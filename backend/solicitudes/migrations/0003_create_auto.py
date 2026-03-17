import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("solicitudes", "0002_rename_cliente_nombre_add_apellidos"),
    ]

    operations = [
        migrations.CreateModel(
            name="Auto",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("placa", models.CharField(max_length=20)),
                ("modelo", models.CharField(max_length=120)),
                ("anio", models.PositiveSmallIntegerField(verbose_name="Anio")),
                ("color", models.CharField(blank=True, max_length=50)),
                (
                    "cliente",
                    models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="autos", to="solicitudes.cliente"),
                ),
                ("marca", models.IntegerField(null=True, blank=True, db_column="marca_id")),
            ],
            options={
                "verbose_name": "Auto",
                "verbose_name_plural": "Autos",
                "ordering": ["placa"],
            },
        ),
    ]
