from rest_framework import serializers

from .models import (
    DetalleMovimiento,
    EstadoMovimiento,
    MovimientoInventario,
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
        queryset=None,
        write_only=True,
    )
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=None,
        write_only=True,
    )
    estado_producto_id = serializers.PrimaryKeyRelatedField(
        source="estado_producto",
        queryset=None,
        write_only=True,
    )
    movimiento = serializers.StringRelatedField(read_only=True)
    inventario = serializers.StringRelatedField(read_only=True)
    producto = serializers.StringRelatedField(read_only=True)
    estado_producto = serializers.StringRelatedField(read_only=True)

    class Meta:
        model = DetalleMovimiento
        fields = [
            "id",
            "movimiento",
            "movimiento_id",
            "inventario",
            "inventario_id",
            "producto",
            "producto_id",
            "estado_producto",
            "estado_producto_id",
            "cantidad",
            "notas",
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        from inventarios.models import EstadoProducto, Inventario
        from productos.models import Producto

        self.fields["inventario_id"].queryset = Inventario.objects.all()
        self.fields["producto_id"].queryset = Producto.objects.all()
        self.fields["estado_producto_id"].queryset = EstadoProducto.objects.all()


class MovimientoInventarioSerializer(serializers.ModelSerializer):
    """Serializa los encabezados del movimiento e incluye sus detalles."""

    subdivision_id = serializers.PrimaryKeyRelatedField(
        source="subdivision",
        queryset=None,
        write_only=True,
    )
    tipo_movimiento_id = serializers.PrimaryKeyRelatedField(
        source="tipo_movimiento",
        queryset=TipoMovimiento.objects.all(),
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
    tipo_movimiento = TipoMovimientoSerializer(read_only=True)
    estado = EstadoMovimientoSerializer(read_only=True)
    tipo_pago = TipoPagoSerializer(read_only=True)
    detalles = DetalleMovimientoSerializer(many=True, read_only=True)

    class Meta:
        model = MovimientoInventario
        fields = [
            "id",
            "subdivision",
            "subdivision_id",
            "tipo_movimiento",
            "tipo_movimiento_id",
            "estado",
            "estado_id",
            "tipo_pago",
            "tipo_pago_id",
            "fecha_documento",
            "numero_documento",
            "observaciones",
            "detalles",
            "creado_en",
            "actualizado_en",
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        from ubicaciones.models import SubDivision

        self.fields["subdivision_id"].queryset = SubDivision.objects.all()
