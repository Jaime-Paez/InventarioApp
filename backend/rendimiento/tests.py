from unittest import mock

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from . import middleware
from .models import PeticionLenta, RendimientoRuta


class RendimientoMiddlewareTests(APITestCase):
    def setUp(self):
        middleware._buffer.clear()
        self.user = get_user_model().objects.create_superuser(
            username="perf", email="perf@test.local", password="x"
        )
        self.client.force_authenticate(self.user)

    def test_resume_por_ruta_con_consultas_y_cabecera(self):
        response = self.client.get("/inventario/sucursales/")
        self.assertIn("Server-Timing", response)
        self.client.get("/inventario/sucursales/")
        middleware.flush(force=True)
        row = RendimientoRuta.objects.get(metodo="GET", ruta="inventario/sucursales/")
        self.assertEqual(row.peticiones, 2)
        self.assertGreater(row.total_consultas, 0)
        # Un segundo guardado suma sobre la misma fila (misma hora).
        self.client.get("/inventario/sucursales/")
        middleware.flush(force=True)
        row.refresh_from_db()
        self.assertEqual(row.peticiones, 3)

    def test_peticion_lenta_se_guarda_con_detalle(self):
        with mock.patch.object(middleware, "DETALLE_MS", 0):
            self.client.get("/inventario/sucursales/?page_size=5")
        with mock.patch.object(middleware, "DETALLE_MS", 0):
            self.client.get("/inventario/sucursales/1/")
        self.assertTrue(PeticionLenta.objects.filter(ruta="inventario/sucursales/<pk>/").exists())
        lenta = PeticionLenta.objects.filter(ruta="inventario/sucursales/").get()
        self.assertEqual(lenta.url, "/inventario/sucursales/?page_size=5")
        self.assertEqual(lenta.usuario, self.user)
        self.assertEqual(lenta.estado, 200)
