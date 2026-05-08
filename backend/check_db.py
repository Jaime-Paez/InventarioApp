import django, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from django.apps import apps
from movimientos.models import MovimientoInventario, SolicitudTraslado

ReminderState = next((m for m in apps.get_models() if m.__name__ == "ReminderState"), None)

print("=== ESTADO DB ===")
solicitudes = SolicitudTraslado.objects.select_related("sucursal_solicitante", "sucursal_proveedora").all()
print(f"SolicitudTraslado: {solicitudes.count()}")
for st in solicitudes:
    print(f"  #{st.no_documento} | estado={st.estado}")
    print(f"    Proveedora (envia): {st.sucursal_proveedora}")
    print(f"    Solicitante (recibe): {st.sucursal_solicitante}")
    print(f"    salida_id={st.movimiento_salida_id} | entrada_id={st.movimiento_entrada_id}")

movimientos = MovimientoInventario.objects.select_related(
    "tipo_movimiento", "sub_tipo_movimiento", "estado_movimiento", "sucursal"
).all()
print(f"\nMovimientoInventario: {movimientos.count()}")
for mi in movimientos:
    print(f"  #{mi.no_documento} | {mi.tipo_movimiento} / {mi.sub_tipo_movimiento} | estado={mi.estado_movimiento} | sucursal={mi.sucursal}")

if ReminderState:
    print("\nReminderState:")
    for rs in ReminderState.objects.all():
        payload = rs.payload if isinstance(rs.payload, list) else []
        user_ref = getattr(rs, "user_id", getattr(rs, "usuario_id", rs.pk))
        print(f"  ref={user_ref} | items={len(payload)}")
        for item in payload:
            kind = item.get("kind", "?")
            desc = str(item.get("description", ""))[:80]
            print(f"    [{kind}] {desc}")
