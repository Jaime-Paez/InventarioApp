import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("importaciones", "0006_importacion_dias_reales_entrega"),
        ("solicitudes", "0017_solicitud_estado_revisionreferencia"),
    ]

    operations = [
        migrations.AddField(
            model_name="importaciondetalle",
            name="solicitud",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="importacion_detalles",
                to="solicitudes.solicitud",
            ),
        ),
    ]
