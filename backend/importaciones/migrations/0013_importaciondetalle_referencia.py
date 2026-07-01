from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("importaciones", "0012_importaciondetalle_comentario"),
    ]

    operations = [
        migrations.AddField(
            model_name="importaciondetalle",
            name="referencia",
            field=models.CharField(blank=True, default="", max_length=500),
        ),
    ]
