from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("importaciones", "0040_importaciondetalle_coincidencia"),
    ]

    operations = [
        migrations.AddField(
            model_name="importaciondetalle",
            name="oem_quitado",
            field=models.BooleanField(default=False),
        ),
    ]
