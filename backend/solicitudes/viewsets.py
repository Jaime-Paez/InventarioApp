from django.db import transaction
from django.db.models import Case, CharField, Count, F, Q, Sum, TextField, Value, When
from django.db.models.functions import Coalesce, Concat
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.table_filters import apply_column_filters, parse_column_filters
from inventario.models import Inventario, Sucursal
from productos.models import OEM, Producto
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
    queryset = Cliente.objects.all().order_by("-id")
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
    queryset = ProductoSolicitado.objects.select_related("producto").all().order_by("-id")
    serializer_class = ProductoSolicitadoSerializer
    permission_classes = [IsAuthenticated, SolicitudesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "descripcion", "producto__nombre", "producto__codigo"]
    ordering_fields = ["nombre", "conseguido", "producto__nombre"]


class OEMProductoSolicitadoViewSet(viewsets.ModelViewSet):
    queryset = (
        OEMProductoSolicitado.objects.select_related("producto_solicitado", "oem")
        .all()
        .order_by("-id")
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
        .prefetch_related("producto_solicitado__oem_relaciones__oem")
        .all()
        .order_by("-fecha", "-id")
    )
    serializer_class = SolicitudSerializer
    permission_classes = [IsAuthenticated, SolicitudesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
            "descripcion_general",
            "comentario",
            "cliente__nombres",
            "cliente__apellidos",
            "cliente__cedula_ruc",
            "producto__nombre",
            "producto__codigo",
            "producto_solicitado__nombre",
            "producto_solicitado__codigo",
            "producto_solicitado__marca",
            "producto_solicitado__descripcion",
            "producto_solicitado__oem_relaciones__oem__codigo",
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
            producto_solicitado_descripcion_text=Coalesce(
                "producto_solicitado__descripcion",
                Value("", output_field=TextField()),
                output_field=TextField(),
            ),
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
            action_key="puede_leer",
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
            action_key="puede_crear",
        )
        serializer.save(fecha=timezone.localdate())

    def perform_update(self, serializer):
        sucursal = serializer.validated_data.get("sucursal", serializer.instance.sucursal)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SOLICITUDES,
            getattr(sucursal, "id", None),
            action_key="puede_actualizar",
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

    @action(detail=False, methods=["get"], url_path="stock-producto")
    def stock_producto(self, request):
        raw_producto_id = request.query_params.get("producto_id")
        try:
            producto_id = int(raw_producto_id)
        except (TypeError, ValueError):
            return Response(
                {"producto_id": "Debe enviar un producto_id valido."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not Producto.objects.filter(pk=producto_id).exists():
            return Response(
                {"producto_id": "Producto no encontrado."},
                status=status.HTTP_404_NOT_FOUND,
            )

        sucursales_stock = self._get_producto_stock_por_sucursal(producto_id)
        stock_total = sum(item.get("cantidad", 0) for item in sucursales_stock)
        return Response(
            {
                "producto_id": producto_id,
                "stock_total": stock_total,
                "tiene_stock": stock_total > 0,
                "sucursales_stock": sucursales_stock,
            },
            status=status.HTTP_200_OK,
        )

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
            action_key="puede_crear",
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
        producto_ids_en_lote = set()
        codigos_nuevos = set()
        oems_nuevos = set()
        for index, item in enumerate(productos_raw):
            if not isinstance(item, dict):
                return Response(
                    {"productos": f"Elemento invalido en la posicion {index + 1}."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

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

            comentario = str(item.get("comentario") or "").strip()
            producto_id = item.get("producto_id")

            if producto_id not in (None, ""):
                try:
                    producto_id = int(producto_id)
                except (TypeError, ValueError):
                    return Response(
                        {"productos": f"El producto de la fila {index + 1} es invalido."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                if producto_id in producto_ids_en_lote:
                    return Response(
                        {"productos": f"El producto de la fila {index + 1} ya esta en la tabla."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                producto = Producto.objects.filter(pk=producto_id).first()
                if not producto:
                    return Response(
                        {"productos": f"El producto de la fila {index + 1} no existe."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                sucursales_stock = self._get_producto_stock_por_sucursal(producto_id)
                stock_disponible = sum(item.get("cantidad", 0) for item in sucursales_stock)
                if stock_disponible > 0:
                    detalle_stock = self._format_stock_por_sucursal(sucursales_stock)
                    return Response(
                        {
                            "productos": (
                                f"Fila {index + 1}: no se puede solicitar '{producto.codigo}' porque "
                                f"tiene stock disponible ({stock_disponible}) en: {detalle_stock}."
                            )
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                producto_ids_en_lote.add(producto_id)
                productos_normalizados.append(
                    {
                        "tipo": Solicitud.Tabla.PRODUCTO,
                        "producto": producto,
                        "cantidad": cantidad,
                        "comentario": comentario,
                    }
                )
                continue

            nombre = str(item.get("nombre") or "").strip()
            if not nombre:
                return Response(
                    {"productos": f"El nombre es obligatorio en la fila {index + 1}."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            codigo = str(item.get("codigo") or "").strip()
            if not codigo:
                return Response(
                    {"productos": f"El codigo es obligatorio en la fila {index + 1}."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            marca = str(item.get("marca") or "").strip()
            if not marca:
                return Response(
                    {"productos": f"La marca es obligatoria en la fila {index + 1}."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            descripcion = str(item.get("descripcion") or "").strip()
            oem_codigos = self._parse_oem_codes(item.get("oems"))

            codigo_key = codigo.lower()
            if codigo_key in codigos_nuevos:
                return Response(
                    {"productos": f"Fila {index + 1}: ya existe este producto."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if Producto.objects.filter(codigo__iexact=codigo).exists():
                return Response(
                    {"productos": f"Fila {index + 1}: ya existe este producto."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            codigos_nuevos.add(codigo_key)

            for oem_codigo in oem_codigos:
                oem_key = oem_codigo.lower()
                if oem_key in oems_nuevos:
                    return Response(
                        {"productos": f"Fila {index + 1}: ya existe este producto."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if Producto.objects.filter(oem_productos__oem__codigo__iexact=oem_codigo).exists():
                    return Response(
                        {"productos": f"Fila {index + 1}: ya existe este producto."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                oems_nuevos.add(oem_key)

            productos_normalizados.append(
                {
                    "tipo": Solicitud.Tabla.PRODUCTO_SOLICITADO,
                    "codigo": codigo,
                    "nombre": nombre,
                    "marca": marca,
                    "descripcion": descripcion,
                    "oem_codigos": oem_codigos,
                    "cantidad": cantidad,
                    "comentario": comentario,
                }
            )

        with transaction.atomic():
            solicitudes = []
            for item in productos_normalizados:
                if item["tipo"] == Solicitud.Tabla.PRODUCTO:
                    solicitud = Solicitud.objects.create(
                        cantidad=item["cantidad"],
                        tabla=Solicitud.Tabla.PRODUCTO,
                        fecha=fecha,
                        descripcion_general=descripcion_general,
                        comentario=item.get("comentario", ""),
                        sucursal=sucursal,
                        cliente=cliente,
                        producto=item["producto"],
                    )
                else:
                    producto_solicitado = ProductoSolicitado.objects.create(
                        codigo=item["codigo"],
                        nombre=item["nombre"],
                        marca=item["marca"],
                        descripcion=item["descripcion"],
                    )
                    for oem_codigo in item.get("oem_codigos", []):
                        oem, _ = OEM.objects.get_or_create(
                            codigo=oem_codigo,
                            defaults={"descripcion": ""},
                        )
                        OEMProductoSolicitado.objects.get_or_create(
                            producto_solicitado=producto_solicitado,
                            oem=oem,
                        )

                    solicitud = Solicitud.objects.create(
                        cantidad=item["cantidad"],
                        tabla=Solicitud.Tabla.PRODUCTO_SOLICITADO,
                        fecha=fecha,
                        descripcion_general=descripcion_general,
                        comentario=item.get("comentario", ""),
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

    @staticmethod
    def _parse_oem_codes(raw_value):
        if isinstance(raw_value, list):
            raw_items = raw_value
        else:
            raw_items = str(raw_value or "").replace(";", ",").replace("\n", ",").split(",")

        codes = []
        seen = set()
        for value in raw_items:
            code = str(value or "").strip()
            if not code:
                continue
            key = code.lower()
            if key in seen:
                continue
            seen.add(key)
            codes.append(code)
        return codes

    @staticmethod
    def _get_producto_stock_total(producto_id):
        if not producto_id:
            return 0
        aggregated = (
            Inventario.objects.filter(
                producto_id=producto_id,
            ).aggregate(total=Coalesce(Sum("cantidad"), Value(0)))
        )
        return int(aggregated.get("total") or 0)

    @staticmethod
    def _get_producto_stock_por_sucursal(producto_id):
        if not producto_id:
            return []
        rows = (
            Inventario.objects.filter(producto_id=producto_id)
            .values(
                sucursal_id=F("subdivision__division__bodega__sucursal_id"),
                sucursal_nombre=F("subdivision__division__bodega__sucursal__nombre"),
            )
            .annotate(cantidad=Coalesce(Sum("cantidad"), Value(0)))
            .filter(cantidad__gt=0)
            .order_by("-cantidad", "sucursal_nombre")
        )
        return [
            {
                "sucursal_id": int(row.get("sucursal_id") or 0),
                "sucursal_nombre": str(row.get("sucursal_nombre") or "").strip(),
                "cantidad": int(row.get("cantidad") or 0),
            }
            for row in rows
            if int(row.get("cantidad") or 0) > 0
        ]

    @staticmethod
    def _format_stock_por_sucursal(sucursales_stock):
        partes = []
        for item in sucursales_stock:
            nombre = str(item.get("sucursal_nombre") or "Sucursal").strip() or "Sucursal"
            cantidad = int(item.get("cantidad") or 0)
            if cantidad <= 0:
                continue
            partes.append(f"{nombre}: {cantidad}")
        return ", ".join(partes) if partes else "inventario general"

    def _resolve_cliente(self, payload):
        cliente_id = payload.get("cliente_id")
        if cliente_id:
            cliente = Cliente.objects.filter(pk=cliente_id).first()
            if not cliente:
                return None, {"cliente_id": "Cliente no encontrado."}
            return cliente, None

        cliente_data = payload.get("cliente")
        if not isinstance(cliente_data, dict):
            return None, {"cliente": "Debe seleccionar o crear un cliente."}

        if not cliente_data:
            return None, {"cliente": "Debe seleccionar o crear un cliente."}

        cedula_ruc = str(cliente_data.get("cedula_ruc") or "").strip()
        nombres = str(cliente_data.get("nombres") or "").strip()
        apellidos = str(cliente_data.get("apellidos") or "").strip()
        correo = str(cliente_data.get("correo") or "").strip()
        telefono = str(cliente_data.get("telefono") or "").strip()
        direccion = str(cliente_data.get("direccion") or "").strip()

        missing_fields = []
        if not nombres:
            missing_fields.append("nombres")
        if not apellidos:
            missing_fields.append("apellidos")
        if not cedula_ruc:
            missing_fields.append("cedula/ruc")
        if not telefono:
            missing_fields.append("telefono")
        if not direccion:
            missing_fields.append("direccion")

        if missing_fields:
            return None, {"cliente": f"Faltan campos obligatorios del cliente: {', '.join(missing_fields)}."}

        if cedula_ruc:
            cliente_existente = Cliente.objects.filter(cedula_ruc__iexact=cedula_ruc).first()
            if cliente_existente:
                return cliente_existente, None

        cliente = Cliente.objects.create(
            nombres=nombres,
            apellidos=apellidos,
            correo=correo,
            telefono=telefono,
            direccion=direccion,
            cedula_ruc=cedula_ruc,
        )
        return cliente, None
