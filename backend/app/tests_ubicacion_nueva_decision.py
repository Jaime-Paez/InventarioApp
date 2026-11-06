from app import views as app_views
from app.models import InspeccionAleatoriaItem

from .tests_inspeccion_aleatoria import BASE_URL, InspeccionAleatoriaBaseTestCase


class UbicacionNuevaAntesDeReconteoTests(InspeccionAleatoriaBaseTestCase):
    """El revisor encontro el producto en una ubicacion nueva y la cantidad no
    cuadra: administracion tiene que aceptar o rechazar esa ubicacion antes de
    reenviar el conteo, y el reconteo busca solo donde quedo decidido."""

    def setUp(self):
        super().setUp()
        self.inspection = self._crear_inspeccion(productos=[self.producto], sucursal=self.sucursal)
        self.item = self.inspection.items.get()
        # "Pasar a esta ubicacion": encontro 4 en sub_b; en sub_a (sistema 10) no quedo nada.
        self.item.agregado_por_revisor = True
        self.item.encontrado_en = self.sub_b
        self.item.conteo_ubicaciones = [
            {"subdivision_id": self.sub_b.id, "cantidad_contada": 4, "cantidad_sistema": 0},
            {"subdivision_id": self.sub_a.id, "cantidad_contada": 0, "cantidad_sistema": 10},
        ]
        self.item.cantidad_reportada = 4
        self.item.cantidad_esperada = 10
        self.item.estado_revision = InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE
        self.item.verificacion_estado = InspeccionAleatoriaItem.EstadosVerificacion.PENDIENTE
        self.item.save()

    def _verificar(self, body):
        return self.admin_client.post(f"{BASE_URL}/items/{self.item.id}/verificar/", body, format="json")

    def _ubicaciones_del_reconteo(self):
        nuevo = InspeccionAleatoriaItem.objects.get(reconteo_de=self.item)
        app_views._attach_random_inspection_locations([nuevo])
        return [u["subdivision_id"] for u in nuevo._inspection_location_payload["ubicaciones_bodega"]]

    def test_no_se_puede_recontar_sin_decidir_la_ubicacion(self):
        self.assertTrue(app_views._new_location_awaiting_decision(self.item))
        response = self._verificar({"accion": "recontar"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("ubicacion nueva", response.data["detail"])
        self.assertFalse(InspeccionAleatoriaItem.objects.filter(reconteo_de=self.item).exists())

    def test_aceptar_mueve_el_stock_y_el_reconteo_busca_en_la_nueva(self):
        response = self._verificar({"accion": "decidir_movimiento", "aprobar_movimiento": True})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["pendiente_cantidad"])
        # El total no cambia: todo pasa a la ubicacion nueva.
        self.assertEqual(self._stock(subdivision=self.sub_a), 0)
        self.assertEqual(self._stock(subdivision=self.sub_b), 10)

        response = self._verificar({"accion": "recontar"})
        self.assertEqual(response.status_code, 200, response.data)
        ids = self._ubicaciones_del_reconteo()
        self.assertIn(self.sub_b.id, ids)
        self.assertNotIn(self.sub_a.id, ids)

    def test_rechazar_no_mueve_y_el_reconteo_busca_en_la_de_antes(self):
        response = self._verificar({"accion": "decidir_movimiento", "aprobar_movimiento": False})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(subdivision=self.sub_a), 10)
        self.assertEqual(self._stock(subdivision=self.sub_b), 0)

        response = self._verificar({"accion": "recontar"})
        self.assertEqual(response.status_code, 200, response.data)
        ids = self._ubicaciones_del_reconteo()
        self.assertIn(self.sub_a.id, ids)
        self.assertNotIn(self.sub_b.id, ids)

    def test_aceptar_con_parte_en_la_de_antes_mantiene_las_dos(self):
        # Encontro 5 en la nueva y quedaron 2 en la de antes (sistema 10).
        self.item.conteo_ubicaciones = [
            {"subdivision_id": self.sub_b.id, "cantidad_contada": 5, "cantidad_sistema": 0},
            {"subdivision_id": self.sub_a.id, "cantidad_contada": 2, "cantidad_sistema": 10},
        ]
        self.item.cantidad_reportada = 7
        self.item.save()
        response = self._verificar({"accion": "decidir_movimiento", "aprobar_movimiento": True})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(subdivision=self.sub_a), 2)
        self.assertEqual(self._stock(subdivision=self.sub_b), 8)

        self._verificar({"accion": "recontar"})
        ids = self._ubicaciones_del_reconteo()
        self.assertIn(self.sub_a.id, ids)
        self.assertIn(self.sub_b.id, ids)

    def test_si_la_cantidad_cuadra_no_hace_falta_decidir_antes(self):
        self.item.conteo_ubicaciones = [
            {"subdivision_id": self.sub_b.id, "cantidad_contada": 10, "cantidad_sistema": 0},
            {"subdivision_id": self.sub_a.id, "cantidad_contada": 0, "cantidad_sistema": 10},
        ]
        self.item.cantidad_reportada = 10
        self.item.save()
        self.assertFalse(app_views._new_location_awaiting_decision(self.item))
