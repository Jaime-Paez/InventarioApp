from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("importaciones", "0005_importacion_fecha_importacion"),
    ]

    operations = [
        migrations.AddField(
            model_name="importacion",
            name="dias_reales_entrega",
            field=models.PositiveSmallIntegerField(blank=True, null=True),
        ),
    ]
