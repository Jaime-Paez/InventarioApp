import logging
import re
from decimal import Decimal, InvalidOperation
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import (
    Case,
    Count,
    DecimalField,
    ExpressionWrapper,
    F,
    IntegerField,
    OuterRef,
    Q,
    Subquery,
    Sum,
    Value,
    When,
)
from django.db.models.deletion import ProtectedError
from django.db.models.expressions import RawSQL
from django.db.models.functions import Coalesce
from django.utils.dateparse import parse_date
from django.utils import timezone
from rest_framework import filters, serializers as drf_serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.search_utils import (
    apply_token_search,
    attach_product_search,
    get_search_tokens,
    matching_product_ids,
)
from core.table_filters import apply_column_filters, parse_column_filters
from app.models import ReminderState
from app.views import (
    _merge_reminder,
    _merge_transfer_history,
    _normalize_reminder_list,
    _purge_reminders_for_context,
    _sanitize_transfer_history,
    registrar_conteo_por_traslado,
)
from inventario.models import Inventario, SubDivision, Sucursal
from inventario.por_ubicar import (
    RecepcionDesactualizada,
    RecepcionError,
    pending_to_store,
    received_by_product,
    receive_items,
    serialize_progress,
    serialize_progress_many,
    store_items,
)
from solicitudes.models import Cliente

from tipos.models import SubTipoMovimiento, TipoMovimiento
from usuarios.models import RolPermiso, UsuarioModuloSucursal, UsuarioSucursal
from usuarios.permissions import MovimientoInventarioModulePermission
from usuarios.sucursal_scope import (
    ensure_sucursal_allowed_for_modules,
    get_allowed_sucursal_ids,
    get_allowed_sucursal_ids_for_modules,
    get_readable_sucursal_ids,
)
from usuarios.utils import is_app_admin
from .models import (
    DetalleMovimiento,
    MovimientoInventario,
    SolicitudTraslado,
    SolicitudTrasladoDetalle,
    TrasladoInconveniente,
    TrasladoInconvenienteHistorial,
)
from .serializers import (
    MovimientoInventarioSerializer,
    SolicitudTrasladoSerializer,
    build_solicitud_traslado_list_context,
    format_actor_display_name,
    generate_entry_document_number,
    generate_transfer_request_document_number,
    load_ubicacion_orden,
    normalize_name,
    principal_ubicacion_key,
    resolve_subtipo_key,
    SALIDA_SUBTYPE_PREFIXES,
)
from .historial import build_movement_history
from .inconveniente_borrador import parse_borrador_items
from .stock_availability import get_available_transfer_quantities_by_product
from .transfer_helpers import (
    build_sale_stock_change_extra_reason,
    cancel_pending_transfer_requests,
    public_detalles_no_enviados,
    REMINDERS_SYNC_FLAG,
)

ALLOWED_STOCK_MODULES = {
    RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
    RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
}
logger = logging.getLogger(__name__)
TRANSFER_ISSUE_REMINDER_KIND = "solicitud_traslado_inconveniente"
TRANSFER_ISSUE_REMINDER_CONTEXT_TYPE = "traslado_inconveniente"
# Motivos para rechazar un producto de una solicitud de traslado.
TRANSFER_REJECT_REASONS = {"no_tengo", "vendido", "otro"}


# La descripcion de una venta empieza con "Cliente: <nombre>" (ver
# buildDescripcion en CreateSalida.jsx) -- no existe un FK real a Cliente en
# el movimiento, asi que este es el mismo criterio que ya usa el filtro
# cliente_texto (descripcion__iregex=r"(?i)^cliente:") para reconocerlo.
_CLIENTE_DESCRIPCION_RE = re.compile(r"(?i)^cliente:\s*(.*)")


def _extract_cliente_label(descripcion):
    text = str(descripcion or "").strip()
    match = _CLIENTE_DESCRIPCION_RE.match(text)
    if not match:
        return ""
    return match.group(1).split("\n", 1)[0].strip()


# Orden por defecto de la tabla de movimientos (cuando no se pidio un orden
# explicito): Guardado y Pendiente (solicitudes de traslado sin resolver) y
# Enviado (traslado ya en camino) siempre primero y en ese orden fijo, para
# que esos estados accionables salten a la vista de inmediato -- el resto
# cae despues, ordenado por fecha como antes.
def _resolve_estado_priority(estado_nombre):
    normalized = str(estado_nombre or "").strip().lower()
    if "guardado" in normalized:
        return 0
    if "pend" in normalized:
        return 1
    if "envi" in normalized:
        return 2
    return 3


class MovimientoInventarioViewSet(viewsets.ModelViewSet):
    """Gestión de movimientos de inventario."""

    queryset = (
        MovimientoInventario.objects.select_related(
            "sucursal",
            "sucursal_objetivo",
            "tipo_movimiento",
            "sub_tipo_movimiento",
            "estado_movimiento",
            "casa_comercial",
        )
        .prefetch_related(
            "detalles__producto",
            "detalles__estado_producto",
            "pagos__tipo_pago",
        )
        .all()
        .order_by("-fecha", "-id")
    )
    serializer_class = MovimientoInventarioSerializer
    permission_classes = [IsAuthenticated, MovimientoInventarioModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "no_documento",
        "factura_referencia",
        "sucursal__nombre",
        "sucursal_objetivo__nombre",
        "sub_tipo_movimiento__nombre",
        "estado_movimiento__nombre",
    ]
    ordering_fields = [
        "fecha",
        "id",
        "no_documento",
        "factura_referencia",
        "sucursal__nombre",
        "sucursal_objetivo__nombre",
        "sub_tipo_movimiento__nombre",
        "estado_movimiento__nombre",
        "funcional",
        "total_monto",
        "casa_comercial__nombre",
    ]

    def filter_queryset(self, queryset):
        if getattr(self, "action", None) != "tabla":
            return super().filter_queryset(queryset)

        for backend in list(self.filter_backends):
            if backend is filters.SearchFilter:
                continue
            queryset = backend().filter_queryset(self.request, queryset, self)
        return queryset

    def _build_table_detail_payload(self, detail):
        producto = getattr(detail, "producto", None)
        cantidad = int(getattr(detail, "cantidad", 0) or 0)
        valor = getattr(detail, "valor", Decimal("0")) or Decimal("0")
        valor_total = getattr(detail, "valor_total", None)
        if valor_total in (None, ""):
            valor_total = valor * cantidad
        return {
            "id": int(getattr(detail, "id", 0) or 0),
            "producto_id": int(getattr(detail, "producto_id", 0) or 0),
            "producto_codigo": str(getattr(producto, "codigo", "") or "").strip(),
            "producto_nombre": str(getattr(producto, "nombre", "") or "").strip(),
            "cantidad": cantidad,
            "valor": valor,
            "valor_total": valor_total,
        }

    def _serialize_table_rows(self, rows):
        payload = []
        for row in rows:
            is_mapping = isinstance(row, dict)
            movement_id = int((row.get("id") if is_mapping else getattr(row, "id", 0)) or 0)
            estado_raw = (
                row.get("estado_movimiento__nombre")
                if is_mapping
                else getattr(getattr(row, "estado_movimiento", None), "nombre", "")
            )
            tipo_raw = (
                row.get("tipo_movimiento__nombre")
                if is_mapping
                else getattr(getattr(row, "tipo_movimiento", None), "nombre", "")
            )
            sub_tipo_raw = (
                row.get("sub_tipo_movimiento__nombre")
                if is_mapping
                else getattr(getattr(row, "sub_tipo_movimiento", None), "nombre", "")
            )
            fecha_value = row.get("fecha") if is_mapping else getattr(row, "fecha", None)
            detalles_payload = []
            detalles_rows = None if is_mapping else getattr(row, "detalles", None)
            if detalles_rows is not None:
                detalles_payload = [
                    self._build_table_detail_payload(detalle)
                    for detalle in detalles_rows.all()
                ]

            estado_nombre = str(estado_raw or "-").strip() or "-"
            tipo_nombre = self._normalize_state_name(tipo_raw)
            sub_tipo_nombre = self._normalize_state_name(sub_tipo_raw)
            estado_normalizado = self._normalize_state_name(estado_nombre)

            if tipo_nombre.startswith("sal") and "trasl" in sub_tipo_nombre:
                if "parcial" in estado_normalizado or "inconven" in estado_normalizado:
                    estado_nombre = "Llego con inconvenientes"
                elif "recib" in estado_normalizado or "llego" in estado_normalizado:
                    estado_nombre = "Llego"

            sucursal_objetivo_nombre = (
                row.get("sucursal_objetivo__nombre")
                if is_mapping
                else getattr(getattr(row, "sucursal_objetivo", None), "nombre", "")
            ) or ""
            if tipo_nombre.startswith("sal") and "vent" in sub_tipo_nombre:
                descripcion_value = row.get("descripcion") if is_mapping else getattr(row, "descripcion", "")
                sucursal_objetivo_nombre = _extract_cliente_label(descripcion_value) or sucursal_objetivo_nombre
            sucursal_objetivo_nombre = sucursal_objetivo_nombre or "-"

            payload.append(
                {
                    "id": movement_id,
                    "no_documento": str(
                        row.get("no_documento") if is_mapping else getattr(row, "no_documento", "")
                        or ""
                    ).strip(),
                    "factura_referencia": str(
                        row.get("factura_referencia") if is_mapping else getattr(row, "factura_referencia", "")
                        or ""
                    ).strip(),
                    "fecha": fecha_value,
                    "sucursal_nombre": (
                        row.get("sucursal__nombre")
                        if is_mapping
                        else getattr(getattr(row, "sucursal", None), "nombre", "")
                    ) or "-",
                    "sub_tipo_nombre": sub_tipo_raw or "-",
                    "estado_nombre": estado_nombre,
                    "sucursal_objetivo_nombre": sucursal_objetivo_nombre,
                    "casa_comercial_nombre": (
                        row.get("casa_comercial__nombre")
                        if is_mapping
                        else getattr(getattr(row, "casa_comercial", None), "nombre", "")
                    ) or "-",
                    "funcional": bool(row.get("funcional") if is_mapping else getattr(row, "funcional", False)),
                    "funcional_label": "Si"
                    if bool(row.get("funcional") if is_mapping else getattr(row, "funcional", False))
                    else "No",
                    "total": row.get("total_monto") if is_mapping else getattr(row, "total_monto", None),
                    "detalles": detalles_payload,
                    "es_solicitud_traslado": False,
                    "solicitud_traslado_id": None,
                    "garantia_pendiente": bool(
                        row.get("garantia_pendiente") if is_mapping else getattr(row, "garantia_pendiente", False)
                    ),
                    "estado_garantia": (
                        row.get("estado_garantia") if is_mapping else getattr(row, "estado_garantia", None)
                    ) or None,
                    "es_legado": bool(
                        row.get("es_legado") if is_mapping else getattr(row, "es_legado", False)
                    ),
                    "_sort_created_at": (
                        fecha_value.isoformat()
                        if getattr(fecha_value, "isoformat", None)
                        else str(fecha_value or "").strip()
                    ),
                    "_sort_id": movement_id,
                    "_sort_estado_priority": _resolve_estado_priority(estado_nombre),
                }
            )
        return payload

    @staticmethod
    def _resolve_solicitud_estado_label(solicitud):
        estado = str(getattr(solicitud, "estado", "") or "").strip().lower()
        if estado == SolicitudTraslado.Estados.GUARDADO:
            return "Guardado"
        if estado == SolicitudTraslado.Estados.PENDIENTE:
            return "Solicitud pendiente"
        if estado == SolicitudTraslado.Estados.CANCELADA:
            return "Rechazada"
        if estado == SolicitudTraslado.Estados.APROBADA:
            if getattr(solicitud, "movimiento_salida_id", None):
                return "Solicitud enviada"
            return "Solicitud aceptada"
        return estado.capitalize() if estado else "-"

    def _serialize_solicitud_table_rows(self, solicitudes, perspective="entrada"):
        # "sucursal_nombre" siempre es "mi sucursal" y "sucursal_objetivo_nombre"
        # la otra punta, igual que en un movimiento normal -- pero cual es
        # cual depende de si esta fila se esta mostrando en Entradas (yo soy
        # la solicitante) o en Salidas (yo soy la proveedora).
        own_side, other_side = (
            ("sucursal_proveedora", "sucursal_solicitante")
            if perspective == "salida"
            else ("sucursal_solicitante", "sucursal_proveedora")
        )
        payload = []
        for solicitud in solicitudes:
            solicitud_id = int(getattr(solicitud, "id", 0) or 0)
            estado_label = self._resolve_solicitud_estado_label(solicitud)
            is_guardado = str(getattr(solicitud, "estado", "") or "").strip().lower() == SolicitudTraslado.Estados.GUARDADO
            detalles_payload = []
            detalles_rows = getattr(solicitud, "detalles", None)
            if detalles_rows is not None:
                for detalle in detalles_rows.all():
                    detalles_payload.append(self._build_table_detail_payload(detalle))

            payload.append(
                {
                    "id": f"solicitud-{solicitud_id}",
                    "no_documento": str(
                        getattr(solicitud, "no_documento", "") or ""
                    ).strip(),
                    "factura_referencia": "",
                    "fecha": getattr(solicitud, "fecha", None),
                    "sucursal_nombre": (
                        getattr(getattr(solicitud, own_side, None), "nombre", "")
                        or "-"
                    ),
                    "sub_tipo_nombre": "Traslado (Solicitud)",
                    "estado_nombre": estado_label,
                    "sucursal_objetivo_nombre": (
                        getattr(getattr(solicitud, other_side, None), "nombre", "")
                        or "-"
                    ),
                    "funcional": False,
                    "funcional_label": "-",
                    "total": getattr(solicitud, "total_monto", Decimal("0")),
                    "es_solicitud_traslado": True,
                    "solicitud_traslado_id": solicitud_id,
                    "sucursal_solicitante_id": int(
                        getattr(solicitud, "sucursal_solicitante_id", 0) or 0
                    ),
                    "sucursal_proveedora_id": int(
                        getattr(solicitud, "sucursal_proveedora_id", 0) or 0
                    ),
                    "descripcion": str(getattr(solicitud, "descripcion", "") or "").strip(),
                    "motivo_rechazo": str(
                        getattr(solicitud, "motivo_rechazo", "") or ""
                    ).strip(),
                    "urgente": bool(getattr(solicitud, "urgente", False)),
                    "detalles": detalles_payload,
                    "movimiento_salida_id": getattr(
                        solicitud, "movimiento_salida_id", None
                    ),
                    "movimiento_entrada_id": getattr(
                        solicitud, "movimiento_entrada_id", None
                    ),
                    "creado_por_nombre": format_actor_display_name(getattr(solicitud, "creado_por", None)),
                    "enviado_por_nombre": format_actor_display_name(getattr(solicitud, "enviado_por", None)),
                    "recibido_por_nombre": format_actor_display_name(getattr(solicitud, "recibido_por", None)),
                    "_sort_created_at": (
                        getattr(solicitud, "created_at", None).isoformat()
                        if getattr(getattr(solicitud, "created_at", None), "isoformat", None)
                        else (
                            getattr(solicitud, "fecha", None).isoformat()
                            if getattr(getattr(solicitud, "fecha", None), "isoformat", None)
                            else str(getattr(solicitud, "fecha", "") or "").strip()
                        )
                    ),
                    "_sort_id": solicitud_id,
                    "_sort_priority": 0 if is_guardado else 1,
                    "_sort_estado_priority": _resolve_estado_priority(estado_label),
                }
            )
        return payload

    @action(detail=False, methods=['get'], url_path='next-document-number')
    def next_document_number(self, request):
        tipo_movimiento_id = request.query_params.get("tipo_movimiento_id")
        sub_tipo_movimiento_id = request.query_params.get("sub_tipo_movimiento_id")
        sucursal_id = request.query_params.get("sucursal_id")
        sucursal_objetivo_id = request.query_params.get("sucursal_objetivo_id")
        cliente_id = request.query_params.get("cliente_id")
        cliente_identificacion_param = (request.query_params.get("cliente_identificacion") or "").strip()

        if not tipo_movimiento_id:
            return Response({"detail": "tipo_movimiento_id es obligatorio."}, status=status.HTTP_400_BAD_REQUEST)
        if not sub_tipo_movimiento_id:
            return Response({"detail": "sub_tipo_movimiento_id es obligatorio."}, status=status.HTTP_400_BAD_REQUEST)
        if not sucursal_id:
            return Response({"detail": "sucursal_id es obligatorio."}, status=status.HTTP_400_BAD_REQUEST)

        tipo_movimiento = TipoMovimiento.objects.filter(id=tipo_movimiento_id).first()
        sub_tipo_movimiento = SubTipoMovimiento.objects.filter(id=sub_tipo_movimiento_id).first()
        sucursal = Sucursal.objects.filter(id=sucursal_id).first()
        sucursal_objetivo = (
            Sucursal.objects.filter(id=sucursal_objetivo_id).first()
            if sucursal_objetivo_id
            else None
        )
        cliente = Cliente.objects.filter(id=cliente_id).first() if cliente_id else None
        # El cliente puede aun no existir en la BD (se esta creando junto con la
        # salida), asi que se acepta la identificacion tal cual la escribio el
        # usuario cuando no hay un cliente_id resuelto todavia. Y si el cliente
        # SI existe pero le falta cedula/RUC (la gran mayoria de los migrados
        # del sistema anterior -- 8604 de 8731 clientes hoy), se usa su id
        # interno como identificador unico de respaldo en vez de bloquear la
        # venta por un dato que nunca se capturo en la migracion.
        cliente_identificacion = (
            getattr(cliente, "cedula_ruc", None)
            or cliente_identificacion_param
            or (f"CLI{cliente.id}" if cliente is not None else "")
        )

        if not tipo_movimiento or not sub_tipo_movimiento or not sucursal:
            return Response(
                {"detail": "No se encontraron los datos necesarios para generar el documento."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        subtipo_key = resolve_subtipo_key(sub_tipo_movimiento)
        if not subtipo_key:
            return Response(
                {"detail": "No se pudo resolver el tipo de submovimiento."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if subtipo_key == "venta" and cliente_id and not cliente:
            return Response(
                {"detail": "No se encontro el cliente indicado."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        tipo_nombre = str(getattr(tipo_movimiento, "nombre", "") or "").strip().lower()
        prefix_map = SALIDA_SUBTYPE_PREFIXES if tipo_nombre.startswith("sal") else None

        try:
            document_number = generate_entry_document_number(
                tipo_movimiento,
                subtipo_key,
                sucursal,
                sucursal_objetivo,
                prefix_map=prefix_map,
                cliente_identificacion=cliente_identificacion,
            )
        except drf_serializers.ValidationError as exc:
            return Response(exc.detail, status=status.HTTP_400_BAD_REQUEST)

        return Response({"no_documento": document_number})

    # Orden por defecto (sin orden explicito pedido por el usuario): estados
    # accionables primero -- Guardado, Pendiente, Enviado, en ese orden fijo
    # -- y dentro de cada grupo, fecha descendente como antes.
    _DEFAULT_TABLA_ORDERING_TOKENS = ["_sort_estado_priority", "-_sort_created_at", "-fecha", "-id"]

    def _resolve_tabla_ordering_tokens(self):
        raw = (self.request.query_params.get("ordering") or "").strip()
        if not raw:
            return list(self._DEFAULT_TABLA_ORDERING_TOKENS)
        tokens = [token.strip() for token in raw.split(",") if token.strip()]
        return tokens or list(self._DEFAULT_TABLA_ORDERING_TOKENS)

    # Mismo criterio que _NO_DOCUMENTO_SORT_KEY_SQL (natural sort), pero en
    # Python -- esto ordena las filas de solicitudes de traslado (que no
    # existen en la base de datos como movimiento todavia) junto con las
    # ya traidas de la base de datos, y ambos lados deben quedar en el
    # mismo orden relativo.
    _NO_DOCUMENTO_SUFFIX_RE = re.compile(r"^(.*?)(\d+)$")

    def _normalize_table_sort_value(self, value, field):
        if field in {"total", "_sort_id"}:
            try:
                return Decimal(str(value))
            except (InvalidOperation, TypeError, ValueError):
                return Decimal("0")

        if field == "_sort_estado_priority":
            try:
                return int(value)
            except (TypeError, ValueError):
                return 3

        if field == "no_documento":
            text = str(value or "").strip().lower()
            match = self._NO_DOCUMENTO_SUFFIX_RE.match(text)
            if match:
                prefix, digits = match.groups()
                return (prefix, int(digits))
            return (text, -1)

        if value is None:
            return ""
        if isinstance(value, bool):
            return 1 if value else 0
        if hasattr(value, "isoformat"):
            return value.isoformat()
        return str(value).strip().lower()

    def _sort_table_payload(self, rows):
        ordering_map = {
            "_sort_estado_priority": "_sort_estado_priority",
            "_sort_created_at": "_sort_created_at",
            "id": "_sort_id",
            "no_documento": "no_documento",
            "factura_referencia": "factura_referencia",
            "fecha": "fecha",
            "sucursal__nombre": "sucursal_nombre",
            "sub_tipo_movimiento__nombre": "sub_tipo_nombre",
            "estado_movimiento__nombre": "estado_nombre",
            "sucursal_objetivo__nombre": "sucursal_objetivo_nombre",
            "funcional": "funcional",
            "total_monto": "total",
        }

        sorted_rows = list(rows)
        for token in reversed(self._resolve_tabla_ordering_tokens()):
            descending = token.startswith("-")
            ordering_key = token[1:] if descending else token
            field_name = ordering_map.get(ordering_key)
            if not field_name:
                continue
            sorted_rows.sort(
                key=lambda row: self._normalize_table_sort_value(
                    row.get(field_name), field_name
                ),
                reverse=descending,
            )
        # Los pedidos a sucursal guardados (borrador) siempre van primero,
        # sin importar el criterio de orden que se haya pedido: son los que
        # necesitan una accion (completarlos) antes que nada.
        sorted_rows.sort(key=lambda row: row.get("_sort_priority", 1))
        return sorted_rows

    def _strip_internal_table_fields(self, rows):
        sanitized = []
        for row in rows:
            sanitized.append(
                {
                    key: value
                    for key, value in row.items()
                    if not str(key).startswith("_")
                }
            )
        return sanitized

    def _get_solicitudes_for_entrada_table(self):
        params = self.request.query_params
        subtipo_short = str(params.get("subtipo") or "").strip().lower()
        if subtipo_short and subtipo_short != "traslado":
            return []

        sub_tipo_text = str(params.get("sub_tipo") or "").strip().lower()
        if sub_tipo_text and "trasl" not in sub_tipo_text:
            return []

        if self._resolve_funcional_value(params.get("funcional")) is False:
            return []

        detail_total_expr = ExpressionWrapper(
            F("detalles__cantidad") * F("detalles__valor"),
            output_field=DecimalField(max_digits=14, decimal_places=2),
        )
        queryset = (
            SolicitudTraslado.objects.select_related(
                "sucursal_solicitante",
                "sucursal_proveedora",
                "creado_por",
                "enviado_por",
                "recibido_por",
            )
            .prefetch_related("detalles__producto")
            .annotate(
                total_monto=Coalesce(
                    Sum(detail_total_expr),
                    Value(0, output_field=DecimalField(max_digits=14, decimal_places=2)),
                )
            )
            .order_by("-fecha", "-id")
        )
        # Evita duplicados en la tabla de Entradas:
        # cuando la solicitud ya genero movimiento (envio/entrada), se muestra
        # solo el movimiento de inventario real.
        queryset = queryset.filter(
            movimiento_salida_id__isnull=True,
            movimiento_entrada_id__isnull=True,
        )

        if not is_app_admin(self.request.user):
            allowed = get_readable_sucursal_ids(
                self.request.user,
                RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
            )
            if allowed is not None:
                if not allowed:
                    return []
                # Igual que con los movimientos reales (ver el filtro de
                # permisos en get_queryset, que hace match por sucursal O
                # sucursal_objetivo): una solicitud pendiente donde mi
                # sucursal es la proveedora tambien debe verse aqui, no
                # solo cuando ya se convirtio en un movimiento real. Sin
                # esto, un traslado ya completado aparecia en la tabla
                # pero la misma solicitud, mientras seguia pendiente, no.
                queryset = queryset.filter(
                    Q(sucursal_solicitante_id__in=allowed)
                    | Q(sucursal_proveedora_id__in=allowed)
                )

        raw_estado = (params.get("estado") or "").strip().lower()
        allowed_states = {choice[0] for choice in SolicitudTraslado.Estados.choices}
        if raw_estado:
            if raw_estado in allowed_states:
                queryset = queryset.filter(estado=raw_estado)
            else:
                queryset = queryset.filter(estado__icontains=raw_estado)

        no_documento = (params.get("no_documento") or "").strip()
        if no_documento:
            queryset = queryset.filter(no_documento__icontains=no_documento)

        fecha_desde = parse_date((params.get("fecha_desde") or "").strip())
        if fecha_desde:
            queryset = queryset.filter(fecha__gte=fecha_desde)

        fecha_hasta = parse_date((params.get("fecha_hasta") or "").strip())
        if fecha_hasta:
            queryset = queryset.filter(fecha__lte=fecha_hasta)

        sucursal_id_raw = (params.get("sucursal_id") or "").strip()
        if sucursal_id_raw:
            if not sucursal_id_raw.isdigit():
                return []
            queryset = queryset.filter(sucursal_solicitante_id=int(sucursal_id_raw))

        sucursal_text = (params.get("sucursal") or "").strip()
        if sucursal_text:
            queryset = queryset.filter(sucursal_solicitante__nombre__icontains=sucursal_text)

        sucursal_objetivo_text = (params.get("sucursal_objetivo") or "").strip()
        if sucursal_objetivo_text:
            queryset = queryset.filter(
                sucursal_proveedora__nombre__icontains=sucursal_objetivo_text
            )

        search_term = (params.get("search") or "").strip()
        if search_term:
            normalized_search = search_term.lower()
            matching_solicitud_ids = SolicitudTrasladoDetalle.objects.filter(
                Q(producto__codigo__icontains=search_term)
                | Q(producto__nombre__icontains=search_term)
                | Q(producto_id__in=matching_product_ids(search_term))
            ).values_list("solicitud_id", flat=True)
            search_query = (
                Q(no_documento__icontains=search_term)
                | Q(sucursal_solicitante__nombre__icontains=search_term)
                | Q(sucursal_proveedora__nombre__icontains=search_term)
                | Q(estado__icontains=search_term)
                | Q(pk__in=matching_solicitud_ids)
            )
            if normalized_search in {"traslado", "traslados", "trasl"}:
                search_query |= Q(pk__isnull=False)
            queryset = queryset.filter(search_query)

        producto_codigo = (params.get("producto_codigo") or "").strip()
        if producto_codigo:
            matching_solicitud_ids = SolicitudTrasladoDetalle.objects.filter(
                producto__codigo__icontains=producto_codigo
            ).values_list("solicitud_id", flat=True)
            queryset = queryset.filter(pk__in=matching_solicitud_ids)

        total_min = (params.get("total_min") or "").strip()
        if total_min:
            try:
                queryset = queryset.filter(total_monto__gte=Decimal(total_min))
            except (InvalidOperation, ValueError):
                pass

        total_max = (params.get("total_max") or "").strip()
        if total_max:
            try:
                queryset = queryset.filter(total_monto__lte=Decimal(total_max))
            except (InvalidOperation, ValueError):
                pass

        return self._serialize_solicitud_table_rows(queryset)

    def _get_solicitudes_for_salida_table(self):
        """
        Traslados directos guardados como borrador desde el lado que envia
        (Salidas) -- ver _get_solicitudes_for_entrada_table para el
        equivalente del lado que pide (Entradas). A diferencia de ese, solo
        se incluye el estado GUARDADO: pendiente/aprobada/rechazada de un
        traslado directo no tienen sentido (un traslado directo no pasa por
        aprobacion, se envia de una vez), y las solicitudes normales
        (pedido a sucursal) que estan pendientes de una decision ya se ven
        en otro lado (el recordatorio/bola urgente), no en esta tabla.
        """
        params = self.request.query_params
        subtipo_short = str(params.get("subtipo") or "").strip().lower()
        if subtipo_short and subtipo_short != "traslado":
            return []

        sub_tipo_text = str(params.get("sub_tipo") or "").strip().lower()
        if sub_tipo_text and "trasl" not in sub_tipo_text:
            return []

        if self._resolve_funcional_value(params.get("funcional")) is False:
            return []

        detail_total_expr = ExpressionWrapper(
            F("detalles__cantidad") * F("detalles__valor"),
            output_field=DecimalField(max_digits=14, decimal_places=2),
        )
        queryset = (
            SolicitudTraslado.objects.select_related(
                "sucursal_solicitante",
                "sucursal_proveedora",
                "creado_por",
                "enviado_por",
                "recibido_por",
            )
            .prefetch_related("detalles__producto")
            .annotate(
                total_monto=Coalesce(
                    Sum(detail_total_expr),
                    Value(0, output_field=DecimalField(max_digits=14, decimal_places=2)),
                )
            )
            .filter(
                estado=SolicitudTraslado.Estados.GUARDADO,
                movimiento_salida_id__isnull=True,
                movimiento_entrada_id__isnull=True,
            )
            .order_by("-fecha", "-id")
        )

        if not is_app_admin(self.request.user):
            allowed = get_readable_sucursal_ids(
                self.request.user,
                RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
            )
            if allowed is not None:
                if not allowed:
                    return []
                queryset = queryset.filter(sucursal_proveedora_id__in=sorted(allowed))

        no_documento = (params.get("no_documento") or "").strip()
        if no_documento:
            queryset = queryset.filter(no_documento__icontains=no_documento)

        fecha_desde = parse_date((params.get("fecha_desde") or "").strip())
        if fecha_desde:
            queryset = queryset.filter(fecha__gte=fecha_desde)

        fecha_hasta = parse_date((params.get("fecha_hasta") or "").strip())
        if fecha_hasta:
            queryset = queryset.filter(fecha__lte=fecha_hasta)

        sucursal_id_raw = (params.get("sucursal_id") or "").strip()
        if sucursal_id_raw:
            if not sucursal_id_raw.isdigit():
                return []
            queryset = queryset.filter(sucursal_proveedora_id=int(sucursal_id_raw))

        sucursal_text = (params.get("sucursal") or "").strip()
        if sucursal_text:
            queryset = queryset.filter(sucursal_proveedora__nombre__icontains=sucursal_text)

        sucursal_objetivo_text = (params.get("sucursal_objetivo") or "").strip()
        if sucursal_objetivo_text:
            queryset = queryset.filter(
                sucursal_solicitante__nombre__icontains=sucursal_objetivo_text
            )

        search_term = (params.get("search") or "").strip()
        if search_term:
            matching_solicitud_ids = SolicitudTrasladoDetalle.objects.filter(
                Q(producto__codigo__icontains=search_term)
                | Q(producto__nombre__icontains=search_term)
                | Q(producto_id__in=matching_product_ids(search_term))
            ).values_list("solicitud_id", flat=True)
            queryset = queryset.filter(
                Q(no_documento__icontains=search_term)
                | Q(sucursal_solicitante__nombre__icontains=search_term)
                | Q(sucursal_proveedora__nombre__icontains=search_term)
                | Q(pk__in=matching_solicitud_ids)
            )

        return self._serialize_solicitud_table_rows(queryset, perspective="salida")

    def _resolve_tipo_param(self):
        raw = (self.request.query_params.get("tipo") or "").strip().lower()
        if raw in {"salida", "salidas", "sal"}:
            return "salida"
        if raw in {"entrada", "entradas", "ent"}:
            return "entrada"
        return ""

    def _apply_subtipo_filter(self, queryset):
        subtipo = (self.request.query_params.get("subtipo") or "").strip().lower()
        subtype_tokens = {
            "venta": "vent",
            "devolucion": "devol",
            "traslado": "trasl",
            "compra_local": "compra",
            "importacion": "import",
        }
        token = subtype_tokens.get(subtipo)
        if not token:
            return queryset
        return queryset.filter(sub_tipo_movimiento__nombre__icontains=token)

    def _resolve_funcional_value(self, raw_value):
        normalized = str(raw_value or "").strip().lower()
        if not normalized:
            return None
        if normalized in {"si", "sí", "true", "1"}:
            return True
        if normalized in {"no", "false", "0"}:
            return False
        return None

    def _apply_funcional_filter(self, queryset, funcional_filter):
        constraints = funcional_filter.get("constraints")
        if not isinstance(constraints, list):
            return queryset

        operator = str(funcional_filter.get("operator") or "AND").upper()
        query = None
        for constraint in constraints:
            if not isinstance(constraint, dict):
                continue
            value = self._resolve_funcional_value(constraint.get("value"))
            if value is None:
                continue
            partial = Q(funcional=value)
            if query is None:
                query = partial
            elif operator == "OR":
                query |= partial
            else:
                query &= partial

        if query is None:
            return queryset
        return queryset.filter(query)

    def _resolve_tipo_movimiento_ids(self, prefix):
        cache = getattr(self, "_tipo_movimiento_ids_cache", None)
        if cache is None:
            cache = {}
            self._tipo_movimiento_ids_cache = cache
        if prefix not in cache:
            cache[prefix] = list(
                TipoMovimiento.objects.filter(nombre__istartswith=prefix).values_list("id", flat=True)
            )
        return cache[prefix]

    def get_queryset(self):
        # total_monto se calcula con una subconsulta correlacionada (no con
        # un Sum() por JOIN) a proposito: combinar select_related (que ya
        # trae sucursal/tipo/subtipo/estado/casa_comercial por JOIN) con un
        # Sum() sobre detalles obliga a Postgres a agrupar por TODAS esas
        # columnas juntas -- con miles de movimientos eso vuelve un simple
        # "traeme los ultimos 25" en un join+GROUP BY sobre toda la tabla
        # (decenas de segundos). La subconsulta evita el JOIN/GROUP BY por
        # completo: se resuelve solo para las filas que finalmente se piden.
        detalle_totals = DetalleMovimiento.objects.filter(
            movimiento_inventario_id=OuterRef("pk")
        ).values("movimiento_inventario_id").annotate(
            total=Sum("valor_total")
        ).values("total")

        queryset = super().get_queryset().annotate(
            total_monto=Coalesce(
                Subquery(detalle_totals, output_field=DecimalField(max_digits=14, decimal_places=2)),
                Value(0, output_field=DecimalField(max_digits=14, decimal_places=2)),
            )
        ).exclude(estado_garantia=MovimientoInventario.EstadoGarantia.ELIMINADA)
        params = self.request.query_params

        tipo_param = self._resolve_tipo_param()
        if tipo_param in {"salida", "entrada"}:
            # Filtrar por tipo_movimiento_id directo (en vez de un JOIN via
            # tipo_movimiento__nombre__istartswith) para que el planificador
            # de Postgres pueda usar mov_tipo_fecha_id_idx y resolver
            # "traeme la pagina pedida" con un index scan acotado, en vez de
            # traer y ordenar la tabla entera -- con un JOIN dinamico el
            # planificador no logra estimar bien cuantas filas van a
            # calzar y descarta ese indice. La tabla TipoMovimiento tiene
            # solo un puñado de filas, asi que resolver esto aparte es
            # practicamente gratis.
            prefix = "sal" if tipo_param == "salida" else "ent"
            queryset = queryset.filter(tipo_movimiento_id__in=self._resolve_tipo_movimiento_ids(prefix))

        queryset = self._apply_subtipo_filter(queryset)

        no_documento = (params.get("no_documento") or "").strip()
        if no_documento:
            queryset = queryset.filter(no_documento__icontains=no_documento)

        factura_referencia = (params.get("factura_referencia") or "").strip()
        if factura_referencia:
            queryset = queryset.filter(factura_referencia__icontains=factura_referencia)

        fecha_desde = parse_date((params.get("fecha_desde") or "").strip())
        if fecha_desde:
            queryset = queryset.filter(fecha__gte=fecha_desde)

        fecha_hasta = parse_date((params.get("fecha_hasta") or "").strip())
        if fecha_hasta:
            queryset = queryset.filter(fecha__lte=fecha_hasta)

        sucursal_id_raw = (params.get("sucursal_id") or "").strip()
        if sucursal_id_raw:
            if sucursal_id_raw.isdigit():
                queryset = queryset.filter(sucursal_id=int(sucursal_id_raw))
            else:
                queryset = queryset.none()

        sucursal = (params.get("sucursal") or "").strip()
        if sucursal:
            queryset = queryset.filter(sucursal__nombre__icontains=sucursal)

        sub_tipo = (params.get("sub_tipo") or "").strip()
        if sub_tipo:
            queryset = queryset.filter(sub_tipo_movimiento__nombre__icontains=sub_tipo)

        estado = (params.get("estado") or "").strip()
        if estado:
            queryset = queryset.filter(estado_movimiento__nombre__icontains=estado)

        sucursal_objetivo = (params.get("sucursal_objetivo") or "").strip()
        if sucursal_objetivo:
            queryset = queryset.filter(
                sucursal_objetivo__nombre__icontains=sucursal_objetivo
            )

        search_term = (params.get("search") or "").strip()
        if search_term:
            normalized_search = search_term.lower()
            # Tambien por referencia(s) y OEM de los productos del movimiento.
            matching_movement_ids = DetalleMovimiento.objects.filter(
                Q(producto__codigo__icontains=search_term)
                | Q(producto__nombre__icontains=search_term)
                | Q(producto_id__in=matching_product_ids(search_term))
            ).values_list("movimiento_inventario_id", flat=True)
            search_query = (
                Q(no_documento__icontains=search_term)
                | Q(factura_referencia__icontains=search_term)
                | Q(sucursal__nombre__icontains=search_term)
                | Q(sucursal_objetivo__nombre__icontains=search_term)
                | Q(sub_tipo_movimiento__nombre__icontains=search_term)
                | Q(estado_movimiento__nombre__icontains=search_term)
                | Q(pk__in=matching_movement_ids)
            )
            if normalized_search in {"traslado", "traslados", "trasl"}:
                search_query |= Q(sub_tipo_movimiento__nombre__icontains="trasl")
            queryset = queryset.filter(search_query)

        producto_codigo = (params.get("producto_codigo") or "").strip()
        if producto_codigo:
            matching_movement_ids = DetalleMovimiento.objects.filter(
                producto__codigo__icontains=producto_codigo
            ).values_list("movimiento_inventario_id", flat=True)
            queryset = queryset.filter(pk__in=matching_movement_ids)

        total_min = (params.get("total_min") or "").strip()
        if total_min:
            try:
                queryset = queryset.filter(total_monto__gte=Decimal(total_min))
            except (InvalidOperation, ValueError):
                pass

        total_max = (params.get("total_max") or "").strip()
        if total_max:
            try:
                queryset = queryset.filter(total_monto__lte=Decimal(total_max))
            except (InvalidOperation, ValueError):
                pass

        cliente_texto = (params.get("cliente_texto") or "").strip()
        if cliente_texto:
            queryset = queryset.filter(
                Q(descripcion__iregex=r"(?i)^cliente:") & Q(descripcion__icontains=cliente_texto)
            )

        funcional = self._resolve_funcional_value(params.get("funcional"))
        if funcional is True:
            queryset = queryset.filter(funcional=True)
        elif funcional is False:
            queryset = queryset.filter(funcional=False)

        column_filters = parse_column_filters(self.request.query_params.get("column_filters"))
        funcional_filter = column_filters.pop("funcional_label", None)
        if funcional_filter:
            queryset = self._apply_funcional_filter(queryset, funcional_filter)

        queryset = apply_column_filters(
            queryset,
            column_filters,
            {
                "no_documento": "no_documento",
                "factura_referencia": "factura_referencia",
                "fecha": {"lookup": "fecha", "type": "date"},
                "sucursal_nombre": "sucursal__nombre",
                "sub_tipo_nombre": "sub_tipo_movimiento__nombre",
                "estado_nombre": "estado_movimiento__nombre",
                "sucursal_objetivo_nombre": "sucursal_objetivo__nombre",
                "total": {"lookup": "total_monto", "type": "number"},
            },
        )

        if is_app_admin(self.request.user):
            return queryset

        permission_checker = MovimientoInventarioModulePermission()
        permission_index = permission_checker._get_permission_index(self.request)
        action_key = permission_checker.METHOD_TO_ACTION.get(
            self.request.method, "puede_leer"
        )

        module_filters = []
        for module_key, prefix in (
            (RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS, "ent"),
            (RolPermiso.Modulos.MOVIMIENTOS_SALIDAS, "sal"),
        ):
            has_action_permission = bool(
                permission_index.get(module_key, {}).get(action_key)
            )
            if not has_action_permission:
                continue

            if action_key == "puede_leer":
                allowed = get_readable_sucursal_ids(self.request.user, module_key)
            else:
                allowed = get_allowed_sucursal_ids(
                    self.request.user,
                    module_key,
                    action_key=action_key,
                )
            branch_filter = Q()
            if allowed is not None:
                if not allowed:
                    continue
                branch_filter = Q(sucursal_id__in=allowed) | Q(
                    sucursal_objetivo_id__in=allowed
                )

            module_filters.append(
                Q(tipo_movimiento_id__in=self._resolve_tipo_movimiento_ids(prefix)) & branch_filter
            )

        if not module_filters:
            return queryset.none()

        combined = module_filters.pop()
        for extra_filter in module_filters:
            combined |= extra_filter
        return queryset.filter(combined)

    # Traduce cada token de _resolve_tabla_ordering_tokens() a un campo real
    # del modelo, para poder ordenar en la base de datos en vez de traer
    # todo y ordenar en Python. "_sort_created_at" no es un campo real -- en
    # un movimiento normal (a diferencia de una solicitud) equivale a fecha.
    _TABLA_ORDER_FIELD_MAP = {
        "_sort_estado_priority": "estado_priority_sort_key",
        "_sort_created_at": "fecha",
        "id": "id",
        "no_documento": "no_documento_sort_key",
        "factura_referencia": "factura_referencia",
        "fecha": "fecha",
        "sucursal__nombre": "sucursal__nombre",
        "sub_tipo_movimiento__nombre": "sub_tipo_movimiento__nombre",
        "estado_movimiento__nombre": "estado_movimiento__nombre",
        "sucursal_objetivo__nombre": "sucursal_objetivo__nombre",
        "funcional": "funcional",
        "total_monto": "total_monto",
    }

    # no_documento es texto ("CL-9OCT-...-10", "...-2") -- ordenado como
    # texto plano, "-10" cae justo despues de "-1" (antes de "-2".."-9"),
    # porque compara caracter por caracter. Esto separa el prefijo del
    # numero final y rellena el numero con ceros a la izquierda para que
    # la comparacion de texto de el mismo resultado que una comparacion
    # numerica real.
    _NO_DOCUMENTO_SORT_KEY_SQL = r"""
        regexp_replace(no_documento, '\d+$', '')
        || lpad(
            coalesce(
                nullif(regexp_replace(no_documento, '^.*?(\d+)$', '\1'), no_documento),
                '0'
            ),
            12, '0'
        )
    """

    def _annotate_no_documento_sort_key(self, queryset):
        return queryset.annotate(
            no_documento_sort_key=RawSQL(self._NO_DOCUMENTO_SORT_KEY_SQL, ())
        )

    # Mismo criterio que _resolve_estado_priority(), pero calculado en la
    # base de datos para poder ordenar/recortar la ventana de paginacion sin
    # traer toda la tabla. Guardado y Pendiente son estados de solicitudes de
    # traslado (no existen como estado_movimiento real), asi que en la
    # practica esto solo distingue "Enviado" (2) del resto (3) -- los grupos
    # 0 y 1 los aportan las solicitudes, que se combinan aparte en Python.
    def _annotate_estado_priority_sort_key(self, queryset):
        return queryset.annotate(
            estado_priority_sort_key=Case(
                When(estado_movimiento__nombre__icontains="guardado", then=Value(0)),
                When(estado_movimiento__nombre__icontains="pend", then=Value(1)),
                When(estado_movimiento__nombre__icontains="envi", then=Value(2)),
                default=Value(3),
                output_field=IntegerField(),
            )
        )

    def _resolve_tabla_db_order_by(self):
        order_by_fields = []
        for token in self._resolve_tabla_ordering_tokens():
            descending = token.startswith("-")
            key = token[1:] if descending else token
            field = self._TABLA_ORDER_FIELD_MAP.get(key)
            if not field:
                continue
            order_by_fields.append(f"-{field}" if descending else field)
        if not order_by_fields:
            order_by_fields = ["-fecha"]
        # Desempate estable: sin esto, filas con el mismo valor de orden
        # pueden repetirse o saltarse al pasar de una pagina a otra.
        order_by_fields.append("-id")
        return order_by_fields

    def _resolve_tabla_pagination_window(self):
        try:
            page_size = int(self.request.query_params.get("page_size") or 20)
        except (TypeError, ValueError):
            page_size = 20
        page_size = max(1, min(page_size, 2000))

        try:
            page_number = int(self.request.query_params.get("page") or 1)
        except (TypeError, ValueError):
            page_number = 1
        page_number = max(1, page_number)

        offset = (page_number - 1) * page_size
        return offset, page_size

    @action(detail=False, methods=["get"], url_path="tabla")
    def tabla(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())

        tipo_param = self._resolve_tipo_param()
        if tipo_param not in {"entrada", "salida"}:
            page = self.paginate_queryset(queryset)
            if page is not None:
                serialized = self._serialize_table_rows(page)
                return self.get_paginated_response(
                    self._strip_internal_table_fields(serialized)
                )

            serialized = self._serialize_table_rows(queryset)
            return Response(self._strip_internal_table_fields(serialized))

        # Esta tabla combina movimientos reales (pueden ser decenas de
        # miles) con solicitudes de traslado pendientes/guardadas (un
        # puñado). Antes se traian y serializaban TODOS los movimientos
        # -- con sus detalles, sucursales, etc. -- y recien al final se
        # ordenaba en Python y se cortaba la pagina pedida; con una tabla
        # grande eso tardaba decenas de segundos. Ahora se ordena en la
        # base de datos y solo se trae lo que alcanza para cubrir la
        # pagina pedida (offset + page_size), mas un margen por la
        # cantidad de solicitudes que se van a intercalar -- eso siempre
        # alcanza porque las solicitudes nunca desplazan mas posiciones
        # que su propia cantidad.
        serialized_solicitudes = (
            self._get_solicitudes_for_entrada_table()
            if tipo_param == "entrada"
            else self._get_solicitudes_for_salida_table()
        )
        offset, page_size = self._resolve_tabla_pagination_window()
        needed_count = offset + page_size + len(serialized_solicitudes)
        ordering_tokens = self._resolve_tabla_ordering_tokens()
        if any(token.lstrip("-") == "no_documento" for token in ordering_tokens):
            queryset = self._annotate_no_documento_sort_key(queryset)
        if any(token.lstrip("-") == "_sort_estado_priority" for token in ordering_tokens):
            queryset = self._annotate_estado_priority_sort_key(queryset)
        bounded_queryset = queryset.order_by(*self._resolve_tabla_db_order_by())[:needed_count]
        serialized_movimientos = self._serialize_table_rows(bounded_queryset)

        combined_rows = self._sort_table_payload(
            [*serialized_movimientos, *serialized_solicitudes]
        )

        # No se usa self.paginate_queryset()/get_paginated_response() aqui:
        # combined_rows solo contiene la ventana acotada (needed_count), no
        # la tabla completa, asi que el paginador de DRF reportaria un
        # "count" (total de resultados) incorrecto si contara sobre esta
        # lista recortada. El total real se calcula aparte con un COUNT en
        # la base de datos (barato, no trae filas) mas las solicitudes.
        total_count = queryset.count() + len(serialized_solicitudes)
        page_slice = combined_rows[offset:offset + page_size]
        return Response(
            {
                "count": total_count,
                "next": None,
                "previous": None,
                "results": self._strip_internal_table_fields(page_slice),
            }
        )

    def _resolve_target_modules(self):
        permission_checker = MovimientoInventarioModulePermission()
        return permission_checker.get_target_module_keys(self.request, self)

    def _is_traslado_movement(self, serializer):
        sub_tipo = serializer.validated_data.get("sub_tipo_movimiento")
        nombre = str(getattr(sub_tipo, "nombre", "") or "").strip().lower()
        return "trasl" in nombre

    def _is_garantia_salida_from_validated(self, serializer):
        sub_tipo = serializer.validated_data.get("sub_tipo_movimiento")
        tipo = serializer.validated_data.get("tipo_movimiento")
        sub_nombre = str(getattr(sub_tipo, "nombre", "") or "").strip().lower()
        tipo_nombre = str(getattr(tipo, "nombre", "") or "").strip().lower()
        return tipo_nombre.startswith("sal") and "devol" in sub_nombre

    def _is_sale_movement(self, movement):
        tipo_nombre = str(getattr(movement.tipo_movimiento, "nombre", "") or "").strip().lower()
        subtipo_nombre = str(getattr(movement.sub_tipo_movimiento, "nombre", "") or "").strip().lower()
        return tipo_nombre.startswith("sal") and "vent" in subtipo_nombre

    def _auto_reject_pending_transfers_due_to_sale(self, movement):
        if not self._is_sale_movement(movement):
            return False

        branch_id = getattr(movement, "sucursal_id", None)
        if not branch_id:
            return False

        detalles = list(movement.detalles.select_related("producto").all())
        product_ids = {
            int(getattr(detail.producto, "id", getattr(detail, "producto_id", None)) or 0)
            for detail in detalles
        }
        product_ids = {pid for pid in product_ids if pid > 0}
        if not product_ids:
            return False

        reference = str(getattr(movement, "no_documento", "") or "").strip() or None
        extra_reason = build_sale_stock_change_extra_reason(reference)

        return cancel_pending_transfer_requests(
            branch_id=branch_id,
            product_ids=product_ids,
            actor_user=self.request.user,
            extra_reason=extra_reason,
        )

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        headers = self.get_success_headers(serializer.data)
        response_data = dict(serializer.data)
        if serializer.context.get(REMINDERS_SYNC_FLAG):
            response_data[REMINDERS_SYNC_FLAG] = True
        return Response(response_data, status=status.HTTP_201_CREATED, headers=headers)

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop("partial", False)
        instance = self.get_object()
        if instance.es_legado:
            return Response(
                {"detail": "Este registro fue migrado del sistema anterior y no se puede editar."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if self._is_importacion_movement(instance):
            return Response(
                {"detail": "Este movimiento es de una importacion y se actualiza solo al recibirla; no se puede editar."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = self.get_serializer(instance, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        self.perform_update(serializer)
        if getattr(instance, "_prefetched_objects_cache", None):
            instance._prefetched_objects_cache = {}
        response_data = dict(serializer.data)
        if serializer.context.get(REMINDERS_SYNC_FLAG):
            response_data[REMINDERS_SYNC_FLAG] = True
        return Response(response_data)

    @staticmethod
    def _is_importacion_movement(instance):
        from importaciones.models import Importacion, ImportacionEnvio

        return (
            Importacion.objects.filter(movimiento_entrada=instance).exists()
            or ImportacionEnvio.objects.filter(
                Q(movimiento_salida=instance) | Q(movimiento_entrada=instance)
            ).exists()
        )

    def perform_create(self, serializer):
        module_keys = self._resolve_target_modules()
        sucursal = serializer.validated_data.get("sucursal")
        sucursal_objetivo = serializer.validated_data.get("sucursal_objetivo")
        solicitud_traslado = serializer.validated_data.get("solicitud_traslado")
        skip_target_scope_validation = bool(
            (solicitud_traslado is not None and self._is_traslado_movement(serializer))
            or RolPermiso.Modulos.MOVIMIENTOS_SALIDAS in module_keys
        )

        ensure_sucursal_allowed_for_modules(
            self.request.user,
            module_keys,
            getattr(sucursal, "id", None),
            field_label="sucursal",
            action_key="puede_crear",
        )
        if not skip_target_scope_validation:
            ensure_sucursal_allowed_for_modules(
                self.request.user,
                module_keys,
                getattr(sucursal_objetivo, "id", None),
                field_label="sucursal objetivo",
                action_key="puede_crear",
            )
        is_garantia_for_approval = (
            not is_app_admin(self.request.user)
            and self._is_garantia_salida_from_validated(serializer)
        )
        if is_garantia_for_approval:
            serializer.validated_data["garantia_pendiente"] = True
            serializer.validated_data["estado_garantia"] = MovimientoInventario.EstadoGarantia.SOLICITADA

        movement = serializer.save(creado_por=self.request.user)
        reminder_added = False
        if solicitud_traslado:
            reminder_added = self._append_transfer_shipment_reminder(
                solicitud=solicitud_traslado,
                actor_user=self.request.user,
            )
        elif self._is_traslado_movement(serializer):
            raw_ids = self.request.data.get("recipients_ids", [])
            recipient_ids = [i for i in (raw_ids if isinstance(raw_ids, list) else []) if i]
            direct_transfer_solicitud = getattr(movement, "_direct_transfer_solicitud", None)
            if recipient_ids and direct_transfer_solicitud is not None:
                reminder_added = self._append_direct_transfer_shipment_reminder(
                    movement=movement,
                    solicitud_id=direct_transfer_solicitud.id,
                    actor_user=self.request.user,
                    recipient_ids=recipient_ids,
                )
        elif movement.garantia_pendiente:
            reminder_added = self._append_garantia_approval_reminder(
                movement=movement,
                actor_user=self.request.user,
            )
        if reminder_added:
            serializer.context[REMINDERS_SYNC_FLAG] = True
        self._auto_reject_pending_transfers_due_to_sale(movement)

    def perform_update(self, serializer):
        module_keys = self._resolve_target_modules()
        sucursal = serializer.validated_data.get("sucursal", serializer.instance.sucursal)
        sucursal_objetivo = serializer.validated_data.get(
            "sucursal_objetivo",
            serializer.instance.sucursal_objetivo,
        )

        ensure_sucursal_allowed_for_modules(
            self.request.user,
            module_keys,
            getattr(sucursal, "id", None),
            field_label="sucursal",
            action_key="puede_actualizar",
        )
        ensure_sucursal_allowed_for_modules(
            self.request.user,
            module_keys,
            getattr(sucursal_objetivo, "id", None),
            field_label="sucursal objetivo",
            action_key="puede_actualizar",
            )
        serializer.save()

    @staticmethod
    def _extract_validation_message(detail):
        if isinstance(detail, dict):
            for value in detail.values():
                message = MovimientoInventarioViewSet._extract_validation_message(value)
                if message:
                    return message
            return ""
        if isinstance(detail, (list, tuple)):
            for item in detail:
                message = MovimientoInventarioViewSet._extract_validation_message(item)
                if message:
                    return message
            return ""
        return str(detail or "").strip()

    @action(detail=True, methods=["post"], url_path="previsualizar-ajuste")
    def previsualizar_ajuste(self, request, pk=None):
        """Que pasara con el inventario al guardar las cantidades editadas de una entrada.

        Body: {detalles: [{producto_id, cantidad}], ajustes_ubicacion: [{producto_id, subdivision_id}]}.
        No guarda nada: devuelve por producto cuanto se suma o resta, de donde y si se puede.
        """
        from productos.models import Producto

        from .entry_adjustment import plan_adjustment, quantities_by_product
        from .serializers import MovimientoInventarioSerializer

        instance = self.get_object()
        helper = MovimientoInventarioSerializer(context=self.get_serializer_context())
        if instance.es_legado or instance.garantia_pendiente or not helper._entry_adds_stock(instance):
            return Response({"aplica": False, "cambios": []}, status=status.HTTP_200_OK)
        raw_details = request.data.get("detalles") or []
        after = quantities_by_product([d for d in raw_details if isinstance(d, dict)])
        before = quantities_by_product(instance.detalles.all())
        products = {
            p.id: (p.codigo, p.nombre)
            for p in Producto.objects.filter(id__in=set(before) | set(after)).only("id", "codigo", "nombre")
        }
        plan = plan_adjustment(
            sucursal=instance.sucursal,
            before=before,
            after=after,
            overrides=helper.parse_location_overrides(request.data.get("ajustes_ubicacion")),
            products=products,
        )
        # Para elegir donde guardar lo que se suma: todas las ubicaciones de la sucursal.
        ubicaciones_sucursal = []
        if any(item["delta"] > 0 for item in plan):
            from inventario.models import SubDivision

            from .entry_adjustment import location_label

            ubicaciones_sucursal = sorted(
                (
                    {"subdivision_id": sub.id, "label": location_label(sub)}
                    for sub in SubDivision.objects.select_related("division__bodega").filter(
                        division__bodega__sucursal_id=instance.sucursal_id
                    )
                ),
                key=lambda loc: loc["label"],
            )
        return Response(
            {
                "aplica": True,
                "sucursal": str(instance.sucursal),
                "cambios": plan,
                "ubicaciones_sucursal": ubicaciones_sucursal,
            },
            status=status.HTTP_200_OK,
        )

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.es_legado:
            return Response(
                {"detail": "Este registro fue migrado del sistema anterior y no se puede eliminar."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if self._is_importacion_movement(instance):
            return Response(
                {"detail": "Este movimiento es de una importacion, asi que no se puede eliminar."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if instance.envios_compra.exists() or instance.traslados_compra.exists():
            return Response(
                {
                    "detail": (
                        "Esta compra local ya se envio a otras sucursales, asi que no se puede eliminar. "
                        "Si hubo un error, corrigelo con un ajuste de inventario en cada sucursal."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        inventory_action = str(
            request.query_params.get("inventory_action") or "keep"
        ).strip().lower()

        if inventory_action not in {"keep", "reverse"}:
            return Response(
                {"detail": "El parametro inventory_action debe ser keep o reverse."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        tipo_nombre = self._normalize_state_name(
            getattr(getattr(instance, "tipo_movimiento", None), "nombre", "")
        )
        is_entrada = tipo_nombre.startswith("ent")
        is_salida = tipo_nombre.startswith("sal")
        if inventory_action == "reverse" and not (is_entrada or is_salida):
            return Response(
                {
                    "detail": (
                        "Solo se puede revertir inventario al eliminar movimientos de entrada o salida."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            with transaction.atomic():
                if inventory_action == "reverse":
                    serializer = self.get_serializer(instance)
                    details_source = list(
                        instance.detalles.select_related("producto").all()
                    )
                    serializer._apply_inventory_effect(
                        instance,
                        details_source,
                        reverse=True,
                    )

                self.perform_destroy(instance)
        except drf_serializers.ValidationError as exc:
            message = self._extract_validation_message(getattr(exc, "detail", exc))
            return Response(
                {
                    "detail": (
                        message
                        or "No se pudo ajustar el inventario al eliminar el movimiento."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        except ProtectedError:
            return Response(
                {
                    "detail": (
                        "No se puede eliminar el movimiento porque tiene registros "
                        "relacionados protegidos."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(status=status.HTTP_204_NO_CONTENT)

    def _get_solicitud_traslado(self, solicitud_id):
        return (
            SolicitudTraslado.objects.select_related(
                "sucursal_solicitante",
                "sucursal_proveedora",
                "movimiento_salida",
                "movimiento_entrada",
                "rechazada_por",
            )
            .prefetch_related("detalles__producto")
            .filter(pk=solicitud_id)
            .first()
        )

    @staticmethod
    def _normalize_state_name(value):
        return str(value or "").strip().lower()

    def _resolve_estado_movimiento(self, *candidates):
        queryset = MovimientoInventario._meta.get_field("estado_movimiento").remote_field.model.objects.all()
        for candidate in candidates:
            token = self._normalize_state_name(candidate)
            if not token:
                continue
            match = queryset.filter(nombre__icontains=token).order_by("id").first()
            if match is not None:
                return match
        return queryset.order_by("id").first()

    @staticmethod
    def _resolve_user_display(user):
        if user is None:
            return ""
        full_name = str(getattr(user, "get_full_name", lambda: "")() or "").strip()
        if full_name:
            return full_name
        return str(getattr(user, "email", "") or "").strip()

    @staticmethod
    def _normalize_reminder_recipient(user):
        if user is None:
            return None
        if isinstance(user, dict):
            user_id = str(
                user.get("id")
                or user.get("usuario_id")
                or user.get("user_id")
                or ""
            ).strip()
            if not user_id:
                return None
            name = str(
                user.get("name")
                or user.get("nombre")
                or user.get("label")
                or ""
            ).strip()
            email = str(user.get("email") or "").strip()
            return {
                "id": user_id,
                "name": name or email or f"Usuario {user_id}",
            }

        user_id = str(getattr(user, "id", "") or "").strip()
        if not user_id:
            return None
        full_name = str(getattr(user, "get_full_name", lambda: "")() or "").strip()
        email = str(getattr(user, "email", "") or "").strip()
        name = full_name or email or f"Usuario {user_id}"
        return {
            "id": user_id,
            "name": name,
        }

    def _resolve_transfer_provider_recipients(
        self,
        sucursal_proveedora_id,
        *,
        exclude_user_ids=None,
    ):
        provider_branch_id = int(sucursal_proveedora_id or 0)
        if provider_branch_id <= 0:
            return []

        excluded = {str(user_id).strip() for user_id in (exclude_user_ids or []) if str(user_id).strip()}

        scoped_user_ids = set(
            UsuarioModuloSucursal.objects.filter(
                modulo=RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
                sucursal_id=provider_branch_id,
            ).values_list("usuario_id", flat=True)
        )
        assigned_user_ids = set(
            UsuarioSucursal.objects.filter(
                sucursal_id=provider_branch_id,
            ).values_list("usuario_id", flat=True)
        )

        User = get_user_model()
        candidate_users = User.objects.filter(
            is_active=True,
            id__in=sorted(scoped_user_ids | assigned_user_ids),
        ).exclude(
            Q(preferencia_operativa__es_administrador=True) | Q(is_superuser=True)
        ).order_by("id")

        recipients = []
        seen_recipient_ids = set()
        for candidate in candidate_users:
            recipient = self._normalize_reminder_recipient(candidate)
            recipient_id = str(recipient.get("id") if recipient else "").strip()
            if not recipient_id or recipient_id in excluded:
                continue
            if recipient_id in seen_recipient_ids:
                continue

            seen_recipient_ids.add(recipient_id)
            recipients.append(recipient)

        return recipients

    def _resolve_transfer_requester_recipients(
        self,
        sucursal_solicitante_id,
        *,
        exclude_user_ids=None,
    ):
        """Users at the requesting branch (MOVIMIENTOS_ENTRADAS) — the ones waiting to receive."""
        requester_branch_id = int(sucursal_solicitante_id or 0)
        if requester_branch_id <= 0:
            return []

        excluded = {str(uid).strip() for uid in (exclude_user_ids or []) if str(uid).strip()}

        scoped_user_ids = set(
            UsuarioModuloSucursal.objects.filter(
                modulo=RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
                sucursal_id=requester_branch_id,
            ).values_list("usuario_id", flat=True)
        )
        assigned_user_ids = set(
            UsuarioSucursal.objects.filter(
                sucursal_id=requester_branch_id,
            ).values_list("usuario_id", flat=True)
        )

        User = get_user_model()
        candidate_users = User.objects.filter(is_active=True).filter(
            Q(preferencia_operativa__es_administrador=True)
            | Q(is_superuser=True)
            | Q(id__in=sorted(scoped_user_ids | assigned_user_ids))
        ).order_by("id")

        recipients = []
        seen_recipient_ids = set()
        for candidate in candidate_users:
            recipient = self._normalize_reminder_recipient(candidate)
            recipient_id = str(recipient.get("id") if recipient else "").strip()
            if not recipient_id or recipient_id in excluded or recipient_id in seen_recipient_ids:
                continue
            seen_recipient_ids.add(recipient_id)
            recipients.append(recipient)

        return recipients

    def _resolve_transfer_request_admin_recipients(
        self,
        *,
        exclude_user_ids=None,
    ):
        excluded = {str(user_id).strip() for user_id in (exclude_user_ids or []) if str(user_id).strip()}
        User = get_user_model()
        recipients = []
        seen_recipient_ids = set()

        for candidate in User.objects.filter(is_active=True).filter(
            Q(preferencia_operativa__es_administrador=True) | Q(is_superuser=True)
        ).order_by("id"):
            recipient = self._normalize_reminder_recipient(candidate)
            recipient_id = str(recipient.get("id") if recipient else "").strip()
            if not recipient_id or recipient_id in excluded or recipient_id in seen_recipient_ids:
                continue
            seen_recipient_ids.add(recipient_id)
            recipients.append(recipient)

        return recipients

    def _resolve_transfer_selected_recipients(
        self,
        sucursal_proveedora_id,
        selected_user_ids,
        *,
        exclude_user_ids=None,
    ):
        selected_ids = {
            str(user_id).strip()
            for user_id in (selected_user_ids or [])
            if str(user_id).strip()
        }
        if not selected_ids:
            return []

        recipients = []
        seen_recipient_ids = set()
        for candidate in self._resolve_transfer_provider_recipients(
            sucursal_proveedora_id,
            exclude_user_ids=exclude_user_ids,
        ):
            recipient = self._normalize_reminder_recipient(candidate)
            recipient_id = str(recipient.get("id") if recipient else "").strip()
            if not recipient_id or recipient_id not in selected_ids or recipient_id in seen_recipient_ids:
                continue
            seen_recipient_ids.add(recipient_id)
            recipients.append(recipient)

        return recipients

    def _resolve_transfer_context_recipients_from_payload(
        self,
        payload,
        *,
        solicitud_id,
        exclude_user_ids=None,
    ):
        solicitud_token = str(solicitud_id or "").strip()
        if not solicitud_token:
            return []

        excluded = {str(user_id).strip() for user_id in (exclude_user_ids or []) if str(user_id).strip()}
        recipients = []
        seen_recipient_ids = set()

        def append_unique(candidate):
            normalized = self._normalize_reminder_recipient(candidate)
            if normalized is None:
                return
            recipient_id = str(normalized.get("id") or "").strip()
            if not recipient_id or recipient_id in excluded:
                return
            if recipient_id in seen_recipient_ids:
                return
            seen_recipient_ids.add(recipient_id)
            recipients.append(normalized)

        for reminder in payload if isinstance(payload, list) else []:
            context = reminder.get("context") if isinstance(reminder, dict) else None
            if not isinstance(context, dict):
                continue
            context_type = (
                str(context.get("type") or "")
                .strip()
                .lower()
                .replace(" ", "_")
                .replace("-", "_")
            )
            context_id = str(context.get("id") or "").strip()
            if context_type != "solicitud_traslado" or context_id != solicitud_token:
                continue
            append_unique(reminder.get("creator") if isinstance(reminder, dict) else None)
            for candidate in (
                reminder.get("recipients", []) if isinstance(reminder, dict) else []
            ):
                append_unique(candidate)

        return recipients

    def _resolve_transfer_request_creator_from_payload(self, payload, *, solicitud_id):
        solicitud_token = str(int(solicitud_id or 0))
        if not solicitud_token:
            return None

        fallback_creator = None
        for reminder in payload if isinstance(payload, list) else []:
            if not isinstance(reminder, dict):
                continue
            context = reminder.get("context")
            if not isinstance(context, dict):
                continue
            context_type = self._normalize_reminder_context_type(context.get("type"))
            context_id = str(context.get("id") or "").strip()
            if context_type != "solicitud_traslado" or context_id != solicitud_token:
                continue

            creator = self._normalize_reminder_recipient(reminder.get("creator"))
            if creator is None:
                continue

            kind = str(reminder.get("kind") or "").strip().lower()
            if kind == "solicitud_traslado_decision":
                return creator

            decision = reminder.get("decision") if isinstance(reminder.get("decision"), dict) else {}
            decision_status = self._normalize_state_name(decision.get("status"))
            if fallback_creator is None or decision_status in {"", "pendiente"}:
                fallback_creator = creator

        return fallback_creator

    def _build_transfer_history_entry(self, *, stage, description, actor, at=None):
        timestamp = at or timezone.now().isoformat()
        return {
            "stage": str(stage or "").strip().lower(),
            "description": str(description or "").strip(),
            "at": timestamp,
            "actor": self._normalize_reminder_recipient(actor),
        }

    def _get_transfer_context_history_from_payload(self, normalized_payload, *, solicitud_id):
        solicitud_token = str(int(solicitud_id or 0))
        if not solicitud_token:
            return []

        merged_history = []
        for reminder in normalized_payload if isinstance(normalized_payload, list) else []:
            if not isinstance(reminder, dict):
                continue
            context = reminder.get("context") if isinstance(reminder.get("context"), dict) else {}
            context_type = self._normalize_reminder_context_type(context.get("type"))
            context_id = str(context.get("id") or "").strip()
            if context_type != "solicitud_traslado" or context_id != solicitud_token:
                continue
            merged_history = _merge_transfer_history(
                merged_history,
                reminder.get("transferHistory") or [],
            )

        return merged_history

    def _get_solicitud_transfer_history(self, solicitud, *, seed_history=None):
        persisted_history = getattr(solicitud, "historial_transfer", None)
        sanitized_persisted = (
            _sanitize_transfer_history(persisted_history) if isinstance(persisted_history, list) else []
        )
        sanitized_seed = (
            _sanitize_transfer_history(seed_history) if isinstance(seed_history, list) else []
        )
        return _merge_transfer_history(sanitized_seed, sanitized_persisted)

    def _save_solicitud_transfer_history(self, solicitud, history):
        sanitized_history = _sanitize_transfer_history(history)
        current_history = getattr(solicitud, "historial_transfer", None)
        sanitized_current = (
            _sanitize_transfer_history(current_history) if isinstance(current_history, list) else []
        )
        if isinstance(current_history, list) and sanitized_current == sanitized_history:
            return sanitized_history

        solicitud.historial_transfer = sanitized_history
        solicitud.save(update_fields=["historial_transfer", "updated_at"])
        return sanitized_history

    def _append_solicitud_transfer_history_event(
        self,
        *,
        solicitud,
        stage,
        description,
        actor,
        at=None,
        seed_history=None,
    ):
        history_entry = self._build_transfer_history_entry(
            stage=stage,
            description=description,
            actor=actor,
            at=at,
        )
        current_history = self._get_solicitud_transfer_history(
            solicitud,
            seed_history=seed_history,
        )
        merged_history = _merge_transfer_history(current_history, [history_entry])
        return self._save_solicitud_transfer_history(solicitud, merged_history)

    def _upsert_transfer_context_reminder(
        self,
        normalized_payload,
        *,
        solicitud_id,
        reminder,
        preserve_identity=True,
        preserve_created_at=True,
    ):
        solicitud_token = str(int(solicitud_id or 0))
        if not solicitud_token:
            return normalized_payload

        matches = []
        remainder = []
        for item in normalized_payload if isinstance(normalized_payload, list) else []:
            if not isinstance(item, dict):
                continue
            context = item.get("context") if isinstance(item.get("context"), dict) else {}
            context_type = self._normalize_reminder_context_type(context.get("type"))
            context_id = str(context.get("id") or "").strip()
            if context_type == "solicitud_traslado" and context_id == solicitud_token:
                matches.append(item)
            else:
                remainder.append(item)

        base = None
        if matches:
            base = sorted(
                matches,
                key=lambda row: str(row.get("createdAt") or "").strip() or "9999",
            )[0]

        merged = dict(base or {})
        for candidate in matches:
            merged = _merge_reminder(merged, candidate) or merged
        merged = _merge_reminder(merged, reminder) or reminder
        if preserve_identity and base and str(base.get("id") or "").strip():
            merged["id"] = str(base.get("id")).strip()
        if preserve_created_at and base and str(base.get("createdAt") or "").strip():
            merged["createdAt"] = str(base.get("createdAt")).strip()
        if base and isinstance(base.get("creator"), dict):
            merged["creator"] = base.get("creator")

        return [merged, *remainder]

    def _upsert_transfer_issue_context_reminder(
        self,
        normalized_payload,
        *,
        solicitud_id,
        reminder,
        preserve_identity=True,
        preserve_created_at=True,
        preserve_display_timestamp=True,
    ):
        solicitud_token = str(int(solicitud_id or 0))
        if not solicitud_token:
            return normalized_payload

        matches = []
        remainder = []
        for item in normalized_payload if isinstance(normalized_payload, list) else []:
            if not isinstance(item, dict):
                continue
            context = item.get("context") if isinstance(item.get("context"), dict) else {}
            context_type = self._normalize_reminder_context_type(context.get("type"))
            context_id = str(context.get("id") or "").strip()
            if (
                context_type == TRANSFER_ISSUE_REMINDER_CONTEXT_TYPE
                and context_id == solicitud_token
            ):
                matches.append(item)
            else:
                remainder.append(item)

        base = None
        if matches:
            base = sorted(
                matches,
                key=lambda row: str(row.get("createdAt") or "").strip() or "9999",
            )[0]

        merged = dict(base or {})
        for candidate in matches:
            merged = _merge_reminder(merged, candidate) or merged
        merged = _merge_reminder(merged, reminder) or reminder
        if preserve_identity and base and str(base.get("id") or "").strip():
            merged["id"] = str(base.get("id")).strip()
        if preserve_created_at and base and str(base.get("createdAt") or "").strip():
            merged["createdAt"] = str(base.get("createdAt")).strip()
        if base and isinstance(base.get("creator"), dict):
            merged["creator"] = base.get("creator")
        if preserve_display_timestamp and base:
            if str(base.get("date") or "").strip():
                merged["date"] = str(base.get("date")).strip()
            if str(base.get("time") or "").strip():
                merged["time"] = str(base.get("time")).strip()

        return [merged, *remainder]

    def _normalize_reminder_context_type(self, value):
        normalized = str(value or "").strip().lower()
        if not normalized:
            return ""
        return normalized.replace(" ", "_").replace("-", "_")

    def _get_transfer_decision_reminder_recipient_ids(self, solicitud_id):
        solicitud_token = str(solicitud_id or "").strip()
        if not solicitud_token:
            return set()
        store = ReminderState.get_global()
        payload = store.payload if isinstance(store.payload, list) else []
        recipients = set()
        for reminder in payload:
            if not isinstance(reminder, dict):
                continue
            context = reminder.get("context")
            if not isinstance(context, dict):
                continue
            context_type = self._normalize_reminder_context_type(context.get("type"))
            context_id = str(context.get("id") or "").strip()
            if context_type != "solicitud_traslado" or context_id != solicitud_token:
                continue
            kind = str(reminder.get("kind") or "").strip().lower()
            if kind != "solicitud_traslado_decision":
                continue
            decision = reminder.get("decision") if isinstance(reminder.get("decision"), dict) else {}
            decision_recipients = decision.get("assignedRecipients")
            recipients_source = (
                decision_recipients
                if isinstance(decision_recipients, list) and decision_recipients
                else reminder.get("recipients") or []
            )
            for recipient in recipients_source:
                if not isinstance(recipient, dict):
                    continue
                recipient_id = str(
                    recipient.get("id")
                    or recipient.get("usuario_id")
                    or recipient.get("user_id")
                    or ""
                ).strip()
                if not recipient_id:
                    continue
                recipients.add(recipient_id)
        return recipients

    def _append_transfer_request_reminder(
        self,
        *,
        solicitud,
        actor_user,
        selected_user_ids=None,
    ):
        if solicitud is None:
            return False

        solicitud_id = int(getattr(solicitud, "id", 0) or 0)
        if solicitud_id <= 0:
            return False

        transfer_doc = str(getattr(solicitud, "no_documento", "") or "").strip()
        transfer_reference = f"#{transfer_doc}" if transfer_doc else f"#{solicitud_id}"
        context_label = f"Solicitud de traslado {transfer_reference}"
        actor_recipient = self._normalize_reminder_recipient(actor_user) or {
            "id": "system",
            "name": "Sistema",
        }
        admin_recipients = self._resolve_transfer_request_admin_recipients()
        # El recordatorio le debe llegar a todos los usuarios elegibles de la
        # sucursal proveedora (todo el listado de opciones del checkbox), no
        # solo a los que el creador marco -- eso es lo que decide quien ve la
        # bola urgente creciendo (assignedRecipients), no quien se entera.
        all_provider_recipients = self._resolve_transfer_provider_recipients(
            solicitud.sucursal_proveedora_id,
        )
        selected_recipients = self._resolve_transfer_selected_recipients(
            solicitud.sucursal_proveedora_id,
            selected_user_ids,
        )

        recipients = []
        seen_recipient_ids = set()

        def append_unique(candidate):
            normalized_candidate = self._normalize_reminder_recipient(candidate)
            if normalized_candidate is None:
                return
            candidate_id = str(normalized_candidate.get("id") or "").strip()
            if not candidate_id or candidate_id in seen_recipient_ids:
                return
            seen_recipient_ids.add(candidate_id)
            recipients.append(normalized_candidate)

        for candidate in admin_recipients:
            append_unique(candidate)
        for candidate in all_provider_recipients:
            append_unique(candidate)
        append_unique(actor_recipient)

        now = timezone.localtime(timezone.now())
        created_at = timezone.now().isoformat()
        deadline_at = now.replace(hour=23, minute=59, second=59, microsecond=999000)
        description = (
            f"Solicitud de traslado {transfer_reference}. Revisar gestion pendiente. "
            "Usuarios asignados deben aceptar o rechazar hoy."
            if selected_recipients
            else f"Solicitud de traslado {transfer_reference}. Revisar gestion pendiente."
        )

        with transaction.atomic():
            full_history = self._append_solicitud_transfer_history_event(
                solicitud=solicitud,
                stage="pendiente",
                description=description,
                actor=actor_recipient,
                at=created_at,
            )
            if not recipients:
                return False

            reminder = {
                "id": str(uuid4()),
                "date": now.strftime("%Y-%m-%d"),
                "time": now.strftime("%H:%M"),
                "description": description,
                "creator": actor_recipient,
                "recipients": recipients,
                "context": {
                    "type": "solicitud_traslado",
                    "id": str(solicitud_id),
                    "label": context_label,
                    "sucursal_solicitante_id": str(int(solicitud.sucursal_solicitante_id or 0)) if solicitud.sucursal_solicitante_id else "",
                    "sucursal_proveedora_id": str(int(solicitud.sucursal_proveedora_id or 0)) if solicitud.sucursal_proveedora_id else "",
                    "urgente": bool(getattr(solicitud, "urgente", False)),
                },
                "kind": "solicitud_traslado_decision",
                "deadlineAt": deadline_at.isoformat(),
                "decision": {
                    "status": "pendiente",
                    "reason": "",
                    "by": None,
                    "at": "",
                    "assignedRecipients": selected_recipients,
                },
                "transferHistory": full_history,
                "createdAt": created_at,
                "completedBy": [],
            }
            store = ReminderState.get_global(for_update=True)
            existing_payload = store.payload if isinstance(store.payload, list) else []
            merged = self._upsert_transfer_context_reminder(
                _normalize_reminder_list(existing_payload),
                solicitud_id=solicitud_id,
                reminder=reminder,
            )
            store.payload = _normalize_reminder_list(merged)
            store.save(update_fields=["payload", "updated_at"])

        return True

    def _append_transfer_decision_result_reminder(
        self,
        *,
        solicitud,
        actor_user,
        decision_status,
        rejection_reason="",
    ):
        if solicitud is None:
            return False

        solicitud_id = int(getattr(solicitud, "id", 0) or 0)
        if solicitud_id <= 0:
            return False

        normalized_status = self._normalize_state_name(decision_status)
        if normalized_status not in {"aceptada", "rechazada", "cancelado"}:
            return False

        actor_recipient = self._normalize_reminder_recipient(actor_user) or {
            "id": "system",
            "name": "Sistema",
        }
        transfer_doc = str(getattr(solicitud, "no_documento", "") or "").strip()
        transfer_reference = f"#{transfer_doc}" if transfer_doc else f"#{solicitud_id}"
        context_label = f"Solicitud de traslado {transfer_reference}"
        now = timezone.localtime(timezone.now())
        resolved_at = timezone.now().isoformat()

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            existing_payload = store.payload if isinstance(store.payload, list) else []
            normalized_payload = _normalize_reminder_list(existing_payload)
            request_creator = self._resolve_transfer_request_creator_from_payload(
                normalized_payload,
                solicitud_id=solicitud_id,
            ) or self._normalize_reminder_recipient(getattr(solicitud, "creado_por", None))

            current_context_reminder = None
            for item in normalized_payload:
                if not isinstance(item, dict):
                    continue
                context = item.get("context") if isinstance(item.get("context"), dict) else {}
                context_type = self._normalize_reminder_context_type(context.get("type"))
                context_id = str(context.get("id") or "").strip()
                if context_type == "solicitud_traslado" and context_id == str(solicitud_id):
                    current_context_reminder = item
                    break

            seed_history = self._get_transfer_context_history_from_payload(
                normalized_payload,
                solicitud_id=solicitud_id,
            )

            recipients = []
            seen_recipient_ids = set()

            def append_unique(candidate):
                normalized_candidate = self._normalize_reminder_recipient(candidate)
                if normalized_candidate is None:
                    return
                candidate_id = str(normalized_candidate.get("id") or "").strip()
                if not candidate_id or candidate_id in seen_recipient_ids:
                    return
                seen_recipient_ids.add(candidate_id)
                recipients.append(normalized_candidate)

            for candidate in (
                current_context_reminder.get("recipients", [])
                if isinstance(current_context_reminder, dict)
                else []
            ):
                append_unique(candidate)
            append_unique(request_creator)

            if normalized_status == "rechazada":
                description = (
                    f"Su solicitud de traslado {transfer_reference} fue rechazada. Motivo: {rejection_reason}"
                    if rejection_reason
                    else f"Su solicitud de traslado {transfer_reference} fue rechazada."
                )
            elif normalized_status == "cancelado":
                description = (
                    f"Su solicitud de traslado {transfer_reference} fue cancelada. {rejection_reason}"
                    if rejection_reason
                    else f"Su solicitud de traslado {transfer_reference} fue cancelada."
                )
            elif rejection_reason:
                # Aceptacion parcial: rejection_reason lista lo que no se envia.
                description = (
                    f"Su solicitud de traslado {transfer_reference} fue aceptada parcialmente. "
                    f"Rechazados: {rejection_reason}"
                )
            else:
                description = f"Su solicitud de traslado {transfer_reference} fue aceptada."

            assigned_recipients = []
            if isinstance(current_context_reminder, dict):
                decision = current_context_reminder.get("decision")
                if isinstance(decision, dict) and isinstance(decision.get("assignedRecipients"), list):
                    assigned_recipients = decision.get("assignedRecipients") or []

            full_history = self._append_solicitud_transfer_history_event(
                solicitud=solicitud,
                stage=normalized_status,
                description=description,
                actor=actor_recipient,
                at=resolved_at,
                seed_history=seed_history,
            )
            if not recipients:
                return False

            # Rechazada/cancelado is a terminal, no-action-needed outcome for the
            # requester -- there is nothing to approve/reject anymore, only to read.
            # Seeding completedBy with every recipient keeps it from ever entering the
            # "pending correction" urgent-shield bubble, instead of relying on someone
            # opening the reminders panel to dismiss it (which could never happen).
            initial_completed_by = (
                [str(r.get("id") or "").strip() for r in recipients if r.get("id")]
                if normalized_status in {"rechazada", "cancelado"}
                else []
            )

            reminder = {
                "id": str(uuid4()),
                "date": now.strftime("%Y-%m-%d"),
                "time": now.strftime("%H:%M"),
                "description": description,
                "creator": request_creator or actor_recipient,
                "recipients": recipients,
                "context": {
                    "type": "solicitud_traslado",
                    "id": str(solicitud_id),
                    "label": context_label,
                    "urgente": bool(getattr(solicitud, "urgente", False)),
                },
                "kind": "recordatorio_general",
                "createdAt": resolved_at,
                "decision": {
                    "status": normalized_status,
                    "reason": rejection_reason if normalized_status in {"rechazada", "cancelado"} else "",
                    "by": actor_recipient,
                    "at": resolved_at,
                    "assignedRecipients": assigned_recipients,
                },
                "transferHistory": full_history,
                "completedBy": initial_completed_by,
            }

            merged = self._upsert_transfer_context_reminder(
                normalized_payload,
                solicitud_id=solicitud_id,
                reminder=reminder,
            )
            store.payload = _normalize_reminder_list(merged)
            store.save(update_fields=["payload", "updated_at"])

        return True

    def _append_transfer_shipment_reminder(
        self,
        *,
        solicitud,
        actor_user,
    ):
        if solicitud is None:
            return False

        solicitud_id = int(getattr(solicitud, "id", 0) or 0)
        if solicitud_id <= 0:
            return False

        transfer_doc = str(getattr(solicitud, "no_documento", "") or "").strip()
        transfer_reference = f"#{transfer_doc}" if transfer_doc else f"#{solicitud_id}"
        context_label = f"Solicitud de traslado {transfer_reference}"

        now = timezone.localtime(timezone.now())
        creator = self._normalize_reminder_recipient(actor_user) or {"id": "system", "name": "Sistema"}

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            existing_payload = store.payload if isinstance(store.payload, list) else []
            normalized = _normalize_reminder_list(existing_payload)
            request_creator = self._resolve_transfer_request_creator_from_payload(
                normalized,
                solicitud_id=solicitud_id,
            ) or self._normalize_reminder_recipient(getattr(solicitud, "creado_por", None))
            seed_history = self._get_transfer_context_history_from_payload(
                normalized,
                solicitud_id=solicitud_id,
            )

            requester_recipients = self._resolve_transfer_requester_recipients(
                solicitud.sucursal_solicitante_id,
            )
            provider_recipients = self._resolve_transfer_provider_recipients(
                solicitud.sucursal_proveedora_id,
            )
            recipients = []
            seen_recipient_ids = set()

            def append_unique(candidate):
                normalized_candidate = self._normalize_reminder_recipient(candidate)
                if normalized_candidate is None:
                    return
                candidate_id = str(normalized_candidate.get("id") or "").strip()
                if not candidate_id or candidate_id in seen_recipient_ids:
                    return
                seen_recipient_ids.add(candidate_id)
                recipients.append(normalized_candidate)

            for candidate in requester_recipients:
                append_unique(candidate)
            append_unique(request_creator)
            for candidate in provider_recipients:
                append_unique(candidate)
            append_unique(creator)

            description = f"Su solicitud de traslado {transfer_reference} fue enviada y está en traslado."
            created_at = timezone.now().isoformat()
            full_history = self._append_solicitud_transfer_history_event(
                solicitud=solicitud,
                stage="enviado",
                description=description,
                actor=creator,
                at=created_at,
                seed_history=seed_history,
            )
            if not recipients:
                return False

            reminder = {
                "id": str(uuid4()),
                "date": now.strftime("%Y-%m-%d"),
                "time": now.strftime("%H:%M"),
                "description": description,
                "creator": request_creator or creator,
                "recipients": recipients,
                "context": {
                    "type": "solicitud_traslado",
                    "id": str(solicitud_id),
                    "label": context_label,
                    "sucursal_solicitante_id": str(int(solicitud.sucursal_solicitante_id or 0)) if solicitud.sucursal_solicitante_id else "",
                    "sucursal_proveedora_id": str(int(solicitud.sucursal_proveedora_id or 0)) if solicitud.sucursal_proveedora_id else "",
                    "urgente": bool(getattr(solicitud, "urgente", False)),
                },
                "kind": "recordatorio_general",
                "createdAt": created_at,
                "decision": {
                    "status": "enviado",
                    "reason": "",
                    "by": creator,
                    "at": created_at,
                    "assignedRecipients": [],
                },
                "transferHistory": full_history,
                "completedBy": [],
            }

            merged = self._upsert_transfer_context_reminder(
                normalized,
                solicitud_id=solicitud_id,
                reminder=reminder,
            )
            store.payload = _normalize_reminder_list(merged)
            store.save(update_fields=["payload", "updated_at"])

        return True

    def _append_direct_transfer_shipment_reminder(
        self,
        *,
        movement,
        solicitud_id,
        actor_user,
        recipient_ids,
    ):
        if not movement or not recipient_ids:
            return False

        movement_id = int(getattr(movement, "id", 0) or 0)
        solicitud_id = int(solicitud_id or 0)
        if movement_id <= 0 or solicitud_id <= 0:
            return False

        User = get_user_model()
        recipient_users = User.objects.filter(id__in=recipient_ids, is_active=True)
        recipients = [self._normalize_reminder_recipient(u) for u in recipient_users]
        recipients = [r for r in recipients if r]
        if not recipients:
            return False

        transfer_doc = str(getattr(movement, "no_documento", "") or "").strip()
        transfer_reference = f"#{transfer_doc}" if transfer_doc else f"#{movement_id}"
        context_label = f"Traslado directo {transfer_reference}"
        description = f"El traslado {transfer_reference} fue enviado y está en camino."

        now = timezone.localtime(timezone.now())
        actor = self._normalize_reminder_recipient(actor_user) or {"id": "system", "name": "Sistema"}
        created_at = timezone.now().isoformat()

        reminder = {
            "id": str(uuid4()),
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M"),
            "description": description,
            "creator": actor,
            "recipients": recipients,
            "context": {
                "type": "solicitud_traslado",
                "id": str(solicitud_id),
                "label": context_label,
                "sucursal_solicitante_id": str(getattr(movement, "sucursal_objetivo_id", "") or ""),
                "sucursal_proveedora_id": str(getattr(movement, "sucursal_id", "") or ""),
            },
            "kind": "recordatorio_general",
            "createdAt": created_at,
            "decision": {
                "status": "enviado",
                "reason": "",
                "by": actor,
                "at": created_at,
                "assignedRecipients": [],
            },
            "transferHistory": [
                {
                    "stage": "enviado",
                    "label": "Enviado",
                    "description": description,
                    "at": created_at,
                    "actor": actor,
                }
            ],
            "completedBy": [],
        }

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            existing_payload = store.payload if isinstance(store.payload, list) else []
            normalized = _normalize_reminder_list(existing_payload)
            normalized.insert(0, reminder)
            store.payload = _normalize_reminder_list(normalized)
            store.save(update_fields=["payload", "updated_at"])

        return True

    def _append_garantia_approval_reminder(self, *, movement, actor_user):
        movement_id = int(getattr(movement, "id", 0) or 0)
        if movement_id <= 0:
            return False

        doc = str(getattr(movement, "no_documento", "") or "").strip()
        reference = f"#{doc}" if doc else f"#{movement_id}"
        context_label = f"Garantia {reference}"
        description = f"Solicitud de garantia {reference} requiere aprobacion."

        now = timezone.localtime(timezone.now())
        actor = self._normalize_reminder_recipient(actor_user) or {"id": "system", "name": "Sistema"}
        created_at = timezone.now().isoformat()

        admin_recipients = self._resolve_transfer_request_admin_recipients(
            exclude_user_ids=[str(actor.get("id") or "")],
        )
        if not admin_recipients:
            return False

        reminder = {
            "id": str(uuid4()),
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M"),
            "description": description,
            "creator": actor,
            "recipients": admin_recipients,
            "context": {
                "type": "solicitud_garantia",
                "id": str(movement_id),
                "label": context_label,
            },
            "kind": "solicitud_garantia",
            "color": "rojo",
            "createdAt": created_at,
            "decision": {
                "status": "pendiente",
                "reason": "",
                "by": None,
                "at": created_at,
                "assignedRecipients": [],
            },
            "completedBy": [],
        }

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            existing_payload = store.payload if isinstance(store.payload, list) else []
            normalized = _normalize_reminder_list(existing_payload)
            normalized.insert(0, reminder)
            store.payload = _normalize_reminder_list(normalized)
            store.save(update_fields=["payload", "updated_at"])

        return True

    def _get_garantia_creator_from_payload(self, movement_id):
        movement_id_str = str(movement_id)
        store = ReminderState.get_global()
        payload = store.payload if isinstance(store.payload, list) else []
        for item in payload:
            ctx = item.get("context") or {}
            if (
                str(item.get("kind") or "").strip() == "solicitud_garantia"
                and str(ctx.get("type") or "").strip() == "solicitud_garantia"
                and str(ctx.get("id") or "").strip() == movement_id_str
            ):
                return item.get("creator")
        return None

    def _append_garantia_result_notification(self, *, movement, actor_user, decision, reason=""):
        movement_id = int(getattr(movement, "id", 0) or 0)
        if movement_id <= 0:
            return False

        creator = self._get_garantia_creator_from_payload(movement_id)
        if not creator:
            return False

        creator_id = str(creator.get("id") or "").strip()
        if not creator_id:
            return False

        doc = str(getattr(movement, "no_documento", "") or "").strip()
        reference = f"#{doc}" if doc else f"#{movement_id}"

        if decision == "aceptada":
            description = f"Tu solicitud de garantia {reference} fue aceptada."
        else:
            description = f"Tu solicitud de garantia {reference} fue rechazada."
            if reason:
                description += f" Motivo: {reason}"

        actor = self._normalize_reminder_recipient(actor_user) or {"id": "system", "name": "Sistema"}
        now = timezone.localtime(timezone.now())
        created_at = timezone.now().isoformat()

        reminder = {
            "id": str(uuid4()),
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M"),
            "description": description,
            "creator": actor,
            "recipients": [creator],
            "context": {
                "type": "solicitud_garantia_resultado",
                "id": str(movement_id),
                "label": f"Garantia {reference}",
            },
            "kind": "solicitud_garantia_resultado",
            "createdAt": created_at,
            "decision": {
                "status": decision,
                "reason": reason,
                "by": actor,
                "at": created_at,
            },
            "completedBy": [],
        }

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            existing_payload = store.payload if isinstance(store.payload, list) else []
            normalized = _normalize_reminder_list(existing_payload)
            normalized.insert(0, reminder)
            store.payload = _normalize_reminder_list(normalized)
            store.save(update_fields=["payload", "updated_at"])

        return True

    def _update_garantia_reminder_decision(self, movement_id, actor_user, decision_status, reason=""):
        actor = self._normalize_reminder_recipient(actor_user) or {"id": "system", "name": "Sistema"}
        now = timezone.now().isoformat()
        movement_id_str = str(movement_id)

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            payload = store.payload if isinstance(store.payload, list) else []
            updated = []
            for item in payload:
                ctx = item.get("context") or {}
                if (
                    str(item.get("kind") or "").strip() == "solicitud_garantia"
                    and str(ctx.get("type") or "").strip() == "solicitud_garantia"
                    and str(ctx.get("id") or "").strip() == movement_id_str
                ):
                    item = dict(item)
                    item["decision"] = {
                        **(item.get("decision") or {}),
                        "status": decision_status,
                        "reason": reason,
                        "by": actor,
                        "at": now,
                    }
                updated.append(item)
            store.payload = _normalize_reminder_list(updated)
            store.save(update_fields=["payload", "updated_at"])

    def _compra_local_distribucion_payload(self, instance):
        enviado = {}
        envios = []
        for envio in instance.envios_compra.select_related("sucursal").prefetch_related("detalles"):
            items = []
            for detalle in envio.detalles.all():
                pid = int(detalle.producto_id)
                enviado[pid] = enviado.get(pid, 0) + int(detalle.cantidad or 0)
                items.append({"producto_id": pid, "cantidad": int(detalle.cantidad or 0)})
            envios.append(
                {
                    "id": int(envio.id),
                    "sucursal_id": int(envio.sucursal_id),
                    "sucursal_nombre": str(envio.sucursal.nombre or "").strip(),
                    "estado": envio.estado,
                    "llegada_confirmada": bool(envio.llegada_confirmada_en),
                    "fecha": envio.fecha,
                    "detalles": items,
                }
            )
        # Desde que el reparto se hace con traslados (los envios de arriba son
        # los de antes).
        for traslado in instance.traslados_compra.select_related(
            "sucursal_solicitante", "movimiento_entrada__estado_movimiento"
        ).prefetch_related("detalles"):
            items = []
            for detalle in traslado.detalles.all():
                pid = int(detalle.producto_id)
                enviado[pid] = enviado.get(pid, 0) + int(detalle.cantidad or 0)
                items.append({"producto_id": pid, "cantidad": int(detalle.cantidad or 0)})
            estado_entrada = self._normalize_state_name(
                getattr(getattr(traslado.movimiento_entrada, "estado_movimiento", None), "nombre", "")
            )
            envios.append(
                {
                    "id": int(traslado.id),
                    "solicitud_traslado_id": int(traslado.id),
                    "sucursal_id": int(traslado.sucursal_solicitante_id),
                    "sucursal_nombre": str(traslado.sucursal_solicitante.nombre or "").strip(),
                    "estado": "recibido" if "recib" in estado_entrada else "pendiente",
                    "llegada_confirmada": "recib" in estado_entrada,
                    "fecha": traslado.fecha,
                    "detalles": items,
                }
            )
        comprado = {}
        productos = {}
        for detalle in instance.detalles.select_related("producto"):
            if not detalle.producto_id:
                continue
            pid = int(detalle.producto_id)
            comprado[pid] = comprado.get(pid, 0) + int(detalle.cantidad or 0)
            productos[pid] = detalle.producto
        return {
            "sucursal_id": int(instance.sucursal_id),
            "sucursal_nombre": str(getattr(instance.sucursal, "nombre", "") or "").strip(),
            "no_documento": str(instance.no_documento or "").strip(),
            "productos": [
                {
                    "producto_id": pid,
                    "codigo": str(productos[pid].codigo or "").strip(),
                    "nombre": str(productos[pid].nombre or "").strip(),
                    "cantidad": cantidad,
                    "enviado": enviado.get(pid, 0),
                }
                for pid, cantidad in comprado.items()
            ],
            "envios": envios,
            "borrador": instance.borrador_distribucion or {},
        }

    def _crear_traslado_compra(self, helper, compra, destino, items, *, no_documento, tipo_salida, subtipo_salida):
        """Traslado ya aprobado de la sucursal de la compra a `destino`, igual
        que un traslado directo: salida (Enviado), entrada (Enviado) y la
        solicitud que los une. El stock del origen ya se desconto; el destino
        lo suma al recibirlo."""
        from productos.models import Producto

        valores = {}
        for detalle in compra.detalles.all():
            if detalle.producto_id:
                valores.setdefault(int(detalle.producto_id), detalle.valor or Decimal("0"))
        productos = Producto.objects.in_bulk(list(items))
        estado_producto = helper._resolve_default_estado_producto()
        detalles_data = [
            {
                "producto": productos[producto_id],
                "cantidad": cantidad,
                "estado_producto": estado_producto,
                "valor": valores.get(producto_id, Decimal("0")),
                "valor_total": valores.get(producto_id, Decimal("0")) * cantidad,
            }
            for producto_id, cantidad in items.items()
        ]
        descripcion = f"Envio de la compra local {str(compra.no_documento or '').strip()}"
        salida = MovimientoInventario.objects.create(
            sucursal=compra.sucursal,
            tipo_movimiento=tipo_salida,
            sub_tipo_movimiento=subtipo_salida,
            descripcion=descripcion,
            sucursal_objetivo=destino,
            estado_movimiento=self._resolve_estado_movimiento("enviado"),
            iva_rate=compra.iva_rate,
            fecha=timezone.localdate(),
            no_documento=no_documento,
            tipo_envio=MovimientoInventario.TipoEnvio.TRASLADO_NORMAL,
            creado_por=self.request.user,
        )
        helper._replace_detalles(salida, detalles_data)
        entrada = helper._create_transfer_entry_from_salida(salida, detalles_data, None)
        traslado = SolicitudTraslado.objects.create(
            sucursal_solicitante=destino,
            sucursal_proveedora=compra.sucursal,
            descripcion=descripcion,
            fecha=salida.fecha,
            no_documento=no_documento,
            estado=SolicitudTraslado.Estados.APROBADA,
            creado_por=self.request.user,
            enviado_por=self.request.user,
            movimiento_salida=salida,
            movimiento_entrada=entrada,
            compra_local=compra,
        )
        SolicitudTrasladoDetalle.objects.bulk_create(
            [
                SolicitudTrasladoDetalle(
                    solicitud=traslado, producto=d["producto"], cantidad=d["cantidad"], valor=d["valor"]
                )
                for d in detalles_data
            ]
        )
        return traslado

    @action(detail=True, methods=["get"], url_path="historial")
    def historial(self, request, pk=None):
        """Historial del movimiento: creacion, ediciones, estados, etapas del
        traslado, envios de la compra local e inconvenientes."""
        instance = self.get_object()
        return Response({"eventos": build_movement_history(instance)})

    @action(detail=True, methods=["get", "post", "patch"], url_path="distribucion-compra")
    def distribucion_compra(self, request, pk=None):
        """Reparte una compra local a otras sucursales: lo enviado sale del
        stock de la sucursal de la compra y a cada sucursal le llega como un
        traslado (salida en el origen, entrada en el destino) que se recibe
        igual que cualquier traslado, con checkboxes y sin POR UBICAR. Solo
        las importaciones usan POR UBICAR.

        POST body: {distribuciones: [{producto_id, sucursal_id, cantidad}],
        destinatarios_por_sucursal: [{sucursal_id, user_ids}],
        documentos_por_sucursal: [{sucursal_id, no_documento}]}.
        PATCH body: {borrador: {...}}: guarda el reparto a medio hacer.
        """
        from importaciones.models import ImportacionEnvio

        from .serializers import MovimientoInventarioSerializer

        instance = self.get_object()
        helper = MovimientoInventarioSerializer(context=self.get_serializer_context())
        is_compra_local = (
            helper._resolve_subtipo_key(instance.sub_tipo_movimiento) == "compra_local"
            and helper._entry_adds_stock(instance)
            and not instance.es_legado
        )
        if not is_compra_local:
            return Response(
                {"detail": "Solo una compra local ya recibida se puede enviar a otras sucursales."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        from app.reposicion import central_branch_id

        central_id = central_branch_id()
        if not central_id or int(instance.sucursal_id) != int(central_id):
            return Response(
                {"detail": "Solo la matriz puede enviar sus compras locales a otras sucursales."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if request.method == "GET":
            return Response(self._compra_local_distribucion_payload(instance), status=status.HTTP_200_OK)
        if request.method == "PATCH":
            borrador = request.data.get("borrador")
            instance.borrador_distribucion = borrador if isinstance(borrador, dict) else {}
            instance.save(update_fields=["borrador_distribucion"])
            return Response({"borrador": instance.borrador_distribucion}, status=status.HTTP_200_OK)

        ensure_sucursal_allowed_for_modules(
            request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
            instance.sucursal_id,
            field_label="sucursal",
            action_key="puede_crear",
        )

        por_sucursal = {}
        for raw in request.data.get("distribuciones") or []:
            if not isinstance(raw, dict):
                continue
            try:
                producto_id = int(raw.get("producto_id") or 0)
                sucursal_id = int(raw.get("sucursal_id") or 0)
                cantidad = int(raw.get("cantidad") or 0)
            except (TypeError, ValueError):
                continue
            if producto_id <= 0 or sucursal_id <= 0 or cantidad <= 0:
                continue
            if sucursal_id == int(instance.sucursal_id):
                continue
            items = por_sucursal.setdefault(sucursal_id, {})
            items[producto_id] = items.get(producto_id, 0) + cantidad
        if not por_sucursal:
            return Response(
                {"detail": "Indica cuantas unidades van a otra sucursal."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        sucursales = {s.id: s for s in Sucursal.objects.filter(id__in=sorted(por_sucursal))}
        faltan = sorted(set(por_sucursal) - set(sucursales))
        if faltan:
            return Response(
                {"detail": "Una o mas sucursales destino no existen."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Cada envio lleva su No. Documento (obligatorio y sin repetir).
        documentos = {}
        for raw in request.data.get("documentos_por_sucursal") or []:
            if not isinstance(raw, dict):
                continue
            try:
                sucursal_id = int(raw.get("sucursal_id") or 0)
            except (TypeError, ValueError):
                continue
            documentos[sucursal_id] = str(raw.get("no_documento") or "").strip()
        sin_documento = [sucursales[sid].nombre for sid in sorted(por_sucursal) if not documentos.get(sid)]
        if sin_documento:
            return Response(
                {"detail": f"Falta el No. Documento del envio a: {', '.join(sin_documento)}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        usados = [documentos[sid] for sid in por_sucursal]
        if len({doc.upper() for doc in usados}) != len(usados):
            return Response(
                {"detail": "Cada envio debe tener un No. Documento distinto."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        repetidos = [
            doc
            for doc in usados
            if ImportacionEnvio.objects.filter(no_documento__iexact=doc).exists()
            or MovimientoInventario.objects.filter(no_documento__iexact=doc).exists()
            or SolicitudTraslado.objects.filter(no_documento__iexact=doc).exists()
        ]
        if repetidos:
            return Response(
                {"detail": f"El No. Documento {', '.join(repetidos)} ya existe; usa otro."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        tipo_salida = TipoMovimiento.objects.filter(nombre__istartswith="sal").order_by("id").first()
        subtipo_salida = (
            SubTipoMovimiento.objects.filter(tipo_movimiento=tipo_salida, nombre__icontains="trasl")
            .order_by("id")
            .first()
            if tipo_salida is not None
            else None
        )
        if subtipo_salida is None:
            return Response(
                {"detail": "No existe el subtipo de salida por traslado para enviar a otras sucursales."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        traslados = {}
        with transaction.atomic():
            # Bloquea la compra: dos repartos a la vez no pueden pasarse de lo comprado.
            MovimientoInventario.objects.select_for_update().filter(pk=instance.pk).first()
            payload = self._compra_local_distribucion_payload(instance)
            productos = {item["producto_id"]: item for item in payload["productos"]}
            a_enviar = {}
            for items in por_sucursal.values():
                for producto_id, cantidad in items.items():
                    a_enviar[producto_id] = a_enviar.get(producto_id, 0) + cantidad

            errores = []
            for producto_id, cantidad in a_enviar.items():
                producto = productos.get(producto_id)
                if producto is None:
                    errores.append(f"El producto {producto_id} no esta en esta compra.")
                    continue
                disponible = producto["cantidad"] - producto["enviado"]
                if cantidad > disponible:
                    errores.append(
                        f"{producto['codigo']}: quieres enviar {cantidad} pero de esta compra quedan {max(0, disponible)} por repartir."
                    )
                    continue
                en_sucursal = (
                    Inventario.objects.filter(
                        producto_id=producto_id,
                        subdivision__division__bodega__sucursal_id=instance.sucursal_id,
                    ).aggregate(total=Coalesce(Sum("cantidad"), 0))["total"]
                    or 0
                )
                if cantidad > en_sucursal:
                    errores.append(
                        f"{producto['codigo']}: quieres enviar {cantidad} pero en {payload['sucursal_nombre']} hay {en_sucursal}."
                    )
            if errores:
                transaction.set_rollback(True)
                return Response({"detail": " ".join(errores)}, status=status.HTTP_400_BAD_REQUEST)

            stock_reductions = {}
            for producto_id, cantidad in a_enviar.items():
                helper._adjust_stock(instance.sucursal, producto_id, -cantidad)
                stock_reductions.setdefault(int(instance.sucursal_id), set()).add(producto_id)
            try:
                for sucursal_id, items in por_sucursal.items():
                    traslados[sucursal_id] = self._crear_traslado_compra(
                        helper,
                        instance,
                        sucursales[sucursal_id],
                        items,
                        no_documento=documentos[sucursal_id],
                        tipo_salida=tipo_salida,
                        subtipo_salida=subtipo_salida,
                    )
            except drf_serializers.ValidationError as exc:
                transaction.set_rollback(True)
                return Response(
                    {"detail": self._extract_validation_message(exc.detail) or "No se pudo crear el traslado."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            helper._reject_pending_transfers_due_to_stock_changes(stock_reductions)
            instance.borrador_distribucion = {}
            instance.save(update_fields=["borrador_distribucion"])

        for dest in request.data.get("destinatarios_por_sucursal") or []:
            if not isinstance(dest, dict):
                continue
            try:
                sucursal_id = int(dest.get("sucursal_id") or 0)
            except (TypeError, ValueError):
                continue
            user_ids = [uid for uid in (dest.get("user_ids") or []) if uid]
            if sucursal_id not in traslados or not user_ids:
                continue
            self._append_direct_transfer_shipment_reminder(
                movement=traslados[sucursal_id].movimiento_salida,
                solicitud_id=traslados[sucursal_id].id,
                actor_user=request.user,
                recipient_ids=user_ids,
            )

        instance.refresh_from_db()
        response = self._compra_local_distribucion_payload(instance)
        response[REMINDERS_SYNC_FLAG] = True
        return Response(response, status=status.HTTP_200_OK)

    @action(detail=True, methods=["post"], url_path="aceptar-garantia")
    def aceptar_garantia(self, request, pk=None):
        if not is_app_admin(request.user):
            raise PermissionDenied("Solo los administradores pueden aprobar garantias.")

        movement = self.get_object()
        if not movement.garantia_pendiente:
            return Response(
                {"detail": "Este movimiento no tiene aprobacion pendiente."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            movement.garantia_pendiente = False
            movement.estado_garantia = MovimientoInventario.EstadoGarantia.REALIZADA
            movement.save(update_fields=["garantia_pendiente", "estado_garantia"])

            serializer = MovimientoInventarioSerializer(context=self.get_serializer_context())
            detalles = list(movement.detalles.select_related("producto").all())
            serializer._apply_inventory_effect(movement, detalles, reverse=False)

        self._update_garantia_reminder_decision(movement.id, request.user, "aceptada")
        self._append_garantia_result_notification(
            movement=movement,
            actor_user=request.user,
            decision="aceptada",
        )
        response_data = MovimientoInventarioSerializer(
            movement, context=self.get_serializer_context()
        ).data
        response_data[REMINDERS_SYNC_FLAG] = True
        return Response(response_data)

    @action(detail=True, methods=["post"], url_path="rechazar-garantia")
    def rechazar_garantia(self, request, pk=None):
        if not is_app_admin(request.user):
            raise PermissionDenied("Solo los administradores pueden rechazar garantias.")

        movement = self.get_object()
        if not movement.garantia_pendiente:
            return Response(
                {"detail": "Este movimiento no tiene aprobacion pendiente."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        motivo = str(request.data.get("motivo") or "").strip()
        movement_id = movement.id
        self._update_garantia_reminder_decision(movement_id, request.user, "rechazada", reason=motivo)
        self._append_garantia_result_notification(
            movement=movement,
            actor_user=request.user,
            decision="rechazada",
            reason=motivo,
        )

        with transaction.atomic():
            movement.garantia_pendiente = False
            movement.estado_garantia = MovimientoInventario.EstadoGarantia.ELIMINADA
            movement.save(update_fields=["garantia_pendiente", "estado_garantia"])

        return Response({REMINDERS_SYNC_FLAG: True}, status=status.HTTP_200_OK)

    def _append_transfer_reception_reminder(
        self,
        *,
        solicitud,
        resultado,
        total_faltante,
        processed_items,
        actor_user,
    ):
        if solicitud is None:
            return False

        actor_recipient = self._normalize_reminder_recipient(actor_user) or {
            "id": "system",
            "name": "Sistema",
        }
        recipients = []
        recipient_ids = set()

        def append_unique_recipient(candidate):
            normalized = self._normalize_reminder_recipient(candidate)
            if normalized is None:
                return
            recipient_id = str(normalized.get("id") or "").strip()
            if not recipient_id or recipient_id in recipient_ids:
                return
            recipient_ids.add(recipient_id)
            recipients.append(normalized)

        append_unique_recipient(actor_recipient)
        for candidate in self._resolve_transfer_provider_recipients(
            solicitud.sucursal_proveedora_id
        ):
            append_unique_recipient(candidate)
        transfer_doc = str(getattr(solicitud, "no_documento", "") or "").strip()
        transfer_reference = f"#{transfer_doc}" if transfer_doc else f"#{int(solicitud.id)}"
        requester_name = str(
            getattr(getattr(solicitud, "sucursal_solicitante", None), "nombre", "") or ""
        ).strip() or "sucursal solicitante"
        context_label = f"Solicitud de traslado {transfer_reference}"

        normalized_resultado = self._normalize_state_name(resultado)
        missing_lines = []
        for item in processed_items or []:
            faltante = int(item.get("cantidad_faltante") or 0)
            if faltante <= 0:
                continue
            detalle = item.get("detalle")
            product_name = str(
                getattr(getattr(detalle, "producto", None), "nombre", "")
                or getattr(getattr(detalle, "producto", None), "codigo", "")
                or item.get("producto_id")
            ).strip()
            novedad = str(item.get("novedad") or "").strip()
            if novedad:
                missing_lines.append(f"{product_name}: faltan {faltante} ({novedad})")
            else:
                missing_lines.append(f"{product_name}: faltan {faltante}")

        if normalized_resultado == "incompleto":
            description = (
                f"Su envio de traslado {transfer_reference} llego incompleto en {requester_name}. "
                f"Faltantes: {'; '.join(missing_lines) or int(total_faltante)}."
            )
        else:
            description = (
                f"Su envio de traslado {transfer_reference} llego completo en {requester_name}."
            )

        now = timezone.localtime(timezone.now())
        created_at = timezone.now().isoformat()

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            existing_payload = store.payload if isinstance(store.payload, list) else []
            normalized_payload = _normalize_reminder_list(existing_payload)
            seed_history = self._get_transfer_context_history_from_payload(
                normalized_payload,
                solicitud_id=int(solicitud.id),
            )
            full_history = self._append_solicitud_transfer_history_event(
                solicitud=solicitud,
                stage="incompleto" if normalized_resultado == "incompleto" else "completo",
                description=description,
                actor=actor_recipient,
                at=created_at,
                seed_history=seed_history,
            )
            if not recipients:
                return False

            reminder = {
                "id": str(uuid4()),
                "date": now.strftime("%Y-%m-%d"),
                "time": now.strftime("%H:%M"),
                "description": description,
                "creator": actor_recipient,
                "recipients": recipients,
                "context": {
                    "type": "solicitud_traslado",
                    "id": str(int(solicitud.id)),
                    "label": context_label,
                    "urgente": bool(getattr(solicitud, "urgente", False)),
                },
                "kind": "recordatorio_general",
                "createdAt": created_at,
                "transferHistory": full_history,
                "completedBy": [],
            }
            store.payload = self._upsert_transfer_context_reminder(
                normalized_payload,
                solicitud_id=int(solicitud.id),
                reminder=reminder,
            )
            store.save(update_fields=["payload", "updated_at"])

        return True

    def _sync_transfer_inconvenience_reminder(
        self,
        *,
        solicitud,
        actor_user,
    ):
        if solicitud is None:
            return False

        solicitud_id = int(getattr(solicitud, "id", 0) or 0)
        if solicitud_id <= 0:
            return False

        inconvenientes = list(
            TrasladoInconveniente.objects.select_related("producto")
            .filter(solicitud_id=solicitud_id)
            .order_by("id")
        )
        if not inconvenientes:
            return False

        recipients = self._resolve_transfer_request_admin_recipients()
        if not recipients:
            return False

        actor_recipient = self._normalize_reminder_recipient(actor_user) or {
            "id": "system",
            "name": "Sistema",
        }
        transfer_doc = str(getattr(solicitud, "no_documento", "") or "").strip()
        transfer_reference = f"#{transfer_doc}" if transfer_doc else f"#{solicitud_id}"
        requester_name = str(
            getattr(getattr(solicitud, "sucursal_solicitante", None), "nombre", "") or ""
        ).strip() or "sucursal destino"
        context_label = f"Inconveniente de traslado {transfer_reference}"

        pending_state = str(TrasladoInconveniente.Estados.PENDIENTE).strip().lower()
        pending_issues = [
            issue
            for issue in inconvenientes
            if str(getattr(issue, "estado", "") or "").strip().lower()
            == pending_state
        ]
        active_issues = pending_issues or inconvenientes

        summary_lines = []
        max_summary_items = 3
        for issue in active_issues[:max_summary_items]:
            product_name = str(
                getattr(getattr(issue, "producto", None), "nombre", "")
                or getattr(getattr(issue, "producto", None), "codigo", "")
                or getattr(issue, "producto_id", "")
            ).strip() or "Producto"
            missing_qty = int(getattr(issue, "cantidad_faltante", 0) or 0)
            issue_reason = str(getattr(issue, "motivo", "") or "").strip()
            detail = f"{product_name}: faltan {missing_qty}"
            if issue_reason:
                detail = f"{detail} ({issue_reason})"
            summary_lines.append(detail)

        summary = "; ".join(summary_lines)
        extra_count = max(0, len(active_issues) - len(summary_lines))
        if summary and extra_count > 0:
            summary = f"{summary}; y {extra_count} mas"

        all_resolved = not pending_issues
        if all_resolved:
            resolved_count = len(inconvenientes)
            if resolved_count == 1:
                description = (
                    f"El inconveniente del traslado {transfer_reference} ya fue resuelto."
                )
            else:
                description = (
                    f"Los {resolved_count} inconvenientes del traslado {transfer_reference} "
                    "ya fueron resueltos."
                )
        else:
            pending_count = len(pending_issues)
            count_label = (
                "1 inconveniente pendiente"
                if pending_count == 1
                else f"{pending_count} inconvenientes pendientes"
            )
            description = (
                f"El traslado {transfer_reference} llego con inconvenientes en {requester_name}. "
                f"Hay {count_label} por resolver."
            )

        if summary:
            description = f"{description} Detalle: {summary}."

        now = timezone.localtime(timezone.now())
        created_at = timezone.now().isoformat()
        completed_by = (
            [
                str(recipient.get("id") or "").strip()
                for recipient in recipients
                if str(recipient.get("id") or "").strip()
            ]
            if all_resolved
            else []
        )

        reminder = {
            "id": str(uuid4()),
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M"),
            "description": description,
            "creator": actor_recipient,
            "recipients": recipients,
            "context": {
                "type": TRANSFER_ISSUE_REMINDER_CONTEXT_TYPE,
                "id": str(solicitud_id),
                "label": context_label,
            },
            "kind": TRANSFER_ISSUE_REMINDER_KIND,
            "createdAt": created_at,
            "completedBy": completed_by,
        }

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            existing_payload = store.payload if isinstance(store.payload, list) else []
            merged = self._upsert_transfer_issue_context_reminder(
                _normalize_reminder_list(existing_payload),
                solicitud_id=solicitud_id,
                reminder=reminder,
            )
            store.payload = _normalize_reminder_list(merged)
            store.save(update_fields=["payload", "updated_at"])

        return True

    def _serialize_inconveniente(self, inconveniente):
        historial_rows = list(
            sorted(
                inconveniente.historial.all(), key=lambda row: (row.created_at, row.id), reverse=True
            )
        )
        historial_payload = [
            {
                "id": int(row.id),
                "accion": str(row.accion or "").strip(),
                "detalle": str(row.detalle or "").strip(),
                "actor_id": int(row.actor_id) if row.actor_id else None,
                "actor_nombre": self._resolve_user_display(getattr(row, "actor", None)),
                "created_at": row.created_at,
            }
            for row in historial_rows
        ]

        return {
            "id": int(inconveniente.id),
            "solicitud_id": int(inconveniente.solicitud_id),
            "solicitud_no_documento": str(
                getattr(getattr(inconveniente, "solicitud", None), "no_documento", "") or ""
            ).strip(),
            "sucursal_solicitante_id": int(
                getattr(getattr(inconveniente, "solicitud", None), "sucursal_solicitante_id", 0) or 0
            ),
            "sucursal_solicitante": str(
                getattr(
                    getattr(getattr(inconveniente, "solicitud", None), "sucursal_solicitante", None),
                    "nombre",
                    "",
                )
                or ""
            ).strip(),
            "sucursal_proveedora_id": int(
                getattr(getattr(inconveniente, "solicitud", None), "sucursal_proveedora_id", 0) or 0
            ),
            "sucursal_proveedora": str(
                getattr(
                    getattr(getattr(inconveniente, "solicitud", None), "sucursal_proveedora", None),
                    "nombre",
                    "",
                )
                or ""
            ).strip(),
            "movimiento_entrada_id": int(inconveniente.movimiento_entrada_id),
            "movimiento_salida_id": (
                getattr(getattr(inconveniente, "solicitud", None), "movimiento_salida_id", None) or None
            ),
            "producto_id": int(inconveniente.producto_id) if inconveniente.producto_id else None,
            "producto_codigo": str(getattr(getattr(inconveniente, "producto", None), "codigo", "") or "").strip(),
            "producto_nombre": str(getattr(getattr(inconveniente, "producto", None), "nombre", "") or "").strip(),
            "tipo": str(inconveniente.tipo or "faltante").strip(),
            "cantidad_faltante": int(inconveniente.cantidad_faltante or 0),
            "estado": str(inconveniente.estado or "").strip(),
            "resolucion": str(inconveniente.resolucion or "").strip(),
            "sucursal_resolucion_id": int(inconveniente.sucursal_resolucion_id) if inconveniente.sucursal_resolucion_id else None,
            "sucursal_resolucion": str(
                getattr(getattr(inconveniente, "sucursal_resolucion", None), "nombre", "") or ""
            ).strip(),
            "subdivision_resolucion_id": int(inconveniente.subdivision_resolucion_id) if inconveniente.subdivision_resolucion_id else None,
            "subdivision_resolucion": str(
                getattr(getattr(inconveniente, "subdivision_resolucion", None), "nombre", "") or ""
            ).strip(),
            "motivo": str(inconveniente.motivo or "").strip(),
            "motivo_resolucion": str(inconveniente.motivo_resolucion or "").strip(),
            "borrador": inconveniente.borrador if isinstance(inconveniente.borrador, dict) else {},
            "creado_por_id": int(inconveniente.creado_por_id) if inconveniente.creado_por_id else None,
            "creado_por_nombre": self._resolve_user_display(getattr(inconveniente, "creado_por", None)),
            "resuelto_por_id": int(inconveniente.resuelto_por_id) if inconveniente.resuelto_por_id else None,
            "resuelto_por_nombre": self._resolve_user_display(getattr(inconveniente, "resuelto_por", None)),
            "created_at": inconveniente.created_at,
            "updated_at": inconveniente.updated_at,
            "historial": historial_payload,
        }

    @staticmethod
    def _add_stock_to_subdivision(subdivision_id, producto_id, cantidad):
        qty = int(cantidad or 0)
        if qty <= 0:
            return
        inventory_row, _ = Inventario.objects.select_for_update().get_or_create(
            subdivision_id=int(subdivision_id),
            producto_id=int(producto_id),
            referencia="",
            defaults={"cantidad": 0},
        )
        inventory_row.cantidad = int(inventory_row.cantidad or 0) + qty
        inventory_row.save(update_fields=["cantidad"])

    @staticmethod
    def _remove_stock_from_subdivision(subdivision_id, producto_id, cantidad):
        qty = int(cantidad or 0)
        if qty <= 0:
            return
        inventory_row = Inventario.objects.select_for_update().filter(
            subdivision_id=int(subdivision_id),
            producto_id=int(producto_id),
            referencia="",
        ).first()
        if inventory_row is None:
            return
        inventory_row.cantidad = max(0, int(inventory_row.cantidad or 0) - qty)
        inventory_row.save(update_fields=["cantidad"])

    def _ensure_solicitud_traslado_write_access(
        self,
        *,
        sucursal_solicitante_id,
        sucursal_proveedora_id,
        action_key,
    ):
        """
        Una solicitud de traslado la puede crear/editar/eliminar quien tenga
        permiso de escritura sobre CUALQUIERA de las dos sucursales
        involucradas: el lado solicitante (Entradas, el flujo original de
        "Pedido a sucursal") o el lado proveedor (Salidas, los traslados
        directos que ahora tambien se pueden guardar como borrador). Se
        intenta el lado solicitante primero -- es el caso mas comun -- y
        solo se propaga el error si tampoco pasa por el lado proveedor.
        """
        try:
            ensure_sucursal_allowed_for_modules(
                self.request.user,
                [RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
                sucursal_solicitante_id,
                field_label="sucursal solicitante",
                action_key=action_key,
            )
            return
        except PermissionDenied:
            pass
        ensure_sucursal_allowed_for_modules(
            self.request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_SALIDAS],
            sucursal_proveedora_id,
            field_label="sucursal proveedora",
            action_key=action_key,
        )

    @action(detail=False, methods=["get", "post"], url_path="solicitudes-traslado")
    def solicitudes_traslado(self, request):
        if request.method.lower() == "post":
            guardar_borrador = bool(request.data.get("guardar_borrador"))
            serializer = SolicitudTrasladoSerializer(
                data=request.data,
                context={"is_borrador": guardar_borrador},
            )
            serializer.is_valid(raise_exception=True)
            reminder_recipient_ids = serializer.validated_data.get("recordatorio_destinatario_ids") or []

            sucursal_solicitante = serializer.validated_data.get("sucursal_solicitante")
            sucursal_proveedora = serializer.validated_data.get("sucursal_proveedora")
            self._ensure_solicitud_traslado_write_access(
                sucursal_solicitante_id=getattr(sucursal_solicitante, "id", None),
                sucursal_proveedora_id=getattr(sucursal_proveedora, "id", None),
                action_key="puede_crear",
            )

            estado = (
                SolicitudTraslado.Estados.GUARDADO
                if guardar_borrador
                else SolicitudTraslado.Estados.PENDIENTE
            )
            solicitud = serializer.save(creado_por=request.user, estado=estado)
            if not guardar_borrador:
                self._append_transfer_request_reminder(
                    solicitud=solicitud,
                    actor_user=request.user,
                    selected_user_ids=reminder_recipient_ids,
                )
            output = SolicitudTrasladoSerializer(instance=solicitud)
            return Response(output.data, status=status.HTTP_201_CREATED)

        queryset = (
            SolicitudTraslado.objects.select_related(
                "sucursal_solicitante",
                "sucursal_proveedora",
                "movimiento_salida",
                "movimiento_entrada",
                "creado_por",
                "enviado_por",
                "rechazada_por",
                "recibido_por",
            )
            .prefetch_related("detalles__producto")
            .order_by("-fecha", "-id")
        )

        raw_estado = (
            request.query_params.get("estado") or SolicitudTraslado.Estados.PENDIENTE
        )
        estado = str(raw_estado).strip().lower()
        allowed_states = {choice[0] for choice in SolicitudTraslado.Estados.choices}
        if estado in allowed_states:
            queryset = queryset.filter(estado=estado)

        if estado == SolicitudTraslado.Estados.APROBADA:
            queryset = queryset.filter(movimiento_salida_id__isnull=True)

        sucursal_proveedora_raw = (
            request.query_params.get("sucursal_proveedora_id") or ""
        ).strip()
        if sucursal_proveedora_raw:
            if not sucursal_proveedora_raw.isdigit():
                return Response(
                    {"detail": "Debes enviar un sucursal_proveedora_id valido."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            sucursal_proveedora_id = int(sucursal_proveedora_raw)
            ensure_sucursal_allowed_for_modules(
                request.user,
                [RolPermiso.Modulos.MOVIMIENTOS_SALIDAS],
                sucursal_proveedora_id,
                field_label="sucursal proveedora",
                action_key="puede_leer",
            )
            queryset = queryset.filter(sucursal_proveedora_id=sucursal_proveedora_id)
        else:
            allowed = get_readable_sucursal_ids(
                request.user,
                RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
            )
            if allowed is not None:
                if not allowed:
                    queryset = queryset.none()
                else:
                    queryset = queryset.filter(sucursal_proveedora_id__in=sorted(allowed))

        sucursal_solicitante_raw = (
            request.query_params.get("sucursal_solicitante_id") or ""
        ).strip()
        if sucursal_solicitante_raw:
            if not sucursal_solicitante_raw.isdigit():
                return Response(
                    {"detail": "Debes enviar un sucursal_solicitante_id valido."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            queryset = queryset.filter(sucursal_solicitante_id=int(sucursal_solicitante_raw))

        page = self.paginate_queryset(queryset)
        rows = page if page is not None else list(queryset)
        # Lo que antes se consultaba por fila/detalle se calcula una vez.
        serializer = SolicitudTrasladoSerializer(
            rows, many=True, context=build_solicitud_traslado_list_context(rows)
        )
        if page is not None:
            return self.get_paginated_response(serializer.data)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @action(
        detail=False,
        methods=["get", "put", "delete"],
        url_path=r"solicitudes-traslado/(?P<solicitud_id>\d+)",
    )
    def actualizar_solicitud_traslado(self, request, solicitud_id=None):
        solicitud = self._get_solicitud_traslado(solicitud_id)
        if solicitud is None:
            return Response(
                {"detail": "No se encontro la solicitud de traslado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        if request.method.upper() == "GET":
            try:
                ensure_sucursal_allowed_for_modules(
                    request.user,
                    [RolPermiso.Modulos.MOVIMIENTOS_SALIDAS, RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
                    solicitud.sucursal_proveedora_id,
                    field_label="sucursal proveedora",
                    action_key="puede_leer",
                )
            except PermissionDenied:
                ensure_sucursal_allowed_for_modules(
                    request.user,
                    [RolPermiso.Modulos.MOVIMIENTOS_SALIDAS, RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
                    solicitud.sucursal_solicitante_id,
                    field_label="sucursal solicitante",
                    action_key="puede_leer",
                )
            serializer = SolicitudTrasladoSerializer(instance=solicitud)
            return Response(serializer.data, status=status.HTTP_200_OK)

        self._ensure_solicitud_traslado_write_access(
            sucursal_solicitante_id=solicitud.sucursal_solicitante_id,
            sucursal_proveedora_id=solicitud.sucursal_proveedora_id,
            action_key="puede_actualizar",
        )

        if request.method.upper() != "DELETE" and solicitud.estado not in {
            SolicitudTraslado.Estados.GUARDADO,
            SolicitudTraslado.Estados.PENDIENTE,
            SolicitudTraslado.Estados.CANCELADA,
        }:
            return Response(
                {
                    "detail": (
                        "Solo se pueden editar solicitudes guardadas, pendientes o rechazadas de traslado."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        if request.method.upper() != "DELETE" and (
            solicitud.movimiento_salida_id or solicitud.movimiento_entrada_id
        ):
            return Response(
                {
                    "detail": (
                        "La solicitud ya fue procesada y no puede modificarse."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        solicitud_token = str(solicitud.id or "")
        if request.method.upper() == "DELETE":
            self._ensure_solicitud_traslado_write_access(
                sucursal_solicitante_id=solicitud.sucursal_solicitante_id,
                sucursal_proveedora_id=solicitud.sucursal_proveedora_id,
                action_key="puede_eliminar",
            )
            if solicitud.estado not in {
                SolicitudTraslado.Estados.GUARDADO,
                SolicitudTraslado.Estados.PENDIENTE,
            }:
                return Response(
                    {"detail": "Solo se pueden eliminar solicitudes de traslado guardadas o pendientes."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            entrada_movimiento = getattr(solicitud, "movimiento_entrada", None)
            salida_movimiento = getattr(solicitud, "movimiento_salida", None)
            with transaction.atomic():
                if salida_movimiento is not None:
                    salida_movimiento.delete()
                if entrada_movimiento is not None:
                    entrada_movimiento.delete()
                solicitud.delete()
            _purge_reminders_for_context("solicitud_traslado", solicitud_token)
            return Response(status=status.HTTP_204_NO_CONTENT)

        guardar_borrador = bool(request.data.get("guardar_borrador"))
        was_borrador = solicitud.estado == SolicitudTraslado.Estados.GUARDADO
        serializer = SolicitudTrasladoSerializer(
            instance=solicitud,
            data=request.data,
            partial=True,
            context={"is_borrador": guardar_borrador},
        )
        serializer.is_valid(raise_exception=True)
        reminder_recipient_ids = serializer.validated_data.get("recordatorio_destinatario_ids") or []
        save_kwargs = {}
        is_finalizing = was_borrador and not guardar_borrador
        if is_finalizing:
            save_kwargs["estado"] = SolicitudTraslado.Estados.PENDIENTE
        updated = serializer.save(**save_kwargs)
        if is_finalizing:
            self._append_transfer_request_reminder(
                solicitud=updated,
                actor_user=request.user,
                selected_user_ids=reminder_recipient_ids,
            )
        output = SolicitudTrasladoSerializer(instance=updated)
        return Response(output.data, status=status.HTTP_200_OK)

    @action(
        detail=False,
        methods=["get"],
        url_path="sucursales-traslado-proveedoras",
    )
    def sucursales_traslado_proveedoras(self, request):
        """
        Lista sucursales proveedoras para solicitudes de traslado.
        Este endpoint no aplica alcance por sucursal para permitir solicitar
        a cualquier sucursal distinta de la propia.
        """
        exclude_id_raw = (
            request.query_params.get("sucursal_solicitante_id")
            or request.query_params.get("exclude_id")
            or ""
        ).strip()

        queryset = Sucursal.objects.all().order_by("nombre", "id")
        if exclude_id_raw:
            if not exclude_id_raw.isdigit():
                return Response(
                    {"detail": "Debes enviar un sucursal_solicitante_id valido."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            queryset = queryset.exclude(id=int(exclude_id_raw))

        payload = [
            {
                "id": int(branch.id),
                "nombre": str(branch.nombre or "").strip(),
                "direccion": str(branch.direccion or "").strip(),
            }
            for branch in queryset
        ]
        return Response(payload, status=status.HTTP_200_OK)

    @action(
        detail=False,
        methods=["get"],
        url_path=r"solicitudes-traslado/(?P<solicitud_id>\d+)",
    )
    def detalle_solicitud_traslado(self, request, solicitud_id=None):
        solicitud = self._get_solicitud_traslado(solicitud_id)
        if solicitud is None:
            return Response(
                {"detail": "No se encontro la solicitud de traslado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        ensure_sucursal_allowed_for_modules(
            request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_SALIDAS],
            solicitud.sucursal_proveedora_id,
            field_label="sucursal proveedora",
            action_key="puede_leer",
        )

        serializer = SolicitudTrasladoSerializer(instance=solicitud)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @action(
        detail=False,
        methods=["post"],
        url_path=r"solicitudes-traslado/(?P<solicitud_id>\d+)/decision",
    )
    def decision_solicitud_traslado(self, request, solicitud_id=None):
        solicitud = self._get_solicitud_traslado(solicitud_id)
        if solicitud is None:
            return Response(
                {"detail": "No se encontro la solicitud de traslado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        ensure_sucursal_allowed_for_modules(
            request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_SALIDAS],
            solicitud.sucursal_proveedora_id,
            field_label="sucursal proveedora",
            action_key=("puede_crear", "puede_actualizar"),
        )

        allowed_recipient_ids = self._get_transfer_decision_reminder_recipient_ids(solicitud.id)
        if allowed_recipient_ids and not is_app_admin(request.user):
            current_user_id = str(getattr(request.user, "id", "") or "").strip()
            if not current_user_id or current_user_id not in allowed_recipient_ids:
                return Response(
                    {
                        "detail": (
                            "Solo el usuario asignado al recordatorio puede resolver esta solicitud."
                        )
                    },
                    status=status.HTTP_403_FORBIDDEN,
                )

        if solicitud.estado != SolicitudTraslado.Estados.PENDIENTE:
            return Response(
                {
                    "detail": (
                        "La solicitud ya fue procesada y no admite nuevas decisiones."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        decision = str(request.data.get("decision") or "").strip().lower()
        if decision in {"aceptar", "aprobar", "aprobada", "approve", "approved"}:
            pendientes = solicitud.detalles.filter(verificado=False, no_enviar=False).count()
            if pendientes:
                return Response(
                    {
                        "detail": (
                            "Debes marcar cada producto como separado o como rechazado "
                            "antes de aceptar la solicitud."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if solicitud.detalles.filter(no_enviar=True, motivo_no_envio="").exists():
                return Response(
                    {"detail": "Cada producto rechazado debe tener un motivo."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if not solicitud.detalles.filter(no_enviar=False).exists():
                # Todos los productos rechazados: se rechaza la solicitud con
                # el motivo de cada uno.
                return self._reject_transfer_by_products(request, solicitud)
            with transaction.atomic():
                solicitud_locked = (
                    SolicitudTraslado.objects.select_for_update(of=("self",))
                    .select_related(
                        "sucursal_solicitante",
                        "sucursal_proveedora",
                    )
                    .prefetch_related("detalles__producto")
                    .filter(pk=solicitud.id)
                    .first()
                )
                if solicitud_locked is None:
                    return Response(
                        {"detail": "No se encontro la solicitud de traslado."},
                        status=status.HTTP_404_NOT_FOUND,
                    )

                if solicitud_locked.estado != SolicitudTraslado.Estados.PENDIENTE:
                    return Response(
                        {
                            "detail": (
                                "La solicitud ya fue procesada y no admite nuevas decisiones."
                            )
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                todos_detalles = list(solicitud_locked.detalles.select_related("producto").all())
                if any(
                    not detalle.verificado and not detalle.no_enviar for detalle in todos_detalles
                ) or all(detalle.no_enviar for detalle in todos_detalles):
                    return Response(
                        {"detail": "La solicitud cambio mientras se aceptaba. Vuelve a revisarla."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                detalles = [detalle for detalle in todos_detalles if not detalle.no_enviar]
                no_enviados = [detalle for detalle in todos_detalles if detalle.no_enviar]
                product_ids = sorted(
                    {
                        int(getattr(detalle, "producto_id", 0) or 0)
                        for detalle in detalles
                        if int(getattr(detalle, "producto_id", 0) or 0) > 0
                    }
                )

                if product_ids:
                    # Bloquea filas de inventario para serializar aceptaciones concurrentes.
                    list(
                        Inventario.objects.select_for_update()
                        .filter(
                            subdivision__division__bodega__sucursal_id=solicitud_locked.sucursal_proveedora_id,
                            producto_id__in=product_ids,
                        )
                        .values_list("id", flat=True)
                    )

                    available_by_product = get_available_transfer_quantities_by_product(
                        sucursal_id=solicitud_locked.sucursal_proveedora_id,
                        product_ids=product_ids,
                        exclude_solicitud_id=solicitud_locked.id,
                    )

                shortage = None
                for detalle in detalles:
                    product_id = int(getattr(detalle, "producto_id", 0) or 0)
                    if product_id <= 0:
                        continue
                    required = int(getattr(detalle, "cantidad", 0) or 0)
                    available = int(available_by_product.get(product_id, 0) or 0)
                    if required <= available:
                        continue

                    producto = getattr(detalle, "producto", None)
                    codigo = str(getattr(producto, "codigo", "") or "").strip()
                    label = codigo or f"ID {product_id}"
                    shortage = {
                        "producto_label": label,
                        "available": available,
                        "required": required,
                    }
                    break

                if shortage:
                    motivo_rechazo = "Cantidades cambiaron y no se puede hacer este traslado."
                    solicitud_locked.estado = SolicitudTraslado.Estados.CANCELADA
                    solicitud_locked.motivo_rechazo = motivo_rechazo
                    solicitud_locked.rechazada_por = request.user
                    solicitud_locked.rechazada_en = timezone.now()
                    solicitud_locked.save(
                        update_fields=[
                            "estado",
                            "motivo_rechazo",
                            "rechazada_por",
                            "rechazada_en",
                            "updated_at",
                        ]
                    )

                    output = SolicitudTrasladoSerializer(instance=solicitud_locked)
                    detail_text = (
                        f"No se pudo aceptar la solicitud porque el stock cambió "
                        f"para '{shortage['producto_label']}'. Disponible: {shortage['available']}."
                    )
                    self._append_transfer_decision_result_reminder(
                        solicitud=solicitud_locked,
                        actor_user=request.user,
                        decision_status="rechazada",
                        rejection_reason=motivo_rechazo,
                    )
                    return Response(
                        {
                            "detail": detail_text,
                            "decision": "rechazada",
                            "solicitud": output.data,
                            "motivo_rechazo": motivo_rechazo,
                        },
                        status=status.HTTP_200_OK,
                    )

                # Aceptacion parcial: lo no enviado sale de la solicitud (asi la
                # salida, la entrada y la recepcion solo ven lo que si viaja) y
                # queda registrado con su motivo en detalles_no_enviados.
                if no_enviados:
                    solicitud_locked.detalles_no_enviados = [
                        *(solicitud_locked.detalles_no_enviados or []),
                        *[
                            {
                                "producto_id": int(detalle.producto_id),
                                "producto_codigo": str(getattr(detalle.producto, "codigo", "") or ""),
                                "producto_nombre": str(getattr(detalle.producto, "nombre", "") or ""),
                                "cantidad": int(detalle.cantidad or 0),
                                "motivo": detalle.motivo_no_envio,
                                "motivo_tipo": detalle.motivo_no_envio_tipo,
                                "conteo": detalle.conteo_no_envio or [],
                            }
                            for detalle in no_enviados
                        ],
                    ]
                    SolicitudTrasladoDetalle.objects.filter(
                        id__in=[detalle.id for detalle in no_enviados]
                    ).delete()

                solicitud_locked.estado = SolicitudTraslado.Estados.APROBADA
                solicitud_locked.motivo_rechazo = ""
                solicitud_locked.rechazada_por = None
                solicitud_locked.rechazada_en = None
                solicitud_locked.enviado_por = request.user
                solicitud_locked.save(
                    update_fields=[
                        "estado",
                        "motivo_rechazo",
                        "rechazada_por",
                        "rechazada_en",
                        "enviado_por",
                        "detalles_no_enviados",
                        "updated_at",
                    ]
                )

            self._register_transfer_reject_counts(request.user, solicitud_locked, no_enviados)
            no_enviados_texto = "; ".join(
                f"{item.get('producto_codigo') or item.get('producto_nombre')} "
                f"x{item.get('cantidad')} ({item.get('motivo')})"
                for item in (
                    solicitud_locked.detalles_no_enviados[-len(no_enviados):] if no_enviados else []
                )
            )
            self._append_transfer_decision_result_reminder(
                solicitud=solicitud_locked,
                actor_user=request.user,
                decision_status="aceptada",
                rejection_reason=no_enviados_texto,
            )
            # Recarga: el prefetch de solicitud_locked aun trae los detalles borrados.
            output = SolicitudTrasladoSerializer(
                instance=self._get_solicitud_traslado(solicitud_locked.id) or solicitud_locked
            )
            return Response(
                {
                    "detail": "Solicitud aceptada correctamente.",
                    "decision": "aceptada",
                    "solicitud": output.data,
                    "next_action": {
                        "type": "crear_salida",
                        "solicitud_id": int(solicitud_locked.id),
                        "sucursal_proveedora_id": int(solicitud_locked.sucursal_proveedora_id),
                    },
                },
                status=status.HTTP_200_OK,
            )

        if decision in {"rechazar", "rechazada", "reject", "rejected"}:
            motivo = str(request.data.get("motivo") or "").strip()
            if not motivo:
                return Response(
                    {"motivo": "Debes indicar un motivo para rechazar la solicitud."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            solicitud.estado = SolicitudTraslado.Estados.CANCELADA
            solicitud.motivo_rechazo = motivo
            solicitud.rechazada_por = request.user
            solicitud.rechazada_en = timezone.now()
            solicitud.save(
                update_fields=[
                    "estado",
                    "motivo_rechazo",
                    "rechazada_por",
                    "rechazada_en",
                    "updated_at",
                ]
            )

            self._append_transfer_decision_result_reminder(
                solicitud=solicitud,
                actor_user=request.user,
                decision_status="rechazada",
                rejection_reason=motivo,
            )
            output = SolicitudTrasladoSerializer(instance=solicitud)
            return Response(
                {
                    "detail": "Solicitud rechazada correctamente.",
                    "decision": "rechazada",
                    "solicitud": output.data,
                },
                status=status.HTTP_200_OK,
            )

        return Response(
            {"detail": "Debes enviar una decision valida (aceptar o rechazar)."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    def _find_pending_transfer_decisions_for_user(self, usuario_id):
        usuario_token = str(usuario_id or "").strip()
        if not usuario_token:
            return []
        store = ReminderState.get_global()
        payload = store.payload if isinstance(store.payload, list) else []
        solicitud_ids = []
        for reminder in payload:
            if not isinstance(reminder, dict):
                continue
            context = reminder.get("context") if isinstance(reminder.get("context"), dict) else {}
            if self._normalize_reminder_context_type(context.get("type")) != "solicitud_traslado":
                continue
            decision = reminder.get("decision") if isinstance(reminder.get("decision"), dict) else {}
            if str(decision.get("status") or "").strip().lower() != "pendiente":
                continue
            assigned = decision.get("assignedRecipients")
            assigned = assigned if isinstance(assigned, list) else []
            assigned_ids = {
                str((r or {}).get("id") or "").strip() for r in assigned if isinstance(r, dict)
            }
            if usuario_token not in assigned_ids:
                continue
            solicitud_id_raw = str(context.get("id") or "").strip()
            if solicitud_id_raw.isdigit():
                solicitud_ids.append(int(solicitud_id_raw))
        return solicitud_ids

    @action(
        detail=False,
        methods=["get"],
        url_path="solicitudes-traslado/decisiones-pendientes-usuario",
    )
    def decisiones_pendientes_usuario(self, request):
        # Solo para el panel de administracion de usuarios: al admin le
        # interesa saber si, antes de quitarle un permiso a alguien, esa
        # persona tiene decisiones de traslado pendientes que se quedarian
        # sin poder resolver.
        if not is_app_admin(request.user):
            raise PermissionDenied("Solo un administrador puede consultar esto.")

        usuario_id = request.query_params.get("usuario_id")
        solicitud_ids = self._find_pending_transfer_decisions_for_user(usuario_id)
        if not solicitud_ids:
            return Response([])

        solicitudes = SolicitudTraslado.objects.filter(id__in=solicitud_ids).select_related(
            "sucursal_solicitante", "sucursal_proveedora"
        )
        candidatos_por_sucursal = {}
        output = []
        for solicitud in solicitudes:
            proveedora_id = solicitud.sucursal_proveedora_id
            if proveedora_id not in candidatos_por_sucursal:
                candidatos_por_sucursal[proveedora_id] = [
                    candidate
                    for candidate in self._resolve_transfer_provider_recipients(proveedora_id)
                    if str(candidate.get("id") or "").strip() != str(usuario_id or "").strip()
                ]
            output.append(
                {
                    "solicitud_id": solicitud.id,
                    "no_documento": solicitud.no_documento,
                    "sucursal_proveedora_id": proveedora_id,
                    "sucursal_proveedora_nombre": solicitud.sucursal_proveedora.nombre,
                    "sucursal_solicitante_nombre": solicitud.sucursal_solicitante.nombre,
                    "candidatos": candidatos_por_sucursal[proveedora_id],
                }
            )
        return Response(output)

    @action(
        detail=False,
        methods=["post"],
        url_path=r"solicitudes-traslado/(?P<solicitud_id>\d+)/reasignar-destinatario",
    )
    def reasignar_destinatario_traslado(self, request, solicitud_id=None):
        # Reemplaza a un usuario por otro como responsable de decidir una
        # solicitud de traslado puntual -- se usa desde el panel de usuarios
        # cuando a alguien se le va a quitar un permiso y tiene decisiones
        # pendientes ahi, para no dejarlo en un recordatorio sin salida.
        if not is_app_admin(request.user):
            raise PermissionDenied("Solo un administrador puede reasignar destinatarios.")

        solicitud = self._get_solicitud_traslado(solicitud_id)
        if solicitud is None:
            return Response(
                {"detail": "No se encontro la solicitud de traslado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        from_usuario_id = str(request.data.get("from_usuario_id") or "").strip()
        to_usuario_id = str(request.data.get("to_usuario_id") or "").strip()
        if not from_usuario_id or not to_usuario_id:
            return Response(
                {"detail": "Debes indicar from_usuario_id y to_usuario_id."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        User = get_user_model()
        to_user = User.objects.filter(pk=to_usuario_id, is_active=True).first()
        if to_user is None:
            return Response(
                {"detail": "El usuario de reemplazo no existe o esta inactivo."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            ensure_sucursal_allowed_for_modules(
                to_user,
                [RolPermiso.Modulos.MOVIMIENTOS_SALIDAS],
                solicitud.sucursal_proveedora_id,
                field_label="sucursal proveedora",
                action_key="puede_actualizar",
            )
        except PermissionDenied:
            return Response(
                {
                    "detail": (
                        "El usuario de reemplazo no tiene permiso de Salidas en la "
                        "sucursal proveedora de esta solicitud."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        to_recipient = self._normalize_reminder_recipient(to_user)
        solicitud_token = str(solicitud.id)
        changed = False

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            payload = store.payload if isinstance(store.payload, list) else []
            for reminder in payload:
                if not isinstance(reminder, dict):
                    continue
                context = reminder.get("context") if isinstance(reminder.get("context"), dict) else {}
                if self._normalize_reminder_context_type(context.get("type")) != "solicitud_traslado":
                    continue
                if str(context.get("id") or "").strip() != solicitud_token:
                    continue

                recipients = reminder.get("recipients") if isinstance(reminder.get("recipients"), list) else []
                recipients = [
                    r for r in recipients if str((r or {}).get("id") or "").strip() != from_usuario_id
                ]
                if to_recipient and not any(
                    str((r or {}).get("id") or "").strip() == to_usuario_id for r in recipients
                ):
                    recipients.append(to_recipient)
                reminder["recipients"] = recipients

                decision = reminder.get("decision") if isinstance(reminder.get("decision"), dict) else {}
                assigned = decision.get("assignedRecipients")
                assigned = assigned if isinstance(assigned, list) else []
                had_from = any(
                    str((r or {}).get("id") or "").strip() == from_usuario_id for r in assigned
                )
                assigned = [
                    r for r in assigned if str((r or {}).get("id") or "").strip() != from_usuario_id
                ]
                if had_from and to_recipient and not any(
                    str((r or {}).get("id") or "").strip() == to_usuario_id for r in assigned
                ):
                    assigned.append(to_recipient)
                decision["assignedRecipients"] = assigned
                reminder["decision"] = decision
                changed = True

            if changed:
                store.payload = payload
                store.save(update_fields=["payload", "updated_at"])

        if not changed:
            return Response(
                {"detail": "No se encontro un recordatorio de decision para esta solicitud."},
                status=status.HTTP_404_NOT_FOUND,
            )

        return Response({"detail": "Destinatario reasignado correctamente."}, status=status.HTTP_200_OK)

    def _register_transfer_reject_counts(self, user, solicitud, detalles):
        """Cada producto rechazado con "No tengo" deja su conteo como revision
        de inventario de la sucursal proveedora. Va despues de la decision y
        fuera de su transaccion: un fallo aqui no deshace la decision."""
        transfer_doc = str(getattr(solicitud, "no_documento", "") or "").strip()
        transfer_reference = f"#{transfer_doc}" if transfer_doc else f"#{int(solicitud.id)}"
        for detalle in detalles:
            if detalle.motivo_no_envio_tipo != "no_tengo":
                continue
            try:
                registrar_conteo_por_traslado(
                    user=user,
                    sucursal_id=solicitud.sucursal_proveedora_id,
                    producto_id=detalle.producto_id,
                    conteo=detalle.conteo_no_envio or [],
                    observacion=f"Traslado {transfer_reference}: {detalle.motivo_no_envio}",
                    origen=f"traslado {transfer_reference}",
                )
            except Exception:
                logger.exception(
                    "No se pudo registrar el conteo del producto %s rechazado en el traslado %s",
                    detalle.producto_id,
                    solicitud.id,
                )

    def _reject_transfer_by_products(self, request, solicitud):
        with transaction.atomic():
            solicitud_locked = (
                SolicitudTraslado.objects.select_for_update(of=("self",))
                .prefetch_related("detalles__producto")
                .filter(pk=solicitud.id)
                .first()
            )
            detalles = list(solicitud_locked.detalles.all()) if solicitud_locked else []
            if (
                solicitud_locked is None
                or solicitud_locked.estado != SolicitudTraslado.Estados.PENDIENTE
                or not detalles
                or not all(detalle.no_enviar and detalle.motivo_no_envio for detalle in detalles)
            ):
                return Response(
                    {"detail": "La solicitud cambio mientras se rechazaba. Vuelve a revisarla."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            motivo = "; ".join(
                f"{getattr(detalle.producto, 'codigo', '') or getattr(detalle.producto, 'nombre', '')} "
                f"x{int(detalle.cantidad or 0)} ({detalle.motivo_no_envio})"
                for detalle in detalles
            )
            solicitud_locked.estado = SolicitudTraslado.Estados.CANCELADA
            solicitud_locked.motivo_rechazo = motivo
            solicitud_locked.rechazada_por = request.user
            solicitud_locked.rechazada_en = timezone.now()
            solicitud_locked.save(
                update_fields=[
                    "estado",
                    "motivo_rechazo",
                    "rechazada_por",
                    "rechazada_en",
                    "updated_at",
                ]
            )

        self._register_transfer_reject_counts(request.user, solicitud_locked, detalles)
        self._append_transfer_decision_result_reminder(
            solicitud=solicitud_locked,
            actor_user=request.user,
            decision_status="rechazada",
            rejection_reason=motivo,
        )
        output = SolicitudTrasladoSerializer(instance=solicitud_locked)
        return Response(
            {
                "detail": "Solicitud rechazada correctamente.",
                "decision": "rechazada",
                "solicitud": output.data,
            },
            status=status.HTTP_200_OK,
        )

    def _parse_transfer_reject_count(self, raw_value, sucursal_id):
        """Conteo de "No tengo": [{subdivision_id, cantidad}] de la sucursal
        proveedora. Vacio = no hay nada (cuenta 0 en todas las ubicaciones)."""
        if raw_value in (None, ""):
            raw_value = []
        if not isinstance(raw_value, list):
            return [], "El conteo debe ser una lista de ubicaciones con su cantidad."
        cantidades = {}
        for entry in raw_value[:100]:
            if not isinstance(entry, dict):
                continue
            try:
                subdivision_id = int(entry.get("subdivision_id") or 0)
                cantidad = int(str(entry.get("cantidad") if entry.get("cantidad") is not None else "").strip() or 0)
            except (TypeError, ValueError):
                return [], "Cada ubicacion debe tener una cantidad valida."
            if subdivision_id <= 0:
                return [], "Escoge la ubicacion de cada cantidad."
            if cantidad < 0:
                return [], "Las cantidades no pueden ser negativas."
            cantidades[subdivision_id] = cantidades.get(subdivision_id, 0) + cantidad
        if not cantidades:
            return [], None
        subdivisiones = {
            int(subdivision.id): subdivision
            for subdivision in SubDivision.objects.select_related("division__bodega").filter(
                id__in=list(cantidades),
                division__bodega__sucursal_id=sucursal_id,
            )
        }
        if len(subdivisiones) != len(cantidades):
            return [], "Alguna ubicacion no pertenece a la sucursal proveedora."
        conteo = []
        for subdivision_id, cantidad in cantidades.items():
            subdivision = subdivisiones[subdivision_id]
            conteo.append(
                {
                    "subdivision_id": subdivision_id,
                    "cantidad": cantidad,
                    "ubicacion": " / ".join(
                        part
                        for part in (
                            subdivision.division.bodega.nombre,
                            subdivision.division.nombre,
                            subdivision.nombre,
                        )
                        if part
                    ),
                }
            )
        return conteo, None

    def _build_transfer_reject_reason(self, motivo_tipo, nota, conteo):
        """Texto del motivo que ve quien pidio el traslado."""
        if motivo_tipo == "no_tengo":
            total = sum(int(entry.get("cantidad") or 0) for entry in conteo)
            donde = ", ".join(
                f"{entry.get('cantidad')} en {entry.get('ubicacion')}"
                for entry in conteo
                if int(entry.get("cantidad") or 0) > 0
            )
            texto = f"No tengo: hay {total}" + (f" ({donde})" if donde else "")
        elif motivo_tipo == "vendido":
            texto = "Ya lo vendí (por facturar)"
        else:
            return nota
        return f"{texto}. {nota}" if nota else texto

    @action(
        detail=False,
        methods=["patch"],
        url_path=r"solicitudes-traslado/(?P<solicitud_id>\d+)/detalles/(?P<detalle_id>\d+)/verificar",
    )
    def verificar_detalle_solicitud_traslado(self, request, solicitud_id=None, detalle_id=None):
        solicitud = self._get_solicitud_traslado(solicitud_id)
        if solicitud is None:
            return Response(
                {"detail": "No se encontro la solicitud de traslado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        ensure_sucursal_allowed_for_modules(
            request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_SALIDAS],
            solicitud.sucursal_proveedora_id,
            field_label="sucursal proveedora",
            action_key=("puede_crear", "puede_actualizar"),
        )

        allowed_recipient_ids = self._get_transfer_decision_reminder_recipient_ids(solicitud.id)
        if allowed_recipient_ids and not is_app_admin(request.user):
            current_user_id = str(getattr(request.user, "id", "") or "").strip()
            if not current_user_id or current_user_id not in allowed_recipient_ids:
                return Response(
                    {
                        "detail": (
                            "Solo el usuario asignado al recordatorio puede modificar esta solicitud."
                        )
                    },
                    status=status.HTTP_403_FORBIDDEN,
                )

        if solicitud.estado != SolicitudTraslado.Estados.PENDIENTE:
            return Response(
                {"detail": "La solicitud ya fue procesada y no admite cambios."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        detalle = solicitud.detalles.filter(pk=detalle_id).first()
        if detalle is None:
            return Response(
                {"detail": "No se encontro el detalle indicado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        # `estado`: "separado" | "no_enviar" | "" (sin marcar). Son excluyentes:
        # un producto se separa para enviarlo o se marca que no se envia, con
        # motivo obligatorio. Se mantiene `verificado` por compatibilidad.
        if "estado" in request.data:
            estado = str(request.data.get("estado") or "").strip().lower()
            if estado not in {"", "separado", "no_enviar"}:
                return Response(
                    {"detail": "Estado invalido. Usa separado, no_enviar o vacio."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        else:
            estado = "separado" if bool(request.data.get("verificado")) else ""

        motivo_tipo = ""
        nota = str(request.data.get("motivo") or "").strip()
        conteo = []
        motivo = ""
        if estado == "no_enviar":
            motivo_tipo = str(request.data.get("motivo_tipo") or "").strip().lower()
            if motivo_tipo not in TRANSFER_REJECT_REASONS:
                return Response(
                    {"motivo": "Escoge por que se rechaza: No tengo, Ya lo vendí u Otro."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if motivo_tipo == "otro" and not nota:
                return Response(
                    {"motivo": "Escribe por que se rechaza este producto."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if motivo_tipo == "no_tengo":
                conteo, error = self._parse_transfer_reject_count(
                    request.data.get("conteo"), solicitud.sucursal_proveedora_id
                )
                if error:
                    return Response({"conteo": error}, status=status.HTTP_400_BAD_REQUEST)
            motivo = self._build_transfer_reject_reason(motivo_tipo, nota, conteo)

        detalle.verificado = estado == "separado"
        detalle.no_enviar = estado == "no_enviar"
        detalle.motivo_no_envio = motivo
        detalle.motivo_no_envio_tipo = motivo_tipo
        detalle.conteo_no_envio = conteo
        detalle.save(
            update_fields=[
                "verificado",
                "no_enviar",
                "motivo_no_envio",
                "motivo_no_envio_tipo",
                "conteo_no_envio",
            ]
        )

        return Response(
            {
                "id": detalle.id,
                "verificado": detalle.verificado,
                "no_enviar": detalle.no_enviar,
                "motivo_no_envio_tipo": detalle.motivo_no_envio_tipo,
                "conteo_no_envio": detalle.conteo_no_envio,
                "motivo_no_envio": detalle.motivo_no_envio,
            },
            status=status.HTTP_200_OK,
        )

    @action(
        detail=False,
        methods=["get"],
        url_path=r"solicitudes-traslado/(?P<solicitud_id>\d+)/detalles/(?P<detalle_id>\d+)/ubicaciones",
    )
    def ubicaciones_detalle_solicitud_traslado(self, request, solicitud_id=None, detalle_id=None):
        # Todas las ubicaciones del producto en la sucursal proveedora (la
        # tabla de decision solo muestra la principal), para que quien
        # separa pueda buscarlo en las demas antes de rechazarlo. Con
        # `?conteo=1` (el "No tengo") no van las cantidades del sistema: quien
        # rechaza cuenta a ciegas; van todas las ubicaciones de la sucursal
        # para que diga donde esta lo que si hay.
        solicitud = self._get_solicitud_traslado(solicitud_id)
        if solicitud is None:
            return Response(
                {"detail": "No se encontro la solicitud de traslado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        ensure_sucursal_allowed_for_modules(
            request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_SALIDAS],
            solicitud.sucursal_proveedora_id,
            field_label="sucursal proveedora",
            action_key="puede_leer",
        )

        detalle = solicitud.detalles.select_related("producto").filter(pk=detalle_id).first()
        if detalle is None:
            return Response(
                {"detail": "No se encontro el detalle indicado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        rows = (
            Inventario.objects.filter(
                producto_id=detalle.producto_id,
                cantidad__gt=0,
                subdivision__division__bodega__sucursal_id=solicitud.sucursal_proveedora_id,
            )
            .select_related("subdivision__division__bodega")
        )
        # La principal primero (la misma que muestra la tabla).
        user_order = load_ubicacion_orden([detalle.producto_id])
        rows = sorted(rows, key=lambda row: principal_ubicacion_key(row, user_order))
        ubicaciones = []
        for inventario in rows:
            subdivision = inventario.subdivision
            division = subdivision.division
            bodega = division.bodega
            ubicaciones.append(
                {
                    "id": inventario.id,
                    "subdivision_id": subdivision.id,
                    "bodega": bodega.nombre,
                    "division": division.nombre,
                    "subdivision": subdivision.nombre,
                    "cantidad": int(inventario.cantidad or 0),
                    "bodega_layout": {
                        "id": bodega.id,
                        "nombre": bodega.nombre,
                        "ancho_metros": bodega.ancho_metros,
                        "alto_metros": bodega.alto_metros,
                        "ubicaciones": bodega.ubicaciones,
                    },
                }
            )

        if str(request.query_params.get("conteo") or "").strip() in {"1", "true"}:
            subdivisiones = (
                SubDivision.objects.filter(
                    division__bodega__sucursal_id=solicitud.sucursal_proveedora_id
                )
                .select_related("division__bodega")
                .order_by("division__bodega__nombre", "division__nombre", "nombre", "id")
            )
            return Response(
                {
                    "producto_id": detalle.producto_id,
                    "producto_codigo": detalle.producto.codigo,
                    "producto_nombre": detalle.producto.nombre,
                    "sucursal_proveedora": str(solicitud.sucursal_proveedora),
                    "ubicaciones": [
                        {key: value for key, value in item.items() if key != "cantidad"}
                        for item in ubicaciones
                    ],
                    # Bodega y division por separado: el conteo las escoge en
                    # cascada (Bodega -> Division -> Subdivision).
                    "ubicaciones_sucursal": [
                        {
                            "subdivision_id": subdivision.id,
                            "bodega_id": subdivision.division.bodega_id,
                            "bodega": subdivision.division.bodega.nombre,
                            "division_id": subdivision.division_id,
                            "division": subdivision.division.nombre,
                            "subdivision": subdivision.nombre,
                            "label": " / ".join(
                                part
                                for part in (
                                    subdivision.division.bodega.nombre,
                                    subdivision.division.nombre,
                                    subdivision.nombre,
                                )
                                if part
                            ),
                        }
                        for subdivision in subdivisiones
                    ],
                },
                status=status.HTTP_200_OK,
            )

        disponible = get_available_transfer_quantities_by_product(
            sucursal_id=solicitud.sucursal_proveedora_id,
            product_ids=[detalle.producto_id],
            exclude_solicitud_id=solicitud.id,
        ).get(detalle.producto_id, 0)

        return Response(
            {
                "producto_id": detalle.producto_id,
                "producto_codigo": detalle.producto.codigo,
                "producto_nombre": detalle.producto.nombre,
                "sucursal_proveedora": str(solicitud.sucursal_proveedora),
                "total": sum(item["cantidad"] for item in ubicaciones),
                "disponible": int(disponible or 0),
                "ubicaciones": ubicaciones,
            },
            status=status.HTTP_200_OK,
        )

    @action(
        detail=False,
        methods=["post"],
        url_path=r"solicitudes-traslado/(?P<solicitud_id>\d+)/cancelar-envio",
    )
    def cancelar_envio_solicitud_traslado(self, request, solicitud_id=None):
        solicitud = self._get_solicitud_traslado(solicitud_id)
        if solicitud is None:
            return Response(
                {"detail": "No se encontro la solicitud de traslado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        ensure_sucursal_allowed_for_modules(
            request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_SALIDAS],
            solicitud.sucursal_proveedora_id,
            field_label="sucursal proveedora",
            action_key="puede_actualizar",
        )

        if solicitud.estado != SolicitudTraslado.Estados.APROBADA:
            return Response(
                {
                    "detail": (
                        "Solo puedes cancelar una solicitud aceptada pendiente de envio."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        if solicitud.movimiento_salida_id or solicitud.movimiento_entrada_id:
            return Response(
                {
                    "detail": (
                        "La solicitud ya fue procesada y no puede cancelarse."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        motivo = str(request.data.get("motivo") or "").strip()
        if not motivo:
            return Response(
                {"motivo": "Debes indicar un motivo para cancelar el envio."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        solicitud.estado = SolicitudTraslado.Estados.CANCELADA
        solicitud.motivo_rechazo = motivo
        solicitud.rechazada_por = request.user
        solicitud.rechazada_en = timezone.now()
        solicitud.save(
            update_fields=[
                "estado",
                "motivo_rechazo",
                "rechazada_por",
                "rechazada_en",
                "updated_at",
            ]
        )

        self._append_transfer_decision_result_reminder(
            solicitud=solicitud,
            actor_user=request.user,
            decision_status="rechazada",
            rejection_reason=motivo,
        )

        output = SolicitudTrasladoSerializer(instance=solicitud)
        return Response(
            {
                "detail": "Envio cancelado correctamente.",
                "decision": "rechazada",
                "solicitud": output.data,
            },
            status=status.HTTP_200_OK,
        )

    @action(
        detail=False,
        methods=["post"],
        url_path=r"solicitudes-traslado/(?P<solicitud_id>\d+)/reabrir",
    )
    def reabrir_solicitud_traslado(self, request, solicitud_id=None):
        """Reabre una solicitud rechazada/cancelada, volviendo al estado pendiente."""
        solicitud = self._get_solicitud_traslado(solicitud_id)
        if solicitud is None:
            return Response(
                {"detail": "No se encontro la solicitud de traslado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        ensure_sucursal_allowed_for_modules(
            request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
            solicitud.sucursal_solicitante_id,
            field_label="sucursal solicitante",
            action_key="puede_actualizar",
        )

        if solicitud.estado != SolicitudTraslado.Estados.CANCELADA:
            return Response(
                {"detail": "Solo se pueden reabrir solicitudes rechazadas o canceladas."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if solicitud.movimiento_salida_id or solicitud.movimiento_entrada_id:
            return Response(
                {
                    "detail": (
                        "La solicitud ya fue procesada y no puede volver a realizarse."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        payload = request.data if isinstance(request.data, dict) else {}

        with transaction.atomic():
            solicitud_locked = (
                SolicitudTraslado.objects.select_for_update(of=("self",))
                .prefetch_related("detalles__producto")
                .filter(pk=solicitud.id)
                .first()
            )
            if solicitud_locked is None:
                return Response(
                    {"detail": "No se encontro la solicitud de traslado."},
                    status=status.HTTP_404_NOT_FOUND,
                )

            if solicitud_locked.estado != SolicitudTraslado.Estados.CANCELADA:
                return Response(
                    {"detail": "Solo se pueden reabrir solicitudes rechazadas o canceladas."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if payload:
                serializer = SolicitudTrasladoSerializer(
                    instance=solicitud_locked,
                    data=payload,
                    partial=True,
                )
                serializer.is_valid(raise_exception=True)
                solicitud_locked = serializer.save()

            solicitud_locked.estado = SolicitudTraslado.Estados.PENDIENTE
            solicitud_locked.motivo_rechazo = ""
            solicitud_locked.rechazada_por = None
            solicitud_locked.rechazada_en = None
            solicitud_locked.save(
                update_fields=[
                    "estado",
                    "motivo_rechazo",
                    "rechazada_por",
                    "rechazada_en",
                    "updated_at",
                ]
            )

        self._append_reopen_transfer_reminder(solicitud=solicitud_locked, actor_user=request.user)

        output = SolicitudTrasladoSerializer(instance=solicitud_locked)
        return Response(
            {
                "detail": "Solicitud reabierta correctamente.",
                "solicitud": output.data,
            },
            status=status.HTTP_200_OK,
        )

    @action(
        detail=False,
        methods=["post"],
        url_path=r"solicitudes-traslado/(?P<solicitud_id>\d+)/cancelar-pedido",
    )
    def cancelar_pedido_solicitud_traslado(self, request, solicitud_id=None):
        solicitud = self._get_solicitud_traslado(solicitud_id)
        if solicitud is None:
            return Response(
                {"detail": "No se encontro la solicitud de traslado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        ensure_sucursal_allowed_for_modules(
            request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
            solicitud.sucursal_solicitante_id,
            field_label="sucursal solicitante",
            action_key="puede_actualizar",
        )

        if solicitud.estado != SolicitudTraslado.Estados.CANCELADA:
            return Response(
                {
                    "detail": (
                        "Solo puedes cancelar pedidos que ya fueron rechazados o cancelados."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        if solicitud.movimiento_salida_id or solicitud.movimiento_entrada_id:
            return Response(
                {
                    "detail": (
                        "La solicitud ya fue procesada y no puede cancelarse."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        solicitud_id_str = str(int(solicitud.id))
        with transaction.atomic():
            solicitud.delete()
        _purge_reminders_for_context("solicitud_traslado", solicitud_id_str)

        return Response(
            {"detail": "Pedido eliminado correctamente."},
            status=status.HTTP_200_OK,
        )

    def _append_reopen_transfer_reminder(self, *, solicitud, actor_user):
        """Actualiza el recordatorio de traslado a estado pendiente al reabrir."""
        if solicitud is None:
            return False

        solicitud_id = int(getattr(solicitud, "id", 0) or 0)
        if solicitud_id <= 0:
            return False

        actor_recipient = self._normalize_reminder_recipient(actor_user) or {
            "id": "system",
            "name": "Sistema",
        }
        transfer_doc = str(getattr(solicitud, "no_documento", "") or "").strip()
        transfer_reference = f"#{transfer_doc}" if transfer_doc else f"#{solicitud_id}"
        context_label = f"Solicitud de traslado {transfer_reference}"
        now = timezone.localtime(timezone.now())
        resolved_at = timezone.now().isoformat()
        description = f"Solicitud de traslado {transfer_reference}. Revisar gestion pendiente."

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            existing_payload = store.payload if isinstance(store.payload, list) else []
            normalized_payload = _normalize_reminder_list(existing_payload)
            seed_history = self._get_transfer_context_history_from_payload(
                normalized_payload,
                solicitud_id=solicitud_id,
            )

            current_context_reminder = None
            for item in normalized_payload:
                if not isinstance(item, dict):
                    continue
                context = item.get("context") if isinstance(item.get("context"), dict) else {}
                context_type = self._normalize_reminder_context_type(context.get("type"))
                context_id = str(context.get("id") or "").strip()
                if context_type == "solicitud_traslado" and context_id == str(solicitud_id):
                    current_context_reminder = item
                    break

            request_creator = self._resolve_transfer_request_creator_from_payload(
                normalized_payload,
                solicitud_id=solicitud_id,
            ) or self._normalize_reminder_recipient(getattr(solicitud, "creado_por", None))

            existing_assigned = []
            if isinstance(current_context_reminder, dict):
                decision = current_context_reminder.get("decision")
                if isinstance(decision, dict) and isinstance(decision.get("assignedRecipients"), list):
                    existing_assigned = decision.get("assignedRecipients") or []

            recipients = []
            seen_recipient_ids = set()

            def append_unique(candidate):
                normalized_candidate = self._normalize_reminder_recipient(candidate)
                if normalized_candidate is None:
                    return
                candidate_id = str(normalized_candidate.get("id") or "").strip()
                if not candidate_id or candidate_id in seen_recipient_ids:
                    return
                seen_recipient_ids.add(candidate_id)
                recipients.append(normalized_candidate)

            assigned_user_ids = [
                str(candidate.get("id") or "").strip()
                for candidate in existing_assigned
                if isinstance(candidate, dict) and str(candidate.get("id") or "").strip()
            ]

            for candidate in self._resolve_transfer_request_admin_recipients():
                append_unique(candidate)
            for candidate in self._resolve_transfer_selected_recipients(
                solicitud.sucursal_proveedora_id,
                assigned_user_ids,
            ):
                append_unique(candidate)
            if not assigned_user_ids:
                for candidate in self._resolve_transfer_provider_recipients(
                    solicitud.sucursal_proveedora_id,
                ):
                    append_unique(candidate)
            append_unique(request_creator)
            append_unique(actor_recipient)

            already_aware_ids = []
            for candidate in (request_creator, actor_recipient):
                candidate_id = str((candidate or {}).get("id") or "").strip()
                if candidate_id and candidate_id not in already_aware_ids:
                    already_aware_ids.append(candidate_id)

            deadline_at = now.replace(hour=23, minute=59, second=59, microsecond=999000)
            full_history = self._append_solicitud_transfer_history_event(
                solicitud=solicitud,
                stage="pendiente",
                description=description,
                actor=actor_recipient,
                at=resolved_at,
                seed_history=seed_history,
            )
            if not recipients:
                return False

            reminder = {
                "id": str(uuid4()),
                "date": now.strftime("%Y-%m-%d"),
                "time": now.strftime("%H:%M"),
                "description": description,
                "creator": request_creator or actor_recipient,
                "recipients": recipients,
                "context": {
                    "type": "solicitud_traslado",
                    "id": str(solicitud_id),
                    "label": context_label,
                    "urgente": bool(getattr(solicitud, "urgente", False)),
                },
                "kind": "solicitud_traslado_decision",
                "deadlineAt": deadline_at.isoformat(),
                "decision": {
                    "status": "pendiente",
                    "reason": "",
                    "by": None,
                    "at": "",
                    "assignedRecipients": existing_assigned,
                },
                "transferHistory": full_history,
                "createdAt": resolved_at,
                "completedBy": already_aware_ids,
            }

            merged = self._upsert_transfer_context_reminder(
                normalized_payload,
                solicitud_id=solicitud_id,
                reminder=reminder,
            )

            store.payload = _normalize_reminder_list(merged)
            store.save(update_fields=["payload", "updated_at"])

        return True

    @action(detail=False, methods=["get"], url_path="envios-en-camino")
    def envios_en_camino(self, request):
        queryset = (
            SolicitudTraslado.objects.select_related(
                "sucursal_solicitante",
                "sucursal_proveedora",
                "movimiento_salida",
                "movimiento_entrada",
                "movimiento_entrada__estado_movimiento",
            )
            .prefetch_related("movimiento_entrada__detalles__producto")
            .filter(
                estado=SolicitudTraslado.Estados.APROBADA,
                movimiento_salida_id__isnull=False,
                movimiento_entrada_id__isnull=False,
            )
            .order_by("-fecha", "-id")
        )

        sucursal_solicitante_raw = (request.query_params.get("sucursal_solicitante_id") or "").strip()
        if sucursal_solicitante_raw:
            if not sucursal_solicitante_raw.isdigit():
                return Response(
                    {"detail": "Debes enviar un sucursal_solicitante_id valido."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            queryset = queryset.filter(sucursal_solicitante_id=int(sucursal_solicitante_raw))

        # Antes se filtraba por creado_por=request.user (solo quien creo el
        # pedido lo veia aqui para confirmar su recepcion). El problema: los
        # permisos de una sucursal cambian de responsable con el tiempo, y
        # quien tiene hoy el modulo Entradas ahi debe poder ver y gestionar
        # estos envios aunque no los haya creado el -- no solo el creador
        # original. Se filtra por alcance de sucursal, igual que el resto de
        # acciones de esta solicitud (ver confirmar_recepcion_traslado).
        allowed_branch_ids = get_readable_sucursal_ids(
            request.user, RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS
        )
        if allowed_branch_ids is not None:
            if not allowed_branch_ids:
                return Response([], status=status.HTTP_200_OK)
            queryset = queryset.filter(sucursal_solicitante_id__in=sorted(allowed_branch_ids))

        pending_issue_count_by_solicitud = {
            int(row["solicitud_id"]): int(row["count"] or 0)
            for row in (
                TrasladoInconveniente.objects.filter(estado=TrasladoInconveniente.Estados.PENDIENTE)
                .values("solicitud_id")
                .annotate(count=Count("id"))
            )
        }

        payload = []
        for solicitud in queryset:
            movimiento_entrada = getattr(solicitud, "movimiento_entrada", None)
            if movimiento_entrada is None:
                continue

            estado_name = self._normalize_state_name(
                getattr(getattr(movimiento_entrada, "estado_movimiento", None), "nombre", "")
            )
            if "recib" in estado_name or "parcial" in estado_name:
                continue

            detalles_payload = []
            # .all() usa lo precargado; select_related() aca hacia una consulta por envio.
            for detalle in movimiento_entrada.detalles.all():
                producto = getattr(detalle, "producto", None)
                detalles_payload.append(
                    {
                        "detalle_id": int(detalle.id),
                        "producto_id": int(getattr(detalle, "producto_id", 0) or 0),
                        "producto_codigo": str(getattr(producto, "codigo", "") or "").strip(),
                        "producto_nombre": str(getattr(producto, "nombre", "") or "").strip(),
                        "cantidad_enviada": int(detalle.cantidad or 0),
                        "valor": detalle.valor,
                    }
                )

            payload.append(
                {
                    "id": int(solicitud.id),
                    "no_documento": str(solicitud.no_documento or "").strip(),
                    "fecha": solicitud.fecha,
                    "sucursal_solicitante_id": int(solicitud.sucursal_solicitante_id),
                    "sucursal_solicitante": str(getattr(solicitud.sucursal_solicitante, "nombre", "") or "").strip(),
                    "sucursal_proveedora_id": int(solicitud.sucursal_proveedora_id),
                    "sucursal_proveedora": str(getattr(solicitud.sucursal_proveedora, "nombre", "") or "").strip(),
                    "movimiento_salida_id": int(solicitud.movimiento_salida_id or 0),
                    "movimiento_entrada_id": int(solicitud.movimiento_entrada_id or 0),
                    "factura_referencia": str(
                        getattr(solicitud.movimiento_salida, "factura_referencia", "") or ""
                    ).strip(),
                    # Nota que escribio quien despacho la salida (como se envio,
                    # empaque, vehiculo...): se muestra al recibir.
                    "nota_envio": str(
                        getattr(solicitud.movimiento_salida, "descripcion", "") or ""
                    ).strip(),
                    "estado_entrada": str(getattr(movimiento_entrada.estado_movimiento, "nombre", "") or "").strip(),
                    "descripcion": str(solicitud.descripcion or "").strip(),
                    "detalles": detalles_payload,
                    # Lo que quien envio rechazo, con su motivo (envio parcial).
                    "detalles_no_enviados": public_detalles_no_enviados(solicitud),
                    "inconvenientes_pendientes": pending_issue_count_by_solicitud.get(int(solicitud.id), 0),
                    "recepcion_progreso": (solicitud.recepcion_progreso, solicitud.sucursal_solicitante_id),
                }
            )

        # Avance de todos los envios de una vez (antes 2 consultas por envio).
        for row, progreso in zip(payload, serialize_progress_many([row["recepcion_progreso"] for row in payload])):
            row["recepcion_progreso"] = progreso

        # Para el buscador de la ventana de recepcion: referencias y OEM.
        attach_product_search([detalle for row in payload for detalle in row.get("detalles", [])])
        return Response(payload, status=status.HTTP_200_OK)

    def _get_open_transfer_for_reception(self, request, solicitud_id, *, lock=False):
        """Solicitud aprobada con entrada aun sin recibir, con permiso del usuario."""
        solicitud = self._get_solicitud_traslado(solicitud_id)
        if solicitud is None:
            return None, None, Response(
                {"detail": "No se encontro la solicitud de traslado."},
                status=status.HTTP_404_NOT_FOUND,
            )
        ensure_sucursal_allowed_for_modules(
            request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
            solicitud.sucursal_solicitante_id,
            field_label="sucursal de destino",
            action_key=("puede_crear", "puede_actualizar"),
        )
        if lock:
            solicitud = SolicitudTraslado.objects.select_for_update(of=("self",)).get(pk=solicitud.pk)
        if solicitud.estado != SolicitudTraslado.Estados.APROBADA or not solicitud.movimiento_entrada_id:
            return None, None, Response(
                {"detail": "Este traslado no esta pendiente de recepcion."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        entrada = (
            MovimientoInventario.objects.select_related("estado_movimiento")
            .filter(pk=solicitud.movimiento_entrada_id)
            .first()
        )
        estado = self._normalize_state_name(getattr(getattr(entrada, "estado_movimiento", None), "nombre", ""))
        if entrada is None or "recib" in estado or "parcial" in estado:
            return None, None, Response(
                {"detail": "La recepcion de este traslado ya fue cerrada."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return solicitud, entrada, None

    @action(
        detail=False,
        methods=["post"],
        url_path=r"solicitudes-traslado/(?P<solicitud_id>\d+)/recibir-parcial",
    )
    def recibir_parcial_traslado(self, request, solicitud_id=None):
        """Recibe por partes: lo marcado entra ya al stock (en su ubicacion o
        en POR UBICAR) y se puede vender aunque falte guardarlo."""
        with transaction.atomic():
            solicitud, entrada, error = self._get_open_transfer_for_reception(request, solicitud_id, lock=True)
            if error is not None:
                return error
            sent = {
                int(detalle.producto_id): int(detalle.cantidad or 0)
                for detalle in entrada.detalles.all()
            }
            try:
                progreso = receive_items(
                    progress=solicitud.recepcion_progreso,
                    sucursal_id=solicitud.sucursal_solicitante_id,
                    items=request.data.get("items"),
                    sent_by_product=sent,
                )
            except RecepcionDesactualizada as exc:
                # Peticion repetida o vieja: no se suma nada y se devuelve el
                # avance real para que la pantalla se ponga al dia.
                # Se lee antes de marcar el rollback (despues ya no se puede consultar).
                progreso_actual = serialize_progress(solicitud.recepcion_progreso, solicitud.sucursal_solicitante_id)
                transaction.set_rollback(True)
                return Response(
                    {
                        "detail": str(exc),
                        "desactualizada": True,
                        "recepcion_progreso": progreso_actual,
                    },
                    status=status.HTTP_409_CONFLICT,
                )
            except RecepcionError as exc:
                transaction.set_rollback(True)
                return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
            solicitud.recepcion_progreso = progreso
            solicitud.save(update_fields=["recepcion_progreso", "updated_at"])
        return Response(
            {"recepcion_progreso": serialize_progress(progreso, solicitud.sucursal_solicitante_id)},
            status=status.HTTP_200_OK,
        )

    @action(
        detail=False,
        methods=["post"],
        url_path=r"solicitudes-traslado/(?P<solicitud_id>\d+)/guardar-ubicaciones",
    )
    def guardar_ubicaciones_traslado(self, request, solicitud_id=None):
        """Mueve desde POR UBICAR a la ubicacion definitiva lo ya recibido."""
        with transaction.atomic():
            solicitud, _entrada, error = self._get_open_transfer_for_reception(request, solicitud_id, lock=True)
            if error is not None:
                return error
            try:
                progreso, _moved = store_items(
                    progress=solicitud.recepcion_progreso,
                    sucursal_id=solicitud.sucursal_solicitante_id,
                    items=request.data.get("items"),
                )
            except RecepcionError as exc:
                transaction.set_rollback(True)
                return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
            solicitud.recepcion_progreso = progreso
            solicitud.save(update_fields=["recepcion_progreso", "updated_at"])
        return Response(
            {"recepcion_progreso": serialize_progress(progreso, solicitud.sucursal_solicitante_id)},
            status=status.HTTP_200_OK,
        )

    @action(
        detail=False,
        methods=["patch"],
        url_path=r"solicitudes-traslado/(?P<solicitud_id>\d+)/borrador-recepcion",
    )
    def guardar_borrador_recepcion(self, request, solicitud_id=None):
        solicitud = self._get_solicitud_traslado(solicitud_id)
        if solicitud is None:
            return Response(
                {"detail": "No se encontro la solicitud de traslado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        items = request.data.get("items")
        if not isinstance(items, dict):
            return Response(
                {"detail": "Se esperaba un objeto en `items`."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        borrador = {}
        for producto_id, data in items.items():
            if not isinstance(data, dict):
                continue
            raw_qty = data.get("cantidad_recibida")
            borrador[str(producto_id)] = {
                "cantidad_recibida": max(0, int(raw_qty)) if raw_qty is not None else None,
                "recepcion_revisada": bool(data.get("recepcion_revisada", False)),
                "novedad": str(data.get("novedad") or "").strip(),
                "ubicaciones": [
                    {"subdivision_id": loc["subdivision_id"], "cantidad": loc["cantidad"]}
                    for loc in (data.get("ubicaciones") or [])
                    if isinstance(loc, dict) and loc.get("subdivision_id") and loc.get("cantidad") is not None
                ],
                # Eligio "Por ubicar": se recibe sin ubicacion y se guarda despues.
                "por_ubicar": bool(data.get("por_ubicar", False)),
            }

        # Nota general del envio ("hay una novedad general" + texto): tambien
        # va al servidor, no solo las filas. Se guarda bajo "__meta__", que no
        # choca con los ids de producto.
        if "nota_general" in request.data or "tiene_novedad_general" in request.data:
            borrador["__meta__"] = {
                "tiene_novedad_general": bool(request.data.get("tiene_novedad_general")),
                "nota_general": str(request.data.get("nota_general") or ""),
            }

        solicitud.borrador_recepcion = borrador
        solicitud.save(update_fields=["borrador_recepcion", "updated_at"])
        return Response({"ok": True}, status=status.HTTP_200_OK)

    @action(
        detail=False,
        methods=["post"],
        url_path=r"solicitudes-traslado/(?P<solicitud_id>\d+)/confirmar-recepcion",
    )
    def confirmar_recepcion_traslado(self, request, solicitud_id=None):
        solicitud = self._get_solicitud_traslado(solicitud_id)
        if solicitud is None:
            return Response(
                {"detail": "No se encontro la solicitud de traslado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        ensure_sucursal_allowed_for_modules(
            request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
            solicitud.sucursal_solicitante_id,
            field_label="sucursal de destino",
            action_key=("puede_crear", "puede_actualizar"),
        )

        if solicitud.estado != SolicitudTraslado.Estados.APROBADA:
            return Response(
                {"detail": "La solicitud no esta aprobada para registrar recepcion."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not solicitud.movimiento_entrada_id:
            return Response(
                {"detail": "La solicitud no tiene una entrada asociada."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        items = request.data.get("items")
        if not isinstance(items, list) or not items:
            return Response(
                {"detail": "Debes enviar la lista de productos recibidos en `items`."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        resultado = self._normalize_state_name(
            request.data.get("resultado") or request.data.get("estado_recepcion")
        )
        if resultado not in {"completo", "incompleto"}:
            return Response(
                {"detail": "Debes indicar `resultado` como completo o incompleto."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        nota_general = str(request.data.get("nota_general") or "").strip()

        movimiento_entrada = (
            MovimientoInventario.objects.select_related("estado_movimiento")
            .prefetch_related("detalles__producto")
            .filter(pk=solicitud.movimiento_entrada_id)
            .first()
        )
        if movimiento_entrada is None:
            return Response(
                {"detail": "No se encontro el movimiento de entrada asociado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        estado_actual = self._normalize_state_name(
            getattr(getattr(movimiento_entrada, "estado_movimiento", None), "nombre", "")
        )
        if "recib" in estado_actual or "parcial" in estado_actual:
            return Response(
                {"detail": "La recepcion ya fue registrada anteriormente.", "ya_registrada": True},
                status=status.HTTP_400_BAD_REQUEST,
            )

        detalles_por_producto = {
            int(detalle.producto_id): detalle
            for detalle in movimiento_entrada.detalles.select_related("producto").all()
        }
        if not detalles_por_producto:
            return Response(
                {"detail": "La entrada no tiene productos para registrar recepcion."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Lo recibido por partes ya esta en el stock: al cerrar solo se suma la
        # diferencia (cantidad recibida total - ya recibido).
        ya_recibido_por_producto = received_by_product(solicitud.recepcion_progreso)
        if pending_to_store(solicitud.recepcion_progreso, solicitud.sucursal_solicitante_id) > 0:
            return Response(
                {"detail": "Guarda en su ubicacion los productos que quedaron en POR UBICAR antes de cerrar la recepcion."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        processed_items = []
        seen_product_ids = set()
        total_faltante = 0
        subdivision_ids_to_check = set()
        for raw_item in items:
            if not isinstance(raw_item, dict):
                return Response(
                    {"detail": "Cada item debe ser un objeto valido."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            try:
                product_id = int(raw_item.get("producto_id"))
            except (TypeError, ValueError):
                return Response(
                    {"detail": "Cada item debe incluir un `producto_id` valido."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if product_id in seen_product_ids:
                return Response(
                    {"detail": "No puedes repetir el mismo producto en la recepcion."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            seen_product_ids.add(product_id)

            detalle = detalles_por_producto.get(product_id)
            if detalle is None:
                return Response(
                    {"detail": f"El producto {product_id} no pertenece al traslado."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            cantidad_enviada = int(detalle.cantidad or 0)
            try:
                cantidad_recibida = int(raw_item.get("cantidad_recibida"))
            except (TypeError, ValueError):
                return Response(
                    {"detail": f"Debes enviar una cantidad recibida valida para producto {product_id}."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if cantidad_recibida < 0:
                return Response(
                    {
                        "detail": (
                            f"La cantidad recibida para producto {product_id} no puede ser negativa."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

            # Un traslado siempre llega con lo que salio de la otra sucursal:
            # recibir mas de lo enviado solo puede ser una duplicacion, asi
            # que no se permite (ya no existen "sobrantes" de traslado).
            if cantidad_recibida > cantidad_enviada:
                return Response(
                    {
                        "detail": (
                            f"No se puede recibir mas de lo enviado del producto "
                            f"{getattr(detalle.producto, 'codigo', product_id)}: se enviaron {cantidad_enviada} "
                            f"y se intento recibir {cantidad_recibida}."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

            ubicaciones_raw = raw_item.get("ubicaciones")
            if not isinstance(ubicaciones_raw, list):
                ubicaciones_raw = []

            ubicaciones = []
            cantidad_ubicada = 0
            for raw_ubicacion in ubicaciones_raw:
                if not isinstance(raw_ubicacion, dict):
                    return Response(
                        {"detail": "Cada ubicacion debe ser un objeto valido."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                try:
                    subdivision_id = int(raw_ubicacion.get("subdivision_id"))
                    cantidad_ubicacion = int(raw_ubicacion.get("cantidad"))
                except (TypeError, ValueError):
                    return Response(
                        {"detail": "Cada ubicacion debe incluir subdivision_id y cantidad validos."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                if cantidad_ubicacion <= 0:
                    return Response(
                        {"detail": "La cantidad por ubicacion debe ser mayor a 0."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                subdivision_ids_to_check.add(subdivision_id)
                ubicaciones.append(
                    {
                        "subdivision_id": subdivision_id,
                        "cantidad": cantidad_ubicacion,
                    }
                )
                cantidad_ubicada += cantidad_ubicacion

            ya_recibido = int(ya_recibido_por_producto.get(product_id, 0))
            if cantidad_recibida < ya_recibido:
                return Response(
                    {
                        "detail": (
                            f"La cantidad recibida para producto {product_id} no puede ser menor "
                            f"a lo que ya se recibio ({ya_recibido})."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            cantidad_por_sumar = cantidad_recibida - ya_recibido

            if cantidad_por_sumar > 0 and not ubicaciones:
                return Response(
                    {
                        "detail": (
                            f"Debes ubicar el producto {product_id} en al menos una subdivision."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if cantidad_ubicada != cantidad_por_sumar:
                return Response(
                    {
                        "detail": (
                            f"La suma de ubicaciones para producto {product_id} ({cantidad_ubicada}) "
                            f"debe coincidir con la cantidad por recibir ({cantidad_por_sumar})."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

            cantidad_faltante = max(0, int(cantidad_enviada - cantidad_recibida))
            total_faltante += cantidad_faltante

            processed_items.append(
                {
                    "producto_id": product_id,
                    "detalle": detalle,
                    "cantidad_enviada": cantidad_enviada,
                    "cantidad_recibida": cantidad_recibida,
                    "cantidad_faltante": cantidad_faltante,
                    "ubicaciones": ubicaciones,
                    "novedad": str(raw_item.get("novedad") or "").strip(),
                }
            )

        expected_product_ids = set(detalles_por_producto.keys())
        if seen_product_ids != expected_product_ids:
            return Response(
                {
                    "detail": (
                        "Debes confirmar la recepcion para todos los productos del traslado."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        if resultado == "completo" and total_faltante > 0:
            return Response(
                {"detail": "No puedes marcar como completo si existen faltantes."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if resultado == "incompleto" and total_faltante <= 0:
            return Response(
                {"detail": "Para marcar incompleto debe existir al menos un faltante."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if subdivision_ids_to_check:
            valid_subdivision_ids = set(
                SubDivision.objects.filter(
                    id__in=sorted(subdivision_ids_to_check),
                    division__bodega__sucursal_id=solicitud.sucursal_solicitante_id,
                ).values_list("id", flat=True)
            )
            if valid_subdivision_ids != subdivision_ids_to_check:
                return Response(
                    {"detail": "Una o mas subdivisiones no pertenecen a la sucursal solicitante."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        with transaction.atomic():
            solicitud_locked = (
                SolicitudTraslado.objects.select_for_update(of=("self",))
                .filter(pk=solicitud.id)
                .first()
            )
            if solicitud_locked is None:
                return Response(
                    {"detail": "No se encontro la solicitud de traslado."},
                    status=status.HTTP_404_NOT_FOUND,
                )

            movimiento_entrada_locked = (
                MovimientoInventario.objects.select_for_update(of=("self",))
                .select_related("estado_movimiento")
                .prefetch_related("detalles__producto")
                .filter(pk=solicitud_locked.movimiento_entrada_id)
                .first()
            )
            if movimiento_entrada_locked is None:
                return Response(
                    {"detail": "No se encontro el movimiento de entrada asociado."},
                    status=status.HTTP_404_NOT_FOUND,
                )

            estado_actual_locked = self._normalize_state_name(
                getattr(
                    getattr(movimiento_entrada_locked, "estado_movimiento", None),
                    "nombre",
                    "",
                )
            )
            if "recib" in estado_actual_locked or "parcial" in estado_actual_locked:
                return Response(
                    {"detail": "La recepcion ya fue registrada anteriormente.", "ya_registrada": True},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            detalle_locked_by_producto = {
                int(detalle.producto_id): detalle
                for detalle in movimiento_entrada_locked.detalles.all()
            }

            requested_inventory_locks = Q(pk__in=[])
            for item in processed_items:
                product_id = int(item["producto_id"])
                for ubicacion in item["ubicaciones"]:
                    requested_inventory_locks |= Q(
                        subdivision_id=int(ubicacion["subdivision_id"]),
                        producto_id=product_id,
                    )
            if requested_inventory_locks:
                list(Inventario.objects.select_for_update().filter(requested_inventory_locks).values_list("id", flat=True))

            for item in processed_items:
                detail_row = detalle_locked_by_producto.get(int(item["producto_id"]))
                if detail_row is None:
                    return Response(
                        {"detail": "No se pudo resolver el detalle del traslado."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                cantidad_recibida = int(item["cantidad_recibida"] or 0)
                detail_row.cantidad = cantidad_recibida
                detail_row.valor_total = (detail_row.valor or Decimal("0")) * cantidad_recibida
                detail_row.save(update_fields=["cantidad", "valor_total"])

                for ubicacion in item["ubicaciones"]:
                    self._add_stock_to_subdivision(
                        subdivision_id=int(ubicacion["subdivision_id"]),
                        producto_id=int(item["producto_id"]),
                        cantidad=int(ubicacion["cantidad"]),
                    )

            estado_destino = self._resolve_estado_movimiento(
                "recibido" if total_faltante <= 0 else "parcialmente recibido",
                "recibido",
            )
            if estado_destino is None:
                return Response(
                    {"detail": "No se pudo resolver el estado de movimiento."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            movimiento_entrada_locked.estado_movimiento = estado_destino
            movimiento_entrada_locked.save(update_fields=["estado_movimiento"])

            movimiento_salida_locked = None
            if solicitud_locked.movimiento_salida_id:
                movimiento_salida_locked = (
                    MovimientoInventario.objects.select_for_update(of=("self",))
                    .select_related("estado_movimiento")
                    .filter(pk=solicitud_locked.movimiento_salida_id)
                    .first()
                )

            if movimiento_salida_locked is not None:
                salida_estado_destino = self._resolve_estado_movimiento(
                    "llego con inconvenientes" if total_faltante > 0 else "llego",
                    "parcialmente recibido" if total_faltante > 0 else "recibido",
                    "recibido",
                )
                if salida_estado_destino is not None:
                    movimiento_salida_locked.estado_movimiento = salida_estado_destino
                    movimiento_salida_locked.save(update_fields=["estado_movimiento"])

            inconvenientes_payload = []
            for item in processed_items:
                faltante = int(item["cantidad_faltante"] or 0)
                if faltante <= 0:
                    continue

                inconveniente = TrasladoInconveniente.objects.create(
                    solicitud=solicitud_locked,
                    movimiento_entrada=movimiento_entrada_locked,
                    producto_id=int(item["producto_id"]),
                    tipo=TrasladoInconveniente.Tipos.FALTANTE,
                    cantidad_faltante=faltante,
                    estado=TrasladoInconveniente.Estados.PENDIENTE,
                    motivo=str(item.get("novedad") or "").strip(),
                    creado_por=request.user,
                )
                TrasladoInconvenienteHistorial.objects.create(
                    inconveniente=inconveniente,
                    accion="detectado",
                    detalle=(
                        f"Faltante detectado en recepcion. Enviado: {item['cantidad_enviada']}, "
                        f"recibido: {item['cantidad_recibida']}, faltante: {faltante}."
                    ),
                    actor=request.user,
                )
                inconveniente = (
                    TrasladoInconveniente.objects.select_related(
                        "solicitud",
                        "solicitud__sucursal_solicitante",
                        "solicitud__sucursal_proveedora",
                        "producto",
                        "creado_por",
                        "resuelto_por",
                        "sucursal_resolucion",
                        "subdivision_resolucion",
                    )
                    .prefetch_related("historial__actor")
                    .filter(pk=inconveniente.id)
                    .first()
                )
                if inconveniente is not None:
                    inconvenientes_payload.append(self._serialize_inconveniente(inconveniente))

            if nota_general:
                # Nota general del usuario que recibe ("algo no salio como lo
                # esperado"), sin ligarse a un producto puntual ni a un
                # faltante/sobrante de cantidad: se registra igual como
                # Inconveniente (tipo Otro, sin producto) para que quede
                # visible/rastreable para el admin, pero se resuelve con un
                # solo boton ("Solucionado") en vez del flujo de ajuste de
                # inventario.
                inconveniente = TrasladoInconveniente.objects.create(
                    solicitud=solicitud_locked,
                    movimiento_entrada=movimiento_entrada_locked,
                    producto=None,
                    tipo=TrasladoInconveniente.Tipos.OTRO,
                    cantidad_faltante=0,
                    estado=TrasladoInconveniente.Estados.PENDIENTE,
                    motivo=nota_general,
                    creado_por=request.user,
                )
                TrasladoInconvenienteHistorial.objects.create(
                    inconveniente=inconveniente,
                    accion="detectado",
                    detalle="El usuario reporto un problema general con la recepcion.",
                    actor=request.user,
                )
                inconveniente = (
                    TrasladoInconveniente.objects.select_related(
                        "solicitud",
                        "solicitud__sucursal_solicitante",
                        "solicitud__sucursal_proveedora",
                        "producto",
                        "creado_por",
                        "resuelto_por",
                        "sucursal_resolucion",
                        "subdivision_resolucion",
                    )
                    .prefetch_related("historial__actor")
                    .filter(pk=inconveniente.id)
                    .first()
                )
                if inconveniente is not None:
                    inconvenientes_payload.append(self._serialize_inconveniente(inconveniente))

            solicitud_locked.borrador_recepcion = {}
            solicitud_locked.recibido_por = request.user
            solicitud_locked.save(update_fields=["borrador_recepcion", "recibido_por", "updated_at"])
            solicitud_output = SolicitudTrasladoSerializer(instance=solicitud_locked).data

        reception_result = "completo" if total_faltante <= 0 else "incompleto"
        reminder_sent = False
        try:
            reminder_sent = self._append_transfer_reception_reminder(
                solicitud=solicitud_locked,
                resultado=reception_result,
                total_faltante=total_faltante,
                processed_items=processed_items,
                actor_user=request.user,
            )
        except Exception:
            reminder_sent = False

        inconvenience_reminder_sent = False

        return Response(
            {
                "detail": (
                    "Recepcion registrada como completa."
                    if total_faltante <= 0
                    else "Recepcion registrada con faltantes."
                ),
                "resultado": reception_result,
                "faltantes": int(total_faltante),
                "solicitud": solicitud_output,
                "inconvenientes": inconvenientes_payload,
                "recordatorio_enviado": bool(reminder_sent),
                "recordatorio_inconveniente_enviado": bool(inconvenience_reminder_sent),
            },
            status=status.HTTP_200_OK,
        )

    @action(detail=False, methods=["get"], url_path="traslados-inconvenientes")
    def traslados_inconvenientes(self, request):
        if not is_app_admin(request.user):
            return Response(
                {
                    "detail": (
                        "Solo los administradores pueden consultar "
                        "traslados con inconvenientes."
                    )
                },
                status=status.HTTP_403_FORBIDDEN,
            )

        queryset = (
            TrasladoInconveniente.objects.select_related(
                "solicitud",
                "solicitud__sucursal_solicitante",
                "solicitud__sucursal_proveedora",
                "movimiento_entrada",
                "producto",
                "creado_por",
                "resuelto_por",
                "sucursal_resolucion",
                "subdivision_resolucion",
            )
            .prefetch_related("historial__actor")
            .order_by("-created_at", "-id")
        )

        estado = self._normalize_state_name(request.query_params.get("estado"))
        if estado in {
            TrasladoInconveniente.Estados.PENDIENTE,
            TrasladoInconveniente.Estados.RESUELTO,
            TrasladoInconveniente.Estados.PERDIDO,
        }:
            queryset = queryset.filter(estado=estado)

        solicitud_id = str(request.query_params.get("solicitud_id") or "").strip()
        if solicitud_id.isdigit():
            queryset = queryset.filter(solicitud_id=int(solicitud_id))

        allowed = get_allowed_sucursal_ids_for_modules(
            request.user,
            [
                RolPermiso.Modulos.MOVIMIENTOS_INCONVENIENTES,
                RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
                RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
            ],
            action_key="puede_leer",
        )
        if allowed is not None:
            if not allowed:
                return Response([], status=status.HTTP_200_OK)
            queryset = queryset.filter(
                Q(solicitud__sucursal_solicitante_id__in=sorted(allowed))
                | Q(solicitud__sucursal_proveedora_id__in=sorted(allowed))
            )

        # La barra lateral solo necesita saber si hay pendientes.
        if str(request.query_params.get("solo_conteo") or "").strip() in {"1", "true"}:
            return Response({"count": queryset.count()}, status=status.HTTP_200_OK)

        payload = [self._serialize_inconveniente(row) for row in queryset]
        # Para el buscador de la tabla: referencias y OEM del producto.
        attach_product_search(payload)
        return Response(payload, status=status.HTTP_200_OK)

    @action(detail=False, methods=["post"], url_path="traslados-inconvenientes/borradores")
    def guardar_borradores_traslado_inconvenientes(self, request):
        """Guarda la solucion elegida de cada producto sin aplicarla.
        `{"items": [{"id": 1, "borrador": {...}}]}`; `{}` borra el borrador."""
        if not is_app_admin(request.user):
            return Response(
                {"detail": "Solo los administradores pueden resolver traslados con inconvenientes."},
                status=status.HTTP_403_FORBIDDEN,
            )
        items, error = parse_borrador_items(request.data)
        if error:
            return Response({"detail": error}, status=status.HTTP_400_BAD_REQUEST)
        guardados = []
        with transaction.atomic():
            for inconveniente in TrasladoInconveniente.objects.select_for_update().filter(
                pk__in=sorted(items), estado=TrasladoInconveniente.Estados.PENDIENTE
            ):
                inconveniente.borrador = items[inconveniente.id]
                inconveniente.save(update_fields=["borrador", "updated_at"])
                guardados.append(int(inconveniente.id))
        return Response({"guardados": sorted(guardados)}, status=status.HTTP_200_OK)

    @action(
        detail=False,
        methods=["post"],
        url_path=r"traslados-inconvenientes/(?P<inconveniente_id>\d+)/resolver",
    )
    def resolver_traslado_inconveniente(self, request, inconveniente_id=None):
        if not is_app_admin(request.user):
            return Response(
                {
                    "detail": (
                        "Solo los administradores pueden resolver "
                        "traslados con inconvenientes."
                    )
                },
                status=status.HTTP_403_FORBIDDEN,
            )

        inconveniente = (
            TrasladoInconveniente.objects.select_related(
                "solicitud",
                "solicitud__sucursal_solicitante",
                "solicitud__sucursal_proveedora",
                "movimiento_entrada",
                "producto",
                "creado_por",
                "resuelto_por",
                "sucursal_resolucion",
                "subdivision_resolucion",
            )
            .prefetch_related("historial__actor")
            .filter(pk=inconveniente_id)
            .first()
        )
        if inconveniente is None:
            return Response(
                {"detail": "No se encontro el inconveniente de traslado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        allowed = get_allowed_sucursal_ids_for_modules(
            request.user,
            [
                RolPermiso.Modulos.MOVIMIENTOS_INCONVENIENTES,
                RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
                RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
            ],
            action_key="puede_actualizar",
        )
        if (
            allowed is not None
            and int(inconveniente.solicitud.sucursal_solicitante_id) not in allowed
            and int(inconveniente.solicitud.sucursal_proveedora_id) not in allowed
        ):
            return Response(
                {"detail": "No tienes acceso para resolver este inconveniente."},
                status=status.HTTP_403_FORBIDDEN,
            )

        if inconveniente.estado != TrasladoInconveniente.Estados.PENDIENTE:
            return Response(
                {"detail": "Este inconveniente ya fue resuelto."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        decision = self._normalize_state_name(request.data.get("decision"))
        motivo = str(request.data.get("motivo") or "").strip()

        valid_decisions = {
            "sumar_solicitante", "sumar_proveedora", "perdido", "restar_proveedora",
            "sin_cambios", "devolver_proveedora", "solucionado",
        }
        if decision not in valid_decisions:
            return Response(
                {
                    "detail": (
                        "Debes enviar una decision valida: sumar_solicitante, sumar_proveedora, perdido, "
                        "restar_proveedora, sin_cambios, devolver_proveedora o solucionado."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            inconveniente_locked = (
                TrasladoInconveniente.objects.select_for_update(of=("self",))
                .select_related(
                    "solicitud",
                    "solicitud__sucursal_solicitante",
                    "solicitud__sucursal_proveedora",
                    "producto",
                )
                .filter(pk=inconveniente.id)
                .first()
            )
            if inconveniente_locked is None:
                return Response(
                    {"detail": "No se encontro el inconveniente de traslado."},
                    status=status.HTTP_404_NOT_FOUND,
                )

            if inconveniente_locked.estado != TrasladoInconveniente.Estados.PENDIENTE:
                return Response(
                    {"detail": "Este inconveniente ya fue resuelto."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            es_otro = inconveniente_locked.tipo == TrasladoInconveniente.Tipos.OTRO
            if es_otro and decision != "solucionado":
                return Response(
                    {"detail": "Este inconveniente solo admite marcarse como solucionado."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if not es_otro and decision == "solucionado":
                return Response(
                    {"detail": "La decision 'solucionado' solo aplica a inconvenientes de tipo Otro."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            cantidad_faltante = int(inconveniente_locked.cantidad_faltante or 0)
            if not es_otro and cantidad_faltante <= 0:
                return Response(
                    {"detail": "El inconveniente no tiene cantidad faltante pendiente."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            sucursal_resolucion_id = None
            subdivision_resolucion_id = None
            resolucion = ""
            estado_resultado = TrasladoInconveniente.Estados.RESUELTO
            es_sobrante = inconveniente_locked.tipo == TrasladoInconveniente.Tipos.SOBRANTE

            if decision in {"sumar_solicitante", "sumar_proveedora", "restar_proveedora"}:
                if decision == "restar_proveedora":
                    target_branch_id = int(inconveniente_locked.solicitud.sucursal_proveedora_id)
                elif decision == "sumar_solicitante":
                    target_branch_id = int(inconveniente_locked.solicitud.sucursal_solicitante_id)
                else:
                    target_branch_id = int(inconveniente_locked.solicitud.sucursal_proveedora_id)

                subdivision_id_raw = str(request.data.get("subdivision_id") or "").strip()
                if not subdivision_id_raw.isdigit():
                    return Response(
                        {"detail": "Debes indicar una subdivision valida para ajustar inventario."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                subdivision = (
                    SubDivision.objects.select_related("division__bodega")
                    .filter(pk=int(subdivision_id_raw))
                    .first()
                )
                bodega = getattr(getattr(subdivision, "division", None), "bodega", None)
                bodega_sucursal_id = int(getattr(bodega, "sucursal_id", 0) or 0)
                if subdivision is None or bodega_sucursal_id != target_branch_id:
                    return Response(
                        {"detail": "La subdivision no pertenece a la sucursal seleccionada."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                if decision == "restar_proveedora":
                    self._remove_stock_from_subdivision(
                        subdivision_id=int(subdivision.id),
                        producto_id=int(inconveniente_locked.producto_id),
                        cantidad=cantidad_faltante,
                    )
                    resolucion = TrasladoInconveniente.Resoluciones.RESTAR_PROVEEDORA
                else:
                    self._add_stock_to_subdivision(
                        subdivision_id=int(subdivision.id),
                        producto_id=int(inconveniente_locked.producto_id),
                        cantidad=cantidad_faltante,
                    )
                    resolucion = (
                        TrasladoInconveniente.Resoluciones.SUMAR_SOLICITANTE
                        if decision == "sumar_solicitante"
                        else TrasladoInconveniente.Resoluciones.SUMAR_PROVEEDORA
                    )
                sucursal_resolucion_id = target_branch_id
                subdivision_resolucion_id = int(subdivision.id)
            elif decision == "devolver_proveedora":
                if not es_sobrante:
                    return Response(
                        {"detail": "La decision 'devolver_proveedora' solo aplica para inconvenientes de tipo sobrante."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                subdivision_id_raw = str(request.data.get("subdivision_id") or "").strip()
                subdivision_prov_id_raw = str(request.data.get("subdivision_proveedora_id") or "").strip()
                if not subdivision_id_raw.isdigit():
                    return Response(
                        {"detail": "Debes indicar una subdivision valida de la sucursal destino para restar el sobrante."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if not subdivision_prov_id_raw.isdigit():
                    return Response(
                        {"detail": "Debes indicar una subdivision valida de la sucursal proveedora para devolver el sobrante."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                subdivision_dest = (
                    SubDivision.objects.select_related("division__bodega")
                    .filter(pk=int(subdivision_id_raw))
                    .first()
                )
                bodega_dest = getattr(getattr(subdivision_dest, "division", None), "bodega", None)
                bodega_dest_sucursal_id = int(getattr(bodega_dest, "sucursal_id", 0) or 0)
                if subdivision_dest is None or bodega_dest_sucursal_id != int(inconveniente_locked.solicitud.sucursal_solicitante_id):
                    return Response(
                        {"detail": "La subdivision de destino no pertenece a la sucursal solicitante."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                subdivision_prov = (
                    SubDivision.objects.select_related("division__bodega")
                    .filter(pk=int(subdivision_prov_id_raw))
                    .first()
                )
                bodega_prov = getattr(getattr(subdivision_prov, "division", None), "bodega", None)
                bodega_prov_sucursal_id = int(getattr(bodega_prov, "sucursal_id", 0) or 0)
                if subdivision_prov is None or bodega_prov_sucursal_id != int(inconveniente_locked.solicitud.sucursal_proveedora_id):
                    return Response(
                        {"detail": "La subdivision de proveedor no pertenece a la sucursal proveedora."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                self._remove_stock_from_subdivision(
                    subdivision_id=int(subdivision_dest.id),
                    producto_id=int(inconveniente_locked.producto_id),
                    cantidad=cantidad_faltante,
                )
                self._add_stock_to_subdivision(
                    subdivision_id=int(subdivision_prov.id),
                    producto_id=int(inconveniente_locked.producto_id),
                    cantidad=cantidad_faltante,
                )
                resolucion = TrasladoInconveniente.Resoluciones.DEVOLVER_PROVEEDORA
                sucursal_resolucion_id = int(inconveniente_locked.solicitud.sucursal_solicitante_id)
                subdivision_resolucion_id = int(subdivision_dest.id)
            elif decision == "sin_cambios":
                resolucion = TrasladoInconveniente.Resoluciones.SIN_CAMBIOS
            elif decision == "solucionado":
                resolucion = TrasladoInconveniente.Resoluciones.SIN_CAMBIOS
            else:
                resolucion = TrasladoInconveniente.Resoluciones.PERDIDO
                estado_resultado = TrasladoInconveniente.Estados.PERDIDO

            inconveniente_locked.estado = estado_resultado
            inconveniente_locked.resolucion = resolucion
            inconveniente_locked.sucursal_resolucion_id = sucursal_resolucion_id
            inconveniente_locked.subdivision_resolucion_id = subdivision_resolucion_id
            if es_otro:
                # Para "Otro" el campo `motivo` guarda la novedad original con
                # la que se creo el inconveniente (se muestra en "Novedad"),
                # asi que la nota de como se soluciono se guarda aparte en
                # `motivo_resolucion` para no pisar la novedad original.
                inconveniente_locked.motivo_resolucion = motivo
            else:
                inconveniente_locked.motivo = motivo
            inconveniente_locked.resuelto_por = request.user
            inconveniente_locked.borrador = {}
            inconveniente_locked.save(
                update_fields=[
                    "estado",
                    "resolucion",
                    "sucursal_resolucion",
                    "subdivision_resolucion",
                    "motivo",
                    "motivo_resolucion",
                    "resuelto_por",
                    "borrador",
                    "updated_at",
                ]
            )

            tipo_label = "sobrante" if es_sobrante else "faltante"
            if decision in {"sumar_solicitante", "sumar_proveedora"}:
                action_label = "sumado_a_sucursal"
                detail_text = f"Se resolvio el {tipo_label} de {cantidad_faltante} unidades sumando a sucursal."
            elif decision == "restar_proveedora":
                action_label = "restado_de_proveedora"
                detail_text = f"Se resolvio el {tipo_label} de {cantidad_faltante} unidades restando del proveedor."
            elif decision == "devolver_proveedora":
                action_label = "devuelto_a_proveedora"
                detail_text = f"Se devolvio el sobrante de {cantidad_faltante} unidades a la sucursal proveedora."
            elif decision == "sin_cambios":
                action_label = "sin_cambios"
                detail_text = f"Se resolvio el {tipo_label} de {cantidad_faltante} unidades sin modificar inventario."
            elif decision == "solucionado":
                action_label = "solucionado"
                detail_text = "Se marco como solucionado."
            else:
                action_label = "marcado_como_perdido"
                detail_text = f"Se marco como perdido el {tipo_label} de {cantidad_faltante} unidades."
            if motivo:
                detail_text = f"{detail_text} Motivo: {motivo}"

            TrasladoInconvenienteHistorial.objects.create(
                inconveniente=inconveniente_locked,
                accion=action_label,
                detalle=detail_text,
                actor=request.user,
            )

            still_pending = TrasladoInconveniente.objects.filter(
                solicitud_id=inconveniente_locked.solicitud_id,
                estado=TrasladoInconveniente.Estados.PENDIENTE,
            ).exists()

            if not still_pending:
                solicitud_obj = inconveniente_locked.solicitud
                entrada_estado = self._resolve_estado_movimiento("recibido")
                salida_estado = self._resolve_estado_movimiento("llego", "recibido")
                if solicitud_obj.movimiento_entrada_id and entrada_estado:
                    MovimientoInventario.objects.filter(
                        pk=solicitud_obj.movimiento_entrada_id
                    ).update(estado_movimiento=entrada_estado)
                if solicitud_obj.movimiento_salida_id and salida_estado:
                    MovimientoInventario.objects.filter(
                        pk=solicitud_obj.movimiento_salida_id
                    ).update(estado_movimiento=salida_estado)

            inconveniente_out = (
                TrasladoInconveniente.objects.select_related(
                    "solicitud",
                    "solicitud__sucursal_solicitante",
                    "solicitud__sucursal_proveedora",
                    "movimiento_entrada",
                    "producto",
                    "creado_por",
                    "resuelto_por",
                    "sucursal_resolucion",
                    "subdivision_resolucion",
                )
                .prefetch_related("historial__actor")
                .filter(pk=inconveniente_locked.id)
                .first()
            )

        try:
            self._sync_transfer_inconvenience_reminder(
                solicitud=inconveniente_out.solicitud if inconveniente_out else None,
                actor_user=request.user,
            )
        except Exception:
            pass

        return Response(
            {
                "detail": "Inconveniente resuelto correctamente.",
                "inconveniente": self._serialize_inconveniente(inconveniente_out),
            },
            status=status.HTTP_200_OK,
        )

    @action(detail=False, methods=["get"], url_path="buscar-cliente")
    def buscar_cliente(self, request):
        raw_query = (
            request.query_params.get("q")
            or request.query_params.get("search")
            or request.query_params.get("cedula_ruc")
            or ""
        )
        query = str(raw_query).strip()
        if len(query) < 2:
            return Response({"results": []}, status=status.HTTP_200_OK)

        # Antes esto comparaba con icontains crudo, que es sensible a
        # acentos -- un cliente guardado como "Jose Peña" no aparecia si
        # buscabas "Jose Pena" (sin ñ), que es como la mayoria escribe.
        # apply_token_search normaliza acentos y exige que cada palabra
        # buscada aparezca en algun campo, igual que el buscador de productos.
        tokens = get_search_tokens(query)
        clientes_qs = apply_token_search(
            Cliente.objects.all(),
            tokens,
            ["cedula_ruc", "nombres", "apellidos"],
        ).order_by("nombres", "apellidos").distinct()[:10]
        payload = []
        for cliente in clientes_qs:
            nombres = str(getattr(cliente, "nombres", "") or "").strip()
            apellidos = str(getattr(cliente, "apellidos", "") or "").strip()
            cedula = str(getattr(cliente, "cedula_ruc", "") or "").strip()
            payload.append(
                {
                    "id": int(cliente.id),
                    "nombres": nombres,
                    "apellidos": apellidos,
                    "nombre_completo": f"{nombres} {apellidos}".strip(),
                    "cedula_ruc": cedula,
                    "correo": str(getattr(cliente, "correo", "") or "").strip(),
                    "telefono": str(getattr(cliente, "telefono", "") or "").strip(),
                    "direccion": str(getattr(cliente, "direccion", "") or "").strip(),
                }
            )

        return Response({"results": payload}, status=status.HTTP_200_OK)

    @action(detail=False, methods=["get"], url_path="validar-documento")
    def validar_documento(self, request):
        no_documento = str(request.query_params.get("no_documento") or "").strip()
        tipo_movimiento_raw = str(request.query_params.get("tipo_movimiento_id") or "").strip()
        exclude_id_raw = str(request.query_params.get("exclude_id") or "").strip()

        if not no_documento:
            return Response(
                {
                    "is_available": False,
                    "detail": "Debes enviar un numero de documento.",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not tipo_movimiento_raw.isdigit():
            return Response(
                {
                    "is_available": False,
                    "detail": "Debes enviar un tipo_movimiento_id valido.",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        queryset = MovimientoInventario.objects.filter(
            tipo_movimiento_id=int(tipo_movimiento_raw),
            no_documento__iexact=no_documento,
        )
        if exclude_id_raw.isdigit():
            queryset = queryset.exclude(pk=int(exclude_id_raw))

        return Response({"is_available": not queryset.exists()}, status=status.HTTP_200_OK)

    @action(detail=False, methods=["get"], url_path="siguiente-documento-entrada")
    def siguiente_documento_entrada(self, request):
        sub_tipo_raw = str(request.query_params.get("sub_tipo_movimiento_id") or "").strip()
        sucursal_raw = str(request.query_params.get("sucursal_id") or "").strip()
        sucursal_objetivo_raw = str(request.query_params.get("sucursal_objetivo_id") or "").strip()

        if not sub_tipo_raw.isdigit():
            return Response(
                {"detail": "Debes enviar un sub_tipo_movimiento_id valido."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not sucursal_raw.isdigit():
            return Response(
                {"detail": "Debes enviar un sucursal_id valido."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        serializer = self.get_serializer()
        subtipo = (
            serializer.fields["sub_tipo_movimiento_id"]
            .queryset.select_related("tipo_movimiento")
            .filter(id=int(sub_tipo_raw))
            .first()
        )
        if subtipo is None:
            return Response(
                {"detail": "No se encontro el subtipo de movimiento."},
                status=status.HTTP_404_NOT_FOUND,
            )

        tipo_movimiento = getattr(subtipo, "tipo_movimiento", None)
        tipo_name = normalize_name(getattr(tipo_movimiento, "nombre", ""))
        subtipo_key = resolve_subtipo_key(subtipo)
        allowed_entry_subtypes = {"importacion", "compra_local", "devolucion", "traslado"}
        if not tipo_name.startswith("ent") or subtipo_key not in allowed_entry_subtypes:
            return Response(
                {"detail": "El subtipo enviado no corresponde a una entrada valida."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            sucursal = Sucursal.objects.get(id=int(sucursal_raw))
        except Sucursal.DoesNotExist:
            return Response(
                {"detail": "No se encontro la sucursal solicitante."},
                status=status.HTTP_404_NOT_FOUND,
            )

        ensure_sucursal_allowed_for_modules(
            request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
            sucursal.id,
            field_label="sucursal solicitante",
            action_key="puede_crear",
        )

        if subtipo_key == "traslado":
            if not sucursal_objetivo_raw.isdigit():
                return Response(
                    {"detail": "Debes enviar un sucursal_objetivo_id valido para traslados."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            try:
                sucursal_objetivo = Sucursal.objects.get(id=int(sucursal_objetivo_raw))
            except Sucursal.DoesNotExist:
                return Response(
                    {"detail": "No se encontro la sucursal proveedora."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            document_number = generate_transfer_request_document_number(
                sucursal_solicitante=sucursal,
                sucursal_proveedora=sucursal_objetivo,
            )
        else:
            document_number = generate_entry_document_number(
                tipo_movimiento=tipo_movimiento,
                subtipo_key=subtipo_key,
                sucursal=sucursal,
                sucursal_objetivo=None,
            )

        return Response({"no_documento": document_number}, status=status.HTTP_200_OK)

    @action(detail=False, methods=["get"], url_path="stock-sucursal")
    def stock_sucursal(self, request):
        sucursal_id_raw = (request.query_params.get("sucursal_id") or "").strip()
        if not sucursal_id_raw.isdigit():
            return Response(
                {"detail": "Debes enviar un sucursal_id valido."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        sucursal_id = int(sucursal_id_raw)
        modulo = (request.query_params.get("modulo") or "").strip()
        if modulo == RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS:
            permission_checker = MovimientoInventarioModulePermission()
            module_permissions = permission_checker._get_permission_index(request).get(
                RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS, {}
            )
            if not module_permissions.get("puede_leer"):
                return Response(
                    {"detail": "No tienes acceso a la sucursal seleccionada para este modulo."},
                    status=status.HTTP_403_FORBIDDEN,
                )
        else:
            if modulo and modulo in ALLOWED_STOCK_MODULES:
                target_modules = [modulo]
            else:
                target_modules = list(ALLOWED_STOCK_MODULES)
            ensure_sucursal_allowed_for_modules(
                request.user,
                target_modules,
                sucursal_id,
                field_label="sucursal",
                action_key="puede_leer",
            )

        rows = (
            Inventario.objects.filter(
                subdivision__division__bodega__sucursal_id=sucursal_id
            )
            .values("producto_id", "producto__codigo", "producto__nombre")
            .annotate(cantidad_fisica=Sum("cantidad"))
            .filter(cantidad_fisica__gt=0)
            .order_by("producto__nombre", "producto__codigo")
        )
        rows = list(rows)
        product_ids = [int(row.get("producto_id") or 0) for row in rows if int(row.get("producto_id") or 0) > 0]
        available_by_product = get_available_transfer_quantities_by_product(
            sucursal_id=sucursal_id,
            product_ids=product_ids,
            include_reserved=False,
        )

        payload = []
        for row in rows:
            product_id = int(row.get("producto_id") or 0)
            if product_id <= 0:
                continue
            available = int(available_by_product.get(product_id, 0) or 0)
            if available <= 0:
                continue
            payload.append(
                {
                    "producto_id": product_id,
                    "codigo": row.get("producto__codigo") or "",
                    "nombre": row.get("producto__nombre") or "",
                    "cantidad_disponible": available,
                }
            )
        return Response(payload)

    @action(detail=False, methods=["get"], url_path="stock-sucursal-global")
    def stock_sucursal_global(self, request):
        """
        Stock por sucursal sin alcance por sucursal del usuario.
        Usado para solicitudes de traslado en Entradas.
        """
        sucursal_id_raw = (request.query_params.get("sucursal_id") or "").strip()
        if not sucursal_id_raw.isdigit():
            return Response(
                {"detail": "Debes enviar un sucursal_id valido."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        sucursal_id = int(sucursal_id_raw)
        rows = (
            Inventario.objects.filter(
                subdivision__division__bodega__sucursal_id=sucursal_id
            )
            .values("producto_id", "producto__codigo", "producto__nombre")
            .annotate(cantidad_fisica=Sum("cantidad"))
            .filter(cantidad_fisica__gt=0)
            .order_by("producto__nombre", "producto__codigo")
        )
        rows = list(rows)
        product_ids = [int(row.get("producto_id") or 0) for row in rows if int(row.get("producto_id") or 0) > 0]
        available_by_product = get_available_transfer_quantities_by_product(
            sucursal_id=sucursal_id,
            product_ids=product_ids,
        )

        payload = []
        for row in rows:
            product_id = int(row.get("producto_id") or 0)
            if product_id <= 0:
                continue
            available = int(available_by_product.get(product_id, 0) or 0)
            if available <= 0:
                continue
            payload.append(
                {
                    "producto_id": product_id,
                    "codigo": row.get("producto__codigo") or "",
                    "nombre": row.get("producto__nombre") or "",
                    "cantidad_disponible": available,
                }
            )
        return Response(payload)

    @action(detail=False, methods=["get"], url_path="ubicaciones-productos-sucursal")
    def ubicaciones_productos_sucursal(self, request):
        sucursal_id_raw = (request.query_params.get("sucursal_id") or "").strip()
        if not sucursal_id_raw.isdigit():
            return Response(
                {"detail": "Debes enviar un sucursal_id valido."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        producto_ids_raw = (request.query_params.get("producto_ids") or "").strip()
        product_ids = []
        for token in producto_ids_raw.split(","):
            parsed = str(token or "").strip()
            if not parsed.isdigit():
                continue
            product_id = int(parsed)
            if product_id <= 0:
                continue
            product_ids.append(product_id)

        product_ids = sorted(set(product_ids))
        if not product_ids:
            return Response(
                {"detail": "Debes enviar al menos un producto_id valido."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        sucursal_id = int(sucursal_id_raw)
        ensure_sucursal_allowed_for_modules(
            request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
            sucursal_id,
            field_label="sucursal",
            action_key="puede_leer",
        )

        product_ids_with_location = sorted(
            set(
                Inventario.objects.filter(
                    subdivision__division__bodega__sucursal_id=sucursal_id,
                    producto_id__in=product_ids,
                )
                .values_list("producto_id", flat=True)
                .distinct()
            )
        )

        return Response(
            {
                "sucursal_id": sucursal_id,
                "producto_ids": product_ids,
                "producto_ids_con_ubicacion": product_ids_with_location,
            }
        )
