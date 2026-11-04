from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('app', '0022_inspeccion_faltantes_abiertos'),
    ]

    operations = [
        migrations.AddField(
            model_name='inspeccionaleatoriadiaria',
            name='cuenta_toda_la_sucursal',
            field=models.BooleanField(db_default=False, default=False),
        ),
    ]
