from collections import defaultdict
import unicodedata

from django.db import transaction
from rest_framework import serializers

from configuracion.models import ConfiguracionSistema
from inventario.models import Inventario, SubDivision, Sucursal
from productos.models import Producto
from tipos.models import (
    EstadoMovimiento,
    EstadoProducto,
    SubTipoMovimiento,
    TipoMovimiento,
    TipoPago,
)

from .models import DetalleMovimiento, MovimientoInventario, PagoMovimiento


def normalize_name(value):
    text = str(value or "")
    normalized = unicodedata.normalize("NFD", text)
    without_marks = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    return without_marks.strip().lower()


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

    def _resolve_subtipo_key(self, subtipo):
        name = normalize_name(getattr(subtipo, "nombre", ""))
        if "devol" in name:
            return "devolucion"
        if "trasl" in name:
            return "traslado"
        if "vent" in name:
            return "venta"
        return None

    def _resolve_estado_name(self, estado):
        return normalize_name(getattr(estado, "nombre", ""))

    def validate(self, attrs):
        attrs = super().validate(attrs)

        tipo = attrs.get("tipo_movimiento") or getattr(self.instance, "tipo_movimiento", None)
        subtipo = attrs.get("sub_tipo_movimiento") or getattr(self.instance, "sub_tipo_movimiento", None)
        estado = attrs.get("estado_movimiento") or getattr(self.instance, "estado_movimiento", None)

        no_documento = str(
            attrs.get("no_documento", getattr(self.instance, "no_documento", ""))
            or ""
        ).strip()
        tipo_id = getattr(tipo, "id", None)
        if tipo_id and no_documento:
            duplicated = MovimientoInventario.objects.filter(
                tipo_movimiento_id=tipo_id,
                no_documento__iexact=no_documento,
            )
            if self.instance is not None:
                duplicated = duplicated.exclude(pk=self.instance.pk)
            if duplicated.exists():
                raise serializers.ValidationError(
                    {"no_documento": "No se puede usar dos iguales."}
                )

        tipo_name = normalize_name(getattr(tipo, "nombre", ""))
        if not tipo_name.startswith("sal"):
            return attrs

        subtipo_key = self._resolve_subtipo_key(subtipo)
        estado_name = self._resolve_estado_name(estado)

        if subtipo_key == "devolucion":
            if estado_name != "recibido":
                raise serializers.ValidationError(
                    {"estado_movimiento_id": "En devolucion el estado debe ser Recibido."}
                )

        if subtipo_key == "traslado":
            allowed = {"enviado", "recibido", "parcialmente recibido"}
            if estado_name not in allowed:
                raise serializers.ValidationError(
                    {
                        "estado_movimiento_id": (
                            "En traslado solo se permite Enviado, Recibido o Parcialmente recibido."
                        )
                    }
                )

            if self.instance is None and estado_name != "enviado":
                raise serializers.ValidationError(
                    {
                        "estado_movimiento_id": (
                            "El traslado nuevo debe iniciar en estado Enviado."
                        )
                    }
                )

            sucursal = attrs.get("sucursal") or getattr(self.instance, "sucursal", None)
            sucursal_objetivo = attrs.get("sucursal_objetivo") or getattr(
                self.instance,
                "sucursal_objetivo",
                None,
            )
            if sucursal_objetivo is None:
                raise serializers.ValidationError(
                    {"sucursal_objetivo_id": "En traslado debes seleccionar sucursal B."}
                )
            if (
                sucursal is not None
                and sucursal_objetivo is not None
                and int(sucursal.id) == int(sucursal_objetivo.id)
            ):
                raise serializers.ValidationError(
                    {
                        "sucursal_objetivo_id": (
                            "En traslado la sucursal B debe ser diferente a la sucursal A."
                        )
                    }
                )

        if subtipo_key == "venta":
            allowed = {"vendido", "proformado", "facturado"}
            if estado_name not in allowed:
                raise serializers.ValidationError(
                    {
                        "estado_movimiento_id": (
                            "En venta solo se permite Vendido, Proformado o Facturado."
                        )
                    }
                )

            descuento_raw = attrs.get("descuento", getattr(self.instance, "descuento", 0))
            try:
                descuento_value = float(descuento_raw or 0)
            except (TypeError, ValueError):
                raise serializers.ValidationError(
                    {"descuento": "El descuento debe ser un porcentaje valido entre 0 y 100."}
                )

            if descuento_value < 0 or descuento_value > 100:
                raise serializers.ValidationError(
                    {"descuento": "El descuento debe ser un porcentaje entre 0 y 100."}
                )

        return attrs

    def create(self, validated_data):
        detalles_data = validated_data.pop("detalles", [])
        pagos_data = validated_data.pop("pagos", [])
        if "iva_rate" not in validated_data or validated_data["iva_rate"] is None:
            validated_data["iva_rate"] = ConfiguracionSistema.get_solo().iva_rate
        with transaction.atomic():
            movimiento = super().create(validated_data)
            self._replace_detalles(movimiento, detalles_data)
            self._replace_pagos(movimiento, pagos_data)
            self._apply_inventory_effect(movimiento, detalles_data, reverse=False)
        return movimiento

    def update(self, instance, validated_data):
        detalles_data = validated_data.pop("detalles", None)
        pagos_data = validated_data.pop("pagos", None)
        previous_details = list(instance.detalles.select_related("producto").all())

        with transaction.atomic():
            self._apply_inventory_effect(instance, previous_details, reverse=True)

            movimiento = super().update(instance, validated_data)
            if detalles_data is not None:
                movimiento.detalles.all().delete()
                self._replace_detalles(movimiento, detalles_data)
                current_details = detalles_data
            else:
                current_details = list(movimiento.detalles.select_related("producto").all())

            if pagos_data is not None:
                movimiento.pagos.all().delete()
                self._replace_pagos(movimiento, pagos_data)

            self._apply_inventory_effect(movimiento, current_details, reverse=False)

        return movimiento

    def _collect_product_quantities(self, details_source):
        quantities = defaultdict(int)

        for detail in details_source or []:
            if isinstance(detail, dict):
                producto = detail.get("producto")
                producto_id = getattr(producto, "id", None)
                raw_qty = detail.get("cantidad")
            else:
                producto_id = getattr(detail, "producto_id", None)
                raw_qty = getattr(detail, "cantidad", 0)

            try:
                cantidad = int(raw_qty or 0)
            except (TypeError, ValueError):
                continue

            if not producto_id or cantidad <= 0:
                continue
            quantities[int(producto_id)] += cantidad

        return quantities

    def _adjust_stock(self, sucursal, producto_id, delta):
        if not delta:
            return

        if sucursal is None:
            raise serializers.ValidationError(
                {"sucursal_id": "No se pudo resolver la sucursal para actualizar inventario."}
            )

        branch_stock = Inventario.objects.select_for_update().filter(
            producto_id=producto_id,
            subdivision__division__bodega__sucursal_id=sucursal.id,
        ).order_by("id")

        if delta < 0:
            required = -int(delta)
            available = sum(item.cantidad for item in branch_stock)
            if available < required:
                raise serializers.ValidationError(
                    {
                        "detalles": (
                            "Stock insuficiente en sucursal A para completar el traslado."
                        )
                    }
                )

            remaining = required
            for item in branch_stock:
                if remaining <= 0:
                    break
                taken = min(item.cantidad, remaining)
                item.cantidad -= taken
                item.save(update_fields=["cantidad"])
                remaining -= taken
            return

        target = branch_stock.filter(cantidad__gt=0).first() or branch_stock.first()
        if target is not None:
            target.cantidad += int(delta)
            target.save(update_fields=["cantidad"])
            return

        subdivision = (
            SubDivision.objects.select_related("division__bodega")
            .filter(division__bodega__sucursal_id=sucursal.id)
            .order_by("id")
            .first()
        )
        if subdivision is None:
            raise serializers.ValidationError(
                {
                    "sucursal_objetivo_id": (
                        "La sucursal destino no tiene subdivisiones para registrar inventario."
                    )
                }
            )

        inventory_row, _ = Inventario.objects.select_for_update().get_or_create(
            subdivision=subdivision,
            producto_id=producto_id,
            referencia="",
            defaults={"cantidad": 0},
        )
        inventory_row.cantidad += int(delta)
        inventory_row.save(update_fields=["cantidad"])

    def _apply_inventory_effect(self, movimiento, details_source, reverse=False):
        if self._resolve_subtipo_key(getattr(movimiento, "sub_tipo_movimiento", None)) != "traslado":
            return

        estado_name = self._resolve_estado_name(getattr(movimiento, "estado_movimiento", None))
        quantities = self._collect_product_quantities(details_source)
        if not quantities:
            return

        factor = -1 if reverse else 1
        should_add_destino = estado_name in {"recibido", "parcialmente recibido"}

        for producto_id, cantidad in quantities.items():
            self._adjust_stock(
                sucursal=getattr(movimiento, "sucursal", None),
                producto_id=producto_id,
                delta=(-cantidad * factor),
            )
            if should_add_destino:
                self._adjust_stock(
                    sucursal=getattr(movimiento, "sucursal_objetivo", None),
                    producto_id=producto_id,
                    delta=(cantidad * factor),
                )

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
