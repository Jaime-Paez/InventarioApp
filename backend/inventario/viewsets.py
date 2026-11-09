import re
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


def is_bodega_location(location):
    """Ubicacion de una BODEGA (respaldo), no del almacen: "Bodega Matriz" en
    9 de Octubre. Estas nunca son la ubicacion principal."""
    nombre = strip_accents(str(location.get("bodega_nombre") or "")).strip().lower()
    return nombre.startswith("bodega")


def location_label_sort_key(label):
    """Orden de las ubicaciones al ordenar la columna Ub.: primero las de
    pasillo con letra ("1A:01"), luego las numericas (01:01 ... 14:01), despues
    las de nombre (ALMACEN, MOSTRADOR, B01...) y SIN UBICACION al final. Dentro
    de cada grupo, orden natural (01:02 antes que 01:10)."""
    text = strip_accents(str(label or "")).strip().upper()
    first = text.split(":", 1)[0].strip()
    if text.startswith("SIN UBICACION"):
        group = 3
    elif re.fullmatch(r"\d+[A-Z]+", first):
        group = 0
    elif first[:1].isdigit():
        group = 1
    else:
        group = 2
    natural = tuple(
        (0, int(part), "") if part.isdigit() else (1, 0, part)
        for part in re.findall(r"\d+|[^\d]+", text)
    )
    return (group, natural)


def _location_bodega_key(location):
    bodega_id = int((location or {}).get("bodega_id") or 0)
    if bodega_id:
        return ("id", bodega_id)
    return ("nombre", strip_accents(str((location or {}).get("bodega_nombre") or "")).strip().lower())


def needs_restock(principal, others):
    """Ojo en rojo: una ubicacion de OTRA bodega (ej. Bodega Matriz) tiene
    MAS que la principal (hay que pasar mercaderia al almacen). Las de la
    misma bodega que la principal (dos filas de Almacen Matriz) son todas
    principales: entre ellas no se compara."""
    principal_qty = int((principal or {}).get("cantidad") or 0)
    principal_bodega = _location_bodega_key(principal)
    return any(
        int(item.get("cantidad") or 0) > principal_qty
        for item in others
        if _location_bodega_key(item) != principal_bodega
    )


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

    - Las de una bodega (ej. "Bodega Matriz") siempre son secundarias: van
      despues de las del almacen y solo son principal si no hay ninguna del
      almacen.
    - Con orden elegido por el usuario: ese orden (las que no tienen orden van
      al final, por nombre) y la principal es la primera, aunque este en 0
      (asi se ve en rojo cuando se vacio).
    - Sin orden elegido: por nombre y la principal es la primera con stock
      del almacen (si ninguna del almacen tiene stock, la primera del almacen).
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
                1 if is_bodega_location(item) else 0,
                0 if order_of(item) is not None else 1,
                order_of(item) if order_of(item) is not None else 0,
                name_key(item),
            ),
        )
        return ordered, ordered[0]

    ordered = sorted(locations, key=lambda item: (1 if is_bodega_location(item) else 0, name_key(item)))
    almacen = [item for item in ordered if not is_bodega_location(item)] or ordered
    principal = next(
        (item for item in almacen if int(item.get("cantidad") or 0) > 0),
        almacen[0],
    )
    return [principal] + [item for item in ordered if item is not principal], principal


LOCATION_CATALOG_SCOPED_READ_MODULE_KEYS = (
    RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
    RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
    RolPermiso.Modulos.MOVIMIENTOS_INCONVENIENTES,
)

def _norm_motivo(texto):
    import unicodedata

    raw = unicodedata.normalize("NFD", str(texto or ""))
    return "".join(ch for ch in raw if unicodedata.category(ch) != "Mn").strip().lower()


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


# Una ubicacion (division del plano de la bodega) o una subdivision no se puede
# eliminar mientras tenga productos asignados, aunque esten en cantidad 0: se
# perderian esos registros (Inventario cae en cascada). El mensaje dice cuales
# son para moverlos o quitarlos antes.
STOCK_BLOCK_LIST_LIMIT = 10


def _productos_con_stock(inventario_qs):
    rows = (
        inventario_qs
        .values("producto__codigo", "producto__nombre")
        .annotate(total=Sum("cantidad"))
        .order_by("producto__codigo")
    )
    return [
        {
            "codigo": row["producto__codigo"] or "",
            "nombre": row["producto__nombre"] or "",
            "cantidad": int(row["total"] or 0),
        }
        for row in rows
    ]


def _stock_block_detail(ubicacion_label, productos):
    shown = productos[:STOCK_BLOCK_LIST_LIMIT]
    partes = ", ".join(
        f"{p['codigo'] or p['nombre']} ({p['cantidad']})" for p in shown
    )
    resto = len(productos) - len(shown)
    if resto > 0:
        partes += f" y {resto} más"
    return (
        f"No se puede eliminar {ubicacion_label} porque tiene productos asignados: "
        f"{partes}. Muévelos o quítalos de esa ubicación antes de eliminarla."
    )


def _stock_block_response(ubicacion_label, productos):
    return Response(
        {
            "code": "ubicacion_con_stock",
            "detail": _stock_block_detail(ubicacion_label, productos),
            "productos": productos,
        },
        status=status.HTTP_400_BAD_REQUEST,
    )


def _ubicacion_key(value):
    return str(value or "").strip().lower()


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

    def update(self, request, *args, **kwargs):
        # Quitar una ubicacion del plano: si su division tiene productos con
        # cantidad no se deja (quedarian en una ubicacion que ya no se ve).
        instance = self.get_object()
        if "ubicaciones" in request.data:
            nuevas = request.data.get("ubicaciones") or []
            nuevas_keys = {
                _ubicacion_key(u.get("nombre")) for u in nuevas if isinstance(u, dict)
            }
            quitadas = [
                u for u in (instance.ubicaciones or [])
                if isinstance(u, dict)
                and _ubicacion_key(u.get("nombre"))
                and _ubicacion_key(u.get("nombre")) not in nuevas_keys
            ]
            if quitadas:
                quitadas_keys = {_ubicacion_key(u.get("nombre")) for u in quitadas}
                for division in instance.divisiones.all():
                    if _ubicacion_key(division.nombre) not in quitadas_keys:
                        continue
                    productos = _productos_con_stock(
                        Inventario.objects.filter(subdivision__division=division)
                    )
                    if productos:
                        return _stock_block_response(
                            f'la ubicación "{division.nombre}"', productos
                        )
                # Sin productos: la division (y sus subdivisiones) se borra con
                # la ubicacion; si no, seguia saliendo al elegir ubicaciones.
                with transaction.atomic():
                    response = super().update(request, *args, **kwargs)
                    if response.status_code < 400:
                        sigue_en_plano = {
                            _ubicacion_key(u.get("nombre"))
                            for u in (self.get_object().ubicaciones or [])
                            if isinstance(u, dict)
                        }
                        for division in instance.divisiones.all():
                            key = _ubicacion_key(division.nombre)
                            if key in quitadas_keys and key not in sigue_en_plano:
                                division.delete()
                    return response
        return super().update(request, *args, **kwargs)

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

    @action(detail=True, methods=["get"], url_path="productos-con-stock")
    def productos_con_stock(self, request, pk=None):
        division = self.get_object()
        productos = _productos_con_stock(
            Inventario.objects.filter(subdivision__division=division)
        )
        return Response(
            {
                "productos": productos,
                "detail": (
                    _stock_block_detail(f'la ubicación "{division.nombre}"', productos)
                    if productos else ""
                ),
            }
        )

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        productos = _productos_con_stock(
            Inventario.objects.filter(subdivision__division=instance)
        )
        if productos:
            return _stock_block_response(f'la ubicación "{instance.nombre}"', productos)
        try:
            return super().destroy(request, *args, **kwargs)
        except ProtectedError:
            return Response(
                {"detail": "No se puede eliminar la ubicación porque está ligada a registros históricos."},
                status=status.HTTP_400_BAD_REQUEST,
            )


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
        productos = _productos_con_stock(Inventario.objects.filter(subdivision=instance))
        if productos:
            return _stock_block_response(f'la subdivisión "{instance.nombre}"', productos)
        try:
            return super().destroy(request, *args, **kwargs)
        except ProtectedError:
            return Response(
                {"detail": "No se puede eliminar la subdivisión porque está ligada a registros históricos."},
                status=status.HTTP_400_BAD_REQUEST,
            )

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

        product_queryset = self._apply_advanced_product_filters(product_queryset)

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

    @staticmethod
    def _parse_decimal_param(raw):
        value = str(raw or "").strip()
        if not value:
            return None
        try:
            return Decimal(value)
        except (InvalidOperation, ValueError):
            return None

    @staticmethod
    def _is_true_param(raw):
        return str(raw or "").strip().lower() in {"1", "true", "si", "yes"}

    def _apply_advanced_product_filters(self, product_queryset):
        """Filtros de la Busqueda avanzada de Inventario (nivel producto):
        referencia, rangos de precio/costo, rango de fecha de creacion y
        "datos incompletos" (sin precio, sin costo, sin casa, sin OEM)."""
        from productos.models import ProductoReferencia
        from usuarios.utils import is_app_admin

        params = self.request.query_params
        # El costo solo lo ve el administrador: tampoco se puede filtrar por el.
        can_filter_cost = is_app_admin(self.request.user)

        referencia = (params.get("referencia") or "").strip()
        if referencia:
            product_queryset = product_queryset.filter(
                Q(referencia__unaccent__icontains=referencia)
                | Q(
                    id__in=ProductoReferencia.objects.filter(
                        valor__unaccent__icontains=referencia
                    ).values("producto_id")
                )
            )

        ranges = [("precio_min", "precio__gte"), ("precio_max", "precio__lte")]
        if can_filter_cost:
            ranges += [("costo_min", "costo_minimo__gte"), ("costo_max", "costo_minimo__lte")]
        for param, lookup in ranges:
            value = self._parse_decimal_param(params.get(param))
            if value is not None:
                product_queryset = product_queryset.filter(**{lookup: value})

        fecha_desde = parse_date((params.get("fecha_desde") or "").strip())
        if fecha_desde:
            product_queryset = product_queryset.filter(creado_en__date__gte=fecha_desde)
        fecha_hasta = parse_date((params.get("fecha_hasta") or "").strip())
        if fecha_hasta:
            product_queryset = product_queryset.filter(creado_en__date__lte=fecha_hasta)

        if self._is_true_param(params.get("sin_precio")):
            product_queryset = product_queryset.filter(Q(precio__isnull=True) | Q(precio__lte=0))
        if can_filter_cost and self._is_true_param(params.get("sin_costo")):
            product_queryset = product_queryset.filter(
                Q(costo_minimo__isnull=True) | Q(costo_minimo__lte=0)
            )
        if self._is_true_param(params.get("sin_casa")):
            product_queryset = product_queryset.exclude(
                id__in=Producto.casas_comerciales.through.objects.values("producto_id")
            )
        if self._is_true_param(params.get("sin_oem")):
            product_queryset = product_queryset.exclude(
                id__in=OEMProducto.objects.values("producto_id")
            )

        # Ubicacion: productos que estan en esa sucursal / bodega / division /
        # subdivision. Se usa la mas especifica que se eligio.
        location_lookup = None
        for param, lookup in (
            ("ubic_subdivision", "subdivision_id"),
            ("ubic_division", "subdivision__division_id"),
            ("ubic_bodega", "subdivision__division__bodega_id"),
            ("ubic_sucursal", "subdivision__division__bodega__sucursal_id"),
        ):
            try:
                value = int(str(params.get(param) or "").strip())
            except ValueError:
                continue
            location_lookup = {lookup: value}
            break
        if location_lookup:
            product_queryset = product_queryset.filter(
                id__in=Inventario.objects.filter(**location_lookup).values("producto_id")
            )

        return product_queryset

    def _restock_product_ids(self, branch_ids):
        """Productos con el ojo en rojo en alguna de estas sucursales.

        Usa exactamente la misma funcion que arma el ojo de la tabla, pero solo
        sobre los productos que tienen 2 o mas ubicaciones en una sucursal (sin
        eso no hay ojo). Hacerlo con anotaciones SQL por sucursal tardaba ~30 s
        y pasaba el limite de 20 s de las consultas en produccion."""
        if not branch_ids:
            return []
        candidates = (
            Inventario.objects.filter(subdivision__division__bodega__sucursal_id__in=branch_ids)
            .values("producto_id", "subdivision__division__bodega__sucursal_id")
            .annotate(_ubicaciones=Count("subdivision_id", distinct=True))
            .filter(_ubicaciones__gte=2)
            .values_list("producto_id", flat=True)
        )
        payloads = self._build_branch_location_payloads(set(candidates), branch_ids)
        return sorted(
            product_id
            for product_id, by_branch in payloads.items()
            if any(payload.get("tiene_stock_bajo") for payload in by_branch.values())
        )

    def _principal_by_product(self, branch_id):
        """{producto_id: (ubicacion, cantidad)} de la ubicacion principal en la
        sucursal, con la misma regla que la celda de la tabla (solo productos
        con stock en alguna ubicacion de la sucursal)."""
        product_ids = set(
            Inventario.objects.filter(
                subdivision__division__bodega__sucursal_id=branch_id, cantidad__gt=0
            ).values_list("producto_id", flat=True)
        )
        payloads = self._build_branch_location_payloads(product_ids, [branch_id])
        result = {}
        for product_id, by_branch in payloads.items():
            principal = (by_branch.get(int(branch_id)) or {}).get("principal")
            if principal:
                result[product_id] = (
                    str(principal.get("ubicacion") or ""),
                    int(principal.get("cantidad") or 0),
                )
        return result

    def _apply_total_range_filters(self, queryset):
        params = self.request.query_params
        stock = (params.get("stock") or "").strip().lower()
        if stock == "con":
            queryset = queryset.filter(total_general__gt=0)
        elif stock == "sin":
            queryset = queryset.filter(total_general__lte=0)

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
                if target_key.startswith("ubicacion_sort_"):
                    # Sin ubicacion en la sucursal (celda vacia): al final en
                    # ambos sentidos; dentro de la misma ubicacion, la de mas
                    # unidades primero.
                    resolved.append(target_key.replace("ubicacion_sort_", "ubicacion_vacia_"))
                    resolved.append(f"-{target_key}" if descending else target_key)
                    resolved.append("-" + target_key.replace("ubicacion_sort_", "ubicacion_cant_"))
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
            restock = needs_restock(principal, ordered_locations[1:])
            principal_payload = {
                "bodega_nombre": principal.get("bodega_nombre") or "",
                "ubicacion": principal.get("ubicacion") or "-",
                "division_nombre": principal.get("division_nombre") or "",
                "subdivision_nombre": principal.get("subdivision_nombre") or "",
                "cantidad": int(principal.get("cantidad") or 0),
                "stock_bajo": restock,
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
                # Ojo en rojo: alguna secundaria tiene mas que la principal.
                "tiene_stock_bajo": restock,
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

        # Repuestos despachados a ordenes de taller abiertas (ya no estan en
        # el stock de la sucursal; se muestran aparte, en verde).
        try:
            from taller.stock import en_taller_por_producto_sucursal

            en_taller = en_taller_por_producto_sucursal(product_ids)
        except Exception:  # pragma: no cover - el taller nunca debe romper el inventario
            en_taller = {}

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
                taller = en_taller.get((product_id, int(branch.id)))
                if taller:
                    item[f"en_taller_sucursal_{branch.id}"] = taller
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
            if not re.search(rf"(^|,)-?{ub_field}(,|$)", ordering_param):
                continue
            # Orden por el nombre de la ubicacion principal (la de la celda):
            # 1A primero, luego 01..14, despues las de nombre (ALMACEN,
            # MOSTRADOR...) y SIN UBICACION al final. Se calcula con la misma
            # regla de la tabla y se agrupa para que el CASE quede corto.
            principals = self._principal_by_product(int(branch.id))
            labels = sorted({label for label, _ in principals.values()}, key=location_label_sort_key)
            rank_of = {label: index for index, label in enumerate(labels)}
            ids_by_rank = defaultdict(list)
            ids_by_qty = defaultdict(list)
            for product_id, (label, qty) in principals.items():
                ids_by_rank[rank_of[label]].append(product_id)
                ids_by_qty[qty].append(product_id)
            aggregated_queryset = aggregated_queryset.annotate(
                **{
                    f"ubicacion_sort_{branch.id}": Case(
                        *[When(id__in=ids, then=Value(rank)) for rank, ids in ids_by_rank.items()],
                        default=Value(None),
                        output_field=IntegerField(),
                    ),
                    f"ubicacion_cant_{branch.id}": Case(
                        *[When(id__in=ids, then=Value(qty)) for qty, ids in ids_by_qty.items()],
                        default=Value(None),
                        output_field=IntegerField(),
                    ),
                    f"ubicacion_vacia_{branch.id}": Case(
                        When(id__in=list(principals), then=Value(0)),
                        default=Value(1),
                        output_field=IntegerField(),
                    ),
                }
            )

        # Restock bodega (Busqueda avanzada): productos con el ojo en rojo en
        # alguna de las sucursales que el usuario ve (o en la elegida).
        if self._is_true_param(request.query_params.get("restock_bodega")):
            restock_branch_raw = (request.query_params.get("restock_sucursal") or "").strip()
            restock_branches = [
                b for b in permitted_branches
                if not restock_branch_raw.isdigit() or int(b.id) == int(restock_branch_raw)
            ]
            aggregated_queryset = aggregated_queryset.filter(
                id__in=self._restock_product_ids([int(b.id) for b in restock_branches])
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

    def _por_guardar_branch_ids(self, request):
        """Sucursales donde el usuario guarda lo de POR UBICAR: las de entradas
        (donde recibe), igual que Envios pendientes. Inventario no sirve: no
        tiene alcance por sucursal y a todos les salia lo de todas. None = todas."""
        ids = get_readable_sucursal_ids(request.user, RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS)
        return None if ids is None else {int(branch_id) for branch_id in ids}

    def _close_finished_shipments(self, shipments, *, actor=None):
        """Un envio que ya llego y no tiene nada por contar (todo se vendio o
        se guardo) se cierra solo: si no, sin pendientes no aparece en "Por
        ubicar" y nadie podria terminar su conteo. Devuelve los que siguen."""
        from importaciones.models import ImportacionEnvio
        from importaciones.viewsets import finish_envio_count

        from .por_ubicar import serialize_progress

        remaining = []
        for shipment in shipments:
            if not shipment["items"] or any(int(item["pendiente"]) > 0 for item in shipment["items"]):
                remaining.append(shipment)
                continue
            with transaction.atomic():
                envio = (
                    ImportacionEnvio.objects.select_for_update()
                    .filter(
                        pk=shipment["id"],
                        estado=ImportacionEnvio.ESTADO_PENDIENTE,
                        llegada_confirmada_en__isnull=False,
                    )
                    .first()
                )
                if envio is None:
                    continue
                # Se vuelve a mirar con el envio bloqueado (una venta o un
                # guardado pudo cambiarlo mientras tanto).
                pendiente = sum(
                    int(entry.get("pendiente_guardar") or 0)
                    for entry in serialize_progress(envio.recepcion_progreso, envio.sucursal_id).values()
                )
                if pendiente > 0:
                    remaining.append(shipment)
                    continue
                finish_envio_count(envio, actor=actor)
        return remaining

    def _arrived_shipments(self, allowed, sucursal_id=None):
        """Envios de importacion que ya llegaron (paso 1: todo entro a POR
        UBICAR y se puede vender) y faltan contar y guardar. Por producto:
        - vendido: lo que salio de POR UBICAR antes de contarlo.
        - guardado: lo ya contado y guardado en su ubicacion.
        - pendiente: lo que queda por contar (sigue en POR UBICAR)."""
        from django.db.models import Prefetch

        from importaciones.models import ImportacionEnvio, ImportacionEnvioDetalle

        from .por_ubicar import normalize_progress, serialize_progress_many

        # Solo los campos que se usan: la importacion y la compra traen JSON
        # grandes (borradores, historial) que hacian lenta la lista.
        envios = (
            ImportacionEnvio.objects.filter(
                estado=ImportacionEnvio.ESTADO_PENDIENTE,
                llegada_confirmada_en__isnull=False,
            )
            .select_related("importacion", "compra_local", "sucursal")
            .only(
                "id",
                "sucursal_id",
                "importacion_id",
                "compra_local_id",
                "llegada_confirmada_en",
                "recepcion_progreso",
                "importacion__codigo",
                "compra_local__no_documento",
                "sucursal__nombre",
            )
        )
        if sucursal_id:
            envios = envios.filter(sucursal_id=sucursal_id)
        if allowed is not None:
            envios = envios.filter(sucursal_id__in=sorted(allowed))
        envios = list(
            envios.prefetch_related(
                Prefetch(
                    "detalles",
                    queryset=ImportacionEnvioDetalle.objects.select_related("producto").only(
                        "id", "envio_id", "producto_id", "cantidad", "producto__codigo", "producto__nombre"
                    ),
                )
            )
        )
        avances = serialize_progress_many([(envio.recepcion_progreso, envio.sucursal_id) for envio in envios])

        shipments = []
        for envio, avance in zip(envios, avances):
            progreso = normalize_progress(envio.recepcion_progreso)
            enviados = {}
            productos = {}
            for detalle in envio.detalles.all():
                pid = int(detalle.producto_id)
                enviados[pid] = enviados.get(pid, 0) + int(detalle.cantidad or 0)
                productos[pid] = detalle.producto
            items = []
            for pid, enviado in enviados.items():
                entry = progreso.get(str(pid)) or {"recibido": 0, "por_ubicar": 0}
                pendiente = int((avance.get(str(pid)) or {}).get("pendiente_guardar") or 0)
                producto = productos[pid]
                items.append(
                    {
                        "producto_id": pid,
                        "producto_codigo": producto.codigo or "",
                        "producto_nombre": producto.nombre or "",
                        "enviado": enviado,
                        "vendido": max(0, entry["por_ubicar"] - pendiente),
                        "guardado": max(0, entry["recibido"] - entry["por_ubicar"]),
                        "pendiente": pendiente,
                    }
                )
            items.sort(key=lambda item: (item["pendiente"] == 0, item["producto_codigo"].lower()))
            shipments.append(
                {
                    "tipo": "importacion",
                    "id": int(envio.id),
                    "codigo": envio.documento,
                    "origen": "Compra local" if envio.compra_local_id else "Importacion",
                    "sucursal_id": int(envio.sucursal_id),
                    "sucursal_nombre": str(getattr(envio.sucursal, "nombre", "") or "").strip(),
                    "llegada_confirmada_en": envio.llegada_confirmada_en,
                    "items": items,
                }
            )
        shipments.sort(key=lambda item: (item["sucursal_nombre"].lower(), str(item["llegada_confirmada_en"])))
        return shipments

    @action(detail=False, methods=["get"], url_path="por-guardar")
    def por_guardar(self, request):
        """"Por ubicar" (paso 2 de la recepcion de importaciones):
        - envios: envios de importacion que ya llegaron. Lo enviado ya esta en
          el stock (POR UBICAR, entre parentesis en el inventario) y se puede
          vender; aqui se cuenta lo que queda de cada producto y se guarda en
          su ubicacion. Al terminar, lo que no aparecio es faltante.
        - productos: lo demas que haya en POR UBICAR (ya en stock) por guardar.
        Con cada producto va la ubicacion sugerida (su principal en esa
        sucursal) y, por sucursal, las ubicaciones donde se puede guardar.
        `?solo_conteo=1` = contador del boton."""
        from .por_ubicar import POR_UBICAR_NOMBRE

        allowed = self._por_guardar_branch_ids(request)
        sucursal_raw = str(request.query_params.get("sucursal_id") or "").strip()
        sucursal_id = int(sucursal_raw) if sucursal_raw.isdigit() else None
        rows_qs = Inventario.objects.filter(
            cantidad__gt=0,
            subdivision__nombre__iexact=POR_UBICAR_NOMBRE,
            subdivision__division__nombre__iexact=POR_UBICAR_NOMBRE,
        )
        if sucursal_id:
            rows_qs = rows_qs.filter(subdivision__division__bodega__sucursal_id=sucursal_id)
        if allowed is not None:
            rows_qs = rows_qs.filter(subdivision__division__bodega__sucursal_id__in=sorted(allowed))

        shipments = self._close_finished_shipments(
            self._arrived_shipments(allowed, sucursal_id), actor=request.user
        )

        # Lo que esta en POR UBICAR por un envio de importacion se cuenta en su
        # envio; en "productos" va solo el resto (si no, saldria dos veces).
        de_envios = defaultdict(int)
        for shipment in shipments:
            for item in shipment["items"]:
                de_envios[(int(item["producto_id"]), int(shipment["sucursal_id"]))] += int(item["pendiente"])
        rows = []
        for row in rows_qs.values(
            "producto_id",
            "producto__codigo",
            "producto__nombre",
            "subdivision_id",
            "subdivision__division__bodega__sucursal_id",
            "subdivision__division__bodega__sucursal__nombre",
        ).annotate(total=Sum("cantidad")).order_by("producto_id", "subdivision_id"):
            key = (int(row["producto_id"]), int(row["subdivision__division__bodega__sucursal_id"]))
            descontar = min(int(row["total"] or 0), de_envios[key])
            de_envios[key] -= descontar
            row["total"] = int(row["total"] or 0) - descontar
            if row["total"] > 0:
                rows.append(row)

        if str(request.query_params.get("solo_conteo") or "").strip() in {"1", "true"}:
            pending_lines = sum(1 for s in shipments for item in s["items"] if item["pendiente"] > 0)
            return Response({"count": pending_lines + len(rows)})

        product_ids = sorted(
            {int(row["producto_id"]) for row in rows}
            | {int(item["producto_id"]) for s in shipments for item in s["items"]}
        )
        branch_ids = sorted(
            {int(row["subdivision__division__bodega__sucursal_id"]) for row in rows}
            | {int(s["sucursal_id"]) for s in shipments}
        )

        # Ubicaciones donde se puede guardar (todas menos POR UBICAR). Con
        # values(): select_related traia el plano de la bodega (`ubicaciones`)
        # repetido en cada una de las ~2000 filas y tardaba segundos.
        storage = {}
        for sub in (
            SubDivision.objects.filter(division__bodega__sucursal_id__in=branch_ids)
            .exclude(nombre__iexact=POR_UBICAR_NOMBRE, division__nombre__iexact=POR_UBICAR_NOMBRE)
            .order_by("division__bodega__nombre", "division__nombre", "nombre", "id")
            .values("id", "nombre", "division__nombre", "division__bodega__nombre", "division__bodega__sucursal_id")
        ):
            bodega, division, nombre = sub["division__bodega__nombre"], sub["division__nombre"], sub["nombre"]
            storage.setdefault(int(sub["division__bodega__sucursal_id"]), []).append(
                {
                    "id": int(sub["id"]),
                    "bodega": bodega,
                    "division": division,
                    "subdivision": nombre,
                    "label": f"{bodega} / {division} / {nombre}",
                }
            )

        # Ubicacion sugerida: la principal del producto en esa sucursal (fuera de POR UBICAR).
        existing = defaultdict(list)
        for loc in (
            Inventario.objects.filter(
                producto_id__in=product_ids,
                subdivision__division__bodega__sucursal_id__in=branch_ids,
            )
            .exclude(
                subdivision__nombre__iexact=POR_UBICAR_NOMBRE,
                subdivision__division__nombre__iexact=POR_UBICAR_NOMBRE,
            )
            .values(
                "producto_id",
                "subdivision_id",
                "subdivision__nombre",
                "subdivision__division_id",
                "subdivision__division__nombre",
                "subdivision__division__bodega_id",
                "subdivision__division__bodega__nombre",
                "subdivision__division__bodega__sucursal_id",
            )
            .annotate(cantidad=Sum("cantidad"))
        ):
            existing[(int(loc["producto_id"]), int(loc["subdivision__division__bodega__sucursal_id"]))].append(
                {
                    "subdivision_id": int(loc["subdivision_id"]),
                    "subdivision_nombre": loc["subdivision__nombre"] or "",
                    "division_id": int(loc["subdivision__division_id"]),
                    "division_nombre": loc["subdivision__division__nombre"] or "",
                    "bodega_id": int(loc["subdivision__division__bodega_id"]),
                    "bodega_nombre": loc["subdivision__division__bodega__nombre"] or "",
                    "cantidad": int(loc["cantidad"] or 0),
                }
            )
        user_order = get_user_location_order(product_ids)

        def suggestion(pid, branch_id):
            locations = existing.get((pid, branch_id)) or []
            principal = order_branch_locations(pid, locations, user_order)[1] if locations else None
            if not principal:
                return {"sugerida_subdivision_id": None, "sugerida_label": ""}
            return {
                "sugerida_subdivision_id": int(principal["subdivision_id"]),
                "sugerida_label": (
                    f"{principal['bodega_nombre']} / {principal['division_nombre']} / {principal['subdivision_nombre']}"
                ),
            }

        for shipment in shipments:
            for item in shipment["items"]:
                item.update(suggestion(item["producto_id"], shipment["sucursal_id"]))

        payload = []
        for row in rows:
            pid = int(row["producto_id"])
            branch_id = int(row["subdivision__division__bodega__sucursal_id"])
            payload.append(
                {
                    "producto_id": pid,
                    "producto_codigo": row["producto__codigo"] or "",
                    "producto_nombre": row["producto__nombre"] or "",
                    "sucursal_id": branch_id,
                    "sucursal_nombre": row["subdivision__division__bodega__sucursal__nombre"] or "",
                    "cantidad": int(row["total"] or 0),
                    **suggestion(pid, branch_id),
                }
            )
        payload.sort(key=lambda item: (item["sucursal_nombre"].lower(), item["producto_codigo"].lower()))
        return Response(
            {
                "envios": shipments,
                "productos": payload,
                "ubicaciones": {str(branch_id): items for branch_id, items in storage.items()},
            }
        )

    @action(detail=False, methods=["post"], url_path="guardar-por-ubicar")
    def guardar_por_ubicar(self, request):
        """Mueve desde POR UBICAR a su ubicacion. Body: {items: [{producto_id,
        sucursal_id, subdivision_id, cantidad?}]} (sin cantidad = todo)."""
        from .por_ubicar import POR_UBICAR_NOMBRE, add_stock, get_por_ubicar_subdivision, take_stock

        items = request.data.get("items")
        if not isinstance(items, list) or not items:
            return Response({"detail": "Debes enviar los productos a guardar en `items`."}, status=status.HTTP_400_BAD_REQUEST)
        allowed = self._por_guardar_branch_ids(request)
        results = []
        with transaction.atomic():
            for raw in items:
                try:
                    pid = int(raw.get("producto_id"))
                    branch_id = int(raw.get("sucursal_id"))
                    subdivision_id = int(raw.get("subdivision_id"))
                except (TypeError, ValueError, AttributeError):
                    transaction.set_rollback(True)
                    return Response(
                        {"detail": "Cada producto debe tener producto, sucursal y ubicacion validos."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if allowed is not None and branch_id not in allowed:
                    transaction.set_rollback(True)
                    return Response({"detail": "No tienes acceso a esa sucursal."}, status=status.HTTP_403_FORBIDDEN)
                destino = (
                    SubDivision.objects.select_related("division")
                    .filter(pk=subdivision_id, division__bodega__sucursal_id=branch_id)
                    .first()
                )
                if destino is None:
                    transaction.set_rollback(True)
                    return Response(
                        {"detail": "La ubicacion no pertenece a la sucursal."}, status=status.HTTP_400_BAD_REQUEST
                    )
                if (
                    str(destino.nombre or "").strip().upper() == POR_UBICAR_NOMBRE
                    and str(destino.division.nombre or "").strip().upper() == POR_UBICAR_NOMBRE
                ):
                    transaction.set_rollback(True)
                    return Response(
                        {"detail": "Elige una ubicacion distinta de POR UBICAR."}, status=status.HTTP_400_BAD_REQUEST
                    )
                por_ubicar = get_por_ubicar_subdivision(branch_id, create=False)
                if por_ubicar is None:
                    transaction.set_rollback(True)
                    return Response({"detail": "No hay nada en POR UBICAR en esa sucursal."}, status=status.HTTP_400_BAD_REQUEST)
                disponible = sum(
                    int(qty or 0)
                    for qty in Inventario.objects.filter(subdivision_id=por_ubicar.id, producto_id=pid).values_list(
                        "cantidad", flat=True
                    )
                )
                # Lo de un envio de importacion que falta contar se guarda
                # desde su envio, no desde aqui.
                disponible -= sum(
                    int(item["pendiente"])
                    for shipment in self._arrived_shipments(None, branch_id)
                    for item in shipment["items"]
                    if int(item["producto_id"]) == pid
                )
                disponible = max(0, disponible)
                cantidad = disponible
                if raw.get("cantidad") not in (None, ""):
                    try:
                        cantidad = int(raw.get("cantidad"))
                    except (TypeError, ValueError):
                        cantidad = -1
                if cantidad <= 0 or cantidad > disponible:
                    transaction.set_rollback(True)
                    return Response(
                        {"detail": f"Cantidad no valida: en POR UBICAR hay {disponible} de este producto."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                movido = take_stock(por_ubicar.id, pid, cantidad)
                add_stock(destino.id, pid, movido)
                results.append({"producto_id": pid, "sucursal_id": branch_id, "subdivision_id": destino.id, "cantidad": movido})
        return Response({"guardados": results})

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

    @action(detail=False, methods=["post"], url_path="ajustar")
    def ajustar(self, request, *args, **kwargs):
        """Guarda de una vez las cantidades editadas de las ubicaciones de un
        producto. Si el total de una sucursal sube o baja es un ajuste de
        inventario: exige motivo y queda registrado (sale en el Kardex).
        Repartir entre ubicaciones de la misma sucursal no es ajuste.

        Body: {producto_id, motivo?, cambios: [{id?, subdivision_id, cantidad, eliminar?}]}
        (cantidad 0 en una fila existente la elimina; con eliminar=false la
        ubicacion se queda en 0: un ajuste que no quita la ubicacion). Sin motivo y con
        cambio de total responde 400 code=motivo_requerido con los ajustes
        para que el usuario elija el motivo y reenvie."""
        from .models import AjusteInventario

        try:
            producto_id = int(request.data.get("producto_id"))
        except (TypeError, ValueError):
            return Response({"detail": "Falta producto_id."}, status=status.HTTP_400_BAD_REQUEST)
        producto = Producto.objects.filter(id=producto_id).first()
        if not producto:
            return Response({"detail": "Producto no encontrado."}, status=status.HTTP_404_NOT_FOUND)
        motivo = str(request.data.get("motivo") or "").strip()[:200]
        cambios = request.data.get("cambios")
        if not isinstance(cambios, list):
            return Response({"detail": "cambios debe ser una lista."}, status=status.HTTP_400_BAD_REQUEST)

        parsed = []
        for raw in cambios:
            if not isinstance(raw, dict):
                return Response({"detail": "Cambio no valido."}, status=status.HTTP_400_BAD_REQUEST)
            try:
                cantidad = int(raw.get("cantidad"))
                subdivision_id = int(raw.get("subdivision_id")) if raw.get("subdivision_id") not in (None, "") else None
                inv_id = int(raw.get("id")) if raw.get("id") not in (None, "") else None
            except (TypeError, ValueError):
                return Response({"detail": "Cantidad o ubicacion no valida."}, status=status.HTTP_400_BAD_REQUEST)
            if cantidad < 0:
                return Response({"detail": "La cantidad no puede ser negativa."}, status=status.HTTP_400_BAD_REQUEST)
            if inv_id is None and subdivision_id is None:
                return Response({"detail": "Falta la ubicacion."}, status=status.HTTP_400_BAD_REQUEST)
            # Sin "eliminar" se mantiene lo de antes: 0 borra la ubicacion.
            eliminar = raw.get("eliminar", True) not in (False, "false", "0", 0)
            parsed.append((inv_id, subdivision_id, cantidad, eliminar))

        def _totales(sucursal_ids):
            rows = (
                Inventario.objects.filter(
                    producto_id=producto_id,
                    subdivision__division__bodega__sucursal_id__in=sorted(sucursal_ids),
                )
                .values("subdivision__division__bodega__sucursal_id")
                .annotate(total=Sum("cantidad"))
            )
            result = {sid: 0 for sid in sucursal_ids}
            for row in rows:
                result[row["subdivision__division__bodega__sucursal_id"]] = int(row["total"] or 0)
            return result

        sucursales_tocadas = set()
        with transaction.atomic():
            plan = []
            for inv_id, subdivision_id, cantidad, eliminar in parsed:
                if inv_id is not None:
                    inv = (
                        Inventario.objects.select_for_update()
                        .select_related("subdivision__division__bodega")
                        .filter(id=inv_id, producto_id=producto_id)
                        .first()
                    )
                    if not inv:
                        transaction.set_rollback(True)
                        return Response({"detail": "Una de las ubicaciones ya no existe; recarga el producto."}, status=status.HTTP_404_NOT_FOUND)
                    sucursal_id = inv.subdivision.division.bodega.sucursal_id
                    plan.append(("existing", inv, None, cantidad, eliminar, sucursal_id))
                else:
                    subdivision = SubDivision.objects.select_related("division__bodega").filter(id=subdivision_id).first()
                    if not subdivision:
                        transaction.set_rollback(True)
                        return Response({"detail": "Ubicacion no valida."}, status=status.HTTP_400_BAD_REQUEST)
                    sucursal_id = subdivision.division.bodega.sucursal_id
                    plan.append(("new", None, subdivision, cantidad, eliminar, sucursal_id))
                sucursales_tocadas.add(sucursal_id)

            antes = _totales(sucursales_tocadas)
            for kind, inv, subdivision, cantidad, eliminar, sucursal_id in plan:
                if kind == "existing":
                    action_key = "puede_eliminar" if cantidad == 0 and eliminar else "puede_actualizar"
                else:
                    action_key = "puede_crear"
                ensure_sucursal_allowed_for_modules(
                    request.user, INVENTARIO_WRITE_SCOPE_MODULE_KEYS, sucursal_id, action_key=action_key
                )
                if kind == "existing":
                    if cantidad == 0 and eliminar:
                        inv.delete()
                    elif inv.cantidad != cantidad:
                        inv.cantidad = cantidad
                        inv.save(update_fields=["cantidad"])
                    continue
                existing = Inventario.objects.select_for_update().filter(
                    producto_id=producto_id, subdivision=subdivision, referencia=""
                ).first()
                if existing:
                    if cantidad == 0 and eliminar:
                        existing.delete()
                    elif existing.cantidad != cantidad:
                        existing.cantidad = cantidad
                        existing.save(update_fields=["cantidad"])
                elif cantidad > 0:
                    Inventario.objects.create(
                        producto_id=producto_id, subdivision=subdivision, referencia="", cantidad=cantidad
                    )
            despues = _totales(sucursales_tocadas)

            nombres = dict(Sucursal.objects.filter(id__in=sorted(sucursales_tocadas)).values_list("id", "nombre"))
            ajustes = [
                {
                    "sucursal_id": sid,
                    "sucursal": nombres.get(sid, ""),
                    "cantidad_anterior": antes[sid],
                    "cantidad_nueva": despues[sid],
                    "diferencia": despues[sid] - antes[sid],
                }
                for sid in sorted(sucursales_tocadas)
                if despues[sid] != antes[sid]
            ]
            if motivo and _norm_motivo(motivo) == "no encontre" and any(a["diferencia"] > 0 for a in ajustes):
                # "No encontré" solo cuando la cantidad baja.
                transaction.set_rollback(True)
                return Response(
                    {"detail": '"No encontré" solo se puede usar cuando la cantidad baja.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if ajustes and not motivo:
                transaction.set_rollback(True)
                return Response(
                    {
                        "code": "motivo_requerido",
                        "detail": "Cambio la cantidad del producto: elige el motivo del ajuste.",
                        "ajustes": ajustes,
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            for ajuste in ajustes:
                AjusteInventario.objects.create(
                    producto_id=producto_id,
                    sucursal_id=ajuste["sucursal_id"],
                    cantidad_anterior=ajuste["cantidad_anterior"],
                    cantidad_nueva=ajuste["cantidad_nueva"],
                    diferencia=ajuste["diferencia"],
                    motivo=motivo,
                    usuario=request.user if request.user.is_authenticated else None,
                )

        response_data = {"ajustes": ajustes}
        extra_reason = build_sale_stock_change_extra_reason(None)
        sync = False
        for sid in sorted(sucursales_tocadas):
            if cancel_pending_transfer_requests(
                branch_id=sid, product_ids=[producto_id], actor_user=request.user, extra_reason=extra_reason
            ):
                sync = True
        if sync:
            response_data[REMINDERS_SYNC_FLAG] = True
        return Response(response_data)
