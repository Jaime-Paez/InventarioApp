from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from casa_comercial.models import CasaComercial
from importaciones.models import Importacion
from inventario.models import Sucursal
from productos.models import Producto
from tipos.models import EstadoMovimiento, EstadoProducto, SubTipoMovimiento, TipoMovimiento

from .historial_producto import build_product_movement_history
from .models import DetalleMovimiento, MovimientoInventario


class HistorialProductoTests(APITestCase):
    """Entradas y salidas de un producto con de donde vino o a donde fue."""

    def setUp(self):
        self.matriz = Sucursal.objects.create(nombre="Matriz", direccion="X")
        self.norte = Sucursal.objects.create(nombre="Norte", direccion="Y")
        self.entrada, _ = TipoMovimiento.objects.get_or_create(nombre="Entrada")
        self.salida, _ = TipoMovimiento.objects.get_or_create(nombre="Salida")
        self.sub = {
            "importacion": SubTipoMovimiento.objects.create(tipo_movimiento=self.entrada, nombre="Importación"),
            "compra": SubTipoMovimiento.objects.create(tipo_movimiento=self.entrada, nombre="Compra local"),
            "traslado_sal": SubTipoMovimiento.objects.create(tipo_movimiento=self.salida, nombre="Traslado"),
            "venta": SubTipoMovimiento.objects.create(tipo_movimiento=self.salida, nombre="Venta"),
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

        self.assertEqual([row["no_documento"] for row in data["results"]], ["V-1", "TR-1", "CL-1", "IMP-1"])
        rows = {row["no_documento"]: row for row in data["results"]}
        self.assertEqual(rows["IMP-1"]["origen"], "Importación IMP-77 · ACME")
        self.assertEqual(rows["IMP-1"]["importacion"]["codigo"], "IMP-77")
        self.assertEqual(rows["CL-1"]["cantidad"], 5)
        self.assertEqual(rows["CL-1"]["origen"], "Compra local · ACME")
        self.assertEqual(rows["TR-1"]["origen"], "Traslado a Norte")
        self.assertEqual(rows["V-1"]["origen"], "Venta · JUAN")
        self.assertEqual(data["totales"], {"entradas": 15, "salidas": 5})

        salidas = build_product_movement_history(self.producto.id, tipo="salida")
        self.assertEqual([row["no_documento"] for row in salidas["results"]], ["V-1", "TR-1"])

    def test_endpoint(self):
        self._mov(self.sub["compra"], "CL-9", "2026-10-02", [(self.producto, 2)])
        user = get_user_model().objects.create_superuser(username="adm", email="adm@x.com", password="x")
        self.client.force_authenticate(user)
        response = self.client.get(
            "/movimientos/movimiento_inventario/historial-producto/", {"producto_id": self.producto.id}
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.data["count"], 1)
        self.assertEqual(self.client.get("/movimientos/movimiento_inventario/historial-producto/").status_code, 400)
