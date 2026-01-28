from django.db import migrations


def drop_legacy_user_tables(apps, schema_editor):
    tables_to_drop = [
        "usuarios_usuariosucursal",
        "usuarios_usuario",
    ]
    with schema_editor.connection.cursor() as cursor:
        existing_tables = set(schema_editor.connection.introspection.table_names(cursor))
        for table in tables_to_drop:
            if table in existing_tables:
                cursor.execute(f"DROP TABLE IF EXISTS {table}")


class Migration(migrations.Migration):
    dependencies = [
        ("usuarios", "0008_eliminar_usuario_interno"),
    ]

    operations = [
        migrations.DeleteModel(
            name="UsuarioSucursal",
        ),
        migrations.RunPython(drop_legacy_user_tables, migrations.RunPython.noop),
    ]
