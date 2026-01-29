from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.contrib.auth.models import Group, Permission


User = get_user_model()


try:
    admin.site.unregister(User)
except admin.sites.NotRegistered:
    pass


class UserAdmin(DjangoUserAdmin):
    list_display = (
        "username",
        "email",
        "first_name",
        "last_name",
        "is_active",
        "is_staff",
        "is_superuser",
    )
    list_filter = ("is_active", "is_staff", "is_superuser")
    search_fields = ("username", "email", "first_name", "last_name")


admin.site.register(User, UserAdmin)


# ---- Ocultar grupos/permisos del admin nativo de Django ----

try:
    admin.site.unregister(Group)
except admin.sites.NotRegistered:
    pass

try:
    admin.site.unregister(Permission)
except admin.sites.NotRegistered:
    pass
