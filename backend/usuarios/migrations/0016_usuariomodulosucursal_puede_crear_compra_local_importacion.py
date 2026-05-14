from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('usuarios', '0015_alter_usuariomodulosucursal_modulo'),
    ]

    operations = [
        migrations.AddField(
            model_name='usuariomodulosucursal',
            name='puede_crear_compra_local',
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name='usuariomodulosucursal',
            name='puede_crear_importacion',
            field=models.BooleanField(default=True),
        ),
    ]
