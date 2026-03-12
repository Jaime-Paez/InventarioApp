from decimal import Decimal

from django.db.models import Sum
from django.test import TestCase

from inventario.models import Bodega, Division, Inventario, SubDivision, Sucursal
from marcas.models import Marca
from productos.models import Producto
from tipos.models import (
    EstadoMovimiento,
    EstadoProducto,
    SubTipoMovimiento,
    TipoDivision,
    TipoMovimiento,
)

from .serializers import MovimientoInventarioSerializer


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

        marca, _ = Marca.objects.get_or_create(
            codigo="M-TEST",
            defaults={"nombre": "Marca Test"},
        )
        self.producto, _ = Producto.objects.get_or_create(
            codigo="PR-001",
            defaults={
                "nombre": "Producto Test",
                "marca": marca,
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

    def _build_detail(self, cantidad):
        return [
            {
                "producto_id": self.producto.id,
                "cantidad": int(cantidad),
                "estado_producto_id": self.estado_producto.id,
                "valor": "10.00",
                "valor_total": str(Decimal("10.00") * int(cantidad)),
            }
        ]

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
            "descripcion": "Ingreso por compra",
            "fecha": "2026-03-11",
            "detalles": self._build_detail(cantidad=5),
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
