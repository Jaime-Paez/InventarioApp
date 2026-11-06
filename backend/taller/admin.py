from django.contrib import admin

from .models import ManoObra, OrdenTaller, OrdenTallerEvento, OrdenTallerLinea


@admin.register(ManoObra)
class ManoObraAdmin(admin.ModelAdmin):
    list_display = ("nombre", "precio", "activo")
    search_fields = ("nombre",)


class OrdenTallerLineaInline(admin.TabularInline):
    model = OrdenTallerLinea
    extra = 0
    raw_id_fields = ("producto",)


@admin.register(OrdenTaller)
class OrdenTallerAdmin(admin.ModelAdmin):
    list_display = ("numero", "numero_pedido", "estado", "placa", "cliente_nombre", "tecnico", "creado_en")
    list_filter = ("estado",)
    search_fields = ("numero", "numero_pedido", "placa", "cliente_nombre", "tecnico", "vin")
    inlines = [OrdenTallerLineaInline]


@admin.register(OrdenTallerEvento)
class OrdenTallerEventoAdmin(admin.ModelAdmin):
    list_display = ("orden", "tipo", "usuario", "creado_en")
