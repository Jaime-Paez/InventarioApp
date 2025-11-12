from django.contrib import admin

from .models import (
    EstadoMovimiento,
    EstadoProducto,
    Pais,
    SubTipoMovimiento,
    TipoDivision,
    TipoMovimiento,
    TipoPago,
)


@admin.register(Pais)
class PaisAdmin(admin.ModelAdmin):
    list_display = ("codigo_tais", "nombre")
    search_fields = ("codigo_tais", "nombre")


@admin.register(TipoMovimiento)
class TipoMovimientoAdmin(admin.ModelAdmin):
    list_display = ("nombre",)
    search_fields = ("nombre",)


@admin.register(SubTipoMovimiento)
class SubTipoMovimientoAdmin(admin.ModelAdmin):
    list_display = ("nombre", "tipo_movimiento")
    search_fields = ("nombre", "tipo_movimiento__nombre")
    list_filter = ("tipo_movimiento",)


@admin.register(EstadoMovimiento)
class EstadoMovimientoAdmin(admin.ModelAdmin):
    list_display = ("nombre",)
    search_fields = ("nombre",)


@admin.register(EstadoProducto)
class EstadoProductoAdmin(admin.ModelAdmin):
    list_display = ("nombre",)
    search_fields = ("nombre",)


@admin.register(TipoPago)
class TipoPagoAdmin(admin.ModelAdmin):
    list_display = ("nombre",)
    search_fields = ("nombre",)


@admin.register(TipoDivision)
class TipoDivisionAdmin(admin.ModelAdmin):
    list_display = ("nombre",)
    search_fields = ("nombre",)
