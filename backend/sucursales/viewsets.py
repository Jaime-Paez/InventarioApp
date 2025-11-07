from rest_framework import filters, viewsets

from sucursales.models import Sucursal
from sucursales.serializers import SucursalSerializer


class SucursalViewSet(viewsets.ModelViewSet):
    queryset = Sucursal.objects.all().order_by("nombre")
    serializer_class = SucursalSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["codigo", "nombre", "ciudad"]
    ordering_fields = ["nombre", "codigo"]

    def get_queryset(self):
        queryset = super().get_queryset()
        activo = self.request.query_params.get("activo")
        if activo in {"true", "false", "1", "0"}:
            queryset = queryset.filter(activo=activo.lower() in {"true", "1"})
        return queryset
