from django.contrib import admin

from .models import Importacion, ImportacionDetalle


class ImportacionDetalleInline(admin.TabularInline):
    model = ImportacionDetalle
    extra = 0


@admin.register(Importacion)
class ImportacionAdmin(admin.ModelAdmin):
    list_display = ("codigo", "estado", "fecha", "casa_comercial", "dias_entrega_estimados")
    list_filter = ("estado", "fecha", "casa_comercial")
    search_fields = ("codigo", "casa_comercial__nombre")
    inlines = [ImportacionDetalleInline]
