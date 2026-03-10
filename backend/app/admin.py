from django.contrib import admin

from .models import (
    InspeccionAleatoriaDiaria,
    InspeccionAleatoriaItem,
    ReminderState,
    UsuarioPreferencia,
)


@admin.register(ReminderState)
class ReminderStateAdmin(admin.ModelAdmin):
    list_display = ("key", "updated_at", "created_at")
    readonly_fields = ("created_at", "updated_at")
    search_fields = ("key",)


@admin.register(UsuarioPreferencia)
class UsuarioPreferenciaAdmin(admin.ModelAdmin):
    list_display = ("usuario", "inspeccion_aleatoria", "updated_at")
    list_filter = ("inspeccion_aleatoria",)
    search_fields = ("usuario__first_name", "usuario__last_name", "usuario__email")
    readonly_fields = ("created_at", "updated_at")


class InspeccionAleatoriaItemInline(admin.TabularInline):
    model = InspeccionAleatoriaItem
    extra = 0
    fields = (
        "sucursal",
        "producto",
        "cantidad_esperada",
        "estado_revision",
        "cantidad_reportada",
        "verificacion_estado",
    )
    readonly_fields = (
        "sucursal",
        "producto",
        "cantidad_esperada",
        "estado_revision",
        "cantidad_reportada",
        "verificacion_estado",
    )
    can_delete = False


@admin.register(InspeccionAleatoriaDiaria)
class InspeccionAleatoriaDiariaAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "usuario",
        "fecha_programada",
        "estado",
        "total_items",
        "cobertura_porcentaje",
        "completada_en",
    )
    list_filter = ("estado", "fecha_programada")
    search_fields = ("usuario__first_name", "usuario__last_name", "usuario__email")
    readonly_fields = ("created_at", "updated_at")
    inlines = [InspeccionAleatoriaItemInline]
