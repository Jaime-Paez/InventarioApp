from django.contrib import admin

from .models import Inventario


@admin.register(Inventario)
class InventarioAdmin(admin.ModelAdmin):
    list_display = (
        "producto",
        "subdivision",
        "estado_producto",
        "cantidad",
        "cantidad_reservada",
        "actualizado_en",
    )
    search_fields = (
        "producto__codigo",
        "producto__nombre",
        "subdivision__nombre",
        "subdivision__division__bodega__nombre",
    )
    list_filter = ("estado_producto", "subdivision__division__bodega__sucursal")
