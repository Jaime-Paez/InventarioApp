import django, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from django.db import transaction
from movimientos.models import SolicitudTraslado, TrasladoInconveniente, MovimientoInventario
from app.models import ReminderState

SOLICITUD_ID = 169
SALIDA_ID = 207081
ENTRADA_ID = 207082

with transaction.atomic():
    # Borrar inconvenientes
    inc_deleted, _ = TrasladoInconveniente.objects.filter(solicitud_id=SOLICITUD_ID).delete()
    print(f"Inconvenientes eliminados: {inc_deleted}")

    # Borrar solicitud (primero para liberar FK)
    sol_deleted, _ = SolicitudTraslado.objects.filter(pk=SOLICITUD_ID).delete()
    print(f"Solicitud eliminada: {sol_deleted}")

    # Borrar movimientos
    m_deleted, _ = MovimientoInventario.objects.filter(pk__in=[SALIDA_ID, ENTRADA_ID]).delete()
    print(f"Movimientos eliminados: {m_deleted}")

    # Limpiar reminders relacionados a esta solicitud
    store = ReminderState.objects.select_for_update().first()
    if store and isinstance(store.payload, list):
        before = len(store.payload)
        cleaned = [
            item for item in store.payload
            if not (
                str(item.get("context", {}).get("solicitud_id", "")) == str(SOLICITUD_ID)
                or item.get("context", {}).get("type") in {"solicitud_traslado", "traslado_inconveniente"}
            )
        ]
        removed = before - len(cleaned)
        if removed:
            store.payload = cleaned
            store.save(update_fields=["payload", "updated_at"])
            print(f"Reminders eliminados: {removed}")
        else:
            print("No habia reminders asociados a esta solicitud.")
    else:
        print("No hay reminders.")

print("Limpieza completa.")
