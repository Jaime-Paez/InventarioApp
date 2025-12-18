from django.core.exceptions import ValidationError
from django.db import models


class Rol(models.Model):
    """Define un rol de acceso para los usuarios del sistema."""

    nombre = models.CharField(max_length=150, unique=True)
    descripcion = models.TextField(blank=True)
    activo = models.BooleanField(default=True)
    es_personalizado = models.BooleanField(default=False)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Rol"
        verbose_name_plural = "Roles"

    def __str__(self) -> str:
        return self.nombre


class RolPermiso(models.Model):
    """Permisos específicos asignados a un rol para un módulo."""

    class Modulos(models.TextChoices):
        CASA_COMERCIAL = "casa_comercial", "Casa comercial"
        INVENTARIO = "inventario", "Inventario"
        MARCAS = "marcas", "Marcas"
        MOVIMIENTOS = "movimientos", "Movimientos"
        PRODUCTOS = "productos", "Productos"
        SOLICITUDES = "solicitudes", "Solicitudes"
        TIPOS = "tipos", "Tipos"
        USUARIOS = "usuarios", "Usuarios"

    class SubModulos(models.TextChoices):
        """Submódulos disponibles para permisos específicos."""

        GENERAL = "", "General"
        MOV_SALIDA_VENTA = "mov_salida_venta", "Salidas por venta"
        MOV_SALIDA_TRASLADO = "mov_salida_traslado", "Salidas por traslado"
        MOV_SALIDA_DEVOLUCION = "mov_salida_devolucion", "Salidas por devolución"
        MOV_ENTRADA_TRASLADO = "mov_entrada_traslado", "Entradas por traslado"
        MOV_ENTRADA_DEVOLUCION = "mov_entrada_devolucion", "Entradas por devolución"
        MOV_ENTRADA_COMPRA_LOCAL = (
            "mov_entrada_compra_local",
            "Entradas por compra local",
        )
        MOV_ENTRADA_IMPORTACION = (
            "mov_entrada_importacion",
            "Entradas por importación",
        )

    rol = models.ForeignKey(
        Rol,
        on_delete=models.CASCADE,
        related_name="permisos",
    )
    modulo = models.CharField(max_length=50, choices=Modulos.choices)
    submodulo = models.CharField(
        max_length=50,
        choices=SubModulos.choices,
        blank=True,
        default="",
    )
    puede_crear = models.BooleanField(default=False)
    puede_leer = models.BooleanField(default=False)
    puede_actualizar = models.BooleanField(default=False)
    puede_eliminar = models.BooleanField(default=False)

    class Meta:
        ordering = ["rol__nombre", "modulo", "submodulo"]
        unique_together = ("rol", "modulo", "submodulo")
        verbose_name = "Permiso de rol"
        verbose_name_plural = "Permisos de rol"
        constraints = [
            models.CheckConstraint(
                check=models.Q(submodulo="")
                | models.Q(modulo="movimientos"),
                name="rol_permiso_submodulo_movimientos",
            )
        ]

    def __str__(self) -> str:
        if self.submodulo:
            return (
                f"{self.rol} - {self.get_modulo_display()} / "
                f"{self.get_submodulo_display()}"
            )
        return f"{self.rol} - {self.get_modulo_display()}"

    def clean(self):
        super().clean()
        if self.submodulo and self.modulo != self.Modulos.MOVIMIENTOS:
            raise ValidationError(
                {
                    "submodulo": "Solo los permisos de Movimientos pueden tener una subcategoría.",
                    "modulo": "El módulo debe ser Movimientos cuando se especifica una subcategoría.",
                }
            )


class Usuario(models.Model):
    """Usuario interno que puede operar el sistema."""

    nombres = models.CharField(max_length=150)
    apellidos = models.CharField(max_length=150)
    correo = models.EmailField(unique=True)
    telefono = models.CharField(max_length=30, blank=True)
    cargo = models.CharField(max_length=120, blank=True)
    activo = models.BooleanField(default=True)
    roles = models.ManyToManyField(
        Rol,
        related_name="usuarios",
        blank=True,
    )
    rol_personalizado = models.OneToOneField(
        Rol,
        on_delete=models.SET_NULL,
        related_name="usuario_personalizado",
        null=True,
        blank=True,
    )

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
