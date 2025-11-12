from rest_framework import filters, viewsets

from .models import Marca
from .serializers import MarcaSerializer


class MarcaViewSet(viewsets.ModelViewSet):
    queryset = Marca.objects.all().order_by("nombre")
    serializer_class = MarcaSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]
