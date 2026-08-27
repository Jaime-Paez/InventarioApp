from uuid import uuid4

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
    fecha_puerto = models.DateField(
        null=True,
        blank=True,
        help_text="Fecha en que la importación llegó al puerto/país, editable mientras está en camino.",
    )
    fecha_llegada = models.DateField(
        null=True,
        blank=True,
        help_text="Fecha real en que llegó la importación, confirmada/editada al marcar la llegada.",
    )
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
    borrador_llegada = models.JSONField(
        null=True,
        blank=True,
        default=None,
        help_text="Progreso guardado del asistente de llegada (paso, revisados, cantidades recibidas, distribución, destinatarios) para poder continuar al reabrirlo.",
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
    orden = models.PositiveIntegerField(
        null=True,
        blank=True,
        help_text="Fila del Excel original (subido) en la que estaba este producto -- solo para exportarlo de vuelta, no se muestra en ninguna tabla de la app.",
    )
    precio_estimado = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    cantidad_aproximada = models.PositiveIntegerField(null=True, blank=True)
    precio_confirmado = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    cantidad_confirmada = models.PositiveIntegerField(null=True, blank=True)
    precio_pvp_snapshot = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    cantidad_recibida = models.PositiveIntegerField(null=True, blank=True)
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


class ImportacionInconveniente(models.Model):
    """Inconvenientes detectados al revisar la llegada de una importación (faltante/sobrante frente a lo esperado)."""

    class Tipos(models.TextChoices):
        FALTANTE = "faltante", "Faltante"
        SOBRANTE = "sobrante", "Sobrante"

    class Estados(models.TextChoices):
        PENDIENTE = "pendiente", "Pendiente"
        RECLAMADO = "reclamado", "Reclamado"
        RESUELTO = "resuelto", "Resuelto"
        PERDIDO = "perdido", "Perdido"

    class Resoluciones(models.TextChoices):
        REPORTADO_PROVEEDOR = "reportado_proveedor", "Reportado al proveedor"
        ACEPTADO = "aceptado", "Aceptado sin cambios"
        PERDIDO = "perdido", "Perdido / no recuperable"
        DEVOLVER_PROVEEDOR = "devolver_proveedor", "Devuelto al proveedor"
        REPOSICION_ACORDADA = "reposicion_acordada", "Reposición acordada"

    importacion = models.ForeignKey(
        Importacion,
        on_delete=models.CASCADE,
        related_name="inconvenientes",
    )
    detalle = models.ForeignKey(
        ImportacionDetalle,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="inconvenientes",
    )
    producto = models.ForeignKey(
        Producto,
        on_delete=models.PROTECT,
        related_name="inconvenientes_importacion",
    )
    tipo = models.CharField(
        max_length=20,
        choices=Tipos.choices,
        default=Tipos.FALTANTE,
    )
    cantidad_esperada = models.PositiveIntegerField(default=0)
    cantidad_recibida = models.PositiveIntegerField(default=0)
    cantidad_diferencia = models.PositiveIntegerField(default=0)
    estado = models.CharField(
        max_length=20,
        choices=Estados.choices,
        default=Estados.PENDIENTE,
    )
    resolucion = models.CharField(
        max_length=30,
        choices=Resoluciones.choices,
        blank=True,
        default="",
    )
    motivo = models.TextField(blank=True, default="")
    cantidad_prometida = models.PositiveIntegerField(null=True, blank=True)
    fecha_entrega_prometida = models.DateField(null=True, blank=True)
    creado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="inconvenientes_importacion_creados",
        null=True,
        blank=True,
    )
    resuelto_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="inconvenientes_importacion_resueltos_por",
        null=True,
        blank=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "Inconveniente de importación"
        verbose_name_plural = "Inconvenientes de importación"

    def __str__(self):
        return f"{self.importacion.codigo} - {self.producto.codigo} ({self.tipo}: {self.cantidad_diferencia})"


class ImportacionInconvenienteHistorial(models.Model):
    """Historial de decisiones tomadas sobre inconvenientes de importación."""

    inconveniente = models.ForeignKey(
        ImportacionInconveniente,
        on_delete=models.CASCADE,
        related_name="historial",
    )
    accion = models.CharField(max_length=40)
    detalle = models.TextField(blank=True, default="")
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="historial_inconvenientes_importacion",
        null=True,
        blank=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "Historial de inconveniente de importación"
        verbose_name_plural = "Historial de inconvenientes de importación"

    def __str__(self):
        return f"{self.inconveniente_id} - {self.accion}"


class ImportacionExcelJob(models.Model):
    """Job en segundo plano para procesar un Excel de sugerencia (paso 3 del wizard).

    Se procesa en un thread aparte para poder reportar progreso vía polling
    (GET), ya que el proyecto no cuenta con Celery/Redis ni otra cola de
    tareas en segundo plano.
    """

    ESTADO_PROCESANDO = "procesando"
    ESTADO_LISTO = "listo"
    ESTADO_ERROR = "error"
    ESTADO_CHOICES = [
        (ESTADO_PROCESANDO, "Procesando"),
        (ESTADO_LISTO, "Listo"),
        (ESTADO_ERROR, "Error"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid4, editable=False)
    estado = models.CharField(max_length=20, choices=ESTADO_CHOICES, default=ESTADO_PROCESANDO)
    progreso = models.PositiveSmallIntegerField(default=0)
    resultado = models.JSONField(null=True, blank=True, default=None)
    error = models.TextField(blank=True, default="")
    creado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="importacion_excel_jobs",
        null=True,
        blank=True,
    )
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-creado_en"]
        verbose_name = "Job de procesamiento de Excel"
        verbose_name_plural = "Jobs de procesamiento de Excel"

    def __str__(self):
        return f"{self.id} ({self.estado} {self.progreso}%)"
