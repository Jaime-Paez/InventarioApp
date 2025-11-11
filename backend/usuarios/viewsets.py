from rest_framework import filters, viewsets

from .models import Usuario, UsuarioSucursal
from .serializers import UsuarioSerializer, UsuarioSucursalSerializer


class UsuarioViewSet(viewsets.ModelViewSet):
    """Gestión de usuarios internos."""

    queryset = Usuario.objects.all().order_by("apellidos", "nombres")
    serializer_class = UsuarioSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombres", "apellidos", "correo", "cargo"]
    ordering_fields = ["apellidos", "nombres", "correo"]


class UsuarioSucursalViewSet(viewsets.ModelViewSet):
    """Gestión de asignaciones de usuarios a sucursales."""

    queryset = (
        UsuarioSucursal.objects.select_related("usuario", "sucursal")
        .all()
        .order_by("sucursal__nombre", "usuario__apellidos")
    )
    serializer_class = UsuarioSucursalSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "usuario__nombres",
        "usuario__apellidos",
        "sucursal__nombre",
        "rol",
    ]
    ordering_fields = ["sucursal__nombre", "usuario__apellidos"]
