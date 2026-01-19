from django.db import migrations, models
import django.db.models.deletion
from django.conf import settings


class Migration(migrations.Migration):
    dependencies = [
        ("usuarios", "0007_unificar_usuarios_auth"),
    ]

    operations = [
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
