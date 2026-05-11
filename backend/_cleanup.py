import os
import django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'core.settings')
django.setup()

from movimientos.models import (
    TrasladoInconvenienteHistorial, TrasladoInconveniente,
    SolicitudTrasladoDetalle, SolicitudTraslado,
    DetalleMovimiento, PagoMovimiento, MovimientoInventario,
)
from inventario.models import Inventario

counts = {
    'TrasladoInconvenienteHistorial': TrasladoInconvenienteHistorial.objects.count(),
    'TrasladoInconveniente': TrasladoInconveniente.objects.count(),
    'SolicitudTrasladoDetalle': SolicitudTrasladoDetalle.objects.count(),
    'SolicitudTraslado': SolicitudTraslado.objects.count(),
    'DetalleMovimiento': DetalleMovimiento.objects.count(),
    'PagoMovimiento': PagoMovimiento.objects.count(),
    'MovimientoInventario': MovimientoInventario.objects.count(),
    'Inventario': Inventario.objects.count(),
}

TrasladoInconvenienteHistorial.objects.all().delete()
TrasladoInconveniente.objects.all().delete()
SolicitudTrasladoDetalle.objects.all().delete()
SolicitudTraslado.objects.all().delete()
DetalleMovimiento.objects.all().delete()
PagoMovimiento.objects.all().delete()
MovimientoInventario.objects.all().delete()
Inventario.objects.all().delete()

for k, v in counts.items():
    print(f'  {k}: {v} eliminados')
print('Listo.')
