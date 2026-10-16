from django.contrib import admin

from .models import PeticionLenta, RendimientoRuta


@admin.register(RendimientoRuta)
class RendimientoRutaAdmin(admin.ModelAdmin):
    list_display = ("hora", "metodo", "ruta", "peticiones", "lentas", "max_ms", "total_consultas")
    list_filter = ("metodo",)
    search_fields = ("ruta",)


@admin.register(PeticionLenta)
class PeticionLentaAdmin(admin.ModelAdmin):
    list_display = ("fecha", "metodo", "ruta", "duracion_ms", "db_ms", "consultas", "usuario")
    search_fields = ("ruta", "url")
