from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("inventario", "0010_saldo_inicial_inventario"),
        ("productos", "0018_producto_activo"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="BorradorUbicacionPorUbicar",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("envio_id", models.PositiveIntegerField(blank=True, db_index=True, null=True)),
                ("ubicaciones", models.JSONField(blank=True, default=list)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("actualizado_por", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="+", to=settings.AUTH_USER_MODEL)),
                ("producto", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="borradores_por_ubicar", to="productos.producto")),
                ("sucursal", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="borradores_por_ubicar", to="inventario.sucursal")),
            ],
            options={
                "verbose_name": "Borrador de ubicacion (Por ubicar)",
                "verbose_name_plural": "Borradores de ubicacion (Por ubicar)",
                "indexes": [models.Index(fields=["sucursal", "producto"], name="inventario__sucursa_bpu_idx")],
            },
        ),
    ]
