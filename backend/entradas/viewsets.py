from rest_framework import filters, viewsets

from entradas.models import Entrada, EntradaDetalle
from entradas.serializers import EntradaDetalleSerializer, EntradaSerializer


class EntradaViewSet(viewsets.ModelViewSet):
    queryset = (
        Entrada.objects.select_related(
            "sucursal",
            "responsable",
            "tipo_compra",
            "tipo_pago",
        )
        .prefetch_related("detalles__producto")
        .all()
    )
    serializer_class = EntradaSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["folio", "observaciones", "sucursal__nombre", "responsable__nombre"]
    ordering_fields = ["fecha", "folio"]
    ordering = ["-fecha", "folio"]

    def get_queryset(self):
        queryset = super().get_queryset()
        sucursal = self.request.query_params.get("sucursal")
        if sucursal:
            queryset = queryset.filter(sucursal_id=sucursal)
        fecha_desde = self.request.query_params.get("fecha_desde")
        if fecha_desde:
            queryset = queryset.filter(fecha__gte=fecha_desde)
        fecha_hasta = self.request.query_params.get("fecha_hasta")
        if fecha_hasta:
            queryset = queryset.filter(fecha__lte=fecha_hasta)
        return queryset


class EntradaCompraViewSet(EntradaViewSet):
    def get_queryset(self):
        return super().get_queryset().filter(tipo="compra")


class EntradaDevolucionViewSet(EntradaViewSet):
    def get_queryset(self):
        return super().get_queryset().filter(tipo="devolucion")


class EntradaDetalleViewSet(viewsets.ModelViewSet):
    queryset = EntradaDetalle.objects.select_related("entrada", "producto").all()
    serializer_class = EntradaDetalleSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["entrada__folio", "producto__nombre", "producto__sku"]
    ordering_fields = ["cantidad", "costo_unitario"]

    def get_queryset(self):
        queryset = super().get_queryset()
        entrada = self.request.query_params.get("entrada")
        if entrada:
            queryset = queryset.filter(entrada_id=entrada)
        producto = self.request.query_params.get("producto")
        if producto:
            queryset = queryset.filter(producto_id=producto)
        return queryset
