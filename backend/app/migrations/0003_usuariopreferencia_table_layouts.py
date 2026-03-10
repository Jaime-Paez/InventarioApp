from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("app", "0002_inspeccionaleatoriadiaria_usuariopreferencia_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="usuariopreferencia",
            name="table_layouts",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text="Layouts de tablas guardados por usuario para restaurar en cualquier equipo.",
            ),
        ),
    ]
