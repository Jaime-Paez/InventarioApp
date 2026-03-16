from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('app', '0005_inspeccionaleatoriaconfiguracion'),
        ('inventario', '0004_bodega_layout_fields'),
    ]

    operations = [
        migrations.AddField(
            model_name='inspeccionaleatoriadiaria',
            name='sucursal',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='inspecciones_aleatorias_diarias',
                to='inventario.sucursal',
            ),
        ),
        migrations.AlterUniqueTogether(
            name='inspeccionaleatoriadiaria',
            unique_together=set(),
        ),
        migrations.AddConstraint(
            model_name='inspeccionaleatoriadiaria',
            constraint=models.UniqueConstraint(
                condition=models.Q(sucursal__isnull=True),
                fields=['usuario', 'fecha_programada'],
                name='unique_insp_aleatoria_usuario_fecha',
            ),
        ),
        migrations.AddConstraint(
            model_name='inspeccionaleatoriadiaria',
            constraint=models.UniqueConstraint(
                condition=models.Q(sucursal__isnull=False),
                fields=['usuario', 'sucursal', 'fecha_programada'],
                name='unique_insp_aleatoria_usuario_sucursal_fecha',
            ),
        ),
    ]
