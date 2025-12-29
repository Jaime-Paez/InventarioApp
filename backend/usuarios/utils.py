from django.contrib.auth import get_user_model

from .models import Rol, Usuario
from .serializers import build_permissions_summary


def get_usuario_interno_por_correo(email):
    """Devuelve el usuario interno asociado a un correo (si existe)."""

    if not email:
        return None

    return (
        Usuario.objects.prefetch_related(
            "rol_personalizado__permisos",
            "roles__permisos",
        )
        .filter(correo__iexact=email)
        .first()
    )


def get_permisos_efectivos(usuario_interno, email):
    """Consolida los permisos disponibles para un usuario autenticado."""

    roles = []
    extra_roles = []

    if usuario_interno:
        roles = list(usuario_interno.roles.all())
        if usuario_interno.rol_personalizado:
            extra_roles.append(usuario_interno.rol_personalizado)
    else:
        fallback_role = (
            Rol.objects.prefetch_related("permisos")
            .filter(es_personalizado=True, nombre__iexact=f"Permisos - {email}")
            .first()
        )
        if fallback_role:
            extra_roles.append(fallback_role)

    return build_permissions_summary(roles, extra_roles=extra_roles)


def ensure_personalized_role(usuario):
    """Garantiza que el usuario tenga un rol personalizado creado y enlazado."""

    if not usuario or not usuario.correo:
        return None

    if usuario.rol_personalizado:
        return usuario.rol_personalizado

    role_name = f"Permisos - {usuario.correo}"
    role = (
        Rol.objects.filter(es_personalizado=True, nombre__iexact=role_name)
        .order_by("id")
        .first()
    )

    if role is None:
        role = Rol.objects.create(
            nombre=role_name,
            descripcion="Permisos personalizados del usuario",
            activo=True,
            es_personalizado=True,
        )

    usuario.rol_personalizado = role
    usuario.save(update_fields=["rol_personalizado"])
    return role


def sync_auth_user_from_usuario(usuario, *, password=None, create_if_missing=True):
    """Crea o sincroniza la cuenta de autenticación asociada a un usuario interno.

    Devuelve una tupla (auth_user, created) indicando si se creó un nuevo registro.
    """

    if not usuario or not usuario.correo:
        return None, False

    User = get_user_model()
    email = usuario.correo.strip().lower()
    first_name = (usuario.nombres or "").strip()
    last_name = (usuario.apellidos or "").strip()

    auth_user = User.objects.filter(email__iexact=email).first()
    created = False

    if auth_user is None and create_if_missing:
        auth_user = User(username=email, email=email, first_name=first_name, last_name=last_name)
        if password:
            auth_user.set_password(password)
        else:
            auth_user.set_unusable_password()
        auth_user.save()
        created = True
    elif auth_user:
        updates = []
        if auth_user.username != email:
            auth_user.username = email
            updates.append("username")
        if auth_user.email != email:
            auth_user.email = email
            updates.append("email")
        if auth_user.first_name != first_name:
            auth_user.first_name = first_name
            updates.append("first_name")
        if auth_user.last_name != last_name:
            auth_user.last_name = last_name
            updates.append("last_name")
        if password:
            auth_user.set_password(password)
            updates.append("password")
        if updates:
            auth_user.save(update_fields=updates)

    return auth_user, created
