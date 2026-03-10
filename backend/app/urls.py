from django.urls import path
from . import views

urlpatterns = [
    path("ping/", views.ping),
    path("recordatorios/estado/", views.ReminderStateAPIView.as_view(), name="recordatorios-estado"),
    path(
        "recordatorios/inspeccion-aleatoria/actual/",
        views.RandomInspectionCurrentAPIView.as_view(),
        name="recordatorios-inspeccion-aleatoria-actual",
    ),
    path(
        "recordatorios/inspeccion-aleatoria/<int:inspection_id>/",
        views.RandomInspectionDetailAPIView.as_view(),
        name="recordatorios-inspeccion-aleatoria-detalle",
    ),
    path(
        "recordatorios/inspeccion-aleatoria/<int:inspection_id>/responder/",
        views.RandomInspectionRespondAPIView.as_view(),
        name="recordatorios-inspeccion-aleatoria-responder",
    ),
    path(
        "recordatorios/inspeccion-aleatoria/items/<int:item_id>/verificar/",
        views.RandomInspectionVerifyItemAPIView.as_view(),
        name="recordatorios-inspeccion-aleatoria-verificar",
    ),
]
