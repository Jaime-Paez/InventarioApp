"""Stock que se mueve entre bodega y taller.

Al despachar, los repuestos SALEN del inventario (ya no se pueden vender ni
sacar en otra salida) y quedan "en taller". Salen primero de la sucursal del
taller; si ahi no hay, el administrador los despacha desde otra sucursal y se
descuentan de esa. Siguen siendo de la empresa: el kardex no cambia hasta que
la orden se cierra con su salida tipo Taller (una por sucursal de origen). Lo
que vuelve (a prueba o quitado de la orden) entra a la ubicacion que elige el
administrador.
"""

from collections import defaultdict

from django.db.models import F
from rest_framework.exceptions import ValidationError

from inventario.models import Inventario, Sucursal, SubDivision
from inventario.por_ubicar import POR_UBICAR_NOMBRE, add_stock, get_por_ubicar_subdivision


def _es_por_ubicar(subdivision):
    return (
        str(subdivision.nombre or "").strip().upper() == POR_UBICAR_NOMBRE
        and str(subdivision.division.nombre or "").strip().upper() == POR_UBICAR_NOMBRE
    )


def etiqueta_ubicacion(subdivision, con_sucursal=False):
    division = subdivision.division
    bodega = division.bodega
    if _es_por_ubicar(subdivision):
        texto = f"{bodega.nombre} / POR UBICAR"
    else:
        texto = f"{bodega.nombre} / {division.nombre} / {subdivision.nombre}"
    if con_sucursal:
        return f"{bodega.sucursal.nombre} · {texto}"
    return texto


def _principal_id(sucursal_id, producto_id):
    from movimientos.entry_adjustment import principal_subdivision_id

    try:
        return principal_subdivision_id(sucursal_id, producto_id)
    except Exception:  # pragma: no cover - sin orden de ubicaciones
        return None


def ubicaciones_producto(sucursal_taller_id, producto_id):
    """Ubicaciones del producto en TODAS las sucursales: primero la del taller
    (su ubicacion principal arriba), luego las demas con stock. Al final, POR
    UBICAR de la sucursal del taller como opcion para devolver."""
    rows = (
        Inventario.objects.filter(producto_id=producto_id)
        .select_related("subdivision__division__bodega__sucursal")
        .order_by("id")
    )
    principales = {}
    por_sub = {}
    for row in rows:
        sub = row.subdivision
        sucursal = sub.division.bodega.sucursal
        if sucursal.id not in principales:
            principales[sucursal.id] = _principal_id(sucursal.id, producto_id)
        entry = por_sub.setdefault(
            sub.id,
            {
                "subdivision_id": sub.id,
                "sucursal_id": sucursal.id,
                "sucursal_nombre": sucursal.nombre,
                "es_sucursal_taller": sucursal.id == sucursal_taller_id,
                "ubicacion": etiqueta_ubicacion(sub),
                "cantidad": 0,
                "principal": sub.id == principales[sucursal.id],
                "por_ubicar": _es_por_ubicar(sub),
            },
        )
        entry["cantidad"] += max(0, int(row.cantidad or 0))
    ubicaciones = sorted(
        por_sub.values(),
        key=lambda item: (
            not item["es_sucursal_taller"],
            item["sucursal_nombre"],
            not item["principal"],
            item["por_ubicar"],
            -item["cantidad"],
            item["ubicacion"],
        ),
    )
    # Sucursales ajenas sin stock no sirven ni para despachar ni para devolver.
    ubicaciones = [u for u in ubicaciones if u["es_sucursal_taller"] or u["cantidad"] > 0]
    if sucursal_taller_id and not any(u["por_ubicar"] and u["es_sucursal_taller"] for u in ubicaciones):
        sucursal = Sucursal.objects.filter(pk=sucursal_taller_id).first()
        por_ubicar = get_por_ubicar_subdivision(sucursal_taller_id, create=False)
        ubicaciones.append(
            {
                "subdivision_id": por_ubicar.id if por_ubicar else "por_ubicar",
                "sucursal_id": sucursal_taller_id,
                "sucursal_nombre": sucursal.nombre if sucursal else "",
                "es_sucursal_taller": True,
                "ubicacion": etiqueta_ubicacion(por_ubicar) if por_ubicar else "POR UBICAR",
                "cantidad": 0,
                "principal": False,
                "por_ubicar": True,
            }
        )
    return ubicaciones


def _sucursal_de(subdivision_id):
    return (
        SubDivision.objects.filter(pk=subdivision_id)
        .values_list("division__bodega__sucursal_id", flat=True)
        .first()
    )


def descontar(sucursal_taller_id, producto_id, cantidad, subdivision_id=None):
    """Saca `cantidad` del inventario. Con una ubicacion elegida sale de esa
    (y si no alcanza, de las demas de SU sucursal); en automatico, de la
    sucursal del taller empezando por la principal. Las filas quedan en 0 (no
    se borran) para que el producto no pierda su ubicacion. Devuelve
    (sucursal_id, [{subdivision_id, ubicacion, cantidad}])."""
    cantidad = int(cantidad or 0)
    if cantidad <= 0:
        return sucursal_taller_id, []
    elegida = None if subdivision_id in (None, "", "auto") else int(subdivision_id)
    sucursal_id = _sucursal_de(elegida) if elegida else sucursal_taller_id
    if sucursal_id is None:
        raise ValidationError({"detail": "Esa ubicación ya no existe."})
    rows = list(
        Inventario.objects.select_for_update(of=("self",))
        .filter(
            producto_id=producto_id,
            subdivision__division__bodega__sucursal_id=sucursal_id,
            cantidad__gt=0,
        )
        .select_related("subdivision__division__bodega__sucursal")
        .order_by("id")
    )
    preferida = elegida or _principal_id(sucursal_id, producto_id)
    rows.sort(key=lambda row: (row.subdivision_id != preferida, _es_por_ubicar(row.subdivision), row.id))
    disponible = sum(int(row.cantidad or 0) for row in rows)
    if disponible < cantidad:
        from productos.models import Producto

        codigo = Producto.objects.filter(pk=producto_id).values_list("codigo", flat=True).first() or producto_id
        sucursal = Sucursal.objects.filter(pk=sucursal_id).values_list("nombre", flat=True).first() or "la sucursal"
        otras = defaultdict(int)
        for suc_nombre, qty in (
            Inventario.objects.filter(producto_id=producto_id, cantidad__gt=0)
            .exclude(subdivision__division__bodega__sucursal_id=sucursal_id)
            .values_list("subdivision__division__bodega__sucursal__nombre", "cantidad")
        ):
            otras[suc_nombre] += int(qty)
        extra = (
            " Hay en " + ", ".join(f"{nombre} ({qty})" for nombre, qty in sorted(otras.items()))
            + ": elige esa ubicación para despacharlo desde allá."
            if otras
            else " No hay en ninguna otra sucursal."
        )
        raise ValidationError(
            {"detail": f"No alcanza {codigo} en {sucursal}: hay {disponible} y se necesitan {cantidad}.{extra}"}
        )
    restante = cantidad
    tomado = []
    for row in rows:
        if restante <= 0:
            break
        parte = min(int(row.cantidad or 0), restante)
        Inventario.objects.filter(pk=row.pk).update(cantidad=F("cantidad") - parte)
        tomado.append(
            {
                "subdivision_id": row.subdivision_id,
                "ubicacion": etiqueta_ubicacion(row.subdivision, con_sucursal=sucursal_id != sucursal_taller_id),
                "cantidad": parte,
            }
        )
        restante -= parte
    return sucursal_id, tomado


def resolver_subdivision(sucursal_taller_id, subdivision_id):
    """Ubicacion donde se guarda lo que vuelve: cualquiera de cualquier
    sucursal, o POR UBICAR de la sucursal del taller."""
    if subdivision_id == "por_ubicar":
        subdivision = get_por_ubicar_subdivision(sucursal_taller_id, create=True)
        if subdivision is None:
            raise ValidationError({"detail": "La sucursal del taller no tiene bodegas para crear POR UBICAR."})
        return subdivision
    try:
        sub_id = int(subdivision_id)
    except (TypeError, ValueError):
        raise ValidationError({"detail": "Elige la ubicación donde se guarda."})
    subdivision = SubDivision.objects.select_related("division__bodega__sucursal").filter(pk=sub_id).first()
    if subdivision is None:
        raise ValidationError({"detail": "Esa ubicación ya no existe."})
    return subdivision


def devolver(subdivision, producto_id, cantidad):
    add_stock(subdivision.id, producto_id, cantidad)


def en_taller_por_producto_sucursal(product_ids):
    """{(producto_id, sucursal_id): {"cantidad", "documentos": [...]}} con lo
    que esta fisicamente en el taller (ordenes de trabajo abiertas), contado
    en la sucursal de la que salio."""
    from .models import OrdenTaller, OrdenTallerDevolucion, OrdenTallerEntregaItem

    ids = sorted({int(pid) for pid in product_ids if pid})
    if not ids:
        return {}
    abiertas = OrdenTaller.Estados.ORDEN
    neto = defaultdict(lambda: defaultdict(int))
    info = {}

    entregas = OrdenTallerEntregaItem.objects.filter(
        producto_id__in=ids, entrega__orden__estado=abiertas
    ).values_list(
        "producto_id", "sucursal_id", "entrega__orden_id", "entrega__orden__numero", "entrega__orden__placa", "cantidad",
        "entrega__orden__sucursal_id",
    )
    for pid, sid, oid, numero, placa, qty, sucursal_orden in entregas:
        sid = sid or sucursal_orden
        neto[(pid, sid)][oid] += int(qty or 0)
        info[oid] = (numero, placa or "")

    devueltos = OrdenTallerDevolucion.objects.filter(
        producto_id__in=ids, orden__estado=abiertas
    ).values_list("producto_id", "subdivision__division__bodega__sucursal_id", "orden_id", "cantidad", "orden__sucursal_id")
    for pid, sid, oid, qty, sucursal_orden in devueltos:
        sid = sid or sucursal_orden
        neto[(pid, sid)][oid] -= int(qty or 0)

    resultado = {}
    for key, por_orden in neto.items():
        if key[1] is None:
            continue
        documentos = [
            {"orden_id": oid, "numero": info.get(oid, ("", ""))[0], "placa": info.get(oid, ("", ""))[1], "cantidad": qty}
            for oid, qty in sorted(por_orden.items(), key=lambda item: info.get(item[0], (0,))[0] or 0)
            if qty > 0
        ]
        total = sum(doc["cantidad"] for doc in documentos)
        if total > 0:
            resultado[(int(key[0]), int(key[1]))] = {"cantidad": total, "documentos": documentos}
    return resultado


def disponible_por_sucursal(orden, producto_id):
    """Unidades de este producto que la orden tiene en el taller, por sucursal
    de origen (entregado - devuelto)."""
    from .models import OrdenTallerDevolucion, OrdenTallerEntregaItem

    neto = defaultdict(int)
    for sid, qty in OrdenTallerEntregaItem.objects.filter(entrega__orden=orden, producto_id=producto_id).values_list(
        "sucursal_id", "cantidad"
    ):
        neto[sid or orden.sucursal_id] += int(qty or 0)
    for sid, qty in OrdenTallerDevolucion.objects.filter(orden=orden, producto_id=producto_id).values_list(
        "subdivision__division__bodega__sucursal_id", "cantidad"
    ):
        neto[sid or orden.sucursal_id] -= int(qty or 0)
    return neto
