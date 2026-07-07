from django.conf import settings
from django.db import models
from django.utils import timezone

from casa_comercial.models import CasaComercial
from productos.models import Producto


class Importacion(models.Model):
    ESTADO_BORRADOR = "borrador"
    ESTADO_COTIZACION = "cotizacion"
    ESTADO_CONFIRMACION = "confirmacion"
    ESTADO_EN_CAMINO = "en_camino"
    ESTADO_IMPORTADA = "importada"
    ESTADO_CHOICES = [
        (ESTADO_BORRADOR, "Borrador"),
        (ESTADO_COTIZACION, "Cotización"),
        (ESTADO_CONFIRMACION, "Confirmación"),
        (ESTADO_EN_CAMINO, "En camino"),
        (ESTADO_IMPORTADA, "Importada"),
    ]

    # Not unique: when a confirmacion is imported, the new en_camino record it spawns
    # keeps this same codigo on purpose, so both are recognizable as the same import.
    codigo = models.CharField(max_length=30, db_index=True)
    estado = models.CharField(max_length=20, choices=ESTADO_CHOICES, default=ESTADO_BORRADOR)
    fecha = models.DateField(default=timezone.localdate)
    casa_comercial = models.ForeignKey(
        CasaComercial,
        on_delete=models.PROTECT,
        related_name="importaciones",
    )
    dias_entrega_estimados = models.PositiveSmallIntegerField(null=True, blank=True)
    numero_factura = models.CharField(max_length=100, blank=True, default="")
    fecha_importacion = models.DateField(null=True, blank=True)
    dias_reales_entrega = models.PositiveSmallIntegerField(null=True, blank=True)
    origen = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="en_camino_generadas",
        help_text="Importacion de cotizacion/confirmacion desde la que se generó esta (en_camino). Legado: ya no se generan registros separados al importar.",
    )
    historial_confirmacion = models.JSONField(
        null=True,
        blank=True,
        default=None,
        help_text="Snapshot de los productos revisados en confirmación (check/x, comentarios, precios) al momento de importar.",
    )
    creado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="importaciones_creadas",
        null=True,
        blank=True,
    )
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-creado_en", "-id"]
        verbose_name = "Importacion"
        verbose_name_plural = "Importaciones"

    def __str__(self):
        return self.codigo


class ImportacionDetalle(models.Model):
    importacion = models.ForeignKey(
        Importacion,
        on_delete=models.CASCADE,
        related_name="detalles",
    )
    producto = models.ForeignKey(
        Producto,
        on_delete=models.PROTECT,
        related_name="detalles_importacion",
        null=True,
        blank=True,
    )
    codigo = models.CharField(max_length=150, blank=True, default="")
    nombre = models.CharField(max_length=255, blank=True, default="")
    oem = models.CharField(max_length=500, blank=True, default="")
    referencia = models.CharField(max_length=500, blank=True, default="")
    cantidad = models.PositiveIntegerField(default=1)
    precio_estimado = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    cantidad_aproximada = models.PositiveIntegerField(null=True, blank=True)
    precio_confirmado = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    cantidad_confirmada = models.PositiveIntegerField(null=True, blank=True)
    precio_pvp_snapshot = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    seleccionado = models.BooleanField(null=True, blank=True)
    comentario = models.TextField(blank=True, default="")
    solicitud = models.ForeignKey(
        "solicitudes.Solicitud",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="importacion_detalles",
    )

    class Meta:
        ordering = ["id"]
        verbose_name = "Detalle de importacion"
        verbose_name_plural = "Detalles de importacion"

    def __str__(self):
        label = self.producto.codigo if self.producto_id else (self.codigo or self.nombre or "sin catálogo")
        return f"{self.importacion.codigo} - {label}"


class ImportacionEnvio(models.Model):
    ESTADO_PENDIENTE = "pendiente"
    ESTADO_RECIBIDO = "recibido"
    ESTADO_CHOICES = [
        (ESTADO_PENDIENTE, "Pendiente"),
        (ESTADO_RECIBIDO, "Recibido"),
    ]

    importacion = models.ForeignKey(
        Importacion,
        on_delete=models.CASCADE,
        related_name="envios",
    )
    sucursal = models.ForeignKey(
        "inventario.Sucursal",
        on_delete=models.PROTECT,
        related_name="importacion_envios",
    )
    estado = models.CharField(max_length=20, choices=ESTADO_CHOICES, default=ESTADO_PENDIENTE)
    fecha = models.DateField(default=timezone.localdate)
    fecha_recepcion = models.DateField(null=True, blank=True)
    recibido_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="importacion_envios_recibidos",
    )

    class Meta:
        ordering = ["-fecha", "-id"]
        verbose_name = "Envío de importación"
        verbose_name_plural = "Envíos de importación"

    def __str__(self):
        return f"Envío {self.importacion.codigo} → {self.sucursal.nombre}"


class ImportacionEnvioDetalle(models.Model):
    envio = models.ForeignKey(
        ImportacionEnvio,
        on_delete=models.CASCADE,
        related_name="detalles",
    )
    producto = models.ForeignKey(
        Producto,
        on_delete=models.PROTECT,
        related_name="importacion_envio_detalles",
    )
    cantidad = models.PositiveIntegerField(default=1)

    class Meta:
        ordering = ["id"]
        verbose_name = "Detalle de envío de importación"
        verbose_name_plural = "Detalles de envío de importación"

    def __str__(self):
        return f"{self.envio} - {self.producto.codigo}"
