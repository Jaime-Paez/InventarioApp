from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models import Case, CharField, DecimalField, ExpressionWrapper, F, IntegerField, OuterRef, Q, Subquery, Sum, Value, When
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

from .models import OEM, OEMProducto, Producto, ProductoAlterno, ProductoReferencia, sync_producto_referencia_primary
from .serializers import (
    OEMProductoSerializer,
    OEMSerializer,
    ProductoCalificacionSerializer,
    ProductoDetailSerializer,
    ProductoAlternoSerializer,
    ProductoReferenciaSerializer,
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


def sync_group_oems(producto_ids):
    """Reparte a todos los productos del grupo la union de sus OEM."""
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


GRUPO_BASE_LEN = 5


def codigo_base(codigo):
    codigo = str(codigo or "").strip().upper()
    return codigo[:GRUPO_BASE_LEN] if len(codigo) >= GRUPO_BASE_LEN else ""


class ProductoViewSet(viewsets.ModelViewSet):
    queryset = (
        Producto.objects.prefetch_related(
            "casas_comerciales__pais", "oem_productos__oem", "alternativas__alterno", "referencias"
        )
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
        "referencias__valor",
        "casas_comerciales__nombre",
        "oem_productos__oem__codigo",
    ]
    ordering_fields = [
        "nombre",
        "codigo",
        "descripcion",
        "referencia",
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
        # Los productos inactivos no salen en las busquedas (entradas,
        # salidas, solicitudes, importaciones...). Solo con incluir_inactivos.
        if self.action == "list" and str(params.get("incluir_inactivos") or "").strip().lower() not in {"1", "true", "si"}:
            queryset = queryset.filter(activo=True)
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

        codigos_raw = (params.get("codigos") or "").strip()
        if codigos_raw:
            codigos = [c.strip() for c in codigos_raw.split(",") if c.strip()][:300]
            if codigos:
                codigos_filter = Q()
                for value in codigos:
                    codigos_filter |= Q(codigo__iexact=value)
                queryset = queryset.filter(codigos_filter)
            else:
                queryset = queryset.none()

        referencia = (params.get("referencia") or "").strip()
        if referencia:
            # Un producto puede tener varias referencias -- se busca en todas
            # (Producto.referencia es solo una copia de la primera, ver
            # sync_producto_referencia_primary, así que ya queda incluida).
            queryset = queryset.filter(referencias__valor__icontains=referencia).distinct()

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
                "referencia": "referencias__valor",
                "oem_codes": "oem_productos__oem__codigo",
                "casa_comercial_nombre": "casas_comerciales__nombre",
            },
        )

        # Con "search" (FuzzyTokenSearchFilter) el orden por defecto
        # (-creado_en, -id) puede dejar un match exacto de codigo fuera de la
        # primera pagina cuando hay varios productos con codigos parecidos
        # (ej. "P0936S-R" vs "P0936SL-R"/"P0936SO-R"). Se prioriza el codigo
        # exacto, luego el que empieza con el termino buscado, antes de caer
        # al orden por defecto.
        search_term = (params.get("search") or "").strip()
        if search_term:
            queryset = queryset.annotate(
                _search_relevance=Case(
                    When(codigo__iexact=search_term, then=Value(0)),
                    When(codigo__istartswith=search_term, then=Value(1)),
                    default=Value(2),
                    output_field=IntegerField(),
                )
            ).order_by("_search_relevance", "-creado_en", "-id")

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

    @action(detail=True, methods=["patch"], url_path="cambiar-activo")
    def cambiar_activo(self, request, pk=None):
        """Inactiva o reactiva el producto (mismo permiso que editarlo)."""
        producto = self.get_object()
        activo = str(request.data.get("activo", "")).strip().lower() in {"1", "true", "si"}
        if producto.activo != activo:
            producto.activo = activo
            producto.save(update_fields=["activo", "actualizado_en"])
        return Response({"id": producto.id, "codigo": producto.codigo, "activo": producto.activo})

    @action(detail=True, methods=["get"], url_path="calificacion")
    def calificacion(self, request, pk=None):
        producto = self.get_object()
        return Response(build_producto_rating_summary(producto), status=status.HTTP_200_OK)

    @action(detail=True, methods=["get"], url_path="grupo-sugerido")
    def grupo_sugerido(self, request, pk=None):
        """Productos con el mismo codigo base (primeros 5 caracteres) que este:
        candidatos a vincular como alternos. Cada uno indica si ya es alterno
        directo para que la ficha solo proponga los que faltan."""
        producto = self.get_object()
        base = codigo_base(producto.codigo)
        if not base:
            return Response({"base": "", "productos": []}, status=status.HTTP_200_OK)

        directos = set(
            ProductoAlterno.objects.filter(producto_id=producto.id).values_list("alterno_id", flat=True)
        ) | set(
            ProductoAlterno.objects.filter(alterno_id=producto.id).values_list("producto_id", flat=True)
        )
        candidatos = (
            Producto.objects.filter(codigo__istartswith=base)
            .exclude(id=producto.id)
            .prefetch_related("oem_productos__oem")
            .order_by("codigo")[:100]
        )
        payload = [
            {
                "id": p.id,
                "codigo": p.codigo,
                "nombre": p.nombre,
                "descripcion": getattr(p, "descripcion", "") or "",
                "oem_productos": [
                    {"oem": {"id": rel.oem_id, "codigo": rel.oem.codigo}} for rel in p.oem_productos.all()
                ],
                "ya_alterno": p.id in directos,
            }
            for p in candidatos
        ]
        return Response({"base": base, "productos": payload}, status=status.HTTP_200_OK)

    @action(detail=True, methods=["post"], url_path="vincular-grupo")
    def vincular_grupo(self, request, pk=None):
        """Vincula como alternos entre si (todos con todos, en ambos sentidos)
        este producto y los ids recibidos, y les reparte la union de sus OEM.
        Asi cualquiera del grupo muestra a los demas como alternos directos."""
        producto = self.get_object()
        raw_ids = request.data.get("ids") or []
        if not isinstance(raw_ids, list):
            raise ValidationError({"ids": "Debe ser una lista de ids de producto."})
        try:
            ids = {int(value) for value in raw_ids if value not in (None, "")}
        except (TypeError, ValueError):
            raise ValidationError({"ids": "Ids de producto invalidos."})
        ids.add(producto.id)
        existentes = set(Producto.objects.filter(id__in=ids).values_list("id", flat=True))
        if len(existentes) < 2:
            return Response({"creados": 0}, status=status.HTTP_200_OK)

        with transaction.atomic():
            ya = set(
                ProductoAlterno.objects.filter(producto_id__in=existentes, alterno_id__in=existentes)
                .values_list("producto_id", "alterno_id")
            )
            nuevos = [
                ProductoAlterno(producto_id=a, alterno_id=b)
                for a in existentes
                for b in existentes
                if a != b and (a, b) not in ya
            ]
            if nuevos:
                ProductoAlterno.objects.bulk_create(nuevos, ignore_conflicts=True)
            sync_group_oems(get_alterno_group_ids(producto.id))
        return Response({"creados": len(nuevos)}, status=status.HTTP_200_OK)

    @action(detail=True, methods=["post"], url_path="nombre-grupo")
    def nombre_grupo(self, request, pk=None):
        """Pone el mismo nombre a este producto y a todos sus alternos (todo el
        grupo). Se guarda producto por producto para que quede en el
        historial de cada uno."""
        from usuarios.utils import is_app_admin
        if not is_app_admin(request.user):
            raise PermissionDenied("Solo el administrador puede poner el mismo nombre a todos los alternos.")
        producto = self.get_object()
        nombre = str(request.data.get("nombre") or "").strip()
        if not nombre:
            raise ValidationError({"nombre": "Escribe el nombre."})
        max_len = Producto._meta.get_field("nombre").max_length
        if max_len and len(nombre) > max_len:
            raise ValidationError({"nombre": f"El nombre puede tener hasta {max_len} caracteres."})
        grupo = get_alterno_group_ids(producto.id) | {producto.id}
        cambiados = []
        with transaction.atomic():
            for item in Producto.objects.filter(id__in=grupo).order_by("codigo"):
                if item.nombre == nombre:
                    continue
                item.nombre = nombre
                item.save(update_fields=["nombre", "actualizado_en"])
                cambiados.append(item.codigo)
        return Response({"nombre": nombre, "cambiados": cambiados, "total": len(grupo)}, status=status.HTTP_200_OK)

    @action(detail=True, methods=["get", "post"], url_path="ubicaciones-grupo")
    def ubicaciones_grupo(self, request, pk=None):
        """"Unificar ubicaciones" (solo administrador).
        GET: todas las ubicaciones que tiene este producto o alguno de sus
        alternos, con quien la tiene. POST {subdivision_id}: todo el grupo
        pasa a esa ubicacion en su sucursal (ver abajo). POR UBICAR, TEMPORAL
        y SIN UBICACION no se pueden escoger."""
        from usuarios.utils import is_app_admin
        from inventario.por_ubicar import is_special_subdivision
        from inventario.models import SubDivision
        from core.search_utils import strip_accents

        if not is_app_admin(request.user):
            raise PermissionDenied("Solo el administrador puede unificar las ubicaciones de los alternos.")
        producto = self.get_object()
        grupo = get_alterno_group_ids(producto.id) | {producto.id}

        def copiable(sub):
            nombre_div = str(getattr(sub.division, "nombre", "") or "")
            sin_ubic = "sin ubic" in strip_accents(nombre_div).lower() or "sin ubic" in strip_accents(sub.nombre or "").lower()
            return not is_special_subdivision(sub) and not sin_ubic

        filas = (
            Inventario.objects.filter(producto_id__in=grupo)
            .select_related("producto", "subdivision__division__bodega__sucursal", "subdivision__division__tipo_division")
        )
        if request.method == "GET":
            ubicaciones = {}
            for fila in filas:
                sub = fila.subdivision
                if not copiable(sub):
                    continue
                bodega = sub.division.bodega
                item = ubicaciones.setdefault(sub.id, {
                    "subdivision_id": sub.id,
                    "nombre": f"{sub.division.nombre} - {sub.nombre}",
                    "bodega": bodega.nombre,
                    "sucursal_id": bodega.sucursal_id,
                    "sucursal": getattr(bodega.sucursal, "nombre", ""),
                    "productos": {},
                })
                prev = item["productos"].get(fila.producto_id)
                item["productos"][fila.producto_id] = {
                    "id": fila.producto_id,
                    "codigo": fila.producto.codigo,
                    "cantidad": (prev["cantidad"] if prev else 0) + int(fila.cantidad or 0),
                }
            data = []
            for item in ubicaciones.values():
                item["productos"] = sorted(item["productos"].values(), key=lambda p: p["codigo"] or "")
                data.append(item)
            data.sort(key=lambda u: (u["sucursal"] or "", u["bodega"] or "", u["nombre"]))
            return Response({"total_productos": len(grupo), "ubicaciones": data}, status=status.HTTP_200_OK)

        # POST: se escoge UNA ubicacion de una sucursal y todo el grupo pasa a
        # ella: el stock que cada producto tiene en las otras ubicaciones de
        # esa sucursal se mueve ahi (el total no cambia, no es ajuste) y esas
        # ubicaciones se quitan. POR UBICAR y TEMPORAL no se tocan. Quien no
        # tenga stock queda con la ubicacion en 0. Queda como principal.
        from inventario.models import ProductoUbicacionOrden

        try:
            destino_id = int(request.data.get("subdivision_id"))
        except (TypeError, ValueError):
            raise ValidationError({"subdivision_id": "Escoge la ubicacion."})
        destino = (
            SubDivision.objects.select_related("division__bodega", "division__tipo_division")
            .filter(id=destino_id)
            .first()
        )
        if not destino or not copiable(destino):
            raise ValidationError({"subdivision_id": "Esa ubicacion no se puede usar."})
        if not filas.filter(subdivision_id=destino_id).exists():
            raise ValidationError({"subdivision_id": "Esa ubicacion no es de este grupo de alternos."})
        sucursal_id = destino.division.bodega.sucursal_id

        movidas = 0
        quitadas = 0
        with transaction.atomic():
            origenes = list(
                Inventario.objects.select_for_update()
                .filter(producto_id__in=grupo, subdivision__division__bodega__sucursal_id=sucursal_id)
                .exclude(subdivision_id=destino_id)
                .select_related("subdivision__division__tipo_division", "subdivision__division__bodega")
            )
            for origen in origenes:
                if is_special_subdivision(origen.subdivision):
                    continue
                cantidad = int(origen.cantidad or 0)
                if cantidad > 0:
                    fila, _ = Inventario.objects.select_for_update().get_or_create(
                        producto_id=origen.producto_id,
                        subdivision_id=destino_id,
                        referencia=origen.referencia or "",
                        defaults={"cantidad": 0},
                    )
                    fila.cantidad = int(fila.cantidad or 0) + cantidad
                    fila.save(update_fields=["cantidad"])
                    movidas += cantidad
                origen.delete()
                quitadas += 1
            tienen = set(
                Inventario.objects.filter(producto_id__in=grupo, subdivision_id=destino_id).values_list("producto_id", flat=True)
            )
            Inventario.objects.bulk_create(
                [Inventario(producto_id=pid, subdivision_id=destino_id, cantidad=0, referencia="") for pid in grupo if pid not in tienen],
                ignore_conflicts=True,
            )
            # La escogida queda como ubicacion principal en esa sucursal.
            ProductoUbicacionOrden.objects.filter(
                producto_id__in=grupo, subdivision__division__bodega__sucursal_id=sucursal_id
            ).delete()
            ProductoUbicacionOrden.objects.bulk_create(
                [ProductoUbicacionOrden(producto_id=pid, subdivision_id=destino_id, orden=0) for pid in grupo]
            )
        return Response(
            {
                "ubicacion": f"{destino.division.nombre} - {destino.nombre}",
                "unidades_movidas": movidas,
                "ubicaciones_quitadas": quitadas,
                "agregada_a": len(set(grupo) - tienen),
                "total_productos": len(grupo),
            },
            status=status.HTTP_200_OK,
        )

    def _alterno_a_quitar(self, request, producto):
        raw = request.query_params.get("alterno_id") if request.method == "GET" else request.data.get("alterno_id")
        try:
            alterno_id = int(raw)
        except (TypeError, ValueError):
            raise ValidationError({"alterno_id": "Indica el alterno a quitar."})
        if alterno_id == producto.id:
            raise ValidationError({"alterno_id": "No puedes quitar el mismo producto."})
        grupo = get_alterno_group_ids(producto.id)
        if alterno_id not in grupo:
            raise ValidationError({"alterno_id": "Ese producto no es alterno de este grupo."})
        return alterno_id, grupo - {alterno_id}

    @action(detail=True, methods=["get"], url_path="quitar-alterno-preview")
    def quitar_alterno_preview(self, request, pk=None):
        """Que pasa al sacar un alterno del grupo: de quienes deja de ser
        alterno y que OEM comparte con ellos (candidatos a quitarle)."""
        producto = self.get_object()
        alterno_id, resto = self._alterno_a_quitar(request, producto)
        alterno = Producto.objects.get(id=alterno_id)
        oems_resto = set(
            OEMProducto.objects.filter(producto_id__in=resto).values_list("oem_id", flat=True)
        )
        compartidos = (
            OEMProducto.objects.filter(producto_id=alterno_id, oem_id__in=oems_resto)
            .select_related("oem")
            .order_by("oem__codigo")
        )
        return Response(
            {
                "alterno": {"id": alterno.id, "codigo": alterno.codigo, "nombre": alterno.nombre},
                "grupo": list(
                    Producto.objects.filter(id__in=resto).order_by("codigo").values_list("codigo", flat=True)
                ),
                "oems": [{"id": rel.oem_id, "codigo": rel.oem.codigo} for rel in compartidos],
            },
            status=status.HTTP_200_OK,
        )

    @action(detail=True, methods=["post"], url_path="quitar-alterno")
    def quitar_alterno(self, request, pk=None):
        """Saca el alterno de TODO el grupo (no solo del vinculo con este
        producto: si no, seguiria unido por los demas y recuperaria los OEM) y
        le quita solo a el los OEM confirmados. El resto del grupo los conserva.
        Se borra directo (no por el endpoint de OEM, que lo propagaria al grupo)."""
        producto = self.get_object()
        alterno_id, resto = self._alterno_a_quitar(request, producto)
        raw_oems = request.data.get("oem_ids") or []
        if not isinstance(raw_oems, list):
            raise ValidationError({"oem_ids": "Debe ser una lista."})
        try:
            oem_ids = {int(value) for value in raw_oems}
        except (TypeError, ValueError):
            raise ValidationError({"oem_ids": "OEM invalidos."})
        with transaction.atomic():
            vinculos = ProductoAlterno.objects.filter(
                Q(producto_id=alterno_id, alterno_id__in=resto) | Q(alterno_id=alterno_id, producto_id__in=resto)
            ).delete()[0]
            oems = 0
            if oem_ids:
                oems = OEMProducto.objects.filter(producto_id=alterno_id, oem_id__in=oem_ids).delete()[0]
        return Response({"vinculos_borrados": vinculos, "oems_quitados": oems}, status=status.HTTP_200_OK)

    @staticmethod
    def _stock_por_sucursal(group_ids, principal_id=None, *, solo_con_stock=False):
        """{productos, sucursales, stock} de esos productos: stock por sucursal."""
        inventario_rows = (
            Inventario.objects.filter(producto_id__in=group_ids)
            .values(
                "producto_id",
                "subdivision__division__bodega__sucursal_id",
                "subdivision__division__bodega__sucursal__nombre",
            )
            .annotate(total=Sum("cantidad"))
        )
        sucursales_map = {}
        stock = {}
        for row in inventario_rows:
            total = int(row["total"] or 0)
            if total <= 0:
                continue
            sucursal_id = row["subdivision__division__bodega__sucursal_id"]
            sucursales_map[sucursal_id] = row["subdivision__division__bodega__sucursal__nombre"]
            stock.setdefault(str(row["producto_id"]), {})[str(sucursal_id)] = total

        productos_list = list(Producto.objects.filter(id__in=group_ids))
        if solo_con_stock:
            productos_list = [p for p in productos_list if str(p.id) in stock]
        productos_list.sort(key=lambda p: (p.id != principal_id, p.codigo))
        productos_payload = [
            {
                "id": p.id,
                "codigo": p.codigo,
                "nombre": p.nombre,
                "es_principal": p.id == principal_id,
            }
            for p in productos_list
        ]
        sucursales_payload = [
            {"id": sucursal_id, "nombre": nombre}
            for sucursal_id, nombre in sorted(sucursales_map.items(), key=lambda kv: kv[1])
        ]
        return {"productos": productos_payload, "sucursales": sucursales_payload, "stock": stock}

    @action(detail=True, methods=["get"], url_path="stock-alternos")
    def stock_alternos(self, request, pk=None):
        """Stock por sucursal de este producto y todos sus alternos (útil para decidir
        cuántas unidades enviar a cada sucursal durante una distribución)."""
        producto = self.get_object()
        group_ids = get_alterno_group_ids(producto.id) | {producto.id}
        return Response(self._stock_por_sucursal(group_ids, producto.id), status=status.HTTP_200_OK)

    @action(detail=False, methods=["get"], url_path="stock-alternos-codigo")
    def stock_alternos_codigo(self, request):
        """Para un producto que todavia no esta en el catalogo (nuevo de una
        importacion): stock por sucursal de sus posibles alternos, los que
        comparten el codigo base (mismos 5 primeros caracteres) o un OEM, mas
        sus grupos de alternos. Solo los que tienen stock en alguna sucursal.
        Params: codigo, oem (separados por coma)."""
        codigo = str(request.query_params.get("codigo") or "").strip()
        oems = [o.strip().upper() for o in str(request.query_params.get("oem") or "").replace(";", ",").split(",") if o.strip()]
        # Misma regla de codigo base que las importaciones (P2265QH-A <->
        # P2265CL-A; una variante como -K es otra pieza).
        from importaciones.viewsets import _codigo_base, CODIGO_BASE_LENGTH

        base = _codigo_base(codigo)
        ids = set()
        if base:
            ids |= {
                pid for pid, cod in Producto.objects.filter(
                    codigo__istartswith=base[:CODIGO_BASE_LENGTH], activo=True
                ).values_list("id", "codigo")[:300]
                if _codigo_base(cod) == base
            }
        if oems:
            ids |= set(
                Producto.objects.filter(oem_productos__oem__codigo__in=oems, activo=True).values_list("id", flat=True)[:200]
            )
        if not ids:
            return Response({"productos": [], "sucursales": [], "stock": {}, "posibles": True}, status=status.HTTP_200_OK)
        group_ids = set()
        for pid in ids:
            if pid not in group_ids:
                group_ids |= get_alterno_group_ids(pid)
        group_ids = set(Producto.objects.filter(id__in=group_ids, activo=True).values_list("id", flat=True))
        data = self._stock_por_sucursal(group_ids, solo_con_stock=True)
        data["posibles"] = True
        return Response(data, status=status.HTTP_200_OK)

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


class ProductoReferenciaViewSet(viewsets.ModelViewSet):
    queryset = ProductoReferencia.objects.select_related("producto").all().order_by("-id")
    serializer_class = ProductoReferenciaSerializer
    permission_classes = [IsAuthenticated, ProductosModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["producto__codigo", "producto__nombre", "valor"]
    ordering_fields = ["producto__nombre", "valor"]

    def perform_destroy(self, instance):
        # A diferencia del OEM, la referencia no se comparte entre productos
        # -- borrar solo afecta a este producto -- pero sí hay que
        # re-sincronizar Producto.referencia por si se borró la primera.
        producto = instance.producto
        instance.delete()
        sync_producto_referencia_primary(producto)


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
        sync_group_oems(producto_ids)

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
