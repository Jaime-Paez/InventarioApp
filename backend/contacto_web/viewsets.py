from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from usuarios.permissions import ConfiguracionModulePermission

from .models import SolicitudWeb
from .serializers import SolicitudWebSerializer


class SolicitudWebViewSet(viewsets.ModelViewSet):
    """Lista de solicitudes recibidas por el formulario de contacto del sitio
    público. Solo administradores: se muestra dentro de Configuración. Solo
    lectura y marcar como leída — se crean únicamente desde ContactoWebAPIView.
    """

    queryset = SolicitudWeb.objects.all()
    serializer_class = SolicitudWebSerializer
    permission_classes = [ConfiguracionModulePermission]
    http_method_names = ["get", "patch", "head", "options"]

    @action(detail=False, methods=["get"], url_path="no-leidas")
    def no_leidas(self, request):
        count = self.get_queryset().filter(leido=False).count()
        return Response({"no_leidas": count})
