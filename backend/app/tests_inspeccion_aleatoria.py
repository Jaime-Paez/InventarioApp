from datetime import time as dt_time, timedelta
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
        # Estas pruebas cubren tambien la automatica (en produccion esta apagada).
        config.inspeccion_automatica = True
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

    def _diferencias(self, inspection):
        return inspection.items.filter(
            estado_revision=InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE
        ).count()

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
        self.assertEqual(self._diferencias(inspection), 0)
        item = inspection.items.get()
        self.assertEqual(item.estado_revision, "coincide")
        self.assertEqual(item.cantidad_esperada, 8)
        self.assertEqual(item.cantidad_esperada_inicial, 10)

    def test_aprobar_no_descuenta_dos_veces_las_ventas(self):
        inspection = self._crear_inspeccion()
        Inventario.objects.filter(pk=self.inv_a.pk).update(cantidad=8)  # venta antes de contar
        response = self._responder(inspection, {self.producto.id: 7})
        self.assertEqual(self._diferencias(inspection), 1)

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

        revealed = self.revisor_client.patch(
            f"{BASE_URL}/{inspection.id}/borrador/",
            {"revelar": True, "fase": "resumen", "items": [{"id": item.id, "cantidad_reportada": 6}]},
            format="json",
        )
        self.assertEqual(revealed.status_code, 200, revealed.data)
        # El revisor sigue sin ver el esperado; administracion si.
        self.assertIsNone(revealed.data["inspection"]["items"][0]["cantidad_esperada"])
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
        self._responder_por_ubicacion(inspection, 3, 5)
        self.assertEqual(self._diferencias(inspection), 1)

        item = inspection.items.get()
        self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/",
            {"accion": "aprobar", "cantidad_confirmada": 8},
            format="json",
        )
        self.assertEqual(self._stock(subdivision=self.sub_a), 3)
        self.assertEqual(self._stock(subdivision=self.sub_b), 5)

    def test_total_correcto_con_ubicaciones_cruzadas_espera_al_administrador(self):
        inspection = self._crear_inspeccion()
        self._responder_por_ubicacion(inspection, 3, 7)

        # No se corrige solo: queda pendiente como "cambio de ubicacion".
        item = inspection.items.get()
        self.assertTrue(item.cambio_ubicacion)
        self.assertEqual(item.verificacion_estado, "pendiente")
        self.assertEqual(self._diferencias(inspection), 1)
        self.assertEqual(self._stock(subdivision=self.sub_a), 5)
        self.assertEqual(self._stock(subdivision=self.sub_b), 5)

        response = self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/",
            {
                "accion": "aprobar",
                "cantidades_por_ubicacion": [
                    {"subdivision_id": self.sub_a.id, "cantidad": 3},
                    {"subdivision_id": self.sub_b.id, "cantidad": 7},
                ],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(), 10)
        self.assertEqual(self._stock(subdivision=self.sub_a), 3)
        self.assertEqual(self._stock(subdivision=self.sub_b), 7)

    def test_cambio_de_ubicacion_rechazado_no_mueve_nada(self):
        inspection = self._crear_inspeccion()
        self._responder_por_ubicacion(inspection, 3, 7)
        item = inspection.items.get()
        response = self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/", {"accion": "rechazar"}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(subdivision=self.sub_a), 5)
        self.assertEqual(self._stock(subdivision=self.sub_b), 5)


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

    def test_division_tambien_cuenta_las_otras_ubicaciones_del_producto(self):
        # P-1 esta en la division enviada (10) y tambien en otra division (3).
        Inventario.objects.create(producto=self.producto, subdivision=self.sub_b, cantidad=3)
        response = self.admin_client.post(
            f"{BASE_URL}/enviar-division/",
            {"division_id": self.division.id, "usuario_id": self.revisor.id, "hora_recordatorio": "23:59"},
            format="json",
        )
        inspection = InspeccionAleatoriaDiaria.objects.get(pk=response.data["inspeccion_id"])
        self.assertTrue(inspection.cuenta_toda_la_sucursal)

        detail = self.revisor_client.get(f"{BASE_URL}/{inspection.id}/").data["inspection"]
        item = next(row for row in detail["items"] if row["producto_id"] == self.producto.id)
        ubicaciones = {row["subdivision_id"]: row["division_id"] for row in item["ubicaciones_bodega"]}
        self.assertEqual(ubicaciones, {self.sub_a.id: self.division.id, self.sub_b.id: self.division_b.id})

        # Si solo cuenta la division, falta lo de la otra ubicacion: es diferencia.
        self._responder(inspection, {self.producto.id: 10, self.producto_2.id: 4})
        self.assertEqual(
            inspection.items.get(producto=self.producto).estado_revision, "no_coincide"
        )
        self.assertEqual(inspection.items.get(producto=self.producto).cantidad_esperada, 13)

    def test_revision_de_division_anterior_sigue_solo_en_su_division(self):
        Inventario.objects.create(producto=self.producto, subdivision=self.sub_b, cantidad=3)
        response = self.admin_client.post(
            f"{BASE_URL}/enviar-division/",
            {"division_id": self.division.id, "usuario_id": self.revisor.id, "hora_recordatorio": "23:59"},
            format="json",
        )
        inspection = InspeccionAleatoriaDiaria.objects.get(pk=response.data["inspeccion_id"])
        InspeccionAleatoriaDiaria.objects.filter(pk=inspection.pk).update(cuenta_toda_la_sucursal=False)
        response = self._responder(inspection, {self.producto.id: 10, self.producto_2.id: 4})
        self.assertEqual(self._diferencias(inspection), 0)

    def test_reenviar_la_misma_division_no_duplica_y_responde_ok(self):
        body = {"division_id": self.division.id, "usuario_id": self.revisor.id, "hora_recordatorio": "23:59"}
        primera = self.admin_client.post(f"{BASE_URL}/enviar-division/", body, format="json")
        repetida = self.admin_client.post(f"{BASE_URL}/enviar-division/", body, format="json")

        self.assertEqual(primera.status_code, 200, primera.data)
        self.assertEqual(repetida.status_code, 200, repetida.data)
        self.assertTrue(repetida.data["ya_enviada"])
        self.assertNotIn("ya_enviada", primera.data)
        self.assertEqual(repetida.data["inspeccion_id"], primera.data["inspeccion_id"])
        inspection = InspeccionAleatoriaDiaria.objects.get(pk=primera.data["inspeccion_id"])
        self.assertEqual(InspeccionAleatoriaDiaria.objects.filter(es_por_division=True).count(), 1)
        self.assertEqual(inspection.items.count(), primera.data["productos"])
        self.assertEqual(inspection.total_items, primera.data["productos"])


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
        self.assertEqual(self._diferencias(inspection), 1)

    def test_la_misma_lista_repetida_no_crea_otra_inspeccion(self):
        # Doble click en "Enviar lista": antes se creaban 2 o 3 iguales.
        primera = self._enviar_lista(producto_ids=[self.producto.id, self.producto_2.id])
        repetida = self._enviar_lista(producto_ids=[self.producto_2.id, self.producto.id])
        self.assertEqual(repetida.status_code, 200, repetida.data)
        self.assertTrue(repetida.data["ya_enviada"])
        self.assertEqual(repetida.data["inspeccion_id"], primera.data["inspeccion_id"])
        self.assertEqual(
            InspeccionAleatoriaDiaria.objects.filter(usuario=self.revisor, es_por_lista=True).count(), 1
        )
        # Una lista distinta si crea otra, y la nueva queda pendiente para el revisor.
        otra = self._enviar_lista(producto_ids=[self.producto.id])
        self.assertNotEqual(otra.data["inspeccion_id"], primera.data["inspeccion_id"])
        self.assertNotIn("ya_enviada", otra.data)

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


class VerResultadoConProductosPendientesTests(InspeccionAleatoriaBaseTestCase):
    def test_se_puede_ver_el_resultado_aunque_falten_productos(self):
        inspection = self._crear_inspeccion(productos=[self.producto, self.producto_2])
        item_1 = inspection.items.get(producto=self.producto)
        item_2 = inspection.items.get(producto=self.producto_2)

        response = self.revisor_client.patch(
            f"{BASE_URL}/{inspection.id}/borrador/",
            {"revelar": True, "fase": "resumen", "items": [{"id": item_1.id, "cantidad_reportada": 9}]},
            format="json",
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertIsNone(response.data["inspection"]["items"][0]["cantidad_esperada"])
        item_1.refresh_from_db()
        item_2.refresh_from_db()
        self.assertEqual(item_1.cantidad_primer_conteo, 9)
        self.assertIsNone(item_2.cantidad_primer_conteo)


class RevisorNoVeElResultadoTests(InspeccionAleatoriaBaseTestCase):
    def test_el_revisor_no_recibe_esperado_ni_diferencias_despues_de_enviar(self):
        inspection = self._crear_inspeccion()
        response = self._responder(inspection, {self.producto.id: 7})

        self.assertEqual(response.status_code, 200, response.data)
        self.assertNotIn("mismatch_count", response.data)
        item = response.data["inspection"]["items"][0]
        self.assertIsNone(item["cantidad_esperada"])
        self.assertEqual(item["estado_revision"], "revisado")
        self.assertEqual(item["verificacion_estado"], "")
        self.assertEqual(item["cantidad_reportada"], 7)

        # Administracion si lo ve todo.
        admin_view = self.admin_client.get(f"{BASE_URL}/{inspection.id}/")
        admin_item = admin_view.data["inspection"]["items"][0]
        self.assertEqual(admin_item["cantidad_esperada"], 10)
        self.assertEqual(admin_item["estado_revision"], "no_coincide")
        self.assertEqual(admin_item["verificacion_estado"], "pendiente")


class DiferenciasAdminTests(InspeccionAleatoriaBaseTestCase):
    def test_admin_recibe_conteo_por_ubicacion_con_nombre(self):
        Inventario.objects.filter(pk=self.inv_a.pk).update(cantidad=5)
        Inventario.objects.create(producto=self.producto, subdivision=self.sub_b, cantidad=5)
        inspection = self._crear_inspeccion()
        item = inspection.items.get()
        self.revisor_client.post(
            f"{BASE_URL}/{inspection.id}/responder/",
            {
                "items": [
                    {
                        "id": item.id,
                        "cantidad_reportada": 8,
                        "cantidad_por_ubicacion": [
                            {"key": "a", "subdivision_id": self.sub_a.id, "cantidad": 3},
                            {"key": "b", "subdivision_id": self.sub_b.id, "cantidad": 5},
                        ],
                    }
                ]
            },
            format="json",
        )

        response = self.admin_client.get(
            f"{BASE_URL}/admin/items/", {"sucursal_id": self.sucursal.id, "estado": "pendiente"}
        )

        self.assertEqual(response.status_code, 200, response.data)
        row = response.data["results"][0]
        self.assertEqual(row["cantidad_esperada"], 10)
        self.assertEqual(row["cantidad_reportada"], 8)
        self.assertEqual(
            [(u["label"], u["cantidad_contada"], u["cantidad_sistema"]) for u in row["ubicaciones_conteo"]],
            [("Principal / Percha A / Nivel 1", 3, 5), ("Principal / Percha B / Nivel 1", 5, 5)],
        )


class HoraRecordatorioTests(InspeccionAleatoriaBaseTestCase):
    def test_hora_que_ya_paso_se_envia_con_la_hora_actual(self):
        time_str, error = app_views._parse_reminder_time("00:00")
        now = timezone.localtime()
        self.assertIsNone(error)
        if (now.hour, now.minute) > (0, 0):
            self.assertEqual(time_str, f"{now.hour:02d}:{now.minute:02d}")

    def test_hora_futura_se_respeta_y_formato_invalido_falla(self):
        self.assertEqual(app_views._parse_reminder_time("23:59"), ("23:59", None))
        self.assertEqual(app_views._parse_reminder_time("25:00")[0], "")
        self.assertIsNotNone(app_views._parse_reminder_time("abc")[1])


class ConfirmarPorUbicacionTests(InspeccionAleatoriaBaseTestCase):
    def setUp(self):
        super().setUp()
        Inventario.objects.filter(pk=self.inv_a.pk).update(cantidad=8)
        self.inv_b = Inventario.objects.create(producto=self.producto, subdivision=self.sub_b, cantidad=6)

    def test_admin_confirma_una_cantidad_distinta_en_cada_ubicacion(self):
        inspection = self._crear_inspeccion()
        item = inspection.items.get()
        self.revisor_client.post(
            f"{BASE_URL}/{inspection.id}/responder/",
            {
                "items": [
                    {
                        "id": item.id,
                        "cantidad_reportada": 7,
                        "cantidad_por_ubicacion": [
                            {"key": "a", "subdivision_id": self.sub_a.id, "cantidad": 5},
                            {"key": "b", "subdivision_id": self.sub_b.id, "cantidad": 2},
                        ],
                    }
                ]
            },
            format="json",
        )

        # El admin recuenta: en A hay 6 (no 5) y en B 6 (como el sistema).
        response = self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/",
            {
                "accion": "aprobar",
                "cantidades_por_ubicacion": [
                    {"subdivision_id": self.sub_a.id, "cantidad": 6},
                    {"subdivision_id": self.sub_b.id, "cantidad": 6},
                ],
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(subdivision=self.sub_a), 6)
        self.assertEqual(self._stock(subdivision=self.sub_b), 6)
        item.refresh_from_db()
        self.assertEqual(item.cantidad_confirmada, 12)
        self.assertEqual(
            sorted(entry["cantidad_confirmada"] for entry in item.conteo_ubicaciones), [6, 6]
        )

    def test_rechaza_ubicacion_que_no_es_del_conteo(self):
        inspection = self._crear_inspeccion()
        item = inspection.items.get()
        self._responder(inspection, {self.producto.id: 10})
        otra = SubDivision.objects.create(division=self.division, nombre="Nivel 9")
        item.refresh_from_db()
        if item.estado_revision != "no_coincide":
            item.estado_revision = "no_coincide"
            item.verificacion_estado = "pendiente"
            item.save(update_fields=["estado_revision", "verificacion_estado"])
        response = self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/",
            {"accion": "aprobar", "cantidades_por_ubicacion": [{"subdivision_id": otra.id, "cantidad": 3}]},
            format="json",
        )
        self.assertEqual(response.status_code, 400)


class InspeccionPorSubdivisionTests(InspeccionAleatoriaBaseTestCase):
    def setUp(self):
        super().setUp()
        # Segunda subdivision dentro de la misma division (Percha A).
        self.sub_a2 = SubDivision.objects.create(division=self.division, nombre="Nivel 2")
        self.inv_a2 = Inventario.objects.create(producto=self.producto, subdivision=self.sub_a2, cantidad=3)

    def _enviar(self, **extra):
        return self.admin_client.post(
            f"{BASE_URL}/enviar-division/",
            {
                "division_id": self.division.id,
                "usuario_id": self.revisor.id,
                "hora_recordatorio": "23:59",
                **extra,
            },
            format="json",
        )

    def test_productos_de_la_subdivision_se_buscan_en_todas_sus_ubicaciones(self):
        response = self._enviar(subdivision_id=self.sub_a2.id)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["subdivision_id"], self.sub_a2.id)
        inspection = InspeccionAleatoriaDiaria.objects.get(pk=response.data["inspeccion_id"])
        self.assertTrue(inspection.es_por_division)
        self.assertTrue(inspection.es_por_subdivision)
        # Solo el producto que hay en Nivel 2 (el producto_2 esta solo en Nivel 1).
        self.assertEqual(
            list(inspection.items.values_list("producto_id", flat=True)), [self.producto.id]
        )

        # Tambien se manda a buscar en Nivel 1 (su otra ubicacion): esperado 13.
        Inventario.objects.create(producto=self.producto, subdivision=self.sub_b, cantidad=4)
        detail = self.revisor_client.get(f"{BASE_URL}/{inspection.id}/")
        self.assertEqual(detail.status_code, 200, detail.data)
        payload = detail.data.get("inspection", detail.data)
        labels = {row["subdivision_id"] for row in payload["items"][0]["ubicaciones_bodega"]}
        self.assertEqual(labels, {self.sub_a.id, self.sub_a2.id, self.sub_b.id})
        self._responder(inspection, {self.producto.id: 17})
        self.assertEqual(self._diferencias(inspection), 0)

    def test_aprobar_ajusta_cada_ubicacion_contada(self):
        response = self._enviar(subdivision_id=self.sub_a2.id)
        inspection = InspeccionAleatoriaDiaria.objects.get(pk=response.data["inspeccion_id"])
        item = inspection.items.get()
        self.revisor_client.post(
            f"{BASE_URL}/{inspection.id}/responder/",
            {
                "items": [
                    {
                        "id": item.id,
                        "cantidad_reportada": 11,
                        "cantidad_por_ubicacion": [
                            {"key": "a", "subdivision_id": self.sub_a.id, "cantidad": 10},
                            {"key": "a2", "subdivision_id": self.sub_a2.id, "cantidad": 1},
                        ],
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(self._diferencias(inspection), 1)

        response = self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/",
            {"accion": "aprobar", "cantidad_confirmada": 11},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.inv_a.refresh_from_db()
        self.inv_a2.refresh_from_db()
        self.assertEqual(self.inv_a2.cantidad, 1)
        self.assertEqual(self.inv_a.cantidad, 10)

    def test_division_completa_y_subdivision_el_mismo_dia_son_separadas(self):
        por_subdivision = self._enviar(subdivision_id=self.sub_a2.id)
        division_completa = self._enviar()
        self.assertEqual(por_subdivision.status_code, 200, por_subdivision.data)
        self.assertEqual(division_completa.status_code, 200, division_completa.data)
        self.assertNotEqual(
            por_subdivision.data["inspeccion_id"], division_completa.data["inspeccion_id"]
        )
        completa = InspeccionAleatoriaDiaria.objects.get(pk=division_completa.data["inspeccion_id"])
        self.assertFalse(completa.es_por_subdivision)
        self.assertEqual(completa.items.count(), 2)

    def test_subdivision_de_otra_division_se_rechaza(self):
        response = self._enviar(subdivision_id=self.sub_b.id)
        self.assertEqual(response.status_code, 404)


class RecordatorioEnProgresoTests(InspeccionAleatoriaBaseTestCase):
    """El aviso "en progreso" sale del borrador guardado en el servidor."""

    def _contexto(self, inspection):
        response = self.revisor_client.get("/recordatorios/estado/")
        self.assertEqual(response.status_code, 200)
        for reminder in response.data["reminders"]:
            context = reminder.get("context") or {}
            if context.get("type") == app_views.RANDOM_INSPECTION_CONTEXT_TYPE and str(
                context.get("id")
            ) == str(inspection.id):
                return context
        return None

    def test_en_progreso_segun_borrador_del_servidor(self):
        response = self.admin_client.post(
            f"{BASE_URL}/enviar-division/",
            {"division_id": self.division.id, "usuario_id": self.revisor.id, "hora_recordatorio": "23:59"},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        inspection = InspeccionAleatoriaDiaria.objects.get(pk=response.data["inspeccion_id"])

        context = self._contexto(inspection)
        self.assertIsNotNone(context)
        self.assertFalse(context["en_progreso"])

        InspeccionAleatoriaDiaria.objects.filter(pk=inspection.pk).update(borrador_version=1)
        self.assertTrue(self._contexto(inspection)["en_progreso"])


class TemaUsuarioTests(InspeccionAleatoriaBaseTestCase):
    """El tema claro/oscuro se guarda en la base, por usuario."""

    def test_guarda_y_lee_tema(self):
        url = "/usuarios/preferencias/tema/"
        self.assertEqual(self.revisor_client.get(url).data["tema"], "")
        self.assertEqual(self.revisor_client.put(url, {"tema": "dark"}, format="json").status_code, 200)
        self.assertEqual(self.revisor_client.get(url).data["tema"], "dark")
        self.assertEqual(self.revisor_client.put(url, {"tema": "rosado"}, format="json").status_code, 400)
        # Cada usuario tiene el suyo.
        self.assertEqual(self.admin_client.get(url).data["tema"], "")


class InspeccionPorDivisionOrdenTests(InspeccionAleatoriaBaseTestCase):
    """Por division: los productos salen en el orden de la percha, no al azar."""

    def test_productos_en_orden_de_subdivision_y_codigo(self):
        sub_10 = SubDivision.objects.create(division=self.division, nombre="Nivel 10")
        sub_2 = SubDivision.objects.create(division=self.division, nombre="Nivel 2")
        # Creados a proposito en desorden (ids altos para los primeros niveles).
        en_10 = Producto.objects.create(codigo="A-10", nombre="En nivel 10", precio=Decimal("1"))
        en_2_b = Producto.objects.create(codigo="B-2", nombre="En nivel 2 B", precio=Decimal("1"))
        en_2_a = Producto.objects.create(codigo="A-2", nombre="En nivel 2 A", precio=Decimal("1"))
        Inventario.objects.create(producto=en_10, subdivision=sub_10, cantidad=1)
        Inventario.objects.create(producto=en_2_b, subdivision=sub_2, cantidad=1)
        Inventario.objects.create(producto=en_2_a, subdivision=sub_2, cantidad=1)

        response = self.admin_client.post(
            f"{BASE_URL}/enviar-division/",
            {"division_id": self.division.id, "usuario_id": self.revisor.id, "hora_recordatorio": "23:59"},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        inspection = InspeccionAleatoriaDiaria.objects.get(pk=response.data["inspeccion_id"])
        codigos = list(inspection.items.order_by("id").values_list("producto__codigo", flat=True))
        # Nivel 1 (P-1, P-2), Nivel 2 (A-2, B-2), Nivel 10 (A-10).
        self.assertEqual(codigos, ["P-1", "P-2", "A-2", "B-2", "A-10"])


class CroquisConteoTests(InspeccionAleatoriaBaseTestCase):
    """Croquis: cuanto de cada percha (division) y nivel ya se conto."""

    URL = f"{BASE_URL}/admin/croquis/"

    def _divisiones(self, **params):
        response = self.admin_client.get(self.URL, {"sucursal_id": self.sucursal.id, **params})
        self.assertEqual(response.status_code, 200, response.data)
        return {division["nombre"]: division for division in response.data["divisiones"]}

    def _contar(self, inspection, producto, cantidad):
        item = inspection.items.get(producto=producto)
        InspeccionAleatoriaItem.objects.filter(pk=item.pk).update(
            estado_revision=InspeccionAleatoriaItem.EstadosRevision.COINCIDE,
            cantidad_reportada=cantidad,
            revisado_en=timezone.now(),
        )

    def test_conteo_de_sucursal_cubre_todas_las_perchas(self):
        Inventario.objects.create(producto=self.producto, subdivision=self.sub_b, cantidad=2)
        divisiones = self._divisiones()
        self.assertEqual((divisiones["Percha A"]["contados"], divisiones["Percha A"]["total"]), (0, 2))

        inspection = self._crear_inspeccion(productos=[self.producto], sucursal=self.sucursal)
        self._contar(inspection, self.producto, 12)
        divisiones = self._divisiones()
        # P-1 contado en toda la sucursal: cuenta en Percha A y Percha B.
        self.assertEqual(divisiones["Percha A"]["contados"], 1)
        self.assertEqual(divisiones["Percha B"]["contados"], 1)
        nivel = divisiones["Percha A"]["subdivisiones"][0]
        self.assertEqual([p["codigo"] for p in nivel["pendientes"]], ["P-2"])

    def test_conteo_por_division_solo_cubre_esa_percha(self):
        Inventario.objects.create(producto=self.producto, subdivision=self.sub_b, cantidad=2)
        response = self.admin_client.post(
            f"{BASE_URL}/enviar-division/",
            {"division_id": self.division_b.id, "usuario_id": self.revisor.id, "hora_recordatorio": "23:59"},
            format="json",
        )
        inspection = InspeccionAleatoriaDiaria.objects.get(pk=response.data["inspeccion_id"])
        self._contar(inspection, self.producto, 2)
        divisiones = self._divisiones()
        self.assertEqual(divisiones["Percha B"]["contados"], 1)
        self.assertEqual(divisiones["Percha A"]["contados"], 0)

    def test_rango_de_fechas(self):
        inspection = self._crear_inspeccion(productos=[self.producto], sucursal=self.sucursal)
        self._contar(inspection, self.producto, 10)
        manana = (timezone.localdate() + timezone.timedelta(days=1)).isoformat()
        self.assertEqual(self._divisiones()["Percha A"]["contados"], 1)
        self.assertEqual(self._divisiones(desde=manana)["Percha A"]["contados"], 0)

    def test_revisor_sin_permiso(self):
        response = self.revisor_client.get(self.URL, {"sucursal_id": self.sucursal.id})
        self.assertEqual(response.status_code, 403)


class YaContadosTests(InspeccionAleatoriaBaseTestCase):
    URL = f"{BASE_URL}/admin/ya-contados/"

    def test_cuenta_los_contados_recientes(self):
        inspection = self._crear_inspeccion(productos=[self.producto], sucursal=self.sucursal)
        item = inspection.items.get()
        InspeccionAleatoriaItem.objects.filter(pk=item.pk).update(
            estado_revision=InspeccionAleatoriaItem.EstadosRevision.COINCIDE, revisado_en=timezone.now()
        )
        response = self.admin_client.post(
            self.URL, {"sucursal_id": self.sucursal.id, "producto_ids": [self.producto.id, self.producto_2.id]}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual((response.data["total"], response.data["contados"]), (2, 1))
        self.assertEqual(response.data["productos"][0]["codigo"], "P-1")

        por_division = self.admin_client.post(self.URL, {"division_id": self.division.id}, format="json")
        self.assertEqual((por_division.data["total"], por_division.data["contados"]), (2, 1))

    def test_conteo_viejo_no_cuenta(self):
        inspection = self._crear_inspeccion(productos=[self.producto], sucursal=self.sucursal)
        InspeccionAleatoriaItem.objects.filter(inspeccion=inspection).update(
            estado_revision=InspeccionAleatoriaItem.EstadosRevision.COINCIDE,
            revisado_en=timezone.now() - timezone.timedelta(days=45),
        )
        response = self.admin_client.post(
            self.URL, {"sucursal_id": self.sucursal.id, "producto_ids": [self.producto.id]}, format="json"
        )
        self.assertEqual(response.data["contados"], 0)


class NoEncontradoTests(InspeccionAleatoriaBaseTestCase):
    def _responder_no_encontrado(self, inspection):
        body = {
            "items": [
                {"id": item.id, "no_encontrado": True} for item in inspection.items.all()
            ],
        }
        return self.revisor_client.post(
            f"{BASE_URL}/{inspection.id}/responder/", body, format="json"
        )

    def test_no_encontrado_cuenta_como_cero_y_queda_marcado(self):
        inspection = self._crear_inspeccion()
        response = self._responder_no_encontrado(inspection)
        self.assertEqual(response.status_code, 200, response.data)
        item = inspection.items.get()
        self.assertTrue(item.no_encontrado)
        self.assertEqual(item.cantidad_reportada, 0)
        self.assertEqual(item.estado_revision, "no_coincide")
        self.assertEqual(item.verificacion_estado, "pendiente")

    def test_borrador_guarda_no_encontrado(self):
        inspection = self._crear_inspeccion()
        item = inspection.items.get()
        response = self.revisor_client.patch(
            f"{BASE_URL}/{inspection.id}/borrador/",
            {"items": [{"id": item.id, "no_encontrado": True, "cantidad_reportada": 0}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        item.refresh_from_db()
        self.assertTrue(item.no_encontrado)

    def test_admin_reubica_sin_cambiar_el_total(self):
        inspection = self._crear_inspeccion()
        self._responder_no_encontrado(inspection)
        item = inspection.items.get()
        response = self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/",
            {"accion": "reubicar", "subdivision_id": self.sub_b.id},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        item.refresh_from_db()
        self.assertEqual(item.verificacion_estado, "aprobada")
        self.assertEqual(item.reubicado_a_id, self.sub_b.id)
        self.assertIn("Reubicado a", item.nota_verificacion)
        self.assertEqual(self._stock(subdivision=self.sub_a), 0)
        self.assertEqual(self._stock(subdivision=self.sub_b), 10)
        self.assertEqual(self._stock(), 10)
        # La ubicacion vieja no queda en 0: se quita.
        self.assertFalse(Inventario.objects.filter(producto=self.producto, subdivision=self.sub_a).exists())

    def test_reubicar_a_otra_sucursal_se_rechaza(self):
        otra = Sucursal.objects.create(nombre="Sur", direccion="Av 2")
        bodega = Bodega.objects.create(sucursal=otra, nombre="Sur")
        division = Division.objects.create(tipo_division=self.division.tipo_division, bodega=bodega, nombre="X")
        sub = SubDivision.objects.create(division=division, nombre="1")
        inspection = self._crear_inspeccion()
        self._responder_no_encontrado(inspection)
        item = inspection.items.get()
        response = self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/",
            {"accion": "reubicar", "subdivision_id": sub.id},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self._stock(subdivision=self.sub_a), 10)


class AgregarProductoEncontradoTests(InspeccionAleatoriaBaseTestCase):
    def setUp(self):
        super().setUp()
        Inventario.objects.create(producto=self.producto_2, subdivision=self.sub_b, cantidad=2)
        self.inspection = self._crear_inspeccion(
            productos=[self.producto_2], es_por_division=True, division=self.division_b
        )

    def _agregar(self, **extra):
        body = {"producto_id": self.producto.id, "subdivision_id": self.sub_b.id, "cantidad": 3, **extra}
        return self.revisor_client.post(
            f"{BASE_URL}/{self.inspection.id}/agregar-producto/", body, format="json"
        )

    def test_busca_y_agrega_producto_en_la_fila(self):
        response = self.revisor_client.get(f"{BASE_URL}/{self.inspection.id}/buscar-producto/?q=P-")
        self.assertEqual(response.status_code, 200, response.data)
        en_lista = {row["codigo"]: row["en_lista"] for row in response.data["results"]}
        self.assertEqual(en_lista, {"P-1": False, "P-2": True})

        response = self._agregar()
        self.assertEqual(response.status_code, 201, response.data)
        item = self.inspection.items.get(producto=self.producto)
        self.assertTrue(item.agregado_por_revisor)
        self.assertEqual(item.encontrado_en_id, self.sub_b.id)
        self.assertEqual(item.cantidad_reportada, 3)
        self.assertEqual(item.cantidad_esperada, 0)
        self.inspection.refresh_from_db()
        self.assertEqual(self.inspection.total_items, 2)

    def test_no_repite_y_valida_ubicacion_y_cantidad(self):
        self.assertEqual(self._agregar(producto_id=self.producto_2.id).status_code, 400)
        self.assertEqual(self._agregar(cantidad=0).status_code, 400)
        otra = Sucursal.objects.create(nombre="Sur", direccion="Av 2")
        bodega = Bodega.objects.create(sucursal=otra, nombre="Sur")
        division = Division.objects.create(tipo_division=self.division.tipo_division, bodega=bodega, nombre="X")
        sub_otra = SubDivision.objects.create(division=division, nombre="1")
        self.assertEqual(self._agregar(subdivision_id=sub_otra.id).status_code, 400)

    def test_se_puede_elegir_otra_ubicacion_de_la_sucursal(self):
        response = self.revisor_client.get(f"{BASE_URL}/{self.inspection.id}/ubicaciones/")
        self.assertEqual(response.status_code, 200, response.data)
        ids = {row["subdivision_id"]: row["en_revision"] for row in response.data["results"]}
        self.assertEqual(ids, {self.sub_a.id: False, self.sub_b.id: True})

        response = self._agregar(subdivision_id=self.sub_a.id)
        self.assertEqual(response.status_code, 201, response.data)
        item = self.inspection.items.get(producto=self.producto)
        self.assertEqual(item.encontrado_en_id, self.sub_a.id)

    def test_admin_mueve_aqui_sin_inventar_stock(self):
        self._agregar()
        response = self._responder(self.inspection, {self.producto.id: 3, self.producto_2.id: 2})
        self.assertEqual(response.status_code, 200, response.data)
        item = self.inspection.items.get(producto=self.producto)
        self.assertEqual(item.estado_revision, "no_coincide")
        self.assertEqual(item.conteo_ubicaciones[0]["subdivision_id"], self.sub_b.id)

        response = self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/", {"accion": "mover_aqui"}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        item.refresh_from_db()
        self.assertEqual(item.verificacion_estado, "aprobada")
        self.assertEqual(self._stock(subdivision=self.sub_a), 7)
        self.assertEqual(self._stock(subdivision=self.sub_b), 3)
        self.assertEqual(self._stock(), 10)

    def test_mover_aqui_suma_ajuste_si_no_alcanza(self):
        self._agregar(cantidad=12)
        self._responder(self.inspection, {self.producto.id: 12, self.producto_2.id: 2})
        item = self.inspection.items.get(producto=self.producto)
        response = self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/", {"accion": "mover_aqui"}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(subdivision=self.sub_a), 0)
        self.assertEqual(self._stock(subdivision=self.sub_b), 12)
        self.assertFalse(Inventario.objects.filter(producto=self.producto, subdivision=self.sub_a).exists())

    def test_tambien_en_revision_por_lista(self):
        """El formulario es el mismo para todas las revisiones: en una por
        lista tambien se puede agregar un producto encontrado."""
        lista = self._crear_inspeccion(productos=[self.producto_2], es_por_lista=True, sucursal=self.sucursal)
        response = self.revisor_client.get(f"{BASE_URL}/{lista.id}/ubicaciones/")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertIn(self.sub_b.id, {row["subdivision_id"] for row in response.data["results"]})
        response = self.revisor_client.post(
            f"{BASE_URL}/{lista.id}/agregar-producto/",
            {"producto_id": self.producto.id, "subdivision_id": self.sub_b.id, "cantidad": 1},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertTrue(lista.items.filter(producto=self.producto, agregado_por_revisor=True).exists())

    def _inspeccion_toda_la_sucursal(self):
        InspeccionAleatoriaDiaria.objects.filter(pk=self.inspection.pk).update(cuenta_toda_la_sucursal=True)
        self.inspection.refresh_from_db()

    def _recontar(self, cantidad_aqui, cantidad_alla, nota="Lo lleve a su ubicacion"):
        return self._agregar(
            cantidad=None,
            nota=nota,
            conteo_ubicaciones=[
                {"key": "b", "subdivision_id": self.sub_b.id, "cantidad": cantidad_aqui},
                {"key": "a", "subdivision_id": self.sub_a.id, "cantidad": cantidad_alla},
            ],
        )

    def test_buscar_trae_sus_ubicaciones_sin_cantidades(self):
        self._inspeccion_toda_la_sucursal()
        response = self.revisor_client.get(f"{BASE_URL}/{self.inspection.id}/buscar-producto/?q=P-1")
        row = next(row for row in response.data["results"] if row["codigo"] == "P-1")
        self.assertEqual([location["subdivision_id"] for location in row["ubicaciones"]], [self.sub_a.id])
        self.assertNotIn("cantidad", row["ubicaciones"][0])

    def test_lo_lleva_donde_estaba_y_recuenta_todas(self):
        # Encontro 1 aqui y lo llevo a donde habia 10: al recontar hay 11 alla.
        self._inspeccion_toda_la_sucursal()
        response = self._recontar(0, 11)
        self.assertEqual(response.status_code, 201, response.data)
        item = self.inspection.items.get(producto=self.producto)
        self.assertEqual(item.cantidad_reportada, 11)
        self.assertEqual(item.observacion, "Lo lleve a su ubicacion")

        detail = self.revisor_client.get(f"{BASE_URL}/{self.inspection.id}/").data["inspection"]
        row = next(row for row in detail["items"] if row["producto_id"] == self.producto.id)
        self.assertEqual(
            [location["subdivision_id"] for location in row["ubicaciones_bodega"]], [self.sub_b.id, self.sub_a.id]
        )

        response = self._responder(self.inspection, {self.producto.id: 11, self.producto_2.id: 2})
        self.assertEqual(response.status_code, 200, response.data)
        item.refresh_from_db()
        response = self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/", {"accion": "aprobar"}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(subdivision=self.sub_a), 11)
        self.assertEqual(self._stock(subdivision=self.sub_b), 0)

    def test_trae_todo_a_esta_fila_y_recuenta(self):
        # Esta es la ubicacion nueva: trajo los de alla y aqui quedan 9 (habia 8 + 1).
        self._inspeccion_toda_la_sucursal()
        self.assertEqual(self._recontar(9, 0, nota="Traje todo aqui").status_code, 201)
        self._responder(self.inspection, {self.producto.id: 9, self.producto_2.id: 2})
        item = self.inspection.items.get(producto=self.producto)
        response = self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/", {"accion": "aprobar"}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(subdivision=self.sub_b), 9)
        self.assertEqual(self._stock(subdivision=self.sub_a), 0)

    def test_recuento_debe_incluir_esta_fila_y_todas_contadas(self):
        self._inspeccion_toda_la_sucursal()
        sin_esta = self._agregar(conteo_ubicaciones=[{"key": "a", "subdivision_id": self.sub_a.id, "cantidad": 3}])
        self.assertEqual(sin_esta.status_code, 400)
        incompleto = self._agregar(conteo_ubicaciones=[
            {"key": "b", "subdivision_id": self.sub_b.id, "cantidad": 1},
            {"key": "a", "subdivision_id": self.sub_a.id, "cantidad": ""},
        ])
        self.assertEqual(incompleto.status_code, 400)

    def test_quita_solo_lo_que_agrego(self):
        self._agregar()
        agregado = self.inspection.items.get(producto=self.producto)
        de_la_lista = self.inspection.items.get(producto=self.producto_2)
        url = f"{BASE_URL}/{self.inspection.id}/quitar-producto/"
        self.assertEqual(self.revisor_client.post(url, {"item_id": de_la_lista.id}, format="json").status_code, 400)
        response = self.revisor_client.post(url, {"item_id": agregado.id}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(self.inspection.items.filter(pk=agregado.pk).exists())
        self.inspection.refresh_from_db()
        self.assertEqual(self.inspection.total_items, 1)

    def test_buscar_producto_por_referencia(self):
        from productos.models import ProductoReferencia

        ProductoReferencia.objects.create(producto=self.producto, valor="ZZ-REF-1234")
        response = self.revisor_client.get(f"{BASE_URL}/{self.inspection.id}/buscar-producto/?q=1234")
        self.assertEqual([row["codigo"] for row in response.data["results"]], ["P-1"])


class RevisionesConDiferenciasTests(InspeccionAleatoriaBaseTestCase):
    def _revisiones(self, estado="pendiente"):
        response = self.admin_client.get(
            f"{BASE_URL}/admin/revisiones/?sucursal_id={self.sucursal.id}&estado={estado}"
        )
        self.assertEqual(response.status_code, 200, response.data)
        return response.data["results"]

    def test_agrupa_las_diferencias_por_revision_con_su_codigo(self):
        Sucursal.objects.filter(pk=self.sucursal.pk).update(codigo="9OCT")
        con_diferencia = self._crear_inspeccion(es_por_lista=True, sucursal=self.sucursal)
        self._responder(con_diferencia, {self.producto.id: 7})
        sin_diferencia = self._crear_inspeccion(es_por_lista=True, sucursal=self.sucursal)
        self._responder(sin_diferencia, {self.producto.id: 10})
        self.assertEqual((con_diferencia.codigo, sin_diferencia.codigo), ("REV-9OCT-L1", "REV-9OCT-L2"))

        pendientes = self._revisiones()
        self.assertEqual([row["id"] for row in pendientes], [con_diferencia.id])
        self.assertEqual(pendientes[0]["codigo"], "REV-9OCT-L1")
        self.assertEqual(pendientes[0]["descripcion"], "Lista de productos")
        self.assertEqual(
            (pendientes[0]["productos"], pendientes[0]["diferencias"], pendientes[0]["pendientes"]), (1, 1, 1)
        )

        items = self.admin_client.get(
            f"{BASE_URL}/admin/items/?sucursal_id={self.sucursal.id}&estado=todos&inspeccion_id={sin_diferencia.id}"
        ).data["results"]
        self.assertEqual([row["inspeccion_codigo"] for row in items], ["REV-9OCT-L2"])

        item = con_diferencia.items.get()
        self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/", {"accion": "aprobar", "cantidad_confirmada": 7}, format="json"
        )
        self.assertEqual(self._revisiones(), [])
        self.assertEqual([row["id"] for row in self._revisiones("verificado")], [con_diferencia.id])

    def test_historial_pendientes_arriba_y_solucionadas_abajo(self):
        revisada = self._crear_inspeccion(es_por_lista=True, sucursal=self.sucursal)
        self._responder(revisada, {self.producto.id: 10})
        solucionada = self._crear_inspeccion(es_por_lista=True, sucursal=self.sucursal)
        self._responder(solucionada, {self.producto.id: 9})
        self.admin_client.post(
            f"{BASE_URL}/items/{solucionada.items.get().id}/verificar/",
            {"accion": "aprobar", "cantidad_confirmada": 9},
            format="json",
        )
        pendiente = self._crear_inspeccion(es_por_lista=True, sucursal=self.sucursal)
        self._responder(pendiente, {self.producto.id: 7})
        en_curso = self._crear_inspeccion(es_por_lista=True, sucursal=self.sucursal)

        todas = self._revisiones("todos")
        estados = {row["id"]: row["estado_revision"] for row in todas}
        self.assertEqual(
            estados,
            {revisada.id: "revisada", solucionada.id: "solucionada", pendiente.id: "pendiente", en_curso.id: "en_curso"},
        )
        # Primero la que tiene diferencias por verificar, luego en curso, abajo lo cerrado.
        self.assertEqual([row["id"] for row in todas[:2]], [pendiente.id, en_curso.id])
        self.assertEqual({row["id"] for row in self._revisiones("pendientes")}, {pendiente.id, en_curso.id})
        self.assertEqual({row["id"] for row in self._revisiones("solucionadas")}, {revisada.id, solucionada.id})

    def test_codigo_por_sucursal_y_tipo(self):
        Sucursal.objects.filter(pk=self.sucursal.pk).update(codigo="NOR")
        response = self.admin_client.post(
            f"{BASE_URL}/enviar-division/",
            {"division_id": self.division.id, "usuario_id": self.revisor.id, "hora_recordatorio": "23:59"},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        division = InspeccionAleatoriaDiaria.objects.get(pk=response.data["inspeccion_id"])
        self.assertEqual(division.codigo, "REV-NOR-D1")
        # Cada tipo lleva su propio correlativo; sin sucursal es GEN.
        lista = self._crear_inspeccion(es_por_lista=True, sucursal=self.sucursal)
        aleatoria = self._crear_inspeccion()
        self.assertEqual((lista.codigo, aleatoria.codigo), ("REV-NOR-L1", "REV-GEN-A1"))


class ReconteoTests(InspeccionAleatoriaBaseTestCase):
    def _recontar(self, item):
        return self.admin_client.post(f"{BASE_URL}/items/{item.id}/verificar/", {"accion": "recontar"}, format="json")

    def test_reenvia_hasta_tres_veces_y_luego_hay_que_solucionarlo(self):
        Sucursal.objects.filter(pk=self.sucursal.pk).update(codigo="9OCT")
        original = self._crear_inspeccion(es_por_lista=True, sucursal=self.sucursal)
        self._responder(original, {self.producto.id: 7})
        item = original.items.get()
        for numero in (1, 2, 3):
            response = self._recontar(item)
            self.assertEqual(response.status_code, 200, response.data)
            item.refresh_from_db()
            self.assertEqual(item.verificacion_estado, "reconteo")
            nuevo = InspeccionAleatoriaItem.objects.get(reconteo_de=item)
            self.assertEqual(nuevo.reconteos, numero)
            self.assertEqual(nuevo.inspeccion.usuario_id, original.usuario_id)
            self.assertTrue(nuevo.inspeccion.nota_general.startswith("Reconteo de "))
            # El revisor vuelve a contar y sigue la diferencia.
            self._responder(nuevo.inspeccion, {self.producto.id: 7})
            item = InspeccionAleatoriaItem.objects.get(pk=nuevo.pk)
            self.assertEqual(item.estado_revision, "no_coincide")
        # Tercer reconteo: ya no se puede reenviar, hay que solucionarlo.
        self.assertEqual(self._recontar(item).status_code, 400)
        self.assertEqual(self._stock(), 10)

    def test_los_de_una_misma_revision_van_juntos_al_reconteo(self):
        original = self._crear_inspeccion(productos=[self.producto, self.producto_2], es_por_lista=True, sucursal=self.sucursal)
        self._responder(original, {self.producto.id: 7, self.producto_2.id: 1})
        for item in original.items.all():
            self.assertEqual(self._recontar(item).status_code, 200)
        reconteos = InspeccionAleatoriaDiaria.objects.filter(nota_general__startswith="Reconteo de ")
        self.assertEqual(reconteos.count(), 1)
        self.assertEqual(reconteos.get().items.count(), 2)


class MismoProductoEnDosInspeccionesTests(InspeccionAleatoriaBaseTestCase):
    def _verificar(self, item, cantidad):
        return self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/",
            {"accion": "aprobar", "cantidad_confirmada": cantidad, "nota": "ok"},
            format="json",
        )

    def test_aprobar_las_dos_no_resta_la_diferencia_dos_veces(self):
        # El mismo producto en la automatica y en una lista: los dos conteos
        # dan 8 contra 10 en el sistema. Antes quedaba 10 -> 8 -> 6.
        automatica = self._crear_inspeccion()
        lista = self._crear_inspeccion(es_por_lista=True, sucursal=self.sucursal)
        self.assertEqual(self._responder(automatica, {self.producto.id: 8}).status_code, 200)
        self.assertEqual(self._responder(lista, {self.producto.id: 8}).status_code, 200)

        primera = self._verificar(automatica.items.get(), 8)
        self.assertEqual(primera.status_code, 200, primera.data)
        self.assertEqual(self._stock(), 8)
        segunda = self._verificar(lista.items.get(), 8)
        self.assertEqual(segunda.status_code, 200, segunda.data)
        self.assertEqual(self._stock(), 8)
        item = lista.items.get()
        self.assertEqual(item.verificacion_estado, InspeccionAleatoriaItem.EstadosVerificacion.APROBADA)
        self.assertIn(f"#{automatica.id}", item.nota_verificacion or "")

    def test_segundo_admin_recibe_aviso_de_ya_verificado(self):
        inspection = self._crear_inspeccion()
        self._responder(inspection, {self.producto.id: 8})
        item = inspection.items.get()
        self._verificar(item, 8)
        otra = self._verificar(item, 8)
        self.assertEqual(otra.status_code, 400)
        self.assertTrue(otra.data["ya_verificado"])
        self.assertEqual(self._stock(), 8)


class RecordatorioConservaTextoYHoraTests(InspeccionAleatoriaBaseTestCase):
    def test_enviar_el_conteo_de_una_lista_no_cambia_su_texto_ni_su_hora(self):
        response = self.admin_client.post(
            f"{BASE_URL}/enviar-lista/",
            {
                "sucursal_id": self.sucursal.id,
                "usuario_id": self.revisor.id,
                "producto_ids": [self.producto.id],
                "hora_recordatorio": "23:59",
            },
            format="json",
        )
        inspection = InspeccionAleatoriaDiaria.objects.get(pk=response.data["inspeccion_id"])

        def reminder():
            store = ReminderState.get_global()
            return next(r for r in store.payload if r.get("id") == f"insp-{inspection.id}")

        antes = reminder()
        self.assertEqual(self._responder(inspection, {self.producto.id: 10}).status_code, 200)
        despues = reminder()
        self.assertEqual(despues["time"], antes["time"])
        self.assertEqual(despues["description"], antes["description"])
        self.assertIn(str(self.revisor.id), despues["completedBy"])


class AvisoYaContadoTests(InspeccionAleatoriaBaseTestCase):
    def _ya_contados(self, **body):
        return self.admin_client.post(f"{BASE_URL}/admin/ya-contados/", body, format="json")

    def test_contado_en_otra_percha_no_cuenta_para_esta(self):
        # P-1 esta en las perchas A y B y solo se conto la A.
        Inventario.objects.create(producto=self.producto, subdivision=self.sub_b, cantidad=3)
        inspection = self._crear_inspeccion(
            es_por_division=True, division=self.division, sucursal=self.sucursal
        )
        self._responder(inspection, {self.producto.id: 10})

        en_b = self._ya_contados(sucursal_id=self.sucursal.id, producto_ids=[self.producto.id], division_id=self.division_b.id)
        self.assertEqual(en_b.status_code, 200, en_b.data)
        self.assertEqual(en_b.data["contados"], 0)

        en_a = self._ya_contados(sucursal_id=self.sucursal.id, producto_ids=[self.producto.id], division_id=self.division.id)
        self.assertEqual(en_a.data["contados"], 1)
        fila = en_a.data["productos"][0]
        self.assertEqual(fila["codigo"], "P-1")
        self.assertEqual(fila["donde"], "Percha A")
        self.assertEqual(en_a.data["contados_ids"], [self.producto.id])

    def test_conteo_de_toda_la_sucursal_cuenta_en_cualquier_percha(self):
        inspection = self._crear_inspeccion()
        self._responder(inspection, {self.producto.id: 10})
        response = self._ya_contados(division_id=self.division_b.id, producto_ids=[self.producto.id, self.producto_2.id])
        self.assertEqual(response.data["contados"], 1)
        self.assertEqual(response.data["total"], 2)
        self.assertEqual(response.data["productos"][0]["donde"], "Toda la sucursal")



class InspeccionAutomaticaApagadaTests(InspeccionAleatoriaBaseTestCase):
    def test_apagada_no_crea_inspecciones_y_quita_resumenes_vacios(self):
        config = InspeccionAleatoriaConfiguracion.get_global()
        config.inspeccion_automatica = False
        config.save()
        # Resumen viejo de un dia que se quedo sin inspecciones.
        store = ReminderState.get_global()
        ayer = timezone.localdate() - timedelta(days=1)
        store.payload = [
            {
                "id": f"insp-admin-summary-{ayer.isoformat()}",
                "date": ayer.isoformat(),
                "time": "09:00",
                "description": "Resumen",
                "kind": "inspeccion_aleatoria_resumen_admin",
                "context": {"type": "inspeccion_aleatoria", "id": ayer.isoformat(), "label": "Resumen"},
                "recipients": [{"id": str(self.admin.id), "name": "Admin"}],
                "creator": {"id": "sistema", "name": "Sistema"},
                "completedBy": [],
            }
        ]
        store.save()

        self.revisor_client.get("/recordatorios/estado/")
        self.admin_client.get("/recordatorios/estado/")

        self.assertFalse(InspeccionAleatoriaDiaria.objects.filter(usuario=self.revisor).exists())
        ids = [r.get("id") for r in ReminderState.get_global().payload]
        self.assertNotIn(f"insp-admin-summary-{ayer.isoformat()}", ids)

        config_response = self.admin_client.get(f"{BASE_URL}/configuracion/")
        self.assertFalse(config_response.data["inspeccion_automatica"])


class FaltanteAbiertoTests(InspeccionAleatoriaBaseTestCase):
    """Lo que falta al aprobar queda abierto y se va cerrando con lo que aparece."""

    def setUp(self):
        super().setUp()
        Inventario.objects.filter(pk=self.inv_a.pk).update(cantidad=11)

    def _verificar(self, item, **body):
        return self.admin_client.post(f"{BASE_URL}/items/{item.id}/verificar/", body, format="json")

    def _faltante_no_encontrado(self):
        inspection = self._crear_inspeccion()
        self.revisor_client.post(
            f"{BASE_URL}/{inspection.id}/responder/",
            {"items": [{"id": item.id, "no_encontrado": True} for item in inspection.items.all()]},
            format="json",
        )
        item = inspection.items.get()
        response = self._verificar(item, accion="aprobar", cantidad_confirmada=0)
        self.assertEqual(response.status_code, 200, response.data)
        # Fue otro dia: la siguiente revision del mismo revisor puede ser hoy.
        InspeccionAleatoriaDiaria.objects.filter(pk=inspection.pk).update(
            fecha_programada=timezone.localdate() - timedelta(days=1)
        )
        item.refresh_from_db()
        return item

    def _faltantes(self):
        response = self.admin_client.get(
            f"{BASE_URL}/admin/items/?sucursal_id={self.sucursal.id}&estado=faltantes"
        )
        self.assertEqual(response.status_code, 200, response.data)
        return response.data["results"]

    def test_no_encontrado_aprobado_queda_abierto(self):
        item = self._faltante_no_encontrado()
        self.assertEqual(item.cantidad_faltante, 11)
        self.assertEqual(self._stock(), 0)
        rows = self._faltantes()
        self.assertEqual([row["id"] for row in rows], [item.id])
        self.assertEqual(rows[0]["faltante_pendiente"], 11)
        resumen = self.admin_client.get(f"{BASE_URL}/admin/resumen/").data["results"]
        self.assertEqual(resumen[0]["faltantes_abiertos"], 1)

    def test_conteo_menor_tambien_deja_faltante(self):
        inspection = self._crear_inspeccion()
        self._responder(inspection, {self.producto.id: 8})
        item = inspection.items.get()
        self._verificar(item, accion="aprobar", cantidad_confirmada=8)
        item.refresh_from_db()
        self.assertEqual(item.cantidad_faltante, 3)

    def test_rechazar_no_deja_faltante(self):
        inspection = self._crear_inspeccion()
        self._responder(inspection, {self.producto.id: 8})
        item = inspection.items.get()
        self._verificar(item, accion="rechazar")
        item.refresh_from_db()
        self.assertEqual(item.cantidad_faltante, 0)
        self.assertEqual(self._faltantes(), [])

    def test_aparecen_5_en_otra_revision_y_siguen_faltando_6(self):
        faltante = self._faltante_no_encontrado()

        otra = self._crear_inspeccion()
        self._responder(otra, {self.producto.id: 5})
        nuevo = otra.items.get()
        response = self._verificar(nuevo, accion="aprobar", cantidad_confirmada=5)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["recupera_faltantes"][0]["cantidad"], 5)

        faltante.refresh_from_db()
        nuevo.refresh_from_db()
        self.assertEqual(self._stock(), 5)
        self.assertEqual(faltante.faltante_recuperado, 5)
        self.assertEqual(faltante.faltante_recuperaciones[0]["item_id"], nuevo.id)
        self.assertEqual(nuevo.recupera_faltantes, [{"item_id": faltante.id, "inspeccion_id": faltante.inspeccion_id, "cantidad": 5}])
        self.assertEqual(nuevo.cantidad_faltante, 0)
        self.assertIn(f"#{faltante.inspeccion_id}", nuevo.nota_verificacion)
        rows = self._faltantes()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["faltante_pendiente"], 6)

    def test_mover_aqui_cierra_faltante(self):
        faltante = self._faltante_no_encontrado()
        Inventario.objects.create(producto=self.producto_2, subdivision=self.sub_b, cantidad=2)
        otra = self._crear_inspeccion(productos=[self.producto_2], es_por_division=True, division=self.division_b)
        self.revisor_client.post(
            f"{BASE_URL}/{otra.id}/agregar-producto/",
            {"producto_id": self.producto.id, "subdivision_id": self.sub_b.id, "cantidad": 4},
            format="json",
        )
        self._responder(otra, {self.producto.id: 4, self.producto_2.id: 2})
        nuevo = otra.items.get(producto=self.producto)
        response = self._verificar(nuevo, accion="mover_aqui")
        self.assertEqual(response.status_code, 200, response.data)

        faltante.refresh_from_db()
        self.assertEqual(faltante.faltante_recuperado, 4)
        self.assertEqual(faltante.faltante_recuperaciones[0]["subdivision_id"], self.sub_b.id)
        self.assertEqual(self._stock(subdivision=self.sub_b), 4)

    def test_aparecio_manual_suma_stock_y_no_pasa_de_lo_pendiente(self):
        faltante = self._faltante_no_encontrado()
        url = f"{BASE_URL}/items/{faltante.id}/aparecio/"

        response = self.admin_client.post(url, {"subdivision_id": self.sub_b.id, "cantidad": 12}, format="json")
        self.assertEqual(response.status_code, 400)

        response = self.admin_client.post(url, {"subdivision_id": self.sub_b.id, "cantidad": 5}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["item"]["faltante_pendiente"], 6)
        self.assertEqual(self._stock(subdivision=self.sub_b), 5)
        self.assertEqual(response.data["item"]["faltante_recuperaciones"][0]["origen"], "manual")

        response = self.admin_client.post(url, {"subdivision_id": self.sub_a.id, "cantidad": 6}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._faltantes(), [])
        self.assertEqual(self._stock(), 11)

        response = self.admin_client.post(url, {"subdivision_id": self.sub_a.id, "cantidad": 1}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_aparecio_en_otra_sucursal_se_rechaza(self):
        faltante = self._faltante_no_encontrado()
        otra = Sucursal.objects.create(nombre="Sur", direccion="Av 2")
        bodega = Bodega.objects.create(sucursal=otra, nombre="Sur")
        division = Division.objects.create(tipo_division=self.division.tipo_division, bodega=bodega, nombre="X")
        sub = SubDivision.objects.create(division=division, nombre="1")
        response = self.admin_client.post(
            f"{BASE_URL}/items/{faltante.id}/aparecio/", {"subdivision_id": sub.id, "cantidad": 1}, format="json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self._stock(), 0)


class NoEncontradoPorUbicacionTests(InspeccionAleatoriaBaseTestCase):
    """'No lo encontre' en una sola ubicacion del producto."""

    def setUp(self):
        super().setUp()
        Inventario.objects.filter(pk=self.inv_a.pk).update(cantidad=5)
        Inventario.objects.create(producto=self.producto, subdivision=self.sub_b, cantidad=3)

    def _responder(self, inspection, ubicaciones):
        item = inspection.items.get()
        return self.revisor_client.post(
            f"{BASE_URL}/{inspection.id}/responder/",
            {"items": [{"id": item.id, "cantidad_por_ubicacion": ubicaciones}]},
            format="json",
        )

    def test_no_encontrado_en_una_ubicacion_es_diferencia_y_admin_lo_ve(self):
        inspection = self._crear_inspeccion()
        response = self._responder(inspection, [
            {"key": "a", "subdivision_id": self.sub_a.id, "cantidad": 5},
            {"key": "b", "subdivision_id": self.sub_b.id, "cantidad": 7, "no_encontrado": True},
        ])
        self.assertEqual(response.status_code, 200, response.data)
        item = inspection.items.get()
        self.assertEqual(item.estado_revision, "no_coincide")
        self.assertFalse(item.no_encontrado)
        self.assertEqual(item.cantidad_reportada, 5)
        por_sub = {entry["subdivision_id"]: entry for entry in item.conteo_ubicaciones}
        self.assertTrue(por_sub[self.sub_b.id]["no_encontrado"])
        self.assertEqual(por_sub[self.sub_b.id]["cantidad_contada"], 0)
        self.assertFalse(por_sub[self.sub_a.id]["no_encontrado"])

        rows = self.admin_client.get(
            f"{BASE_URL}/admin/items/?sucursal_id={self.sucursal.id}&estado=pendiente"
        ).data["results"]
        ubicaciones = {row["subdivision_id"]: row["no_encontrado"] for row in rows[0]["ubicaciones_conteo"]}
        self.assertEqual(ubicaciones, {self.sub_a.id: False, self.sub_b.id: True})

        # Al aprobar, lo que falta queda abierto como cualquier faltante.
        response = self.admin_client.post(
            f"{BASE_URL}/items/{item.id}/verificar/", {"accion": "aprobar", "cantidad_confirmada": 5}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        item.refresh_from_db()
        self.assertEqual(item.cantidad_faltante, 3)
        self.assertEqual(self._stock(subdivision=self.sub_b), 0)
        self.assertEqual(self._stock(subdivision=self.sub_a), 5)

    def test_no_encontrado_en_todas_es_no_encontrado(self):
        inspection = self._crear_inspeccion()
        self._responder(inspection, [
            {"key": "a", "subdivision_id": self.sub_a.id, "cantidad": None, "no_encontrado": True},
            {"key": "b", "subdivision_id": self.sub_b.id, "cantidad": None, "no_encontrado": True},
        ])
        item = inspection.items.get()
        self.assertTrue(item.no_encontrado)
        self.assertEqual(item.cantidad_reportada, 0)

    def test_borrador_guarda_no_encontrado_por_ubicacion(self):
        inspection = self._crear_inspeccion()
        item = inspection.items.get()
        response = self.revisor_client.patch(
            f"{BASE_URL}/{inspection.id}/borrador/",
            {"items": [{"id": item.id, "cantidad_por_ubicacion": [
                {"key": "b", "subdivision_id": self.sub_b.id, "cantidad": None, "no_encontrado": True},
            ]}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        item.refresh_from_db()
        self.assertTrue(item.conteo_ubicaciones[0]["no_encontrado"])
        self.assertEqual(item.conteo_ubicaciones[0]["cantidad_contada"], 0)


class MoverProductoDeFilaTests(InspeccionAleatoriaBaseTestCase):
    """Al ordenar, el revisor pasa TODO un producto de la lista a la fila
    donde esta contando: se cuenta ahi, su fila de antes queda en 0
    ("Movido") y administracion lo aprueba como cambio de ubicacion."""

    def setUp(self):
        super().setUp()
        self.inspection = self._crear_inspeccion(productos=[self.producto], sucursal=self.sucursal)
        self.item = self.inspection.items.get()

    def _mover(self, cantidad=10, **extra):
        body = {
            "item_id": self.item.id,
            "subdivision_id": self.sub_b.id,
            "cantidad": cantidad,
            "conteo_ubicaciones": [
                {"key": "b", "subdivision_id": self.sub_b.id, "cantidad": cantidad},
                {"key": "a", "subdivision_id": self.sub_a.id, "cantidad": 0},
            ],
            **extra,
        }
        return self.revisor_client.post(
            f"{BASE_URL}/{self.inspection.id}/mover-producto/", body, format="json"
        )

    def test_mueve_y_al_aprobar_el_stock_queda_en_la_fila_nueva(self):
        response = self._mover()
        self.assertEqual(response.status_code, 200, response.data)
        self.item.refresh_from_db()
        self.assertTrue(self.item.movido_por_revisor)
        self.assertEqual(self.item.encontrado_en_id, self.sub_b.id)
        self.assertEqual(self.item.cantidad_reportada, 10)
        self.assertIn("[Movido]", self.item.observacion)
        # El stock no cambia hasta que administracion apruebe.
        self.assertEqual(self._stock(subdivision=self.sub_a), 10)
        # La fila nueva viene como ubicacion del producto (primero).
        row = response.data["inspection"]["items"][0]
        self.assertEqual(row["ubicaciones_bodega"][0]["subdivision_id"], self.sub_b.id)

        response = self._responder(self.inspection, {self.producto.id: 10})
        self.assertEqual(response.status_code, 200, response.data)
        self.item.refresh_from_db()
        self.assertTrue(self.item.cambio_ubicacion)
        self.assertEqual(self.item.verificacion_estado, "pendiente")

        # Primero se decide el cambio de fila (no se puede ajustar ni recontar antes).
        response = self._verificar({"accion": "recontar"})
        self.assertEqual(response.status_code, 400)
        response = self._verificar({"accion": "decidir_movimiento", "aprobar_movimiento": True})
        self.assertEqual(response.status_code, 200, response.data)
        self.item.refresh_from_db()
        # El total cuadraba: con aprobar el cambio queda resuelto.
        self.assertEqual(self.item.verificacion_estado, "aprobada")
        self.assertEqual(self.item.movimiento_decision, "aprobado")
        self.assertEqual(self._stock(subdivision=self.sub_a), 0)
        self.assertEqual(self._stock(subdivision=self.sub_b), 10)

    def _verificar(self, body):
        return self.admin_client.post(
            f"{BASE_URL}/items/{self.item.id}/verificar/", body, format="json"
        )

    def test_mantener_no_mueve_nada(self):
        self._mover()
        self._responder(self.inspection, {self.producto.id: 10})
        response = self._verificar({"accion": "decidir_movimiento", "aprobar_movimiento": False})
        self.assertEqual(response.status_code, 200, response.data)
        self.item.refresh_from_db()
        self.assertEqual(self.item.verificacion_estado, "rechazada")
        self.assertEqual(self._stock(subdivision=self.sub_a), 10)
        self.assertEqual(self._stock(subdivision=self.sub_b), 0)

    def test_si_no_coincide_primero_el_cambio_y_despues_la_cantidad(self):
        self._mover(cantidad=8)
        self._responder(self.inspection, {self.producto.id: 8})
        response = self._verificar({"accion": "decidir_movimiento", "aprobar_movimiento": True})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["pendiente_cantidad"])
        self.item.refresh_from_db()
        # El cambio ya se aplico (todo a la fila nueva); la diferencia sigue pendiente.
        self.assertEqual(self.item.verificacion_estado, "pendiente")
        self.assertEqual(self._stock(subdivision=self.sub_a), 0)
        self.assertEqual(self._stock(subdivision=self.sub_b), 10)

        response = self._verificar({"accion": "aprobar", "cantidad_confirmada": 8})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(subdivision=self.sub_a), 0)
        self.assertEqual(self._stock(subdivision=self.sub_b), 8)

    def test_deshacer_lo_devuelve_a_su_fila_sin_contar(self):
        self._mover()
        response = self.revisor_client.post(
            f"{BASE_URL}/{self.inspection.id}/quitar-producto/", {"item_id": self.item.id}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.item.refresh_from_db()
        self.assertFalse(self.item.movido_por_revisor)
        self.assertIsNone(self.item.encontrado_en_id)
        self.assertIsNone(self.item.cantidad_reportada)
        self.assertEqual(self.item.conteo_ubicaciones, [])
        self.assertNotIn("[Movido]", self.item.observacion)
        self.assertTrue(self.inspection.items.filter(pk=self.item.pk).exists())

    def test_mover_sin_cantidad_queda_por_contar_en_la_fila_nueva(self):
        response = self._mover(cantidad=None)
        self.assertEqual(response.status_code, 200, response.data)
        self.item.refresh_from_db()
        self.assertTrue(self.item.movido_por_revisor)
        self.assertIsNone(self.item.cantidad_reportada)
        conteo = {entry["subdivision_id"]: entry["cantidad_contada"] for entry in self.item.conteo_ubicaciones}
        self.assertEqual(conteo, {self.sub_b.id: None, self.sub_a.id: 0})

    def test_validaciones(self):
        # Sin otra ubicacion de donde traerlo: ya esta en esta fila.
        response = self.revisor_client.post(
            f"{BASE_URL}/{self.inspection.id}/mover-producto/",
            {
                "item_id": self.item.id,
                "subdivision_id": self.sub_a.id,
                "cantidad": 3,
                "conteo_ubicaciones": [{"key": "a", "subdivision_id": self.sub_a.id, "cantidad": 3}],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
