import re
import unicodedata

from django.db import migrations, models

# Los que se acordaron; las demas toman las 3 primeras letras del nombre.
KNOWN_CODES = {
    "9 de octubre (matriz)": "9OCT",
    "norte": "NOR",
    "sur": "SUR",
    "tumbaco": "TUM",
    "valle": "VAL",
}


def _suggest(nombre):
    plain = unicodedata.normalize("NFD", str(nombre or "")).encode("ascii", "ignore").decode()
    letters = re.sub(r"[^A-Za-z0-9]", "", plain).upper()
    return letters[:3] or "SUC"


def fill_codes(apps, schema_editor):
    Sucursal = apps.get_model("inventario", "Sucursal")
    used = set()
    for sucursal in Sucursal.objects.order_by("id"):
        base = KNOWN_CODES.get(str(sucursal.nombre or "").strip().lower()) or _suggest(sucursal.nombre)
        code, n = base, 2
        while code in used:
            code = f"{base}{n}"
            n += 1
        used.add(code)
        Sucursal.objects.filter(pk=sucursal.pk).update(codigo=code)


class Migration(migrations.Migration):

    dependencies = [
        ('inventario', '0007_sucursal_puede_compra_local'),
    ]

    operations = [
        migrations.AddField(
            model_name='sucursal',
            name='codigo',
            field=models.CharField(blank=True, db_default='', default='', max_length=10),
        ),
        migrations.RunPython(fill_codes, migrations.RunPython.noop),
    ]
