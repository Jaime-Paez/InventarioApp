# Generated manually for the importaciones module.

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("casa_comercial", "0005_casacomercial_dias_entrega"),
        ("productos", "0011_remove_oem_descripcion"),
    ]

    operations = [
        migrations.CreateModel(
            name="Importacion",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("codigo", models.CharField(max_length=30, unique=True)),
                (
                    "estado",
                    models.CharField(
                        choices=[
                            ("en_proceso", "En proceso"),
                            ("en_camino", "En camino"),
                            ("importada", "Importada"),
                        ],
                        default="en_proceso",
                        max_length=20,
                    ),
                ),
                ("fecha", models.DateField(default=django.utils.timezone.localdate)),
                ("dias_entrega_estimados", models.PositiveSmallIntegerField(blank=True, null=True)),
                ("creado_en", models.DateTimeField(auto_now_add=True)),
                ("actualizado_en", models.DateTimeField(auto_now=True)),
                (
                    "casa_comercial",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="importaciones",
                        to="casa_comercial.casacomercial",
                    ),
                ),
                (
                    "creado_por",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="importaciones_creadas",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "verbose_name": "Importacion",
                "verbose_name_plural": "Importaciones",
                "ordering": ["-creado_en", "-id"],
            },
        ),
        migrations.CreateModel(
            name="ImportacionDetalle",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("cantidad", models.PositiveIntegerField(default=1)),
                (
                    "importacion",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="detalles",
                        to="importaciones.importacion",
                    ),
                ),
                (
                    "producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="detalles_importacion",
                        to="productos.producto",
                    ),
                ),
            ],
            options={
                "verbose_name": "Detalle de importacion",
                "verbose_name_plural": "Detalles de importacion",
                "ordering": ["id"],
                "unique_together": {("importacion", "producto")},
            },
        ),
    ]
