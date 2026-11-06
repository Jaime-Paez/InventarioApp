from django.db import migrations

CATEGORIAS = [
    "Movilización",
    "Alimentación",
    "Suministros de oficina",
    "Limpieza",
    "Mensajería",
    "Compras urgentes",
    "Mantenimiento menor",
    "Otros",
]


def crear(apps, schema_editor):
    CategoriaGasto = apps.get_model("caja_chica", "CategoriaGasto")
    for nombre in CATEGORIAS:
        CategoriaGasto.objects.get_or_create(nombre=nombre)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [("caja_chica", "0001_initial")]

    operations = [migrations.RunPython(crear, noop)]
