from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("solicitudes", "0015_replace_chasis_with_auto_fields"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="productosolicitado",
            name="descripcion",
        ),
        migrations.RemoveField(
            model_name="solicitud",
            name="descripcion_general",
        ),
    ]
