from decimal import Decimal

import django.db.models.deletion
from django.db import migrations, models


def envios_pendientes_a_traslados(apps, schema_editor):
    """Los envios de compras locales que aun no llegan pasan a ser traslados
    (salida + entrada + solicitud aprobada), como los que se crean desde ahora.
    El stock del origen ya se desconto al repartir; el destino lo suma al
    recibir el traslado. Los que ya llegaron se quedan como envios."""
    ImportacionEnvio = apps.get_model("importaciones", "ImportacionEnvio")
    MovimientoInventario = apps.get_model("movimientos", "MovimientoInventario")
    DetalleMovimiento = apps.get_model("movimientos", "DetalleMovimiento")
    SolicitudTraslado = apps.get_model("movimientos", "SolicitudTraslado")
    SolicitudTrasladoDetalle = apps.get_model("movimientos", "SolicitudTrasladoDetalle")
    TipoMovimiento = apps.get_model("tipos", "TipoMovimiento")
    SubTipoMovimiento = apps.get_model("tipos", "SubTipoMovimiento")
    EstadoMovimiento = apps.get_model("tipos", "EstadoMovimiento")
    EstadoProducto = apps.get_model("tipos", "EstadoProducto")

    envios = list(
        ImportacionEnvio.objects.filter(
            compra_local__isnull=False, estado="pendiente", llegada_confirmada_en__isnull=True
        )
        .select_related("compra_local")
        .order_by("id")
    )
    if not envios:
        return

    def subtipo(prefijo):
        tipo = TipoMovimiento.objects.filter(nombre__istartswith=prefijo).order_by("id").first()
        sub = SubTipoMovimiento.objects.filter(tipo_movimiento=tipo, nombre__icontains="trasl").order_by("id").first()
        return tipo, sub

    tipo_salida, sub_salida = subtipo("sal")
    tipo_entrada, sub_entrada = subtipo("ent")
    enviado = EstadoMovimiento.objects.filter(nombre__icontains="enviado").order_by("id").first()
    estado_producto = (
        EstadoProducto.objects.filter(nombre__icontains="dispon").order_by("id").first()
        or EstadoProducto.objects.order_by("id").first()
    )
    if not (sub_salida and sub_entrada and enviado and estado_producto):
        return

    for envio in envios:
        compra = envio.compra_local
        documento = str(envio.no_documento or "").strip()
        if not documento or SolicitudTraslado.objects.filter(no_documento__iexact=documento).exists():
            continue
        valores = {}
        for detalle in DetalleMovimiento.objects.filter(movimiento_inventario=compra):
            valores.setdefault(detalle.producto_id, detalle.valor or Decimal("0"))
        items = [(d.producto_id, int(d.cantidad or 0)) for d in envio.detalles.all() if d.cantidad]
        descripcion = f"Envio de la compra local {str(compra.no_documento or '').strip()}"

        movimientos = {}
        for clave, tipo, sub, sucursal_id, objetivo_id in (
            ("salida", tipo_salida, sub_salida, compra.sucursal_id, envio.sucursal_id),
            ("entrada", tipo_entrada, sub_entrada, envio.sucursal_id, compra.sucursal_id),
        ):
            movimiento = MovimientoInventario.objects.create(
                sucursal_id=sucursal_id,
                tipo_movimiento=tipo,
                sub_tipo_movimiento=sub,
                sucursal_objetivo_id=objetivo_id,
                descripcion=descripcion,
                estado_movimiento=enviado,
                iva_rate=compra.iva_rate,
                fecha=envio.fecha,
                no_documento=documento,
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
                    for producto_id, cantidad in items
                ]
            )
            movimientos[clave] = movimiento

        traslado = SolicitudTraslado.objects.create(
            sucursal_solicitante_id=envio.sucursal_id,
            sucursal_proveedora_id=compra.sucursal_id,
            descripcion=descripcion,
            fecha=envio.fecha,
            no_documento=documento,
            estado="aprobada",
            movimiento_salida=movimientos["salida"],
            movimiento_entrada=movimientos["entrada"],
            compra_local=compra,
        )
        SolicitudTrasladoDetalle.objects.bulk_create(
            [
                SolicitudTrasladoDetalle(
                    solicitud=traslado,
                    producto_id=producto_id,
                    cantidad=cantidad,
                    valor=valores.get(producto_id, Decimal("0")),
                )
                for producto_id, cantidad in items
            ]
        )
        envio.delete()


class Migration(migrations.Migration):

    dependencies = [
        ("movimientos", "0031_borrador_distribucion_compra"),
        ("importaciones", "0037_importacion_historial_verificacion"),
        ("tipos", "0009_add_estado_devuelto"),
    ]

    operations = [
        migrations.AddField(
            model_name="solicitudtraslado",
            name="compra_local",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="traslados_compra",
                to="movimientos.movimientoinventario",
            ),
        ),
        migrations.RunPython(envios_pendientes_a_traslados, migrations.RunPython.noop),
    ]
