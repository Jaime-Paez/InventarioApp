import django
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from django.db import transaction
from movimientos.models import SolicitudTraslado, MovimientoInventario
from app.models import ReminderState

with transaction.atomic():
    solicitudes = SolicitudTraslado.objects.all()
    total = solicitudes.count()

    if total == 0:
        print("No hay solicitudes de traslado. Nada que limpiar.")
    else:
        print(f"Solicitudes encontradas: {total}")
        for s in solicitudes:
            print(f"  #{s.id} | {s.sucursal_solicitante} → {s.sucursal_proveedora} | estado={s.estado} | salida={s.movimiento_salida_id} | entrada={s.movimiento_entrada_id}")

        salida_ids = list(
            solicitudes.exclude(movimiento_salida=None)
            .values_list('movimiento_salida_id', flat=True)
        )
        entrada_ids = list(
            solicitudes.exclude(movimiento_entrada=None)
            .values_list('movimiento_entrada_id', flat=True)
        )

        # Desvincular para poder borrar los movimientos (SET_NULL no es CASCADE)
        solicitudes.update(movimiento_salida=None, movimiento_entrada=None)

        # Borrar solicitudes (CASCADE elimina detalles e inconvenientes)
        n_sol, _ = SolicitudTraslado.objects.all().delete()
        print(f"Solicitudes eliminadas: {n_sol}")

        # Borrar movimientos vinculados
        all_mov_ids = list(set(salida_ids + entrada_ids))
        if all_mov_ids:
            n_mov, detail = MovimientoInventario.objects.filter(pk__in=all_mov_ids).delete()
            print(f"Movimientos eliminados: {n_mov} — {detail}")
        else:
            print("No habia movimientos vinculados.")

    # Limpiar reminders de traslado del ReminderState
    store = ReminderState.objects.select_for_update().first()
    if store and isinstance(store.payload, list):
        before = len(store.payload)
        store.payload = [
            item for item in store.payload
            if not (
                isinstance(item, dict) and
                isinstance(item.get("context"), dict) and
                item["context"].get("type") in {"solicitud_traslado", "traslado_inconveniente"}
            )
        ]
        removed = before - len(store.payload)
        store.save(update_fields=["payload", "updated_at"])
        print(f"Recordatorios de traslado eliminados: {removed} (quedan {len(store.payload)})")
    else:
        print("No hay ReminderState o ya está vacío.")

print("\n¡Listo! Base limpia para prueba desde cero.")
