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

from decimal import ROUND_HALF_UP, Decimal

from django.db.models import Case, DecimalField, F, Max, Q, Sum, Value, When
from django.db.models.functions import Coalesce
from django.utils.dateparse import parse_date

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


def _horas_registro_movimientos(movement_ids):
    """{movimiento_id: datetime} de cuando se registro cada movimiento (su
    creacion en la auditoria)."""
    from django.contrib.contenttypes.models import ContentType
    from django.db.models import Min

    from auditoria.models import RegistroAuditoria

    if not movement_ids:
        return {}
    content_type = ContentType.objects.get_for_model(MovimientoInventario)
    rows = (
        RegistroAuditoria.objects.filter(
            content_type=content_type,
            accion=RegistroAuditoria.Acciones.CREACION,
            object_id__in=[str(mov_id) for mov_id in movement_ids],
        )
        .values("object_id")
        .annotate(hora=Min("registrado_en"))
    )
    result = {}
    for row in rows:
        try:
            result[int(row["object_id"])] = row["hora"]
        except (TypeError, ValueError):
            continue
    return result


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


# Entradas que traen su propio costo (compras). Las demas entradas (traslado,
# devolucion) entran al costo promedio que ya tenia el producto.
_ENTRADAS_CON_COSTO = {"compra_local", "importacion"}

_Q4 = Decimal("0.0001")


def _money(value):
    """None = costo desconocido (se muestra como "-")."""
    if value is None:
        return None
    return str(Decimal(value).quantize(_Q4, rounding=ROUND_HALF_UP))


def _subtipo_key_nombre(nombre):
    name = _norm(nombre)
    if name.startswith("import"):
        return "importacion"
    if name.startswith("compra"):
        return "compra_local"
    return name


def _stock_actual(producto_id, sucursal_id, allowed_sucursal_ids):
    from inventario.models import Inventario

    queryset = Inventario.objects.filter(producto_id=producto_id)
    if sucursal_id:
        queryset = queryset.filter(subdivision__division__bodega__sucursal_id=sucursal_id)
    elif allowed_sucursal_ids is not None:
        queryset = queryset.filter(subdivision__division__bodega__sucursal_id__in=sorted(allowed_sucursal_ids))
    return int(queryset.aggregate(total=Sum("cantidad"))["total"] or 0)


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
    """Kardex del producto: parte del saldo inicial de la migracion
    (SaldoInicialInventario) y suma, del mas antiguo al mas reciente, las
    entradas, salidas y ajustes del sistema nuevo, con el acumulado (cantidad y
    costo) despues de cada uno. Costo promedio ponderado: las compras entran a
    su costo, las demas entradas y todas las salidas al costo promedio del
    momento; sin costo conocido se devuelve None.

    El saldo anterior (saldo inicial + todo lo de antes de fecha_desde) y los
    acumulados son los mismos con o sin filtro de tipo; el filtro de tipo solo
    oculta filas.

    allowed_sucursal_ids None = todas; si no, solo movimientos de esas
    sucursales (sucursal_id ya debe estar entre ellas)."""
    if isinstance(fecha_desde, str):
        fecha_desde = parse_date(fecha_desde)
    if isinstance(fecha_hasta, str):
        fecha_hasta = parse_date(fecha_hasta)
    # Solo movimientos del sistema nuevo: los del sistema anterior ya estan
    # dentro del saldo inicial (y no se pueden sumar: el sistema anterior no
    # guardaba los traslados enviados ni los cambios de stock).
    detalles = DetalleMovimiento.objects.filter(
        producto_id=producto_id,
        movimiento_inventario__in=_base_movements().filter(es_legado=False),
    )
    if allowed_sucursal_ids is not None:
        detalles = detalles.filter(movimiento_inventario__sucursal_id__in=sorted(allowed_sucursal_ids))
    if sucursal_id:
        detalles = detalles.filter(movimiento_inventario__sucursal_id=sucursal_id)
    if fecha_hasta:
        detalles = detalles.filter(movimiento_inventario__fecha__lte=fecha_hasta)

    grouped = (
        detalles.values("movimiento_inventario_id")
        .annotate(
            # Va primero: mas abajo "cantidad" y "valor_total" pasan a ser las
            # sumas y F() ya no veria los campos de cada linea.
            # En compras locales `valor` es el PVP; el costo real es `costo`
            # menos el descuento negociado. Sin costo (importaciones, compras
            # del sistema anterior) se usa el valor de la linea.
            costo_compra=Sum(
                Case(
                    When(
                        costo__isnull=False,
                        then=F("costo") * F("cantidad") * (Value(100) - Coalesce("descuento_porcentaje", Value(0))) / Value(100),
                    ),
                    default=F("valor_total"),
                    output_field=DecimalField(max_digits=20, decimal_places=6),
                )
            ),
            cantidad=Sum("cantidad"),
            valor_total=Sum("valor_total"),
            fecha=Max("movimiento_inventario__fecha"),
            tipo_nombre=Max("movimiento_inventario__tipo_movimiento__nombre"),
            subtipo_nombre=Max("movimiento_inventario__sub_tipo_movimiento__nombre"),
        )
        .order_by("fecha", "movimiento_inventario_id")
    )

    # Ajustes de inventario (cambios manuales de cantidad con motivo). Van
    # despues de los movimientos del mismo dia: corrigen lo que se conto.
    from inventario.models import AjusteInventario

    ajustes = AjusteInventario.objects.filter(producto_id=producto_id)
    if allowed_sucursal_ids is not None:
        ajustes = ajustes.filter(sucursal_id__in=sorted(allowed_sucursal_ids))
    if sucursal_id:
        ajustes = ajustes.filter(sucursal_id=sucursal_id)
    if fecha_hasta:
        ajustes = ajustes.filter(fecha__lte=fecha_hasta)
    # Dentro del mismo dia van por la hora en que se registraron (el
    # movimiento no guarda la hora: se toma de su registro de creacion en la
    # auditoria). Sin hora conocida quedan al inicio del dia, por id.
    grouped = list(grouped)
    horas = _horas_registro_movimientos([row["movimiento_inventario_id"] for row in grouped])
    eventos = []
    for row in grouped:
        hora = horas.get(row["movimiento_inventario_id"])
        row["registrado_en"] = hora
        eventos.append((row["fecha"], hora.timestamp() if hora else 0, 0, row["movimiento_inventario_id"], row))
    for ajuste in ajustes.values("id", "fecha", "diferencia", "created_at"):
        if ajuste["diferencia"]:
            hora = ajuste["created_at"]
            eventos.append(
                (ajuste["fecha"], hora.timestamp() if hora else 0, 1, ajuste["id"], {"ajuste_id": ajuste["id"], "registrado_en": hora, **ajuste})
            )
    eventos.sort(key=lambda item: (item[0] is None, item[0] or "", item[1], item[2], item[3]))

    # Saldo inicial: el stock con el que arranco el producto al migrar del
    # sistema anterior (sin costo: el sistema anterior no lo guardaba).
    from inventario.models import SaldoInicialInventario

    iniciales = SaldoInicialInventario.objects.filter(producto_id=producto_id)
    if allowed_sucursal_ids is not None:
        iniciales = iniciales.filter(sucursal_id__in=sorted(allowed_sucursal_ids))
    if sucursal_id:
        iniciales = iniciales.filter(sucursal_id=sucursal_id)
    saldo_inicial = int(iniciales.aggregate(total=Sum("cantidad"))["total"] or 0)

    # Costo promedio ponderado. acum_costo None = costo desconocido (unidades
    # del saldo inicial o que entraron sin costo); toman el costo de la
    # primera compra que llegue despues.
    acum_cant = saldo_inicial
    acum_costo = None if saldo_inicial > 0 else Decimal("0")
    saldo_anterior = {"cantidad": acum_cant, "costo": acum_costo}
    totales = {
        "entradas": 0,
        "salidas": 0,
        "entradas_total": Decimal("0"),
        "salidas_total": Decimal("0"),
        "ajustes": 0,
    }
    costos_incompletos = False
    visibles = []
    for _fecha, _hora, _orden, _id, row in eventos:
        es_ajuste = "ajuste_id" in row
        if es_ajuste:
            es_salida = row["diferencia"] < 0
            cantidad = abs(int(row["diferencia"]))
            valor_total = Decimal("0")
        else:
            es_salida = _norm(row["tipo_nombre"]).startswith("sal")
            cantidad = int(row["cantidad"] or 0)
            valor_total = Decimal(row["valor_total"] or 0)
        promedio = (acum_costo / acum_cant) if acum_cant > 0 and acum_costo is not None else None

        if es_salida:
            unitario = promedio
            if unitario is None:
                total = None
            elif cantidad == acum_cant:
                # Se lleva justo lo que hay: todo el costo, sin centavos sueltos.
                total = acum_costo
            else:
                total = unitario * cantidad
            acum_cant -= cantidad
            if acum_costo is not None and total is not None:
                acum_costo -= total
            if acum_cant <= 0:
                acum_costo = Decimal("0")
        else:
            costo_compra = Decimal(row.get("costo_compra") or 0)
            con_costo = (
                not es_ajuste
                and _subtipo_key_nombre(row["subtipo_nombre"]) in _ENTRADAS_CON_COSTO
                and cantidad
                and costo_compra
            )
            if con_costo:
                unitario = costo_compra / cantidad
            else:
                # Traslados, devoluciones y ajustes entran al costo promedio.
                unitario = promedio
            total = unitario * cantidad if unitario is not None else None
            anterior = acum_cant
            acum_cant += cantidad
            if unitario is None:
                acum_costo = None if acum_cant > 0 else Decimal("0")
            elif anterior <= 0 or acum_costo is None:
                # No habia stock valorado (saldo inicial sin costo o venia en
                # negativo): todo lo que queda vale al costo de esta entrada.
                acum_costo = unitario * max(acum_cant, 0)
            else:
                acum_costo += total
            if acum_cant <= 0:
                acum_costo = Decimal("0")

        if fecha_desde and row["fecha"] and row["fecha"] < fecha_desde:
            saldo_anterior = {"cantidad": acum_cant, "costo": acum_costo}
            continue
        key = "salidas" if es_salida else "entradas"
        totales[key] += cantidad
        if total is None:
            costos_incompletos = True
        else:
            totales[f"{key}_total"] += total
        if es_ajuste:
            totales["ajustes"] += row["diferencia"]
        if tipo == "ajuste" and not es_ajuste:
            continue
        if tipo in {"entrada", "salida"} and (es_ajuste or (tipo == "salida") != es_salida):
            continue
        visibles.append(
            {
                "ajuste_id": row.get("ajuste_id"),
                "movimiento_inventario_id": row.get("movimiento_inventario_id"),
                "registrado_en": row.get("registrado_en"),
                "cantidad": cantidad,
                "valor_total": valor_total,
                "costo_unitario": unitario,
                "costo_total": total,
                "acum_cantidad": acum_cant,
                "acum_costo": acum_costo,
            }
        )

    total_rows = len(visibles)
    page_size = max(1, min(int(page_size or PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX))
    total_pages = max(1, (total_rows + page_size - 1) // page_size)
    page = max(1, min(int(page or 1), total_pages))
    page_rows = visibles[(page - 1) * page_size: page * page_size]

    ids = [row["movimiento_inventario_id"] for row in page_rows if row["movimiento_inventario_id"]]
    ajuste_ids = [row["ajuste_id"] for row in page_rows if row["ajuste_id"]]
    ajustes_por_id = AjusteInventario.objects.filter(id__in=ajuste_ids).select_related("sucursal", "usuario").in_bulk()
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
        if row["ajuste_id"]:
            ajuste = ajustes_por_id.get(row["ajuste_id"])
            if not ajuste:
                continue
            usuario = ajuste.usuario
            usuario_nombre = ""
            if usuario:
                usuario_nombre = (usuario.get_full_name() or "").strip() or usuario.get_username()
            results.append(
                {
                    "movimiento_id": None,
                    "ajuste_id": ajuste.id,
                    "tipo": "ajuste",
                    "subtipo": "ajuste",
                    "subtipo_nombre": "Ajuste de inventario",
                    "fecha": ajuste.fecha.isoformat() if ajuste.fecha else None,
                    "registrado_en": row["registrado_en"].isoformat() if row["registrado_en"] else None,
                    "no_documento": "AJUSTE",
                    "estado": "",
                    "sucursal_id": ajuste.sucursal_id,
                    "sucursal": str(ajuste.sucursal) if ajuste.sucursal_id else "",
                    "origen": f"Ajuste · {ajuste.motivo}" if ajuste.motivo else "Ajuste de inventario",
                    "motivo": ajuste.motivo,
                    "usuario": usuario_nombre,
                    "cantidad_anterior": ajuste.cantidad_anterior,
                    "cantidad_nueva": ajuste.cantidad_nueva,
                    "diferencia": ajuste.diferencia,
                    "importacion": None,
                    "cantidad": row["cantidad"],
                    "valor_total": "0",
                    "costo_unitario": _money(row["costo_unitario"]),
                    "costo_total": _money(row["costo_total"]),
                    "acum_cantidad": row["acum_cantidad"],
                    "acum_costo": _money(row["acum_costo"]),
                    "es_legado": False,
                }
            )
            continue
        mov = movements.get(row["movimiento_inventario_id"])
        if not mov:
            continue
        tipo_key = _tipo_key(mov)
        subtipo = _subtipo_key(mov)
        importacion = importaciones.get(mov.id)
        results.append(
            {
                "movimiento_id": mov.id,
                "tipo": tipo_key,
                "subtipo": subtipo,
                "subtipo_nombre": getattr(mov.sub_tipo_movimiento, "nombre", "") or "",
                "fecha": mov.fecha.isoformat() if mov.fecha else None,
                "registrado_en": row["registrado_en"].isoformat() if row["registrado_en"] else None,
                "no_documento": mov.no_documento,
                "estado": getattr(mov.estado_movimiento, "nombre", "") or "",
                "sucursal_id": mov.sucursal_id,
                "sucursal": str(mov.sucursal) if mov.sucursal_id else "",
                "origen": _origen_texto(mov, tipo_key, subtipo, importacion),
                "importacion": importacion,
                "cantidad": row["cantidad"],
                "valor_total": str(row["valor_total"]),
                "costo_unitario": _money(row["costo_unitario"]),
                "costo_total": _money(row["costo_total"]),
                "acum_cantidad": row["acum_cantidad"],
                "acum_costo": _money(row["acum_costo"]),
                "es_legado": bool(mov.es_legado),
            }
        )

    return {
        "results": results,
        "count": total_rows,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "totales": {
            "entradas": totales["entradas"],
            "salidas": totales["salidas"],
            "entradas_total": _money(totales["entradas_total"]),
            "salidas_total": _money(totales["salidas_total"]),
            "ajustes": totales["ajustes"],
            "costos_incompletos": costos_incompletos,
        },
        "saldo_inicial": saldo_inicial,
        "saldo_anterior": {
            "cantidad": saldo_anterior["cantidad"],
            "costo": _money(saldo_anterior["costo"]),
        },
        "saldo_actual": {"cantidad": acum_cant, "costo": _money(acum_costo)},
        "stock_actual": _stock_actual(producto_id, sucursal_id, allowed_sucursal_ids),
    }
