from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("casa_comercial", "0005_casacomercial_dias_entrega"),
        ("movimientos", "0015_add_devolver_proveedora_resolucion"),
    ]

    operations = [
        migrations.AddField(
            model_name="movimientoinventario",
            name="casa_comercial",
            field=models.ForeignKey(
                blank=True,
                help_text="Proveedor asociado al movimiento (compra local o importacion).",
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="movimientos",
                to="casa_comercial.casacomercial",
            ),
        ),
    ]
