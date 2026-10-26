from django.db import transaction
from django.utils import timezone

from .models import SolicitudTraslado
from .stock_availability import get_available_transfer_quantities_by_product


STOCK_CHANGE_REJECTION_REASON = (
    "Cambio de stock por venta o edición y no se puede cumplir con el traslado."
)


def build_sale_stock_change_extra_reason(reference=None):
    reference_text = f" {reference.strip()}" if reference and str(reference).strip() else ""
    return (
        f"Solicitud pendiente cancelada porque el stock cambió tras la venta{reference_text}."
    )

REMINDERS_SYNC_FLAG = "reminders_sync_required"


def _normalize_product_ids(product_ids):
    normalized = set()
    for raw in product_ids or []:
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        if value <= 0:
            continue
        normalized.add(value)
    return sorted(normalized)


def _find_stock_shortage(solicitud, available_map):
    for detalle in solicitud.detalles.all():
        # Ya marcado como "no se envia": no compite por el stock.
        if getattr(detalle, "no_enviar", False):
            continue
        producto_id = int(getattr(detalle, "producto_id", 0) or 0)
        if producto_id <= 0 or producto_id not in available_map:
            continue
        required = int(getattr(detalle, "cantidad", 0) or 0)
        if required <= 0:
            continue
        available = int(available_map.get(producto_id, 0) or 0)
        if required > available:
            return detalle, producto_id, required, available
    return None


def cancel_pending_transfer_requests(
    branch_id,
    product_ids,
    *,
    actor_user=None,
    extra_reason=None,
):
    normalized_ids = _normalize_product_ids(product_ids)
    if not branch_id or not normalized_ids:
        return False

    available_map = get_available_transfer_quantities_by_product(
        sucursal_id=branch_id,
        product_ids=normalized_ids,
    )

    pending_ids_query = SolicitudTraslado.objects.filter(
        sucursal_proveedora_id=branch_id,
        estado__in=[
            SolicitudTraslado.Estados.PENDIENTE,
            SolicitudTraslado.Estados.APROBADA,
        ],
        # Una solicitud ya convertida en envio real (salida/entrada creadas)
        # ya tomo su stock -- no vuelve a competir por el disponible actual,
        # asi que revisarla de nuevo aqui solo la cancela por error (el stock
        # "faltante" es de otra venta, no de esta).
        movimiento_salida__isnull=True,
        movimiento_entrada__isnull=True,
        detalles__producto_id__in=normalized_ids,
    ).values_list("id", flat=True)
    pending_ids = sorted(
        {int(value) for value in pending_ids_query if value is not None}
    )
    if not pending_ids:
        return False

    changed = False
    with transaction.atomic():
        queryset = (
            SolicitudTraslado.objects.select_for_update(of=("self",))
            .filter(id__in=pending_ids)
            .prefetch_related("detalles__producto")
        )

        for solicitud in queryset:
            # pending_ids se calculo ANTES de tomar el lock de esta fila --
            # si justo en ese intervalo la solicitud termino de convertirse
            # en un envio real (alguien la acepto y creo la salida), select_
            # for_update espera a que esa transaccion termine y aqui ya la
            # vemos con movimiento_salida/entrada puestos. Sin este segundo
            # chequeo (ya no basta con haberlo filtrado al armar pending_ids)
            # se cancelaba por error un traslado que en realidad ya se envio,
            # justo en la ventana entre "aceptar" y "crear la salida".
            if solicitud.movimiento_salida_id or solicitud.movimiento_entrada_id:
                continue

            shortage = _find_stock_shortage(solicitud, available_map)
            if shortage is None:
                continue

            detalle, producto_id, required, available = shortage
            producto = getattr(detalle, "producto", None)
            label = str(getattr(producto, "codigo", "") or "").strip()
            if not label:
                label = str(getattr(producto, "nombre", "") or "").strip()
            if not label:
                label = f"ID {producto_id}"

            motivo = (
                f"{STOCK_CHANGE_REJECTION_REASON} ({label}: disponible {available}, "
                f"solicitado {required})."
            )
            if extra_reason:
                motivo = f"{extra_reason} {motivo}"

            solicitud.estado = SolicitudTraslado.Estados.CANCELADA
            solicitud.motivo_rechazo = motivo
            solicitud.rechazada_por = actor_user
            solicitud.rechazada_en = timezone.now()
            solicitud.save(
                update_fields=[
                    "estado",
                    "motivo_rechazo",
                    "rechazada_por",
                    "rechazada_en",
                    "updated_at",
                ]
            )

            # Import diferido: viewsets.py importa este modulo, asi que
            # importarlo arriba crearia un ciclo. El metodo no usa self.request
            # ni nada propio de la vista, solo arma el recordatorio de "rechazada"
            # (mismo aviso que ve el usuario cuando alguien rechaza a mano).
            from .viewsets import MovimientoInventarioViewSet

            MovimientoInventarioViewSet()._append_transfer_decision_result_reminder(
                solicitud=solicitud,
                actor_user=actor_user,
                decision_status="rechazada",
                rejection_reason=motivo,
            )
            changed = True

    return changed
