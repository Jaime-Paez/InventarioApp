from django.conf import settings
from django.db import migrations, models


def forwards(apps, schema_editor):
    Usuario = apps.get_model("usuarios", "Usuario")
    RegistroAuditoria = apps.get_model("auditoria", "RegistroAuditoria")
    app_label, model_name = settings.AUTH_USER_MODEL.split(".")
    User = apps.get_model(app_label, model_name)
    db_alias = schema_editor.connection.alias

    usuarios_por_id = {
        usuario.id: usuario
        for usuario in Usuario.objects.using(db_alias).all()
    }

    registros = RegistroAuditoria.objects.using(db_alias).all()
    for registro in registros:
        if not registro.usuario_id:
            continue
        usuario = usuarios_por_id.get(registro.usuario_id)
        if not usuario:
            continue
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
        registro.auth_user_id = user.id
        registro.save(update_fields=["auth_user"])


def backwards(apps, schema_editor):
    # No reverse migration for audit linkage.
    return


class Migration(migrations.Migration):
    dependencies = [
        ("usuarios", "0006_flatten_modules_no_submodules"),
        ("auditoria", "0002_rename_auditoria__registr_463a73_idx_auditoria_r_registr_cc14eb_idx_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="registroauditoria",
            name="auth_user",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.deletion.SET_NULL,
                related_name="registros_auditoria_tmp",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.RunPython(forwards, backwards),
        migrations.RemoveField(
            model_name="registroauditoria",
            name="usuario",
        ),
        migrations.RenameField(
            model_name="registroauditoria",
            old_name="auth_user",
            new_name="usuario",
        ),
        migrations.AlterField(
            model_name="registroauditoria",
            name="usuario",
            field=models.ForeignKey(
                blank=True,
                help_text="Usuario responsable de la acción registrada.",
                null=True,
                on_delete=models.deletion.SET_NULL,
                related_name="registros_auditoria",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
