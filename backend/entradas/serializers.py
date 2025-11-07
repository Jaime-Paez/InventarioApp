from rest_framework import serializers

from entradas.models import Entrada, EntradaDetalle


class EntradaDetalleSerializer(serializers.ModelSerializer):
    producto_nombre = serializers.CharField(source="producto.nombre", read_only=True)
    producto_sku = serializers.CharField(source="producto.sku", read_only=True)

    class Meta:
        model = EntradaDetalle
        fields = [
            "id",
            "producto",
            "producto_sku",
            "producto_nombre",
            "cantidad",
            "costo_unitario",
        ]


class EntradaSerializer(serializers.ModelSerializer):
    detalles = EntradaDetalleSerializer(many=True, read_only=True)
    sucursal_nombre = serializers.CharField(source="sucursal.nombre", read_only=True)
    responsable_nombre = serializers.CharField(source="responsable.nombre", read_only=True)

    class Meta:
        model = Entrada
        fields = [
            "id",
            "folio",
            "sucursal",
            "sucursal_nombre",
            "responsable",
            "responsable_nombre",
            "tipo",
            "tipo_compra",
            "tipo_pago",
            "fecha",
            "observaciones",
            "detalles",
        ]
