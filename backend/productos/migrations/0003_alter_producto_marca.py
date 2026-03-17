from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("productos", "0002_oem_remove_producto_casa_compra_and_more"),
    ]

    operations = [
        migrations.RunPython(migrations.RunPython.noop, migrations.RunPython.noop),
    ]
