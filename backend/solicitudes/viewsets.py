from django.db import transaction
from django.db.models import Case, CharField, Count, Q, Value, When
from django.db.models.functions import Coalesce, Concat
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.table_filters import apply_column_filters, parse_column_filters
from inventario.models import Sucursal
from usuarios.models import RolPermiso
from usuarios.permissions import ClientesModulePermission, SolicitudesModulePermission
from usuarios.sucursal_scope import apply_sucursal_scope, ensure_sucursal_allowed

from .models import Cliente, OEMProductoSolicitado, ProductoSolicitado, Solicitud
from .serializers import (
    ClienteSerializer,
    ClienteLiteSerializer,
    OEMProductoSolicitadoSerializer,
    ProductoSolicitadoSerializer,
    SolicitudSerializer,
)


class ClienteViewSet(viewsets.ModelViewSet):
    queryset = Cliente.objects.all().order_by("nombres", "apellidos")
    serializer_class = ClienteSerializer
    permission_classes = [IsAuthenticated, ClientesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombres", "apellidos", "correo", "telefono", "cedula_ruc", "direccion"]
    ordering_fields = [
        "nombres",
        "apellidos",
        "correo",
        "telefono",
        "cedula_ruc",
        "direccion",
        "autos_count_backend",
    ]

    def get_queryset(self):
        queryset = super().get_queryset().annotate(autos_count_backend=Count("autos", distinct=True))
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

        queryset = apply_column_filters(
            queryset,
            parse_column_filters(params.get("column_filters")),
            {
                "nombres": "nombres",
                "apellidos": "apellidos",
                "cedula_ruc": "cedula_ruc",
                "correo": "correo",
                "telefono": "telefono",
                "direccion": "direccion",
                "autos_count": {"lookup": "autos_count_backend", "type": "number"},
            },
        )

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
            "producto_solicitado__producto",
        )
        .all()
        .order_by("-fecha", "id")
    )
    serializer_class = SolicitudSerializer
    permission_classes = [IsAuthenticated, SolicitudesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "descripcion_general",
        "cliente__nombres",
        "cliente__apellidos",
        "cliente__cedula_ruc",
        "producto__nombre",
        "producto_solicitado__nombre",
        "producto_solicitado__descripcion",
        "sucursal__nombre",
    ]
    ordering_fields = [
        "fecha",
        "cantidad",
        "cliente__nombres",
        "cliente__apellidos",
        "cliente__cedula_ruc",
        "sucursal__nombre",
        "producto_referencia_text",
        "producto_solicitado_descripcion_text",
        "descripcion_general",
        "producto_conseguido_text",
        "conseguido_label_text",
        "cliente_nombre_text",
    ]

    def get_queryset(self):
        queryset = super().get_queryset().annotate(
            cliente_nombre_text=Concat(
                Coalesce("cliente__nombres", Value("")),
                Value(" "),
                Coalesce("cliente__apellidos", Value("")),
                output_field=CharField(),
            ),
            producto_referencia_text=Coalesce("producto_solicitado__nombre", "producto__nombre", Value("")),
            producto_solicitado_descripcion_text=Coalesce("producto_solicitado__descripcion", Value("")),
            producto_conseguido_text=Concat(
                Coalesce("producto_solicitado__producto__codigo", Value("")),
                Value(" "),
                Coalesce("producto_solicitado__producto__nombre", Value("")),
                output_field=CharField(),
            ),
            conseguido_label_text=Case(
                When(tabla=Solicitud.Tabla.PRODUCTO, then=Value("Si")),
                When(producto_solicitado__conseguido=True, then=Value("Si")),
                default=Value("No"),
                output_field=CharField(),
            ),
        )
        queryset = apply_sucursal_scope(
            queryset,
            self.request.user,
            RolPermiso.Modulos.SOLICITUDES,
            "sucursal_id",
        )

        params = self.request.query_params

        tabla = (params.get("tabla") or "").strip()
        if tabla in {Solicitud.Tabla.PRODUCTO, Solicitud.Tabla.PRODUCTO_SOLICITADO}:
            queryset = queryset.filter(tabla=tabla)

        sucursal_id = (params.get("sucursal_id") or "").strip()
        if sucursal_id:
            queryset = queryset.filter(sucursal_id=sucursal_id)

        cliente_id = (params.get("cliente_id") or "").strip()
        if cliente_id:
            queryset = queryset.filter(cliente_id=cliente_id)

        cedula_ruc = (params.get("cedula_ruc") or "").strip()
        if cedula_ruc:
            queryset = queryset.filter(cliente__cedula_ruc__icontains=cedula_ruc)

        fecha_desde = parse_date((params.get("fecha_desde") or "").strip())
        if fecha_desde:
            queryset = queryset.filter(fecha__gte=fecha_desde)

        fecha_hasta = parse_date((params.get("fecha_hasta") or "").strip())
        if fecha_hasta:
            queryset = queryset.filter(fecha__lte=fecha_hasta)

        conseguido = self._parse_bool_param(params.get("conseguido"))
        if conseguido is True:
            queryset = queryset.filter(
                Q(tabla=Solicitud.Tabla.PRODUCTO)
                | Q(
                    tabla=Solicitud.Tabla.PRODUCTO_SOLICITADO,
                    producto_solicitado__conseguido=True,
                )
            )
        elif conseguido is False:
            queryset = queryset.filter(
                tabla=Solicitud.Tabla.PRODUCTO_SOLICITADO,
                producto_solicitado__conseguido=False,
            )

        queryset = apply_column_filters(
            queryset,
            parse_column_filters(params.get("column_filters")),
            {
                "fecha": {"lookup": "fecha", "type": "date"},
                "cliente_nombre": "cliente_nombre_text",
                "cedula_ruc": "cliente__cedula_ruc",
                "sucursal_nombre": "sucursal__nombre",
                "producto_solicitado_nombre": "producto_referencia_text",
                "producto_solicitado_descripcion": "producto_solicitado_descripcion_text",
                "descripcion_general": "descripcion_general",
                "producto_conseguido": "producto_conseguido_text",
                "cantidad": {"lookup": "cantidad", "type": "number"},
                "conseguido_label": "conseguido_label_text",
            },
        )

        return queryset

    def perform_create(self, serializer):
        sucursal = serializer.validated_data.get("sucursal")
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SOLICITUDES,
            getattr(sucursal, "id", None),
        )
        serializer.save(fecha=timezone.localdate())

    def perform_update(self, serializer):
        sucursal = serializer.validated_data.get("sucursal", serializer.instance.sucursal)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SOLICITUDES,
            getattr(sucursal, "id", None),
        )
        serializer.save()

    def update(self, request, *args, **kwargs):
        return Response(
            {"detail": "Una solicitud creada no se puede editar."},
            status=status.HTTP_405_METHOD_NOT_ALLOWED,
        )

    def partial_update(self, request, *args, **kwargs):
        return Response(
            {"detail": "Una solicitud creada no se puede editar."},
            status=status.HTTP_405_METHOD_NOT_ALLOWED,
        )

    @action(detail=False, methods=["get"], url_path="buscar-cliente")
    def buscar_cliente(self, request):
        raw_query = (
            request.query_params.get("q")
            or request.query_params.get("search")
            or request.query_params.get("cedula_ruc")
            or ""
        )
        query = str(raw_query).strip()
        if not query:
            return Response({"results": []}, status=status.HTTP_200_OK)

        tokens = [token for token in query.split() if token]
        search_q = Q(cedula_ruc__icontains=query)
        if tokens:
            for token in tokens:
                search_q |= Q(nombres__icontains=token) | Q(apellidos__icontains=token)
        else:
            search_q |= Q(nombres__icontains=query) | Q(apellidos__icontains=query)

        queryset = Cliente.objects.filter(search_q).order_by("nombres", "apellidos").distinct()[:10]
        serializer = ClienteLiteSerializer(queryset, many=True)
        return Response({"results": serializer.data}, status=status.HTTP_200_OK)

    @action(detail=False, methods=["post"], url_path="crear-lote")
    def crear_lote(self, request):
        payload = request.data or {}

        sucursal_id = payload.get("sucursal_id")
        if not sucursal_id:
            return Response(
                {"sucursal_id": "Debe seleccionar una sucursal."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        sucursal = Sucursal.objects.filter(pk=sucursal_id).first()
        if not sucursal:
            return Response(
                {"sucursal_id": "Sucursal no encontrada."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ensure_sucursal_allowed(
            request.user,
            RolPermiso.Modulos.SOLICITUDES,
            getattr(sucursal, "id", None),
        )

        fecha = timezone.localdate()
        descripcion_general = str(payload.get("descripcion_general") or "").strip()

        cliente, cliente_error = self._resolve_cliente(payload)
        if cliente_error:
            return Response(cliente_error, status=status.HTTP_400_BAD_REQUEST)

        productos_raw = payload.get("productos")
        if not isinstance(productos_raw, list) or not productos_raw:
            return Response(
                {"productos": "Debe agregar al menos un producto solicitado."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        productos_normalizados = []
        for index, item in enumerate(productos_raw):
            if not isinstance(item, dict):
                return Response(
                    {"productos": f"Elemento invalido en la posicion {index + 1}."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            nombre = str(item.get("nombre") or "").strip()
            if not nombre:
                return Response(
                    {"productos": f"El nombre es obligatorio en la fila {index + 1}."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            descripcion = str(item.get("descripcion") or "").strip()
            cantidad_raw = item.get("cantidad", 1)
            try:
                cantidad = int(cantidad_raw)
            except (TypeError, ValueError):
                return Response(
                    {"productos": f"La cantidad de la fila {index + 1} es invalida."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if cantidad <= 0:
                return Response(
                    {"productos": f"La cantidad de la fila {index + 1} debe ser mayor a 0."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            productos_normalizados.append(
                {
                    "nombre": nombre,
                    "descripcion": descripcion,
                    "cantidad": cantidad,
                }
            )

        with transaction.atomic():
            solicitudes = []
            for item in productos_normalizados:
                producto_solicitado = ProductoSolicitado.objects.create(
                    nombre=item["nombre"],
                    descripcion=item["descripcion"],
                )
                solicitud = Solicitud.objects.create(
                    cantidad=item["cantidad"],
                    tabla=Solicitud.Tabla.PRODUCTO_SOLICITADO,
                    fecha=fecha,
                    descripcion_general=descripcion_general,
                    sucursal=sucursal,
                    cliente=cliente,
                    producto_solicitado=producto_solicitado,
                )
                solicitudes.append(solicitud)

        serializer = self.get_serializer(solicitudes, many=True)
        return Response(
            {"count": len(solicitudes), "results": serializer.data},
            status=status.HTTP_201_CREATED,
        )

    @staticmethod
    def _parse_bool_param(raw_value):
        if raw_value is None:
            return None
        value = str(raw_value).strip().lower()
        if value in {"1", "true", "t", "si", "yes"}:
            return True
        if value in {"0", "false", "f", "no"}:
            return False
        return None

    def _resolve_cliente(self, payload):
        cliente_id = payload.get("cliente_id")
        if cliente_id:
            cliente = Cliente.objects.filter(pk=cliente_id).first()
            if not cliente:
                return None, {"cliente_id": "Cliente no encontrado."}
            return cliente, None

        cliente_data = payload.get("cliente") or {}
        if not isinstance(cliente_data, dict):
            return None, {"cliente": "Formato de cliente invalido."}

        cedula_ruc = str(cliente_data.get("cedula_ruc") or "").strip()
        if cedula_ruc:
            cliente_existente = Cliente.objects.filter(cedula_ruc__iexact=cedula_ruc).first()
            if cliente_existente:
                return cliente_existente, None

        nombres = str(cliente_data.get("nombres") or "").strip()
        apellidos = str(cliente_data.get("apellidos") or "").strip()
        correo = str(cliente_data.get("correo") or "").strip()
        telefono = str(cliente_data.get("telefono") or "").strip()
        direccion = str(cliente_data.get("direccion") or "").strip()

        if not nombres:
            return None, {"cliente": "Debe definir los nombres del cliente."}

        cliente = Cliente.objects.create(
            nombres=nombres,
            apellidos=apellidos,
            correo=correo,
            telefono=telefono,
            direccion=direccion,
            cedula_ruc=cedula_ruc,
        )
        return cliente, None
