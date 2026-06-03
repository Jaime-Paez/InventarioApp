from django.db import models

from tipos.models import Pais


class CasaComercial(models.Model):
    """Proveedor o casa comercial donde se adquiere el producto."""

    TIPO_LOCAL = "local"
    TIPO_IMPORTACION = "importacion"
    TIPO_CHOICES = [
        (TIPO_LOCAL, "Local"),
        (TIPO_IMPORTACION, "Importación"),
    ]

    nombre = models.CharField(max_length=150)
    codigo = models.CharField(max_length=50)
    tipo = models.CharField(max_length=20, choices=TIPO_CHOICES, default=TIPO_LOCAL)
    descripcion = models.TextField(blank=True)
    pais = models.ForeignKey(
        Pais,
        on_delete=models.SET_NULL,
        related_name="casas_comerciales",
        null=True,
        blank=True,
    )
    telefono = models.CharField(max_length=30, blank=True)
    correo = models.EmailField(blank=True)
    dias_entrega = models.PositiveSmallIntegerField(
        null=True,
        blank=True,
        help_text="Días aproximados que tarda la casa comercial en entregar mercadería.",
    )

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Casa comercial"
        verbose_name_plural = "Casas comerciales"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.nombre} ({self.codigo})"
