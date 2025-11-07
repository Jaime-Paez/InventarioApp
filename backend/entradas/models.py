from django.db import models


class Entrada(models.Model):
    TIPO_ENTRADA = [
        ("compra", "Compra"),
        ("devolucion", "Devolución"),
    ]

    folio = models.CharField(max_length=50, unique=True)
    sucursal = models.ForeignKey(
        "sucursales.Sucursal",
        on_delete=models.PROTECT,
        related_name="entradas",
    )
    responsable = models.ForeignKey(
        "usuarios.Usuario",
        on_delete=models.SET_NULL,
        related_name="entradas",
        null=True,
        blank=True,
    )
    tipo = models.CharField(max_length=20, choices=TIPO_ENTRADA)
    tipo_compra = models.ForeignKey(
        "catalogo.TipoCompra",
        on_delete=models.PROTECT,
        related_name="entradas",
        null=True,
        blank=True,
    )
    tipo_pago = models.ForeignKey(
        "catalogo.TipoPago",
        on_delete=models.PROTECT,
        related_name="entradas",
        null=True,
        blank=True,
    )
    fecha = models.DateField()
    observaciones = models.TextField(blank=True)

    class Meta:
        ordering = ["-fecha", "folio"]
        verbose_name = "Entrada"
        verbose_name_plural = "Entradas"

    def __str__(self) -> str:
        return f"{self.get_tipo_display()} #{self.folio}"


class EntradaDetalle(models.Model):
    entrada = models.ForeignKey(
        Entrada,
        on_delete=models.CASCADE,
        related_name="detalles",
    )
    producto = models.ForeignKey(
        "catalogo.Producto",
        on_delete=models.PROTECT,
        related_name="entradas",
    )
    cantidad = models.PositiveIntegerField()
    costo_unitario = models.DecimalField(max_digits=12, decimal_places=2)

    class Meta:
        verbose_name = "Detalle de entrada"
        verbose_name_plural = "Detalles de entrada"
        unique_together = ("entrada", "producto")

    def __str__(self) -> str:
        return f"{self.producto} x{self.cantidad}"
