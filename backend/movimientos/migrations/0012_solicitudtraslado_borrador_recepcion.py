from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("movimientos", "0011_solicitudtraslado_urgente"),
    ]

    operations = [
        migrations.AddField(
            model_name="solicitudtraslado",
            name="borrador_recepcion",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
