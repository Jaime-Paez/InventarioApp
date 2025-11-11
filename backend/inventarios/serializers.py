from rest_framework import serializers

from productos.models import Producto
from ubicaciones.models import SubDivision

from .models import EstadoProducto, Inventario


class EstadoProductoSerializer(serializers.ModelSerializer):
    """Serializa los estados en los que puede estar un producto."""

    class Meta:
        model = EstadoProducto
        fields = ["id", "nombre", "descripcion"]


class InventarioSerializer(serializers.ModelSerializer):
    """Serializa los lotes de inventario disponibles."""

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
    estado_producto_id = serializers.PrimaryKeyRelatedField(
        source="estado_producto",
        queryset=EstadoProducto.objects.all(),
        write_only=True,
    )
    subdivision = serializers.StringRelatedField(read_only=True)
    producto = serializers.StringRelatedField(read_only=True)
    estado_producto = EstadoProductoSerializer(read_only=True)
    disponible = serializers.IntegerField(read_only=True)

    class Meta:
        model = Inventario
        fields = [
            "id",
            "subdivision",
            "subdivision_id",
            "producto",
            "producto_id",
            "estado_producto",
            "estado_producto_id",
            "referencia",
            "cantidad",
            "cantidad_reservada",
            "disponible",
            "actualizado_en",
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["subdivision_id"].queryset = SubDivision.objects.all()
        self.fields["producto_id"].queryset = Producto.objects.all()
