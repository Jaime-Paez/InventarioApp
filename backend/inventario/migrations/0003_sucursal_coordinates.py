from django.db import migrations, models


DEFAULT_COORDS = {
    "9 de Octubre (Matriz)": (-0.204404, -78.496283),
    "Norte": (-0.13746, -78.47712),
    "Sur": (-0.28221, -78.52053),
    "Tumbaco": (-0.1965, -78.4189),
    "Valle": (-0.3349, -78.4416),
}


def set_default_coords(apps, schema_editor):
    Sucursal = apps.get_model("inventario", "Sucursal")
    for nombre, (latitud, longitud) in DEFAULT_COORDS.items():
        Sucursal.objects.filter(nombre__iexact=nombre).update(
            latitud=latitud,
            longitud=longitud,
        )


class Migration(migrations.Migration):

    dependencies = [
        ("inventario", "0002_seed_default_sucursales"),
    ]

    operations = [
        migrations.AddField(
            model_name="sucursal",
            name="latitud",
            field=models.DecimalField(decimal_places=6, default=0, max_digits=9),
        ),
        migrations.AddField(
            model_name="sucursal",
            name="longitud",
            field=models.DecimalField(decimal_places=6, default=0, max_digits=9),
        ),
        migrations.RunPython(set_default_coords, reverse_code=migrations.RunPython.noop),
    ]
