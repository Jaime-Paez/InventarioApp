from django.db import models


class Inventario(models.Model):
    sucursal = models.ForeignKey(
        "sucursales.Sucursal",
        on_delete=models.CASCADE,
        related_name="inventarios",
    )
    producto = models.ForeignKey(
        "catalogo.Producto",
        on_delete=models.CASCADE,
        related_name="inventarios",
    )
    cantidad = models.PositiveIntegerField(default=0)
    punto_reorden = models.PositiveIntegerField(default=0)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Inventario"
        verbose_name_plural = "Inventarios"
        unique_together = ("sucursal", "producto")
        ordering = ["sucursal__nombre", "producto__nombre"]

    def __str__(self) -> str:
        return f"{self.sucursal} - {self.producto}: {self.cantidad}"
