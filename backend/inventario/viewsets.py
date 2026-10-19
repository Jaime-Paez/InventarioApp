from collections import defaultdict
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models.deletion import ProtectedError
from django.db.models import (
    BooleanField,
    Case,
    CharField,
    Count,
    Exists,
    IntegerField,
    Max,
    OuterRef,
    Q,
    Subquery,
    Sum,
    Value,
    When,
)
from django.db.models.functions import Coalesce, Concat, Lower
from django.utils.dateparse import parse_date
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.search_utils import (
    FuzzyTokenSearchFilter,
    apply_token_search,
    get_search_tokens,
    strip_accents,
)
from core.table_filters import apply_column_filters, parse_column_filters
from productos.models import OEMProducto, Producto
from usuarios.models import RolPermiso
from usuarios.permissions import (
    BodegasDependentReadPermission,
    InventarioReadProductosWritePermission,
    SucursalScopedModulePermission,
)
from usuarios.sucursal_scope import (
    apply_sucursal_scope,
    ensure_sucursal_allowed,
    ensure_sucursal_allowed_for_modules,
    get_allowed_sucursal_ids_for_modules,
    get_allowed_sucursal_ids,
    get_any_permitted_sucursal_ids,
    get_readable_sucursal_ids,
)

from .models import Bodega, Division, Inventario, SubDivision, Sucursal
from .serializers import (
    BodegaSerializer,
    DivisionSerializer,
    InventarioSerializer,
    SubDivisionSerializer,
    SucursalSerializer,
)
from movimientos.transfer_helpers import (
    build_sale_stock_change_extra_reason,
    cancel_pending_transfer_requests,
    REMINDERS_SYNC_FLAG,
)


# Una ubicacion del ALMACEN (no de la bodega) con esta cantidad o menos se
# marca como "poco stock": el ojo de "otras ubicaciones" de la tabla de
# Inventario se pinta de rojo cuando la sucursal tiene varias ubicaciones y
# alguna del almacen esta en este nivel o por debajo ("menos de 2 unidades").
LOW_STOCK_LOCATION_THRESHOLD = 1


def is_low_stock_principal(cantidad):
    return int(cantidad or 0) <= LOW_STOCK_LOCATION_THRESHOLD


def get_user_location_order(product_ids):
    """{(producto_id, subdivision_id): orden} elegido por el usuario."""
    from .models import ProductoUbicacionOrden

    ids = sorted({int(pid) for pid in product_ids if int(pid or 0) > 0})
    if not ids:
        return {}
    return {
        (int(row["producto_id"]), int(row["subdivision_id"])): int(row["orden"])
        for row in ProductoUbicacionOrden.objects.filter(producto_id__in=ids).values(
            "producto_id", "subdivision_id", "orden"
        )
    }


def order_branch_locations(product_id, locations, user_order):
    """Ubicaciones de un producto en una sucursal, la principal primero.

    - Con orden elegido por el usuario: ese orden (las que no tienen orden van
      al final, por nombre) y la principal es la primera, aunque este en 0
      (asi se ve en rojo cuando se vacio).
    - Sin orden elegido: como antes, por nombre y la principal es la primera
      con stock.
    """
    def name_key(item):
        return (
            str(item.get("bodega_nombre") or "").lower(),
            str(item.get("division_nombre") or "").lower(),
            str(item.get("subdivision_nombre") or "").lower(),
            int(item.get("bodega_id") or 0),
            int(item.get("division_id") or 0),
            int(item.get("subdivision_id") or 0),
        )

    def order_of(item):
        return user_order.get((int(product_id), int(item.get("subdivision_id") or 0)))

    has_user_order = any(order_of(item) is not None for item in locations)
    if has_user_order:
        ordered = sorted(
            locations,
            key=lambda item: (
                0 if order_of(item) is not None else 1,
                order_of(item) if order_of(item) is not None else 0,
                name_key(item),
            ),
        )
        return ordered, ordered[0]

    ordered = sorted(locations, key=name_key)
    principal = next(
        (item for item in ordered if int(item.get("cantidad") or 0) > 0),
        ordered[0],
    )
    return [principal] + [item for item in ordered if item is not principal], principal


LOCATION_CATALOG_SCOPED_READ_MODULE_KEYS = (
    RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
    RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
    RolPermiso.Modulos.MOVIMIENTOS_INCONVENIENTES,
)

INVENTARIO_WRITE_SCOPE_MODULE_KEYS = (
    RolPermiso.Modulos.PRODUCTOS,
)

METHOD_SCOPE_ACTION = {
    "GET": "puede_leer",
    "HEAD": "puede_leer",
    "OPTIONS": "puede_leer",
    "POST": "puede_crear",
    "PUT": "puede_actualizar",
    "PATCH": "puede_actualizar",
    "DELETE": "puede_eliminar",
}


def _resolve_location_catalog_scope_modules(request):
    if request.method in ("GET", "HEAD", "OPTIONS"):
        query_module = (request.query_params.get("modulo") or "").strip()
        if query_module in LOCATION_CATALOG_SCOPED_READ_MODULE_KEYS:
            return [query_module]
        return []
    return [RolPermiso.Modulos.SUCURSALES_BODEGAS]


def _apply_location_catalog_scope(queryset, request, field_lookup):
    module_keys = _resolve_location_catalog_scope_modules(request)
    if not module_keys:
        return queryset
    allowed = get_allowed_sucursal_ids_for_modules(
        request.user,
        module_keys,
        action_key="puede_leer",
    )
    if allowed is None:
        return queryset
    if not allowed:
        return queryset.none()
    return queryset.filter(**{f"{field_lookup}__in": sorted(allowed)})


def _apply_bodegas_scope(queryset, request, field_lookup):
    if request.method in ("GET", "HEAD", "OPTIONS"):
        readable = get_readable_sucursal_ids(request.user, RolPermiso.Modulos.SUCURSALES_BODEGAS)
        if readable is None:
            return queryset
        if not readable:
            return queryset.none()
        return queryset.filter(**{f"{field_lookup}__in": sorted(readable)})
    return _apply_location_catalog_scope(queryset, request, field_lookup)


class SucursalViewSet(viewsets.ModelViewSet):
    queryset = Sucursal.objects.all().order_by("-id")
    serializer_class = SucursalSerializer
    permission_classes = [IsAuthenticated, SucursalScopedModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]

    def _resolve_scope_module_key(self):
        if self.request.method in ("GET", "HEAD", "OPTIONS"):
            query_module = (self.request.query_params.get("modulo") or "").strip()
            valid_modules = {key for key, _ in RolPermiso.Modulos.choices}
            if query_module in valid_modules:
                return query_module
        return RolPermiso.Modulos.SUCURSALES_SUCURSALES

    def get_queryset(self):
        queryset = super().get_queryset()
        module_key = self._resolve_scope_module_key()
        if (
            self.request.method in ("GET", "HEAD", "OPTIONS")
            and module_key in LOCATION_CATALOG_SCOPED_READ_MODULE_KEYS
        ):
            readable = get_readable_sucursal_ids(self.request.user, module_key)
            if readable is None:
                return queryset
            if not readable:
                return queryset.none()
            return queryset.filter(id__in=sorted(readable))

        return apply_sucursal_scope(
            queryset,
            self.request.user,
            module_key,
            "id",
            action_key=METHOD_SCOPE_ACTION.get(self.request.method),
        )

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        module_key = self._resolve_scope_module_key()
        if module_key in LOCATION_CATALOG_SCOPED_READ_MODULE_KEYS:
            readable = get_readable_sucursal_ids(request.user, module_key)
            writable = get_allowed_sucursal_ids(
                request.user,
                module_key,
                action_key="puede_crear",
            )
            response["X-Sucursal-Scope-Unrestricted"] = "1" if readable is None else "0"
            if writable is None:
                response["X-Sucursal-Scope-Writable-Ids"] = "all"
            elif writable:
                response["X-Sucursal-Scope-Writable-Ids"] = ",".join(
                    str(branch_id) for branch_id in sorted(writable)
                )
            else:
                response["X-Sucursal-Scope-Writable-Ids"] = "none"
        else:
            allowed = get_allowed_sucursal_ids(
                request.user,
                module_key,
                action_key=METHOD_SCOPE_ACTION.get(request.method),
            )
            response["X-Sucursal-Scope-Unrestricted"] = "1" if allowed is None else "0"
        return response

    def _get_delete_block_reasons(self, instance):
        reasons = []

        if instance.bodegas.exists():
            reasons.append("bodegas o estructura de inventario")

        if instance.movimientos_origen.exists() or instance.movimientos_destino.exists():
            reasons.append("movimientos de inventario (entradas, salidas o traslados)")

        if instance.solicitudes.exists():
            reasons.append("solicitudes de clientes")

        if (
            instance.solicitudes_traslado_realizadas.exists()
            or instance.solicitudes_traslado_recibidas.exists()
        ):
            reasons.append("solicitudes de traslado")

        inspecciones_rel = getattr(instance, "inspecciones_aleatorias_items", None)
        if inspecciones_rel is not None and inspecciones_rel.exists():
            reasons.append("inspecciones aleatorias")

        return reasons

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        reasons = self._get_delete_block_reasons(instance)
        if reasons:
            return Response(
                {
                    "detail": (
                        "No se puede eliminar la sucursal porque tiene registros relacionados: "
                        + ", ".join(reasons)
                        + "."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            return super().destroy(request, *args, **kwargs)
        except ProtectedError:
            return Response(
                {
                    "detail": (
                        "No se puede eliminar la sucursal porque esta ligada a registros historicos protegidos."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )


class BodegaViewSet(viewsets.ModelViewSet):
    queryset = Bodega.objects.select_related("sucursal").all().order_by(
        "-id"
    )
    serializer_class = BodegaSerializer
    permission_classes = [IsAuthenticated, BodegasDependentReadPermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "sucursal__nombre"]
    ordering_fields = ["nombre", "sucursal__nombre"]

    def get_queryset(self):
        queryset = super().get_queryset()
        queryset = _apply_bodegas_scope(queryset, self.request, "sucursal_id")
        sucursal_id = self.request.query_params.get("sucursal_id")
        if sucursal_id:
            queryset = queryset.filter(sucursal_id=sucursal_id)
        return queryset

    def perform_create(self, serializer):
        sucursal = serializer.validated_data.get("sucursal")
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            getattr(sucursal, "id", None),
            action_key="puede_crear",
        )
        serializer.save()

    def perform_update(self, serializer):
        sucursal = serializer.validated_data.get("sucursal", serializer.instance.sucursal)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            getattr(sucursal, "id", None),
            action_key="puede_actualizar",
        )
        serializer.save()

    def _get_delete_block_reasons(self, instance):
        reasons = []

        has_inventario = Inventario.objects.filter(
            subdivision__division__bodega=instance
        ).exists()
        has_subdivisiones = SubDivision.objects.filter(division__bodega=instance).exists()
        has_divisiones = instance.divisiones.exists()

        if has_inventario:
            reasons.append("inventario asociado")
        if has_subdivisiones:
            reasons.append("subdivisiones asociadas")
        if has_divisiones:
            reasons.append("divisiones asociadas")

        return reasons

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        reasons = self._get_delete_block_reasons(instance)
        if reasons:
            return Response(
                {
                    "detail": (
                        "No se puede eliminar la bodega porque tiene registros relacionados: "
                        + ", ".join(reasons)
                        + "."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            return super().destroy(request, *args, **kwargs)
        except ProtectedError:
            return Response(
                {
                    "detail": (
                        "No se puede eliminar la bodega porque esta ligada a registros historicos protegidos."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )


class DivisionViewSet(viewsets.ModelViewSet):
    queryset = (
        Division.objects.select_related("tipo_division", "bodega", "bodega__sucursal")
        .all()
        .order_by("-id")
    )
    serializer_class = DivisionSerializer
    permission_classes = [IsAuthenticated, BodegasDependentReadPermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "nombre",
        "tipo_division__nombre",
        "bodega__nombre",
        "bodega__sucursal__nombre",
    ]
    ordering_fields = ["nombre", "bodega__nombre", "tipo_division__nombre"]

    def get_queryset(self):
        queryset = super().get_queryset()
        queryset = _apply_bodegas_scope(queryset, self.request, "bodega__sucursal_id")
        sucursal_id = self.request.query_params.get("sucursal_id")
        if sucursal_id:
            queryset = queryset.filter(bodega__sucursal_id=sucursal_id)
        bodega_id = self.request.query_params.get("bodega_id")
        if bodega_id:
            queryset = queryset.filter(bodega_id=bodega_id)
        return queryset

    def perform_create(self, serializer):
        bodega = serializer.validated_data.get("bodega")
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            getattr(bodega, "sucursal_id", None),
            action_key="puede_crear",
        )
        serializer.save()

    def perform_update(self, serializer):
        bodega = serializer.validated_data.get("bodega", serializer.instance.bodega)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            getattr(bodega, "sucursal_id", None),
            action_key="puede_actualizar",
        )
        serializer.save()


class SubDivisionViewSet(viewsets.ModelViewSet):
    queryset = (
        SubDivision.objects.select_related(
            "division",
            "division__bodega",
            "division__bodega__sucursal",
            "division__tipo_division",
        )
        .all()
        .order_by("-id")
    )
    serializer_class = SubDivisionSerializer
    permission_classes = [IsAuthenticated, BodegasDependentReadPermission]
    filter_backends = [FuzzyTokenSearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "division__nombre", "division__bodega__nombre"]
    ordering_fields = ["nombre", "division__nombre"]

    def get_queryset(self):
        queryset = super().get_queryset()
        queryset = _apply_bodegas_scope(
            queryset,
            self.request,
            "division__bodega__sucursal_id",
        )
        sucursal_id = self.request.query_params.get("sucursal_id")
        if sucursal_id:
            queryset = queryset.filter(division__bodega__sucursal_id=sucursal_id)
        bodega_id = self.request.query_params.get("bodega_id")
        if bodega_id:
            queryset = queryset.filter(division__bodega_id=bodega_id)
        division_id = self.request.query_params.get("division_id")
        if division_id:
            queryset = queryset.filter(division_id=division_id)
        return queryset

    def perform_create(self, serializer):
        division = serializer.validated_data.get("division")
        sucursal_id = getattr(getattr(division, "bodega", None), "sucursal_id", None)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            sucursal_id,
            action_key="puede_crear",
        )
        serializer.save()

    def perform_update(self, serializer):
        division = serializer.validated_data.get("division", serializer.instance.division)
        sucursal_id = getattr(getattr(division, "bodega", None), "sucursal_id", None)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            sucursal_id,
            action_key="puede_actualizar",
        )
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if Inventario.objects.filter(subdivision=instance).exists():
            return Response(
                {"detail": "No se puede eliminar la subdivisión porque tiene productos asociados."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return super().destroy(request, *args, **kwargs)

class InventarioViewSet(viewsets.ModelViewSet):
    queryset = (
        Inventario.objects.select_related(
            "producto",
            "subdivision",
            "subdivision__division",
            "subdivision__division__tipo_division",
            "subdivision__division__bodega",
            "subdivision__division__bodega__sucursal",
        )
        .prefetch_related("producto__casas_comerciales", "producto__oem_productos__oem")
        .all()
        .order_by("-id")
    )
    serializer_class = InventarioSerializer
    permission_classes = [IsAuthenticated, InventarioReadProductosWritePermission]
    filter_backends = [FuzzyTokenSearchFilter, filters.OrderingFilter]
    search_fields = [
        "producto__codigo",
        "producto__nombre",
        "producto__descripcion",
        "producto__referencia",
        "producto__referencias__valor",
        "producto__casas_comerciales__nombre",
        "producto__oem_productos__oem__codigo",
        "subdivision__nombre",
        "subdivision__division__nombre",
        "subdivision__division__bodega__nombre",
        "subdivision__division__bodega__sucursal__nombre",
        "referencia",
    ]
    ordering_fields = [
        "producto__codigo",
        "producto__nombre",
        "producto__costo_minimo",
        "producto__precio",
        "cantidad",
        "subdivision__nombre",
        "subdivision__division__nombre",
        "subdivision__division__bodega__nombre",
        "subdivision__division__bodega__sucursal__nombre",
    ]

    def _resolve_inventory_branch_id(self, instance):
        subdivision = getattr(instance, "subdivision", None)
        division = getattr(subdivision, "division", None)
        bodega = getattr(division, "bodega", None)
        sucursal = getattr(bodega, "sucursal", None)
        return getattr(sucursal, "id", None)

    def _cancel_pending_transfers_due_to_inventory_change(self, instance):
        branch_id = self._resolve_inventory_branch_id(instance)
        product_id = getattr(instance, "producto_id", None)
        if not branch_id or not product_id:
            return False
        reference = str(getattr(instance, "referencia", "") or "").strip() or None
        extra_reason = build_sale_stock_change_extra_reason(reference)
        return cancel_pending_transfer_requests(
            branch_id=branch_id,
            product_ids=[product_id],
            actor_user=self.request.user,
            extra_reason=extra_reason,
        )

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop("partial", False)
        instance = self.get_object()
        serializer = self.get_serializer(instance, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)

        self.perform_update(serializer)
        response_data = dict(serializer.data)

        if self._cancel_pending_transfers_due_to_inventory_change(serializer.instance):
            response_data[REMINDERS_SYNC_FLAG] = True

        return Response(response_data)

    def get_permissions(self):
        # "mover" traslada cantidad ya existente entre ubicaciones de una MISMA
        # sucursal (no crea ni destruye stock, solo lo reposiciona), asi que no
        # exige ningun permiso de modulo -- cualquier usuario autenticado puede
        # hacerlo en cualquier sucursal. Solo se valida que origen y destino
        # sean de la misma sucursal (mas abajo) y que la cantidad total no
        # cambie (se revalida en el servidor, no se confia en el cliente).
        if getattr(self, "action", None) == "mover":
            return [IsAuthenticated()]
        return super().get_permissions()

    @action(detail=False, methods=["post"], url_path="mover")
    def mover(self, request, *args, **kwargs):
        producto_id = request.data.get("producto_id")
        origen_subdivision_id = request.data.get("origen_subdivision_id")
        destino_subdivision_id = request.data.get("destino_subdivision_id")
        referencia = str(request.data.get("referencia") or "").strip()

        try:
            cantidad = int(request.data.get("cantidad"))
        except (TypeError, ValueError):
            return Response({"detail": "Ingresa una cantidad valida."}, status=status.HTTP_400_BAD_REQUEST)
        if cantidad <= 0:
            return Response({"detail": "Ingresa una cantidad valida."}, status=status.HTTP_400_BAD_REQUEST)

        if not producto_id or not origen_subdivision_id or not destino_subdivision_id:
            return Response(
                {"detail": "Faltan datos para completar el traslado."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if str(origen_subdivision_id) == str(destino_subdivision_id):
            return Response(
                {"detail": "Elige una ubicacion distinta a la actual."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        origen_subdivision = SubDivision.objects.select_related(
            "division__bodega__sucursal"
        ).filter(id=origen_subdivision_id).first()
        destino_subdivision = SubDivision.objects.select_related(
            "division__bodega__sucursal"
        ).filter(id=destino_subdivision_id).first()
        if not origen_subdivision or not destino_subdivision:
            return Response({"detail": "Ubicacion no encontrada."}, status=status.HTTP_404_NOT_FOUND)

        origen_sucursal_id = origen_subdivision.division.bodega.sucursal_id
        destino_sucursal_id = destino_subdivision.division.bodega.sucursal_id
        if origen_sucursal_id != destino_sucursal_id:
            return Response(
                {"detail": "Solo puedes trasladar entre ubicaciones de la misma sucursal."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            origen = (
                Inventario.objects.select_for_update()
                .filter(
                    producto_id=producto_id,
                    subdivision_id=origen_subdivision_id,
                    referencia=referencia,
                )
                .first()
            )
            if not origen or origen.cantidad < cantidad:
                return Response(
                    {"detail": "No hay suficiente cantidad disponible en la ubicacion de origen."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            remaining = origen.cantidad - cantidad
            if remaining > 0:
                origen.cantidad = remaining
                origen.save(update_fields=["cantidad"])
            else:
                origen.delete()
                origen = None

            destino, _ = Inventario.objects.select_for_update().get_or_create(
                producto_id=producto_id,
                subdivision_id=destino_subdivision_id,
                referencia=referencia,
                defaults={"cantidad": 0},
            )
            destino.cantidad = destino.cantidad + cantidad
            destino.save(update_fields=["cantidad"])

        response_data = {
            "origen": InventarioSerializer(origen).data if origen is not None else None,
            "destino": InventarioSerializer(destino).data,
        }
        if self._cancel_pending_transfers_due_to_inventory_change(destino):
            response_data[REMINDERS_SYNC_FLAG] = True

        return Response(response_data)

    def _parse_producto_ids_param(self):
        producto_ids_raw = (self.request.query_params.get("producto_ids") or "").strip()
        if not producto_ids_raw:
            return None
        ids = []
        for raw in producto_ids_raw.split(","):
            token = raw.strip()
            if token.isdigit():
                ids.append(int(token))
        return ids

    def _apply_product_filters_for_table(
        self,
        queryset,
        column_filters=None,
        allowed_branch_ids=None,
    ):
        params = self.request.query_params
        product_queryset = queryset

        producto_ids = self._parse_producto_ids_param()
        if producto_ids is not None:
            if not producto_ids:
                return product_queryset.none()
            product_queryset = product_queryset.filter(id__in=producto_ids)

        codigo = (params.get("codigo") or "").strip()
        if codigo:
            product_queryset = product_queryset.filter(codigo__icontains=codigo)

        nombre = (params.get("nombre") or "").strip()
        if nombre:
            product_queryset = product_queryset.filter(nombre__unaccent__icontains=nombre)

        descripcion = (params.get("descripcion") or "").strip()
        if descripcion:
            product_queryset = product_queryset.filter(descripcion__unaccent__icontains=descripcion)

        casa_comercial = (params.get("casa_comercial") or "").strip()
        if casa_comercial:
            product_queryset = product_queryset.filter(
                casas_comerciales__nombre__unaccent__icontains=casa_comercial
            )

        oem = (params.get("oem") or "").strip()
        if oem:
            product_queryset = product_queryset.filter(oem_productos__oem__codigo__icontains=oem)

        costo_minimo = (params.get("costo_minimo") or "").strip()
        if costo_minimo:
            try:
                product_queryset = product_queryset.filter(
                    costo_minimo=Decimal(costo_minimo)
                )
            except (InvalidOperation, ValueError):
                pass

        precio = (params.get("precio") or "").strip()
        if precio:
            try:
                product_queryset = product_queryset.filter(precio=Decimal(precio))
            except (InvalidOperation, ValueError):
                pass

        fecha_creacion = (params.get("fecha_creacion") or "").strip()
        if fecha_creacion:
            parsed = parse_date(fecha_creacion)
            if parsed:
                product_queryset = product_queryset.filter(creado_en__date=parsed)

        casa_filter = (column_filters or {}).get("casa_comercial_nombre")
        if casa_filter:
            product_queryset = apply_column_filters(
                product_queryset,
                {"casa_comercial_nombre": casa_filter},
                {"casa_comercial_nombre": "casas_comerciales__nombre"},
            )

        oem_filter = (column_filters or {}).get("oem_codes")
        if oem_filter:
            product_queryset = apply_column_filters(
                product_queryset,
                {"oem_codes": oem_filter},
                {"oem_codes": "oem_productos__oem__codigo"},
            )

        referencia_filter = (column_filters or {}).get("referencia")
        if referencia_filter:
            product_queryset = apply_column_filters(
                product_queryset,
                {"referencia": referencia_filter},
                {"referencia": "referencia"},
            )

        search_term = (self.request.query_params.get("search") or "").strip()
        if not search_term:
            return product_queryset.distinct()

        tokens = get_search_tokens(search_term)
        if not tokens:
            return product_queryset.distinct()

        # Coincidencias por casa comercial, OEM o ubicacion se resuelven con
        # una subconsulta (id__in=...) en vez de un join directo sobre
        # product_queryset. Antes cada palabra buscada se resolvia con un
        # .filter() encadenado que unia esas relaciones multivaluadas
        # directamente -- Django no reutiliza esos joins entre llamadas de
        # .filter(), asi que cada palabra multiplicaba las filas intermedias
        # sobre las anteriores. Con una busqueda de 4 palabras eso tardaba
        # mas de 13 minutos y encima devolvia 0 resultados (el join
        # explotaba antes de llegar al distinct() final). Una subconsulta
        # independiente por relacion y por palabra no infla las filas del
        # queryset principal, y el significado no cambia: por palabra,
        # "algun" registro relacionado que calce sigue bastando.
        # Los tokens ya vienen sin tildes ni eñes (get_search_tokens: "piñon"
        # -> "pinon"), asi que la comparacion tambien quita tildes y eñes del
        # lado de la base (unaccent). Con icontains crudo "pinon" nunca
        # coincidia con "PIÑON" y la busqueda parecia ignorar la ñ.
        for token in tokens:
            matching_casa_ids = Producto.objects.filter(
                casas_comerciales__nombre__unaccent__icontains=token
            ).values("id")
            matching_oem_ids = Producto.objects.filter(
                oem_productos__oem__codigo__unaccent__icontains=token
            ).values("id")
            # Un producto puede tener varias referencias (ProductoReferencia)
            # -- se busca en todas con la misma subconsulta independiente que
            # casa/OEM, no con un .filter() encadenado directo (mismo motivo
            # del comentario de arriba: evitar el fan-out de joins).
            matching_referencia_ids = Producto.objects.filter(
                referencias__valor__unaccent__icontains=token
            ).values("id")
            product_query = (
                Q(codigo__unaccent__icontains=token)
                | Q(nombre__unaccent__icontains=token)
                | Q(descripcion__unaccent__icontains=token)
                | Q(referencia__unaccent__icontains=token)
                | Q(id__in=matching_casa_ids)
                | Q(id__in=matching_oem_ids)
                | Q(id__in=matching_referencia_ids)
            )
            if allowed_branch_ids:
                matching_location_ids = Producto.objects.filter(
                    Q(
                        inventarios__subdivision__division__bodega__sucursal_id__in=allowed_branch_ids
                    )
                    & (
                        Q(inventarios__subdivision__nombre__unaccent__icontains=token)
                        | Q(inventarios__subdivision__division__nombre__unaccent__icontains=token)
                        | Q(
                            inventarios__subdivision__division__bodega__nombre__unaccent__icontains=token
                        )
                        | Q(
                            inventarios__subdivision__division__bodega__sucursal__nombre__unaccent__icontains=token
                        )
                        | Q(inventarios__referencia__unaccent__icontains=token)
                    )
                ).values("id")
                product_query |= Q(id__in=matching_location_ids)
            product_queryset = product_queryset.filter(product_query)

        return product_queryset.distinct()

    def _apply_total_range_filters(self, queryset):
        params = self.request.query_params
        cantidad_min = (params.get("cantidad_min") or "").strip()
        if cantidad_min:
            try:
                queryset = queryset.filter(total_general__gte=max(0, int(cantidad_min)))
            except (TypeError, ValueError):
                pass

        cantidad_max = (params.get("cantidad_max") or "").strip()
        if cantidad_max:
            try:
                queryset = queryset.filter(total_general__lte=max(0, int(cantidad_max)))
            except (TypeError, ValueError):
                pass

        return queryset

    def _resolve_table_ordering(self, branches):
        raw_ordering = (self.request.query_params.get("ordering") or "").strip()
        ordering_aliases = {
            "producto__codigo": "codigo",
            "producto__nombre": "nombre",
            "producto__costo_minimo": "costo_minimo",
            "producto__precio": "precio",
            "cantidad": "total_general",
            "codigo": "codigo",
            "nombre": "nombre",
            "referencia": "referencia",
            "costo_minimo": "costo_minimo",
            "precio": "precio",
            "precio_con_iva_backend": "precio",
            "total_general": "total_general",
            "oem_codes": "oem_codes_sort",
        }
        for branch in branches:
            field_name = f"sucursal_{branch.id}"
            ordering_aliases[field_name] = field_name
        for branch in branches:
            ordering_aliases[f"ubicacion_sucursal_{branch.id}"] = f"ubicacion_sort_{branch.id}"
            ordering_aliases[f"ubicacion_bajo_sucursal_{branch.id}"] = f"ubicacion_bajo_sort_{branch.id}"

        allowed_fields = set(ordering_aliases.values())
        resolved = []
        if raw_ordering:
            for raw_term in raw_ordering.split(","):
                term = raw_term.strip()
                if not term:
                    continue
                descending = term.startswith("-")
                source_key = term[1:] if descending else term
                target_key = ordering_aliases.get(source_key)
                if target_key not in allowed_fields:
                    continue
                resolved.append(f"-{target_key}" if descending else target_key)

        if not resolved:
            return ["-producto_id"]

        if "producto_id" not in {term.lstrip("-") for term in resolved}:
            resolved.append("producto_id")
        return resolved

    @staticmethod
    def _build_table_location_label(division_name, subdivision_name):
        division = str(division_name or "").strip()
        subdivision = str(subdivision_name or "").strip()
        if division and subdivision:
            return f"{division}:{subdivision}"
        return division or subdivision or "-"

    def _build_branch_location_payloads(self, product_ids, branch_ids):
        normalized_product_ids = sorted(
            {
                int(product_id)
                for product_id in product_ids
                if int(product_id or 0) > 0
            }
        )
        normalized_branch_ids = sorted(
            {int(branch_id) for branch_id in branch_ids if int(branch_id or 0) > 0}
        )
        if not normalized_product_ids or not normalized_branch_ids:
            return {}

        aggregated_locations = (
            # Tambien las ubicaciones en 0: se muestran (en rojo) junto a las
            # demas para que se vea donde falta stock.
            Inventario.objects.filter(
                producto_id__in=normalized_product_ids,
                subdivision__division__bodega__sucursal_id__in=normalized_branch_ids,
            )
            .values(
                "producto_id",
                "subdivision__division__bodega__sucursal_id",
                "subdivision__division__bodega_id",
                "subdivision__division__bodega__nombre",
                "subdivision__division_id",
                "subdivision__division__nombre",
                "subdivision_id",
                "subdivision__nombre",
            )
            .annotate(
                cantidad_total=Coalesce(
                    Sum("cantidad"),
                    Value(0),
                    output_field=IntegerField(),
                )
            )
        )

        locations_by_product_branch = defaultdict(list)
        for row in aggregated_locations:
            product_id = int(row.get("producto_id") or 0)
            branch_id = int(row.get("subdivision__division__bodega__sucursal_id") or 0)
            cantidad_total = max(0, int(row.get("cantidad_total") or 0))
            if product_id <= 0 or branch_id <= 0:
                continue

            bodega_nombre = str(
                row.get("subdivision__division__bodega__nombre") or ""
            ).strip()
            division_nombre = str(
                row.get("subdivision__division__nombre") or ""
            ).strip()
            subdivision_nombre = str(row.get("subdivision__nombre") or "").strip()
            locations_by_product_branch[(product_id, branch_id)].append(
                {
                    "bodega_id": int(row.get("subdivision__division__bodega_id") or 0),
                    "bodega_nombre": bodega_nombre,
                    "division_id": int(row.get("subdivision__division_id") or 0),
                    "division_nombre": division_nombre,
                    "subdivision_id": int(row.get("subdivision_id") or 0),
                    "subdivision_nombre": subdivision_nombre,
                    "cantidad": cantidad_total,
                    "ubicacion": self._build_table_location_label(
                        division_nombre,
                        subdivision_nombre,
                    ),
                }
            )

        # Orden elegido por el usuario (arrastrando en Ubicaciones).
        user_order = get_user_location_order(normalized_product_ids)

        payload_by_product = {}
        for (product_id, branch_id), locations in locations_by_product_branch.items():
            # Sin stock en ninguna ubicacion de la sucursal: igual que antes,
            # la celda queda vacia.
            if not any(int(location.get("cantidad") or 0) > 0 for location in locations):
                continue
            ordered_locations, principal = order_branch_locations(product_id, locations, user_order)
            ordered_locations = [principal] + [
                location for location in ordered_locations if location is not principal
            ]
            principal_payload = {
                "bodega_nombre": principal.get("bodega_nombre") or "",
                "ubicacion": principal.get("ubicacion") or "-",
                "division_nombre": principal.get("division_nombre") or "",
                "subdivision_nombre": principal.get("subdivision_nombre") or "",
                "cantidad": int(principal.get("cantidad") or 0),
                "stock_bajo": is_low_stock_principal(principal.get("cantidad")),
                "orden_definido": (int(product_id), int(principal.get("subdivision_id") or 0)) in user_order,
            }
            additional_locations = [
                {
                    "bodega_nombre": location.get("bodega_nombre") or "",
                    "ubicacion": location.get("ubicacion") or "-",
                    "division_nombre": location.get("division_nombre") or "",
                    "subdivision_nombre": location.get("subdivision_nombre") or "",
                    "cantidad": int(location.get("cantidad") or 0),
                    # El rojo es solo de la principal: las demas son respaldo.
                    "stock_bajo": False,
                }
                for location in ordered_locations[1:]
            ]
            product_payload = payload_by_product.setdefault(product_id, {})
            product_payload[branch_id] = {
                "principal": principal_payload,
                "ubicacion_principal": principal_payload["ubicacion"],
                "ubicaciones_adicionales": additional_locations,
                "total_ubicaciones": len(ordered_locations),
                # Rojo solo cuando hay ojo (varias ubicaciones) y a la
                # principal (la primera del orden, de cualquier bodega) le
                # queda poco. Antes miraba cualquier ubicacion del almacen.
                "tiene_stock_bajo": len(ordered_locations) > 1
                and is_low_stock_principal(principal.get("cantidad")),
            }

        return payload_by_product

    def _serialize_inventory_table_rows(self, rows, branches, location_branches=None):
        if location_branches is None:
            location_branches = branches
        rows_list = list(rows)
        product_ids = []
        for row in rows_list:
            product_id = int(row.get("producto_id") or 0)
            if product_id > 0:
                product_ids.append(product_id)

        branch_location_payloads = self._build_branch_location_payloads(
            product_ids,
            [int(branch.id or 0) for branch in location_branches],
        )

        # Unidades en camino hacia cada sucursal (traslados despachados y envios
        # de importacion aun no recibidos), solo para los productos de la pagina.
        from .por_ubicar import in_transit_by_product_branch

        in_transit = in_transit_by_product_branch(product_ids)

        products = (
            Producto.objects.filter(id__in=product_ids)
            .prefetch_related("casas_comerciales", "oem_productos__oem", "referencias")
        )
        product_meta = {}
        for product in products:
            casas = [
                casa.nombre
                for casa in product.casas_comerciales.all()
                if getattr(casa, "nombre", None)
            ]
            oem_codes = []
            for rel in product.oem_productos.all():
                codigo = getattr(getattr(rel, "oem", None), "codigo", None)
                if codigo:
                    oem_codes.append(codigo)
            referencias_list = [ref.valor for ref in product.referencias.all() if ref.valor]
            product_meta[int(product.id)] = {
                "casas_comerciales_nombres": ", ".join(casas),
                "casa_comercial_nombre": (casas[0] if casas else "") or "",
                "oem_codes": ", ".join(oem_codes),
                "oem_codes_list": oem_codes,
                "referencias_list": referencias_list,
            }

        serialized = []
        for row in rows_list:
            product_id = int(row.get("producto_id") or 0)
            if product_id <= 0:
                continue
            meta = product_meta.get(product_id, {})
            item = {
                "id": product_id,
                "producto_id": product_id,
                "codigo": row.get("codigo") or "",
                "nombre": row.get("nombre") or "",
                "descripcion": row.get("descripcion") or "",
                "referencia": row.get("referencia") or "",
                "referencias_list": meta.get("referencias_list") or [],
                "casa_comercial_nombre": meta.get("casa_comercial_nombre") or "",
                "casas_comerciales_nombres": meta.get("casas_comerciales_nombres") or "",
                "costo_minimo": row.get("costo_minimo"),
                "precio": row.get("precio"),
                "total_general": int(row.get("total_general") or 0),
                "oem_codes": meta.get("oem_codes") or "",
                "oem_codes_list": meta.get("oem_codes_list") or [],
                "creado_en": row.get("creado_en"),
            }
            branch_locations = branch_location_payloads.get(product_id, {})
            for branch in branches:
                field_name = f"sucursal_{branch.id}"
                item[field_name] = int(row.get(field_name) or 0)
                location_field_name = f"ubicacion_sucursal_{branch.id}"
                item[location_field_name] = branch_locations.get(int(branch.id))
                transit = in_transit.get((product_id, int(branch.id)))
                if transit:
                    item[f"en_camino_sucursal_{branch.id}"] = transit
            serialized.append(item)

        return serialized

    def _serialize_branch_list_for_table(self, branches):
        result = []
        for branch in branches:
            branch_id = int(branch.id or 0)
            if branch_id <= 0:
                continue
            result.append(
                {
                    "id": branch_id,
                    "nombre": str(branch.nombre or "").strip(),
                    "direccion": str(branch.direccion or "").strip(),
                }
            )
        return result

    @action(detail=False, methods=["get"], url_path="sucursales-tabla")
    def sucursales_tabla(self, request, *args, **kwargs):
        branches = Sucursal.objects.all()
        allowed_branch_ids = get_any_permitted_sucursal_ids(request.user)
        if allowed_branch_ids is not None:
            if not allowed_branch_ids:
                return Response([])
            branches = branches.filter(id__in=sorted(allowed_branch_ids))
        branches = branches.order_by("-id").values("id", "nombre", "direccion")
        payload = [
            {
                "id": int(branch.get("id") or 0),
                "nombre": str(branch.get("nombre") or "").strip(),
                "direccion": str(branch.get("direccion") or "").strip(),
            }
            for branch in branches
            if int(branch.get("id") or 0) > 0
        ]
        return Response(payload)

    @action(detail=False, methods=["get"], url_path="tabla")
    def tabla(self, request, *args, **kwargs):
        # All branches — quantities are shown for every branch regardless of permissions
        all_branches = list(Sucursal.objects.all().order_by("-id"))
        all_branch_ids = [int(branch.id) for branch in all_branches]

        if not all_branch_ids:
            page = self.paginate_queryset([])
            if page is not None:
                response = self.get_paginated_response([])
                response.data["branches"] = []
                response.data["permitted_branch_ids"] = None
                return response
            return Response({"results": [], "count": 0, "branches": [], "permitted_branch_ids": None})

        # Permitted branches — only these branches expose location data
        scoped_branch_ids = get_any_permitted_sucursal_ids(request.user)
        if scoped_branch_ids is None:
            permitted_branches = all_branches
            permitted_branch_ids_response = None  # None means "all branches"
        else:
            if not scoped_branch_ids:
                page = self.paginate_queryset([])
                if page is not None:
                    response = self.get_paginated_response([])
                    response.data["branches"] = []
                    response.data["permitted_branch_ids"] = []
                    return response
                return Response({"results": [], "count": 0, "branches": [], "permitted_branch_ids": []})
            permitted_branches = [b for b in all_branches if int(b.id) in scoped_branch_ids]
            permitted_branch_ids_response = [int(b.id) for b in permitted_branches]

        permitted_branch_ids_for_filter = [int(b.id) for b in permitted_branches]

        column_filters = parse_column_filters(request.query_params.get("column_filters"))
        product_queryset = self._apply_product_filters_for_table(
            Producto.objects.all(),
            column_filters=column_filters,
            allowed_branch_ids=permitted_branch_ids_for_filter,
        )

        product_ids = product_queryset.values("id").distinct()
        aggregated_queryset = (
            Producto.objects.filter(id__in=product_ids)
            .values("id")
            .annotate(
            producto_id=Max("id"),
            codigo=Max("codigo"),
            nombre=Max("nombre"),
            descripcion=Max("descripcion"),
            referencia=Max("referencia"),
            costo_minimo=Max("costo_minimo"),
            precio=Max("precio"),
            creado_en=Max("creado_en"),
            total_general=Coalesce(
                Sum(
                    "inventarios__cantidad",
                    filter=Q(
                        inventarios__subdivision__division__bodega__sucursal_id__in=all_branch_ids
                    ),
                ),
                Value(0),
                output_field=IntegerField(),
            ),
            )
        )
        for branch in all_branches:
            field_name = f"sucursal_{branch.id}"
            aggregated_queryset = aggregated_queryset.annotate(
                **{
                    field_name: Coalesce(
                        Sum(
                            "inventarios__cantidad",
                            filter=Q(
                                inventarios__subdivision__division__bodega__sucursal_id=branch.id
                            ),
                        ),
                        Value(0),
                        output_field=IntegerField(),
                    )
                }
            )

        ordering_param = (request.query_params.get("ordering") or "").strip()
        if "oem_codes" in ordering_param:
            first_oem_codigo_subquery = (
                OEMProducto.objects.filter(producto_id=OuterRef("id"))
                .order_by("id")
                .values("oem__codigo")[:1]
            )
            aggregated_queryset = aggregated_queryset.annotate(
                oem_codes_sort=Subquery(first_oem_codigo_subquery, output_field=CharField())
            )
        for branch in all_branches:
            ub_field = f"ubicacion_sucursal_{branch.id}"
            sort_field = f"ubicacion_sort_{branch.id}"
            if ub_field in ordering_param:
                aggregated_queryset = aggregated_queryset.annotate(
                    **{
                        sort_field: Subquery(
                            Inventario.objects.filter(
                                producto_id=OuterRef("id"),
                                cantidad__gt=0,
                                subdivision__division__bodega__sucursal_id=branch.id,
                            )
                            .order_by(
                                "-cantidad",
                                "subdivision__division__nombre",
                                "subdivision__nombre",
                            )
                            .annotate(
                                _full_label=Concat(
                                    "subdivision__division__nombre",
                                    Value(":"),
                                    "subdivision__nombre",
                                    output_field=CharField(),
                                )
                            )
                            .values("_full_label")[:1],
                            output_field=CharField(),
                        )
                    }
                )

            bajo_field = f"ubicacion_bajo_sucursal_{branch.id}"
            if bajo_field in ordering_param:
                # Misma regla que "tiene_stock_bajo" del payload: varias
                # ubicaciones en la sucursal, alguna con stock, y a la
                # principal (la primera del orden del usuario; si no hay
                # orden, la primera por nombre con stock) le queda poco.
                branch_q = Q(inventarios__subdivision__division__bodega__sucursal_id=branch.id)
                from .models import ProductoUbicacionOrden

                user_principal = Subquery(
                    ProductoUbicacionOrden.objects.filter(
                        producto_id=OuterRef("id"),
                        subdivision__division__bodega__sucursal_id=branch.id,
                    )
                    .filter(
                        Exists(
                            Inventario.objects.filter(
                                producto_id=OuterRef("producto_id"),
                                subdivision_id=OuterRef("subdivision_id"),
                            )
                        )
                    )
                    .order_by(
                        "orden",
                        Lower("subdivision__division__bodega__nombre"),
                        Lower("subdivision__division__nombre"),
                        Lower("subdivision__nombre"),
                        "subdivision_id",
                    )
                    .values("subdivision_id")[:1],
                    output_field=IntegerField(),
                )
                fallback_principal = Subquery(
                    Inventario.objects.filter(
                        producto_id=OuterRef("id"),
                        subdivision__division__bodega__sucursal_id=branch.id,
                    )
                    .values(
                        "subdivision_id",
                        "subdivision__division__bodega__nombre",
                        "subdivision__division__nombre",
                        "subdivision__nombre",
                        "subdivision__division__bodega_id",
                        "subdivision__division_id",
                    )
                    .annotate(_total=Sum("cantidad"))
                    .filter(_total__gt=0)
                    .order_by(
                        Lower("subdivision__division__bodega__nombre"),
                        Lower("subdivision__division__nombre"),
                        Lower("subdivision__nombre"),
                        "subdivision__division__bodega_id",
                        "subdivision__division_id",
                        "subdivision_id",
                    )
                    .values("subdivision_id")[:1],
                    output_field=IntegerField(),
                )
                aggregated_queryset = aggregated_queryset.annotate(
                    **{f"_ub_princ_{branch.id}": Coalesce(user_principal, fallback_principal)}
                ).annotate(
                    **{
                        f"_ub_princ_qty_{branch.id}": Coalesce(
                            Subquery(
                                Inventario.objects.filter(
                                    producto_id=OuterRef("id"),
                                    subdivision_id=OuterRef(f"_ub_princ_{branch.id}"),
                                )
                                .values("producto_id")
                                .annotate(_total=Sum("cantidad"))
                                .values("_total")[:1],
                                output_field=IntegerField(),
                            ),
                            Value(0),
                            output_field=IntegerField(),
                        ),
                        f"_ub_count_{branch.id}": Count(
                            "inventarios__subdivision", filter=branch_q, distinct=True
                        ),
                        f"_ub_pos_{branch.id}": Count(
                            "inventarios__id", filter=branch_q & Q(inventarios__cantidad__gt=0)
                        ),
                    }
                )
                aggregated_queryset = aggregated_queryset.annotate(
                    **{
                        f"_ub_low_{branch.id}": Case(
                            When(
                                **{f"_ub_princ_qty_{branch.id}__lte": LOW_STOCK_LOCATION_THRESHOLD},
                                then=Value(True),
                            ),
                            default=Value(False),
                            output_field=BooleanField(),
                        )
                    }
                ).annotate(
                    **{
                        f"ubicacion_bajo_sort_{branch.id}": Case(
                            When(
                                **{
                                    f"_ub_count_{branch.id}__gte": 2,
                                    f"_ub_pos_{branch.id}__gte": 1,
                                    f"_ub_low_{branch.id}": True,
                                },
                                then=Value(1),
                            ),
                            default=Value(0),
                            output_field=IntegerField(),
                        )
                    }
                )

        aggregated_queryset = self._apply_total_range_filters(aggregated_queryset)
        filtered_column_filters = dict(column_filters)
        filtered_column_filters.pop("casa_comercial_nombre", None)
        filtered_column_filters.pop("oem_codes", None)
        filtered_column_filters.pop("referencia", None)

        field_map = {
            "codigo": "codigo",
            "nombre": "nombre",
            "costo_minimo": {"lookup": "costo_minimo", "type": "number"},
            "precio": {"lookup": "precio", "type": "number"},
            "precio_con_iva": {"lookup": "precio", "type": "number"},
            "total_general": {"lookup": "total_general", "type": "number"},
        }
        for branch in all_branches:
            field_name = f"sucursal_{branch.id}"
            field_map[field_name] = {"lookup": field_name, "type": "number"}

        aggregated_queryset = apply_column_filters(
            aggregated_queryset,
            filtered_column_filters,
            field_map,
        )
        aggregated_queryset = aggregated_queryset.order_by(
            *self._resolve_table_ordering(all_branches)
        )

        branch_metadata = self._serialize_branch_list_for_table(all_branches)

        page = self.paginate_queryset(aggregated_queryset)
        if page is not None:
            serialized = self._serialize_inventory_table_rows(page, all_branches, location_branches=permitted_branches)
            response = self.get_paginated_response(serialized)
            response.data["branches"] = branch_metadata
            response.data["permitted_branch_ids"] = permitted_branch_ids_response
            return response

        serialized = self._serialize_inventory_table_rows(aggregated_queryset, all_branches, location_branches=permitted_branches)
        payload = {
            "results": serialized,
            "count": len(serialized),
            "branches": branch_metadata,
            "permitted_branch_ids": permitted_branch_ids_response,
        }
        return Response(payload)

    def get_queryset(self):
        queryset = super().get_queryset()
        if self.request.method not in ("GET", "HEAD", "OPTIONS"):
            allowed = get_allowed_sucursal_ids_for_modules(
                self.request.user,
                INVENTARIO_WRITE_SCOPE_MODULE_KEYS,
                action_key=METHOD_SCOPE_ACTION.get(self.request.method),
            )
            if allowed is not None:
                if not allowed:
                    return queryset.none()
                queryset = queryset.filter(
                    subdivision__division__bodega__sucursal_id__in=sorted(allowed)
                )
        params = self.request.query_params
        needs_distinct = bool((params.get("search") or "").strip())

        producto_ids_raw = (params.get("producto_ids") or "").strip()
        if producto_ids_raw:
            ids = []
            for raw in producto_ids_raw.split(","):
                token = raw.strip()
                if token.isdigit():
                    ids.append(int(token))
            if ids:
                queryset = queryset.filter(producto_id__in=ids)
            else:
                return queryset.none()

        codigo = (params.get("codigo") or "").strip()
        if codigo:
            queryset = queryset.filter(producto__codigo__icontains=codigo)

        nombre = (params.get("nombre") or "").strip()
        if nombre:
            queryset = queryset.filter(producto__nombre__unaccent__icontains=nombre)

        descripcion = (params.get("descripcion") or "").strip()
        if descripcion:
            queryset = queryset.filter(producto__descripcion__unaccent__icontains=descripcion)

        casa_comercial = (params.get("casa_comercial") or "").strip()
        if casa_comercial:
            needs_distinct = True
            queryset = queryset.filter(
                producto__casas_comerciales__nombre__unaccent__icontains=casa_comercial
            )

        oem = (params.get("oem") or "").strip()
        if oem:
            needs_distinct = True
            queryset = queryset.filter(producto__oem_productos__oem__codigo__icontains=oem)

        costo_minimo = (params.get("costo_minimo") or "").strip()
        if costo_minimo:
            try:
                queryset = queryset.filter(producto__costo_minimo=Decimal(costo_minimo))
            except (InvalidOperation, ValueError):
                pass

        precio = (params.get("precio") or "").strip()
        if precio:
            try:
                queryset = queryset.filter(producto__precio=Decimal(precio))
            except (InvalidOperation, ValueError):
                pass

        fecha_creacion = (params.get("fecha_creacion") or "").strip()
        if fecha_creacion:
            parsed = parse_date(fecha_creacion)
            if parsed:
                queryset = queryset.filter(producto__creado_en__date=parsed)

        cantidad_min = (params.get("cantidad_min") or "").strip()
        if cantidad_min:
            try:
                queryset = queryset.filter(cantidad__gte=max(0, int(cantidad_min)))
            except (TypeError, ValueError):
                pass

        cantidad_max = (params.get("cantidad_max") or "").strip()
        if cantidad_max:
            try:
                queryset = queryset.filter(cantidad__lte=max(0, int(cantidad_max)))
            except (TypeError, ValueError):
                pass

        column_filters = parse_column_filters(params.get("column_filters"))
        if column_filters.get("casa_comercial_nombre"):
            needs_distinct = True

        queryset = apply_column_filters(
            queryset,
            column_filters,
            {
                "codigo": "producto__codigo",
                "nombre": "producto__nombre",
                "casa_comercial_nombre": "producto__casas_comerciales__nombre",
                "costo_minimo": {"lookup": "producto__costo_minimo", "type": "number"},
                "precio": {"lookup": "producto__precio", "type": "number"},
                "cantidad": {"lookup": "cantidad", "type": "number"},
                "ubicacion": "subdivision__division__bodega__sucursal__nombre",
            },
        )
        return queryset.distinct() if needs_distinct else queryset

    @action(detail=False, methods=["post"], url_path="orden-ubicaciones")
    def orden_ubicaciones(self, request):
        """Guarda el orden de las ubicaciones de un producto en una sucursal
        (la primera es la principal). Body: {producto_id, sucursal_id,
        subdivision_ids: [en orden]}. Reemplaza el orden de esa sucursal."""
        from .models import ProductoUbicacionOrden

        producto_id = int(request.data.get("producto_id") or 0)
        sucursal_id = int(request.data.get("sucursal_id") or 0)
        raw_ids = request.data.get("subdivision_ids")
        if producto_id <= 0 or sucursal_id <= 0 or not isinstance(raw_ids, list) or not raw_ids:
            return Response(
                {"detail": "Debes enviar producto_id, sucursal_id y subdivision_ids (lista)."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        ensure_sucursal_allowed_for_modules(
            request.user,
            INVENTARIO_WRITE_SCOPE_MODULE_KEYS,
            sucursal_id,
            action_key="puede_actualizar",
        )
        from productos.models import Producto

        if not Producto.objects.filter(pk=producto_id).exists():
            return Response({"detail": "El producto no existe."}, status=status.HTTP_404_NOT_FOUND)
        subdivision_ids = []
        for raw in raw_ids:
            try:
                value = int(raw)
            except (TypeError, ValueError):
                continue
            if value > 0 and value not in subdivision_ids:
                subdivision_ids.append(value)
        valid_ids = set(
            SubDivision.objects.filter(
                pk__in=subdivision_ids, division__bodega__sucursal_id=sucursal_id
            ).values_list("id", flat=True)
        )
        if valid_ids != set(subdivision_ids):
            return Response(
                {"detail": "Una o mas ubicaciones no pertenecen a esa sucursal."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        with transaction.atomic():
            ProductoUbicacionOrden.objects.filter(
                producto_id=producto_id,
                subdivision__division__bodega__sucursal_id=sucursal_id,
            ).delete()
            ProductoUbicacionOrden.objects.bulk_create(
                [
                    ProductoUbicacionOrden(producto_id=producto_id, subdivision_id=sub_id, orden=index)
                    for index, sub_id in enumerate(subdivision_ids)
                ]
            )
        return Response(
            {"orden": {str(sub_id): index for index, sub_id in enumerate(subdivision_ids)}},
            status=status.HTTP_200_OK,
        )

    def perform_create(self, serializer):
        subdivision = serializer.validated_data.get("subdivision")
        sucursal_id = getattr(
            getattr(getattr(subdivision, "division", None), "bodega", None),
            "sucursal_id",
            None,
        )
        ensure_sucursal_allowed_for_modules(
            self.request.user,
            INVENTARIO_WRITE_SCOPE_MODULE_KEYS,
            sucursal_id,
            action_key="puede_crear",
        )
        serializer.save()

    def perform_update(self, serializer):
        subdivision = serializer.validated_data.get(
            "subdivision", serializer.instance.subdivision
        )
        sucursal_id = getattr(
            getattr(getattr(subdivision, "division", None), "bodega", None),
            "sucursal_id",
            None,
        )
        ensure_sucursal_allowed_for_modules(
            self.request.user,
            INVENTARIO_WRITE_SCOPE_MODULE_KEYS,
            sucursal_id,
            action_key="puede_actualizar",
        )
        serializer.save()
