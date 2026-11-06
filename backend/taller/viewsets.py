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
from inventario.models import Inventario, Sucursal
from productos.models import Producto
from usuarios.permissions import TallerModulePermission
from usuarios.utils import is_app_admin

from . import stock as taller_stock
from .cierre import crear_salidas_taller
from .codigos import sugerir_codigo
from .models import (
    ManoObra,
    Taller,
    Tecnico,
    OrdenTaller,
    OrdenTallerDevolucion,
    OrdenTallerEntrega,
    OrdenTallerEntregaItem,
    OrdenTallerEvento,
    OrdenTallerLinea,
    OrdenTallerPrueba,
)
from .serializers import (
    ManoObraSerializer,
    TallerSerializer,
    TecnicoSerializer,
    OrdenTallerDetailSerializer,
    OrdenTallerHeaderSerializer,
    OrdenTallerListSerializer,
    nombre_usuario,
    resumen_orden_anterior,
)

Estados = OrdenTaller.Estados
Tipos = OrdenTallerLinea.Tipos
EstadosPrecio = OrdenTallerLinea.EstadosPrecio
Origenes = OrdenTallerPrueba.Origenes

FIRMA_MAX_CHARS = 600_000

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


def _parse_cantidad(value, default=None, minimo=1):
    if value is None or value == "":
        if default is not None:
            return default
        raise ValidationError({"detail": "Indica la cantidad."})
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ValidationError({"detail": "La cantidad debe ser un número entero."})
    if parsed < minimo:
        raise ValidationError({"detail": f"La cantidad debe ser al menos {minimo}."})
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

    Solo aplica a repuestos del inventario que no van por garantia. Si quien
    pone el precio es el administrador, ya queda verificado.
    """
    if linea.tipo != Tipos.REPUESTO or linea.es_garantia:
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


def _taller_por_defecto():
    """Si hay un solo taller activo (o ninguno elegido), el primero activo."""
    return Taller.objects.filter(activo=True).order_by("id").first()


def _sucursal_por_defecto(user=None):
    """Solo hay un taller: el de la sucursal 9 de Octubre (la matriz).
    Sus repuestos salen siempre del inventario de esa sucursal."""
    sucursal = Sucursal.objects.filter(nombre__icontains="octubre").order_by("id").first()
    if sucursal is not None:
        return sucursal
    try:
        from app.reposicion import central_branch_id

        central = central_branch_id()
        if central:
            sucursal = Sucursal.objects.filter(pk=central).first()
            if sucursal is not None:
                return sucursal
    except Exception:  # pragma: no cover - sin configuracion de reposicion
        pass
    return Sucursal.objects.filter(nombre__icontains="matriz").order_by("id").first() or Sucursal.objects.order_by("id").first()


def _quitar_despachado(orden, linea, cantidad, user):
    """El admin quito/bajo una linea ya despachada: lo que sobra queda en el
    taller como "quitado" y tiene que volver a bodega."""
    if cantidad <= 0:
        return
    OrdenTallerPrueba.objects.create(
        orden=orden,
        producto_id=linea.producto_id,
        origen=Origenes.QUITADO,
        cantidad_solicitada=cantidad,
        cantidad_entregada=cantidad,
        creado_por=user,
    )


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


class TallerViewSet(viewsets.ModelViewSet):
    serializer_class = TallerSerializer
    permission_classes = [IsAuthenticated, TallerModulePermission]
    pagination_class = None

    def get_queryset(self):
        queryset = Taller.objects.select_related("sucursal").order_by("-activo", "nombre", "id")
        if str(self.request.query_params.get("activos") or "").strip() in ("1", "true"):
            queryset = queryset.filter(activo=True)
        return queryset

    def _solo_admin(self):
        if not is_app_admin(self.request.user):
            raise PermissionDenied("Solo un administrador puede configurar los talleres.")

    def perform_create(self, serializer):
        self._solo_admin()
        serializer.save()

    def perform_update(self, serializer):
        self._solo_admin()
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        self._solo_admin()
        taller = self.get_object()
        if taller.ordenes.exists():
            taller.activo = False
            taller.save(update_fields=["activo"])
            return Response(TallerSerializer(taller).data, status=status.HTTP_200_OK)
        taller.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class TecnicoViewSet(viewsets.ModelViewSet):
    serializer_class = TecnicoSerializer
    permission_classes = [IsAuthenticated, TallerModulePermission]
    pagination_class = None

    def get_queryset(self):
        queryset = Tecnico.objects.all().order_by("-activo", "nombre", "id")
        params = self.request.query_params
        if str(params.get("activos") or "").strip() in ("1", "true"):
            queryset = queryset.filter(activo=True)
        search = str(params.get("search") or "").strip()
        if search:
            queryset = queryset.filter(
                Q(nombre__icontains=search) | Q(cedula__icontains=search) | Q(especialidad__icontains=search)
            )
        return queryset

    def destroy(self, request, *args, **kwargs):
        tecnico = self.get_object()
        if tecnico.ordenes.exists():
            # Ya tiene ordenes: se desactiva para no perder el historial.
            tecnico.activo = False
            tecnico.save(update_fields=["activo"])
            return Response(TecnicoSerializer(tecnico).data, status=status.HTTP_200_OK)
        tecnico.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class OrdenTallerViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated, TallerModulePermission]
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_serializer_class(self):
        if self.action == "list":
            return OrdenTallerListSerializer
        return OrdenTallerDetailSerializer

    def get_queryset(self):
        queryset = OrdenTaller.objects.select_related(
            "asesor", "aceptada_por", "cerrada_por", "sucursal", "taller", "garantia_de", "movimiento_salida"
        )
        if self.action != "list":
            return queryset.prefetch_related(
                "lineas__producto",
                "lineas__precio_revisado_por",
                "lineas__creado_por",
                "pruebas__producto",
                "pruebas__creado_por",
                "entregas__entregado_por",
                "entregas__items__producto",
                "entregas__items__sucursal",
                "salidas",
                "devoluciones__producto",
                "devoluciones__recibido_por",
                "eventos__usuario",
                "garantia_de__lineas__producto",
            )

        lineas_repuesto_pendientes = OrdenTallerLinea.objects.filter(
            orden=OuterRef("pk"),
            tipo=Tipos.REPUESTO,
            producto__isnull=False,
            cantidad__gt=F("cantidad_despachada"),
        )
        pruebas_por_entregar = OrdenTallerPrueba.objects.filter(
            orden=OuterRef("pk"), cantidad_solicitada__gt=F("cantidad_entregada")
        )
        pruebas_en_taller = OrdenTallerPrueba.objects.filter(
            orden=OuterRef("pk"), cantidad_entregada__gt=F("cantidad_usada") + F("cantidad_devuelta")
        )
        lineas_sin_codigo = OrdenTallerLinea.objects.filter(orden=OuterRef("pk"), tipo=Tipos.SIN_CODIGO)
        lineas_precio_pendiente = OrdenTallerLinea.objects.filter(
            orden=OuterRef("pk"), precio_estado=EstadosPrecio.PENDIENTE
        )
        queryset = queryset.annotate(
            total_calculado=Coalesce(
                Sum(LINEA_TOTAL), Value(Decimal("0")), output_field=DecimalField(max_digits=14, decimal_places=2)
            ),
            lineas_count=Count("lineas", distinct=True),
            precios_pendientes=Count(
                "lineas", filter=Q(lineas__precio_estado=EstadosPrecio.PENDIENTE), distinct=True
            ),
            hay_lineas_pendientes=Exists(lineas_repuesto_pendientes),
            hay_pruebas_por_entregar=Exists(pruebas_por_entregar),
            por_devolver=Exists(pruebas_en_taller),
            sin_codigo=Exists(lineas_sin_codigo),
        )
        params = self.request.query_params
        estados = [e.strip() for e in str(params.get("estado") or "").split(",") if e.strip()]
        if estados:
            queryset = queryset.filter(estado__in=estados)
        alerta = str(params.get("alerta") or "").strip()
        if alerta == "precios" or str(params.get("precios_pendientes") or "") in ("1", "true"):
            queryset = queryset.filter(Exists(lineas_precio_pendiente))
        elif alerta == "despachar":
            queryset = queryset.filter(estado=Estados.ORDEN).filter(
                Q(hay_lineas_pendientes=True) | Q(hay_pruebas_por_entregar=True)
            )
        elif alerta == "devolver":
            queryset = queryset.filter(por_devolver=True)
        elif alerta == "sin_codigo":
            queryset = queryset.filter(estado=Estados.ORDEN, sin_codigo=True)
        search = str(params.get("search") or "").strip()
        if search:
            text_q = (
                Q(numero_pedido__icontains=search)
                | Q(numero_factura__icontains=search)
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
            return queryset.order_by(f"-{field}" if descending else field, "-numero")
        return queryset.order_by("-numero")

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        # Contadores de avisos para los botones de la tabla.
        base = OrdenTaller.objects.all()
        response.data["avisos"] = {
            "precios": base.filter(
                Exists(OrdenTallerLinea.objects.filter(orden=OuterRef("pk"), precio_estado=EstadosPrecio.PENDIENTE))
            ).count(),
            "despachar": base.filter(estado=Estados.ORDEN)
            .filter(
                Exists(
                    OrdenTallerLinea.objects.filter(
                        orden=OuterRef("pk"),
                        tipo=Tipos.REPUESTO,
                        producto__isnull=False,
                        cantidad__gt=F("cantidad_despachada"),
                    )
                )
                | Exists(
                    OrdenTallerPrueba.objects.filter(orden=OuterRef("pk"), cantidad_solicitada__gt=F("cantidad_entregada"))
                )
            )
            .count(),
            "devolver": base.filter(
                Exists(
                    OrdenTallerPrueba.objects.filter(
                        orden=OuterRef("pk"), cantidad_entregada__gt=F("cantidad_usada") + F("cantidad_devuelta")
                    )
                )
            ).count(),
            "sin_codigo": base.filter(estado=Estados.ORDEN)
            .filter(Exists(OrdenTallerLinea.objects.filter(orden=OuterRef("pk"), tipo=Tipos.SIN_CODIGO)))
            .count(),
        }
        return response

    def _detail(self, orden, status_code=status.HTTP_200_OK):
        self.action = "retrieve"
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
    def _exigir_orden_de_trabajo(orden, accion):
        if orden.estado != Estados.ORDEN:
            raise ValidationError({"detail": f"Solo en una orden de trabajo se puede {accion}."})

    @staticmethod
    def _exigir_admin(user, accion):
        if not is_app_admin(user):
            raise PermissionDenied(f"Solo un administrador puede {accion}.")

    @staticmethod
    def _exigir_sucursal(orden):
        if orden.sucursal_id is None:
            raise ValidationError({"detail": "Elige la sucursal de la orden (de dónde salen los repuestos)."})

    # ---- Cabecera -----------------------------------------------------

    def create(self, request, *args, **kwargs):
        garantia_de = None
        if request.data.get("garantia_de"):
            garantia_de = OrdenTaller.objects.filter(pk=request.data.get("garantia_de")).first()
            if garantia_de is None:
                raise ValidationError({"detail": "La orden original ya no existe."})
            if garantia_de.estado != Estados.CERRADA:
                raise ValidationError({"detail": "La garantía se hace sobre una orden ya cerrada."})
        header = OrdenTallerHeaderSerializer(data=request.data, partial=True)
        header.is_valid(raise_exception=True)
        valores = dict(header.validated_data)
        if garantia_de is not None:
            for campo in (
                "cliente_nombre", "cliente_identificacion", "cliente_telefono", "placa", "modelo", "vin",
                "tecnico", "tecnico_asignado",
            ):
                valores.setdefault(campo, getattr(garantia_de, campo))
        taller = valores.get("taller") or (garantia_de.taller if garantia_de is not None else None) or _taller_por_defecto()
        valores["taller"] = taller
        valores["sucursal"] = taller.sucursal if taller is not None else _sucursal_por_defecto(request.user)
        for _attempt in range(5):
            try:
                with transaction.atomic():
                    ultimo = OrdenTaller.objects.aggregate(m=Max("numero"))["m"] or 0
                    orden = OrdenTaller.objects.create(
                        numero=ultimo + 1,
                        asesor=request.user,
                        tipo=OrdenTaller.TiposOrden.GARANTIA if garantia_de else OrdenTaller.TiposOrden.NORMAL,
                        garantia_de=garantia_de,
                        **valores,
                    )
                    if garantia_de is not None:
                        _registrar(
                            orden,
                            request.user,
                            "creada",
                            f"Creó la cotización por garantía de la orden #{garantia_de.numero:05d}.",
                        )
                        _registrar(
                            garantia_de,
                            request.user,
                            "garantia",
                            f"Se abrió la orden #{orden.numero:05d} por garantía de esta orden.",
                        )
                    else:
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
            campos = set(request.data.keys())
            if not (orden.estado == Estados.CERRADA and campos <= {"numero_factura"}):
                # La factura se puede anotar despues de cerrar; lo demas no.
                self._exigir_editable(orden)
            if "taller" in campos and str(request.data.get("taller") or "") != str(orden.taller_id or ""):
                if orden.entregas.exists():
                    raise ValidationError(
                        {"detail": "Ya se despacharon repuestos para este taller: no se puede cambiar."}
                    )
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
            sin_codigo = orden.lineas.filter(tipo=Tipos.SIN_CODIGO).count()
            if sin_codigo:
                _registrar(
                    orden,
                    request.user,
                    "sin_codigo",
                    f"Aviso al administrador: {sin_codigo} repuesto(s) sin código hay que comprarlos y crearlos en el inventario.",
                )
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
            en_taller = sum(linea.cantidad_despachada for linea in orden.lineas.all()) + sum(
                prueba.en_taller for prueba in orden.pruebas.all()
            )
            if en_taller:
                raise ValidationError(
                    {
                        "detail": (
                            f"Hay {en_taller} repuesto(s) en el taller. Quítalos de la orden y registra su devolución "
                            "a bodega antes de anular."
                        )
                    }
                )
            orden.estado = Estados.ANULADA
            orden.save(update_fields=["estado", "actualizado_en"])
            detalle = f" Motivo: {motivo}" if motivo else ""
            _registrar(orden, request.user, "anulada", f"Anuló la orden.{detalle}")
        return self._detail(orden)

    @action(detail=True, methods=["post"], url_path="cerrar")
    def cerrar(self, request, pk=None):
        numero_factura = str(request.data.get("numero_factura") or "").strip()
        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            self._exigir_orden_de_trabajo(orden, "cerrar")
            self._exigir_sucursal(orden)
            lineas = list(orden.lineas.select_related("producto"))
            pruebas = list(orden.pruebas.select_related("producto"))
            problemas = []
            sin_codigo = [linea for linea in lineas if linea.tipo == Tipos.SIN_CODIGO]
            if sin_codigo:
                problemas.append(f"{len(sin_codigo)} repuesto(s) sin código: el administrador debe crearlos y despacharlos")
            precios = [linea for linea in lineas if linea.precio_estado == EstadosPrecio.PENDIENTE]
            if precios:
                problemas.append(f"{len(precios)} precio(s) por aprobar")
            por_despachar = [linea for linea in lineas if linea.pendiente_despacho > 0]
            if por_despachar:
                problemas.append(
                    "faltan despachar: "
                    + ", ".join(f"{linea.producto.codigo} ({linea.pendiente_despacho})" for linea in por_despachar)
                )
            por_entregar = [prueba for prueba in pruebas if prueba.pendiente_entrega > 0]
            if por_entregar:
                problemas.append(
                    "repuestos a prueba pedidos sin entregar (entrégalos o cancélalos): "
                    + ", ".join(prueba.producto.codigo for prueba in por_entregar)
                )
            por_devolver = [prueba for prueba in pruebas if prueba.en_taller > 0]
            if por_devolver:
                problemas.append(
                    "faltan devolver a bodega: "
                    + ", ".join(f"{prueba.producto.codigo} ({prueba.en_taller})" for prueba in por_devolver)
                )
            if problemas:
                raise ValidationError({"detail": "Todavía no se puede cerrar: " + "; ".join(problemas) + "."})

            if numero_factura:
                orden.numero_factura = numero_factura
            salidas = crear_salidas_taller(orden, lineas, request.user)
            movimiento = salidas[0] if salidas else None
            orden.movimiento_salida = movimiento
            orden.estado = Estados.CERRADA
            orden.cerrada_en = timezone.now()
            orden.cerrada_por = request.user
            orden.save(
                update_fields=[
                    "estado",
                    "numero_factura",
                    "movimiento_salida",
                    "cerrada_en",
                    "cerrada_por",
                    "actualizado_en",
                ]
            )
            if salidas:
                orden.salidas.set(salidas)
            texto = "Cerró la orden"
            if salidas:
                texto += ": salida tipo Taller " + ", ".join(
                    f"{m.no_documento} ({m.sucursal.nombre})" for m in salidas
                )
            if orden.numero_factura:
                texto += f" (factura {orden.numero_factura})"
            _registrar(orden, request.user, "cerrada", texto + ".")
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
            es_garantia = bool(data.get("es_garantia")) and tipo == Tipos.REPUESTO
            if es_garantia and orden.tipo != OrdenTaller.TiposOrden.GARANTIA:
                raise ValidationError({"detail": "Solo en una orden por garantía un repuesto puede ir sin costo."})
            cantidad = _parse_cantidad(data.get("cantidad"), default=1)
            precio = _parse_decimal(data.get("precio"), "El precio")
            posicion = (orden.lineas.aggregate(m=Max("posicion"))["m"] or 0) + 1

            if tipo == Tipos.REPUESTO:
                producto = Producto.objects.filter(pk=data.get("producto")).first()
                if producto is None:
                    raise ValidationError({"detail": "Elige un repuesto del inventario."})
                existente = (
                    orden.lineas.select_for_update()
                    .filter(tipo=Tipos.REPUESTO, producto=producto, es_garantia=es_garantia)
                    .first()
                )
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
                    es_garantia=es_garantia,
                    precio=(
                        Decimal("0")
                        if es_garantia
                        else (precio if precio is not None else (producto.precio or Decimal("0")))
                    ),
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
                extra = " (garantía, sin costo)" if linea.es_garantia else ""
                _registrar(
                    orden,
                    request.user,
                    "linea_agregada",
                    f"Agregó {linea.get_tipo_display().lower()}: {_linea_label(linea)} x{linea.cantidad}{extra}.",
                )
                if linea.tipo == Tipos.SIN_CODIGO:
                    _registrar(
                        orden,
                        request.user,
                        "sin_codigo",
                        f"Aviso al administrador: {_linea_label(linea)} no existe en el inventario; hay que comprarlo y crearlo.",
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
                despachado = linea.cantidad_despachada
                _quitar_despachado(orden, linea, despachado, request.user)
                linea.delete()
                if en_orden:
                    texto = f"Quitó {label}."
                    if despachado:
                        texto += f" Las {despachado} unidad(es) ya entregadas quedan por devolver a bodega."
                    _registrar(orden, request.user, "linea_quitada", texto)
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
                    if cantidad < linea.cantidad_despachada:
                        sobra = linea.cantidad_despachada - cantidad
                        _quitar_despachado(orden, linea, sobra, request.user)
                        linea.cantidad_despachada = cantidad
                        cambios.append(f"{sobra} ya entregada(s) quedan por devolver a bodega")
            if "es_garantia" in data and linea.tipo == Tipos.REPUESTO:
                es_garantia = bool(data.get("es_garantia"))
                if es_garantia and orden.tipo != OrdenTaller.TiposOrden.GARANTIA:
                    raise ValidationError({"detail": "Solo en una orden por garantía un repuesto puede ir sin costo."})
                if es_garantia != linea.es_garantia:
                    linea.es_garantia = es_garantia
                    linea.precio = Decimal("0") if es_garantia else (linea.precio_lista or Decimal("0"))
                    _aplicar_estado_precio(linea, request.user)
                    cambios.append("marcado como garantía (sin costo)" if es_garantia else "ya no va por garantía")
            if "precio" in data and not linea.es_garantia:
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
            linea.precio_revisado_en = timezone.now()
            linea.save()
            _registrar(orden, request.user, "precio_revisado", texto)
        return self._detail(orden)

    @action(detail=True, methods=["post"], url_path=r"lineas/(?P<linea_id>\d+)/vincular-producto")
    def vincular_producto(self, request, pk=None, linea_id=None):
        """Repuesto sin codigo -> producto del inventario (recien creado o existente)."""
        self._exigir_admin(request.user, "crear o vincular el producto")
        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            self._exigir_editable(orden)
            linea = orden.lineas.select_for_update(of=("self",)).filter(pk=linea_id).first()
            if linea is None:
                raise ValidationError({"detail": "Esa línea ya no existe en la orden."})
            if linea.tipo != Tipos.SIN_CODIGO:
                raise ValidationError({"detail": "Esa línea ya tiene un producto del inventario."})
            producto = Producto.objects.filter(pk=request.data.get("producto")).first()
            if producto is None:
                raise ValidationError({"detail": "Ese producto no existe."})
            antes = _linea_label(linea)
            linea.tipo = Tipos.REPUESTO
            linea.producto = producto
            linea.era_sin_codigo = True
            linea.descripcion = producto.nombre
            linea.precio_lista = producto.precio
            if not linea.precio:
                linea.precio = producto.precio or Decimal("0")
            _aplicar_estado_precio(linea, request.user)
            linea.save()
            _registrar(
                orden,
                request.user,
                "producto_creado",
                f"El repuesto sin código {antes} ahora es el producto {producto.codigo} del inventario.",
            )
        return self._detail(orden)

    # ---- Repuestos a prueba -------------------------------------------------

    @action(detail=True, methods=["post"], url_path="pruebas")
    def agregar_prueba(self, request, pk=None):
        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            self._exigir_orden_de_trabajo(orden, "pedir repuestos a prueba")
            producto = Producto.objects.filter(pk=request.data.get("producto")).first()
            if producto is None:
                raise ValidationError({"detail": "Elige el repuesto del inventario que quieren probar."})
            cantidad = _parse_cantidad(request.data.get("cantidad"), default=1)
            prueba = orden.pruebas.select_for_update().filter(producto=producto, origen=Origenes.PRUEBA).first()
            if prueba is None:
                OrdenTallerPrueba.objects.create(
                    orden=orden,
                    producto=producto,
                    origen=Origenes.PRUEBA,
                    cantidad_solicitada=cantidad,
                    creado_por=request.user,
                )
            else:
                prueba.cantidad_solicitada += cantidad
                prueba.save(update_fields=["cantidad_solicitada"])
            _registrar(orden, request.user, "prueba_pedida", f"Pidió a prueba {producto.codigo} x{cantidad}.")
        return self._detail(orden, status.HTTP_201_CREATED)

    @action(detail=True, methods=["patch", "delete"], url_path=r"pruebas/(?P<prueba_id>\d+)")
    def prueba(self, request, pk=None, prueba_id=None):
        """Cancela lo pedido a prueba que todavia no se entrega."""
        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            self._exigir_orden_de_trabajo(orden, "cambiar los repuestos a prueba")
            prueba = (
                orden.pruebas.select_for_update(of=("self",)).select_related("producto").filter(pk=prueba_id).first()
            )
            if prueba is None:
                raise ValidationError({"detail": "Ese repuesto a prueba ya no existe."})
            if request.method == "DELETE":
                if prueba.cantidad_entregada:
                    raise ValidationError(
                        {"detail": "Ya se entregó: no se puede borrar. Pásalo a la orden o regístralo como devuelto."}
                    )
                codigo = prueba.producto.codigo
                prueba.delete()
                _registrar(orden, request.user, "prueba_cancelada", f"Canceló la prueba de {codigo}.")
                return self._detail(orden)
            nueva = _parse_cantidad(request.data.get("cantidad_solicitada"), minimo=0)
            if nueva < prueba.cantidad_entregada:
                raise ValidationError(
                    {"detail": f"Ya se entregaron {prueba.cantidad_entregada}: no puede quedar menos que eso."}
                )
            prueba.cantidad_solicitada = nueva
            prueba.save(update_fields=["cantidad_solicitada"])
        return self._detail(orden)

    @action(detail=True, methods=["post"], url_path=r"pruebas/(?P<prueba_id>\d+)/pasar-a-orden")
    def pasar_a_orden(self, request, pk=None, prueba_id=None):
        """El repuesto a prueba funciono: entra a la orden (ya esta en el taller)."""
        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            self._exigir_orden_de_trabajo(orden, "pasar repuestos a la orden")
            prueba = (
                orden.pruebas.select_for_update(of=("self",)).select_related("producto").filter(pk=prueba_id).first()
            )
            if prueba is None:
                raise ValidationError({"detail": "Ese repuesto a prueba ya no existe."})
            cantidad = _parse_cantidad(request.data.get("cantidad"), default=prueba.en_taller)
            if cantidad > prueba.en_taller:
                raise ValidationError({"detail": f"En el taller solo hay {prueba.en_taller} de este repuesto."})
            producto = prueba.producto
            linea = (
                orden.lineas.select_for_update()
                .filter(tipo=Tipos.REPUESTO, producto=producto, es_garantia=False)
                .first()
            )
            if linea is None:
                linea = OrdenTallerLinea(
                    orden=orden,
                    tipo=Tipos.REPUESTO,
                    producto=producto,
                    descripcion=producto.nombre,
                    cantidad=cantidad,
                    cantidad_despachada=cantidad,
                    precio_lista=producto.precio,
                    precio=producto.precio or Decimal("0"),
                    agregada_en_orden=True,
                    posicion=(orden.lineas.aggregate(m=Max("posicion"))["m"] or 0) + 1,
                    creado_por=request.user,
                )
                _aplicar_estado_precio(linea, request.user)
                linea.save()
            else:
                linea.cantidad += cantidad
                linea.cantidad_despachada += cantidad
                linea.save(update_fields=["cantidad", "cantidad_despachada", "actualizado_en"])
            prueba.cantidad_usada += cantidad
            prueba.save(update_fields=["cantidad_usada"])
            _registrar(
                orden,
                request.user,
                "prueba_a_orden",
                f"El repuesto a prueba {producto.codigo} x{cantidad} pasó a la orden.",
            )
        return self._detail(orden)

    # ---- Despachos (entregas con firma) --------------------------------------

    @action(detail=True, methods=["get"], url_path="ubicaciones")
    def ubicaciones(self, request, pk=None):
        orden = OrdenTaller.objects.filter(pk=pk).first()
        if orden is None:
            raise ValidationError({"detail": "La orden ya no existe."})
        self._exigir_sucursal(orden)
        ids = [int(x) for x in str(request.query_params.get("productos") or "").split(",") if x.strip().isdigit()]
        return Response(
            {str(pid): taller_stock.ubicaciones_producto(orden.sucursal_id, pid) for pid in ids[:200]}
        )

    @action(detail=True, methods=["post"], url_path="entregas")
    def entregar(self, request, pk=None):
        self._exigir_admin(request.user, "despachar repuestos")
        data = request.data
        recibido_por = str(data.get("recibido_por") or "").strip()
        firma = str(data.get("firma") or "").strip()
        if not recibido_por:
            raise ValidationError({"detail": "Indica quién recibe los repuestos."})
        if not firma.startswith("data:image/"):
            raise ValidationError({"detail": "Falta la firma de quien recibe."})
        if len(firma) > FIRMA_MAX_CHARS:
            raise ValidationError({"detail": "La firma es demasiado grande. Bórrala y vuelve a firmar."})
        items = data.get("items") or []
        if not isinstance(items, list) or not items:
            raise ValidationError({"detail": "Elige qué repuestos se entregan."})

        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            self._exigir_orden_de_trabajo(orden, "despachar repuestos")
            self._exigir_sucursal(orden)
            preparados = []
            for raw in items:
                cantidad = _parse_cantidad(raw.get("cantidad"), minimo=0)
                if cantidad == 0:
                    continue
                if raw.get("linea"):
                    linea = (
                        orden.lineas.select_for_update(of=("self",))
                        .select_related("producto")
                        .filter(pk=raw.get("linea"))
                        .first()
                    )
                    if linea is None:
                        raise ValidationError({"detail": "Una de las líneas ya no existe en la orden."})
                    if linea.tipo != Tipos.REPUESTO or not linea.producto_id:
                        raise ValidationError({"detail": f"{_linea_label(linea)} no es un repuesto del inventario."})
                    if linea.precio_estado == EstadosPrecio.PENDIENTE:
                        raise ValidationError(
                            {"detail": f"{_linea_label(linea)} tiene el precio por aprobar: apruébalo antes de despacharlo."}
                        )
                    if cantidad > linea.pendiente_despacho:
                        raise ValidationError(
                            {"detail": f"De {linea.producto.codigo} solo faltan despachar {linea.pendiente_despacho}."}
                        )
                    preparados.append(("linea", linea, linea.producto_id, cantidad, raw.get("subdivision_id")))
                elif raw.get("prueba"):
                    prueba = (
                        orden.pruebas.select_for_update(of=("self",))
                        .select_related("producto")
                        .filter(pk=raw.get("prueba"))
                        .first()
                    )
                    if prueba is None:
                        raise ValidationError({"detail": "Uno de los repuestos a prueba ya no existe."})
                    if cantidad > prueba.pendiente_entrega:
                        raise ValidationError(
                            {
                                "detail": (
                                    f"De {prueba.producto.codigo} a prueba solo faltan entregar {prueba.pendiente_entrega}."
                                )
                            }
                        )
                    preparados.append(("prueba", prueba, prueba.producto_id, cantidad, raw.get("subdivision_id")))
                else:
                    raise ValidationError({"detail": "Cada repuesto debe indicar su línea o su prueba."})
            if not preparados:
                raise ValidationError({"detail": "Indica al menos una cantidad para entregar."})

            tipo = (
                OrdenTallerEntrega.Tipos.PRUEBA
                if all(p[0] == "prueba" for p in preparados)
                else OrdenTallerEntrega.Tipos.ORDEN
            )
            entrega = OrdenTallerEntrega.objects.create(
                orden=orden,
                tipo=tipo,
                entregado_por=request.user,
                recibido_por=recibido_por[:150],
                recibido_rol=str(data.get("recibido_rol") or "").strip()[:40],
                firma=firma,
                nota=str(data.get("nota") or "").strip(),
            )
            resumen = []
            for kind, obj, producto_id, cantidad, subdivision_id in preparados:
                origen, tomado = taller_stock.descontar(orden.sucursal_id, producto_id, cantidad, subdivision_id)
                if kind == "linea":
                    obj.cantidad_despachada += cantidad
                    obj.save(update_fields=["cantidad_despachada", "actualizado_en"])
                    OrdenTallerEntregaItem.objects.create(
                        entrega=entrega, linea=obj, producto_id=producto_id, sucursal_id=origen, cantidad=cantidad, ubicaciones=tomado
                    )
                    resumen.append(f"{obj.producto.codigo} x{cantidad}")
                else:
                    obj.cantidad_entregada += cantidad
                    obj.save(update_fields=["cantidad_entregada"])
                    OrdenTallerEntregaItem.objects.create(
                        entrega=entrega, prueba=obj, producto_id=producto_id, sucursal_id=origen, cantidad=cantidad, ubicaciones=tomado
                    )
                    resumen.append(f"{obj.producto.codigo} x{cantidad} (a prueba)")
            _registrar(
                orden,
                request.user,
                "despacho",
                f"Despachó {', '.join(resumen)}. Recibió {entrega.recibido_por}"
                + (f" ({entrega.recibido_rol})" if entrega.recibido_rol else "")
                + " con firma.",
            )
        return self._detail(orden, status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"], url_path="devoluciones")
    def devolver(self, request, pk=None):
        """El admin verifica que el repuesto volvio y lo guarda donde elija."""
        self._exigir_admin(request.user, "recibir devoluciones del taller")
        with transaction.atomic():
            orden = self._orden_bloqueada(pk)
            self._exigir_sucursal(orden)
            if orden.estado != Estados.ORDEN:
                raise ValidationError({"detail": "Esta orden no tiene repuestos por devolver."})
            prueba = (
                orden.pruebas.select_for_update(of=("self",))
                .select_related("producto")
                .filter(pk=request.data.get("prueba"))
                .first()
            )
            if prueba is None:
                raise ValidationError({"detail": "Ese repuesto ya no está en la lista del taller."})
            cantidad = _parse_cantidad(request.data.get("cantidad"), default=prueba.en_taller)
            if cantidad > prueba.en_taller:
                raise ValidationError({"detail": f"En el taller solo hay {prueba.en_taller} de {prueba.producto.codigo}."})
            if not request.data.get("subdivision_id"):
                raise ValidationError({"detail": "Elige la ubicación donde se guardó."})
            subdivision = taller_stock.resolver_subdivision(orden.sucursal_id, request.data.get("subdivision_id"))
            taller_stock.devolver(subdivision, prueba.producto_id, cantidad)
            prueba.cantidad_devuelta += cantidad
            prueba.save(update_fields=["cantidad_devuelta"])
            ubicacion = taller_stock.etiqueta_ubicacion(subdivision, con_sucursal=True)
            devuelto_por = str(request.data.get("devuelto_por") or "").strip()[:150]
            OrdenTallerDevolucion.objects.create(
                orden=orden,
                prueba=prueba,
                producto_id=prueba.producto_id,
                cantidad=cantidad,
                subdivision=subdivision,
                ubicacion=ubicacion,
                devuelto_por=devuelto_por,
                recibido_por=request.user,
            )
            _registrar(
                orden,
                request.user,
                "devolucion",
                f"Verificó la devolución de {prueba.producto.codigo} x{cantidad}"
                + (f" (la trajo {devuelto_por})" if devuelto_por else "")
                + f" y la guardó en {ubicacion}.",
            )
        return self._detail(orden, status.HTTP_201_CREATED)

    # ---- Busquedas -------------------------------------------------------------

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
        # Stock en la sucursal del taller y en las demas (se puede pedir de alla).
        sucursal = str(request.query_params.get("sucursal") or "").strip()
        sucursal_id = int(sucursal) if sucursal.isdigit() else None
        stock = {}
        otras = {}
        for pid, sid, nombre, qty in (
            Inventario.objects.filter(producto_id__in=[p["id"] for p in productos], cantidad__gt=0)
            .values_list("producto_id", "subdivision__division__bodega__sucursal_id", "subdivision__division__bodega__sucursal__nombre", "cantidad")
        ):
            if sucursal_id is None or sid == sucursal_id:
                stock[pid] = stock.get(pid, 0) + int(qty)
            else:
                otras.setdefault(pid, {})
                otras[pid][nombre] = otras[pid].get(nombre, 0) + int(qty)
        upper = term.upper()
        productos.sort(key=lambda p: (str(p["codigo"]).upper() != upper, not str(p["codigo"]).upper().startswith(upper)))
        return Response(
            [
                {
                    **p,
                    "precio": str(p["precio"]) if p["precio"] is not None else None,
                    "stock": int(stock.get(p["id"]) or 0),
                    "stock_otras": sum((otras.get(p["id"]) or {}).values()),
                    "otras_sucursales": [
                        {"sucursal": nombre, "cantidad": qty} for nombre, qty in sorted((otras.get(p["id"]) or {}).items())
                    ],
                }
                for p in productos
            ]
        )

    @action(detail=False, methods=["get"], url_path="sucursales")
    def sucursales(self, request):
        """Sucursales para elegir de donde salen los repuestos de la orden."""
        return Response(list(Sucursal.objects.order_by("nombre").values("id", "nombre")))

    @action(detail=False, methods=["get"], url_path="buscar-garantia")
    def buscar_garantia(self, request):
        """Ordenes cerradas por placa, factura, cliente, encargado o numero."""
        term = str(request.query_params.get("q") or "").strip()
        if not term:
            return Response([])
        filtro = (
            Q(placa__icontains=term)
            | Q(numero_factura__icontains=term)
            | Q(numero_pedido__icontains=term)
            | Q(cliente_nombre__icontains=term)
            | Q(cliente_identificacion__icontains=term)
            | Q(tecnico__icontains=term)
            | Q(asesor__first_name__icontains=term)
            | Q(asesor__last_name__icontains=term)
            | Q(asesor__email__icontains=term)
            | Q(vin__icontains=term)
        )
        digits = term.lstrip("#")
        if digits.isdigit():
            filtro |= Q(numero=int(digits))
        ordenes = (
            OrdenTaller.objects.filter(estado=Estados.CERRADA)
            .filter(filtro)
            .select_related("asesor")
            .prefetch_related("lineas__producto")
            .order_by("-cerrada_en", "-numero")[:20]
        )
        resultado = []
        for orden in ordenes:
            item = resumen_orden_anterior(orden)
            item.update(
                {
                    "modelo": orden.modelo,
                    "tecnico": orden.tecnico,
                    "asesor_nombre": nombre_usuario(orden.asesor),
                    "numero_pedido": orden.numero_pedido,
                }
            )
            resultado.append(item)
        return Response(resultado)

    @action(detail=False, methods=["get"], url_path="sugerir-codigo")
    def sugerir_codigo(self, request):
        self._exigir_admin(request.user, "crear productos")
        referencia = str(request.query_params.get("referencia") or "").strip()
        casa = str(request.query_params.get("casa") or "").strip()
        return Response(sugerir_codigo(referencia, int(casa) if casa.isdigit() else None))
