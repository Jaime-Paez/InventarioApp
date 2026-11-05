from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("app", "0026_inspeccion_reconteo"),
    ]

    operations = [
        migrations.AddField(
            model_name="inspeccionaleatoriaitem",
            name="movido_por_revisor",
            field=models.BooleanField(db_default=False, default=False),
        ),
    ]
