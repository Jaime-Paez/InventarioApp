from django.contrib import admin

from .models import (
    DetalleMovimiento,
    EstadoMovimiento,
    MovimientoInventario,
    PagoMovimiento,
    SubTipoMovimiento,
    TipoMovimiento,
    TipoPago,
)


@admin.register(TipoPago)
class TipoPagoAdmin(admin.ModelAdmin):
    list_display = ("nombre",)
    search_fields = ("nombre",)


@admin.register(TipoMovimiento)
class TipoMovimientoAdmin(admin.ModelAdmin):
    list_display = ("nombre",)
    search_fields = ("nombre",)


@admin.register(SubTipoMovimiento)
class SubTipoMovimientoAdmin(admin.ModelAdmin):
    list_display = ("nombre", "tipo_movimiento")
    list_filter = ("tipo_movimiento",)
    search_fields = ("nombre", "tipo_movimiento__nombre")


@admin.register(EstadoMovimiento)
class EstadoMovimientoAdmin(admin.ModelAdmin):
    list_display = ("nombre",)
    search_fields = ("nombre",)


class DetalleMovimientoInline(admin.TabularInline):
    model = DetalleMovimiento
    extra = 1


@admin.register(MovimientoInventario)
class MovimientoInventarioAdmin(admin.ModelAdmin):
    list_display = (
        "numero_documento",
        "tipo_movimiento",
        "estado",
        "subdivision",
        "fecha_documento",
        "creado_en",
    )
    list_filter = ("tipo_movimiento", "estado", "subdivision__division__bodega")
    search_fields = (
        "numero_documento",
        "subdivision__nombre",
        "subdivision__division__bodega__nombre",
    )
    inlines = [DetalleMovimientoInline]


@admin.register(DetalleMovimiento)
class DetalleMovimientoAdmin(admin.ModelAdmin):
    list_display = ("movimiento", "producto", "cantidad", "estado_producto")
    search_fields = (
        "movimiento__numero_documento",
        "producto__codigo",
        "producto__nombre",
    )
    list_filter = ("estado_producto",)


@admin.register(PagoMovimiento)
class PagoMovimientoAdmin(admin.ModelAdmin):
    list_display = ("movimiento", "tipo_pago", "monto", "fecha_pago")
    search_fields = (
        "movimiento__numero_documento",
        "tipo_pago__nombre",
        "referencia",
    )
    list_filter = ("tipo_pago", "fecha_pago")
