from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("auditoria", "0003_unificar_usuario_auth"),
    ]

    operations = [
        migrations.DeleteModel(
            name="RegistroAuditoria",
        ),
    ]
