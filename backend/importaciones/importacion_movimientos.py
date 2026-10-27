"""Movimientos de una importacion repartida a las sucursales.

Todo lo importado entra a la matriz (9 de Octubre): una entrada de subtipo
Importacion por todo lo repartido. Lo que va a otra sucursal sale de la
matriz como traslado: salida en la matriz y entrada en la sucursal, que pasan
a Recibido al terminar el conteo del envio. Son solo registro: el stock lo
sigue sumando la recepcion de cada envio en su POR UBICAR, asi la matriz no
muestra en su inventario lo que ya va para otra sucursal.
"""

from decimal import Decimal

from django.utils import timezone

from inventario.models import Sucursal
from movimientos.models import DetalleMovimiento, MovimientoInventario
from tipos.models import EstadoMovimiento, EstadoProducto, SubTipoMovimiento, TipoMovimiento


class MovimientosImportacionError(Exception):
    pass


def _matriz():
    return Sucursal.objects.filter(nombre__icontains="matriz").order_by("id").first()


def _subtipo(prefijo, nombre):
    tipo = TipoMovimiento.objects.filter(nombre__istartswith=prefijo).order_by("id").first()
    subtipo = (
        SubTipoMovimiento.objects.filter(tipo_movimiento=tipo, nombre__icontains=nombre).order_by("id").first()
        if tipo is not None
        else None
    )
    if subtipo is None:
        raise MovimientosImportacionError(f"No existe el subtipo {nombre} para registrar los movimientos de la importacion.")
    return tipo, subtipo


def _estado(*nombres):
    for nombre in nombres:
        estado = EstadoMovimiento.objects.filter(nombre__iexact=nombre).order_by("id").first()
        if estado is not None:
            return estado
    raise MovimientosImportacionError(f"No existe el estado de movimiento {nombres[0]}.")


def _estado_producto():
    estado = (
        EstadoProducto.objects.filter(nombre__icontains="dispon").order_by("id").first()
        or EstadoProducto.objects.order_by("id").first()
    )
    if estado is None:
        raise MovimientosImportacionError("No hay estados de producto configurados.")
    return estado


def _documento_libre(tipo, base):
    """No. Documento sin repetir para ese tipo (entrada/salida)."""
    base = str(base or "").strip()[:74]
    documento, n = base, 1
    while MovimientoInventario.objects.filter(tipo_movimiento=tipo, no_documento__iexact=documento).exists():
        n += 1
        documento = f"{base}-{n}"
    return documento


def _crear(*, tipo, subtipo, sucursal_id, objetivo_id, estado, fecha, documento, descripcion, items, valores,
           estado_producto, actor, tipo_envio=""):
    movimiento = MovimientoInventario.objects.create(
        sucursal_id=sucursal_id,
        tipo_movimiento=tipo,
        sub_tipo_movimiento=subtipo,
        sucursal_objetivo_id=objetivo_id,
        descripcion=descripcion,
        estado_movimiento=estado,
        fecha=fecha,
        no_documento=_documento_libre(tipo, documento),
        tipo_envio=tipo_envio,
        creado_por=actor,
    )
    DetalleMovimiento.objects.bulk_create(
        [
            DetalleMovimiento(
                movimiento_inventario=movimiento,
                producto_id=producto_id,
                cantidad=cantidad,
                estado_producto=estado_producto,
                valor=valores.get(producto_id, Decimal("0")),
                valor_total=valores.get(producto_id, Decimal("0")) * cantidad,
            )
            for producto_id, cantidad in items.items()
            if cantidad > 0
        ]
    )
    return movimiento


def crear_movimientos_importacion(importacion, envios, *, actor=None):
    """Entrada de importacion en la matriz por todo lo de `envios` y, por cada
    envio a otra sucursal, su salida y su entrada por traslado (Enviado)."""
    envios = [envio for envio in envios if envio.importacion_id == importacion.id]
    if not envios:
        return
    matriz = _matriz()
    if matriz is None:
        raise MovimientosImportacionError("No se encontro la sucursal matriz para registrar la importacion.")
    tipo_entrada, subtipo_importacion = _subtipo("ent", "import")
    _, subtipo_entrada_traslado = _subtipo("ent", "trasl")
    tipo_salida, subtipo_salida_traslado = _subtipo("sal", "trasl")
    recibido, enviado = _estado("Recibido"), _estado("Enviado")
    estado_producto = _estado_producto()
    fecha = timezone.localdate()
    codigo = str(importacion.codigo or "").strip() or f"IMP-{importacion.id}"

    valores = {}
    for detalle in importacion.detalles.filter(producto_id__isnull=False):
        valor = detalle.precio_confirmado if detalle.precio_confirmado is not None else detalle.precio_estimado
        valores.setdefault(int(detalle.producto_id), valor or Decimal("0"))

    items_por_envio = {}
    total = {}
    for envio in envios:
        items = {}
        for detalle in envio.detalles.all():
            pid = int(detalle.producto_id)
            items[pid] = items.get(pid, 0) + int(detalle.cantidad or 0)
            total[pid] = total.get(pid, 0) + int(detalle.cantidad or 0)
        items_por_envio[envio.id] = items

    comunes = {"valores": valores, "estado_producto": estado_producto, "actor": actor, "fecha": fecha}
    if not importacion.movimiento_entrada_id:
        importacion.movimiento_entrada = _crear(
            tipo=tipo_entrada,
            subtipo=subtipo_importacion,
            sucursal_id=matriz.id,
            objetivo_id=None,
            estado=recibido,
            documento=codigo,
            descripcion=f"Entrada automatica por la importacion {codigo}",
            items=total,
            **comunes,
        )
        importacion.save(update_fields=["movimiento_entrada"])

    for envio in envios:
        if int(envio.sucursal_id) == int(matriz.id) or envio.movimiento_salida_id:
            continue
        documento = f"{codigo} {envio.sucursal.nombre}"
        envio.movimiento_salida = _crear(
            tipo=tipo_salida,
            subtipo=subtipo_salida_traslado,
            sucursal_id=matriz.id,
            objetivo_id=envio.sucursal_id,
            estado=enviado,
            documento=documento,
            descripcion=f"Salida automatica por envio de la importacion {codigo}",
            items=items_por_envio[envio.id],
            tipo_envio=MovimientoInventario.TipoEnvio.TRASLADO_NORMAL,
            **comunes,
        )
        envio.movimiento_entrada = _crear(
            tipo=tipo_entrada,
            subtipo=subtipo_entrada_traslado,
            sucursal_id=envio.sucursal_id,
            objetivo_id=matriz.id,
            estado=enviado,
            documento=documento,
            descripcion=f"Entrada automatica por envio de la importacion {codigo}",
            items=items_por_envio[envio.id],
            **comunes,
        )
        envio.save(update_fields=["movimiento_salida", "movimiento_entrada"])


def cerrar_movimientos_envio(envio, recibido_por_producto):
    """Al terminar el envio: la entrada queda con lo que llego y ambas pasan a
    Recibido (o Parcialmente recibido si llego de menos)."""
    if not (envio.movimiento_salida_id or envio.movimiento_entrada_id):
        return
    enviado = {}
    for detalle in envio.detalles.all():
        pid = int(detalle.producto_id)
        enviado[pid] = enviado.get(pid, 0) + int(detalle.cantidad or 0)
    recibido = {pid: max(0, int(recibido_por_producto.get(pid, 0) or 0)) for pid in enviado}
    faltante = any(recibido[pid] < cantidad for pid, cantidad in enviado.items())
    estado = _estado("Parcialmente recibido", "Recibido") if faltante else _estado("Recibido")

    if envio.movimiento_entrada_id:
        for detalle in DetalleMovimiento.objects.filter(movimiento_inventario_id=envio.movimiento_entrada_id):
            cantidad = recibido.get(int(detalle.producto_id), 0)
            detalle.cantidad = cantidad
            detalle.valor_total = (detalle.valor or Decimal("0")) * cantidad
            detalle.save(update_fields=["cantidad", "valor_total"])
    MovimientoInventario.objects.filter(
        pk__in=[pk for pk in (envio.movimiento_salida_id, envio.movimiento_entrada_id) if pk]
    ).update(estado_movimiento=estado)
