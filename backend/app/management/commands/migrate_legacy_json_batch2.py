"""Migra un SEGUNDO export del sistema anterior (rescatado porque el sistema
viejo se estaba colgando) -- ver migrate_legacy_json.py para el primer batch.

A diferencia de migrate_legacy_json, este comando es puramente ADITIVO:
- No borra nada.
- No toca Inventario/stock: la app ya esta en produccion desde el primer
  batch y puede tener movimientos reales hechos por usuarios desde entonces;
  pisar el stock con este snapshot viejo podria perder esos cambios. Se
  confirmo con el usuario dejar el stock actual intacto y solo agregar el
  historial de movimientos que faltaba.
- Es idempotente: cada Entrada/Salida vieja se identifica por su clave de
  Firebase (mismo esquema "LEG-<key>" que usa no_documento en el primer
  batch); si esa clave ya existe en la base, se salta. Se puede correr mas
  de una vez sin duplicar nada.
- Solo crea los productos que de verdad falten (por codigo); los que ya
  existen se reusan tal cual, no se tocan sus datos.

Uso:
    python manage.py migrate_legacy_json_batch2 --dry-run   (default)
    python manage.py migrate_legacy_json_batch2 --commit
"""

import json
import time
from collections import defaultdict
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models.signals import post_delete, post_save, pre_save

from app.management.commands.migrate_legacy_json import (
    MARCA_OVERRIDES,
    MARCA_SKIP,
    SUCURSAL_TO_BODEGA_HINT,
    SUCURSAL_TO_SUCURSAL_HINT,
    Report,
    as_list,
    normalize,
    oem_codes_for_entry,
    parse_producto_line,
    safe_date,
    safe_float,
    safe_int,
)
from app.models import InspeccionAleatoriaItem
from casa_comercial.models import CasaComercial
from inventario.models import Bodega, Inventario, Sucursal
from movimientos.models import DetalleMovimiento, MovimientoInventario
from productos.models import OEM, OEMProducto, Producto, ProductoAlterno
from productos.viewsets import get_alterno_group_ids
from solicitudes.models import Cliente
from tipos.models import EstadoMovimiento, EstadoProducto, SubTipoMovimiento
from auditoria.signals import (
    _post_delete_handler,
    _post_save_handler,
    _pre_save_handler,
    register_audit_signals,
)


AUDITED_MODELS = [Inventario, Bodega, Producto, MovimientoInventario, Cliente, InspeccionAleatoriaItem, get_user_model()]


from contextlib import contextmanager


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


JSON_PATH = Path(r"C:\Users\PC\Documents\GitHub\InventarioApp\DATOS 29 DIC.json")


class Command(BaseCommand):
    help = "Migra el segundo export (batch2) del sistema anterior, sin borrar ni tocar stock."

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

        self._build_sucursal_index()
        self._load_existing_no_documentos()
        self._resolve_casas_comerciales_para_nuevos()

        if self.commit:
            with transaction.atomic(), audit_signals_disabled():
                self._progress("creando productos nuevos...")
                self._migrate_productos_nuevos()
                self._progress("creando clientes nuevos...")
                self._migrate_clientes()
                self._progress("creando movimientos (entradas/salidas) faltantes...")
                self._migrate_movimientos()
                self._progress("listo, haciendo commit de la transaccion...")
        else:
            self._migrate_productos_nuevos()
            self._migrate_clientes()
            self._migrate_movimientos()

        self.report.print_all()
        if not self.commit:
            self.stdout.write(self.style.WARNING("DRY-RUN: no se escribio nada. Corre con --commit para aplicar."))
        else:
            self.stdout.write(self.style.SUCCESS("Migracion batch2 aplicada."))

    # ------------------------------------------------------------------

    def _build_sucursal_index(self):
        self.sucursal_by_vieja = {}
        for vieja, sucursal_hint in SUCURSAL_TO_SUCURSAL_HINT.items():
            sucursal = None
            for s in Sucursal.objects.all():
                if sucursal_hint in normalize(s.nombre):
                    sucursal = s
                    break
            if sucursal is None:
                raise RuntimeError(f"No se encontro la Sucursal nueva para '{vieja}'.")
            self.sucursal_by_vieja[vieja] = sucursal

    def _load_existing_no_documentos(self):
        self.existing_no_documentos = set(
            MovimientoInventario.objects.filter(es_legado=True).values_list("no_documento", flat=True)
        )
        self._progress(f"documentos legado ya existentes en la base: {len(self.existing_no_documentos)}")

    def _resolve_casas_comerciales_para_nuevos(self):
        """Solo resuelve la marca de los productos que de verdad son nuevos
        (los que ya existen conservan su casa comercial tal cual)."""
        inv = self.data.get("Inventario", {})
        existing_codigos = {c.upper() for c in Producto.objects.values_list("codigo", flat=True)}
        marcas_nuevas = set()
        for entry in inv.values():
            codigo = str(entry.get("codigo") or "").strip()
            if not codigo or codigo.upper() in existing_codigos:
                continue
            marcas_nuevas.add(str(entry.get("marca") or "").strip())

        existing_by_nombre = {c.nombre.strip().upper(): c for c in CasaComercial.objects.all()}
        existing_by_codigo = {}
        for c in CasaComercial.objects.all():
            existing_by_codigo.setdefault(c.codigo.strip().upper(), c)

        self.casa_by_marca = {}
        for marca in sorted(marcas_nuevas):
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
            self.report.note(f"Casa comercial nueva a crear para marca '{marca}'")
            self.report.count("casas_comerciales_nuevas")
            if self.commit:
                codigo = "".join(ch for ch in marca if ch.isalnum())[:10] or marca[:10]
                casa = CasaComercial.objects.create(nombre=marca.title(), codigo=codigo, tipo=CasaComercial.TIPO_LOCAL)
                self.casa_by_marca[marca] = casa

    # ------------------------------------------------------------------
    # Productos: solo los que faltan por codigo. El resto se reusa de la BD.
    # ------------------------------------------------------------------

    def _migrate_productos_nuevos(self):
        inv = self.data.get("Inventario", {})
        existing = {
            p.codigo.strip().upper(): p
            for p in Producto.objects.all()
        }

        self.producto_by_codigo = dict(existing)  # codigo_upper -> Producto (para resolver lineas de movimiento)
        nuevos_info = []
        for key, entry in inv.items():
            codigo = str(entry.get("codigo") or "").strip()
            if not codigo:
                continue
            codigo_upper = codigo.upper()
            if codigo_upper in existing:
                continue
            referencia = str(entry.get("referencia") or "").strip()
            if referencia.upper() == "N/A":
                referencia = ""
            nombre = str(entry.get("descripcion") or "").strip() or codigo
            precio = safe_float(entry.get("precio"), None)
            nuevos_info.append({
                "key": key,
                "codigo": codigo,
                "codigo_upper": codigo_upper,
                "nombre": nombre,
                "referencia": referencia,
                "precio": precio,
                "marca": str(entry.get("marca") or "").strip(),
                "oem_codes": oem_codes_for_entry(entry),
            })

        self.report.count("productos_nuevos_detectados", len(nuevos_info))
        if not self.commit or not nuevos_info:
            for info in nuevos_info:
                self.report.note(f"Producto nuevo a crear: {info['codigo']} ({info['nombre'][:40]})")
            return

        created = []
        for info in nuevos_info:
            producto = Producto.objects.create(
                codigo=info["codigo"],
                nombre=info["nombre"],
                referencia=info["referencia"],
                precio=info["precio"],
            )
            casa = self.casa_by_marca.get(info["marca"])
            if casa:
                producto.casas_comerciales.add(casa)
            self.producto_by_codigo[info["codigo_upper"]] = producto
            created.append((producto, info))

        self.report.count("productos_creados", len(created))

        # OEMs/alternos: solo si el producto nuevo de verdad trae codigos OEM.
        oem_producto_count = 0
        alterno_count = 0
        for producto, info in created:
            if not info["oem_codes"]:
                continue
            oem_objs = []
            for code in info["oem_codes"]:
                oem, _ = OEM.objects.get_or_create(codigo=code)
                oem_objs.append(oem)
            for oem in oem_objs:
                _, was_created = OEMProducto.objects.get_or_create(producto=producto, oem=oem)
                if was_created:
                    oem_producto_count += 1

            group_ids = get_alterno_group_ids(producto.id)
            if len(group_ids) <= 1:
                continue
            all_oem_ids = set(
                OEMProducto.objects.filter(producto_id__in=group_ids).values_list("oem_id", flat=True)
            )
            existing_pairs = set(
                OEMProducto.objects.filter(producto_id__in=group_ids, oem_id__in=all_oem_ids)
                .values_list("producto_id", "oem_id")
            )
            missing = [
                OEMProducto(producto_id=pid, oem_id=oid)
                for pid in group_ids
                for oid in all_oem_ids
                if (pid, oid) not in existing_pairs
            ]
            if missing:
                OEMProducto.objects.bulk_create(missing, ignore_conflicts=True)
                oem_producto_count += len(missing)

            for a in group_ids:
                for b in group_ids:
                    if a != b:
                        _, was_created = ProductoAlterno.objects.get_or_create(producto_id=a, alterno_id=b)
                        if was_created:
                            alterno_count += 1

        self.report.count("oem_producto_links_nuevos", oem_producto_count)
        self.report.count("producto_alterno_links_nuevos", alterno_count)
        self._progress(f"productos nuevos creados: {len(created)}")

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
                self.cliente_by_nombre[key] = None

        if self.commit and nuevos:
            Cliente.objects.bulk_create(nuevos, batch_size=1000)
            self.cliente_by_nombre = {c.nombres.strip().upper(): c for c in Cliente.objects.all()}

        nuevos_count = len(nuevos) if self.commit else sum(1 for n in nombres if n.upper() not in existing)
        self.report.count("clientes_nuevos", nuevos_count)
        self._progress(f"clientes nuevos: {nuevos_count}")

    # ------------------------------------------------------------------
    # Movimientos: mismo esquema que el primer batch, pero saltando
    # cualquier clave de Firebase que ya exista (idempotente).
    # ------------------------------------------------------------------

    def _get_subtipo(self, tipo_nombre, subtipo_nombre):
        if not hasattr(self, "_subtipo_cache"):
            self._subtipo_cache = {}
        key = f"{tipo_nombre}::{subtipo_nombre}"
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
        producto = self.producto_by_codigo.get(codigo.strip().upper())
        if not producto:
            self.report.count("lineas_producto_sin_match")
            return None
        return producto

    def _create_movimiento(self, *, sucursal_vieja, tipo_nombre, subtipo_nombre, estado_nombre, fecha, no_documento,
                            productos_raw, cantidades_raw, precios_raw, casa=None, descripcion="", datos_legado=None):
        if no_documento in self.existing_no_documentos:
            self.report.count(f"{tipo_nombre}_{subtipo_nombre}_ya_migrado_saltado")
            return

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
            producto = self._resolve_producto_line(prod_raw)
            if not producto:
                continue
            cantidad = safe_int(cantidades_raw[i]) if i < len(cantidades_raw) else 0
            if cantidad <= 0:
                continue
            precio = safe_float(precios_raw[i]) if i < len(precios_raw) else 0.0
            lineas.append((producto, cantidad, precio))

        if not lineas:
            self.report.count(f"{tipo_nombre}_{subtipo_nombre}_sin_lineas_validas")
            return

        self.report.count(f"movimientos_{tipo_nombre}_{subtipo_nombre}_planeados")
        if not self.commit:
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
            "lineas": lineas,
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
                sucursal_vieja="Bodega",
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
