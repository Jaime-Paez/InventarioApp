from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('importaciones', '0044_reconstruir_historial_sugerencia'),
    ]

    operations = [
        migrations.AlterField(
            model_name='importacioninconveniente',
            name='resolucion',
            field=models.CharField(blank=True, choices=[('reportado_proveedor', 'Reportado al proveedor'), ('aceptado', 'Aceptado sin cambios'), ('perdido', 'Perdido / no recuperable'), ('devolver_proveedor', 'Devuelto al proveedor'), ('reposicion_acordada', 'Reposición acordada'), ('sumado_sucursal', 'Sumado a la sucursal destino'), ('sumado_origen', 'Sumado a la sucursal de origen (matriz)'), ('cantidad_corregida', 'Cantidad corregida')], default='', max_length=30),
        ),
    ]
