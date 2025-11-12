from django.db import models

from casa_comercial.models import CasaComercial
from marcas.models import Marca


class Producto(models.Model):
    """Producto disponible para inventario y movimientos."""

    codigo = models.CharField(max_length=80, unique=True)
    nombre = models.CharField(max_length=200)
    descripcion = models.TextField(blank=True)
    pieza_original = models.BooleanField(default=False)
    referencia_fabricante = models.CharField(max_length=120, blank=True)
    casa_comercial = models.ForeignKey(
        CasaComercial,
        on_delete=models.SET_NULL,
        related_name="productos",
        null=True,
        blank=True,
    )
    marca = models.ForeignKey(
        Marca,
        on_delete=models.PROTECT,
        related_name="productos",
    )
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Producto"
        verbose_name_plural = "Productos"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.nombre} ({self.codigo})"


class OEM(models.Model):
    """Identificador OEM provisto por el fabricante."""

    codigo = models.CharField(max_length=80, unique=True)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["codigo"]
        verbose_name = "OEM"
        verbose_name_plural = "OEM"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return self.codigo


class OEMProducto(models.Model):
    """Relación entre un producto y un código OEM."""

    producto = models.ForeignKey(
        Producto,
        on_delete=models.CASCADE,
        related_name="oem_productos",
    )
    oem = models.ForeignKey(
        OEM,
        on_delete=models.CASCADE,
        related_name="productos",
    )

    class Meta:
        verbose_name = "OEM de producto"
        verbose_name_plural = "OEM por producto"
        unique_together = ("producto", "oem")

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.producto.codigo} - {self.oem.codigo}"


class ProductoAlterno(models.Model):
    """Relación entre un producto y sus alternativas compatibles."""

    producto = models.ForeignKey(
        Producto,
        on_delete=models.CASCADE,
        related_name="alternativas",
    )
    alterno = models.ForeignKey(
        Producto,
        on_delete=models.CASCADE,
        related_name="alternativas_para",
    )
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Producto alterno"
        verbose_name_plural = "Productos alternos"
        unique_together = ("producto", "alterno")

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"Alterno de {self.producto.codigo}: {self.alterno.codigo}"
