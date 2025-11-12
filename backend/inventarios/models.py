from django.db import models


class EstadoProducto(models.Model):
    """Estado físico del producto (Enviado, Recibido, No llego, etc.)."""

    nombre = models.CharField(max_length=80, unique=True)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Estado de producto"
        verbose_name_plural = "Estados de producto"

    def __str__(self) -> str:
        return self.nombre


class Inventario(models.Model):
    """Representa un lote de productos almacenados en una subdivisión específica.

    Ejemplo: Inventario(subdivision=SubDivision(...), producto=Producto(...), cantidad=10).
    """

    subdivision = models.ForeignKey(
        "ubicaciones.SubDivision",
        on_delete=models.CASCADE,
        related_name="inventarios",
    )
    producto = models.ForeignKey(
        "productos.Producto",
        on_delete=models.PROTECT,
        related_name="inventarios",
    )
    estado_producto = models.ForeignKey(
        EstadoProducto,
        on_delete=models.PROTECT,
        related_name="inventarios",
    )
    referencia = models.CharField(max_length=120, blank=True)
    cantidad = models.PositiveIntegerField(default=0)
    cantidad_reservada = models.PositiveIntegerField(default=0)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["subdivision__division__bodega__nombre", "producto__nombre"]
        verbose_name = "Inventario"
        verbose_name_plural = "Inventarios"
        unique_together = ("subdivision", "producto", "estado_producto", "referencia")

    def __str__(self) -> str:
        return f"{self.producto.codigo} - {self.subdivision.nombre} ({self.cantidad} uds)"

    @property
    def disponible(self) -> int:
        """Cantidad disponible considerando reservas."""

        reservado = min(self.cantidad_reservada, self.cantidad)
        return self.cantidad - reservado
