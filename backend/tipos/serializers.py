from rest_framework import serializers

from .models import (
    EstadoMovimiento,
    EstadoProducto,
    Pais,
    SubTipoMovimiento,
    TipoDivision,
    TipoMovimiento,
    TipoPago,
)


class PaisSerializer(serializers.ModelSerializer):
    class Meta:
        model = Pais
        fields = ["id", "codigo_pais", "nombre"]


class TipoMovimientoSerializer(serializers.ModelSerializer):
    class Meta:
        model = TipoMovimiento
        fields = ["id", "nombre", "descripcion"]


class SubTipoMovimientoSerializer(serializers.ModelSerializer):
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
    class Meta:
        model = EstadoMovimiento
        fields = ["id", "nombre"]


class EstadoProductoSerializer(serializers.ModelSerializer):
    class Meta:
        model = EstadoProducto
        fields = ["id", "nombre"]


class TipoPagoSerializer(serializers.ModelSerializer):
    class Meta:
        model = TipoPago
        fields = ["id", "nombre"]


class TipoDivisionSerializer(serializers.ModelSerializer):
    class Meta:
        model = TipoDivision
        fields = ["id", "nombre", "descripcion"]
