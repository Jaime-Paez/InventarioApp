from rest_framework import serializers

from inventarios.models import EstadoProducto, Inventario
from inventarios.serializers import InventarioSerializer
from productos.models import Producto
from ubicaciones.models import SubDivision

from .models import (
    DetalleMovimiento,
    EstadoMovimiento,
    MovimientoInventario,
    PagoMovimiento,
    SubTipoMovimiento,
    TipoMovimiento,
    TipoPago,
)


class TipoPagoSerializer(serializers.ModelSerializer):
    """Serializa los tipos de pago disponibles."""

    class Meta:
        model = TipoPago
        fields = ["id", "nombre", "descripcion"]


class TipoMovimientoSerializer(serializers.ModelSerializer):
    """Serializa los tipos de movimiento de inventario."""

    class Meta:
        model = TipoMovimiento
        fields = ["id", "nombre", "descripcion"]


class SubTipoMovimientoSerializer(serializers.ModelSerializer):
    """Serializa los subtipos asociados a un tipo de movimiento."""

    tipo_movimiento = TipoMovimientoSerializer(read_only=True)
    tipo_movimiento_id = serializers.PrimaryKeyRelatedField(
        source="tipo_movimiento",
        queryset=TipoMovimiento.objects.all(),
        write_only=True,
    )

    class Meta:
        model = SubTipoMovimiento
        fields = [
            "id",
            "tipo_movimiento",
            "tipo_movimiento_id",
            "nombre",
            "descripcion",
        ]

class EstadoMovimientoSerializer(serializers.ModelSerializer):
    """Serializa los estados del movimiento."""

    class Meta:
        model = EstadoMovimiento
        fields = ["id", "nombre", "descripcion"]


class DetalleMovimientoSerializer(serializers.ModelSerializer):
    """Serializa los productos involucrados en un movimiento."""

    movimiento_id = serializers.PrimaryKeyRelatedField(
        source="movimiento",
        queryset=MovimientoInventario.objects.all(),
        write_only=True,
    )
    inventario_id = serializers.PrimaryKeyRelatedField(
        source="inventario",
        queryset=Inventario.objects.all(),
        write_only=True,
    )
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
        write_only=True,
    )
    estado_producto_id = serializers.PrimaryKeyRelatedField(
        source="estado_producto",
        queryset=EstadoProducto.objects.all(),
        write_only=True,
    )
    movimiento = serializers.StringRelatedField(read_only=True)
    inventario = serializers.StringRelatedField(read_only=True)
    producto = serializers.StringRelatedField(read_only=True)
    estado_producto = serializers.StringRelatedField(read_only=True)
    inventario_detalle = InventarioSerializer(source="inventario", read_only=True)

    class Meta:
        model = DetalleMovimiento
        fields = [
            "id",
            "movimiento",
            "movimiento_id",
            "inventario",
            "inventario_id",
            "inventario_detalle",
            "producto",
            "producto_id",
            "estado_producto",
            "estado_producto_id",
            "cantidad",
            "notas",
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.fields["inventario_id"].queryset = Inventario.objects.all()
        self.fields["producto_id"].queryset = Producto.objects.all()
        self.fields["estado_producto_id"].queryset = EstadoProducto.objects.all()


class PagoMovimientoSerializer(serializers.ModelSerializer):
    """Serializa los pagos realizados para un movimiento."""

    movimiento = serializers.StringRelatedField(read_only=True)
    movimiento_id = serializers.PrimaryKeyRelatedField(
        source="movimiento",
        queryset=MovimientoInventario.objects.all(),
        write_only=True,
    )
    tipo_pago = TipoPagoSerializer(read_only=True)
    tipo_pago_id = serializers.PrimaryKeyRelatedField(
        source="tipo_pago",
        queryset=TipoPago.objects.all(),
        write_only=True,
    )

    class Meta:
        model = PagoMovimiento
        fields = [
            "id",
            "movimiento",
            "movimiento_id",
            "tipo_pago",
            "tipo_pago_id",
            "fecha_pago",
            "monto",
            "referencia",
            "notas",
            "creado_en",
            "actualizado_en",
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["movimiento_id"].queryset = MovimientoInventario.objects.all()
        self.fields["tipo_pago_id"].queryset = TipoPago.objects.all()


class MovimientoInventarioSerializer(serializers.ModelSerializer):
    """Serializa los encabezados del movimiento e incluye sus detalles."""

    subdivision_id = serializers.PrimaryKeyRelatedField(
        source="subdivision",
        queryset=SubDivision.objects.all(),
        write_only=True,
    )
    tipo_movimiento_id = serializers.PrimaryKeyRelatedField(
        source="tipo_movimiento",
        queryset=TipoMovimiento.objects.all(),
        write_only=True,
    )
    sub_tipo_movimiento_id = serializers.PrimaryKeyRelatedField(
        source="sub_tipo_movimiento",
        queryset=SubTipoMovimiento.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )
    estado_id = serializers.PrimaryKeyRelatedField(
        source="estado",
        queryset=EstadoMovimiento.objects.all(),
        write_only=True,
    )
    tipo_pago_id = serializers.PrimaryKeyRelatedField(
        source="tipo_pago",
        queryset=TipoPago.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )
    subdivision = serializers.StringRelatedField(read_only=True)
    division = serializers.CharField(
        source="subdivision.division.nombre", read_only=True
    )
    bodega = serializers.CharField(
        source="subdivision.division.bodega.nombre", read_only=True
    )
    sucursal = serializers.CharField(
        source="subdivision.division.bodega.sucursal.nombre", read_only=True
    )
    tipo_movimiento = TipoMovimientoSerializer(read_only=True)
    sub_tipo_movimiento = SubTipoMovimientoSerializer(read_only=True)
    estado = EstadoMovimientoSerializer(read_only=True)
    tipo_pago = TipoPagoSerializer(read_only=True)
    detalles = DetalleMovimientoSerializer(many=True, read_only=True)
    pagos = PagoMovimientoSerializer(many=True, read_only=True)

    class Meta:
        model = MovimientoInventario
        fields = [
            "id",
            "subdivision",
            "subdivision_id",
            "division",
            "bodega",
            "sucursal",
            "tipo_movimiento",
            "tipo_movimiento_id",
            "sub_tipo_movimiento",
            "sub_tipo_movimiento_id",
            "estado",
            "estado_id",
            "tipo_pago",
            "tipo_pago_id",
            "fecha_documento",
            "numero_documento",
            "observaciones",
            "detalles",
            "pagos",
            "creado_en",
            "actualizado_en",
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.fields["subdivision_id"].queryset = SubDivision.objects.all()
        self.fields["sub_tipo_movimiento_id"].queryset = SubTipoMovimiento.objects.all()
