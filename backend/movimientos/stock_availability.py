from django.db.models import Sum
from django.db.models.functions import Coalesce

from inventario.models import Inventario

from .models import SolicitudTraslado, SolicitudTrasladoDetalle


def _normalize_product_ids(product_ids):
    normalized = []
    for raw_id in product_ids or []:
        try:
            value = int(raw_id)
        except (TypeError, ValueError):
            continue
        if value <= 0:
            continue
        normalized.append(value)
    return sorted(set(normalized))


def get_branch_stock_quantities_by_product(sucursal_id, product_ids=None):
    try:
        branch_id = int(sucursal_id)
    except (TypeError, ValueError):
        return {}
    if branch_id <= 0:
        return {}

    normalized_product_ids = _normalize_product_ids(product_ids)
    queryset = Inventario.objects.filter(
        subdivision__division__bodega__sucursal_id=branch_id
    )
    if normalized_product_ids:
        queryset = queryset.filter(producto_id__in=normalized_product_ids)

    rows = queryset.values("producto_id").annotate(total=Coalesce(Sum("cantidad"), 0))
    result = {}
    for row in rows:
        try:
            product_id = int(row.get("producto_id") or 0)
        except (TypeError, ValueError):
            continue
        if product_id <= 0:
            continue
        try:
            total = int(row.get("total") or 0)
        except (TypeError, ValueError):
            total = 0
        result[product_id] = max(total, 0)
    return result


def get_reserved_transfer_quantities_by_product(
    sucursal_id,
    product_ids=None,
    exclude_solicitud_id=None,
):
    try:
        branch_id = int(sucursal_id)
    except (TypeError, ValueError):
        return {}
    if branch_id <= 0:
        return {}

    normalized_product_ids = _normalize_product_ids(product_ids)
    queryset = SolicitudTrasladoDetalle.objects.filter(
        solicitud__sucursal_proveedora_id=branch_id,
        solicitud__estado=SolicitudTraslado.Estados.APROBADA,
        solicitud__movimiento_salida__isnull=True,
        solicitud__movimiento_entrada__isnull=True,
    )
    if normalized_product_ids:
        queryset = queryset.filter(producto_id__in=normalized_product_ids)

    try:
        excluded_id = int(exclude_solicitud_id)
    except (TypeError, ValueError):
        excluded_id = 0
    if excluded_id > 0:
        queryset = queryset.exclude(solicitud_id=excluded_id)

    rows = queryset.values("producto_id").annotate(total=Coalesce(Sum("cantidad"), 0))
    result = {}
    for row in rows:
        try:
            product_id = int(row.get("producto_id") or 0)
        except (TypeError, ValueError):
            continue
        if product_id <= 0:
            continue
        try:
            total = int(row.get("total") or 0)
        except (TypeError, ValueError):
            total = 0
        result[product_id] = max(total, 0)
    return result


def get_available_transfer_quantities_by_product(
    sucursal_id,
    product_ids=None,
    exclude_solicitud_id=None,
):
    stock_map = get_branch_stock_quantities_by_product(
        sucursal_id=sucursal_id,
        product_ids=product_ids,
    )
    reserved_map = get_reserved_transfer_quantities_by_product(
        sucursal_id=sucursal_id,
        product_ids=product_ids,
        exclude_solicitud_id=exclude_solicitud_id,
    )

    keys = set(stock_map.keys()) | set(reserved_map.keys())
    return {
        product_id: max(int(stock_map.get(product_id, 0)) - int(reserved_map.get(product_id, 0)), 0)
        for product_id in keys
    }
