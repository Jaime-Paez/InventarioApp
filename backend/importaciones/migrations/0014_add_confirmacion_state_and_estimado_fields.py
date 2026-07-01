from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('importaciones', '0013_importaciondetalle_referencia'),
    ]

    operations = [
        migrations.AlterField(
            model_name='importacion',
            name='estado',
            field=models.CharField(
                choices=[
                    ('borrador', 'Borrador'),
                    ('cotizacion', 'Cotización'),
                    ('confirmacion', 'Confirmación'),
                    ('en_camino', 'En camino'),
                    ('importada', 'Importada'),
                ],
                default='borrador',
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name='importaciondetalle',
            name='precio_estimado',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True),
        ),
        migrations.AddField(
            model_name='importaciondetalle',
            name='cantidad_aproximada',
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
    ]
