from django.db import migrations, models

TIPO = {"division": "D", "lista": "L", "aleatoria": "A"}


def fill_codes(apps, schema_editor):
    """REV-{sucursal}-{tipo}{n} para las revisiones que ya existian, numeradas
    por fecha dentro de cada sucursal y tipo."""
    Inspeccion = apps.get_model("app", "InspeccionAleatoriaDiaria")
    Sucursal = apps.get_model("inventario", "Sucursal")
    codes = {row["id"]: (row["codigo"] or "").strip().upper() for row in Sucursal.objects.values("id", "codigo")}
    counters = {}
    rows = Inspeccion.objects.filter(codigo="").select_related("division__bodega").order_by("created_at", "id")
    for inspection in rows.iterator():
        sucursal_id = inspection.sucursal_id
        if not sucursal_id and inspection.division_id and inspection.division is not None:
            sucursal_id = inspection.division.bodega.sucursal_id if inspection.division.bodega_id else None
        sucursal_code = (codes.get(sucursal_id) or f"S{sucursal_id}") if sucursal_id else "GEN"
        tipo = "division" if inspection.es_por_division else "lista" if inspection.es_por_lista else "aleatoria"
        prefix = f"REV-{sucursal_code}-{TIPO[tipo]}"
        counters[prefix] = counters.get(prefix, 0) + 1
        Inspeccion.objects.filter(pk=inspection.pk).update(codigo=f"{prefix}{counters[prefix]}")


class Migration(migrations.Migration):

    dependencies = [
        ('app', '0024_inspeccion_nombre'),
        ('inventario', '0008_sucursal_codigo'),
    ]

    operations = [
        migrations.AddField(
            model_name='inspeccionaleatoriadiaria',
            name='codigo',
            field=models.CharField(blank=True, db_default='', db_index=True, default='', max_length=40),
        ),
        migrations.RunPython(fill_codes, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name='inspeccionaleatoriadiaria',
            constraint=models.UniqueConstraint(
                condition=models.Q(('codigo', ''), _negated=True),
                fields=('codigo',),
                name='unique_insp_aleatoria_codigo',
            ),
        ),
    ]
