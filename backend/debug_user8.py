import django, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from usuarios.models import UsuarioSucursal, UsuarioModuloSucursal
from usuarios.sucursal_scope import get_allowed_sucursal_ids, _get_scoped_branch_action_index
from usuarios.models import RolPermiso
from django.contrib.auth import get_user_model
User = get_user_model()

user8 = User.objects.get(pk=8)
print(f"User 8: {user8.get_full_name() or user8.email} | is_staff={user8.is_staff} | is_superuser={user8.is_superuser}")

print("\n=== UsuarioSucursal (asignaciones directas) ===")
for us in UsuarioSucursal.objects.filter(usuario=user8).select_related("sucursal"):
    print(f"  Sucursal: {us.sucursal.nombre} (ID={us.sucursal_id})")

print("\n=== UsuarioModuloSucursal (alcance por módulo) ===")
for ums in UsuarioModuloSucursal.objects.filter(usuario=user8).select_related("sucursal"):
    print(f"  Módulo: {ums.modulo} | Sucursal: {ums.sucursal.nombre} (ID={ums.sucursal_id}) | crear={ums.puede_crear} | leer={ums.puede_leer} | actualizar={ums.puede_actualizar}")

print("\n=== get_allowed_sucursal_ids para MOVIMIENTOS_ENTRADAS ===")
allowed = get_allowed_sucursal_ids(user8, RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS, action_key=("puede_crear", "puede_actualizar"))
print(f"  allowed = {allowed}")

print("\n=== _get_scoped_branch_action_index ===")
index = _get_scoped_branch_action_index(user8)
print(f"  index keys: {list(index.keys())}")
for k, v in index.items():
    print(f"  {k}: {v}")
