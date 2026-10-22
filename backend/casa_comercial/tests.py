from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APITestCase

import uuid

from productos.models import Producto

from .models import CasaComercial


class CasaComercialListadoTests(APITestCase):
    def setUp(self):
        from app.models import UsuarioPreferencia
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            username="admin_casa",
            email="admin_casa@example.com",
            password="test12345",
        )
        UsuarioPreferencia.objects.get_or_create(usuario=self.user, defaults={"es_administrador": True})
        self.client.force_authenticate(user=self.user)

    def test_listado_casa_comercial_ok(self):
        codigo = f"C{uuid.uuid4().hex[:6].upper()}"
        CasaComercial.objects.create(nombre="Casa Prueba", codigo=codigo)

        url = reverse("casa-comercial-casas-list")
        response = self.client.get(url)

        self.assertEqual(response.status_code, 200)
        self.assertIn("results", response.data)
        self.assertEqual(response.data["results"][0]["codigo"], codigo)

    def _crear(self, **payload):
        return self.client.post(reverse("casa-comercial-casas-list"), payload, format="json")

    def test_casa_local_usa_codigo_fijo_cl_o_clo(self):
        # Las locales no tienen codigo propio: "CL", o "CLO" si venden originales,
        # y se pueden repetir entre si (lo escrito a mano se ignora).
        normal = self._crear(nombre="Repuestos Quito", tipo="local", codigo="XYZ")
        self.assertEqual(normal.status_code, 201, normal.data)
        self.assertEqual(normal.data["codigo"], "CL")
        otra = self._crear(nombre="Otra local", tipo="local")
        self.assertEqual(otra.data["codigo"], "CL")
        original = self._crear(nombre="Original local", tipo="local", es_original=True)
        self.assertEqual(original.data["codigo"], "CLO")

    def test_casa_de_importacion_usa_su_codigo_sin_repetir(self):
        primera = self._crear(nombre="Ford", tipo="importacion", codigo=" frd ")
        self.assertEqual(primera.status_code, 201, primera.data)
        self.assertEqual(primera.data["codigo"], "FRD")
        repetida = self._crear(nombre="Ford 2", tipo="importacion", codigo="FRD")
        self.assertEqual(repetida.status_code, 400)
        sin_codigo = self._crear(nombre="Nissan", tipo="importacion")
        self.assertEqual(sin_codigo.status_code, 400)

    def test_no_permite_eliminar_casa_comercial_asociada_a_producto(self):
        casa = CasaComercial.objects.create(
            nombre="Casa Bloqueada",
            codigo=f"CB{uuid.uuid4().hex[:4].upper()}",
        )
        producto = Producto.objects.create(
            codigo=f"P{uuid.uuid4().hex[:6].upper()}",
            nombre="Producto Casa Bloqueada",
            precio=10,
        )
        producto.casas_comerciales.add(casa)

        url = reverse("casa-comercial-casas-detail", args=[casa.id])
        response = self.client.delete(url)

        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn("productos asociados", str(response.data.get("detail", "")).lower())
        self.assertTrue(CasaComercial.objects.filter(id=casa.id).exists())
