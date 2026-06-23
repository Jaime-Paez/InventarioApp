from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("importaciones", "0008_importacionenvio"),
    ]

    operations = [
        migrations.AlterField(
            model_name="importacion",
            name="estado",
            field=models.CharField(
                choices=[
                    ("borrador", "Borrador"),
                    ("cotizacion", "Cotización"),
                    ("en_camino", "En camino"),
                    ("importada", "Importada"),
                ],
                default="borrador",
                max_length=20,
            ),
        ),
    ]
