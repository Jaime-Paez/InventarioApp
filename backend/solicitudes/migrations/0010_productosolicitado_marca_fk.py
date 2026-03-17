from django.db import migrations, models


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("solicitudes", "0009_regroup_solicitud_grupos"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="productosolicitado",
            name="marca",
        ),
        migrations.AddField(
            model_name="productosolicitado",
            name="marca",
            field=models.IntegerField(blank=True, null=True, db_column="marca_id"),
        ),
    ]
