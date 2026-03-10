from django.db import migrations


def add_devuelto_estado_movimiento(apps, schema_editor):
    EstadoMovimiento = apps.get_model("tipos", "EstadoMovimiento")
    EstadoMovimiento.objects.get_or_create(nombre="Devuelto")


def remove_devuelto_estado_movimiento(apps, schema_editor):
    EstadoMovimiento = apps.get_model("tipos", "EstadoMovimiento")
    EstadoMovimiento.objects.filter(nombre__iexact="Devuelto").delete()


class Migration(migrations.Migration):

    dependencies = [
        ("tipos", "0008_add_estado_en_camino"),
    ]

    operations = [
        migrations.RunPython(
            add_devuelto_estado_movimiento,
            remove_devuelto_estado_movimiento,
        ),
    ]

