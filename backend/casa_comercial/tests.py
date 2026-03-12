from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APITestCase

import uuid

from marcas.models import Marca
from productos.models import Producto

from .models import CasaComercial


class CasaComercialListadoTests(APITestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            username="admin_casa",
            email="admin_casa@example.com",
            password="test12345",
            is_staff=True,
        )
        self.client.force_authenticate(user=self.user)

    def test_listado_casa_comercial_ok(self):
        codigo = f"C{uuid.uuid4().hex[:6].upper()}"
        CasaComercial.objects.create(nombre="Casa Prueba", codigo=codigo)

        url = reverse("casa-comercial-casas-list")
        response = self.client.get(url)

        self.assertEqual(response.status_code, 200)
        self.assertIn("results", response.data)
        self.assertEqual(response.data["results"][0]["codigo"], codigo)

    def test_crear_casa_comercial_sin_codigo_genera_codigo_automatico(self):
        url = reverse("casa-comercial-casas-list")
        payload = {
            "nombre": "Ford",
        }

        response = self.client.post(url, payload, format="json")

        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["codigo"], "FRD")
        self.assertTrue(CasaComercial.objects.filter(codigo="FRD").exists())

    def test_crear_casa_comercial_con_colision_genera_codigo_alterno(self):
        CasaComercial.objects.create(nombre="Base", codigo="FRD")
        url = reverse("casa-comercial-casas-list")
        payload = {
            "nombre": "Ford",
        }

        response = self.client.post(url, payload, format="json")

        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["codigo"], "FRO")
        self.assertNotEqual(response.data["codigo"], "FRD")

    def test_crear_casa_comercial_ignora_codigo_manual(self):
        url = reverse("casa-comercial-casas-list")
        payload = {
            "nombre": "Nissan",
            "codigo": "XYZ",
        }

        response = self.client.post(url, payload, format="json")

        self.assertEqual(response.status_code, 201, response.data)
        self.assertNotEqual(response.data["codigo"], "XYZ")
        self.assertEqual(response.data["codigo"], "NSS")

    def test_no_permite_eliminar_casa_comercial_asociada_a_producto(self):
        casa = CasaComercial.objects.create(
            nombre="Casa Bloqueada",
            codigo=f"CB{uuid.uuid4().hex[:4].upper()}",
        )
        marca = Marca.objects.create(
            nombre="Marca Bloqueada",
            codigo=f"MB{uuid.uuid4().hex[:4].upper()}",
        )
        producto = Producto.objects.create(
            codigo=f"P{uuid.uuid4().hex[:6].upper()}",
            nombre="Producto Casa Bloqueada",
            descripcion="Producto de prueba",
            marca=marca,
            precio=10,
        )
        producto.casas_comerciales.add(casa)

        url = reverse("casa-comercial-casas-detail", args=[casa.id])
        response = self.client.delete(url)

        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn("productos asociados", str(response.data.get("detail", "")).lower())
        self.assertTrue(CasaComercial.objects.filter(id=casa.id).exists())
