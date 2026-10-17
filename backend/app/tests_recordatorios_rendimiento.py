from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from . import views


class RecordatoriosSondeoTests(APITestCase):
    """El sondeo de recordatorios no reenvia la lista completa si no cambio."""

    url = "/recordatorios/estado/"

    def setUp(self):
        views.invalidate_reminders_cache()
        views._last_inspection_check_by_user.clear()
        self.user = get_user_model().objects.create_user(
            username="sondeo", email="sondeo@test.local", password="x"
        )
        self.client.force_authenticate(self.user)

    def _reminder(self, reminder_id, description):
        return {
            "id": reminder_id,
            "date": "2026-10-17",
            "time": "09:00",
            "description": description,
            "creator": {"id": str(self.user.id), "name": "Sondeo"},
            "recipients": [{"id": str(self.user.id), "name": "Sondeo"}],
        }

    def test_misma_version_responde_sin_cambios(self):
        first = self.client.get(self.url)
        self.assertEqual(first.status_code, 200)
        version = first.data["version"]
        self.assertTrue(version)
        self.assertIn("reminders", first.data)

        again = self.client.get(self.url, {"version": version})
        self.assertTrue(again.data.get("unchanged"))
        self.assertNotIn("reminders", again.data)

    def test_despues_de_guardar_cambia_la_version(self):
        version = self.client.get(self.url).data["version"]
        put = self.client.put(
            self.url, {"reminders": [self._reminder("rem-1", "Revisar stock")]}, format="json"
        )
        self.assertEqual(put.status_code, 200, put.data)
        self.assertNotEqual(put.data["version"], version)

        after = self.client.get(self.url, {"version": version})
        self.assertFalse(after.data.get("unchanged"))
        self.assertEqual([r["id"] for r in after.data["reminders"]], ["rem-1"])

    def test_respuesta_comprimida_si_el_navegador_la_acepta(self):
        self.client.put(
            self.url,
            {"reminders": [self._reminder(f"rem-{i}", "Revisar stock " * 20) for i in range(40)]},
            format="json",
        )
        response = self.client.get(self.url, HTTP_ACCEPT_ENCODING="gzip")
        self.assertEqual(response.get("Content-Encoding"), "gzip")
