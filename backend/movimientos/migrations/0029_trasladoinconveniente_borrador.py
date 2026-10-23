from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('movimientos', '0028_movimiento_tipo_envio'),
    ]

    operations = [
        migrations.AddField(
            model_name='trasladoinconveniente',
            name='borrador',
            field=models.JSONField(blank=True, db_default=models.Value({}, output_field=models.JSONField()), default=dict),
        ),
    ]
