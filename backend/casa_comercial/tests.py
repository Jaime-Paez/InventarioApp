from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APITestCase

import uuid

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
