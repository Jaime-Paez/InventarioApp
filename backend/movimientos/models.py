from django.db import models


class MovimientoInventario(models.Model):
    """Representa un movimiento de inventario entre sucursales."""

    sucursal = models.ForeignKey(
        "ubicaciones.Sucursal",
        on_delete=models.PROTECT,
        related_name="movimientos_origen",
    )
    tipo_movimiento = models.ForeignKey(
        "tipos.TipoMovimiento",
        on_delete=models.PROTECT,
        related_name="movimientos",
    )
    sub_tipo_movimiento = models.ForeignKey(
        "tipos.SubTipoMovimiento",
        on_delete=models.PROTECT,
        related_name="movimientos",
        null=True,
        blank=True,
    )
    descripcion = models.TextField(blank=True)
    funcional = models.BooleanField(default=True)
    sucursal_objetivo = models.ForeignKey(
        "ubicaciones.Sucursal",
        on_delete=models.PROTECT,
        related_name="movimientos_destino",
        null=True,
        blank=True,
    )
    estado_movimiento = models.ForeignKey(
        "tipos.EstadoMovimiento",
        on_delete=models.PROTECT,
        related_name="movimientos",
    )
    descuento = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    fecha = models.DateField()
    no_documento = models.CharField(max_length=80)

    class Meta:
        ordering = ["-fecha", "no_documento"]
        verbose_name = "Movimiento de inventario"
        verbose_name_plural = "Movimientos de inventario"
        unique_together = ("tipo_movimiento", "no_documento")

    def __str__(self) -> str:
        return f"{self.tipo_movimiento.nombre} #{self.no_documento}"
