from django.contrib.auth import get_user_model

from .models import Rol


def build_full_permissions():
    """Devuelve permisos completos (crear/leer/actualizar/eliminar) por módulo."""

    from .models import RolPermiso  # import tardío para evitar ciclos

    return [
        {
            "modulo": modulo_key,
            "submodulo": "",
            "puede_crear": True,
            "puede_leer": True,
            "puede_actualizar": True,
            "puede_eliminar": True,
        }
        for modulo_key, _ in RolPermiso.Modulos.choices
    ]


def get_usuario_interno_por_correo(email):
    """Devuelve el usuario de Django asociado a un correo (si existe)."""

    if not email:
        return None

    User = get_user_model()
    return (
        User.objects.prefetch_related("roles__permisos")
        .filter(email__iexact=email)
        .first()
    )


def get_personalized_role_for_email(email, *, create=False):
    """Obtiene el rol personalizado asociado a un correo."""

    if not email:
        return None

    role_name = f"Permisos - {email}"
    role = (
        Rol.objects.filter(es_personalizado=True, nombre__iexact=role_name)
        .order_by("id")
        .first()
    )

    if role is None and create:
        role = Rol.objects.create(
            nombre=role_name,
            descripcion="Permisos personalizados del usuario",
            activo=True,
            es_personalizado=True,
        )

    return role


def get_permisos_efectivos(usuario, email):
    """Consolida los permisos disponibles para un usuario autenticado."""

    roles = []
    extra_roles = []

    if usuario:
        roles = list(usuario.roles.all())
        personalized_role = get_personalized_role_for_email(email)
        if personalized_role:
            extra_roles.append(personalized_role)
    else:
        fallback_role = get_personalized_role_for_email(email)
        if fallback_role:
            extra_roles.append(fallback_role)

    return build_permissions_summary(roles, extra_roles=extra_roles)


def build_permissions_summary(roles, extra_roles=None):
    """Agrupa los permisos de una colección de roles en una lista consolidada."""

    roles_to_process = list(roles) + [r for r in extra_roles or [] if r]
    summary = {}

    for role in roles_to_process:
        for permiso in role.permisos.all():
            key = (permiso.modulo, (permiso.submodulo or ""))
            if key not in summary:
                summary[key] = {
                    "modulo": permiso.modulo,
                    "submodulo": permiso.submodulo or "",
                    "puede_crear": False,
                    "puede_leer": False,
                    "puede_actualizar": False,
                    "puede_eliminar": False,
                }

            summary[key]["puede_crear"] = summary[key]["puede_crear"] or permiso.puede_crear
            summary[key]["puede_leer"] = summary[key]["puede_leer"] or permiso.puede_leer
            summary[key]["puede_actualizar"] = (
                summary[key]["puede_actualizar"] or permiso.puede_actualizar
            )
            summary[key]["puede_eliminar"] = summary[key]["puede_eliminar"] or permiso.puede_eliminar

    return [
        value
        for value in summary.values()
        if value["puede_crear"]
        or value["puede_leer"]
        or value["puede_actualizar"]
        or value["puede_eliminar"]
    ]


def remove_personalized_role_for_email(email):
    """Elimina el rol personalizado asociado a un correo."""

    role = get_personalized_role_for_email(email)
    if role:
        role.permisos.all().delete()
        role.delete()
