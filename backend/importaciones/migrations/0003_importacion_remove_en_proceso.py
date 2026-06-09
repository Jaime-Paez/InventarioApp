from django.db import migrations, models


def migrate_en_proceso_to_borrador(apps, schema_editor):
    Importacion = apps.get_model("importaciones", "Importacion")
    Importacion.objects.filter(estado="en_proceso").update(estado="borrador")


class Migration(migrations.Migration):

    dependencies = [
        ("importaciones", "0002_importaciondetalle_sin_catalogo"),
    ]

    operations = [
        migrations.RunPython(migrate_en_proceso_to_borrador, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="importacion",
            name="estado",
            field=models.CharField(
                max_length=20,
                choices=[
                    ("borrador", "Borrador"),
                    ("en_camino", "En camino"),
                    ("importada", "Importada"),
                ],
                default="borrador",
            ),
        ),
    ]
