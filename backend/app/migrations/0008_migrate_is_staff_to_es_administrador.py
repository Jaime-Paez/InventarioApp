from django.conf import settings
from django.db import migrations


def migrate_is_staff(apps, schema_editor):
    User = apps.get_model(*settings.AUTH_USER_MODEL.split(".")) if "." in getattr(settings, "AUTH_USER_MODEL", "") else apps.get_model("auth", "User")
    UsuarioPreferencia = apps.get_model("app", "UsuarioPreferencia")

    for user in User.objects.filter(is_staff=True, is_superuser=False):
        pref, _ = UsuarioPreferencia.objects.get_or_create(usuario=user)
        pref.es_administrador = True
        pref.save(update_fields=["es_administrador"])

    User.objects.filter(is_superuser=False).update(is_staff=False)


def reverse_migrate_is_staff(apps, schema_editor):
    User = apps.get_model(*settings.AUTH_USER_MODEL.split(".")) if "." in getattr(settings, "AUTH_USER_MODEL", "") else apps.get_model("auth", "User")
    UsuarioPreferencia = apps.get_model("app", "UsuarioPreferencia")

    for pref in UsuarioPreferencia.objects.filter(es_administrador=True):
        pref.usuario.is_staff = True
        pref.usuario.save(update_fields=["is_staff"])


class Migration(migrations.Migration):

    dependencies = [
        ("app", "0007_usuariopreferencia_es_administrador"),
    ]

    operations = [
        migrations.RunPython(migrate_is_staff, reverse_migrate_is_staff),
    ]
