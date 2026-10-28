"""Migra datos del sistema anterior (export de Firebase) al sistema nuevo.

Ver el plan completo en el reporte de la sesion. Reglas clave verificadas
contra datos reales antes de escribir esta migracion:

- oems: cada entrada es [base, sufijo1, sufijo2, ...]; se genera un OEM por
  cada sufijo no vacio (base+sufijo), o solo "base" si el unico sufijo esta
  vacio.
- ubicacion: se separa por ":" tal cual (sin normalizar); con 2 segmentos
  division=seg1/subdivision=seg2, con 3 segmentos division=seg1:seg2 /
  subdivision=seg3. Se busca por nombre EXACTO contra las Division/
  SubDivision que YA EXISTEN en la bodega (nunca se crean/borran bodegas).
- las Sucursales del JSON viejo son las bodegas fisicas viejas; el mapeo a
  las bodegas nuevas (todas ya existentes) fue confirmado con el usuario.

Uso:
    python manage.py migrate_legacy_json --dry-run   (default, no escribe nada)
    python manage.py migrate_legacy_json --commit     (ejecuta la migracion)
"""

import json
import re
import time
import unicodedata
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models.signals import post_delete, post_save, pre_save

from app.models import InspeccionAleatoriaItem
from casa_comercial.models import CasaComercial
from inventario.models import Bodega, Division, Inventario, Sucursal, SubDivision
from movimientos.models import (
    DetalleMovimiento,
    MovimientoInventario,
    PagoMovimiento,
    SolicitudTraslado,
    SolicitudTrasladoDetalle,
    TrasladoInconveniente,
    TrasladoInconvenienteHistorial,
)
from importaciones.models import (
    Importacion,
    ImportacionDetalle,
    ImportacionEnvio,
    ImportacionEnvioDetalle,
    ImportacionInconveniente,
    ImportacionInconvenienteHistorial,
)
from productos.models import OEM, OEMProducto, Producto, ProductoAlterno
from solicitudes.models import Auto, Cliente, ProductoSolicitado, Solicitud
from tipos.models import EstadoMovimiento, EstadoProducto, SubTipoMovimiento
from auditoria.signals import (
    _post_delete_handler,
    _post_save_handler,
    _pre_save_handler,
    register_audit_signals,
)


# Modelos que la app "auditoria" instrumenta (ver auditoria/apps.py). Durante
# esta migracion masiva se desconectan sus señales: no tiene sentido generar
# un RegistroAuditoria por cada una de las ~70,000 filas que se crean/borran
# aqui, y hacerlo (un INSERT extra por fila) fue el principal cuello de
# botella en los primeros intentos de esta migracion.
AUDITED_MODELS = [Inventario, Bodega, Producto, MovimientoInventario, Solicitud, Cliente, InspeccionAleatoriaItem, get_user_model()]


@contextmanager
def audit_signals_disabled():
    for model in AUDITED_MODELS:
        name = f"{model._meta.app_label}_{model.__name__}"
        pre_save.disconnect(_pre_save_handler, sender=model, dispatch_uid=f"audit_pre_{name}")
        post_save.disconnect(_post_save_handler, sender=model, dispatch_uid=f"audit_post_{name}")
        post_delete.disconnect(_post_delete_handler, sender=model, dispatch_uid=f"audit_del_{name}")
    try:
        yield
    finally:
        for model in AUDITED_MODELS:
            register_audit_signals(model)


JSON_PATH = Path(r"C:\Users\PC\Documents\GitHub\InventarioApp\jpaezdemo-default-rtdb-export (1).json")

# Marca (JSON viejo) -> como resolver la CasaComercial ya existente.
MARCA_OVERRIDES = {
    # El JSON viejo no distingue Tecnova: toda "COMPRA LOCAL" va a la casa
    # COMPRA LOCAL (Tecnova se agrega aparte a los que tuvieron pedido).
    "COMPRA LOCAL": ("nombre", "COMPRA LOCAL"),
    "AFP": ("codigo", "AFP"),
    "PCX": ("codigo", "PX"),
    "COMPRA LOCAL MAVESA": ("codigo", "CLO"),
    "LHP (OMER)": ("codigo", "LHP"),
}
# Valores basura: nunca crean casa comercial, el producto queda sin casa.
MARCA_SKIP = {"", "N/A", "210553"}

# Sucursal vieja (clave en Inventario.estado / Entradas_.../Salidas) -> nombre
# (contiene) de la Bodega nueva donde vive ese stock. Confirmado con el usuario.
SUCURSAL_TO_BODEGA_HINT = {
    "9 de Octubre": "ALMACEN MATRIZ",
    "Bodega": "BODEGA MATRIZ",
    "Norte": "ALMACEN NORTE",
    "Sur": "ALMACEN SUR",
    "Tumbaco": "ALMACEN TUMBACO",
    "Valle": "ALMACEN VALLE",
}
# Sucursal vieja -> nombre (contiene) de la Sucursal nueva (para el campo
# `sucursal` del movimiento migrado).
SUCURSAL_TO_SUCURSAL_HINT = {
    "9 de Octubre": "9 DE OCTUBRE",
    "Bodega": "9 DE OCTUBRE",
    "Norte": "NORTE",
    "Sur": "SUR",
    "Tumbaco": "TUMBACO",
    "Valle": "VALLE",
}


def normalize(value):
    text = str(value or "").strip().upper()
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return text


def safe_float(value, default=0.0):
    try:
        if value in (None, ""):
            return default
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return default


def safe_int(value, default=0):
    return int(safe_float(value, default))


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def safe_date(value):
    """Valida 'YYYY-MM-DD'. El JSON viejo trae ~200 fechas vacias/'N/A' y un
    puñado con un digito de mas tecleado por error (ej. '20225-02-18'): no
    se adivina la fecha real, se descarta el documento entero (se reporta)."""
    text = str(value or "").strip()
    if not _DATE_RE.match(text):
        return None
    try:
        from datetime import date
        date.fromisoformat(text)
    except ValueError:
        return None
    return text


def as_list(value):
    """Varias secciones a veces traen un solo item plano en vez de un array
    de un elemento (ej. Entradas_Devolucion). Normaliza ambas formas."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def parse_producto_line(raw):
    """'P1739LPR: TAMBOR 206 207 1.4 S/RULIMAN' -> ('P1739LPR', 'TAMBOR...')"""
    text = str(raw or "").strip()
    if ":" not in text:
        return text.strip(), ""
    codigo, _, resto = text.partition(":")
    return codigo.strip(), resto.strip()


def oem_codes_for_entry(entry):
    """Aplica la regla base+sufijo verificada con el usuario."""
    codes = set()
    for arr in (entry.get("oems") or {}).values():
        if not isinstance(arr, list) or not arr:
            continue
        base = str(arr[0] or "").strip().upper()
        if not base:
            continue
        suffixes = arr[1:]
        if not suffixes:
            codes.add(base)
            continue
        found_suffix = False
        for suf in suffixes:
            suf = str(suf or "").strip().upper()
            if suf:
                codes.add(f"{base}{suf}")
                found_suffix = True
        if not found_suffix:
            codes.add(base)
    return codes


class UnionFind:
    def __init__(self, keys):
        self.parent = {k: k for k in keys}

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb

    def groups(self):
        out = defaultdict(list)
        for k in self.parent:
            out[self.find(k)].append(k)
        return list(out.values())


class Report:
    def __init__(self):
        self.lines = []
        self.counts = defaultdict(int)

    def note(self, msg):
        self.lines.append(msg)

    def count(self, key, n=1):
        self.counts[key] += n

    def print_all(self):
        print("\n" + "=" * 70)
        print("REPORTE DE MIGRACION")
        print("=" * 70)
        for key in sorted(self.counts):
            print(f"  {key}: {self.counts[key]}")
        if self.lines:
            print("-" * 70)
            for line in self.lines:
                print(" ", line)
        print("=" * 70 + "\n")


class Command(BaseCommand):
    help = "Migra productos/inventario/movimientos/clientes desde el JSON del sistema anterior."

    def add_arguments(self, parser):
        parser.add_argument("--commit", action="store_true", help="Ejecuta los cambios. Sin esto, solo reporta.")
        parser.add_argument("--json-path", default=str(JSON_PATH))

    def _progress(self, msg):
        elapsed = time.time() - self._t0
        print(f"[{elapsed:7.1f}s] {msg}", flush=True)

    def handle(self, *args, **options):
        self._t0 = time.time()
        self.commit = bool(options["commit"])
        self.report = Report()
        path = Path(options["json_path"])
        self.stdout.write(f"Cargando {path} ...")
        with open(path, encoding="utf-8") as f:
            self.data = json.load(f)
        self.stdout.write(self.style.SUCCESS("JSON cargado."))

        self._build_location_index()
        self._resolve_casas_comerciales()

        if self.commit:
            with transaction.atomic(), audit_signals_disabled():
                self._progress("borrando datos existentes...")
                self._delete_existing()
                self._progress("creando productos/OEMs/alternos...")
                self._migrate_productos()
                self._progress("creando inventario...")
                self._migrate_inventario()
                self._progress("creando clientes...")
                self._migrate_clientes()
                self._progress("creando movimientos (entradas/salidas/traslados)...")
                self._migrate_movimientos()
                self._progress("listo, haciendo commit de la transaccion...")
        else:
            # Dry-run: igual computamos todo lo posible en memoria para que
            # el reporte sea real, sin tocar la base.
            self._migrate_productos()
            self._migrate_inventario()
            self._migrate_clientes()
            self._migrate_movimientos()

        self.report.print_all()
        if not self.commit:
            self.stdout.write(self.style.WARNING("DRY-RUN: no se escribio nada. Corre con --commit para aplicar."))
        else:
            self.stdout.write(self.style.SUCCESS("Migracion aplicada."))

    # ------------------------------------------------------------------
    # Resolucion de ubicaciones (bodega/division/subdivision) y casas
    # ------------------------------------------------------------------

    def _build_location_index(self):
        """Bodega vieja (nombre) -> {(division_norm, subdivision_norm): (division_id, subdivision_id)}."""
        self.bodega_by_sucursal_vieja = {}
        self.location_index = {}
        self.sucursal_by_vieja = {}
        for vieja, bodega_hint in SUCURSAL_TO_BODEGA_HINT.items():
            sucursal_hint = SUCURSAL_TO_SUCURSAL_HINT[vieja]
            bodega = None
            for b in Bodega.objects.select_related("sucursal").all():
                if normalize(b.sucursal.nombre).find(sucursal_hint) == -1:
                    continue
                if normalize(b.nombre) == bodega_hint or bodega_hint in normalize(b.nombre):
                    bodega = b
                    break
            if bodega is None:
                raise RuntimeError(f"No se encontro la bodega nueva para '{vieja}' (se esperaba algo como '{bodega_hint}').")
            self.bodega_by_sucursal_vieja[vieja] = bodega
            sucursal = None
            for s in Sucursal.objects.all():
                if sucursal_hint in normalize(s.nombre):
                    sucursal = s
                    break
            if sucursal is None:
                raise RuntimeError(f"No se encontro la Sucursal nueva para '{vieja}'.")
            self.sucursal_by_vieja[vieja] = sucursal

            idx = {}
            for div in Division.objects.filter(bodega=bodega):
                for sub in SubDivision.objects.filter(division=div):
                    idx[(div.nombre, sub.nombre)] = (div.id, sub.id)
            self.location_index[vieja] = idx

        # division/subdivision "SIN UBICACION" como respaldo, por bodega
        self.sin_ubicacion = {}
        for vieja, bodega in self.bodega_by_sucursal_vieja.items():
            div = Division.objects.filter(bodega=bodega, nombre__iexact="SIN UBICACION").first()
            sub = SubDivision.objects.filter(division=div, nombre__iexact="SIN UBICACION").first() if div else None
            self.sin_ubicacion[vieja] = (div.id, sub.id) if div and sub else (None, None)

    def _resolve_ubicacion(self, sucursal_vieja, ubicacion_raw):
        raw = str(ubicacion_raw or "").strip()
        idx = self.location_index.get(sucursal_vieja, {})
        if raw and raw not in ("N/A", ":") and "__" not in raw:
            parts = [p.strip() for p in raw.split(":")]
            if len(parts) == 2 and parts[0] and parts[1]:
                key = (parts[0], parts[1])
                if key in idx:
                    return idx[key]
            elif len(parts) == 3 and all(parts):
                key = (f"{parts[0]}:{parts[1]}", parts[2])
                if key in idx:
                    return idx[key]
        self.report.count(f"ubicacion_sin_match::{sucursal_vieja}")
        return self.sin_ubicacion.get(sucursal_vieja, (None, None))

    def _resolve_casas_comerciales(self):
        inv = self.data.get("Inventario", {})
        marcas = sorted({str(v.get("marca") or "").strip() for v in inv.values()})
        existing_by_nombre = {c.nombre.strip().upper(): c for c in CasaComercial.objects.all()}
        existing_by_codigo = {}
        for c in CasaComercial.objects.all():
            existing_by_codigo.setdefault(c.codigo.strip().upper(), c)

        self.casa_by_marca = {}
        self.marcas_pendientes_casa_nueva = set()
        for marca in marcas:
            if marca in MARCA_SKIP:
                continue
            if marca in MARCA_OVERRIDES:
                field, value = MARCA_OVERRIDES[marca]
                casa = existing_by_nombre.get(value.upper()) if field == "nombre" else existing_by_codigo.get(value.upper())
                if casa:
                    self.casa_by_marca[marca] = casa
                    continue
            casa = existing_by_nombre.get(marca.upper())
            if casa:
                self.casa_by_marca[marca] = casa
                continue
            # Marca real sin match: se crea (confirmado por el usuario).
            self.report.note(f"Casa comercial nueva a crear para marca '{marca}'")
            self.marcas_pendientes_casa_nueva.add(marca)
            self.report.count("casas_comerciales_nuevas")
            if self.commit:
                codigo = "".join(ch for ch in marca if ch.isalnum())[:10] or marca[:10]
                casa = CasaComercial.objects.create(nombre=marca.title(), codigo=codigo, tipo=CasaComercial.TIPO_LOCAL)
                self.casa_by_marca[marca] = casa

    # ------------------------------------------------------------------
    # Borrado (solo bajo --commit)
    # ------------------------------------------------------------------

    def _delete_existing(self):
        # Orden importa por las FK protegidas/cascada -- ver nota mas abajo
        # sobre Solicitud vs ProductoSolicitado. Con las señales de auditoria
        # desconectadas (audit_signals_disabled) estos .all().delete() ya no
        # generan un INSERT extra por fila.
        ordered_models = [
            DetalleMovimiento,
            PagoMovimiento,
            MovimientoInventario,
            SolicitudTrasladoDetalle,
            SolicitudTraslado,
            TrasladoInconvenienteHistorial,
            TrasladoInconveniente,
            ImportacionInconvenienteHistorial,
            ImportacionInconveniente,
            ImportacionEnvioDetalle,
            ImportacionEnvio,
            ImportacionDetalle,
            Importacion,
            Inventario,
            ProductoAlterno,
            OEMProducto,
            # Solicitud.producto e InspeccionAleatoriaItem.producto son
            # PROTECT: hay que borrarlos antes de poder borrar Producto.
            # Ademas Solicitud se borra ANTES que ProductoSolicitado (aunque
            # Solicitud.producto_solicitado es CASCADE desde
            # ProductoSolicitado): si se borra ProductoSolicitado primero,
            # el delete en cascada de Solicitud dispara la señal de
            # auditoria (post_delete) que llama a Solicitud.__str__(), y
            # esta intenta leer self.producto_solicitado -- que para ese
            # momento ya fue borrado en el mismo batch del collector, y
            # truena con DoesNotExist.
            Solicitud,
            ProductoSolicitado,
            Auto,
            InspeccionAleatoriaItem,
            Producto,
            OEM,
        ]
        for model in ordered_models:
            _, per_model = model.objects.all().delete()
            n = sum(per_model.values())
            self._progress(f"borrado {model.__name__}: {n} filas")
        self.report.note("Borrado completo de: movimientos, importaciones, inventario, productos/oems/alternos, solicitudes.")

    # ------------------------------------------------------------------
    # Productos + OEMs + alternos
    # ------------------------------------------------------------------

    def _migrate_productos(self):
        inv = self.data.get("Inventario", {})
        keys = list(inv.keys())

        oem_codes_by_key = {k: oem_codes_for_entry(inv[k]) for k in keys}
        uf = UnionFind(keys)
        oem_to_keys = defaultdict(list)
        for k, codes in oem_codes_by_key.items():
            for c in codes:
                oem_to_keys[c].append(k)
        for ks in oem_to_keys.values():
            for other in ks[1:]:
                uf.union(ks[0], other)
        groups = uf.groups()

        self.report.count("productos_total", len(keys))
        self.report.count("grupos_oem_compartido", sum(1 for g in groups if len(g) > 1))

        self.producto_by_codigo = {}
        casas_by_key = {}
        for k in keys:
            entry = inv[k]
            codigo = str(entry.get("codigo") or "").strip()
            if not codigo:
                self.report.count("productos_sin_codigo_saltados")
                continue
            referencia = str(entry.get("referencia") or "").strip()
            if referencia.upper() == "N/A":
                referencia = ""
            nombre = str(entry.get("descripcion") or "").strip() or codigo
            precio = safe_float(entry.get("precio"), None)
            self.producto_by_codigo[codigo.upper()] = {
                "key": k,
                "codigo": codigo,
                "nombre": nombre,
                "referencia": referencia,
                "precio": precio,
            }
            marca = str(entry.get("marca") or "").strip()
            casa = self.casa_by_marca.get(marca)
            if casa:
                casas_by_key[k] = casa
            elif marca in self.marcas_pendientes_casa_nueva:
                pass  # se vinculara cuando se cree la casa nueva (solo en --commit)
            elif marca not in MARCA_SKIP:
                self.report.count("productos_sin_casa_comercial")

        if not self.commit:
            self.report.count("oems_distintos", len(oem_to_keys))
            return

        # Producto/OEM quedaron vacios en _delete_existing, asi que no hace
        # falta chequear duplicados: se crea todo de una vez y se relee
        # completo (evita un IN gigante con miles de codigos).
        producto_objs = {}
        for codigo_upper, info in self.producto_by_codigo.items():
            producto_objs[info["key"]] = Producto(
                codigo=info["codigo"],
                nombre=info["nombre"],
                referencia=info["referencia"],
                precio=info["precio"],
            )
        Producto.objects.bulk_create(producto_objs.values(), batch_size=1000)
        self._progress(f"productos creados: {len(producto_objs)}")
        created = {p.codigo.upper(): p for p in Producto.objects.all()}
        for codigo_upper, info in self.producto_by_codigo.items():
            info["producto"] = created.get(codigo_upper)

        # casas_comerciales M2M
        through = Producto.casas_comerciales.through
        m2m_rows = []
        for codigo_upper, info in self.producto_by_codigo.items():
            casa = casas_by_key.get(info["key"])
            if casa and info.get("producto"):
                m2m_rows.append(through(producto_id=info["producto"].id, casacomercial_id=casa.id))
        if m2m_rows:
            through.objects.bulk_create(m2m_rows, ignore_conflicts=True, batch_size=1000)

        # OEMs
        all_codes = set(oem_to_keys.keys())
        OEM.objects.bulk_create([OEM(codigo=c) for c in all_codes], ignore_conflicts=True, batch_size=1000)
        oem_by_code = {o.codigo: o for o in OEM.objects.all()}
        missing_codes = all_codes

        # Union de OEMs por grupo + OEMProducto + ProductoAlterno
        oem_producto_rows = []
        alterno_rows = []
        for group in groups:
            group_codes = set()
            for k in group:
                group_codes |= oem_codes_by_key.get(k, set())
            if not group_codes:
                continue
            group_producto_ids = [producto_objs[k].id for k in group if k in producto_objs and producto_objs[k].id]
            for pid in group_producto_ids:
                for code in group_codes:
                    oem = oem_by_code.get(code)
                    if oem:
                        oem_producto_rows.append(OEMProducto(producto_id=pid, oem_id=oem.id))
            if len(group_producto_ids) > 1:
                for a in group_producto_ids:
                    for b in group_producto_ids:
                        if a != b:
                            alterno_rows.append(ProductoAlterno(producto_id=a, alterno_id=b))

        if oem_producto_rows:
            OEMProducto.objects.bulk_create(oem_producto_rows, ignore_conflicts=True, batch_size=2000)
        if alterno_rows:
            ProductoAlterno.objects.bulk_create(alterno_rows, ignore_conflicts=True, batch_size=2000)
        self._progress(f"OEMs/alternos listos: {len(oem_producto_rows)} oem-producto, {len(alterno_rows)} alternos")

        self.report.count("productos_creados", len(created))
        self.report.count("oems_creados", len(missing_codes))
        self.report.count("oem_producto_links", len(oem_producto_rows))
        self.report.count("producto_alterno_links", len(alterno_rows))

    # ------------------------------------------------------------------
    # Inventario (stock por bodega/division/subdivision)
    # ------------------------------------------------------------------

    def _migrate_inventario(self):
        inv = self.data.get("Inventario", {})
        rows = []
        for k, entry in inv.items():
            codigo = str(entry.get("codigo") or "").strip().upper()
            info = self.producto_by_codigo.get(codigo)
            if not info:
                continue
            for sucursal_vieja, estado in (entry.get("estado") or {}).items():
                if sucursal_vieja not in SUCURSAL_TO_BODEGA_HINT:
                    continue
                stock = safe_int(estado.get("stock"))
                if stock <= 0:
                    continue
                division_id, subdivision_id = self._resolve_ubicacion(sucursal_vieja, estado.get("ubicacion"))
                if subdivision_id is None:
                    self.report.count("inventario_sin_subdivision_saltado")
                    continue
                if self.commit and info.get("producto"):
                    rows.append(Inventario(producto_id=info["producto"].id, subdivision_id=subdivision_id, cantidad=stock, referencia=""))
                self.report.count("inventario_filas_planeadas")
        if self.commit and rows:
            Inventario.objects.bulk_create(rows, batch_size=2000)
            self.report.count("inventario_filas_creadas", len(rows))
        self._progress(f"inventario: {len(rows)} filas creadas")

    # ------------------------------------------------------------------
    # Clientes
    # ------------------------------------------------------------------

    def _migrate_clientes(self):
        salidas = self.data.get("Salidas", {})
        nombres = set()
        for sucursal, docs in salidas.items():
            for doc in docs.values():
                cliente = str(doc.get("cliente") or "").strip()
                if cliente and cliente.upper() != "N/A":
                    nombres.add(cliente)

        existing = {c.nombres.strip().upper(): c for c in Cliente.objects.all()}
        self.cliente_by_nombre = dict(existing)
        nuevos = []
        for nombre in nombres:
            key = nombre.upper()
            if key in self.cliente_by_nombre:
                continue
            if self.commit:
                nuevos.append(Cliente(nombres=nombre, apellidos="", cedula_ruc=""))
            else:
                self.cliente_by_nombre[key] = None  # marcador: se crearia
        if self.commit and nuevos:
            Cliente.objects.bulk_create(nuevos, batch_size=1000)
            self.cliente_by_nombre = {c.nombres.strip().upper(): c for c in Cliente.objects.all()}

        self.report.count("clientes_distintos_en_json", len(nombres))
        self.report.count("clientes_nuevos", len(nuevos) if self.commit else len(nombres) - sum(1 for v in existing if v.upper() in nombres))
        self._progress(f"clientes: {len(nuevos) if self.commit else 0} nuevos creados")

    # ------------------------------------------------------------------
    # Movimientos (Entradas/Salidas/Traslados) legado
    # ------------------------------------------------------------------

    def _get_subtipo(self, tipo_nombre, subtipo_nombre):
        key = f"{tipo_nombre}::{subtipo_nombre}"
        if not hasattr(self, "_subtipo_cache"):
            self._subtipo_cache = {}
        if key not in self._subtipo_cache:
            self._subtipo_cache[key] = SubTipoMovimiento.objects.select_related("tipo_movimiento").get(
                tipo_movimiento__nombre__iexact=tipo_nombre, nombre__iexact=subtipo_nombre
            )
        return self._subtipo_cache[key]

    def _get_estado_movimiento(self, nombre):
        if not hasattr(self, "_estado_mov_cache"):
            self._estado_mov_cache = {}
        if nombre not in self._estado_mov_cache:
            self._estado_mov_cache[nombre] = EstadoMovimiento.objects.get(nombre__iexact=nombre)
        return self._estado_mov_cache[nombre]

    def _get_estado_producto_enviado(self):
        if not hasattr(self, "_estado_producto_enviado"):
            self._estado_producto_enviado = EstadoProducto.objects.filter(nombre__icontains="enviad").order_by("id").first()
        return self._estado_producto_enviado

    def _resolve_producto_line(self, raw):
        codigo, _ = parse_producto_line(raw)
        info = self.producto_by_codigo.get(codigo.strip().upper())
        if not info:
            self.report.count("lineas_producto_sin_match")
            return None
        return info

    def _create_movimiento(self, *, sucursal_vieja, tipo_nombre, subtipo_nombre, estado_nombre, fecha, no_documento,
                            productos_raw, cantidades_raw, precios_raw, casa=None, descripcion="", datos_legado=None):
        """No escribe nada: valida y encola. El escritor real
        (_flush_pending_movimientos) hace bulk_create al final, en bloque --
        crear un movimiento a la vez contra la base remota (con su insert de
        detalle aparte) fue el cuello de botella real de esta migracion."""
        fecha = safe_date(fecha)
        if fecha is None:
            self.report.count(f"{tipo_nombre}_{subtipo_nombre}_fecha_invalida_saltado")
            return

        productos_raw = as_list(productos_raw)
        cantidades_raw = as_list(cantidades_raw)
        precios_raw = as_list(precios_raw)
        if not productos_raw:
            return

        lineas = []
        for i, prod_raw in enumerate(productos_raw):
            info = self._resolve_producto_line(prod_raw)
            if not info:
                continue
            cantidad = safe_int(cantidades_raw[i]) if i < len(cantidades_raw) else 0
            if cantidad <= 0:
                continue
            precio = safe_float(precios_raw[i]) if i < len(precios_raw) else 0.0
            lineas.append((info, cantidad, precio))

        if not lineas:
            self.report.count(f"{tipo_nombre}_{subtipo_nombre}_sin_lineas_validas")
            return

        self.report.count(f"movimientos_{tipo_nombre}_{subtipo_nombre}_planeados")
        if not self.commit:
            return

        producto_lineas = [
            (info["producto"], cantidad, precio)
            for info, cantidad, precio in lineas
            if info.get("producto")
        ]
        if not producto_lineas:
            return

        self._pending_movimientos.append({
            "sucursal_id": self.sucursal_by_vieja[sucursal_vieja].id,
            "tipo_movimiento_id": self._get_subtipo(tipo_nombre, subtipo_nombre).tipo_movimiento_id,
            "sub_tipo_movimiento_id": self._get_subtipo(tipo_nombre, subtipo_nombre).id,
            "descripcion": descripcion,
            "estado_movimiento_id": self._get_estado_movimiento(estado_nombre).id,
            "fecha": fecha,
            "no_documento": no_documento,
            "casa_comercial_id": casa.id if casa else None,
            "datos_legado": datos_legado or None,
            "lineas": producto_lineas,
            "tipo_nombre": tipo_nombre,
            "subtipo_nombre": subtipo_nombre,
        })
        if len(self._pending_movimientos) % 5000 == 0:
            self._progress(f"  ... {len(self._pending_movimientos)} movimientos encolados")

    def _flush_pending_movimientos(self):
        pending = self._pending_movimientos
        total = len(pending)
        self._progress(f"creando {total} movimientos en bloque...")
        if not pending:
            return

        estado_producto_id = self._get_estado_producto_enviado().id
        created_total = 0
        detail_total = 0
        CHUNK = 2000
        for start in range(0, total, CHUNK):
            chunk = pending[start:start + CHUNK]
            objs = [
                MovimientoInventario(
                    sucursal_id=p["sucursal_id"],
                    tipo_movimiento_id=p["tipo_movimiento_id"],
                    sub_tipo_movimiento_id=p["sub_tipo_movimiento_id"],
                    descripcion=p["descripcion"],
                    estado_movimiento_id=p["estado_movimiento_id"],
                    fecha=p["fecha"],
                    no_documento=p["no_documento"],
                    casa_comercial_id=p["casa_comercial_id"],
                    es_legado=True,
                    datos_legado=p["datos_legado"],
                )
                for p in chunk
            ]
            MovimientoInventario.objects.bulk_create(objs, batch_size=CHUNK)
            created_total += len(objs)

            detalles = []
            for p, movimiento in zip(chunk, objs):
                for producto, cantidad, precio in p["lineas"]:
                    detalles.append(DetalleMovimiento(
                        movimiento_inventario_id=movimiento.id,
                        producto=producto,
                        cantidad=cantidad,
                        estado_producto_id=estado_producto_id,
                        valor=precio,
                        valor_total=round(precio * cantidad, 2),
                    ))
            if detalles:
                DetalleMovimiento.objects.bulk_create(detalles, batch_size=CHUNK)
                detail_total += len(detalles)

            self._progress(f"  movimientos {created_total}/{total} ({100 * created_total // total}%), detalles {detail_total}")

        por_tipo = defaultdict(int)
        for p in pending:
            por_tipo[f"movimientos_{p['tipo_nombre']}_{p['subtipo_nombre']}_creados"] += 1
        for key, n in por_tipo.items():
            self.report.count(key, n)
        self.report.count("movimientos_total_creados", created_total)
        self.report.count("detalles_movimiento_creados", detail_total)

    def _migrate_movimientos(self):
        self._pending_movimientos = []
        self._migrate_entradas_compras()
        self._migrate_entradas_devolucion()
        self._migrate_entradas_sucursal()
        self._migrate_salidas()
        if self.commit:
            self._flush_pending_movimientos()

    def _migrate_entradas_compras(self):
        for key, doc in self.data.get("Entradas_Compras", {}).items():
            casa = self.casa_by_marca.get(str(doc.get("tipo_compra") or "").strip())
            self._create_movimiento(
                sucursal_vieja="Bodega",  # las compras no traen sucursal; se registran en Bodega Matriz por defecto
                tipo_nombre="Entrada",
                subtipo_nombre="Compra local",
                estado_nombre="Recibido",
                fecha=doc.get("fecha"),
                no_documento=f"LEG-{key}",
                productos_raw=doc.get("productos"),
                cantidades_raw=doc.get("cantidades"),
                precios_raw=doc.get("precio"),
                casa=casa,
                descripcion=f"Documento original: {doc.get('documento', '')}".strip(),
                datos_legado={"origen": "Entradas_Compras", "raw": doc},
            )

    def _migrate_entradas_devolucion(self):
        for sucursal_vieja, docs in self.data.get("Entradas_Devolucion", {}).items():
            if sucursal_vieja not in SUCURSAL_TO_BODEGA_HINT:
                continue
            for key, doc in docs.items():
                motivo = str(doc.get("motivo") or "").strip()
                self._create_movimiento(
                    sucursal_vieja=sucursal_vieja,
                    tipo_nombre="Entrada",
                    subtipo_nombre="Devolucion",
                    estado_nombre="Recibido",
                    fecha=doc.get("fecha"),
                    no_documento=f"LEG-{key}",
                    productos_raw=doc.get("producto"),
                    cantidades_raw=doc.get("cantidad"),
                    precios_raw=doc.get("precio"),
                    descripcion=motivo,
                    datos_legado={"origen": "Entradas_Devolucion", "raw": doc},
                )

    def _migrate_entradas_sucursal(self):
        for sucursal_vieja, docs in self.data.get("Entradas_Sucursal", {}).items():
            if sucursal_vieja not in SUCURSAL_TO_BODEGA_HINT:
                continue
            for key, doc in docs.items():
                origen = str(doc.get("sucursal_envio") or "").strip()
                self._create_movimiento(
                    sucursal_vieja=sucursal_vieja,
                    tipo_nombre="Entrada",
                    subtipo_nombre="Traslado",
                    estado_nombre="Recibido",
                    fecha=doc.get("fecha"),
                    no_documento=f"LEG-{key}",
                    productos_raw=doc.get("productos"),
                    cantidades_raw=doc.get("cantidades"),
                    precios_raw=doc.get("precio"),
                    descripcion=f"Traslado desde {origen}".strip(),
                    datos_legado={"origen": "Entradas_Sucursal", "raw": doc},
                )

    def _migrate_salidas(self):
        for sucursal_vieja, docs in self.data.get("Salidas", {}).items():
            if sucursal_vieja not in SUCURSAL_TO_BODEGA_HINT:
                continue
            for key, doc in docs.items():
                cliente_nombre = str(doc.get("cliente") or "").strip()
                descripcion = ""
                if cliente_nombre and cliente_nombre.upper() != "N/A":
                    cliente = self.cliente_by_nombre.get(cliente_nombre.upper())
                    if cliente:
                        descripcion = f"Cliente: {cliente_nombre}"
                comentario = str(doc.get("comentario") or "").strip()
                if comentario:
                    descripcion = f"{descripcion}\n{comentario}" if descripcion else comentario
                self._create_movimiento(
                    sucursal_vieja=sucursal_vieja,
                    tipo_nombre="Salida",
                    subtipo_nombre="Venta",
                    estado_nombre="Vendido",
                    fecha=doc.get("fecha"),
                    no_documento=f"LEG-{key}",
                    productos_raw=doc.get("productos"),
                    cantidades_raw=doc.get("cantidades"),
                    precios_raw=doc.get("precio"),
                    descripcion=descripcion,
                    datos_legado={"origen": "Salidas", "raw": doc},
                )
