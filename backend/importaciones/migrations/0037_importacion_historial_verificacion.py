from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("importaciones", "0036_importaciondetalle_precio_casa"),
    ]

    operations = [
        migrations.AddField(
            model_name="importacion",
            name="historial_verificacion",
            field=models.JSONField(
                blank=True,
                default=None,
                help_text="Snapshot de la verificación al pedir confirmación: qué se pidió, qué se agregó y qué se quitó (no se pidió).",
                null=True,
            ),
        ),
    ]
