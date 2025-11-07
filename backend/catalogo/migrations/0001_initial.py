from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Categoria",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=120, unique=True)),
                ("descripcion", models.TextField(blank=True)),
                ("activo", models.BooleanField(default=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Categoría",
                "verbose_name_plural": "Categorías",
            },
        ),
        migrations.CreateModel(
            name="Marca",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=100, unique=True)),
                ("descripcion", models.TextField(blank=True)),
                ("activo", models.BooleanField(default=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Marca",
                "verbose_name_plural": "Marcas",
            },
        ),
        migrations.CreateModel(
            name="TipoCompra",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=80, unique=True)),
                ("descripcion", models.TextField(blank=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Tipo de compra",
                "verbose_name_plural": "Tipos de compra",
            },
        ),
        migrations.CreateModel(
            name="TipoPago",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=80, unique=True)),
                ("descripcion", models.TextField(blank=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Tipo de pago",
                "verbose_name_plural": "Tipos de pago",
            },
        ),
        migrations.CreateModel(
            name="Producto",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("sku", models.CharField(max_length=50, unique=True)),
                ("nombre", models.CharField(max_length=150)),
                ("descripcion", models.TextField(blank=True)),
                ("precio_compra", models.DecimalField(decimal_places=2, max_digits=12)),
                ("precio_venta", models.DecimalField(decimal_places=2, max_digits=12)),
                ("activo", models.BooleanField(default=True)),
                ("creado_en", models.DateTimeField(auto_now_add=True)),
                ("actualizado_en", models.DateTimeField(auto_now=True)),
                (
                    "categoria",
                    models.ForeignKey(
                        on_delete=models.PROTECT,
                        related_name="productos",
                        to="catalogo.categoria",
                    ),
                ),
                (
                    "marca",
                    models.ForeignKey(
                        on_delete=models.PROTECT,
                        related_name="productos",
                        to="catalogo.marca",
                    ),
                ),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Producto",
                "verbose_name_plural": "Productos",
            },
        ),
    ]
