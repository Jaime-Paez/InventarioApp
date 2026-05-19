from django.db.models import F, Sum, Value
from django.db.models.functions import Coalesce
from rest_framework import serializers

from casa_comercial.models import CasaComercial
from inventario.models import Inventario, Sucursal
from productos.models import OEM, Producto

from .models import Auto, Cliente, OEMProductoSolicitado, ProductoSolicitado, Solicitud


def normalize_text(value):
    return str(value or "").strip()


def parse_oem_codes(raw_value):
    if raw_value in (None, serializers.empty):
        return []

    if isinstance(raw_value, list):
        raw_items = raw_value
    else:
        raw_items = str(raw_value or "").replace(";", ",").replace("\n", ",").split(",")

    codes = []
    seen = set()
    for value in raw_items:
        code = normalize_text(value)
        if not code:
            continue
        key = code.lower()
        if key in seen:
            continue
        seen.add(key)
        codes.append(code)
    return codes


class AutoSerializer(serializers.ModelSerializer):
    class Meta:
        model = Auto
        fields = ["id", "placa", "modelo", "anio", "marca", "color"]


class ClienteSerializer(serializers.ModelSerializer):
    autos = AutoSerializer(many=True, required=False)

    class Meta:
        model = Cliente
        fields = ["id", "nombres", "apellidos", "correo", "telefono", "direccion", "cedula_ruc", "autos"]
        extra_kwargs = {
            "correo": {"required": False, "allow_blank": True},
            "telefono": {"required": False, "allow_blank": True},
            "direccion": {"required": False, "allow_blank": True},
        }

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

        nombres = normalize_text(nombres)
        apellidos = normalize_text(apellidos)
        cedula_ruc = normalize_text(cedula_ruc)

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
        for optional_field in ("correo", "telefono", "direccion"):
            optional_value = attrs.get(optional_field, serializers.empty)
            if optional_value is serializers.empty:
                continue
            attrs[optional_field] = normalize_text(optional_value)
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


class CasaComercialLiteSerializer(serializers.ModelSerializer):
    class Meta:
        model = CasaComercial
        fields = ["id", "codigo", "nombre", "tipo"]


class ProductoSolicitadoSerializer(serializers.ModelSerializer):
    casa_comercial_nombre = serializers.SerializerMethodField(read_only=True)
    casa_comercial_id = serializers.PrimaryKeyRelatedField(
        source="casa_comercial",
        queryset=CasaComercial.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )
    casa_comercial_data = CasaComercialLiteSerializer(source="casa_comercial", read_only=True)
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
            "casa_comercial_nombre",
            "casa_comercial_id",
            "casa_comercial_data",
            "conseguido",
            "producto",
            "producto_id",
        ]

    def get_casa_comercial_nombre(self, obj):
        if obj.casa_comercial_id:
            return obj.casa_comercial.nombre
        return ""

    def to_representation(self, instance):
        data = super().to_representation(instance)
        data["casa_comercial_id"] = instance.casa_comercial_id
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
    casa_comercial_nombre = serializers.SerializerMethodField(read_only=True)
    casa_comercial_id = serializers.IntegerField(read_only=True)
    casa_comercial_data = CasaComercialLiteSerializer(source="casa_comercial", read_only=True)
    producto_id = serializers.IntegerField(read_only=True)
    producto_data = ProductoLiteSerializer(source="producto", read_only=True)
    oem_codigos = serializers.SerializerMethodField()

    class Meta:
        model = ProductoSolicitado
        fields = [
            "id",
            "codigo",
            "nombre",
            "casa_comercial_nombre",
            "casa_comercial_id",
            "casa_comercial_data",
            "conseguido",
            "producto_id",
            "producto_data",
            "oem_codigos",
        ]

    def get_casa_comercial_nombre(self, obj):
        if obj.casa_comercial_id:
            return obj.casa_comercial.nombre
        return ""

    def get_oem_codigos(self, obj):
        relaciones = getattr(obj, "oem_relaciones", None)
        if relaciones is None:
            return []
        codigos = []
        for relation in relaciones.select_related("oem").all():
            codigo = normalize_text(getattr(getattr(relation, "oem", None), "codigo", ""))
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
    codigo = serializers.CharField(read_only=True)
    cliente = serializers.StringRelatedField(read_only=True)
    cliente_id = serializers.PrimaryKeyRelatedField(
        source="cliente",
        queryset=Cliente.objects.all(),
        required=False,
        allow_null=True,
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
    conseguido = serializers.SerializerMethodField()
    conseguido_label = serializers.SerializerMethodField()
    producto_conseguido = serializers.SerializerMethodField()
    producto_resuelto_data = serializers.SerializerMethodField()
    cliente_nombres = serializers.CharField(write_only=True, required=False, allow_blank=True)
    cliente_apellidos = serializers.CharField(write_only=True, required=False, allow_blank=True)
    cliente_cedula_ruc = serializers.CharField(write_only=True, required=False, allow_blank=True)
    cliente_correo = serializers.CharField(write_only=True, required=False, allow_blank=True)
    cliente_telefono = serializers.CharField(write_only=True, required=False, allow_blank=True)
    cliente_direccion = serializers.CharField(write_only=True, required=False, allow_blank=True)
    producto_codigo = serializers.CharField(write_only=True, required=False, allow_blank=True)
    producto_nombre = serializers.CharField(write_only=True, required=False, allow_blank=True)
    producto_casa_comercial_id = serializers.IntegerField(write_only=True, required=False, allow_null=True)
    producto_oems = serializers.ListField(
        child=serializers.CharField(allow_blank=False),
        write_only=True,
        required=False,
    )

    class Meta:
        model = Solicitud
        fields = [
            "id",
            "codigo",
            "grupo_codigo",
            "cantidad",
            "tabla",
            "producto",
            "producto_solicitado",
            "producto_id",
            "fecha",
            "comentario",
            "marca",
            "modelo",
            "motor",
            "anio",
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
            "conseguido",
            "conseguido_label",
            "producto_conseguido",
            "producto_resuelto_data",
            "cliente_nombres",
            "cliente_apellidos",
            "cliente_cedula_ruc",
            "cliente_correo",
            "cliente_telefono",
            "cliente_direccion",
            "producto_codigo",
            "producto_nombre",
            "producto_casa_comercial_id",
            "producto_oems",
        ]
        read_only_fields = ["codigo", "fecha", "grupo_codigo"]

    def validate(self, attrs):
        cliente_payload = self._pop_write_payload(
            attrs,
            (
                "cliente_nombres",
                "cliente_apellidos",
                "cliente_cedula_ruc",
                "cliente_correo",
                "cliente_telefono",
                "cliente_direccion",
            ),
        )
        producto_payload = self._pop_write_payload(
            attrs,
            (
                "producto_codigo",
                "producto_nombre",
                "producto_casa_comercial_id",
                "producto_oems",
            ),
        )
        attrs["_cliente_payload"] = cliente_payload
        attrs["_producto_payload"] = producto_payload

        tabla = attrs.get("tabla")
        if tabla is None and self.instance is not None:
            tabla = self.instance.tabla
            attrs["tabla"] = tabla

        producto_id = attrs.pop("producto_id", serializers.empty)

        if tabla is None:
            raise serializers.ValidationError({"tabla": "Este campo es obligatorio."})

        if tabla == Solicitud.Tabla.PRODUCTO:
            attrs["producto_solicitado"] = None
            if producto_id is serializers.empty:
                if self.instance is not None and self.instance.tabla == Solicitud.Tabla.PRODUCTO:
                    attrs["producto"] = self.instance.producto
                    return attrs
                raise serializers.ValidationError({"producto_id": "Este campo es obligatorio."})

            try:
                producto = Producto.objects.get(pk=int(producto_id))
            except Producto.DoesNotExist as exc:
                raise serializers.ValidationError({"producto_id": "Producto no encontrado."}) from exc
            except (TypeError, ValueError) as exc:
                raise serializers.ValidationError({"producto_id": "Producto no encontrado."}) from exc

            same_producto = (
                self.instance is not None
                and self.instance.tabla == Solicitud.Tabla.PRODUCTO
                and self.instance.producto_id == producto.id
            )
            if not same_producto:
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
            return attrs

        if tabla == Solicitud.Tabla.PRODUCTO_SOLICITADO:
            attrs["producto"] = None
            create_producto_solicitado = False

            if producto_id is serializers.empty or producto_id in (None, ""):
                if self.instance is not None and self.instance.tabla == Solicitud.Tabla.PRODUCTO_SOLICITADO:
                    attrs["producto_solicitado"] = self.instance.producto_solicitado
                elif producto_payload["_provided"]:
                    attrs["producto_solicitado"] = None
                    create_producto_solicitado = True
                else:
                    raise serializers.ValidationError({"producto_id": "Este campo es obligatorio."})
            else:
                try:
                    producto_solicitado = ProductoSolicitado.objects.get(pk=int(producto_id))
                except ProductoSolicitado.DoesNotExist as exc:
                    raise serializers.ValidationError(
                        {"producto_id": "Producto solicitado no encontrado."}
                    ) from exc
                except (TypeError, ValueError) as exc:
                    raise serializers.ValidationError(
                        {"producto_id": "Producto solicitado no encontrado."}
                    ) from exc
                attrs["producto_solicitado"] = producto_solicitado

            attrs["_create_producto_solicitado"] = create_producto_solicitado
            return attrs

        raise serializers.ValidationError({"tabla": "Seleccion de tabla invalida."})

    def create(self, validated_data):
        cliente_payload = validated_data.pop("_cliente_payload", {"_provided": False})
        producto_payload = validated_data.pop("_producto_payload", {"_provided": False})
        create_producto_solicitado = validated_data.pop("_create_producto_solicitado", False)

        validated_data["cliente"] = self._resolve_cliente_write(
            current_cliente=None,
            selected_cliente=validated_data.get("cliente"),
            payload=cliente_payload,
        )

        if validated_data.get("tabla") == Solicitud.Tabla.PRODUCTO_SOLICITADO:
            validated_data["producto_solicitado"] = self._resolve_producto_solicitado_write(
                current_producto_solicitado=None,
                selected_producto_solicitado=validated_data.get("producto_solicitado"),
                payload=producto_payload,
                create_if_missing=create_producto_solicitado,
            )
            validated_data["producto"] = None

        return super().create(validated_data)

    def update(self, instance, validated_data):
        cliente_payload = validated_data.pop("_cliente_payload", {"_provided": False})
        producto_payload = validated_data.pop("_producto_payload", {"_provided": False})
        create_producto_solicitado = validated_data.pop("_create_producto_solicitado", False)

        validated_data["cliente"] = self._resolve_cliente_write(
            current_cliente=instance.cliente,
            selected_cliente=validated_data.get("cliente", instance.cliente),
            payload=cliente_payload,
        )

        if validated_data.get("tabla", instance.tabla) == Solicitud.Tabla.PRODUCTO_SOLICITADO:
            validated_data["producto_solicitado"] = self._resolve_producto_solicitado_write(
                current_producto_solicitado=instance.producto_solicitado,
                selected_producto_solicitado=validated_data.get(
                    "producto_solicitado",
                    instance.producto_solicitado,
                ),
                payload=producto_payload,
                create_if_missing=create_producto_solicitado,
            )
            validated_data["producto"] = None
        else:
            validated_data["producto_solicitado"] = None

        return super().update(instance, validated_data)

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
        return normalize_text(getattr(obj.cliente, "cedula_ruc", ""))

    def get_sucursal_nombre(self, obj):
        if not obj.sucursal_id:
            return ""
        return normalize_text(getattr(obj.sucursal, "nombre", ""))

    def get_producto_referencia(self, obj):
        if obj.tabla == Solicitud.Tabla.PRODUCTO and obj.producto_id:
            return obj.producto.nombre
        if obj.producto_solicitado_id:
            return obj.producto_solicitado.nombre
        return ""

    def get_producto_solicitado_nombre(self, obj):
        return self.get_producto_referencia(obj)

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
        codigo = normalize_text(resolved.get("codigo"))
        nombre = normalize_text(resolved.get("nombre"))
        return f"{codigo} {nombre}".strip()

    def get_producto_resuelto_data(self, obj):
        if obj.tabla == Solicitud.Tabla.PRODUCTO and obj.producto_id:
            return ProductoLiteSerializer(obj.producto).data

        if obj.producto_solicitado_id and obj.producto_solicitado.producto_id:
            return ProductoLiteSerializer(obj.producto_solicitado.producto).data

        return None

    @staticmethod
    def _pop_write_payload(attrs, field_names):
        payload = {}
        for field_name in field_names:
            value = attrs.pop(field_name, serializers.empty)
            if value is serializers.empty:
                continue
            payload[field_name] = value
        payload["_provided"] = bool(payload)
        return payload

    def _resolve_cliente_write(self, current_cliente, selected_cliente, payload):
        has_payload = bool(payload.get("_provided"))
        target = selected_cliente or current_cliente

        if not has_payload:
            return target

        nombres = normalize_text(payload.get("cliente_nombres", getattr(target, "nombres", "")))
        apellidos = normalize_text(payload.get("cliente_apellidos", getattr(target, "apellidos", "")))
        cedula_ruc = normalize_text(payload.get("cliente_cedula_ruc", getattr(target, "cedula_ruc", "")))
        correo = normalize_text(payload.get("cliente_correo", getattr(target, "correo", "")))
        telefono = normalize_text(payload.get("cliente_telefono", getattr(target, "telefono", "")))
        direccion = normalize_text(payload.get("cliente_direccion", getattr(target, "direccion", "")))

        errors = {}
        if not nombres:
            errors["cliente_nombres"] = "Los nombres son obligatorios."
        if not apellidos:
            errors["cliente_apellidos"] = "Los apellidos son obligatorios."
        if not cedula_ruc:
            errors["cliente_cedula_ruc"] = "La cedula/RUC es obligatoria."

        if errors:
            raise serializers.ValidationError(errors)

        if target is None:
            return Cliente.objects.create(
                nombres=nombres,
                apellidos=apellidos,
                cedula_ruc=cedula_ruc,
                correo=correo,
                telefono=telefono,
                direccion=direccion,
            )

        target.nombres = nombres
        target.apellidos = apellidos
        target.cedula_ruc = cedula_ruc
        target.correo = correo
        target.telefono = telefono
        target.direccion = direccion
        target.save()
        return target

    def _resolve_producto_solicitado_write(
        self,
        current_producto_solicitado,
        selected_producto_solicitado,
        payload,
        create_if_missing=False,
    ):
        has_payload = bool(payload.get("_provided"))
        target = selected_producto_solicitado or current_producto_solicitado

        if target is not None and not has_payload and not create_if_missing:
            return target

        if target is None and not create_if_missing and not has_payload:
            return None

        if target is None:
            target = ProductoSolicitado()

        is_new = target.pk is None
        codigo = normalize_text(payload.get("producto_codigo", getattr(target, "codigo", "")))
        nombre = normalize_text(payload.get("producto_nombre", getattr(target, "nombre", "")))
        casa_comercial_id = payload.get("producto_casa_comercial_id", getattr(target, "casa_comercial_id", None))

        if "producto_oems" in payload:
            oem_codes = parse_oem_codes(payload.get("producto_oems"))
        else:
            oem_codes = self._get_producto_solicitado_oem_codes(target)

        errors = {}
        if not codigo:
            errors["producto_codigo"] = "El codigo es obligatorio."
        if not nombre:
            errors["producto_nombre"] = "El nombre es obligatorio."
        if errors:
            raise serializers.ValidationError(errors)

        casa_comercial = None
        if casa_comercial_id not in (None, "", serializers.empty):
            try:
                casa_comercial = CasaComercial.objects.get(pk=int(casa_comercial_id))
            except CasaComercial.DoesNotExist as exc:
                raise serializers.ValidationError(
                    {"producto_casa_comercial_id": "La casa comercial seleccionada no existe."}
                ) from exc
            except (TypeError, ValueError) as exc:
                raise serializers.ValidationError(
                    {"producto_casa_comercial_id": "La casa comercial seleccionada no existe."}
                ) from exc

        if is_new or "producto_codigo" in payload:
            if Producto.objects.filter(codigo__iexact=codigo).exists():
                raise serializers.ValidationError(
                    {"producto_codigo": "Ya existe un producto de catalogo con ese codigo."}
                )

        if is_new or "producto_oems" in payload:
            for oem_code in oem_codes:
                if Producto.objects.filter(oem_productos__oem__codigo__iexact=oem_code).exists():
                    raise serializers.ValidationError(
                        {"producto_oems": "Ya existe un producto de catalogo con uno de esos OEM."}
                    )

        target.codigo = codigo
        target.nombre = nombre
        target.casa_comercial = casa_comercial
        target.save()

        if is_new or "producto_oems" in payload:
            self._sync_producto_solicitado_oems(target, oem_codes)

        return target

    @staticmethod
    def _get_producto_solicitado_oem_codes(producto_solicitado):
        if producto_solicitado is None or not producto_solicitado.pk:
            return []

        rows = (
            OEMProductoSolicitado.objects.filter(producto_solicitado=producto_solicitado)
            .select_related("oem")
            .all()
        )
        return [
            normalize_text(getattr(getattr(row, "oem", None), "codigo", ""))
            for row in rows
            if normalize_text(getattr(getattr(row, "oem", None), "codigo", ""))
        ]

    @staticmethod
    def _sync_producto_solicitado_oems(producto_solicitado, oem_codes):
        normalized_codes = parse_oem_codes(oem_codes)
        existing_relations = OEMProductoSolicitado.objects.filter(producto_solicitado=producto_solicitado)
        if normalized_codes:
            existing_relations.exclude(oem__codigo__in=normalized_codes).delete()
        else:
            existing_relations.delete()

        for oem_code in normalized_codes:
            oem, _ = OEM.objects.get_or_create(
                codigo=oem_code,
                defaults={},
            )
            OEMProductoSolicitado.objects.get_or_create(
                producto_solicitado=producto_solicitado,
                oem=oem,
            )

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
                "sucursal_nombre": normalize_text(row.get("sucursal_nombre")),
                "cantidad": int(row.get("cantidad") or 0),
            }
            for row in rows
            if int(row.get("cantidad") or 0) > 0
        ]

    @staticmethod
    def _format_stock_por_sucursal(sucursales_stock):
        partes = []
        for item in sucursales_stock:
            nombre = normalize_text(item.get("sucursal_nombre")) or "Sucursal"
            cantidad = int(item.get("cantidad") or 0)
            if cantidad <= 0:
                continue
            partes.append(f"{nombre}: {cantidad}")
        return ", ".join(partes) if partes else "inventario general"
