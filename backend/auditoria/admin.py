from django.contrib import admin

from .models import RegistroAuditoria


@admin.register(RegistroAuditoria)
class RegistroAuditoriaAdmin(admin.ModelAdmin):
    list_display = (
        "registrado_en",
        "accion",
        "content_type",
        "object_id",
        "usuario",
    )
    list_filter = ("accion", "content_type")
    search_fields = (
        "object_id",
        "representacion_objeto",
        "usuario__nombres",
        "usuario__apellidos",
    )
    readonly_fields = (
        "usuario",
        "accion",
        "content_type",
        "object_id",
        "representacion_objeto",
        "valores_previos",
        "valores_nuevos",
        "detalles",
        "registrado_en",
    )
