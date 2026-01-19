from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def asegurar_usuario_auth(apps, schema_editor):
    UsuarioSucursal = apps.get_model("usuarios", "UsuarioSucursal")
    table = UsuarioSucursal._meta.db_table
    with schema_editor.connection.cursor() as cursor:
        columns = {
            col.name
            for col in schema_editor.connection.introspection.get_table_description(
                cursor, table
            )
        }
    if "usuario_auth_id" not in columns:
        field = UsuarioSucursal._meta.get_field("usuario_auth")
        schema_editor.add_field(UsuarioSucursal, field)
    schema_editor.execute(
        f"UPDATE {table} SET usuario_auth_id = usuario_id WHERE usuario_auth_id IS NULL"
    )


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
