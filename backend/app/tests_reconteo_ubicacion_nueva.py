from app import views as app_views
from app.models import InspeccionAleatoriaItem

from .tests_inspeccion_aleatoria import InspeccionAleatoriaBaseTestCase


class ReconteoUbicacionNuevaTests(InspeccionAleatoriaBaseTestCase):
    """Si el primer conteo encontro el producto en una ubicacion donde el
    sistema no lo tenia y se manda a reconteo, el reconteo tambien pide contar
    esa ubicacion (antes se perdia y al aprobar quedaba la cantidad vieja)."""

    def test_reconteo_incluye_la_ubicacion_nueva_encontrada(self):
        inspeccion = self._crear_inspeccion()
        item = inspeccion.items.get()
        # Conteo: 0 donde decia el sistema (sub_a) y 4 en una ubicacion nueva (sub_b).
        item.conteo_ubicaciones = [
            {"subdivision_id": self.sub_a.id, "cantidad_contada": 0, "cantidad_sistema": 10},
            {"subdivision_id": self.sub_b.id, "cantidad_contada": 4, "cantidad_sistema": 0},
        ]
        item.cantidad_reportada = 4
        item.estado_revision = InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE
        item.save()

        recount, error = app_views._send_item_to_recount(item, self.admin)
        self.assertIsNone(error)
        nuevo = recount.items.get()
        app_views._attach_random_inspection_locations([nuevo])
        ubicaciones = nuevo._inspection_location_payload["ubicaciones_bodega"]
        ids = [u["subdivision_id"] for u in ubicaciones]
        self.assertIn(self.sub_a.id, ids)
        self.assertIn(self.sub_b.id, ids)
        nueva = next(u for u in ubicaciones if u["subdivision_id"] == self.sub_b.id)
        self.assertTrue(nueva["encontrado_en_conteo_anterior"])
        self.assertEqual(nueva["cantidad"], 0)

    def test_reconteo_de_reconteo_sigue_incluyendola(self):
        inspeccion = self._crear_inspeccion()
        item = inspeccion.items.get()
        item.conteo_ubicaciones = [
            {"subdivision_id": self.sub_b.id, "cantidad_contada": 4, "cantidad_sistema": 0},
        ]
        item.save()
        recount, _ = app_views._send_item_to_recount(item, self.admin)
        segundo = recount.items.get()
        # El reconteo se conto sin la ubicacion nueva (como pasaba antes).
        segundo.conteo_ubicaciones = [
            {"subdivision_id": self.sub_a.id, "cantidad_contada": 0, "cantidad_sistema": 10},
        ]
        segundo.save()
        recount2, error = app_views._send_item_to_recount(segundo, self.admin)
        self.assertIsNone(error)
        tercero = recount2.items.exclude(pk=segundo.pk).get(producto=self.producto)
        app_views._attach_random_inspection_locations([tercero])
        ids = [u["subdivision_id"] for u in tercero._inspection_location_payload["ubicaciones_bodega"]]
        self.assertIn(self.sub_b.id, ids)
