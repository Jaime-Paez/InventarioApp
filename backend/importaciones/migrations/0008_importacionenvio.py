import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("importaciones", "0007_importaciondetalle_solicitud"),
        ("inventario", "0004_bodega_layout_fields"),
        ("productos", "0012_remove_pieza_original"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="ImportacionEnvio",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("estado", models.CharField(choices=[("pendiente", "Pendiente"), ("recibido", "Recibido")], default="pendiente", max_length=20)),
                ("fecha", models.DateField(default=django.utils.timezone.localdate)),
                ("fecha_recepcion", models.DateField(blank=True, null=True)),
                (
                    "importacion",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="envios",
                        to="importaciones.importacion",
                    ),
                ),
                (
                    "sucursal",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="importacion_envios",
                        to="inventario.sucursal",
                    ),
                ),
                (
                    "recibido_por",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="importacion_envios_recibidos",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "verbose_name": "Envío de importación",
                "verbose_name_plural": "Envíos de importación",
                "ordering": ["-fecha", "-id"],
            },
        ),
        migrations.CreateModel(
            name="ImportacionEnvioDetalle",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("cantidad", models.PositiveIntegerField(default=1)),
                (
                    "envio",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="detalles",
                        to="importaciones.importacionenvio",
                    ),
                ),
                (
                    "producto",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="importacion_envio_detalles",
                        to="productos.producto",
                    ),
                ),
            ],
            options={
                "verbose_name": "Detalle de envío de importación",
                "verbose_name_plural": "Detalles de envío de importación",
                "ordering": ["id"],
            },
        ),
    ]
