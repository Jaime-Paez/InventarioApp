from django.contrib import admin

from inventario.models import Inventario


@admin.register(Inventario)
class InventarioAdmin(admin.ModelAdmin):
    list_display = ("sucursal", "producto", "cantidad", "punto_reorden", "actualizado_en")
    search_fields = ("sucursal__nombre", "producto__nombre", "producto__sku")
    list_filter = ("sucursal", "producto")
