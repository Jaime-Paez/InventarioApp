from django.conf import settings
from django.contrib.postgres.indexes import GinIndex, OpClass
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models.functions import Upper

from casa_comercial.models import CasaComercial


class Producto(models.Model):
    """Producto disponible para inventario y movimientos."""

    codigo = models.CharField(max_length=80, unique=True)
    nombre = models.CharField(max_length=200)
    descripcion = models.TextField(blank=True)
    referencia = models.CharField(max_length=200, blank=True)
    costo_minimo = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="Costo mínimo de adquisición",
    )
    precio = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="Precio de venta sugerido",
    )

    casas_comerciales = models.ManyToManyField(
        CasaComercial,
        related_name="productos",
        blank=True,
    )
    creado_desde_importacion = models.ForeignKey(
        "importaciones.Importacion",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="productos_generados",
        help_text="Importación desde la que se creó este producto automáticamente por venir sin catálogo.",
    )
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Producto"
        verbose_name_plural = "Productos"
        indexes = [
            models.Index(fields=["nombre"], name="productos_nombre_idx"),
            GinIndex(OpClass(Upper("codigo"), name="gin_trgm_ops"), name="productos_codigo_trgm"),
            GinIndex(OpClass(Upper("nombre"), name="gin_trgm_ops"), name="productos_nombre_trgm"),
            GinIndex(OpClass(Upper("descripcion"), name="gin_trgm_ops"), name="productos_descripcion_trgm"),
            GinIndex(OpClass(Upper("referencia"), name="gin_trgm_ops"), name="productos_referencia_trgm"),
            models.Index(fields=["-creado_en", "-id"], name="productos_creado_en_id_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.nombre} ({self.codigo})"


class OEM(models.Model):
    """Identificador OEM provisto por el fabricante."""

    codigo = models.CharField(max_length=80, unique=True)

    class Meta:
        ordering = ["codigo"]
        verbose_name = "OEM"
        verbose_name_plural = "OEM"
        indexes = [
            GinIndex(OpClass(Upper("codigo"), name="gin_trgm_ops"), name="productos_oem_codigo_trgm"),
        ]

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


class ProductoCalificacion(models.Model):
    """Comentario y calificacion de un producto por usuario."""

    producto = models.ForeignKey(
        Producto,
        on_delete=models.CASCADE,
        related_name="calificaciones",
    )
    usuario = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="calificaciones_producto",
        null=True,
        blank=True,
    )
    estrellas = models.PositiveSmallIntegerField(
        validators=[MinValueValidator(1), MaxValueValidator(5)],
    )
    comentario = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "Calificacion de producto"
        verbose_name_plural = "Calificaciones de producto"

    def __str__(self) -> str:
        return f"{self.producto.codigo} - {self.estrellas} estrella(s)"
