from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ("sucursales", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="Usuario",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=150)),
                ("email", models.EmailField(max_length=254, unique=True)),
                ("telefono", models.CharField(blank=True, max_length=30)),
                ("rol", models.CharField(choices=[("administrador", "Administrador"), ("vendedor", "Vendedor"), ("almacen", "Almacén")], max_length=30)),
                ("activo", models.BooleanField(default=True)),
                (
                    "sucursal",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="usuarios",
                        to="sucursales.sucursal",
                    ),
                ),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Usuario",
                "verbose_name_plural": "Usuarios",
            },
        ),
    ]
