from decimal import Decimal, InvalidOperation

from django.db.models import DecimalField, Q, Sum, Value
from django.db.models.functions import Coalesce
from django.utils.dateparse import parse_date
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.table_filters import apply_column_filters, parse_column_filters
from inventario.models import Inventario
from solicitudes.models import Cliente

from usuarios.models import RolPermiso
from usuarios.permissions import MovimientoInventarioModulePermission
from usuarios.sucursal_scope import (
    ensure_sucursal_allowed_for_modules,
    get_allowed_sucursal_ids,
)

from .models import MovimientoInventario, SolicitudTraslado
from .serializers import MovimientoInventarioSerializer, SolicitudTrasladoSerializer


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

    def _serialize_table_rows(self, rows):
        payload = []
        for row in rows:
            payload.append(
                {
                    "id": int(row.get("id") or 0),
                    "no_documento": str(row.get("no_documento") or "").strip(),
                    "fecha": row.get("fecha"),
                    "sucursal_nombre": row.get("sucursal__nombre") or "-",
                    "sub_tipo_nombre": row.get("sub_tipo_movimiento__nombre") or "-",
                    "estado_nombre": row.get("estado_movimiento__nombre") or "-",
                    "sucursal_objetivo_nombre": row.get("sucursal_objetivo__nombre") or "-",
                    "funcional": bool(row.get("funcional")),
                    "funcional_label": "Si" if bool(row.get("funcional")) else "No",
                    "total": row.get("total_monto"),
                }
            )
        return payload

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

            allowed = get_allowed_sucursal_ids(self.request.user, module_key)
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
        table_rows = queryset.values(
            "id",
            "no_documento",
            "fecha",
            "funcional",
            "sucursal__nombre",
            "sub_tipo_movimiento__nombre",
            "estado_movimiento__nombre",
            "sucursal_objetivo__nombre",
            "total_monto",
        )

        page = self.paginate_queryset(table_rows)
        if page is not None:
            serialized = self._serialize_table_rows(page)
            return self.get_paginated_response(serialized)

        serialized = self._serialize_table_rows(table_rows)
        return Response(serialized)

    def _resolve_target_modules(self):
        permission_checker = MovimientoInventarioModulePermission()
        return permission_checker.get_target_module_keys(self.request, self)

    def _is_traslado_movement(self, serializer):
        sub_tipo = serializer.validated_data.get("sub_tipo_movimiento")
        nombre = str(getattr(sub_tipo, "nombre", "") or "").strip().lower()
        return "trasl" in nombre

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
        )
        if not skip_target_scope_validation:
            ensure_sucursal_allowed_for_modules(
                self.request.user,
                module_keys,
                getattr(sucursal_objetivo, "id", None),
                field_label="sucursal objetivo",
            )
        serializer.save()

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
        )
        ensure_sucursal_allowed_for_modules(
            self.request.user,
            module_keys,
            getattr(sucursal_objetivo, "id", None),
                field_label="sucursal objetivo",
            )
        serializer.save()

    @action(detail=False, methods=["get", "post"], url_path="solicitudes-traslado")
    def solicitudes_traslado(self, request):
        if request.method.lower() == "post":
            serializer = SolicitudTrasladoSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)

            sucursal_solicitante = serializer.validated_data.get("sucursal_solicitante")
            ensure_sucursal_allowed_for_modules(
                request.user,
                [RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS],
                getattr(sucursal_solicitante, "id", None),
                field_label="sucursal solicitante",
            )

            solicitud = serializer.save()
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
            )
            queryset = queryset.filter(sucursal_proveedora_id=sucursal_proveedora_id)
        else:
            allowed = get_allowed_sucursal_ids(
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
        allowed_modules = {
            RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
            RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
        }
        target_module = (
            modulo
            if modulo in allowed_modules
            else RolPermiso.Modulos.MOVIMIENTOS_SALIDAS
        )
        ensure_sucursal_allowed_for_modules(
            request.user,
            [target_module],
            sucursal_id,
            field_label="sucursal",
        )

        rows = (
            Inventario.objects.filter(
                subdivision__division__bodega__sucursal_id=sucursal_id
            )
            .values("producto_id", "producto__codigo", "producto__nombre")
            .annotate(cantidad_disponible=Sum("cantidad"))
            .filter(cantidad_disponible__gt=0)
            .order_by("producto__nombre", "producto__codigo")
        )

        payload = [
            {
                "producto_id": int(row["producto_id"]),
                "codigo": row.get("producto__codigo") or "",
                "nombre": row.get("producto__nombre") or "",
                "cantidad_disponible": int(row.get("cantidad_disponible") or 0),
            }
            for row in rows
        ]
        return Response(payload)
