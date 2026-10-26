import re

from django.db import transaction

from rest_framework import serializers

from casa_comercial.models import CasaComercial
from casa_comercial.serializers import CasaComercialSerializer
from core.concurrency import acquire_sequence_lock
from productos.models import OEM, OEMProducto, Producto, add_producto_referencia
from productos.serializers import ProductoSerializer
from solicitudes.models import Solicitud

from .models import Importacion, ImportacionDetalle


def generate_next_importacion_code(casa=None):
    casa_code = str(getattr(casa, "codigo", "") or "").strip().upper()
    prefix = f"IMP-{casa_code}-" if casa_code else "IMP-"
    # Si se llama dentro de un transaction.atomic() que tambien crea la
    # Importacion (el caso que importa), serializa a dos requests generando
    # un codigo para el mismo prefijo -- ver acquire_sequence_lock.
    acquire_sequence_lock(Importacion._meta.label, prefix)
    last_codes = Importacion.objects.filter(codigo__startswith=prefix).values_list("codigo", flat=True)
    max_number = 0
    pattern = re.compile(r"^" + re.escape(prefix) + r"(\d+)$")
    for code in last_codes:
        match = pattern.match(str(code or "").strip())
        if match:
            max_number = max(max_number, int(match.group(1)))
    next_number = max_number + 1
    candidate = f"{prefix}{next_number}"
    while Importacion.objects.filter(codigo=candidate).exists():
        next_number += 1
        candidate = f"{prefix}{next_number}"
    return candidate


class ImportacionDetalleSerializer(serializers.ModelSerializer):
    producto = ProductoSerializer(read_only=True)
    producto_id = serializers.PrimaryKeyRelatedField(
        source="producto",
        queryset=Producto.objects.all(),
        write_only=True,
        required=False,
        allow_null=True,
    )
    solicitud_id = serializers.PrimaryKeyRelatedField(
        source="solicitud",
        queryset=Solicitud.objects.all(),
        write_only=False,
        required=False,
        allow_null=True,
    )

    class Meta:
        model = ImportacionDetalle
        fields = ["id", "producto", "producto_id", "codigo", "nombre", "oem", "referencia", "cantidad", "comentario", "precio_estimado", "cantidad_aproximada", "precio_confirmado", "cantidad_confirmada", "precio_pvp_snapshot", "cantidad_recibida", "seleccionado", "solicitud_id", "orden"]

    def validate(self, data):
        producto = data.get("producto")
        codigo = str(data.get("codigo") or "").strip()
        nombre = str(data.get("nombre") or "").strip()
        referencia = str(data.get("referencia") or "").strip()
        oem = str(data.get("oem") or "").strip()
        # Un producto realmente sin catálogo (sin producto_id, sin código
        # sugerido) queda como pendiente: alcanza con referencia u OEM para
        # poder identificarlo y vincularlo después al confirmar la llegada.
        if not producto and not codigo and not nombre and not referencia and not oem:
            raise serializers.ValidationError("Se requiere producto, código/nombre, o referencia/OEM.")
        # La cantidad puede quedar en 0 (p. ej. un Excel que solo trae los
        # productos buscados): las unidades se completan después.
        return data

    def validate_cantidad(self, value):
        if int(value or 0) < 0:
            raise serializers.ValidationError("La cantidad no puede ser negativa.")
        return value


class ImportacionSerializer(serializers.ModelSerializer):
    casa_comercial = CasaComercialSerializer(read_only=True)
    casa_comercial_id = serializers.PrimaryKeyRelatedField(
        source="casa_comercial",
        queryset=CasaComercial.objects.all(),
        write_only=True,
    )
    detalles = ImportacionDetalleSerializer(many=True)
    total_productos = serializers.SerializerMethodField()
    origen_id = serializers.SerializerMethodField()
    origen_codigo = serializers.SerializerMethodField()
    en_camino_id = serializers.SerializerMethodField()
    envios = serializers.SerializerMethodField()

    class Meta:
        model = Importacion
        fields = [
            "id",
            "codigo",
            "estado",
            "fecha",
            "casa_comercial",
            "casa_comercial_id",
            "dias_entrega_estimados",
            "numero_factura",
            "fecha_importacion",
            "fecha_puerto",
            "fecha_llegada",
            "dias_reales_entrega",
            "origen_id",
            "origen_codigo",
            "en_camino_id",
            "historial_confirmacion",
            "borrador_llegada",
            "detalles",
            "envios",
            "total_productos",
            "creado_en",
            "actualizado_en",
        ]
        read_only_fields = [
            "id",
            "codigo",
            "estado",
            "fecha",
            "dias_entrega_estimados",
            "fecha_importacion",
            "fecha_puerto",
            "fecha_llegada",
            "dias_reales_entrega",
            "origen_id",
            "origen_codigo",
            "en_camino_id",
            "envios",
            "historial_confirmacion",
            "borrador_llegada",
            "total_productos",
            "creado_en",
            "actualizado_en",
        ]

    def get_origen_id(self, obj):
        return obj.origen_id

    def get_en_camino_id(self, obj):
        prefetched = getattr(obj, "_prefetched_objects_cache", {}).get("en_camino_generadas")
        derived = prefetched[0] if prefetched else obj.en_camino_generadas.first()
        return derived.id if derived else None

    def get_origen_codigo(self, obj):
        return obj.origen.codigo if obj.origen_id else None

    def get_envios(self, obj):
        if "envios" in getattr(obj, "_prefetched_objects_cache", {}):
            envios_qs = obj.envios.all()
        else:
            envios_qs = obj.envios.select_related("sucursal").prefetch_related("detalles__producto")
        return [
            {
                "id": envio.id,
                "sucursal_id": envio.sucursal_id,
                "sucursal_nombre": envio.sucursal.nombre,
                "estado": envio.estado,
                "detalles": [
                    {
                        "producto_id": detalle.producto_id,
                        "producto_codigo": detalle.producto.codigo,
                        "producto_nombre": detalle.producto.nombre,
                        "cantidad": detalle.cantidad,
                    }
                    for detalle in envio.detalles.all()
                ],
            }
            for envio in envios_qs
        ]

    def get_total_productos(self, obj):
        prefetched = getattr(obj, "_prefetched_objects_cache", {}).get("detalles")
        if prefetched is not None:
            return sum(int(detalle.cantidad or 0) for detalle in prefetched)
        return sum(obj.detalles.values_list("cantidad", flat=True))

    _SIDE_SUFFIX_RE = re.compile(r"-(L|R)$", re.IGNORECASE)

    @staticmethod
    def _detalle_label(item):
        producto = item.get("producto")
        if producto:
            return producto.codigo
        return str(item.get("codigo") or item.get("nombre") or "sin código").strip() or "sin código"

    def _find_shared_field_conflicts(self, value, field_name, label):
        """Un mismo OEM o referencia repetido en mas de una fila de la misma
        importacion (aunque cada fila haya resuelto a un producto distinto, o
        a ninguno todavia) es la señal exacta del problema que causo P2066PX
        y P1915PX: un producto del catalogo con un OEM/referencia que en
        realidad pertenece a otro. Se avisa apenas se detecta -- con el
        producto/fila donde ocurre -- en vez de dejar que se manifieste
        despues como un producto duplicado dificil de rastrear.

        Cuando el grupo en conflicto ya tiene codigos con sufijo -L/-R y
        alguno se quedo sin sufijo (el caso de C0363PX vs C0363AFP-R/
        C0363AF-R/C0363CL-R), se sugiere directamente cual sufijo agregarle
        en vez de solo señalar el choque -- asi la proxima vez no hay que
        adivinar cual lado es.
        """
        etiquetas_por_valor = {}
        for item in value:
            crudo = str(item.get(field_name) or "").strip()
            if not crudo:
                continue
            etiqueta = self._detalle_label(item)
            for token in crudo.split(","):
                token = token.strip()
                if not token:
                    continue
                etiquetas_por_valor.setdefault(token.upper(), []).append(etiqueta)

        conflictos = []
        for valor, etiquetas in etiquetas_por_valor.items():
            distintas = list(dict.fromkeys(etiquetas))
            if len(distintas) <= 1:
                continue
            mensaje = f"{label} {valor} aparece en {' y '.join(distintas)}"

            sin_sufijo = [c for c in distintas if not self._SIDE_SUFFIX_RE.search(c)]
            lados = {self._SIDE_SUFFIX_RE.search(c).group(1).upper() for c in distintas if self._SIDE_SUFFIX_RE.search(c)}
            if sin_sufijo and len(lados) == 1:
                lado = next(iter(lados))
                sugerencias = ", ".join(f"{c} -> {c}-{lado}" for c in sin_sufijo)
                mensaje += (
                    f" -- {', '.join(sin_sufijo)} no tiene el sufijo -{lado} que sí tienen los demás "
                    f"({sugerencias})"
                )
            conflictos.append(mensaje)
        return conflictos

    def validate_detalles(self, value):
        if not value:
            raise serializers.ValidationError("Agrega al menos un producto a la importacion.")
        productos = [item["producto"] for item in value if item.get("producto")]
        codigo_by_id = {producto.id: producto.codigo for producto in productos}
        conteo_by_id = {}
        for producto in productos:
            conteo_by_id[producto.id] = conteo_by_id.get(producto.id, 0) + 1
        codigos_repetidos = [codigo_by_id[pid] for pid, conteo in conteo_by_id.items() if conteo > 1]
        if codigos_repetidos:
            raise serializers.ValidationError(
                f"No repitas productos dentro de la misma importacion: {', '.join(codigos_repetidos)}."
            )

        conflictos = self._find_shared_field_conflicts(value, "oem", "el OEM") + self._find_shared_field_conflicts(
            value, "referencia", "la referencia"
        )
        if conflictos:
            raise serializers.ValidationError(
                "Hay un OEM o referencia repetido entre productos distintos, revisa el catálogo: "
                + "; ".join(conflictos)
                + "."
            )
        return value

    def _resolve_producto_for_detalle(self, item, casa_comercial, importacion):
        """Si el detalle trae un código (sugerido por OEM o escrito a mano)
        pero no está vinculado a un producto existente, se crea el producto
        real en el catálogo (con stock en 0) en lugar de dejarlo pendiente —
        así futuras importaciones lo reconocen por OEM/código. Mientras la
        importación es una sugerencia (borrador) no se crea nada: queda como
        detalle pendiente y se crea al pedir la cotización
        (crear_productos_pendientes).
        """
        if item.get("producto") is not None:
            return

        codigo = str(item.get("codigo") or "").strip()
        if not codigo:
            return

        nombre = str(item.get("nombre") or "").strip() or codigo
        referencia = str(item.get("referencia") or "").strip()
        precio_estimado = item.get("precio_estimado")

        producto = Producto.objects.filter(codigo__iexact=codigo).first()
        if producto is None:
            # Se marca de dónde salió este producto para poder resaltarlo en
            # amarillo en esta importación (y solo en esta) mientras sigue
            # avanzando por cotización/confirmación/importar.
            producto = Producto.objects.create(
                codigo=codigo,
                nombre=nombre,
                precio=precio_estimado,
                creado_desde_importacion=importacion,
            )

        # Un producto puede tener varias referencias -- si esta ya la tiene
        # no se duplica, y si no la tiene se agrega sin borrar las demás (ver
        # add_producto_referencia).
        if referencia:
            add_producto_referencia(producto, referencia)

        if casa_comercial and not producto.casas_comerciales.filter(pk=casa_comercial.pk).exists():
            producto.casas_comerciales.add(casa_comercial)

        for oem_codigo in str(item.get("oem") or "").split(","):
            oem_codigo = oem_codigo.strip()
            if not oem_codigo:
                continue
            oem_obj, _ = OEM.objects.get_or_create(codigo=oem_codigo)
            OEMProducto.objects.get_or_create(producto=producto, oem=oem_obj)

        item["producto"] = producto

    def crear_productos_pendientes(self, importacion):
        """Al pasar la sugerencia a cotizacion: los detalles con codigo que
        todavia no tienen producto se crean en el catalogo (con su PVP aprox.
        como precio) y quedan vinculados."""
        for detalle in importacion.detalles.filter(producto__isnull=True).exclude(codigo=""):
            item = {
                "producto": None,
                "codigo": detalle.codigo,
                "nombre": detalle.nombre,
                "referencia": detalle.referencia,
                "oem": detalle.oem,
                "precio_estimado": detalle.precio_estimado,
            }
            self._resolve_producto_for_detalle(item, importacion.casa_comercial, importacion)
            detalle.producto = item["producto"]
            detalle.save(update_fields=["producto"])

    @transaction.atomic
    def update(self, instance, validated_data):
        detalles_data = validated_data.pop("detalles", None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        if detalles_data is not None:
            casa_comercial = validated_data.get("casa_comercial") or instance.casa_comercial
            if instance.estado != Importacion.ESTADO_BORRADOR:
                for item in detalles_data:
                    self._resolve_producto_for_detalle(item, casa_comercial, instance)
            instance.detalles.all().delete()
            ImportacionDetalle.objects.bulk_create([
                ImportacionDetalle(
                    importacion=instance,
                    producto=item.get("producto"),
                    codigo=str(item.get("codigo") or ""),
                    nombre=str(item.get("nombre") or ""),
                    oem=str(item.get("oem") or ""),
                    referencia=str(item.get("referencia") or ""),
                    cantidad=item["cantidad"],
                    comentario=str(item.get("comentario") or ""),
                    precio_estimado=item.get("precio_estimado"),
                    cantidad_aproximada=item.get("cantidad_aproximada"),
                    precio_confirmado=item.get("precio_confirmado"),
                    cantidad_confirmada=item.get("cantidad_confirmada"),
                    precio_pvp_snapshot=item.get("precio_pvp_snapshot"),
                    cantidad_recibida=item.get("cantidad_recibida"),
                    solicitud=item.get("solicitud"),
                    seleccionado=item.get("seleccionado"),
                    orden=item.get("orden"),
                )
                for item in detalles_data
            ])
            if hasattr(instance, "_prefetched_objects_cache"):
                instance._prefetched_objects_cache.pop("detalles", None)
        return instance

    @transaction.atomic
    def create(self, validated_data):
        detalles_data = validated_data.pop("detalles", [])
        casa = validated_data.get("casa_comercial")
        validated_data["codigo"] = generate_next_importacion_code(casa)
        validated_data["estado"] = Importacion.ESTADO_BORRADOR
        validated_data["dias_entrega_estimados"] = getattr(casa, "dias_entrega", None)

        request = self.context.get("request")
        if request and request.user and request.user.is_authenticated:
            validated_data["creado_por"] = request.user

        # Se crea como sugerencia (borrador): los productos nuevos todavia no
        # entran al catalogo, se crean al pedir la cotizacion.
        importacion = Importacion.objects.create(**validated_data)
        ImportacionDetalle.objects.bulk_create(
            [
                ImportacionDetalle(
                    importacion=importacion,
                    producto=item.get("producto"),
                    codigo=str(item.get("codigo") or ""),
                    nombre=str(item.get("nombre") or ""),
                    oem=str(item.get("oem") or ""),
                    referencia=str(item.get("referencia") or ""),
                    cantidad=item["cantidad"],
                    comentario=str(item.get("comentario") or ""),
                    precio_estimado=item.get("precio_estimado"),
                    precio_confirmado=item.get("precio_confirmado"),
                    cantidad_confirmada=item.get("cantidad_confirmada"),
                    solicitud=item.get("solicitud"),
                    orden=item.get("orden"),
                )
                for item in detalles_data
            ]
        )
        return importacion
