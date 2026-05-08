import django, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from django.contrib.auth import get_user_model
from usuarios.models import UsuarioSucursal
from usuarios.sucursal_scope import get_allowed_sucursal_ids
from usuarios.models import RolPermiso
from movimientos.models import SolicitudTraslado
User = get_user_model()

for uid, label in [(8, "9 de Octubre Prueba"), (10, "Sur Prueba")]:
    try:
        user = User.objects.get(pk=uid)
    except User.DoesNotExist:
        print(f"User {uid} not found")
        continue

    print(f"\n=== User {uid}: {user.email} | staff={user.is_staff} ===")
    allowed = get_allowed_sucursal_ids(
        user,
        RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
        action_key=("puede_crear", "puede_actualizar"),
    )
    print(f"  allowed (entradas crear/act): {allowed}")

    qs = SolicitudTraslado.objects.filter(
        estado="aprobada",
        movimiento_salida_id__isnull=False,
        movimiento_entrada_id__isnull=False,
    )

    if allowed is not None:
        user_sucursales = set(UsuarioSucursal.objects.filter(usuario=user).values_list("sucursal_id", flat=True))
        print(f"  UsuarioSucursal direct IDs: {user_sucursales}")
        if user_sucursales:
            allowed = allowed & user_sucursales
            print(f"  allowed after intersection: {allowed}")
        if not allowed:
            print("  -> returns []")
            continue
        qs = qs.filter(sucursal_solicitante_id__in=sorted(allowed))

    results = list(qs.values("id", "no_documento", "sucursal_solicitante_id", "sucursal_proveedora_id"))
    print(f"  Solicitudes visibles: {results}")
