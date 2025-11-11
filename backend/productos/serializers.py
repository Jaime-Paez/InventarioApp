from rest_framework import serializers

from .models import (
    CasaCompra,
    CasaProducto,
    Pais,
    Producto,
    ProductoAlterno,
    ProductoOEM,
    ProductoReferencia,
)


class PaisSerializer(serializers.ModelSerializer):
    """Serializa los países del catálogo."""

    class Meta:
        model = Pais
        fields = ["id", "codigo_tais", "nombre"]


class CasaProductoSerializer(serializers.ModelSerializer):
    """Serializa las casas de producto (fabricantes)."""

    pais = PaisSerializer(read_only=True)
    pais_id = serializers.PrimaryKeyRelatedField(
        source="pais",
        queryset=Pais.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )

    class Meta:
        model = CasaProducto
        fields = ["id", "codigo", "nombre", "descripcion", "pais", "pais_id"]


class CasaCompraSerializer(serializers.ModelSerializer):
    """Serializa las casas comerciales donde se compran los productos."""

    pais = PaisSerializer(read_only=True)
    pais_id = serializers.PrimaryKeyRelatedField(
        source="pais",
        queryset=Pais.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )

    class Meta:
        model = CasaCompra
        fields = [
            "id",
            "codigo",
            "nombre",
            "descripcion",
            "telefono",
            "correo",
            "pais",
            "pais_id",
        ]


class ProductoReferenciaSerializer(serializers.ModelSerializer):
    """Serializa códigos alternos del producto."""

    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
        write_only=True,
    )
    producto = serializers.StringRelatedField(read_only=True)

    class Meta:
        model = ProductoReferencia
        fields = ["id", "codigo", "descripcion", "producto", "producto_id"]


class ProductoOEMSerializer(serializers.ModelSerializer):
    """Serializa códigos OEM asociados al producto."""

    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
        write_only=True,
    )
    producto = serializers.StringRelatedField(read_only=True)

    class Meta:
        model = ProductoOEM
        fields = ["id", "codigo", "descripcion", "producto", "producto_id"]


class ProductoAlternoSerializer(serializers.ModelSerializer):
    """Serializa relaciones de compatibilidad entre productos."""

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
    """Serializa productos, incluyendo información de fabricante y proveedor."""

    casa_producto = CasaProductoSerializer(read_only=True)
    casa_producto_id = serializers.PrimaryKeyRelatedField(
        source="casa_producto",
        queryset=CasaProducto.objects.all(),
        write_only=True,
    )
    casa_compra = CasaCompraSerializer(read_only=True)
    casa_compra_id = serializers.PrimaryKeyRelatedField(
        source="casa_compra",
        queryset=CasaCompra.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )
    referencias = ProductoReferenciaSerializer(many=True, read_only=True)
    codigos_oem = ProductoOEMSerializer(many=True, read_only=True)
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
            "casa_producto",
            "casa_producto_id",
            "casa_compra",
            "casa_compra_id",
            "referencias",
            "codigos_oem",
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
