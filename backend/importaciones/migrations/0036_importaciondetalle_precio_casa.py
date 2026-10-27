from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("importaciones", "0035_importaciondetalle_quitado"),
    ]

    operations = [
        migrations.AddField(
            model_name="importaciondetalle",
            name="precio_casa",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
    ]
