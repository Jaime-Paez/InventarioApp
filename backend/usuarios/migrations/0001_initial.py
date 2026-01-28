from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="Rol",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("nombre", models.CharField(max_length=150, unique=True)),
                ("descripcion", models.TextField(blank=True)),
                ("activo", models.BooleanField(default=True)),
                ("es_personalizado", models.BooleanField(default=False)),
                (
                    "usuarios",
                    models.ManyToManyField(
                        blank=True,
                        related_name="roles",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["nombre"],
                "verbose_name": "Rol",
                "verbose_name_plural": "Roles",
            },
        ),
        migrations.CreateModel(
            name="RolPermiso",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "modulo",
                    models.CharField(
                        choices=[("usuarios", "Administrar")],
                        max_length=50,
                    ),
                ),
                (
                    "submodulo",
                    models.CharField(
                        blank=True,
                        choices=[("", "General")],
                        default="",
                        max_length=50,
                    ),
                ),
                ("puede_crear", models.BooleanField(default=False)),
                ("puede_leer", models.BooleanField(default=False)),
                ("puede_actualizar", models.BooleanField(default=False)),
                ("puede_eliminar", models.BooleanField(default=False)),
                (
                    "rol",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="permisos",
                        to="usuarios.rol",
                    ),
                ),
            ],
            options={
                "ordering": ["rol__nombre", "modulo", "submodulo"],
                "verbose_name": "Permiso de rol",
                "verbose_name_plural": "Permisos de rol",
                "unique_together": {("rol", "modulo", "submodulo")},
            },
        ),
        migrations.CreateModel(
            name="UsuarioPerfil",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("telefono", models.CharField(blank=True, max_length=30)),
                ("cargo", models.CharField(blank=True, max_length=120)),
                (
                    "rol_personalizado",
                    models.OneToOneField(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="perfil_personalizado",
                        to="usuarios.rol",
                    ),
                ),
                (
                    "usuario",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="perfil",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["usuario__last_name", "usuario__first_name"],
                "verbose_name": "Perfil de usuario",
                "verbose_name_plural": "Perfiles de usuario",
            },
        ),
        migrations.AddConstraint(
            model_name="rolpermiso",
            constraint=models.CheckConstraint(
                check=models.Q(("submodulo", "")),
                name="rol_permiso_sin_submodulos",
            ),
        ),
    ]
