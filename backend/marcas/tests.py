from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APITestCase

import uuid

from .models import Marca


class MarcaListadoTests(APITestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            username="admin_marca",
            email="admin_marca@example.com",
            password="test12345",
            is_staff=True,
        )
        self.client.force_authenticate(user=self.user)

    def test_listado_marca_ok(self):
        codigo = f"M{uuid.uuid4().hex[:6].upper()}"
        Marca.objects.create(nombre="Marca Prueba", codigo=codigo)

        url = reverse("marcas-listado-list")
        response = self.client.get(url)

        self.assertEqual(response.status_code, 200)
        self.assertIn("results", response.data)
        self.assertEqual(response.data["results"][0]["codigo"], codigo)
