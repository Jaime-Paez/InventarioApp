"""Carga el saldo inicial del Kardex desde el export de Firebase del sistema
anterior: el stock de cada producto en cada sucursal al migrar (el mismo con
el que se lleno Inventario en migrate_legacy_json).

    python manage.py cargar_saldo_inicial "DATOS 21 DE OCTUBRE ... .json" [--dry-run]

Reemplaza todos los saldos iniciales (se puede correr de nuevo sin duplicar).
"""

import json
import unicodedata
from collections import defaultdict

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from inventario.models import SaldoInicialInventario, Sucursal
from productos.models import Producto

# Igual que app/management/commands/migrate_legacy_json.py: la Bodega era de
# la matriz.
SUCURSAL_VIEJA_A_NUEVA = {
    "9 de Octubre": "9 DE OCTUBRE",
    "Bodega": "9 DE OCTUBRE",
    "Norte": "NORTE",
    "Sur": "SUR",
    "Tumbaco": "TUMBACO",
    "Valle": "VALLE",
}


def _upper(text):
    raw = unicodedata.normalize("NFD", str(text or ""))
    return "".join(ch for ch in raw if unicodedata.category(ch) != "Mn").strip().upper()


class Command(BaseCommand):
    help = "Carga el saldo inicial del Kardex desde el export JSON del sistema anterior."

    def add_arguments(self, parser):
        parser.add_argument("archivo")
        parser.add_argument("--dry-run", action="store_true", help="Solo muestra lo que cargaria.")

    def handle(self, *args, archivo, dry_run=False, **options):
        try:
            with open(archivo, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError) as exc:
            raise CommandError(f"No se pudo leer {archivo}: {exc}")
        inventario = data.get("Inventario")
        if not isinstance(inventario, dict):
            raise CommandError("El archivo no tiene la seccion Inventario.")

        sucursal_por_vieja = {}
        for sid, nombre in Sucursal.objects.values_list("id", "nombre"):
            for vieja, hint in SUCURSAL_VIEJA_A_NUEVA.items():
                if hint in _upper(nombre):
                    sucursal_por_vieja[vieja] = sid
        faltan = sorted(set(SUCURSAL_VIEJA_A_NUEVA) - set(sucursal_por_vieja))
        if faltan:
            raise CommandError(f"No se encontro la sucursal nueva de: {', '.join(faltan)}")

        producto_por_codigo = {
            str(codigo).strip().upper(): pid for codigo, pid in Producto.objects.values_list("codigo", "id")
        }
        saldos = defaultdict(int)
        sin_producto = 0
        for entry in inventario.values():
            pid = producto_por_codigo.get(str(entry.get("codigo") or "").strip().upper())
            if not pid:
                sin_producto += 1
                continue
            for vieja, estado in (entry.get("estado") or {}).items():
                sid = sucursal_por_vieja.get(vieja)
                if not sid or not isinstance(estado, dict):
                    continue
                try:
                    stock = int(float(estado.get("stock") or 0))
                except (TypeError, ValueError):
                    stock = 0
                if stock > 0:
                    saldos[(pid, sid)] += stock

        origen = f"Migracion del sistema anterior ({archivo.replace(chr(92), '/').rsplit('/', 1)[-1]})"[:200]
        self.stdout.write(
            f"{len(saldos)} saldos ({sum(saldos.values())} unidades); {sin_producto} productos del archivo sin match."
        )
        if dry_run:
            self.stdout.write("Dry run: no se guardo nada.")
            return
        with transaction.atomic():
            SaldoInicialInventario.objects.all().delete()
            SaldoInicialInventario.objects.bulk_create(
                [
                    SaldoInicialInventario(producto_id=pid, sucursal_id=sid, cantidad=cantidad, origen=origen)
                    for (pid, sid), cantidad in saldos.items()
                ],
                batch_size=2000,
            )
        self.stdout.write(self.style.SUCCESS("Saldo inicial cargado."))
