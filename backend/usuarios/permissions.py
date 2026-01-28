from rest_framework.permissions import BasePermission

from .models import RolPermiso
from .utils import get_permisos_efectivos, get_usuario_interno_por_correo


class ModulePermission(BasePermission):
    """Verifica permisos por módulo usando la matriz personalizada."""

    module_key = None

    METHOD_TO_ACTION = {
        "GET": "puede_leer",
        "HEAD": "puede_leer",
        "OPTIONS": "puede_leer",
        "POST": "puede_crear",
        "PUT": "puede_actualizar",
        "PATCH": "puede_actualizar",
        "DELETE": "puede_eliminar",
    }

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False

        if request.user.is_staff or request.user.is_superuser:
            return True

        action_key = self.METHOD_TO_ACTION.get(request.method)
        if not action_key:
            return False

        permission_index = self._get_permission_index(request)
        target_modules = self.get_target_module_keys(request, view)

        if not target_modules:
            return False

        for module in target_modules:
            module_permissions = permission_index.get(module, {})
            if module_permissions.get(action_key):
                return True
        return False

    def get_target_module_keys(self, request, view):
        if self.module_key is None:
            return []
        if isinstance(self.module_key, (list, tuple, set)):
            return list(self.module_key)
        return [self.module_key]

    def _get_permission_index(self, request):
        if hasattr(request, "_module_permission_index"):
            return request._module_permission_index

        email = request.user.email
        usuario_interno = get_usuario_interno_por_correo(email)
        permisos = get_permisos_efectivos(usuario_interno, email)

        index = {}
        for permiso in permisos:
            key = permiso.get("modulo")
            if not key:
                continue
            index[key] = {
                "puede_crear": bool(permiso.get("puede_crear")),
                "puede_leer": bool(permiso.get("puede_leer")),
                "puede_actualizar": bool(permiso.get("puede_actualizar")),
                "puede_eliminar": bool(permiso.get("puede_eliminar")),
            }

        request._module_permission_index = index
        return index


class UsuariosModulePermission(ModulePermission):
    """Permiso específico para el módulo de Administración/Usuarios."""

    module_key = RolPermiso.Modulos.USUARIOS
