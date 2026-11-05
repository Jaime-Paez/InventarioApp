from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from casa_comercial.models import CasaComercial
from importaciones.models import Importacion
from inventario.models import Sucursal
from productos.models import Producto
from tipos.models import EstadoMovimiento, EstadoProducto, SubTipoMovimiento, TipoMovimiento

from .historial_producto import build_product_movement_history, history_branch_options
from .models import DetalleMovimiento, MovimientoInventario


class HistorialProductoTests(APITestCase):
    """Entradas y salidas de un producto con de donde vino o a donde fue."""

    def setUp(self):
        # Las migraciones ya crean "9 de Octubre (Matriz)".
        self.matriz = Sucursal.objects.filter(nombre__icontains="matriz").order_by("id").first() or Sucursal.objects.create(
            nombre="9 de Octubre (Matriz)", direccion="X"
        )
        self.norte = Sucursal.objects.create(nombre="Norte", direccion="Y")
        self.entrada, _ = TipoMovimiento.objects.get_or_create(nombre="Entrada")
        self.salida, _ = TipoMovimiento.objects.get_or_create(nombre="Salida")
        self.sub = {
            "importacion": SubTipoMovimiento.objects.get_or_create(tipo_movimiento=self.entrada, nombre="Importación")[0],
            "compra": SubTipoMovimiento.objects.get_or_create(tipo_movimiento=self.entrada, nombre="Compra local")[0],
            "traslado_sal": SubTipoMovimiento.objects.get_or_create(tipo_movimiento=self.salida, nombre="Traslado")[0],
            "venta": SubTipoMovimiento.objects.get_or_create(tipo_movimiento=self.salida, nombre="Venta")[0],
        }
        self.estado, _ = EstadoMovimiento.objects.get_or_create(nombre="Recibido")
        self.estado_producto, _ = EstadoProducto.objects.get_or_create(nombre="Disponible")
        self.casa = CasaComercial.objects.create(nombre="ACME")
        self.producto = Producto.objects.create(codigo="HIST-1", nombre="Filtro", precio=Decimal("10.00"))
        self.otro = Producto.objects.create(codigo="HIST-2", nombre="Otro", precio=Decimal("10.00"))

    def _mov(self, sub, doc, fecha, cantidades, **extra):
        mov = MovimientoInventario.objects.create(
            sucursal=extra.pop("sucursal", self.matriz),
            tipo_movimiento=sub.tipo_movimiento,
            sub_tipo_movimiento=sub,
            estado_movimiento=self.estado,
            fecha=fecha,
            no_documento=doc,
            **extra,
        )
        for producto, cantidad in cantidades:
            DetalleMovimiento.objects.create(
                movimiento_inventario=mov,
                producto=producto,
                cantidad=cantidad,
                estado_producto=self.estado_producto,
                valor=Decimal("10"),
                valor_total=Decimal("10") * cantidad,
            )
        return mov

    def test_historial_con_origen_y_totales(self):
        imp_mov = self._mov(self.sub["importacion"], "IMP-1", "2026-10-01", [(self.producto, 10)])
        Importacion.objects.create(codigo="IMP-77", casa_comercial=self.casa, movimiento_entrada=imp_mov)
        self._mov(self.sub["compra"], "CL-1", "2026-10-02", [(self.producto, 2), (self.producto, 3)], casa_comercial=self.casa)
        self._mov(self.sub["traslado_sal"], "TR-1", "2026-10-03", [(self.producto, 4)], sucursal_objetivo=self.norte)
        self._mov(self.sub["venta"], "V-1", "2026-10-04", [(self.producto, 1)], descripcion="Cliente: JUAN")
        self._mov(self.sub["venta"], "V-OTRO", "2026-10-05", [(self.otro, 9)])
        self._mov(
            self.sub["venta"], "GAR-1", "2026-10-06", [(self.producto, 1)],
            garantia_pendiente=True, estado_garantia=MovimientoInventario.EstadoGarantia.SOLICITADA,
        )

        data = build_product_movement_history(self.producto.id)

        self.assertEqual([row["no_documento"] for row in data["results"]], ["IMP-1", "CL-1", "TR-1", "V-1"])
        rows = {row["no_documento"]: row for row in data["results"]}
        self.assertEqual(rows["IMP-1"]["origen"], "Importación IMP-77 · ACME")
        self.assertEqual(rows["IMP-1"]["importacion"]["codigo"], "IMP-77")
        self.assertEqual(rows["CL-1"]["cantidad"], 5)
        self.assertEqual(rows["CL-1"]["origen"], "Compra local · ACME")
        self.assertEqual(rows["TR-1"]["origen"], "Traslado a Norte")
        self.assertEqual(rows["V-1"]["origen"], "Venta · JUAN")
        self.assertEqual((data["totales"]["entradas"], data["totales"]["salidas"]), (15, 5))

        salidas = build_product_movement_history(self.producto.id, tipo="salida")
        self.assertEqual([row["no_documento"] for row in salidas["results"]], ["TR-1", "V-1"])

        rango = build_product_movement_history(self.producto.id, fecha_desde="2026-10-02", fecha_hasta="2026-10-03")
        self.assertEqual([row["no_documento"] for row in rango["results"]], ["CL-1", "TR-1"])
        self.assertEqual((rango["totales"]["entradas"], rango["totales"]["salidas"]), (5, 4))
        # Antes del 2 de octubre solo estaba la importacion de 10.
        self.assertEqual(rango["saldo_anterior"]["cantidad"], 10)
        self.assertEqual([row["acum_cantidad"] for row in rango["results"]], [15, 11])

    def _mov_valor(self, sub, doc, fecha, cantidad, valor, **extra):
        mov = self._mov(sub, doc, fecha, [], **extra)
        DetalleMovimiento.objects.create(
            movimiento_inventario=mov,
            producto=self.producto,
            cantidad=cantidad,
            estado_producto=self.estado_producto,
            valor=valor,
            valor_total=valor * cantidad,
        )
        return mov

    def test_kardex_costo_promedio(self):
        """Saldo anterior, salidas al costo promedio y compras a su valor,
        como el Kardex del sistema anterior."""
        devol = SubTipoMovimiento.objects.get_or_create(tipo_movimiento=self.entrada, nombre="Devolucion")[0]
        self._mov_valor(self.sub["compra"], "CL-0", "2026-09-01", 9, Decimal("120.00"))
        self._mov_valor(self.sub["venta"], "V-1", "2026-10-06", 1, Decimal("200"))
        self._mov_valor(self.sub["venta"], "V-2", "2026-10-21", 1, Decimal("200"))
        self._mov_valor(self.sub["compra"], "CL-1", "2026-10-23", 6, Decimal("109.57"))
        self._mov_valor(devol, "D-1", "2026-10-24", 1, Decimal("999"))

        data = build_product_movement_history(self.producto.id, fecha_desde="2026-10-01", fecha_hasta="2026-11-30")

        self.assertEqual(data["saldo_anterior"], {"cantidad": 9, "costo": "1080.0000"})
        rows = {row["no_documento"]: row for row in data["results"]}
        self.assertEqual(rows["V-1"]["costo_unitario"], "120.0000")
        self.assertEqual(rows["V-1"]["acum_cantidad"], 8)
        self.assertEqual(rows["V-1"]["acum_costo"], "960.0000")
        self.assertEqual(rows["CL-1"]["costo_total"], "657.4200")
        self.assertEqual(rows["CL-1"]["acum_cantidad"], 13)
        self.assertEqual(rows["CL-1"]["acum_costo"], "1497.4200")
        # La devolucion entra al costo promedio, no a su precio.
        self.assertEqual(rows["D-1"]["costo_unitario"], "115.1862")
        self.assertEqual(data["saldo_actual"]["cantidad"], 14)
        self.assertEqual(data["totales"]["salidas_total"], "240.0000")

    def test_kardex_compra_local_usa_costo_con_descuento_y_parte_de_negativo(self):
        # Venta sin entradas previas: el acumulado queda en -1.
        self._mov_valor(self.sub["venta"], "V-0", "2026-10-01", 1, Decimal("200"))
        compra = self._mov_valor(self.sub["compra"], "CL-1", "2026-10-02", 3, Decimal("200"))
        DetalleMovimiento.objects.filter(movimiento_inventario=compra).update(
            costo=Decimal("100"), descuento_porcentaje=Decimal("10")
        )

        data = build_product_movement_history(self.producto.id)

        rows = {row["no_documento"]: row for row in data["results"]}
        self.assertEqual(rows["V-0"]["acum_cantidad"], -1)
        # El PVP (valor) es 200; el costo es 100 menos 10 %.
        self.assertEqual(rows["CL-1"]["costo_unitario"], "90.0000")
        self.assertEqual(rows["CL-1"]["acum_cantidad"], 2)
        self.assertEqual(rows["CL-1"]["acum_costo"], "180.0000")

    def test_kardex_parte_del_saldo_inicial_e_ignora_el_sistema_anterior(self):
        from inventario.models import SaldoInicialInventario

        SaldoInicialInventario.objects.create(producto=self.producto, sucursal=self.matriz, cantidad=5)
        SaldoInicialInventario.objects.create(producto=self.producto, sucursal=self.norte, cantidad=99)
        # Del sistema anterior: ya esta dentro del saldo inicial.
        self._mov_valor(self.sub["venta"], "LEG-1", "2026-09-01", 3, Decimal("200"), es_legado=True)
        self._mov_valor(self.sub["venta"], "V-1", "2026-10-01", 1, Decimal("200"))
        compra = self._mov_valor(self.sub["compra"], "CL-1", "2026-10-02", 2, Decimal("200"))
        DetalleMovimiento.objects.filter(movimiento_inventario=compra).update(costo=Decimal("10"))
        self._mov_valor(self.sub["venta"], "V-2", "2026-10-03", 1, Decimal("200"))

        data = build_product_movement_history(self.producto.id, sucursal_id=self.matriz.id)

        self.assertEqual(data["saldo_inicial"], 5)
        self.assertEqual(data["saldo_anterior"], {"cantidad": 5, "costo": None})
        self.assertEqual([row["no_documento"] for row in data["results"]], ["V-1", "CL-1", "V-2"])
        rows = {row["no_documento"]: row for row in data["results"]}
        # Sin costo conocido todavia: no se inventa.
        self.assertIsNone(rows["V-1"]["costo_unitario"])
        self.assertIsNone(rows["V-1"]["acum_costo"])
        self.assertEqual(rows["V-1"]["acum_cantidad"], 4)
        # La primera compra con costo valora todo lo que hay.
        self.assertEqual(rows["CL-1"]["acum_cantidad"], 6)
        self.assertEqual(rows["CL-1"]["acum_costo"], "60.0000")
        self.assertEqual(rows["V-2"]["costo_unitario"], "10.0000")
        self.assertEqual(data["saldo_actual"], {"cantidad": 5, "costo": "50.0000"})
        self.assertTrue(data["totales"]["costos_incompletos"])

        rango = build_product_movement_history(self.producto.id, sucursal_id=self.matriz.id, fecha_desde="2026-10-02")
        self.assertEqual(rango["saldo_anterior"], {"cantidad": 4, "costo": None})

    def test_endpoint(self):
        self._mov(self.sub["compra"], "CL-9", "2026-10-02", [(self.producto, 2)])
        user = get_user_model().objects.create_superuser(username="adm", email="adm@x.com", password="x")
        self.client.force_authenticate(user)
        response = self.client.get(
            "/movimientos/movimiento_inventario/historial-producto/", {"producto_id": self.producto.id}
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.data["count"], 1)
        response = self.client.get(
            "/movimientos/movimiento_inventario/historial-producto/",
            {"producto_id": self.producto.id, "fecha_desde": "2026-10-03"},
        )
        self.assertEqual(response.data["count"], 0)
        self.assertEqual(self.client.get("/movimientos/movimiento_inventario/historial-producto/").status_code, 400)

    def test_sucursales_por_permiso(self):
        """El admin ve todas con la matriz primero y marcada; un usuario
        restringido solo ve sus sucursales y le sale marcada la suya."""
        sur = Sucursal.objects.create(nombre="Sur", direccion="Z")
        self._mov(self.sub["compra"], "CL-M", "2026-10-02", [(self.producto, 2)])
        self._mov(self.sub["compra"], "CL-N", "2026-10-03", [(self.producto, 3)], sucursal=self.norte)

        branches, default_id = history_branch_options(None)
        self.assertEqual(branches[0]["id"], self.matriz.id)
        self.assertEqual(default_id, self.matriz.id)

        branches, default_id = history_branch_options({self.norte.id, sur.id}, {sur.id})
        self.assertEqual({b["id"] for b in branches}, {self.norte.id, sur.id})
        self.assertEqual(default_id, sur.id)

        data = build_product_movement_history(self.producto.id, allowed_sucursal_ids={self.norte.id})
        self.assertEqual([row["no_documento"] for row in data["results"]], ["CL-N"])

        user = get_user_model().objects.create_superuser(username="adm2", email="adm2@x.com", password="x")
        self.client.force_authenticate(user)
        url = "/movimientos/movimiento_inventario/historial-producto/"
        default = self.client.get(url, {"producto_id": self.producto.id})
        self.assertEqual(default.data["sucursal_aplicada"], self.matriz.id)
        self.assertTrue(default.data["puede_ver_todas"])
        self.assertEqual(default.data["count"], 1)
        todas = self.client.get(url, {"producto_id": self.producto.id, "sucursal_id": "todas"})
        self.assertIsNone(todas.data["sucursal_aplicada"])
        self.assertEqual(todas.data["count"], 2)
