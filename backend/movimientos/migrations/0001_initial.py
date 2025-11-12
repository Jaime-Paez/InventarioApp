from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("tipos", "0001_initial"),
        ("ubicaciones", "0001_initial"),
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
                        to="ubicaciones.sucursal",
                    ),
                ),
                (
                    "sucursal_objetivo",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="movimientos_destino",
                        to="ubicaciones.sucursal",
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
    ]
