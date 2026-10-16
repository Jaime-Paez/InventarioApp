"""Editar las cantidades de una entrada ya recibida, aplicando solo la diferencia.

Antes, al guardar una entrada editada se deshacia la entrada completa (se
restaba todo lo que habia ingresado) y luego se volvia a registrar. Si una
parte ya se habia vendido o trasladado, el "deshacer" fallaba con "Stock
insuficiente" aunque solo se quisiera sumar una unidad, y ademas el stock
volvia a la primera ubicacion de la sucursal, no a donde estaba.

Ahora, por producto: si la cantidad sube se suma la diferencia en su ubicacion
(o en la elegida); si baja se resta de la ubicacion elegida, o de las que mas
stock tienen. La misma funcion arma la vista previa que ve el usuario antes de
guardar y el plan que se aplica al guardar.
"""

from collections import defaultdict

from inventario.models import Inventario, SubDivision

ENTRY_SUBTIPOS = {"compra_local", "importacion", "devolucion"}
ENTRY_ESTADOS = {"recibido", "parcialmente recibido"}


class AdjustmentError(Exception):
    """Un cambio que no se puede aplicar; el mensaje es para el usuario."""


def location_label(subdivision):
    division = subdivision.division
    return f"{division.bodega.nombre} › {division.nombre} › {subdivision.nombre}"


def entry_adds_stock(tipo_name, subtipo_key, estado_name, funcional=True):
    """Si una entrada con estos datos suma al inventario de su sucursal."""
    if not str(tipo_name or "").startswith("ent"):
        return False
    if subtipo_key not in ENTRY_SUBTIPOS or estado_name not in ENTRY_ESTADOS:
        return False
    if subtipo_key == "devolucion" and not funcional:
        return False
    return True


def quantities_by_product(details):
    """{producto_id: cantidad} desde detalles (dicts validados o modelos)."""
    totals = defaultdict(int)
    for detail in details or []:
        if isinstance(detail, dict):
            producto = detail.get("producto")
            producto_id = getattr(producto, "id", None) or detail.get("producto_id")
            raw = detail.get("cantidad")
        else:
            producto_id = getattr(detail, "producto_id", None)
            raw = getattr(detail, "cantidad", 0)
        try:
            cantidad = int(raw or 0)
        except (TypeError, ValueError):
            continue
        if producto_id and cantidad > 0:
            totals[int(producto_id)] += cantidad
    return dict(totals)


def branch_locations(sucursal_id, product_ids, for_update=False):
    """{producto_id: [ {subdivision_id, label, cantidad} ]} ordenado de mas a menos stock."""
    queryset = Inventario.objects.filter(
        subdivision__division__bodega__sucursal_id=sucursal_id,
        producto_id__in=sorted(product_ids),
    ).select_related("subdivision__division__bodega")
    if for_update:
        queryset = queryset.select_for_update()
    by_product = defaultdict(dict)
    for row in queryset:
        bucket = by_product[row.producto_id]
        entry = bucket.setdefault(
            row.subdivision_id,
            {
                "subdivision_id": row.subdivision_id,
                "label": location_label(row.subdivision),
                "cantidad": 0,
                "orden": row.id,
            },
        )
        entry["cantidad"] += int(row.cantidad or 0)
        entry["orden"] = min(entry["orden"], row.id)
    return {
        pid: sorted(locs.values(), key=lambda loc: (-loc["cantidad"], loc["label"]))
        for pid, locs in by_product.items()
    }


def plan_adjustment(*, sucursal, before, after, overrides=None, products=None, for_update=False):
    """Lista de cambios por producto. Cada uno trae `error` si no se puede aplicar.

    before/after: {producto_id: cantidad}. overrides: {producto_id: subdivision_id}.
    products: {producto_id: (codigo, nombre)} para los mensajes.
    """
    overrides = overrides or {}
    products = products or {}
    sucursal_id = int(sucursal.id)
    sucursal_name = str(getattr(sucursal, "nombre", "") or "la sucursal")
    changed = sorted(pid for pid in set(before) | set(after) if after.get(pid, 0) != before.get(pid, 0))
    if not changed:
        return []
    locations = branch_locations(sucursal_id, changed, for_update=for_update)
    branch_subdivisions = {
        sub.id: sub
        for sub in SubDivision.objects.select_related("division__bodega").filter(
            division__bodega__sucursal_id=sucursal_id,
            id__in=[int(v) for v in overrides.values() if v],
        )
    }

    plan = []
    for pid in changed:
        old, new = int(before.get(pid, 0)), int(after.get(pid, 0))
        delta = new - old
        codigo, nombre = products.get(pid, ("", ""))
        label = codigo or nombre or f"producto {pid}"
        locs = locations.get(pid, [])
        total = sum(loc["cantidad"] for loc in locs)
        item = {
            "producto_id": pid,
            "codigo": codigo,
            "nombre": nombre,
            "antes": old,
            "despues": new,
            "delta": delta,
            "stock_sucursal": total,
            "ubicaciones": locs,
            "subdivision_id": None,
            "ubicacion": "",
            "repartir": False,
            "error": "",
        }
        chosen = overrides.get(pid)
        if chosen:
            sub = branch_subdivisions.get(int(chosen))
            if sub is None:
                item["error"] = f"La ubicación elegida para {label} no es de {sucursal_name}."
                plan.append(item)
                continue
            item["subdivision_id"] = sub.id
            item["ubicacion"] = location_label(sub)

        if delta > 0:
            if not item["subdivision_id"]:
                # Igual que al crear una entrada: la ubicacion habitual del
                # producto (la primera registrada que tiene stock).
                by_order = sorted(locs, key=lambda loc: loc["orden"])
                target = next((loc for loc in by_order if loc["cantidad"] > 0), by_order[0] if by_order else None)
                if target is None:
                    item["error"] = (
                        f"{label} no tiene ubicación en {sucursal_name}: elige dónde guardar "
                        f"las {delta} unidades que se suman."
                    )
                else:
                    item["subdivision_id"] = target["subdivision_id"]
                    item["ubicacion"] = target["label"]
        else:
            need = -delta
            if total < need:
                minimo = old - total
                item["error"] = (
                    f"No se puede bajar {label} de {old} a {new}: en {sucursal_name} solo quedan {total} "
                    f"(el resto de esta entrada ya se vendió o se trasladó). Como mínimo puede quedar en {minimo}."
                )
            elif item["subdivision_id"]:
                here = next((loc["cantidad"] for loc in locs if loc["subdivision_id"] == item["subdivision_id"]), 0)
                if here < need:
                    item["error"] = (
                        f"En {item['ubicacion']} solo hay {here} de {label} y se quieren restar {need}: "
                        "elige otra ubicación."
                    )
            else:
                single = next((loc for loc in locs if loc["cantidad"] >= need), None)
                if single is not None:
                    item["subdivision_id"] = single["subdivision_id"]
                    item["ubicacion"] = single["label"]
                else:
                    item["repartir"] = True
                    item["ubicacion"] = "varias ubicaciones (de las que más tienen)"
        plan.append(item)
    return plan


def apply_adjustment(plan, sucursal_id):
    """Aplica un plan sin errores. Devuelve los producto_id cuyo stock bajo."""
    reduced = set()
    for item in plan:
        pid, delta = item["producto_id"], item["delta"]
        if delta > 0:
            row = (
                Inventario.objects.select_for_update()
                .filter(subdivision_id=item["subdivision_id"], producto_id=pid)
                .order_by("-cantidad", "id")
                .first()
            )
            if row is None:
                row = Inventario.objects.create(
                    subdivision_id=item["subdivision_id"], producto_id=pid, referencia="", cantidad=0
                )
            row.cantidad += delta
            row.save(update_fields=["cantidad"])
            continue
        remaining = -delta
        rows = Inventario.objects.select_for_update().filter(producto_id=pid, cantidad__gt=0)
        if item["subdivision_id"]:
            rows = rows.filter(subdivision_id=item["subdivision_id"])
        else:
            rows = rows.filter(subdivision__division__bodega__sucursal_id=sucursal_id)
        for row in rows.order_by("-cantidad", "id"):
            if remaining <= 0:
                break
            taken = min(row.cantidad, remaining)
            row.cantidad -= taken
            row.save(update_fields=["cantidad"])
            remaining -= taken
        if remaining > 0:
            raise AdjustmentError(f"No hay stock suficiente para restar {-delta} de {item['codigo'] or pid}.")
        reduced.add(pid)
    return reduced
