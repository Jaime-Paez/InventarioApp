from rest_framework.exceptions import PermissionDenied

from .models import MODULOS_CON_ALCANCE_SUCURSAL, UsuarioModuloSucursal


def module_supports_sucursal_scope(module_key):
    return module_key in MODULOS_CON_ALCANCE_SUCURSAL


def _get_scoped_branch_index(user):
    if not user or not user.is_authenticated:
        return {}

    cached = getattr(user, "_scoped_branch_index_cache", None)
    if cached is not None:
        return cached

    index = {}
    rows = UsuarioModuloSucursal.objects.filter(usuario=user).values_list(
        "modulo", "sucursal_id"
    )
    for modulo, sucursal_id in rows:
        index.setdefault(modulo, set()).add(int(sucursal_id))

    user._scoped_branch_index_cache = index
    return index


def get_allowed_sucursal_ids(user, module_key):
    """None = sin restriccion; set() = sin acceso a sucursales en ese modulo."""

    if not module_supports_sucursal_scope(module_key):
        return None

    if not user or not user.is_authenticated:
        return set()

    if user.is_staff or user.is_superuser:
        return None

    scoped_index = _get_scoped_branch_index(user)
    if module_key in scoped_index:
        return set(scoped_index[module_key])

    return set()


def get_allowed_sucursal_ids_for_modules(user, module_keys):
    unrestricted = False
    merged = set()

    for module_key in module_keys or []:
        allowed = get_allowed_sucursal_ids(user, module_key)
        if allowed is None:
            unrestricted = True
            break
        merged.update(allowed)

    if unrestricted:
        return None
    return merged


def apply_sucursal_scope(queryset, user, module_key, field_lookup):
    allowed = get_allowed_sucursal_ids(user, module_key)
    if allowed is None:
        return queryset
    if not allowed:
        return queryset.none()
    return queryset.filter(**{f"{field_lookup}__in": sorted(allowed)})


def _to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def ensure_sucursal_allowed(user, module_key, sucursal_id, field_label="sucursal"):
    allowed = get_allowed_sucursal_ids(user, module_key)
    if allowed is None:
        return

    target_id = _to_int(sucursal_id)
    if target_id is None:
        return

    if target_id not in allowed:
        raise PermissionDenied(
            f"No tienes acceso a la {field_label} seleccionada para este modulo."
        )


def ensure_sucursal_allowed_for_modules(
    user, module_keys, sucursal_id, field_label="sucursal"
):
    allowed = get_allowed_sucursal_ids_for_modules(user, module_keys)
    if allowed is None:
        return

    target_id = _to_int(sucursal_id)
    if target_id is None:
        return

    if target_id not in allowed:
        raise PermissionDenied(
            f"No tienes acceso a la {field_label} seleccionada para este modulo."
        )
