# Índices para acelerar las búsquedas por texto (icontains) y el ordenamiento
# usados por la tabla de inventario. Django traduce "icontains" en Postgres como
# UPPER(campo) LIKE UPPER(patron) (no usa ILIKE), así que el índice GIN trigram
# tiene que construirse sobre UPPER(campo) para que el planner lo use; un GIN
# trigram sobre la columna cruda no calza con esa expresión y se ignora.
from django.contrib.postgres.indexes import GinIndex, OpClass
from django.contrib.postgres.operations import TrigramExtension
from django.db import migrations, models
from django.db.models.functions import Upper


class Migration(migrations.Migration):

    dependencies = [
        ('productos', '0013_producto_creado_desde_importacion'),
    ]

    operations = [
        TrigramExtension(),
        migrations.AddIndex(
            model_name='producto',
            index=models.Index(fields=['nombre'], name='productos_nombre_idx'),
        ),
        migrations.AddIndex(
            model_name='producto',
            index=GinIndex(
                OpClass(Upper('codigo'), name='gin_trgm_ops'),
                name='productos_codigo_trgm',
            ),
        ),
        migrations.AddIndex(
            model_name='producto',
            index=GinIndex(
                OpClass(Upper('nombre'), name='gin_trgm_ops'),
                name='productos_nombre_trgm',
            ),
        ),
        migrations.AddIndex(
            model_name='producto',
            index=GinIndex(
                OpClass(Upper('descripcion'), name='gin_trgm_ops'),
                name='productos_descripcion_trgm',
            ),
        ),
        migrations.AddIndex(
            model_name='producto',
            index=GinIndex(
                OpClass(Upper('referencia'), name='gin_trgm_ops'),
                name='productos_referencia_trgm',
            ),
        ),
        migrations.AddIndex(
            model_name='oem',
            index=GinIndex(
                OpClass(Upper('codigo'), name='gin_trgm_ops'),
                name='productos_oem_codigo_trgm',
            ),
        ),
    ]
