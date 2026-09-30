from datetime import time as dt_time
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from app import views as app_views
from app.models import (
    InspeccionAleatoriaConfiguracion,
    InspeccionAleatoriaDiaria,
    InspeccionAleatoriaItem,
    ReminderState,
    UsuarioPreferencia,
)
from auditoria.models import RegistroAuditoria
from inventario.models import Bodega, Division, Inventario, SubDivision, Sucursal
from productos.models import Producto
from tipos.models import TipoDivision

BASE_URL = "/recordatorios/inspeccion-aleatoria"


class InspeccionAleatoriaBaseTestCase(TestCase):
    def setUp(self):
        app_views._last_inspection_check_by_user.clear()
        User = get_user_model()
        self.admin = User.objects.create_superuser(
            username="admin@test.com", email="admin@test.com", password="x"
        )
        self.revisor = User.objects.create_user(
            username="revisor@test.com", email="revisor@test.com", password="x"
        )
        self.sucursal = Sucursal.objects.create(nombre="Norte", direccion="Av 1")
        self.bodega = Bodega.objects.create(sucursal=self.sucursal, nombre="Principal")
        tipo = TipoDivision.objects.create(nombre="Percha")
        self.division = Division.objects.create(tipo_division=tipo, bodega=self.bodega, nombre="Percha A")
        self.division_b = Division.objects.create(tipo_division=tipo, bodega=self.bodega, nombre="Percha B")
        self.sub_a = SubDivision.objects.create(division=self.division, nombre="Nivel 1")
        self.sub_b = SubDivision.objects.create(division=self.division_b, nombre="Nivel 1")
        self.producto = Producto.objects.create(codigo="P-1", nombre="Filtro", precio=Decimal("10"))
        self.producto_2 = Producto.objects.create(codigo="P-2", nombre="Pastilla", precio=Decimal("5"))
        self.inv_a = Inventario.objects.create(producto=self.producto, subdivision=self.sub_a, cantidad=10)
        self.inv_2 = Inventario.objects.create(producto=self.producto_2, subdivision=self.sub_a, cantidad=4)
        UsuarioPreferencia.objects.create(
            usuario=self.revisor,
            inspeccion_aleatoria=True,
            inspeccion_aleatoria_sucursales=[self.sucursal.id],
        )
        config = InspeccionAleatoriaConfiguracion.get_global()
        config.hora_recordatorio = dt_time(0, 0)
        config.save()

        self.revisor_client = APIClient()
        self.revisor_client.force_authenticate(self.revisor)
        self.admin_client = APIClient()
        self.admin_client.force_authenticate(self.admin)

    def _crear_inspeccion(self, productos=None, usuario=None, **extra):
        inspection = InspeccionAleatoriaDiaria.objects.create(
            usuario=usuario or self.revisor,
            fecha_programada=timezone.localdate(),
            total_items=0,
            **extra,
        )
        for producto in productos or [self.producto]:
            stock = sum(
                Inventario.objects.filter(producto=producto).values_list("cantidad", flat=True)
            )
            InspeccionAleatoriaItem.objects.create(
                inspeccion=inspection,
                sucursal=self.sucursal,
                producto=producto,
                cantidad_esperada=stock,
                cantidad_esperada_inicial=stock,
            )
        inspection.total_items = inspection.items.count()
        inspection.save(update_fields=["total_items"])
        return inspection

    def _stock(self, producto=None, subdivision=None):
        queryset = Inventario.objects.filter(producto=producto or self.producto)
        if subdivision is not None:
            queryset = queryset.filter(subdivision=subdivision)
        return sum(queryset.values_list("cantidad", flat=True))

    def _responder(self, inspection, cantidades, version=None, client=None):
        body = {
            "items": [
                {"id": item.id, "cantidad_reportada": cantidades[item.producto_id]}
                for item in inspection.items.all()
            ],
        }
        if version is not None:
            body["version"] = version
        return (client or self.revisor_client).post(
            f"{BASE_URL}/{inspection.id}/responder/", body, format="json"
        )


class AjusteContraStockAlContarTests(InspeccionAleatoriaBaseTestCase):
    def test_venta_entre_generacion_y_conteo_no_genera_diferencia_falsa(self):
        inspection = self._crear_inspeccion()
        # Se genero con 10; antes de contar se vendieron 2.
        Inventario.objects.filter(pk=self.inv_a.pk).update(cantidad=8)

        response = self._responder(inspection, {self.producto.id: 8})

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["mismatch_count"], 0)
        item = inspection.items.get()
        self.assertEqual(item.estado_revision, "coincide")
        self.assertEqual(item.cantidad_esperada, 8)
        self.assertEqual(item.cantidad_esperada_inicial, 10)

    def test_aprobar_no_descuenta_dos_veces_las_ventas(self):
        inspection = self._crear_inspeccion()
        Inventario.objects.filter(pk=self.inv_a.pk).update(cantidad=8)  # venta antes de contar
        response = self._responder(inspection, {self.producto.id: 7})
        self.assertEqual(response.data["mismatch_count"], 1)

        Inventario.objects.filter(pk=self.inv_a.pk).update(cantidad=6)  # venta despues de contar
        item = inspection.items.get()
        response = self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/",
            {"accion": "aprobar", "cantidad_confirmada": 7},
            format="json",
        )

        self.assertEqual(response.status_code, 200, response.data)
        # Habia 7 al contar y despues salieron 2 mas: quedan 5 (antes quedaban 4).
        self.assertEqual(self._stock(), 5)
        self.assertTrue(
            RegistroAuditoria.objects.filter(
                accion=RegistroAuditoria.Acciones.OTRO, object_id=str(item.id)
            ).exists()
        )


class BorradorMultiDispositivoTests(InspeccionAleatoriaBaseTestCase):
    def test_dispositivo_desactualizado_no_puede_guardar_ni_enviar(self):
        inspection = self._crear_inspeccion()
        item = inspection.items.get()
        otro_dispositivo = APIClient()
        otro_dispositivo.force_authenticate(self.revisor)

        response = self.revisor_client.patch(
            f"{BASE_URL}/{inspection.id}/borrador/",
            {"version": 0, "items": [{"id": item.id, "cantidad_reportada": 9}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["version"], 1)

        # El otro dispositivo sigue con la version 0.
        stale = otro_dispositivo.patch(
            f"{BASE_URL}/{inspection.id}/borrador/",
            {"version": 0, "items": [{"id": item.id, "cantidad_reportada": 3}]},
            format="json",
        )
        self.assertEqual(stale.status_code, 409)
        self.assertTrue(stale.data["conflict"])
        self.assertEqual(stale.data["inspection"]["items"][0]["cantidad_reportada"], 9)

        stale_submit = self._responder(inspection, {self.producto.id: 3}, version=0, client=otro_dispositivo)
        self.assertEqual(stale_submit.status_code, 409)
        item.refresh_from_db()
        self.assertEqual(item.cantidad_reportada, 9)
        self.assertEqual(item.estado_revision, "pendiente")

        ok = self._responder(inspection, {self.producto.id: 9}, version=1)
        self.assertEqual(ok.status_code, 200, ok.data)

    def test_guardar_un_producto_no_borra_los_demas(self):
        inspection = self._crear_inspeccion(productos=[self.producto, self.producto_2])
        item_1 = inspection.items.get(producto=self.producto)
        item_2 = inspection.items.get(producto=self.producto_2)

        self.revisor_client.patch(
            f"{BASE_URL}/{inspection.id}/borrador/",
            {"items": [{"id": item_1.id, "cantidad_reportada": 10}]},
            format="json",
        )
        self.revisor_client.patch(
            f"{BASE_URL}/{inspection.id}/borrador/",
            {
                "items": [
                    {
                        "id": item_2.id,
                        "cantidad_reportada": 4,
                        "cantidad_por_ubicacion": [
                            {"key": "k", "subdivision_id": self.sub_a.id, "cantidad": 4}
                        ],
                    }
                ]
            },
            format="json",
        )

        item_1.refresh_from_db()
        item_2.refresh_from_db()
        self.assertEqual(item_1.cantidad_reportada, 10)
        self.assertEqual(item_2.cantidad_reportada, 4)
        self.assertEqual(item_2.conteo_ubicaciones[0]["cantidad_contada"], 4)

    def test_inspeccion_enviada_desde_otro_dispositivo(self):
        inspection = self._crear_inspeccion()
        self._responder(inspection, {self.producto.id: 10})
        response = self.revisor_client.patch(
            f"{BASE_URL}/{inspection.id}/borrador/",
            {"items": []},
            format="json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertTrue(response.data["completed"])


class ConteoCiegoTests(InspeccionAleatoriaBaseTestCase):
    def test_esperado_oculto_hasta_revelar_y_primer_conteo_fijo(self):
        inspection = self._crear_inspeccion()
        item = inspection.items.get()

        detail = self.revisor_client.get(f"{BASE_URL}/{inspection.id}/")
        self.assertIsNone(detail.data["inspection"]["items"][0]["cantidad_esperada"])
        self.assertIsNone(detail.data["inspection"]["items"][0]["ubicaciones_bodega"][0]["cantidad"])
        # El admin si lo ve.
        admin_detail = self.admin_client.get(f"{BASE_URL}/{inspection.id}/")
        self.assertEqual(admin_detail.data["inspection"]["items"][0]["cantidad_esperada"], 10)

        missing = self.revisor_client.patch(
            f"{BASE_URL}/{inspection.id}/borrador/", {"revelar": True}, format="json"
        )
        self.assertEqual(missing.status_code, 400)

        revealed = self.revisor_client.patch(
            f"{BASE_URL}/{inspection.id}/borrador/",
            {"revelar": True, "fase": "resumen", "items": [{"id": item.id, "cantidad_reportada": 6}]},
            format="json",
        )
        self.assertEqual(revealed.status_code, 200, revealed.data)
        self.assertEqual(revealed.data["inspection"]["items"][0]["cantidad_esperada"], 10)
        self.assertEqual(revealed.data["inspection"]["borrador_fase"], "resumen")

        # Corrige despues de ver lo esperado: el primer conteo no cambia.
        self._responder(inspection, {self.producto.id: 10})
        item.refresh_from_db()
        self.assertEqual(item.cantidad_primer_conteo, 6)
        self.assertEqual(item.cantidad_reportada, 10)


class ConteoPorUbicacionTests(InspeccionAleatoriaBaseTestCase):
    def setUp(self):
        super().setUp()
        Inventario.objects.filter(pk=self.inv_a.pk).update(cantidad=5)
        self.inv_b = Inventario.objects.create(producto=self.producto, subdivision=self.sub_b, cantidad=5)

    def _responder_por_ubicacion(self, inspection, cantidad_a, cantidad_b):
        item = inspection.items.get()
        return self.revisor_client.post(
            f"{BASE_URL}/{inspection.id}/responder/",
            {
                "items": [
                    {
                        "id": item.id,
                        "cantidad_reportada": cantidad_a + cantidad_b,
                        "cantidad_por_ubicacion": [
                            {"key": "a", "subdivision_id": self.sub_a.id, "cantidad": cantidad_a},
                            {"key": "b", "subdivision_id": self.sub_b.id, "cantidad": cantidad_b},
                        ],
                    }
                ]
            },
            format="json",
        )

    def test_aprobar_corrige_cada_ubicacion(self):
        inspection = self._crear_inspeccion()
        response = self._responder_por_ubicacion(inspection, 3, 5)
        self.assertEqual(response.data["mismatch_count"], 1)

        item = inspection.items.get()
        self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/",
            {"accion": "aprobar", "cantidad_confirmada": 8},
            format="json",
        )
        self.assertEqual(self._stock(subdivision=self.sub_a), 3)
        self.assertEqual(self._stock(subdivision=self.sub_b), 5)

    def test_total_correcto_con_ubicaciones_cruzadas_se_reubica(self):
        inspection = self._crear_inspeccion()
        response = self._responder_por_ubicacion(inspection, 3, 7)

        self.assertEqual(response.data["mismatch_count"], 0)
        self.assertEqual(self._stock(), 10)
        self.assertEqual(self._stock(subdivision=self.sub_a), 3)
        self.assertEqual(self._stock(subdivision=self.sub_b), 7)


class GeneracionTests(InspeccionAleatoriaBaseTestCase):
    def test_inspeccion_diaria_se_crea_aunque_el_revisor_no_abra_la_app(self):
        response = self.admin_client.get("/recordatorios/estado/")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            InspeccionAleatoriaDiaria.objects.filter(
                usuario=self.revisor, fecha_programada=timezone.localdate()
            ).exists()
        )

    def test_no_se_repiten_productos_entre_revisores(self):
        User = get_user_model()
        revisor_2 = User.objects.create_user(username="r2@test.com", email="r2@test.com", password="x")
        UsuarioPreferencia.objects.create(
            usuario=revisor_2, inspeccion_aleatoria=True, inspeccion_aleatoria_sucursales=[self.sucursal.id]
        )
        self.admin_client.get("/recordatorios/estado/")

        productos_1 = set(
            InspeccionAleatoriaItem.objects.filter(inspeccion__usuario=self.revisor).values_list("producto_id", flat=True)
        )
        productos_2 = set(
            InspeccionAleatoriaItem.objects.filter(inspeccion__usuario=revisor_2).values_list("producto_id", flat=True)
        )
        self.assertFalse(productos_1 & productos_2)

    def test_incluye_productos_con_stock_cero(self):
        Inventario.objects.filter(pk=self.inv_2.pk).update(cantidad=0)
        for index in range(3, 9):
            producto = Producto.objects.create(codigo=f"P-{index}", nombre=f"Producto {index}")
            Inventario.objects.create(producto=producto, subdivision=self.sub_a, cantidad=index)

        candidates = app_views._collect_branch_inspection_candidates(self.sucursal.id)
        selected = app_views._select_random_inspection_candidates(
            self.revisor, timezone.localdate(), candidates, items_per_day=5
        )

        self.assertEqual(len(selected), 5)
        self.assertIn(self.producto_2.id, {candidate["producto_id"] for candidate in selected})

    def test_enviar_ahora_con_lista_vacia_usa_todas_las_sucursales(self):
        UsuarioPreferencia.objects.filter(usuario=self.revisor).update(inspeccion_aleatoria_sucursales=[])
        response = self.admin_client.post(
            f"{BASE_URL}/enviar-ahora/",
            {"hora_recordatorio": "23:59", "usuario_ids": [self.revisor.id], "cantidad_productos": 2},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["count"], 1)


class InspeccionPorDivisionTests(InspeccionAleatoriaBaseTestCase):
    def test_division_con_inspeccion_de_sucursal_completada_crea_una_nueva(self):
        sucursal_inspection = self._crear_inspeccion(sucursal=self.sucursal)
        self._responder(sucursal_inspection, {self.producto.id: 10})

        response = self.admin_client.post(
            f"{BASE_URL}/enviar-division/",
            {"division_id": self.division.id, "usuario_id": self.revisor.id, "hora_recordatorio": "23:59"},
            format="json",
        )

        self.assertEqual(response.status_code, 200, response.data)
        division_inspection = InspeccionAleatoriaDiaria.objects.get(pk=response.data["inspeccion_id"])
        self.assertNotEqual(division_inspection.id, sucursal_inspection.id)
        self.assertTrue(division_inspection.es_por_division)
        self.assertEqual(division_inspection.estado, "pendiente")

        cantidades = {item.producto_id: 0 for item in division_inspection.items.all()}
        cantidades[self.producto.id] = 10
        cantidades[self.producto_2.id] = 4
        self.assertEqual(self._responder(division_inspection, cantidades).status_code, 200)

    def test_esperado_por_division_solo_cuenta_esa_division(self):
        Inventario.objects.create(producto=self.producto, subdivision=self.sub_b, cantidad=3)
        response = self.admin_client.post(
            f"{BASE_URL}/enviar-division/",
            {"division_id": self.division.id, "usuario_id": self.revisor.id, "hora_recordatorio": "23:59"},
            format="json",
        )
        inspection = InspeccionAleatoriaDiaria.objects.get(pk=response.data["inspeccion_id"])
        response = self._responder(inspection, {self.producto.id: 10, self.producto_2.id: 4})
        self.assertEqual(response.data["mismatch_count"], 0)


class DisculparTests(InspeccionAleatoriaBaseTestCase):
    def test_disculpar_cubre_todas_las_inspecciones_del_dia(self):
        daily = self._crear_inspeccion()
        branch = self._crear_inspeccion(sucursal=self.sucursal)
        response = self.admin_client.post(
            f"{BASE_URL}/admin/disculpar/",
            {"usuario_id": self.revisor.id, "fecha": timezone.localdate().isoformat()},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        daily.refresh_from_db()
        branch.refresh_from_db()
        self.assertTrue(daily.disculpada)
        self.assertTrue(branch.disculpada)


class ResumenAdminTests(InspeccionAleatoriaBaseTestCase):
    def _resumen_usuario(self):
        store = ReminderState.get_global()
        app_views._upsert_random_inspection_admin_summary_reminder(store, timezone.localdate())
        resumen = next(
            reminder
            for reminder in store.payload
            if reminder.get("kind") == app_views.RANDOM_INSPECTION_ADMIN_SUMMARY_KIND
        )
        return resumen["context"]["detalle_usuarios"][0], resumen

    def test_una_disculpada_no_oculta_otra_inspeccion_pendiente_del_mismo_dia(self):
        self._crear_inspeccion(disculpada=True)
        self._crear_inspeccion(sucursal=self.sucursal)  # sigue pendiente

        usuario, resumen = self._resumen_usuario()

        self.assertFalse(usuario["completada"])
        self.assertFalse(usuario["disculpada"])
        self.assertEqual(resumen["completedBy"], [])

    def test_completada_mas_disculpada_cuenta_como_terminado(self):
        completada = self._crear_inspeccion()
        self._responder(completada, {self.producto.id: 10})
        self._crear_inspeccion(sucursal=self.sucursal, disculpada=True)

        usuario, _ = self._resumen_usuario()

        self.assertFalse(usuario["completada"])
        self.assertTrue(usuario["disculpada"])


class RecordatoriosHuerfanosTests(InspeccionAleatoriaBaseTestCase):
    def test_quita_recordatorios_de_inspecciones_borradas(self):
        existente = self._crear_inspeccion()
        store = ReminderState.get_global()
        contexto = {"type": app_views.RANDOM_INSPECTION_CONTEXT_TYPE}
        store.payload = [
            {"id": "insp-verify-999999", "kind": app_views.RANDOM_INSPECTION_VERIFY_KIND,
             "context": {**contexto, "id": "999999"}},
            {"id": f"insp-{existente.id}", "kind": app_views.RANDOM_INSPECTION_KIND,
             "context": {**contexto, "id": str(existente.id)}},
            {"id": "insp-admin-summary-2026-01-01", "kind": app_views.RANDOM_INSPECTION_ADMIN_SUMMARY_KIND,
             "context": {**contexto, "id": "2026-01-01"}},
        ]

        self.assertTrue(app_views._purge_orphan_random_inspection_reminders(store))

        self.assertEqual(
            [reminder["id"] for reminder in store.payload],
            [f"insp-{existente.id}", "insp-admin-summary-2026-01-01"],
        )


class InspeccionPorListaTests(InspeccionAleatoriaBaseTestCase):
    def _enviar_lista(self, **body):
        payload = {
            "sucursal_id": self.sucursal.id,
            "usuario_id": self.revisor.id,
            "hora_recordatorio": "23:59",
            **body,
        }
        return self.admin_client.post(f"{BASE_URL}/enviar-lista/", payload, format="json")

    def test_envia_lista_por_ids_y_codigos_e_informa_los_no_encontrados(self):
        response = self._enviar_lista(
            producto_ids=[self.producto.id],
            codigos=["p-2", "NO-EXISTE", "P-1"],
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["productos"], 2)
        self.assertEqual(response.data["codigos_no_encontrados"], ["NO-EXISTE"])
        inspection = InspeccionAleatoriaDiaria.objects.get(pk=response.data["inspeccion_id"])
        self.assertTrue(inspection.es_por_lista)
        self.assertEqual(
            {item.producto_id: item.cantidad_esperada for item in inspection.items.all()},
            {self.producto.id: 10, self.producto_2.id: 4},
        )

    def test_varias_listas_el_mismo_dia_y_se_pueden_responder(self):
        primera = self._enviar_lista(producto_ids=[self.producto.id])
        segunda = self._enviar_lista(producto_ids=[self.producto_2.id])
        self.assertEqual(primera.status_code, 200)
        self.assertEqual(segunda.status_code, 200)
        self.assertNotEqual(primera.data["inspeccion_id"], segunda.data["inspeccion_id"])

        inspection = InspeccionAleatoriaDiaria.objects.get(pk=primera.data["inspeccion_id"])
        response = self._responder(inspection, {self.producto.id: 9})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["mismatch_count"], 1)

    def test_lista_no_reemplaza_la_inspeccion_automatica(self):
        self._enviar_lista(producto_ids=[self.producto.id])
        self.admin_client.get("/recordatorios/estado/")

        self.assertTrue(
            InspeccionAleatoriaDiaria.objects.filter(
                usuario=self.revisor, sucursal__isnull=True, fecha_programada=timezone.localdate()
            ).exists()
        )

    def test_rechaza_lista_vacia_o_sucursal_no_asignada(self):
        vacia = self._enviar_lista(codigos=["NO-EXISTE"])
        self.assertEqual(vacia.status_code, 400)
        self.assertEqual(vacia.data["codigos_no_encontrados"], ["NO-EXISTE"])

        otra = Sucursal.objects.create(nombre="Sur", direccion="Av 2")
        response = self._enviar_lista(sucursal_id=otra.id, producto_ids=[self.producto.id])
        self.assertEqual(response.status_code, 400)
