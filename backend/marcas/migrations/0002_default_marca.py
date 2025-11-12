from django.db import migrations


def create_default_brand(apps, schema_editor):
    Marca = apps.get_model("marcas", "Marca")
    Marca.objects.get_or_create(nombre="Sin marca", defaults={"descripcion": "Marca por defecto"})


def reverse_default_brand(apps, schema_editor):
    Marca = apps.get_model("marcas", "Marca")
    Marca.objects.filter(nombre="Sin marca").delete()


class Migration(migrations.Migration):
    dependencies = [
        ("marcas", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(create_default_brand, reverse_default_brand),
    ]
