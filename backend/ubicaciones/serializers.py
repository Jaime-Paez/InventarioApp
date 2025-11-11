from rest_framework import serializers

from .models import Bodega, Division, Sucursal, SubDivision, TipoDivision


class SucursalSerializer(serializers.ModelSerializer):
    """Serializa sucursales y permite registrar datos básicos de ubicación."""

    class Meta:
        model = Sucursal
        fields = [
            "id",
            "codigo",
            "nombre",
            "direccion",
            "ciudad",
            "telefono",
            "notas",
        ]


class BodegaSerializer(serializers.ModelSerializer):
    """Serializa bodegas ligadas a una sucursal específica."""

    sucursal_id = serializers.PrimaryKeyRelatedField(
        source="sucursal",
        queryset=Sucursal.objects.all(),
        write_only=True,
    )
    sucursal = SucursalSerializer(read_only=True)

    class Meta:
        model = Bodega
        fields = ["id", "nombre", "descripcion", "sucursal", "sucursal_id"]


class TipoDivisionSerializer(serializers.ModelSerializer):
    """Serializa catálogos de tipos de división (estantería, repisa, etc.)."""

    class Meta:
        model = TipoDivision
        fields = ["id", "nombre", "descripcion"]


class DivisionSerializer(serializers.ModelSerializer):
    """Serializa divisiones dentro de una bodega."""

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
    tipo_division = TipoDivisionSerializer(read_only=True)
    bodega = BodegaSerializer(read_only=True)

    class Meta:
        model = Division
        fields = [
            "id",
            "nombre",
            "descripcion",
            "tipo_division",
            "tipo_division_id",
            "bodega",
            "bodega_id",
        ]


class SubDivisionSerializer(serializers.ModelSerializer):
    """Serializa subdivisiones como niveles, repisas o cajones."""

    division_id = serializers.PrimaryKeyRelatedField(
        source="division",
        queryset=Division.objects.all(),
        write_only=True,
    )
    division = DivisionSerializer(read_only=True)

    class Meta:
        model = SubDivision
        fields = ["id", "nombre", "descripcion", "division", "division_id"]
