from decimal import Decimal

from rest_framework import serializers

from .models import ManoObra, OrdenTaller, OrdenTallerEvento, OrdenTallerLinea


def nombre_usuario(user):
    if user is None:
        return ""
    full_name = str(user.get_full_name() or "").strip()
    return full_name or str(user.email or user.username or "").strip()


class ManoObraSerializer(serializers.ModelSerializer):
    class Meta:
        model = ManoObra
        fields = ["id", "nombre", "precio", "activo", "creado_en", "actualizado_en"]
        read_only_fields = ["id", "creado_en", "actualizado_en"]

    def validate_nombre(self, value):
        value = str(value or "").strip()
        if not value:
            raise serializers.ValidationError("Escribe el nombre del trabajo.")
        return value

    def validate_precio(self, value):
        if value is None or value < 0:
            raise serializers.ValidationError("El precio no puede ser negativo.")
        return value


class OrdenTallerLineaSerializer(serializers.ModelSerializer):
    tipo_label = serializers.CharField(source="get_tipo_display", read_only=True)
    producto_codigo = serializers.CharField(source="producto.codigo", read_only=True, default="")
    total = serializers.SerializerMethodField()
    precio_revisado_por_nombre = serializers.SerializerMethodField()
    creado_por_nombre = serializers.SerializerMethodField()

    class Meta:
        model = OrdenTallerLinea
        fields = [
            "id",
            "tipo",
            "tipo_label",
            "producto",
            "producto_codigo",
            "mano_obra",
            "referencia",
            "descripcion",
            "cantidad",
            "precio_lista",
            "precio",
            "precio_estado",
            "precio_revisado_por_nombre",
            "precio_revisado_en",
            "agregada_en_orden",
            "total",
            "creado_por_nombre",
            "creado_en",
        ]

    def get_total(self, obj):
        return str(obj.total.quantize(Decimal("0.01")))

    def get_precio_revisado_por_nombre(self, obj):
        return nombre_usuario(obj.precio_revisado_por)

    def get_creado_por_nombre(self, obj):
        return nombre_usuario(obj.creado_por)


class OrdenTallerEventoSerializer(serializers.ModelSerializer):
    usuario_nombre = serializers.SerializerMethodField()

    class Meta:
        model = OrdenTallerEvento
        fields = ["id", "tipo", "descripcion", "usuario_nombre", "creado_en"]

    def get_usuario_nombre(self, obj):
        return nombre_usuario(obj.usuario)


ORDEN_CAMPOS_EDITABLES = [
    "numero_pedido",
    "tecnico",
    "cliente_nombre",
    "cliente_identificacion",
    "cliente_telefono",
    "placa",
    "modelo",
    "vin",
    "kilometraje",
    "observaciones",
]


class OrdenTallerListSerializer(serializers.ModelSerializer):
    estado_label = serializers.CharField(source="get_estado_display", read_only=True)
    asesor_nombre = serializers.SerializerMethodField()
    total = serializers.SerializerMethodField()
    lineas_count = serializers.IntegerField(read_only=True, default=0)
    precios_pendientes = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = OrdenTaller
        fields = [
            "id",
            "numero",
            "estado",
            "estado_label",
            "asesor_nombre",
            "total",
            "lineas_count",
            "precios_pendientes",
            "aceptada_en",
            "creado_en",
            "actualizado_en",
            *ORDEN_CAMPOS_EDITABLES,
        ]

    def get_asesor_nombre(self, obj):
        return nombre_usuario(obj.asesor)

    def get_total(self, obj):
        total = getattr(obj, "total_calculado", None)
        if total is None:
            total = sum((linea.total for linea in obj.lineas.all()), Decimal("0"))
        return str(Decimal(total).quantize(Decimal("0.01")))


class OrdenTallerDetailSerializer(OrdenTallerListSerializer):
    lineas = OrdenTallerLineaSerializer(many=True, read_only=True)
    eventos = OrdenTallerEventoSerializer(many=True, read_only=True)
    aceptada_por_nombre = serializers.SerializerMethodField()

    class Meta(OrdenTallerListSerializer.Meta):
        fields = OrdenTallerListSerializer.Meta.fields + [
            "motivo_rechazo",
            "aceptada_por_nombre",
            "lineas",
            "eventos",
        ]

    def get_aceptada_por_nombre(self, obj):
        return nombre_usuario(obj.aceptada_por)


class OrdenTallerHeaderSerializer(serializers.ModelSerializer):
    """Solo los datos de cabecera que se pueden editar."""

    class Meta:
        model = OrdenTaller
        fields = ORDEN_CAMPOS_EDITABLES

    def validate(self, attrs):
        for key in ("placa", "vin"):
            if key in attrs and attrs[key] is not None:
                attrs[key] = str(attrs[key]).strip().upper()
        for key in ("numero_pedido", "tecnico", "cliente_nombre", "cliente_identificacion", "cliente_telefono", "modelo"):
            if key in attrs and attrs[key] is not None:
                attrs[key] = str(attrs[key]).strip()
        return attrs
