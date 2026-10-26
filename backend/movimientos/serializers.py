from collections import defaultdict
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import re
from types import SimpleNamespace
import unicodedata

from django.db import IntegrityError, transaction
from rest_framework import serializers

from core.concurrency import acquire_sequence_lock
from casa_comercial.models import CasaComercial
from configuracion.models import ConfiguracionSistema
from inventario.models import Inventario, SubDivision, Sucursal
from productos.models import Producto, add_producto_referencia
from tipos.models import (
    EstadoMovimiento,
    EstadoProducto,
    SubTipoMovimiento,
    TipoMovimiento,
    TipoPago,
)

from .models import (
    DetalleMovimiento,
    MovimientoInventario,
    PagoMovimiento,
    SolicitudTraslado,
    SolicitudTrasladoDetalle,
    TrasladoInconveniente,
)
from .entry_adjustment import (
    AdjustmentError,
    apply_adjustment,
    entry_adds_stock,
    plan_adjustment,
    quantities_by_product,
)
from .stock_availability import get_available_transfer_quantities_by_product
from .transfer_helpers import cancel_pending_transfer_requests, REMINDERS_SYNC_FLAG


def normalize_name(value):
    text = str(value or "")
    normalized = unicodedata.normalize("NFD", text)
    without_marks = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    return without_marks.strip().lower()


ENTRY_SUBTYPE_PREFIXES = {
    "importacion": "imp",
    "compra_local": "cl",
    "devolucion": "dev",
    "traslado": "tr",
}
SALIDA_SUBTYPE_PREFIXES = {
    **ENTRY_SUBTYPE_PREFIXES,
    "devolucion": "gar",
    "venta": "cl",
}
BRANCH_WORD_STOPWORDS = {
    "de",
    "del",
    "la",
    "las",
    "los",
    "el",
    "y",
    "sucursal",
}


def resolve_subtipo_key(subtipo):
    name = normalize_name(getattr(subtipo, "nombre", ""))
    if "devol" in name:
        return "devolucion"
    if "trasl" in name:
        return "traslado"
    if "vent" in name:
        return "venta"
    if "compra" in name:
        return "compra_local"
    if "import" in name:
        return "importacion"
    return None


def _build_branch_token(branch, fallback="sucursal"):
    if branch is None:
        fallback_normalized = normalize_name(fallback)
        fallback_tokens = re.findall(r"[a-z]+", fallback_normalized)
        fallback_text = "".join(fallback_tokens).strip()
        return (fallback_text[:3] if fallback_text else "suc")

    branch_name = str(getattr(branch, "nombre", "") or "").strip()
    normalized_name = normalize_name(branch_name)
    number_match = re.search(r"\d+", normalized_name)
    number_part = str(number_match.group(0) if number_match else "").strip()
    if number_part.isdigit():
        number_part = str(int(number_part))

    alpha_tokens = re.findall(r"[a-z]+", normalized_name)
    meaningful_tokens = [token for token in alpha_tokens if token not in BRANCH_WORD_STOPWORDS]
    source_tokens = meaningful_tokens or alpha_tokens
    source_text = "".join(source_tokens).strip()
    letters_part = source_text[:3] if source_text else "suc"

    if number_part:
        return f"{number_part}{letters_part}"

    if letters_part:
        return letters_part

    branch_id = getattr(branch, "id", None)
    branch_id_token = str(branch_id).strip() if branch_id is not None else ""
    if branch_id_token:
        return f"{branch_id_token}suc"
    return "suc"


def _max_existing_document_number(model, base_token, filters=None):
    query_filters = dict(filters or {})
    query_filters["no_documento__istartswith"] = f"{base_token}-"
    existing_docs = model.objects.filter(**query_filters).values_list("no_documento", flat=True)
    matcher = re.compile(rf"^{re.escape(base_token)}-(\d+)$", flags=re.IGNORECASE)
    max_number = 0

    for raw_doc in existing_docs:
        matched = matcher.match(str(raw_doc or "").strip())
        if not matched:
            continue
        try:
            max_number = max(max_number, int(matched.group(1)))
        except (TypeError, ValueError):
            continue

    return max_number


def _next_incremental_document_number(model, base, filters=None, extra_max_sources=None, lock_model_label=None):
    base_token = str(base or "").strip().upper().strip("-")
    if not base_token:
        base_token = "DOC"

    # Debe llamarse dentro del mismo transaction.atomic() que hace el INSERT
    # que reserva el numero (ver acquire_sequence_lock): sin esto, dos
    # entradas/salidas/traslados creados al mismo tiempo pueden calcular el
    # mismo "siguiente numero" y chocar contra el unique de no_documento.
    # Cuando el numero se comparte entre dos modelos (ver TRASLADO_SHARED_LOCK_LABEL
    # mas abajo), ambos deben pedir el lock con la MISMA llave, si no cada uno
    # se serializa contra si mismo pero no contra el otro.
    acquire_sequence_lock(lock_model_label or model._meta.label, base_token)

    max_number = _max_existing_document_number(model, base_token, filters)
    for extra_model, extra_filters in extra_max_sources or []:
        max_number = max(max_number, _max_existing_document_number(extra_model, base_token, extra_filters))

    return f"{base_token}-{max_number + 1}"


# Un traslado directo (MovimientoInventario) y una solicitud de traslado
# (SolicitudTraslado) comparten el mismo espacio de no_documento -- un
# traslado directo crea de una vez su propia SolicitudTraslado "aprobada"
# con el mismo numero (ver create() mas abajo, is_direct_transfer). Por eso
# el numero para "tr-..." se calcula mirando las dos tablas, y las dos usan
# esta misma llave de lock para serializarse entre si (no solo consigo mismas).
TRASLADO_SHARED_LOCK_LABEL = "movimientos.TrasladoDocumento"


def build_entry_document_base(
    subtipo_key,
    sucursal,
    sucursal_objetivo=None,
    prefix_map=None,
    cliente_identificacion=None,
):
    if prefix_map is None:
        prefix_map = ENTRY_SUBTYPE_PREFIXES
    normalized_subtipo_key = str(subtipo_key or "").strip()
    prefix = prefix_map.get(normalized_subtipo_key)
    if not prefix:
        raise serializers.ValidationError(
            {"sub_tipo_movimiento_id": "No se pudo resolver el prefijo del documento."}
        )

    sucursal_token = _build_branch_token(sucursal)

    if prefix == "tr":
        objetivo_token = _build_branch_token(sucursal_objetivo, fallback="destino")
        return f"{prefix}-{sucursal_token}-{objetivo_token}"

    if normalized_subtipo_key == "venta":
        cliente_token = re.sub(r"[^A-Za-z0-9]", "", str(cliente_identificacion or "")).strip().upper()
        if not cliente_token:
            raise serializers.ValidationError(
                {"cliente_id": "Se requiere la identificacion del cliente para generar el documento."}
            )
        return f"{prefix}-{sucursal_token}-{cliente_token}"

    return f"{prefix}-{sucursal_token}"


def generate_entry_document_number(
    tipo_movimiento,
    subtipo_key,
    sucursal,
    sucursal_objetivo=None,
    prefix_map=None,
    cliente_identificacion=None,
):
    if tipo_movimiento is None:
        raise serializers.ValidationError(
            {"tipo_movimiento_id": "No se pudo resolver el tipo de movimiento."}
        )

    base = build_entry_document_base(
        subtipo_key=subtipo_key,
        sucursal=sucursal,
        sucursal_objetivo=sucursal_objetivo,
        prefix_map=prefix_map,
        cliente_identificacion=cliente_identificacion,
    )
    is_traslado = str(subtipo_key or "").strip() == "traslado"
    return _next_incremental_document_number(
        model=MovimientoInventario,
        base=base,
        filters={"tipo_movimiento": tipo_movimiento},
        extra_max_sources=[(SolicitudTraslado, None)] if is_traslado else None,
        lock_model_label=TRASLADO_SHARED_LOCK_LABEL if is_traslado else None,
    )


def generate_transfer_request_document_number(sucursal_solicitante, sucursal_proveedora):
    base = build_entry_document_base(
        subtipo_key="traslado",
        sucursal=sucursal_proveedora,
        sucursal_objetivo=sucursal_solicitante,
    )
    return _next_incremental_document_number(
        model=SolicitudTraslado,
        base=base,
        extra_max_sources=[(MovimientoInventario, None)],
        lock_model_label=TRASLADO_SHARED_LOCK_LABEL,
    )


class DetalleMovimientoSerializer(serializers.ModelSerializer):
    """Serializa los productos asociados a un movimiento."""

    producto = serializers.StringRelatedField(read_only=True)
    # Tambien se devuelve: las pantallas de detalle lo necesitan para saber
    # que producto es cada linea (antes lo buscaban por nombre en la primera
    # pagina del catalogo y casi nunca lo encontraban).
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
    )
    estado_producto = serializers.StringRelatedField(read_only=True)
    estado_producto_id = serializers.PrimaryKeyRelatedField(
        source="estado_producto",
        queryset=EstadoProducto.objects.all(),
        write_only=True,
    )
    # No pertenece a DetalleMovimiento -- se usa solo para actualizar
    # Producto.referencia en compra local (ver _sync_producto_pricing_from_compra_local).
    producto_referencia = serializers.CharField(
        write_only=True, required=False, allow_blank=True, allow_null=True
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
            "costo",
            "descuento_porcentaje",
            "precio_anterior",
            "producto_referencia",
        ]
        extra_kwargs = {
            "costo": {"required": False, "allow_null": True},
            "descuento_porcentaje": {"required": False, "allow_null": True},
            "precio_anterior": {"required": False, "allow_null": True},
        }


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


class UbicacionInicialEntradaSerializer(serializers.Serializer):
    """
    Ubicacion sugerida para productos que aun no tienen inventario
    registrado en la sucursal de la entrada.
    """

    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
    )
    subdivision_id = serializers.PrimaryKeyRelatedField(
        source="subdivision",
        queryset=SubDivision.objects.all(),
        required=False,
    )
    # En vez de una subdivision: "por_ubicar" (queda pendiente de guardar en
    # "Por ubicar") o "temporal" (ubicacion temporal, sin pendiente).
    ubicacion_especial = serializers.ChoiceField(
        choices=["por_ubicar", "temporal"],
        required=False,
    )

    def validate(self, attrs):
        if not attrs.get("subdivision") and not attrs.get("ubicacion_especial"):
            raise serializers.ValidationError("Indica la subdivision o la ubicacion especial.")
        return attrs


class SolicitudTrasladoDetalleSerializer(serializers.ModelSerializer):
    """Detalle de productos de una solicitud de traslado."""

    producto = serializers.StringRelatedField(read_only=True)
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
    )
    producto_codigo = serializers.CharField(source="producto.codigo", read_only=True)
    producto_nombre = serializers.CharField(source="producto.nombre", read_only=True)

    class Meta:
        model = SolicitudTrasladoDetalle
        fields = [
            "id",
            "producto",
            "producto_id",
            "producto_codigo",
            "producto_nombre",
            "cantidad",
            "valor",
            "verificado",
        ]
        extra_kwargs = {
            "verificado": {"read_only": True},
        }

    def _resolve_ubicacion_actual(self, instance):
        sucursal_id = getattr(instance.solicitud, "sucursal_proveedora_id", None)
        producto_id = getattr(instance, "producto_id", None)
        if not sucursal_id or not producto_id:
            return None
        precomputed = self.context.get("ubicacion_actual_map")
        if precomputed is not None:
            return precomputed.get((int(sucursal_id), int(producto_id)))
        return (
            Inventario.objects.filter(
                producto_id=producto_id,
                cantidad__gt=0,
                subdivision__division__bodega__sucursal_id=sucursal_id,
            )
            .select_related("subdivision__division__bodega")
            .order_by("-cantidad", "subdivision__division__nombre", "subdivision__nombre")
            .first()
        )

    def to_representation(self, instance):
        data = super().to_representation(instance)
        inventario = self._resolve_ubicacion_actual(instance)
        if inventario is not None:
            subdivision = inventario.subdivision
            division = subdivision.division
            bodega = division.bodega
            data["ubicacion_bodega"] = bodega.nombre
            data["ubicacion_division"] = division.nombre
            data["ubicacion_subdivision"] = subdivision.nombre
            data["ubicacion_bodega_layout"] = {
                "id": bodega.id,
                "nombre": bodega.nombre,
                "ancho_metros": bodega.ancho_metros,
                "alto_metros": bodega.alto_metros,
                "ubicaciones": bodega.ubicaciones,
            }
        else:
            data["ubicacion_bodega"] = None
            data["ubicacion_division"] = None
            data["ubicacion_subdivision"] = None
            data["ubicacion_bodega_layout"] = None
        return data


def format_actor_display_name(user):
    if user is None:
        return ""
    full_name = str(getattr(user, "get_full_name", lambda: "")() or "").strip()
    if full_name:
        return full_name
    return str(getattr(user, "email", "") or "").strip()


class SolicitudTrasladoSerializer(serializers.ModelSerializer):
    """Serializa solicitudes de traslado A -> B."""

    sucursal_solicitante = serializers.StringRelatedField(read_only=True)
    sucursal_solicitante_id = serializers.PrimaryKeyRelatedField(
        source="sucursal_solicitante",
        queryset=Sucursal.objects.all(),
    )
    sucursal_proveedora = serializers.StringRelatedField(read_only=True)
    sucursal_proveedora_id = serializers.PrimaryKeyRelatedField(
        source="sucursal_proveedora",
        queryset=Sucursal.objects.all(),
    )
    detalles = SolicitudTrasladoDetalleSerializer(many=True)
    movimiento_salida_id = serializers.IntegerField(source="movimiento_salida.id", read_only=True)
    movimiento_entrada_id = serializers.IntegerField(source="movimiento_entrada.id", read_only=True)
    estado_label = serializers.SerializerMethodField(read_only=True)
    rechazada_por_nombre = serializers.SerializerMethodField(read_only=True)
    creado_por_nombre = serializers.SerializerMethodField(read_only=True)
    enviado_por_nombre = serializers.SerializerMethodField(read_only=True)
    recibido_por_nombre = serializers.SerializerMethodField(read_only=True)
    factura_referencia = serializers.SerializerMethodField(read_only=True)
    recepcion_progreso = serializers.SerializerMethodField(read_only=True)
    nota_envio = serializers.SerializerMethodField(read_only=True)
    recordatorio_destinatario_ids = serializers.ListField(
        child=serializers.IntegerField(min_value=1),
        write_only=True,
        required=False,
        allow_empty=True,
    )

    class Meta:
        model = SolicitudTraslado
        fields = [
            "id",
            "no_documento",
            "fecha",
            "descripcion",
            "urgente",
            "estado",
            "estado_label",
            "sucursal_solicitante",
            "sucursal_solicitante_id",
            "sucursal_proveedora",
            "sucursal_proveedora_id",
            "movimiento_salida_id",
            "movimiento_entrada_id",
            "factura_referencia",
            "historial_transfer",
            "borrador_recepcion",
            "recepcion_progreso",
            "nota_envio",
            "motivo_rechazo",
            "rechazada_por",
            "rechazada_por_nombre",
            "rechazada_en",
            "creado_por",
            "creado_por_nombre",
            "enviado_por",
            "enviado_por_nombre",
            "recibido_por",
            "recibido_por_nombre",
            "detalles",
            "recordatorio_destinatario_ids",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "no_documento",
            "estado",
            "estado_label",
            "motivo_rechazo",
            "rechazada_por",
            "rechazada_por_nombre",
            "rechazada_en",
            "creado_por",
            "creado_por_nombre",
            "enviado_por",
            "enviado_por_nombre",
            "recibido_por",
            "recibido_por_nombre",
            "movimiento_salida_id",
            "movimiento_entrada_id",
            "factura_referencia",
            "historial_transfer",
            "created_at",
            "updated_at",
        ]

    def get_nota_envio(self, obj):
        salida = getattr(obj, "movimiento_salida", None)
        return str(getattr(salida, "descripcion", "") or "").strip()

    def get_recepcion_progreso(self, obj):
        from inventario.por_ubicar import serialize_progress

        precomputed = self.context.get("recepcion_progreso_map")
        if precomputed is not None and obj.pk in precomputed:
            return precomputed[obj.pk]
        return serialize_progress(obj.recepcion_progreso, obj.sucursal_solicitante_id)

    def get_factura_referencia(self, obj):
        movimiento_salida = getattr(obj, "movimiento_salida", None)
        return str(getattr(movimiento_salida, "factura_referencia", "") or "").strip()

    def get_rechazada_por_nombre(self, obj):
        return format_actor_display_name(getattr(obj, "rechazada_por", None))

    def get_creado_por_nombre(self, obj):
        return format_actor_display_name(getattr(obj, "creado_por", None))

    def get_enviado_por_nombre(self, obj):
        return format_actor_display_name(getattr(obj, "enviado_por", None))

    def get_recibido_por_nombre(self, obj):
        return format_actor_display_name(getattr(obj, "recibido_por", None))

    def get_estado_label(self, obj):
        estado = str(getattr(obj, "estado", "") or "").strip().lower()
        if estado == SolicitudTraslado.Estados.GUARDADO:
            return "Guardado"
        if estado == SolicitudTraslado.Estados.PENDIENTE:
            return "Solicitud pendiente"
        if estado == SolicitudTraslado.Estados.CANCELADA:
            return "Rechazada"
        if estado == SolicitudTraslado.Estados.APROBADA:
            if getattr(obj, "movimiento_salida_id", None):
                return "Solicitud enviada"
            return "Solicitud aceptada"
        display = str(getattr(obj, "get_estado_display", lambda: "")() or "").strip()
        if display:
            return display
        return str(getattr(obj, "estado", "") or "").strip() or "-"

    def validate(self, attrs):
        attrs = super().validate(attrs)
        is_borrador = bool(self.context.get("is_borrador"))
        sucursal_solicitante = attrs.get("sucursal_solicitante") or getattr(
            self.instance, "sucursal_solicitante", None
        )
        sucursal_proveedora = attrs.get("sucursal_proveedora") or getattr(
            self.instance, "sucursal_proveedora", None
        )

        if (
            sucursal_solicitante is not None
            and sucursal_proveedora is not None
            and int(sucursal_solicitante.id) == int(sucursal_proveedora.id)
        ):
            raise serializers.ValidationError(
                {
                    "sucursal_proveedora_id": (
                        "La sucursal proveedora debe ser diferente a la sucursal solicitante."
                    )
                }
            )

        is_finalizing = (
            self.instance is not None
            and getattr(self.instance, "estado", None) == SolicitudTraslado.Estados.GUARDADO
            and not is_borrador
        )
        detalles_data = attrs.get("detalles")
        if (self.instance is None or is_finalizing) and not is_borrador:
            effective_detalles = detalles_data
            if effective_detalles is None and self.instance is not None:
                effective_detalles = list(self.instance.detalles.all())
            if not effective_detalles:
                raise serializers.ValidationError(
                    {"detalles": "Debes agregar al menos un producto en la solicitud."}
                )

            if not attrs.get("recordatorio_destinatario_ids"):
                raise serializers.ValidationError(
                    {
                        "recordatorio_destinatario_ids": (
                            "Debes seleccionar al menos un usuario adicional para el recordatorio."
                        )
                    }
                )

        if detalles_data is not None:
            repeated = set()
            stock_cache = {}
            for item in detalles_data:
                producto = item.get("producto")
                producto_id = getattr(producto, "id", None)
                cantidad = int(item.get("cantidad") or 0)
                if not producto_id or cantidad <= 0:
                    raise serializers.ValidationError(
                        {"detalles": "Todos los productos deben tener cantidad mayor a 0."}
                    )
                if producto_id in repeated:
                    raise serializers.ValidationError(
                        {"detalles": "No puedes repetir el mismo producto en la solicitud."}
                    )
                repeated.add(producto_id)

                if sucursal_proveedora is not None:
                    available = stock_cache.get(int(producto_id))
                    if available is None:
                        available = self._get_available_stock_in_branch(
                            sucursal_id=int(sucursal_proveedora.id),
                            producto_id=int(producto_id),
                            exclude_solicitud_id=getattr(self.instance, "id", None),
                        )
                        stock_cache[int(producto_id)] = available
                    if cantidad > available:
                        codigo = str(getattr(producto, "codigo", "") or "").strip()
                        label = codigo or f"ID {producto_id}"
                        raise serializers.ValidationError(
                            {
                                "detalles": (
                                    f"Stock insuficiente en sucursal proveedora para '{label}'. "
                                    f"Disponible: {available}."
                                )
                            }
                        )
        return attrs

    def create(self, validated_data):
        detalles_data = validated_data.pop("detalles", [])
        validated_data.pop("recordatorio_destinatario_ids", None)
        # La generacion del numero tiene que quedar dentro del mismo atomic()
        # que el INSERT que lo reserva -- ver acquire_sequence_lock.
        with transaction.atomic():
            validated_data["no_documento"] = generate_transfer_request_document_number(
                sucursal_solicitante=validated_data.get("sucursal_solicitante"),
                sucursal_proveedora=validated_data.get("sucursal_proveedora"),
            )
            solicitud = SolicitudTraslado.objects.create(**validated_data)
            for detalle in detalles_data:
                SolicitudTrasladoDetalle.objects.create(solicitud=solicitud, **detalle)
        return solicitud

    def update(self, instance, validated_data):
        detalles_data = validated_data.pop("detalles", None)
        validated_data.pop("recordatorio_destinatario_ids", None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        with transaction.atomic():
            instance.save()
            if detalles_data is not None:
                instance.detalles.all().delete()
                for detalle in detalles_data:
                    SolicitudTrasladoDetalle.objects.create(solicitud=instance, **detalle)
        return instance

    @staticmethod
    def _get_available_stock_in_branch(sucursal_id, producto_id, exclude_solicitud_id=None):
        if not sucursal_id or not producto_id:
            return 0

        product_id = int(producto_id)
        available_map = get_available_transfer_quantities_by_product(
            sucursal_id=int(sucursal_id),
            product_ids=[product_id],
            exclude_solicitud_id=exclude_solicitud_id,
        )
        return max(int(available_map.get(product_id, 0)), 0)


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
    casa_comercial = serializers.StringRelatedField(read_only=True)
    casa_comercial_id = serializers.PrimaryKeyRelatedField(
        source="casa_comercial",
        queryset=CasaComercial.objects.all(),
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
    creado_por_nombre = serializers.SerializerMethodField(read_only=True)
    solicitud_traslado = serializers.SerializerMethodField(read_only=True)
    solicitud_traslado_id = serializers.PrimaryKeyRelatedField(
        source="solicitud_traslado",
        queryset=SolicitudTraslado.objects.select_related(
            "sucursal_solicitante",
            "sucursal_proveedora",
            "movimiento_salida",
            "movimiento_entrada",
        ).prefetch_related("detalles__producto"),
        write_only=True,
        required=False,
        allow_null=True,
    )
    detalles = DetalleMovimientoSerializer(many=True, required=False)
    pagos = PagoMovimientoSerializer(many=True, required=False)
    ubicaciones_iniciales = UbicacionInicialEntradaSerializer(
        many=True,
        required=False,
        write_only=True,
    )
    # Al editar una entrada recibida: donde sumar o restar la diferencia de
    # cada producto ([{producto_id, subdivision_id}]); ver entry_adjustment.
    ajustes_ubicacion = serializers.ListField(
        child=serializers.DictField(),
        required=False,
        write_only=True,
    )
    nota_inconveniente = serializers.SerializerMethodField(read_only=True)
    nota_inconveniente_resolucion = serializers.SerializerMethodField(read_only=True)
    faltantes_traslado = serializers.SerializerMethodField(read_only=True)
    # Solo la matriz reparte sus compras locales a las demas sucursales.
    es_sucursal_matriz = serializers.SerializerMethodField(read_only=True)

    def get_es_sucursal_matriz(self, obj):
        from app.reposicion import central_branch_id

        # Se calcula una vez por respuesta (el contexto lo comparte la lista).
        if "_central_branch_id" not in self.context:
            self.context["_central_branch_id"] = central_branch_id()
        central_id = self.context["_central_branch_id"]
        return bool(central_id) and int(obj.sucursal_id or 0) == int(central_id)

    def _resolve_otro_inconveniente(self, obj):
        # La nota general de "algo no salio como lo esperado" al recibir un
        # traslado se guarda como TrasladoInconveniente (tipo Otro) ligada a
        # la entrada. Se resuelve aqui para que tanto la entrada como la
        # salida de ese mismo traslado puedan mostrarla junto a la nota normal.
        cached = getattr(obj, "_otro_inconveniente_cache", None)
        if cached is not None:
            return cached or None

        inconveniente = obj.inconvenientes_traslado.filter(
            tipo=TrasladoInconveniente.Tipos.OTRO
        ).order_by("-id").first()
        if inconveniente is None:
            solicitud_salida = getattr(obj, "solicitud_traslado_salida", None)
            if solicitud_salida is not None and solicitud_salida.movimiento_entrada_id:
                inconveniente = TrasladoInconveniente.objects.filter(
                    movimiento_entrada_id=solicitud_salida.movimiento_entrada_id,
                    tipo=TrasladoInconveniente.Tipos.OTRO,
                ).order_by("-id").first()
        obj._otro_inconveniente_cache = inconveniente or False
        return inconveniente

    def get_nota_inconveniente(self, obj):
        inconveniente = self._resolve_otro_inconveniente(obj)
        return str(inconveniente.motivo).strip() if inconveniente else ""

    def get_nota_inconveniente_resolucion(self, obj):
        inconveniente = self._resolve_otro_inconveniente(obj)
        return str(inconveniente.motivo_resolucion).strip() if inconveniente else ""

    def get_faltantes_traslado(self, obj):
        # Unidades que no llegaron al recibir el traslado, por producto, para
        # mostrar "recibido (faltante)" en el detalle de la entrada, junto con
        # como se soluciono cada faltante. Solo en el detalle: en el listado
        # seria una consulta extra por fila.
        view = self.context.get("view")
        if getattr(view, "action", None) != "retrieve":
            return {}
        resoluciones = {
            TrasladoInconveniente.Resoluciones.SUMAR_SOLICITANTE: "Se sumó a la sucursal destino",
            TrasladoInconveniente.Resoluciones.SUMAR_PROVEEDORA: "Se sumó a la sucursal proveedora",
            TrasladoInconveniente.Resoluciones.PERDIDO: "Desaparecido",
            TrasladoInconveniente.Resoluciones.RESTAR_PROVEEDORA: "Se restó de la sucursal proveedora",
            TrasladoInconveniente.Resoluciones.SIN_CAMBIOS: "Sin cambios de inventario",
            TrasladoInconveniente.Resoluciones.DEVOLVER_PROVEEDORA: "Se devolvió a la sucursal proveedora",
        }
        inconvenientes = obj.inconvenientes_traslado.filter(
            tipo=TrasladoInconveniente.Tipos.FALTANTE,
            producto_id__isnull=False,
            cantidad_faltante__gt=0,
        ).select_related(
            "sucursal_resolucion",
            "subdivision_resolucion__division",
            "resuelto_por",
        ).order_by("id")
        faltantes = {}
        for inconveniente in inconvenientes:
            entry = faltantes.setdefault(
                str(inconveniente.producto_id), {"cantidad": 0, "detalles": []}
            )
            cantidad = int(inconveniente.cantidad_faltante or 0)
            entry["cantidad"] += cantidad
            pendiente = inconveniente.estado == TrasladoInconveniente.Estados.PENDIENTE
            resuelto_por = inconveniente.resuelto_por
            entry["detalles"].append(
                {
                    "cantidad": cantidad,
                    "pendiente": pendiente,
                    "solucion": (
                        "Pendiente de solución"
                        if pendiente
                        else resoluciones.get(inconveniente.resolucion)
                        or inconveniente.get_estado_display()
                    ),
                    "sucursal": str(inconveniente.sucursal_resolucion or "") if not pendiente else "",
                    "ubicacion": str(inconveniente.subdivision_resolucion or "") if not pendiente else "",
                    "nota": str(inconveniente.motivo or "").strip(),
                    "resuelto_por": (
                        (resuelto_por.get_full_name() or resuelto_por.get_username()).strip()
                        if resuelto_por and not pendiente
                        else ""
                    ),
                    "fecha": (
                        inconveniente.updated_at.date().isoformat() if not pendiente else ""
                    ),
                }
            )
        return faltantes

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
            "factura_referencia",
            "tipo_envio",
            "solicitud_traslado",
            "solicitud_traslado_id",
            "detalles",
            "pagos",
            "ubicaciones_iniciales",
            "ajustes_ubicacion",
            "garantia_pendiente",
            "estado_garantia",
            "casa_comercial",
            "casa_comercial_id",
            "nota_inconveniente",
            "nota_inconveniente_resolucion",
            "faltantes_traslado",
            "es_sucursal_matriz",
            "es_legado",
            "creado_por",
            "creado_por_nombre",
        ]
        extra_kwargs = {
            "no_documento": {
                "required": False,
                "allow_blank": True,
            },
            "factura_referencia": {
                "required": False,
                "allow_blank": True,
            },
            "tipo_envio": {
                "required": False,
                "allow_blank": True,
            },
            "garantia_pendiente": {
                "read_only": True,
            },
            "estado_garantia": {
                "read_only": True,
            },
            "es_legado": {
                "read_only": True,
            },
            "creado_por": {
                "read_only": True,
            },
        }

    def _resolve_subtipo_key(self, subtipo):
        return resolve_subtipo_key(subtipo)

    def _resolve_tipo_name(self, tipo):
        return normalize_name(getattr(tipo, "nombre", ""))

    def _resolve_estado_name(self, estado):
        return normalize_name(getattr(estado, "nombre", ""))

    def _resolve_estado_recibido(self):
        recibido = (
            EstadoMovimiento.objects.filter(nombre__iexact="recibido")
            .order_by("id")
            .first()
        )
        if recibido is not None:
            return recibido

        fallback = (
            EstadoMovimiento.objects.filter(nombre__icontains="recib")
            .exclude(nombre__icontains="parcial")
            .order_by("id")
            .first()
        )
        if fallback is not None:
            return fallback

        raise serializers.ValidationError(
            {
                "estado_movimiento_id": (
                    "No existe el estado Recibido configurado en el sistema."
                )
            }
        )

    def _get_linked_solicitud_traslado(self, movimiento):
        if movimiento is None:
            return None

        try:
            solicitud = movimiento.solicitud_traslado_salida
            if solicitud is not None:
                return solicitud
        except SolicitudTraslado.DoesNotExist:
            pass

        try:
            solicitud = movimiento.solicitud_traslado_entrada
            if solicitud is not None:
                return solicitud
        except SolicitudTraslado.DoesNotExist:
            pass

        return None

    def get_creado_por_nombre(self, movimiento):
        return format_actor_display_name(getattr(movimiento, "creado_por", None))

    def get_solicitud_traslado(self, movimiento):
        solicitud = self._get_linked_solicitud_traslado(movimiento)
        if solicitud is None:
            return None
        # "Enviado por" es quien realmente creo el envio (el movimiento de
        # salida), no solo quien acepto la solicitud -- pueden ser personas
        # distintas. Si el movimiento de salida ya tiene su propio creador
        # (campo nuevo, no existe en registros viejos), se usa ese; si no,
        # se cae de vuelta a quien acepto la solicitud como mejor dato
        # disponible.
        movimiento_salida = getattr(solicitud, "movimiento_salida", None)
        enviado_por = getattr(movimiento_salida, "creado_por", None) or getattr(solicitud, "enviado_por", None)
        return {
            "id": int(solicitud.id),
            "no_documento": str(solicitud.no_documento or "").strip(),
            "estado": str(solicitud.estado or "").strip(),
            "sucursal_solicitante_id": int(solicitud.sucursal_solicitante_id),
            "sucursal_proveedora_id": int(solicitud.sucursal_proveedora_id),
            "creado_por_nombre": format_actor_display_name(getattr(solicitud, "creado_por", None)),
            "enviado_por_nombre": format_actor_display_name(enviado_por),
            "recibido_por_nombre": format_actor_display_name(getattr(solicitud, "recibido_por", None)),
        }

    def to_internal_value(self, data):
        # El frontend calcula el descuento con alta precision para que el
        # Total cuadre exacto al editar directamente el campo Total. En vez
        # de depender de que el cliente nunca mande mas decimales de los que
        # el campo admite, se redondea aqui de forma defensiva para que la
        # creacion/edicion nunca falle por precision decimal.
        if isinstance(data, dict) and data.get("descuento") not in (None, ""):
            try:
                descuento_decimal = Decimal(str(data["descuento"]))
            except (InvalidOperation, ValueError, TypeError):
                pass
            else:
                decimal_places = MovimientoInventario._meta.get_field("descuento").decimal_places
                quantizer = Decimal(1).scaleb(-decimal_places)
                rounded = descuento_decimal.quantize(quantizer, rounding=ROUND_HALF_UP)
                data = {**data, "descuento": str(rounded)}
        return super().to_internal_value(data)

    def validate(self, attrs):
        attrs = super().validate(attrs)

        tipo = attrs.get("tipo_movimiento") or getattr(self.instance, "tipo_movimiento", None)
        subtipo = attrs.get("sub_tipo_movimiento") or getattr(self.instance, "sub_tipo_movimiento", None)
        estado = attrs.get("estado_movimiento") or getattr(self.instance, "estado_movimiento", None)
        solicitud_traslado = attrs.get("solicitud_traslado")

        linked_solicitud = self._get_linked_solicitud_traslado(self.instance)
        if solicitud_traslado is None:
            solicitud_traslado = linked_solicitud
        elif linked_solicitud is not None and int(solicitud_traslado.id) != int(linked_solicitud.id):
            raise serializers.ValidationError(
                {"solicitud_traslado_id": "No puedes reasignar la solicitud de traslado."}
            )

        tipo_name = self._resolve_tipo_name(tipo)
        subtipo_key = self._resolve_subtipo_key(subtipo)
        estado_name = self._resolve_estado_name(estado)
        detalles_data = attrs.get("detalles")
        is_create = self.instance is None

        no_documento = str(
            attrs.get("no_documento", getattr(self.instance, "no_documento", ""))
            or ""
        ).strip()
        factura_referencia = str(
            attrs.get(
                "factura_referencia",
                getattr(self.instance, "factura_referencia", ""),
            )
            or ""
        ).strip()
        is_entry = tipo_name.startswith("ent")
        tipo_id = getattr(tipo, "id", None)

        # Tipo de salida a sucursal: solo en salidas de traslado y obligatorio
        # al crearlas (sin valor por defecto); en el resto queda vacio. Las
        # salidas anteriores sin tipo se pueden seguir editando.
        if not is_entry and subtipo_key == "traslado":
            tipo_envio = str(
                attrs.get("tipo_envio", getattr(self.instance, "tipo_envio", "")) or ""
            ).strip()
            if not tipo_envio and not is_create and "tipo_envio" not in attrs:
                tipo_envio = None
            if tipo_envio is None:
                pass
            elif not tipo_envio:
                raise serializers.ValidationError(
                    {"tipo_envio": "Selecciona el tipo de salida: traslado normal, envio cliente o envio provincia."}
                )
            elif tipo_envio not in MovimientoInventario.TipoEnvio.values:
                raise serializers.ValidationError(
                    {"tipo_envio": "Tipo de salida invalido: traslado normal, envio cliente o envio provincia."}
                )
            if tipo_envio is not None:
                attrs["tipo_envio"] = tipo_envio
        elif is_create or "tipo_envio" in attrs:
            attrs["tipo_envio"] = ""

        if is_entry:
            if self.instance is not None and "no_documento" in attrs:
                original_document = str(getattr(self.instance, "no_documento", "") or "").strip()
                if no_documento != original_document:
                    raise serializers.ValidationError(
                        {"no_documento": "El codigo de entradas se genera automaticamente y no se puede editar."}
                    )
                attrs["no_documento"] = original_document

            requires_factura = subtipo_key in ("devolucion", "compra_local")
            if is_create and requires_factura and not factura_referencia:
                message = (
                    "Debes ingresar la factura de venta para la devolucion."
                    if subtipo_key == "devolucion"
                    else "Debes ingresar el numero de factura."
                )
                raise serializers.ValidationError({"factura_referencia": message})
            attrs["factura_referencia"] = factura_referencia if requires_factura else ""

            if subtipo_key == "compra_local" and (is_create or "sucursal" in attrs):
                sucursal_entrada = attrs.get("sucursal") or getattr(self.instance, "sucursal", None)
                if sucursal_entrada is not None and not sucursal_entrada.puede_compra_local:
                    raise serializers.ValidationError(
                        {
                            "sub_tipo_movimiento": (
                                f"La sucursal {sucursal_entrada.nombre} no tiene permiso para hacer compras locales. "
                                "Activalo en Sucursales si corresponde."
                            )
                        }
                    )

            if subtipo_key == "compra_local" and detalles_data:
                for item in detalles_data:
                    if item.get("costo") is None:
                        raise serializers.ValidationError(
                            {"detalles": "Debes ingresar el costo de cada producto."}
                        )
        else:
            if is_create and not no_documento:
                raise serializers.ValidationError(
                    {"no_documento": "Debes ingresar el numero de documento."}
                )

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
            attrs["factura_referencia"] = factura_referencia

        if is_create and not detalles_data:
            requires_request_details = (
                tipo_name.startswith("sal")
                and subtipo_key == "traslado"
                and solicitud_traslado is not None
            )
            if not requires_request_details:
                raise serializers.ValidationError(
                    {"detalles": "Debes agregar al menos un producto al movimiento."}
                )

        if tipo_name.startswith("ent"):
            if subtipo_key == "traslado" and is_create:
                raise serializers.ValidationError(
                    {
                        "sub_tipo_movimiento_id": (
                            "Las entradas por traslado se generan automaticamente cuando se aprueba una solicitud."
                        )
                    }
                )

            if subtipo_key in {"compra_local", "importacion", "devolucion"}:
                attrs["estado_movimiento"] = self._resolve_estado_recibido()
            return attrs

        if not tipo_name.startswith("sal"):
            return attrs

        if subtipo_key == "devolucion":
            if estado_name != "devuelto":
                raise serializers.ValidationError(
                    {"estado_movimiento_id": "En devolucion el estado debe ser Devuelto."}
                )

        if subtipo_key == "venta":
            if estado_name != "vendido":
                raise serializers.ValidationError(
                    {"estado_movimiento_id": "En ventas el estado debe ser Vendido."}
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

            if is_create and estado_name != "enviado":
                raise serializers.ValidationError(
                    {
                        "estado_movimiento_id": (
                            "El traslado nuevo debe iniciar en estado Enviado."
                        )
                    }
                )

            if linked_solicitud is not None and estado_name != "enviado":
                raise serializers.ValidationError(
                    {
                        "estado_movimiento_id": (
                            "Esta salida de traslado fue aprobada por solicitud y debe mantenerse en Enviado."
                        )
                    }
                )

            sucursal = attrs.get("sucursal") or getattr(self.instance, "sucursal", None)
            sucursal_objetivo = attrs.get("sucursal_objetivo") or getattr(
                self.instance,
                "sucursal_objetivo",
                None,
            )

            if is_create:
                if solicitud_traslado is not None:
                    if solicitud_traslado.estado != SolicitudTraslado.Estados.APROBADA:
                        raise serializers.ValidationError(
                            {"solicitud_traslado_id": "La solicitud de traslado debe estar aceptada."}
                        )

                    if (
                        solicitud_traslado.movimiento_salida_id
                        or solicitud_traslado.movimiento_entrada_id
                    ):
                        raise serializers.ValidationError(
                            {"solicitud_traslado_id": "La solicitud ya fue procesada."}
                        )

                    if sucursal is None or int(sucursal.id) != int(solicitud_traslado.sucursal_proveedora_id):
                        raise serializers.ValidationError(
                            {
                                "sucursal_id": (
                                    "La salida debe crearse desde la sucursal proveedora de la solicitud."
                                )
                            }
                        )

                    if (
                        sucursal_objetivo is not None
                        and int(sucursal_objetivo.id) != int(solicitud_traslado.sucursal_solicitante_id)
                    ):
                        raise serializers.ValidationError(
                            {
                                "sucursal_objetivo_id": (
                                    "La sucursal destino debe coincidir con la sucursal solicitante."
                                )
                            }
                        )
                    attrs["sucursal_objetivo"] = solicitud_traslado.sucursal_solicitante
                else:
                    if sucursal_objetivo is None:
                        raise serializers.ValidationError(
                            {"sucursal_objetivo_id": "En traslado debes seleccionar sucursal destino."}
                        )
            else:
                if sucursal_objetivo is None:
                    raise serializers.ValidationError(
                        {"sucursal_objetivo_id": "En traslado debes seleccionar sucursal B."}
                    )

            if (
                sucursal is not None
                and attrs.get("sucursal_objetivo") is not None
                and int(sucursal.id) == int(attrs["sucursal_objetivo"].id)
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

    def _resolve_default_estado_producto(self):
        preferred = EstadoProducto.objects.filter(nombre__icontains="enviad").order_by("id").first()
        if preferred is not None:
            return preferred
        fallback = EstadoProducto.objects.order_by("id").first()
        if fallback is not None:
            return fallback
        raise serializers.ValidationError(
            {
                "detalles": (
                    "No hay estados de producto configurados para completar el traslado."
                )
            }
        )

    def _build_detalles_from_solicitud(self, solicitud_traslado):
        rows = list(solicitud_traslado.detalles.select_related("producto").all())
        if not rows:
            raise serializers.ValidationError(
                {"solicitud_traslado_id": "La solicitud de traslado no tiene productos."}
            )

        estado_producto = self._resolve_default_estado_producto()
        detalles = []
        for row in rows:
            cantidad = int(row.cantidad or 0)
            if cantidad <= 0:
                continue
            valor = row.valor if row.valor is not None else Decimal("0")
            detalles.append(
                {
                    "producto": row.producto,
                    "cantidad": cantidad,
                    "estado_producto": estado_producto,
                    "valor": valor,
                    "valor_total": valor * cantidad,
                }
            )

        if not detalles:
            raise serializers.ValidationError(
                {"solicitud_traslado_id": "La solicitud no tiene cantidades validas."}
            )
        return detalles

    def _resolve_transfer_entry_subtipo(self):
        tipo_entrada = TipoMovimiento.objects.filter(nombre__istartswith="ent").order_by("id").first()
        if tipo_entrada is None:
            raise serializers.ValidationError(
                {
                    "tipo_movimiento_id": (
                        "No existe el tipo de movimiento de entrada para generar el traslado."
                    )
                }
            )

        subtipo_traslado = (
            SubTipoMovimiento.objects.filter(
                tipo_movimiento=tipo_entrada,
                nombre__icontains="trasl",
            )
            .order_by("id")
            .first()
        )
        if subtipo_traslado is None:
            raise serializers.ValidationError(
                {
                    "sub_tipo_movimiento_id": (
                        "No existe el subtipo de traslado para entradas."
                    )
                }
            )
        return tipo_entrada, subtipo_traslado

    def _create_transfer_entry_from_salida(self, salida, detalles_data, solicitud_traslado):
        tipo_entrada, subtipo_traslado = self._resolve_transfer_entry_subtipo()
        descripcion_salida = str(salida.descripcion or "").strip()

        if solicitud_traslado is not None:
            document_number = str(getattr(solicitud_traslado, "no_documento", "") or "").strip()
            if not document_number:
                raise serializers.ValidationError(
                    {
                        "solicitud_traslado_id": (
                            "La solicitud de traslado debe tener un numero de documento para generar la entrada."
                        )
                    }
                )
            sucursal_solicitante = solicitud_traslado.sucursal_solicitante
            sucursal_proveedora = solicitud_traslado.sucursal_proveedora
            descripcion_base = f"Entrada automatica por traslado solicitado #{solicitud_traslado.no_documento}"
        else:
            # Traslado directo: no hay SolicitudTraslado previa, asi que la
            # entrada se deriva directamente de los datos ya presentes en la
            # salida (sucursal_objetivo es el destino que eligio quien envio).
            document_number = str(salida.no_documento or "").strip()
            if not document_number:
                raise serializers.ValidationError(
                    {
                        "no_documento": (
                            "El traslado directo debe tener un numero de documento para generar la entrada."
                        )
                    }
                )
            sucursal_solicitante = salida.sucursal_objetivo
            sucursal_proveedora = salida.sucursal
            descripcion_base = f"Entrada automatica por traslado directo #{document_number}"

        descripcion = (
            f"{descripcion_base}\n{descripcion_salida}"
            if descripcion_salida
            else descripcion_base
        )

        entrada = MovimientoInventario.objects.create(
            sucursal=sucursal_solicitante,
            tipo_movimiento=tipo_entrada,
            sub_tipo_movimiento=subtipo_traslado,
            descripcion=descripcion,
            funcional=bool(salida.funcional),
            sucursal_objetivo=sucursal_proveedora,
            estado_movimiento=salida.estado_movimiento,
            descuento=Decimal("0"),
            iva_rate=salida.iva_rate,
            fecha=salida.fecha,
            no_documento=document_number,
            factura_referencia=str(salida.factura_referencia or "").strip(),
        )

        normalized_details = []
        for detail in detalles_data:
            producto = detail.get("producto")
            cantidad = int(detail.get("cantidad") or 0)
            estado_producto = detail.get("estado_producto")
            valor = detail.get("valor") if detail.get("valor") is not None else Decimal("0")
            valor_total = (
                detail.get("valor_total")
                if detail.get("valor_total") is not None
                else (valor * cantidad)
            )
            normalized_details.append(
                {
                    "producto": producto,
                    "cantidad": cantidad,
                    "estado_producto": estado_producto,
                    "valor": valor,
                    "valor_total": valor_total,
                }
            )

        self._replace_detalles(entrada, normalized_details)
        self._apply_inventory_effect(entrada, normalized_details, reverse=False)
        return entrada

    def _build_entry_initial_locations_map(self, ubicaciones_iniciales, sucursal_id):
        from inventario.por_ubicar import get_por_ubicar_subdivision, get_temporal_subdivision

        special_getters = {
            "por_ubicar": get_por_ubicar_subdivision,
            "temporal": get_temporal_subdivision,
        }
        special_ids = {}
        mapping = {}
        for item in ubicaciones_iniciales or []:
            product = item.get("producto")
            subdivision = item.get("subdivision")
            especial = item.get("ubicacion_especial")
            if subdivision is None and especial in special_getters:
                if especial not in special_ids:
                    special = special_getters[especial](sucursal_id)
                    if special is None:
                        raise serializers.ValidationError(
                            {"ubicaciones_iniciales": "La sucursal no tiene bodegas para ubicar el producto."}
                        )
                    special_ids[especial] = special
                subdivision = special_ids[especial]
            product_id = int(getattr(product, "id", 0) or 0)
            subdivision_id = int(getattr(subdivision, "id", 0) or 0)
            if product_id <= 0 or subdivision_id <= 0:
                continue
            if product_id in mapping and mapping[product_id] != subdivision_id:
                raise serializers.ValidationError(
                    {
                        "ubicaciones_iniciales": (
                            "No puedes asignar mas de una subdivision inicial al mismo producto."
                        )
                    }
                )
            mapping[product_id] = subdivision_id
        return mapping

    def _ensure_entry_location_rows(self, movimiento, details_source, ubicaciones_iniciales):
        tipo_name = self._resolve_tipo_name(getattr(movimiento, "tipo_movimiento", None))
        subtipo_key = self._resolve_subtipo_key(
            getattr(movimiento, "sub_tipo_movimiento", None)
        )
        estado_name = self._resolve_estado_name(
            getattr(movimiento, "estado_movimiento", None)
        )

        should_add_on_entry = (
            tipo_name.startswith("ent")
            and subtipo_key in {"compra_local", "importacion", "devolucion"}
            and estado_name in {"recibido", "parcialmente recibido"}
        )
        if not should_add_on_entry:
            return

        quantities = self._collect_product_quantities(details_source)
        if not quantities:
            return

        sucursal_id = int(getattr(movimiento, "sucursal_id", 0) or 0)
        if sucursal_id <= 0:
            raise serializers.ValidationError(
                {"sucursal_id": "No se pudo resolver la sucursal de la entrada."}
            )

        detail_product_ids = set(int(product_id) for product_id in quantities.keys())
        existing_product_ids = set(
            Inventario.objects.select_for_update()
            .filter(
                subdivision__division__bodega__sucursal_id=sucursal_id,
                producto_id__in=sorted(detail_product_ids),
            )
            .values_list("producto_id", flat=True)
        )
        missing_product_ids = sorted(detail_product_ids - existing_product_ids)
        if not missing_product_ids:
            return

        location_map = self._build_entry_initial_locations_map(ubicaciones_iniciales, sucursal_id)
        unassigned_ids = [pid for pid in missing_product_ids if pid not in location_map]
        if unassigned_ids:
            raise serializers.ValidationError(
                {
                    "ubicaciones_iniciales": (
                        "Debes asignar una ubicacion inicial para todos los productos "
                        "sin ubicacion en la sucursal seleccionada."
                    )
                }
            )

        target_subdivision_ids = sorted(
            {int(location_map[pid]) for pid in missing_product_ids}
        )
        valid_subdivision_ids = set(
            SubDivision.objects.filter(
                id__in=target_subdivision_ids,
                division__bodega__sucursal_id=sucursal_id,
            ).values_list("id", flat=True)
        )
        if valid_subdivision_ids != set(target_subdivision_ids):
            raise serializers.ValidationError(
                {
                    "ubicaciones_iniciales": (
                        "Una o mas subdivisiones no pertenecen a la sucursal de la entrada."
                    )
                }
            )

        for product_id in missing_product_ids:
            subdivision_id = int(location_map[product_id])
            Inventario.objects.select_for_update().get_or_create(
                subdivision_id=subdivision_id,
                producto_id=int(product_id),
                referencia="",
                defaults={"cantidad": 0},
            )

    def _create_movimiento_with_document_retry(self, validated_data, tipo_name, max_attempts=5):
        # Las salidas (a diferencia de entradas y traslados) reciben el
        # no_documento ya elegido por el cliente -- normalmente el numero
        # sugerido por el preview de /siguiente-documento/, que dos usuarios
        # pueden haber pedido casi al mismo tiempo y recibido igual. validate()
        # ya chequea que no exista, pero ese chequeo y este INSERT no son
        # atomicos entre requests, asi que reintenta con un numero nuevo
        # (calculado con lock, ver acquire_sequence_lock) si el INSERT choca
        # contra el unique de no_documento -- en vez de devolver un error al
        # segundo usuario que solo estaba creando su salida al mismo tiempo.
        original_no_documento = str(validated_data.get("no_documento") or "").strip()
        for attempt in range(max_attempts):
            try:
                with transaction.atomic():
                    return super().create(validated_data)
            except IntegrityError as exc:
                is_document_conflict = "no_documento" in str(exc).lower()
                if not is_document_conflict or not original_no_documento or attempt == max_attempts - 1:
                    raise
                base_token = re.sub(r"-\d+$", "", original_no_documento.upper()).strip("-")
                with transaction.atomic():
                    validated_data["no_documento"] = _next_incremental_document_number(
                        model=MovimientoInventario,
                        base=base_token,
                        filters={"tipo_movimiento": validated_data.get("tipo_movimiento")},
                    )
        raise IntegrityError("No se pudo generar un numero de documento unico.")

    def create(self, validated_data):
        detalles_data = validated_data.pop("detalles", [])
        pagos_data = validated_data.pop("pagos", [])
        solicitud_traslado = validated_data.pop("solicitud_traslado", None)
        ubicaciones_iniciales = validated_data.pop("ubicaciones_iniciales", [])

        tipo_name = self._resolve_tipo_name(validated_data.get("tipo_movimiento"))
        subtipo_key = self._resolve_subtipo_key(validated_data.get("sub_tipo_movimiento"))
        is_transfer_approval = (
            tipo_name.startswith("sal")
            and subtipo_key == "traslado"
            and solicitud_traslado is not None
        )
        is_direct_transfer = (
            tipo_name.startswith("sal")
            and subtipo_key == "traslado"
            and solicitud_traslado is None
            and validated_data.get("sucursal_objetivo") is not None
        )

        if is_transfer_approval:
            solicitud_document_number = str(
                getattr(solicitud_traslado, "no_documento", "") or ""
            ).strip()
            if not solicitud_document_number:
                raise serializers.ValidationError(
                    {
                        "solicitud_traslado_id": (
                            "La solicitud de traslado debe tener un numero de documento para generar la salida."
                        )
                    }
                )
            validated_data["no_documento"] = solicitud_document_number

        if is_transfer_approval:
            detalles_data = self._build_detalles_from_solicitud(solicitud_traslado)
            pagos_data = []

        if "iva_rate" not in validated_data or validated_data["iva_rate"] is None:
            validated_data["iva_rate"] = ConfiguracionSistema.get_solo().iva_rate
        # Solo la salida "libre" (venta, garantia, etc. -- no atada a una
        # solicitud de traslado) usa un no_documento elegido por el cliente
        # y necesita el reintento; entradas y traslados ya se generan bajo
        # lock arriba/en generate_transfer_request_document_number.
        is_plain_salida = tipo_name.startswith("sal") and not is_transfer_approval and not is_direct_transfer
        with transaction.atomic():
            if tipo_name.startswith("ent"):
                # Generado dentro del atomic() que hace el INSERT que lo
                # reserva -- ver acquire_sequence_lock.
                validated_data["no_documento"] = generate_entry_document_number(
                    tipo_movimiento=validated_data.get("tipo_movimiento"),
                    subtipo_key=subtipo_key,
                    sucursal=validated_data.get("sucursal"),
                    sucursal_objetivo=validated_data.get("sucursal_objetivo"),
                )
            if is_plain_salida:
                movimiento = self._create_movimiento_with_document_retry(validated_data, tipo_name)
            else:
                movimiento = super().create(validated_data)
            self._replace_detalles(movimiento, detalles_data)
            if tipo_name.startswith("ent") and subtipo_key == "compra_local":
                self._sync_producto_pricing_from_compra_local(detalles_data)
            self._replace_pagos(movimiento, pagos_data)
            self._ensure_entry_location_rows(
                movimiento,
                detalles_data,
                ubicaciones_iniciales,
            )
            self._apply_inventory_effect(movimiento, detalles_data, reverse=False)

            if is_transfer_approval:
                movimiento_entrada = self._create_transfer_entry_from_salida(
                    movimiento,
                    detalles_data,
                    solicitud_traslado,
                )
                solicitud_traslado.estado = SolicitudTraslado.Estados.APROBADA
                solicitud_traslado.movimiento_salida = movimiento
                solicitud_traslado.movimiento_entrada = movimiento_entrada
                solicitud_traslado.save(
                    update_fields=[
                        "estado",
                        "movimiento_salida",
                        "movimiento_entrada",
                        "updated_at",
                    ]
                )
            elif is_direct_transfer:
                # Traslado directo (sin solicitud previa): se genera la
                # entrada igual que en un traslado aprobado, y se crea una
                # SolicitudTraslado ya "aprobada" para que el resto del
                # sistema (envios en camino, recepcion, inconvenientes,
                # recordatorios) trate este traslado exactamente igual que
                # uno que si paso por el flujo de solicitud.
                movimiento_entrada = self._create_transfer_entry_from_salida(
                    movimiento,
                    detalles_data,
                    None,
                )
                request_obj = self.context.get("request")
                actor_user = getattr(request_obj, "user", None) if request_obj is not None else None
                solicitud_directa = SolicitudTraslado.objects.create(
                    sucursal_solicitante=movimiento.sucursal_objetivo,
                    sucursal_proveedora=movimiento.sucursal,
                    descripcion=str(movimiento.descripcion or "").strip(),
                    fecha=movimiento.fecha,
                    no_documento=str(movimiento.no_documento or "").strip(),
                    estado=SolicitudTraslado.Estados.APROBADA,
                    creado_por=actor_user,
                    enviado_por=actor_user,
                    movimiento_salida=movimiento,
                    movimiento_entrada=movimiento_entrada,
                )
                SolicitudTrasladoDetalle.objects.bulk_create(
                    [
                        SolicitudTrasladoDetalle(
                            solicitud=solicitud_directa,
                            producto=detalle.get("producto"),
                            cantidad=int(detalle.get("cantidad") or 0),
                            valor=(
                                detalle.get("valor")
                                if detalle.get("valor") is not None
                                else Decimal("0")
                            ),
                        )
                        for detalle in detalles_data
                        if detalle.get("producto") is not None
                    ]
                )
                movimiento._direct_transfer_solicitud = solicitud_directa
        return movimiento

    @staticmethod
    def parse_location_overrides(raw):
        overrides = {}
        for item in raw or []:
            try:
                producto_id = int(item.get("producto_id") or 0)
                subdivision_id = int(item.get("subdivision_id") or 0)
            except (TypeError, ValueError, AttributeError):
                continue
            if producto_id > 0 and subdivision_id > 0:
                overrides[producto_id] = subdivision_id
        return overrides

    def _entry_adds_stock(self, movimiento):
        return entry_adds_stock(
            self._resolve_tipo_name(getattr(movimiento, "tipo_movimiento", None)),
            self._resolve_subtipo_key(getattr(movimiento, "sub_tipo_movimiento", None)),
            self._resolve_estado_name(getattr(movimiento, "estado_movimiento", None)),
            getattr(movimiento, "funcional", True),
        )

    def _update_entry_by_difference(self, instance, validated_data, detalles_data, pagos_data, overrides):
        """Entrada recibida que sigue recibida en la misma sucursal: solo la diferencia."""
        before = quantities_by_product(instance.detalles.all())
        after = quantities_by_product(detalles_data)
        product_ids = set(before) | set(after)
        products = {
            p.id: (p.codigo, p.nombre)
            for p in Producto.objects.filter(id__in=product_ids).only("id", "codigo", "nombre")
        }
        with transaction.atomic():
            plan = plan_adjustment(
                sucursal=instance.sucursal,
                before=before,
                after=after,
                overrides=overrides,
                products=products,
                for_update=True,
            )
            errors = [item["error"] for item in plan if item["error"]]
            if errors:
                raise serializers.ValidationError({"detalles": " ".join(errors)})
            movimiento = super().update(instance, validated_data)
            movimiento.detalles.all().delete()
            self._replace_detalles(movimiento, detalles_data)
            if self._resolve_subtipo_key(movimiento.sub_tipo_movimiento) == "compra_local":
                self._sync_producto_pricing_from_compra_local(detalles_data)
            if pagos_data is not None:
                movimiento.pagos.all().delete()
                self._replace_pagos(movimiento, pagos_data)
            try:
                reduced = apply_adjustment(plan, movimiento.sucursal_id)
            except AdjustmentError as exc:
                raise serializers.ValidationError({"detalles": str(exc)})
            if reduced:
                self._reject_pending_transfers_due_to_stock_changes({movimiento.sucursal_id: reduced})
        return movimiento

    def update(self, instance, validated_data):
        detalles_data = validated_data.pop("detalles", None)
        pagos_data = validated_data.pop("pagos", None)
        validated_data.pop("ubicaciones_iniciales", None)
        validated_data.pop("solicitud_traslado", None)
        overrides = self.parse_location_overrides(validated_data.pop("ajustes_ubicacion", None))

        # Compra local ya repartida a otras sucursales: lo enviado salio de su
        # stock, asi que sus cantidades y su sucursal ya no se pueden cambiar.
        if instance.pk and instance.envios_compra.exists():
            nueva_sucursal = validated_data.get("sucursal", instance.sucursal)
            cambia_cantidades = detalles_data is not None and quantities_by_product(
                detalles_data
            ) != quantities_by_product(instance.detalles.all())
            if cambia_cantidades or getattr(nueva_sucursal, "id", None) != instance.sucursal_id:
                raise serializers.ValidationError(
                    {
                        "detalles": (
                            "Esta compra local ya se envio a otras sucursales: no puedes cambiar sus "
                            "cantidades ni su sucursal (si puedes cambiar precios, costos y factura)."
                        )
                    }
                )

        # Entrada que ya sumo al inventario y lo sigue haciendo en la misma
        # sucursal: se aplica solo la diferencia por producto.
        if detalles_data is not None and not getattr(instance, "garantia_pendiente", False):
            fields = ("tipo_movimiento", "sub_tipo_movimiento", "estado_movimiento", "funcional", "sucursal")
            preview = SimpleNamespace(
                **{name: validated_data.get(name, getattr(instance, name, None)) for name in fields}
            )
            if (
                self._entry_adds_stock(instance)
                and self._entry_adds_stock(preview)
                and getattr(preview.sucursal, "id", None) == instance.sucursal_id
            ):
                return self._update_entry_by_difference(
                    instance, validated_data, detalles_data, pagos_data, overrides
                )

        previous_details = list(instance.detalles.select_related("producto").all())

        with transaction.atomic():
            if not getattr(instance, "garantia_pendiente", False):
                self._apply_inventory_effect(instance, previous_details, reverse=True)

            movimiento = super().update(instance, validated_data)
            if detalles_data is not None:
                movimiento.detalles.all().delete()
                self._replace_detalles(movimiento, detalles_data)
                current_details = detalles_data
                tipo_name = self._resolve_tipo_name(movimiento.tipo_movimiento)
                subtipo_key = self._resolve_subtipo_key(movimiento.sub_tipo_movimiento)
                if tipo_name.startswith("ent") and subtipo_key == "compra_local":
                    self._sync_producto_pricing_from_compra_local(detalles_data)
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

        branch_stock = Inventario.objects.select_for_update(of=("self",)).filter(
            producto_id=producto_id,
            subdivision__division__bodega__sucursal_id=sucursal.id,
        ).select_related("subdivision__division").order_by("id")

        if delta < 0:
            required = -int(delta)
            # Lo que llego y sigue en POR UBICAR (entre parentesis en el
            # inventario) se descuenta primero: asi al contar el envio solo
            # quedan por guardar las que no se vendieron.
            from inventario.por_ubicar import POR_UBICAR_NOMBRE

            branch_stock = sorted(
                branch_stock,
                key=lambda item: (
                    not (
                        str(item.subdivision.nombre or "").strip().upper() == POR_UBICAR_NOMBRE
                        and str(item.subdivision.division.nombre or "").strip().upper() == POR_UBICAR_NOMBRE
                    ),
                    item.id,
                ),
            )
            available = sum(item.cantidad for item in branch_stock)
            if available < required:
                raise serializers.ValidationError(
                    {
                        "detalles": (
                            "Stock insuficiente en la sucursal para completar el movimiento."
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
        if getattr(movimiento, "garantia_pendiente", False):
            return
        if str(getattr(movimiento, "estado_garantia", "") or "").strip() == "eliminada":
            return
        subtipo_key = self._resolve_subtipo_key(getattr(movimiento, "sub_tipo_movimiento", None))
        tipo_name = self._resolve_tipo_name(getattr(movimiento, "tipo_movimiento", None))
        estado_name = self._resolve_estado_name(getattr(movimiento, "estado_movimiento", None))
        quantities = self._collect_product_quantities(details_source)
        if not quantities:
            return

        stock_reductions = defaultdict(set)
        factor = -1 if reverse else 1

        if tipo_name.startswith("ent"):
            should_add_on_entry = (
                subtipo_key in {"compra_local", "importacion", "devolucion"}
                and estado_name in {"recibido", "parcialmente recibido"}
            )
            if should_add_on_entry:
                if subtipo_key == "devolucion" and not getattr(movimiento, "funcional", True):
                    return
                for producto_id, cantidad in quantities.items():
                    delta = cantidad * factor
                    self._adjust_stock(
                        sucursal=getattr(movimiento, "sucursal", None),
                        producto_id=producto_id,
                        delta=delta,
                    )
                    self._track_stock_reduction(
                        stock_reductions,
                        getattr(movimiento, "sucursal", None),
                        producto_id,
                        delta,
                    )
                self._reject_pending_transfers_due_to_stock_changes(stock_reductions)
                return

        if subtipo_key == "venta" and tipo_name.startswith("sal"):
            if estado_name != "vendido":
                return
            for producto_id, cantidad in quantities.items():
                delta = -cantidad * factor
                self._adjust_stock(
                    sucursal=getattr(movimiento, "sucursal", None),
                    producto_id=producto_id,
                    delta=delta,
                )
                self._track_stock_reduction(
                    stock_reductions,
                    getattr(movimiento, "sucursal", None),
                    producto_id,
                    delta,
                )
            self._reject_pending_transfers_due_to_stock_changes(stock_reductions)
            return

        if subtipo_key == "devolucion" and tipo_name.startswith("sal"):
            if estado_name != "devuelto":
                return
            for producto_id, cantidad in quantities.items():
                delta = -cantidad * factor
                self._adjust_stock(
                    sucursal=getattr(movimiento, "sucursal", None),
                    producto_id=producto_id,
                    delta=delta,
                )
                self._track_stock_reduction(
                    stock_reductions,
                    getattr(movimiento, "sucursal", None),
                    producto_id,
                    delta,
                )
            self._reject_pending_transfers_due_to_stock_changes(stock_reductions)
            return

        if subtipo_key != "traslado":
            self._reject_pending_transfers_due_to_stock_changes(stock_reductions)
            return

        should_mark_received = estado_name in {"recibido", "parcialmente recibido"}

        if tipo_name.startswith("sal"):
            for producto_id, cantidad in quantities.items():
                delta = -cantidad * factor
                self._adjust_stock(
                    sucursal=getattr(movimiento, "sucursal", None),
                    producto_id=producto_id,
                    delta=delta,
                )
                self._track_stock_reduction(
                    stock_reductions,
                    getattr(movimiento, "sucursal", None),
                    producto_id,
                    delta,
                )
                if should_mark_received:
                    entry_delta = cantidad * factor
                    self._adjust_stock(
                        sucursal=getattr(movimiento, "sucursal_objetivo", None),
                        producto_id=producto_id,
                        delta=entry_delta,
                    )
                    self._track_stock_reduction(
                        stock_reductions,
                        getattr(movimiento, "sucursal_objetivo", None),
                        producto_id,
                        entry_delta,
                    )
            self._reject_pending_transfers_due_to_stock_changes(stock_reductions)
            return

        if tipo_name.startswith("ent") and should_mark_received:
            for producto_id, cantidad in quantities.items():
                delta = cantidad * factor
                self._adjust_stock(
                    sucursal=getattr(movimiento, "sucursal", None),
                    producto_id=producto_id,
                    delta=delta,
                )
                self._track_stock_reduction(
                    stock_reductions,
                    getattr(movimiento, "sucursal", None),
                    producto_id,
                    delta,
                )

        self._reject_pending_transfers_due_to_stock_changes(stock_reductions)

    def _track_stock_reduction(self, stock_reductions, sucursal, producto_id, delta):
        if delta >= 0:
            return

        sucursal_id = int(getattr(sucursal, "id", 0) or 0)
        if sucursal_id <= 0 or producto_id <= 0:
            return

        stock_reductions[sucursal_id].add(int(producto_id))

    def _reject_pending_transfers_due_to_stock_changes(self, stock_changes):
        if not stock_changes:
            return

        request_user = None
        request_obj = self.context.get("request")
        if request_obj is not None:
            request_user = getattr(request_obj, "user", None)

        changed = False
        for sucursal_id, product_ids in stock_changes.items():
            if sucursal_id <= 0 or not product_ids:
                continue

            triggered = cancel_pending_transfer_requests(
                branch_id=sucursal_id,
                product_ids=product_ids,
                actor_user=request_user,
            )
            if triggered:
                changed = True

        if changed:
            self.context[REMINDERS_SYNC_FLAG] = True

    def _replace_detalles(self, movimiento, detalles_data):
        for detalle in detalles_data:
            detalle_kwargs = {
                key: value for key, value in detalle.items() if key != "producto_referencia"
            }
            DetalleMovimiento.objects.create(
                movimiento_inventario=movimiento,
                **detalle_kwargs,
            )

    def _sync_producto_pricing_from_compra_local(self, detalles_data):
        # El costo que se guarda en el catalogo es siempre el costo inicial
        # ingresado (sin aplicar el descuento negociado): el descuento es
        # informativo de esta compra puntual, no redefine el costo base.
        for detalle in detalles_data:
            producto = detalle.get("producto")
            if producto is None:
                continue
            update_fields = []
            costo = detalle.get("costo")
            if costo is not None:
                producto.costo_minimo = costo
                update_fields.append("costo_minimo")
            valor = detalle.get("valor")
            if valor is not None:
                producto.precio = valor
                update_fields.append("precio")
            if update_fields:
                producto.save(update_fields=update_fields)
            # Un producto puede tener varias referencias: la de esta compra
            # se agrega a la lista sin borrar las que ya tenía
            # (add_producto_referencia deduplica si ya la tiene).
            referencia = detalle.get("producto_referencia")
            if referencia is not None:
                add_producto_referencia(producto, referencia)

    def _replace_pagos(self, movimiento, pagos_data):
        for pago in pagos_data:
            PagoMovimiento.objects.create(
                movimiento_inventario=movimiento,
                **pago,
            )


def build_solicitud_traslado_list_context(solicitudes):
    """Contexto para serializar muchas solicitudes de traslado sin consultas
    por fila: avance de recepcion y "ubicacion actual" de cada producto en la
    sucursal proveedora (antes 1 consulta por detalle y 2 por solicitud)."""
    from inventario.por_ubicar import serialize_progress_many

    solicitudes = list(solicitudes)
    progresos = serialize_progress_many(
        [(row.recepcion_progreso, row.sucursal_solicitante_id) for row in solicitudes]
    )
    pairs = {
        (int(row.sucursal_proveedora_id), int(detalle.producto_id))
        for row in solicitudes
        if row.sucursal_proveedora_id
        for detalle in row.detalles.all()
        if detalle.producto_id
    }
    ubicaciones = {}
    if pairs:
        rows = (
            Inventario.objects.filter(
                producto_id__in=sorted({pid for _, pid in pairs}),
                cantidad__gt=0,
                subdivision__division__bodega__sucursal_id__in=sorted({suc for suc, _ in pairs}),
            )
            .select_related("subdivision__division__bodega")
            .order_by("-cantidad", "subdivision__division__nombre", "subdivision__nombre")
        )
        # Mismo orden que _resolve_ubicacion_actual: la primera de cada par gana.
        for inventario in rows:
            key = (int(inventario.subdivision.division.bodega.sucursal_id), int(inventario.producto_id))
            if key in pairs and key not in ubicaciones:
                ubicaciones[key] = inventario
    return {
        "recepcion_progreso_map": {row.pk: progreso for row, progreso in zip(solicitudes, progresos)},
        "ubicacion_actual_map": ubicaciones,
    }
