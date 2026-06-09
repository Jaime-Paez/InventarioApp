from django.conf import settings
from django.db import models
from django.utils import timezone

from casa_comercial.models import CasaComercial
from productos.models import Producto


class Importacion(models.Model):
    ESTADO_BORRADOR = "borrador"
    ESTADO_EN_CAMINO = "en_camino"
    ESTADO_IMPORTADA = "importada"
    ESTADO_CHOICES = [
        (ESTADO_BORRADOR, "Borrador"),
        (ESTADO_EN_CAMINO, "En camino"),
        (ESTADO_IMPORTADA, "Importada"),
    ]

    codigo = models.CharField(max_length=30, unique=True)
    estado = models.CharField(max_length=20, choices=ESTADO_CHOICES, default=ESTADO_BORRADOR)
    fecha = models.DateField(default=timezone.localdate)
    casa_comercial = models.ForeignKey(
        CasaComercial,
        on_delete=models.PROTECT,
        related_name="importaciones",
    )
    dias_entrega_estimados = models.PositiveSmallIntegerField(null=True, blank=True)
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
    cantidad = models.PositiveIntegerField(default=1)

    class Meta:
        ordering = ["id"]
        verbose_name = "Detalle de importacion"
        verbose_name_plural = "Detalles de importacion"

    def __str__(self):
        label = self.producto.codigo if self.producto_id else (self.codigo or self.nombre or "sin catálogo")
        return f"{self.importacion.codigo} - {label}"
