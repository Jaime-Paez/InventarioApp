from decimal import Decimal

from django.db import models
from django.db.models import Q


class MovimientoInventario(models.Model):
    """Representa un movimiento de inventario entre sucursales."""

    sucursal = models.ForeignKey(
        "inventario.Sucursal",
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
        "inventario.Sucursal",
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
    iva_rate = models.DecimalField(
        max_digits=5,
        decimal_places=4,
        default=Decimal("0.15"),
        help_text="IVA aplicado al movimiento, expresado como decimal (ej: 0.15).",
    )
    fecha = models.DateField()
    no_documento = models.CharField(max_length=80)
    tipos_pago = models.ManyToManyField(
        "tipos.TipoPago",
        through="PagoMovimiento",
        related_name="movimientos",
        blank=True,
    )

    class Meta:
        ordering = ["-fecha", "-id"]
        verbose_name = "Movimiento de inventario"
        verbose_name_plural = "Movimientos de inventario"
        unique_together = ("tipo_movimiento", "no_documento")

    def __str__(self) -> str:
        return f"{self.tipo_movimiento.nombre} #{self.no_documento}"


class SolicitudTraslado(models.Model):
    """Solicitud de traslado entre sucursales (A solicita a B)."""

    class Estados(models.TextChoices):
        PENDIENTE = "pendiente", "Pendiente"
        APROBADA = "aprobada", "Aprobada"
        CANCELADA = "cancelada", "Cancelada"

    sucursal_solicitante = models.ForeignKey(
        "inventario.Sucursal",
        on_delete=models.PROTECT,
        related_name="solicitudes_traslado_realizadas",
    )
    sucursal_proveedora = models.ForeignKey(
        "inventario.Sucursal",
        on_delete=models.PROTECT,
        related_name="solicitudes_traslado_recibidas",
    )
    descripcion = models.TextField(blank=True)
    fecha = models.DateField()
    no_documento = models.CharField(max_length=80, unique=True)
    estado = models.CharField(
        max_length=20,
        choices=Estados.choices,
        default=Estados.PENDIENTE,
    )
    movimiento_salida = models.OneToOneField(
        "movimientos.MovimientoInventario",
        on_delete=models.SET_NULL,
        related_name="solicitud_traslado_salida",
        null=True,
        blank=True,
    )
    movimiento_entrada = models.OneToOneField(
        "movimientos.MovimientoInventario",
        on_delete=models.SET_NULL,
        related_name="solicitud_traslado_entrada",
        null=True,
        blank=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-fecha", "-id"]
        verbose_name = "Solicitud de traslado"
        verbose_name_plural = "Solicitudes de traslado"
        constraints = [
            models.CheckConstraint(
                check=~Q(sucursal_solicitante=models.F("sucursal_proveedora")),
                name="solicitud_traslado_sucursales_distintas",
            )
        ]

    def __str__(self) -> str:
        return f"Traslado #{self.no_documento}"


class SolicitudTrasladoDetalle(models.Model):
    """Detalle de productos solicitados en una solicitud de traslado."""

    solicitud = models.ForeignKey(
        SolicitudTraslado,
        on_delete=models.CASCADE,
        related_name="detalles",
    )
    producto = models.ForeignKey(
        "productos.Producto",
        on_delete=models.PROTECT,
        related_name="detalles_solicitud_traslado",
    )
    cantidad = models.PositiveIntegerField()
    valor = models.DecimalField(max_digits=10, decimal_places=2, default=0)

    class Meta:
        verbose_name = "Detalle de solicitud de traslado"
        verbose_name_plural = "Detalles de solicitud de traslado"

    def __str__(self) -> str:
        return f"{self.solicitud.no_documento} - {self.producto.codigo}"


class DetalleMovimiento(models.Model):
    """Detalle de productos incluidos en un movimiento de inventario."""

    movimiento_inventario = models.ForeignKey(
        MovimientoInventario,
        on_delete=models.CASCADE,
        related_name="detalles",
    )
    producto = models.ForeignKey(
        "productos.Producto",
        on_delete=models.PROTECT,
        related_name="detalles_movimiento",
    )
    cantidad = models.PositiveIntegerField()
    estado_producto = models.ForeignKey(
        "tipos.EstadoProducto",
        on_delete=models.PROTECT,
        related_name="detalles_movimiento",
    )
    valor = models.DecimalField(max_digits=10, decimal_places=2)
    valor_total = models.DecimalField(max_digits=12, decimal_places=2)

    class Meta:
        verbose_name = "Detalle de movimiento"
        verbose_name_plural = "Detalles de movimiento"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.movimiento_inventario} - {self.producto.codigo}"


class PagoMovimiento(models.Model):
    """Relación entre un movimiento y los tipos de pago utilizados."""

    movimiento_inventario = models.ForeignKey(
        MovimientoInventario,
        on_delete=models.CASCADE,
        related_name="pagos",
    )
    tipo_pago = models.ForeignKey(
        "tipos.TipoPago",
        on_delete=models.PROTECT,
        related_name="pagos_movimiento",
    )

    class Meta:
        verbose_name = "Pago de movimiento"
        verbose_name_plural = "Pagos de movimiento"
        unique_together = ("movimiento_inventario", "tipo_pago")

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.movimiento_inventario} - {self.tipo_pago.nombre}"
