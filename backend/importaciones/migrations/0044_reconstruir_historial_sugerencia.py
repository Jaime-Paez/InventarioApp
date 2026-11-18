"""Las importaciones que pidieron la cotizacion antes de que se guardara
`historial_sugerencia` no tenian nada que mostrar en el Historial. Se
reconstruye lo mejor posible con lo que si quedo guardado (marcado como
"reconstruido" para que el Historial lo avise):

- con historial de verificacion: todo menos lo agregado en la verificacion
  (lo "no se pidio" si estaba en la sugerencia);
- solo con historial de confirmacion (importadas antiguas): esos productos
  (no queda el PVP aprox. de la sugerencia);
- en verificacion (cotizacion): los productos actuales menos los agregados.
"""

from django.db import migrations

NOTA_AGREGADO_VERIFICACION = "Agregado en la verificación"


def _fila(codigo, nombre, referencia, oem, cantidad, precio, comentario, nuevo=False):
    return {
        "codigo": codigo or "",
        "nombre": nombre or "",
        "referencia": referencia or "",
        "oem": oem or "",
        "cantidad": cantidad,
        "precio_estimado": precio,
        "comentario": (comentario or "").replace(NOTA_AGREGADO_VERIFICACION, "").strip(" -"),
        "nuevo": nuevo,
        "reconstruido": True,
    }


def reconstruir(apps, schema_editor):
    Importacion = apps.get_model("importaciones", "Importacion")
    for imp in Importacion.objects.filter(historial_sugerencia__isnull=True).exclude(estado="borrador"):
        filas = None
        if isinstance(imp.historial_verificacion, list) and imp.historial_verificacion:
            filas = [
                _fila(
                    row.get("codigo"), row.get("nombre"), row.get("referencia"), row.get("oem"),
                    row.get("cantidad"), row.get("precio_estimado"), row.get("comentario"),
                )
                for row in imp.historial_verificacion
                if isinstance(row, dict) and row.get("estado") != "agregado"
            ]
        elif isinstance(imp.historial_confirmacion, list) and imp.historial_confirmacion:
            filas = [
                _fila(row.get("codigo"), row.get("nombre"), row.get("referencia"), "", row.get("cantidad"), None, "")
                for row in imp.historial_confirmacion
                if isinstance(row, dict)
            ]
        elif imp.estado == "cotizacion":
            filas = []
            for d in imp.detalles.select_related("producto").order_by("orden", "id"):
                if NOTA_AGREGADO_VERIFICACION in (d.comentario or ""):
                    continue
                filas.append(_fila(
                    d.producto.codigo if d.producto_id else d.codigo,
                    d.producto.nombre if d.producto_id else d.nombre,
                    d.referencia or (d.producto.referencia if d.producto_id else ""),
                    d.oem,
                    d.cantidad,
                    str(d.precio_estimado) if d.precio_estimado is not None else None,
                    d.comentario,
                    nuevo=not d.producto_id,
                ))
        if filas is not None:
            imp.historial_sugerencia = filas
            imp.save(update_fields=["historial_sugerencia"])


class Migration(migrations.Migration):
    dependencies = [
        ("importaciones", "0043_historial_sugerencia"),
    ]

    operations = [
        migrations.RunPython(reconstruir, migrations.RunPython.noop),
    ]
