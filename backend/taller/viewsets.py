from decimal import Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.db.models import Count, DecimalField, Exists, ExpressionWrapper, F, Max, OuterRef, Q, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.search_utils import matching_product_ids
from inventario.models import Inventario
from productos.models import Producto
from usuarios.permissions import TallerModulePermission
from usuarios.utils import is_app_admin

from .models import ManoObra, OrdenTaller, OrdenTallerEvento, OrdenTallerLinea
from .serializers import (
    ManoObraSerializer,
    OrdenTallerDetailSerializer,
    OrdenTallerHeaderSerializer,
    OrdenTallerLineaSerializer,
    OrdenTallerListSerializer,
)

Estados = OrdenTaller.Estados
Tipos = OrdenTallerLinea.Tipos
EstadosPrecio = OrdenTallerLinea.EstadosPrecio

LINEA_TOTAL = ExpressionWrapper(
    F("lineas__precio") * F("lineas__cantidad"),
    output_field=DecimalField(max_digits=14, decimal_places=2),
)

ORDERING_FIELDS = {
    "numero": "numero",
    "numero_pedido": "numero_pedido",
    "estado": "estado",
    "placa": "placa",
    "modelo": "modelo",
    "cliente_nombre": "cliente_nombre",
    "tecnico": "tecnico",
    "total": "total_calculado",
    "creado_en": "creado_en",
    "actualizado_en": "actualizado_en",
}


def _parse_decimal(value, field_label):
    if value is None or value == "":
        return None
    try:
        parsed = Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        raise ValidationError({"detail": f"{field_label} no es un número válido."})
    if parsed < 0:
        raise ValidationError({"detail": f"{field_label} no puede ser negativo."})
    return parsed


def _parse_cantidad(value, default=None):
    if value is None or value == "":
        if default is not None:
            return default
        raise ValidationError({"detail": "Indica la cantidad."})
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ValidationError({"detail": "La cantidad debe ser un número entero."})
    if parsed < 1:
        raise ValidationError({"detail": "La cantidad debe ser al menos 1."})
    return parsed


def _fmt_money(value):
    return f"${Decimal(value or 0).quantize(Decimal('0.01'))}"


def _linea_label(linea):
    if linea.tipo == Tipos.REPUESTO and linea.producto_id:
        return f"{linea.producto.codigo} - {linea.descripcion}"
    if linea.tipo == Tipos.SIN_CODIGO and linea.referencia:
        return f"{linea.referencia} - {linea.descripcion}".strip(" -")
    return linea.descripcion or linea.get_tipo_display()


def _registrar(orden, user, tipo, descripcion):
    OrdenTallerEvento.objects.create(orden=orden, usuario=user, tipo=tipo, descripcion=descripcion)


def _estado_precio(linea, user):
    """Precio distinto al del inventario (o sin PVP) -> lo verifica el admin.

    Solo aplica a repuestos del inventario. Si quien pone el precio es el
    administrador, ya queda verificado.
    """
    if linea.tipo != Tipos.REPUESTO:
        return EstadosPrecio.NO_APLICA, None, None
    if linea.precio_lista is not None and linea.precio == linea.precio_lista:
        return EstadosPrecio.NO_APLICA, None, None
    if is_app_admin(user):
        return EstadosPrecio.APROBADO, user, timezone.now()
    return EstadosPrecio.PENDIENTE, None, None


def _aplicar_estado_precio(linea, user):
    estado, revisor, revisado_en = _estado_precio(linea, user)
    linea.precio_estado = estado
    linea.precio_revisado_por = revisor
    linea.precio_revisado_en = revisado_en


class ManoObraViewSet(viewsets.ModelViewSet):
    serializer_class = ManoObraSerializer
    permission_classes = [IsAuthenticated, TallerModulePermission]
    pagination_class = None

    def get_queryset(self):
        queryset = ManoObra.objects.all().order_by("nombre", "id")
        if str(self.request.query_params.get("activos") or "").strip() in ("1", "true"):
            queryset = queryset.filter(activo=True)
        return queryset

    def perform_create(self, serializer):
        serializer.save(creado_por=self.request.user)

    def destroy(self, request, *args, **kwargs):
        trabajo = self.get_object()
        if trabajo.lineas.exists():
            # Ya se uso en alguna orden: se desactiva para no perder la referencia.
            trabajo.activo = False
            trabajo.save(update_fields=["activo", "actualizado_en"])
            return Response(ManoObraSerializer(trabajo).data, status=status.HTTP_200_OK)
        trabajo.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class OrdenTallerViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated, TallerModulePermission]
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_serializer_class(self):
        if self.action == "list":
            return OrdenTallerListSerializer
        return OrdenTallerDetailSerializer

    def get_queryset(self):
        queryset = OrdenTaller.objects.select_related("asesor", "aceptada_por")
        if self.action == "list":
            queryset = queryset.annotate(
                total_calculado=Coalesce(Sum(LINEA_TOTAL), Value(Decimal("0")), output_field=DecimalField(max_digits=14, decimal_places=2)),
                lineas_count=Count("lineas", distinct=True),
                precios_pendientes=Count(
                    "lineas",
                    filter=Q(lineas__precio_estado=EstadosPrecio.PENDIENTE),
                    distinct=True,
                ),
            )
            params = self.request.query_params
            estados = [e for e in str(params.get("estado") or "").split(",") if e.strip()]
            if estados:
                queryset = queryset.filter(estado__in=[e.strip() for e in estados])
            if str(params.get("precios_pendientes") or "") in ("1", "true"):
                queryset = queryset.filter(
                    Exists(
                        OrdenTallerLinea.objects.filter(
                            orden=OuterRef("pk"), precio_estado=EstadosPrecio.PENDIENTE
                        )
                    )
                )
            search = str(params.get("search") or "").strip()
            if search:
                text_q = (
                    Q(numero_pedido__icontains=search)
                    | Q(placa__icontains=search)
                    | Q(cliente_nombre__icontains=search)
                    | Q(cliente_identificacion__icontains=search)
                    | Q(tecnico__icontains=search)
                    | Q(modelo__icontains=search)
                    | Q(vin__icontains=search)
                )
                digits = search.lstrip("#")
                if digits.isdigit():
                    text_q |= Q(numero=int(digits))
                queryset = queryset.filter(text_q)
            raw_ordering = str(params.get("ordering") or "").strip()
            descending = raw_ordering.startswith("-")
            field = ORDERING_FIELDS.get(raw_ordering.lstrip("-"))
            if field:
                queryset = queryset.order_by(f"-{field}" if descending else field, "-numero")
            else:
                queryset = queryset.order_by("-numero")
        else:
            queryset = queryset.prefetch_related(
                "lineas__producto",
                "lineas__precio_revisado_por",
                "lineas__creado_por",
                "eventos__usuario",
            )
        return queryset

    def _detail(self, orden, status_code=status.HTTP_200_OK):
        orden = self.get_queryset().get(pk=orden.pk)
        return Response(OrdenTallerDetailSerializer(orden).data, status=status_code)

    def _orden_bloqueada(self, pk):
        orden = OrdenTaller.objects.select_for_update().filter(pk=pk).first()
        if orden is None:
            raise ValidationError({"detail": "La orden ya no existe."})
        return orden

    @staticmethod
    def _exigir_editable(orden):
        if not orden.es_editable:
            raise ValidationError(
                {"detail": f"La orden está {orden.get_estado_display().lower()}: ya no se puede modificar."}
            )

    @staticmethod
    def _exigir_admin(user, accion):
        if not is_app_admin(user):
            raise PermissionDenied(f"Solo un administrador puede {accion}.")

    # ---- Cabecera -----------------------------------------------------

    def create(self, request, *args, **kwargs):
        header = OrdenTallerHeaderSerializer(data=request.data, partial=True)
        header.is_valid(raise_exception=True)
        for _attempt in range(5):
            try:
                with transaction.atomic():
                    ultimo = OrdenTaller.objects.aggregate(m=Max("numero"))["m"] or 0
                    orden = OrdenTaller.objects.create(
                        numero=ultimo + 1,
                        asesor=request.user,
                        **header.validated_data,
                    )
                    _registrar(orden, request.user, "creada", "Creó la cotización.")
                break
            except IntegrityError:
                continue
        else:
            raise ValidationError({"detail": "No se pudo asignar un número de orden. Intenta otra vez."})
        return self._detail(orden, status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        if not kwargs.get("partial"):
            return Response(status=status.HTTP_405_METHOD_NOT_ALLOWED)
        with transaction.atomic():
            orden = self._orden_bloqueada(kwargs["pk"])
            self._exigir_editable(orden)
            header = OrdenTallerHeaderSerializer(orden, data=request.data, partial=True)
            header.is_valid(raise_exception=True)
            header.save()
        return self._detail(orden)

    def destroy(self, request, *args, **kwargs):
        with transaction.atomic():
            orden = self._orden_bloqueada(kwargs["pk"])
            if orden.estado != Estados.COTIZACION or orden.lineas.exists():
                raise ValidationError(
                    {"detail": "Solo se puede descartar una cotización vacía. Para lo demás, anula la orden."}
                )
            orden.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ---- Pasos ----------------------------------------------------------

    @action(detail=True, methods=["post"], url_path="aceptar")
    def aceptar(self, request, pk=None):
        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            if orden.estado != Estados.COTIZACION:
                raise ValidationError({"detail": "Solo una cotización se puede convertir en orden de trabajo."})
            if not orden.lineas.exists():
                raise ValidationError({"detail": "La cotización no tiene nada: agrega repuestos, insumos o mano de obra."})
            orden.estado = Estados.ORDEN
            orden.aceptada_en = timezone.now()
            orden.aceptada_por = request.user
            orden.save(update_fields=["estado", "aceptada_en", "aceptada_por", "actualizado_en"])
            _registrar(orden, request.user, "aceptada", "El cliente aceptó: la cotización pasó a orden de trabajo.")
        return self._detail(orden)

    @action(detail=True, methods=["post"], url_path="rechazar")
    def rechazar(self, request, pk=None):
        motivo = str(request.data.get("motivo") or "").strip()
        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            if orden.estado != Estados.COTIZACION:
                raise ValidationError({"detail": "Solo se puede marcar como rechazada una cotización."})
            orden.estado = Estados.RECHAZADA
            orden.motivo_rechazo = motivo
            orden.save(update_fields=["estado", "motivo_rechazo", "actualizado_en"])
            detalle = f" Motivo: {motivo}" if motivo else ""
            _registrar(orden, request.user, "rechazada", f"El cliente rechazó la cotización.{detalle}")
        return self._detail(orden)

    @action(detail=True, methods=["post"], url_path="reabrir")
    def reabrir(self, request, pk=None):
        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            if orden.estado != Estados.RECHAZADA:
                raise ValidationError({"detail": "Solo se puede reabrir una cotización rechazada."})
            orden.estado = Estados.COTIZACION
            orden.motivo_rechazo = ""
            orden.save(update_fields=["estado", "motivo_rechazo", "actualizado_en"])
            _registrar(orden, request.user, "reabierta", "Reabrió la cotización.")
        return self._detail(orden)

    @action(detail=True, methods=["post"], url_path="anular")
    def anular(self, request, pk=None):
        self._exigir_admin(request.user, "anular una orden")
        motivo = str(request.data.get("motivo") or "").strip()
        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            if orden.estado not in (Estados.COTIZACION, Estados.ORDEN, Estados.RECHAZADA):
                raise ValidationError({"detail": "Esta orden ya no se puede anular."})
            orden.estado = Estados.ANULADA
            orden.save(update_fields=["estado", "actualizado_en"])
            detalle = f" Motivo: {motivo}" if motivo else ""
            _registrar(orden, request.user, "anulada", f"Anuló la orden.{detalle}")
        return self._detail(orden)

    # ---- Detalle (lineas) -------------------------------------------------

    @action(detail=True, methods=["post"], url_path="lineas")
    def agregar_linea(self, request, pk=None):
        data = request.data
        tipo = str(data.get("tipo") or "").strip()
        if tipo not in Tipos.values:
            raise ValidationError({"detail": "Tipo de línea no válido."})

        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            self._exigir_editable(orden)
            en_orden = orden.estado == Estados.ORDEN
            cantidad = _parse_cantidad(data.get("cantidad"), default=1)
            precio = _parse_decimal(data.get("precio"), "El precio")
            posicion = (orden.lineas.aggregate(m=Max("posicion"))["m"] or 0) + 1

            if tipo == Tipos.REPUESTO:
                producto = Producto.objects.filter(pk=data.get("producto")).first()
                if producto is None:
                    raise ValidationError({"detail": "Elige un repuesto del inventario."})
                existente = orden.lineas.select_for_update().filter(tipo=Tipos.REPUESTO, producto=producto).first()
                if existente is not None:
                    # El mismo repuesto otra vez: se suma a la fila que ya esta.
                    existente.cantidad += cantidad
                    existente.save(update_fields=["cantidad", "actualizado_en"])
                    if en_orden:
                        _registrar(
                            orden,
                            request.user,
                            "linea_cantidad",
                            f"Subió {_linea_label(existente)} a {existente.cantidad}.",
                        )
                    return self._detail(orden)
                linea = OrdenTallerLinea(
                    orden=orden,
                    tipo=tipo,
                    producto=producto,
                    descripcion=producto.nombre,
                    cantidad=cantidad,
                    precio_lista=producto.precio,
                    precio=precio if precio is not None else (producto.precio or Decimal("0")),
                )
                _aplicar_estado_precio(linea, request.user)
            elif tipo == Tipos.MANO_OBRA:
                trabajo = None
                if data.get("mano_obra"):
                    trabajo = ManoObra.objects.filter(pk=data.get("mano_obra")).first()
                descripcion = str(data.get("descripcion") or (trabajo.nombre if trabajo else "")).strip()
                if not descripcion:
                    raise ValidationError({"detail": "Describe el trabajo de mano de obra."})
                if precio is None:
                    precio = trabajo.precio if trabajo else Decimal("0")
                linea = OrdenTallerLinea(
                    orden=orden,
                    tipo=tipo,
                    mano_obra=trabajo,
                    descripcion=descripcion,
                    cantidad=cantidad,
                    precio=precio,
                )
            else:
                descripcion = str(data.get("descripcion") or "").strip()
                referencia = str(data.get("referencia") or "").strip()
                if tipo == Tipos.SIN_CODIGO and not (descripcion or referencia):
                    raise ValidationError({"detail": "Escribe el OEM/referencia o la descripción del repuesto."})
                if tipo == Tipos.INSUMO and not descripcion:
                    raise ValidationError({"detail": "Describe el insumo."})
                linea = OrdenTallerLinea(
                    orden=orden,
                    tipo=tipo,
                    referencia=referencia if tipo == Tipos.SIN_CODIGO else "",
                    descripcion=descripcion,
                    cantidad=cantidad,
                    precio=precio or Decimal("0"),
                )

            linea.posicion = posicion
            linea.agregada_en_orden = en_orden
            linea.creado_por = request.user
            linea.save()
            if en_orden:
                _registrar(
                    orden,
                    request.user,
                    "linea_agregada",
                    f"Agregó {linea.get_tipo_display().lower()}: {_linea_label(linea)} x{linea.cantidad}.",
                )
        return self._detail(orden, status.HTTP_201_CREATED)

    @action(detail=True, methods=["patch", "delete"], url_path=r"lineas/(?P<linea_id>\d+)")
    def linea(self, request, pk=None, linea_id=None):
        es_admin = is_app_admin(request.user)
        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            self._exigir_editable(orden)
            linea = orden.lineas.select_for_update(of=("self",)).select_related("producto").filter(pk=linea_id).first()
            if linea is None:
                raise ValidationError({"detail": "Esa línea ya no existe en la orden."})
            en_orden = orden.estado == Estados.ORDEN

            if request.method == "DELETE":
                if en_orden and not es_admin:
                    raise PermissionDenied(
                        "En una orden de trabajo no se puede quitar nada: ya se le confirmó al cliente. "
                        "Solo un administrador puede quitarlo."
                    )
                label = _linea_label(linea)
                linea.delete()
                if en_orden:
                    _registrar(orden, request.user, "linea_quitada", f"Quitó {label}.")
                return self._detail(orden)

            data = request.data
            cambios = []
            if "cantidad" in data:
                cantidad = _parse_cantidad(data.get("cantidad"))
                if en_orden and not es_admin and cantidad < linea.cantidad:
                    raise PermissionDenied(
                        f"En una orden de trabajo solo se puede aumentar la cantidad (mínimo {linea.cantidad}). "
                        "Solo un administrador puede bajarla."
                    )
                if cantidad != linea.cantidad:
                    cambios.append(f"cantidad {linea.cantidad} → {cantidad}")
                    linea.cantidad = cantidad
            if "precio" in data:
                precio = _parse_decimal(data.get("precio"), "El precio")
                if precio is None:
                    precio = linea.precio_lista if linea.precio_lista is not None else Decimal("0")
                if precio != linea.precio:
                    cambios.append(f"precio {_fmt_money(linea.precio)} → {_fmt_money(precio)}")
                    linea.precio = precio
                    _aplicar_estado_precio(linea, request.user)
            if "descripcion" in data and linea.tipo != Tipos.REPUESTO:
                descripcion = str(data.get("descripcion") or "").strip()
                if not descripcion and not (linea.tipo == Tipos.SIN_CODIGO and linea.referencia):
                    raise ValidationError({"detail": "La descripción no puede quedar vacía."})
                linea.descripcion = descripcion
            if "referencia" in data and linea.tipo == Tipos.SIN_CODIGO:
                linea.referencia = str(data.get("referencia") or "").strip()
            linea.save()
            if en_orden and cambios:
                _registrar(orden, request.user, "linea_editada", f"{_linea_label(linea)}: {', '.join(cambios)}.")
        return self._detail(orden)

    @action(detail=True, methods=["post"], url_path=r"lineas/(?P<linea_id>\d+)/revisar-precio")
    def revisar_precio(self, request, pk=None, linea_id=None):
        """El admin aprueba el precio puesto o lo devuelve al del inventario."""
        self._exigir_admin(request.user, "verificar precios")
        aprobar = bool(request.data.get("aprobar"))
        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            self._exigir_editable(orden)
            linea = orden.lineas.select_for_update(of=("self",)).select_related("producto").filter(pk=linea_id).first()
            if linea is None:
                raise ValidationError({"detail": "Esa línea ya no existe en la orden."})
            if linea.precio_estado != EstadosPrecio.PENDIENTE:
                raise ValidationError({"detail": "Ese precio ya no está pendiente de aprobación."})
            ahora = timezone.now()
            if aprobar:
                linea.precio_estado = EstadosPrecio.APROBADO
                texto = f"Aprobó el precio {_fmt_money(linea.precio)} de {_linea_label(linea)}."
            else:
                if linea.precio_lista is None:
                    raise ValidationError(
                        {"detail": "Este repuesto no tiene PVP en el inventario: corrige el precio en la línea."}
                    )
                anterior = linea.precio
                linea.precio = linea.precio_lista
                linea.precio_estado = EstadosPrecio.NO_APLICA
                texto = (
                    f"Rechazó el precio {_fmt_money(anterior)} de {_linea_label(linea)}: "
                    f"vuelve al PVP {_fmt_money(linea.precio_lista)}."
                )
            linea.precio_revisado_por = request.user
            linea.precio_revisado_en = ahora
            linea.save()
            _registrar(orden, request.user, "precio_revisado", texto)
        return self._detail(orden)

    # ---- Busqueda de repuestos ---------------------------------------------

    @action(detail=False, methods=["get"], url_path="buscar-productos")
    def buscar_productos(self, request):
        term = str(request.query_params.get("q") or "").strip()
        if not term:
            return Response([])
        productos = list(
            Producto.objects.filter(id__in=matching_product_ids(term))
            .order_by("codigo")
            .values("id", "codigo", "nombre", "precio")[:25]
        )
        stock = dict(
            Inventario.objects.filter(producto_id__in=[p["id"] for p in productos])
            .values("producto_id")
            .annotate(total=Sum("cantidad"))
            .values_list("producto_id", "total")
        )
        upper = term.upper()
        productos.sort(key=lambda p: (str(p["codigo"]).upper() != upper, not str(p["codigo"]).upper().startswith(upper)))
        return Response(
            [
                {
                    **p,
                    "precio": str(p["precio"]) if p["precio"] is not None else None,
                    "stock": int(stock.get(p["id"]) or 0),
                }
                for p in productos
            ]
        )
