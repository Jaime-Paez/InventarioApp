from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APITestCase

import uuid

from casa_comercial.models import CasaComercial
from productos.models import Producto

from .models import Marca


class MarcaListadoTests(APITestCase):
    def setUp(self):
        from app.models import UsuarioPreferencia
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            username="admin_marca",
            email="admin_marca@example.com",
            password="test12345",
        )
        UsuarioPreferencia.objects.get_or_create(usuario=self.user, defaults={"es_administrador": True})
        self.client.force_authenticate(user=self.user)

    def test_listado_marca_ok(self):
        codigo = f"M{uuid.uuid4().hex[:6].upper()}"
        Marca.objects.create(nombre="Marca Prueba", codigo=codigo)

        url = reverse("marcas-listado-list")
        response = self.client.get(url)

        self.assertEqual(response.status_code, 200)
        self.assertIn("results", response.data)
        self.assertEqual(response.data["results"][0]["codigo"], codigo)

    def test_crear_marca_sin_codigo_genera_codigo_automatico(self):
        url = reverse("marcas-listado-list")
        payload = {
            "nombre": "Ford",
        }

        response = self.client.post(url, payload, format="json")

        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["codigo"], "FRD")
        self.assertTrue(Marca.objects.filter(codigo="FRD").exists())

    def test_crear_marca_con_colision_genera_codigo_alterno(self):
        Marca.objects.create(nombre="Base", codigo="FRD")
        url = reverse("marcas-listado-list")
        payload = {
            "nombre": "Ford",
        }

        response = self.client.post(url, payload, format="json")

        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["codigo"], "FRO")
        self.assertNotEqual(response.data["codigo"], "FRD")

    def test_crear_marca_ignora_codigo_manual(self):
        url = reverse("marcas-listado-list")
        payload = {
            "nombre": "Nissan",
            "codigo": "XYZ",
        }

        response = self.client.post(url, payload, format="json")

        self.assertEqual(response.status_code, 201, response.data)
        self.assertNotEqual(response.data["codigo"], "XYZ")
        self.assertEqual(response.data["codigo"], "NSS")

    def test_no_permite_eliminar_marca_asociada_a_producto(self):
        marca = Marca.objects.create(nombre="Marca Bloqueada", codigo=f"MB{uuid.uuid4().hex[:4].upper()}")
        casa = CasaComercial.objects.create(
            nombre="Casa Bloqueada",
            codigo=f"CB{uuid.uuid4().hex[:4].upper()}",
        )
        producto = Producto.objects.create(
            codigo=f"P{uuid.uuid4().hex[:6].upper()}",
            nombre="Producto Marca Bloqueada",
            descripcion="Producto de prueba",
            marca=marca,
            precio=10,
        )
        producto.casas_comerciales.add(casa)

        url = reverse("marcas-listado-detail", args=[marca.id])
        response = self.client.delete(url)

        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn("productos asociados", str(response.data.get("detail", "")).lower())
        self.assertTrue(Marca.objects.filter(id=marca.id).exists())
