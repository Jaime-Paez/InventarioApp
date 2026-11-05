"""Registro de ajustes de inventario (cambios de stock que no son entrada ni
salida). Se llama DESPUES de cambiar el stock, dentro de la misma
transaccion: el total actual de la sucursal es la cantidad nueva."""

from django.db.models import Sum

from .models import AjusteInventario, Inventario


def registrar_ajuste_inventario(*, producto_id, sucursal_id, diferencia, motivo, usuario=None):
    diferencia = int(diferencia or 0)
    if not diferencia or not producto_id or not sucursal_id:
        return None
    nueva = int(
        Inventario.objects.filter(
            producto_id=int(producto_id),
            subdivision__division__bodega__sucursal_id=int(sucursal_id),
        ).aggregate(total=Sum("cantidad"))["total"]
        or 0
    )
    return AjusteInventario.objects.create(
        producto_id=int(producto_id),
        sucursal_id=int(sucursal_id),
        cantidad_anterior=nueva - diferencia,
        cantidad_nueva=nueva,
        diferencia=diferencia,
        motivo=str(motivo or "Ajuste de inventario")[:200],
        usuario=usuario if getattr(usuario, "is_authenticated", False) else None,
    )
