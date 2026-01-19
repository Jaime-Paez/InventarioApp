from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import UsuarioPerfil


User = get_user_model()


@receiver(post_save, sender=User)
def crear_perfil_usuario(sender, instance, created, **kwargs):
    """Crea el perfil extendido cuando se crea un usuario autenticado."""

    if created:
        UsuarioPerfil.objects.get_or_create(usuario=instance)
