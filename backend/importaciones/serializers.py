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
        fields = ["id", "producto", "producto_id", "codigo", "nombre", "oem", "referencia", "cantidad", "comentario", "precio_estimado", "precio_casa", "coincidencia", "coincidencia_codigo", "coincidencia_casa", "coincidencia_precio", "cantidad_aproximada", "precio_confirmado", "cantidad_confirmada", "precio_pvp_snapshot", "cantidad_recibida", "seleccionado", "quitado", "solicitud_id", "orden"]

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
            "historial_verificacion",
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
            "historial_verificacion",
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
        # Fuera de la sugerencia, un código escrito que ya existe es ese mismo
        # producto: se vincula aquí para que el chequeo de repetidos de abajo
        # lo vea si ese producto ya está en la lista.
        if self.instance is not None and self.instance.estado != Importacion.ESTADO_BORRADOR:
            for item in value:
                self._vincular_producto_existente(item)
        productos =[item["producto"] for item in value if item.get("producto")]
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
        así futuras importaciones lo reconocen por OEM/código. Solo se usa al
        importar (crear_productos_pendientes): antes de eso queda como
        detalle pendiente, así lo que la casa niega nunca entra al catálogo.
        """
        if item.get("producto") is not None:
            return

        codigo = str(item.get("codigo") or "").strip()
        if not codigo:
            return

        nombre = str(item.get("nombre") or "").strip() or codigo
        referencia = str(item.get("referencia") or "").strip()
        precio_estimado = item.get("precio_estimado")
        if precio_estimado is None:
            precio_estimado = item.get("precio_confirmado")

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

    @staticmethod
    def validar_codigos_nuevos(nuevos, codigos_en_importacion=()):
        """Un producto no puede quedar dos veces en la importación: antes de
        crear (o de pedir la confirmación) se revisan todos los códigos nuevos
        de una vez y se devuelve cada uno con su motivo, para no crear ninguno
        si alguno está mal. `nuevos` son los (codigo, nombre) de los detalles
        sin producto que se van a crear; `codigos_en_importacion`, los códigos
        de los productos del catálogo que ya están en ella. Un código que ya
        existe en el catálogo es ese mismo producto y se vincula (no es error)
        salvo que ese producto ya esté en la importación."""
        max_codigo = Producto._meta.get_field("codigo").max_length
        max_nombre = Producto._meta.get_field("nombre").max_length
        en_importacion = {str(c or "").strip().upper() for c in codigos_en_importacion}
        nuevos = [(str(c or "").strip(), str(n or "").strip()) for c, n in nuevos]
        nuevos = [(c, n) for c, n in nuevos if c]
        conteo = {}
        for codigo, _ in nuevos:
            conteo[codigo.upper()] = conteo.get(codigo.upper(), 0) + 1
        invalidos = []
        vistos = set()
        for codigo, nombre in nuevos:
            clave = codigo.upper()
            if clave in vistos:
                continue
            vistos.add(clave)
            motivos = []
            if clave in en_importacion:
                motivos.append("ese producto ya está en esta importación")
            if conteo[clave] > 1:
                motivos.append(f"está repetido {conteo[clave]} veces en esta importación")
            if len(codigo) > max_codigo:
                motivos.append(f"tiene más de {max_codigo} caracteres")
            if len(nombre or codigo) > max_nombre:
                motivos.append(f"la descripción tiene más de {max_nombre} caracteres")
            if motivos:
                invalidos.append({"codigo": codigo, "motivo": "; ".join(motivos)})
        return invalidos

    @staticmethod
    def codigos_invalidos_response_data(invalidos):
        lista = "; ".join(f"{row['codigo']}: {row['motivo']}" for row in invalidos)
        return {
            "detail": f"Hay códigos nuevos repetidos, cámbialos o quita la fila: {lista}.",
            "codigos_invalidos": invalidos,
        }

    @staticmethod
    def _vincular_producto_existente(item):
        """Un código escrito que ya existe en el catálogo es ese mismo
        producto: se vincula, sin crear ni modificar nada."""
        if item.get("producto") is not None:
            return
        codigo = str(item.get("codigo") or "").strip()
        if codigo:
            item["producto"] = Producto.objects.filter(codigo__iexact=codigo).first()

    @classmethod
    def vincular_codigos_existentes(cls, detalles):
        """Los detalles sin producto cuyo código ya existe quedan vinculados a
        ese producto (p. ej. si alguien lo creó en el catálogo mientras tanto)."""
        for detalle in detalles:
            if detalle.producto_id or not (detalle.codigo or "").strip():
                continue
            item = {"producto": None, "codigo": detalle.codigo}
            cls._vincular_producto_existente(item)
            if item["producto"] is not None:
                detalle.producto = item["producto"]
                detalle.save(update_fields=["producto"])

    def crear_productos_pendientes(self, importacion):
        """Al importar: los detalles con codigo que todavia no tienen producto
        se crean en el catalogo (con su PVP aprox. como precio) y quedan
        vinculados."""
        for detalle in importacion.detalles.filter(producto__isnull=True).exclude(codigo=""):
            item = {
                "producto": None,
                "codigo": detalle.codigo,
                "nombre": detalle.nombre,
                "referencia": detalle.referencia,
                "oem": detalle.oem,
                "precio_estimado": detalle.precio_estimado,
                "precio_confirmado": detalle.precio_confirmado,
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
            # Los guardados que no mandan precio_casa (casi todos) conservan
            # la que ya tenía cada producto -- aquí se borra y se vuelve a
            # crear todo el listado.
            # Lo mismo con la coincidencia (amarillo/naranja de la sugerencia).
            casa_previa = {}
            coincidencia_previa = {}
            for detalle in instance.detalles.all():
                claves = []
                if detalle.producto_id:
                    claves.append(("p", detalle.producto_id))
                if detalle.codigo:
                    claves.append(("c", detalle.codigo.strip().lower()))
                for clave in claves:
                    if detalle.precio_casa:
                        casa_previa[clave] = detalle.precio_casa
                    if detalle.coincidencia:
                        coincidencia_previa[clave] = {
                            "coincidencia": detalle.coincidencia,
                            "coincidencia_codigo": detalle.coincidencia_codigo,
                            "coincidencia_casa": detalle.coincidencia_casa,
                            "coincidencia_precio": detalle.coincidencia_precio,
                        }
            for item in detalles_data:
                producto = item.get("producto")
                codigo = str(item.get("codigo") or (producto.codigo if producto else "")).strip().lower()
                claves = ([("p", producto.id)] if producto else []) + [("c", codigo)]
                if "precio_casa" not in item:
                    item["precio_casa"] = next((casa_previa[c] for c in claves if c in casa_previa), "")
                if "coincidencia" not in item:
                    previa = next((coincidencia_previa[c] for c in claves if c in coincidencia_previa), None)
                    if previa:
                        item.update(previa)
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
                    precio_casa=str(item.get("precio_casa") or ""),
                    coincidencia=str(item.get("coincidencia") or ""),
                    coincidencia_codigo=str(item.get("coincidencia_codigo") or ""),
                    coincidencia_casa=str(item.get("coincidencia_casa") or ""),
                    coincidencia_precio=item.get("coincidencia_precio"),
                    cantidad_aproximada=item.get("cantidad_aproximada"),
                    precio_confirmado=item.get("precio_confirmado"),
                    cantidad_confirmada=item.get("cantidad_confirmada"),
                    precio_pvp_snapshot=item.get("precio_pvp_snapshot"),
                    cantidad_recibida=item.get("cantidad_recibida"),
                    solicitud=item.get("solicitud"),
                    seleccionado=item.get("seleccionado"),
                    quitado=bool(item.get("quitado")),
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
                    precio_casa=str(item.get("precio_casa") or ""),
                    coincidencia=str(item.get("coincidencia") or ""),
                    coincidencia_codigo=str(item.get("coincidencia_codigo") or ""),
                    coincidencia_casa=str(item.get("coincidencia_casa") or ""),
                    coincidencia_precio=item.get("coincidencia_precio"),
                    precio_confirmado=item.get("precio_confirmado"),
                    cantidad_confirmada=item.get("cantidad_confirmada"),
                    solicitud=item.get("solicitud"),
                    orden=item.get("orden"),
                )
                for item in detalles_data
            ]
        )
        return importacion
