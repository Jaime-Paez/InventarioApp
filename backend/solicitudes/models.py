from django.core.exceptions import ValidationError
from django.db import models

from marcas.models import Marca


class Cliente(models.Model):
    """Información básica de los clientes que realizan solicitudes."""

    nombres = models.CharField(max_length=255)
    apellidos = models.CharField(max_length=255)
    correo = models.EmailField(blank=True)
    telefono = models.CharField(max_length=50, blank=True)
    direccion = models.CharField(max_length=255, blank=True)
    cedula_ruc = models.CharField("Cédula/RUC", max_length=25, blank=True)

    class Meta:
        ordering = ["nombres", "apellidos"]
        verbose_name = "Cliente"
        verbose_name_plural = "Clientes"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        full_name = f"{self.nombres} {self.apellidos}".strip()
        return full_name or self.nombres

class Auto(models.Model):
    """Vehiculo asociado a un cliente."""

    cliente = models.ForeignKey(
        Cliente,
        on_delete=models.CASCADE,
        related_name="autos",
    )
    placa = models.CharField(max_length=20)
    modelo = models.CharField(max_length=120)
    anio = models.PositiveSmallIntegerField("Anio")
    marca = models.ForeignKey(
        Marca,
        on_delete=models.PROTECT,
        related_name="autos",
    )
    color = models.CharField(max_length=50, blank=True)

    class Meta:
        ordering = ["placa"]
        verbose_name = "Auto"
        verbose_name_plural = "Autos"

    def __str__(self) -> str:  # pragma: no cover - representacion legible
        return f"{self.placa} - {self.modelo}"

class ProductoSolicitado(models.Model):
    """Producto solicitado por un cliente que aún no está en inventario."""

    codigo = models.CharField(max_length=80, blank=True)
    nombre = models.CharField(max_length=255)
    marca = models.CharField(max_length=120, blank=True)
    descripcion = models.TextField(blank=True)
    conseguido = models.BooleanField(default=False)
    producto = models.ForeignKey(
        "productos.Producto",
        on_delete=models.SET_NULL,
        related_name="productos_solicitados",
        null=True,
        blank=True,
    )

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Producto solicitado"
        verbose_name_plural = "Productos solicitados"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return self.nombre

class Solicitud(models.Model):
    """Solicitud de productos realizada por un cliente."""

    class Tabla(models.TextChoices):
        PRODUCTO = "producto", "Producto"
        PRODUCTO_SOLICITADO = "producto_solicitado", "Producto solicitado"

    cantidad = models.PositiveIntegerField()
    producto = models.ForeignKey(
        "productos.Producto",
        on_delete=models.PROTECT,
        related_name="solicitudes",
        null=True,
        blank=True,
    )
    producto_solicitado = models.ForeignKey(
        ProductoSolicitado,
        on_delete=models.CASCADE,
        related_name="solicitudes",
        null=True,
        blank=True,
    )
    tabla = models.CharField(max_length=30, choices=Tabla.choices)
    fecha = models.DateField()
    descripcion_general = models.TextField(blank=True)
    comentario = models.TextField(blank=True)
    placa = models.CharField(max_length=20, blank=True, default="")
    sucursal = models.ForeignKey(
        "inventario.Sucursal",
        on_delete=models.PROTECT,
        related_name="solicitudes",
    )
    cliente = models.ForeignKey(
        Cliente,
        on_delete=models.PROTECT,
        related_name="solicitudes",
        null=True,
        blank=True,
    )

    class Meta:
        ordering = ["-fecha", "id"]
        verbose_name = "Solicitud"
        verbose_name_plural = "Solicitudes"

    def __str__(self) -> str:  # pragma: no cover - representación legible
        if self.tabla == self.Tabla.PRODUCTO and self.producto:
            referencia = self.producto.nombre
        elif self.producto_solicitado:
            referencia = self.producto_solicitado.nombre
        else:  # pragma: no cover - fallback seguro
            referencia = "Producto"
        return f"Solicitud #{self.pk or 'nuevo'} - {referencia}"

    def clean(self):
        """Valida que la tabla seleccionada coincida con la referencia asociada."""

        if self.tabla == self.Tabla.PRODUCTO:
            if not self.producto:
                raise ValidationError({"producto": "Debe seleccionar un producto."})
            if self.producto_solicitado:
                raise ValidationError(
                    {"producto_solicitado": "No debe asociar un producto solicitado."}
                )
        elif self.tabla == self.Tabla.PRODUCTO_SOLICITADO:
            if not self.producto_solicitado:
                raise ValidationError(
                    {"producto_solicitado": "Debe seleccionar un producto solicitado."}
                )
            if self.producto:
                raise ValidationError({"producto": "No debe asociar un producto del catálogo."})
        else:
            raise ValidationError({"tabla": "Selección de tabla inválida."})

    def save(self, *args, **kwargs):
        self.full_clean()
        return super().save(*args, **kwargs)


class OEMProductoSolicitado(models.Model):
    """Relación entre un producto solicitado y un código OEM."""

    producto_solicitado = models.ForeignKey(
        ProductoSolicitado,
        on_delete=models.CASCADE,
        related_name="oem_relaciones",
    )
    oem = models.ForeignKey(
        "productos.OEM",
        on_delete=models.CASCADE,
        related_name="productos_solicitados",
    )

    class Meta:
        verbose_name = "OEM de producto solicitado"
        verbose_name_plural = "OEM por producto solicitado"
        unique_together = ("producto_solicitado", "oem")

    def __str__(self) -> str:  # pragma: no cover - representación legible
        return f"{self.producto_solicitado} - {self.oem}"
