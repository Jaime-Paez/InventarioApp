from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import Inventario
from .por_ubicar import purge_empty_special_rows_on_commit


@receiver(post_save, sender=Inventario)
def borrar_ubicacion_temporal_vacia(sender, instance, raw=False, **kwargs):
    """Cuando una fila de POR UBICAR o TEMPORAL queda en 0 se elimina sola."""
    if raw or instance.cantidad is None or int(instance.cantidad) > 0:
        return
    purge_empty_special_rows_on_commit([instance.pk])
