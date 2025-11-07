from django.db import models


class Salida(models.Model):
    TIPO_SALIDA = [
        ("venta", "Venta"),
        ("sucursal", "Traslado a sucursal"),
    ]

    folio = models.CharField(max_length=50, unique=True)
    sucursal_origen = models.ForeignKey(
        "sucursales.Sucursal",
        on_delete=models.PROTECT,
        related_name="salidas_origen",
    )
    sucursal_destino = models.ForeignKey(
        "sucursales.Sucursal",
        on_delete=models.PROTECT,
        related_name="salidas_destino",
        null=True,
        blank=True,
    )
    responsable = models.ForeignKey(
        "usuarios.Usuario",
        on_delete=models.SET_NULL,
        related_name="salidas",
        null=True,
        blank=True,
    )
    tipo = models.CharField(max_length=20, choices=TIPO_SALIDA)
    fecha = models.DateField()
    observaciones = models.TextField(blank=True)

    class Meta:
        ordering = ["-fecha", "folio"]
        verbose_name = "Salida"
        verbose_name_plural = "Salidas"

    def __str__(self) -> str:
        return f"{self.get_tipo_display()} #{self.folio}"


class SalidaDetalle(models.Model):
    salida = models.ForeignKey(
        Salida,
        on_delete=models.CASCADE,
        related_name="detalles",
    )
    producto = models.ForeignKey(
        "catalogo.Producto",
        on_delete=models.PROTECT,
        related_name="salidas",
    )
    cantidad = models.PositiveIntegerField()
    precio_unitario = models.DecimalField(max_digits=12, decimal_places=2)

    class Meta:
        verbose_name = "Detalle de salida"
        verbose_name_plural = "Detalles de salida"
        unique_together = ("salida", "producto")

    def __str__(self) -> str:
        return f"{self.producto} x{self.cantidad}"
