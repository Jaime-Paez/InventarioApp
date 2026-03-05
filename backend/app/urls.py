from django.urls import path
from . import views

urlpatterns = [
    path("ping/", views.ping),
    path("recordatorios/estado/", views.ReminderStateAPIView.as_view(), name="recordatorios-estado"),
]
