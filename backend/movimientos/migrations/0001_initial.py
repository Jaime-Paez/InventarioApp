from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("tipos", "0002_estadoproducto_tipopago"),
        ("productos", "0001_initial"),
        ("inventario", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="MovimientoInventario",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("descripcion", models.TextField(blank=True)),
                ("funcional", models.BooleanField(default=True)),
                ("descuento", models.DecimalField(decimal_places=2, default=0, max_digits=10)),
                ("fecha", models.DateField()),
                ("no_documento", models.CharField(max_length=80)),
                (
                    "estado_movimiento",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="movimientos",
                        to="tipos.estadomovimiento",
                    ),
                ),
                (
                    "sucursal",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="movimientos_origen",
                        to="inventario.sucursal",
                    ),
                ),
                (
                    "sucursal_objetivo",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="movimientos_destino",
                        to="inventario.sucursal",
                    ),
                ),
                (
                    "sub_tipo_movimiento",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="movimientos",
                        to="tipos.subtipomovimiento",
                    ),
                ),
                (
                    "tipo_movimiento",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="movimientos",
                        to="tipos.tipomovimiento",
                    ),
                ),
            ],
            options={
                "ordering": ["-fecha", "no_documento"],
                "unique_together": {("tipo_movimiento", "no_documento")},
                "verbose_name": "Movimiento de inventario",
                "verbose_name_plural": "Movimientos de inventario",
            },
        ),
        migrations.CreateModel(
            name="DetalleMovimiento",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("cantidad", models.PositiveIntegerField()),
                ("valor", models.DecimalField(decimal_places=2, max_digits=10)),
                ("valor_total", models.DecimalField(decimal_places=2, max_digits=12)),
                (
                    "estado_producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="detalles_movimiento",
                        to="tipos.estadoproducto",
                    ),
                ),
                (
                    "movimiento_inventario",
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
                        related_name="detalles_movimiento",
                        to="productos.producto",
                    ),
                ),
            ],
            options={
                "verbose_name": "Detalle de movimiento",
                "verbose_name_plural": "Detalles de movimiento",
            },
        ),
        migrations.CreateModel(
            name="PagoMovimiento",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "movimiento_inventario",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="pagos",
                        to="movimientos.movimientoinventario",
                    ),
                ),
                (
                    "tipo_pago",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="pagos_movimiento",
                        to="tipos.tipopago",
                    ),
                ),
            ],
            options={
                "verbose_name": "Pago de movimiento",
                "verbose_name_plural": "Pagos de movimiento",
                "unique_together": {("movimiento_inventario", "tipo_pago")},
            },
        ),
        migrations.AddField(
            model_name="movimientoinventario",
            name="tipos_pago",
            field=models.ManyToManyField(
                blank=True,
                related_name="movimientos",
                through="movimientos.PagoMovimiento",
                to="tipos.tipopago",
            ),
        ),
    ]
