"""Borrador de la solucion de un inconveniente (traslado o importacion).

En el detalle del inconveniente se elige la solucion de cada producto y se
guarda aqui, sin tocar el inventario. Al "Aplicar cambios" el frontend
resuelve cada uno con su borrador y el borrador se limpia.
"""

from datetime import date

MAX_TEXT = 2000
MAX_LABEL = 300
MAX_ITEMS = 500

DECISIONES = {
    # Traslados y envios de importacion.
    "sumar_solicitante",
    "sumar_proveedora",
    "sumar_origen",
    "perdido",
    "devolver_proveedora",
    "sin_cambios",
    # Importacion (llegada desde la casa comercial).
    "aceptado",
    "reportado_proveedor",
    "devolver_proveedor",
    "olvidar",
    "solucion",
    # Inconveniente "otro" de traslado.
    "solucionado",
}


def _text(value, limit):
    return str(value or "").strip()[:limit]


def _positive_int(value):
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def sanitize_borrador(raw):
    """Deja solo las claves conocidas con tipos validos. `{}` = sin borrador."""
    if not isinstance(raw, dict):
        return {}
    clean = {}
    decision = _text(raw.get("decision"), 40).lower()
    if decision in DECISIONES:
        clean["decision"] = decision
    motivo = _text(raw.get("motivo"), MAX_TEXT)
    if motivo:
        clean["motivo"] = motivo
    for key in ("subdivision_id", "subdivision_proveedora_id", "cantidad_prometida"):
        number = _positive_int(raw.get(key))
        if number is not None:
            clean[key] = number
    for key in ("subdivision_label", "subdivision_proveedora_label"):
        label = _text(raw.get(key), MAX_LABEL)
        if label:
            clean[key] = label
    fecha = _text(raw.get("fecha_entrega_prometida"), 10)
    if fecha:
        try:
            clean["fecha_entrega_prometida"] = date.fromisoformat(fecha).isoformat()
        except ValueError:
            pass
    return clean


def parse_borrador_items(data):
    """`{"items": [{"id": 1, "borrador": {...}}]}` -> {id: borrador limpio}.
    Devuelve (items, error)."""
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list) or not items:
        return None, "Debes enviar al menos un inconveniente."
    if len(items) > MAX_ITEMS:
        return None, "Demasiados inconvenientes en una sola solicitud."
    parsed = {}
    for item in items:
        if not isinstance(item, dict):
            return None, "Formato invalido."
        issue_id = _positive_int(item.get("id"))
        if issue_id is None:
            return None, "Cada inconveniente debe tener un id valido."
        parsed[issue_id] = sanitize_borrador(item.get("borrador"))
    return parsed, None
