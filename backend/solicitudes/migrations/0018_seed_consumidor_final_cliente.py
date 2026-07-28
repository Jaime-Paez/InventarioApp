from django.db import migrations

CONSUMIDOR_FINAL_CEDULA = "000000000"
CONSUMIDOR_FINAL_NOMBRES = "Consumidor"
CONSUMIDOR_FINAL_APELLIDOS = "Final"


def create_consumidor_final(apps, schema_editor):
    Cliente = apps.get_model("solicitudes", "Cliente")
    if Cliente.objects.filter(cedula_ruc=CONSUMIDOR_FINAL_CEDULA).exists():
        return
    Cliente.objects.create(
        nombres=CONSUMIDOR_FINAL_NOMBRES,
        apellidos=CONSUMIDOR_FINAL_APELLIDOS,
        cedula_ruc=CONSUMIDOR_FINAL_CEDULA,
    )


def remove_consumidor_final(apps, schema_editor):
    Cliente = apps.get_model("solicitudes", "Cliente")
    Cliente.objects.filter(
        cedula_ruc=CONSUMIDOR_FINAL_CEDULA,
        nombres=CONSUMIDOR_FINAL_NOMBRES,
        apellidos=CONSUMIDOR_FINAL_APELLIDOS,
    ).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("solicitudes", "0017_solicitud_estado_revisionreferencia"),
    ]

    operations = [
        migrations.RunPython(create_consumidor_final, remove_consumidor_final),
    ]
