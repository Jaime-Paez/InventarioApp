from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("solicitudes", "0001_initial"),
    ]

    operations = [
        migrations.RenameField(
            model_name="cliente",
            old_name="nombre",
            new_name="nombres",
        ),
        migrations.AddField(
            model_name="cliente",
            name="apellidos",
            field=models.CharField(max_length=255, default=""),
            preserve_default=False,
        ),
    ]
