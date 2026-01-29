from django.contrib.auth.hashers import make_password
from django.db import migrations, models
from django.utils import timezone


def populate_user_credentials(apps, schema_editor):
    Usuario = apps.get_model("usuarios", "Usuario")
    for usuario in Usuario.objects.all():
        updates = []
        if not usuario.username:
            usuario.username = (usuario.email or "").strip()
            updates.append("username")
        if not usuario.password:
            usuario.password = make_password(None)
            updates.append("password")
        if updates:
            usuario.save(update_fields=updates)


class Migration(migrations.Migration):
    dependencies = [
        ("auth", "0012_alter_user_first_name_max_length"),
        ("usuarios", "0002_rol_usuario_roles_rolpermiso"),
    ]

    operations = [
        migrations.RenameField(
            model_name="usuario",
            old_name="nombres",
            new_name="first_name",
        ),
        migrations.RenameField(
            model_name="usuario",
            old_name="apellidos",
            new_name="last_name",
        ),
        migrations.RenameField(
            model_name="usuario",
            old_name="correo",
            new_name="email",
        ),
        migrations.RenameField(
            model_name="usuario",
            old_name="activo",
            new_name="is_active",
        ),
        migrations.AddField(
            model_name="usuario",
            name="username",
            field=models.CharField(blank=True, max_length=150, null=True, unique=True),
        ),
        migrations.AddField(
            model_name="usuario",
            name="password",
            field=models.CharField(default="", max_length=128),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name="usuario",
            name="last_login",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="usuario",
            name="is_superuser",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="usuario",
            name="is_staff",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="usuario",
            name="date_joined",
            field=models.DateTimeField(default=timezone.now),
        ),
        migrations.AddField(
            model_name="usuario",
            name="groups",
            field=models.ManyToManyField(
                blank=True,
                help_text="The groups this user belongs to.",
                related_name="user_set",
                related_query_name="user",
                to="auth.group",
                verbose_name="groups",
            ),
        ),
        migrations.AddField(
            model_name="usuario",
            name="user_permissions",
            field=models.ManyToManyField(
                blank=True,
                help_text="Specific permissions for this user.",
                related_name="user_set",
                related_query_name="user",
                to="auth.permission",
                verbose_name="user permissions",
            ),
        ),
        migrations.RunPython(populate_user_credentials, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="usuario",
            name="username",
            field=models.CharField(max_length=150, unique=True),
        ),
    ]
