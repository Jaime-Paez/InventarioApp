from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.contenttypes.models import ContentType
from django.db import models


class RegistroAuditoria(models.Model):
    """Almacena un rastro de auditoría para operaciones CRUD."""

    class Acciones(models.TextChoices):
        CREACION = "creacion", "Creación"
        ACTUALIZACION = "actualizacion", "Actualización"
        ELIMINACION = "eliminacion", "Eliminación"
        OTRO = "otro", "Otro"

    usuario = models.ForeignKey(
        "usuarios.Usuario",
        on_delete=models.SET_NULL,
        related_name="registros_auditoria",
        null=True,
        blank=True,
        help_text="Usuario responsable de la acción registrada.",
    )
    accion = models.CharField(
        max_length=20,
        choices=Acciones.choices,
        help_text="Tipo de operación realizada sobre el objeto auditado.",
    )
    content_type = models.ForeignKey(
        ContentType,
        on_delete=models.PROTECT,
        related_name="registros_auditoria",
        help_text="Modelo sobre el cual se ejecutó la acción.",
    )
    object_id = models.CharField(
        max_length=255,
        help_text="Identificador del objeto afectado.",
    )
    objeto = GenericForeignKey("content_type", "object_id")
    representacion_objeto = models.CharField(
        max_length=255,
        blank=True,
        help_text="Representación legible del objeto afectado.",
    )
    valores_previos = models.JSONField(
        null=True,
        blank=True,
        help_text="Valores anteriores del objeto antes del cambio.",
    )
    valores_nuevos = models.JSONField(
        null=True,
        blank=True,
        help_text="Valores resultantes después del cambio.",
    )
    detalles = models.TextField(
        blank=True,
        help_text="Descripción adicional de la acción registrada.",
    )
    registrado_en = models.DateTimeField(
        auto_now_add=True,
        help_text="Fecha y hora en la que se guardó el registro de auditoría.",
    )

    class Meta:
        ordering = ["-registrado_en"]
        verbose_name = "Registro de auditoría"
        verbose_name_plural = "Registros de auditoría"
        indexes = [
            models.Index(fields=["registrado_en"]),
            models.Index(fields=["accion"]),
            models.Index(fields=["content_type", "object_id"]),
        ]

    def __str__(self) -> str:
        objeto = self.representacion_objeto or self.object_id
        usuario = self.usuario if self.usuario else "Sistema"
        return f"{self.get_accion_display()} - {objeto} ({usuario})"
