from django.db.models import F, Sum, Value
from django.db.models.functions import Coalesce
from rest_framework import serializers

from inventario.models import Inventario, Sucursal
from marcas.models import Marca
from productos.models import OEM, Producto

from .models import Auto, Cliente, OEMProductoSolicitado, ProductoSolicitado, Solicitud


class AutoSerializer(serializers.ModelSerializer):
    marca = serializers.StringRelatedField(read_only=True)
    marca_id = serializers.PrimaryKeyRelatedField(
        source="marca",
        queryset=Marca.objects.all(),
        write_only=True,
    )

    class Meta:
        model = Auto
        fields = ["id", "placa", "modelo", "anio", "marca", "marca_id", "color"]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        data["marca_id"] = instance.marca_id
        return data


class ClienteSerializer(serializers.ModelSerializer):
    autos = AutoSerializer(many=True, required=False)

    class Meta:
        model = Cliente
        fields = ["id", "nombres", "apellidos", "correo", "telefono", "direccion", "cedula_ruc", "autos"]

    def validate(self, attrs):
        nombres = attrs.get("nombres", serializers.empty)
        apellidos = attrs.get("apellidos", serializers.empty)
        cedula_ruc = attrs.get("cedula_ruc", serializers.empty)

        if nombres is serializers.empty and self.instance is not None:
            nombres = self.instance.nombres
        if apellidos is serializers.empty and self.instance is not None:
            apellidos = self.instance.apellidos
        if cedula_ruc is serializers.empty and self.instance is not None:
            cedula_ruc = self.instance.cedula_ruc

        nombres = str(nombres or "").strip()
        apellidos = str(apellidos or "").strip()
        cedula_ruc = str(cedula_ruc or "").strip()

        errors = {}
        if not nombres:
            errors["nombres"] = ["Los nombres son obligatorios."]
        if not apellidos:
            errors["apellidos"] = ["Los apellidos son obligatorios."]
        if not cedula_ruc:
            errors["cedula_ruc"] = ["La cedula/RUC es obligatoria."]

        if errors:
            raise serializers.ValidationError(errors)

        attrs["nombres"] = nombres
        attrs["apellidos"] = apellidos
        attrs["cedula_ruc"] = cedula_ruc
        return attrs

    def create(self, validated_data):
        autos_data = validated_data.pop("autos", [])
        cliente = super().create(validated_data)
        for auto in autos_data:
            Auto.objects.create(cliente=cliente, **auto)
        return cliente

    def update(self, instance, validated_data):
        autos_data = validated_data.pop("autos", None)
        cliente = super().update(instance, validated_data)
        if autos_data is not None:
            instance.autos.all().delete()
            for auto in autos_data:
                Auto.objects.create(cliente=cliente, **auto)
        return cliente


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
            "codigo",
            "nombre",
            "marca",
            "descripcion",
            "conseguido",
            "producto",
            "producto_id",
        ]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        data["producto_id"] = instance.producto_id
        return data


class ClienteLiteSerializer(serializers.ModelSerializer):
    nombre_completo = serializers.SerializerMethodField()

    class Meta:
        model = Cliente
        fields = [
            "id",
            "nombres",
            "apellidos",
            "nombre_completo",
            "cedula_ruc",
            "correo",
            "telefono",
            "direccion",
        ]

    def get_nombre_completo(self, obj):
        return f"{obj.nombres} {obj.apellidos}".strip()


class SucursalLiteSerializer(serializers.ModelSerializer):
    class Meta:
        model = Sucursal
        fields = ["id", "nombre", "direccion"]


class ProductoLiteSerializer(serializers.ModelSerializer):
    class Meta:
        model = Producto
        fields = ["id", "codigo", "nombre"]


class ProductoSolicitadoLiteSerializer(serializers.ModelSerializer):
    producto_id = serializers.IntegerField(read_only=True)
    producto_data = ProductoLiteSerializer(source="producto", read_only=True)
    oem_codigos = serializers.SerializerMethodField()

    class Meta:
        model = ProductoSolicitado
        fields = [
            "id",
            "codigo",
            "nombre",
            "marca",
            "descripcion",
            "conseguido",
            "producto_id",
            "producto_data",
            "oem_codigos",
        ]

    def get_oem_codigos(self, obj):
        relaciones = getattr(obj, "oem_relaciones", None)
        if relaciones is None:
            return []
        codigos = []
        for relation in relaciones.select_related("oem").all():
            codigo = str(getattr(getattr(relation, "oem", None), "codigo", "") or "").strip()
            if codigo:
                codigos.append(codigo)
        return codigos


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
    cliente_data = ClienteLiteSerializer(source="cliente", read_only=True)
    sucursal_data = SucursalLiteSerializer(source="sucursal", read_only=True)
    producto_data = ProductoLiteSerializer(source="producto", read_only=True)
    producto_solicitado_data = ProductoSolicitadoLiteSerializer(
        source="producto_solicitado",
        read_only=True,
    )
    cliente_nombre = serializers.SerializerMethodField()
    cedula_ruc = serializers.SerializerMethodField()
    sucursal_nombre = serializers.SerializerMethodField()
    producto_referencia = serializers.SerializerMethodField()
    producto_solicitado_nombre = serializers.SerializerMethodField()
    producto_solicitado_descripcion = serializers.SerializerMethodField()
    conseguido = serializers.SerializerMethodField()
    conseguido_label = serializers.SerializerMethodField()
    producto_conseguido = serializers.SerializerMethodField()
    producto_resuelto_data = serializers.SerializerMethodField()

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
            "descripcion_general",
            "comentario",
            "sucursal",
            "sucursal_id",
            "cliente",
            "cliente_id",
            "cliente_data",
            "sucursal_data",
            "producto_data",
            "producto_solicitado_data",
            "cliente_nombre",
            "cedula_ruc",
            "sucursal_nombre",
            "producto_referencia",
            "producto_solicitado_nombre",
            "producto_solicitado_descripcion",
            "conseguido",
            "conseguido_label",
            "producto_conseguido",
            "producto_resuelto_data",
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

            sucursales_stock = self._get_producto_stock_por_sucursal(producto.id)
            stock_disponible = sum(item.get("cantidad", 0) for item in sucursales_stock)
            if stock_disponible > 0:
                detalle_stock = self._format_stock_por_sucursal(sucursales_stock)
                raise serializers.ValidationError(
                    {
                        "producto_id": (
                            f"No se puede solicitar este producto porque tiene stock "
                            f"disponible ({stock_disponible}) en: {detalle_stock}."
                        )
                    }
                )

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

    def get_cliente_nombre(self, obj):
        if not obj.cliente_id:
            return ""
        return f"{obj.cliente.nombres} {obj.cliente.apellidos}".strip()

    def get_cedula_ruc(self, obj):
        if not obj.cliente_id:
            return ""
        return str(getattr(obj.cliente, "cedula_ruc", "") or "").strip()

    def get_sucursal_nombre(self, obj):
        if not obj.sucursal_id:
            return ""
        return str(getattr(obj.sucursal, "nombre", "") or "").strip()

    def get_producto_referencia(self, obj):
        if obj.tabla == Solicitud.Tabla.PRODUCTO and obj.producto_id:
            return obj.producto.nombre
        if obj.producto_solicitado_id:
            return obj.producto_solicitado.nombre
        return ""

    def get_producto_solicitado_nombre(self, obj):
        return self.get_producto_referencia(obj)

    def get_producto_solicitado_descripcion(self, obj):
        if obj.producto_solicitado_id:
            return str(getattr(obj.producto_solicitado, "descripcion", "") or "").strip()
        return ""

    def get_conseguido(self, obj):
        if obj.tabla == Solicitud.Tabla.PRODUCTO:
            return True
        if obj.producto_solicitado_id:
            return bool(obj.producto_solicitado.conseguido)
        return False

    def get_conseguido_label(self, obj):
        return "Si" if self.get_conseguido(obj) else "No"

    def get_producto_conseguido(self, obj):
        resolved = self.get_producto_resuelto_data(obj)
        if not isinstance(resolved, dict):
            return ""
        codigo = str(resolved.get("codigo") or "").strip()
        nombre = str(resolved.get("nombre") or "").strip()
        return f"{codigo} {nombre}".strip()

    def get_producto_resuelto_data(self, obj):
        if obj.tabla == Solicitud.Tabla.PRODUCTO and obj.producto_id:
            return ProductoLiteSerializer(obj.producto).data

        if obj.producto_solicitado_id and obj.producto_solicitado.producto_id:
            return ProductoLiteSerializer(obj.producto_solicitado.producto).data

        return None

    @staticmethod
    def _get_producto_stock_total(producto_id):
        if not producto_id:
            return 0
        aggregated = (
            Inventario.objects.filter(
                producto_id=producto_id,
            ).aggregate(total=Coalesce(Sum("cantidad"), Value(0)))
        )
        return int(aggregated.get("total") or 0)

    @staticmethod
    def _get_producto_stock_por_sucursal(producto_id):
        if not producto_id:
            return []
        rows = (
            Inventario.objects.filter(producto_id=producto_id)
            .values(
                sucursal_id=F("subdivision__division__bodega__sucursal_id"),
                sucursal_nombre=F("subdivision__division__bodega__sucursal__nombre"),
            )
            .annotate(cantidad=Coalesce(Sum("cantidad"), Value(0)))
            .filter(cantidad__gt=0)
            .order_by("-cantidad", "sucursal_nombre")
        )
        return [
            {
                "sucursal_id": int(row.get("sucursal_id") or 0),
                "sucursal_nombre": str(row.get("sucursal_nombre") or "").strip(),
                "cantidad": int(row.get("cantidad") or 0),
            }
            for row in rows
            if int(row.get("cantidad") or 0) > 0
        ]

    @staticmethod
    def _format_stock_por_sucursal(sucursales_stock):
        partes = []
        for item in sucursales_stock:
            nombre = str(item.get("sucursal_nombre") or "Sucursal").strip() or "Sucursal"
            cantidad = int(item.get("cantidad") or 0)
            if cantidad <= 0:
                continue
            partes.append(f"{nombre}: {cantidad}")
        return ", ".join(partes) if partes else "inventario general"
