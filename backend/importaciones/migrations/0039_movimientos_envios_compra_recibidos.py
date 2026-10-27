from decimal import Decimal

from django.db import migrations


def crear_movimientos_envios_compra(apps, schema_editor):
    """Envios de compras locales que se recibieron con el flujo anterior (no
    pasaron a traslado): se les crea su salida y su entrada como registro, sin
    tocar stock. La entrada queda con lo recibido."""
    ImportacionEnvio = apps.get_model("importaciones", "ImportacionEnvio")
    MovimientoInventario = apps.get_model("movimientos", "MovimientoInventario")
    DetalleMovimiento = apps.get_model("movimientos", "DetalleMovimiento")
    TipoMovimiento = apps.get_model("tipos", "TipoMovimiento")
    SubTipoMovimiento = apps.get_model("tipos", "SubTipoMovimiento")
    EstadoMovimiento = apps.get_model("tipos", "EstadoMovimiento")
    EstadoProducto = apps.get_model("tipos", "EstadoProducto")

    envios = list(
        ImportacionEnvio.objects.filter(
            compra_local__isnull=False, estado="recibido", movimiento_salida__isnull=True
        ).select_related("compra_local")
    )
    if not envios:
        return

    def subtipo(prefijo):
        tipo = TipoMovimiento.objects.filter(nombre__istartswith=prefijo).order_by("id").first()
        sub = SubTipoMovimiento.objects.filter(tipo_movimiento=tipo, nombre__icontains="trasl").order_by("id").first()
        return tipo, sub

    tipo_salida, sub_salida = subtipo("sal")
    tipo_entrada, sub_entrada = subtipo("ent")
    recibido = EstadoMovimiento.objects.filter(nombre__iexact="Recibido").first()
    parcial = EstadoMovimiento.objects.filter(nombre__iexact="Parcialmente recibido").first() or recibido
    estado_producto = (
        EstadoProducto.objects.filter(nombre__icontains="dispon").order_by("id").first()
        or EstadoProducto.objects.order_by("id").first()
    )
    if not (sub_salida and sub_entrada and recibido and estado_producto):
        return

    for envio in envios:
        compra = envio.compra_local
        documento = str(envio.no_documento or "").strip() or str(compra.no_documento or "").strip()
        valores = {}
        for detalle in DetalleMovimiento.objects.filter(movimiento_inventario=compra):
            valores.setdefault(detalle.producto_id, detalle.valor or Decimal("0"))
        enviado = {}
        for detalle in envio.detalles.all():
            enviado[detalle.producto_id] = enviado.get(detalle.producto_id, 0) + int(detalle.cantidad or 0)
        progreso = envio.recepcion_progreso if isinstance(envio.recepcion_progreso, dict) else {}
        llegado = {
            pid: min(cantidad, int((progreso.get(str(pid)) or {}).get("recibido", cantidad) or 0))
            for pid, cantidad in enviado.items()
        }
        estado = parcial if any(llegado[pid] < cantidad for pid, cantidad in enviado.items()) else recibido
        descripcion = f"Envio de la compra local {str(compra.no_documento or '').strip()}"

        movimientos = {}
        for clave, tipo, sub, sucursal_id, objetivo_id, items in (
            ("salida", tipo_salida, sub_salida, compra.sucursal_id, envio.sucursal_id, enviado),
            ("entrada", tipo_entrada, sub_entrada, envio.sucursal_id, compra.sucursal_id, llegado),
        ):
            no_documento, n = documento, 1
            while MovimientoInventario.objects.filter(tipo_movimiento=tipo, no_documento__iexact=no_documento).exists():
                n += 1
                no_documento = f"{documento}-{n}"
            movimiento = MovimientoInventario.objects.create(
                sucursal_id=sucursal_id,
                tipo_movimiento=tipo,
                sub_tipo_movimiento=sub,
                sucursal_objetivo_id=objetivo_id,
                descripcion=descripcion,
                estado_movimiento=estado,
                iva_rate=compra.iva_rate,
                fecha=envio.fecha,
                no_documento=no_documento,
                tipo_envio="traslado_normal" if clave == "salida" else "",
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
                ]
            )
            movimientos[clave] = movimiento
        envio.movimiento_salida = movimientos["salida"]
        envio.movimiento_entrada = movimientos["entrada"]
        envio.save(update_fields=["movimiento_salida", "movimiento_entrada"])


class Migration(migrations.Migration):

    dependencies = [
        ("importaciones", "0038_movimientos_importacion"),
    ]

    operations = [
        migrations.RunPython(crear_movimientos_envios_compra, migrations.RunPython.noop),
    ]
