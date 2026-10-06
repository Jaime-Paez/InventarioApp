from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from casa_comercial.models import CasaComercial
from inventario.models import Sucursal
from productos.models import Producto

from .models import Importacion, ImportacionEnvio, ImportacionEnvioDetalle

BASE_URL = "/importaciones/importaciones"


class BorradorRecepcionEnvioTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(
            username="admin@test.com", email="admin@test.com", password="x"
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.sucursal = Sucursal.objects.create(nombre="Norte", direccion="Av 1")
        casa = CasaComercial.objects.create(nombre="Casa", codigo="C1")
        importacion = Importacion.objects.create(codigo="IMP-1", casa_comercial=casa)
        self.producto = Producto.objects.create(codigo="P-1", nombre="Filtro", precio=Decimal("10"))
        self.envio = ImportacionEnvio.objects.create(importacion=importacion, sucursal=self.sucursal)
        ImportacionEnvioDetalle.objects.create(envio=self.envio, producto=self.producto, cantidad=5)

    def _url(self, envio_id=None):
        return f"{BASE_URL}/envios/{envio_id or self.envio.id}/borrador-recepcion/"

    def test_guarda_y_devuelve_borrador_en_envios_pendientes(self):
        response = self.client.patch(
            self._url(),
            {
                "items": {
                    str(self.producto.id): {
                        "cantidad_recibida": 4,
                        "recepcion_revisada": True,
                        "novedad": " falta uno ",
                        "ubicaciones": [
                            {"subdivision_id": 7, "cantidad": 4},
                            {"subdivision_id": None, "cantidad": 1},
                        ],
                    }
                }
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)

        listado = self.client.get(f"{BASE_URL}/envios-pendientes/")
        self.assertEqual(listado.status_code, 200)
        row = next(r for r in listado.json() if r["envio_id"] == self.envio.id)
        self.assertEqual(
            row["borrador_recepcion"],
            {
                str(self.producto.id): {
                    "cantidad_recibida": 4,
                    "recepcion_revisada": True,
                    "novedad": "falta uno",
                    "ubicaciones": [{"subdivision_id": 7, "cantidad": 4}],
                }
            },
        )

    def test_guarda_nota_general(self):
        response = self.client.patch(
            self._url(),
            {
                "items": {str(self.producto.id): {"cantidad_recibida": 5, "recepcion_revisada": True}},
                "tiene_novedad_general": True,
                "nota_general": "Caja golpeada",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.envio.refresh_from_db()
        self.assertEqual(
            self.envio.borrador_recepcion["__meta__"],
            {"tiene_novedad_general": True, "nota_general": "Caja golpeada"},
        )
        self.assertTrue(self.envio.borrador_recepcion[str(self.producto.id)]["recepcion_revisada"])

    def test_envio_recibido_no_acepta_borrador(self):
        ImportacionEnvio.objects.filter(pk=self.envio.pk).update(estado=ImportacionEnvio.ESTADO_RECIBIDO)
        response = self.client.patch(self._url(), {"items": {}}, format="json")
        self.assertEqual(response.status_code, 404)

    def test_items_invalidos(self):
        response = self.client.patch(self._url(), {"items": []}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_usuario_sin_acceso_a_la_sucursal(self):
        otro = get_user_model().objects.create_user(
            username="otro@test.com", email="otro@test.com", password="x"
        )
        client = APIClient()
        client.force_authenticate(otro)
        response = client.patch(self._url(), {"items": {}}, format="json")
        self.assertIn(response.status_code, (403, 404))
        self.envio.refresh_from_db()
        self.assertEqual(self.envio.borrador_recepcion, {})
