from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tipos", "0002_estadoproducto_tipopago"),
    ]

    operations = [
        migrations.CreateModel(
            name="TipoDivision",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=80, unique=True)),
                ("descripcion", models.TextField(blank=True)),
            ],
            options={
                "verbose_name": "Tipo de división",
                "verbose_name_plural": "Tipos de división",
                "ordering": ["nombre"],
            },
        ),
    ]
