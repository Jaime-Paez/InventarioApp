from decimal import Decimal

from rest_framework import serializers

from .models import (
    ManoObra,
    Taller,
    Tecnico,
    OrdenTaller,
    OrdenTallerDevolucion,
    OrdenTallerEntrega,
    OrdenTallerEvento,
    OrdenTallerLinea,
    OrdenTallerPrueba,
)


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


class TallerSerializer(serializers.ModelSerializer):
    sucursal_nombre = serializers.CharField(source="sucursal.nombre", read_only=True)
    ordenes_abiertas = serializers.SerializerMethodField()

    class Meta:
        model = Taller
        fields = ["id", "nombre", "sucursal", "sucursal_nombre", "direccion", "activo", "ordenes_abiertas", "creado_en"]
        read_only_fields = ["id", "creado_en"]

    def get_ordenes_abiertas(self, obj):
        return obj.ordenes.filter(estado=OrdenTaller.Estados.ORDEN).count()

    def validate_nombre(self, value):
        value = str(value or "").strip()
        if not value:
            raise serializers.ValidationError("Escribe el nombre del taller.")
        return value


class TecnicoSerializer(serializers.ModelSerializer):
    ordenes_abiertas = serializers.SerializerMethodField()

    class Meta:
        model = Tecnico
        fields = ["id", "nombre", "cedula", "telefono", "especialidad", "activo", "ordenes_abiertas", "creado_en"]
        read_only_fields = ["id", "creado_en"]

    def get_ordenes_abiertas(self, obj):
        return obj.ordenes.filter(estado=OrdenTaller.Estados.ORDEN).count()

    def validate_nombre(self, value):
        value = str(value or "").strip()
        if not value:
            raise serializers.ValidationError("Escribe el nombre del técnico.")
        return value


class OrdenTallerLineaSerializer(serializers.ModelSerializer):
    tipo_label = serializers.CharField(source="get_tipo_display", read_only=True)
    producto_codigo = serializers.CharField(source="producto.codigo", read_only=True, default="")
    total = serializers.SerializerMethodField()
    pendiente_despacho = serializers.IntegerField(read_only=True)
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
            "cantidad_despachada",
            "pendiente_despacho",
            "precio_lista",
            "precio",
            "precio_estado",
            "precio_revisado_por_nombre",
            "precio_revisado_en",
            "es_garantia",
            "era_sin_codigo",
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


class OrdenTallerPruebaSerializer(serializers.ModelSerializer):
    producto_codigo = serializers.CharField(source="producto.codigo", read_only=True)
    producto_nombre = serializers.CharField(source="producto.nombre", read_only=True)
    producto_precio = serializers.DecimalField(source="producto.precio", max_digits=10, decimal_places=2, read_only=True)
    origen_label = serializers.CharField(source="get_origen_display", read_only=True)
    pendiente_entrega = serializers.IntegerField(read_only=True)
    en_taller = serializers.IntegerField(read_only=True)
    creado_por_nombre = serializers.SerializerMethodField()

    class Meta:
        model = OrdenTallerPrueba
        fields = [
            "id",
            "producto",
            "producto_codigo",
            "producto_nombre",
            "producto_precio",
            "origen",
            "origen_label",
            "cantidad_solicitada",
            "cantidad_entregada",
            "cantidad_usada",
            "cantidad_devuelta",
            "pendiente_entrega",
            "en_taller",
            "creado_por_nombre",
            "creado_en",
        ]

    def get_creado_por_nombre(self, obj):
        return nombre_usuario(obj.creado_por)


class OrdenTallerEntregaSerializer(serializers.ModelSerializer):
    entregado_por_nombre = serializers.SerializerMethodField()
    tipo_label = serializers.CharField(source="get_tipo_display", read_only=True)
    items = serializers.SerializerMethodField()

    class Meta:
        model = OrdenTallerEntrega
        fields = [
            "id",
            "tipo",
            "tipo_label",
            "entregado_por_nombre",
            "recibido_por",
            "recibido_rol",
            "firma",
            "nota",
            "creado_en",
            "items",
        ]

    def get_entregado_por_nombre(self, obj):
        return nombre_usuario(obj.entregado_por)

    def get_items(self, obj):
        return [
            {
                "id": item.id,
                "linea": item.linea_id,
                "prueba": item.prueba_id,
                "producto": item.producto_id,
                "producto_codigo": item.producto.codigo,
                "producto_nombre": item.producto.nombre,
                "sucursal": item.sucursal_id,
                "sucursal_nombre": item.sucursal.nombre if item.sucursal_id else "",
                "cantidad": item.cantidad,
                "ubicaciones": item.ubicaciones or [],
                "a_prueba": item.prueba_id is not None,
            }
            for item in obj.items.all()
        ]


class OrdenTallerDevolucionSerializer(serializers.ModelSerializer):
    producto_codigo = serializers.CharField(source="producto.codigo", read_only=True)
    producto_nombre = serializers.CharField(source="producto.nombre", read_only=True)
    recibido_por_nombre = serializers.SerializerMethodField()

    class Meta:
        model = OrdenTallerDevolucion
        fields = [
            "id",
            "prueba",
            "producto",
            "producto_codigo",
            "producto_nombre",
            "cantidad",
            "ubicacion",
            "devuelto_por",
            "recibido_por_nombre",
            "creado_en",
        ]

    def get_recibido_por_nombre(self, obj):
        return nombre_usuario(obj.recibido_por)


class OrdenTallerEventoSerializer(serializers.ModelSerializer):
    usuario_nombre = serializers.SerializerMethodField()

    class Meta:
        model = OrdenTallerEvento
        fields = ["id", "tipo", "descripcion", "usuario_nombre", "creado_en"]

    def get_usuario_nombre(self, obj):
        return nombre_usuario(obj.usuario)


ORDEN_CAMPOS_EDITABLES = [
    "numero_pedido",
    "tecnico_asignado",
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
    sucursal_nombre = serializers.CharField(source="sucursal.nombre", read_only=True, default="")
    taller_nombre = serializers.CharField(source="taller.nombre", read_only=True, default="")
    garantia_de_numero = serializers.IntegerField(source="garantia_de.numero", read_only=True, default=None)
    total = serializers.SerializerMethodField()
    lineas_count = serializers.IntegerField(read_only=True, default=0)
    precios_pendientes = serializers.IntegerField(read_only=True, default=0)
    por_despachar = serializers.SerializerMethodField()
    por_devolver = serializers.BooleanField(read_only=True, default=False)
    sin_codigo = serializers.BooleanField(read_only=True, default=False)

    class Meta:
        model = OrdenTaller
        fields = [
            "id",
            "numero",
            "estado",
            "estado_label",
            "tipo",
            "garantia_de",
            "garantia_de_numero",
            "taller",
            "taller_nombre",
            "sucursal",
            "sucursal_nombre",
            "numero_factura",
            "asesor_nombre",
            "total",
            "lineas_count",
            "precios_pendientes",
            "por_despachar",
            "por_devolver",
            "sin_codigo",
            "aceptada_en",
            "cerrada_en",
            "creado_en",
            "actualizado_en",
            *ORDEN_CAMPOS_EDITABLES,
        ]

    def get_asesor_nombre(self, obj):
        return nombre_usuario(obj.asesor)

    def get_por_despachar(self, obj):
        if obj.estado != OrdenTaller.Estados.ORDEN:
            return False
        lineas = getattr(obj, "hay_lineas_pendientes", None)
        pruebas = getattr(obj, "hay_pruebas_por_entregar", None)
        if lineas is not None or pruebas is not None:
            return bool(lineas or pruebas)
        return any(linea.pendiente_despacho for linea in obj.lineas.all()) or any(
            prueba.pendiente_entrega for prueba in obj.pruebas.all()
        )

    def get_total(self, obj):
        total = getattr(obj, "total_calculado", None)
        if total is None:
            total = sum((linea.total for linea in obj.lineas.all()), Decimal("0"))
        return str(Decimal(total).quantize(Decimal("0.01")))


def resumen_orden_anterior(orden):
    if orden is None:
        return None
    return {
        "id": orden.id,
        "numero": orden.numero,
        "estado": orden.estado,
        "numero_factura": orden.numero_factura,
        "placa": orden.placa,
        "cliente_nombre": orden.cliente_nombre,
        "cerrada_en": orden.cerrada_en,
        "repuestos": [
            {
                "linea": linea.id,
                "producto": linea.producto_id,
                "producto_codigo": linea.producto.codigo if linea.producto_id else "",
                "descripcion": linea.descripcion,
                "cantidad": linea.cantidad,
                "precio": str(linea.precio),
            }
            for linea in orden.lineas.all()
            if linea.tipo == OrdenTallerLinea.Tipos.REPUESTO and linea.producto_id
        ],
    }


class OrdenTallerDetailSerializer(OrdenTallerListSerializer):
    lineas = OrdenTallerLineaSerializer(many=True, read_only=True)
    pruebas = OrdenTallerPruebaSerializer(many=True, read_only=True)
    entregas = OrdenTallerEntregaSerializer(many=True, read_only=True)
    devoluciones = OrdenTallerDevolucionSerializer(many=True, read_only=True)
    eventos = OrdenTallerEventoSerializer(many=True, read_only=True)
    aceptada_por_nombre = serializers.SerializerMethodField()
    cerrada_por_nombre = serializers.SerializerMethodField()
    salida_documento = serializers.SerializerMethodField()
    garantia_de_resumen = serializers.SerializerMethodField()
    iva_rate = serializers.SerializerMethodField()

    class Meta(OrdenTallerListSerializer.Meta):
        fields = OrdenTallerListSerializer.Meta.fields + [
            "motivo_rechazo",
            "aceptada_por_nombre",
            "cerrada_por_nombre",
            "salida_documento",
            "garantia_de_resumen",
            "iva_rate",
            "lineas",
            "pruebas",
            "entregas",
            "devoluciones",
            "eventos",
        ]

    def get_aceptada_por_nombre(self, obj):
        return nombre_usuario(obj.aceptada_por)

    def get_salida_documento(self, obj):
        salidas = list(obj.salidas.all())
        if salidas:
            return ", ".join(m.no_documento for m in salidas)
        return obj.movimiento_salida.no_documento if obj.movimiento_salida_id else ""

    def get_cerrada_por_nombre(self, obj):
        return nombre_usuario(obj.cerrada_por)

    def get_garantia_de_resumen(self, obj):
        return resumen_orden_anterior(obj.garantia_de)

    def get_iva_rate(self, obj):
        from configuracion.models import ConfiguracionSistema

        try:
            return str(ConfiguracionSistema.get_solo().iva_rate)
        except Exception:  # pragma: no cover
            return "0.15"


class OrdenTallerHeaderSerializer(serializers.ModelSerializer):
    """Solo los datos de cabecera que se pueden editar."""

    class Meta:
        model = OrdenTaller
        fields = ORDEN_CAMPOS_EDITABLES + ["taller", "numero_factura"]

    def validate(self, attrs):
        if "taller" in attrs:
            taller = attrs["taller"]
            if taller is None:
                raise serializers.ValidationError({"detail": "Elige el taller."})
            attrs["sucursal"] = taller.sucursal
        if "tecnico_asignado" in attrs:
            tecnico = attrs["tecnico_asignado"]
            attrs["tecnico"] = tecnico.nombre if tecnico else ""
        for key in ("placa", "vin"):
            if key in attrs and attrs[key] is not None:
                attrs[key] = str(attrs[key]).strip().upper()
        for key in ("numero_pedido", "tecnico", "cliente_nombre", "cliente_identificacion", "cliente_telefono", "modelo", "numero_factura"):
            if key in attrs and attrs[key] is not None:
                attrs[key] = str(attrs[key]).strip()
        return attrs
