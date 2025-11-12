from rest_framework import filters, viewsets

from .models import Rol, Usuario, UsuarioSucursal
from .serializers import (
    RolSerializer,
    UsuarioSerializer,
    UsuarioSucursalSerializer,
)


class RolViewSet(viewsets.ModelViewSet):
    """Gestión de roles y permisos."""

    queryset = Rol.objects.prefetch_related("permisos").all().order_by("nombre")
    serializer_class = RolSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class UsuarioViewSet(viewsets.ModelViewSet):
    """Gestión de usuarios internos."""

    queryset = (
        Usuario.objects.prefetch_related("roles__permisos")
        .all()
        .order_by("apellidos", "nombres")
    )
    serializer_class = UsuarioSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombres", "apellidos", "correo", "cargo", "roles__nombre"]
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
