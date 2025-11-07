from django.contrib import admin

from sucursales.models import Sucursal


@admin.register(Sucursal)
class SucursalAdmin(admin.ModelAdmin):
    list_display = ("codigo", "nombre", "ciudad", "es_principal", "activo")
    search_fields = ("codigo", "nombre", "ciudad")
    list_filter = ("ciudad", "es_principal", "activo")
