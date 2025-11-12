from django.contrib import admin

from .models import DetalleMovimiento, MovimientoInventario, PagoMovimiento


class DetalleMovimientoInline(admin.TabularInline):
    model = DetalleMovimiento
    extra = 0


class PagoMovimientoInline(admin.TabularInline):
    model = PagoMovimiento
    extra = 0


@admin.register(MovimientoInventario)
class MovimientoInventarioAdmin(admin.ModelAdmin):
    list_display = (
        "no_documento",
        "tipo_movimiento",
        "sucursal",
        "sucursal_objetivo",
        "estado_movimiento",
        "fecha",
        "funcional",
    )
    list_filter = (
        "tipo_movimiento",
        "estado_movimiento",
        "funcional",
        "sucursal",
    )
    search_fields = (
        "no_documento",
        "sucursal__nombre",
        "sucursal_objetivo__nombre",
    )
    inlines = [DetalleMovimientoInline, PagoMovimientoInline]
