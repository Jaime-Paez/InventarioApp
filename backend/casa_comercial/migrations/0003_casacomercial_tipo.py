from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("casa_comercial", "0002_delete_casaproducto"),
    ]

    operations = [
        migrations.AddField(
            model_name="casacomercial",
            name="tipo",
            field=models.CharField(
                choices=[("local", "Local"), ("importacion", "Importación")],
                default="local",
                max_length=20,
            ),
        ),
    ]
