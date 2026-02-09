from rest_framework import filters, status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from usuarios.permissions import (
    BodegasModulePermission,
    InventarioModulePermission,
    SucursalesModulePermission,
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
    permission_classes = [IsAuthenticated, SucursalesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class BodegaViewSet(viewsets.ModelViewSet):
    queryset = Bodega.objects.select_related("sucursal").all().order_by(
        "sucursal__nombre", "nombre"
    )
    serializer_class = BodegaSerializer
    permission_classes = [IsAuthenticated, BodegasModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "sucursal__nombre"]
    ordering_fields = ["nombre", "sucursal__nombre"]


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
