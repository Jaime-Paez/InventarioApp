import django, os, json
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from app.models import ReminderState
from movimientos.models import SolicitudTraslado

store = ReminderState.objects.first()
if not store or not isinstance(store.payload, list):
    print("Sin reminders.")
else:
    for i, item in enumerate(store.payload):
        print(f"\n--- Reminder #{i} ---")
        print(json.dumps(item, indent=2, default=str))
