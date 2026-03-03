from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("movimientos", "0002_add_iva_rate"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="movimientoinventario",
            options={
                "ordering": ["-fecha", "-id"],
                "verbose_name": "Movimiento de inventario",
                "verbose_name_plural": "Movimientos de inventario",
            },
        ),
    ]
