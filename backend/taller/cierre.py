"""Cierre de una orden de taller: salida tipo "Taller".

Los repuestos ya salieron del inventario cuando se despacharon, asi que esta
salida NO vuelve a descontar stock (el subtipo "Taller" no tiene efecto de
inventario en movimientos/serializers.py). Solo deja el documento: en
Salidas, en el kardex del producto y con el valor cobrado.
"""

from collections import OrderedDict
from decimal import Decimal

from django.utils import timezone
from rest_framework.exceptions import ValidationError

from movimientos.models import DetalleMovimiento, MovimientoInventario
from tipos.models import EstadoMovimiento, EstadoProducto, SubTipoMovimiento, TipoMovimiento

SUBTIPO_TALLER = "Taller"


def _tipo_salida():
    tipo = TipoMovimiento.objects.filter(nombre__istartswith="sal").order_by("id").first()
    if tipo is None:
        raise ValidationError({"detail": "No existe el tipo de movimiento Salida para registrar el cierre."})
    return tipo


def _subtipo_taller(tipo):
    subtipo = SubTipoMovimiento.objects.filter(tipo_movimiento=tipo, nombre__iexact=SUBTIPO_TALLER).order_by("id").first()
    if subtipo is None:
        subtipo = SubTipoMovimiento.objects.create(
            tipo_movimiento=tipo,
            nombre=SUBTIPO_TALLER,
            descripcion="Repuestos usados en una orden de taller.",
        )
    return subtipo


def _estado_movimiento():
    for nombre in ("Vendido", "Entregado", "Completado"):
        estado = EstadoMovimiento.objects.filter(nombre__iexact=nombre).order_by("id").first()
        if estado is not None:
            return estado
    estado = EstadoMovimiento.objects.order_by("id").first()
    if estado is None:
        raise ValidationError({"detail": "No hay estados de movimiento configurados."})
    return estado


def _estado_producto():
    estado = (
        EstadoProducto.objects.filter(nombre__icontains="nuev").order_by("id").first()
        or EstadoProducto.objects.filter(nombre__icontains="dispon").order_by("id").first()
        or EstadoProducto.objects.order_by("id").first()
    )
    if estado is None:
        raise ValidationError({"detail": "No hay estados de producto configurados."})
    return estado


def _documento_libre(tipo, base):
    candidato = base
    n = 1
    while MovimientoInventario.objects.filter(tipo_movimiento=tipo, no_documento=candidato).exists():
        n += 1
        candidato = f"{base}-{n}"
    return candidato


def crear_salidas_taller(orden, lineas, user):
    """Una salida tipo Taller por cada sucursal de la que salieron los
    repuestos usados (primero la del taller). Lista vacia si no hubo repuestos."""
    from collections import defaultdict

    from configuracion.models import ConfiguracionSistema
    from inventario.models import Sucursal

    from .stock import disponible_por_sucursal

    por_producto = OrderedDict()
    for linea in lineas:
        if linea.tipo != linea.Tipos.REPUESTO or not linea.producto_id or not linea.cantidad:
            continue
        entry = por_producto.setdefault(linea.producto_id, {"cantidad": 0, "total": Decimal("0")})
        entry["cantidad"] += int(linea.cantidad)
        entry["total"] += (linea.precio or Decimal("0")) * int(linea.cantidad)
    if not por_producto:
        return []

    # Reparte lo usado de cada repuesto entre las sucursales de las que salio.
    por_sucursal = defaultdict(list)
    for producto_id, entry in por_producto.items():
        unitario = entry["total"] / entry["cantidad"]
        disponible = disponible_por_sucursal(orden, producto_id)
        orden_sucursales = sorted(disponible, key=lambda sid: (sid != orden.sucursal_id, sid or 0))
        restante = entry["cantidad"]
        for sid in orden_sucursales:
            if restante <= 0:
                break
            parte = min(max(disponible[sid], 0), restante)
            if parte > 0:
                por_sucursal[sid].append((producto_id, parte, unitario))
                restante -= parte
        if restante > 0:
            por_sucursal[orden.sucursal_id].append((producto_id, restante, unitario))

    tipo = _tipo_salida()
    subtipo = _subtipo_taller(tipo)
    estado_mov = _estado_movimiento()
    estado_producto = _estado_producto()
    partes = [f"Orden de taller #{orden.numero:05d}"]
    if orden.taller_id:
        partes.append(orden.taller.nombre)
    if orden.tipo == orden.TiposOrden.GARANTIA:
        partes.append("garantía")
    if orden.placa:
        partes.append(f"placa {orden.placa}")
    if orden.cliente_nombre:
        partes.append(orden.cliente_nombre)
    if orden.numero_factura:
        partes.append(f"factura {orden.numero_factura}")
    try:
        iva_rate = ConfiguracionSistema.get_solo().iva_rate
    except Exception:  # pragma: no cover
        iva_rate = Decimal("0.15")

    salidas = []
    sucursales = sorted(por_sucursal, key=lambda sid: (sid != orden.sucursal_id, sid or 0))
    for indice, sucursal_id in enumerate(sucursales):
        base = f"OT-{orden.numero:05d}" if indice == 0 else f"OT-{orden.numero:05d}-{indice + 1}"
        descripcion = " · ".join(partes)
        if sucursal_id != orden.sucursal_id:
            nombre = Sucursal.objects.filter(pk=sucursal_id).values_list("nombre", flat=True).first() or ""
            descripcion += f" · repuestos despachados desde {nombre}"
        movimiento = MovimientoInventario.objects.create(
            sucursal_id=sucursal_id,
            tipo_movimiento=tipo,
            sub_tipo_movimiento=subtipo,
            estado_movimiento=estado_mov,
            descripcion=descripcion,
            fecha=timezone.localdate(),
            no_documento=_documento_libre(tipo, base),
            factura_referencia=(orden.numero_factura or "")[:80],
            iva_rate=iva_rate,
            creado_por=user,
        )
        agrupado = OrderedDict()
        for producto_id, cantidad, unitario in por_sucursal[sucursal_id]:
            fila = agrupado.setdefault(producto_id, {"cantidad": 0, "total": Decimal("0")})
            fila["cantidad"] += cantidad
            fila["total"] += unitario * cantidad
        DetalleMovimiento.objects.bulk_create(
            [
                DetalleMovimiento(
                    movimiento_inventario=movimiento,
                    producto_id=producto_id,
                    cantidad=fila["cantidad"],
                    estado_producto=estado_producto,
                    valor=(fila["total"] / fila["cantidad"]).quantize(Decimal("0.01")),
                    valor_total=fila["total"].quantize(Decimal("0.01")),
                )
                for producto_id, fila in agrupado.items()
            ]
        )
        salidas.append(movimiento)
    return salidas
