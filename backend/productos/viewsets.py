from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models import Case, CharField, DecimalField, ExpressionWrapper, F, IntegerField, OuterRef, Subquery, Sum, Value, When
from django.db.models.functions import Coalesce
from django.db.models.deletion import ProtectedError
from django.utils.dateparse import parse_date
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from configuracion.models import ConfiguracionSistema
from core.search_utils import FuzzyTokenSearchFilter
from core.table_filters import apply_column_filters, parse_column_filters
from usuarios.models import RolPermiso
from usuarios.permissions import (
    ProductosDependentReadPermission,
    ProductosModulePermission,
)
from usuarios.sucursal_scope import get_allowed_sucursal_ids
from usuarios.sucursal_scope import get_any_permitted_sucursal_ids

from inventario.models import Inventario, Sucursal

from .models import OEM, OEMProducto, Producto, ProductoAlterno
from .serializers import (
    OEMProductoSerializer,
    OEMSerializer,
    ProductoCalificacionSerializer,
    ProductoDetailSerializer,
    ProductoAlternoSerializer,
    ProductoSerializer,
    build_producto_rating_summary,
)


def get_alterno_group_ids(producto_id):
    pending = {producto_id}
    visited = set()

    while pending:
        current_id = pending.pop()
        if current_id in visited:
            continue
        visited.add(current_id)

        forward_ids = set(
            ProductoAlterno.objects.filter(producto_id=current_id)
            .values_list("alterno_id", flat=True)
        )
        backward_ids = set(
            ProductoAlterno.objects.filter(alterno_id=current_id)
            .values_list("producto_id", flat=True)
        )
        pending.update((forward_ids | backward_ids) - visited)

    return visited


class ProductoViewSet(viewsets.ModelViewSet):
    queryset = (
        Producto.objects.prefetch_related("casas_comerciales", "oem_productos__oem")
        .all()
        .order_by("-creado_en", "-id")
    )
    serializer_class = ProductoSerializer
    permission_classes = [IsAuthenticated, ProductosDependentReadPermission]
    filter_backends = [FuzzyTokenSearchFilter, filters.OrderingFilter]
    search_fields = [
        "codigo",
        "nombre",
        "descripcion",
        "referencia",
        "casas_comerciales__nombre",
        "oem_productos__oem__codigo",
    ]
    ordering_fields = [
        "nombre",
        "codigo",
        "descripcion",
        "casas_comerciales__nombre",
        "costo_minimo",
        "precio",
        "precio_con_iva_backend",
        "creado_en",
    ]

    def get_serializer_class(self):
        if self.action == "retrieve":
            return ProductoDetailSerializer
        return ProductoSerializer

    def get_permissions(self):
        # Para publicar comentarios, la validacion especifica se maneja
        # dentro de la accion `comentarios` (permiso de editar productos).
        if (
            self.action == "comentarios"
            and self.request
            and self.request.method.lower() == "post"
        ):
            return [IsAuthenticated()]
        return super().get_permissions()

    def _get_table_branches(self):
        branches = Sucursal.objects.all()
        allowed_branch_ids = get_any_permitted_sucursal_ids(self.request.user)
        if allowed_branch_ids is not None:
            if not allowed_branch_ids:
                return []
            branches = branches.filter(id__in=sorted(allowed_branch_ids))
        return list(branches.order_by("-id"))

    def _serialize_table_branches(self, branches):
        return [
            {
                "id": int(branch.id or 0),
                "nombre": str(branch.nombre or "").strip(),
                "direccion": str(getattr(branch, "direccion", "") or "").strip(),
            }
            for branch in branches
            if int(branch.id or 0) > 0
        ]

    def _attach_branch_stock(self, products, branches):
        products = list(products)
        branch_ids = [int(branch.id) for branch in branches if int(branch.id or 0) > 0]
        product_ids = [int(product.id) for product in products if int(product.id or 0) > 0]
        empty_stock = {branch_id: 0 for branch_id in branch_ids}

        for product in products:
            product._stock_por_sucursal = dict(empty_stock)

        if not product_ids or not branch_ids:
            return products

        stock_rows = (
            Inventario.objects.filter(
                producto_id__in=product_ids,
                subdivision__division__bodega__sucursal_id__in=branch_ids,
            )
            .values("producto_id", "subdivision__division__bodega__sucursal_id")
            .annotate(total=Coalesce(Sum("cantidad"), Value(0), output_field=IntegerField()))
        )
        stock_by_product = {product_id: dict(empty_stock) for product_id in product_ids}
        for row in stock_rows:
            product_id = int(row.get("producto_id") or 0)
            branch_id = int(row.get("subdivision__division__bodega__sucursal_id") or 0)
            if product_id in stock_by_product and branch_id in empty_stock:
                stock_by_product[product_id][branch_id] = int(row.get("total") or 0)

        for product in products:
            product._stock_por_sucursal = stock_by_product.get(int(product.id), dict(empty_stock))
        return products

    def list(self, request, *args, **kwargs):
        branches = self._get_table_branches()
        queryset = self.filter_queryset(self.get_queryset())

        page = self.paginate_queryset(queryset)
        if page is not None:
            page = self._attach_branch_stock(page, branches)
            serializer = self.get_serializer(page, many=True)
            response = self.get_paginated_response(serializer.data)
            response.data["branches"] = self._serialize_table_branches(branches)
            return response

        products = self._attach_branch_stock(queryset, branches)
        serializer = self.get_serializer(products, many=True)
        return Response(
            {
                "results": serializer.data,
                "count": len(serializer.data),
                "branches": self._serialize_table_branches(branches),
            }
        )

    def get_queryset(self):
        queryset = super().get_queryset()
        if self.action == "retrieve":
            return queryset
        params = self.request.query_params
        iva_rate = ConfiguracionSistema.get_solo().iva_rate
        factor = Decimal("1") + Decimal(str(iva_rate or 0))

        total_stock_subq = (
            Inventario.objects.filter(producto=OuterRef("pk"))
            .values("producto")
            .annotate(total=Sum("cantidad"))
            .values("total")[:1]
        )
        queryset = queryset.annotate(
            precio_con_iva_backend=ExpressionWrapper(
                F("precio") * Value(factor),
                output_field=DecimalField(max_digits=16, decimal_places=4),
            ),
            total_stock=Coalesce(
                Subquery(total_stock_subq, output_field=IntegerField()),
                Value(0),
            ),
        )

        codigo = (params.get("codigo") or "").strip()
        if codigo:
            queryset = queryset.filter(codigo__icontains=codigo)

        referencia = (params.get("referencia") or "").strip()
        if referencia:
            queryset = queryset.filter(referencia__icontains=referencia)

        nombre = (params.get("nombre") or "").strip()
        if nombre:
            queryset = queryset.filter(nombre__icontains=nombre)

        descripcion = (params.get("descripcion") or "").strip()
        if descripcion:
            queryset = queryset.filter(descripcion__icontains=descripcion)

        casa_comercial = (params.get("casa_comercial") or "").strip()
        if casa_comercial:
            queryset = queryset.filter(casas_comerciales__nombre__icontains=casa_comercial)

        oem = (params.get("oem") or "").strip()
        if oem:
            queryset = queryset.filter(oem_productos__oem__codigo__icontains=oem)

        costo_minimo = (params.get("costo_minimo") or "").strip()
        if costo_minimo:
            try:
                queryset = queryset.filter(costo_minimo=Decimal(costo_minimo))
            except (InvalidOperation, ValueError):
                pass

        precio = (params.get("precio") or "").strip()
        if precio:
            try:
                queryset = queryset.filter(precio=Decimal(precio))
            except (InvalidOperation, ValueError):
                pass

        fecha_creacion = (params.get("fecha_creacion") or "").strip()
        if fecha_creacion:
            parsed = parse_date(fecha_creacion)
            if parsed:
                queryset = queryset.filter(creado_en__date=parsed)

        queryset = apply_column_filters(
            queryset,
            parse_column_filters(params.get("column_filters")),
            {
                "codigo": "codigo",
                "nombre": "nombre",
                "costo_minimo": {"lookup": "costo_minimo", "type": "number"},
                "precio": {"lookup": "precio", "type": "number"},
                "precio_con_iva": {"lookup": "precio_con_iva_backend", "type": "number"},
                "referencia": "referencia",
                "oem_codes": "oem_productos__oem__codigo",
                "casa_comercial_nombre": "casas_comerciales__nombre",
            },
        )

        return queryset.distinct()

    def perform_destroy(self, instance):
        if instance.detalles_movimiento.exists():
            raise ValidationError(
                {
                    "detail": (
                        "No se puede eliminar el producto porque está ligado a una "
                        "entrada o salida registrada."
                    )
                }
            )

        inventory_rows = list(
            instance.inventarios.values_list(
                "subdivision__division__bodega__sucursal_id",
                "subdivision__division__bodega__sucursal__nombre",
            ).distinct()
        )
        inventory_branch_ids = {
            int(sucursal_id)
            for sucursal_id, _nombre in inventory_rows
            if sucursal_id is not None
        }

        if inventory_branch_ids:
            allowed_branch_ids = get_allowed_sucursal_ids(
                self.request.user,
                RolPermiso.Modulos.PRODUCTOS,
                action_key="puede_eliminar",
            )
            if allowed_branch_ids is not None:
                missing_branch_ids = sorted(inventory_branch_ids.difference(allowed_branch_ids))
                if missing_branch_ids:
                    branch_names = []
                    for sucursal_id, sucursal_nombre in inventory_rows:
                        if sucursal_id in missing_branch_ids and sucursal_nombre:
                            branch_names.append(str(sucursal_nombre).strip())
                    branch_names = sorted(set([name for name in branch_names if name]))
                    branch_hint = (
                        f" Sucursales faltantes: {', '.join(branch_names)}."
                        if branch_names
                        else ""
                    )
                    raise PermissionDenied(
                        "No tienes permiso para eliminar este producto en todas las sucursales donde tiene inventario."
                        + branch_hint
                    )

        try:
            with transaction.atomic():
                if inventory_branch_ids:
                    instance.inventarios.all().delete()
                instance.delete()
        except ProtectedError:
            raise ValidationError(
                {
                    "detail": (
                        "No se puede eliminar el producto porque está relacionado con movimientos "
                        "u otros registros históricos protegidos."
                    )
                }
            )

    @action(detail=True, methods=["get"], url_path="calificacion")
    def calificacion(self, request, pk=None):
        producto = self.get_object()
        return Response(build_producto_rating_summary(producto), status=status.HTTP_200_OK)

    @action(detail=True, methods=["get", "post"], url_path="comentarios")
    def comentarios(self, request, pk=None):
        producto = self.get_object()

        if request.method.lower() == "get":
            comentarios_qs = producto.calificaciones.select_related("usuario").all()
            serializer = ProductoCalificacionSerializer(comentarios_qs, many=True)
            return Response(
                {
                    "results": serializer.data,
                    "rating_summary": build_producto_rating_summary(producto),
                },
                status=status.HTTP_200_OK,
            )

        # Comentar requiere permiso de edicion en el modulo Productos.
        permission_checker = ProductosModulePermission()
        permission_index = permission_checker._get_permission_index(request)
        module_permissions = permission_index.get(RolPermiso.Modulos.PRODUCTOS, {})
        can_comment = bool(module_permissions.get("puede_actualizar"))
        if not can_comment:
            raise PermissionDenied(
                "No tienes permisos para comentar este producto."
            )

        serializer = ProductoCalificacionSerializer(
            data=request.data,
            context={"request": request, "producto": producto},
        )
        serializer.is_valid(raise_exception=True)
        comentario = serializer.save()

        return Response(
            {
                "comment": ProductoCalificacionSerializer(comentario).data,
                "rating_summary": build_producto_rating_summary(producto),
            },
            status=status.HTTP_201_CREATED,
        )


class OEMViewSet(viewsets.ModelViewSet):
    queryset = OEM.objects.all().order_by("-id")
    serializer_class = OEMSerializer
    permission_classes = [IsAuthenticated, ProductosModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["codigo"]
    ordering_fields = ["codigo"]


class OEMProductoViewSet(viewsets.ModelViewSet):
    queryset = (
        OEMProducto.objects.select_related("producto", "oem")
        .all()
        .order_by("-id")
    )
    serializer_class = OEMProductoSerializer
    permission_classes = [IsAuthenticated, ProductosModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "producto__codigo",
        "producto__nombre",
        "oem__codigo",
    ]
    ordering_fields = ["producto__nombre", "oem__codigo"]

    @transaction.atomic
    def perform_create(self, serializer):
        instance = serializer.save()
        for producto_id in get_alterno_group_ids(instance.producto_id):
            OEMProducto.objects.get_or_create(producto_id=producto_id, oem=instance.oem)

    @transaction.atomic
    def perform_destroy(self, instance):
        oem = instance.oem
        group_ids = get_alterno_group_ids(instance.producto_id)
        instance.delete()
        OEMProducto.objects.filter(producto_id__in=group_ids, oem=oem).delete()


class ProductoAlternoViewSet(viewsets.ModelViewSet):
    queryset = (
        ProductoAlterno.objects.select_related("producto", "alterno")
        .all()
        .order_by("-id")
    )
    serializer_class = ProductoAlternoSerializer
    permission_classes = [IsAuthenticated, ProductosModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "producto__codigo",
        "producto__nombre",
        "alterno__codigo",
        "alterno__nombre",
    ]
    ordering_fields = ["producto__nombre", "alterno__nombre"]

    def _sync_group_oems(self, producto_ids):
        product_ids = {int(product_id) for product_id in producto_ids if product_id}
        if not product_ids:
            return

        oem_ids = set(
            OEMProducto.objects.filter(producto_id__in=product_ids)
            .values_list("oem_id", flat=True)
        )
        if not oem_ids:
            return

        existing_pairs = set(
            OEMProducto.objects.filter(producto_id__in=product_ids, oem_id__in=oem_ids)
            .values_list("producto_id", "oem_id")
        )
        missing = [
            OEMProducto(producto_id=producto_id, oem_id=oem_id)
            for producto_id in product_ids
            for oem_id in oem_ids
            if (producto_id, oem_id) not in existing_pairs
        ]
        if missing:
            OEMProducto.objects.bulk_create(missing, ignore_conflicts=True)

    def perform_create(self, serializer):
        with transaction.atomic():
            instance = serializer.save()
            if instance.producto_id == instance.alterno_id:
                raise ValidationError({"detail": "Un producto no puede ser alterno de si mismo."})
            ProductoAlterno.objects.get_or_create(
                producto_id=instance.alterno_id,
                alterno_id=instance.producto_id,
                defaults={"notas": instance.notas},
            )
            group_ids = get_alterno_group_ids(instance.producto_id)
            self._sync_group_oems(group_ids)

    def perform_destroy(self, instance):
        with transaction.atomic():
            producto_id = instance.producto_id
            alterno_id = instance.alterno_id
            instance.delete()
            ProductoAlterno.objects.filter(producto_id=alterno_id, alterno_id=producto_id).delete()
