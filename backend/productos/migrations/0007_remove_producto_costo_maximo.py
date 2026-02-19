from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("productos", "0006_remove_producto_casa_comercial_and_more"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="producto",
            name="costo_maximo",
        ),
    ]
