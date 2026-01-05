from django.db import migrations


DEFAULT_SUCURSALES = [
    ("9 de Octubre (Matriz)", "9 de Octubre (Matriz)"),
    ("Norte", "Sucursal Norte"),
    ("Sur", "Sucursal Sur"),
    ("Tumbaco", "Sucursal Tumbaco"),
    ("Valle", "Sucursal Valle"),
]


def crear_sucursales_iniciales(apps, schema_editor):
    Sucursal = apps.get_model("inventario", "Sucursal")

    for nombre, direccion in DEFAULT_SUCURSALES:
        Sucursal.objects.get_or_create(
            nombre=nombre,
            defaults={"direccion": direccion},
        )


def eliminar_sucursales_iniciales(apps, schema_editor):
    Sucursal = apps.get_model("inventario", "Sucursal")

    Sucursal.objects.filter(nombre__in=[nombre for nombre, _ in DEFAULT_SUCURSALES]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("inventario", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(
            crear_sucursales_iniciales,
            reverse_code=eliminar_sucursales_iniciales,
        )
    ]
