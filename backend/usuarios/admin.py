from django.contrib import admin

from usuarios.models import Usuario


@admin.register(Usuario)
class UsuarioAdmin(admin.ModelAdmin):
    list_display = ("nombre", "email", "rol", "sucursal", "activo")
    search_fields = ("nombre", "email")
    list_filter = ("rol", "activo", "sucursal")
