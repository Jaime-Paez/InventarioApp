from rest_framework import filters, viewsets

from .models import CasaComercial
from .serializers import CasaComercialSerializer


class CasaComercialViewSet(viewsets.ModelViewSet):
    queryset = CasaComercial.objects.select_related("pais").all().order_by("nombre")
    serializer_class = CasaComercialSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "codigo", "pais__nombre"]
    ordering_fields = ["nombre", "codigo", "pais__nombre"]
