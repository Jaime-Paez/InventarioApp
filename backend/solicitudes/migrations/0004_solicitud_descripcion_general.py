from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("solicitudes", "0003_create_auto"),
    ]

    operations = [
        migrations.AddField(
            model_name="solicitud",
            name="descripcion_general",
            field=models.TextField(blank=True),
        ),
    ]
