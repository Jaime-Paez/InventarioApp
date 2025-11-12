from rest_framework import serializers

from tipos.models import EstadoMovimiento, SubTipoMovimiento, TipoMovimiento
from ubicaciones.models import Sucursal

from .models import MovimientoInventario


class MovimientoInventarioSerializer(serializers.ModelSerializer):
    """Serializador principal para los movimientos de inventario."""

    sucursal = serializers.StringRelatedField(read_only=True)
    sucursal_id = serializers.PrimaryKeyRelatedField(
        source="sucursal",
        queryset=Sucursal.objects.all(),
        write_only=True,
    )
    sucursal_objetivo = serializers.StringRelatedField(read_only=True)
    sucursal_objetivo_id = serializers.PrimaryKeyRelatedField(
        source="sucursal_objetivo",
        queryset=Sucursal.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )
    tipo_movimiento = serializers.StringRelatedField(read_only=True)
    tipo_movimiento_id = serializers.PrimaryKeyRelatedField(
        source="tipo_movimiento",
        queryset=TipoMovimiento.objects.all(),
        write_only=True,
    )
    sub_tipo_movimiento = serializers.StringRelatedField(read_only=True)
    sub_tipo_movimiento_id = serializers.PrimaryKeyRelatedField(
        source="sub_tipo_movimiento",
        queryset=SubTipoMovimiento.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )
    estado_movimiento = serializers.StringRelatedField(read_only=True)
    estado_movimiento_id = serializers.PrimaryKeyRelatedField(
        source="estado_movimiento",
        queryset=EstadoMovimiento.objects.all(),
        write_only=True,
    )

    class Meta:
        model = MovimientoInventario
        fields = [
            "id",
            "sucursal",
            "sucursal_id",
            "tipo_movimiento",
            "tipo_movimiento_id",
            "sub_tipo_movimiento",
            "sub_tipo_movimiento_id",
            "descripcion",
            "funcional",
            "sucursal_objetivo",
            "sucursal_objetivo_id",
            "estado_movimiento",
            "estado_movimiento_id",
            "descuento",
            "fecha",
            "no_documento",
        ]
