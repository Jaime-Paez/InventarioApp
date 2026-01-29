from rest_framework.permissions import BasePermission


class ModulePermission(BasePermission):
    """Permite acceso a usuarios autenticados."""

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated)


class UsuariosModulePermission(ModulePermission):
    """Permiso específico para el módulo de Administración/Usuarios."""
