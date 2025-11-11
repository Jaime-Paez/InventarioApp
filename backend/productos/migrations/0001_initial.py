from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Pais",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("codigo_tais", models.CharField(max_length=10, unique=True)),
                ("nombre", models.CharField(max_length=120)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "País",
                "verbose_name_plural": "Países",
            },
        ),
        migrations.CreateModel(
            name="CasaCompra",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=150)),
                ("codigo", models.CharField(max_length=50, unique=True)),
                ("descripcion", models.TextField(blank=True)),
                ("telefono", models.CharField(blank=True, max_length=30)),
                ("correo", models.EmailField(blank=True, max_length=254)),
                (
                    "pais",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="casas_compra",
                        to="productos.pais",
                    ),
                ),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Casa de compra",
                "verbose_name_plural": "Casas de compra",
            },
        ),
        migrations.CreateModel(
            name="CasaProducto",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=150)),
                ("codigo", models.CharField(max_length=50, unique=True)),
                ("descripcion", models.TextField(blank=True)),
                (
                    "pais",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="casas_producto",
                        to="productos.pais",
                    ),
                ),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Casa de producto",
                "verbose_name_plural": "Casas de producto",
            },
        ),
        migrations.CreateModel(
            name="Producto",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("codigo", models.CharField(max_length=80, unique=True)),
                ("nombre", models.CharField(max_length=200)),
                ("descripcion", models.TextField(blank=True)),
                ("pieza_original", models.BooleanField(default=False)),
                ("referencia_fabricante", models.CharField(blank=True, max_length=120)),
                ("creado_en", models.DateTimeField(auto_now_add=True)),
                ("actualizado_en", models.DateTimeField(auto_now=True)),
                (
                    "casa_compra",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="productos",
                        to="productos.casacompra",
                    ),
                ),
                (
                    "casa_producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="productos",
                        to="productos.casaproducto",
                    ),
                ),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Producto",
                "verbose_name_plural": "Productos",
            },
        ),
        migrations.CreateModel(
            name="ProductoAlterno",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("notas", models.TextField(blank=True)),
                (
                    "alterno",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="alternativas_para",
                        to="productos.producto",
                    ),
                ),
                (
                    "producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="alternativas",
                        to="productos.producto",
                    ),
                ),
            ],
            options={
                "verbose_name": "Producto alterno",
                "verbose_name_plural": "Productos alternos",
                "unique_together": {("producto", "alterno")},
            },
        ),
        migrations.CreateModel(
            name="ProductoOEM",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("codigo", models.CharField(max_length=80)),
                ("descripcion", models.TextField(blank=True)),
                (
                    "producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="codigos_oem",
                        to="productos.producto",
                    ),
                ),
            ],
            options={
                "ordering": ["codigo"],
                "verbose_name": "Código OEM",
                "verbose_name_plural": "Códigos OEM",
                "unique_together": {("producto", "codigo")},
            },
        ),
        migrations.CreateModel(
            name="ProductoReferencia",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("codigo", models.CharField(max_length=80)),
                ("descripcion", models.TextField(blank=True)),
                (
                    "producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="referencias",
                        to="productos.producto",
                    ),
                ),
            ],
            options={
                "ordering": ["codigo"],
                "verbose_name": "Referencia de producto",
                "verbose_name_plural": "Referencias de producto",
                "unique_together": {("producto", "codigo")},
            },
        ),
    ]
