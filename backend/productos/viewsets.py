from rest_framework import filters, viewsets

from .models import (
    CasaCompra,
    CasaProducto,
    Pais,
    Producto,
    ProductoAlterno,
    ProductoOEM,
    ProductoReferencia,
)
from .serializers import (
    CasaCompraSerializer,
    CasaProductoSerializer,
    PaisSerializer,
    ProductoAlternoSerializer,
    ProductoOEMSerializer,
    ProductoReferenciaSerializer,
    ProductoSerializer,
)


class PaisViewSet(viewsets.ModelViewSet):
    """Catálogo de países."""

    queryset = Pais.objects.all().order_by("nombre")
    serializer_class = PaisSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "codigo_tais"]
    ordering_fields = ["nombre", "codigo_tais"]


class CasaProductoViewSet(viewsets.ModelViewSet):
    """Catálogo de casas de producto (fabricantes)."""

    queryset = CasaProducto.objects.select_related("pais").all().order_by("nombre")
    serializer_class = CasaProductoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "codigo", "pais__nombre"]
    ordering_fields = ["nombre", "codigo", "pais__nombre"]


class CasaCompraViewSet(viewsets.ModelViewSet):
    """Catálogo de proveedores o casas de compra."""

    queryset = CasaCompra.objects.select_related("pais").all().order_by("nombre")
    serializer_class = CasaCompraSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "codigo", "pais__nombre"]
    ordering_fields = ["nombre", "codigo", "pais__nombre"]


class ProductoViewSet(viewsets.ModelViewSet):
    """Gestión de productos."""

    queryset = Producto.objects.select_related("casa_producto", "casa_compra").all().order_by("nombre")
    serializer_class = ProductoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "codigo",
        "nombre",
        "casa_producto__nombre",
        "casa_compra__nombre",
    ]
    ordering_fields = ["nombre", "codigo", "casa_producto__nombre"]


class ProductoReferenciaViewSet(viewsets.ModelViewSet):
    """Gestión de códigos alternos (OCP_PRO)."""

    queryset = ProductoReferencia.objects.select_related("producto").all().order_by("codigo")
    serializer_class = ProductoReferenciaSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["codigo", "producto__codigo", "producto__nombre"]
    ordering_fields = ["codigo", "producto__codigo"]


class ProductoOEMViewSet(viewsets.ModelViewSet):
    """Gestión de códigos OEM."""

    queryset = ProductoOEM.objects.select_related("producto").all().order_by("codigo")
    serializer_class = ProductoOEMSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["codigo", "producto__codigo", "producto__nombre"]
    ordering_fields = ["codigo", "producto__codigo"]


class ProductoAlternoViewSet(viewsets.ModelViewSet):
    """Gestión de productos alternos o compatibles."""

    queryset = (
        ProductoAlterno.objects.select_related("producto", "alterno")
        .all()
        .order_by("producto__nombre", "alterno__nombre")
    )
    serializer_class = ProductoAlternoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "producto__codigo",
        "producto__nombre",
        "alterno__codigo",
        "alterno__nombre",
    ]
    ordering_fields = ["producto__nombre", "alterno__nombre"]
