from datetime import date
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models import Count, Q, Sum
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from usuarios.permissions import CajaChicaModulePermission
from usuarios.utils import is_app_admin

from .models import Arqueo, Caja, CategoriaGasto, MovimientoCaja

M = MovimientoCaja
IMAGEN_MAX_CHARS = 3_000_000
DENOMINACIONES = ["100", "50", "20", "10", "5", "2", "1", "0.50", "0.25", "0.10", "0.05", "0.01"]


def _nombre(user):
    if user is None:
        return ""
    return str(user.get_full_name() or "").strip() or str(user.email or user.username or "")


def _money(value, label="El monto", allow_zero=False):
    try:
        parsed = Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError, TypeError):
        raise ValidationError({"detail": f"{label} no es un número válido."})
    if parsed < 0 or (parsed == 0 and not allow_zero):
        raise ValidationError({"detail": f"{label} debe ser mayor que cero."})
    return parsed


def _fmt(value):
    return f"${Decimal(value or 0).quantize(Decimal('0.01'))}"


# ---------------------------------------------------------------- serializers


class CategoriaGastoSerializer(serializers.ModelSerializer):
    class Meta:
        model = CategoriaGasto
        fields = ["id", "nombre", "activa"]

    def validate_nombre(self, value):
        value = str(value or "").strip()
        if not value:
            raise serializers.ValidationError("Escribe el nombre de la categoría.")
        return value


class CajaSerializer(serializers.ModelSerializer):
    sucursal_nombre = serializers.CharField(source="sucursal.nombre", read_only=True, default="")
    custodio_nombre = serializers.SerializerMethodField()
    saldo = serializers.SerializerMethodField()
    pendientes = serializers.SerializerMethodField()
    anticipos_abiertos = serializers.SerializerMethodField()
    ultimo_arqueo = serializers.SerializerMethodField()

    class Meta:
        model = Caja
        fields = [
            "id",
            "nombre",
            "sucursal",
            "sucursal_nombre",
            "custodio",
            "custodio_nombre",
            "monto_fondo",
            "tope_gasto",
            "alerta_reposicion",
            "activa",
            "saldo",
            "pendientes",
            "anticipos_abiertos",
            "ultimo_arqueo",
            "configurada",
            "creado_en",
        ]
        read_only_fields = ["id", "creado_en"]

    configurada = serializers.SerializerMethodField()

    def get_configurada(self, obj):
        return obj.movimientos.filter(tipo=MovimientoCaja.Tipos.APERTURA).exists()

    def get_custodio_nombre(self, obj):
        return _nombre(obj.custodio)

    def get_saldo(self, obj):
        return str(obj.saldo())

    def get_pendientes(self, obj):
        return obj.movimientos.filter(estado=M.Estados.PENDIENTE).count()

    def get_anticipos_abiertos(self, obj):
        return obj.movimientos.filter(tipo=M.Tipos.ANTICIPO, estado=M.Estados.APROBADO, liquidado_en__isnull=True).count()

    def get_ultimo_arqueo(self, obj):
        arqueo = obj.arqueos.first()
        if arqueo is None:
            return None
        return {"fecha": arqueo.creado_en, "diferencia": str(arqueo.diferencia)}

    def get_unique_together_validators(self):
        return []

    def get_fields(self):
        fields = super().get_fields()
        # La unicidad de la sucursal se valida abajo con un mensaje claro.
        fields["sucursal"].validators = []
        fields["nombre"].required = False
        fields["nombre"].allow_blank = True
        return fields

    def validate(self, attrs):
        sucursal = attrs.get("sucursal", getattr(self.instance, "sucursal", None))
        if sucursal is None:
            raise serializers.ValidationError({"detail": "Elige la sucursal: cada sucursal tiene su caja chica."})
        otra = Caja.objects.filter(sucursal=sucursal)
        if self.instance is not None:
            otra = otra.exclude(pk=self.instance.pk)
        if otra.exists():
            raise serializers.ValidationError({"detail": f"{sucursal.nombre} ya tiene su caja chica."})
        if "nombre" in attrs or self.instance is None:
            attrs["nombre"] = str(attrs.get("nombre") or "").strip() or f"Caja chica {sucursal.nombre}"
        if "monto_fondo" in attrs and (attrs["monto_fondo"] is None or attrs["monto_fondo"] <= 0):
            raise serializers.ValidationError({"detail": "El fondo debe ser mayor que cero."})
        if self.instance is not None and "sucursal" in attrs and attrs["sucursal"] != self.instance.sucursal:
            raise serializers.ValidationError({"detail": "La caja es de su sucursal: no se puede cambiar."})
        if "tope_gasto" in attrs and attrs["tope_gasto"] is not None and attrs["tope_gasto"] < 0:
            raise serializers.ValidationError({"detail": "El tope no puede ser negativo."})
        return attrs


class MovimientoCajaSerializer(serializers.ModelSerializer):
    tipo_label = serializers.CharField(source="get_tipo_display", read_only=True)
    estado_label = serializers.CharField(source="get_estado_display", read_only=True)
    comprobante_label = serializers.CharField(source="get_comprobante_tipo_display", read_only=True)
    categoria_nombre = serializers.CharField(source="categoria.nombre", read_only=True, default="")
    registrado_por_nombre = serializers.SerializerMethodField()
    revisado_por_nombre = serializers.SerializerMethodField()
    tiene_imagen = serializers.SerializerMethodField()
    es_entrada = serializers.SerializerMethodField()
    afecta_saldo = serializers.SerializerMethodField()
    liquidacion = serializers.SerializerMethodField()

    class Meta:
        model = MovimientoCaja
        fields = [
            "id",
            "caja",
            "tipo",
            "tipo_label",
            "estado",
            "estado_label",
            "fecha",
            "monto",
            "categoria",
            "categoria_nombre",
            "descripcion",
            "beneficiario",
            "comprobante_tipo",
            "comprobante_label",
            "comprobante_numero",
            "tiene_imagen",
            "motivo_rechazo",
            "liquidado_en",
            "de_anticipo",
            "liquidacion",
            "es_entrada",
            "afecta_saldo",
            "registrado_por",
            "registrado_por_nombre",
            "revisado_por_nombre",
            "revisado_en",
            "creado_en",
        ]

    def get_registrado_por_nombre(self, obj):
        return _nombre(obj.registrado_por)

    def get_revisado_por_nombre(self, obj):
        return _nombre(obj.revisado_por)

    def get_tiene_imagen(self, obj):
        return bool(obj.comprobante_imagen)

    def get_es_entrada(self, obj):
        return obj.tipo in M.TIPOS_ENTRADA

    def get_afecta_saldo(self, obj):
        return obj.estado == M.Estados.APROBADO and obj.de_anticipo_id is None

    def get_liquidacion(self, obj):
        if obj.tipo != M.Tipos.ANTICIPO or not obj.liquidado_en:
            return None
        gastos = [m for m in obj.liquidaciones.all()]
        gastado = sum((m.monto for m in gastos), Decimal("0"))
        return {"gastado": str(gastado), "diferencia": str(obj.monto - gastado)}


# ---------------------------------------------------------------- helpers


def asegurar_cajas():
    """Cada sucursal tiene su caja chica, siempre: crea las que falten."""
    from inventario.models import Sucursal

    faltan = Sucursal.objects.filter(caja_chica__isnull=True)
    for sucursal in faltan:
        Caja.objects.get_or_create(sucursal=sucursal, defaults={"nombre": f"Caja chica {sucursal.nombre}"})


def caja_configurada(caja):
    return caja.movimientos.filter(tipo=M.Tipos.APERTURA).exists()


def _cajas_visibles(user):
    queryset = Caja.objects.select_related("sucursal", "custodio")
    if is_app_admin(user):
        return queryset
    return queryset.filter(custodio=user, activa=True)


def _caja_para(user, caja_id):
    caja = _cajas_visibles(user).filter(pk=caja_id).first()
    if caja is None:
        raise ValidationError({"detail": "No tienes acceso a esa caja."})
    return caja


def _estado_inicial(caja, tipo, monto, user):
    if is_app_admin(user):
        return M.Estados.APROBADO
    if tipo == M.Tipos.INGRESO:
        return M.Estados.PENDIENTE
    if tipo in M.TIPOS_SALIDA and caja.tope_gasto and monto > caja.tope_gasto:
        return M.Estados.PENDIENTE
    return M.Estados.APROBADO


def _exigir_saldo(caja, monto, excluir_id=None):
    saldo = caja.saldo()
    if monto > saldo:
        raise ValidationError(
            {"detail": f"No alcanza: en la caja hay {_fmt(saldo)} y el movimiento es de {_fmt(monto)}. Pide una reposición."}
        )


def _datos_movimiento(data, tipo, parcial=False):
    """Valida y normaliza los campos que llegan del formulario."""
    valores = {}
    if not parcial or "fecha" in data:
        fecha = parse_date(str(data.get("fecha") or "")) if data.get("fecha") else timezone.localdate()
        if fecha is None:
            raise ValidationError({"detail": "La fecha no es válida."})
        if fecha > timezone.localdate():
            raise ValidationError({"detail": "La fecha no puede ser futura."})
        valores["fecha"] = fecha
    if not parcial or "monto" in data:
        valores["monto"] = _money(data.get("monto"))
    for campo, largo in (("descripcion", None), ("beneficiario", 150), ("comprobante_numero", 60)):
        if not parcial or campo in data:
            texto = str(data.get(campo) or "").strip()
            valores[campo] = texto[:largo] if largo else texto
    if not parcial or "categoria" in data:
        categoria = None
        if data.get("categoria"):
            categoria = CategoriaGasto.objects.filter(pk=data.get("categoria")).first()
            if categoria is None:
                raise ValidationError({"detail": "Esa categoría no existe."})
        valores["categoria"] = categoria
    if not parcial or "comprobante_tipo" in data:
        comprobante = str(data.get("comprobante_tipo") or "").strip()
        if comprobante and comprobante not in M.Comprobantes.values:
            raise ValidationError({"detail": "Tipo de comprobante no válido."})
        valores["comprobante_tipo"] = comprobante
    if not parcial or "comprobante_imagen" in data:
        imagen = str(data.get("comprobante_imagen") or "").strip()
        if imagen and not imagen.startswith("data:image/"):
            raise ValidationError({"detail": "La foto del comprobante no es una imagen."})
        if len(imagen) > IMAGEN_MAX_CHARS:
            raise ValidationError({"detail": "La foto es demasiado grande."})
        valores["comprobante_imagen"] = imagen

    if tipo == M.Tipos.GASTO:
        if not parcial or "categoria" in valores:
            if valores.get("categoria") is None:
                raise ValidationError({"detail": "Elige la categoría del gasto."})
        if not parcial or "comprobante_tipo" in valores:
            if not valores.get("comprobante_tipo"):
                raise ValidationError({"detail": "Indica el comprobante (o \"Sin comprobante\")."})
    if not parcial or "descripcion" in valores:
        if not valores.get("descripcion"):
            raise ValidationError({"detail": "Describe el movimiento."})
    if tipo == M.Tipos.ANTICIPO and (not parcial or "beneficiario" in valores):
        if not valores.get("beneficiario"):
            raise ValidationError({"detail": "Indica a quién se entrega el anticipo."})
    return valores


# ---------------------------------------------------------------- viewsets


class CategoriaGastoViewSet(viewsets.ModelViewSet):
    serializer_class = CategoriaGastoSerializer
    permission_classes = [IsAuthenticated, CajaChicaModulePermission]
    pagination_class = None
    queryset = CategoriaGasto.objects.all()

    def get_queryset(self):
        queryset = CategoriaGasto.objects.all().order_by("nombre")
        if str(self.request.query_params.get("activas") or "") in ("1", "true"):
            queryset = queryset.filter(activa=True)
        return queryset

    def _solo_admin(self):
        if not is_app_admin(self.request.user):
            raise PermissionDenied("Solo un administrador puede cambiar las categorías.")

    def perform_create(self, serializer):
        self._solo_admin()
        serializer.save()

    def perform_update(self, serializer):
        self._solo_admin()
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        self._solo_admin()
        categoria = self.get_object()
        if categoria.movimientos.exists():
            categoria.activa = False
            categoria.save(update_fields=["activa"])
            return Response(CategoriaGastoSerializer(categoria).data)
        categoria.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class CajaViewSet(viewsets.ModelViewSet):
    serializer_class = CajaSerializer
    permission_classes = [IsAuthenticated, CajaChicaModulePermission]
    pagination_class = None
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_queryset(self):
        return _cajas_visibles(self.request.user).order_by("-activa", "nombre")

    def _solo_admin(self, accion="configurar cajas"):
        if not is_app_admin(self.request.user):
            raise PermissionDenied(f"Solo un administrador puede {accion}.")

    def list(self, request, *args, **kwargs):
        asegurar_cajas()
        return super().list(request, *args, **kwargs)

    def create(self, request, *args, **kwargs):
        raise ValidationError({"detail": "Cada sucursal ya tiene su caja chica: configúrala en vez de crear otra."})

    def perform_update(self, serializer):
        self._solo_admin()
        with transaction.atomic():
            caja = serializer.save()
            # La primera vez que se pone el fondo se abre la caja con ese monto.
            if caja.monto_fondo > 0 and not caja_configurada(caja):
                MovimientoCaja.objects.create(
                    caja=caja,
                    tipo=M.Tipos.APERTURA,
                    estado=M.Estados.APROBADO,
                    fecha=timezone.localdate(),
                    monto=caja.monto_fondo,
                    descripcion="Apertura del fondo de caja chica.",
                    registrado_por=self.request.user,
                    revisado_por=self.request.user,
                    revisado_en=timezone.now(),
                )

    def destroy(self, request, *args, **kwargs):
        raise ValidationError({"detail": "La caja chica de una sucursal no se elimina. Si no se usa, desactívala."})

    @action(detail=False, methods=["get"], url_path="opciones")
    def opciones(self, request):
        """Sucursales y usuarios para configurar una caja (solo admin)."""
        self._solo_admin()
        from django.contrib.auth import get_user_model

        from inventario.models import Sucursal

        usuarios = [
            {"id": u.id, "nombre": _nombre(u)}
            for u in get_user_model().objects.filter(is_active=True).order_by("first_name", "last_name", "email")
        ]
        con_caja = dict(Caja.objects.values_list("sucursal_id", "nombre"))
        return Response(
            {
                "sucursales": [
                    {**row, "caja": con_caja.get(row["id"], "")}
                    for row in Sucursal.objects.order_by("nombre").values("id", "nombre")
                ],
                "usuarios": usuarios,
            }
        )

    @action(detail=True, methods=["post"], url_path="reposicion")
    def reposicion(self, request, pk=None):
        """Pide reponer lo gastado para que el fondo vuelva a su monto."""
        caja = self.get_object()
        with transaction.atomic():
            caja = Caja.objects.select_for_update().get(pk=caja.pk)
            if caja.movimientos.filter(tipo=M.Tipos.REPOSICION, estado=M.Estados.PENDIENTE).exists():
                raise ValidationError({"detail": "Ya hay una reposición pedida esperando al administrador."})
            saldo = caja.saldo()
            sugerido = (caja.monto_fondo - saldo).quantize(Decimal("0.01"))
            monto = _money(request.data.get("monto"), "El monto") if request.data.get("monto") not in (None, "") else sugerido
            if monto <= 0:
                raise ValidationError({"detail": "La caja está completa: no hay nada que reponer."})
            movimiento = MovimientoCaja.objects.create(
                caja=caja,
                tipo=M.Tipos.REPOSICION,
                estado=M.Estados.APROBADO if is_app_admin(request.user) else M.Estados.PENDIENTE,
                fecha=timezone.localdate(),
                monto=monto,
                descripcion=str(request.data.get("descripcion") or "").strip()
                or f"Reposición: el fondo es {_fmt(caja.monto_fondo)} y quedan {_fmt(saldo)}.",
                registrado_por=request.user,
                revisado_por=request.user if is_app_admin(request.user) else None,
                revisado_en=timezone.now() if is_app_admin(request.user) else None,
            )
        return Response(MovimientoCajaSerializer(movimiento).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get", "post"], url_path="arqueos")
    def arqueos(self, request, pk=None):
        caja = self.get_object()
        if request.method == "GET":
            return Response(
                [
                    {
                        "id": a.id,
                        "denominaciones": a.denominaciones,
                        "total_contado": str(a.total_contado),
                        "saldo_sistema": str(a.saldo_sistema),
                        "diferencia": str(a.diferencia),
                        "observacion": a.observacion,
                        "realizado_por_nombre": _nombre(a.realizado_por),
                        "creado_en": a.creado_en,
                    }
                    for a in caja.arqueos.select_related("realizado_por")[:100]
                ]
            )
        raw = request.data.get("denominaciones") or {}
        if not isinstance(raw, dict):
            raise ValidationError({"detail": "El conteo no es válido."})
        conteo = {}
        total = Decimal("0")
        for denominacion in DENOMINACIONES:
            try:
                cantidad = int(raw.get(denominacion) or 0)
            except (TypeError, ValueError):
                raise ValidationError({"detail": f"La cantidad de {denominacion} no es un número."})
            if cantidad < 0:
                raise ValidationError({"detail": "Las cantidades no pueden ser negativas."})
            if cantidad:
                conteo[denominacion] = cantidad
                total += Decimal(denominacion) * cantidad
        saldo = caja.saldo()
        diferencia = (total - saldo).quantize(Decimal("0.01"))
        observacion = str(request.data.get("observacion") or "").strip()
        if diferencia != 0 and not observacion:
            raise ValidationError(
                {"detail": f"Hay {'un sobrante' if diferencia > 0 else 'un faltante'} de {_fmt(abs(diferencia))}: explica el motivo."}
            )
        arqueo = Arqueo.objects.create(
            caja=caja,
            denominaciones=conteo,
            total_contado=total,
            saldo_sistema=saldo,
            diferencia=diferencia,
            observacion=observacion,
            realizado_por=request.user,
        )
        return Response(
            {
                "id": arqueo.id,
                "total_contado": str(total),
                "saldo_sistema": str(saldo),
                "diferencia": str(diferencia),
            },
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=["get"], url_path="resumen")
    def resumen(self, request, pk=None):
        caja = self.get_object()
        desde = parse_date(str(request.query_params.get("desde") or "")) or date(timezone.localdate().year, timezone.localdate().month, 1)
        hasta = parse_date(str(request.query_params.get("hasta") or "")) or timezone.localdate()
        gastos = caja.movimientos.filter(
            tipo=M.Tipos.GASTO, estado=M.Estados.APROBADO, fecha__gte=desde, fecha__lte=hasta
        )
        por_categoria = [
            {"categoria": row["categoria__nombre"] or "Sin categoría", "total": str(row["total"]), "cantidad": row["n"]}
            for row in gastos.values("categoria__nombre").annotate(total=Sum("monto"), n=Count("id")).order_by("-total")
        ]
        total_gastos = gastos.aggregate(t=Sum("monto"))["t"] or Decimal("0")
        return Response(
            {
                "desde": desde,
                "hasta": hasta,
                "total_gastos": str(total_gastos),
                "por_categoria": por_categoria,
                "sin_comprobante": gastos.filter(Q(comprobante_tipo=M.Comprobantes.SIN) | Q(comprobante_tipo="")).count(),
                "sin_foto": gastos.filter(comprobante_imagen="").exclude(comprobante_tipo=M.Comprobantes.SIN).count(),
                "ingresos": str(
                    caja.movimientos.filter(
                        tipo__in=M.TIPOS_ENTRADA, estado=M.Estados.APROBADO, fecha__gte=desde, fecha__lte=hasta
                    ).aggregate(t=Sum("monto"))["t"]
                    or Decimal("0")
                ),
            }
        )


class MovimientoCajaViewSet(viewsets.ModelViewSet):
    serializer_class = MovimientoCajaSerializer
    permission_classes = [IsAuthenticated, CajaChicaModulePermission]
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_queryset(self):
        queryset = (
            MovimientoCaja.objects.filter(caja__in=_cajas_visibles(self.request.user))
            .select_related("categoria", "registrado_por", "revisado_por")
            .prefetch_related("liquidaciones")
            .defer("comprobante_imagen")
        )
        params = self.request.query_params
        if params.get("caja"):
            queryset = queryset.filter(caja_id=params.get("caja"))
        tipos = [t for t in str(params.get("tipo") or "").split(",") if t]
        if tipos:
            queryset = queryset.filter(tipo__in=tipos)
        if params.get("estado"):
            queryset = queryset.filter(estado=params.get("estado"))
        if params.get("categoria"):
            queryset = queryset.filter(categoria_id=params.get("categoria"))
        desde = parse_date(str(params.get("desde") or ""))
        hasta = parse_date(str(params.get("hasta") or ""))
        if desde:
            queryset = queryset.filter(fecha__gte=desde)
        if hasta:
            queryset = queryset.filter(fecha__lte=hasta)
        if str(params.get("abiertos") or "") in ("1", "true"):
            queryset = queryset.filter(tipo=M.Tipos.ANTICIPO, estado=M.Estados.APROBADO, liquidado_en__isnull=True)
        search = str(params.get("search") or "").strip()
        if search:
            queryset = queryset.filter(
                Q(descripcion__icontains=search)
                | Q(beneficiario__icontains=search)
                | Q(comprobante_numero__icontains=search)
                | Q(categoria__nombre__icontains=search)
            )
        return queryset.order_by("-fecha", "-id")

    @action(detail=True, methods=["get"], url_path="imagen")
    def imagen(self, request, pk=None):
        movimiento = MovimientoCaja.objects.filter(
            pk=pk, caja__in=_cajas_visibles(request.user)
        ).values("comprobante_imagen").first()
        if movimiento is None:
            raise ValidationError({"detail": "Ese movimiento no existe."})
        return Response({"imagen": movimiento["comprobante_imagen"]})

    def create(self, request, *args, **kwargs):
        tipo = str(request.data.get("tipo") or "").strip()
        if tipo not in (M.Tipos.GASTO, M.Tipos.ANTICIPO, M.Tipos.INGRESO):
            raise ValidationError({"detail": "Tipo de movimiento no válido."})
        caja = _caja_para(request.user, request.data.get("caja"))
        if not caja.activa:
            raise ValidationError({"detail": "Esa caja está desactivada."})
        if not caja_configurada(caja):
            raise ValidationError({"detail": "La caja todavía no tiene fondo: el administrador debe configurarla."})
        valores = _datos_movimiento(request.data, tipo)
        with transaction.atomic():
            caja = Caja.objects.select_for_update().get(pk=caja.pk)
            estado = _estado_inicial(caja, tipo, valores["monto"], request.user)
            if tipo in M.TIPOS_SALIDA and estado == M.Estados.APROBADO:
                _exigir_saldo(caja, valores["monto"])
            es_admin = is_app_admin(request.user)
            movimiento = MovimientoCaja.objects.create(
                caja=caja,
                tipo=tipo,
                estado=estado,
                registrado_por=request.user,
                revisado_por=request.user if es_admin else None,
                revisado_en=timezone.now() if es_admin else None,
                **valores,
            )
        return Response(MovimientoCajaSerializer(movimiento).data, status=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        if not kwargs.get("partial"):
            return Response(status=status.HTTP_405_METHOD_NOT_ALLOWED)
        es_admin = is_app_admin(request.user)
        with transaction.atomic():
            movimiento = self.get_queryset().select_for_update(of=("self",)).filter(pk=kwargs["pk"]).first()
            if movimiento is None:
                raise ValidationError({"detail": "Ese movimiento no existe."})
            if movimiento.tipo in (M.Tipos.APERTURA, M.Tipos.VUELTO) or movimiento.de_anticipo_id or movimiento.liquidado_en:
                raise ValidationError({"detail": "Este movimiento no se edita."})
            if not es_admin:
                if movimiento.registrado_por_id != request.user.id or movimiento.estado == M.Estados.APROBADO:
                    raise PermissionDenied("Solo puedes corregir tus movimientos por aprobar o rechazados.")
            valores = _datos_movimiento(request.data, movimiento.tipo, parcial=True)
            for campo, valor in valores.items():
                setattr(movimiento, campo, valor)
            caja = Caja.objects.select_for_update().get(pk=movimiento.caja_id)
            if not es_admin:
                # Corregido: vuelve a evaluarse (o a esperar al admin).
                movimiento.estado = _estado_inicial(caja, movimiento.tipo, movimiento.monto, request.user)
                movimiento.motivo_rechazo = ""
            movimiento.save()
            if movimiento.tipo in M.TIPOS_SALIDA and movimiento.estado == M.Estados.APROBADO and caja.saldo() < 0:
                raise ValidationError({"detail": "Con ese monto la caja quedaría en negativo."})
        return Response(MovimientoCajaSerializer(movimiento).data)

    def destroy(self, request, *args, **kwargs):
        movimiento = self.get_queryset().filter(pk=kwargs["pk"]).first()
        if movimiento is None:
            raise ValidationError({"detail": "Ese movimiento no existe."})
        if movimiento.tipo == M.Tipos.APERTURA:
            raise ValidationError({"detail": "La apertura del fondo no se elimina."})
        if movimiento.liquidado_en or movimiento.de_anticipo_id or movimiento.tipo == M.Tipos.VUELTO:
            raise ValidationError({"detail": "Es parte de un anticipo liquidado: no se elimina."})
        if not is_app_admin(request.user) and (
            movimiento.registrado_por_id != request.user.id or movimiento.estado == M.Estados.APROBADO
        ):
            raise PermissionDenied("Solo puedes eliminar tus movimientos por aprobar o rechazados.")
        movimiento.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    def _revisar(self, request, pk, aprobar):
        if not is_app_admin(request.user):
            raise PermissionDenied("Solo un administrador puede aprobar o rechazar.")
        with transaction.atomic():
            movimiento = MovimientoCaja.objects.select_for_update().filter(pk=pk).first()
            if movimiento is None:
                raise ValidationError({"detail": "Ese movimiento no existe."})
            if movimiento.estado != M.Estados.PENDIENTE:
                raise ValidationError({"detail": "Ese movimiento ya no está por aprobar."})
            caja = Caja.objects.select_for_update().get(pk=movimiento.caja_id)
            if aprobar:
                if movimiento.tipo in M.TIPOS_SALIDA:
                    _exigir_saldo(caja, movimiento.monto)
                movimiento.estado = M.Estados.APROBADO
                movimiento.motivo_rechazo = ""
            else:
                movimiento.estado = M.Estados.RECHAZADO
                movimiento.motivo_rechazo = str(request.data.get("motivo") or "").strip()
            movimiento.revisado_por = request.user
            movimiento.revisado_en = timezone.now()
            movimiento.save()
        return Response(MovimientoCajaSerializer(movimiento).data)

    @action(detail=True, methods=["post"], url_path="aprobar")
    def aprobar(self, request, pk=None):
        return self._revisar(request, pk, True)

    @action(detail=True, methods=["post"], url_path="rechazar")
    def rechazar(self, request, pk=None):
        return self._revisar(request, pk, False)

    @action(detail=True, methods=["post"], url_path="liquidar")
    def liquidar(self, request, pk=None):
        """Anticipo: se registra lo que realmente se gasto, con su comprobante;
        si sobro dinero vuelve a la caja (vuelto), si falto sale de la caja."""
        with transaction.atomic():
            anticipo = self.get_queryset().select_for_update(of=("self",)).filter(pk=pk).first()
            if anticipo is None or anticipo.tipo != M.Tipos.ANTICIPO:
                raise ValidationError({"detail": "Ese anticipo no existe."})
            if anticipo.estado != M.Estados.APROBADO:
                raise ValidationError({"detail": "El anticipo todavía no está aprobado."})
            if anticipo.liquidado_en:
                raise ValidationError({"detail": "Ese anticipo ya se liquidó."})
            datos = dict(request.data)
            datos.setdefault("descripcion", anticipo.descripcion)
            datos["monto"] = request.data.get("monto_gastado")
            valores = _datos_movimiento(datos, M.Tipos.GASTO)
            gastado = valores["monto"]
            caja = Caja.objects.select_for_update().get(pk=anticipo.caja_id)
            comun = {
                "caja": caja,
                "registrado_por": request.user,
                "revisado_por": request.user,
                "revisado_en": timezone.now(),
            }
            parte_anticipo = min(gastado, anticipo.monto)
            MovimientoCaja.objects.create(
                tipo=M.Tipos.GASTO,
                estado=M.Estados.APROBADO,
                de_anticipo=anticipo,
                **{**valores, "monto": parte_anticipo, "beneficiario": valores.get("beneficiario") or anticipo.beneficiario},
                **comun,
            )
            if gastado < anticipo.monto:
                MovimientoCaja.objects.create(
                    tipo=M.Tipos.VUELTO,
                    estado=M.Estados.APROBADO,
                    fecha=valores["fecha"],
                    monto=anticipo.monto - gastado,
                    descripcion=f"Vuelto del anticipo a {anticipo.beneficiario}.",
                    beneficiario=anticipo.beneficiario,
                    **comun,
                )
            elif gastado > anticipo.monto:
                extra = gastado - anticipo.monto
                estado = _estado_inicial(caja, M.Tipos.GASTO, extra, request.user)
                if estado == M.Estados.APROBADO:
                    _exigir_saldo(caja, extra)
                MovimientoCaja.objects.create(
                    tipo=M.Tipos.GASTO,
                    estado=estado,
                    **{**valores, "monto": extra, "descripcion": f"Diferencia del anticipo: {valores['descripcion']}"},
                    caja=caja,
                    registrado_por=request.user,
                )
            anticipo.liquidado_en = timezone.now()
            anticipo.save(update_fields=["liquidado_en"])
        anticipo.refresh_from_db()
        return Response(MovimientoCajaSerializer(anticipo).data)
