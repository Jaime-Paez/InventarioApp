from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Pais",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("codigo_tais", models.CharField(max_length=10, unique=True)),
                ("nombre", models.CharField(max_length=120)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "País",
                "verbose_name_plural": "Países",
            },
        ),
        migrations.CreateModel(
            name="TipoMovimiento",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=80, unique=True)),
                ("descripcion", models.TextField(blank=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Tipo de movimiento",
                "verbose_name_plural": "Tipos de movimiento",
            },
        ),
        migrations.CreateModel(
            name="EstadoMovimiento",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=80, unique=True)),
                ("descripcion", models.TextField(blank=True)),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Estado de movimiento",
                "verbose_name_plural": "Estados de movimiento",
            },
        ),
        migrations.CreateModel(
            name="SubTipoMovimiento",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=80)),
                ("descripcion", models.TextField(blank=True)),
                (
                    "tipo_movimiento",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="subtipos",
                        to="tipos.tipomovimiento",
                    ),
                ),
            ],
            options={
                "ordering": ["tipo_movimiento__nombre", "nombre"],
                "verbose_name": "Subtipo de movimiento",
                "verbose_name_plural": "Subtipos de movimiento",
                "unique_together": {("tipo_movimiento", "nombre")},
            },
        ),
    ]
