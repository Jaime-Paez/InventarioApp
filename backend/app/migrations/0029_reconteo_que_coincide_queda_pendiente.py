"""Un reconteo que coincide con el sistema ya no queda "Revisado" solo: el
primer conteo no coincidio y pudo contarse mal otra vez, asi que queda
pendiente para que administracion lo verifique o lo mande a contar de nuevo.
Pasa a pendiente los reconteos que ya se habian guardado como coincide."""

from django.db import migrations


def reconteos_a_pendiente(apps, schema_editor):
    Item = apps.get_model("app", "InspeccionAleatoriaItem")
    Item.objects.filter(
        reconteos__gt=0,
        estado_revision="coincide",
        verificacion_estado="sin_novedad",
    ).update(estado_revision="no_coincide", verificacion_estado="pendiente")


class Migration(migrations.Migration):
    dependencies = [
        ("app", "0028_inspeccion_item_movimiento_decision"),
    ]

    operations = [
        migrations.RunPython(reconteos_a_pendiente, migrations.RunPython.noop),
    ]
