from rest_framework import viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from usuarios.permissions import ConfiguracionModulePermission

from .models import ConfiguracionSistema
from .serializers import ConfiguracionSistemaSerializer


class ConfiguracionSistemaViewSet(viewsets.ModelViewSet):
    """API para configuracion global del sistema (singleton)."""

    serializer_class = ConfiguracionSistemaSerializer
    http_method_names = ["get", "put", "patch", "head", "options"]

    def get_permissions(self):
        if self.request.method in ("GET", "HEAD", "OPTIONS"):
            return [IsAuthenticated()]
        return [IsAuthenticated(), ConfiguracionModulePermission()]

    def get_queryset(self):
        return ConfiguracionSistema.objects.all()

    def get_object(self):
        obj = ConfiguracionSistema.get_solo()
        self.check_object_permissions(self.request, obj)
        return obj

    def list(self, request, *args, **kwargs):
        obj = self.get_object()
        serializer = self.get_serializer(obj)
        return Response(serializer.data)
