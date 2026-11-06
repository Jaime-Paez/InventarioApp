from django.db import migrations

# Los tipos que el plano traia fijos: ahora viven en el catalogo (Bodegas ->
# Tipos de ubicacion) con su color, y los de referencia marcados como visuales.
TIPOS = [
    ("Estantería", "#4f8df8", False),
    ("Cajonera", "#f59e0b", False),
    ("Muebles", "#10b981", False),
    ("Puerta", "#a16207", True),
    ("Pasillo", "#cbd5e1", True),
    ("Columna", "#64748b", True),
    ("Pared", "#475569", True),
    ("Escritorio", "#a8a29e", True),
]


def cargar(apps, schema_editor):
    TipoDivision = apps.get_model("tipos", "TipoDivision")
    for nombre, color, referencia in TIPOS:
        tipo = TipoDivision.objects.filter(nombre__iexact=nombre).first()
        if tipo is None:
            TipoDivision.objects.create(nombre=nombre, color=color, es_referencia=referencia)
            continue
        cambios = []
        if not tipo.color:
            tipo.color = color
            cambios.append("color")
        if referencia and not tipo.es_referencia:
            tipo.es_referencia = True
            cambios.append("es_referencia")
        if cambios:
            tipo.save(update_fields=cambios)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [("tipos", "0010_color_y_referencia_en_tipo_division")]

    operations = [migrations.RunPython(cargar, noop)]
