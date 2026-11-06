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


def crear_salida_taller(orden, lineas, user):
    """Crea la salida con los repuestos de la orden. None si no hubo repuestos."""
    from configuracion.models import ConfiguracionSistema

    por_producto = OrderedDict()
    for linea in lineas:
        if linea.tipo != linea.Tipos.REPUESTO or not linea.producto_id or not linea.cantidad:
            continue
        entry = por_producto.setdefault(
            linea.producto_id, {"producto": linea.producto, "cantidad": 0, "total": Decimal("0")}
        )
        entry["cantidad"] += int(linea.cantidad)
        entry["total"] += (linea.precio or Decimal("0")) * int(linea.cantidad)
    if not por_producto:
        return None

    tipo = _tipo_salida()
    subtipo = _subtipo_taller(tipo)
    estado_producto = _estado_producto()
    partes = [f"Orden de taller #{orden.numero:05d}"]
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

    movimiento = MovimientoInventario.objects.create(
        sucursal_id=orden.sucursal_id,
        tipo_movimiento=tipo,
        sub_tipo_movimiento=subtipo,
        estado_movimiento=_estado_movimiento(),
        descripcion=" · ".join(partes),
        fecha=timezone.localdate(),
        no_documento=_documento_libre(tipo, f"OT-{orden.numero:05d}"),
        factura_referencia=(orden.numero_factura or "")[:80],
        iva_rate=iva_rate,
        creado_por=user,
    )
    DetalleMovimiento.objects.bulk_create(
        [
            DetalleMovimiento(
                movimiento_inventario=movimiento,
                producto_id=producto_id,
                cantidad=entry["cantidad"],
                estado_producto=estado_producto,
                valor=(entry["total"] / entry["cantidad"]).quantize(Decimal("0.01")),
                valor_total=entry["total"].quantize(Decimal("0.01")),
            )
            for producto_id, entry in por_producto.items()
        ]
    )
    return movimiento
