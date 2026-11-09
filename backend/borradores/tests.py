from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient


class BorradorFormularioTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.a = APIClient()
        self.a.force_authenticate(User.objects.create_user(username="a@x.com", email="a@x.com", password="x"))
        self.b = APIClient()
        self.b.force_authenticate(User.objects.create_user(username="b@x.com", email="b@x.com", password="x"))

    def test_guardar_recuperar_y_borrar(self):
        url = "/borradores/nueva-salida/"
        self.assertIsNone(self.a.get(url).json()["datos"])
        datos = {"formData": {"sucursalId": "1"}, "details": [{"productoId": "5", "cantidad": "2"}]}
        self.assertEqual(self.a.put(url, {"datos": datos}, format="json").status_code, 200)
        self.assertEqual(self.a.get(url).json()["datos"], datos)
        # Cada usuario tiene el suyo.
        self.assertIsNone(self.b.get(url).json()["datos"])
        self.assertEqual(self.a.delete(url).status_code, 204)
        self.assertIsNone(self.a.get(url).json()["datos"])
