"""
Encuentra productos "genericos" en el catalogo que en realidad deberian
llevar el sufijo -L o -R, porque comparten un OEM o una referencia con un
hermano que ya existe con ese sufijo (ej: "P2066PX" vs "P2066PX-L" /
"P2066PX-R" -- el mismo bug que causo P2066PX, P1915PX, C0363PX y C0755PX).

Solo compara el codigo EXACTO sin el sufijo -L/-R contra el genérico (no
solo "le falta algun sufijo"), para no marcar como sospechosos codigos con
sufijos compuestos legitimos (ej: "-RD", "-LA", "-AFP") que son variantes
distintas, no duplicados.

Uso:
    python manage.py detectar_duplicados_lado              # solo reporta
    python manage.py detectar_duplicados_lado --fix         # además borra
                                                              los genericos
                                                              seguros (sin
                                                              stock ni
                                                              movimientos)

Un genérico se considera "seguro" para borrar con --fix solo si:
  - No tiene stock en ninguna sucursal.
  - No tiene movimientos (entradas/salidas) ni aparece en ninguna
    solicitud de cliente.
  - Si aparece en detalles de importación, esos detalles se reasignan al
    hermano correcto antes de borrar (no se pierden).
Cualquier otro caso se reporta para revisar a mano -- por ejemplo un "KIT"
que comparte OEM con sus piezas sueltas es un producto real y distinto,
no un duplicado (ver P2732AFP).
"""

import re

from django.apps import apps
from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Sum

from productos.models import OEMProducto, Producto, ProductoReferencia

SIDE_RE = re.compile(r"^(.*)-(L|R)$", re.IGNORECASE)


class Command(BaseCommand):
    help = "Detecta (y opcionalmente corrige) productos genericos que deberian llevar sufijo -L/-R"

    def add_arguments(self, parser):
        parser.add_argument(
            "--fix",
            action="store_true",
            help="Ademas de reportar, borra los genericos que no tengan stock ni historial real",
        )

    def handle(self, *args, **options):
        fix = options["fix"]

        by_oem = {}
        for op in OEMProducto.objects.select_related("producto", "oem"):
            by_oem.setdefault(op.oem.codigo, set()).add(op.producto_id)
        by_referencia = {}
        for pr in ProductoReferencia.objects.select_related("producto"):
            by_referencia.setdefault(pr.valor.upper(), set()).add(pr.producto_id)

        productos_by_id = {p.id: p for p in Producto.objects.all()}
        codigo_to_id = {p.codigo: p.id for p in productos_by_id.values()}

        # generico_id -> {"hermano_id":..., "sufijo":..., "via": "OEM 123"}
        candidatos = {}
        for valor_a_ids, tipo in ((by_oem, "OEM"), (by_referencia, "referencia")):
            for valor, ids in valor_a_ids.items():
                if len(ids) < 2:
                    continue
                for pid in ids:
                    codigo = productos_by_id[pid].codigo
                    m = SIDE_RE.match(codigo)
                    if not m:
                        continue
                    base, lado = m.group(1), m.group(2).upper()
                    generico_id = codigo_to_id.get(base)
                    if generico_id is not None and generico_id in ids and generico_id != pid:
                        candidatos.setdefault(
                            generico_id,
                            {"hermano_id": pid, "sufijo": lado, "via": f"{tipo} {valor}"},
                        )

        if not candidatos:
            self.stdout.write(self.style.SUCCESS("No se encontraron genericos sospechosos."))
            return

        self.stdout.write(f"Encontrados: {len(candidatos)}\n")

        for generico_id, info in candidatos.items():
            generico = productos_by_id[generico_id]
            hermano = productos_by_id[info["hermano_id"]]
            nuevo_codigo = f"{generico.codigo}-{info['sufijo']}"
            mismo_nombre = generico.nombre.strip().lower() == hermano.nombre.strip().lower()

            stock_total = self._stock_total(generico)
            dependientes = self._collect_dependents(generico)
            detalles_importacion = dependientes.pop("importaciones.ImportacionDetalle", 0)
            bloqueantes = dependientes

            es_seguro = mismo_nombre and stock_total == 0 and not bloqueantes

            self.stdout.write(
                f"  {generico.codigo} (precio={generico.precio}, stock={stock_total}) "
                f"-- comparte {info['via']} con {hermano.codigo} -- sugerido: {nuevo_codigo}"
            )
            if not mismo_nombre:
                self.stdout.write(
                    self.style.WARNING(
                        f"    nombre distinto al hermano ({generico.nombre!r} vs {hermano.nombre!r}) "
                        "-- puede ser un producto real y distinto (ej. un kit), no un duplicado. Revisar a mano."
                    )
                )
            elif bloqueantes:
                self.stdout.write(
                    self.style.WARNING(f"    tiene historial real que no se puede fusionar solo: {bloqueantes}")
                )
            elif not fix:
                self.stdout.write("    seguro para corregir (sin stock ni historial) -- correr con --fix")

            if fix and es_seguro:
                self._fix_generic(generico, hermano, detalles_importacion)
                self.stdout.write(self.style.SUCCESS(f"    corregido: {generico.codigo} eliminado"))

    @staticmethod
    def _collect_dependents(producto):
        """{'app_label.Model': cantidad} para todo lo que apunta a este producto,
        exceptuando lo que se borra en cascada solo (OEM/referencia/alterno) y
        el inventario (que se revisa aparte por cantidad real, no por filas)."""
        ignorados = {
            "productos.OEMProducto",
            "productos.ProductoReferencia",
            "productos.ProductoAlterno",
            "inventario.Inventario",
        }
        resultado = {}
        for model in apps.get_models():
            label = model._meta.label
            if label in ignorados:
                continue
            for field in model._meta.get_fields():
                if getattr(field, "related_model", None) is Producto and field.concrete:
                    count = model.objects.filter(**{field.name: producto}).count()
                    if count:
                        resultado[label] = resultado.get(label, 0) + count
        return resultado

    @staticmethod
    def _stock_total(producto):
        from inventario.models import Inventario

        return Inventario.objects.filter(producto=producto).aggregate(total=Sum("cantidad"))["total"] or 0

    @staticmethod
    def _fix_generic(generico, hermano, detalles_importacion_count):
        with transaction.atomic():
            if detalles_importacion_count:
                from importaciones.models import ImportacionDetalle

                ImportacionDetalle.objects.filter(producto=generico).update(
                    producto=hermano, codigo=hermano.codigo
                )
            generico.delete()
