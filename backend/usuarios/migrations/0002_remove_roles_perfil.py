from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("usuarios", "0001_initial"),
    ]

    operations = [
        migrations.DeleteModel(
            name="RolPermiso",
        ),
        migrations.DeleteModel(
            name="UsuarioPerfil",
        ),
        migrations.DeleteModel(
            name="Rol",
        ),
    ]
