from django.db import migrations


def seed_referencias(apps, schema_editor):
    Producto = apps.get_model("productos", "Producto")
    ProductoReferencia = apps.get_model("productos", "ProductoReferencia")

    productos_con_referencia = Producto.objects.exclude(referencia="").exclude(referencia__isnull=True)
    nuevas = [
        ProductoReferencia(producto_id=producto.id, valor=producto.referencia.strip())
        for producto in productos_con_referencia.only("id", "referencia")
        if producto.referencia.strip()
    ]
    ProductoReferencia.objects.bulk_create(nuevas, ignore_conflicts=True)


def revertir(apps, schema_editor):
    # No borra Producto.referencia (nunca se tocó): solo vacía la tabla nueva.
    ProductoReferencia = apps.get_model("productos", "ProductoReferencia")
    ProductoReferencia.objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ("productos", "0016_productoreferencia"),
    ]

    operations = [
        migrations.RunPython(seed_referencias, revertir),
    ]
