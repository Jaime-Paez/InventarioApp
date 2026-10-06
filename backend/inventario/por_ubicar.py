"""Recepcion por partes de envios (traslados e importaciones) y "en camino".

Flujo en dos pasos:
1. Recibir: el producto entra al stock de la sucursal de destino. Si no se
   indica ubicacion va a "POR UBICAR" (ubicacion temporal del almacen), asi la
   sucursal ya puede venderlo aunque todavia no lo haya guardado.
2. Guardar: mas tarde se mueve desde POR UBICAR a su ubicacion definitiva.

El avance de cada envio se guarda en su campo `recepcion_progreso`:
    {"<producto_id>": {"recibido": int, "por_ubicar": int}}
- recibido: unidades que ya entraron al stock por este envio.
- por_ubicar: de esas, cuantas se dejaron en POR UBICAR y faltan guardar.
"""

from django.db.models import F

from core.search_utils import strip_accents

from .models import Bodega, Division, Inventario, SubDivision

POR_UBICAR_NOMBRE = "POR UBICAR"
POR_UBICAR_TIPO = "Temporal"


def _main_bodega(sucursal_id):
    """El almacen de la sucursal (nombre "Almacen ..."); si no hay, la primera bodega."""
    bodegas = list(Bodega.objects.filter(sucursal_id=int(sucursal_id)).order_by("id"))
    for bodega in bodegas:
        if strip_accents(bodega.nombre or "").strip().startswith("almacen"):
            return bodega
    return bodegas[0] if bodegas else None


def get_por_ubicar_subdivision(sucursal_id, *, create=True):
    """Subdivision "POR UBICAR / POR UBICAR" del almacen de la sucursal."""
    existing = (
        SubDivision.objects.filter(
            division__bodega__sucursal_id=int(sucursal_id),
            division__nombre__iexact=POR_UBICAR_NOMBRE,
            nombre__iexact=POR_UBICAR_NOMBRE,
        )
        .order_by("id")
        .first()
    )
    if existing is not None or not create:
        return existing

    bodega = _main_bodega(sucursal_id)
    if bodega is None:
        return None
    from tipos.models import TipoDivision

    tipo, _ = TipoDivision.objects.get_or_create(nombre=POR_UBICAR_TIPO)
    division, _ = Division.objects.get_or_create(
        bodega=bodega,
        nombre=POR_UBICAR_NOMBRE,
        defaults={"tipo_division": tipo},
    )
    subdivision, _ = SubDivision.objects.get_or_create(division=division, nombre=POR_UBICAR_NOMBRE)
    return subdivision


def add_stock(subdivision_id, producto_id, cantidad):
    qty = int(cantidad or 0)
    if qty <= 0:
        return
    row, _ = Inventario.objects.select_for_update().get_or_create(
        subdivision_id=int(subdivision_id),
        producto_id=int(producto_id),
        referencia="",
        defaults={"cantidad": 0},
    )
    Inventario.objects.filter(pk=row.pk).update(cantidad=F("cantidad") + qty)


def take_stock(subdivision_id, producto_id, cantidad):
    """Quita hasta `cantidad` de la ubicacion; devuelve cuanto pudo quitar."""
    qty = int(cantidad or 0)
    if qty <= 0:
        return 0
    rows = list(
        Inventario.objects.select_for_update()
        .filter(subdivision_id=int(subdivision_id), producto_id=int(producto_id), cantidad__gt=0)
        .order_by("id")
    )
    taken = 0
    for row in rows:
        if taken >= qty:
            break
        part = min(int(row.cantidad or 0), qty - taken)
        row.cantidad = int(row.cantidad or 0) - part
        row.save(update_fields=["cantidad"])
        taken += part
    return taken


def stock_in(subdivision_id, producto_ids):
    """{producto_id: unidades} en una ubicacion."""
    if subdivision_id is None or not producto_ids:
        return {}
    totals = {}
    for row in Inventario.objects.filter(
        subdivision_id=int(subdivision_id), producto_id__in=sorted({int(p) for p in producto_ids})
    ).values("producto_id", "cantidad"):
        pid = int(row["producto_id"])
        totals[pid] = totals.get(pid, 0) + max(0, int(row["cantidad"] or 0))
    return totals


def normalize_progress(progress):
    clean = {}
    if not isinstance(progress, dict):
        return clean
    for key, entry in progress.items():
        if not isinstance(entry, dict):
            continue
        try:
            pid = int(key)
        except (TypeError, ValueError):
            continue
        clean[str(pid)] = {
            "recibido": max(0, int(entry.get("recibido") or 0)),
            "por_ubicar": max(0, int(entry.get("por_ubicar") or 0)),
        }
    return clean


def received_by_product(progress):
    return {int(pid): entry["recibido"] for pid, entry in normalize_progress(progress).items()}


def serialize_progress(progress, sucursal_id):
    """Avance para la app. `pendiente_guardar` = lo que falta guardar y sigue
    en POR UBICAR (si se vendio desde ahi, ya no hay nada que guardar)."""
    clean = normalize_progress(progress)
    if not clean:
        return {}
    por_ubicar = get_por_ubicar_subdivision(sucursal_id, create=False)
    disponibles = stock_in(por_ubicar.id if por_ubicar else None, [int(pid) for pid in clean])
    return {
        pid: {
            **entry,
            "pendiente_guardar": min(entry["por_ubicar"], disponibles.get(int(pid), 0)),
        }
        for pid, entry in clean.items()
    }


def _validated_subdivision(subdivision_id, sucursal_id):
    try:
        sid = int(subdivision_id)
    except (TypeError, ValueError):
        return None
    return SubDivision.objects.filter(pk=sid, division__bodega__sucursal_id=int(sucursal_id)).first()


class RecepcionError(ValueError):
    pass


def receive_items(*, progress, sucursal_id, items, sent_by_product):
    """Recibe productos: los suma al stock (en su ubicacion o en POR UBICAR).

    items: [{"producto_id", "cantidad", "subdivision_id"?}]
    Devuelve el progreso actualizado. Llamar dentro de transaction.atomic()
    con el envio bloqueado (select_for_update).
    """
    progress = normalize_progress(progress)
    if not isinstance(items, list) or not items:
        raise RecepcionError("Debes enviar los productos a recibir en `items`.")
    por_ubicar = None
    seen = set()
    for raw in items:
        if not isinstance(raw, dict):
            raise RecepcionError("Cada producto debe ser un objeto valido.")
        try:
            pid = int(raw.get("producto_id"))
            qty = int(raw.get("cantidad"))
        except (TypeError, ValueError):
            raise RecepcionError("Cada producto debe tener producto_id y cantidad validos.")
        if pid not in sent_by_product:
            raise RecepcionError(f"El producto {pid} no pertenece a este envio.")
        if pid in seen:
            raise RecepcionError("No puedes repetir el mismo producto.")
        seen.add(pid)
        if qty <= 0:
            raise RecepcionError("La cantidad a recibir debe ser mayor a 0.")
        entry = progress.setdefault(str(pid), {"recibido": 0, "por_ubicar": 0})

        subdivision = None
        if raw.get("subdivision_id"):
            subdivision = _validated_subdivision(raw.get("subdivision_id"), sucursal_id)
            if subdivision is None:
                raise RecepcionError("La ubicacion no pertenece a la sucursal de destino.")
        if subdivision is None:
            if por_ubicar is None:
                por_ubicar = get_por_ubicar_subdivision(sucursal_id)
            if por_ubicar is None:
                raise RecepcionError("La sucursal de destino no tiene bodegas para recibir.")
            add_stock(por_ubicar.id, pid, qty)
            entry["por_ubicar"] += qty
        else:
            add_stock(subdivision.id, pid, qty)
        entry["recibido"] += qty
    return progress


def store_items(*, progress, sucursal_id, items):
    """Guarda en su ubicacion lo que quedo en POR UBICAR.

    items: [{"producto_id", "subdivision_id", "cantidad"?}] (sin cantidad = todo
    lo pendiente). Se mueve solo lo que siga en POR UBICAR: lo que se vendio
    desde ahi ya no se mueve, y su pendiente se da por resuelto.
    """
    progress = normalize_progress(progress)
    if not isinstance(items, list) or not items:
        raise RecepcionError("Debes enviar los productos a guardar en `items`.")
    por_ubicar = get_por_ubicar_subdivision(sucursal_id, create=False)
    moved = {}
    for raw in items:
        if not isinstance(raw, dict):
            raise RecepcionError("Cada producto debe ser un objeto valido.")
        try:
            pid = int(raw.get("producto_id"))
        except (TypeError, ValueError):
            raise RecepcionError("Cada producto debe tener un producto_id valido.")
        entry = progress.get(str(pid))
        if not entry or entry["por_ubicar"] <= 0:
            raise RecepcionError(f"El producto {pid} no tiene unidades por guardar.")
        destino = _validated_subdivision(raw.get("subdivision_id"), sucursal_id)
        if destino is None:
            raise RecepcionError("Selecciona una ubicacion de la sucursal de destino.")
        if por_ubicar is not None and destino.id == por_ubicar.id:
            raise RecepcionError("Elige una ubicacion distinta de POR UBICAR.")
        requested = entry["por_ubicar"]
        if raw.get("cantidad") is not None:
            try:
                requested = min(requested, max(0, int(raw.get("cantidad"))))
            except (TypeError, ValueError):
                raise RecepcionError("La cantidad a guardar no es valida.")
        if requested <= 0:
            raise RecepcionError("La cantidad a guardar debe ser mayor a 0.")
        taken = take_stock(por_ubicar.id, pid, requested) if por_ubicar else 0
        add_stock(destino.id, pid, taken)
        if taken < requested:
            # El resto ya no esta en POR UBICAR (se vendio): nada que guardar.
            entry["por_ubicar"] = 0
        else:
            entry["por_ubicar"] -= requested
        moved[pid] = taken
    return progress, moved


def pending_to_store(progress, sucursal_id):
    """Total de unidades que siguen en POR UBICAR por este envio."""
    return sum(entry["pendiente_guardar"] for entry in serialize_progress(progress, sucursal_id).values())


def in_transit_by_product_branch(product_ids, branch_ids=None):
    """Unidades en camino hacia cada sucursal, por producto, con sus documentos.

    {(producto_id, sucursal_id): {"total": int, "documentos": [{"tipo", "id", "codigo", "cantidad"}]}}
    - Traslados aprobados ya despachados cuya entrada aun no se recibio.
    - Envios de importacion pendientes.
    Lo que ya se recibio por partes no cuenta como en camino.
    """
    from importaciones.models import ImportacionEnvio, ImportacionEnvioDetalle
    from movimientos.models import DetalleMovimiento, SolicitudTraslado

    product_ids = sorted({int(pid) for pid in product_ids if pid})
    if not product_ids:
        return {}
    result = {}

    def add(key, tipo, doc_id, codigo, cantidad):
        if cantidad <= 0:
            return
        bucket = result.setdefault(key, {"total": 0, "documentos": []})
        bucket["total"] += cantidad
        bucket["documentos"].append({"tipo": tipo, "id": doc_id, "codigo": codigo, "cantidad": cantidad})

    traslados = SolicitudTraslado.objects.filter(
        estado=SolicitudTraslado.Estados.APROBADA,
        movimiento_salida_id__isnull=False,
        movimiento_entrada_id__isnull=False,
    ).select_related("movimiento_entrada__estado_movimiento")
    if branch_ids is not None:
        traslados = traslados.filter(sucursal_solicitante_id__in=sorted({int(b) for b in branch_ids}))
    open_traslados = {}
    for traslado in traslados:
        estado = strip_accents(
            getattr(getattr(traslado.movimiento_entrada, "estado_movimiento", None), "nombre", "") or ""
        )
        if "recib" in estado or "parcial" in estado:
            continue
        open_traslados[int(traslado.movimiento_entrada_id)] = traslado
    if open_traslados:
        for detalle in DetalleMovimiento.objects.filter(
            movimiento_inventario_id__in=sorted(open_traslados), producto_id__in=product_ids
        ).values("movimiento_inventario_id", "producto_id", "cantidad"):
            traslado = open_traslados[int(detalle["movimiento_inventario_id"])]
            pid = int(detalle["producto_id"])
            recibido = received_by_product(traslado.recepcion_progreso).get(pid, 0)
            add(
                (pid, int(traslado.sucursal_solicitante_id)),
                "traslado",
                int(traslado.id),
                str(traslado.no_documento or "").strip(),
                int(detalle["cantidad"] or 0) - recibido,
            )

    envios = ImportacionEnvio.objects.filter(estado=ImportacionEnvio.ESTADO_PENDIENTE).select_related("importacion")
    if branch_ids is not None:
        envios = envios.filter(sucursal_id__in=sorted({int(b) for b in branch_ids}))
    envios_by_id = {int(envio.id): envio for envio in envios}
    if envios_by_id:
        for detalle in ImportacionEnvioDetalle.objects.filter(
            envio_id__in=sorted(envios_by_id), producto_id__in=product_ids
        ).values("envio_id", "producto_id", "cantidad"):
            envio = envios_by_id[int(detalle["envio_id"])]
            pid = int(detalle["producto_id"])
            recibido = received_by_product(envio.recepcion_progreso).get(pid, 0)
            add(
                (pid, int(envio.sucursal_id)),
                "importacion",
                int(envio.id),
                str(getattr(envio.importacion, "codigo", "") or "").strip(),
                int(detalle["cantidad"] or 0) - recibido,
            )
    return result
