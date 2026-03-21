from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models


class Rol(models.Model):
    """Define un rol de acceso para los usuarios del sistema."""

    nombre = models.CharField(max_length=150, unique=True)
    descripcion = models.TextField(blank=True)
    activo = models.BooleanField(default=True)
    es_personalizado = models.BooleanField(default=False)
    usuarios = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        related_name="roles",
        blank=True,
    )

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Rol"
        verbose_name_plural = "Roles"

    def __str__(self) -> str:
        return self.nombre


class RolPermiso(models.Model):
    """Permisos especificos asignados a un rol para un modulo."""

    class Modulos(models.TextChoices):
        INVENTARIO = "inventario", "Inventario"
        MOVIMIENTOS_ENTRADAS = "movimientos_entradas", "Movimientos - Entradas"
        MOVIMIENTOS_SALIDAS = "movimientos_salidas", "Movimientos - Salidas"
        MOVIMIENTOS_INCONVENIENTES = (
            "movimientos_inconvenientes",
            "Movimientos - Inconvenientes",
        )
        PRODUCTOS = "productos", "Productos"
        SUCURSALES_SUCURSALES = "sucursales_sucursales", "Sucursales - Sucursales"
        SUCURSALES_BODEGAS = "sucursales_bodegas", "Sucursales - Bodegas"
        PROVEEDORES_MARCAS = "proveedores_marcas", "Proveedores - Marcas"
        PROVEEDORES_CASAS = "proveedores_casas", "Proveedores - Casas comerciales"
        SOLICITUDES = "solicitudes", "Solicitudes"
        CLIENTES = "clientes", "Clientes"
        USUARIOS = "usuarios", "Administrar"
        CONFIGURACION = "configuracion", "Configuraciones"

    class SubModulos(models.TextChoices):
        """Submodulos disponibles para permisos especificos (solo general)."""

        GENERAL = "", "General"

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
                check=models.Q(submodulo=""),
                name="rol_permiso_sin_submodulos",
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
        if self.submodulo:
            raise ValidationError(
                {
                    "submodulo": "Los submodulos estan deshabilitados; usa solo 'General'.",
                }
            )


MODULOS_CON_ALCANCE_SUCURSAL = (
    RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS,
    RolPermiso.Modulos.MOVIMIENTOS_SALIDAS,
    RolPermiso.Modulos.MOVIMIENTOS_INCONVENIENTES,
    RolPermiso.Modulos.PRODUCTOS,
    RolPermiso.Modulos.SOLICITUDES,
)
MODULOS_CON_ALCANCE_SUCURSAL_CHOICES = tuple(
    (key, label)
    for key, label in RolPermiso.Modulos.choices
    if key in MODULOS_CON_ALCANCE_SUCURSAL
)


class UsuarioSucursal(models.Model):
    """Asignacion de un usuario a una sucursal especifica."""

    usuario = models.ForeignKey(
        settings.AUTH_USER_MODEL,
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


class UsuarioModuloSucursal(models.Model):
    """Alcance de sucursales permitido a un usuario por modulo."""

    usuario = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="alcances_sucursal",
    )
    modulo = models.CharField(
        max_length=50,
        choices=MODULOS_CON_ALCANCE_SUCURSAL_CHOICES,
    )
    sucursal = models.ForeignKey(
        "inventario.Sucursal",
        on_delete=models.CASCADE,
        related_name="usuarios_por_modulo",
    )
    puede_crear = models.BooleanField(default=True)
    puede_leer = models.BooleanField(default=True)
    puede_actualizar = models.BooleanField(default=True)
    puede_eliminar = models.BooleanField(default=True)

    class Meta:
        verbose_name = "Alcance de sucursal por modulo"
        verbose_name_plural = "Alcances de sucursal por modulo"
        unique_together = ("usuario", "modulo", "sucursal")
        ordering = ["usuario__id", "modulo", "sucursal__nombre"]

    def clean(self):
        super().clean()
        if self.modulo not in MODULOS_CON_ALCANCE_SUCURSAL:
            raise ValidationError(
                {"modulo": "El modulo seleccionado no admite alcance por sucursal."}
            )

        if self.puede_eliminar:
            self.puede_crear = True
            self.puede_actualizar = True

        if self.puede_crear or self.puede_actualizar or self.puede_eliminar:
            self.puede_leer = True

        if not any(
            (
                self.puede_crear,
                self.puede_leer,
                self.puede_actualizar,
                self.puede_eliminar,
            )
        ):
            raise ValidationError(
                {
                    "puede_leer": (
                        "Debes habilitar al menos una accion para el alcance "
                        "por sucursal."
                    )
                }
            )

    def __str__(self) -> str:
        return f"{self.usuario} - {self.modulo} @ {self.sucursal}"
