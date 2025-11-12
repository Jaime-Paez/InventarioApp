from django.db import models


class Usuario(models.Model):
    """Usuario interno que puede operar el sistema."""

    nombres = models.CharField(max_length=150)
    apellidos = models.CharField(max_length=150)
    correo = models.EmailField(unique=True)
    telefono = models.CharField(max_length=30, blank=True)
    cargo = models.CharField(max_length=120, blank=True)
    activo = models.BooleanField(default=True)

    class Meta:
        ordering = ["apellidos", "nombres"]
        verbose_name = "Usuario"
        verbose_name_plural = "Usuarios"

    def __str__(self) -> str:
        return f"{self.nombres} {self.apellidos}".strip()


class UsuarioSucursal(models.Model):
    """Asignación de un usuario a una sucursal específica."""

    usuario = models.ForeignKey(
        Usuario,
        on_delete=models.CASCADE,
        related_name="asignaciones",
    )
    sucursal = models.ForeignKey(
        "inventario.Sucursal",
        on_delete=models.CASCADE,
        related_name="usuarios",
    )
    rol = models.CharField(max_length=120, blank=True)
    es_responsable = models.BooleanField(default=False)

    class Meta:
        verbose_name = "Usuario por sucursal"
        verbose_name_plural = "Usuarios por sucursal"
        unique_together = ("usuario", "sucursal")

    def __str__(self) -> str:
        rol = f" - {self.rol}" if self.rol else ""
        return f"{self.usuario} @ {self.sucursal}{rol}"
