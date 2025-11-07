from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ("catalogo", "0001_initial"),
        ("sucursales", "0001_initial"),
        ("usuarios", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="Salida",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("folio", models.CharField(max_length=50, unique=True)),
                ("tipo", models.CharField(choices=[("venta", "Venta"), ("sucursal", "Traslado a sucursal")], max_length=20)),
                ("fecha", models.DateField()),
                ("observaciones", models.TextField(blank=True)),
                (
                    "responsable",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="salidas",
                        to="usuarios.usuario",
                    ),
                ),
                (
                    "sucursal_destino",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="salidas_destino",
                        to="sucursales.sucursal",
                    ),
                ),
                (
                    "sucursal_origen",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="salidas_origen",
                        to="sucursales.sucursal",
                    ),
                ),
            ],
            options={
                "ordering": ["-fecha", "folio"],
                "verbose_name": "Salida",
                "verbose_name_plural": "Salidas",
            },
        ),
        migrations.CreateModel(
            name="SalidaDetalle",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("cantidad", models.PositiveIntegerField()),
                ("precio_unitario", models.DecimalField(decimal_places=2, max_digits=12)),
                (
                    "producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="salidas",
                        to="catalogo.producto",
                    ),
                ),
                (
                    "salida",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="detalles",
                        to="salidas.salida",
                    ),
                ),
            ],
            options={
                "verbose_name": "Detalle de salida",
                "verbose_name_plural": "Detalles de salida",
                "unique_together": {("salida", "producto")},
            },
        ),
    ]
