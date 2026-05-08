import django, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from movimientos.models import SolicitudTraslado, TrasladoInconveniente, MovimientoInventario
from app.models import ReminderState

print("=== SOLICITUDES DE TRASLADO RECIENTES ===")
solicitudes = SolicitudTraslado.objects.select_related(
    "movimiento_salida", "movimiento_entrada",
    "sucursal_solicitante", "sucursal_proveedora",
).order_by("-id")[:10]

for s in solicitudes:
    m_salida = getattr(s, "movimiento_salida", None)
    m_entrada = getattr(s, "movimiento_entrada", None)
    inconvenientes = s.inconvenientes.all()
    print(f"\n  Solicitud ID={s.id} | Doc={s.no_documento} | Estado={s.estado}")
    print(f"    Salida ID={m_salida.id if m_salida else '-'} | Doc={getattr(m_salida,'no_documento','-')} | Estado={getattr(getattr(m_salida,'estado_movimiento',None),'nombre','-') if m_salida else '-'}")
    print(f"    Entrada ID={m_entrada.id if m_entrada else '-'} | Doc={getattr(m_entrada,'no_documento','-')} | Estado={getattr(getattr(m_entrada,'estado_movimiento',None),'nombre','-') if m_entrada else '-'}")
    if inconvenientes:
        for inc in inconvenientes:
            print(f"    Inconveniente ID={inc.id} | Producto={inc.producto.codigo} | Estado={inc.estado}")
    else:
        print("    Sin inconvenientes")

print("\n=== REMINDERS ACTUALES ===")
store = ReminderState.objects.first()
if store and isinstance(store.payload, list):
    for item in store.payload:
        print(f"  kind={item.get('kind')} | context={item.get('context', {}).get('type')} | solicitud_id={item.get('context', {}).get('solicitud_id')}")
else:
    print("  (vacío)")
