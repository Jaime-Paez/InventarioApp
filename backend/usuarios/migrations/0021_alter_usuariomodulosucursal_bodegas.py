from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('usuarios', '0020_default_solicitudes_importaciones_permisos'),
    ]

    operations = [
        migrations.AlterField(
            model_name='usuariomodulosucursal',
            name='modulo',
            field=models.CharField(
                choices=[
                    ('movimientos_entradas', 'Movimientos - Entradas'),
                    ('movimientos_salidas', 'Movimientos - Salidas'),
                    ('movimientos_inconvenientes', 'Movimientos - Inconvenientes'),
                    ('productos', 'Productos'),
                    ('sucursales_bodegas', 'Sucursales - Bodegas'),
                    ('solicitudes', 'Solicitudes'),
                    ('importaciones', 'Importaciones'),
                ],
                max_length=50,
            ),
        ),
    ]
