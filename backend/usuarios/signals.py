from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import Usuario
from .utils import ensure_personalized_role, sync_auth_user_from_usuario


User = get_user_model()


@receiver(post_save, sender=User)
def crear_usuario_interno_desde_auth(sender, instance, created, **kwargs):
    """Crea o sincroniza el usuario interno cuando se crea/actualiza un User de auth."""

    email = (instance.email or "").strip().lower()
    if not email:
        return

    usuario = (
        Usuario.objects.filter(correo__iexact=email).first()
        or Usuario(
            correo=email,
            nombres=instance.first_name or instance.username or email,
            apellidos=instance.last_name or "",
            activo=True,
        )
    )

    updates = []
    if usuario.id:
        if usuario.nombres != (instance.first_name or usuario.nombres):
            usuario.nombres = instance.first_name or usuario.nombres
            updates.append("nombres")
        if usuario.apellidos != (instance.last_name or usuario.apellidos):
            usuario.apellidos = instance.last_name or usuario.apellidos
            updates.append("apellidos")
        if usuario.correo != email:
            usuario.correo = email
            updates.append("correo")
        if updates:
            usuario.save(update_fields=updates)
    else:
        usuario.save()

    ensure_personalized_role(usuario)
    sync_auth_user_from_usuario(usuario, create_if_missing=False)
