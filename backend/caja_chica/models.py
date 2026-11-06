from decimal import Decimal

from django.conf import settings
from django.db import models
from django.db.models import Q, Sum


class Caja(models.Model):
    """Fondo fijo de caja chica, con un custodio responsable."""

    nombre = models.CharField(max_length=120)
    # Una caja chica por sucursal.
    sucursal = models.OneToOneField(
        "inventario.Sucursal",
        on_delete=models.PROTECT,
        related_name="caja_chica",
    )
    custodio = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="cajas_chicas",
    )
    monto_fondo = models.DecimalField(max_digits=10, decimal_places=2)
    # Gastos por encima de este monto necesitan aprobacion del administrador.
    tope_gasto = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("50"))
    # Bajo este porcentaje del fondo se avisa que hay que pedir reposicion.
    alerta_reposicion = models.PositiveSmallIntegerField(default=20)
    activa = models.BooleanField(default=True)
    creado_en = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Caja chica"
        verbose_name_plural = "Cajas chicas"

    def __str__(self) -> str:  # pragma: no cover
        return self.nombre

    def saldo(self):
        """Efectivo que deberia haber en la caja segun el sistema."""
        M = MovimientoCaja
        aprobados = self.movimientos.filter(estado=M.Estados.APROBADO)
        entradas = aprobados.filter(tipo__in=M.TIPOS_ENTRADA).aggregate(t=Sum("monto"))["t"] or Decimal("0")
        salidas = (
            aprobados.filter(Q(tipo__in=M.TIPOS_SALIDA) & Q(de_anticipo__isnull=True)).aggregate(t=Sum("monto"))["t"]
            or Decimal("0")
        )
        return entradas - salidas


class CategoriaGasto(models.Model):
    nombre = models.CharField(max_length=120, unique=True)
    activa = models.BooleanField(default=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Categoría de gasto"
        verbose_name_plural = "Categorías de gasto"

    def __str__(self) -> str:  # pragma: no cover
        return self.nombre


class MovimientoCaja(models.Model):
    class Tipos(models.TextChoices):
        APERTURA = "apertura", "Apertura del fondo"
        GASTO = "gasto", "Gasto"
        ANTICIPO = "anticipo", "Anticipo / vale"
        INGRESO = "ingreso", "Ingreso"
        REPOSICION = "reposicion", "Reposición"
        VUELTO = "vuelto", "Vuelto de anticipo"

    TIPOS_ENTRADA = ("apertura", "ingreso", "reposicion", "vuelto")
    TIPOS_SALIDA = ("gasto", "anticipo")

    class Estados(models.TextChoices):
        PENDIENTE = "pendiente", "Por aprobar"
        APROBADO = "aprobado", "Aprobado"
        RECHAZADO = "rechazado", "Rechazado"

    class Comprobantes(models.TextChoices):
        FACTURA = "factura", "Factura"
        NOTA_VENTA = "nota_venta", "Nota de venta"
        RECIBO = "recibo", "Recibo"
        SIN = "sin", "Sin comprobante"

    caja = models.ForeignKey(Caja, on_delete=models.PROTECT, related_name="movimientos")
    tipo = models.CharField(max_length=20, choices=Tipos.choices)
    estado = models.CharField(max_length=20, choices=Estados.choices, default=Estados.APROBADO)
    fecha = models.DateField()
    monto = models.DecimalField(max_digits=10, decimal_places=2)
    categoria = models.ForeignKey(CategoriaGasto, on_delete=models.SET_NULL, null=True, blank=True, related_name="movimientos")
    descripcion = models.TextField(blank=True)
    beneficiario = models.CharField(max_length=150, blank=True)
    comprobante_tipo = models.CharField(max_length=20, choices=Comprobantes.choices, blank=True)
    comprobante_numero = models.CharField(max_length=60, blank=True)
    # Foto del comprobante (imagen reducida, data URL).
    comprobante_imagen = models.TextField(blank=True)
    motivo_rechazo = models.TextField(blank=True)

    # Anticipo: se entrega efectivo y luego se liquida con el gasto real.
    liquidado_en = models.DateTimeField(null=True, blank=True)
    # Gasto que liquida un anticipo: ya salio de la caja con el anticipo, no
    # vuelve a restar del saldo.
    de_anticipo = models.ForeignKey(
        "self", on_delete=models.CASCADE, null=True, blank=True, related_name="liquidaciones"
    )

    registrado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    revisado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    revisado_en = models.DateTimeField(null=True, blank=True)
    creado_en = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-fecha", "-id"]
        verbose_name = "Movimiento de caja chica"
        verbose_name_plural = "Movimientos de caja chica"
        indexes = [models.Index(fields=["caja", "estado"], name="caja_mov_estado_idx")]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.get_tipo_display()} ${self.monto}"


class Arqueo(models.Model):
    """Conteo del efectivo por denominacion contra el saldo del sistema."""

    caja = models.ForeignKey(Caja, on_delete=models.CASCADE, related_name="arqueos")
    denominaciones = models.JSONField(default=dict, blank=True)
    total_contado = models.DecimalField(max_digits=10, decimal_places=2)
    saldo_sistema = models.DecimalField(max_digits=10, decimal_places=2)
    diferencia = models.DecimalField(max_digits=10, decimal_places=2)
    observacion = models.TextField(blank=True)
    realizado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    creado_en = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-creado_en", "-id"]
        verbose_name = "Arqueo de caja"
        verbose_name_plural = "Arqueos de caja"
