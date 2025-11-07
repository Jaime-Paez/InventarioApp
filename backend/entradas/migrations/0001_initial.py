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
            name="Entrada",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("folio", models.CharField(max_length=50, unique=True)),
                ("tipo", models.CharField(choices=[("compra", "Compra"), ("devolucion", "Devolución")], max_length=20)),
                ("fecha", models.DateField()),
                ("observaciones", models.TextField(blank=True)),
                (
                    "responsable",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="entradas",
                        to="usuarios.usuario",
                    ),
                ),
                (
                    "sucursal",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="entradas",
                        to="sucursales.sucursal",
                    ),
                ),
                (
                    "tipo_compra",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="entradas",
                        to="catalogo.tipocompra",
                    ),
                ),
                (
                    "tipo_pago",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="entradas",
                        to="catalogo.tipopago",
                    ),
                ),
            ],
            options={
                "ordering": ["-fecha", "folio"],
                "verbose_name": "Entrada",
                "verbose_name_plural": "Entradas",
            },
        ),
        migrations.CreateModel(
            name="EntradaDetalle",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("cantidad", models.PositiveIntegerField()),
                ("costo_unitario", models.DecimalField(decimal_places=2, max_digits=12)),
                (
                    "entrada",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="detalles",
                        to="entradas.entrada",
                    ),
                ),
                (
                    "producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="entradas",
                        to="catalogo.producto",
                    ),
                ),
            ],
            options={
                "verbose_name": "Detalle de entrada",
                "verbose_name_plural": "Detalles de entrada",
                "unique_together": {("entrada", "producto")},
            },
        ),
    ]
