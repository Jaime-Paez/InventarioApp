from rest_framework import filters, viewsets
from rest_framework.permissions import IsAuthenticated

from usuarios.permissions import ProveedoresMarcasModulePermission

from .models import Marca
from .serializers import MarcaSerializer


class MarcaViewSet(viewsets.ModelViewSet):
    queryset = Marca.objects.all().order_by("nombre")
    serializer_class = MarcaSerializer
    permission_classes = [IsAuthenticated, ProveedoresMarcasModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]
