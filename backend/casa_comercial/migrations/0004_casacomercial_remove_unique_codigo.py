from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("casa_comercial", "0003_casacomercial_tipo"),
    ]

    operations = [
        migrations.AlterField(
            model_name="casacomercial",
            name="codigo",
            field=models.CharField(max_length=50),
        ),
    ]
