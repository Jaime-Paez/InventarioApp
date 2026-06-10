from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('importaciones', '0003_importacion_remove_en_proceso'),
    ]

    operations = [
        migrations.AddField(
            model_name='importacion',
            name='numero_factura',
            field=models.CharField(blank=True, default='', max_length=100),
        ),
    ]
