from django.conf import settings
from django.db import migrations


def fix_usuario_sucursal_fk(apps, schema_editor):
    connection = schema_editor.connection
    if connection.vendor != "postgresql":
        return

    table_name = "usuarios_usuariosucursal"
    existing_tables = connection.introspection.table_names()
    if table_name not in existing_tables:
        return

    quote = connection.ops.quote_name

    # Remap legacy usuario_id values to auth_user by matching email.
    if "usuarios_usuario" in existing_tables and "auth_user" in existing_tables:
        schema_editor.execute(
            f"""
            UPDATE {quote(table_name)} AS uus
            SET usuario_id = au.id
            FROM {quote("usuarios_usuario")} AS uu
            JOIN {quote("auth_user")} AS au
              ON lower(au.email) = lower(uu.email)
            WHERE uus.usuario_id = uu.id
              AND uus.usuario_id NOT IN (SELECT id FROM {quote("auth_user")})
              AND NOT EXISTS (
                SELECT 1
                FROM {quote(table_name)} AS dup
                WHERE dup.usuario_id = au.id
                  AND dup.sucursal_id = uus.sucursal_id
              )
            """
        )

    # Drop any rows that still reference missing users.
    schema_editor.execute(
        f"""
        DELETE FROM {quote(table_name)}
        WHERE usuario_id NOT IN (SELECT id FROM {quote("auth_user")})
        """
    )

    with connection.cursor() as cursor:
        constraints = connection.introspection.get_constraints(cursor, table_name)

    fk_constraints = [
        name
        for name, info in constraints.items()
        if info.get("foreign_key") and info.get("columns") == ["usuario_id"]
    ]

    for constraint_name in fk_constraints:
        schema_editor.execute(
            f"ALTER TABLE {quote(table_name)} DROP CONSTRAINT {quote(constraint_name)}"
        )

    app_label, model_name = settings.AUTH_USER_MODEL.split(".")
    User = apps.get_model(app_label, model_name)
    auth_table = User._meta.db_table

    new_constraint = "usuarios_usuariosucu_usuario_id_fk_auth_user"
    schema_editor.execute(
        f"""
        ALTER TABLE {quote(table_name)}
        ADD CONSTRAINT {quote(new_constraint)}
        FOREIGN KEY (usuario_id)
        REFERENCES {quote(auth_table)} (id)
        ON DELETE CASCADE
        """
    )


class Migration(migrations.Migration):
    atomic = False
    dependencies = [
        ("usuarios", "0008_create_rol_usuario_m2m_table"),
    ]

    operations = [
        migrations.RunPython(fix_usuario_sucursal_fk, migrations.RunPython.noop),
    ]
