from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('importaciones', '0034_envio_no_documento'),
    ]

    operations = [
        migrations.AddField(
            model_name='importaciondetalle',
            name='quitado',
            field=models.BooleanField(default=False),
        ),
    ]
