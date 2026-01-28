from django.db import migrations


def ensure_roles_and_profile_tables(apps, schema_editor):
    Rol = apps.get_model("usuarios", "Rol")
    RolPermiso = apps.get_model("usuarios", "RolPermiso")
    UsuarioPerfil = apps.get_model("usuarios", "UsuarioPerfil")
    through_model = Rol.usuarios.through

    with schema_editor.connection.cursor() as cursor:
        existing_tables = set(schema_editor.connection.introspection.table_names(cursor))

    for model in (Rol, RolPermiso, UsuarioPerfil, through_model):
        if model._meta.db_table not in existing_tables:
            schema_editor.create_model(model)


class Migration(migrations.Migration):
    dependencies = [
        ("usuarios", "0009_eliminar_tablas_usuario_legacy"),
    ]

    operations = [
        migrations.RunPython(ensure_roles_and_profile_tables, migrations.RunPython.noop),
    ]
