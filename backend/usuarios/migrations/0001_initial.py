from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("ubicaciones", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="Usuario",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombres", models.CharField(max_length=150)),
                ("apellidos", models.CharField(max_length=150)),
                ("correo", models.EmailField(max_length=254, unique=True)),
                ("telefono", models.CharField(blank=True, max_length=30)),
                ("cargo", models.CharField(blank=True, max_length=120)),
                ("activo", models.BooleanField(default=True)),
            ],
            options={
                "ordering": ["apellidos", "nombres"],
                "verbose_name": "Usuario",
                "verbose_name_plural": "Usuarios",
            },
        ),
        migrations.CreateModel(
            name="UsuarioSucursal",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("rol", models.CharField(blank=True, max_length=120)),
                ("es_responsable", models.BooleanField(default=False)),
                (
                    "sucursal",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="usuarios",
                        to="ubicaciones.sucursal",
                    ),
                ),
                (
                    "usuario",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="asignaciones",
                        to="usuarios.usuario",
                    ),
                ),
            ],
            options={
                "verbose_name": "Usuario por sucursal",
                "verbose_name_plural": "Usuarios por sucursal",
                "unique_together": {("usuario", "sucursal")},
            },
        ),
    ]
