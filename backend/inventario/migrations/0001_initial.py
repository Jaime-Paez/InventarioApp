from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ("catalogo", "0001_initial"),
        ("sucursales", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="Inventario",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("cantidad", models.PositiveIntegerField(default=0)),
                ("punto_reorden", models.PositiveIntegerField(default=0)),
                ("actualizado_en", models.DateTimeField(auto_now=True)),
                (
                    "producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="inventarios",
                        to="catalogo.producto",
                    ),
                ),
                (
                    "sucursal",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="inventarios",
                        to="sucursales.sucursal",
                    ),
                ),
            ],
            options={
                "ordering": ["sucursal__nombre", "producto__nombre"],
                "verbose_name": "Inventario",
                "verbose_name_plural": "Inventarios",
                "unique_together": {("sucursal", "producto")},
            },
        ),
    ]
