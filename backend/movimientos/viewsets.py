from django.db.models import Q
from rest_framework import filters, viewsets
from rest_framework.permissions import IsAuthenticated

from usuarios.models import RolPermiso
from usuarios.permissions import MovimientoInventarioModulePermission
from usuarios.sucursal_scope import (
    ensure_sucursal_allowed_for_modules,
    get_allowed_sucursal_ids,
)

from .models import MovimientoInventario
from .serializers import MovimientoInventarioSerializer


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
        .order_by("-fecha", "no_documento")
    )
    serializer_class = MovimientoInventarioSerializer
    permission_classes = [IsAuthenticated, MovimientoInventarioModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "no_documento",
        "sucursal__nombre",
        "sucursal_objetivo__nombre",
    ]
    ordering_fields = ["fecha", "no_documento"]

    def get_queryset(self):
        queryset = super().get_queryset()
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

    def _resolve_target_modules(self):
        permission_checker = MovimientoInventarioModulePermission()
        return permission_checker.get_target_module_keys(self.request, self)

    def perform_create(self, serializer):
        module_keys = self._resolve_target_modules()
        sucursal = serializer.validated_data.get("sucursal")
        sucursal_objetivo = serializer.validated_data.get("sucursal_objetivo")

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
