# Generated manually to define initial schema for solicitudes app.
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ("inventario", "0001_initial"),
        ("productos", "0006_remove_producto_casa_comercial_and_more"),
    ]

    operations = [
        migrations.CreateModel(
            name="Cliente",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=255)),
                ("correo", models.EmailField(blank=True, max_length=254)),
                ("telefono", models.CharField(blank=True, max_length=50)),
                ("direccion", models.CharField(blank=True, max_length=255)),
                ("cedula_ruc", models.CharField(blank=True, max_length=25, verbose_name="Cédula/RUC")),
            ],
            options={
                "verbose_name": "Cliente",
                "verbose_name_plural": "Clientes",
                "ordering": ["nombre"],
            },
        ),
        migrations.CreateModel(
            name="ProductoSolicitado",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=255)),
                ("descripcion", models.TextField(blank=True)),
                ("conseguido", models.BooleanField(default=False)),
                (
                    "producto",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="productos_solicitados",
                        to="productos.producto",
                    ),
                ),
            ],
            options={
                "verbose_name": "Producto solicitado",
                "verbose_name_plural": "Productos solicitados",
                "ordering": ["nombre"],
            },
        ),
        migrations.CreateModel(
            name="Solicitud",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("cantidad", models.PositiveIntegerField()),
                (
                    "tabla",
                    models.CharField(
                        choices=[("producto", "Producto"), ("producto_solicitado", "Producto solicitado")],
                        max_length=30,
                    ),
                ),
                ("fecha", models.DateField()),
                (
                    "cliente",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="solicitudes",
                        to="solicitudes.cliente",
                    ),
                ),
                (
                    "producto",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="solicitudes",
                        to="productos.producto",
                    ),
                ),
                (
                    "producto_solicitado",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="solicitudes",
                        to="solicitudes.productosolicitado",
                    ),
                ),
                (
                    "sucursal",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="solicitudes",
                        to="inventario.sucursal",
                    ),
                ),
            ],
            options={
                "verbose_name": "Solicitud",
                "verbose_name_plural": "Solicitudes",
                "ordering": ["-fecha", "id"],
            },
        ),
        migrations.CreateModel(
            name="OEMProductoSolicitado",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "oem",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="productos_solicitados",
                        to="productos.oem",
                    ),
                ),
                (
                    "producto_solicitado",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="oem_relaciones",
                        to="solicitudes.productosolicitado",
                    ),
                ),
            ],
            options={
                "verbose_name": "OEM de producto solicitado",
                "verbose_name_plural": "OEM por producto solicitado",
                "unique_together": {("producto_solicitado", "oem")},
            },
        ),
    ]
