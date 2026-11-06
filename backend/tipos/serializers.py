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
    divisiones_count = serializers.SerializerMethodField()

    class Meta:
        model = TipoDivision
        fields = ["id", "nombre", "descripcion", "color", "es_referencia", "divisiones_count"]

    def get_divisiones_count(self, obj):
        return obj.divisiones.count()

    def validate_nombre(self, value):
        value = str(value or "").strip()
        if not value:
            raise serializers.ValidationError("Escribe el nombre del tipo.")
        return value

    def validate_color(self, value):
        value = str(value or "").strip()
        if value and not (value.startswith("#") and len(value) in (4, 7)):
            raise serializers.ValidationError("El color no es válido.")
        return value
