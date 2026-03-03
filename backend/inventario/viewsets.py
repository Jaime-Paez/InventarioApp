from decimal import Decimal, InvalidOperation

from django.db.models import (
    Case,
    CharField,
    IntegerField,
    Max,
    Q,
    Sum,
    Value,
    When,
)
from django.db.models.functions import Coalesce
from django.utils.dateparse import parse_date
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.table_filters import apply_column_filters, parse_column_filters
from productos.models import Producto
from usuarios.models import RolPermiso
from usuarios.permissions import (
    BodegasModulePermission,
    InventarioModulePermission,
    SucursalScopedModulePermission,
)
from usuarios.sucursal_scope import (
    apply_sucursal_scope,
    ensure_sucursal_allowed,
)

from .models import Bodega, Division, Inventario, SubDivision, Sucursal
from .serializers import (
    BodegaSerializer,
    DivisionSerializer,
    InventarioSerializer,
    SubDivisionSerializer,
    SucursalSerializer,
)


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
        return apply_sucursal_scope(
            queryset,
            self.request.user,
            self._resolve_scope_module_key(),
            "id",
        )


class BodegaViewSet(viewsets.ModelViewSet):
    queryset = Bodega.objects.select_related("sucursal").all().order_by(
        "-id"
    )
    serializer_class = BodegaSerializer
    permission_classes = [IsAuthenticated, BodegasModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "sucursal__nombre"]
    ordering_fields = ["nombre", "sucursal__nombre"]

    def get_queryset(self):
        queryset = super().get_queryset()
        return apply_sucursal_scope(
            queryset,
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            "sucursal_id",
        )

    def perform_create(self, serializer):
        sucursal = serializer.validated_data.get("sucursal")
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            getattr(sucursal, "id", None),
        )
        serializer.save()

    def perform_update(self, serializer):
        sucursal = serializer.validated_data.get("sucursal", serializer.instance.sucursal)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            getattr(sucursal, "id", None),
        )
        serializer.save()


class DivisionViewSet(viewsets.ModelViewSet):
    queryset = (
        Division.objects.select_related("tipo_division", "bodega", "bodega__sucursal")
        .all()
        .order_by("-id")
    )
    serializer_class = DivisionSerializer
    permission_classes = [IsAuthenticated, BodegasModulePermission]
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
        return apply_sucursal_scope(
            queryset,
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            "bodega__sucursal_id",
        )

    def perform_create(self, serializer):
        bodega = serializer.validated_data.get("bodega")
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            getattr(bodega, "sucursal_id", None),
        )
        serializer.save()

    def perform_update(self, serializer):
        bodega = serializer.validated_data.get("bodega", serializer.instance.bodega)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            getattr(bodega, "sucursal_id", None),
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
    permission_classes = [IsAuthenticated, BodegasModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "division__nombre", "division__bodega__nombre"]
    ordering_fields = ["nombre", "division__nombre"]

    def get_queryset(self):
        queryset = super().get_queryset()
        return apply_sucursal_scope(
            queryset,
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            "division__bodega__sucursal_id",
        )

    def perform_create(self, serializer):
        division = serializer.validated_data.get("division")
        sucursal_id = getattr(getattr(division, "bodega", None), "sucursal_id", None)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            sucursal_id,
        )
        serializer.save()

    def perform_update(self, serializer):
        division = serializer.validated_data.get("division", serializer.instance.division)
        sucursal_id = getattr(getattr(division, "bodega", None), "sucursal_id", None)
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            sucursal_id,
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
            "producto__marca",
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
    permission_classes = [IsAuthenticated, InventarioModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "producto__codigo",
        "producto__nombre",
        "producto__descripcion",
        "producto__marca__nombre",
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
        "producto__marca__nombre",
        "producto__pieza_original",
        "producto__costo_minimo",
        "producto__precio",
        "cantidad",
        "subdivision__nombre",
        "subdivision__division__nombre",
        "subdivision__division__bodega__nombre",
        "subdivision__division__bodega__sucursal__nombre",
    ]

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
            product_queryset = product_queryset.filter(nombre__icontains=nombre)

        descripcion = (params.get("descripcion") or "").strip()
        if descripcion:
            product_queryset = product_queryset.filter(descripcion__icontains=descripcion)

        marca = (params.get("marca") or "").strip()
        if marca:
            product_queryset = product_queryset.filter(marca__nombre__icontains=marca)

        casa_comercial = (params.get("casa_comercial") or "").strip()
        if casa_comercial:
            product_queryset = product_queryset.filter(
                casas_comerciales__nombre__icontains=casa_comercial
            )

        oem = (params.get("oem") or "").strip()
        if oem:
            product_queryset = product_queryset.filter(oem_productos__oem__codigo__icontains=oem)

        pieza_original = (params.get("pieza_original") or "").strip().lower()
        if pieza_original in {"true", "1", "si", "sí"}:
            product_queryset = product_queryset.filter(pieza_original=True)
        elif pieza_original in {"false", "0", "no"}:
            product_queryset = product_queryset.filter(pieza_original=False)

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

        search_term = (self.request.query_params.get("search") or "").strip()
        if not search_term:
            return product_queryset.distinct()

        product_query = (
            Q(codigo__icontains=search_term)
            | Q(nombre__icontains=search_term)
            | Q(descripcion__icontains=search_term)
            | Q(marca__nombre__icontains=search_term)
            | Q(casas_comerciales__nombre__icontains=search_term)
            | Q(oem_productos__oem__codigo__icontains=search_term)
        )
        if allowed_branch_ids:
            location_query = (
                Q(
                    inventarios__subdivision__division__bodega__sucursal_id__in=allowed_branch_ids
                )
                & (
                    Q(inventarios__subdivision__nombre__icontains=search_term)
                    | Q(inventarios__subdivision__division__nombre__icontains=search_term)
                    | Q(
                        inventarios__subdivision__division__bodega__nombre__icontains=search_term
                    )
                    | Q(
                        inventarios__subdivision__division__bodega__sucursal__nombre__icontains=search_term
                    )
                    | Q(inventarios__referencia__icontains=search_term)
                )
            )
            product_query |= location_query

        return product_queryset.filter(product_query).distinct()

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
            "producto__marca__nombre": "marca_nombre",
            "producto__pieza_original": "pieza_original_num",
            "producto__costo_minimo": "costo_minimo",
            "producto__precio": "precio",
            "cantidad": "total_general",
            "codigo": "codigo",
            "nombre": "nombre",
            "marca_nombre": "marca_nombre",
            "pieza_original_label": "pieza_original_label_text",
            "costo_minimo": "costo_minimo",
            "precio": "precio",
            "precio_con_iva": "precio",
            "total_general": "total_general",
        }
        for branch in branches:
            field_name = f"sucursal_{branch.id}"
            ordering_aliases[field_name] = field_name

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

    def _serialize_inventory_table_rows(self, rows, branches):
        rows_list = list(rows)
        product_ids = []
        for row in rows_list:
            product_id = int(row.get("producto_id") or 0)
            if product_id > 0:
                product_ids.append(product_id)

        products = (
            Producto.objects.filter(id__in=product_ids)
            .select_related("marca")
            .prefetch_related("casas_comerciales", "oem_productos__oem")
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
            product_meta[int(product.id)] = {
                "casas_comerciales_nombres": ", ".join(casas),
                "casa_comercial_nombre": (casas[0] if casas else "") or "",
                "oem_codes": ", ".join(oem_codes),
                "marca_nombre": getattr(getattr(product, "marca", None), "nombre", "") or "",
            }

        serialized = []
        for row in rows_list:
            product_id = int(row.get("producto_id") or 0)
            if product_id <= 0:
                continue
            meta = product_meta.get(product_id, {})
            piece_original = bool(int(row.get("pieza_original_num") or 0))
            item = {
                "id": product_id,
                "producto_id": product_id,
                "codigo": row.get("codigo") or "",
                "nombre": row.get("nombre") or "",
                "descripcion": row.get("descripcion") or "",
                "marca_nombre": row.get("marca_nombre")
                or meta.get("marca_nombre")
                or "",
                "pieza_original": piece_original,
                "pieza_original_label": "Si" if piece_original else "No",
                "casa_comercial_nombre": meta.get("casa_comercial_nombre") or "",
                "casas_comerciales_nombres": meta.get("casas_comerciales_nombres") or "",
                "costo_minimo": row.get("costo_minimo"),
                "precio": row.get("precio"),
                "total_general": int(row.get("total_general") or 0),
                "oem_codes": meta.get("oem_codes") or "",
                "creado_en": row.get("creado_en"),
            }
            for branch in branches:
                field_name = f"sucursal_{branch.id}"
                item[field_name] = int(row.get(field_name) or 0)
            serialized.append(item)

        return serialized

    @action(detail=False, methods=["get"], url_path="tabla")
    def tabla(self, request, *args, **kwargs):
        branches = list(
            apply_sucursal_scope(
                Sucursal.objects.all().order_by("-id"),
                request.user,
                RolPermiso.Modulos.INVENTARIO,
                "id",
            )
        )
        allowed_branch_ids = [int(branch.id) for branch in branches]
        if not allowed_branch_ids:
            page = self.paginate_queryset([])
            if page is not None:
                return self.get_paginated_response([])
            return Response([])

        column_filters = parse_column_filters(request.query_params.get("column_filters"))
        product_queryset = self._apply_product_filters_for_table(
            Producto.objects.all(),
            column_filters=column_filters,
            allowed_branch_ids=allowed_branch_ids,
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
            marca_nombre=Max("marca__nombre"),
            pieza_original_num=Coalesce(
                Max(
                    Case(
                        When(pieza_original=True, then=Value(1)),
                        default=Value(0),
                        output_field=IntegerField(),
                    )
                ),
                Value(0),
                output_field=IntegerField(),
            ),
            costo_minimo=Max("costo_minimo"),
            precio=Max("precio"),
            creado_en=Max("creado_en"),
            total_general=Coalesce(
                Sum(
                    "inventarios__cantidad",
                    filter=Q(
                        inventarios__subdivision__division__bodega__sucursal_id__in=allowed_branch_ids
                    ),
                ),
                Value(0),
                output_field=IntegerField(),
            ),
            )
        )
        aggregated_queryset = aggregated_queryset.annotate(
            pieza_original_label_text=Case(
                When(pieza_original_num__gte=1, then=Value("Si")),
                default=Value("No"),
                output_field=CharField(),
            )
        )

        for branch in branches:
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

        aggregated_queryset = self._apply_total_range_filters(aggregated_queryset)
        filtered_column_filters = dict(column_filters)
        filtered_column_filters.pop("casa_comercial_nombre", None)

        field_map = {
            "codigo": "codigo",
            "nombre": "nombre",
            "marca_nombre": "marca_nombre",
            "pieza_original_label": "pieza_original_label_text",
            "costo_minimo": {"lookup": "costo_minimo", "type": "number"},
            "precio": {"lookup": "precio", "type": "number"},
            "precio_con_iva": {"lookup": "precio", "type": "number"},
            "total_general": {"lookup": "total_general", "type": "number"},
        }
        for branch in branches:
            field_name = f"sucursal_{branch.id}"
            field_map[field_name] = {"lookup": field_name, "type": "number"}

        aggregated_queryset = apply_column_filters(
            aggregated_queryset,
            filtered_column_filters,
            field_map,
        )
        aggregated_queryset = aggregated_queryset.order_by(
            *self._resolve_table_ordering(branches)
        )

        page = self.paginate_queryset(aggregated_queryset)
        if page is not None:
            serialized = self._serialize_inventory_table_rows(page, branches)
            return self.get_paginated_response(serialized)

        serialized = self._serialize_inventory_table_rows(aggregated_queryset, branches)
        return Response(serialized)

    def get_queryset(self):
        queryset = super().get_queryset()
        queryset = apply_sucursal_scope(
            queryset,
            self.request.user,
            RolPermiso.Modulos.INVENTARIO,
            "subdivision__division__bodega__sucursal_id",
        )
        queryset = queryset.annotate(
            pieza_original_label_text=Case(
                When(producto__pieza_original=True, then=Value("Si")),
                default=Value("No"),
                output_field=CharField(),
            )
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
            queryset = queryset.filter(producto__nombre__icontains=nombre)

        descripcion = (params.get("descripcion") or "").strip()
        if descripcion:
            queryset = queryset.filter(producto__descripcion__icontains=descripcion)

        marca = (params.get("marca") or "").strip()
        if marca:
            queryset = queryset.filter(producto__marca__nombre__icontains=marca)

        casa_comercial = (params.get("casa_comercial") or "").strip()
        if casa_comercial:
            needs_distinct = True
            queryset = queryset.filter(
                producto__casas_comerciales__nombre__icontains=casa_comercial
            )

        oem = (params.get("oem") or "").strip()
        if oem:
            needs_distinct = True
            queryset = queryset.filter(producto__oem_productos__oem__codigo__icontains=oem)

        pieza_original = (params.get("pieza_original") or "").strip().lower()
        if pieza_original in {"true", "1", "si", "sí"}:
            queryset = queryset.filter(producto__pieza_original=True)
        elif pieza_original in {"false", "0", "no"}:
            queryset = queryset.filter(producto__pieza_original=False)

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
                "marca_nombre": "producto__marca__nombre",
                "pieza_original_label": "pieza_original_label_text",
                "casa_comercial_nombre": "producto__casas_comerciales__nombre",
                "costo_minimo": {"lookup": "producto__costo_minimo", "type": "number"},
                "precio": {"lookup": "producto__precio", "type": "number"},
                "cantidad": {"lookup": "cantidad", "type": "number"},
                "ubicacion": "subdivision__division__bodega__sucursal__nombre",
            },
        )
        return queryset.distinct() if needs_distinct else queryset

    def perform_create(self, serializer):
        subdivision = serializer.validated_data.get("subdivision")
        sucursal_id = getattr(
            getattr(getattr(subdivision, "division", None), "bodega", None),
            "sucursal_id",
            None,
        )
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.INVENTARIO,
            sucursal_id,
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
        ensure_sucursal_allowed(
            self.request.user,
            RolPermiso.Modulos.INVENTARIO,
            sucursal_id,
        )
        serializer.save()

