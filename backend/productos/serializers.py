from rest_framework import serializers

from casa_comercial.models import CasaComercial
from casa_comercial.serializers import CasaComercialSerializer
from inventario.models import Bodega, SubDivision, Sucursal
from marcas.models import Marca
from marcas.serializers import MarcaSerializer
from usuarios.models import RolPermiso
from usuarios.sucursal_scope import apply_sucursal_scope

from .models import OEM, OEMProducto, Producto, ProductoAlterno


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


class ProductoDetailSerializer(ProductoSerializer):
    inventario_context = serializers.SerializerMethodField()

    class Meta(ProductoSerializer.Meta):
        fields = ProductoSerializer.Meta.fields + ["inventario_context"]

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
