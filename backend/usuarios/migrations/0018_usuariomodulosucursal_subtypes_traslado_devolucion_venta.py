from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('usuarios', '0017_alter_usuariomodulosucursal_subtypes_default_false'),
    ]

    operations = [
        migrations.AddField(
            model_name='usuariomodulosucursal',
            name='puede_crear_traslado',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='usuariomodulosucursal',
            name='puede_crear_devolucion',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='usuariomodulosucursal',
            name='puede_crear_venta',
            field=models.BooleanField(default=False),
        ),
    ]
