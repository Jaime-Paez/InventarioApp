from rest_framework import serializers

from salidas.models import Salida, SalidaDetalle


class SalidaDetalleSerializer(serializers.ModelSerializer):
    producto_nombre = serializers.CharField(source="producto.nombre", read_only=True)
    producto_sku = serializers.CharField(source="producto.sku", read_only=True)

    class Meta:
        model = SalidaDetalle
        fields = [
            "id",
            "producto",
            "producto_sku",
            "producto_nombre",
            "cantidad",
            "precio_unitario",
        ]


class SalidaSerializer(serializers.ModelSerializer):
    detalles = SalidaDetalleSerializer(many=True, read_only=True)
    sucursal_origen_nombre = serializers.CharField(source="sucursal_origen.nombre", read_only=True)
    sucursal_destino_nombre = serializers.CharField(source="sucursal_destino.nombre", read_only=True)
    responsable_nombre = serializers.CharField(source="responsable.nombre", read_only=True)

    class Meta:
        model = Salida
        fields = [
            "id",
            "folio",
            "sucursal_origen",
            "sucursal_origen_nombre",
            "sucursal_destino",
            "sucursal_destino_nombre",
            "responsable",
            "responsable_nombre",
            "tipo",
            "fecha",
            "observaciones",
            "detalles",
        ]
