from django.urls import path
from . import views
from auditoria.views import AuditoriaListAPIView

urlpatterns = [
    path("auditoria/registros/", AuditoriaListAPIView.as_view(), name="auditoria-registros"),
    path("ping/", views.ping),
    path(
        "usuarios/preferencias/table-layouts/",
        views.UserTableLayoutsAPIView.as_view(),
        name="usuarios-preferencias-table-layouts",
    ),
    path("recordatorios/estado/", views.ReminderStateAPIView.as_view(), name="recordatorios-estado"),
    path(
        "recordatorios/inspeccion-aleatoria/configuracion/",
        views.RandomInspectionConfigAPIView.as_view(),
        name="recordatorios-inspeccion-aleatoria-configuracion",
    ),
    path(
        "recordatorios/inspeccion-aleatoria/enviar-ahora/",
        views.RandomInspectionSendNowAPIView.as_view(),
        name="recordatorios-inspeccion-aleatoria-enviar-ahora",
    ),
    path(
        "recordatorios/inspeccion-aleatoria/admin/resumen/",
        views.RandomInspectionAdminSummaryAPIView.as_view(),
        name="recordatorios-inspeccion-aleatoria-admin-resumen",
    ),
    path(
        "recordatorios/inspeccion-aleatoria/admin/items/",
        views.RandomInspectionAdminItemsAPIView.as_view(),
        name="recordatorios-inspeccion-aleatoria-admin-items",
    ),
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
        "recordatorios/inspeccion-aleatoria/<int:inspection_id>/borrador/",
        views.RandomInspectionSaveDraftAPIView.as_view(),
        name="recordatorios-inspeccion-aleatoria-borrador",
    ),
    path(
        "recordatorios/inspeccion-aleatoria/items/<int:item_id>/verificar/",
        views.RandomInspectionVerifyItemAPIView.as_view(),
        name="recordatorios-inspeccion-aleatoria-verificar",
    ),
]
