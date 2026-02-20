from rest_framework import filters, status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from usuarios.models import RolPermiso
from usuarios.permissions import (
    BodegasModulePermission,
    InventarioModulePermission,
    SucursalScopedModulePermission,
)
from usuarios.sucursal_scope import (
    apply_sucursal_scope,
    ensure_sucursal_allowed,
)

from .models import Bodega, Division, Inventario, SubDivision, Sucursal
from .serializers import (
    BodegaSerializer,
    DivisionSerializer,
    InventarioSerializer,
    SubDivisionSerializer,
    SucursalSerializer,
)


class SucursalViewSet(viewsets.ModelViewSet):
    queryset = Sucursal.objects.all().order_by("nombre")
    serializer_class = SucursalSerializer
    permission_classes = [IsAuthenticated, SucursalScopedModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]

    def _resolve_scope_module_key(self):
        if self.request.method in ("GET", "HEAD", "OPTIONS"):
            query_module = (self.request.query_params.get("modulo") or "").strip()
            valid_modules = {key for key, _ in RolPermiso.Modulos.choices}
            if query_module in valid_modules:
                return query_module
        return RolPermiso.Modulos.SUCURSALES_SUCURSALES

    def get_queryset(self):
        queryset = super().get_queryset()
        return apply_sucursal_scope(
            queryset,
            self.request.user,
            self._resolve_scope_module_key(),
            "id",
        )


class BodegaViewSet(viewsets.ModelViewSet):
    queryset = Bodega.objects.select_related("sucursal").all().order_by(
        "sucursal__nombre", "nombre"
    )
    serializer_class = BodegaSerializer
    permission_classes = [IsAuthenticated, BodegasModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "sucursal__nombre"]
    ordering_fields = ["nombre", "sucursal__nombre"]

    def get_queryset(self):
        queryset = super().get_queryset()
        return apply_sucursal_scope(
            queryset,
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            "sucursal_id",
        )

    def perform_create(self, serializer):
        sucursal = serializer.validated_data.get("sucursal")
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            getattr(sucursal, "id", None),
        )
        serializer.save()

    def perform_update(self, serializer):
        sucursal = serializer.validated_data.get("sucursal", serializer.instance.sucursal)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            getattr(sucursal, "id", None),
        )
        serializer.save()


class DivisionViewSet(viewsets.ModelViewSet):
    queryset = (
        Division.objects.select_related("tipo_division", "bodega", "bodega__sucursal")
        .all()
        .order_by("bodega__nombre", "nombre")
    )
    serializer_class = DivisionSerializer
    permission_classes = [IsAuthenticated, BodegasModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "nombre",
        "tipo_division__nombre",
        "bodega__nombre",
        "bodega__sucursal__nombre",
    ]
    ordering_fields = ["nombre", "bodega__nombre", "tipo_division__nombre"]

    def get_queryset(self):
        queryset = super().get_queryset()
        return apply_sucursal_scope(
            queryset,
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            "bodega__sucursal_id",
        )

    def perform_create(self, serializer):
        bodega = serializer.validated_data.get("bodega")
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            getattr(bodega, "sucursal_id", None),
        )
        serializer.save()

    def perform_update(self, serializer):
        bodega = serializer.validated_data.get("bodega", serializer.instance.bodega)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            getattr(bodega, "sucursal_id", None),
        )
        serializer.save()


class SubDivisionViewSet(viewsets.ModelViewSet):
    queryset = (
        SubDivision.objects.select_related(
            "division",
            "division__bodega",
            "division__bodega__sucursal",
            "division__tipo_division",
        )
        .all()
        .order_by("division__nombre", "nombre")
    )
    serializer_class = SubDivisionSerializer
    permission_classes = [IsAuthenticated, BodegasModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "division__nombre", "division__bodega__nombre"]
    ordering_fields = ["nombre", "division__nombre"]

    def get_queryset(self):
        queryset = super().get_queryset()
        return apply_sucursal_scope(
            queryset,
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            "division__bodega__sucursal_id",
        )

    def perform_create(self, serializer):
        division = serializer.validated_data.get("division")
        sucursal_id = getattr(getattr(division, "bodega", None), "sucursal_id", None)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            sucursal_id,
        )
        serializer.save()

    def perform_update(self, serializer):
        division = serializer.validated_data.get("division", serializer.instance.division)
        sucursal_id = getattr(getattr(division, "bodega", None), "sucursal_id", None)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            sucursal_id,
        )
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if Inventario.objects.filter(subdivision=instance).exists():
            return Response(
                {"detail": "No se puede eliminar la subdivisión porque tiene productos asociados."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return super().destroy(request, *args, **kwargs)


class InventarioViewSet(viewsets.ModelViewSet):
    queryset = (
        Inventario.objects.select_related(
            "producto",
            "subdivision",
            "subdivision__division",
            "subdivision__division__bodega",
            "subdivision__division__bodega__sucursal",
        )
        .all()
        .order_by("subdivision__division__bodega__nombre", "producto__nombre")
    )
    serializer_class = InventarioSerializer
    permission_classes = [IsAuthenticated, InventarioModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "producto__codigo",
        "producto__nombre",
        "subdivision__nombre",
        "subdivision__division__bodega__nombre",
        "subdivision__division__bodega__sucursal__nombre",
    ]
    ordering_fields = [
        "producto__nombre",
        "subdivision__division__bodega__nombre",
        "subdivision__division__bodega__sucursal__nombre",
    ]

    def get_queryset(self):
        queryset = super().get_queryset()
        return apply_sucursal_scope(
            queryset,
            self.request.user,
            RolPermiso.Modulos.INVENTARIO,
            "subdivision__division__bodega__sucursal_id",
        )

    def perform_create(self, serializer):
        subdivision = serializer.validated_data.get("subdivision")
        sucursal_id = getattr(
            getattr(getattr(subdivision, "division", None), "bodega", None),
            "sucursal_id",
            None,
        )
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.INVENTARIO,
            sucursal_id,
        )
        serializer.save()

    def perform_update(self, serializer):
        subdivision = serializer.validated_data.get(
            "subdivision", serializer.instance.subdivision
        )
        sucursal_id = getattr(
            getattr(getattr(subdivision, "division", None), "bodega", None),
            "sucursal_id",
            None,
        )
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.INVENTARIO,
            sucursal_id,
        )
        serializer.save()
