from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('app', '0023_inspeccion_cuenta_toda_la_sucursal'),
    ]

    operations = [
        migrations.AddField(
            model_name='inspeccionaleatoriadiaria',
            name='nombre',
            field=models.CharField(blank=True, db_default='', default='', max_length=120),
        ),
    ]
