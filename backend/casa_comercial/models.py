from django.db import models

from tipos.models import Pais


class CasaComercial(models.Model):
    """Proveedor o casa comercial donde se adquiere el producto."""

    nombre = models.CharField(max_length=150)
    codigo = models.CharField(max_length=50, unique=True)
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

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Casa comercial"
        verbose_name_plural = "Casas comerciales"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.nombre} ({self.codigo})"
