from rest_framework import serializers

from productos.models import Producto

from .models import Bodega, Division, Inventario, SubDivision, Sucursal
from tipos.models import TipoDivision


class SucursalSerializer(serializers.ModelSerializer):
    class Meta:
        model = Sucursal
        fields = ["id", "nombre", "direccion", "latitud", "longitud"]


class BodegaSerializer(serializers.ModelSerializer):
    sucursal_id = serializers.PrimaryKeyRelatedField(
        source="sucursal",
        queryset=Sucursal.objects.all(),
        write_only=True,
    )
    sucursal = SucursalSerializer(read_only=True)

    class Meta:
        model = Bodega
        fields = ["id", "nombre", "sucursal", "sucursal_id"]


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
        write_only=True,
    )
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
        write_only=True,
    )
    subdivision = SubDivisionSerializer(read_only=True)
    producto = serializers.StringRelatedField(read_only=True)

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
        ]
