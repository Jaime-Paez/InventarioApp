from django.contrib import admin

from .models import CasaComercial


@admin.register(CasaComercial)
class CasaComercialAdmin(admin.ModelAdmin):
    list_display = ("codigo", "nombre", "pais")
    search_fields = ("codigo", "nombre", "pais__nombre")
