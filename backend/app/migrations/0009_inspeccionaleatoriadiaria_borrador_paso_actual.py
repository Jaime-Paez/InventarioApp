from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("app", "0008_migrate_is_staff_to_es_administrador"),
    ]

    operations = [
        migrations.AddField(
            model_name="inspeccionaleatoriadiaria",
            name="borrador_paso_actual",
            field=models.PositiveSmallIntegerField(default=0),
        ),
    ]
