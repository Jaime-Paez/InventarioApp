import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("importaciones", "0001_initial"),
        ("productos", "0011_remove_oem_descripcion"),
    ]

    operations = [
        migrations.AlterUniqueTogether(
            name="importaciondetalle",
            unique_together=set(),
        ),
        migrations.AlterField(
            model_name="importaciondetalle",
            name="producto",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="detalles_importacion",
                to="productos.producto",
            ),
        ),
        migrations.AddField(
            model_name="importaciondetalle",
            name="codigo",
            field=models.CharField(blank=True, default="", max_length=150),
        ),
        migrations.AddField(
            model_name="importaciondetalle",
            name="nombre",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddField(
            model_name="importaciondetalle",
            name="oem",
            field=models.CharField(blank=True, default="", max_length=500),
        ),
    ]
