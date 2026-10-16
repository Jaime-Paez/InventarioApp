from django.conf import settings
from django.db import models


class RendimientoRuta(models.Model):
    """Resumen por hora de cada endpoint: cuantas veces se llamo y cuanto tardo."""

    hora = models.DateTimeField(db_index=True)
    metodo = models.CharField(max_length=8)
    ruta = models.CharField(max_length=255)
    peticiones = models.PositiveIntegerField(default=0)
    lentas = models.PositiveIntegerField(default=0)  # mas de RENDIMIENTO_LENTA_MS
    total_ms = models.BigIntegerField(default=0)
    max_ms = models.PositiveIntegerField(default=0)
    total_db_ms = models.BigIntegerField(default=0)
    total_consultas = models.BigIntegerField(default=0)
    max_consultas = models.PositiveIntegerField(default=0)

    class Meta:
        unique_together = ("hora", "metodo", "ruta")
        ordering = ["-hora", "-total_ms"]

    def __str__(self):  # pragma: no cover
        return f"{self.hora:%Y-%m-%d %H}h {self.metodo} {self.ruta}"


class PeticionLenta(models.Model):
    """Una peticion que paso de RENDIMIENTO_DETALLE_MS, con lo necesario para reproducirla."""

    fecha = models.DateTimeField(auto_now_add=True, db_index=True)
    metodo = models.CharField(max_length=8)
    ruta = models.CharField(max_length=255)
    url = models.CharField(max_length=1000)
    estado = models.PositiveSmallIntegerField()
    duracion_ms = models.PositiveIntegerField()
    db_ms = models.PositiveIntegerField()
    consultas = models.PositiveIntegerField()
    usuario = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        ordering = ["-fecha"]
