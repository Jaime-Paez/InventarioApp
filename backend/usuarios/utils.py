from django.contrib.auth import get_user_model

from .models import MODULOS_CON_ALCANCE_SUCURSAL, Rol, RolPermiso, UsuarioModuloSucursal

ADMIN_ONLY_MODULES = {
    RolPermiso.Modulos.MOVIMIENTOS_INCONVENIENTES,
    RolPermiso.Modulos.CONFIGURACION,
}


SCOPE_ACTION_KEYS = (
    "puede_crear",
    "puede_leer",
    "puede_actualizar",
    "puede_eliminar",
)


def normalize_scope_action_flags(source):
    flags = {key: bool(source.get(key)) for key in SCOPE_ACTION_KEYS}

    if flags["puede_eliminar"]:
        flags["puede_crear"] = True
        flags["puede_actualizar"] = True

    if flags["puede_crear"] or flags["puede_actualizar"] or flags["puede_eliminar"]:
        flags["puede_leer"] = True

    if not flags["puede_leer"]:
        flags["puede_crear"] = False
        flags["puede_actualizar"] = False
        flags["puede_eliminar"] = False

    return flags


def build_full_permissions():
    """Devuelve permisos completos (crear/leer/actualizar/eliminar) por modulo."""

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

    user_model = get_user_model()
    return (
        user_model.objects.prefetch_related("roles__permisos")
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

    summary = build_permissions_summary(roles, extra_roles=extra_roles)
    if usuario and (usuario.is_staff or usuario.is_superuser):
        return summary

    return [
        permiso
        for permiso in summary
        if str(permiso.get("modulo") or "").strip() not in ADMIN_ONLY_MODULES
    ]


def build_permissions_summary(roles, extra_roles=None):
    """Agrupa los permisos de una coleccion de roles en una lista consolidada."""

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


def user_has_module_action(usuario, module_key, action_key="puede_leer"):
    if not usuario:
        return False

    if usuario.is_staff or usuario.is_superuser:
        return True

    permisos = get_permisos_efectivos(usuario, getattr(usuario, "email", ""))
    for permiso in permisos:
        if str(permiso.get("modulo") or "").strip() != str(module_key or "").strip():
            continue
        if bool(permiso.get(action_key)):
            return True
        if action_key == "puede_leer" and any(
            (
                permiso.get("puede_crear"),
                permiso.get("puede_actualizar"),
                permiso.get("puede_eliminar"),
            )
        ):
            return True
    return False


def normalize_random_inspection_branch_ids(raw_ids):
    if raw_ids is None:
        return []

    if isinstance(raw_ids, str):
        raw_ids = [part.strip() for part in raw_ids.split(",")]

    if not isinstance(raw_ids, (list, tuple, set)):
        return []

    normalized = []
    seen = set()
    for value in raw_ids:
        try:
            branch_id = int(value)
        except (TypeError, ValueError):
            continue
        if branch_id <= 0 or branch_id in seen:
            continue
        normalized.append(branch_id)
        seen.add(branch_id)
    return normalized


def _get_existing_branch_ids():
    from inventario.models import Sucursal

    return list(
        Sucursal.objects.order_by("nombre", "id").values_list("id", flat=True)
    )


def get_random_inspection_branch_ids(usuario):
    from app.models import UsuarioPreferencia

    if not usuario:
        return []

    preference = getattr(usuario, "preferencia_operativa", None)
    if preference is None:
        preference = (
            UsuarioPreferencia.objects.filter(usuario=usuario)
            .only("inspeccion_aleatoria", "inspeccion_aleatoria_sucursales")
            .first()
        )

    valid_branch_ids = set(_get_existing_branch_ids())
    branch_ids = [
        branch_id
        for branch_id in normalize_random_inspection_branch_ids(
            getattr(preference, "inspeccion_aleatoria_sucursales", [])
        )
        if branch_id in valid_branch_ids
    ]

    if branch_ids:
        return branch_ids

    if preference is not None and bool(
        getattr(preference, "inspeccion_aleatoria", False)
    ):
        return sorted(valid_branch_ids)

    return []


def _sync_random_inspection_inventory_access(usuario, enabled):
    enabled = bool(enabled)

    if usuario.is_staff or usuario.is_superuser:
        return

    personalized_role = get_personalized_role_for_email(
        getattr(usuario, "email", ""),
        create=enabled,
    )

    if enabled:
        if personalized_role is None:
            return

        permiso, created = RolPermiso.objects.get_or_create(
            rol=personalized_role,
            modulo=RolPermiso.Modulos.INVENTARIO,
            submodulo="",
            defaults={
                "puede_crear": False,
                "puede_leer": True,
                "puede_actualizar": False,
                "puede_eliminar": False,
            },
        )
        if not created and not permiso.puede_leer:
            permiso.puede_leer = True
            permiso.save(update_fields=["puede_leer"])
        return

    if personalized_role is None:
        return

    personalized_role.permisos.filter(
        modulo=RolPermiso.Modulos.INVENTARIO,
        submodulo="",
    ).delete()
    if not personalized_role.permisos.exists():
        personalized_role.delete()


def set_random_inspection_branch_ids(usuario, branch_ids):
    from app.models import UsuarioPreferencia

    existing_branch_ids = set(_get_existing_branch_ids())
    normalized_branch_ids = [
        branch_id
        for branch_id in normalize_random_inspection_branch_ids(branch_ids)
        if branch_id in existing_branch_ids
    ]
    enabled = bool(normalized_branch_ids)

    UsuarioPreferencia.objects.update_or_create(
        usuario=usuario,
        defaults={
            "inspeccion_aleatoria": enabled,
            "inspeccion_aleatoria_sucursales": normalized_branch_ids,
        },
    )

    _sync_random_inspection_inventory_access(usuario, enabled)
    return normalized_branch_ids


def sync_random_inspection_assignment(usuario, enabled):
    enabled = bool(enabled)
    branch_ids = _get_existing_branch_ids() if enabled else []
    set_random_inspection_branch_ids(usuario, branch_ids)


def sync_random_inspection_branch_assignment(usuario, branch_id, enabled):
    branch_ids = set(get_random_inspection_branch_ids(usuario))
    try:
        normalized_branch_id = int(branch_id)
    except (TypeError, ValueError):
        normalized_branch_id = 0

    if normalized_branch_id <= 0:
        return sorted(branch_ids)

    if enabled:
        branch_ids.add(normalized_branch_id)
    else:
        branch_ids.discard(normalized_branch_id)

    return set_random_inspection_branch_ids(usuario, sorted(branch_ids))


def get_modulos_con_alcance_sucursal_options():
    return [
        {"key": modulo_key, "label": modulo_label}
        for modulo_key, modulo_label in RolPermiso.Modulos.choices
        if modulo_key in MODULOS_CON_ALCANCE_SUCURSAL and modulo_key not in ADMIN_ONLY_MODULES
    ]


def build_sucursal_scope_summary(usuario):
    if not usuario:
        return []

    grouped = {}
    rows = UsuarioModuloSucursal.objects.filter(usuario=usuario).values(
        "modulo",
        "sucursal_id",
        "puede_crear",
        "puede_leer",
        "puede_actualizar",
        "puede_eliminar",
    )
    for row in rows:
        modulo = row.get("modulo")
        sucursal_id = row.get("sucursal_id")
        if not modulo or sucursal_id is None:
            continue
        normalized_flags = normalize_scope_action_flags(row)
        if not any(normalized_flags.values()):
            continue
        modulo_data = grouped.setdefault(modulo, {})
        modulo_data[int(sucursal_id)] = normalized_flags

    payload = []
    for modulo, scope_map in grouped.items():
        branch_ids = sorted(scope_map.keys())
        payload.append(
            {
                "modulo": modulo,
                "sucursales_ids": branch_ids,
                "acciones_por_sucursal": [
                    {"sucursal_id": branch_id, **scope_map[branch_id]}
                    for branch_id in branch_ids
                ],
            }
        )
    return payload
