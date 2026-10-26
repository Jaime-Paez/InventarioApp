from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('importaciones', '0033_envio_compra_local'),
    ]

    operations = [
        migrations.AddField(
            model_name='importacionenvio',
            name='no_documento',
            field=models.CharField(blank=True, default='', max_length=100),
        ),
    ]
