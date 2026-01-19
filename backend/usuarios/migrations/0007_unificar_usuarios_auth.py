from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def migrar_usuarios_a_auth(apps, schema_editor):
    User = apps.get_model("auth", "User")
    Usuario = apps.get_model("usuarios", "Usuario")
    UsuarioPerfil = apps.get_model("usuarios", "UsuarioPerfil")
    Rol = apps.get_model("usuarios", "Rol")
    UsuarioSucursal = apps.get_model("usuarios", "UsuarioSucursal")

    for usuario in Usuario.objects.all():
        email = (usuario.correo or "").strip().lower()
        username = email or f"usuario-{usuario.pk}"
        user = User.objects.filter(email__iexact=email).first() if email else None

        if user is None:
            user = User(
                username=username,
                email=email,
                first_name=usuario.nombres or "",
                last_name=usuario.apellidos or "",
                is_active=usuario.activo,
            )
            user.set_unusable_password()
            user.save()
        else:
            updates = []
            if email and user.email != email:
                user.email = email
                updates.append("email")
            if email and user.username != email:
                user.username = email
                updates.append("username")
            if user.first_name != (usuario.nombres or ""):
                user.first_name = usuario.nombres or ""
                updates.append("first_name")
            if user.last_name != (usuario.apellidos or ""):
                user.last_name = usuario.apellidos or ""
                updates.append("last_name")
            if user.is_active != usuario.activo:
                user.is_active = usuario.activo
                updates.append("is_active")
            if updates:
                user.save(update_fields=updates)

        perfil, _ = UsuarioPerfil.objects.get_or_create(usuario=user)
        perfil_updates = []
        if perfil.telefono != (usuario.telefono or ""):
            perfil.telefono = usuario.telefono or ""
            perfil_updates.append("telefono")
        if perfil.cargo != (usuario.cargo or ""):
            perfil.cargo = usuario.cargo or ""
            perfil_updates.append("cargo")
        if usuario.rol_personalizado_id and perfil.rol_personalizado_id != usuario.rol_personalizado_id:
            perfil.rol_personalizado_id = usuario.rol_personalizado_id
            perfil_updates.append("rol_personalizado")
        if perfil_updates:
            perfil.save(update_fields=perfil_updates)

        for rol in usuario.roles.all():
            rol.usuarios.add(user)

        UsuarioSucursal.objects.filter(usuario=usuario).update(usuario_auth=user)


class Migration(migrations.Migration):
    dependencies = [
        ("auth", "0012_alter_user_first_name_max_length"),
        ("usuarios", "0006_flatten_modules_no_submodules"),
    ]

    operations = [
        migrations.CreateModel(
            name="UsuarioPerfil",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("telefono", models.CharField(blank=True, max_length=30)),
                ("cargo", models.CharField(blank=True, max_length=120)),
                (
                    "rol_personalizado",
                    models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="perfil_personalizado", to="usuarios.rol"),
                ),
                (
                    "usuario",
                    models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="perfil", to=settings.AUTH_USER_MODEL),
                ),
            ],
            options={
                "verbose_name": "Perfil de usuario",
                "verbose_name_plural": "Perfiles de usuario",
                "ordering": ["usuario__last_name", "usuario__first_name"],
            },
        ),
        migrations.AddField(
            model_name="rol",
            name="usuarios",
            field=models.ManyToManyField(blank=True, related_name="roles", to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddField(
            model_name="usuariosucursal",
            name="usuario_auth",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name="asignaciones_auth", to=settings.AUTH_USER_MODEL),
        ),
        migrations.RunPython(migrar_usuarios_a_auth, migrations.RunPython.noop),
    ]
