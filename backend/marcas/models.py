from django.db import models

from tipos.models import Pais


class Marca(models.Model):
    nombre = models.CharField(max_length=150)
    codigo = models.CharField(max_length=50, unique=True)
    descripcion = models.TextField(blank=True)
    pais = models.ForeignKey(
        Pais,
        on_delete=models.SET_NULL,
        related_name="marcas",
        null=True,
        blank=True,
    )
    telefono = models.CharField(max_length=30, blank=True)
    correo = models.EmailField(blank=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Marca"
        verbose_name_plural = "Marcas"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.nombre} ({self.codigo})"
