from django.contrib.auth import get_user_model


def get_usuario_interno_por_correo(email):
    """Devuelve el usuario autenticado asociado a un correo (si existe)."""

    if not email:
        return None

    User = get_user_model()
    return User.objects.filter(email__iexact=email).first()


def get_permisos_efectivos(usuario_interno, email):
    """Consolida los permisos disponibles para un usuario autenticado."""
    return []


def build_permissions_summary(roles, extra_roles=None):
    """Retorna el resumen de permisos (vacío cuando no hay roles)."""
    return []
