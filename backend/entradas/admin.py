from django.contrib import admin

from entradas.models import Entrada, EntradaDetalle


class EntradaDetalleInline(admin.TabularInline):
    model = EntradaDetalle
    extra = 1


@admin.register(Entrada)
class EntradaAdmin(admin.ModelAdmin):
    list_display = (
        "folio",
        "tipo",
        "sucursal",
        "fecha",
        "responsable",
    )
    list_filter = ("tipo", "sucursal", "fecha")
    search_fields = ("folio", "observaciones")
    inlines = [EntradaDetalleInline]


@admin.register(EntradaDetalle)
class EntradaDetalleAdmin(admin.ModelAdmin):
    list_display = ("entrada", "producto", "cantidad", "costo_unitario")
    list_filter = ("producto",)
    search_fields = ("entrada__folio", "producto__nombre", "producto__sku")
