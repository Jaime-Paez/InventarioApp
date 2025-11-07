from django.db import models


class Usuario(models.Model):
    ROLES = [
        ("administrador", "Administrador"),
        ("vendedor", "Vendedor"),
        ("almacen", "Almacén"),
    ]

    nombre = models.CharField(max_length=150)
    email = models.EmailField(unique=True)
    telefono = models.CharField(max_length=30, blank=True)
    rol = models.CharField(max_length=30, choices=ROLES)
    sucursal = models.ForeignKey(
        "sucursales.Sucursal",
        on_delete=models.SET_NULL,
        related_name="usuarios",
        null=True,
        blank=True,
    )
    activo = models.BooleanField(default=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Usuario"
        verbose_name_plural = "Usuarios"

    def __str__(self) -> str:
        return self.nombre
