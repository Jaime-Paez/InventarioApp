from rest_framework import serializers

from inventario.models import Inventario


class InventarioSerializer(serializers.ModelSerializer):
    sucursal_nombre = serializers.CharField(source="sucursal.nombre", read_only=True)
    producto_nombre = serializers.CharField(source="producto.nombre", read_only=True)
    producto_sku = serializers.CharField(source="producto.sku", read_only=True)

    class Meta:
        model = Inventario
        fields = [
            "id",
            "sucursal",
            "sucursal_nombre",
            "producto",
            "producto_sku",
            "producto_nombre",
            "cantidad",
            "punto_reorden",
            "actualizado_en",
        ]
