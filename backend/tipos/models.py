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


class TipoMovimiento(models.Model):
    """Tipo general de un movimiento de inventario (Ingreso, Salida, etc.)."""

    nombre = models.CharField(max_length=80, unique=True)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Tipo de movimiento"
        verbose_name_plural = "Tipos de movimiento"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return self.nombre


class SubTipoMovimiento(models.Model):
    """Subclasificación para un tipo de movimiento."""

    tipo_movimiento = models.ForeignKey(
        "TipoMovimiento",
        on_delete=models.PROTECT,
        related_name="subtipos",
    )
    nombre = models.CharField(max_length=80)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["tipo_movimiento__nombre", "nombre"]
        verbose_name = "Subtipo de movimiento"
        verbose_name_plural = "Subtipos de movimiento"
        unique_together = ("tipo_movimiento", "nombre")

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.tipo_movimiento.nombre} - {self.nombre}"


class EstadoMovimiento(models.Model):
    """Estado del movimiento de inventario (Borrador, Confirmado, etc.)."""

    nombre = models.CharField(max_length=80, unique=True)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Estado de movimiento"
        verbose_name_plural = "Estados de movimiento"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return self.nombre
