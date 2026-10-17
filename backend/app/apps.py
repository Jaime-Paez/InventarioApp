from django.apps import AppConfig


class AppConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'app'

    def ready(self):
        from django.db.models.signals import post_save

        from .models import ReminderState
        from .views import invalidate_reminders_cache

        # El sondeo de recordatorios reutiliza su respuesta unos segundos:
        # cualquier guardado del estado global en este proceso la invalida.
        post_save.connect(
            invalidate_reminders_cache,
            sender=ReminderState,
            dispatch_uid="app.invalidate_reminders_cache",
        )
