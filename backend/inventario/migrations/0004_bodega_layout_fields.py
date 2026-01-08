from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("inventario", "0003_sucursal_coordinates"),
    ]

    operations = [
        migrations.AddField(
            model_name="bodega",
            name="alto_metros",
            field=models.DecimalField(decimal_places=2, default=0, max_digits=8),
        ),
        migrations.AddField(
            model_name="bodega",
            name="ancho_metros",
            field=models.DecimalField(decimal_places=2, default=0, max_digits=8),
        ),
        migrations.AddField(
            model_name="bodega",
            name="ubicaciones",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
