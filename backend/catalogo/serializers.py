from rest_framework import serializers

from catalogo.models import Categoria, Marca, Producto, TipoCompra, TipoPago


class MarcaSerializer(serializers.ModelSerializer):
    class Meta:
        model = Marca
        fields = ["id", "nombre", "descripcion", "activo"]


class CategoriaSerializer(serializers.ModelSerializer):
    class Meta:
        model = Categoria
        fields = ["id", "nombre", "descripcion", "activo"]


class TipoCompraSerializer(serializers.ModelSerializer):
    class Meta:
        model = TipoCompra
        fields = ["id", "nombre", "descripcion"]


class TipoPagoSerializer(serializers.ModelSerializer):
    class Meta:
        model = TipoPago
        fields = ["id", "nombre", "descripcion"]


class ProductoSerializer(serializers.ModelSerializer):
    categoria = CategoriaSerializer(read_only=True)
    marca = MarcaSerializer(read_only=True)
    categoria_id = serializers.PrimaryKeyRelatedField(
        source="categoria",
        queryset=Categoria.objects.all(),
        write_only=True,
    )
    marca_id = serializers.PrimaryKeyRelatedField(
        source="marca",
        queryset=Marca.objects.all(),
        write_only=True,
    )

    class Meta:
        model = Producto
        fields = [
            "id",
            "sku",
            "nombre",
            "descripcion",
            "categoria",
            "categoria_id",
            "marca",
            "marca_id",
            "precio_compra",
            "precio_venta",
            "activo",
            "creado_en",
            "actualizado_en",
        ]
