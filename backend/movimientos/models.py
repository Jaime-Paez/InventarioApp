from django.db import models
from django.utils import timezone


class TipoPago(models.Model):
    """Tipos de pago vinculados a un movimiento (contado, transferencia, etc.)."""

    nombre = models.CharField(max_length=80, unique=True)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Tipo de pago"
        verbose_name_plural = "Tipos de pago"

    def __str__(self) -> str:
        return self.nombre


class TipoMovimiento(models.Model):
    """Tipo de proceso del movimiento (Ingreso, Salida, Traslado, etc.)."""

    nombre = models.CharField(max_length=80, unique=True)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Tipo de movimiento"
        verbose_name_plural = "Tipos de movimiento"

    def __str__(self) -> str:
        return self.nombre


class SubTipoMovimiento(models.Model):
    """Subclasificación para un tipo de movimiento (Venta, Traslado interno, etc.)."""

    tipo_movimiento = models.ForeignKey(
        TipoMovimiento,
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

    def __str__(self) -> str:
        return f"{self.tipo_movimiento.nombre} - {self.nombre}"


class EstadoMovimiento(models.Model):
    """Estado del movimiento (Borrador, Confirmado, Cancelado, etc.)."""

    nombre = models.CharField(max_length=80, unique=True)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Estado de movimiento"
        verbose_name_plural = "Estados de movimiento"

    def __str__(self) -> str:
        return self.nombre


class MovimientoInventario(models.Model):
    """Encabezado del movimiento de inventario.

    Ejemplo: MovimientoInventario(tipo_movimiento=Ingreso, subdivision=SubDivision(...), fecha_documento=2024-01-01).
    """

    subdivision = models.ForeignKey(
        "ubicaciones.SubDivision",
        on_delete=models.PROTECT,
        related_name="movimientos",
    )
    tipo_movimiento = models.ForeignKey(
        TipoMovimiento,
        on_delete=models.PROTECT,
        related_name="movimientos",
    )
    sub_tipo_movimiento = models.ForeignKey(
        SubTipoMovimiento,
        on_delete=models.PROTECT,
        related_name="movimientos",
        null=True,
        blank=True,
    )
    estado = models.ForeignKey(
        EstadoMovimiento,
        on_delete=models.PROTECT,
        related_name="movimientos",
    )
    tipo_pago = models.ForeignKey(
        TipoPago,
        on_delete=models.SET_NULL,
        related_name="movimientos",
        null=True,
        blank=True,
    )
    fecha_documento = models.DateField()
    numero_documento = models.CharField(max_length=80)
    observaciones = models.TextField(blank=True)
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-fecha_documento", "numero_documento"]
        verbose_name = "Movimiento de inventario"
        verbose_name_plural = "Movimientos de inventario"
        unique_together = ("tipo_movimiento", "numero_documento")

    def __str__(self) -> str:
        return f"{self.tipo_movimiento.nombre} #{self.numero_documento}"


class DetalleMovimiento(models.Model):
    """Detalle del movimiento, donde se registra cada producto movilizado."""

    movimiento = models.ForeignKey(
        MovimientoInventario,
        on_delete=models.CASCADE,
        related_name="detalles",
    )
    inventario = models.ForeignKey(
        "inventarios.Inventario",
        on_delete=models.PROTECT,
        related_name="movimientos",
    )
    producto = models.ForeignKey(
        "productos.Producto",
        on_delete=models.PROTECT,
        related_name="movimientos",
    )
    estado_producto = models.ForeignKey(
        "inventarios.EstadoProducto",
        on_delete=models.PROTECT,
        related_name="movimientos",
    )
    cantidad = models.PositiveIntegerField()
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Detalle de movimiento"
        verbose_name_plural = "Detalles de movimiento"
        ordering = ["movimiento__fecha_documento", "producto__nombre"]

    def __str__(self) -> str:
        return f"{self.producto.codigo} x{self.cantidad} ({self.movimiento.numero_documento})"


class PagoMovimiento(models.Model):
    """Pagos asociados a un movimiento de inventario."""

    movimiento = models.ForeignKey(
        MovimientoInventario,
        on_delete=models.CASCADE,
        related_name="pagos",
    )
    tipo_pago = models.ForeignKey(
        TipoPago,
        on_delete=models.PROTECT,
        related_name="pagos",
    )
    fecha_pago = models.DateField(default=timezone.now)
    monto = models.DecimalField(max_digits=12, decimal_places=2)
    referencia = models.CharField(max_length=120, blank=True)
    notas = models.TextField(blank=True)
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-fecha_pago", "movimiento__numero_documento"]
        verbose_name = "Pago de movimiento"
        verbose_name_plural = "Pagos de movimiento"

    def __str__(self) -> str:
        return f"{self.tipo_pago.nombre} - {self.monto} ({self.movimiento.numero_documento})"
