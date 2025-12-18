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
