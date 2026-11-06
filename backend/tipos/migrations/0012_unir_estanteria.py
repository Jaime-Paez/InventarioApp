import unicodedata

from django.db import migrations

NOMBRE_FINAL = "Estantería"


def _clave(texto):
    raw = unicodedata.normalize("NFD", str(texto or ""))
    return "".join(ch for ch in raw if unicodedata.category(ch) != "Mn").strip().lower()


def unir(apps, schema_editor):
    """'Estanteria' y 'Estantería' eran el mismo tipo: queda uno solo
    ('Estantería'), con todas las divisiones, y los planos de las bodegas
    pasan a usar ese nombre."""
    TipoDivision = apps.get_model("tipos", "TipoDivision")
    Division = apps.get_model("inventario", "Division")
    Bodega = apps.get_model("inventario", "Bodega")

    tipos = [t for t in TipoDivision.objects.all() if _clave(t.nombre) == "estanteria"]
    if not tipos:
        return
    # Se queda el mas usado (conserva su color); los demas pasan a el.
    tipos.sort(key=lambda t: Division.objects.filter(tipo_division_id=t.id).count(), reverse=True)
    principal, otros = tipos[0], tipos[1:]
    nombres_viejos = {t.nombre for t in tipos}
    for otro in otros:
        Division.objects.filter(tipo_division_id=otro.id).update(tipo_division_id=principal.id)
        otro.delete()
    if principal.nombre != NOMBRE_FINAL:
        principal.nombre = NOMBRE_FINAL
        principal.save(update_fields=["nombre"])

    for bodega in Bodega.objects.exclude(ubicaciones=[]):
        ubicaciones = bodega.ubicaciones or []
        cambio = False
        for ubicacion in ubicaciones:
            if isinstance(ubicacion, dict) and ubicacion.get("tipo") in nombres_viejos and ubicacion.get("tipo") != NOMBRE_FINAL:
                ubicacion["tipo"] = NOMBRE_FINAL
                cambio = True
        if cambio:
            bodega.ubicaciones = ubicaciones
            bodega.save(update_fields=["ubicaciones"])


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("tipos", "0011_tipos_division_iniciales"),
        ("inventario", "0010_saldo_inicial_inventario"),
    ]

    operations = [migrations.RunPython(unir, noop)]
