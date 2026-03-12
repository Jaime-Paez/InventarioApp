from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("solicitudes", "0005_alter_cliente_options_productosolicitado_codigo_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="solicitud",
            name="placa",
            field=models.CharField(blank=True, default="", max_length=20),
        ),
        migrations.AlterField(
            model_name="solicitud",
            name="cliente",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.PROTECT,
                related_name="solicitudes",
                to="solicitudes.cliente",
            ),
        ),
    ]
