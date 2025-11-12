from rest_framework import serializers

from inventario.models import Sucursal
from productos.models import OEM, Producto

from .models import Cliente, OEMProductoSolicitado, ProductoSolicitado, Solicitud


class ClienteSerializer(serializers.ModelSerializer):
    class Meta:
        model = Cliente
        fields = ["id", "nombre", "correo", "telefono", "direccion", "cedula_ruc"]


class ProductoSolicitadoSerializer(serializers.ModelSerializer):
    producto = serializers.StringRelatedField(read_only=True)
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )

    class Meta:
        model = ProductoSolicitado
        fields = [
            "id",
            "nombre",
            "descripcion",
            "conseguido",
            "producto",
            "producto_id",
        ]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        data["producto_id"] = instance.producto_id
        return data


class OEMProductoSolicitadoSerializer(serializers.ModelSerializer):
    producto_solicitado = serializers.StringRelatedField(read_only=True)
    producto_solicitado_id = serializers.PrimaryKeyRelatedField(
        source="producto_solicitado",
        queryset=ProductoSolicitado.objects.all(),
        write_only=True,
    )
    oem = serializers.StringRelatedField(read_only=True)
    oem_id = serializers.PrimaryKeyRelatedField(
        source="oem",
        queryset=OEM.objects.all(),
        write_only=True,
    )

    class Meta:
        model = OEMProductoSolicitado
        fields = ["id", "producto_solicitado", "producto_solicitado_id", "oem", "oem_id"]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        data["producto_solicitado_id"] = instance.producto_solicitado_id
        data["oem_id"] = instance.oem_id
        return data


class SolicitudSerializer(serializers.ModelSerializer):
    cliente = serializers.StringRelatedField(read_only=True)
    cliente_id = serializers.PrimaryKeyRelatedField(
        source="cliente",
        queryset=Cliente.objects.all(),
        write_only=True,
    )
    sucursal = serializers.StringRelatedField(read_only=True)
    sucursal_id = serializers.PrimaryKeyRelatedField(
        source="sucursal",
        queryset=Sucursal.objects.all(),
        write_only=True,
    )
    producto = serializers.StringRelatedField(read_only=True)
    producto_solicitado = serializers.StringRelatedField(read_only=True)
    producto_id = serializers.IntegerField(write_only=True, required=False, allow_null=True)

    class Meta:
        model = Solicitud
        fields = [
            "id",
            "cantidad",
            "tabla",
            "producto",
            "producto_solicitado",
            "producto_id",
            "fecha",
            "sucursal",
            "sucursal_id",
            "cliente",
            "cliente_id",
        ]

    def validate(self, attrs):
        tabla = attrs.get("tabla")
        if tabla is None and self.instance is not None:
            tabla = self.instance.tabla
            attrs["tabla"] = tabla

        producto_id = attrs.pop("producto_id", None)

        if tabla is None:
            raise serializers.ValidationError({"tabla": "Este campo es obligatorio."})

        if producto_id is None:
            if self.instance is None:
                raise serializers.ValidationError({"producto_id": "Este campo es obligatorio."})
            if tabla != self.instance.tabla:
                raise serializers.ValidationError(
                    {
                        "producto_id": "Debe indicar el identificador del nuevo recurso al cambiar la tabla.",
                    }
                )
            attrs["producto"] = self.instance.producto
            attrs["producto_solicitado"] = self.instance.producto_solicitado
            return attrs

        if tabla == Solicitud.Tabla.PRODUCTO:
            try:
                producto = Producto.objects.get(pk=producto_id)
            except Producto.DoesNotExist as exc:  # pragma: no cover - validación
                raise serializers.ValidationError(
                    {"producto_id": "Producto no encontrado."}
                ) from exc
            attrs["producto"] = producto
            attrs["producto_solicitado"] = None
        elif tabla == Solicitud.Tabla.PRODUCTO_SOLICITADO:
            try:
                producto_solicitado = ProductoSolicitado.objects.get(pk=producto_id)
            except ProductoSolicitado.DoesNotExist as exc:  # pragma: no cover - validación
                raise serializers.ValidationError(
                    {"producto_id": "Producto solicitado no encontrado."}
                ) from exc
            attrs["producto"] = None
            attrs["producto_solicitado"] = producto_solicitado
        else:  # pragma: no cover - se valida también en el modelo
            raise serializers.ValidationError({"tabla": "Selección de tabla inválida."})

        return attrs

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if instance.tabla == Solicitud.Tabla.PRODUCTO:
            data["producto_id"] = instance.producto_id
        else:
            data["producto_id"] = instance.producto_solicitado_id
        return data
