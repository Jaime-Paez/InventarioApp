from django.db import migrations


def ensure_registroauditoria_table(apps, schema_editor):
    model = apps.get_model("auditoria", "RegistroAuditoria")
    table_name = model._meta.db_table
    existing_tables = schema_editor.connection.introspection.table_names()
    if table_name in existing_tables:
        return

    original_indexes = list(model._meta.indexes)
    model._meta.indexes = []
    try:
        schema_editor.create_model(model)
    finally:
        model._meta.indexes = original_indexes


class Migration(migrations.Migration):
    dependencies = [
        ("auditoria", "0004_merge_0002_initial_0003_migrate_usuario_a_auth_user"),
    ]

    operations = [
        migrations.RunPython(ensure_registroauditoria_table, migrations.RunPython.noop),
    ]
