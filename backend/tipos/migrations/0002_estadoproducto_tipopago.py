from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tipos", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="EstadoProducto",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=80, unique=True)),
                ("descripcion", models.TextField(blank=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Estado de producto",
                "verbose_name_plural": "Estados de producto",
            },
        ),
        migrations.CreateModel(
            name="TipoPago",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=80, unique=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Tipo de pago",
                "verbose_name_plural": "Tipos de pago",
            },
        ),
    ]
