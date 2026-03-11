from rest_framework import filters, viewsets
from rest_framework.permissions import IsAuthenticated

from usuarios.permissions import (
    BodegasModulePermission,
    EstadoProductoDependentReadPermission,
    MovimientosCatalogosPermission,
    ProveedoresCasasModulePermission,
)

from .models import (
    EstadoMovimiento,
    EstadoProducto,
    Pais,
    SubTipoMovimiento,
    TipoDivision,
    TipoMovimiento,
    TipoPago,
)
from .serializers import (
    EstadoMovimientoSerializer,
    EstadoProductoSerializer,
    PaisSerializer,
    SubTipoMovimientoSerializer,
    TipoDivisionSerializer,
    TipoMovimientoSerializer,
    TipoPagoSerializer,
)


class PaisViewSet(viewsets.ModelViewSet):
    queryset = Pais.objects.all().order_by("-id")
    serializer_class = PaisSerializer
    permission_classes = [IsAuthenticated, ProveedoresCasasModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "codigo_pais"]
    ordering_fields = ["nombre", "codigo_pais"]


class TipoMovimientoViewSet(viewsets.ModelViewSet):
    queryset = TipoMovimiento.objects.all().order_by("-id")
    serializer_class = TipoMovimientoSerializer
    permission_classes = [IsAuthenticated, MovimientosCatalogosPermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class SubTipoMovimientoViewSet(viewsets.ModelViewSet):
    queryset = (
        SubTipoMovimiento.objects.select_related("tipo_movimiento")
        .all()
        .order_by("-id")
    )
    serializer_class = SubTipoMovimientoSerializer
    permission_classes = [IsAuthenticated, MovimientosCatalogosPermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "tipo_movimiento__nombre"]
    ordering_fields = ["nombre", "tipo_movimiento__nombre"]


class EstadoMovimientoViewSet(viewsets.ModelViewSet):
    queryset = EstadoMovimiento.objects.all().order_by("-id")
    serializer_class = EstadoMovimientoSerializer
    permission_classes = [IsAuthenticated, MovimientosCatalogosPermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class EstadoProductoViewSet(viewsets.ModelViewSet):
    queryset = EstadoProducto.objects.all().order_by("-id")
    serializer_class = EstadoProductoSerializer
    permission_classes = [IsAuthenticated, EstadoProductoDependentReadPermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class TipoPagoViewSet(viewsets.ModelViewSet):
    queryset = TipoPago.objects.all().order_by("-id")
    serializer_class = TipoPagoSerializer
    permission_classes = [IsAuthenticated, MovimientosCatalogosPermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class TipoDivisionViewSet(viewsets.ModelViewSet):
    queryset = TipoDivision.objects.all().order_by("-id")
    serializer_class = TipoDivisionSerializer
    permission_classes = [IsAuthenticated, BodegasModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]
