import re
import unicodedata

from django.db import migrations, models


def normalize_sucursal_name(value):
    raw_value = str(value or "").strip()
    if not raw_value:
        return ""
    normalized = unicodedata.normalize("NFKD", raw_value)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    collapsed = re.sub(r"[^a-zA-Z0-9]+", " ", ascii_text).strip().lower()
    return re.sub(r"\s+", " ", collapsed)


def resolve_solicitud_sucursal_code(sucursal_nombre):
    normalized_name = normalize_sucursal_name(sucursal_nombre)
    if not normalized_name:
        return "SUC"

    if "norte" in normalized_name:
        return "NOR"
    if "sur" in normalized_name:
        return "SUR"
    if "octubre" in normalized_name and "9" in normalized_name:
        return "9OCT"

    tokens = re.findall(r"[a-z0-9]+", normalized_name)
    compact = "".join(tokens).upper()
    if not compact:
        return "SUC"
    if compact[0].isdigit():
        return compact[:4]
    return compact[:3]


def populate_solicitud_codes(apps, schema_editor):
    Solicitud = apps.get_model("solicitudes", "Solicitud")
    db_alias = schema_editor.connection.alias
    counters = {}

    queryset = (
        Solicitud.objects.using(db_alias)
        .select_related("sucursal")
        .order_by("fecha", "id")
    )

    for solicitud in queryset.iterator():
        prefix = resolve_solicitud_sucursal_code(getattr(getattr(solicitud, "sucursal", None), "nombre", ""))
        counters[prefix] = counters.get(prefix, 0) + 1
        solicitud.codigo = f"SOL-{prefix}-{counters[prefix]}"
        solicitud.save(update_fields=["codigo"])


def clear_solicitud_codes(apps, schema_editor):
    Solicitud = apps.get_model("solicitudes", "Solicitud")
    db_alias = schema_editor.connection.alias
    Solicitud.objects.using(db_alias).all().update(codigo=None)


class Migration(migrations.Migration):

    dependencies = [
        ("solicitudes", "0006_solicitud_placa_cliente_nullable"),
    ]

    operations = [
        migrations.AddField(
            model_name="solicitud",
            name="codigo",
            field=models.CharField(blank=True, max_length=80, null=True, unique=True),
        ),
        migrations.RunPython(populate_solicitud_codes, reverse_code=clear_solicitud_codes),
        migrations.AlterField(
            model_name="solicitud",
            name="codigo",
            field=models.CharField(blank=True, default="", max_length=80, unique=True),
        ),
    ]
