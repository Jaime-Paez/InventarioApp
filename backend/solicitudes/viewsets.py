from rest_framework import filters, viewsets
from rest_framework.permissions import IsAuthenticated

from usuarios.permissions import ClientesModulePermission, SolicitudesModulePermission

from .models import Cliente, OEMProductoSolicitado, ProductoSolicitado, Solicitud
from .serializers import (
    ClienteSerializer,
    OEMProductoSolicitadoSerializer,
    ProductoSolicitadoSerializer,
    SolicitudSerializer,
)


class ClienteViewSet(viewsets.ModelViewSet):
    queryset = Cliente.objects.all().order_by("nombre")
    serializer_class = ClienteSerializer
    permission_classes = [IsAuthenticated, ClientesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "correo", "telefono", "cedula_ruc"]
    ordering_fields = ["nombre", "correo", "telefono"]


class ProductoSolicitadoViewSet(viewsets.ModelViewSet):
    queryset = ProductoSolicitado.objects.select_related("producto").all().order_by("nombre")
    serializer_class = ProductoSolicitadoSerializer
    permission_classes = [IsAuthenticated, SolicitudesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "descripcion", "producto__nombre", "producto__codigo"]
    ordering_fields = ["nombre", "conseguido", "producto__nombre"]


class OEMProductoSolicitadoViewSet(viewsets.ModelViewSet):
    queryset = (
        OEMProductoSolicitado.objects.select_related("producto_solicitado", "oem")
        .all()
        .order_by("producto_solicitado__nombre", "oem__codigo")
    )
    serializer_class = OEMProductoSolicitadoSerializer
    permission_classes = [IsAuthenticated, SolicitudesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "producto_solicitado__nombre",
        "producto_solicitado__descripcion",
        "oem__codigo",
    ]
    ordering_fields = ["producto_solicitado__nombre", "oem__codigo"]


class SolicitudViewSet(viewsets.ModelViewSet):
    queryset = (
        Solicitud.objects.select_related(
            "cliente",
            "sucursal",
            "producto",
            "producto_solicitado",
        )
        .all()
        .order_by("-fecha", "id")
    )
    serializer_class = SolicitudSerializer
    permission_classes = [IsAuthenticated, SolicitudesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "cliente__nombre",
        "cliente__cedula_ruc",
        "producto__nombre",
        "producto_solicitado__nombre",
        "sucursal__nombre",
    ]
    ordering_fields = ["fecha", "cantidad", "cliente__nombre", "sucursal__nombre"]
