import django, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from app.models import ReminderState

TRANSFER_ISSUE_KIND = "solicitud_traslado_inconveniente"
TRANSFER_ISSUE_CONTEXT = "traslado_inconveniente"

from django.db import transaction

with transaction.atomic():
    store = ReminderState.get_global(for_update=True)
    payload = store.payload if isinstance(store.payload, list) else []

    before = len(payload)
    cleaned = [
        item for item in payload
        if not (
            item.get("kind") == TRANSFER_ISSUE_KIND
            or (isinstance(item.get("context"), dict) and item["context"].get("type") == TRANSFER_ISSUE_CONTEXT)
        )
    ]
    removed = before - len(cleaned)

    if removed:
        store.payload = cleaned
        store.save(update_fields=["payload", "updated_at"])
        print(f"Eliminados {removed} reminder(s) de inconveniente de traslado.")
    else:
        print("No habia reminders de inconveniente de traslado.")
