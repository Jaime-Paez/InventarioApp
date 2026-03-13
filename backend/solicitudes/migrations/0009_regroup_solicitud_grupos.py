from django.db import migrations


def normalize_group_value(value):
    return " ".join(str(value or "").strip().lower().split())


def regroup_existing_solicitudes(apps, schema_editor):
    Solicitud = apps.get_model("solicitudes", "Solicitud")
    db_alias = schema_editor.connection.alias

    def resolve_group_code(rows):
        existing_codes = {
            str(getattr(row, "grupo_codigo", "") or "").strip()
            for row in rows
            if str(getattr(row, "grupo_codigo", "") or "").strip()
        }
        if len(existing_codes) == 1:
            return existing_codes.pop()
        first = rows[0]
        return str(getattr(first, "codigo", "") or "").strip() or f"SOL-GRP-{first.pk}"

    def flush(rows):
        if not rows:
            return
        group_code = resolve_group_code(rows)
        for row in rows:
            if str(getattr(row, "grupo_codigo", "") or "").strip() == group_code:
                continue
            row.grupo_codigo = group_code
            row.save(update_fields=["grupo_codigo"])

    current_rows = []
    current_key = None
    previous_id = None

    queryset = Solicitud.objects.using(db_alias).all().order_by("id")
    for solicitud in queryset.iterator():
        group_key = (
            str(getattr(solicitud, "fecha", "") or ""),
            int(getattr(solicitud, "sucursal_id", 0) or 0),
            int(getattr(solicitud, "cliente_id", 0) or 0),
            normalize_group_value(getattr(solicitud, "placa", "")),
            normalize_group_value(getattr(solicitud, "descripcion_general", "")),
        )
        is_contiguous = previous_id is not None and int(solicitud.pk or 0) == previous_id + 1

        if current_rows and (group_key != current_key or not is_contiguous):
            flush(current_rows)
            current_rows = []

        current_rows.append(solicitud)
        current_key = group_key
        previous_id = int(solicitud.pk or 0)

    flush(current_rows)


class Migration(migrations.Migration):

    dependencies = [
        ("solicitudes", "0008_solicitud_grupo_codigo"),
    ]

    operations = [
        migrations.RunPython(regroup_existing_solicitudes, reverse_code=migrations.RunPython.noop),
    ]
