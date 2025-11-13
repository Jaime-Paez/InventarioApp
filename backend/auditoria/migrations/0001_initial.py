# Generated manually due to unavailable Django manage.py in this environment.
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ("usuarios", "0003_alter_rolpermiso_options_and_more"),
        ("contenttypes", "0002_remove_content_type_name"),
    ]

    operations = [
        migrations.CreateModel(
            name="RegistroAuditoria",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("accion", models.CharField(choices=[("creacion", "Creación"), ("actualizacion", "Actualización"), ("eliminacion", "Eliminación"), ("otro", "Otro")], help_text="Tipo de operación realizada sobre el objeto auditado.", max_length=20)),
                ("object_id", models.CharField(help_text="Identificador del objeto afectado.", max_length=255)),
                ("representacion_objeto", models.CharField(blank=True, help_text="Representación legible del objeto afectado.", max_length=255)),
                ("valores_previos", models.JSONField(blank=True, help_text="Valores anteriores del objeto antes del cambio.", null=True)),
                ("valores_nuevos", models.JSONField(blank=True, help_text="Valores resultantes después del cambio.", null=True)),
                ("detalles", models.TextField(blank=True, help_text="Descripción adicional de la acción registrada.")),
                ("registrado_en", models.DateTimeField(auto_now_add=True, help_text="Fecha y hora en la que se guardó el registro de auditoría.")),
                ("content_type", models.ForeignKey(help_text="Modelo sobre el cual se ejecutó la acción.", on_delete=django.db.models.deletion.PROTECT, related_name="registros_auditoria", to="contenttypes.contenttype")),
                ("usuario", models.ForeignKey(blank=True, help_text="Usuario responsable de la acción registrada.", null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="registros_auditoria", to="usuarios.usuario")),
            ],
            options={
                "verbose_name": "Registro de auditoría",
                "verbose_name_plural": "Registros de auditoría",
                "ordering": ["-registrado_en"],
            },
        ),
        migrations.AddIndex(
            model_name="registroauditoria",
            index=models.Index(fields=["registrado_en"], name="auditoria__registr_463a73_idx"),
        ),
        migrations.AddIndex(
            model_name="registroauditoria",
            index=models.Index(fields=["accion"], name="auditoria__accion_3a0535_idx"),
        ),
        migrations.AddIndex(
            model_name="registroauditoria",
            index=models.Index(fields=["content_type", "object_id"], name="auditoria__content_7f7e11_idx"),
        ),
    ]
