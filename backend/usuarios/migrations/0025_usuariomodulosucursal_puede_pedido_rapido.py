from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("usuarios", "0024_taller_caja_por_sucursal"),
    ]

    operations = [
        migrations.AddField(
            model_name="usuariomodulosucursal",
            name="puede_pedido_rapido",
            field=models.BooleanField(default=False),
        ),
    ]
