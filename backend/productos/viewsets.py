from rest_framework import filters, viewsets
from rest_framework.permissions import IsAuthenticated

from usuarios.permissions import ProductosModulePermission

from .models import OEM, OEMProducto, Producto, ProductoAlterno
from .serializers import (
    OEMProductoSerializer,
    OEMSerializer,
    ProductoAlternoSerializer,
    ProductoSerializer,
)


class ProductoViewSet(viewsets.ModelViewSet):
    queryset = (
        Producto.objects.select_related("marca")
        .prefetch_related("casas_comerciales")
        .all()
        .order_by("nombre")
    )
    serializer_class = ProductoSerializer
    permission_classes = [IsAuthenticated, ProductosModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "codigo",
        "nombre",
        "casas_comerciales__nombre",
        "marca__nombre",
    ]
    ordering_fields = [
        "nombre",
        "codigo",
        "casas_comerciales__nombre",
        "marca__nombre",
    ]


class OEMViewSet(viewsets.ModelViewSet):
    queryset = OEM.objects.all().order_by("codigo")
    serializer_class = OEMSerializer
    permission_classes = [IsAuthenticated, ProductosModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["codigo"]
    ordering_fields = ["codigo"]


class OEMProductoViewSet(viewsets.ModelViewSet):
    queryset = (
        OEMProducto.objects.select_related("producto", "oem")
        .all()
        .order_by("producto__nombre", "oem__codigo")
    )
    serializer_class = OEMProductoSerializer
    permission_classes = [IsAuthenticated, ProductosModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "producto__codigo",
        "producto__nombre",
        "oem__codigo",
    ]
    ordering_fields = ["producto__nombre", "oem__codigo"]


class ProductoAlternoViewSet(viewsets.ModelViewSet):
    queryset = (
        ProductoAlterno.objects.select_related("producto", "alterno")
        .all()
        .order_by("producto__nombre", "alterno__nombre")
    )
    serializer_class = ProductoAlternoSerializer
    permission_classes = [IsAuthenticated, ProductosModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "producto__codigo",
        "producto__nombre",
        "alterno__codigo",
        "alterno__nombre",
    ]
    ordering_fields = ["producto__nombre", "alterno__nombre"]
