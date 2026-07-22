import re

from django.db import transaction

from rest_framework import serializers

from casa_comercial.models import CasaComercial
from casa_comercial.serializers import CasaComercialSerializer
from productos.models import Producto
from productos.serializers import ProductoSerializer
from solicitudes.models import Solicitud

from .models import Importacion, ImportacionDetalle


def generate_next_importacion_code(casa=None):
    casa_code = str(getattr(casa, "codigo", "") or "").strip().upper()
    prefix = f"IMP-{casa_code}-" if casa_code else "IMP-"
    last_codes = Importacion.objects.filter(codigo__startswith=prefix).values_list("codigo", flat=True)
    max_number = 0
    pattern = re.compile(r"^" + re.escape(prefix) + r"(\d+)$")
    for code in last_codes:
        match = pattern.match(str(code or "").strip())
        if match:
            max_number = max(max_number, int(match.group(1)))
    next_number = max_number + 1
    candidate = f"{prefix}{next_number}"
    while Importacion.objects.filter(codigo=candidate).exists():
        next_number += 1
        candidate = f"{prefix}{next_number}"
    return candidate


class ImportacionDetalleSerializer(serializers.ModelSerializer):
    producto = ProductoSerializer(read_only=True)
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
        write_only=True,
        required=False,
        allow_null=True,
    )
    solicitud_id = serializers.PrimaryKeyRelatedField(
        source="solicitud",
        queryset=Solicitud.objects.all(),
        write_only=False,
        required=False,
        allow_null=True,
    )

    class Meta:
        model = ImportacionDetalle
        fields = ["id", "producto", "producto_id", "codigo", "nombre", "oem", "referencia", "cantidad", "comentario", "precio_estimado", "cantidad_aproximada", "precio_confirmado", "cantidad_confirmada", "precio_pvp_snapshot", "cantidad_recibida", "seleccionado", "solicitud_id"]

    def validate(self, data):
        producto = data.get("producto")
        codigo = str(data.get("codigo") or "").strip()
        nombre = str(data.get("nombre") or "").strip()
        referencia = str(data.get("referencia") or "").strip()
        oem = str(data.get("oem") or "").strip()
        # Un producto realmente sin catálogo (sin producto_id, sin código
        # sugerido) queda como pendiente: alcanza con referencia u OEM para
        # poder identificarlo y vincularlo después al confirmar la llegada.
        if not producto and not codigo and not nombre and not referencia and not oem:
            raise serializers.ValidationError("Se requiere producto, código/nombre, o referencia/OEM.")
        # Un producto ya existente en el catálogo sí necesita una cantidad
        # real a importar. Un producto pendiente (sin producto_id) puede
        # crearse con cantidad 0 — solo registra el catálogo, sin pedir
        # unidades en este envío todavía.
        if producto and int(data.get("cantidad") or 0) <= 0:
            raise serializers.ValidationError("La cantidad debe ser mayor a cero.")
        return data

    def validate_cantidad(self, value):
        if int(value or 0) < 0:
            raise serializers.ValidationError("La cantidad no puede ser negativa.")
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
    origen_id = serializers.SerializerMethodField()
    origen_codigo = serializers.SerializerMethodField()
    en_camino_id = serializers.SerializerMethodField()
    envios = serializers.SerializerMethodField()

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
            "numero_factura",
            "fecha_importacion",
            "fecha_puerto",
            "fecha_llegada",
            "dias_reales_entrega",
            "origen_id",
            "origen_codigo",
            "en_camino_id",
            "historial_confirmacion",
            "borrador_llegada",
            "detalles",
            "envios",
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
            "fecha_importacion",
            "fecha_puerto",
            "fecha_llegada",
            "dias_reales_entrega",
            "origen_id",
            "origen_codigo",
            "en_camino_id",
            "envios",
            "historial_confirmacion",
            "borrador_llegada",
            "total_productos",
            "creado_en",
            "actualizado_en",
        ]

    def get_origen_id(self, obj):
        return obj.origen_id

    def get_en_camino_id(self, obj):
        prefetched = getattr(obj, "_prefetched_objects_cache", {}).get("en_camino_generadas")
        derived = prefetched[0] if prefetched else obj.en_camino_generadas.first()
        return derived.id if derived else None

    def get_origen_codigo(self, obj):
        return obj.origen.codigo if obj.origen_id else None

    def get_envios(self, obj):
        envios_qs = obj.envios.select_related("sucursal").prefetch_related("detalles__producto")
        return [
            {
                "id": envio.id,
                "sucursal_id": envio.sucursal_id,
                "sucursal_nombre": envio.sucursal.nombre,
                "estado": envio.estado,
                "detalles": [
                    {
                        "producto_id": detalle.producto_id,
                        "producto_codigo": detalle.producto.codigo,
                        "producto_nombre": detalle.producto.nombre,
                        "cantidad": detalle.cantidad,
                    }
                    for detalle in envio.detalles.all()
                ],
            }
            for envio in envios_qs
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
    def update(self, instance, validated_data):
        detalles_data = validated_data.pop("detalles", None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        if detalles_data is not None:
            instance.detalles.all().delete()
            ImportacionDetalle.objects.bulk_create([
                ImportacionDetalle(
                    importacion=instance,
                    producto=item.get("producto"),
                    codigo=str(item.get("codigo") or ""),
                    nombre=str(item.get("nombre") or ""),
                    oem=str(item.get("oem") or ""),
                    referencia=str(item.get("referencia") or ""),
                    cantidad=item["cantidad"],
                    comentario=str(item.get("comentario") or ""),
                    precio_estimado=item.get("precio_estimado"),
                    cantidad_aproximada=item.get("cantidad_aproximada"),
                    precio_confirmado=item.get("precio_confirmado"),
                    cantidad_confirmada=item.get("cantidad_confirmada"),
                    precio_pvp_snapshot=item.get("precio_pvp_snapshot"),
                    cantidad_recibida=item.get("cantidad_recibida"),
                    solicitud=item.get("solicitud"),
                    seleccionado=item.get("seleccionado"),
                )
                for item in detalles_data
            ])
            if hasattr(instance, "_prefetched_objects_cache"):
                instance._prefetched_objects_cache.pop("detalles", None)
        return instance

    @transaction.atomic
    def create(self, validated_data):
        detalles_data = validated_data.pop("detalles", [])
        casa = validated_data.get("casa_comercial")
        validated_data["codigo"] = generate_next_importacion_code(casa)
        validated_data["estado"] = Importacion.ESTADO_BORRADOR
        validated_data["dias_entrega_estimados"] = getattr(casa, "dias_entrega", None)

        request = self.context.get("request")
        if request and request.user and request.user.is_authenticated:
            validated_data["creado_por"] = request.user

        importacion = Importacion.objects.create(**validated_data)
        ImportacionDetalle.objects.bulk_create(
            [
                ImportacionDetalle(
                    importacion=importacion,
                    producto=item.get("producto"),
                    codigo=str(item.get("codigo") or ""),
                    nombre=str(item.get("nombre") or ""),
                    oem=str(item.get("oem") or ""),
                    referencia=str(item.get("referencia") or ""),
                    cantidad=item["cantidad"],
                    comentario=str(item.get("comentario") or ""),
                    precio_estimado=item.get("precio_estimado"),
                    precio_confirmado=item.get("precio_confirmado"),
                    cantidad_confirmada=item.get("cantidad_confirmada"),
                    solicitud=item.get("solicitud"),
                )
                for item in detalles_data
            ]
        )
        return importacion
