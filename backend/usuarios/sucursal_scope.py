from rest_framework.exceptions import PermissionDenied

from .models import MODULOS_CON_ALCANCE_SUCURSAL, UsuarioModuloSucursal, UsuarioSucursal
from .utils import is_app_admin, normalize_scope_action_flags


ACTION_KEYS = (
    "puede_crear",
    "puede_leer",
    "puede_actualizar",
    "puede_eliminar",
)


def module_supports_sucursal_scope(module_key):
    return module_key in MODULOS_CON_ALCANCE_SUCURSAL


def _empty_action_scope():
    return {action_key: set() for action_key in ACTION_KEYS}


def _get_scoped_branch_action_index(user):
    if not user or not user.is_authenticated:
        return {}

    cached = getattr(user, "_scoped_branch_action_index_cache", None)
    if cached is not None:
        return cached

    index = {}
    rows = UsuarioModuloSucursal.objects.filter(usuario=user).values(
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
        module_actions = index.setdefault(modulo, _empty_action_scope())
        for action_key in ACTION_KEYS:
            if normalized_flags.get(action_key):
                module_actions[action_key].add(int(sucursal_id))

    user._scoped_branch_action_index_cache = index
    return index


def _get_assigned_branch_ids(user):
    if not user or not user.is_authenticated:
        return set()

    cached = getattr(user, "_assigned_branch_ids_cache", None)
    if cached is not None:
        return cached

    ids = set(
        UsuarioSucursal.objects.filter(usuario=user).values_list("sucursal_id", flat=True)
    )
    user._assigned_branch_ids_cache = ids
    return ids


def _collect_action_scoped_branch_ids(module_actions, action_key=None):
    if not isinstance(module_actions, dict):
        return set()

    if isinstance(action_key, (list, tuple, set)):
        merged = set()
        for key in action_key:
            if key in ACTION_KEYS:
                merged.update(module_actions.get(key, set()))
        return merged

    if action_key in ACTION_KEYS:
        return set(module_actions.get(action_key, set()))

    merged = set()
    for key in ACTION_KEYS:
        merged.update(module_actions.get(key, set()))
    return merged


def get_allowed_sucursal_ids(user, module_key, action_key=None):
    """
    None = sin restriccion; set() = sin acceso a sucursales en ese modulo/accion.

    `action_key` puede ser una accion especifica (`puede_crear`, `puede_leer`,
    `puede_actualizar`, `puede_eliminar`) o `None` para unir todas.
    """

    if not module_supports_sucursal_scope(module_key):
        return None

    if not user or not user.is_authenticated:
        return set()

    if is_app_admin(user):
        return None

    scoped_index = _get_scoped_branch_action_index(user)
    if module_key in scoped_index:
        return _collect_action_scoped_branch_ids(scoped_index[module_key], action_key)

    return set()


def get_readable_sucursal_ids(user, module_key):
    """
    None = sin restriccion; set() = sin acceso.

    Para lectura en modulos con alcance por sucursal:
    - Si el usuario tiene asignaciones de sucursal, esas definen lo visible.
    - Las sucursales con alcance explicito del modulo tambien se incluyen.
    - Si no hay asignaciones, se conserva el comportamiento anterior
      (usar solo el alcance del modulo).
    """

    if not module_supports_sucursal_scope(module_key):
        return None

    if not user or not user.is_authenticated:
        return set()

    if is_app_admin(user):
        return None

    scoped_index = _get_scoped_branch_action_index(user)
    scoped_ids = set()
    if module_key in scoped_index:
        scoped_ids = _collect_action_scoped_branch_ids(
            scoped_index[module_key],
            action_key="puede_leer",
        )

    assigned_ids = _get_assigned_branch_ids(user)

    if assigned_ids:
        if scoped_ids:
            return set(assigned_ids) | scoped_ids
        return set(assigned_ids)

    if module_key in scoped_index:
        return scoped_ids

    return set()


def get_readable_sucursal_ids_for_modules(user, module_keys):
    unrestricted = False
    merged = set()

    for module_key in module_keys or []:
        allowed = get_readable_sucursal_ids(user, module_key)
        if allowed is None:
            unrestricted = True
            break
        merged.update(allowed)

    if unrestricted:
        return None
    return merged


def get_allowed_sucursal_ids_for_modules(user, module_keys, action_key=None):
    unrestricted = False
    merged = set()

    for module_key in module_keys or []:
        allowed = get_allowed_sucursal_ids(user, module_key, action_key=action_key)
        if allowed is None:
            unrestricted = True
            break
        merged.update(allowed)

    if unrestricted:
        return None
    return merged


def apply_sucursal_scope(queryset, user, module_key, field_lookup, action_key=None):
    allowed = get_allowed_sucursal_ids(user, module_key, action_key=action_key)
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


def ensure_sucursal_allowed(
    user,
    module_key,
    sucursal_id,
    field_label="sucursal",
    action_key=None,
):
    allowed = get_allowed_sucursal_ids(user, module_key, action_key=action_key)
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
    user,
    module_keys,
    sucursal_id,
    field_label="sucursal",
    action_key=None,
):
    allowed = get_allowed_sucursal_ids_for_modules(
        user,
        module_keys,
        action_key=action_key,
    )
    if allowed is None:
        return

    target_id = _to_int(sucursal_id)
    if target_id is None:
        return

    if target_id not in allowed:
        raise PermissionDenied(
            f"No tienes acceso a la {field_label} seleccionada para este modulo."
        )
