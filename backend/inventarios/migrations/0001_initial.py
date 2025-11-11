from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("ubicaciones", "0001_initial"),
        ("productos", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="EstadoProducto",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=80, unique=True)),
                ("descripcion", models.TextField(blank=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Estado de producto",
                "verbose_name_plural": "Estados de producto",
            },
        ),
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
                        to="inventarios.estadoproducto",
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
