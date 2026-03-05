from django.db import models


class ReminderState(models.Model):
    """
    Global storage for reminder payloads.

    The frontend keeps a full reminder list shape and syncs it here so that
    reminders survive browser restarts and new sessions in deployed environments.
    """

    GLOBAL_KEY = "global"

    key = models.CharField(max_length=50, unique=True, default=GLOBAL_KEY)
    payload = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Reminder state"
        verbose_name_plural = "Reminder states"

    def __str__(self) -> str:
        return f"ReminderState<{self.key}>"

    @classmethod
    def get_global(cls, *, for_update=False):
        queryset = cls.objects
        if for_update:
            queryset = queryset.select_for_update()
        instance, _ = queryset.get_or_create(
            key=cls.GLOBAL_KEY,
            defaults={"payload": []},
        )
        return instance
