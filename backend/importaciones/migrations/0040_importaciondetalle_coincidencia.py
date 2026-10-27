from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("importaciones", "0039_movimientos_envios_compra_recibidos"),
    ]

    operations = [
        migrations.AddField(
            model_name="importaciondetalle",
            name="coincidencia",
            field=models.CharField(blank=True, default="", max_length=20),
        ),
        migrations.AddField(
            model_name="importaciondetalle",
            name="coincidencia_codigo",
            field=models.CharField(blank=True, default="", max_length=150),
        ),
        migrations.AddField(
            model_name="importaciondetalle",
            name="coincidencia_casa",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddField(
            model_name="importaciondetalle",
            name="coincidencia_precio",
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True),
        ),
    ]
