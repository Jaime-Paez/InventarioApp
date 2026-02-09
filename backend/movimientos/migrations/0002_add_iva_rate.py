from decimal import Decimal

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("movimientos", "0001_initial"),
        ("configuracion", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="movimientoinventario",
            name="iva_rate",
            field=models.DecimalField(
                decimal_places=4,
                default=Decimal("0.15"),
                help_text="IVA aplicado al movimiento, expresado como decimal (ej: 0.15).",
                max_digits=5,
            ),
        ),
    ]
