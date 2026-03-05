from django.contrib import admin

from .models import ReminderState


@admin.register(ReminderState)
class ReminderStateAdmin(admin.ModelAdmin):
    list_display = ("key", "updated_at", "created_at")
    readonly_fields = ("created_at", "updated_at")
    search_fields = ("key",)
