from django.db import migrations


def crear_taller_inicial(apps, schema_editor):
    """El taller que ya existe: junto a la matriz (9 de Octubre)."""
    Sucursal = apps.get_model("inventario", "Sucursal")
    Taller = apps.get_model("taller", "Taller")
    OrdenTaller = apps.get_model("taller", "OrdenTaller")
    OrdenTallerEntregaItem = apps.get_model("taller", "OrdenTallerEntregaItem")
    SubDivision = apps.get_model("inventario", "SubDivision")

    sucursal = (
        Sucursal.objects.filter(nombre__icontains="octubre").order_by("id").first()
        or Sucursal.objects.filter(nombre__icontains="matriz").order_by("id").first()
        or Sucursal.objects.order_by("id").first()
    )
    if sucursal is None:
        return
    taller = Taller.objects.filter(sucursal=sucursal).order_by("id").first()
    if taller is None:
        taller = Taller.objects.create(nombre="Taller 9 de Octubre", sucursal=sucursal)
    OrdenTaller.objects.filter(taller__isnull=True).update(taller=taller, sucursal=sucursal)

    # Entregas ya hechas: su sucursal de origen sale de la ubicacion.
    for item in OrdenTallerEntregaItem.objects.filter(sucursal__isnull=True):
        sucursal_id = None
        for parte in item.ubicaciones or []:
            sub = SubDivision.objects.filter(pk=parte.get("subdivision_id")).values_list(
                "division__bodega__sucursal_id", flat=True
            ).first()
            if sub:
                sucursal_id = sub
                break
        item.sucursal_id = sucursal_id or item.entrega.orden.sucursal_id
        item.save(update_fields=["sucursal"])


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("taller", "0005_talleres"),
        ("inventario", "0010_saldo_inicial_inventario"),
    ]

    operations = [migrations.RunPython(crear_taller_inicial, noop)]
