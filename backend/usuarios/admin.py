from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.contrib.auth.models import Group, Permission

from .models import Rol, RolPermiso, Usuario, UsuarioSucursal


class RolPermisoInline(admin.TabularInline):
    model = RolPermiso
    extra = 0
    fields = (
        "modulo",
        "submodulo",
        "puede_crear",
        "puede_leer",
        "puede_actualizar",
        "puede_eliminar",
    )


@admin.register(Rol)
class RolAdmin(admin.ModelAdmin):
    list_display = ("nombre", "activo", "es_personalizado")
    list_filter = ("activo", "es_personalizado")
    search_fields = ("nombre",)
    inlines = [RolPermisoInline]


@admin.register(Usuario)
class UsuarioAdmin(admin.ModelAdmin):
    list_display = ("nombres", "apellidos", "correo", "cargo", "activo")
    search_fields = ("nombres", "apellidos", "correo", "cargo")
    list_filter = ("activo",)


@admin.register(UsuarioSucursal)
class UsuarioSucursalAdmin(admin.ModelAdmin):
    list_display = ("usuario", "sucursal", "rol", "es_responsable")
    search_fields = (
        "usuario__nombres",
        "usuario__apellidos",
        "sucursal__nombre",
        "rol",
    )
    list_filter = ("es_responsable", "sucursal")


# ---- Ocultar grupos/permisos del admin nativo de Django ----
User = get_user_model()


class UserAdmin(DjangoUserAdmin):
    """User admin sin gestión de grupos ni permisos nativos."""

    exclude = ("groups", "user_permissions")

    def get_fieldsets(self, request, obj=None):
        fieldsets = super().get_fieldsets(request, obj)
        # Filtra cualquier sección que involucre grupos/permisos
        filtered = []
        for title, fields in fieldsets:
            if not fields:
                continue
            if any(field in ("groups", "user_permissions") for field in fields):
                continue
            filtered.append((title, fields))
        return tuple(filtered)


try:
    admin.site.unregister(Group)
except admin.sites.NotRegistered:
    pass

try:
    admin.site.unregister(Permission)
except admin.sites.NotRegistered:
    pass

try:
    admin.site.unregister(User)
except admin.sites.NotRegistered:
    pass

admin.site.register(User, UserAdmin)
