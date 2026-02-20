from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.contrib.auth.models import Group, Permission
from .models import Rol, RolPermiso, UsuarioModuloSucursal, UsuarioSucursal


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


@admin.register(UsuarioSucursal)
class UsuarioSucursalAdmin(admin.ModelAdmin):
    list_display = ("usuario", "sucursal", "rol", "es_responsable")
    search_fields = (
        "usuario__first_name",
        "usuario__last_name",
        "sucursal__nombre",
        "rol",
    )
    list_filter = ("es_responsable", "sucursal")


@admin.register(UsuarioModuloSucursal)
class UsuarioModuloSucursalAdmin(admin.ModelAdmin):
    list_display = ("usuario", "modulo", "sucursal")
    list_filter = ("modulo", "sucursal")
    search_fields = (
        "usuario__first_name",
        "usuario__last_name",
        "usuario__email",
        "sucursal__nombre",
    )


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
                "fields": (
                    "username",
                    "password1",
                    "password2",
                    "first_name",
                    "last_name",
                    "email",
                    "is_active",
                    "is_staff",
                    "is_superuser",
                ),
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
