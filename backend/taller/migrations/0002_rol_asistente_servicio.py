from django.db import migrations

ROL_NOMBRE = "Asistente de servicio"


def crear_rol(apps, schema_editor):
    Rol = apps.get_model("usuarios", "Rol")
    RolPermiso = apps.get_model("usuarios", "RolPermiso")
    rol, _ = Rol.objects.get_or_create(
        nombre=ROL_NOMBRE,
        defaults={
            "descripcion": "Crea cotizaciones y órdenes de trabajo del taller y pide los repuestos.",
            "activo": True,
        },
    )
    RolPermiso.objects.get_or_create(
        rol=rol,
        modulo="taller",
        submodulo="",
        defaults={
            "puede_crear": True,
            "puede_leer": True,
            "puede_actualizar": True,
            "puede_eliminar": True,
        },
    )


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("taller", "0001_initial"),
        ("usuarios", "0022_alter_rolpermiso_modulo"),
    ]

    operations = [migrations.RunPython(crear_rol, noop)]
