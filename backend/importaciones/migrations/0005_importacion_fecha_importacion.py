from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("importaciones", "0004_importacion_numero_factura"),
    ]

    operations = [
        migrations.AddField(
            model_name="importacion",
            name="fecha_importacion",
            field=models.DateField(blank=True, null=True),
        ),
    ]
