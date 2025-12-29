from django.contrib import admin, messages
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.contrib.auth.models import Group, Permission
from django.utils.crypto import get_random_string
from django import forms

from .models import Rol, RolPermiso, Usuario, UsuarioSucursal
from .utils import ensure_personalized_role, sync_auth_user_from_usuario


class UsuarioAdminForm(forms.ModelForm):
    password1 = forms.CharField(
        label="Contraseña",
        required=False,
        widget=forms.PasswordInput(render_value=False),
        help_text="Define la contraseña inicial. Si se deja en blanco se generará una temporal.",
    )
    password2 = forms.CharField(
        label="Confirmar contraseña",
        required=False,
        widget=forms.PasswordInput(render_value=False),
    )

    class Meta:
        model = Usuario
        fields = "__all__"

    def clean(self):
        cleaned = super().clean()
        p1 = cleaned.get("password1")
        p2 = cleaned.get("password2")
        if p1 or p2:
            if p1 != p2:
                raise forms.ValidationError("Las contraseñas no coinciden.")
            if len(p1) < 8:
                raise forms.ValidationError("La contraseña debe tener al menos 8 caracteres.")
        return cleaned


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
    form = UsuarioAdminForm

    fieldsets = (
        (None, {"fields": ("nombres", "apellidos", "correo", "telefono", "cargo", "activo")}),
        (
            "Permisos personalizados",
            {
                "fields": ("permisos_personalizados_admin",),
                "description": "Resumen de acciones otorgadas al usuario mediante su rol personalizado.",
            },
        ),
        (
            "Credenciales",
            {
                "fields": ("password1", "password2"),
                "description": "Se creará automáticamente la cuenta de autenticación vinculada al usuario.",
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

        password = form.cleaned_data.get("password1")
        generated_password = None
        if not password:
            generated_password = get_random_string(length=12)
            password = generated_password

        auth_user, created = sync_auth_user_from_usuario(
            obj,
            password=password,
            create_if_missing=True,
        )

        # Garantizar rol personalizado para que tenga contenedor de permisos
        ensure_personalized_role(obj)

        if created and generated_password:
            messages.info(
                request,
                f"Se creó la cuenta de acceso para {obj.correo} con una contraseña temporal: {generated_password}",
            )
        elif auth_user and password == generated_password:
            messages.info(
                request,
                f"La cuenta de acceso vinculada a {obj.correo} se sincronizó correctamente.",
            )
        elif auth_user and form.cleaned_data.get("password1"):
            messages.success(
                request,
                f"Se actualizó la contraseña de acceso para {obj.correo}.",
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
