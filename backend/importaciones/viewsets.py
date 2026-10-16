import io
import statistics
import threading
import unicodedata
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import connections, transaction
from django.utils import timezone

from core.search_utils import attach_product_search
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from usuarios.models import RolPermiso, UsuarioModuloSucursal
from usuarios.permissions import ImportacionesModulePermission
from usuarios.sucursal_scope import get_allowed_sucursal_ids, get_readable_sucursal_ids
from usuarios.utils import is_app_admin

from django.db.models import F, Func, Q

from app.models import ReminderState
from configuracion.models import ConfiguracionSistema
from inventario.models import Inventario, SubDivision
from inventario.por_ubicar import (
    RecepcionDesactualizada,
    RecepcionError,
    pending_to_store,
    received_by_product,
    receive_items,
    serialize_progress,
    serialize_progress_many,
    store_items,
)
from productos.models import OEMProducto, Producto, add_producto_referencia

from .models import (
    Importacion,
    ImportacionDetalle,
    ImportacionEnvio,
    ImportacionEnvioDetalle,
    ImportacionExcelJob,
    ImportacionInconveniente,
    ImportacionInconvenienteHistorial,
)
from .serializers import ImportacionDetalleSerializer, ImportacionSerializer, generate_next_importacion_code


class _StripLeadingZerosSQL(Func):
    """Quita ceros a la izquierda de una referencia en la base (deja al menos
    un caracter) para poder comparar '0042' con '42' como la misma referencia.
    """

    function = "REGEXP_REPLACE"
    template = "%(function)s(%(expressions)s, '^0+(?=.)', '')"


def _strip_leading_zeros(value):
    text = str(value or "").strip()
    return text.lstrip("0") or text


def _pick_producto_match(candidates, casa_comercial_id):
    """Cuando el mismo código/referencia existe en más de un producto (uno por
    casa comercial), prioriza el que ya pertenece a la casa que se está
    importando en vez de tomar el primero al azar -- así no se marca como
    'conflicto de otra casa' un producto que en realidad sí calza.
    """
    if not candidates:
        return None
    if casa_comercial_id:
        for candidate in candidates:
            if candidate.casas_comerciales.filter(id=casa_comercial_id).exists():
                return candidate
    return candidates[0]


def _resolve_producto_by_referencia(referencia, casa_comercial_id):
    if not referencia:
        return None
    # Un producto puede tener varias referencias (ProductoReferencia): hay
    # que buscar en todas, no solo en Producto.referencia (que es nada más
    # una copia de la primera, ver sync_producto_referencia_primary).
    candidates = list(Producto.objects.filter(referencias__valor__iexact=referencia).distinct())
    if not candidates:
        # Los ceros a la izquierda no distinguen la referencia ('0042' es lo
        # mismo que '42'), sin importar de qué lado (Excel o catálogo) estén
        # de más -- pero solo se usan para buscar el match, el valor tal cual
        # vino del Excel se sigue guardando sin tocar.
        stripped = _strip_leading_zeros(referencia)
        candidates = list(
            Producto.objects.annotate(referencia_sin_ceros=_StripLeadingZerosSQL("referencias__valor"))
            .filter(referencia_sin_ceros__iexact=stripped)
            .distinct()
        )
    return _pick_producto_match(candidates, casa_comercial_id)


def _run_parse_excel_job(job_id, file_bytes, casa_comercial_id):
    """Procesa el Excel de sugerencia en un thread aparte, reportando progreso
    incremental en el job (0-100) para que el frontend pueda hacer polling.
    """
    import openpyxl

    def set_progress(pct):
        ImportacionExcelJob.objects.filter(pk=job_id).update(progreso=min(99, max(0, int(pct))))

    try:
        try:
            wb = openpyxl.load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
            ws = wb.active
        except Exception:
            raise ValueError("No se pudo leer el archivo. Asegúrate de que sea un .xlsx válido.")
        all_rows = list(ws.iter_rows(values_only=True))
        if not all_rows:
            raise ValueError("El archivo está vacío.")

        set_progress(5)

        def normalize_header(val):
            text = str(val or "").strip().upper()
            text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
            return text

        header = [normalize_header(h) for h in all_rows[0]]
        # Known columns can appear in any order; anything left over (after the
        # known ones) is treated as a per-sucursal quantity column.
        known_aliases = {
            # Si el Excel ya trae una columna "Orden" (por ejemplo, porque es
            # el mismo archivo descargado antes y se vuelve a subir), esa
            # columna define el orden real de cada producto sin importar en
            # qué fila haya quedado dentro del archivo -- ver más abajo.
            "orden": ["ORDEN"],
            "codigo": ["CODIGO JP", "CODIGO"],
            "referencia": ["REFERENCIA"],
            "oem": ["OEM"],
            "descripcion": ["DESCRIPCION"],
            "cantidad": ["CANTIDAD"],
            "pvp": ["PVP", "PVP APROX", "PVP APROXIMADO"],
        }
        col_idx_by_field = {}
        known_col_indexes = set()
        for field, aliases in known_aliases.items():
            for idx, name in enumerate(header):
                if name in aliases:
                    col_idx_by_field[field] = idx
                    known_col_indexes.add(idx)
                    break

        sucursal_cols = [(idx, name) for idx, name in enumerate(header) if idx not in known_col_indexes and name]

        from inventario.models import Sucursal as SucursalModel
        suc_by_name = {s.nombre.strip().upper(): s.id for s in SucursalModel.objects.all()}
        sucursal_col_ids = {idx: suc_by_name.get(name) for idx, name in sucursal_cols}

        def cell(row, field):
            idx = col_idx_by_field.get(field)
            if idx is None or idx >= len(row):
                return None
            return row[idx]

        def safe_str(val):
            return str(val or "").strip()

        def safe_code(val):
            # Código/referencia/OEM son identificadores, pero si en el Excel
            # la columna quedó con formato numérico (común cuando el código
            # es solo dígitos, p. ej. un OEM "9822498280"), Excel lo guarda
            # como float y str(9822498280.0) da "9822498280.0" — ese ".0" de
            # más rompe la comparación exacta contra el código real en la
            # base de datos. Si es un float entero, se descarta el ".0".
            if isinstance(val, float) and val.is_integer():
                return str(int(val)).strip()
            return str(val or "").strip()

        def safe_int(val):
            try:
                return int(float(val))
            except (TypeError, ValueError):
                return 0

        def safe_float(val):
            try:
                return float(val or 0)
            except (TypeError, ValueError):
                return 0.0

        set_progress(10)

        # Junta todos los códigos OEM del Excel para resolverlos en una sola
        # consulta (en vez de una por fila) y así poder mostrar, por fila, qué
        # productos del catálogo ya tienen registrado ese mismo OEM.
        from django.db.models.functions import Lower

        all_oem_codes_lower = set()
        for row in all_rows[1:]:
            for code in safe_code(cell(row, "oem")).split(","):
                code = code.strip()
                if code:
                    all_oem_codes_lower.add(code.lower())

        iva_rate = ConfiguracionSistema.get_solo().iva_rate or 0

        def with_iva(precio):
            return round(float(precio) * (1 + float(iva_rate)), 2) if precio is not None else None

        oem_matches_by_code = {}
        if all_oem_codes_lower:
            oem_links = (
                OEMProducto.objects
                .select_related("producto", "oem")
                .prefetch_related(
                    "producto__casas_comerciales",
                    "producto__alternativas__alterno__casas_comerciales",
                    "producto__alternativas_para__producto__casas_comerciales",
                )
                .annotate(codigo_lower=Lower("oem__codigo"))
                .filter(codigo_lower__in=all_oem_codes_lower)
            )
            for link in oem_links:
                precio = float(link.producto.precio) if link.producto.precio is not None else None
                # Productos "alternos" (ProductoAlterno, en cualquiera de las dos
                # direcciones): aunque no compartan este mismo OEM, son la MISMA
                # pieza física en otras casas comerciales, así que también sirven
                # como fuente del patrón <base><sufijo> para sugerir un código
                # nuevo cuando el match directo por OEM no alcanza otra casa.
                alterno_productos = [rel.alterno for rel in link.producto.alternativas.all()]
                alterno_productos += [rel.producto for rel in link.producto.alternativas_para.all()]
                alternos_payload = []
                for alt in alterno_productos:
                    alt_precio = float(alt.precio) if alt.precio is not None else None
                    alternos_payload.append({
                        "producto_id": alt.id,
                        "codigo": alt.codigo,
                        "nombre": alt.nombre,
                        "referencia": alt.referencia,
                        "casas_comerciales_codigos": [
                            c.codigo for c in alt.casas_comerciales.all() if c.codigo
                        ],
                        "precio": alt_precio,
                        "precio_con_iva": with_iva(alt_precio),
                    })
                oem_matches_by_code.setdefault(link.codigo_lower, []).append({
                    "producto_id": link.producto_id,
                    "codigo": link.producto.codigo,
                    "nombre": link.producto.nombre,
                    "referencia": link.producto.referencia,
                    # Códigos JP se arman como <base><sufijo de la casa comercial>;
                    # se manda el sufijo de cada casa a la que pertenece este
                    # producto para que el frontend pueda inferir la base y
                    # sugerir el código con el sufijo de la casa actual.
                    "casas_comerciales_codigos": [
                        c.codigo for c in link.producto.casas_comerciales.all() if c.codigo
                    ],
                    # Nombres completos (para mostrarlos en el hover de OEMs,
                    # a diferencia de los códigos de arriba que son para lógica).
                    "casas_comerciales_nombres": [
                        c.nombre for c in link.producto.casas_comerciales.all() if c.nombre
                    ],
                    "alternos": alternos_payload,
                    "precio": precio,
                    "precio_con_iva": with_iva(precio),
                })

        set_progress(20)

        data_rows = all_rows[1:]
        total_data_rows = max(len(data_rows), 1)
        parsed = []
        for i, (fila_excel, row) in enumerate(enumerate(data_rows, start=2), start=1):
            codigo = safe_code(cell(row, "codigo"))
            referencia = safe_code(cell(row, "referencia"))
            oem = safe_code(cell(row, "oem"))
            descripcion = safe_str(cell(row, "descripcion"))
            cantidad = safe_int(cell(row, "cantidad"))
            pvp = safe_float(cell(row, "pvp"))
            # Si el Excel ya traía su propia columna "Orden" (se descargó antes
            # y se vuelve a subir), se respeta ese valor tal cual -- así el
            # producto conserva su orden real aunque el usuario haya
            # reordenado las filas en el archivo antes de volver a subirlo.
            # Si no hay columna Orden (Excel nuevo), se usa la fila en la que
            # cayó dentro de este archivo, como antes.
            orden_cell = cell(row, "orden")
            try:
                orden = int(float(orden_cell)) if orden_cell not in (None, "") else 0
            except (TypeError, ValueError):
                orden = 0
            if orden <= 0:
                orden = i
            if not codigo and not referencia and not oem and not descripcion and cantidad <= 0 and pvp <= 0:
                if i % 10 == 0 or i == total_data_rows:
                    set_progress(20 + (i / total_data_rows) * 75)
                continue  # fully blank template row

            matched = None
            # Un match por código o referencia es una identidad fuerte (ese
            # código/referencia es unico de ese producto), asi que si resulta
            # ser de otra casa es un conflicto real. Un match por OEM en
            # cambio solo indica que el repuesto es compatible/equivalente:
            # es normal que el mismo OEM lo fabriquen o lo cataloguen varias
            # casas, asi que por si solo NO implica que sea el mismo producto
            # de esa otra casa (ver mas abajo).
            matched_via_identity = False
            conflicto_casa = False
            conflicto_casa_nombre = ""
            if codigo:
                matched = _pick_producto_match(
                    list(Producto.objects.filter(codigo__iexact=codigo)), casa_comercial_id
                )
                if matched:
                    matched_via_identity = True
            if not matched and referencia:
                matched = _resolve_producto_by_referencia(referencia, casa_comercial_id)
                if matched:
                    matched_via_identity = True

            oem_matches_dict = {}
            for code in oem.split(","):
                code = code.strip()
                if not code:
                    continue
                for m in oem_matches_by_code.get(code.lower(), []):
                    oem_matches_dict[m["producto_id"]] = m
            oem_matches = list(oem_matches_dict.values())

            # Si el Excel solo trae OEM (sin código ni referencia, o con datos
            # que no encontraron producto), y ese OEM identifica sin ambigüedad
            # un único producto del catálogo, se usa para vincular la fila igual
            # que si hubiera traído código o referencia. Referencia u OEM son
            # identificadores alternativos: basta con uno de los dos.
            if not matched and len(oem_matches) == 1:
                matched = Producto.objects.filter(pk=oem_matches[0]["producto_id"]).first()
                # matched_via_identity se deja en False: ver comentario arriba.

            if matched and casa_comercial_id:
                casas_ids = list(matched.casas_comerciales.values_list("id", flat=True))
                if casas_ids and casa_comercial_id not in casas_ids:
                    if matched_via_identity:
                        # Product is linked to other casa(s) but not the selected one
                        otra = matched.casas_comerciales.exclude(id=casa_comercial_id).first()
                        conflicto_casa = True
                        conflicto_casa_nombre = otra.nombre if otra else "otra casa comercial"
                    # Si el match fue solo por OEM, no es un conflicto: se
                    # descarta el match (matched = None) y la fila sigue como
                    # sin catálogo, para que el frontend pueda sugerir un
                    # código nuevo a partir de oem_matches (igual que cuando
                    # el OEM es ambiguo entre varias casas).
                    matched = None  # treat as unmatched so it never enters the import

            # Si el producto ya existe (por código, referencia u OEM), completa
            # código/referencia/descripción con los datos del catálogo cuando el
            # Excel no los trae: cualquiera de esos identificadores solo ya
            # identifica el producto.
            if matched:
                if not codigo:
                    codigo = matched.codigo
                if not referencia:
                    referencia = matched.referencia or ""
                if not descripcion:
                    descripcion = matched.nombre or ""

            faltan_datos = []
            if not conflicto_casa:
                # Referencia u OEM identifican el producto (ver
                # ImportacionDetalleSerializer.validate): basta con que el Excel
                # traiga uno de los dos, no hace falta ambos ni que el producto
                # ya exista en el catálogo.
                if not referencia and not oem:
                    faltan_datos.append("Referencia u OEM")
                # La cantidad solo es obligatoria si el producto ya existe en el
                # catálogo: ahí sí se está registrando una entrada real de stock.
                # Un producto pendiente (sin vincular a uno existente) se puede
                # crear con cantidad 0 y pedir unidades después, así que no
                # bloquea este paso (ver ImportacionDetalleSerializer.validate).
                if matched and cantidad <= 0:
                    faltan_datos.append("Cantidad")
                # La descripción de un producto pendiente ya no bloquea este
                # paso: se completa directamente en la revisión (paso 3), igual
                # que el precio de un producto nuevo con código sugerido.

            suc_quantities = {}
            for idx, suc_id in sucursal_col_ids.items():
                if suc_id is None or idx >= len(row):
                    continue
                qty = safe_int(row[idx])
                if qty > 0:
                    suc_quantities[str(suc_id)] = qty

            parsed.append({
                "fila_excel": fila_excel,
                # Orden real del producto (de la columna "Orden" del Excel si
                # ya la traía, o la fila del archivo si es la primera vez que
                # se sube) -- se guarda sin mostrarse en ninguna tabla de la
                # app, solo para poder exportarlo de vuelta como primera
                # columna al descargar el Excel de una importacion.
                "orden": orden,
                "codigo": codigo,
                "referencia": referencia,
                "oem": oem,
                "descripcion": descripcion,
                "cantidad": cantidad,
                "pvp": round(pvp, 2),
                "matched_producto_id": matched.id if matched else None,
                "matched_producto_codigo": matched.codigo if matched else None,
                "matched_producto_nombre": matched.nombre if matched else None,
                "matched_producto_referencia": matched.referencia if matched else None,
                # Lista completa (un producto puede tener varias referencias)
                # -- se usa para no marcar "conflicto" cuando la referencia
                # del Excel es una de las que el producto ya tiene, aunque no
                # sea la primera/principal.
                "matched_producto_referencias": (
                    list(matched.referencias.values_list("valor", flat=True)) if matched else []
                ),
                "matched_producto_precio": float(matched.precio) if matched and matched.precio is not None else None,
                "oem_matches": oem_matches,
                "sucursal_quantities": suc_quantities,
                "conflicto_casa": conflicto_casa,
                "conflicto_casa_nombre": conflicto_casa_nombre,
                "faltan_datos": faltan_datos,
            })

            if i % 10 == 0 or i == total_data_rows:
                set_progress(20 + (i / total_data_rows) * 75)

        if not parsed:
            raise ValueError("No se encontraron filas con datos válidos (cantidad > 0).")

        ImportacionExcelJob.objects.filter(pk=job_id).update(
            estado=ImportacionExcelJob.ESTADO_LISTO,
            progreso=100,
            resultado={"rows": parsed, "total": len(parsed)},
        )
    except Exception as exc:
        ImportacionExcelJob.objects.filter(pk=job_id).update(
            estado=ImportacionExcelJob.ESTADO_ERROR,
            progreso=100,
            error=str(exc) or "No se pudo procesar el archivo.",
        )
    finally:
        connections.close_all()


class ImportacionViewSet(viewsets.ModelViewSet):
    serializer_class = ImportacionSerializer
    permission_classes = [IsAuthenticated, ImportacionesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]

    def get_permissions(self):
        if self.action in (
            "envios_pendientes",
            "guardar_borrador_recepcion_envio",
            "recibir_parcial_envio",
            "guardar_ubicaciones_envio",
            "confirmar_recepcion_envio",
            "importacion_inconvenientes",
            "resolver_importacion_inconveniente",
        ):
            return [IsAuthenticated()]
        return super().get_permissions()

    @staticmethod
    def _resolve_user_display(user):
        if user is None:
            return ""
        full_name = str(getattr(user, "get_full_name", lambda: "")() or "").strip()
        if full_name:
            return full_name
        return str(getattr(user, "email", "") or "").strip()

    def _serialize_importacion_inconveniente(self, inconveniente):
        historial_rows = list(
            sorted(
                inconveniente.historial.all(), key=lambda row: (row.created_at, row.id), reverse=True
            )
        )
        historial_payload = [
            {
                "id": int(row.id),
                "accion": str(row.accion or "").strip(),
                "detalle": str(row.detalle or "").strip(),
                "actor_id": int(row.actor_id) if row.actor_id else None,
                "actor_nombre": self._resolve_user_display(getattr(row, "actor", None)),
                "created_at": row.created_at,
            }
            for row in historial_rows
        ]

        return {
            "id": int(inconveniente.id),
            "importacion_id": int(inconveniente.importacion_id),
            "importacion_codigo": str(getattr(inconveniente.importacion, "codigo", "") or "").strip(),
            "casa_comercial_nombre": str(
                getattr(getattr(inconveniente.importacion, "casa_comercial", None), "nombre", "") or ""
            ).strip(),
            "producto_id": int(inconveniente.producto_id),
            "producto_codigo": str(getattr(getattr(inconveniente, "producto", None), "codigo", "") or "").strip(),
            "producto_nombre": str(getattr(getattr(inconveniente, "producto", None), "nombre", "") or "").strip(),
            "tipo": str(inconveniente.tipo or "faltante").strip(),
            "cantidad_esperada": int(inconveniente.cantidad_esperada or 0),
            "cantidad_recibida": int(inconveniente.cantidad_recibida or 0),
            "cantidad_diferencia": int(inconveniente.cantidad_diferencia or 0),
            "estado": str(inconveniente.estado or "").strip(),
            "resolucion": str(inconveniente.resolucion or "").strip(),
            "motivo": str(inconveniente.motivo or "").strip(),
            "cantidad_prometida": (
                int(inconveniente.cantidad_prometida) if inconveniente.cantidad_prometida is not None else None
            ),
            "fecha_entrega_prometida": inconveniente.fecha_entrega_prometida,
            "creado_por_id": int(inconveniente.creado_por_id) if inconveniente.creado_por_id else None,
            "creado_por_nombre": self._resolve_user_display(getattr(inconveniente, "creado_por", None)),
            "resuelto_por_id": int(inconveniente.resuelto_por_id) if inconveniente.resuelto_por_id else None,
            "resuelto_por_nombre": self._resolve_user_display(getattr(inconveniente, "resuelto_por", None)),
            "created_at": inconveniente.created_at,
            "updated_at": inconveniente.updated_at,
            "historial": historial_payload,
        }

    def _check_specific_importacion_permission(self, request, flag_name):
        """Verifica un permiso específico de importaciones (puede_importar, puede_marcar_llegada)."""
        if is_app_admin(request.user):
            return True
        return UsuarioModuloSucursal.objects.filter(
            usuario=request.user,
            modulo=RolPermiso.Modulos.IMPORTACIONES,
            **{flag_name: True},
        ).exists()

    search_fields = [
        "codigo",
        "casa_comercial__nombre",
        "detalles__producto__codigo",
        "detalles__producto__nombre",
        "detalles__producto__referencia",
        "detalles__producto__referencias__valor",
        "detalles__producto__oem_productos__oem__codigo",
        "detalles__codigo",
        "detalles__nombre",
        "detalles__oem",
        "detalles__referencia",
    ]
    ordering_fields = ["codigo", "fecha", "creado_en", "casa_comercial__nombre"]

    @transaction.atomic
    def create(self, request, *args, **kwargs):
        detalles_raw = request.data.get("detalles") if isinstance(request.data, dict) else []
        referencia_updates = {}
        for item in (detalles_raw or []):
            pid = item.get("producto_id")
            nueva_ref = str(item.get("nueva_referencia") or "").strip()
            if pid and item.get("update_referencia") and nueva_ref:
                try:
                    referencia_updates[int(pid)] = nueva_ref
                except (ValueError, TypeError):
                    pass
        response = super().create(request, *args, **kwargs)
        if referencia_updates and response.status_code == status.HTTP_201_CREATED:
            # Un producto puede tener varias referencias: la del Excel se
            # agrega a la lista del producto sin borrar las que ya tenía
            # (add_producto_referencia deduplica si ya la tiene).
            for pid, nueva_ref in referencia_updates.items():
                producto = Producto.objects.filter(pk=pid).first()
                if producto:
                    add_producto_referencia(producto, nueva_ref)
        return response

    def get_queryset(self):
        queryset = (
            Importacion.objects.select_related("casa_comercial")
            .prefetch_related(
                "detalles",
                "detalles__producto",
                "detalles__producto__casas_comerciales",
                "detalles__producto__oem_productos__oem",
                "en_camino_generadas",
            )
            .all()
            .distinct()
        )
        estado = str(self.request.query_params.get("estado") or "").strip()
        if estado:
            queryset = queryset.filter(estado=estado)
        casa_comercial_id = str(self.request.query_params.get("casa_comercial_id") or "").strip()
        if casa_comercial_id:
            queryset = queryset.filter(casa_comercial_id=casa_comercial_id)
        return queryset

    @action(detail=False, methods=["get"], url_path="buscar")
    def buscar(self, request):
        """
        Busca importaciones (en cualquier paso) por codigo de producto,
        nombre, referencia u OEM -- ya sea del catalogo o de una linea sin
        vincular (importacion pendiente/en camino/etc). Devuelve un listado
        liviano con el paso (estado) en el que esta cada resultado.
        """
        term = (request.query_params.get("q") or "").strip()
        if len(term) < 2:
            return Response([])

        matches = (
            Importacion.objects.select_related("casa_comercial")
            .prefetch_related(
                "detalles__producto__oem_productos__oem",
                "detalles__producto__referencias",
            )
            .filter(
                Q(codigo__icontains=term)
                | Q(detalles__producto__codigo__icontains=term)
                | Q(detalles__producto__nombre__icontains=term)
                | Q(detalles__producto__referencia__icontains=term)
                | Q(detalles__producto__referencias__valor__icontains=term)
                | Q(detalles__producto__oem_productos__oem__codigo__icontains=term)
                | Q(detalles__codigo__icontains=term)
                | Q(detalles__nombre__icontains=term)
                | Q(detalles__oem__icontains=term)
                | Q(detalles__referencia__icontains=term)
            )
            .distinct()
            .order_by("-creado_en")[:30]
        )

        term_lower = term.lower()

        def detalle_matches(detalle):
            candidates = [detalle.codigo, detalle.nombre, detalle.oem, detalle.referencia]
            producto = detalle.producto
            if producto is not None:
                candidates.extend([producto.codigo, producto.nombre, producto.referencia])
                candidates.extend(
                    op.oem.codigo for op in producto.oem_productos.all() if op.oem_id
                )
                candidates.extend(
                    ref.valor for ref in producto.referencias.all() if ref.valor
                )
            return any(term_lower in str(candidate or "").lower() for candidate in candidates)

        payload = []
        for imp in matches:
            matched_detalle = next(
                (d for d in imp.detalles.all() if detalle_matches(d)), None
            )
            producto = getattr(matched_detalle, "producto", None) if matched_detalle else None
            payload.append(
                {
                    "id": int(imp.id),
                    "codigo": str(imp.codigo or "").strip(),
                    "estado": imp.estado,
                    "estado_label": imp.get_estado_display(),
                    "casa_comercial_nombre": str(
                        getattr(imp.casa_comercial, "nombre", "") or ""
                    ).strip(),
                    "producto_codigo": str(
                        (producto.codigo if producto else getattr(matched_detalle, "codigo", "")) or ""
                    ).strip(),
                    "producto_nombre": str(
                        (producto.nombre if producto else getattr(matched_detalle, "nombre", "")) or ""
                    ).strip(),
                }
            )
        return Response(payload)

    @transaction.atomic
    @action(detail=True, methods=["post"], url_path="pedir-cotizacion")
    def pedir_cotizacion(self, request, pk=None):
        if not self._check_specific_importacion_permission(request, "puede_importar"):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta acción."},
                status=status.HTTP_403_FORBIDDEN,
            )
        instance = self.get_object()
        if instance.estado != Importacion.ESTADO_BORRADOR:
            return Response(
                {"detail": "Solo se puede pedir cotización desde estado borrador."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        instance.estado = Importacion.ESTADO_COTIZACION
        instance.save(update_fields=["estado"])
        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    @transaction.atomic
    @action(detail=True, methods=["post"], url_path="confirmar")
    def confirmar(self, request, pk=None):
        if not self._check_specific_importacion_permission(request, "puede_importar"):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta acción."},
                status=status.HTTP_403_FORBIDDEN,
            )
        instance = self.get_object()
        if instance.estado != Importacion.ESTADO_COTIZACION:
            return Response(
                {"detail": "Solo se puede confirmar desde estado cotización."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        instance.estado = Importacion.ESTADO_CONFIRMACION
        instance.save(update_fields=["estado"])
        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    @transaction.atomic
    @action(detail=True, methods=["post"], url_path="importar")
    def importar(self, request, pk=None):
        if not self._check_specific_importacion_permission(request, "puede_importar"):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta acción."},
                status=status.HTTP_403_FORBIDDEN,
            )
        instance = self.get_object()
        if instance.estado not in (Importacion.ESTADO_COTIZACION, Importacion.ESTADO_CONFIRMACION):
            return Response(
                {"detail": "Solo se puede importar desde estado cotización o confirmación."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if instance.numero_factura:
            return Response(
                {"detail": "Esta importación ya fue importada."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        numero_factura = str(request.data.get("numero_factura") or "").strip()
        if not numero_factura:
            return Response(
                {"detail": "El número de factura es requerido."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        fecha_raw = str(request.data.get("fecha_importacion") or "").strip()
        try:
            from datetime import date
            fecha_importacion = date.fromisoformat(fecha_raw) if fecha_raw else timezone.localdate()
        except ValueError:
            fecha_importacion = timezone.localdate()

        # Keys of reviewed items: String(producto_id) or "sc_{detalle_id}"
        selected_keys = set(str(k) for k in (request.data.get("detalles_seleccionados") or []))
        x_keys = set(str(k) for k in (request.data.get("detalles_x") or []))
        if not selected_keys:
            return Response(
                {"detail": "Selecciona al menos un producto para importar."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Build confirmed-data lookup from submitted detalles. detalle_id is the
        # authoritative key (unambiguous for both catalogued and sin-catálogo
        # items); producto_id is kept only as a fallback for older clients.
        detalles_payload = request.data.get("detalles") or []
        confirmed_by_detalle_id = {}
        confirmed_by_producto_id = {}
        for d in detalles_payload:
            if d.get("detalle_id") is not None:
                confirmed_by_detalle_id[str(d["detalle_id"])] = d
            if d.get("producto_id"):
                confirmed_by_producto_id[str(d["producto_id"])] = d

        # 1. Snapshot every reviewed detalle (checked, x'd, or untouched) with its
        # confirmed price/quantity/comment before anything is removed, so the
        # confirmación review (checks, x's, comments) stays visible via "Historial"
        # even after this importación moves past confirmación — no second record
        # is spawned anymore.
        historial = []
        detalles_to_delete = []
        for detalle in instance.detalles.select_related("producto").all():
            key = str(detalle.producto_id) if detalle.producto_id else f"sc_{detalle.id}"
            confirmed = confirmed_by_detalle_id.get(str(detalle.id)) or confirmed_by_producto_id.get(key, {})
            precio_raw = confirmed.get("precio_confirmado")
            cant_raw = confirmed.get("cantidad_confirmada")
            if precio_raw not in (None, ""):
                try:
                    detalle.precio_confirmado = float(precio_raw)
                except (TypeError, ValueError):
                    pass
            if cant_raw not in (None, ""):
                try:
                    detalle.cantidad_confirmada = int(cant_raw)
                except (TypeError, ValueError):
                    pass
            comentario = confirmed.get("comentario")
            if comentario is not None:
                detalle.comentario = str(comentario)

            if key in selected_keys:
                revision = "check"
            elif key in x_keys:
                revision = "x"
            else:
                revision = None
            detalle.seleccionado = revision == "check"

            historial.append({
                "codigo": (detalle.producto.codigo if detalle.producto_id else detalle.codigo) or "",
                "nombre": (detalle.producto.nombre if detalle.producto_id else detalle.nombre) or "",
                "referencia": (detalle.producto.referencia if detalle.producto_id else detalle.referencia) or "",
                "cantidad": detalle.cantidad,
                "cantidad_confirmada": detalle.cantidad_confirmada,
                "precio_confirmado": str(detalle.precio_confirmado) if detalle.precio_confirmado is not None else None,
                "comentario": detalle.comentario or "",
                "estado": revision,
            })

            if revision == "check":
                detalle.cantidad = detalle.cantidad_confirmada if detalle.cantidad_confirmada is not None else detalle.cantidad
                detalle.precio_pvp_snapshot = detalle.producto.precio if detalle.producto_id else None
                detalle.save(update_fields=["precio_confirmado", "cantidad_confirmada", "comentario", "seleccionado", "cantidad", "precio_pvp_snapshot"])
            else:
                detalles_to_delete.append(detalle.id)

        # Items left unchecked or marked with "x" don't continue in the actual
        # shipment; their review data already lives in historial_confirmacion.
        if detalles_to_delete:
            ImportacionDetalle.objects.filter(id__in=detalles_to_delete).delete()

        # El precio se actualiza al marcar llegada (ver marcar_llegada), que es
        # cuando se reparten las cantidades a las sucursales -- no aqui.

        # 2. Transition this same importación into en_camino instead of spawning
        # a separate record for it.
        instance.estado = Importacion.ESTADO_EN_CAMINO
        instance.numero_factura = numero_factura
        instance.fecha_importacion = fecha_importacion
        instance.fecha = fecha_importacion
        instance.historial_confirmacion = historial
        instance.save(update_fields=["estado", "numero_factura", "fecha_importacion", "fecha", "historial_confirmacion"])

        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    @staticmethod
    def _smart_average(tiempos):
        """
        Weighted average that discards outliers using Modified Z-score (MAD method).
        With values like [1, 41, 42, 42, 43] it excludes the lone 1 and returns ~42.
        """
        if not tiempos:
            return None
        if len(tiempos) <= 2:
            return round(sum(tiempos) / len(tiempos))

        med = statistics.median(tiempos)
        deviations = [abs(x - med) for x in tiempos]
        mad = statistics.median(deviations)

        if mad == 0:
            return round(med)

        scale = 1.4826 * mad
        filtered = [x for x, d in zip(tiempos, deviations) if (d / scale) <= 3.5]

        if not filtered:
            filtered = tiempos

        return round(sum(filtered) / len(filtered))

    @transaction.atomic
    @action(detail=True, methods=["post"], url_path="marcar-llegada")
    def marcar_llegada(self, request, pk=None):
        if not self._check_specific_importacion_permission(request, "puede_marcar_llegada"):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta acción."},
                status=status.HTTP_403_FORBIDDEN,
            )
        instance = self.get_object()
        if instance.estado != Importacion.ESTADO_EN_CAMINO:
            return Response(
                {"detail": "Solo se puede marcar llegada desde estado en camino."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        fecha_llegada_raw = str(request.data.get("fecha_llegada") or "").strip()
        try:
            from datetime import date
            fecha_llegada = date.fromisoformat(fecha_llegada_raw) if fecha_llegada_raw else timezone.localdate()
        except ValueError:
            fecha_llegada = timezone.localdate()

        start = instance.fecha_importacion or instance.fecha
        dias_reales = (fecha_llegada - start).days if start else None

        instance.estado = Importacion.ESTADO_IMPORTADA
        instance.fecha_llegada = fecha_llegada
        instance.dias_reales_entrega = dias_reales
        instance.borrador_llegada = None
        instance.save()

        # Register cantidad recibida per detalle and log faltante/sobrante inconvenientes
        inconvenientes_resumen = []
        for revision in request.data.get("revisiones", []):
            try:
                detalle_id = revision.get("detalle_id")
                cantidad_recibida = int(revision.get("cantidad_recibida"))
                if cantidad_recibida < 0 or not detalle_id:
                    continue
                detalle = instance.detalles.select_related("producto").get(pk=detalle_id)
            except Exception:
                continue
            if not detalle.producto_id:
                continue

            detalle.cantidad_recibida = cantidad_recibida
            detalle.save(update_fields=["cantidad_recibida"])

            cantidad_esperada = int(detalle.cantidad or 0)
            if cantidad_recibida == cantidad_esperada:
                continue

            tipo = (
                ImportacionInconveniente.Tipos.FALTANTE
                if cantidad_recibida < cantidad_esperada
                else ImportacionInconveniente.Tipos.SOBRANTE
            )
            diferencia = abs(cantidad_esperada - cantidad_recibida)
            inconveniente = ImportacionInconveniente.objects.create(
                importacion=instance,
                detalle=detalle,
                producto_id=detalle.producto_id,
                tipo=tipo,
                cantidad_esperada=cantidad_esperada,
                cantidad_recibida=cantidad_recibida,
                cantidad_diferencia=diferencia,
                estado=ImportacionInconveniente.Estados.PENDIENTE,
                creado_por=request.user,
            )
            tipo_label = "faltante" if tipo == ImportacionInconveniente.Tipos.FALTANTE else "sobrante"
            ImportacionInconvenienteHistorial.objects.create(
                inconveniente=inconveniente,
                accion="detectado",
                detalle=(
                    f"Se detecto un {tipo_label} de {diferencia} unidades al revisar la llegada. "
                    f"Esperado: {cantidad_esperada}, recibido: {cantidad_recibida}."
                ),
                actor=request.user,
            )
            producto_label = (
                detalle.producto.nombre or detalle.producto.codigo or f"Producto {detalle.producto_id}"
            )
            verbo = "faltan" if tipo == ImportacionInconveniente.Tipos.FALTANTE else "sobran"
            inconvenientes_resumen.append(f"{producto_label}: {verbo} {diferencia}")

        # Recalculate casa_comercial.dias_entrega from last 5 real delivery times
        if dias_reales is not None:
            ultimos = list(
                Importacion.objects.filter(
                    casa_comercial=instance.casa_comercial,
                    dias_reales_entrega__isnull=False,
                )
                .order_by("-id")
                .values_list("dias_reales_entrega", flat=True)[:5]
            )
            nuevo_promedio = self._smart_average(ultimos)
            if nuevo_promedio is not None and nuevo_promedio > 0:
                instance.casa_comercial.dias_entrega = nuevo_promedio
                instance.casa_comercial.save(update_fields=["dias_entrega"])

        # Group distributions by sucursal and create ImportacionEnvio records
        envios_by_sucursal = {}
        for dist in request.data.get("distribuciones", []):
            try:
                detalle_id = dist.get("detalle_id")
                sucursal_id = int(dist.get("sucursal_id") or 0)
                cantidad = int(dist.get("cantidad") or 0)
                if cantidad <= 0 or not detalle_id or not sucursal_id:
                    continue
                detalle = instance.detalles.select_related("producto").get(pk=detalle_id)
                if not detalle.producto_id:
                    continue
                envios_by_sucursal.setdefault(sucursal_id, []).append(
                    {"producto_id": detalle.producto_id, "cantidad": cantidad}
                )
            except Exception:
                continue

        for sucursal_id, items in envios_by_sucursal.items():
            envio = ImportacionEnvio.objects.create(
                importacion=instance,
                sucursal_id=sucursal_id,
            )
            ImportacionEnvioDetalle.objects.bulk_create([
                ImportacionEnvioDetalle(
                    envio=envio,
                    producto_id=item["producto_id"],
                    cantidad=item["cantidad"],
                )
                for item in items
            ])

        # El precio se aplica al catalogo justo aqui -- el mismo momento en que
        # se reparten las cantidades a las sucursales -- no antes (al aceptar,
        # cuando el precio todavia puede ajustarse) ni despues (al confirmar
        # recepcion en cada sucursal, que puede tardar dias/semanas).
        precio_by_producto = {
            d.producto_id: d.precio_confirmado
            for d in instance.detalles.filter(precio_confirmado__isnull=False)
            if d.producto_id
        }
        for product_id, nuevo_precio in precio_by_producto.items():
            Producto.objects.filter(pk=product_id).update(precio=nuevo_precio)

        # Create reminders for selected recipients per sucursal
        for dest in request.data.get("destinatarios_por_sucursal", []):
            sucursal_id = dest.get("sucursal_id")
            user_ids = dest.get("user_ids", [])
            if user_ids and sucursal_id:
                self._create_importacion_reminder(instance, sucursal_id, user_ids, request.user)

        # Single reminder to all admins automatically
        User = get_user_model()
        admin_ids = [u.pk for u in User.objects.filter(is_active=True) if is_app_admin(u)]
        if admin_ids:
            self._create_importacion_reminder(
                instance, None, admin_ids, request.user, inconvenientes_resumen=inconvenientes_resumen
            )

        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    @action(detail=True, methods=["post"], url_path="guardar-borrador-llegada")
    def guardar_borrador_llegada(self, request, pk=None):
        """Guarda el progreso del asistente de llegada (paso, revisados, cantidades
        recibidas, distribución, destinatarios) para poder continuarlo al reabrirlo."""
        if not self._check_specific_importacion_permission(request, "puede_marcar_llegada"):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta acción."},
                status=status.HTTP_403_FORBIDDEN,
            )
        instance = self.get_object()
        if instance.estado != Importacion.ESTADO_EN_CAMINO:
            return Response(
                {"detail": "Solo se puede guardar el progreso desde estado en camino."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        instance.borrador_llegada = request.data.get("borrador") or None
        instance.save(update_fields=["borrador_llegada"])

        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    @action(detail=True, methods=["post"], url_path="actualizar-fecha-tracker")
    def actualizar_fecha_tracker(self, request, pk=None):
        """Edita las fechas del seguimiento en camino (salida del proveedor / llegada
        a puerto). La fecha de llegada final no se edita aquí, se fija al marcar llegada."""
        if not self._check_specific_importacion_permission(request, "puede_marcar_llegada"):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta acción."},
                status=status.HTTP_403_FORBIDDEN,
            )
        instance = self.get_object()
        if instance.estado != Importacion.ESTADO_EN_CAMINO:
            return Response(
                {"detail": "Solo se puede editar el seguimiento mientras está en camino."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        campo = str(request.data.get("campo") or "").strip()
        if campo not in {"fecha_importacion", "fecha_puerto"}:
            return Response(
                {"detail": "Debes indicar un campo válido: fecha_importacion o fecha_puerto."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        fecha_raw = str(request.data.get("fecha") or "").strip()
        fecha_valor = None
        if fecha_raw:
            try:
                from datetime import date
                fecha_valor = date.fromisoformat(fecha_raw)
            except ValueError:
                return Response({"detail": "Fecha inválida."}, status=status.HTTP_400_BAD_REQUEST)

        update_fields = [campo]
        setattr(instance, campo, fecha_valor)
        if campo == "fecha_importacion" and fecha_valor is not None:
            instance.fecha = fecha_valor
            update_fields.append("fecha")
        instance.save(update_fields=update_fields)

        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    @action(detail=False, methods=["get"], url_path="inconvenientes")
    def importacion_inconvenientes(self, request):
        if not is_app_admin(request.user):
            return Response(
                {"detail": "Solo los administradores pueden consultar inconvenientes de importaciones."},
                status=status.HTTP_403_FORBIDDEN,
            )

        queryset = (
            ImportacionInconveniente.objects.select_related(
                "importacion",
                "importacion__casa_comercial",
                "producto",
                "creado_por",
                "resuelto_por",
            )
            .prefetch_related("historial__actor")
            .order_by("-created_at", "-id")
        )

        estado = str(request.query_params.get("estado") or "").strip().lower()
        if estado in {
            ImportacionInconveniente.Estados.PENDIENTE,
            ImportacionInconveniente.Estados.RECLAMADO,
            ImportacionInconveniente.Estados.RESUELTO,
            ImportacionInconveniente.Estados.PERDIDO,
        }:
            queryset = queryset.filter(estado=estado)

        # La barra lateral solo necesita saber si hay pendientes.
        if str(request.query_params.get("solo_conteo") or "").strip() in {"1", "true"}:
            return Response({"count": queryset.count()}, status=status.HTTP_200_OK)

        payload = [self._serialize_importacion_inconveniente(row) for row in queryset]
        attach_product_search(payload)
        return Response(payload, status=status.HTTP_200_OK)

    @action(
        detail=False,
        methods=["post"],
        url_path=r"inconvenientes/(?P<inconveniente_id>\d+)/resolver",
    )
    def resolver_importacion_inconveniente(self, request, inconveniente_id=None):
        if not is_app_admin(request.user):
            return Response(
                {"detail": "Solo los administradores pueden resolver inconvenientes de importaciones."},
                status=status.HTTP_403_FORBIDDEN,
            )

        inconveniente = (
            ImportacionInconveniente.objects.select_related("importacion", "producto")
            .filter(pk=inconveniente_id)
            .first()
        )
        if inconveniente is None:
            return Response(
                {"detail": "No se encontro el inconveniente de importacion."},
                status=status.HTTP_404_NOT_FOUND,
            )
        estados_accionables = {
            ImportacionInconveniente.Estados.PENDIENTE,
            ImportacionInconveniente.Estados.RECLAMADO,
        }
        if inconveniente.estado not in estados_accionables:
            return Response(
                {"detail": "Este inconveniente ya fue resuelto."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        decision = str(request.data.get("decision") or "").strip().lower()
        motivo = str(request.data.get("motivo") or "").strip()

        if inconveniente.estado == ImportacionInconveniente.Estados.RECLAMADO:
            valid_decisions = {"olvidar", "solucion"}
        else:
            es_sobrante = inconveniente.tipo == ImportacionInconveniente.Tipos.SOBRANTE
            valid_decisions = {"devolver_proveedor", "aceptado"} if es_sobrante else {"aceptado", "reportado_proveedor"}
        if decision not in valid_decisions:
            return Response(
                {"detail": f"Debes enviar una decision valida: {' o '.join(sorted(valid_decisions))}."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        cantidad_prometida = None
        fecha_entrega_prometida = None
        if decision == "solucion":
            try:
                cantidad_prometida = int(request.data.get("cantidad_prometida"))
            except (TypeError, ValueError):
                cantidad_prometida = None
            if not cantidad_prometida or cantidad_prometida <= 0:
                return Response(
                    {"detail": "Debes indicar la cantidad que enviara el proveedor."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            fecha_raw = str(request.data.get("fecha_entrega_prometida") or "").strip()
            try:
                from datetime import date as date_cls
                fecha_entrega_prometida = date_cls.fromisoformat(fecha_raw) if fecha_raw else None
            except ValueError:
                fecha_entrega_prometida = None
            if fecha_entrega_prometida is None:
                return Response(
                    {"detail": "Debes indicar la fecha de entrega acordada con el proveedor."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        with transaction.atomic():
            inconveniente_locked = (
                ImportacionInconveniente.objects.select_for_update(of=("self",))
                .select_related("importacion", "importacion__casa_comercial", "producto")
                .filter(pk=inconveniente.id)
                .first()
            )
            if inconveniente_locked is None or inconveniente_locked.estado not in estados_accionables:
                return Response(
                    {"detail": "Este inconveniente ya fue resuelto."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if decision == "reportado_proveedor":
                resolucion = ImportacionInconveniente.Resoluciones.REPORTADO_PROVEEDOR
                estado_resultado = ImportacionInconveniente.Estados.RECLAMADO
                action_label = "reclamado_a_proveedor"
            elif decision == "devolver_proveedor":
                resolucion = ImportacionInconveniente.Resoluciones.DEVOLVER_PROVEEDOR
                estado_resultado = ImportacionInconveniente.Estados.RESUELTO
                action_label = "devuelto_a_proveedor"
            elif decision == "olvidar":
                resolucion = ImportacionInconveniente.Resoluciones.PERDIDO
                estado_resultado = ImportacionInconveniente.Estados.PERDIDO
                action_label = "olvidado"
            elif decision == "solucion":
                resolucion = ImportacionInconveniente.Resoluciones.REPOSICION_ACORDADA
                estado_resultado = ImportacionInconveniente.Estados.RESUELTO
                action_label = "solucion_acordada"
            else:
                resolucion = ImportacionInconveniente.Resoluciones.ACEPTADO
                estado_resultado = ImportacionInconveniente.Estados.RESUELTO
                action_label = "aceptado_sin_cambios"

            inconveniente_locked.estado = estado_resultado
            inconveniente_locked.resolucion = resolucion
            inconveniente_locked.motivo = motivo
            inconveniente_locked.resuelto_por = request.user
            update_fields = ["estado", "resolucion", "motivo", "resuelto_por", "updated_at"]
            if decision == "solucion":
                inconveniente_locked.cantidad_prometida = cantidad_prometida
                inconveniente_locked.fecha_entrega_prometida = fecha_entrega_prometida
                update_fields += ["cantidad_prometida", "fecha_entrega_prometida"]
            inconveniente_locked.save(update_fields=update_fields)

            tipo_label = "faltante" if inconveniente_locked.tipo == ImportacionInconveniente.Tipos.FALTANTE else "sobrante"
            if decision == "reportado_proveedor":
                detail_text = (
                    f"Se genero un reclamo al proveedor por el {tipo_label} de "
                    f"{inconveniente_locked.cantidad_diferencia} unidades."
                )
            elif decision == "olvidar":
                detail_text = (
                    f"Se decidio olvidar el proceso; el {tipo_label} de "
                    f"{inconveniente_locked.cantidad_diferencia} unidades queda como perdida."
                )
            elif decision == "solucion":
                detail_text = (
                    f"El proveedor acordo enviar {cantidad_prometida} unidades con fecha de entrega "
                    f"{fecha_entrega_prometida.isoformat()}."
                )
            else:
                detail_text = (
                    f"Se resolvio el {tipo_label} de {inconveniente_locked.cantidad_diferencia} unidades "
                    f"({resolucion})."
                )
            if motivo:
                detail_text = f"{detail_text} Motivo: {motivo}"

            ImportacionInconvenienteHistorial.objects.create(
                inconveniente=inconveniente_locked,
                accion=action_label,
                detalle=detail_text,
                actor=request.user,
            )

            inconveniente_out = (
                ImportacionInconveniente.objects.select_related("importacion", "importacion__casa_comercial", "producto")
                .prefetch_related("historial__actor")
                .filter(pk=inconveniente_locked.id)
                .first()
            )

        return Response(
            {
                "detail": "Inconveniente resuelto correctamente.",
                "inconveniente": self._serialize_importacion_inconveniente(inconveniente_out),
            },
            status=status.HTTP_200_OK,
        )

    def _create_importacion_reminder(
        self, importacion, sucursal_id, user_ids, actor_user, inconvenientes_resumen=None
    ):
        User = get_user_model()
        recipient_users = User.objects.filter(id__in=user_ids, is_active=True)
        recipients = [
            {"id": str(u.pk), "name": f"{u.first_name} {u.last_name}".strip() or u.username}
            for u in recipient_users
        ]
        if not recipients:
            return

        actor_name = f"{actor_user.first_name} {actor_user.last_name}".strip() or actor_user.username
        actor = {"id": str(actor_user.pk), "name": actor_name}
        now = timezone.localtime(timezone.now())
        created_at = timezone.now().isoformat()
        label = f"Importación {importacion.codigo}"
        if sucursal_id is None:
            if inconvenientes_resumen:
                description = (
                    f"La {label} ha sido recibida con inconvenientes de cantidad. "
                    f"{'; '.join(inconvenientes_resumen)}."
                )
            else:
                description = f"La {label} ha sido recibida y está siendo distribuida."
        else:
            description = f"Hay un envío en camino de {label} hacia tu sucursal."

        reminder = {
            "id": str(uuid4()),
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M"),
            "description": description,
            "creator": actor,
            "recipients": recipients,
            "context": {
                "type": "importacion",
                "id": str(importacion.pk),
                "label": label,
                "sucursal_destino_id": str(sucursal_id) if sucursal_id is not None else "",
            },
            "kind": "recordatorio_general",
            "createdAt": created_at,
            "decision": {"status": "enviado", "reason": "", "by": actor, "at": created_at, "assignedRecipients": []},
            "transferHistory": [{"stage": "enviado", "label": "Enviado", "description": description, "at": created_at, "actor": actor}],
            "completedBy": [],
        }

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            payload = store.payload if isinstance(store.payload, list) else []
            payload.insert(0, reminder)
            store.payload = payload
            store.save(update_fields=["payload", "updated_at"])

    @action(detail=False, methods=["post"], url_path="parse-excel-iniciar")
    def parse_excel_iniciar(self, request):
        file = request.FILES.get("file")
        if not file:
            return Response({"detail": "No se envió ningún archivo."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            file_bytes = file.read()
        except Exception:
            return Response({"detail": "No se pudo leer el archivo."}, status=status.HTTP_400_BAD_REQUEST)
        if not file_bytes:
            return Response({"detail": "El archivo está vacío."}, status=status.HTTP_400_BAD_REQUEST)

        try:
            casa_comercial_id = int(request.data.get("casa_comercial_id") or 0) or None
        except (ValueError, TypeError):
            casa_comercial_id = None

        job = ImportacionExcelJob.objects.create(
            creado_por=request.user if request.user.is_authenticated else None,
        )
        thread = threading.Thread(
            target=_run_parse_excel_job,
            args=(job.id, file_bytes, casa_comercial_id),
            daemon=True,
        )
        thread.start()
        return Response({"job_id": str(job.id)}, status=status.HTTP_202_ACCEPTED)

    @action(detail=False, methods=["get"], url_path=r"parse-excel-estado/(?P<job_id>[0-9a-fA-F-]+)")
    def parse_excel_estado(self, request, job_id=None):
        try:
            job = ImportacionExcelJob.objects.get(pk=job_id)
        except (ImportacionExcelJob.DoesNotExist, DjangoValidationError):
            return Response({"detail": "No se encontró el proceso solicitado."}, status=status.HTTP_404_NOT_FOUND)

        payload = {"job_id": str(job.id), "estado": job.estado, "progreso": job.progreso}
        if job.estado == ImportacionExcelJob.ESTADO_LISTO:
            resultado = job.resultado or {}
            payload["rows"] = resultado.get("rows", [])
            payload["total"] = resultado.get("total", 0)
        elif job.estado == ImportacionExcelJob.ESTADO_ERROR:
            payload["detail"] = job.error or "No se pudo procesar el archivo."
        return Response(payload, status=status.HTTP_200_OK)

    @action(detail=False, methods=["get"], url_path="envios-pendientes")
    def envios_pendientes(self, request):
        if is_app_admin(request.user):
            qs = ImportacionEnvio.objects.filter(estado=ImportacionEnvio.ESTADO_PENDIENTE)
        else:
            allowed_ids = get_readable_sucursal_ids(
                request.user, RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS
            )
            if allowed_ids is None:
                qs = ImportacionEnvio.objects.filter(estado=ImportacionEnvio.ESTADO_PENDIENTE)
            elif not allowed_ids:
                qs = ImportacionEnvio.objects.none()
            else:
                qs = ImportacionEnvio.objects.filter(
                    estado=ImportacionEnvio.ESTADO_PENDIENTE,
                    sucursal_id__in=allowed_ids,
                )

        qs = qs.select_related("importacion", "sucursal").prefetch_related(
            "detalles__producto"
        ).order_by("-fecha", "-id")

        payload = []
        for envio in qs:
            detalles_payload = [
                {
                    "detalle_id": int(d.id),
                    "producto_id": int(d.producto_id),
                    "producto_codigo": str(getattr(d.producto, "codigo", "") or "").strip(),
                    "producto_nombre": str(getattr(d.producto, "nombre", "") or "").strip(),
                    "cantidad_enviada": int(d.cantidad or 0),
                    "valor": 0,
                }
                for d in envio.detalles.all()
            ]
            payload.append({
                "id": int(envio.id),
                "envio_id": int(envio.id),
                "no_documento": str(envio.importacion.codigo or "").strip(),
                "fecha": envio.fecha,
                "sucursal_solicitante_id": int(envio.sucursal_id),
                "sucursal_solicitante": str(getattr(envio.sucursal, "nombre", "") or "").strip(),
                "sucursal_proveedora_id": None,
                "sucursal_proveedora": "Importación",
                "movimiento_salida_id": None,
                "movimiento_entrada_id": None,
                "estado_entrada": "Pendiente",
                "descripcion": f"Envío de Importación {envio.importacion.codigo}",
                "detalles": detalles_payload,
                "inconvenientes_pendientes": 0,
                "borrador_recepcion": envio.borrador_recepcion or {},
                "recepcion_progreso": (envio.recepcion_progreso, envio.sucursal_id),
                "_source": "importacion",
            })

        # Avance de todos los envios de una vez (antes 2 consultas por envio).
        for row, progreso in zip(payload, serialize_progress_many([row["recepcion_progreso"] for row in payload])):
            row["recepcion_progreso"] = progreso

        attach_product_search([detalle for row in payload for detalle in row.get("detalles", [])])
        return Response(payload, status=status.HTTP_200_OK)

    def _get_pending_envio_for_user(self, request, envio_id, *, lock=False):
        queryset = ImportacionEnvio.objects.filter(pk=envio_id, estado=ImportacionEnvio.ESTADO_PENDIENTE)
        if lock:
            queryset = queryset.select_for_update()
        envio = queryset.first()
        if envio is None:
            return None, Response(
                {"detail": "Envío no encontrado o ya recibido."},
                status=status.HTTP_404_NOT_FOUND,
            )
        if not is_app_admin(request.user):
            allowed_ids = get_readable_sucursal_ids(
                request.user, RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS
            )
            if allowed_ids is not None and int(envio.sucursal_id) not in set(allowed_ids):
                return None, Response(
                    {"detail": "Envío no encontrado o ya recibido."},
                    status=status.HTTP_404_NOT_FOUND,
                )
        return envio, None

    @action(detail=False, methods=["post"], url_path=r"envios/(?P<envio_id>\d+)/recibir-parcial")
    def recibir_parcial_envio(self, request, envio_id=None):
        """Recibe por partes: lo marcado entra ya al stock (en su ubicacion o
        en POR UBICAR) y se puede vender aunque falte guardarlo."""
        with transaction.atomic():
            envio, error = self._get_pending_envio_for_user(request, envio_id, lock=True)
            if error is not None:
                return error
            sent = {
                int(row["producto_id"]): int(row["cantidad"] or 0)
                for row in envio.detalles.values("producto_id", "cantidad")
            }
            try:
                progreso = receive_items(
                    progress=envio.recepcion_progreso,
                    sucursal_id=envio.sucursal_id,
                    items=request.data.get("items"),
                    sent_by_product=sent,
                )
            except RecepcionDesactualizada as exc:
                # Peticion repetida o vieja: no se suma nada y se devuelve el
                # avance real para que la pantalla se ponga al dia.
                # Se lee antes de marcar el rollback (despues ya no se puede consultar).
                progreso_actual = serialize_progress(envio.recepcion_progreso, envio.sucursal_id)
                transaction.set_rollback(True)
                return Response(
                    {
                        "detail": str(exc),
                        "desactualizada": True,
                        "recepcion_progreso": progreso_actual,
                    },
                    status=status.HTTP_409_CONFLICT,
                )
            except RecepcionError as exc:
                transaction.set_rollback(True)
                return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
            envio.recepcion_progreso = progreso
            envio.save(update_fields=["recepcion_progreso"])
        return Response(
            {"recepcion_progreso": serialize_progress(progreso, envio.sucursal_id)},
            status=status.HTTP_200_OK,
        )

    @action(detail=False, methods=["post"], url_path=r"envios/(?P<envio_id>\d+)/guardar-ubicaciones")
    def guardar_ubicaciones_envio(self, request, envio_id=None):
        """Mueve desde POR UBICAR a la ubicacion definitiva lo ya recibido."""
        with transaction.atomic():
            envio, error = self._get_pending_envio_for_user(request, envio_id, lock=True)
            if error is not None:
                return error
            try:
                progreso, _moved = store_items(
                    progress=envio.recepcion_progreso,
                    sucursal_id=envio.sucursal_id,
                    items=request.data.get("items"),
                )
            except RecepcionError as exc:
                transaction.set_rollback(True)
                return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
            envio.recepcion_progreso = progreso
            envio.save(update_fields=["recepcion_progreso"])
        return Response(
            {"recepcion_progreso": serialize_progress(progreso, envio.sucursal_id)},
            status=status.HTTP_200_OK,
        )

    @action(detail=False, methods=["patch"], url_path=r"envios/(?P<envio_id>\d+)/borrador-recepcion")
    def guardar_borrador_recepcion_envio(self, request, envio_id=None):
        envio = ImportacionEnvio.objects.filter(
            pk=envio_id, estado=ImportacionEnvio.ESTADO_PENDIENTE
        ).first()
        if envio is None:
            return Response(
                {"detail": "Envío no encontrado o ya recibido."},
                status=status.HTTP_404_NOT_FOUND,
            )
        if not is_app_admin(request.user):
            allowed_ids = get_readable_sucursal_ids(
                request.user, RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS
            )
            if allowed_ids is not None and int(envio.sucursal_id) not in set(allowed_ids):
                return Response(
                    {"detail": "Envío no encontrado o ya recibido."},
                    status=status.HTTP_404_NOT_FOUND,
                )

        items = request.data.get("items")
        if not isinstance(items, dict):
            return Response(
                {"detail": "Se esperaba un objeto en `items`."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        def _to_int(value):
            try:
                return int(value)
            except (TypeError, ValueError):
                return None

        borrador = {}
        for producto_id, data in items.items():
            if not isinstance(data, dict):
                continue
            qty = _to_int(data.get("cantidad_recibida"))
            ubicaciones = []
            for loc in data.get("ubicaciones") or []:
                if not isinstance(loc, dict):
                    continue
                subdivision_id = _to_int(loc.get("subdivision_id"))
                cantidad = _to_int(loc.get("cantidad"))
                if subdivision_id and cantidad is not None:
                    ubicaciones.append({"subdivision_id": subdivision_id, "cantidad": max(0, cantidad)})
            borrador[str(producto_id)] = {
                "cantidad_recibida": max(0, qty) if qty is not None else None,
                "recepcion_revisada": bool(data.get("recepcion_revisada", False)),
                "novedad": str(data.get("novedad") or "").strip(),
                "ubicaciones": ubicaciones,
            }

        # Nota general del envio ("hay una novedad general" + texto): tambien
        # va al servidor, no solo las filas. Se guarda bajo "__meta__", que no
        # choca con los ids de producto.
        if "nota_general" in request.data or "tiene_novedad_general" in request.data:
            borrador["__meta__"] = {
                "tiene_novedad_general": bool(request.data.get("tiene_novedad_general")),
                "nota_general": str(request.data.get("nota_general") or ""),
            }

        envio.borrador_recepcion = borrador
        envio.save(update_fields=["borrador_recepcion"])
        return Response({"ok": True}, status=status.HTTP_200_OK)

    @transaction.atomic
    @action(detail=False, methods=["post"], url_path=r"envios/(?P<envio_id>\d+)/confirmar-recepcion")
    def confirmar_recepcion_envio(self, request, envio_id=None):
        try:
            envio = (
                ImportacionEnvio.objects.select_related("importacion", "sucursal")
                .prefetch_related("detalles__producto")
                .get(pk=envio_id, estado=ImportacionEnvio.ESTADO_PENDIENTE)
            )
        except ImportacionEnvio.DoesNotExist:
            return Response(
                {"detail": "Envío no encontrado o ya recibido."},
                status=status.HTTP_404_NOT_FOUND,
            )

        items = request.data.get("items")
        if not isinstance(items, list) or not items:
            return Response(
                {"detail": "Debes enviar la lista de productos en `items`."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        detalles_by_producto = {int(d.producto_id): d for d in envio.detalles.all()}
        seen_product_ids = set()
        for raw_item in items:
            try:
                product_id = int(raw_item.get("producto_id"))
            except (TypeError, ValueError):
                return Response(
                    {"detail": "Cada item debe tener producto_id válido."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if product_id in seen_product_ids:
                return Response(
                    {"detail": "No puedes repetir el mismo producto."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            seen_product_ids.add(product_id)
            if product_id not in detalles_by_producto:
                return Response(
                    {"detail": f"El producto {product_id} no pertenece a este envío."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # El envio a la sucursal sale de lo ya recibido de la importacion:
            # recibir mas de lo enviado duplicaria stock.
            detalle = detalles_by_producto[product_id]
            try:
                cantidad_recibida = int(raw_item.get("cantidad_recibida") or 0)
            except (TypeError, ValueError):
                cantidad_recibida = -1
            if cantidad_recibida < 0:
                return Response(
                    {"detail": f"La cantidad recibida del producto {product_id} no es valida."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if cantidad_recibida > int(detalle.cantidad or 0):
                return Response(
                    {
                        "detail": (
                            f"No se puede recibir mas de lo enviado del producto "
                            f"{getattr(detalle.producto, 'codigo', product_id)}: se enviaron "
                            f"{int(detalle.cantidad or 0)} y se intento recibir {cantidad_recibida}."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

        with transaction.atomic():
            envio_locked = ImportacionEnvio.objects.select_for_update().get(pk=envio.pk)
            if envio_locked.estado != ImportacionEnvio.ESTADO_PENDIENTE:
                return Response(
                    {"detail": "El envío ya fue recibido."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if pending_to_store(envio_locked.recepcion_progreso, envio_locked.sucursal_id) > 0:
                return Response(
                    {"detail": "Guarda en su ubicacion los productos que quedaron en POR UBICAR antes de cerrar la recepcion."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # Lo recibido por partes ya esta en el stock: solo se suma la diferencia.
            ya_recibido_por_producto = received_by_product(envio_locked.recepcion_progreso)

            for raw_item in items:
                product_id = int(raw_item.get("producto_id"))
                cantidad_recibida = int(raw_item.get("cantidad_recibida") or 0)
                ya_recibido = int(ya_recibido_por_producto.get(product_id, 0))
                if cantidad_recibida < ya_recibido:
                    transaction.set_rollback(True)
                    return Response(
                        {
                            "detail": (
                                f"La cantidad recibida del producto {product_id} no puede ser menor "
                                f"a lo que ya se recibio ({ya_recibido})."
                            )
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                cantidad_recibida -= ya_recibido
                ubicaciones_raw = raw_item.get("ubicaciones") or []
                if ya_recibido and cantidad_recibida <= 0:
                    ubicaciones_raw = []

                if isinstance(ubicaciones_raw, list) and ubicaciones_raw:
                    for ub in ubicaciones_raw:
                        subdivision_id = int(ub.get("subdivision_id") or 0)
                        qty = int(ub.get("cantidad") or 0)
                        if subdivision_id and qty > 0:
                            inv, _ = Inventario.objects.get_or_create(
                                producto_id=product_id,
                                subdivision_id=subdivision_id,
                                referencia="",
                                defaults={"cantidad": 0},
                            )
                            Inventario.objects.filter(pk=inv.pk).update(cantidad=F("cantidad") + qty)
                elif cantidad_recibida > 0:
                    subdivision = SubDivision.objects.filter(
                        division__bodega__sucursal_id=envio.sucursal_id
                    ).first()
                    if subdivision:
                        inv, _ = Inventario.objects.get_or_create(
                            producto_id=product_id,
                            subdivision=subdivision,
                            referencia="",
                            defaults={"cantidad": 0},
                        )
                        Inventario.objects.filter(pk=inv.pk).update(
                            cantidad=F("cantidad") + cantidad_recibida
                        )

            envio_locked.estado = ImportacionEnvio.ESTADO_RECIBIDO
            envio_locked.fecha_recepcion = timezone.localdate()
            envio_locked.recibido_por = request.user
            envio_locked.save(update_fields=["estado", "fecha_recepcion", "recibido_por"])

            # El precio ya se aplico al catalogo al aceptar la importacion (ver
            # ImportacionViewSet.importar) -- no se vuelve a tocar aqui para no
            # pisar un ajuste manual de precio hecho despues de aceptarla y
            # antes de que la sucursal confirme su envio.

        User = get_user_model()
        admin_ids = [u.pk for u in User.objects.filter(is_active=True) if is_app_admin(u)]
        if admin_ids:
            self._create_importacion_reminder(envio.importacion, None, admin_ids, request.user)

        return Response(
            {"detail": "Recepción registrada correctamente.", "recordatorio_enviado": bool(admin_ids)},
            status=status.HTTP_200_OK,
        )

    def perform_destroy(self, instance):
        if instance.estado not in (Importacion.ESTADO_BORRADOR, Importacion.ESTADO_COTIZACION, Importacion.ESTADO_CONFIRMACION):
            from rest_framework.exceptions import ValidationError
            raise ValidationError("Solo se pueden eliminar importaciones en estado borrador, cotización o confirmación.")
        instance.delete()

    @transaction.atomic
    @action(detail=True, methods=["patch"], url_path=r"detalles/(?P<detalle_id>\d+)")
    def patch_detalle(self, request, pk=None, detalle_id=None):
        instance = self.get_object()
        try:
            detalle = instance.detalles.get(pk=detalle_id)
        except ImportacionDetalle.DoesNotExist:
            return Response({"detail": "Detalle no encontrado."}, status=status.HTTP_404_NOT_FOUND)
        producto_id = request.data.get("producto_id")
        if producto_id is not None:
            try:
                producto = Producto.objects.get(pk=producto_id)
            except Producto.DoesNotExist:
                return Response({"detail": "Producto no encontrado."}, status=status.HTTP_404_NOT_FOUND)
            detalle.producto = producto
            detalle.save(update_fields=["producto"])
            # Si el producto se acaba de crear en el paso "completar datos" de
            # marcar llegada, se marca como generado por esta importación para
            # poder resaltarlo en amarillo en los demás pasos.
            if request.data.get("nuevo") and producto.creado_desde_importacion_id is None:
                producto.creado_desde_importacion = instance
                producto.save(update_fields=["creado_desde_importacion"])
        serializer = ImportacionDetalleSerializer(detalle)
        return Response(serializer.data)

    @action(detail=False, methods=["get"], url_path="next-code")
    def next_code(self, request):
        from casa_comercial.models import CasaComercial
        casa_id = request.query_params.get("casa_id")
        casa = None
        if casa_id:
            try:
                casa = CasaComercial.objects.get(pk=casa_id)
            except CasaComercial.DoesNotExist:
                pass
        return Response({"codigo": generate_next_importacion_code(casa)}, status=status.HTTP_200_OK)
