from rest_framework import filters, viewsets

from salidas.models import Salida, SalidaDetalle
from salidas.serializers import SalidaDetalleSerializer, SalidaSerializer


class SalidaViewSet(viewsets.ModelViewSet):
    queryset = (
        Salida.objects.select_related(
            "sucursal_origen",
            "sucursal_destino",
            "responsable",
        )
        .prefetch_related("detalles__producto")
        .all()
    )
    serializer_class = SalidaSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "folio",
        "observaciones",
        "sucursal_origen__nombre",
        "sucursal_destino__nombre",
        "responsable__nombre",
    ]
    ordering_fields = ["fecha", "folio"]
    ordering = ["-fecha", "folio"]

    def get_queryset(self):
        queryset = super().get_queryset()
        sucursal = self.request.query_params.get("sucursal")
        if sucursal:
            queryset = queryset.filter(sucursal_origen_id=sucursal)
        destino = self.request.query_params.get("sucursal_destino")
        if destino:
            queryset = queryset.filter(sucursal_destino_id=destino)
        tipo = self.request.query_params.get("tipo")
        if tipo:
            queryset = queryset.filter(tipo=tipo)
        fecha_desde = self.request.query_params.get("fecha_desde")
        if fecha_desde:
            queryset = queryset.filter(fecha__gte=fecha_desde)
        fecha_hasta = self.request.query_params.get("fecha_hasta")
        if fecha_hasta:
            queryset = queryset.filter(fecha__lte=fecha_hasta)
        return queryset


class SalidaSucursalViewSet(SalidaViewSet):
    def get_queryset(self):
        return super().get_queryset().filter(tipo="sucursal")


class SalidaDetalleViewSet(viewsets.ModelViewSet):
    queryset = SalidaDetalle.objects.select_related("salida", "producto").all()
    serializer_class = SalidaDetalleSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["salida__folio", "producto__nombre", "producto__sku"]
    ordering_fields = ["cantidad", "precio_unitario"]

    def get_queryset(self):
        queryset = super().get_queryset()
        salida = self.request.query_params.get("salida")
        if salida:
            queryset = queryset.filter(salida_id=salida)
        producto = self.request.query_params.get("producto")
        if producto:
            queryset = queryset.filter(producto_id=producto)
        return queryset
