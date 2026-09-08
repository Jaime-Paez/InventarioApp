from django.db import models


class SolicitudWeb(models.Model):
    """Solicitud enviada desde el formulario de contacto del sitio público
    (JaimePaezWebPage, un proyecto aparte). Se guarda siempre, aunque el envío
    del correo de notificación falle — así la solicitud no se pierde.
    """

    nombre = models.CharField(max_length=255)
    celular = models.CharField(max_length=50)
    marca = models.CharField(max_length=100, blank=True)
    modelo = models.CharField(max_length=100)
    anio = models.CharField("Año", max_length=20, blank=True)
    chasis = models.CharField("N° de chasis", max_length=50, blank=True)
    detalle = models.TextField()
    creado_en = models.DateTimeField(auto_now_add=True)
    leido = models.BooleanField(default=False)
    correo_enviado = models.BooleanField(default=False)

    class Meta:
        ordering = ["-creado_en"]
        verbose_name = "Solicitud web"
        verbose_name_plural = "Solicitudes web"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.nombre} - {self.marca} {self.modelo}".strip()
