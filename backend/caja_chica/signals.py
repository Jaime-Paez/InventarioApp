from django.db.models.signals import post_save
from django.dispatch import receiver

from inventario.models import Sucursal


@receiver(post_save, sender=Sucursal)
def crear_caja_de_sucursal(sender, instance, created, raw=False, **kwargs):
    """Cada sucursal nueva nace con su caja chica (sin fondo hasta configurarla)."""
    if raw or not created:
        return
    from .models import Caja

    Caja.objects.get_or_create(sucursal=instance, defaults={"nombre": f"Caja chica {instance.nombre}"})
