from datetime import date

from django.db import OperationalError, ProgrammingError, connection
from django.db.models import Avg, Count, Max, Q, Sum
from django.utils import timezone
from rest_framework import serializers

from casa_comercial.models import CasaComercial
from casa_comercial.serializers import CasaComercialSerializer
from inventario.models import Bodega, SubDivision, Sucursal
from marcas.models import Marca
from marcas.serializers import MarcaSerializer
from movimientos.models import DetalleMovimiento
from usuarios.models import RolPermiso
from usuarios.sucursal_scope import apply_sucursal_scope

from .models import OEM, OEMProducto, Producto, ProductoAlterno, ProductoCalificacion

NEGATIVE_STARS_THRESHOLD = 2
INACTIVITY_PENALTY_STEP = 0.5
INACTIVITY_PENALTY_INTERVAL_MONTHS = 2
RETURN_PENALTY_STEP = 1.0
SALES_BONUS_STEP = 0.5


def _full_months_between(start_date, end_date):
    if start_date is None or end_date is None:
        return 0

    if start_date > end_date:
        return 0

    months = (end_date.year - start_date.year) * 12 + (end_date.month - start_date.month)
    if end_date.day < start_date.day:
        months -= 1
    return max(months, 0)


def _normalize_rating(value):
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return round(max(0.0, min(5.0, numeric)), 1)


def _table_exists(table_name):
    try:
        return table_name in connection.introspection.table_names()
    except Exception:
        return False


def build_producto_rating_summary(producto):
    comment_stats = {"average": None, "total": 0, "negatives": 0}
    if _table_exists(ProductoCalificacion._meta.db_table):
        try:
            comment_stats = producto.calificaciones.aggregate(
                average=Avg("estrellas"),
                total=Count("id"),
                negatives=Count("id", filter=Q(estrellas__lte=NEGATIVE_STARS_THRESHOLD)),
            )
        except (ProgrammingError, OperationalError):
            # Keep product detail available even if rating schema is not ready.
            comment_stats = {"average": None, "total": 0, "negatives": 0}
    comment_count = int(comment_stats.get("total") or 0)
    negative_count = int(comment_stats.get("negatives") or 0)
    comment_average = _normalize_rating(comment_stats.get("average"))

    sales_stats = DetalleMovimiento.objects.filter(
        producto_id=producto.id,
        movimiento_inventario__tipo_movimiento__nombre__istartswith="sal",
        movimiento_inventario__sub_tipo_movimiento__nombre__icontains="vent",
        movimiento_inventario__estado_movimiento__nombre__iexact="vendido",
    ).aggregate(
        sales_count=Count("movimiento_inventario_id", distinct=True),
        sold_quantity=Sum("cantidad"),
        last_sale_date=Max("movimiento_inventario__fecha"),
    )
    sales_count = int(sales_stats.get("sales_count") or 0)
    sold_quantity = int(sales_stats.get("sold_quantity") or 0)
    last_sale_date = sales_stats.get("last_sale_date")

    returns_stats = DetalleMovimiento.objects.filter(
        producto_id=producto.id,
        movimiento_inventario__tipo_movimiento__nombre__istartswith="ent",
        movimiento_inventario__sub_tipo_movimiento__nombre__icontains="devol",
        movimiento_inventario__estado_movimiento__nombre__iexact="recibido",
    ).aggregate(
        returns_count=Count("movimiento_inventario_id", distinct=True),
        returned_quantity=Sum("cantidad"),
        last_return_date=Max("movimiento_inventario__fecha"),
    )
    returns_count = int(returns_stats.get("returns_count") or 0)
    returned_quantity = int(returns_stats.get("returned_quantity") or 0)
    last_return_date = returns_stats.get("last_return_date")

    today = timezone.localdate()
    reference_date = last_sale_date or (producto.creado_en.date() if producto.creado_en else today)
    months_without_sales = _full_months_between(reference_date, today)

    if comment_count > 0 and comment_average is not None:
        base_rating = float(comment_average)
    else:
        base_rating = 5.0

    negative_ratio = 0.0
    if comment_count > 0 and negative_count > 0:
        negative_ratio = negative_count / comment_count

    inactivity_penalty = 0.0
    if months_without_sales >= INACTIVITY_PENALTY_INTERVAL_MONTHS:
        steps = months_without_sales // INACTIVITY_PENALTY_INTERVAL_MONTHS
        inactivity_penalty = float(steps) * INACTIVITY_PENALTY_STEP

    return_penalty = float(returns_count) * RETURN_PENALTY_STEP
    sales_bonus = float(sales_count) * SALES_BONUS_STEP

    rating = _normalize_rating(base_rating + sales_bonus - inactivity_penalty - return_penalty)
    if rating is None:
        rating = 0.0

    return {
        "rating": rating,
        "base_rating": _normalize_rating(base_rating) or 0.0,
        "comment_average": comment_average,
        "comment_count": comment_count,
        "negative_comments": negative_count,
        "negative_ratio": round(negative_ratio, 3),
        "negative_penalty": 0.0,
        "sales_count": sales_count,
        "sales_bonus": round(sales_bonus, 2),
        "sold_quantity": sold_quantity,
        "last_sale_date": last_sale_date.isoformat() if isinstance(last_sale_date, date) else None,
        "returns_count": returns_count,
        "returned_quantity": returned_quantity,
        "last_return_date": last_return_date.isoformat() if isinstance(last_return_date, date) else None,
        "return_penalty": round(return_penalty, 2),
        "months_without_sales": months_without_sales,
        "inactivity_penalty": round(inactivity_penalty, 2),
        "computed_at": timezone.now().isoformat(),
    }


class OEMSerializer(serializers.ModelSerializer):
    class Meta:
        model = OEM
        fields = ["id", "codigo", "descripcion"]


class OEMProductoSerializer(serializers.ModelSerializer):
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
        write_only=True,
    )
    producto = serializers.StringRelatedField(read_only=True)
    oem = OEMSerializer(read_only=True)
    oem_id = serializers.PrimaryKeyRelatedField(
        source="oem",
        queryset=OEM.objects.all(),
        write_only=True,
    )

    class Meta:
        model = OEMProducto
        fields = ["id", "producto", "producto_id", "oem", "oem_id"]


class ProductoAlternoSerializer(serializers.ModelSerializer):
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
        write_only=True,
    )
    alterno_id = serializers.PrimaryKeyRelatedField(
        source="alterno",
        queryset=Producto.objects.all(),
        write_only=True,
    )
    producto = serializers.StringRelatedField(read_only=True)
    alterno = serializers.StringRelatedField(read_only=True)

    class Meta:
        model = ProductoAlterno
        fields = ["id", "producto", "producto_id", "alterno", "alterno_id", "notas"]


class ProductoSerializer(serializers.ModelSerializer):
    casas_comerciales = CasaComercialSerializer(many=True, read_only=True)
    casas_comerciales_ids = serializers.PrimaryKeyRelatedField(
        source="casas_comerciales",
        queryset=CasaComercial.objects.all(),
        many=True,
        required=True,
        allow_empty=False,
        write_only=True,
    )
    marca = MarcaSerializer(read_only=True)
    marca_id = serializers.PrimaryKeyRelatedField(
        source="marca",
        queryset=Marca.objects.all(),
        write_only=True,
    )
    oem_productos = OEMProductoSerializer(many=True, read_only=True)
    alternativas = serializers.SerializerMethodField()

    class Meta:
        model = Producto
        fields = [
            "id",
            "codigo",
            "nombre",
            "descripcion",
            "pieza_original",
            "costo_minimo",
            "precio",
            "casas_comerciales",
            "casas_comerciales_ids",
            "marca",
            "marca_id",
            "oem_productos",
            "alternativas",
            "creado_en",
            "actualizado_en",
        ]
        extra_kwargs = {
            "codigo": {
                "required": True,
                "allow_blank": False,
                "error_messages": {
                    "blank": "El codigo del producto es obligatorio.",
                    "required": "El codigo del producto es obligatorio.",
                    "unique": "Este codigo ya existe.",
                },
            },
            "descripcion": {
                "required": True,
                "allow_blank": False,
                "error_messages": {
                    "blank": "La descripcion del producto es obligatoria.",
                    "required": "La descripcion del producto es obligatoria.",
                },
            },
            "precio": {
                "required": True,
                "allow_null": False,
                "error_messages": {
                    "null": "El precio del producto es obligatorio.",
                    "required": "El precio del producto es obligatorio.",
                    "invalid": "Ingresa un precio valido.",
                },
            },
        }

    def get_alternativas(self, obj):
        alternativas = []
        for relacion in obj.alternativas.select_related("alterno").all():
            alterno = relacion.alterno
            alternativas.append(
                {
                    "id": alterno.id,
                    "codigo": alterno.codigo,
                    "nombre": alterno.nombre,
                    "notas": relacion.notas,
                }
            )
        return alternativas

    def validate(self, attrs):
        errors = {}

        descripcion = attrs.get("descripcion", serializers.empty)
        if descripcion is serializers.empty and self.instance is not None:
            descripcion = self.instance.descripcion
        if not str(descripcion or "").strip():
            errors["descripcion"] = ["La descripcion del producto es obligatoria."]

        precio = attrs.get("precio", serializers.empty)
        if precio is serializers.empty and self.instance is not None:
            precio = self.instance.precio
        if precio in (serializers.empty, None):
            errors["precio"] = ["El precio del producto es obligatorio."]

        casas_comerciales = attrs.get("casas_comerciales", serializers.empty)
        if casas_comerciales is serializers.empty and self.instance is not None:
            casas_comerciales = list(self.instance.casas_comerciales.all())
        if not casas_comerciales:
            errors["casas_comerciales_ids"] = ["Debe seleccionar al menos una casa comercial."]

        if errors:
            raise serializers.ValidationError(errors)

        return attrs


class ProductoCalificacionSerializer(serializers.ModelSerializer):
    usuario_id = serializers.IntegerField(source="usuario.id", read_only=True)
    usuario_nombre = serializers.SerializerMethodField(read_only=True)
    producto_id = serializers.IntegerField(source="producto.id", read_only=True)

    class Meta:
        model = ProductoCalificacion
        fields = [
            "id",
            "producto_id",
            "usuario_id",
            "usuario_nombre",
            "estrellas",
            "comentario",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "producto_id",
            "usuario_id",
            "usuario_nombre",
            "created_at",
            "updated_at",
        ]

    def get_usuario_nombre(self, obj):
        user = getattr(obj, "usuario", None)
        if user is None:
            return "Usuario"

        full_name = str(getattr(user, "get_full_name", lambda: "")() or "").strip()
        if full_name:
            return full_name
        first_name = str(getattr(user, "first_name", "") or "").strip()
        if first_name:
            return first_name
        email = str(getattr(user, "email", "") or "").strip()
        if email:
            return email
        return "Usuario"

    def validate_estrellas(self, value):
        try:
            estrellas = int(value)
        except (TypeError, ValueError):
            raise serializers.ValidationError("La calificacion debe ser un numero entre 1 y 5.")
        if estrellas < 1 or estrellas > 5:
            raise serializers.ValidationError("La calificacion debe estar entre 1 y 5 estrellas.")
        return estrellas

    def validate_comentario(self, value):
        text = str(value or "").strip()
        if len(text) > 1200:
            raise serializers.ValidationError("El comentario no puede superar 1200 caracteres.")
        return text

    def create(self, validated_data):
        request = self.context.get("request")
        producto = self.context.get("producto")
        if producto is None:
            raise serializers.ValidationError({"producto": "No se encontro el producto objetivo."})
        user = request.user if request and request.user and request.user.is_authenticated else None
        return ProductoCalificacion.objects.create(
            producto=producto,
            usuario=user,
            **validated_data,
        )


class ProductoDetailSerializer(ProductoSerializer):
    inventario_context = serializers.SerializerMethodField()
    calificacion_resumen = serializers.SerializerMethodField()

    class Meta(ProductoSerializer.Meta):
        fields = ProductoSerializer.Meta.fields + ["inventario_context", "calificacion_resumen"]

    def _serialize_sucursal(self, sucursal):
        if sucursal is None:
            return None
        return {
            "id": sucursal.id,
            "nombre": sucursal.nombre,
        }

    def _serialize_bodega(self, bodega, sucursal_payload=None):
        if bodega is None:
            return None
        return {
            "id": bodega.id,
            "nombre": bodega.nombre,
            "sucursal_id": bodega.sucursal_id,
            "sucursal": sucursal_payload or self._serialize_sucursal(getattr(bodega, "sucursal", None)),
            "ancho_metros": getattr(bodega, "ancho_metros", 0),
            "alto_metros": getattr(bodega, "alto_metros", 0),
            "ubicaciones": getattr(bodega, "ubicaciones", []) or [],
        }

    def _serialize_division(self, division, bodega_payload=None):
        if division is None:
            return None
        return {
            "id": division.id,
            "nombre": division.nombre,
            "bodega_id": getattr(division, "bodega_id", None),
            "bodega": bodega_payload,
        }

    def _serialize_subdivision(self, subdivision, division_payload=None):
        if subdivision is None:
            return None
        return {
            "id": subdivision.id,
            "nombre": subdivision.nombre,
            "division": division_payload,
        }

    def _serialize_inventario_entry(self, entry, subdivision_payload=None):
        return {
            "id": entry.id,
            "producto_id": entry.producto_id,
            "subdivision_id": entry.subdivision_id,
            "subdivisionId": entry.subdivision_id,
            "referencia": entry.referencia or "",
            "cantidad": entry.cantidad,
            "subdivision": subdivision_payload,
        }

    def get_inventario_context(self, obj):
        request = self.context.get("request")
        include_inventory_context = str(
            (request.query_params.get("include_inventory_context") if request else "1")
            or "1"
        ).strip().lower() not in {"0", "false", "no"}
        if not include_inventory_context:
            return None

        if not request or not request.user or not request.user.is_authenticated:
            return {
                "branches": [],
                "bodegas": [],
                "subdivisions": [],
                "inventario_entries": [],
            }

        branches_qs = apply_sucursal_scope(
            Sucursal.objects.only("id", "nombre").order_by("id"),
            request.user,
            RolPermiso.Modulos.PRODUCTOS,
            "id",
        )
        bodegas_qs = apply_sucursal_scope(
            Bodega.objects.select_related("sucursal")
            .only(
                "id",
                "nombre",
                "sucursal_id",
                "ancho_metros",
                "alto_metros",
                "ubicaciones",
                "sucursal__id",
                "sucursal__nombre",
            )
            .order_by("id"),
            request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            "sucursal_id",
        )
        subdivisions_qs = apply_sucursal_scope(
            SubDivision.objects.select_related(
                "division",
                "division__bodega",
                "division__bodega__sucursal",
            )
            .only(
                "id",
                "nombre",
                "division_id",
                "division__id",
                "division__nombre",
                "division__bodega_id",
                "division__bodega__id",
                "division__bodega__nombre",
                "division__bodega__sucursal_id",
                "division__bodega__sucursal__id",
                "division__bodega__sucursal__nombre",
            )
            .order_by("id"),
            request.user,
            RolPermiso.Modulos.SUCURSALES_BODEGAS,
            "division__bodega__sucursal_id",
        )
        inventory_entries_qs = apply_sucursal_scope(
            obj.inventarios.select_related(
                "subdivision",
                "subdivision__division",
                "subdivision__division__bodega",
                "subdivision__division__bodega__sucursal",
            )
            .only(
                "id",
                "producto_id",
                "subdivision_id",
                "referencia",
                "cantidad",
                "subdivision__id",
                "subdivision__nombre",
                "subdivision__division_id",
                "subdivision__division__id",
                "subdivision__division__nombre",
                "subdivision__division__bodega_id",
                "subdivision__division__bodega__id",
                "subdivision__division__bodega__nombre",
                "subdivision__division__bodega__sucursal_id",
                "subdivision__division__bodega__sucursal__id",
                "subdivision__division__bodega__sucursal__nombre",
            )
            .order_by("id"),
            request.user,
            RolPermiso.Modulos.INVENTARIO,
            "subdivision__division__bodega__sucursal_id",
        )

        branch_payload_by_id = {}
        bodega_payload_by_id = {}
        subdivision_payload_by_id = {}

        def ensure_branch_payload(sucursal):
            if sucursal is None:
                return None
            key = int(sucursal.id)
            if key not in branch_payload_by_id:
                branch_payload_by_id[key] = self._serialize_sucursal(sucursal)
            return branch_payload_by_id[key]

        def ensure_bodega_payload(bodega):
            if bodega is None:
                return None
            key = int(bodega.id)
            if key not in bodega_payload_by_id:
                sucursal_payload = ensure_branch_payload(getattr(bodega, "sucursal", None))
                bodega_payload_by_id[key] = self._serialize_bodega(bodega, sucursal_payload)
            return bodega_payload_by_id[key]

        def ensure_subdivision_payload(subdivision):
            if subdivision is None:
                return None
            key = int(subdivision.id)
            if key in subdivision_payload_by_id:
                return subdivision_payload_by_id[key]

            division = getattr(subdivision, "division", None)
            bodega = getattr(division, "bodega", None)
            bodega_payload = ensure_bodega_payload(bodega)
            division_payload = self._serialize_division(division, bodega_payload)
            subdivision_payload_by_id[key] = self._serialize_subdivision(subdivision, division_payload)
            return subdivision_payload_by_id[key]

        for branch in branches_qs:
            ensure_branch_payload(branch)

        for bodega in bodegas_qs:
            ensure_bodega_payload(bodega)

        for subdivision in subdivisions_qs:
            ensure_subdivision_payload(subdivision)

        inventory_entries = []
        for entry in inventory_entries_qs:
            subdivision_payload = ensure_subdivision_payload(getattr(entry, "subdivision", None))
            inventory_entries.append(
                self._serialize_inventario_entry(entry, subdivision_payload=subdivision_payload)
            )

        branches = sorted(
            branch_payload_by_id.values(),
            key=lambda item: (item.get("nombre") or "", item.get("id") or 0),
        )
        bodegas = sorted(
            bodega_payload_by_id.values(),
            key=lambda item: (
                item.get("sucursal", {}).get("nombre") or "",
                item.get("nombre") or "",
                item.get("id") or 0,
            ),
        )
        subdivisions = sorted(
            subdivision_payload_by_id.values(),
            key=lambda item: (
                item.get("division", {}).get("bodega", {}).get("nombre") or "",
                item.get("division", {}).get("nombre") or "",
                item.get("nombre") or "",
                item.get("id") or 0,
            ),
        )

        return {
            "branches": branches,
            "bodegas": bodegas,
            "subdivisions": subdivisions,
            "inventario_entries": inventory_entries,
        }

    def get_calificacion_resumen(self, obj):
        return build_producto_rating_summary(obj)
