from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("app", "0009_inspeccionaleatoriadiaria_borrador_paso_actual"),
    ]

    operations = [
        migrations.AddField(
            model_name="inspeccionaleatoriadiaria",
            name="disculpada",
            field=models.BooleanField(
                default=False,
                help_text="True si el admin disculpó al usuario por no haber completado el conteo.",
            ),
        ),
    ]
