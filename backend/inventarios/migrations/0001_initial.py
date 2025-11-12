from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("tipos", "0002_estadoproducto_tipopago"),
        ("ubicaciones", "0001_initial"),
        ("productos", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="Inventario",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("referencia", models.CharField(blank=True, max_length=120)),
                ("cantidad", models.PositiveIntegerField(default=0)),
                ("cantidad_reservada", models.PositiveIntegerField(default=0)),
                ("actualizado_en", models.DateTimeField(auto_now=True)),
                (
                    "estado_producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="inventarios",
                        to="tipos.estadoproducto",
                    ),
                ),
                (
                    "producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="inventarios",
                        to="productos.producto",
                    ),
                ),
                (
                    "subdivision",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="inventarios",
                        to="ubicaciones.subdivision",
                    ),
                ),
            ],
            options={
                "ordering": ["subdivision__division__bodega__nombre", "producto__nombre"],
                "verbose_name": "Inventario",
                "verbose_name_plural": "Inventarios",
                "unique_together": {("subdivision", "producto", "estado_producto", "referencia")},
            },
        ),
    ]
