from django.contrib import admin

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
