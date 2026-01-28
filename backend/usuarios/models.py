from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models.signals import post_delete
from django.dispatch import receiver


class Rol(models.Model):
    """Define un rol de acceso para los usuarios del sistema."""

    nombre = models.CharField(max_length=150, unique=True)
    descripcion = models.TextField(blank=True)
    activo = models.BooleanField(default=True)
    es_personalizado = models.BooleanField(default=False)
    usuarios = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        related_name="roles",
        blank=True,
    )

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Rol"
        verbose_name_plural = "Roles"

    def __str__(self) -> str:
        return self.nombre


class RolPermiso(models.Model):
    """Permisos específicos asignados a un rol para un módulo."""

    class Modulos(models.TextChoices):
        USUARIOS = "usuarios", "Administrar"

    class SubModulos(models.TextChoices):
        """Submódulos disponibles para permisos específicos (solo general)."""

        GENERAL = "", "General"

    rol = models.ForeignKey(
        Rol,
        on_delete=models.CASCADE,
        related_name="permisos",
    )
    modulo = models.CharField(max_length=50, choices=Modulos.choices)
    submodulo = models.CharField(
        max_length=50,
        choices=SubModulos.choices,
        blank=True,
        default="",
    )
    puede_crear = models.BooleanField(default=False)
    puede_leer = models.BooleanField(default=False)
    puede_actualizar = models.BooleanField(default=False)
    puede_eliminar = models.BooleanField(default=False)

    class Meta:
        ordering = ["rol__nombre", "modulo", "submodulo"]
        unique_together = ("rol", "modulo", "submodulo")
        verbose_name = "Permiso de rol"
        verbose_name_plural = "Permisos de rol"
        constraints = [
            models.CheckConstraint(
                check=models.Q(submodulo=""),
                name="rol_permiso_sin_submodulos",
            )
        ]

    def __str__(self) -> str:
        if self.submodulo:
            return (
                f"{self.rol} - {self.get_modulo_display()} / "
                f"{self.get_submodulo_display()}"
            )
        return f"{self.rol} - {self.get_modulo_display()}"

    def clean(self):
        super().clean()
        if self.submodulo:
            raise ValidationError(
                {
                    "submodulo": "Los submódulos están deshabilitados; usa solo 'General'.",
                }
            )


class UsuarioPerfil(models.Model):
    """Perfil extendido para usuarios autenticados."""

    usuario = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="perfil",
    )
    telefono = models.CharField(max_length=30, blank=True)
    cargo = models.CharField(max_length=120, blank=True)
    rol_personalizado = models.OneToOneField(
        Rol,
        on_delete=models.SET_NULL,
        related_name="perfil_personalizado",
        null=True,
        blank=True,
    )

    class Meta:
        ordering = ["usuario__last_name", "usuario__first_name"]
        verbose_name = "Perfil de usuario"
        verbose_name_plural = "Perfiles de usuario"

    def __str__(self) -> str:
        nombre = self.usuario.get_full_name().strip()
        return nombre or self.usuario.email or self.usuario.username


@receiver(post_delete, sender=UsuarioPerfil)
def eliminar_rol_personalizado(sender, instance, **kwargs):
    """Elimina el rol/permisos personalizados al borrar el usuario."""

    if instance.rol_personalizado:
        instance.rol_personalizado.permisos.all().delete()
        instance.rol_personalizado.delete()
