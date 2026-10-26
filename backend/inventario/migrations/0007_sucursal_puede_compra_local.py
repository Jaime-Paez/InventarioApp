from django.db import migrations, models
from django.db.models import Q


def habilitar_compra_local(apps, schema_editor):
    # Por ahora solo Tumbaco y 9 de Octubre (Matriz) hacen compras locales.
    Sucursal = apps.get_model("inventario", "Sucursal")
    Sucursal.objects.filter(
        Q(nombre__icontains="tumbaco") | Q(nombre__icontains="octubre")
    ).update(puede_compra_local=True)


class Migration(migrations.Migration):

    dependencies = [
        ("inventario", "0006_producto_ubicacion_orden"),
    ]

    operations = [
        migrations.AddField(
            model_name="sucursal",
            name="puede_compra_local",
            field=models.BooleanField(default=False),
        ),
        migrations.RunPython(habilitar_compra_local, migrations.RunPython.noop),
    ]
