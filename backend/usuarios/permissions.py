from rest_framework.permissions import BasePermission

from .models import RolPermiso
from .utils import (
    build_full_permissions,
    get_permisos_efectivos,
    get_usuario_interno_por_correo,
)


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

        if request.user.is_staff or request.user.is_superuser:
            permisos = build_full_permissions()
        else:
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


class InventarioModulePermission(ModulePermission):
    module_key = RolPermiso.Modulos.INVENTARIO


class ProductosModulePermission(ModulePermission):
    module_key = RolPermiso.Modulos.PRODUCTOS


class SucursalesModulePermission(ModulePermission):
    module_key = RolPermiso.Modulos.SUCURSALES_SUCURSALES


class BodegasModulePermission(ModulePermission):
    module_key = RolPermiso.Modulos.SUCURSALES_BODEGAS


class ProveedoresMarcasModulePermission(ModulePermission):
    module_key = RolPermiso.Modulos.PROVEEDORES_MARCAS


class ProveedoresCasasModulePermission(ModulePermission):
    module_key = RolPermiso.Modulos.PROVEEDORES_CASAS


class SolicitudesModulePermission(ModulePermission):
    module_key = RolPermiso.Modulos.SOLICITUDES


class ClientesModulePermission(ModulePermission):
    module_key = RolPermiso.Modulos.CLIENTES


class ConfiguracionModulePermission(ModulePermission):
    module_key = RolPermiso.Modulos.CONFIGURACION


class MovimientoInventarioModulePermission(ModulePermission):
    """Valida permisos dependiendo del tipo de movimiento (entrada/salida)."""

    def get_target_module_keys(self, request, view):
        from tipos.models import TipoMovimiento  # Import tardío para evitar ciclos

        tipo_movimiento = None
        tipo_movimiento_id = request.data.get("tipo_movimiento_id") or request.data.get("tipo_movimiento")

        if tipo_movimiento_id:
            tipo_movimiento = TipoMovimiento.objects.filter(pk=tipo_movimiento_id).first()
        elif view and getattr(view, "kwargs", None):
            lookup_field = getattr(view, "lookup_field", "pk")
            lookup_value = view.kwargs.get(lookup_field)
            if lookup_value:
                movimiento = view.get_queryset().filter(pk=lookup_value).first()
                if movimiento:
                    tipo_movimiento = movimiento.tipo_movimiento

        if tipo_movimiento and (tipo_movimiento.nombre or "").lower().startswith("sal"):
            return [RolPermiso.Modulos.MOVIMIENTOS_SALIDAS]

        if tipo_movimiento and (tipo_movimiento.nombre or "").lower().startswith("ent"):
            return [RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS]

        return [
            RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
            RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
        ]


class MovimientosCatalogosPermission(ModulePermission):
    """Catálogos relacionados a movimientos (tipos, subtipos, estados, pagos)."""

    module_key = [
        RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
        RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
    ]
