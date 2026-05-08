import django, os, copy
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from app.models import ReminderState

SOLICITUD_ID = "170"
SUCURSAL_SOLICITANTE_ID = "3"   # Sur (receives)
SUCURSAL_PROVEEDORA_ID = "1"    # 9 de Octubre (sends)

store = ReminderState.objects.first()
if not store or not isinstance(store.payload, list):
    print("No reminder store found.")
else:
    payload_copy = copy.deepcopy(store.payload)
    updated = 0
    for item in payload_copy:
        ctx = item.get("context", {})
        if (
            str(ctx.get("type", "")) == "solicitud_traslado" and
            str(ctx.get("id", "")) == SOLICITUD_ID
        ):
            ctx["sucursal_solicitante_id"] = SUCURSAL_SOLICITANTE_ID
            ctx["sucursal_proveedora_id"] = SUCURSAL_PROVEEDORA_ID
            item["context"] = ctx
            updated += 1
            print(f"  Patched reminder ID={item.get('id')} decision={item.get('decision', {}).get('status')}")

    if updated:
        ReminderState.objects.filter(pk=store.pk).update(payload=payload_copy)
        print(f"Saved. {updated} reminder(s) updated.")
    else:
        print("No matching reminders found or all already patched.")
