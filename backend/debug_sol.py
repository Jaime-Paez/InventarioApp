import django, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from movimientos.models import SolicitudTraslado, MovimientoInventario
from usuarios.models import UsuarioSucursal
from django.contrib.auth import get_user_model
Usuario = get_user_model()

sol = SolicitudTraslado.objects.select_related(
    "sucursal_solicitante", "sucursal_proveedora",
    "movimiento_salida", "movimiento_entrada",
    "movimiento_salida__estado_movimiento",
    "movimiento_entrada__estado_movimiento",
).get(pk=170)

print(f"Solicitud: {sol.no_documento} | Estado: {sol.estado}")
print(f"  Solicitante (RECIBE): {sol.sucursal_solicitante.nombre} (ID={sol.sucursal_solicitante_id})")
print(f"  Proveedora  (ENVIA):  {sol.sucursal_proveedora.nombre} (ID={sol.sucursal_proveedora_id})")
print(f"  Movimiento Salida:  ID={sol.movimiento_salida_id}, Estado={sol.movimiento_salida.estado_movimiento.nombre if sol.movimiento_salida else '-'}")
print(f"  Movimiento Entrada: ID={sol.movimiento_entrada_id}, Estado={sol.movimiento_entrada.estado_movimiento.nombre if sol.movimiento_entrada else '-'}")

print("\n=== Usuarios asignados a cada sucursal ===")
for sucursal_id, nombre in [(sol.sucursal_solicitante_id, sol.sucursal_solicitante.nombre), (sol.sucursal_proveedora_id, sol.sucursal_proveedora.nombre)]:
    users = UsuarioSucursal.objects.filter(sucursal_id=sucursal_id).select_related("usuario")
    print(f"\n  Sucursal '{nombre}' (ID={sucursal_id}):")
    for us in users:
        print(f"    User ID={us.usuario_id} | {us.usuario.get_full_name() or us.usuario.email} | staff={us.usuario.is_staff}")

print("\n=== Usuario 8 asignaciones ===")
assignments = UsuarioSucursal.objects.filter(usuario_id=8).select_related("sucursal")
for a in assignments:
    print(f"  Sucursal: {a.sucursal.nombre} (ID={a.sucursal_id})")
