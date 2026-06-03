import re

from django.db import transaction
from django.db.models import Max
from rest_framework import serializers

from casa_comercial.models import CasaComercial
from casa_comercial.serializers import CasaComercialSerializer
from productos.models import Producto
from productos.serializers import ProductoSerializer

from .models import Importacion, ImportacionDetalle


def generate_next_importacion_code():
    last_codes = Importacion.objects.filter(codigo__startswith="IMP-").values_list("codigo", flat=True)
    max_number = 0
    for code in last_codes:
        match = re.match(r"^IMP-(\d+)$", str(code or "").strip())
        if match:
            max_number = max(max_number, int(match.group(1)))

    max_id = Importacion.objects.aggregate(max_id=Max("id")).get("max_id") or 0
    next_number = max(max_number, int(max_id)) + 1
    candidate = f"IMP-{next_number}"
    while Importacion.objects.filter(codigo=candidate).exists():
        next_number += 1
        candidate = f"IMP-{next_number}"
    return candidate


class ImportacionDetalleSerializer(serializers.ModelSerializer):
    producto = ProductoSerializer(read_only=True)
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
        write_only=True,
    )

    class Meta:
        model = ImportacionDetalle
        fields = ["id", "producto", "producto_id", "cantidad"]

    def validate_cantidad(self, value):
        if int(value or 0) <= 0:
            raise serializers.ValidationError("La cantidad debe ser mayor a cero.")
        return value


class ImportacionSerializer(serializers.ModelSerializer):
    casa_comercial = CasaComercialSerializer(read_only=True)
    casa_comercial_id = serializers.PrimaryKeyRelatedField(
        source="casa_comercial",
        queryset=CasaComercial.objects.all(),
        write_only=True,
    )
    detalles = ImportacionDetalleSerializer(many=True)
    total_productos = serializers.SerializerMethodField()

    class Meta:
        model = Importacion
        fields = [
            "id",
            "codigo",
            "estado",
            "fecha",
            "casa_comercial",
            "casa_comercial_id",
            "dias_entrega_estimados",
            "detalles",
            "total_productos",
            "creado_en",
            "actualizado_en",
        ]
        read_only_fields = [
            "id",
            "codigo",
            "estado",
            "fecha",
            "dias_entrega_estimados",
            "total_productos",
            "creado_en",
            "actualizado_en",
        ]

    def get_total_productos(self, obj):
        prefetched = getattr(obj, "_prefetched_objects_cache", {}).get("detalles")
        if prefetched is not None:
            return sum(int(detalle.cantidad or 0) for detalle in prefetched)
        return sum(obj.detalles.values_list("cantidad", flat=True))

    def validate_detalles(self, value):
        if not value:
            raise serializers.ValidationError("Agrega al menos un producto a la importacion.")
        product_ids = [item["producto"].id for item in value if item.get("producto")]
        if len(product_ids) != len(set(product_ids)):
            raise serializers.ValidationError("No repitas productos dentro de la misma importacion.")
        return value

    @transaction.atomic
    def create(self, validated_data):
        detalles_data = validated_data.pop("detalles", [])
        casa = validated_data.get("casa_comercial")
        validated_data["codigo"] = generate_next_importacion_code()
        validated_data["estado"] = Importacion.ESTADO_EN_PROCESO
        validated_data["dias_entrega_estimados"] = getattr(casa, "dias_entrega", None)

        request = self.context.get("request")
        if request and request.user and request.user.is_authenticated:
            validated_data["creado_por"] = request.user

        importacion = Importacion.objects.create(**validated_data)
        ImportacionDetalle.objects.bulk_create(
            [
                ImportacionDetalle(
                    importacion=importacion,
                    producto=item["producto"],
                    cantidad=item["cantidad"],
                )
                for item in detalles_data
            ]
        )
        return importacion
