from django.contrib import admin

from salidas.models import Salida, SalidaDetalle


class SalidaDetalleInline(admin.TabularInline):
    model = SalidaDetalle
    extra = 1


@admin.register(Salida)
class SalidaAdmin(admin.ModelAdmin):
    list_display = (
        "folio",
        "tipo",
        "sucursal_origen",
        "sucursal_destino",
        "fecha",
    )
    list_filter = ("tipo", "sucursal_origen", "fecha")
    search_fields = ("folio", "observaciones")
    inlines = [SalidaDetalleInline]


@admin.register(SalidaDetalle)
class SalidaDetalleAdmin(admin.ModelAdmin):
    list_display = ("salida", "producto", "cantidad", "precio_unitario")
    list_filter = ("producto",)
    search_fields = ("salida__folio", "producto__nombre", "producto__sku")
