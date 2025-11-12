from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ("productos", "0006_remove_producto_referencia_fabricante_and_more"),
        ("tipos", "0003_tipodivision"),
    ]

    operations = [
        migrations.CreateModel(
            name="Sucursal",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=120)),
                ("direccion", models.CharField(max_length=255)),
            ],
            options={
                "verbose_name": "Sucursal",
                "verbose_name_plural": "Sucursales",
                "ordering": ["nombre"],
            },
        ),
        migrations.CreateModel(
            name="Bodega",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=120)),
                ("sucursal", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="bodegas", to="inventario.sucursal")),
            ],
            options={
                "verbose_name": "Bodega",
                "verbose_name_plural": "Bodegas",
                "ordering": ["sucursal__nombre", "nombre"],
                "unique_together": {("sucursal", "nombre")},
            },
        ),
        migrations.CreateModel(
            name="Division",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=120)),
                ("bodega", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="divisiones", to="inventario.bodega")),
                ("tipo_division", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="divisiones", to="tipos.tipodivision")),
            ],
            options={
                "verbose_name": "División",
                "verbose_name_plural": "Divisiones",
                "ordering": ["bodega__nombre", "nombre"],
                "unique_together": {("bodega", "nombre")},
            },
        ),
        migrations.CreateModel(
            name="SubDivision",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=120)),
                ("division", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="subdivisiones", to="inventario.division")),
            ],
            options={
                "verbose_name": "Subdivisión",
                "verbose_name_plural": "Subdivisiones",
                "ordering": ["division__nombre", "nombre"],
                "unique_together": {("division", "nombre")},
            },
        ),
        migrations.CreateModel(
            name="Inventario",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("cantidad", models.PositiveIntegerField(default=0)),
                ("referencia", models.CharField(blank=True, max_length=120)),
                ("producto", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="inventarios", to="productos.producto")),
                ("subdivision", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="inventarios", to="inventario.subdivision")),
            ],
            options={
                "verbose_name": "Inventario",
                "verbose_name_plural": "Inventarios",
                "ordering": ["subdivision__division__bodega__nombre", "producto__nombre"],
                "unique_together": {("subdivision", "producto", "referencia")},
            },
        ),
    ]
