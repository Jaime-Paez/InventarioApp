from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def migrar_auditoria_usuario_auth(apps, schema_editor):
    User = apps.get_model("auth", "User")
    RegistroAuditoria = apps.get_model("auditoria", "RegistroAuditoria")
    Usuario = apps.get_model("usuarios", "Usuario")

    for registro in RegistroAuditoria.objects.select_related("usuario").all():
        if not registro.usuario_id:
            continue
        usuario = Usuario.objects.filter(pk=registro.usuario_id).first()
        if not usuario:
            continue
        email = (usuario.correo or "").strip().lower()
        user = User.objects.filter(email__iexact=email).first() if email else None
        if user:
            registro.usuario_auth_id = user.id
            registro.save(update_fields=["usuario_auth"])


class Migration(migrations.Migration):
    dependencies = [
        ("auth", "0012_alter_user_first_name_max_length"),
        ("usuarios", "0007_unificar_usuarios_auth"),
        ("auditoria", "0002_rename_auditoria__registr_463a73_idx_auditoria_r_registr_cc14eb_idx_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="registroauditoria",
            name="usuario_auth",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="registros_auditoria_auth", to=settings.AUTH_USER_MODEL),
        ),
        migrations.RunPython(migrar_auditoria_usuario_auth, migrations.RunPython.noop),
        migrations.RemoveField(
            model_name="registroauditoria",
            name="usuario",
        ),
        migrations.RenameField(
            model_name="registroauditoria",
            old_name="usuario_auth",
            new_name="usuario",
        ),
        migrations.AlterField(
            model_name="registroauditoria",
            name="usuario",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="registros_auditoria", to=settings.AUTH_USER_MODEL, help_text="Usuario responsable de la acción registrada."),
        ),
    ]
