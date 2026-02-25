from decimal import Decimal, InvalidOperation

from django.db.models import Case, CharField, Value, When
from django.utils.dateparse import parse_date
from rest_framework import filters, status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.table_filters import apply_column_filters, parse_column_filters
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
            "producto__marca",
            "subdivision",
            "subdivision__division",
            "subdivision__division__bodega",
            "subdivision__division__bodega__sucursal",
        )
        .prefetch_related("producto__casas_comerciales", "producto__oem_productos__oem")
        .all()
        .order_by("subdivision__division__bodega__nombre", "producto__nombre")
    )
    serializer_class = InventarioSerializer
    permission_classes = [IsAuthenticated, InventarioModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "producto__codigo",
        "producto__nombre",
        "producto__descripcion",
        "producto__marca__nombre",
        "producto__casas_comerciales__nombre",
        "producto__oem_productos__oem__codigo",
        "subdivision__nombre",
        "subdivision__division__nombre",
        "subdivision__division__bodega__nombre",
        "subdivision__division__bodega__sucursal__nombre",
        "referencia",
    ]
    ordering_fields = [
        "producto__codigo",
        "producto__nombre",
        "producto__marca__nombre",
        "producto__pieza_original",
        "producto__costo_minimo",
        "producto__precio",
        "cantidad",
        "subdivision__nombre",
        "subdivision__division__nombre",
        "subdivision__division__bodega__nombre",
        "subdivision__division__bodega__sucursal__nombre",
    ]

    def get_queryset(self):
        queryset = super().get_queryset()
        queryset = apply_sucursal_scope(
            queryset,
            self.request.user,
            RolPermiso.Modulos.INVENTARIO,
            "subdivision__division__bodega__sucursal_id",
        )
        queryset = queryset.annotate(
            pieza_original_label_text=Case(
                When(producto__pieza_original=True, then=Value("Si")),
                default=Value("No"),
                output_field=CharField(),
            )
        )
        params = self.request.query_params

        producto_ids_raw = (params.get("producto_ids") or "").strip()
        if producto_ids_raw:
            ids = []
            for raw in producto_ids_raw.split(","):
                token = raw.strip()
                if token.isdigit():
                    ids.append(int(token))
            if ids:
                queryset = queryset.filter(producto_id__in=ids)
            else:
                return queryset.none()

        codigo = (params.get("codigo") or "").strip()
        if codigo:
            queryset = queryset.filter(producto__codigo__icontains=codigo)

        nombre = (params.get("nombre") or "").strip()
        if nombre:
            queryset = queryset.filter(producto__nombre__icontains=nombre)

        descripcion = (params.get("descripcion") or "").strip()
        if descripcion:
            queryset = queryset.filter(producto__descripcion__icontains=descripcion)

        marca = (params.get("marca") or "").strip()
        if marca:
            queryset = queryset.filter(producto__marca__nombre__icontains=marca)

        casa_comercial = (params.get("casa_comercial") or "").strip()
        if casa_comercial:
            queryset = queryset.filter(
                producto__casas_comerciales__nombre__icontains=casa_comercial
            )

        oem = (params.get("oem") or "").strip()
        if oem:
            queryset = queryset.filter(producto__oem_productos__oem__codigo__icontains=oem)

        pieza_original = (params.get("pieza_original") or "").strip().lower()
        if pieza_original in {"true", "1", "si"}:
            queryset = queryset.filter(producto__pieza_original=True)
        elif pieza_original in {"false", "0", "no"}:
            queryset = queryset.filter(producto__pieza_original=False)

        costo_minimo = (params.get("costo_minimo") or "").strip()
        if costo_minimo:
            try:
                queryset = queryset.filter(producto__costo_minimo=Decimal(costo_minimo))
            except (InvalidOperation, ValueError):
                pass

        precio = (params.get("precio") or "").strip()
        if precio:
            try:
                queryset = queryset.filter(producto__precio=Decimal(precio))
            except (InvalidOperation, ValueError):
                pass

        fecha_creacion = (params.get("fecha_creacion") or "").strip()
        if fecha_creacion:
            parsed = parse_date(fecha_creacion)
            if parsed:
                queryset = queryset.filter(producto__creado_en__date=parsed)

        cantidad_min = (params.get("cantidad_min") or "").strip()
        if cantidad_min:
            try:
                queryset = queryset.filter(cantidad__gte=max(0, int(cantidad_min)))
            except (TypeError, ValueError):
                pass

        cantidad_max = (params.get("cantidad_max") or "").strip()
        if cantidad_max:
            try:
                queryset = queryset.filter(cantidad__lte=max(0, int(cantidad_max)))
            except (TypeError, ValueError):
                pass

        queryset = apply_column_filters(
            queryset,
            parse_column_filters(params.get("column_filters")),
            {
                "codigo": "producto__codigo",
                "nombre": "producto__nombre",
                "marca_nombre": "producto__marca__nombre",
                "pieza_original_label": "pieza_original_label_text",
                "casa_comercial_nombre": "producto__casas_comerciales__nombre",
                "costo_minimo": {"lookup": "producto__costo_minimo", "type": "number"},
                "precio": {"lookup": "producto__precio", "type": "number"},
                "cantidad": {"lookup": "cantidad", "type": "number"},
                "ubicacion": "subdivision__division__bodega__sucursal__nombre",
            },
        )
        return queryset.distinct()

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
