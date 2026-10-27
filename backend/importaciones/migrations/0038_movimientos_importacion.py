from decimal import Decimal

import django.db.models.deletion
from django.db import migrations, models


def crear_movimientos_importaciones_repartidas(apps, schema_editor):
    """Las importaciones ya repartidas no generaron movimientos: se crean
    ahora como registro (sin tocar stock), con la fecha del reparto. Lo
    recibido queda en Recibido; lo que sigue en camino, en Enviado."""
    Importacion = apps.get_model("importaciones", "Importacion")
    ImportacionEnvio = apps.get_model("importaciones", "ImportacionEnvio")
    Sucursal = apps.get_model("inventario", "Sucursal")
    MovimientoInventario = apps.get_model("movimientos", "MovimientoInventario")
    DetalleMovimiento = apps.get_model("movimientos", "DetalleMovimiento")
    TipoMovimiento = apps.get_model("tipos", "TipoMovimiento")
    SubTipoMovimiento = apps.get_model("tipos", "SubTipoMovimiento")
    EstadoMovimiento = apps.get_model("tipos", "EstadoMovimiento")
    EstadoProducto = apps.get_model("tipos", "EstadoProducto")

    importaciones = list(
        Importacion.objects.filter(envios__isnull=False, movimiento_entrada__isnull=True).distinct().order_by("id")
    )
    matriz = Sucursal.objects.filter(nombre__icontains="matriz").order_by("id").first()
    if not importaciones or matriz is None:
        return

    def subtipo(prefijo, nombre):
        tipo = TipoMovimiento.objects.filter(nombre__istartswith=prefijo).order_by("id").first()
        sub = SubTipoMovimiento.objects.filter(tipo_movimiento=tipo, nombre__icontains=nombre).order_by("id").first()
        return tipo, sub

    tipo_entrada, sub_importacion = subtipo("ent", "import")
    _, sub_entrada_traslado = subtipo("ent", "trasl")
    tipo_salida, sub_salida_traslado = subtipo("sal", "trasl")
    recibido = EstadoMovimiento.objects.filter(nombre__iexact="Recibido").first()
    enviado = EstadoMovimiento.objects.filter(nombre__iexact="Enviado").first()
    estado_producto = (
        EstadoProducto.objects.filter(nombre__icontains="dispon").order_by("id").first()
        or EstadoProducto.objects.order_by("id").first()
    )
    if not (sub_importacion and sub_entrada_traslado and sub_salida_traslado and recibido and enviado and estado_producto):
        return

    def documento_libre(tipo, base):
        base = str(base or "").strip()[:74]
        documento, n = base, 1
        while MovimientoInventario.objects.filter(tipo_movimiento=tipo, no_documento__iexact=documento).exists():
            n += 1
            documento = f"{base}-{n}"
        return documento

    def crear(tipo, sub, sucursal_id, objetivo_id, estado, fecha, documento, descripcion, items, valores, tipo_envio=""):
        movimiento = MovimientoInventario.objects.create(
            sucursal_id=sucursal_id,
            tipo_movimiento=tipo,
            sub_tipo_movimiento=sub,
            sucursal_objetivo_id=objetivo_id,
            descripcion=descripcion,
            estado_movimiento=estado,
            fecha=fecha,
            no_documento=documento_libre(tipo, documento),
            tipo_envio=tipo_envio,
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

    for importacion in importaciones:
        codigo = str(importacion.codigo or "").strip() or f"IMP-{importacion.id}"
        valores = {}
        for detalle in importacion.detalles.filter(producto_id__isnull=False):
            valor = detalle.precio_confirmado if detalle.precio_confirmado is not None else detalle.precio_estimado
            valores.setdefault(detalle.producto_id, valor or Decimal("0"))
        envios = list(ImportacionEnvio.objects.filter(importacion=importacion).select_related("sucursal").order_by("id"))
        items_por_envio, total = {}, {}
        for envio in envios:
            items = {}
            for detalle in envio.detalles.all():
                items[detalle.producto_id] = items.get(detalle.producto_id, 0) + int(detalle.cantidad or 0)
                total[detalle.producto_id] = total.get(detalle.producto_id, 0) + int(detalle.cantidad or 0)
            items_por_envio[envio.id] = items
        fecha = min(envio.fecha for envio in envios)

        importacion.movimiento_entrada = crear(
            tipo_entrada, sub_importacion, matriz.id, None, recibido, fecha, codigo,
            f"Entrada automatica por la importacion {codigo}", total, valores,
        )
        importacion.save(update_fields=["movimiento_entrada"])

        for envio in envios:
            if envio.sucursal_id == matriz.id:
                continue
            estado = recibido if envio.estado == "recibido" else enviado
            documento = f"{codigo} {envio.sucursal.nombre}"
            envio.movimiento_salida = crear(
                tipo_salida, sub_salida_traslado, matriz.id, envio.sucursal_id, estado, envio.fecha, documento,
                f"Salida automatica por envio de la importacion {codigo}", items_por_envio[envio.id], valores,
                tipo_envio="traslado_normal",
            )
            envio.movimiento_entrada = crear(
                tipo_entrada, sub_entrada_traslado, envio.sucursal_id, matriz.id, estado, envio.fecha, documento,
                f"Entrada automatica por envio de la importacion {codigo}", items_por_envio[envio.id], valores,
            )
            envio.save(update_fields=["movimiento_salida", "movimiento_entrada"])


class Migration(migrations.Migration):

    dependencies = [
        ("importaciones", "0037_importacion_historial_verificacion"),
        ("movimientos", "0032_solicitudtraslado_compra_local"),
        ("tipos", "0009_add_estado_devuelto"),
    ]

    operations = [
        migrations.AddField(
            model_name="importacion",
            name="movimiento_entrada",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="importacion_entrada",
                to="movimientos.movimientoinventario",
            ),
        ),
        migrations.AddField(
            model_name="importacionenvio",
            name="movimiento_salida",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="envio_importacion_salida",
                to="movimientos.movimientoinventario",
            ),
        ),
        migrations.AddField(
            model_name="importacionenvio",
            name="movimiento_entrada",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="envio_importacion_entrada",
                to="movimientos.movimientoinventario",
            ),
        ),
        migrations.RunPython(crear_movimientos_importaciones_repartidas, migrations.RunPython.noop),
    ]
