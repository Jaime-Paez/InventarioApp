"""
Script para resetear la base de datos para pruebas desde cero.
Ejecutar desde la carpeta backend/:
    python reset_para_pruebas.py

Acciones:
  1. Vacia todos los ReminderState (recordatorios)
  2. Elimina todas las Solicitudes de clientes y sus dependientes
  3. Elimina todas las SolicitudesTraslado y sus dependientes
  4. Elimina todos los MovimientoInventario y sus dependientes
  5. Pone todas las cantidades de Inventario en 20
"""
import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from django.db import transaction
from app.models import ReminderState
from movimientos.models import (
    SolicitudTraslado,
    MovimientoInventario,
)
from solicitudes.models import (
    Solicitud,
    ProductoSolicitado,
    Cliente,
    Auto,
    RevisionReferencia,
    OEMProductoSolicitado,
)
from inventario.models import Inventario


with transaction.atomic():

    # ── 1. Recordatorios ────────────────────────────────────────────────────
    reminders = ReminderState.objects.all()
    for r in reminders:
        r.payload = []
        r.save(update_fields=["payload", "updated_at"])
    print(f"Recordatorios vaciados: {reminders.count()} registro(s)")

    # ── 2. Solicitudes de clientes ──────────────────────────────────────────
    n_rev, _ = RevisionReferencia.objects.all().delete()
    n_oem, _ = OEMProductoSolicitado.objects.all().delete()
    n_sol, _ = Solicitud.objects.all().delete()
    n_ps, _  = ProductoSolicitado.objects.all().delete()
    n_auto, _ = Auto.objects.all().delete()
    n_cli, _  = Cliente.objects.all().delete()
    print(f"Solicitudes de clientes:  {n_sol} eliminadas")
    print(f"  Revisiones:             {n_rev}")
    print(f"  OEM producto solicitado: {n_oem}")
    print(f"  Productos solicitados:  {n_ps}")
    print(f"  Autos:                  {n_auto}")
    print(f"  Clientes:               {n_cli}")

    # ── 3. Solicitudes de traslado ──────────────────────────────────────────
    traslados = SolicitudTraslado.objects.all()
    salida_ids = list(traslados.exclude(movimiento_salida=None).values_list("movimiento_salida_id", flat=True))
    entrada_ids = list(traslados.exclude(movimiento_entrada=None).values_list("movimiento_entrada_id", flat=True))
    traslados_mov_ids = list(set(salida_ids + entrada_ids))

    # Desvincular para evitar conflictos SET_NULL al borrar movimientos
    traslados.update(movimiento_salida=None, movimiento_entrada=None)
    n_traslado, _ = SolicitudTraslado.objects.all().delete()
    print(f"Solicitudes de traslado:  {n_traslado} eliminadas")

    # ── 4. Movimientos (entradas y salidas) ─────────────────────────────────
    n_mov, detail = MovimientoInventario.objects.all().delete()
    print(f"Movimientos eliminados:   {n_mov} — {detail}")

    # ── 5. Inventario → cantidad 20 ─────────────────────────────────────────
    n_inv = Inventario.objects.update(cantidad=20)
    print(f"Registros de inventario con cantidad=20: {n_inv}")

print("\n¡Listo! Base lista para pruebas desde cero (inventario en 20 unidades).")
