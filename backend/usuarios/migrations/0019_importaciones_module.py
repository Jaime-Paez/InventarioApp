from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('usuarios', '0018_usuariomodulosucursal_subtypes_traslado_devolucion_venta'),
    ]

    operations = [
        migrations.AlterField(
            model_name='rolpermiso',
            name='modulo',
            field=models.CharField(
                choices=[
                    ('inventario', 'Inventario'),
                    ('movimientos_entradas', 'Movimientos - Entradas'),
                    ('movimientos_salidas', 'Movimientos - Salidas'),
                    ('movimientos_inconvenientes', 'Movimientos - Inconvenientes'),
                    ('productos', 'Productos'),
                    ('sucursales_sucursales', 'Sucursales - Sucursales'),
                    ('sucursales_bodegas', 'Sucursales - Bodegas'),
                    ('proveedores_marcas', 'Proveedores - Marcas'),
                    ('proveedores_casas', 'Proveedores - Casas comerciales'),
                    ('solicitudes', 'Solicitudes'),
                    ('clientes', 'Clientes'),
                    ('importaciones', 'Importaciones'),
                    ('usuarios', 'Administrar'),
                    ('configuracion', 'Configuraciones'),
                ],
                max_length=50,
            ),
        ),
        migrations.AlterField(
            model_name='usuariomodulosucursal',
            name='modulo',
            field=models.CharField(
                choices=[
                    ('movimientos_entradas', 'Movimientos - Entradas'),
                    ('movimientos_salidas', 'Movimientos - Salidas'),
                    ('movimientos_inconvenientes', 'Movimientos - Inconvenientes'),
                    ('productos', 'Productos'),
                    ('solicitudes', 'Solicitudes'),
                    ('importaciones', 'Importaciones'),
                ],
                max_length=50,
            ),
        ),
        migrations.AddField(
            model_name='usuariomodulosucursal',
            name='puede_importar',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='usuariomodulosucursal',
            name='puede_marcar_llegada',
            field=models.BooleanField(default=False),
        ),
    ]
