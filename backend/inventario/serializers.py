from rest_framework import serializers

from productos.models import Producto

from .models import Bodega, Division, Inventario, SubDivision, Sucursal
from tipos.models import TipoDivision


class SucursalSerializer(serializers.ModelSerializer):
    class Meta:
        model = Sucursal
        fields = ["id", "nombre", "direccion", "latitud", "longitud", "puede_compra_local"]


class BodegaSerializer(serializers.ModelSerializer):
    sucursal_id = serializers.PrimaryKeyRelatedField(
        source="sucursal",
        queryset=Sucursal.objects.all(),
        write_only=True,
    )
    sucursal = SucursalSerializer(read_only=True)

    class Meta:
        model = Bodega
        fields = [
            "id",
            "nombre",
            "sucursal",
            "sucursal_id",
            "ancho_metros",
            "alto_metros",
            "ubicaciones",
        ]


class DivisionSerializer(serializers.ModelSerializer):
    tipo_division_id = serializers.PrimaryKeyRelatedField(
        source="tipo_division",
        queryset=TipoDivision.objects.all(),
        write_only=True,
    )
    bodega_id = serializers.PrimaryKeyRelatedField(
        source="bodega",
        queryset=Bodega.objects.all(),
        write_only=True,
    )
    tipo_division = serializers.StringRelatedField(read_only=True)
    bodega = BodegaSerializer(read_only=True)

    class Meta:
        model = Division
        fields = [
            "id",
            "nombre",
            "tipo_division",
            "tipo_division_id",
            "bodega",
            "bodega_id",
        ]


class SubDivisionSerializer(serializers.ModelSerializer):
    division_id = serializers.PrimaryKeyRelatedField(
        source="division",
        queryset=Division.objects.all(),
        write_only=True,
    )
    division = DivisionSerializer(read_only=True)

    class Meta:
        model = SubDivision
        fields = ["id", "nombre", "division", "division_id"]


class InventarioSerializer(serializers.ModelSerializer):
    subdivision_id = serializers.PrimaryKeyRelatedField(
        source="subdivision",
        queryset=SubDivision.objects.all(),
    )
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
    )
    subdivision = SubDivisionSerializer(read_only=True)
    producto = serializers.StringRelatedField(read_only=True)
    producto_data = serializers.SerializerMethodField()
    ubicacion = serializers.SerializerMethodField()

    class Meta:
        model = Inventario
        fields = [
            "id",
            "subdivision",
            "subdivision_id",
            "producto",
            "producto_id",
            "referencia",
            "cantidad",
            "producto_data",
            "ubicacion",
        ]

    def get_producto_data(self, obj):
        producto = getattr(obj, "producto", None)
        if producto is None:
            return None
        casas = list(getattr(producto, "casas_comerciales", []).all())
        oems = list(getattr(producto, "oem_productos", []).all())
        oem_codes = []
        for rel in oems:
            codigo = getattr(getattr(rel, "oem", None), "codigo", None)
            if codigo:
                oem_codes.append(codigo)
        return {
            "id": producto.id,
            "codigo": producto.codigo,
            "nombre": producto.nombre,
            "descripcion": producto.descripcion,
            "costo_minimo": producto.costo_minimo,
            "precio": producto.precio,
            "creado_en": producto.creado_en,
            "marca_nombre": getattr(getattr(producto, "marca", None), "nombre", "") or "",
            "casa_comercial_nombre": (casas[0].nombre if casas else "") or "",
            "casas_comerciales_nombres": ", ".join(
                [casa.nombre for casa in casas if getattr(casa, "nombre", None)]
            ),
            "oem_codes": ", ".join(oem_codes),
        }

    def get_ubicacion(self, obj):
        subdivision = getattr(obj, "subdivision", None)
        division = getattr(subdivision, "division", None)
        bodega = getattr(division, "bodega", None)
        sucursal = getattr(bodega, "sucursal", None)
        parts = [
            getattr(sucursal, "nombre", ""),
            getattr(bodega, "nombre", ""),
            getattr(division, "nombre", ""),
            getattr(subdivision, "nombre", ""),
        ]
        clean_parts = [part for part in parts if part]
        if not clean_parts:
            return ""
        base = " / ".join(clean_parts)
        referencia = (getattr(obj, "referencia", "") or "").strip()
        if not referencia:
            return base
        return f"{base} ({referencia})"
