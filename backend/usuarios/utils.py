from django.contrib.auth import get_user_model
from django.db import connection

from .models import Rol, UsuarioPerfil


def _table_exists(model):
    table_name = model._meta.db_table
    with connection.cursor() as cursor:
        existing_tables = connection.introspection.table_names(cursor)
    return table_name in existing_tables


def _perfil_table_exists():
    return _table_exists(UsuarioPerfil)


def _roles_m2m_table_exists():
    through_model = Rol.usuarios.through
    return _table_exists(through_model)


def get_usuario_interno_por_correo(email):
    """Devuelve el usuario autenticado asociado a un correo (si existe)."""

    if not email:
        return None

    User = get_user_model()
    queryset = User.objects.all()
    if _roles_m2m_table_exists():
        queryset = queryset.prefetch_related("roles__permisos")
    if _perfil_table_exists():
        queryset = queryset.select_related("perfil", "perfil__rol_personalizado")
    return queryset.filter(email__iexact=email).first()


def get_permisos_efectivos(usuario_interno, email):
    """Consolida los permisos disponibles para un usuario autenticado."""

    roles = []
    extra_roles = []

    if usuario_interno and _roles_m2m_table_exists():
        roles = list(usuario_interno.roles.all())
        perfil = getattr(usuario_interno, "perfil", None)
        if perfil and perfil.rol_personalizado:
            extra_roles.append(perfil.rol_personalizado)
    else:
        fallback_role = (
            Rol.objects.prefetch_related("permisos")
            .filter(es_personalizado=True, nombre__iexact=f"Permisos - {email}")
            .first()
        )
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


def ensure_personalized_role(usuario):
    """Garantiza que el usuario tenga un rol personalizado creado y enlazado."""

    if not usuario or not usuario.email:
        return None
    if not _perfil_table_exists():
        return None

    perfil, _ = UsuarioPerfil.objects.get_or_create(usuario=usuario)
    if perfil.rol_personalizado:
        return perfil.rol_personalizado

    role_name = f"Permisos - {usuario.email}"
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

    perfil.rol_personalizado = role
    perfil.save(update_fields=["rol_personalizado"])
    return role
