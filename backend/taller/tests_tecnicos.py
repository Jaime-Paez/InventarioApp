from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from usuarios.models import Rol

from .models import Tecnico


class TecnicosTests(TestCase):
    def setUp(self):
        user = get_user_model().objects.create_user(username="as@x.com", email="as@x.com", password="x")
        Rol.objects.get(nombre="Asistente de servicio").usuarios.add(user)
        self.api = APIClient()
        self.api.force_authenticate(user)

    def test_asignar_tecnico_guarda_nombre(self):
        tecnico = self.api.post("/taller/tecnicos/", {"nombre": "Wilmer Ilbarra"}, format="json").json()
        orden = self.api.post("/taller/ordenes/", {}, format="json").json()
        data = self.api.patch(f"/taller/ordenes/{orden['id']}/", {"tecnico_asignado": tecnico["id"]}, format="json").json()
        self.assertEqual((data["tecnico_asignado"], data["tecnico"]), (tecnico["id"], "Wilmer Ilbarra"))
        data = self.api.patch(f"/taller/ordenes/{orden['id']}/", {"tecnico_asignado": None}, format="json").json()
        self.assertEqual(data["tecnico"], "")

    def test_tecnico_usado_se_desactiva(self):
        tecnico = Tecnico.objects.create(nombre="Juan")
        orden = self.api.post("/taller/ordenes/", {}, format="json").json()
        self.api.patch(f"/taller/ordenes/{orden['id']}/", {"tecnico_asignado": tecnico.id}, format="json")
        self.assertEqual(self.api.delete(f"/taller/tecnicos/{tecnico.id}/").status_code, 200)
        tecnico.refresh_from_db()
        self.assertFalse(tecnico.activo)
        activos = self.api.get("/taller/tecnicos/?activos=1").json()
        self.assertEqual(activos, [])
