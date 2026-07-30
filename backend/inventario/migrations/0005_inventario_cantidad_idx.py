# Índice para acelerar los filtros por rango de cantidad (cantidad_min/cantidad_max)
# usados en la pantalla de inventario. Sin este índice, cualquier filtro de
# cantidad obliga a recorrer toda la tabla inventario_inventario.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('inventario', '0004_bodega_layout_fields'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='inventario',
            index=models.Index(fields=['cantidad'], name='inventario_cantidad_idx'),
        ),
    ]
