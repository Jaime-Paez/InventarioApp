from rest_framework import filters, viewsets

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
    queryset = Pais.objects.all().order_by("nombre")
    serializer_class = PaisSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "codigo_tais"]
    ordering_fields = ["nombre", "codigo_tais"]


class TipoMovimientoViewSet(viewsets.ModelViewSet):
    queryset = TipoMovimiento.objects.all().order_by("nombre")
    serializer_class = TipoMovimientoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class SubTipoMovimientoViewSet(viewsets.ModelViewSet):
    queryset = (
        SubTipoMovimiento.objects.select_related("tipo_movimiento")
        .all()
        .order_by("tipo_movimiento__nombre", "nombre")
    )
    serializer_class = SubTipoMovimientoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "tipo_movimiento__nombre"]
    ordering_fields = ["nombre", "tipo_movimiento__nombre"]


class EstadoMovimientoViewSet(viewsets.ModelViewSet):
    queryset = EstadoMovimiento.objects.all().order_by("nombre")
    serializer_class = EstadoMovimientoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class EstadoProductoViewSet(viewsets.ModelViewSet):
    queryset = EstadoProducto.objects.all().order_by("nombre")
    serializer_class = EstadoProductoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class TipoPagoViewSet(viewsets.ModelViewSet):
    queryset = TipoPago.objects.all().order_by("nombre")
    serializer_class = TipoPagoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class TipoDivisionViewSet(viewsets.ModelViewSet):
    queryset = TipoDivision.objects.all().order_by("nombre")
    serializer_class = TipoDivisionSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]
