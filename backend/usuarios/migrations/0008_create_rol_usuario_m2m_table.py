from django.conf import settings
from django.db import migrations, models


def ensure_rol_user_table(apps, schema_editor):
    table_name = "usuarios_rol_usuarios"
    existing_tables = schema_editor.connection.introspection.table_names()
    if table_name in existing_tables:
        return

    Rol = apps.get_model("usuarios", "Rol")
    app_label, model_name = settings.AUTH_USER_MODEL.split(".")
    User = apps.get_model(app_label, model_name)

    class RolUser(models.Model):
        rol = models.ForeignKey(Rol, on_delete=models.CASCADE)
        user = models.ForeignKey(User, on_delete=models.CASCADE)

        class Meta:
            db_table = table_name
            managed = True
            unique_together = (("rol", "user"),)

    schema_editor.create_model(RolUser)


def copy_old_role_assignments(apps, schema_editor):
    connection = schema_editor.connection
    if connection.vendor != "postgresql":
        return
    existing_tables = connection.introspection.table_names()
    if "usuarios_usuario_roles" not in existing_tables:
        return
    if "usuarios_rol_usuarios" not in existing_tables:
        return

    app_label, model_name = settings.AUTH_USER_MODEL.split(".")
    User = apps.get_model(app_label, model_name)
    auth_table = User._meta.db_table
    usuario_table = "usuarios_usuario"
    roles_table = "usuarios_usuario_roles"
    target_table = "usuarios_rol_usuarios"

    if usuario_table not in existing_tables:
        return

    quote = connection.ops.quote_name
    sql = f"""
        INSERT INTO {quote(target_table)} (rol_id, user_id)
        SELECT uur.rol_id, u.id
        FROM {quote(roles_table)} AS uur
        JOIN {quote(usuario_table)} AS uu ON uu.id = uur.usuario_id
        JOIN {quote(auth_table)} AS u ON lower(u.email) = lower(uu.correo)
        ON CONFLICT DO NOTHING
    """
    with connection.cursor() as cursor:
        cursor.execute(sql)


class Migration(migrations.Migration):
    dependencies = [
        ("usuarios", "0007_migrar_usuarios_a_auth_user"),
    ]

    operations = [
        migrations.RunPython(ensure_rol_user_table, migrations.RunPython.noop),
        migrations.RunPython(copy_old_role_assignments, migrations.RunPython.noop),
    ]
