from django.contrib import admin

from .models import Bodega, Division, Inventario, SubDivision, Sucursal


@admin.register(Sucursal)
class SucursalAdmin(admin.ModelAdmin):
    list_display = ("nombre", "direccion", "puede_compra_local")
    list_filter = ("puede_compra_local",)
    search_fields = ("nombre",)


@admin.register(Bodega)
class BodegaAdmin(admin.ModelAdmin):
    list_display = ("nombre", "sucursal")
    search_fields = ("nombre", "sucursal__nombre")


@admin.register(Division)
class DivisionAdmin(admin.ModelAdmin):
    list_display = ("nombre", "bodega", "tipo_division")
    search_fields = ("nombre", "bodega__nombre", "bodega__sucursal__nombre")


@admin.register(SubDivision)
class SubDivisionAdmin(admin.ModelAdmin):
    list_display = ("nombre", "division")
    search_fields = ("nombre", "division__nombre", "division__bodega__nombre")


@admin.register(Inventario)
class InventarioAdmin(admin.ModelAdmin):
    list_display = ("producto", "subdivision", "cantidad", "referencia")
    search_fields = (
        "producto__codigo",
        "producto__nombre",
        "subdivision__nombre",
        "subdivision__division__bodega__nombre",
    )
