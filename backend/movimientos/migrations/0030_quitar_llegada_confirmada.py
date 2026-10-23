from django.db import migrations


class Migration(migrations.Migration):
    """La recepcion en dos pasos (confirmar llegada + contar) quedo solo para
    los envios de importacion: los traslados ya no usan estos campos."""

    dependencies = [
        ("movimientos", "0029_llegada_confirmada"),
        ("movimientos", "0029_trasladoinconveniente_borrador"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="solicitudtraslado",
            name="llegada_confirmada_en",
        ),
        migrations.RemoveField(
            model_name="solicitudtraslado",
            name="llegada_confirmada_por",
        ),
    ]
