from rest_framework import filters, viewsets

from usuarios.models import Usuario
from usuarios.serializers import UsuarioSerializer


class UsuarioViewSet(viewsets.ModelViewSet):
    queryset = Usuario.objects.select_related("sucursal").all().order_by("nombre")
    serializer_class = UsuarioSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "email", "rol", "sucursal__nombre"]
    ordering_fields = ["nombre", "rol"]

    def get_queryset(self):
        queryset = super().get_queryset()
        rol = self.request.query_params.get("rol")
        if rol:
            queryset = queryset.filter(rol=rol)
        sucursal = self.request.query_params.get("sucursal")
        if sucursal:
            queryset = queryset.filter(sucursal_id=sucursal)
        activo = self.request.query_params.get("activo")
        if activo in {"true", "false", "1", "0"}:
            queryset = queryset.filter(activo=activo.lower() in {"true", "1"})
        return queryset
