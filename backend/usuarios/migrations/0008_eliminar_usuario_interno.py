from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.db import migrations, models
import django.db.models.deletion


def asegurar_usuario_auth(apps, schema_editor):
    UsuarioSucursal = apps.get_model("usuarios", "UsuarioSucursal")
    Usuario = apps.get_model("usuarios", "Usuario")
    UsuarioPerfil = apps.get_model("usuarios", "UsuarioPerfil")
    User = apps.get_model("auth", "User")
    table = UsuarioSucursal._meta.db_table
    with schema_editor.connection.cursor() as cursor:
        introspection = schema_editor.connection.introspection
        columns = {col.name for col in introspection.get_table_description(cursor, table)}
        existing_tables = set(introspection.table_names(cursor))

    if UsuarioPerfil._meta.db_table not in existing_tables:
        schema_editor.create_model(UsuarioPerfil)

    if "usuario_auth_id" not in columns:
        field = UsuarioSucursal._meta.get_field("usuario_auth")
        schema_editor.add_field(UsuarioSucursal, field)

    for usuario in Usuario.objects.all():
        email = (usuario.correo or "").strip().lower()
        user = User.objects.filter(email__iexact=email).first() if email else None
        if user is None:
            username = email or f"usuario-{usuario.pk}"
            user = User(
                username=username,
                email=email,
                first_name=usuario.nombres or "",
                last_name=usuario.apellidos or "",
                is_active=usuario.activo,
            )
            user.password = make_password(None)
            user.save(update_fields=["password"])

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

        UsuarioSucursal.objects.filter(usuario=usuario).update(usuario_auth_id=user.id)


class Migration(migrations.Migration):
    dependencies = [
        ("usuarios", "0007_unificar_usuarios_auth"),
    ]

    operations = [
        migrations.RunPython(asegurar_usuario_auth, migrations.RunPython.noop),
        migrations.RemoveField(
            model_name="usuariosucursal",
            name="usuario",
        ),
        migrations.RenameField(
            model_name="usuariosucursal",
            old_name="usuario_auth",
            new_name="usuario",
        ),
        migrations.AlterField(
            model_name="usuariosucursal",
            name="usuario",
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="asignaciones", to=settings.AUTH_USER_MODEL),
        ),
        migrations.RemoveField(
            model_name="usuario",
            name="rol_personalizado",
        ),
        migrations.RemoveField(
            model_name="usuario",
            name="roles",
        ),
        migrations.DeleteModel(
            name="Usuario",
        ),
    ]
