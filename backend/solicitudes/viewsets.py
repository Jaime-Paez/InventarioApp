import uuid

from django.db import transaction
from django.db.models import CharField, Count, F, Q, Sum, Value
from django.db.models.functions import Coalesce, Concat
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.table_filters import apply_column_filters, parse_column_filters
from casa_comercial.models import CasaComercial
from inventario.models import Inventario, Sucursal
from productos.models import OEM, Producto
from usuarios.models import RolPermiso
from usuarios.permissions import ClientesModulePermission, SolicitudesModulePermission
from usuarios.sucursal_scope import apply_sucursal_scope, ensure_sucursal_allowed

from .models import Cliente, OEMProductoSolicitado, ProductoSolicitado, RevisionReferencia, Solicitud
from .serializers import (
    ClienteSerializer,
    ClienteLiteSerializer,
    OEMProductoSolicitadoSerializer,
    ProductoSolicitadoSerializer,
    RevisionReferenciaSerializer,
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

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        linked_entities = []

        if instance.autos.exists():
            linked_entities.append("autos")
        if instance.solicitudes.exists():
            linked_entities.append("solicitudes")

        if linked_entities:
            joined_entities = " y ".join(linked_entities)
            return Response(
                {
                    "detail": (
                        "No se puede eliminar el cliente porque tiene "
                        f"{joined_entities} asociados."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        return super().destroy(request, *args, **kwargs)


class ProductoSolicitadoViewSet(viewsets.ModelViewSet):
    queryset = ProductoSolicitado.objects.select_related("producto", "casa_comercial").all().order_by("-id")
    serializer_class = ProductoSolicitadoSerializer
    permission_classes = [IsAuthenticated, SolicitudesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "casa_comercial__nombre", "producto__nombre", "producto__codigo"]
    ordering_fields = ["nombre", "casa_comercial__nombre", "conseguido", "producto__nombre"]


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
            "producto_solicitado__casa_comercial",
            "producto_solicitado__producto",
        )
        .prefetch_related(
            "producto_solicitado__oem_relaciones__oem",
            "producto__oem_productos__oem",
            "revisiones__casa_comercial",
        )
        .all()
        .order_by("-fecha", "-id")
    )
    serializer_class = SolicitudSerializer
    permission_classes = [IsAuthenticated, SolicitudesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
            "codigo",
            "comentario",
            "marca",
            "modelo",
            "motor",
            "anio",
            "cliente__nombres",
            "cliente__apellidos",
            "cliente__cedula_ruc",
            "producto__nombre",
            "producto__codigo",
            "producto_solicitado__nombre",
            "producto_solicitado__codigo",
            "producto_solicitado__casa_comercial__nombre",
            "producto_solicitado__oem_relaciones__oem__codigo",
            "sucursal__nombre",
        ]
    ordering_fields = [
        "codigo",
        "fecha",
        "cliente__nombres",
        "cliente__apellidos",
        "cliente__cedula_ruc",
        "sucursal__nombre",
        "producto_referencia_text",
        "cliente_nombre_text",
        "marca",
        "modelo",
        "motor",
        "anio",
    ]

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        grupo_codigo = str(getattr(instance, "grupo_codigo", "") or "").strip()
        queryset = (
            Solicitud.objects.filter(grupo_codigo=grupo_codigo)
            if grupo_codigo
            else Solicitud.objects.filter(pk=instance.pk)
        )

        with transaction.atomic():
            queryset.delete()

        return Response(status=status.HTTP_204_NO_CONTENT)

    def get_queryset(self):
        queryset = super().get_queryset().annotate(
            cliente_nombre_text=Concat(
                Coalesce("cliente__nombres", Value("")),
                Value(" "),
                Coalesce("cliente__apellidos", Value("")),
                output_field=CharField(),
            ),
            producto_referencia_text=Coalesce("producto_solicitado__nombre", "producto__nombre", Value("")),
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

        grupo_codigo = (params.get("grupo_codigo") or "").strip()
        if grupo_codigo:
            queryset = queryset.filter(grupo_codigo__iexact=grupo_codigo)

        cedula_ruc = (params.get("cedula_ruc") or "").strip()
        if cedula_ruc:
            queryset = queryset.filter(cliente__cedula_ruc__icontains=cedula_ruc)

        fecha_desde = parse_date((params.get("fecha_desde") or "").strip())
        if fecha_desde:
            queryset = queryset.filter(fecha__gte=fecha_desde)

        fecha_hasta = parse_date((params.get("fecha_hasta") or "").strip())
        if fecha_hasta:
            queryset = queryset.filter(fecha__lte=fecha_hasta)

        estado_param = (params.get("estado") or "").strip().lower()
        if estado_param:
            estados = [e.strip() for e in estado_param.split(",") if e.strip()]
            valid_estados = {choice[0] for choice in Solicitud.Estado.choices}
            estados = [e for e in estados if e in valid_estados]
            if estados:
                queryset = queryset.filter(estado__in=estados)

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
                "codigo": "codigo",
                "fecha": {"lookup": "fecha", "type": "date"},
                "cliente_nombre": "cliente_nombre_text",
                "cedula_ruc": "cliente__cedula_ruc",
                "sucursal_nombre": "sucursal__nombre",
                "producto_solicitado_nombre": "producto_referencia_text",
                "marca": "marca",
                "modelo": "modelo",
                "motor": "motor",
                "anio": "anio",
            },
        )

        return queryset

    def list(self, request, *args, **kwargs):
        grupo_codigo = (request.query_params.get("grupo_codigo") or "").strip()
        if grupo_codigo:
            return super().list(request, *args, **kwargs)

        queryset = self.filter_queryset(self.get_queryset())

        flat = request.query_params.get("flat", "").strip() in ("1", "true")
        if flat:
            page = self.paginate_queryset(queryset)
            if page is not None:
                serializer = self.get_serializer(page, many=True)
                return self.get_paginated_response(serializer.data)
            serializer = self.get_serializer(queryset, many=True)
            return Response(serializer.data)

        grouped_rows = self._build_grouped_list_payload(queryset)

        page = self.paginate_queryset(grouped_rows)
        if page is not None:
            return self.get_paginated_response(page)

        return Response(grouped_rows)

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
        with transaction.atomic():
            instance = serializer.save()
            self._sync_group_shared_fields(instance, self.request.data)

    def update(self, request, *args, **kwargs):
        return super().update(request, *args, **kwargs)

    def partial_update(self, request, *args, **kwargs):
        return super().partial_update(request, *args, **kwargs)

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

    @action(detail=True, methods=["post"], url_path="ligar-producto-creado")
    def ligar_producto_creado(self, request, pk=None):
        solicitud = self.get_object()
        ensure_sucursal_allowed(
            request.user,
            RolPermiso.Modulos.SOLICITUDES,
            getattr(solicitud, "sucursal_id", None),
            action_key="puede_actualizar",
        )

        if (
            solicitud.tabla != Solicitud.Tabla.PRODUCTO_SOLICITADO
            or solicitud.producto_solicitado_id is None
        ):
            return Response(
                {
                    "detail": (
                        "Solo las solicitudes de producto solicitado pueden ligarse a un producto creado."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        raw_producto_id = request.data.get("producto_id")
        try:
            producto = Producto.objects.get(pk=int(raw_producto_id))
        except Producto.DoesNotExist:
            return Response(
                {"producto_id": "Producto no encontrado."},
                status=status.HTTP_404_NOT_FOUND,
            )
        except (TypeError, ValueError):
            return Response(
                {"producto_id": "Debe enviar un producto_id valido."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        producto_solicitado = solicitud.producto_solicitado
        with transaction.atomic():
            update_fields = []
            if producto_solicitado.producto_id != producto.id:
                producto_solicitado.producto = producto
                update_fields.append("producto")
            if not producto_solicitado.conseguido:
                producto_solicitado.conseguido = True
                update_fields.append("conseguido")
            if update_fields:
                producto_solicitado.save(update_fields=update_fields)

        solicitud.refresh_from_db()
        serializer = self.get_serializer(solicitud)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @action(detail=True, methods=["post"], url_path="revisar")
    def revisar(self, request, pk=None):
        solicitud = self.get_object()
        ensure_sucursal_allowed(
            request.user,
            RolPermiso.Modulos.SOLICITUDES,
            getattr(solicitud, "sucursal_id", None),
            action_key="puede_actualizar",
        )

        referencias_raw = request.data.get("referencias", [])
        producto_resuelto_id = getattr(getattr(solicitud, "producto_solicitado", None), "producto_id", None)
        puede_revisar_sin_referencias = bool(
            solicitud.tabla == Solicitud.Tabla.PRODUCTO
            or producto_resuelto_id
        )

        if not isinstance(referencias_raw, list):
            return Response(
                {"referencias": "Debe enviar una lista valida de referencias."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not referencias_raw and not puede_revisar_sin_referencias:
            return Response(
                {"referencias": "Debe agregar al menos una referencia."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            RevisionReferencia.objects.filter(solicitud=solicitud).delete()
            for item in referencias_raw:
                casa_comercial_id = item.get("casa_comercial_id") or item.get("casa_comercial")
                referencia = str(item.get("referencia") or "").strip()
                casa_comercial = None
                if casa_comercial_id:
                    try:
                        casa_comercial = CasaComercial.objects.get(pk=int(casa_comercial_id))
                    except (CasaComercial.DoesNotExist, TypeError, ValueError):
                        pass
                RevisionReferencia.objects.create(
                    solicitud=solicitud,
                    casa_comercial=casa_comercial,
                    referencia=referencia,
                )
            solicitud.estado = Solicitud.Estado.REVISADO
            solicitud.save(update_fields=["estado"])

        solicitud.refresh_from_db()
        serializer = self.get_serializer(solicitud)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @action(detail=True, methods=["post"], url_path="archivar")
    def archivar(self, request, pk=None):
        solicitud = self.get_object()
        ensure_sucursal_allowed(
            request.user,
            RolPermiso.Modulos.SOLICITUDES,
            getattr(solicitud, "sucursal_id", None),
            action_key="puede_actualizar",
        )

        referencias_raw = request.data.get("referencias", [])
        if not isinstance(referencias_raw, list):
            return Response(
                {"referencias": "Debe enviar una lista valida de referencias."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            RevisionReferencia.objects.filter(solicitud=solicitud).delete()
            for item in referencias_raw:
                casa_comercial_id = item.get("casa_comercial_id") or item.get("casa_comercial")
                referencia = str(item.get("referencia") or "").strip()
                casa_comercial = None
                if casa_comercial_id:
                    try:
                        casa_comercial = CasaComercial.objects.get(pk=int(casa_comercial_id))
                    except (CasaComercial.DoesNotExist, TypeError, ValueError):
                        pass
                RevisionReferencia.objects.create(
                    solicitud=solicitud,
                    casa_comercial=casa_comercial,
                    referencia=referencia,
                )
            solicitud.estado = Solicitud.Estado.ARCHIVADO
            solicitud.save(update_fields=["estado"])

        solicitud.refresh_from_db()
        serializer = self.get_serializer(solicitud)
        return Response(serializer.data, status=status.HTTP_200_OK)

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
        marca = str(payload.get("marca") or "").strip()
        modelo = str(payload.get("modelo") or "").strip()
        motor = str(payload.get("motor") or "").strip()
        anio = str(payload.get("anio") or "").strip()

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

            casa_comercial_id = item.get("casa_comercial_id")
            casa_comercial = None
            if casa_comercial_id not in (None, ""):
                try:
                    casa_comercial = CasaComercial.objects.filter(pk=int(casa_comercial_id)).only("id", "nombre").first()
                except (TypeError, ValueError):
                    casa_comercial = None

            oem_codigos = self._parse_oem_codes(item.get("oems"))

            if codigo:
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
                    "casa_comercial": casa_comercial,
                    "oem_codigos": oem_codigos,
                    "cantidad": cantidad,
                    "comentario": comentario,
                }
            )

        with transaction.atomic():
            solicitudes = []
            grupo_codigo = uuid.uuid4().hex
            codigo_solicitud = Solicitud.generate_next_codigo(sucursal)
            for item in productos_normalizados:
                if item["tipo"] == Solicitud.Tabla.PRODUCTO:
                    solicitud = Solicitud.objects.create(
                        codigo=codigo_solicitud,
                        grupo_codigo=grupo_codigo,
                        cantidad=item["cantidad"],
                        tabla=Solicitud.Tabla.PRODUCTO,
                        fecha=fecha,
                        comentario=item.get("comentario", ""),
                        marca=marca,
                        modelo=modelo,
                        motor=motor,
                        anio=anio,
                        sucursal=sucursal,
                        cliente=cliente,
                        producto=item["producto"],
                    )
                else:
                    producto_solicitado = ProductoSolicitado.objects.create(
                        codigo=item.get("codigo") or "",
                        nombre=item["nombre"],
                        casa_comercial=item.get("casa_comercial"),
                    )
                    for oem_codigo in item.get("oem_codigos", []):
                        oem, _ = OEM.objects.get_or_create(
                            codigo=oem_codigo,
                        )
                        OEMProductoSolicitado.objects.get_or_create(
                            producto_solicitado=producto_solicitado,
                            oem=oem,
                        )

                    solicitud = Solicitud.objects.create(
                        codigo=codigo_solicitud,
                        grupo_codigo=grupo_codigo,
                        cantidad=item["cantidad"],
                        tabla=Solicitud.Tabla.PRODUCTO_SOLICITADO,
                        fecha=fecha,
                        comentario=item.get("comentario", ""),
                        marca=marca,
                        modelo=modelo,
                        motor=motor,
                        anio=anio,
                        sucursal=sucursal,
                        cliente=cliente,
                        producto_solicitado=producto_solicitado,
                    )
                solicitudes.append(solicitud)

        serializer = self.get_serializer(solicitudes, many=True)
        grouped_results = self._build_grouped_list_payload(
            SolicitudViewSet.queryset.filter(grupo_codigo=grupo_codigo)
        )
        return Response(
            {
                "count": len(grouped_results),
                "results": grouped_results,
                "items": serializer.data,
            },
            status=status.HTTP_201_CREATED,
        )

    def _build_grouped_list_payload(self, queryset):
        filtered_rows = list(queryset)
        if not filtered_rows:
            return []

        ordered_group_keys = []
        representatives = {}
        requested_group_codes = []
        for row in filtered_rows:
            group_key = self._get_group_key(row)
            if group_key not in representatives:
                ordered_group_keys.append(group_key)
                representatives[group_key] = row
            group_code = str(getattr(row, "grupo_codigo", "") or "").strip()
            if group_code:
                requested_group_codes.append(group_code)

        members_by_group = {group_key: [] for group_key in ordered_group_keys}
        if requested_group_codes:
            members_queryset = (
                Solicitud.objects.select_related(
                    "cliente",
                    "sucursal",
                    "producto",
                    "producto_solicitado",
                    "producto_solicitado__producto",
                )
                .prefetch_related(
                    "producto_solicitado__oem_relaciones__oem",
                    "producto__oem_productos__oem",
                )
                .filter(grupo_codigo__in=list(dict.fromkeys(requested_group_codes)))
                .order_by("id")
            )
            for row in members_queryset:
                group_key = self._get_group_key(row)
                if group_key in members_by_group:
                    members_by_group[group_key].append(row)

        payload = []
        for group_key in ordered_group_keys:
            representative = representatives[group_key]
            group_rows = members_by_group.get(group_key) or [representative]
            payload.append(self._serialize_group_row_payload(group_rows))

        return payload

    def _serialize_group_row_payload(self, group_rows):
        sorted_rows = sorted(group_rows, key=lambda item: int(getattr(item, "id", 0) or 0))
        lead = sorted_rows[0]
        data = dict(self.get_serializer(lead).data)

        total_cantidad = 0
        nombres = []

        for row in sorted_rows:
            total_cantidad += int(getattr(row, "cantidad", 0) or 0)

            nombre = self._resolve_row_product_name(row)
            if nombre:
                nombres.append(nombre)

        estado_counts = {Solicitud.Estado.SOLICITADO: 0, Solicitud.Estado.REVISADO: 0, Solicitud.Estado.ARCHIVADO: 0}
        for row in sorted_rows:
            row_estado = str(getattr(row, "estado", Solicitud.Estado.SOLICITADO) or Solicitud.Estado.SOLICITADO)
            if row_estado in estado_counts:
                estado_counts[row_estado] += 1

        detalles = []
        for row in sorted_rows:
            tabla = str(getattr(row, "tabla", "") or "")
            if tabla == Solicitud.Tabla.PRODUCTO:
                producto = getattr(row, "producto", None)
                codigo = str(getattr(producto, "codigo", "") or "").strip() if producto else ""
                nombre = str(getattr(producto, "nombre", "") or "").strip() if producto else ""
                oem_codigos = (
                    list(producto.oem_productos.values_list("oem__codigo", flat=True))
                    if producto else []
                )
            else:
                ps = getattr(row, "producto_solicitado", None)
                codigo = str(getattr(ps, "codigo", "") or "").strip() if ps else ""
                nombre = str(getattr(ps, "nombre", "") or "").strip() if ps else ""
                oem_codigos = (
                    [str(r.oem.codigo) for r in ps.oem_relaciones.all() if getattr(r, "oem", None)]
                    if ps else []
                )
            detalles.append({
                "producto_codigo": codigo,
                "producto_nombre": nombre,
                "oem": ", ".join(filter(None, oem_codigos)),
                "cantidad": int(getattr(row, "cantidad", 0) or 0),
                "comentario": str(getattr(row, "comentario", "") or "").strip(),
            })

        data["id"] = int(getattr(lead, "id", 0) or 0)
        data["codigo"] = str(data.get("codigo") or f"Solicitud #{lead.pk}").strip()
        data["grupo_codigo"] = str(getattr(lead, "grupo_codigo", "") or "").strip()
        data["cantidad"] = total_cantidad
        data["producto_referencia"] = self._build_preview_text(nombres)
        data["producto_solicitado_nombre"] = self._build_preview_text(nombres)
        data.pop("conseguido", None)
        data.pop("conseguido_label", None)
        data["detalle_count"] = len(sorted_rows)
        data["estado_counts"] = estado_counts
        data["detalles"] = detalles
        return data

    @staticmethod
    def _get_group_key(instance):
        grupo_codigo = str(getattr(instance, "grupo_codigo", "") or "").strip()
        if grupo_codigo:
            return grupo_codigo
        codigo = str(getattr(instance, "codigo", "") or "").strip()
        if codigo:
            return codigo
        return f"solicitud-{getattr(instance, 'pk', '0')}"

    @staticmethod
    def _build_preview_text(values, empty_value="-", max_items=3):
        unique_values = []
        seen = set()
        for value in values:
            text = str(value or "").strip()
            if not text:
                continue
            key = text.lower()
            if key in seen:
                continue
            seen.add(key)
            unique_values.append(text)

        if not unique_values:
            return empty_value

        preview = ", ".join(unique_values[:max_items])
        if len(unique_values) > max_items:
            preview = f"{preview} +{len(unique_values) - max_items}"
        return preview

    @staticmethod
    def _resolve_row_product_name(row):
        if getattr(row, "tabla", "") == Solicitud.Tabla.PRODUCTO and getattr(row, "producto", None):
            return str(getattr(row.producto, "nombre", "") or "").strip()
        if getattr(row, "producto_solicitado", None):
            return str(getattr(row.producto_solicitado, "nombre", "") or "").strip()
        return ""

    @staticmethod
    def _resolve_row_resolved_product(row):
        if getattr(row, "tabla", "") == Solicitud.Tabla.PRODUCTO and getattr(row, "producto", None):
            codigo = str(getattr(row.producto, "codigo", "") or "").strip()
            nombre = str(getattr(row.producto, "nombre", "") or "").strip()
            return f"{codigo} {nombre}".strip()

        producto_solicitado = getattr(row, "producto_solicitado", None)
        producto_resuelto = getattr(producto_solicitado, "producto", None)
        if producto_resuelto is None:
            return ""

        codigo = str(getattr(producto_resuelto, "codigo", "") or "").strip()
        nombre = str(getattr(producto_resuelto, "nombre", "") or "").strip()
        return f"{codigo} {nombre}".strip()

    @staticmethod
    def _sync_group_shared_fields(instance, payload):
        grupo_codigo = str(getattr(instance, "grupo_codigo", "") or "").strip()
        if not grupo_codigo:
            return

        sync_sucursal = "sucursal_id" in payload
        sync_auto = any(k in payload for k in ("marca", "modelo", "motor", "anio"))
        sync_cliente = any(
            key in payload
            for key in (
                "cliente_id",
                "cliente_nombres",
                "cliente_apellidos",
                "cliente_cedula_ruc",
                "cliente_correo",
                "cliente_telefono",
                "cliente_direccion",
            )
        )

        if not any((sync_sucursal, sync_auto, sync_cliente)):
            return

        siblings = (
            Solicitud.objects.select_related("cliente", "sucursal")
            .filter(grupo_codigo=grupo_codigo)
            .exclude(pk=instance.pk)
        )
        for sibling in siblings:
            update_fields = []

            if sync_sucursal and sibling.sucursal_id != instance.sucursal_id:
                sibling.sucursal = instance.sucursal
                update_fields.append("sucursal")
            if sync_sucursal and sibling.codigo != instance.codigo:
                sibling.codigo = instance.codigo
                update_fields.append("codigo")

            if sync_auto:
                for field in ("marca", "modelo", "motor", "anio"):
                    if getattr(sibling, field) != getattr(instance, field):
                        setattr(sibling, field, getattr(instance, field))
                        update_fields.append(field)

            if sync_cliente and sibling.cliente_id != instance.cliente_id:
                sibling.cliente = instance.cliente
                update_fields.append("cliente")

            if update_fields:
                sibling.save(update_fields=update_fields)

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
        if cliente_data in (None, "", {}):
            return None, None
        if not isinstance(cliente_data, dict):
            return None, {"cliente": "Formato invalido para cliente."}

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
