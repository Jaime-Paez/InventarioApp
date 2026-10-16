from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models import Sum
from rest_framework.test import APITestCase

from inventario.models import Bodega, Division, Inventario, SubDivision, Sucursal
from productos.models import Producto
from tipos.models import (
    EstadoMovimiento,
    EstadoProducto,
    SubTipoMovimiento,
    TipoDivision,
    TipoMovimiento,
)

from .serializers import MovimientoInventarioSerializer


class EditarCantidadesEntradaTests(APITestCase):
    """Editar una entrada recibida aplica solo la diferencia de cada producto."""

    def setUp(self):
        self.sucursal = Sucursal.objects.create(nombre="Matriz", direccion="Principal")
        tipo_division, _ = TipoDivision.objects.get_or_create(nombre="General")
        bodega = Bodega.objects.create(sucursal=self.sucursal, nombre="Bodega 1")
        division = Division.objects.create(bodega=bodega, tipo_division=tipo_division, nombre="Pasillo 1")
        self.sub_a = SubDivision.objects.create(division=division, nombre="A")
        self.sub_b = SubDivision.objects.create(division=division, nombre="B")
        self.tipo_entrada, _ = TipoMovimiento.objects.get_or_create(nombre="Entrada")
        self.compra_local, _ = SubTipoMovimiento.objects.get_or_create(
            tipo_movimiento=self.tipo_entrada, nombre="Compra Local"
        )
        self.recibido, _ = EstadoMovimiento.objects.get_or_create(nombre="Recibido")
        self.estado_producto, _ = EstadoProducto.objects.get_or_create(nombre="Disponible")
        self.producto = Producto.objects.create(codigo="PR-EDIT", nombre="Filtro", precio=Decimal("10.00"))
        Inventario.objects.create(producto=self.producto, subdivision=self.sub_a, referencia="", cantidad=0)
        self.entrada = self._save(None, self._payload(10))

    def _payload(self, cantidad, **extra):
        payload = {
            "sucursal_id": self.sucursal.id,
            "tipo_movimiento_id": self.tipo_entrada.id,
            "sub_tipo_movimiento_id": self.compra_local.id,
            "estado_movimiento_id": self.recibido.id,
            "no_documento": "ENT-EDIT",
            "factura_referencia": "FAC-EDIT",
            "descripcion": "Compra",
            "fecha": "2026-10-16",
            "detalles": [{
                "producto_id": self.producto.id,
                "cantidad": cantidad,
                "estado_producto_id": self.estado_producto.id,
                "valor": "10.00",
                "valor_total": str(10 * cantidad),
                "costo": "6.00",
            }],
        }
        payload.update(extra)
        return payload

    def _save(self, instance, payload):
        if instance is not None:
            payload["no_documento"] = instance.no_documento
        serializer = MovimientoInventarioSerializer(instance, data=payload)
        self.assertTrue(serializer.is_valid(), serializer.errors)
        return serializer.save()

    def _stock(self, subdivision=None):
        rows = Inventario.objects.filter(producto=self.producto)
        if subdivision is not None:
            rows = rows.filter(subdivision=subdivision)
        return int(rows.aggregate(total=Sum("cantidad"))["total"] or 0)

    def _sell(self, units):
        row = Inventario.objects.get(producto=self.producto, subdivision=self.sub_a)
        row.cantidad -= units
        row.save()

    def test_subir_cantidad_aunque_ya_se_haya_vendido_parte(self):
        self._sell(8)  # quedan 2 de las 10 que entraron
        self._save(self.entrada, self._payload(12))  # antes fallaba: "Stock insuficiente"
        self.assertEqual(self._stock(), 4)
        self.assertEqual(self._stock(self.sub_a), 4)

    def test_sumar_va_a_la_ubicacion_habitual_aunque_otra_tenga_mas(self):
        self._sell(8)  # en A quedan 2
        Inventario.objects.create(producto=self.producto, subdivision=self.sub_b, referencia="", cantidad=6)
        self._save(self.entrada, self._payload(12))
        self.assertEqual(self._stock(self.sub_a), 4)
        self.assertEqual(self._stock(self.sub_b), 6)

    def test_bajar_cantidad_resta_solo_la_diferencia(self):
        self._save(self.entrada, self._payload(7))
        self.assertEqual(self._stock(), 7)

    def test_no_se_puede_bajar_mas_de_lo_que_queda(self):
        self._sell(8)  # quedan 2
        serializer = MovimientoInventarioSerializer(
            self.entrada, data=self._payload(5, no_documento=self.entrada.no_documento)
        )
        self.assertTrue(serializer.is_valid(), serializer.errors)
        with self.assertRaises(Exception) as ctx:
            serializer.save()
        self.assertIn("Como mínimo puede quedar en 8", str(ctx.exception))
        self.assertEqual(self._stock(), 2)  # no se toco nada

    def test_restar_de_la_ubicacion_elegida(self):
        Inventario.objects.create(producto=self.producto, subdivision=self.sub_b, referencia="", cantidad=5)
        self._save(
            self.entrada,
            self._payload(7, ajustes_ubicacion=[{"producto_id": self.producto.id, "subdivision_id": self.sub_b.id}]),
        )
        self.assertEqual(self._stock(self.sub_a), 10)
        self.assertEqual(self._stock(self.sub_b), 2)

    def test_sumar_en_la_ubicacion_elegida(self):
        self._save(
            self.entrada,
            self._payload(13, ajustes_ubicacion=[{"producto_id": self.producto.id, "subdivision_id": self.sub_b.id}]),
        )
        self.assertEqual(self._stock(self.sub_a), 10)
        self.assertEqual(self._stock(self.sub_b), 3)

    def test_vista_previa_dice_cuanto_se_suma_y_de_donde(self):
        admin = get_user_model().objects.create_superuser(
            username="admin-edit", email="admin-edit@test.local", password="x"
        )
        self.client.force_authenticate(admin)
        url = f"/movimientos/movimiento_inventario/{self.entrada.id}/previsualizar-ajuste/"
        response = self.client.post(url, {"detalles": [{"producto_id": self.producto.id, "cantidad": 14}]}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["aplica"])
        cambio = response.data["cambios"][0]
        self.assertEqual((cambio["antes"], cambio["despues"], cambio["delta"]), (10, 14, 4))
        self.assertEqual(cambio["ubicacion"], "Bodega 1 › Pasillo 1 › A")
        self.assertEqual(cambio["error"], "")
        self.assertEqual(self._stock(), 10)  # la vista previa no guarda
