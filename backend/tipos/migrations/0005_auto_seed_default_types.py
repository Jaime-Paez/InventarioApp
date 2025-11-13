from django.db import migrations


def create_default_types(apps, schema_editor):
    TipoPago = apps.get_model("tipos", "TipoPago")
    EstadoMovimiento = apps.get_model("tipos", "EstadoMovimiento")
    EstadoProducto = apps.get_model("tipos", "EstadoProducto")
    TipoMovimiento = apps.get_model("tipos", "TipoMovimiento")
    SubTipoMovimiento = apps.get_model("tipos", "SubTipoMovimiento")
    TipoDivision = apps.get_model("tipos", "TipoDivision")

    for nombre in [
        "Efectivo",
        "Transferencia",
        "Tarjeta de crédito",
        "Tarjeta de débito",
    ]:
        TipoPago.objects.get_or_create(nombre=nombre)

    for nombre in [
        "enviado",
        "recibido",
        "no llegó",
        "parcialmente recibido",
        "facturado",
        "proformado",
        "vendido",
    ]:
        EstadoMovimiento.objects.get_or_create(nombre=nombre)

    for nombre in [
        "enviado",
        "recibido",
        "no llegó",
        "parcialmente recibido",
    ]:
        EstadoProducto.objects.get_or_create(nombre=nombre)

    tipo_a_subtipos = {
        "salida": ["venta", "traslado", "devolucion"],
        "entrada": ["traslado", "devolucion", "compra local", "importación"],
    }

    for nombre_tipo, subtipos in tipo_a_subtipos.items():
        tipo, _ = TipoMovimiento.objects.get_or_create(nombre=nombre_tipo)
        for nombre_subtipo in subtipos:
            SubTipoMovimiento.objects.get_or_create(
                tipo_movimiento=tipo,
                nombre=nombre_subtipo,
            )

    for nombre in [
        "Estanteria",
        "repisa",
        "mueble",
    ]:
        TipoDivision.objects.get_or_create(nombre=nombre)


def remove_default_types(apps, schema_editor):
    TipoPago = apps.get_model("tipos", "TipoPago")
    EstadoMovimiento = apps.get_model("tipos", "EstadoMovimiento")
    EstadoProducto = apps.get_model("tipos", "EstadoProducto")
    TipoMovimiento = apps.get_model("tipos", "TipoMovimiento")
    SubTipoMovimiento = apps.get_model("tipos", "SubTipoMovimiento")
    TipoDivision = apps.get_model("tipos", "TipoDivision")

    TipoPago.objects.filter(
        nombre__in=[
            "Efectivo",
            "Transferencia",
            "Tarjeta de crédito",
            "Tarjeta de débito",
        ]
    ).delete()

    EstadoMovimiento.objects.filter(
        nombre__in=[
            "enviado",
            "recibido",
            "no llegó",
            "parcialmente recibido",
            "facturado",
            "proformado",
            "vendido",
        ]
    ).delete()

    EstadoProducto.objects.filter(
        nombre__in=[
            "enviado",
            "recibido",
            "no llegó",
            "parcialmente recibido",
        ]
    ).delete()

    tipo_a_subtipos = {
        "salida": ["venta", "traslado", "devolucion"],
        "entrada": ["traslado", "devolucion", "compra local", "importación"],
    }

    for nombre_tipo, subtipos in tipo_a_subtipos.items():
        try:
            tipo = TipoMovimiento.objects.get(nombre=nombre_tipo)
        except TipoMovimiento.DoesNotExist:
            continue
        SubTipoMovimiento.objects.filter(
            tipo_movimiento=tipo,
            nombre__in=subtipos,
        ).delete()
        if not tipo.subtipos.exists():
            tipo.delete()

    TipoDivision.objects.filter(
        nombre__in=[
            "Estanteria",
            "repisa",
            "mueble",
        ]
    ).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("tipos", "0004_remove_estadomovimiento_descripcion_and_more"),
    ]

    operations = [
        migrations.RunPython(create_default_types, remove_default_types),
    ]
