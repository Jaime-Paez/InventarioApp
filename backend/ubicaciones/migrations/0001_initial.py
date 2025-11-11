from django.db import migrations, models
import django.db.models.deletion


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
                ("ciudad", models.CharField(blank=True, max_length=120)),
                ("telefono", models.CharField(blank=True, max_length=30)),
                ("notas", models.TextField(blank=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Sucursal",
                "verbose_name_plural": "Sucursales",
            },
        ),
        migrations.CreateModel(
            name="Bodega",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=120)),
                ("descripcion", models.TextField(blank=True)),
                (
                    "sucursal",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="bodegas",
                        to="ubicaciones.sucursal",
                    ),
                ),
            ],
            options={
                "ordering": ["sucursal__nombre", "nombre"],
                "verbose_name": "Bodega",
                "verbose_name_plural": "Bodegas",
                "unique_together": {("sucursal", "nombre")},
            },
        ),
        migrations.CreateModel(
            name="TipoDivision",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=80, unique=True)),
                ("descripcion", models.TextField(blank=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Tipo de división",
                "verbose_name_plural": "Tipos de división",
            },
        ),
        migrations.CreateModel(
            name="Division",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=120)),
                ("descripcion", models.TextField(blank=True)),
                (
                    "bodega",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="divisiones",
                        to="ubicaciones.bodega",
                    ),
                ),
                (
                    "tipo_division",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="divisiones",
                        to="ubicaciones.tipodivision",
                    ),
                ),
            ],
            options={
                "ordering": ["bodega__nombre", "nombre"],
                "verbose_name": "División",
                "verbose_name_plural": "Divisiones",
                "unique_together": {("bodega", "nombre")},
            },
        ),
        migrations.CreateModel(
            name="SubDivision",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=120)),
                ("descripcion", models.TextField(blank=True)),
                (
                    "division",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="subdivisiones",
                        to="ubicaciones.division",
                    ),
                ),
            ],
            options={
                "ordering": ["division__nombre", "nombre"],
                "verbose_name": "Subdivisión",
                "verbose_name_plural": "Subdivisiones",
                "unique_together": {("division", "nombre")},
            },
        ),
    ]
