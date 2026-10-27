# 0032_aceptacion_parcial_traslado ya esta aplicada en produccion (se subio y
# luego se revirtio el codigo), por eso se conserva su nombre y esta migracion
# une las dos 0032.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('movimientos', '0032_aceptacion_parcial_traslado'),
        ('movimientos', '0032_solicitudtraslado_compra_local'),
    ]

    operations = [
        migrations.AddField(
            model_name='solicitudtrasladodetalle',
            name='motivo_no_envio_tipo',
            field=models.CharField(blank=True, db_default='', default='', max_length=20),
        ),
        migrations.AddField(
            model_name='solicitudtrasladodetalle',
            name='conteo_no_envio',
            field=models.JSONField(blank=True, db_default=models.Value([], output_field=models.JSONField()), default=list),
        ),
    ]
