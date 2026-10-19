from django.db import models


class Sucursal(models.Model):
    """Sucursal física donde se almacenan productos."""

    nombre = models.CharField(max_length=120)
    direccion = models.CharField(max_length=255)
    latitud = models.DecimalField(max_digits=9, decimal_places=6, default=0)
    longitud = models.DecimalField(max_digits=9, decimal_places=6, default=0)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Sucursal"
        verbose_name_plural = "Sucursales"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return self.nombre


class Bodega(models.Model):
    """Bodega dentro de una sucursal."""

    sucursal = models.ForeignKey(
        Sucursal,
        on_delete=models.CASCADE,
        related_name="bodegas",
    )
    nombre = models.CharField(max_length=120)
    ancho_metros = models.DecimalField(max_digits=8, decimal_places=2, default=0)
    alto_metros = models.DecimalField(max_digits=8, decimal_places=2, default=0)
    ubicaciones = models.JSONField(default=list, blank=True)

    class Meta:
        ordering = ["sucursal__nombre", "nombre"]
        verbose_name = "Bodega"
        verbose_name_plural = "Bodegas"
        unique_together = ("sucursal", "nombre")

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.nombre} - {self.sucursal.nombre}"


class Division(models.Model):
    """División dentro de una bodega."""

    tipo_division = models.ForeignKey(
        "tipos.TipoDivision",
        on_delete=models.PROTECT,
        related_name="divisiones",
    )
    bodega = models.ForeignKey(
        Bodega,
        on_delete=models.CASCADE,
        related_name="divisiones",
    )
    nombre = models.CharField(max_length=120)

    class Meta:
        ordering = ["bodega__nombre", "nombre"]
        verbose_name = "División"
        verbose_name_plural = "Divisiones"
        unique_together = ("bodega", "nombre")

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.nombre} - {self.bodega.nombre}"


class SubDivision(models.Model):
    """Subdivisión dentro de una división."""

    division = models.ForeignKey(
        Division,
        on_delete=models.CASCADE,
        related_name="subdivisiones",
    )
    nombre = models.CharField(max_length=120)

    class Meta:
        ordering = ["division__nombre", "nombre"]
        verbose_name = "Subdivisión"
        verbose_name_plural = "Subdivisiones"
        unique_together = ("division", "nombre")

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.nombre} ({self.division.nombre})"


class Inventario(models.Model):
    """Inventario disponible dentro de una subdivisión."""

    producto = models.ForeignKey(
        "productos.Producto",
        on_delete=models.PROTECT,
        related_name="inventarios",
    )
    subdivision = models.ForeignKey(
        SubDivision,
        on_delete=models.CASCADE,
        related_name="inventarios",
    )
    cantidad = models.PositiveIntegerField(default=0)
    referencia = models.CharField(max_length=120, blank=True)

    class Meta:
        ordering = ["subdivision__division__bodega__nombre", "producto__nombre"]
        verbose_name = "Inventario"
        verbose_name_plural = "Inventarios"
        unique_together = ("subdivision", "producto", "referencia")
        indexes = [
            models.Index(fields=["cantidad"], name="inventario_cantidad_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.producto.codigo} - {self.subdivision.nombre} ({self.cantidad} uds)"


class ProductoUbicacionOrden(models.Model):
    """Orden de las ubicaciones de un producto que eligio el usuario
    (arrastrando en la pestana Ubicaciones). En cada sucursal, la primera es
    la ubicacion principal: la que se muestra en la tabla y la que pone el ojo
    en rojo cuando le queda poco stock.

    Va aparte del Inventario porque esas filas se borran al quedar en 0 al
    mover stock, y el orden elegido no se debe perder.
    """

    producto = models.ForeignKey(
        "productos.Producto",
        on_delete=models.CASCADE,
        related_name="orden_ubicaciones",
    )
    subdivision = models.ForeignKey(
        SubDivision,
        on_delete=models.CASCADE,
        related_name="orden_productos",
    )
    orden = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = "Orden de ubicacion de producto"
        verbose_name_plural = "Orden de ubicaciones de productos"
        constraints = [
            models.UniqueConstraint(
                fields=["producto", "subdivision"], name="producto_ubicacion_orden_unico"
            ),
        ]
        indexes = [
            models.Index(fields=["producto", "orden"], name="prod_ubic_orden_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover - representacion legible
        return f"{self.producto_id} - {self.subdivision_id}: {self.orden}"
