from django.db import models


class Sucursal(models.Model):
    codigo = models.CharField(max_length=30, unique=True)
    nombre = models.CharField(max_length=120)
    direccion = models.CharField(max_length=255)
    ciudad = models.CharField(max_length=120)
    telefono = models.CharField(max_length=30, blank=True)
    es_principal = models.BooleanField(default=False)
    activo = models.BooleanField(default=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Sucursal"
        verbose_name_plural = "Sucursales"

    def __str__(self) -> str:
        return f"{self.nombre} ({self.codigo})"
