from django.db import transaction
from rest_framework import serializers

from productos.models import Producto
from configuracion.models import ConfiguracionSistema
from tipos.models import (
    EstadoMovimiento,
    EstadoProducto,
    SubTipoMovimiento,
    TipoMovimiento,
    TipoPago,
)
from inventario.models import Sucursal

from .models import DetalleMovimiento, MovimientoInventario, PagoMovimiento


class DetalleMovimientoSerializer(serializers.ModelSerializer):
    """Serializa los productos asociados a un movimiento."""

    producto = serializers.StringRelatedField(read_only=True)
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
        write_only=True,
    )
    estado_producto = serializers.StringRelatedField(read_only=True)
    estado_producto_id = serializers.PrimaryKeyRelatedField(
        source="estado_producto",
        queryset=EstadoProducto.objects.all(),
        write_only=True,
    )

    class Meta:
        model = DetalleMovimiento
        fields = [
            "id",
            "producto",
            "producto_id",
            "cantidad",
            "estado_producto",
            "estado_producto_id",
            "valor",
            "valor_total",
        ]


class PagoMovimientoSerializer(serializers.ModelSerializer):
    """Serializa los tipos de pago asociados a un movimiento."""

    tipo_pago = serializers.StringRelatedField(read_only=True)
    tipo_pago_id = serializers.PrimaryKeyRelatedField(
        source="tipo_pago",
        queryset=TipoPago.objects.all(),
        write_only=True,
        allow_null=False,
    )

    class Meta:
        model = PagoMovimiento
        fields = ["id", "tipo_pago", "tipo_pago_id"]


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
    detalles = DetalleMovimientoSerializer(many=True)
    pagos = PagoMovimientoSerializer(many=True, required=False)

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
            "iva_rate",
            "fecha",
            "no_documento",
            "detalles",
            "pagos",
        ]

    def create(self, validated_data):
        detalles_data = validated_data.pop("detalles", [])
        pagos_data = validated_data.pop("pagos", [])
        if "iva_rate" not in validated_data or validated_data["iva_rate"] is None:
            validated_data["iva_rate"] = ConfiguracionSistema.get_solo().iva_rate
        with transaction.atomic():
            movimiento = super().create(validated_data)
            self._replace_detalles(movimiento, detalles_data)
            self._replace_pagos(movimiento, pagos_data)
        return movimiento

    def update(self, instance, validated_data):
        detalles_data = validated_data.pop("detalles", None)
        pagos_data = validated_data.pop("pagos", None)
        with transaction.atomic():
            movimiento = super().update(instance, validated_data)
            if detalles_data is not None:
                movimiento.detalles.all().delete()
                self._replace_detalles(movimiento, detalles_data)
            if pagos_data is not None:
                movimiento.pagos.all().delete()
                self._replace_pagos(movimiento, pagos_data)
        return movimiento

    def _replace_detalles(self, movimiento, detalles_data):
        for detalle in detalles_data:
            DetalleMovimiento.objects.create(
                movimiento_inventario=movimiento,
                **detalle,
            )

    def _replace_pagos(self, movimiento, pagos_data):
        for pago in pagos_data:
            PagoMovimiento.objects.create(
                movimiento_inventario=movimiento,
                **pago,
            )
