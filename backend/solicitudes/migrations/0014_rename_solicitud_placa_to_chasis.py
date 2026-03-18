from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("solicitudes", "0013_remove_productosolicitado_marca_and_more"),
    ]

    operations = [
        migrations.RenameField(
            model_name="solicitud",
            old_name="placa",
            new_name="chasis",
        ),
    ]
