from collections import defaultdict
from decimal import Decimal
import unicodedata

from django.db import transaction
from rest_framework import serializers

from configuracion.models import ConfiguracionSistema
from inventario.models import Inventario, SubDivision, Sucursal
from productos.models import Producto
from tipos.models import (
    EstadoMovimiento,
    EstadoProducto,
    SubTipoMovimiento,
    TipoMovimiento,
    TipoPago,
)

from .models import (
    DetalleMovimiento,
    MovimientoInventario,
    PagoMovimiento,
    SolicitudTraslado,
    SolicitudTrasladoDetalle,
)
from .stock_availability import get_available_transfer_quantities_by_product


def normalize_name(value):
    text = str(value or "")
    normalized = unicodedata.normalize("NFD", text)
    without_marks = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    return without_marks.strip().lower()


class DetalleMovimientoSerializer(serializers.ModelSerializer):
    """Serializa los productos asociados a un movimiento."""

    producto = serializers.StringRelatedField(read_only=True)
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
        write_only=True,
    )
    estado_producto = serializers.StringRelatedField(read_only=True)
    estado_producto_id = serializers.PrimaryKeyRelatedField(
        source="estado_producto",
        queryset=EstadoProducto.objects.all(),
        write_only=True,
    )

    class Meta:
        model = DetalleMovimiento
        fields = [
            "id",
            "producto",
            "producto_id",
            "cantidad",
            "estado_producto",
            "estado_producto_id",
            "valor",
            "valor_total",
        ]


class PagoMovimientoSerializer(serializers.ModelSerializer):
    """Serializa los tipos de pago asociados a un movimiento."""

    tipo_pago = serializers.StringRelatedField(read_only=True)
    tipo_pago_id = serializers.PrimaryKeyRelatedField(
        source="tipo_pago",
        queryset=TipoPago.objects.all(),
        write_only=True,
        allow_null=False,
    )

    class Meta:
        model = PagoMovimiento
        fields = ["id", "tipo_pago", "tipo_pago_id"]


class SolicitudTrasladoDetalleSerializer(serializers.ModelSerializer):
    """Detalle de productos de una solicitud de traslado."""

    producto = serializers.StringRelatedField(read_only=True)
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
    )
    producto_codigo = serializers.CharField(source="producto.codigo", read_only=True)
    producto_nombre = serializers.CharField(source="producto.nombre", read_only=True)

    class Meta:
        model = SolicitudTrasladoDetalle
        fields = [
            "id",
            "producto",
            "producto_id",
            "producto_codigo",
            "producto_nombre",
            "cantidad",
            "valor",
        ]


class SolicitudTrasladoSerializer(serializers.ModelSerializer):
    """Serializa solicitudes de traslado A -> B."""

    sucursal_solicitante = serializers.StringRelatedField(read_only=True)
    sucursal_solicitante_id = serializers.PrimaryKeyRelatedField(
        source="sucursal_solicitante",
        queryset=Sucursal.objects.all(),
    )
    sucursal_proveedora = serializers.StringRelatedField(read_only=True)
    sucursal_proveedora_id = serializers.PrimaryKeyRelatedField(
        source="sucursal_proveedora",
        queryset=Sucursal.objects.all(),
    )
    detalles = SolicitudTrasladoDetalleSerializer(many=True)
    movimiento_salida_id = serializers.IntegerField(source="movimiento_salida.id", read_only=True)
    movimiento_entrada_id = serializers.IntegerField(source="movimiento_entrada.id", read_only=True)
    estado_label = serializers.SerializerMethodField(read_only=True)
    rechazada_por_nombre = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = SolicitudTraslado
        fields = [
            "id",
            "no_documento",
            "fecha",
            "descripcion",
            "estado",
            "estado_label",
            "sucursal_solicitante",
            "sucursal_solicitante_id",
            "sucursal_proveedora",
            "sucursal_proveedora_id",
            "movimiento_salida_id",
            "movimiento_entrada_id",
            "motivo_rechazo",
            "rechazada_por",
            "rechazada_por_nombre",
            "rechazada_en",
            "detalles",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "estado",
            "estado_label",
            "motivo_rechazo",
            "rechazada_por",
            "rechazada_por_nombre",
            "rechazada_en",
            "movimiento_salida_id",
            "movimiento_entrada_id",
            "created_at",
            "updated_at",
        ]

    def get_rechazada_por_nombre(self, obj):
        user = getattr(obj, "rechazada_por", None)
        if user is None:
            return ""

        full_name = str(getattr(user, "get_full_name", lambda: "")() or "").strip()
        if full_name:
            return full_name

        return str(getattr(user, "email", "") or "").strip()

    def get_estado_label(self, obj):
        estado = str(getattr(obj, "estado", "") or "").strip().lower()
        if estado == SolicitudTraslado.Estados.PENDIENTE:
            return "Solicitud pendiente"
        if estado == SolicitudTraslado.Estados.CANCELADA:
            return "Rechazada"
        if estado == SolicitudTraslado.Estados.APROBADA:
            if getattr(obj, "movimiento_salida_id", None):
                return "Solicitud enviada"
            return "Solicitud aceptada"
        display = str(getattr(obj, "get_estado_display", lambda: "")() or "").strip()
        if display:
            return display
        return str(getattr(obj, "estado", "") or "").strip() or "-"

    def validate_no_documento(self, value):
        normalized = str(value or "").strip()
        queryset = SolicitudTraslado.objects.filter(no_documento__iexact=normalized)
        if self.instance is not None:
            queryset = queryset.exclude(pk=self.instance.pk)
        if queryset.exists():
            raise serializers.ValidationError("No se puede usar dos iguales.")
        return normalized

    def validate(self, attrs):
        attrs = super().validate(attrs)
        sucursal_solicitante = attrs.get("sucursal_solicitante") or getattr(
            self.instance, "sucursal_solicitante", None
        )
        sucursal_proveedora = attrs.get("sucursal_proveedora") or getattr(
            self.instance, "sucursal_proveedora", None
        )

        if (
            sucursal_solicitante is not None
            and sucursal_proveedora is not None
            and int(sucursal_solicitante.id) == int(sucursal_proveedora.id)
        ):
            raise serializers.ValidationError(
                {
                    "sucursal_proveedora_id": (
                        "La sucursal proveedora debe ser diferente a la sucursal solicitante."
                    )
                }
            )

        if sucursal_solicitante is not None and sucursal_proveedora is not None:
            pending_qs = SolicitudTraslado.objects.filter(
                sucursal_solicitante_id=int(sucursal_solicitante.id),
                sucursal_proveedora_id=int(sucursal_proveedora.id),
                estado=SolicitudTraslado.Estados.PENDIENTE,
            )
            if self.instance is not None:
                pending_qs = pending_qs.exclude(pk=self.instance.pk)

            existing_document = str(
                pending_qs.order_by("-created_at", "-id")
                .values_list("no_documento", flat=True)
                .first()
                or ""
            ).strip()
            if existing_document:
                raise serializers.ValidationError(
                    {
                        "sucursal_proveedora_id": (
                            "Ya existe una solicitud pendiente para estas sucursales "
                            f"({existing_document}). Debes aceptarla o rechazarla antes "
                            "de crear otra."
                        )
                    }
                )

        detalles_data = attrs.get("detalles")
        if self.instance is None and not detalles_data:
            raise serializers.ValidationError(
                {"detalles": "Debes agregar al menos un producto en la solicitud."}
            )

        if detalles_data is not None:
            repeated = set()
            stock_cache = {}
            for item in detalles_data:
                producto = item.get("producto")
                producto_id = getattr(producto, "id", None)
                cantidad = int(item.get("cantidad") or 0)
                if not producto_id or cantidad <= 0:
                    raise serializers.ValidationError(
                        {"detalles": "Todos los productos deben tener cantidad mayor a 0."}
                    )
                if producto_id in repeated:
                    raise serializers.ValidationError(
                        {"detalles": "No puedes repetir el mismo producto en la solicitud."}
                    )
                repeated.add(producto_id)

                if sucursal_proveedora is not None:
                    available = stock_cache.get(int(producto_id))
                    if available is None:
                        available = self._get_available_stock_in_branch(
                            sucursal_id=int(sucursal_proveedora.id),
                            producto_id=int(producto_id),
                            exclude_solicitud_id=getattr(self.instance, "id", None),
                        )
                        stock_cache[int(producto_id)] = available
                    if cantidad > available:
                        codigo = str(getattr(producto, "codigo", "") or "").strip()
                        label = codigo or f"ID {producto_id}"
                        raise serializers.ValidationError(
                            {
                                "detalles": (
                                    f"Stock insuficiente en sucursal proveedora para '{label}'. "
                                    f"Disponible: {available}."
                                )
                            }
                        )
        return attrs

    def create(self, validated_data):
        detalles_data = validated_data.pop("detalles", [])
        with transaction.atomic():
            solicitud = SolicitudTraslado.objects.create(**validated_data)
            for detalle in detalles_data:
                SolicitudTrasladoDetalle.objects.create(solicitud=solicitud, **detalle)
        return solicitud

    @staticmethod
    def _get_available_stock_in_branch(sucursal_id, producto_id, exclude_solicitud_id=None):
        if not sucursal_id or not producto_id:
            return 0

        product_id = int(producto_id)
        available_map = get_available_transfer_quantities_by_product(
            sucursal_id=int(sucursal_id),
            product_ids=[product_id],
            exclude_solicitud_id=exclude_solicitud_id,
        )
        return max(int(available_map.get(product_id, 0)), 0)


class MovimientoInventarioSerializer(serializers.ModelSerializer):
    """Serializador principal para los movimientos de inventario."""

    sucursal = serializers.StringRelatedField(read_only=True)
    sucursal_id = serializers.PrimaryKeyRelatedField(
        source="sucursal",
        queryset=Sucursal.objects.all(),
        write_only=True,
    )
    sucursal_objetivo = serializers.StringRelatedField(read_only=True)
    sucursal_objetivo_id = serializers.PrimaryKeyRelatedField(
        source="sucursal_objetivo",
        queryset=Sucursal.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )
    tipo_movimiento = serializers.StringRelatedField(read_only=True)
    tipo_movimiento_id = serializers.PrimaryKeyRelatedField(
        source="tipo_movimiento",
        queryset=TipoMovimiento.objects.all(),
        write_only=True,
    )
    sub_tipo_movimiento = serializers.StringRelatedField(read_only=True)
    sub_tipo_movimiento_id = serializers.PrimaryKeyRelatedField(
        source="sub_tipo_movimiento",
        queryset=SubTipoMovimiento.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )
    estado_movimiento = serializers.StringRelatedField(read_only=True)
    estado_movimiento_id = serializers.PrimaryKeyRelatedField(
        source="estado_movimiento",
        queryset=EstadoMovimiento.objects.all(),
        write_only=True,
    )
    solicitud_traslado = serializers.SerializerMethodField(read_only=True)
    solicitud_traslado_id = serializers.PrimaryKeyRelatedField(
        source="solicitud_traslado",
        queryset=SolicitudTraslado.objects.select_related(
            "sucursal_solicitante",
            "sucursal_proveedora",
            "movimiento_salida",
            "movimiento_entrada",
        ).prefetch_related("detalles__producto"),
        write_only=True,
        required=False,
        allow_null=True,
    )
    detalles = DetalleMovimientoSerializer(many=True, required=False)
    pagos = PagoMovimientoSerializer(many=True, required=False)

    class Meta:
        model = MovimientoInventario
        fields = [
            "id",
            "sucursal",
            "sucursal_id",
            "tipo_movimiento",
            "tipo_movimiento_id",
            "sub_tipo_movimiento",
            "sub_tipo_movimiento_id",
            "descripcion",
            "funcional",
            "sucursal_objetivo",
            "sucursal_objetivo_id",
            "estado_movimiento",
            "estado_movimiento_id",
            "descuento",
            "iva_rate",
            "fecha",
            "no_documento",
            "solicitud_traslado",
            "solicitud_traslado_id",
            "detalles",
            "pagos",
        ]

    def _resolve_subtipo_key(self, subtipo):
        name = normalize_name(getattr(subtipo, "nombre", ""))
        if "devol" in name:
            return "devolucion"
        if "trasl" in name:
            return "traslado"
        if "vent" in name:
            return "venta"
        if "compra" in name:
            return "compra_local"
        if "import" in name:
            return "importacion"
        return None

    def _resolve_tipo_name(self, tipo):
        return normalize_name(getattr(tipo, "nombre", ""))

    def _resolve_estado_name(self, estado):
        return normalize_name(getattr(estado, "nombre", ""))

    def _get_linked_solicitud_traslado(self, movimiento):
        if movimiento is None:
            return None

        try:
            solicitud = movimiento.solicitud_traslado_salida
            if solicitud is not None:
                return solicitud
        except SolicitudTraslado.DoesNotExist:
            pass

        try:
            solicitud = movimiento.solicitud_traslado_entrada
            if solicitud is not None:
                return solicitud
        except SolicitudTraslado.DoesNotExist:
            pass

        return None

    def get_solicitud_traslado(self, movimiento):
        solicitud = self._get_linked_solicitud_traslado(movimiento)
        if solicitud is None:
            return None
        return {
            "id": int(solicitud.id),
            "no_documento": str(solicitud.no_documento or "").strip(),
            "estado": str(solicitud.estado or "").strip(),
            "sucursal_solicitante_id": int(solicitud.sucursal_solicitante_id),
            "sucursal_proveedora_id": int(solicitud.sucursal_proveedora_id),
        }

    def validate(self, attrs):
        attrs = super().validate(attrs)

        tipo = attrs.get("tipo_movimiento") or getattr(self.instance, "tipo_movimiento", None)
        subtipo = attrs.get("sub_tipo_movimiento") or getattr(self.instance, "sub_tipo_movimiento", None)
        estado = attrs.get("estado_movimiento") or getattr(self.instance, "estado_movimiento", None)
        solicitud_traslado = attrs.get("solicitud_traslado")

        linked_solicitud = self._get_linked_solicitud_traslado(self.instance)
        if solicitud_traslado is None:
            solicitud_traslado = linked_solicitud
        elif linked_solicitud is not None and int(solicitud_traslado.id) != int(linked_solicitud.id):
            raise serializers.ValidationError(
                {"solicitud_traslado_id": "No puedes reasignar la solicitud de traslado."}
            )

        no_documento = str(
            attrs.get("no_documento", getattr(self.instance, "no_documento", ""))
            or ""
        ).strip()
        tipo_id = getattr(tipo, "id", None)
        if tipo_id and no_documento:
            duplicated = MovimientoInventario.objects.filter(
                tipo_movimiento_id=tipo_id,
                no_documento__iexact=no_documento,
            )
            if self.instance is not None:
                duplicated = duplicated.exclude(pk=self.instance.pk)
            if duplicated.exists():
                raise serializers.ValidationError(
                    {"no_documento": "No se puede usar dos iguales."}
                )

        tipo_name = self._resolve_tipo_name(tipo)
        subtipo_key = self._resolve_subtipo_key(subtipo)
        estado_name = self._resolve_estado_name(estado)
        detalles_data = attrs.get("detalles")
        is_create = self.instance is None

        if is_create and not detalles_data:
            requires_request_details = (
                tipo_name.startswith("sal")
                and subtipo_key == "traslado"
                and solicitud_traslado is not None
            )
            if not requires_request_details:
                raise serializers.ValidationError(
                    {"detalles": "Debes agregar al menos un producto al movimiento."}
                )

        if tipo_name.startswith("ent"):
            if subtipo_key == "traslado" and is_create:
                raise serializers.ValidationError(
                    {
                        "sub_tipo_movimiento_id": (
                            "Las entradas por traslado se generan automaticamente cuando se aprueba una solicitud."
                        )
                    }
                )

            if subtipo_key in {"compra_local", "importacion"}:
                allowed = {"en camino", "recibido", "parcialmente recibido"}
                if estado_name not in allowed:
                    raise serializers.ValidationError(
                        {
                            "estado_movimiento_id": (
                                "En importacion o compra local solo se permite En camino, Recibido o Parcialmente recibido."
                            )
                        }
                    )
            return attrs

        if not tipo_name.startswith("sal"):
            return attrs

        if subtipo_key == "devolucion":
            if estado_name != "recibido":
                raise serializers.ValidationError(
                    {"estado_movimiento_id": "En devolucion el estado debe ser Recibido."}
                )

        if subtipo_key == "traslado":
            allowed = {"enviado", "recibido", "parcialmente recibido"}
            if estado_name not in allowed:
                raise serializers.ValidationError(
                    {
                        "estado_movimiento_id": (
                            "En traslado solo se permite Enviado, Recibido o Parcialmente recibido."
                        )
                    }
                )

            if is_create and estado_name != "enviado":
                raise serializers.ValidationError(
                    {
                        "estado_movimiento_id": (
                            "El traslado nuevo debe iniciar en estado Enviado."
                        )
                    }
                )

            if linked_solicitud is not None and estado_name != "enviado":
                raise serializers.ValidationError(
                    {
                        "estado_movimiento_id": (
                            "Esta salida de traslado fue aprobada por solicitud y debe mantenerse en Enviado."
                        )
                    }
                )

            sucursal = attrs.get("sucursal") or getattr(self.instance, "sucursal", None)
            sucursal_objetivo = attrs.get("sucursal_objetivo") or getattr(
                self.instance,
                "sucursal_objetivo",
                None,
            )

            if is_create:
                if solicitud_traslado is None:
                    raise serializers.ValidationError(
                        {
                            "solicitud_traslado_id": (
                                "Debes seleccionar una solicitud de traslado aceptada."
                            )
                        }
                    )

                if solicitud_traslado.estado != SolicitudTraslado.Estados.APROBADA:
                    raise serializers.ValidationError(
                        {"solicitud_traslado_id": "La solicitud de traslado debe estar aceptada."}
                    )

                if (
                    solicitud_traslado.movimiento_salida_id
                    or solicitud_traslado.movimiento_entrada_id
                ):
                    raise serializers.ValidationError(
                        {"solicitud_traslado_id": "La solicitud ya fue procesada."}
                    )

                if sucursal is None or int(sucursal.id) != int(solicitud_traslado.sucursal_proveedora_id):
                    raise serializers.ValidationError(
                        {
                            "sucursal_id": (
                                "La salida debe crearse desde la sucursal proveedora de la solicitud."
                            )
                        }
                    )

                if (
                    sucursal_objetivo is not None
                    and int(sucursal_objetivo.id) != int(solicitud_traslado.sucursal_solicitante_id)
                ):
                    raise serializers.ValidationError(
                        {
                            "sucursal_objetivo_id": (
                                "La sucursal destino debe coincidir con la sucursal solicitante."
                            )
                        }
                    )
                attrs["sucursal_objetivo"] = solicitud_traslado.sucursal_solicitante
            else:
                if sucursal_objetivo is None:
                    raise serializers.ValidationError(
                        {"sucursal_objetivo_id": "En traslado debes seleccionar sucursal B."}
                    )

            if (
                sucursal is not None
                and attrs.get("sucursal_objetivo") is not None
                and int(sucursal.id) == int(attrs["sucursal_objetivo"].id)
            ):
                raise serializers.ValidationError(
                    {
                        "sucursal_objetivo_id": (
                            "En traslado la sucursal B debe ser diferente a la sucursal A."
                        )
                    }
                )

        if subtipo_key == "venta":
            allowed = {"vendido", "proformado", "facturado"}
            if estado_name not in allowed:
                raise serializers.ValidationError(
                    {
                        "estado_movimiento_id": (
                            "En venta solo se permite Vendido, Proformado o Facturado."
                        )
                    }
                )

            descuento_raw = attrs.get("descuento", getattr(self.instance, "descuento", 0))
            try:
                descuento_value = float(descuento_raw or 0)
            except (TypeError, ValueError):
                raise serializers.ValidationError(
                    {"descuento": "El descuento debe ser un porcentaje valido entre 0 y 100."}
                )

            if descuento_value < 0 or descuento_value > 100:
                raise serializers.ValidationError(
                    {"descuento": "El descuento debe ser un porcentaje entre 0 y 100."}
                )

        return attrs

    def _resolve_default_estado_producto(self):
        preferred = EstadoProducto.objects.filter(nombre__icontains="enviad").order_by("id").first()
        if preferred is not None:
            return preferred
        fallback = EstadoProducto.objects.order_by("id").first()
        if fallback is not None:
            return fallback
        raise serializers.ValidationError(
            {
                "detalles": (
                    "No hay estados de producto configurados para completar el traslado."
                )
            }
        )

    def _build_detalles_from_solicitud(self, solicitud_traslado):
        rows = list(solicitud_traslado.detalles.select_related("producto").all())
        if not rows:
            raise serializers.ValidationError(
                {"solicitud_traslado_id": "La solicitud de traslado no tiene productos."}
            )

        estado_producto = self._resolve_default_estado_producto()
        detalles = []
        for row in rows:
            cantidad = int(row.cantidad or 0)
            if cantidad <= 0:
                continue
            valor = row.valor if row.valor is not None else Decimal("0")
            detalles.append(
                {
                    "producto": row.producto,
                    "cantidad": cantidad,
                    "estado_producto": estado_producto,
                    "valor": valor,
                    "valor_total": valor * cantidad,
                }
            )

        if not detalles:
            raise serializers.ValidationError(
                {"solicitud_traslado_id": "La solicitud no tiene cantidades validas."}
            )
        return detalles

    def _resolve_transfer_entry_subtipo(self):
        tipo_entrada = TipoMovimiento.objects.filter(nombre__istartswith="ent").order_by("id").first()
        if tipo_entrada is None:
            raise serializers.ValidationError(
                {
                    "tipo_movimiento_id": (
                        "No existe el tipo de movimiento de entrada para generar el traslado."
                    )
                }
            )

        subtipo_traslado = (
            SubTipoMovimiento.objects.filter(
                tipo_movimiento=tipo_entrada,
                nombre__icontains="trasl",
            )
            .order_by("id")
            .first()
        )
        if subtipo_traslado is None:
            raise serializers.ValidationError(
                {
                    "sub_tipo_movimiento_id": (
                        "No existe el subtipo de traslado para entradas."
                    )
                }
            )
        return tipo_entrada, subtipo_traslado

    def _build_unique_document_number(self, tipo_movimiento, base_number):
        raw_base = str(base_number or "").strip() or "TR-ENTRADA"
        candidate = raw_base[:80]
        index = 1
        while MovimientoInventario.objects.filter(
            tipo_movimiento=tipo_movimiento,
            no_documento__iexact=candidate,
        ).exists():
            suffix = f"-{index}"
            base_max_length = max(1, 80 - len(suffix))
            candidate = f"{raw_base[:base_max_length]}{suffix}"
            index += 1
        return candidate

    def _create_transfer_entry_from_salida(self, salida, detalles_data, solicitud_traslado):
        tipo_entrada, subtipo_traslado = self._resolve_transfer_entry_subtipo()
        document_number = self._build_unique_document_number(
            tipo_entrada,
            f"TR-ENT-{salida.no_documento}",
        )
        descripcion_salida = str(salida.descripcion or "").strip()
        descripcion_base = f"Entrada automatica por traslado solicitado #{solicitud_traslado.no_documento}"
        descripcion = (
            f"{descripcion_base}\n{descripcion_salida}"
            if descripcion_salida
            else descripcion_base
        )

        entrada = MovimientoInventario.objects.create(
            sucursal=solicitud_traslado.sucursal_solicitante,
            tipo_movimiento=tipo_entrada,
            sub_tipo_movimiento=subtipo_traslado,
            descripcion=descripcion,
            funcional=bool(salida.funcional),
            sucursal_objetivo=solicitud_traslado.sucursal_proveedora,
            estado_movimiento=salida.estado_movimiento,
            descuento=Decimal("0"),
            iva_rate=salida.iva_rate,
            fecha=salida.fecha,
            no_documento=document_number,
        )

        normalized_details = []
        for detail in detalles_data:
            producto = detail.get("producto")
            cantidad = int(detail.get("cantidad") or 0)
            estado_producto = detail.get("estado_producto")
            valor = detail.get("valor") if detail.get("valor") is not None else Decimal("0")
            valor_total = (
                detail.get("valor_total")
                if detail.get("valor_total") is not None
                else (valor * cantidad)
            )
            normalized_details.append(
                {
                    "producto": producto,
                    "cantidad": cantidad,
                    "estado_producto": estado_producto,
                    "valor": valor,
                    "valor_total": valor_total,
                }
            )

        self._replace_detalles(entrada, normalized_details)
        self._apply_inventory_effect(entrada, normalized_details, reverse=False)
        return entrada

    def create(self, validated_data):
        detalles_data = validated_data.pop("detalles", [])
        pagos_data = validated_data.pop("pagos", [])
        solicitud_traslado = validated_data.pop("solicitud_traslado", None)

        tipo_name = self._resolve_tipo_name(validated_data.get("tipo_movimiento"))
        subtipo_key = self._resolve_subtipo_key(validated_data.get("sub_tipo_movimiento"))
        is_transfer_approval = (
            tipo_name.startswith("sal")
            and subtipo_key == "traslado"
            and solicitud_traslado is not None
        )

        if is_transfer_approval:
            detalles_data = self._build_detalles_from_solicitud(solicitud_traslado)
            pagos_data = []

        if "iva_rate" not in validated_data or validated_data["iva_rate"] is None:
            validated_data["iva_rate"] = ConfiguracionSistema.get_solo().iva_rate
        with transaction.atomic():
            movimiento = super().create(validated_data)
            self._replace_detalles(movimiento, detalles_data)
            self._replace_pagos(movimiento, pagos_data)
            self._apply_inventory_effect(movimiento, detalles_data, reverse=False)

            if is_transfer_approval:
                movimiento_entrada = self._create_transfer_entry_from_salida(
                    movimiento,
                    detalles_data,
                    solicitud_traslado,
                )
                solicitud_traslado.estado = SolicitudTraslado.Estados.APROBADA
                solicitud_traslado.movimiento_salida = movimiento
                solicitud_traslado.movimiento_entrada = movimiento_entrada
                solicitud_traslado.save(
                    update_fields=[
                        "estado",
                        "movimiento_salida",
                        "movimiento_entrada",
                        "updated_at",
                    ]
                )
        return movimiento

    def update(self, instance, validated_data):
        detalles_data = validated_data.pop("detalles", None)
        pagos_data = validated_data.pop("pagos", None)
        validated_data.pop("solicitud_traslado", None)
        previous_details = list(instance.detalles.select_related("producto").all())

        with transaction.atomic():
            self._apply_inventory_effect(instance, previous_details, reverse=True)

            movimiento = super().update(instance, validated_data)
            if detalles_data is not None:
                movimiento.detalles.all().delete()
                self._replace_detalles(movimiento, detalles_data)
                current_details = detalles_data
            else:
                current_details = list(movimiento.detalles.select_related("producto").all())

            if pagos_data is not None:
                movimiento.pagos.all().delete()
                self._replace_pagos(movimiento, pagos_data)

            self._apply_inventory_effect(movimiento, current_details, reverse=False)

        return movimiento

    def _collect_product_quantities(self, details_source):
        quantities = defaultdict(int)

        for detail in details_source or []:
            if isinstance(detail, dict):
                producto = detail.get("producto")
                producto_id = getattr(producto, "id", None)
                raw_qty = detail.get("cantidad")
            else:
                producto_id = getattr(detail, "producto_id", None)
                raw_qty = getattr(detail, "cantidad", 0)

            try:
                cantidad = int(raw_qty or 0)
            except (TypeError, ValueError):
                continue

            if not producto_id or cantidad <= 0:
                continue
            quantities[int(producto_id)] += cantidad

        return quantities

    def _adjust_stock(self, sucursal, producto_id, delta):
        if not delta:
            return

        if sucursal is None:
            raise serializers.ValidationError(
                {"sucursal_id": "No se pudo resolver la sucursal para actualizar inventario."}
            )

        branch_stock = Inventario.objects.select_for_update().filter(
            producto_id=producto_id,
            subdivision__division__bodega__sucursal_id=sucursal.id,
        ).order_by("id")

        if delta < 0:
            required = -int(delta)
            available = sum(item.cantidad for item in branch_stock)
            if available < required:
                raise serializers.ValidationError(
                    {
                        "detalles": (
                            "Stock insuficiente en sucursal A para completar el traslado."
                        )
                    }
                )

            remaining = required
            for item in branch_stock:
                if remaining <= 0:
                    break
                taken = min(item.cantidad, remaining)
                item.cantidad -= taken
                item.save(update_fields=["cantidad"])
                remaining -= taken
            return

        target = branch_stock.filter(cantidad__gt=0).first() or branch_stock.first()
        if target is not None:
            target.cantidad += int(delta)
            target.save(update_fields=["cantidad"])
            return

        subdivision = (
            SubDivision.objects.select_related("division__bodega")
            .filter(division__bodega__sucursal_id=sucursal.id)
            .order_by("id")
            .first()
        )
        if subdivision is None:
            raise serializers.ValidationError(
                {
                    "sucursal_objetivo_id": (
                        "La sucursal destino no tiene subdivisiones para registrar inventario."
                    )
                }
            )

        inventory_row, _ = Inventario.objects.select_for_update().get_or_create(
            subdivision=subdivision,
            producto_id=producto_id,
            referencia="",
            defaults={"cantidad": 0},
        )
        inventory_row.cantidad += int(delta)
        inventory_row.save(update_fields=["cantidad"])

    def _apply_inventory_effect(self, movimiento, details_source, reverse=False):
        if self._resolve_subtipo_key(getattr(movimiento, "sub_tipo_movimiento", None)) != "traslado":
            return

        tipo_name = self._resolve_tipo_name(getattr(movimiento, "tipo_movimiento", None))
        estado_name = self._resolve_estado_name(getattr(movimiento, "estado_movimiento", None))
        quantities = self._collect_product_quantities(details_source)
        if not quantities:
            return

        factor = -1 if reverse else 1
        should_mark_received = estado_name in {"recibido", "parcialmente recibido"}

        if tipo_name.startswith("sal"):
            for producto_id, cantidad in quantities.items():
                self._adjust_stock(
                    sucursal=getattr(movimiento, "sucursal", None),
                    producto_id=producto_id,
                    delta=(-cantidad * factor),
                )
                if should_mark_received:
                    self._adjust_stock(
                        sucursal=getattr(movimiento, "sucursal_objetivo", None),
                        producto_id=producto_id,
                        delta=(cantidad * factor),
                    )
            return

        if tipo_name.startswith("ent") and should_mark_received:
            for producto_id, cantidad in quantities.items():
                self._adjust_stock(
                    sucursal=getattr(movimiento, "sucursal", None),
                    producto_id=producto_id,
                    delta=(cantidad * factor),
                )

    def _replace_detalles(self, movimiento, detalles_data):
        for detalle in detalles_data:
            DetalleMovimiento.objects.create(
                movimiento_inventario=movimiento,
                **detalle,
            )

    def _replace_pagos(self, movimiento, pagos_data):
        for pago in pagos_data:
            PagoMovimiento.objects.create(
                movimiento_inventario=movimiento,
                **pago,
            )
