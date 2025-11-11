from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("ubicaciones", "0001_initial"),
        ("inventarios", "0001_initial"),
        ("productos", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="EstadoMovimiento",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=80, unique=True)),
                ("descripcion", models.TextField(blank=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Estado de movimiento",
                "verbose_name_plural": "Estados de movimiento",
            },
        ),
        migrations.CreateModel(
            name="TipoMovimiento",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=80, unique=True)),
                ("descripcion", models.TextField(blank=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Tipo de movimiento",
                "verbose_name_plural": "Tipos de movimiento",
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
            name="MovimientoInventario",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("fecha_documento", models.DateField()),
                ("numero_documento", models.CharField(max_length=80)),
                ("observaciones", models.TextField(blank=True)),
                ("creado_en", models.DateTimeField(auto_now_add=True)),
                ("actualizado_en", models.DateTimeField(auto_now=True)),
                (
                    "estado",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="movimientos",
                        to="movimientos.estadomovimiento",
                    ),
                ),
                (
                    "subdivision",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="movimientos",
                        to="ubicaciones.subdivision",
                    ),
                ),
                (
                    "tipo_movimiento",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="movimientos",
                        to="movimientos.tipomovimiento",
                    ),
                ),
                (
                    "tipo_pago",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="movimientos",
                        to="movimientos.tipopago",
                    ),
                ),
            ],
            options={
                "ordering": ["-fecha_documento", "numero_documento"],
                "verbose_name": "Movimiento de inventario",
                "verbose_name_plural": "Movimientos de inventario",
                "unique_together": {("tipo_movimiento", "numero_documento")},
            },
        ),
        migrations.CreateModel(
            name="DetalleMovimiento",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("cantidad", models.PositiveIntegerField()),
                ("notas", models.TextField(blank=True)),
                (
                    "estado_producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="movimientos",
                        to="inventarios.estadoproducto",
                    ),
                ),
                (
                    "inventario",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="movimientos",
                        to="inventarios.inventario",
                    ),
                ),
                (
                    "movimiento",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="detalles",
                        to="movimientos.movimientoinventario",
                    ),
                ),
                (
                    "producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="movimientos",
                        to="productos.producto",
                    ),
                ),
            ],
            options={
                "ordering": ["movimiento__fecha_documento", "producto__nombre"],
                "verbose_name": "Detalle de movimiento",
                "verbose_name_plural": "Detalles de movimiento",
            },
        ),
    ]
