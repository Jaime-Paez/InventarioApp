from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.contrib.auth.models import Group, Permission

from .models import Rol, RolPermiso, Usuario, UsuarioSucursal
from .utils import ensure_personalized_role


class RolPermisoInline(admin.TabularInline):
    model = RolPermiso
    extra = 0
    fields = (
        "modulo",
        "submodulo",
        "puede_crear",
        "puede_leer",
        "puede_actualizar",
        "puede_eliminar",
    )


@admin.register(Rol)
class RolAdmin(admin.ModelAdmin):
    list_display = ("nombre", "activo", "es_personalizado")
    list_filter = ("activo", "es_personalizado")
    search_fields = ("nombre",)
    inlines = [RolPermisoInline]


@admin.register(Usuario)
class UsuarioAdmin(DjangoUserAdmin):
    list_display = ("username", "email", "first_name", "last_name", "cargo", "is_active")
    search_fields = ("first_name", "last_name", "email", "cargo")
    list_filter = ("is_staff", "is_superuser", "is_active")
    readonly_fields = ("permisos_personalizados_admin",)
    ordering = ("last_name", "first_name")

    fieldsets = (
        (None, {"fields": ("username", "password")}),
        (
            "Información personal",
            {
                "fields": ("first_name", "last_name", "email", "telefono", "cargo"),
            },
        ),
        (
            "Roles",
            {
                "fields": ("roles", "rol_personalizado", "permisos_personalizados_admin"),
            },
        ),
        (
            "Permisos",
            {
                "fields": ("is_active", "is_staff", "is_superuser"),
            },
        ),
        ("Fechas importantes", {"fields": ("last_login", "date_joined")}),
    )

    add_fieldsets = (
        (
            None,
            {
                "classes": ("wide",),
                "fields": (
                    "username",
                    "email",
                    "first_name",
                    "last_name",
                    "telefono",
                    "cargo",
                    "password1",
                    "password2",
                    "is_active",
                    "is_staff",
                    "is_superuser",
                    "roles",
                    "rol_personalizado",
                ),
            },
        ),
    )
    filter_horizontal = ("roles", "groups", "user_permissions")

    def permisos_personalizados_admin(self, obj):
        if not obj.rol_personalizado:
            return "—"
        permisos = obj.rol_personalizado.permisos.all().order_by("modulo", "submodulo")
        if not permisos.exists():
            return "—"
        lines = []
        for permiso in permisos:
            acciones = []
            if permiso.puede_crear:
                acciones.append("crear")
            if permiso.puede_leer:
                acciones.append("ver")
            if permiso.puede_actualizar:
                acciones.append("editar")
            if permiso.puede_eliminar:
                acciones.append("eliminar")
            acciones_str = ", ".join(acciones) or "sin acciones"
            sub = f" / {permiso.get_submodulo_display()}" if permiso.submodulo else ""
            lines.append(f"{permiso.get_modulo_display()}{sub}: {acciones_str}")
        return "; ".join(lines)

    permisos_personalizados_admin.short_description = "Permisos personalizados"

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)

        # Garantizar rol personalizado para que tenga contenedor de permisos
        ensure_personalized_role(obj)


@admin.register(UsuarioSucursal)
class UsuarioSucursalAdmin(admin.ModelAdmin):
    list_display = ("usuario", "sucursal", "rol", "es_responsable")
    search_fields = (
        "usuario__first_name",
        "usuario__last_name",
        "usuario__email",
        "sucursal__nombre",
        "rol",
    )
    list_filter = ("es_responsable", "sucursal")


# ---- Ocultar grupos/permisos del admin nativo de Django ----
try:
    admin.site.unregister(Group)
except admin.sites.NotRegistered:
    pass

try:
    admin.site.unregister(Permission)
except admin.sites.NotRegistered:
    pass
