from rest_framework import serializers

from casa_comercial.models import CasaComercial
from casa_comercial.serializers import CasaComercialSerializer
from marcas.models import Marca
from marcas.serializers import MarcaSerializer

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
    casa_comercial = CasaComercialSerializer(read_only=True)
    casa_comercial_id = serializers.PrimaryKeyRelatedField(
        source="casa_comercial",
        queryset=CasaComercial.objects.all(),
        allow_null=True,
        required=False,
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
            "referencia_fabricante",
            "casa_comercial",
            "casa_comercial_id",
            "marca",
            "marca_id",
            "oem_productos",
            "alternativas",
            "creado_en",
            "actualizado_en",
        ]

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
