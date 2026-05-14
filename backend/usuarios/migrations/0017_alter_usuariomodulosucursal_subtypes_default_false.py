from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('usuarios', '0016_usuariomodulosucursal_puede_crear_compra_local_importacion'),
    ]

    operations = [
        migrations.AlterField(
            model_name='usuariomodulosucursal',
            name='puede_crear_compra_local',
            field=models.BooleanField(default=False),
        ),
        migrations.AlterField(
            model_name='usuariomodulosucursal',
            name='puede_crear_importacion',
            field=models.BooleanField(default=False),
        ),
    ]
