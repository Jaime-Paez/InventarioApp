from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("app", "0006_inspeccionaleatoriadiaria_sucursal"),
    ]

    operations = [
        migrations.AddField(
            model_name="usuariopreferencia",
            name="es_administrador",
            field=models.BooleanField(default=False),
        ),
    ]
