from decimal import Decimal

from django.conf import settings
from django.db import models


class ManoObra(models.Model):
    """Catalogo de trabajos de mano de obra con su precio fijo.

    En la orden siempre se puede escribir cualquier otro trabajo a mano: el
    catalogo solo acelera lo frecuente.
    """

    nombre = models.CharField(max_length=200)
    precio = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("0"))
    activo = models.BooleanField(default=True)
    creado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Mano de obra"
        verbose_name_plural = "Mano de obra"

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.nombre} (${self.precio})"


class OrdenTaller(models.Model):
    """Cotizacion de taller que, si el cliente acepta, pasa a orden de trabajo.

    Reemplaza la hoja fisica "Orden de Repuestos": numero de orden, pedido,
    tecnico, vehiculo (modelo/cilindraje, placa, VIN) y el detalle.
    """

    class Estados(models.TextChoices):
        COTIZACION = "cotizacion", "Cotización"
        RECHAZADA = "rechazada", "Rechazada"
        ORDEN = "orden", "Orden de trabajo"
        CERRADA = "cerrada", "Cerrada"
        ANULADA = "anulada", "Anulada"

    numero = models.PositiveIntegerField(unique=True)
    # Numero de pedido: distinto del numero de orden (lo pide el negocio asi).
    numero_pedido = models.CharField(max_length=60, blank=True)
    estado = models.CharField(max_length=20, choices=Estados.choices, default=Estados.COTIZACION)

    asesor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="ordenes_taller_asesor",
        help_text="Asistente/asesor de servicio que creo la cotizacion.",
    )
    tecnico = models.CharField(max_length=150, blank=True)

    cliente_nombre = models.CharField(max_length=255, blank=True)
    cliente_identificacion = models.CharField("Cédula/RUC", max_length=25, blank=True)
    cliente_telefono = models.CharField(max_length=50, blank=True)

    placa = models.CharField(max_length=20, blank=True)
    modelo = models.CharField("Modelo / cilindraje", max_length=200, blank=True)
    vin = models.CharField("VIN", max_length=40, blank=True)
    kilometraje = models.PositiveIntegerField(null=True, blank=True)

    observaciones = models.TextField(blank=True)
    motivo_rechazo = models.TextField(blank=True)

    aceptada_en = models.DateTimeField(null=True, blank=True)
    aceptada_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-numero"]
        verbose_name = "Orden de taller"
        verbose_name_plural = "Órdenes de taller"
        indexes = [
            models.Index(fields=["estado"], name="taller_orden_estado_idx"),
            models.Index(fields=["placa"], name="taller_orden_placa_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"Orden {self.numero} ({self.get_estado_display()})"

    @property
    def es_editable(self) -> bool:
        return self.estado in (self.Estados.COTIZACION, self.Estados.ORDEN)


class OrdenTallerLinea(models.Model):
    """Una fila del detalle: repuesto, repuesto sin codigo, insumo o mano de obra."""

    class Tipos(models.TextChoices):
        REPUESTO = "repuesto", "Repuesto"
        SIN_CODIGO = "sin_codigo", "Repuesto sin código"
        INSUMO = "insumo", "Insumo"
        MANO_OBRA = "mano_obra", "Mano de obra"

    class EstadosPrecio(models.TextChoices):
        # Sin estado: el precio es el del inventario (o la linea no tiene PVP).
        NO_APLICA = "", "No aplica"
        PENDIENTE = "pendiente", "Por aprobar"
        APROBADO = "aprobado", "Aprobado"

    orden = models.ForeignKey(OrdenTaller, on_delete=models.CASCADE, related_name="lineas")
    tipo = models.CharField(max_length=20, choices=Tipos.choices)
    producto = models.ForeignKey(
        "productos.Producto",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="lineas_taller",
    )
    mano_obra = models.ForeignKey(
        ManoObra,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="lineas",
    )
    # OEM / referencia de un repuesto que todavia no existe en el catalogo.
    referencia = models.CharField(max_length=120, blank=True)
    descripcion = models.CharField(max_length=255, blank=True)
    cantidad = models.PositiveIntegerField(default=1)
    # PVP del inventario al momento de agregar la linea (solo repuestos).
    precio_lista = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    precio = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("0"))
    precio_estado = models.CharField(
        max_length=20,
        choices=EstadosPrecio.choices,
        blank=True,
        default=EstadosPrecio.NO_APLICA,
    )
    precio_revisado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    precio_revisado_en = models.DateTimeField(null=True, blank=True)
    # True si se agrego despues de que el cliente acepto la cotizacion.
    agregada_en_orden = models.BooleanField(default=False)
    posicion = models.PositiveIntegerField(default=0)
    creado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["posicion", "id"]
        verbose_name = "Línea de orden de taller"
        verbose_name_plural = "Líneas de orden de taller"

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.get_tipo_display()} x{self.cantidad} - {self.descripcion}"

    @property
    def total(self) -> Decimal:
        return (self.precio or Decimal("0")) * Decimal(self.cantidad or 0)


class OrdenTallerEvento(models.Model):
    """Historial de la orden: quien hizo que y cuando."""

    orden = models.ForeignKey(OrdenTaller, on_delete=models.CASCADE, related_name="eventos")
    tipo = models.CharField(max_length=40)
    descripcion = models.TextField()
    usuario = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    creado_en = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-creado_en", "-id"]
        verbose_name = "Evento de orden de taller"
        verbose_name_plural = "Eventos de orden de taller"
