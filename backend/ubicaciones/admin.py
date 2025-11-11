from django.contrib import admin

from .models import Bodega, Division, Sucursal, SubDivision, TipoDivision


@admin.register(Sucursal)
class SucursalAdmin(admin.ModelAdmin):
    list_display = ("codigo", "nombre", "ciudad")
    search_fields = ("codigo", "nombre", "ciudad")


@admin.register(Bodega)
class BodegaAdmin(admin.ModelAdmin):
    list_display = ("nombre", "sucursal")
    search_fields = ("nombre", "sucursal__nombre", "sucursal__codigo")


@admin.register(TipoDivision)
class TipoDivisionAdmin(admin.ModelAdmin):
    list_display = ("nombre",)
    search_fields = ("nombre",)


@admin.register(Division)
class DivisionAdmin(admin.ModelAdmin):
    list_display = ("nombre", "bodega", "tipo_division")
    search_fields = (
        "nombre",
        "bodega__nombre",
        "bodega__sucursal__nombre",
        "tipo_division__nombre",
    )


@admin.register(SubDivision)
class SubDivisionAdmin(admin.ModelAdmin):
    list_display = ("nombre", "division")
    search_fields = ("nombre", "division__nombre", "division__bodega__nombre")
