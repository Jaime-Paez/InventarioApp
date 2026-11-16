from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("app", "0029_reconteo_que_coincide_queda_pendiente"),
    ]

    operations = [
        migrations.AddField(
            model_name="inspeccionaleatoriaitem",
            name="ubicacion_cero_decision",
            field=models.CharField(blank=True, db_default="", default="", max_length=10),
        ),
    ]
