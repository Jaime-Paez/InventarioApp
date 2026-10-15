"""Reposicion de inventario por producto y sucursal.

Implementa "Setting Analytical Inventory Targets for a Single Location"
(S. Willems) y la clasificacion de inventario por causa (cap. 8):

- Demanda diaria por (sucursal, producto): media mu y desviacion sigma sobre
  la ventana configurada (dias sin venta cuentan como 0).
- Clasificacion ABC por valor anual de la demanda (a costo).
- A y B -> revision continua (R, Q):
      SS = z * sigma * sqrt(L);  R = L * mu + SS;  Q = EOQ
      inventario esperado = Q / 2 + SS
- C -> revision periodica con stock base (B):
      SS = z * sigma * sqrt(r + L);  B = (r + L) * mu + SS
      inventario esperado = r * mu / 2 + SS
- z sale del nivel de servicio (fill rate) de cada clase.
- L: la sucursal central se abastece del proveedor (dias reales de sus
  importaciones o el valor por defecto segun sea local o de importacion);
  las demas sucursales se abastecen de la central por traslado.
- Sugerido a pedir: con la posicion de inventario (stock + en camino).
- Inventario por causa (en valor): ciclo, seguridad, en camino, exceso y
  obsoleto.
"""

import datetime
import math
import time
from statistics import NormalDist

from django.db.models import Avg, Max, Sum
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from usuarios.utils import is_app_admin

from .models import ReposicionConfiguracion

DEMAND_SUBTYPES = ("venta", "traslado")
_CACHE = {"key": None, "at": 0.0, "rows": None, "meta": None}
CACHE_SECONDS = 300


def _z_for(service_level):
    level = min(max(float(service_level or 0) / 100.0, 0.5), 0.9999)
    return NormalDist().inv_cdf(level)


def _round_up(value):
    return int(math.ceil(max(0.0, float(value)) - 1e-9))


def _central_branch_id(config):
    from inventario.models import Sucursal

    if config.sucursal_central_id:
        return int(config.sucursal_central_id)
    matriz = Sucursal.objects.filter(nombre__icontains="matriz").order_by("id").first()
    if matriz is not None:
        return int(matriz.id)
    first = Sucursal.objects.order_by("id").first()
    return int(first.id) if first else None


def _supplier_leadtimes(config):
    """Dias de entrega por casa comercial: promedio real de sus importaciones,
    o el estimado, o el valor por defecto segun el tipo de proveedor."""
    from casa_comercial.models import CasaComercial
    from importaciones.models import Importacion

    real = {
        int(row["casa_comercial_id"]): float(row["dias"])
        for row in Importacion.objects.filter(dias_reales_entrega__gt=0)
        .values("casa_comercial_id")
        .annotate(dias=Avg("dias_reales_entrega"))
        if row["casa_comercial_id"] and row["dias"]
    }
    estimated = {
        int(row["casa_comercial_id"]): float(row["dias"])
        for row in Importacion.objects.filter(dias_entrega_estimados__gt=0)
        .values("casa_comercial_id")
        .annotate(dias=Avg("dias_entrega_estimados"))
        if row["casa_comercial_id"] and row["dias"]
    }
    result = {}
    for casa in CasaComercial.objects.all().only("id", "tipo", "nombre", "dias_entrega"):
        default = (
            config.proveedor_importacion_dias
            if casa.tipo == CasaComercial.TIPO_IMPORTACION
            else config.proveedor_local_dias
        )
        # Estimado: el de sus importaciones o el "dias de entrega" del proveedor.
        own_estimate = float(casa.dias_entrega) if getattr(casa, "dias_entrega", None) else None
        estimate = estimated.get(int(casa.id)) or own_estimate
        result[int(casa.id)] = {
            "dias": real.get(int(casa.id)) or estimate or float(default),
            "fuente": "proveedor" if int(casa.id) in real else ("estimado" if estimate else "defecto"),
            "proveedor": casa.nombre,
        }
    return result


def _product_leadtimes(product_ids):
    """Dias reales de las importaciones en las que vino cada producto (lo mas
    preciso): {producto_id: {"dias", "importaciones": [codigo...]}}."""
    from importaciones.models import ImportacionDetalle

    result = {}
    rows = (
        ImportacionDetalle.objects.filter(
            producto_id__in=sorted(product_ids), importacion__dias_reales_entrega__gt=0
        )
        .values("producto_id", "importacion_id", "importacion__codigo", "importacion__dias_reales_entrega")
        .distinct()
    )
    for row in rows:
        bucket = result.setdefault(int(row["producto_id"]), {"total": 0.0, "importaciones": {}})
        if row["importacion_id"] in bucket["importaciones"]:
            continue
        bucket["importaciones"][row["importacion_id"]] = (
            row["importacion__codigo"], int(row["importacion__dias_reales_entrega"])
        )
        bucket["total"] += float(row["importacion__dias_reales_entrega"])
    return {
        pid: {
            "dias": bucket["total"] / len(bucket["importaciones"]),
            "importaciones": [
                {"codigo": codigo, "dias": dias} for codigo, dias in bucket["importaciones"].values()
            ][:5],
        }
        for pid, bucket in result.items()
        if bucket["importaciones"]
    }


def compute_replenishment(config=None, *, today=None):
    """Calcula la reposicion de todos los (sucursal, producto) con stock o demanda."""
    from inventario.models import Inventario, Sucursal
    from inventario.por_ubicar import in_transit_by_product_branch
    from movimientos.models import DetalleMovimiento
    from productos.models import Producto

    config = config or ReposicionConfiguracion.get_global()
    today = today or timezone.localdate()
    window = max(14, int(config.ventana_dias or 180))
    start = today - datetime.timedelta(days=window - 1)
    central_id = _central_branch_id(config)
    review = max(1, int(config.revision_dias or 7))
    transfer_days = max(0, int(config.traslado_dias or 0))

    # --- Demanda diaria -------------------------------------------------
    sales = DetalleMovimiento.objects.filter(
        movimiento_inventario__tipo_movimiento__nombre__iexact="salida",
        movimiento_inventario__sub_tipo_movimiento__nombre__iregex=r"^(venta|traslado)$",
        movimiento_inventario__fecha__gte=start,
        movimiento_inventario__fecha__lte=today,
    )
    demand = {}
    for row in sales.values(
        "movimiento_inventario__sucursal_id", "producto_id", "movimiento_inventario__fecha"
    ).annotate(qty=Sum("cantidad")):
        key = (int(row["movimiento_inventario__sucursal_id"]), int(row["producto_id"]))
        qty = float(row["qty"] or 0)
        bucket = demand.setdefault(key, [0.0, 0.0, 0])
        bucket[0] += qty
        bucket[1] += qty * qty
        bucket[2] += 1

    last_sale = {
        (int(row["movimiento_inventario__sucursal_id"]), int(row["producto_id"])): row["ultima"]
        for row in DetalleMovimiento.objects.filter(
            movimiento_inventario__tipo_movimiento__nombre__iexact="salida",
            movimiento_inventario__sub_tipo_movimiento__nombre__iexact="venta",
            movimiento_inventario__fecha__lte=today,
        )
        .values("movimiento_inventario__sucursal_id", "producto_id")
        .annotate(ultima=Max("movimiento_inventario__fecha"))
    }

    # --- Stock y en camino ----------------------------------------------
    stock = {}
    for row in (
        Inventario.objects.filter(cantidad__gt=0)
        .values("subdivision__division__bodega__sucursal_id", "producto_id")
        .annotate(total=Sum("cantidad"))
    ):
        key = (int(row["subdivision__division__bodega__sucursal_id"]), int(row["producto_id"]))
        stock[key] = int(row["total"] or 0)

    keys = set(demand) | set(stock)
    product_ids = {pid for _, pid in keys}
    in_transit = in_transit_by_product_branch(product_ids) if product_ids else {}

    products = {
        int(p["id"]): p
        for p in Producto.objects.filter(id__in=product_ids).values("id", "codigo", "nombre", "costo_minimo", "precio")
    }
    supplier_of = {}
    for row in Producto.casas_comerciales.through.objects.filter(producto_id__in=product_ids).values(
        "producto_id", "casacomercial_id"
    ):
        supplier_of.setdefault(int(row["producto_id"]), int(row["casacomercial_id"]))
    leadtimes = _supplier_leadtimes(config)
    product_leadtimes = _product_leadtimes(product_ids) if product_ids else {}
    branches = {int(s.id): s.nombre for s in Sucursal.objects.all().only("id", "nombre")}

    def unit_cost(pid):
        product = products.get(pid) or {}
        cost = float(product.get("costo_minimo") or 0)
        return cost if cost > 0 else float(product.get("precio") or 0)

    # --- ABC por valor anual de demanda (toda la empresa) ----------------
    annual_value = {}
    for (branch_id, pid), (total, _sq, _days) in demand.items():
        annual_value[pid] = annual_value.get(pid, 0.0) + total * 365.0 / window * unit_cost(pid)
    ranked = sorted(((value, pid) for pid, value in annual_value.items() if value > 0), reverse=True)
    grand_total = sum(value for value, _ in ranked) or 1.0
    abc = {}
    running = 0.0
    for value, pid in ranked:
        # Participacion acumulada ANTES de este producto: el que cruza el
        # corte todavia entra en la clase de arriba.
        share_before = running / grand_total * 100
        running += value
        if share_before < float(config.corte_a):
            abc[pid] = "A"
        elif share_before < float(config.corte_b):
            abc[pid] = "B"
        else:
            abc[pid] = "C"
    z_by_class = {
        "A": _z_for(config.nivel_servicio_a),
        "B": _z_for(config.nivel_servicio_b),
        "C": _z_for(config.nivel_servicio_c),
    }
    min_sale_days = max(1, int(config.min_dias_venta or 1))
    max_order_days = max(1, int(config.max_dias_pedido or 90))
    holding_rate = float(config.costo_mantener_pct or 0) / 100.0
    order_cost = float(config.costo_pedido or 0)
    obsolete_days = int(config.dias_obsoleto or 180)

    rows = []
    for branch_id, pid in keys:
        product = products.get(pid)
        if product is None:
            continue
        total, sumsq, sale_days = demand.get((branch_id, pid), (0.0, 0.0, 0))
        mu = total / window
        variance = max(0.0, (sumsq - window * mu * mu) / (window - 1)) if window > 1 else 0.0
        sigma = math.sqrt(variance)
        on_hand = stock.get((branch_id, pid), 0)
        transit = int((in_transit.get((pid, branch_id)) or {}).get("total", 0))
        position = on_hand + transit
        cost = unit_cost(pid)
        clase = abc.get(pid, "N")  # N = sin demanda

        # Tiempo de entrega L, de lo mas preciso a lo mas general:
        # importaciones de este producto -> de su proveedor -> estimado -> defecto.
        importaciones_l = []
        proveedor_l = ""
        if branch_id == central_id:
            supplier = leadtimes.get(supplier_of.get(pid)) or {
                "dias": float(config.proveedor_local_dias), "fuente": "defecto", "proveedor": ""
            }
            proveedor_l = supplier.get("proveedor", "")
            own = product_leadtimes.get(pid)
            if own:
                leadtime = float(own["dias"])
                fuente_l = "producto"
                importaciones_l = own["importaciones"]
            else:
                leadtime = float(supplier["dias"])
                fuente_l = supplier["fuente"]
        else:
            leadtime = float(transfer_days)
            fuente_l = "traslado"

        last = last_sale.get((branch_id, pid))
        dias_sin_venta = (today - last).days if last else None
        obsolete = on_hand > 0 and (dias_sin_venta is None or dias_sin_venta >= obsolete_days)

        # Patron de demanda: con muy pocos dias de venta la demanda no es
        # "relativamente estable" (supuesto del modelo) y R/B no sirven.
        sporadic = 0 < sale_days < min_sale_days
        z = z_by_class.get(clase, 0.0)
        if sporadic:
            politica = "bajo_pedido"
            safety = 0.0
            punto = 0
            q = None
            nivel_max = 0
            ciclo_max = 0
            sugerido = 0
            esperado = 0.0
        elif clase in ("A", "B"):
            politica = "continua"
            safety = z * sigma * math.sqrt(leadtime)
            reorder = leadtime * mu + safety
            annual_units = mu * 365
            holding = cost * holding_rate
            if annual_units > 0 and holding > 0 and order_cost > 0:
                q = math.sqrt(2 * annual_units * order_cost / holding)
            else:
                q = mu * review
            # EOQ con tope: no pedir mas de max_dias_pedido de venta.
            q = min(q, mu * max_order_days) if mu > 0 else q
            q = max(1, _round_up(q))
            punto = _round_up(reorder)
            nivel_max = punto + q
            ciclo_max = q
            sugerido = q * _round_up((punto - position + 1) / q) if position <= punto and mu > 0 else 0
            esperado = q / 2 + safety
        elif clase == "C":
            politica = "periodica"
            safety = z * sigma * math.sqrt(review + leadtime)
            base = (review + leadtime) * mu + safety
            punto = _round_up(base)
            q = None
            nivel_max = punto
            ciclo_max = review * mu
            sugerido = max(0, punto - position)
            esperado = review * mu / 2 + safety
        else:
            politica = "sin_demanda"
            safety = 0.0
            punto = 0
            q = None
            nivel_max = 0
            ciclo_max = 0
            sugerido = 0
            esperado = 0.0

        safety_units = _round_up(safety)
        # Lo maximo que deberia haber en stock: justo al llegar un pedido
        # (E[I(L)+] = SS + Q en continua; SS + r*mu en periodica). Lo que
        # supere eso es exceso.
        if politica in ("continua", "periodica"):
            nivel_max = safety_units + _round_up(ciclo_max)
        if obsolete:
            estado = "obsoleto"
        elif sporadic:
            estado = "esporadico"
        elif mu > 0 and on_hand <= 0:
            estado = "agotado"
        elif sugerido > 0:
            estado = "pedir"
        elif on_hand > nivel_max and mu > 0:
            estado = "exceso"
        elif mu <= 0:
            estado = "sin_demanda"
        else:
            estado = "ok"

        # Inventario por causa (unidades -> valor).
        if obsolete:
            causa = {"obsoleto": on_hand}
        elif mu <= 0 or sporadic:
            # Poca o ninguna venta reciente, pero aun no obsoleto.
            causa = {"lento": on_hand}
        else:
            seguridad_u = min(on_hand, safety_units)
            ciclo_u = min(on_hand - seguridad_u, _round_up(ciclo_max))
            causa = {
                "seguridad": seguridad_u,
                "ciclo": ciclo_u,
                "exceso": on_hand - seguridad_u - ciclo_u,
            }
        causa["en_camino"] = transit

        rows.append({
            "sucursal_id": branch_id,
            "sucursal_nombre": branches.get(branch_id, ""),
            "es_central": branch_id == central_id,
            "producto_id": pid,
            "codigo": product["codigo"],
            "nombre": product["nombre"],
            "costo": round(cost, 2),
            "clase": clase,
            "politica": politica,
            "venta_dia": round(mu, 3),
            "desviacion_dia": round(sigma, 3),
            "venta_total": int(total),
            "dias_con_venta": int(sale_days),
            "dias_entrega": round(leadtime, 1),
            "fuente_entrega": fuente_l,
            "proveedor_nombre": proveedor_l,
            "importaciones_entrega": importaciones_l,
            "revision_dias": review if politica == "periodica" else None,
            "nivel_servicio": float(
                {"A": config.nivel_servicio_a, "B": config.nivel_servicio_b, "C": config.nivel_servicio_c}.get(clase, 0)
            ),
            "z": round(z, 3),
            "stock_seguridad": safety_units,
            "punto_pedido": punto if politica == "continua" else None,
            "cantidad_pedido": q,
            "nivel_base": punto if politica == "periodica" else None,
            "nivel_maximo": nivel_max,
            "inventario_esperado": round(esperado, 1),
            "stock": on_hand,
            "en_camino": transit,
            "posicion": position,
            "sugerido": int(sugerido),
            "valor_sugerido": round(int(sugerido) * cost, 2),
            "cobertura_dias": round(on_hand / mu, 1) if mu > 0 else None,
            "ultima_venta": last.isoformat() if last else None,
            "dias_sin_venta": dias_sin_venta,
            "estado": estado,
            "causa": causa,
        })

    meta = {
        "fecha": today.isoformat(),
        "ventana_desde": start.isoformat(),
        "ventana_dias": window,
        "sucursal_central_id": central_id,
        "sucursal_central_nombre": branches.get(central_id, "") if central_id else "",
    }
    return rows, meta


def _config_signature(config):
    return tuple(
        str(getattr(config, field))
        for field in (
            "ventana_dias", "nivel_servicio_a", "nivel_servicio_b", "nivel_servicio_c", "corte_a",
            "corte_b", "revision_dias", "traslado_dias", "proveedor_local_dias", "min_dias_venta", "max_dias_pedido",
            "proveedor_importacion_dias", "costo_pedido", "costo_mantener_pct", "dias_obsoleto",
            "sucursal_central_id",
        )
    )


def cached_replenishment(*, refresh=False):
    config = ReposicionConfiguracion.get_global()
    key = (_config_signature(config), timezone.localdate().isoformat())
    now = time.monotonic()
    if not refresh and _CACHE["key"] == key and now - _CACHE["at"] < CACHE_SECONDS:
        return _CACHE["rows"], _CACHE["meta"]
    rows, meta = compute_replenishment(config)
    meta["calculado_en"] = timezone.now().isoformat()
    _CACHE.update({"key": key, "at": now, "rows": rows, "meta": meta})
    return rows, meta


ESTADO_ORDEN = {
    "agotado": 0, "pedir": 1, "ok": 2, "exceso": 3, "esporadico": 4, "obsoleto": 5, "sin_demanda": 6,
}
CAUSAS = ("ciclo", "seguridad", "en_camino", "exceso", "lento", "obsoleto")

# Orden por columna que no es un campo simple de la fila.
SORT_KEYS = {
    "codigo": lambda row: str(row["codigo"] or "").lower(),
    "nombre": lambda row: str(row["nombre"] or "").lower(),
    "sucursal_nombre": lambda row: str(row["sucursal_nombre"] or "").lower(),
    "clase": lambda row: {"A": 0, "B": 1, "C": 2}.get(row["clase"], 3),
    "estado": lambda row: ESTADO_ORDEN.get(row["estado"], 9),
    "pedir_en": lambda row: row["punto_pedido"] if row["punto_pedido"] is not None else row["nivel_base"],
}


def _summary(rows):
    summary = {causa: 0.0 for causa in CAUSAS}
    counts = {estado: 0 for estado in ESTADO_ORDEN}
    total_sugerido = 0.0
    for row in rows:
        for causa, units in row["causa"].items():
            summary[causa] = summary.get(causa, 0.0) + units * row["costo"]
        counts[row["estado"]] = counts.get(row["estado"], 0) + 1
        total_sugerido += row["valor_sugerido"]
    return {
        "valor_por_causa": {causa: round(value, 2) for causa, value in summary.items()},
        "conteo_por_estado": counts,
        "valor_sugerido": round(total_sugerido, 2),
    }


class ReposicionAPIView(APIView):
    """Listado de reposicion con filtros, orden y paginado; resumen por causa."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not is_app_admin(request.user):
            return Response({"detail": "Solo administradores."}, status=status.HTTP_403_FORBIDDEN)
        rows, meta = cached_replenishment(refresh=request.query_params.get("recalcular") == "1")
        params = request.query_params

        sucursal_id = params.get("sucursal_id")
        if sucursal_id:
            rows = [row for row in rows if str(row["sucursal_id"]) == str(sucursal_id)]
        summary = _summary(rows)

        estado = (params.get("estado") or "").strip().lower()
        if estado == "reponer":
            rows = [row for row in rows if row["estado"] in ("agotado", "pedir")]
        elif estado:
            rows = [row for row in rows if row["estado"] == estado]
        clase = (params.get("clase") or "").strip().upper()
        if clase:
            rows = [row for row in rows if row["clase"] == clase]
        search = (params.get("search") or "").strip()
        if search:
            # Codigo, nombre, descripcion, referencia(s) u OEM.
            from core.search_utils import matching_product_ids

            matched = set(matching_product_ids(search).values_list("id", flat=True))
            rows = [row for row in rows if row["producto_id"] in matched]

        orden = (params.get("orden") or "prioridad").strip()
        descending = orden.startswith("-")
        field = orden.lstrip("-")
        if field == "prioridad":
            rows = sorted(
                rows,
                key=lambda row: (
                    ESTADO_ORDEN.get(row["estado"], 9),
                    {"A": 0, "B": 1, "C": 2}.get(row["clase"], 3),
                    row["cobertura_dias"] if row["cobertura_dias"] is not None else 1e9,
                ),
            )
        else:
            value_of = SORT_KEYS.get(field)
            if value_of is None and rows and field in rows[0]:
                value_of = lambda row: row[field]  # noqa: E731
            if value_of is not None:
                # Los vacios siempre al final, sea ascendente o descendente.
                present = [row for row in rows if value_of(row) is not None]
                missing = [row for row in rows if value_of(row) is None]
                rows = sorted(present, key=value_of, reverse=descending) + missing

        try:
            page = max(1, int(params.get("page") or 1))
            page_size = min(200, max(1, int(params.get("page_size") or 50)))
        except ValueError:
            page, page_size = 1, 50
        total = len(rows)
        if params.get("todo") == "1":
            # Para los reportes Excel/PDF: todo lo filtrado, sin paginar.
            page, page_size = 1, max(1, total)
        start = (page - 1) * page_size
        return Response(
            {
                "meta": meta,
                "resumen": summary,
                "count": total,
                "page": page,
                "page_size": page_size,
                "results": rows[start:start + page_size],
            },
            status=status.HTTP_200_OK,
        )


def _weekly_sales(product_id, start, today):
    """Ventas (y traslados que salen) por semana y sucursal en la ventana."""
    from movimientos.models import DetalleMovimiento

    weeks = {}
    rows = (
        DetalleMovimiento.objects.filter(
            producto_id=int(product_id),
            movimiento_inventario__tipo_movimiento__nombre__iexact="salida",
            movimiento_inventario__sub_tipo_movimiento__nombre__iregex=r"^(venta|traslado)$",
            movimiento_inventario__fecha__gte=start,
            movimiento_inventario__fecha__lte=today,
        )
        .values("movimiento_inventario__sucursal_id", "movimiento_inventario__fecha")
        .annotate(qty=Sum("cantidad"))
    )
    for row in rows:
        day = row["movimiento_inventario__fecha"]
        index = (day - start).days // 7
        bucket = weeks.setdefault(int(row["movimiento_inventario__sucursal_id"]), {})
        bucket[index] = bucket.get(index, 0) + int(row["qty"] or 0)
    total_weeks = (today - start).days // 7 + 1
    return {
        str(branch_id): [
            {
                "desde": (start + datetime.timedelta(days=7 * index)).isoformat(),
                "hasta": min(today, start + datetime.timedelta(days=7 * index + 6)).isoformat(),
                "cantidad": int(by_week.get(index, 0)),
            }
            for index in range(total_weeks)
        ]
        for branch_id, by_week in weeks.items()
    }


class ReposicionProductoAPIView(APIView):
    """Reposicion de un producto en todas las sucursales + ventas semanales."""

    permission_classes = [IsAuthenticated]

    def get(self, request, producto_id):
        if not is_app_admin(request.user):
            return Response({"detail": "Solo administradores."}, status=status.HTTP_403_FORBIDDEN)
        rows, meta = cached_replenishment(refresh=request.query_params.get("recalcular") == "1")
        product_rows = sorted(
            (row for row in rows if int(row["producto_id"]) == int(producto_id)),
            key=lambda row: (not row["es_central"], row["sucursal_nombre"]),
        )
        start = datetime.date.fromisoformat(meta["ventana_desde"])
        today = datetime.date.fromisoformat(meta["fecha"])
        return Response(
            {
                "meta": meta,
                "filas": product_rows,
                "ventas_semanales": _weekly_sales(producto_id, start, today),
            },
            status=status.HTTP_200_OK,
        )


OPEN_IMPORT_STATES = ("borrador", "cotizacion", "confirmacion", "en_camino")


def _open_imports_by_product(product_ids):
    """Importaciones abiertas (no recibidas) en las que ya esta cada producto."""
    from importaciones.models import ImportacionDetalle

    result = {}
    for row in (
        ImportacionDetalle.objects.filter(
            producto_id__in=sorted(product_ids), importacion__estado__in=OPEN_IMPORT_STATES
        )
        .values("producto_id", "importacion_id", "importacion__codigo", "importacion__estado", "cantidad")
        .order_by("importacion_id")
    ):
        result.setdefault(int(row["producto_id"]), []).append({
            "id": int(row["importacion_id"]),
            "codigo": row["importacion__codigo"],
            "estado": row["importacion__estado"],
            "cantidad": int(row["cantidad"] or 0),
        })
    return result


class ReposicionSugerenciaImportacionAPIView(APIView):
    """GET: lo que la sucursal central debe pedir, agrupado por proveedor.
    POST: crea la sugerencia de importacion (borrador) de un proveedor."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        from casa_comercial.models import CasaComercial
        from productos.models import Producto

        if not is_app_admin(request.user):
            return Response({"detail": "Solo administradores."}, status=status.HTTP_403_FORBIDDEN)
        rows, meta = cached_replenishment(refresh=request.query_params.get("recalcular") == "1")
        central_id = meta.get("sucursal_central_id")
        to_order = [
            row for row in rows
            if row["sucursal_id"] == central_id and row["sugerido"] > 0 and row["estado"] in ("agotado", "pedir")
        ]
        product_ids = [row["producto_id"] for row in to_order]
        supplier_of = {}
        for link in Producto.casas_comerciales.through.objects.filter(producto_id__in=product_ids).values(
            "producto_id", "casacomercial_id"
        ):
            supplier_of.setdefault(int(link["producto_id"]), []).append(int(link["casacomercial_id"]))
        casas = {
            int(casa.id): casa
            for casa in CasaComercial.objects.filter(
                id__in={cid for ids in supplier_of.values() for cid in ids}
            )
        }
        open_imports = _open_imports_by_product(product_ids) if product_ids else {}

        groups = {}
        for row in to_order:
            candidates = [casas[cid] for cid in supplier_of.get(row["producto_id"], []) if cid in casas]
            # Si tiene varios proveedores, primero el de importacion.
            candidates.sort(key=lambda casa: casa.tipo != CasaComercial.TIPO_IMPORTACION)
            casa = candidates[0] if candidates else None
            key = int(casa.id) if casa else 0
            group = groups.setdefault(key, {
                "casa_comercial_id": key or None,
                "casa_nombre": casa.nombre if casa else "Sin proveedor",
                "tipo": casa.tipo if casa else "",
                "es_importacion": bool(casa and casa.tipo == CasaComercial.TIPO_IMPORTACION),
                "items": [],
            })
            group["items"].append({
                "producto_id": row["producto_id"],
                "codigo": row["codigo"],
                "nombre": row["nombre"],
                "clase": row["clase"],
                "estado": row["estado"],
                "sugerido": row["sugerido"],
                "stock": row["stock"],
                "en_camino": row["en_camino"],
                "venta_dia": row["venta_dia"],
                "cobertura_dias": row["cobertura_dias"],
                "dias_entrega": row["dias_entrega"],
                "costo": row["costo"],
                "valor_sugerido": row["valor_sugerido"],
                "otros_proveedores": [other.nombre for other in candidates[1:]],
                "importaciones_abiertas": open_imports.get(row["producto_id"], []),
            })
        ordered = sorted(
            groups.values(),
            key=lambda group: (not group["es_importacion"], -sum(i["valor_sugerido"] for i in group["items"])),
        )
        for group in ordered:
            group["items"].sort(key=lambda item: ({"agotado": 0, "pedir": 1}.get(item["estado"], 2), item["codigo"]))
            group["valor_total"] = round(sum(item["valor_sugerido"] for item in group["items"]), 2)
        return Response({"meta": meta, "proveedores": ordered}, status=status.HTTP_200_OK)

    def post(self, request):
        from casa_comercial.models import CasaComercial
        from importaciones.serializers import ImportacionSerializer
        from productos.models import Producto

        if not is_app_admin(request.user):
            return Response({"detail": "Solo administradores."}, status=status.HTTP_403_FORBIDDEN)
        casa = CasaComercial.objects.filter(pk=request.data.get("casa_comercial_id")).first()
        if casa is None:
            return Response({"detail": "Elige el proveedor de la importacion."}, status=status.HTTP_400_BAD_REQUEST)
        raw_items = request.data.get("items")
        if not isinstance(raw_items, list) or not raw_items:
            return Response({"detail": "Agrega al menos un producto."}, status=status.HTTP_400_BAD_REQUEST)
        quantities = {}
        for raw in raw_items:
            try:
                pid = int(raw.get("producto_id"))
                qty = int(raw.get("cantidad"))
            except (TypeError, ValueError, AttributeError):
                return Response({"detail": "Producto o cantidad invalidos."}, status=status.HTTP_400_BAD_REQUEST)
            if qty <= 0:
                return Response({"detail": "Cada cantidad debe ser mayor a cero."}, status=status.HTTP_400_BAD_REQUEST)
            quantities[pid] = quantities.get(pid, 0) + qty
        products = {p.id: p for p in Producto.objects.filter(id__in=quantities)}
        if any(pid not in products for pid in quantities):
            return Response({"detail": "Uno de los productos ya no existe."}, status=status.HTTP_400_BAD_REQUEST)

        rows, meta = cached_replenishment()
        central_id = meta.get("sucursal_central_id")
        by_product = {row["producto_id"]: row for row in rows if row["sucursal_id"] == central_id}
        detalles = []
        for orden, pid in enumerate(quantities, start=1):
            product = products[pid]
            row = by_product.get(pid) or {}
            comment = ""
            if row:
                comment = "Reposicion: vende {:.2f}/dia, stock {}, en camino {}, sugerido {}".format(
                    float(row["venta_dia"]), row["stock"], row["en_camino"], row["sugerido"]
                )
            detalles.append({
                "producto_id": pid,
                "codigo": product.codigo,
                "nombre": product.nombre,
                "cantidad": quantities[pid],
                "comentario": comment,
                "orden": orden,
            })
        serializer = ImportacionSerializer(
            data={"casa_comercial_id": casa.id, "detalles": detalles},
            context={"request": request},
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        importacion = serializer.save()
        return Response(
            {
                "id": int(importacion.id),
                "codigo": importacion.codigo,
                "estado": importacion.estado,
                "productos": len(detalles),
                "unidades": sum(quantities.values()),
            },
            status=status.HTTP_201_CREATED,
        )


CONFIG_FIELDS = {
    "ventana_dias": (int, 30, 730),
    "nivel_servicio_a": (float, 50, 99.99),
    "nivel_servicio_b": (float, 50, 99.99),
    "nivel_servicio_c": (float, 50, 99.99),
    "corte_a": (float, 1, 99),
    "corte_b": (float, 1, 99.99),
    "revision_dias": (int, 1, 90),
    "traslado_dias": (int, 0, 60),
    "proveedor_local_dias": (int, 0, 365),
    "proveedor_importacion_dias": (int, 0, 365),
    "costo_pedido": (float, 0, 100000),
    "costo_mantener_pct": (float, 0, 200),
    "dias_obsoleto": (int, 30, 1095),
    "min_dias_venta": (int, 1, 60),
    "max_dias_pedido": (int, 7, 365),
}


def _serialize_config(config):
    from inventario.models import Sucursal

    data = {field: float(getattr(config, field)) if cast is float else int(getattr(config, field))
            for field, (cast, _low, _high) in CONFIG_FIELDS.items()}
    data["sucursal_central_id"] = _central_branch_id(config)
    data["sucursales"] = [{"id": int(s.id), "nombre": s.nombre} for s in Sucursal.objects.order_by("nombre")]
    return data


class ReposicionConfigAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not is_app_admin(request.user):
            return Response({"detail": "Solo administradores."}, status=status.HTTP_403_FORBIDDEN)
        return Response(_serialize_config(ReposicionConfiguracion.get_global()))

    def patch(self, request):
        from inventario.models import Sucursal

        if not is_app_admin(request.user):
            return Response({"detail": "Solo administradores."}, status=status.HTTP_403_FORBIDDEN)
        config = ReposicionConfiguracion.get_global()
        for field, (cast, low, high) in CONFIG_FIELDS.items():
            if field not in request.data:
                continue
            try:
                value = cast(request.data.get(field))
            except (TypeError, ValueError):
                return Response({"detail": f"Valor invalido en {field}."}, status=status.HTTP_400_BAD_REQUEST)
            if value < low or value > high:
                return Response(
                    {"detail": f"{field} debe estar entre {low} y {high}."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            setattr(config, field, value)
        if float(config.corte_a) >= float(config.corte_b):
            return Response({"detail": "El corte A debe ser menor que el corte B."}, status=status.HTTP_400_BAD_REQUEST)
        if "sucursal_central_id" in request.data:
            raw = request.data.get("sucursal_central_id")
            if raw in (None, ""):
                config.sucursal_central = None
            else:
                sucursal = Sucursal.objects.filter(pk=raw).first()
                if sucursal is None:
                    return Response({"detail": "Sucursal central invalida."}, status=status.HTTP_400_BAD_REQUEST)
                config.sucursal_central = sucursal
        config.save()
        _CACHE["key"] = None
        return Response(_serialize_config(config))
