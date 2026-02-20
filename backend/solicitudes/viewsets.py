from rest_framework import filters, viewsets
from rest_framework.permissions import IsAuthenticated

from usuarios.models import RolPermiso
from usuarios.permissions import ClientesModulePermission, SolicitudesModulePermission
from usuarios.sucursal_scope import apply_sucursal_scope, ensure_sucursal_allowed

from .models import Cliente, OEMProductoSolicitado, ProductoSolicitado, Solicitud
from .serializers import (
    ClienteSerializer,
    OEMProductoSolicitadoSerializer,
    ProductoSolicitadoSerializer,
    SolicitudSerializer,
)


class ClienteViewSet(viewsets.ModelViewSet):
    queryset = Cliente.objects.all().order_by("nombres", "apellidos")
    serializer_class = ClienteSerializer
    permission_classes = [IsAuthenticated, ClientesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombres", "apellidos", "correo", "telefono", "cedula_ruc"]
    ordering_fields = ["nombres", "apellidos", "correo", "telefono"]

    def get_queryset(self):
        queryset = super().get_queryset()
        params = self.request.query_params

        nombres = (params.get("nombres") or "").strip()
        if nombres:
            queryset = queryset.filter(nombres__icontains=nombres)

        apellidos = (params.get("apellidos") or "").strip()
        if apellidos:
            queryset = queryset.filter(apellidos__icontains=apellidos)

        cedula_ruc = (params.get("cedula_ruc") or "").strip()
        if cedula_ruc:
            queryset = queryset.filter(cedula_ruc__icontains=cedula_ruc)

        correo = (params.get("correo") or "").strip()
        if correo:
            queryset = queryset.filter(correo__icontains=correo)

        telefono = (params.get("telefono") or "").strip()
        if telefono:
            queryset = queryset.filter(telefono__icontains=telefono)

        direccion = (params.get("direccion") or "").strip()
        if direccion:
            queryset = queryset.filter(direccion__icontains=direccion)

        return queryset


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
        "cliente__nombres",
        "cliente__apellidos",
        "cliente__cedula_ruc",
        "producto__nombre",
        "producto_solicitado__nombre",
        "sucursal__nombre",
    ]
    ordering_fields = ["fecha", "cantidad", "cliente__nombres", "cliente__apellidos", "sucursal__nombre"]

    def get_queryset(self):
        queryset = super().get_queryset()
        return apply_sucursal_scope(
            queryset,
            self.request.user,
            RolPermiso.Modulos.SOLICITUDES,
            "sucursal_id",
        )

    def perform_create(self, serializer):
        sucursal = serializer.validated_data.get("sucursal")
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SOLICITUDES,
            getattr(sucursal, "id", None),
        )
        serializer.save()

    def perform_update(self, serializer):
        sucursal = serializer.validated_data.get("sucursal", serializer.instance.sucursal)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SOLICITUDES,
            getattr(sucursal, "id", None),
        )
        serializer.save()
