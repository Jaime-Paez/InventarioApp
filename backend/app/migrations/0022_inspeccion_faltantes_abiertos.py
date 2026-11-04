from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('app', '0021_inspeccion_automatica_config'),
    ]

    operations = [
        migrations.AddField(
            model_name='inspeccionaleatoriaitem',
            name='cantidad_faltante',
            field=models.PositiveIntegerField(db_default=0, default=0),
        ),
        migrations.AddField(
            model_name='inspeccionaleatoriaitem',
            name='faltante_recuperado',
            field=models.PositiveIntegerField(db_default=0, default=0),
        ),
        migrations.AddField(
            model_name='inspeccionaleatoriaitem',
            name='faltante_recuperaciones',
            field=models.JSONField(
                blank=True,
                db_default=models.Value([], output_field=models.JSONField()),
                default=list,
                help_text='[{cantidad, origen: inspeccion|manual, item_id, inspeccion_id, subdivision_id, ubicacion, usuario, fecha}]',
            ),
        ),
        migrations.AddField(
            model_name='inspeccionaleatoriaitem',
            name='recupera_faltantes',
            field=models.JSONField(
                blank=True,
                db_default=models.Value([], output_field=models.JSONField()),
                default=list,
            ),
        ),
    ]
