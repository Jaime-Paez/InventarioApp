from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('importaciones', '0030_resolucion_sumado_origen'),
    ]

    operations = [
        migrations.AddField(
            model_name='importacioninconveniente',
            name='borrador',
            field=models.JSONField(blank=True, db_default=models.Value({}, output_field=models.JSONField()), default=dict),
        ),
    ]
