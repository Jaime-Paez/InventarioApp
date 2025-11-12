from rest_framework import filters, viewsets

from .models import Pais
from .serializers import PaisSerializer


class PaisViewSet(viewsets.ModelViewSet):
    queryset = Pais.objects.all().order_by("nombre")
    serializer_class = PaisSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "codigo_tais"]
    ordering_fields = ["nombre", "codigo_tais"]
