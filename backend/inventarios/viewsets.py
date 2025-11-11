from rest_framework import filters, viewsets

from .models import EstadoProducto, Inventario
from .serializers import EstadoProductoSerializer, InventarioSerializer


class EstadoProductoViewSet(viewsets.ModelViewSet):
    """API para el catálogo de estados de producto."""

    queryset = EstadoProducto.objects.all().order_by("nombre")
    serializer_class = EstadoProductoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class InventarioViewSet(viewsets.ModelViewSet):
    """API para gestionar los lotes de inventario."""

    queryset = (
        Inventario.objects.select_related(
            "producto",
            "subdivision",
            "subdivision__division",
            "subdivision__division__bodega",
            "estado_producto",
        )
        .all()
        .order_by("subdivision__division__bodega__nombre", "producto__nombre")
    )
    serializer_class = InventarioSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "producto__codigo",
        "producto__nombre",
        "subdivision__nombre",
        "subdivision__division__bodega__nombre",
    ]
    ordering_fields = [
        "producto__nombre",
        "subdivision__division__bodega__nombre",
        "estado_producto__nombre",
    ]
