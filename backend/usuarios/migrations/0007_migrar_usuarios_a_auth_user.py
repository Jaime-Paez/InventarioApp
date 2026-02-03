from django.conf import settings
from django.db import migrations, models


def forwards(apps, schema_editor):
    Usuario = apps.get_model("usuarios", "Usuario")
    UsuarioSucursal = apps.get_model("usuarios", "UsuarioSucursal")
    Rol = apps.get_model("usuarios", "Rol")
    app_label, model_name = settings.AUTH_USER_MODEL.split(".")
    User = apps.get_model(app_label, model_name)
    db_alias = schema_editor.connection.alias

    for usuario in Usuario.objects.using(db_alias).prefetch_related("roles"):
        email = (usuario.correo or "").strip().lower()
        if not email:
            continue
        user = (
            User.objects.using(db_alias)
            .filter(email__iexact=email)
            .first()
        )
        if not user:
            user = User(
                username=email,
                email=email,
                first_name=usuario.nombres or "",
                last_name=usuario.apellidos or "",
                is_active=usuario.activo,
            )
            user.set_unusable_password()
            user.save(using=db_alias)
        else:
            updates = []
            if user.username != email:
                user.username = email
                updates.append("username")
            if user.email != email:
                user.email = email
                updates.append("email")
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
                user.save(using=db_alias, update_fields=updates)

        for rol in usuario.roles.all():
            rol.usuarios.add(user)

        UsuarioSucursal.objects.using(db_alias).filter(usuario_id=usuario.id).update(
            auth_user_id=user.id
        )


class Migration(migrations.Migration):
    dependencies = [
        ("usuarios", "0006_flatten_modules_no_submodules"),
        ("auditoria", "0003_migrate_usuario_a_auth_user"),
    ]

    operations = [
        migrations.AddField(
            model_name="rol",
            name="usuarios",
            field=models.ManyToManyField(
                blank=True,
                related_name="roles",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="usuariosucursal",
            name="auth_user",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.deletion.CASCADE,
                related_name="asignaciones_tmp",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.RunPython(forwards, migrations.RunPython.noop),
        migrations.RemoveField(
            model_name="usuariosucursal",
            name="usuario",
        ),
        migrations.RenameField(
            model_name="usuariosucursal",
            old_name="auth_user",
            new_name="usuario",
        ),
        migrations.AlterField(
            model_name="usuariosucursal",
            name="usuario",
            field=models.ForeignKey(
                on_delete=models.deletion.CASCADE,
                related_name="asignaciones",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.DeleteModel(
            name="Usuario",
        ),
    ]
