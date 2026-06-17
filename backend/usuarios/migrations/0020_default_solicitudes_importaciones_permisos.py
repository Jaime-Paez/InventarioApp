from django.db import migrations


def grant_default_module_permissions(apps, schema_editor):
    User = apps.get_model('auth', 'User')
    Sucursal = apps.get_model('inventario', 'Sucursal')
    UsuarioModuloSucursal = apps.get_model('usuarios', 'UsuarioModuloSucursal')

    sucursal_ids = list(Sucursal.objects.values_list('id', flat=True))
    if not sucursal_ids:
        return

    modules_config = {
        'solicitudes': {
            'puede_crear': True,
            'puede_leer': True,
            'puede_actualizar': True,
            'puede_eliminar': True,
        },
        'importaciones': {
            'puede_crear': True,
            'puede_leer': True,
            'puede_actualizar': True,
            'puede_eliminar': True,
            'puede_importar': True,
            'puede_marcar_llegada': True,
        },
    }

    to_create = []
    for user in User.objects.filter(is_active=True, is_staff=False, is_superuser=False):
        existing = set(
            UsuarioModuloSucursal.objects.filter(
                usuario=user,
                modulo__in=modules_config.keys(),
            ).values_list('modulo', 'sucursal_id')
        )
        for modulo, flags in modules_config.items():
            for sucursal_id in sucursal_ids:
                if (modulo, sucursal_id) not in existing:
                    to_create.append(
                        UsuarioModuloSucursal(
                            usuario=user,
                            modulo=modulo,
                            sucursal_id=sucursal_id,
                            **flags,
                        )
                    )

    if to_create:
        UsuarioModuloSucursal.objects.bulk_create(to_create, ignore_conflicts=True)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('usuarios', '0019_importaciones_module'),
    ]

    operations = [
        migrations.RunPython(grant_default_module_permissions, noop),
    ]
