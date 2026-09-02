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


class ProductoReferencia(models.Model):
    """Referencia (código de fabricante/proveedor) de un producto.

    A diferencia del OEM, una referencia NO se comparte entre productos --
    cada una pertenece a un único producto (unique_together por producto,
    no global) -- pero un mismo producto puede tener varias.
    """

    producto = models.ForeignKey(
        Producto,
        on_delete=models.CASCADE,
        related_name="referencias",
    )
    valor = models.CharField(max_length=200)
    creado_en = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["id"]
        verbose_name = "Referencia de producto"
        verbose_name_plural = "Referencias de producto"
        unique_together = ("producto", "valor")
        indexes = [
            GinIndex(OpClass(Upper("valor"), name="gin_trgm_ops"), name="productos_pref_valor_trgm"),
        ]

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.producto.codigo} - {self.valor}"


def sync_producto_referencia_primary(producto):
    """Mantiene Producto.referencia como una copia de solo lectura de la
    primera referencia agregada (por id) del producto -- para no romper a
    los muchos lugares del código que todavía leen ese campo como si fuera
    un solo valor (búsquedas, columnas, exportaciones, "compra local", etc.)
    mientras la lista completa vive en ProductoReferencia. Nunca se debe
    escribir Producto.referencia a mano en código nuevo; usar
    add_producto_referencia() en su lugar.
    """
    primera = producto.referencias.order_by("id").first()
    valor = primera.valor if primera else ""
    if valor != (producto.referencia or ""):
        producto.referencia = valor
        producto.save(update_fields=["referencia"])


def add_producto_referencia(producto, valor):
    """Agrega `valor` a las referencias de `producto` si no la tiene ya
    (comparación exacta sin distinguir mayúsculas/minúsculas), y mantiene
    sincronizado Producto.referencia. No falla ni duplica si la referencia
    ya existe -- solo la devuelve. Ignora valores vacíos.
    """
    valor = str(valor or "").strip()
    if not valor:
        return None
    existing = producto.referencias.filter(valor__iexact=valor).first()
    if existing:
        return existing
    referencia = ProductoReferencia.objects.create(producto=producto, valor=valor)
    sync_producto_referencia_primary(producto)
    return referencia


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
