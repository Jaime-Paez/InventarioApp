"""Stock que se mueve entre bodega y taller.

Al despachar, los repuestos SALEN del inventario de la sucursal (ya no se
pueden vender ni sacar en otra salida) y quedan "en taller". Siguen siendo de
la empresa: el kardex no cambia hasta que la orden se cierra con su salida
tipo Taller. Lo que vuelve (a prueba o quitado de la orden) entra a la
ubicacion que elige el administrador.
"""

from collections import defaultdict

from django.db.models import F
from rest_framework.exceptions import ValidationError

from inventario.models import Inventario, SubDivision
from inventario.por_ubicar import POR_UBICAR_NOMBRE, add_stock, get_por_ubicar_subdivision


def _es_por_ubicar(subdivision):
    return (
        str(subdivision.nombre or "").strip().upper() == POR_UBICAR_NOMBRE
        and str(subdivision.division.nombre or "").strip().upper() == POR_UBICAR_NOMBRE
    )


def etiqueta_ubicacion(subdivision):
    division = subdivision.division
    bodega = division.bodega
    if _es_por_ubicar(subdivision):
        return f"{bodega.nombre} / POR UBICAR"
    return f"{bodega.nombre} / {division.nombre} / {subdivision.nombre}"


def _principal_id(sucursal_id, producto_id):
    from movimientos.entry_adjustment import principal_subdivision_id

    try:
        return principal_subdivision_id(sucursal_id, producto_id)
    except Exception:  # pragma: no cover - sin orden de ubicaciones
        return None


def ubicaciones_producto(sucursal_id, producto_id):
    """Ubicaciones del producto en la sucursal (con o sin stock), la principal
    primero, y POR UBICAR al final como opcion para devolver."""
    rows = (
        Inventario.objects.filter(
            producto_id=producto_id,
            subdivision__division__bodega__sucursal_id=sucursal_id,
        )
        .select_related("subdivision__division__bodega")
        .order_by("id")
    )
    principal_id = _principal_id(sucursal_id, producto_id)
    por_sub = {}
    for row in rows:
        sub = row.subdivision
        entry = por_sub.setdefault(
            sub.id,
            {
                "subdivision_id": sub.id,
                "ubicacion": etiqueta_ubicacion(sub),
                "cantidad": 0,
                "principal": sub.id == principal_id,
                "por_ubicar": _es_por_ubicar(sub),
            },
        )
        entry["cantidad"] += max(0, int(row.cantidad or 0))
    ubicaciones = sorted(
        por_sub.values(),
        key=lambda item: (not item["principal"], item["por_ubicar"], -item["cantidad"], item["ubicacion"]),
    )
    if not any(item["por_ubicar"] for item in ubicaciones):
        por_ubicar = get_por_ubicar_subdivision(sucursal_id, create=False)
        if por_ubicar is not None:
            ubicaciones.append(
                {
                    "subdivision_id": por_ubicar.id,
                    "ubicacion": etiqueta_ubicacion(por_ubicar),
                    "cantidad": 0,
                    "principal": False,
                    "por_ubicar": True,
                }
            )
        else:
            # Se crea al elegirla (ver devolver()).
            ubicaciones.append(
                {
                    "subdivision_id": "por_ubicar",
                    "ubicacion": "POR UBICAR",
                    "cantidad": 0,
                    "principal": False,
                    "por_ubicar": True,
                }
            )
    return ubicaciones


def descontar(sucursal_id, producto_id, cantidad, subdivision_id=None):
    """Saca `cantidad` del inventario de la sucursal. Empieza por la ubicacion
    elegida (o la principal) y sigue con las demas. Las filas quedan en 0 (no
    se borran) para que el producto no pierda su ubicacion. Devuelve
    [{subdivision_id, ubicacion, cantidad}] de donde salio."""
    cantidad = int(cantidad or 0)
    if cantidad <= 0:
        return []
    rows = list(
        Inventario.objects.select_for_update(of=("self",))
        .filter(
            producto_id=producto_id,
            subdivision__division__bodega__sucursal_id=sucursal_id,
            cantidad__gt=0,
        )
        .select_related("subdivision__division__bodega")
        .order_by("id")
    )
    preferida = int(subdivision_id) if subdivision_id not in (None, "", "auto") else _principal_id(sucursal_id, producto_id)
    rows.sort(key=lambda row: (row.subdivision_id != preferida, _es_por_ubicar(row.subdivision), row.id))
    disponible = sum(int(row.cantidad or 0) for row in rows)
    if disponible < cantidad:
        from productos.models import Producto

        codigo = Producto.objects.filter(pk=producto_id).values_list("codigo", flat=True).first() or producto_id
        raise ValidationError(
            {"detail": f"No hay stock suficiente de {codigo} en la sucursal: hay {disponible} y se necesitan {cantidad}."}
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
                "ubicacion": etiqueta_ubicacion(row.subdivision),
                "cantidad": parte,
            }
        )
        restante -= parte
    return tomado


def resolver_subdivision(sucursal_id, subdivision_id):
    if subdivision_id == "por_ubicar":
        subdivision = get_por_ubicar_subdivision(sucursal_id, create=True)
        if subdivision is None:
            raise ValidationError({"detail": "La sucursal no tiene bodegas para crear POR UBICAR."})
        return subdivision
    try:
        sub_id = int(subdivision_id)
    except (TypeError, ValueError):
        raise ValidationError({"detail": "Elige la ubicación donde se guarda."})
    subdivision = (
        SubDivision.objects.select_related("division__bodega")
        .filter(pk=sub_id, division__bodega__sucursal_id=sucursal_id)
        .first()
    )
    if subdivision is None:
        raise ValidationError({"detail": "Esa ubicación no es de la sucursal de la orden."})
    return subdivision


def devolver(subdivision, producto_id, cantidad):
    add_stock(subdivision.id, producto_id, cantidad)


def en_taller_por_producto_sucursal(product_ids):
    """{(producto_id, sucursal_id): {"cantidad", "documentos": [...]}} con lo
    que esta fisicamente en el taller (ordenes de trabajo abiertas)."""
    from .models import OrdenTaller, OrdenTallerLinea, OrdenTallerPrueba

    ids = sorted({int(pid) for pid in product_ids if pid})
    if not ids:
        return {}
    resultado = {}
    docs = defaultdict(lambda: defaultdict(int))
    abiertas = OrdenTaller.Estados.ORDEN

    lineas = OrdenTallerLinea.objects.filter(
        producto_id__in=ids,
        orden__estado=abiertas,
        cantidad_despachada__gt=0,
    ).values_list("producto_id", "orden__sucursal_id", "orden_id", "orden__numero", "orden__placa", "cantidad_despachada")
    for pid, sid, oid, numero, placa, qty in lineas:
        docs[(pid, sid)][(oid, numero, placa)] += int(qty or 0)

    pruebas = OrdenTallerPrueba.objects.filter(
        producto_id__in=ids,
        orden__estado=abiertas,
        cantidad_entregada__gt=F("cantidad_usada") + F("cantidad_devuelta"),
    ).values_list(
        "producto_id", "orden__sucursal_id", "orden_id", "orden__numero", "orden__placa",
        "cantidad_entregada", "cantidad_usada", "cantidad_devuelta",
    )
    for pid, sid, oid, numero, placa, entregada, usada, devuelta in pruebas:
        docs[(pid, sid)][(oid, numero, placa)] += max(0, int(entregada) - int(usada) - int(devuelta))

    for key, por_orden in docs.items():
        if key[1] is None:
            continue
        documentos = [
            {"orden_id": oid, "numero": numero, "placa": placa or "", "cantidad": qty}
            for (oid, numero, placa), qty in sorted(por_orden.items(), key=lambda item: item[0][1])
            if qty > 0
        ]
        total = sum(doc["cantidad"] for doc in documentos)
        if total > 0:
            resultado[(int(key[0]), int(key[1]))] = {"cantidad": total, "documentos": documentos}
    return resultado
