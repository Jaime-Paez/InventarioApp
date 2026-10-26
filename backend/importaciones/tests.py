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


class SugerenciaProductosNuevosTests(TestCase):
    """En la sugerencia (borrador) los productos nuevos no entran al catalogo
    ni se exige cantidad; al pedir la cotizacion se exige la cantidad y los
    productos nuevos se crean con su PVP aprox."""

    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(
            username="admin-sug@test.com", email="admin-sug@test.com", password="x"
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.casa = CasaComercial.objects.create(
            nombre="Casa Imp", codigo="CI", tipo=CasaComercial.TIPO_IMPORTACION
        )
        self.existente = Producto.objects.create(codigo="EX-1", nombre="Faro", precio=Decimal("20"))

    def _crear(self, cantidad_nuevo=0):
        response = self.client.post(
            f"{BASE_URL}/",
            {
                "casa_comercial_id": self.casa.id,
                "detalles": [
                    {"producto_id": self.existente.id, "cantidad": 0, "precio_estimado": "18.50"},
                    {
                        "codigo": "NUEVO-CI", "nombre": "Filtro nuevo", "referencia": "REF-NUEVO",
                        "oem": "OEM-NUEVO", "cantidad": cantidad_nuevo, "precio_estimado": "12.30",
                    },
                ],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        return Importacion.objects.get(pk=response.data["id"])

    def test_en_sugerencia_no_se_crea_el_producto_ni_se_exige_cantidad(self):
        importacion = self._crear()
        self.assertFalse(Producto.objects.filter(codigo="NUEVO-CI").exists())
        detalle = importacion.detalles.get(codigo="NUEVO-CI")
        self.assertIsNone(detalle.producto_id)
        self.assertEqual(detalle.precio_estimado, Decimal("12.30"))
        self.assertEqual(importacion.detalles.get(producto=self.existente).precio_estimado, Decimal("18.50"))

    def test_pedir_cotizacion_exige_cantidad(self):
        importacion = self._crear()
        response = self.client.post(f"{BASE_URL}/{importacion.id}/pedir-cotizacion/")
        self.assertEqual(response.status_code, 400)
        importacion.refresh_from_db()
        self.assertEqual(importacion.estado, Importacion.ESTADO_BORRADOR)
        self.assertFalse(Producto.objects.filter(codigo="NUEVO-CI").exists())

    def test_pedir_cotizacion_crea_los_productos_nuevos(self):
        importacion = self._crear(cantidad_nuevo=3)
        importacion.detalles.filter(producto=self.existente).update(cantidad=2)
        response = self.client.post(f"{BASE_URL}/{importacion.id}/pedir-cotizacion/")
        self.assertEqual(response.status_code, 200, response.data)
        producto = Producto.objects.get(codigo="NUEVO-CI")
        self.assertEqual(producto.precio, Decimal("12.30"))
        self.assertEqual(producto.creado_desde_importacion_id, importacion.id)
        self.assertTrue(producto.casas_comerciales.filter(pk=self.casa.pk).exists())
        self.assertEqual(importacion.detalles.get(codigo="NUEVO-CI").producto_id, producto.id)
