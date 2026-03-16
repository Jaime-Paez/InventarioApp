from django.conf import settings
from django.db import models


class ReminderState(models.Model):
    """
    Global storage for reminder payloads.

    The frontend keeps a full reminder list shape and syncs it here so that
    reminders survive browser restarts and new sessions in deployed environments.
    """

    GLOBAL_KEY = "global"

    key = models.CharField(max_length=50, unique=True, default=GLOBAL_KEY)
    payload = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Reminder state"
        verbose_name_plural = "Reminder states"

    def __str__(self) -> str:
        return f"ReminderState<{self.key}>"

    @classmethod
    def get_global(cls, *, for_update=False):
        queryset = cls.objects
        if for_update:
            queryset = queryset.select_for_update()
        instance, _ = queryset.get_or_create(
            key=cls.GLOBAL_KEY,
            defaults={"payload": []},
        )
        return instance


class UsuarioPreferencia(models.Model):
    """Preferencias operativas de un usuario del sistema."""

    usuario = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="preferencia_operativa",
    )
    inspeccion_aleatoria = models.BooleanField(default=False)
    inspeccion_aleatoria_sucursales = models.JSONField(
        default=list,
        blank=True,
        help_text="Sucursales asignadas para revision diaria de inventario.",
    )
    table_layouts = models.JSONField(
        default=dict,
        blank=True,
        help_text="Layouts de tablas guardados por usuario para restaurar en cualquier equipo.",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Preferencia de usuario"
        verbose_name_plural = "Preferencias de usuarios"

    def __str__(self) -> str:
        return f"Preferencias<{self.usuario_id}>"


class InspeccionAleatoriaConfiguracion(models.Model):
    """Configuracion global del modulo de inspeccion aleatoria diaria (singleton)."""

    GLOBAL_KEY = "global"

    key = models.CharField(max_length=50, unique=True, default=GLOBAL_KEY)
    hora_recordatorio = models.TimeField(
        null=True,
        blank=True,
        help_text="Hora del dia en que se envia el recordatorio de inspeccion aleatoria.",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Configuracion de inspeccion aleatoria"
        verbose_name_plural = "Configuraciones de inspeccion aleatoria"

    def __str__(self) -> str:
        return f"InspeccionAleatoriaConfiguracion<{self.key}>"

    @classmethod
    def get_global(cls, *, for_update=False):
        queryset = cls.objects
        if for_update:
            queryset = queryset.select_for_update()
        instance, _ = queryset.get_or_create(key=cls.GLOBAL_KEY)
        return instance


class InspeccionAleatoriaDiaria(models.Model):
    """Inspeccion diaria de inventario asignada automaticamente por usuario."""

    class Estados(models.TextChoices):
        PENDIENTE = "pendiente", "Pendiente"
        COMPLETADA = "completada", "Completada"

    usuario = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="inspecciones_aleatorias",
    )
    sucursal = models.ForeignKey(
        "inventario.Sucursal",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="inspecciones_aleatorias_diarias",
    )
    fecha_programada = models.DateField(db_index=True)
    estado = models.CharField(
        max_length=20,
        choices=Estados.choices,
        default=Estados.PENDIENTE,
    )
    total_items = models.PositiveSmallIntegerField(default=0)
    cobertura_porcentaje = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    completada_en = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Inspeccion aleatoria diaria"
        verbose_name_plural = "Inspecciones aleatorias diarias"
        ordering = ["-fecha_programada", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["usuario", "fecha_programada"],
                condition=models.Q(sucursal__isnull=True),
                name="unique_insp_aleatoria_usuario_fecha",
            ),
            models.UniqueConstraint(
                fields=["usuario", "sucursal", "fecha_programada"],
                condition=models.Q(sucursal__isnull=False),
                name="unique_insp_aleatoria_usuario_sucursal_fecha",
            ),
        ]

    def __str__(self) -> str:
        return f"Inspeccion<{self.usuario_id}:{self.fecha_programada}>"


class InspeccionAleatoriaItem(models.Model):
    """Producto puntual revisado dentro de una inspeccion diaria."""

    class EstadosRevision(models.TextChoices):
        PENDIENTE = "pendiente", "Pendiente"
        COINCIDE = "coincide", "Coincide"
        NO_COINCIDE = "no_coincide", "No coincide"

    class EstadosVerificacion(models.TextChoices):
        SIN_NOVEDAD = "sin_novedad", "Sin novedad"
        PENDIENTE = "pendiente", "Pendiente"
        APROBADA = "aprobada", "Aprobada"
        RECHAZADA = "rechazada", "Rechazada"

    inspeccion = models.ForeignKey(
        InspeccionAleatoriaDiaria,
        on_delete=models.CASCADE,
        related_name="items",
    )
    sucursal = models.ForeignKey(
        "inventario.Sucursal",
        on_delete=models.PROTECT,
        related_name="inspecciones_aleatorias_items",
    )
    producto = models.ForeignKey(
        "productos.Producto",
        on_delete=models.PROTECT,
        related_name="inspecciones_aleatorias_items",
    )
    cantidad_esperada = models.PositiveIntegerField(default=0)
    estado_revision = models.CharField(
        max_length=20,
        choices=EstadosRevision.choices,
        default=EstadosRevision.PENDIENTE,
    )
    cantidad_reportada = models.PositiveIntegerField(null=True, blank=True)
    observacion = models.TextField(blank=True, default="")
    revisado_en = models.DateTimeField(null=True, blank=True)
    verificacion_estado = models.CharField(
        max_length=20,
        choices=EstadosVerificacion.choices,
        default=EstadosVerificacion.SIN_NOVEDAD,
    )
    cantidad_confirmada = models.PositiveIntegerField(null=True, blank=True)
    nota_verificacion = models.TextField(blank=True, default="")
    verificado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="inspecciones_aleatorias_verificadas",
    )
    verificado_en = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Item de inspeccion aleatoria"
        verbose_name_plural = "Items de inspeccion aleatoria"
        ordering = ["id"]
        unique_together = ("inspeccion", "sucursal", "producto")
        indexes = [
            models.Index(fields=["verificacion_estado", "estado_revision"]),
        ]

    def __str__(self) -> str:
        return (
            f"ItemInspeccion<{self.inspeccion_id}:{self.sucursal_id}:{self.producto_id}>"
        )
