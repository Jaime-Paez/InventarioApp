from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.contrib.auth.models import Group, Permission, User as AuthUser
from .models import Rol, RolPermiso, UsuarioSucursal


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


User = get_user_model()


try:
    admin.site.unregister(User)
except admin.sites.NotRegistered:
    pass

try:
    admin.site.unregister(AuthUser)
except admin.sites.NotRegistered:
    pass


class UserAdmin(DjangoUserAdmin):
    list_display = (
        "username",
        "email",
        "first_name",
        "last_name",
        "telefono",
        "cargo",
        "is_active",
        "is_staff",
        "is_superuser",
    )
    list_filter = ("is_active", "is_staff", "is_superuser")
    search_fields = ("username", "email", "first_name", "last_name")
    fieldsets = DjangoUserAdmin.fieldsets + (
        ("Información adicional", {"fields": ("telefono", "cargo")}),
    )


admin.site.register(User, UserAdmin)


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


# ---- Ocultar grupos/permisos del admin nativo de Django ----

try:
    admin.site.unregister(Group)
except admin.sites.NotRegistered:
    pass

try:
    admin.site.unregister(Permission)
except admin.sites.NotRegistered:
    pass
