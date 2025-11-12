from rest_framework import filters, viewsets

from .models import (
    DetalleMovimiento,
    EstadoMovimiento,
    MovimientoInventario,
    PagoMovimiento,
    SubTipoMovimiento,
    TipoMovimiento,
    TipoPago,
)
from .serializers import (
    DetalleMovimientoSerializer,
    EstadoMovimientoSerializer,
    MovimientoInventarioSerializer,
    PagoMovimientoSerializer,
    SubTipoMovimientoSerializer,
    TipoMovimientoSerializer,
    TipoPagoSerializer,
)


class TipoPagoViewSet(viewsets.ModelViewSet):
    """Catálogo de tipos de pago."""

    queryset = TipoPago.objects.all().order_by("nombre")
    serializer_class = TipoPagoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class TipoMovimientoViewSet(viewsets.ModelViewSet):
    """Catálogo de tipos de movimiento."""

    queryset = TipoMovimiento.objects.all().order_by("nombre")
    serializer_class = TipoMovimientoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class EstadoMovimientoViewSet(viewsets.ModelViewSet):
    """Catálogo de estados para los movimientos."""

    queryset = EstadoMovimiento.objects.all().order_by("nombre")
    serializer_class = EstadoMovimientoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class SubTipoMovimientoViewSet(viewsets.ModelViewSet):
    """Catálogo de subtipos de movimiento."""

    queryset = (
        SubTipoMovimiento.objects.select_related("tipo_movimiento")
        .all()
        .order_by("tipo_movimiento__nombre", "nombre")
    )
    serializer_class = SubTipoMovimientoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "tipo_movimiento__nombre"]
    ordering_fields = ["nombre", "tipo_movimiento__nombre"]


class MovimientoInventarioViewSet(viewsets.ModelViewSet):
    """Gestión de movimientos de inventario."""

    queryset = (
        MovimientoInventario.objects.select_related(
            "subdivision",
            "subdivision__division",
            "subdivision__division__bodega",
            "subdivision__division__bodega__sucursal",
            "tipo_movimiento",
            "sub_tipo_movimiento",
            "estado",
            "tipo_pago",
        )
        .prefetch_related("detalles", "pagos")
        .all()
        .order_by("-fecha_documento", "numero_documento")
    )
    serializer_class = MovimientoInventarioSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "numero_documento",
        "subdivision__nombre",
        "subdivision__division__bodega__nombre",
        "subdivision__division__bodega__sucursal__nombre",
    ]
    ordering_fields = ["fecha_documento", "numero_documento"]


class DetalleMovimientoViewSet(viewsets.ModelViewSet):
    """Gestión de los detalles de movimiento."""

    queryset = (
        DetalleMovimiento.objects.select_related(
            "movimiento",
            "producto",
            "inventario",
            "inventario__subdivision",
            "inventario__subdivision__division",
            "inventario__subdivision__division__bodega",
            "inventario__subdivision__division__bodega__sucursal",
            "estado_producto",
        )
        .all()
        .order_by("movimiento__fecha_documento", "producto__nombre")
    )
    serializer_class = DetalleMovimientoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "movimiento__numero_documento",
        "producto__codigo",
        "producto__nombre",
    ]
    ordering_fields = ["movimiento__fecha_documento", "producto__nombre"]


class PagoMovimientoViewSet(viewsets.ModelViewSet):
    """Gestión de pagos relacionados a un movimiento de inventario."""

    queryset = (
        PagoMovimiento.objects.select_related("movimiento", "tipo_pago")
        .all()
        .order_by("-fecha_pago", "movimiento__numero_documento")
    )
    serializer_class = PagoMovimientoSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "movimiento__numero_documento",
        "tipo_pago__nombre",
        "referencia",
    ]
    ordering_fields = ["fecha_pago", "monto"]
