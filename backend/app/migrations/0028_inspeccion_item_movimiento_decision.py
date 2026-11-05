from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("app", "0027_inspeccion_item_movido"),
    ]

    operations = [
        migrations.AddField(
            model_name="inspeccionaleatoriaitem",
            name="movimiento_decision",
            field=models.CharField(blank=True, db_default="", default="", max_length=10),
        ),
    ]
