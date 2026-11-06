from django.db import migrations


def crear_cajas(apps, schema_editor):
    """Cada sucursal existente recibe su caja chica (sin fondo hasta configurarla)."""
    Sucursal = apps.get_model("inventario", "Sucursal")
    Caja = apps.get_model("caja_chica", "Caja")
    con_caja = set(Caja.objects.values_list("sucursal_id", flat=True))
    for sucursal in Sucursal.objects.exclude(id__in=con_caja):
        Caja.objects.create(sucursal=sucursal, nombre=f"Caja chica {sucursal.nombre}")


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [("caja_chica", "0004_fondo_por_defecto")]

    operations = [migrations.RunPython(crear_cajas, noop)]
