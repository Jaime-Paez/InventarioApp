import threading
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db import connection
from django.db.models import Sum
from django.test import TestCase, TransactionTestCase
from django.urls import reverse
from rest_framework.test import APITestCase

from app.models import ReminderState, UsuarioPreferencia
from inventario.models import Bodega, Division, Inventario, SubDivision, Sucursal
from productos.models import Producto
from solicitudes.models import Cliente
from tipos.models import (
    EstadoMovimiento,
    EstadoProducto,
    SubTipoMovimiento,
    TipoDivision,
    TipoMovimiento,
)
from usuarios.models import RolPermiso, UsuarioModuloSucursal

from .serializers import MovimientoInventarioSerializer
from .models import (
    DetalleMovimiento,
    MovimientoInventario,
    SolicitudTraslado,
    SolicitudTrasladoDetalle,
)


class MovimientoInventarioStockRulesTests(TestCase):
    def setUp(self):
        self.sucursal = Sucursal.objects.create(nombre="Matriz", direccion="Principal")
        self.sucursal_secundaria = Sucursal.objects.create(
            nombre="Sucursal Norte",
            direccion="Secundaria",
        )

        tipo_division, _ = TipoDivision.objects.get_or_create(nombre="General")
        self.subdivision = self._create_subdivision(
            sucursal=self.sucursal,
            tipo_division=tipo_division,
            suffix="A",
        )
        self._create_subdivision(
            sucursal=self.sucursal_secundaria,
            tipo_division=tipo_division,
            suffix="B",
        )

        self.tipo_entrada, _ = TipoMovimiento.objects.get_or_create(nombre="Entrada")
        self.tipo_salida, _ = TipoMovimiento.objects.get_or_create(nombre="Salida")

        self.subtipo_compra_local, _ = SubTipoMovimiento.objects.get_or_create(
            tipo_movimiento=self.tipo_entrada,
            nombre="Compra Local",
        )
        self.subtipo_venta, _ = SubTipoMovimiento.objects.get_or_create(
            tipo_movimiento=self.tipo_salida,
            nombre="Venta",
        )
        self.subtipo_devolucion, _ = SubTipoMovimiento.objects.get_or_create(
            tipo_movimiento=self.tipo_salida,
            nombre="Devolucion",
        )

        self.estado_recibido, _ = EstadoMovimiento.objects.get_or_create(
            nombre="Recibido"
        )
        self.estado_vendido, _ = EstadoMovimiento.objects.get_or_create(
            nombre="Vendido"
        )
        self.estado_devuelto, _ = EstadoMovimiento.objects.get_or_create(
            nombre="Devuelto"
        )
        self.estado_producto, _ = EstadoProducto.objects.get_or_create(
            nombre="Disponible"
        )

        self.producto, _ = Producto.objects.get_or_create(
            codigo="PR-001",
            defaults={
                "nombre": "Producto Test",
                "precio": Decimal("10.00"),
            },
        )

        Inventario.objects.create(
            producto=self.producto,
            subdivision=self.subdivision,
            referencia="",
            cantidad=10,
        )

    def _create_subdivision(self, sucursal, tipo_division, suffix):
        bodega = Bodega.objects.create(
            sucursal=sucursal,
            nombre=f"Bodega {suffix}",
        )
        division = Division.objects.create(
            bodega=bodega,
            tipo_division=tipo_division,
            nombre=f"Division {suffix}",
        )
        return SubDivision.objects.create(
            division=division,
            nombre=f"Subdivision {suffix}",
        )

    def _stock_total(self, sucursal):
        total = (
            Inventario.objects.filter(
                producto=self.producto,
                subdivision__division__bodega__sucursal=sucursal,
            ).aggregate(total=Sum("cantidad"))["total"]
            or 0
        )
        return int(total)

    def _build_detail(self, cantidad, costo=None):
        detail = {
            "producto_id": self.producto.id,
            "cantidad": int(cantidad),
            "estado_producto_id": self.estado_producto.id,
            "valor": "10.00",
            "valor_total": str(Decimal("10.00") * int(cantidad)),
        }
        if costo is not None:
            detail["costo"] = costo
        return [detail]

    def _create_movement(self, payload):
        serializer = MovimientoInventarioSerializer(data=payload)
        self.assertTrue(serializer.is_valid(), serializer.errors)
        return serializer.save()

    def test_entrada_suma_stock_en_sucursal(self):
        payload = {
            "sucursal_id": self.sucursal.id,
            "tipo_movimiento_id": self.tipo_entrada.id,
            "sub_tipo_movimiento_id": self.subtipo_compra_local.id,
            "estado_movimiento_id": self.estado_recibido.id,
            "no_documento": "TMP",
            "factura_referencia": "FAC-TEST-1",
            "descripcion": "Ingreso por compra",
            "fecha": "2026-03-11",
            "detalles": self._build_detail(cantidad=5, costo="5.00"),
        }

        before = self._stock_total(self.sucursal)
        self._create_movement(payload)
        after = self._stock_total(self.sucursal)

        self.assertEqual(after, before + 5)

    def test_salida_venta_vendido_resta_stock_en_sucursal(self):
        payload = {
            "sucursal_id": self.sucursal.id,
            "tipo_movimiento_id": self.tipo_salida.id,
            "sub_tipo_movimiento_id": self.subtipo_venta.id,
            "estado_movimiento_id": self.estado_vendido.id,
            "no_documento": "SAL-001",
            "descripcion": "Salida de venta",
            "fecha": "2026-03-11",
            "detalles": self._build_detail(cantidad=4),
        }

        before = self._stock_total(self.sucursal)
        self._create_movement(payload)
        after = self._stock_total(self.sucursal)

        self.assertEqual(after, before - 4)

    def test_salida_devolucion_resta_stock_en_sucursal(self):
        payload = {
            "sucursal_id": self.sucursal.id,
            "tipo_movimiento_id": self.tipo_salida.id,
            "sub_tipo_movimiento_id": self.subtipo_devolucion.id,
            "estado_movimiento_id": self.estado_devuelto.id,
            "no_documento": "SAL-002",
            "descripcion": "Salida por devolucion",
            "fecha": "2026-03-11",
            "detalles": self._build_detail(cantidad=3),
        }

        before = self._stock_total(self.sucursal)
        self._create_movement(payload)
        after = self._stock_total(self.sucursal)

        self.assertEqual(after, before - 3)


class DocumentNumberConcurrencyTests(TransactionTestCase):
    """
    Dos usuarios creando entradas/salidas al mismo tiempo terminaban
    recibiendo el mismo no_documento (calculado como MAX+1 sin lock) y a
    uno le fallaba el INSERT por la restriccion unique. Estos tests usan
    threads con conexiones de BD reales (por eso TransactionTestCase, no
    TestCase) para reproducir esa concurrencia y confirmar que ya no pasa.
    """

    def setUp(self):
        self.sucursal = Sucursal.objects.create(nombre="Matriz", direccion="Principal")

        tipo_division, _ = TipoDivision.objects.get_or_create(nombre="General")
        bodega = Bodega.objects.create(sucursal=self.sucursal, nombre="Bodega A")
        division = Division.objects.create(bodega=bodega, tipo_division=tipo_division, nombre="Division A")
        self.subdivision = SubDivision.objects.create(division=division, nombre="Subdivision A")

        self.tipo_entrada, _ = TipoMovimiento.objects.get_or_create(nombre="Entrada")
        self.tipo_salida, _ = TipoMovimiento.objects.get_or_create(nombre="Salida")
        self.subtipo_compra_local, _ = SubTipoMovimiento.objects.get_or_create(
            tipo_movimiento=self.tipo_entrada,
            nombre="Compra Local",
        )
        self.subtipo_venta, _ = SubTipoMovimiento.objects.get_or_create(
            tipo_movimiento=self.tipo_salida,
            nombre="Venta",
        )
        self.estado_recibido, _ = EstadoMovimiento.objects.get_or_create(nombre="Recibido")
        self.estado_vendido, _ = EstadoMovimiento.objects.get_or_create(nombre="Vendido")
        self.estado_producto, _ = EstadoProducto.objects.get_or_create(nombre="Disponible")

        self.producto, _ = Producto.objects.get_or_create(
            codigo="PR-CONC-001",
            defaults={"nombre": "Producto Concurrencia", "precio": Decimal("10.00")},
        )
        Inventario.objects.create(
            producto=self.producto,
            subdivision=self.subdivision,
            referencia="",
            cantidad=100,
        )

    def _run_concurrently(self, target, count):
        results = []
        errors = []
        barrier = threading.Barrier(count)

        def wrapped(index):
            try:
                barrier.wait(timeout=10)
                results.append(target(index))
            except Exception as exc:  # noqa: BLE001 - se reporta en el assert
                errors.append(exc)
            finally:
                connection.close()

        threads = [threading.Thread(target=wrapped, args=(i,)) for i in range(count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        return results, errors

    def test_entradas_concurrentes_no_chocan_de_codigo(self):
        def create_entrada(_index):
            payload = {
                "sucursal_id": self.sucursal.id,
                "tipo_movimiento_id": self.tipo_entrada.id,
                "sub_tipo_movimiento_id": self.subtipo_compra_local.id,
                "estado_movimiento_id": self.estado_recibido.id,
                "no_documento": "IGNORADO",
                "factura_referencia": "FAC-CONC-1",
                "descripcion": "Ingreso concurrente",
                "fecha": "2026-03-11",
                "detalles": [
                    {
                        "producto_id": self.producto.id,
                        "cantidad": 1,
                        "estado_producto_id": self.estado_producto.id,
                        "valor": "10.00",
                        "valor_total": "10.00",
                        "costo": "5.00",
                    }
                ],
            }
            serializer = MovimientoInventarioSerializer(data=payload)
            assert serializer.is_valid(), serializer.errors
            return serializer.save().no_documento

        results, errors = self._run_concurrently(create_entrada, count=5)

        self.assertEqual(errors, [])
        self.assertEqual(len(results), 5)
        self.assertEqual(len(set(results)), 5, f"Numeros duplicados: {results}")

    def test_salidas_concurrentes_con_mismo_no_documento_sugerido_no_chocan(self):
        # Simula el caso real: dos usuarios piden el "siguiente numero" casi
        # al mismo tiempo, ambos reciben el mismo valor sugerido, y los dos
        # lo mandan tal cual al crear la salida.
        shared_suggested_no_documento = "SAL-CONC-1"

        def create_salida(_index):
            payload = {
                "sucursal_id": self.sucursal.id,
                "tipo_movimiento_id": self.tipo_salida.id,
                "sub_tipo_movimiento_id": self.subtipo_venta.id,
                "estado_movimiento_id": self.estado_vendido.id,
                "no_documento": shared_suggested_no_documento,
                "descripcion": "Salida concurrente",
                "fecha": "2026-03-11",
                "detalles": [
                    {
                        "producto_id": self.producto.id,
                        "cantidad": 1,
                        "estado_producto_id": self.estado_producto.id,
                        "valor": "10.00",
                        "valor_total": "10.00",
                    }
                ],
            }
            serializer = MovimientoInventarioSerializer(data=payload)
            assert serializer.is_valid(), serializer.errors
            return serializer.save().no_documento

        # Solo 2: es el caso real (dos usuarios reciben la misma sugerencia
        # de "siguiente numero" y la mandan tal cual). Con mas hilos, los
        # que arrancan despues de que el primero ya hizo commit legitimamente
        # ven el numero como ocupado en el chequeo previo (no es la carrera
        # que este test busca reproducir).
        results, errors = self._run_concurrently(create_salida, count=2)

        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(len(set(results)), 2, f"Numeros duplicados: {results}")


class SolicitudTrasladoReminderRecipientsTests(APITestCase):
    """
    Antes, el recordatorio de una solicitud de traslado solo le llegaba a
    los usuarios marcados con el checkbox ("Usuarios adicionales") -- el
    resto de la lista de opciones no se enteraba de nada. Ahora todos los
    elegibles de la sucursal proveedora deben recibir el recordatorio, pero
    solo los marcados deben quedar en decision.assignedRecipients (que es
    lo que hace crecer la bola urgente).
    """

    def setUp(self):
        user_model = get_user_model()
        self.actor = user_model.objects.create_user(
            username="actor_traslado",
            email="actor_traslado@example.com",
            password="test12345",
        )
        UsuarioPreferencia.objects.get_or_create(usuario=self.actor, defaults={"es_administrador": True})
        self.client.force_authenticate(user=self.actor)

        self.sucursal_solicitante = Sucursal.objects.create(nombre="Solicitante", direccion="Dir 1")
        self.sucursal_proveedora = Sucursal.objects.create(nombre="Proveedora", direccion="Dir 2")

        self.checked_user = user_model.objects.create_user(
            username="checked_user",
            email="checked_user@example.com",
            password="test12345",
        )
        self.unchecked_user_a = user_model.objects.create_user(
            username="unchecked_user_a",
            email="unchecked_user_a@example.com",
            password="test12345",
        )
        self.unchecked_user_b = user_model.objects.create_user(
            username="unchecked_user_b",
            email="unchecked_user_b@example.com",
            password="test12345",
        )
        for user in (self.checked_user, self.unchecked_user_a, self.unchecked_user_b):
            UsuarioModuloSucursal.objects.create(
                usuario=user,
                modulo=RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
                sucursal=self.sucursal_proveedora,
            )

        self.producto, _ = Producto.objects.get_or_create(
            codigo="PR-REM-001",
            defaults={"nombre": "Producto Recordatorio", "precio": Decimal("10.00")},
        )

        tipo_division, _ = TipoDivision.objects.get_or_create(nombre="General")
        bodega = Bodega.objects.create(sucursal=self.sucursal_proveedora, nombre="Bodega Proveedora")
        division = Division.objects.create(bodega=bodega, tipo_division=tipo_division, nombre="Division Proveedora")
        subdivision = SubDivision.objects.create(division=division, nombre="Subdivision Proveedora")
        Inventario.objects.create(
            producto=self.producto,
            subdivision=subdivision,
            referencia="",
            cantidad=10,
        )

    def test_todos_los_elegibles_reciben_el_recordatorio_pero_solo_el_marcado_queda_asignado(self):
        payload = {
            "sucursal_solicitante_id": self.sucursal_solicitante.id,
            "sucursal_proveedora_id": self.sucursal_proveedora.id,
            "fecha": "2026-03-11",
            "descripcion": "Solicitud de prueba",
            "recordatorio_destinatario_ids": [self.checked_user.id],
            "detalles": [
                {"producto_id": self.producto.id, "cantidad": 2, "valor": "10.00"},
            ],
        }

        response = self.client.post(
            reverse("movimientos-movimiento-inventario-solicitudes-traslado"),
            payload,
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        solicitud_id = str(response.data["id"])

        store = ReminderState.objects.get(key=ReminderState.GLOBAL_KEY)
        reminder = next(
            item
            for item in store.payload
            if item.get("kind") == "solicitud_traslado_decision"
            and str(item.get("context", {}).get("id")) == solicitud_id
        )

        recipient_ids = {str(r["id"]) for r in reminder["recipients"]}
        assigned_ids = {str(r["id"]) for r in reminder["decision"]["assignedRecipients"]}

        for user in (self.checked_user, self.unchecked_user_a, self.unchecked_user_b):
            self.assertIn(str(user.id), recipient_ids, f"{user.username} deberia recibir el recordatorio")

        self.assertEqual(assigned_ids, {str(self.checked_user.id)})
        self.assertNotIn(str(self.unchecked_user_a.id), assigned_ids)
        self.assertNotIn(str(self.unchecked_user_b.id), assigned_ids)


class BuscarClienteSearchTests(APITestCase):
    """
    Un cliente guardado con acentos ("José Peña") no aparecia si se
    buscaba sin ellos ("jose pena"), que es como la mayoria escribe --
    icontains es sensible a acentos. Ahora usa la extension unaccent de
    Postgres (ver app/migrations/0012_unaccent_extension.py).
    """

    def setUp(self):
        user_model = get_user_model()
        self.actor = user_model.objects.create_user(
            username="buscador_cliente",
            email="buscador_cliente@example.com",
            password="test12345",
        )
        UsuarioPreferencia.objects.get_or_create(usuario=self.actor, defaults={"es_administrador": True})
        self.client.force_authenticate(user=self.actor)

        self.cliente = Cliente.objects.create(
            nombres="José",
            apellidos="Peña",
            cedula_ruc="1712345678",
        )

    def test_encuentra_cliente_con_acentos_buscando_sin_acentos(self):
        response = self.client.get(
            reverse("movimientos-movimiento-inventario-buscar-cliente"),
            {"q": "jose pena"},
        )
        self.assertEqual(response.status_code, 200, response.data)
        result_ids = {row["id"] for row in response.data["results"]}
        self.assertIn(self.cliente.id, result_ids)


class MovimientoInventarioTablaTests(APITestCase):
    def setUp(self):
        from app.models import UsuarioPreferencia
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            username="admin_movimientos_tabla",
            email="admin_movimientos_tabla@example.com",
            password="test12345",
        )
        UsuarioPreferencia.objects.get_or_create(usuario=self.user, defaults={"es_administrador": True})
        self.client.force_authenticate(user=self.user)

        self.sucursal = Sucursal.objects.create(nombre="Matriz", direccion="Principal")
        self.sucursal_destino = Sucursal.objects.create(
            nombre="Sucursal Norte",
            direccion="Secundaria",
        )

        self.tipo_entrada, _ = TipoMovimiento.objects.get_or_create(nombre="Entrada")
        self.tipo_salida, _ = TipoMovimiento.objects.get_or_create(nombre="Salida")
        self.subtipo_compra_local, _ = SubTipoMovimiento.objects.get_or_create(
            tipo_movimiento=self.tipo_entrada,
            nombre="Compra Local",
        )
        self.subtipo_venta, _ = SubTipoMovimiento.objects.get_or_create(
            tipo_movimiento=self.tipo_salida,
            nombre="Venta",
        )
        self.estado_recibido, _ = EstadoMovimiento.objects.get_or_create(
            nombre="Recibido"
        )
        self.estado_vendido, _ = EstadoMovimiento.objects.get_or_create(
            nombre="Vendido"
        )
        self.estado_producto, _ = EstadoProducto.objects.get_or_create(
            nombre="Disponible"
        )

        self.producto_a, _ = Producto.objects.get_or_create(
            codigo="PR-TAB-001",
            defaults={
                "nombre": "Producto Tabla A",
                "precio": Decimal("10.00"),
            },
        )
        self.producto_b, _ = Producto.objects.get_or_create(
            codigo="PR-TAB-002",
            defaults={
                "nombre": "Producto Tabla B",
                "precio": Decimal("20.00"),
            },
        )

    def _create_movement(self):
        movimiento = MovimientoInventario.objects.create(
            sucursal=self.sucursal,
            sucursal_objetivo=self.sucursal_destino,
            tipo_movimiento=self.tipo_salida,
            sub_tipo_movimiento=self.subtipo_venta,
            estado_movimiento=self.estado_vendido,
            fecha="2026-04-15",
            no_documento="SAL-TAB-001",
            funcional=True,
            descripcion="Salida de prueba para tabla",
        )
        DetalleMovimiento.objects.create(
            movimiento_inventario=movimiento,
            producto=self.producto_a,
            cantidad=2,
            estado_producto=self.estado_producto,
            valor=Decimal("10.00"),
            valor_total=Decimal("20.00"),
        )
        DetalleMovimiento.objects.create(
            movimiento_inventario=movimiento,
            producto=self.producto_b,
            cantidad=3,
            estado_producto=self.estado_producto,
            valor=Decimal("10.00"),
            valor_total=Decimal("30.00"),
        )
        return movimiento

    def _create_transfer_request(self):
        solicitud = SolicitudTraslado.objects.create(
            sucursal_solicitante=self.sucursal,
            sucursal_proveedora=self.sucursal_destino,
            fecha="2026-04-16",
            no_documento="TRA-TAB-001",
            estado=SolicitudTraslado.Estados.PENDIENTE,
            descripcion="Solicitud de prueba para tabla",
        )
        SolicitudTrasladoDetalle.objects.create(
            solicitud=solicitud,
            producto=self.producto_a,
            cantidad=4,
            valor=Decimal("12.50"),
        )
        return solicitud

    def test_tabla_salidas_busca_por_codigo_producto_y_conserva_total(self):
        self._create_movement()

        response = self.client.get(
            reverse("movimientos-movimiento-inventario-tabla"),
            {"tipo": "salida", "search": "PR-TAB-001"},
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["count"], 1)
        row = response.data["results"][0]
        self.assertEqual(row["no_documento"], "SAL-TAB-001")
        self.assertEqual(str(row["total"]), "50.00")
        self.assertEqual(
            [detail["producto_codigo"] for detail in row["detalles"]],
            ["PR-TAB-001", "PR-TAB-002"],
        )

    def test_tabla_entradas_filtra_solicitud_por_producto_codigo(self):
        self._create_transfer_request()

        response = self.client.get(
            reverse("movimientos-movimiento-inventario-tabla"),
            {"tipo": "entrada", "producto_codigo": "PR-TAB-001"},
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["count"], 1)
        row = response.data["results"][0]
        self.assertTrue(row["es_solicitud_traslado"])
        self.assertEqual(row["no_documento"], "TRA-TAB-001")
        self.assertEqual(row["detalles"][0]["producto_codigo"], "PR-TAB-001")


class CancelPendingTransferRequestsTests(TestCase):
    """
    cancel_pending_transfer_requests corre automaticamente cuando se
    registra una venta, para cancelar solicitudes de traslado que ya no se
    pueden cumplir por falta de stock. El bug: no excluia las solicitudes
    que ya se habian convertido en un envio real (movimiento_salida/
    movimiento_entrada ya creados), asi que una venta posterior del mismo
    producto cancelaba por error un traslado que ya habia salido de verdad
    -- el stock "faltante" era de la venta, no de ese traslado (que ya
    tomo el suyo al enviarse). Ver movimientos/transfer_helpers.py.
    """

    def setUp(self):
        self.sucursal_proveedora = Sucursal.objects.create(nombre="Proveedora", direccion="Dir 1")
        self.sucursal_solicitante = Sucursal.objects.create(nombre="Solicitante", direccion="Dir 2")

        tipo_division, _ = TipoDivision.objects.get_or_create(nombre="General")
        bodega = Bodega.objects.create(sucursal=self.sucursal_proveedora, nombre="Bodega Proveedora")
        division = Division.objects.create(bodega=bodega, tipo_division=tipo_division, nombre="Division Proveedora")
        subdivision = SubDivision.objects.create(division=division, nombre="Subdivision Proveedora")

        self.producto, _ = Producto.objects.get_or_create(
            codigo="PR-CANCEL-001",
            defaults={"nombre": "Producto Cancelacion", "precio": Decimal("10.00")},
        )
        # Solo 2 unidades disponibles: no alcanza para ninguna de las dos
        # solicitudes de 5 unidades de abajo, si se les vuelve a chequear.
        Inventario.objects.create(
            producto=self.producto,
            subdivision=subdivision,
            referencia="",
            cantidad=2,
        )

        self.tipo_entrada, _ = TipoMovimiento.objects.get_or_create(nombre="Entrada")
        self.tipo_salida, _ = TipoMovimiento.objects.get_or_create(nombre="Salida")
        self.subtipo_traslado_salida, _ = SubTipoMovimiento.objects.get_or_create(
            tipo_movimiento=self.tipo_salida,
            nombre="Traslado",
        )
        self.subtipo_traslado_entrada, _ = SubTipoMovimiento.objects.get_or_create(
            tipo_movimiento=self.tipo_entrada,
            nombre="Traslado",
        )
        self.estado_enviado, _ = EstadoMovimiento.objects.get_or_create(nombre="Enviado")

    def _create_solicitud(self, no_documento, *, with_shipment):
        solicitud = SolicitudTraslado.objects.create(
            sucursal_solicitante=self.sucursal_solicitante,
            sucursal_proveedora=self.sucursal_proveedora,
            fecha="2026-03-11",
            no_documento=no_documento,
            estado=SolicitudTraslado.Estados.APROBADA,
        )
        SolicitudTrasladoDetalle.objects.create(
            solicitud=solicitud,
            producto=self.producto,
            cantidad=5,
            valor=Decimal("10.00"),
        )
        if with_shipment:
            movimiento_salida = MovimientoInventario.objects.create(
                sucursal=self.sucursal_proveedora,
                sucursal_objetivo=self.sucursal_solicitante,
                tipo_movimiento=self.tipo_salida,
                sub_tipo_movimiento=self.subtipo_traslado_salida,
                estado_movimiento=self.estado_enviado,
                fecha="2026-03-11",
                no_documento=no_documento,
            )
            movimiento_entrada = MovimientoInventario.objects.create(
                sucursal=self.sucursal_solicitante,
                sucursal_objetivo=self.sucursal_proveedora,
                tipo_movimiento=self.tipo_entrada,
                sub_tipo_movimiento=self.subtipo_traslado_entrada,
                estado_movimiento=self.estado_enviado,
                fecha="2026-03-11",
                no_documento=no_documento,
            )
            solicitud.movimiento_salida = movimiento_salida
            solicitud.movimiento_entrada = movimiento_entrada
            solicitud.save(update_fields=["movimiento_salida", "movimiento_entrada"])
        return solicitud

    def test_no_cancela_solicitud_que_ya_se_envio(self):
        from .transfer_helpers import cancel_pending_transfer_requests

        ya_enviada = self._create_solicitud("TR-CANCEL-ENVIADA", with_shipment=True)
        aun_pendiente = self._create_solicitud("TR-CANCEL-PENDIENTE", with_shipment=False)

        changed = cancel_pending_transfer_requests(
            branch_id=self.sucursal_proveedora.id,
            product_ids=[self.producto.id],
        )

        self.assertTrue(changed)

        ya_enviada.refresh_from_db()
        aun_pendiente.refresh_from_db()

        self.assertEqual(
            ya_enviada.estado,
            SolicitudTraslado.Estados.APROBADA,
            "una solicitud ya enviada no debe cancelarse por stock de otra venta",
        )
        self.assertEqual(
            aun_pendiente.estado,
            SolicitudTraslado.Estados.CANCELADA,
            "una solicitud todavia pendiente si debe cancelarse si ya no hay stock",
        )
