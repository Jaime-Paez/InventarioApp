from rest_framework import filters, viewsets
from rest_framework.permissions import IsAuthenticated

from usuarios.permissions import MovimientoInventarioModulePermission

from .models import MovimientoInventario
from .serializers import MovimientoInventarioSerializer


class MovimientoInventarioViewSet(viewsets.ModelViewSet):
    """Gestión de movimientos de inventario."""

    queryset = (
        MovimientoInventario.objects.select_related(
            "sucursal",
            "sucursal_objetivo",
            "tipo_movimiento",
            "sub_tipo_movimiento",
            "estado_movimiento",
        )
        .prefetch_related(
            "detalles__producto",
            "detalles__estado_producto",
            "pagos__tipo_pago",
        )
        .all()
        .order_by("-fecha", "no_documento")
    )
    serializer_class = MovimientoInventarioSerializer
    permission_classes = [IsAuthenticated, MovimientoInventarioModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "no_documento",
        "sucursal__nombre",
        "sucursal_objetivo__nombre",
    ]
    ordering_fields = ["fecha", "no_documento"]
