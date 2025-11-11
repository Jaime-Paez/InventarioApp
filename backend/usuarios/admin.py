from django.contrib import admin

from .models import Usuario, UsuarioSucursal


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
