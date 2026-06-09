from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from usuarios.permissions import SolicitudesModulePermission

from .models import Importacion
from .serializers import ImportacionSerializer, generate_next_importacion_code


class ImportacionViewSet(viewsets.ModelViewSet):
    serializer_class = ImportacionSerializer
    permission_classes = [IsAuthenticated, SolicitudesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "codigo",
        "casa_comercial__nombre",
        "detalles__producto__codigo",
        "detalles__producto__nombre",
    ]
    ordering_fields = ["codigo", "fecha", "creado_en", "casa_comercial__nombre"]

    def get_queryset(self):
        queryset = (
            Importacion.objects.select_related("casa_comercial")
            .prefetch_related(
                "detalles",
                "detalles__producto",
                "detalles__producto__casas_comerciales",
                "detalles__producto__oem_productos__oem",
            )
            .all()
            .distinct()
        )
        estado = str(self.request.query_params.get("estado") or "").strip()
        if estado:
            queryset = queryset.filter(estado=estado)
        casa_comercial_id = str(self.request.query_params.get("casa_comercial_id") or "").strip()
        if casa_comercial_id:
            queryset = queryset.filter(casa_comercial_id=casa_comercial_id)
        return queryset

    @action(detail=False, methods=["get"], url_path="next-code")
    def next_code(self, request):
        from casa_comercial.models import CasaComercial
        casa_id = request.query_params.get("casa_id")
        casa = None
        if casa_id:
            try:
                casa = CasaComercial.objects.get(pk=casa_id)
            except CasaComercial.DoesNotExist:
                pass
        return Response({"codigo": generate_next_importacion_code(casa)}, status=status.HTTP_200_OK)
