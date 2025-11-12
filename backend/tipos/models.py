from django.db import models


class Pais(models.Model):
    """País de origen o comercialización."""

    codigo_tais = models.CharField(max_length=10, unique=True)
    nombre = models.CharField(max_length=120)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "País"
        verbose_name_plural = "Países"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return self.nombre
