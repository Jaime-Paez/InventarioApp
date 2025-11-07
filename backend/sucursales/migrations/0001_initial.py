from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Sucursal",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("codigo", models.CharField(max_length=30, unique=True)),
                ("nombre", models.CharField(max_length=120)),
                ("direccion", models.CharField(max_length=255)),
                ("ciudad", models.CharField(max_length=120)),
                ("telefono", models.CharField(blank=True, max_length=30)),
                ("es_principal", models.BooleanField(default=False)),
                ("activo", models.BooleanField(default=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Sucursal",
                "verbose_name_plural": "Sucursales",
            },
        ),
    ]
