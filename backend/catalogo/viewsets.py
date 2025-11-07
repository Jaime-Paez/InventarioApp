from rest_framework import filters, viewsets

from catalogo.models import Categoria, Marca, Producto, TipoCompra, TipoPago
from catalogo.serializers import (
    CategoriaSerializer,
    MarcaSerializer,
    ProductoSerializer,
    TipoCompraSerializer,
    TipoPagoSerializer,
)


class MarcaViewSet(viewsets.ModelViewSet):
    queryset = Marca.objects.all().order_by("nombre")
    serializer_class = MarcaSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class CategoriaViewSet(viewsets.ModelViewSet):
    queryset = Categoria.objects.all().order_by("nombre")
    serializer_class = CategoriaSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class TipoCompraViewSet(viewsets.ModelViewSet):
    queryset = TipoCompra.objects.all().order_by("nombre")
    serializer_class = TipoCompraSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class TipoPagoViewSet(viewsets.ModelViewSet):
    queryset = TipoPago.objects.all().order_by("nombre")
    serializer_class = TipoPagoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class ProductoViewSet(viewsets.ModelViewSet):
    queryset = Producto.objects.select_related("categoria", "marca").all().order_by("nombre")
    serializer_class = ProductoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["sku", "nombre", "categoria__nombre", "marca__nombre"]
    ordering_fields = ["nombre", "sku", "precio_venta"]
