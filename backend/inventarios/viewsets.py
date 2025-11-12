from rest_framework import filters, viewsets

from .models import Inventario
from .serializers import InventarioSerializer


class InventarioViewSet(viewsets.ModelViewSet):
    """API para gestionar los lotes de inventario."""

    queryset = (
        Inventario.objects.select_related(
            "producto",
            "subdivision",
            "subdivision__division",
            "subdivision__division__bodega",
            "subdivision__division__bodega__sucursal",
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
        "subdivision__division__bodega__sucursal__nombre",
    ]
    ordering_fields = [
        "producto__nombre",
        "subdivision__division__bodega__nombre",
        "subdivision__division__bodega__sucursal__nombre",
        "estado_producto__nombre",
    ]
