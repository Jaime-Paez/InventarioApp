"""Historial de entradas y salidas de un producto (pestana Movimientos del
detalle del producto en Inventario).

Una fila por movimiento donde aparece el producto (si el producto esta en
varias lineas del mismo movimiento, se suman), con de donde vino o a donde fue:
importacion (con su codigo), compra local (casa comercial), traslado (la otra
sucursal), devolucion o venta.

En un movimiento, `sucursal` es la sucursal del propio movimiento y
`sucursal_objetivo` la otra sucursal del traslado (de donde llega en una
entrada, a donde va en una salida).
"""

from django.db.models import Max, Q, Sum

from .models import DetalleMovimiento, MovimientoInventario

PAGE_SIZE_DEFAULT = 50
PAGE_SIZE_MAX = 200


def _norm(text):
    import unicodedata

    raw = unicodedata.normalize("NFD", str(text or ""))
    return "".join(ch for ch in raw if unicodedata.category(ch) != "Mn").strip().lower()


def _tipo_key(mov):
    return "salida" if _norm(getattr(mov.tipo_movimiento, "nombre", "")).startswith("sal") else "entrada"


def _subtipo_key(mov):
    name = _norm(getattr(mov.sub_tipo_movimiento, "nombre", ""))
    if name.startswith("import"):
        return "importacion"
    if name.startswith("compra"):
        return "compra_local"
    if name.startswith("trasl"):
        return "traslado"
    if name.startswith("devol"):
        return "devolucion"
    if name.startswith("vent"):
        return "venta"
    return name or ""


def _importaciones_by_movement(movement_ids):
    """{movimiento_id: {"id", "codigo"}} para los movimientos ligados a una
    importacion: la entrada de la importacion en la matriz y los traslados con
    que se repartio a otras sucursales."""
    from importaciones.models import Importacion, ImportacionEnvio

    result = {}
    if not movement_ids:
        return result
    def _data(imp):
        casa = imp.casa_comercial.nombre if imp.casa_comercial_id else ""
        return {"id": imp.id, "codigo": imp.codigo, "casa_comercial": casa}

    for imp in Importacion.objects.filter(movimiento_entrada_id__in=movement_ids).select_related("casa_comercial"):
        result[imp.movimiento_entrada_id] = _data(imp)
    envios = (
        ImportacionEnvio.objects.filter(importacion__isnull=False)
        .filter(Q(movimiento_entrada_id__in=movement_ids) | Q(movimiento_salida_id__in=movement_ids))
        .select_related("importacion__casa_comercial")
    )
    for envio in envios:
        data = _data(envio.importacion)
        for mov_id in (envio.movimiento_entrada_id, envio.movimiento_salida_id):
            if mov_id in movement_ids:
                result.setdefault(mov_id, data)
    return result


def _origen_texto(mov, tipo, subtipo, importacion):
    otra = str(mov.sucursal_objetivo) if mov.sucursal_objetivo_id else ""
    casa = mov.casa_comercial.nombre if mov.casa_comercial_id else ""
    if not casa and importacion:
        casa = importacion.get("casa_comercial") or ""
    if subtipo == "importacion":
        texto = f"Importación {importacion['codigo']}" if importacion else "Importación"
        return f"{texto} · {casa}" if casa else texto
    if subtipo == "compra_local":
        return f"Compra local · {casa}" if casa else "Compra local"
    if subtipo == "traslado":
        base = f"Traslado desde {otra}" if tipo == "entrada" else f"Traslado a {otra}"
        if not otra:
            base = "Traslado"
        if importacion:
            base = f"{base} (importación {importacion['codigo']})"
        return base
    if subtipo == "devolucion":
        if mov.estado_garantia or _norm(mov.no_documento).startswith("gar"):
            return "Garantía"
        if tipo == "entrada" and mov.factura_referencia:
            return f"Devolución · factura {mov.factura_referencia}"
        return "Devolución"
    if subtipo == "venta":
        desc = (mov.descripcion or "").strip()
        if desc.lower().startswith("cliente:"):
            return f"Venta · {desc.split(':', 1)[1].strip()}"
        return "Venta"
    return getattr(mov.sub_tipo_movimiento, "nombre", "") or ""


def _base_movements():
    # Igual que la tabla de movimientos: las garantias eliminadas no cuentan y
    # las que esperan aprobacion todavia no afectaron el inventario.
    return MovimientoInventario.objects.exclude(
        estado_garantia=MovimientoInventario.EstadoGarantia.ELIMINADA
    ).exclude(garantia_pendiente=True)


def _es_matriz(nombre):
    name = _norm(nombre)
    return "matriz" in name or ("octubre" in name and "9" in name)


def history_branch_options(allowed_ids=None, assigned_ids=None):
    """Sucursales del filtro del historial y la que sale marcada al abrir.

    allowed_ids None = sin restriccion (administrador): todas las sucursales,
    la matriz (9 de Octubre) primero y marcada. Con restriccion: solo las
    permitidas, marcada la sucursal asignada al usuario (o la primera)."""
    from inventario.models import Sucursal

    queryset = Sucursal.objects.all()
    if allowed_ids is not None:
        queryset = queryset.filter(id__in=sorted(allowed_ids))
    branches = sorted(
        queryset.values("id", "nombre"),
        key=lambda row: (0 if _es_matriz(row["nombre"]) else 1, _norm(row["nombre"])),
    )
    default_id = None
    if allowed_ids is not None:
        default_id = next((row["id"] for row in branches if row["id"] in set(assigned_ids or ())), None)
    if default_id is None and branches:
        default_id = branches[0]["id"]
    return branches, default_id


def build_product_movement_history(
    producto_id,
    *,
    tipo="",
    sucursal_id=None,
    allowed_sucursal_ids=None,
    fecha_desde=None,
    fecha_hasta=None,
    page=1,
    page_size=PAGE_SIZE_DEFAULT,
):
    """allowed_sucursal_ids None = todas; si no, solo movimientos de esas
    sucursales (sucursal_id ya debe estar entre ellas)."""
    detalles = DetalleMovimiento.objects.filter(
        producto_id=producto_id,
        movimiento_inventario__in=_base_movements(),
    )
    if allowed_sucursal_ids is not None:
        detalles = detalles.filter(movimiento_inventario__sucursal_id__in=sorted(allowed_sucursal_ids))

    # Totales y sucursales sin filtrar por tipo (para el resumen y el filtro).
    scope = detalles
    if sucursal_id:
        scope = scope.filter(movimiento_inventario__sucursal_id=sucursal_id)
    # Rango de fechas (incluye ambos dias): filtra la tabla y los totales.
    if fecha_desde:
        scope = scope.filter(movimiento_inventario__fecha__gte=fecha_desde)
    if fecha_hasta:
        scope = scope.filter(movimiento_inventario__fecha__lte=fecha_hasta)
    totales = {"entradas": 0, "salidas": 0}
    for row in scope.values("movimiento_inventario__tipo_movimiento__nombre").annotate(total=Sum("cantidad")):
        key = "salidas" if _norm(row["movimiento_inventario__tipo_movimiento__nombre"]).startswith("sal") else "entradas"
        totales[key] += int(row["total"] or 0)

    filtered = scope
    if tipo in {"entrada", "salida"}:
        filtered = filtered.filter(
            movimiento_inventario__tipo_movimiento__nombre__istartswith="sal" if tipo == "salida" else "ent"
        )

    grouped = (
        filtered.values("movimiento_inventario_id")
        .annotate(
            cantidad=Sum("cantidad"),
            valor_total=Sum("valor_total"),
            fecha=Max("movimiento_inventario__fecha"),
        )
        .order_by("-fecha", "-movimiento_inventario_id")
    )
    total_rows = grouped.count()
    page_size = max(1, min(int(page_size or PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX))
    total_pages = max(1, (total_rows + page_size - 1) // page_size)
    page = max(1, min(int(page or 1), total_pages))
    page_rows = list(grouped[(page - 1) * page_size: page * page_size])

    ids = [row["movimiento_inventario_id"] for row in page_rows]
    movements = MovimientoInventario.objects.filter(id__in=ids).select_related(
        "sucursal",
        "sucursal_objetivo",
        "tipo_movimiento",
        "sub_tipo_movimiento",
        "estado_movimiento",
        "casa_comercial",
    ).in_bulk()
    importaciones = _importaciones_by_movement(set(ids))

    results = []
    for row in page_rows:
        mov = movements.get(row["movimiento_inventario_id"])
        if not mov:
            continue
        tipo_key = _tipo_key(mov)
        subtipo = _subtipo_key(mov)
        importacion = importaciones.get(mov.id)
        cantidad = int(row["cantidad"] or 0)
        results.append(
            {
                "movimiento_id": mov.id,
                "tipo": tipo_key,
                "subtipo": subtipo,
                "subtipo_nombre": getattr(mov.sub_tipo_movimiento, "nombre", "") or "",
                "fecha": mov.fecha.isoformat() if mov.fecha else None,
                "no_documento": mov.no_documento,
                "estado": getattr(mov.estado_movimiento, "nombre", "") or "",
                "sucursal_id": mov.sucursal_id,
                "sucursal": str(mov.sucursal) if mov.sucursal_id else "",
                "origen": _origen_texto(mov, tipo_key, subtipo, importacion),
                "importacion": importacion,
                "cantidad": cantidad,
                "valor_total": str(row["valor_total"] or 0),
                "es_legado": bool(mov.es_legado),
            }
        )

    return {
        "results": results,
        "count": total_rows,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "totales": totales,
    }
