from rest_framework import filters, viewsets

from inventario.models import Inventario
from inventario.serializers import InventarioSerializer


class InventarioViewSet(viewsets.ModelViewSet):
    queryset = Inventario.objects.select_related("sucursal", "producto").all()
    serializer_class = InventarioSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["producto__nombre", "producto__sku", "sucursal__nombre"]
    ordering_fields = ["cantidad", "punto_reorden", "actualizado_en"]
    ordering = ["sucursal__nombre", "producto__nombre"]

    def get_queryset(self):
        queryset = super().get_queryset()
        sucursal = self.request.query_params.get("sucursal")
        if sucursal:
            queryset = queryset.filter(sucursal_id=sucursal)
        producto = self.request.query_params.get("producto")
        if producto:
            queryset = queryset.filter(producto_id=producto)
        return queryset
