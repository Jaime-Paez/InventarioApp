from django.contrib import admin
from django.urls import include, path

from app.routers import CustomRouter
from usuarios.viewsets import (
    LoginAPIView,
    PerfilAPIView,
    RegistroAPIView,
    UsuarioViewSet,
)

router = CustomRouter()

# Usuarios
router.register(r"usuarios/listado", UsuarioViewSet, basename="usuarios-listado")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("auth/register/", RegistroAPIView.as_view(), name="auth-register"),
    path("auth/login/", LoginAPIView.as_view(), name="auth-login"),
    path("auth/me/", PerfilAPIView.as_view(), name="auth-profile"),
    path("", include(router.urls)),
]
