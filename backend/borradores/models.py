from django.conf import settings
from django.db import models


class BorradorFormulario(models.Model):
    """Progreso guardado de un formulario a medio llenar (nueva salida, nueva
    entrada...). Es solo un respaldo para no perder lo ingresado: NO mueve
    inventario ni crea el movimiento. Uno por usuario y por formulario; se
    borra al registrar el formulario de verdad o al empezar de cero."""

    usuario = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="borradores_formulario")
    formulario = models.CharField(max_length=60)
    datos = models.JSONField(default=dict, blank=True)
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ("usuario", "formulario")
        ordering = ["-actualizado_en"]

    def __str__(self):
        return f"{self.formulario} - {self.usuario_id}"
