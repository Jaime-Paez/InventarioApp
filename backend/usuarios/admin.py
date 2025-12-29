from django.contrib import admin, messages
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.contrib.auth.models import Group, Permission
from django.utils.crypto import get_random_string

from .models import Rol, RolPermiso, Usuario, UsuarioSucursal
from .utils import sync_auth_user_from_usuario


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
class UsuarioAdmin(admin.ModelAdmin):
    list_display = ("nombres", "apellidos", "correo", "cargo", "activo")
    search_fields = ("nombres", "apellidos", "correo", "cargo")
    list_filter = ("activo",)
    readonly_fields = ("permisos_personalizados_admin",)

    fieldsets = (
        (None, {"fields": ("nombres", "apellidos", "correo", "telefono", "cargo", "activo")}),
        (
            "Permisos personalizados",
            {
                "fields": ("permisos_personalizados_admin",),
                "description": "Resumen de acciones otorgadas al usuario mediante su rol personalizado.",
            },
        ),
    )

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

        generated_password = None
        if not change:
            generated_password = get_random_string(length=12)

        auth_user, created = sync_auth_user_from_usuario(
            obj,
            password=generated_password,
            create_if_missing=True,
        )

        if created and generated_password:
            messages.info(
                request,
                f"Se creó la cuenta de acceso para {obj.correo} con una contraseña temporal: {generated_password}",
            )
        elif auth_user:
            messages.info(
                request,
                f"La cuenta de acceso vinculada a {obj.correo} se sincronizó correctamente.",
            )


@admin.register(UsuarioSucursal)
class UsuarioSucursalAdmin(admin.ModelAdmin):
    list_display = ("usuario", "sucursal", "rol", "es_responsable")
    search_fields = (
        "usuario__nombres",
        "usuario__apellidos",
        "sucursal__nombre",
        "rol",
    )
    list_filter = ("es_responsable", "sucursal")


# ---- Ocultar grupos/permisos del admin nativo de Django ----
User = get_user_model()


class UserAdmin(DjangoUserAdmin):
    """User admin sin gestión de grupos ni permisos nativos."""

    fieldsets = (
        (None, {"fields": ("username", "password")}),
        ("Información personal", {"fields": ("first_name", "last_name", "email")}),
        (
            "Permisos",
            {
                "fields": (
                    "is_active",
                    "is_staff",
                    "is_superuser",
                )
            },
        ),
        ("Fechas importantes", {"fields": ("last_login", "date_joined")}),
    )

    add_fieldsets = (
        (
            None,
            {
                "classes": ("wide",),
                "fields": ("username", "password1", "password2", "first_name", "last_name", "email", "is_active", "is_staff", "is_superuser"),
            },
        ),
    )

    list_filter = ("is_staff", "is_superuser", "is_active")
    filter_horizontal = ()


try:
    admin.site.unregister(Group)
except admin.sites.NotRegistered:
    pass

try:
    admin.site.unregister(Permission)
except admin.sites.NotRegistered:
    pass

try:
    admin.site.unregister(User)
except admin.sites.NotRegistered:
    pass

admin.site.register(User, UserAdmin)
