from decimal import Decimal, InvalidOperation
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Count, DecimalField, ExpressionWrapper, F, Q, Sum, Value
from django.db.models.deletion import ProtectedError
from django.db.models.functions import Coalesce
from django.utils.dateparse import parse_date
from django.utils import timezone
from rest_framework import filters, serializers as drf_serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.table_filters import apply_column_filters, parse_column_filters
from app.models import ReminderState
from app.views import (
    _merge_reminder,
    _merge_transfer_history,
    _normalize_reminder_list,
    _purge_reminders_for_context,
    _sanitize_transfer_history,
)
from inventario.models import Inventario, SubDivision, Sucursal
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
    generate_entry_document_number,
    generate_transfer_request_document_number,
    normalize_name,
    resolve_subtipo_key,
)
from .stock_availability import get_available_transfer_quantities_by_product
from .transfer_helpers import (
    build_sale_stock_change_extra_reason,
    cancel_pending_transfer_requests,
    REMINDERS_SYNC_FLAG,
)

ALLOWED_STOCK_MODULES = {
    RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
    RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
}
TRANSFER_ISSUE_REMINDER_KIND = "solicitud_traslado_inconveniente"
TRANSFER_ISSUE_REMINDER_CONTEXT_TYPE = "traslado_inconveniente"


class MovimientoInventarioViewSet(viewsets.ModelViewSet):
    """Gestión de movimientos de inventario."""

    queryset = (
        MovimientoInventario.objects.select_related(
            "sucursal",
            "sucursal_objetivo",
            "tipo_movimiento",
            "sub_tipo_movimiento",
            "estado_movimiento",
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
        "sucursal__nombre",
        "sucursal_objetivo__nombre",
        "sub_tipo_movimiento__nombre",
        "estado_movimiento__nombre",
    ]
    ordering_fields = [
        "fecha",
        "id",
        "no_documento",
        "sucursal__nombre",
        "sucursal_objetivo__nombre",
        "sub_tipo_movimiento__nombre",
        "estado_movimiento__nombre",
        "funcional",
        "total_monto",
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

            payload.append(
                {
                    "id": movement_id,
                    "no_documento": str(
                        row.get("no_documento") if is_mapping else getattr(row, "no_documento", "")
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
                    "sucursal_objetivo_nombre": (
                        row.get("sucursal_objetivo__nombre")
                        if is_mapping
                        else getattr(getattr(row, "sucursal_objetivo", None), "nombre", "")
                    ) or "-",
                    "funcional": bool(row.get("funcional") if is_mapping else getattr(row, "funcional", False)),
                    "funcional_label": "Si"
                    if bool(row.get("funcional") if is_mapping else getattr(row, "funcional", False))
                    else "No",
                    "total": row.get("total_monto") if is_mapping else getattr(row, "total_monto", None),
                    "detalles": detalles_payload,
                    "es_solicitud_traslado": False,
                    "solicitud_traslado_id": None,
                    "_sort_created_at": (
                        fecha_value.isoformat()
                        if getattr(fecha_value, "isoformat", None)
                        else str(fecha_value or "").strip()
                    ),
                    "_sort_id": movement_id,
                }
            )
        return payload

    @staticmethod
    def _resolve_solicitud_estado_label(solicitud):
        estado = str(getattr(solicitud, "estado", "") or "").strip().lower()
        if estado == SolicitudTraslado.Estados.PENDIENTE:
            return "Solicitud pendiente"
        if estado == SolicitudTraslado.Estados.CANCELADA:
            return "Rechazada"
        if estado == SolicitudTraslado.Estados.APROBADA:
            if getattr(solicitud, "movimiento_salida_id", None):
                return "Solicitud enviada"
            return "Solicitud aceptada"
        return estado.capitalize() if estado else "-"

    def _serialize_solicitud_table_rows(self, solicitudes):
        payload = []
        for solicitud in solicitudes:
            solicitud_id = int(getattr(solicitud, "id", 0) or 0)
            estado_label = self._resolve_solicitud_estado_label(solicitud)
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
                    "fecha": getattr(solicitud, "fecha", None),
                    "sucursal_nombre": (
                        getattr(getattr(solicitud, "sucursal_solicitante", None), "nombre", "")
                        or "-"
                    ),
                    "sub_tipo_nombre": "Traslado (Solicitud)",
                    "estado_nombre": estado_label,
                    "sucursal_objetivo_nombre": (
                        getattr(getattr(solicitud, "sucursal_proveedora", None), "nombre", "")
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
                    "detalles": detalles_payload,
                    "movimiento_salida_id": getattr(
                        solicitud, "movimiento_salida_id", None
                    ),
                    "movimiento_entrada_id": getattr(
                        solicitud, "movimiento_entrada_id", None
                    ),
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
                }
            )
        return payload

    @action(detail=False, methods=['get'], url_path='next-document-number')
    def next_document_number(self, request):
        tipo_movimiento_id = request.query_params.get("tipo_movimiento_id")
        sub_tipo_movimiento_id = request.query_params.get("sub_tipo_movimiento_id")
        sucursal_id = request.query_params.get("sucursal_id")
        sucursal_objetivo_id = request.query_params.get("sucursal_objetivo_id")

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

        try:
            document_number = generate_entry_document_number(
                tipo_movimiento,
                subtipo_key,
                sucursal,
                sucursal_objetivo,
            )
        except drf_serializers.ValidationError as exc:
            return Response(exc.detail, status=status.HTTP_400_BAD_REQUEST)

        return Response({"no_documento": document_number})

    def _resolve_tabla_ordering_tokens(self):
        raw = (self.request.query_params.get("ordering") or "").strip()
        if not raw:
            return ["-_sort_created_at", "-fecha", "-id"]
        tokens = [token.strip() for token in raw.split(",") if token.strip()]
        return tokens or ["-_sort_created_at", "-fecha", "-id"]

    def _normalize_table_sort_value(self, value, field):
        if field in {"total", "_sort_id"}:
            try:
                return Decimal(str(value))
            except (InvalidOperation, TypeError, ValueError):
                return Decimal("0")

        if value is None:
            return ""
        if isinstance(value, bool):
            return 1 if value else 0
        if hasattr(value, "isoformat"):
            return value.isoformat()
        return str(value).strip().lower()

    def _sort_table_payload(self, rows):
        ordering_map = {
            "_sort_created_at": "_sort_created_at",
            "id": "_sort_id",
            "no_documento": "no_documento",
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

        if not (self.request.user.is_staff or self.request.user.is_superuser):
            allowed = get_readable_sucursal_ids(
                self.request.user,
                RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
            )
            if allowed is not None:
                if not allowed:
                    return []
                queryset = queryset.filter(sucursal_solicitante_id__in=sorted(allowed))

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

    def get_queryset(self):
        queryset = super().get_queryset().annotate(
            total_monto=Coalesce(
                Sum("detalles__valor_total"),
                Value(0, output_field=DecimalField(max_digits=14, decimal_places=2)),
            )
        )
        params = self.request.query_params

        tipo_param = self._resolve_tipo_param()
        if tipo_param == "salida":
            queryset = queryset.filter(tipo_movimiento__nombre__istartswith="sal")
        elif tipo_param == "entrada":
            queryset = queryset.filter(tipo_movimiento__nombre__istartswith="ent")

        queryset = self._apply_subtipo_filter(queryset)

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
            matching_movement_ids = DetalleMovimiento.objects.filter(
                Q(producto__codigo__icontains=search_term)
                | Q(producto__nombre__icontains=search_term)
            ).values_list("movimiento_inventario_id", flat=True)
            search_query = (
                Q(no_documento__icontains=search_term)
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
                "fecha": {"lookup": "fecha", "type": "date"},
                "sucursal_nombre": "sucursal__nombre",
                "sub_tipo_nombre": "sub_tipo_movimiento__nombre",
                "estado_nombre": "estado_movimiento__nombre",
                "sucursal_objetivo_nombre": "sucursal_objetivo__nombre",
                "total": {"lookup": "total_monto", "type": "number"},
            },
        )

        if self.request.user.is_staff or self.request.user.is_superuser:
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
                Q(tipo_movimiento__nombre__istartswith=prefix) & branch_filter
            )

        if not module_filters:
            return queryset.none()

        combined = module_filters.pop()
        for extra_filter in module_filters:
            combined |= extra_filter
        return queryset.filter(combined)

    @action(detail=False, methods=["get"], url_path="tabla")
    def tabla(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())

        tipo_param = self._resolve_tipo_param()
        if tipo_param != "entrada":
            page = self.paginate_queryset(queryset)
            if page is not None:
                serialized = self._serialize_table_rows(page)
                return self.get_paginated_response(
                    self._strip_internal_table_fields(serialized)
                )

            serialized = self._serialize_table_rows(queryset)
            return Response(self._strip_internal_table_fields(serialized))

        serialized_movimientos = self._serialize_table_rows(queryset)
        serialized_solicitudes = self._get_solicitudes_for_entrada_table()
        combined_rows = self._sort_table_payload(
            [*serialized_movimientos, *serialized_solicitudes]
        )

        page = self.paginate_queryset(combined_rows)
        if page is not None:
            return self.get_paginated_response(self._strip_internal_table_fields(page))

        return Response(self._strip_internal_table_fields(combined_rows))

    def _resolve_target_modules(self):
        permission_checker = MovimientoInventarioModulePermission()
        return permission_checker.get_target_module_keys(self.request, self)

    def _is_traslado_movement(self, serializer):
        sub_tipo = serializer.validated_data.get("sub_tipo_movimiento")
        nombre = str(getattr(sub_tipo, "nombre", "") or "").strip().lower()
        return "trasl" in nombre

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
        serializer = self.get_serializer(instance, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        self.perform_update(serializer)
        if getattr(instance, "_prefetched_objects_cache", None):
            instance._prefetched_objects_cache = {}
        response_data = dict(serializer.data)
        if serializer.context.get(REMINDERS_SYNC_FLAG):
            response_data[REMINDERS_SYNC_FLAG] = True
        return Response(response_data)

    def perform_create(self, serializer):
        module_keys = self._resolve_target_modules()
        sucursal = serializer.validated_data.get("sucursal")
        sucursal_objetivo = serializer.validated_data.get("sucursal_objetivo")
        solicitud_traslado = serializer.validated_data.get("solicitud_traslado")
        skip_target_scope_validation = bool(
            solicitud_traslado is not None and self._is_traslado_movement(serializer)
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
        movement = serializer.save()
        reminder_added = False
        if solicitud_traslado:
            reminder_added = self._append_transfer_shipment_reminder(
                solicitud=solicitud_traslado,
                actor_user=self.request.user,
            )
        elif self._is_traslado_movement(serializer):
            raw_ids = self.request.data.get("recipients_ids", [])
            recipient_ids = [i for i in (raw_ids if isinstance(raw_ids, list) else []) if i]
            if recipient_ids:
                reminder_added = self._append_direct_transfer_shipment_reminder(
                    movement=movement,
                    actor_user=self.request.user,
                    recipient_ids=recipient_ids,
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

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
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
            is_active=True
        ).filter(
            Q(is_staff=True)
            | Q(is_superuser=True)
            | Q(id__in=sorted(scoped_user_ids | assigned_user_ids))
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
            Q(is_staff=True) | Q(is_superuser=True)
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
        for candidate in selected_recipients:
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
                "completedBy": [],
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
            )
            seed_history = self._get_transfer_context_history_from_payload(
                normalized,
                solicitud_id=solicitud_id,
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

            for candidate in provider_recipients:
                append_unique(candidate)
            append_unique(request_creator)

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
        actor_user,
        recipient_ids,
    ):
        if not movement or not recipient_ids:
            return False

        movement_id = int(getattr(movement, "id", 0) or 0)
        if movement_id <= 0:
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
                "id": str(movement_id),
                "label": context_label,
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
            inconveniente.historial.select_related("actor").all().order_by("-created_at", "-id")
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
            "producto_id": int(inconveniente.producto_id),
            "producto_codigo": str(getattr(getattr(inconveniente, "producto", None), "codigo", "") or "").strip(),
            "producto_nombre": str(getattr(getattr(inconveniente, "producto", None), "nombre", "") or "").strip(),
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

    @action(detail=False, methods=["get", "post"], url_path="solicitudes-traslado")
    def solicitudes_traslado(self, request):
        if request.method.lower() == "post":
            serializer = SolicitudTrasladoSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            reminder_recipient_ids = serializer.validated_data.get("recordatorio_destinatario_ids") or []

            sucursal_solicitante = serializer.validated_data.get("sucursal_solicitante")
            ensure_sucursal_allowed_for_modules(
                request.user,
                [RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
                getattr(sucursal_solicitante, "id", None),
                field_label="sucursal solicitante",
                action_key="puede_crear",
            )

            solicitud = serializer.save()
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
        if page is not None:
            serializer = SolicitudTrasladoSerializer(page, many=True)
            return self.get_paginated_response(serializer.data)

        serializer = SolicitudTrasladoSerializer(queryset, many=True)
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

        ensure_sucursal_allowed_for_modules(
            request.user,
            [RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
            solicitud.sucursal_solicitante_id,
            field_label="sucursal solicitante",
            action_key="puede_actualizar",
        )

        if request.method.upper() != "DELETE" and solicitud.estado not in {
            SolicitudTraslado.Estados.PENDIENTE,
            SolicitudTraslado.Estados.CANCELADA,
        }:
            return Response(
                {
                    "detail": (
                        "Solo se pueden editar solicitudes pendientes o rechazadas de traslado."
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
            ensure_sucursal_allowed_for_modules(
                request.user,
                [RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
                solicitud.sucursal_solicitante_id,
                field_label="sucursal solicitante",
                action_key="puede_eliminar",
            )
            if solicitud.estado != SolicitudTraslado.Estados.PENDIENTE:
                return Response(
                    {"detail": "Solo se pueden eliminar solicitudes de traslado pendientes."},
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

        serializer = SolicitudTrasladoSerializer(instance=solicitud, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        updated = serializer.save()
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
        if allowed_recipient_ids:
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

                detalles = list(solicitud_locked.detalles.select_related("producto").all())
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

                solicitud_locked.estado = SolicitudTraslado.Estados.APROBADA
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

            self._append_transfer_decision_result_reminder(
                solicitud=solicitud_locked,
                actor_user=request.user,
                decision_status="aceptada",
            )
            output = SolicitudTrasladoSerializer(instance=solicitud_locked)
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

        motivo = str(request.data.get("motivo") or "").strip() or "Pedido cancelado por el solicitante."
        solicitud.motivo_rechazo = motivo
        solicitud.rechazada_por = request.user
        solicitud.rechazada_en = timezone.now()
        solicitud.save(
            update_fields=[
                "motivo_rechazo",
                "rechazada_por",
                "rechazada_en",
                "updated_at",
            ]
        )

        self._append_transfer_decision_result_reminder(
            solicitud=solicitud,
            actor_user=request.user,
            decision_status="cancelado",
            rejection_reason=motivo,
        )

        output = SolicitudTrasladoSerializer(instance=solicitud)
        return Response(
            {
                "detail": "Pedido cancelado correctamente.",
                "decision": "cancelado",
                "solicitud": output.data,
            },
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
            )

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
                "completedBy": [],
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

        allowed = get_allowed_sucursal_ids(
            request.user,
            RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
            action_key=("puede_crear", "puede_actualizar"),
        )
        if allowed is not None:
            if not allowed:
                return Response([], status=status.HTTP_200_OK)
            # Intersect with the user's directly-assigned sucursales so that
            # users with entradas permissions on a remote branch (e.g. the sender)
            # don't see incoming shipments destined for that branch in their feed.
            user_assigned_ids = set(
                UsuarioSucursal.objects.filter(usuario=request.user).values_list(
                    "sucursal_id", flat=True
                )
            )
            if user_assigned_ids:
                allowed = allowed & user_assigned_ids
            if not allowed:
                return Response([], status=status.HTTP_200_OK)
            queryset = queryset.filter(sucursal_solicitante_id__in=sorted(allowed))

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
            for detalle in movimiento_entrada.detalles.select_related("producto").all():
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
                    "estado_entrada": str(getattr(movimiento_entrada.estado_movimiento, "nombre", "") or "").strip(),
                    "descripcion": str(solicitud.descripcion or "").strip(),
                    "detalles": detalles_payload,
                    "inconvenientes_pendientes": pending_issue_count_by_solicitud.get(int(solicitud.id), 0),
                }
            )

        return Response(payload, status=status.HTTP_200_OK)

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
                {"detail": "La recepcion ya fue registrada anteriormente."},
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

            if cantidad_recibida < 0 or cantidad_recibida > cantidad_enviada:
                return Response(
                    {
                        "detail": (
                            f"La cantidad recibida para producto {product_id} debe estar entre 0 y {cantidad_enviada}."
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

            if cantidad_recibida > 0 and not ubicaciones:
                return Response(
                    {
                        "detail": (
                            f"Debes ubicar el producto {product_id} en al menos una subdivision."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if cantidad_ubicada != cantidad_recibida:
                return Response(
                    {
                        "detail": (
                            f"La suma de ubicaciones para producto {product_id} ({cantidad_ubicada}) "
                            f"debe coincidir con la cantidad recibida ({cantidad_recibida})."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

            cantidad_faltante = int(cantidad_enviada - cantidad_recibida)
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
                    {"detail": "La recepcion ya fue registrada anteriormente."},
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
        if total_faltante > 0:
            try:
                inconvenience_reminder_sent = self._sync_transfer_inconvenience_reminder(
                    solicitud=solicitud_locked,
                    actor_user=request.user,
                )
            except Exception:
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
        if not (request.user.is_staff or request.user.is_superuser):
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

        payload = [self._serialize_inconveniente(row) for row in queryset]
        return Response(payload, status=status.HTTP_200_OK)

    @action(
        detail=False,
        methods=["post"],
        url_path=r"traslados-inconvenientes/(?P<inconveniente_id>\d+)/resolver",
    )
    def resolver_traslado_inconveniente(self, request, inconveniente_id=None):
        if not (request.user.is_staff or request.user.is_superuser):
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

        if decision not in {"sumar_solicitante", "sumar_proveedora", "perdido"}:
            return Response(
                {
                    "detail": (
                        "Debes enviar una decision valida: sumar_solicitante, sumar_proveedora o perdido."
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

            cantidad_faltante = int(inconveniente_locked.cantidad_faltante or 0)
            if cantidad_faltante <= 0:
                return Response(
                    {"detail": "El inconveniente no tiene cantidad faltante pendiente."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            sucursal_resolucion_id = None
            subdivision_resolucion_id = None
            resolucion = ""
            estado_resultado = TrasladoInconveniente.Estados.RESUELTO

            if decision in {"sumar_solicitante", "sumar_proveedora"}:
                target_branch_id = (
                    int(inconveniente_locked.solicitud.sucursal_solicitante_id)
                    if decision == "sumar_solicitante"
                    else int(inconveniente_locked.solicitud.sucursal_proveedora_id)
                )
                subdivision_id_raw = str(request.data.get("subdivision_id") or "").strip()
                if not subdivision_id_raw.isdigit():
                    return Response(
                        {"detail": "Debes indicar una subdivision valida para sumar inventario."},
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

                self._add_stock_to_subdivision(
                    subdivision_id=int(subdivision.id),
                    producto_id=int(inconveniente_locked.producto_id),
                    cantidad=cantidad_faltante,
                )
                sucursal_resolucion_id = target_branch_id
                subdivision_resolucion_id = int(subdivision.id)
                resolucion = (
                    TrasladoInconveniente.Resoluciones.SUMAR_SOLICITANTE
                    if decision == "sumar_solicitante"
                    else TrasladoInconveniente.Resoluciones.SUMAR_PROVEEDORA
                )
            else:
                resolucion = TrasladoInconveniente.Resoluciones.PERDIDO
                estado_resultado = TrasladoInconveniente.Estados.PERDIDO

            inconveniente_locked.estado = estado_resultado
            inconveniente_locked.resolucion = resolucion
            inconveniente_locked.sucursal_resolucion_id = sucursal_resolucion_id
            inconveniente_locked.subdivision_resolucion_id = subdivision_resolucion_id
            inconveniente_locked.motivo = motivo
            inconveniente_locked.resuelto_por = request.user
            inconveniente_locked.save(
                update_fields=[
                    "estado",
                    "resolucion",
                    "sucursal_resolucion",
                    "subdivision_resolucion",
                    "motivo",
                    "resuelto_por",
                    "updated_at",
                ]
            )

            action_label = (
                "sumado_a_sucursal"
                if decision in {"sumar_solicitante", "sumar_proveedora"}
                else "marcado_como_perdido"
            )
            detail_text = (
                f"Se resolvio el faltante de {cantidad_faltante} unidades."
                if decision in {"sumar_solicitante", "sumar_proveedora"}
                else f"Se marco como perdido el faltante de {cantidad_faltante} unidades."
            )
            if motivo:
                detail_text = f"{detail_text} Motivo: {motivo}"

            TrasladoInconvenienteHistorial.objects.create(
                inconveniente=inconveniente_locked,
                accion=action_label,
                detalle=detail_text,
                actor=request.user,
            )

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
                solicitud=getattr(inconveniente_out, "solicitud", None) or inconveniente.solicitud,
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
        if not query:
            return Response({"results": []}, status=status.HTTP_200_OK)

        tokens = [token for token in query.split() if token]
        search_q = Q(cedula_ruc__icontains=query)
        if tokens:
            for token in tokens:
                search_q |= Q(nombres__icontains=token) | Q(apellidos__icontains=token)
        else:
            search_q |= Q(nombres__icontains=query) | Q(apellidos__icontains=query)

        queryset = Cliente.objects.filter(search_q).order_by("nombres", "apellidos").distinct()[:10]
        payload = []
        for cliente in queryset:
            nombres = str(getattr(cliente, "nombres", "") or "").strip()
            apellidos = str(getattr(cliente, "apellidos", "") or "").strip()
            payload.append(
                {
                    "id": int(cliente.id),
                    "nombres": nombres,
                    "apellidos": apellidos,
                    "nombre_completo": f"{nombres} {apellidos}".strip(),
                    "cedula_ruc": str(getattr(cliente, "cedula_ruc", "") or "").strip(),
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
