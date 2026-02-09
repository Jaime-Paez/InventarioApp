from django.contrib import admin

from .models import ConfiguracionSistema


@admin.register(ConfiguracionSistema)
class ConfiguracionSistemaAdmin(admin.ModelAdmin):
    list_display = ("iva_rate", "actualizado_en")
    readonly_fields = ("actualizado_en",)
