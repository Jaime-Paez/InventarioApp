from django.db import models


class Sucursal(models.Model):
    """Sucursal física de la compañía.

    Ejemplo: Sucursal(codigo="CDMX-01", nombre="Sucursal Centro", direccion="Av. Hidalgo 123", ciudad="Ciudad de México").
    """

    codigo = models.CharField(max_length=30, unique=True)
    nombre = models.CharField(max_length=120)
    direccion = models.CharField(max_length=255)
    ciudad = models.CharField(max_length=120, blank=True)
    telefono = models.CharField(max_length=30, blank=True)
    notas = models.TextField(blank=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Sucursal"
        verbose_name_plural = "Sucursales"

    def __str__(self) -> str:
        return f"{self.nombre} ({self.codigo})"


class Bodega(models.Model):
    """Espacio físico dentro de una sucursal donde se almacenan productos.

    Ejemplo: Bodega(sucursal=Sucursal(...), nombre="Bodega Principal", descripcion="Área de recepción").
    """

    sucursal = models.ForeignKey(
        Sucursal,
        on_delete=models.CASCADE,
        related_name="bodegas",
    )
    nombre = models.CharField(max_length=120)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["sucursal__nombre", "nombre"]
        verbose_name = "Bodega"
        verbose_name_plural = "Bodegas"
        unique_together = ("sucursal", "nombre")

    def __str__(self) -> str:
        return f"{self.nombre} - {self.sucursal.codigo}"


class TipoDivision(models.Model):
    """Clasificación del tipo de división dentro de una bodega (estantería, repisa, mueble, etc.).

    Ejemplo: TipoDivision(nombre="Estantería", descripcion="Estanterías metálicas estándar").
    """

    nombre = models.CharField(max_length=80, unique=True)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Tipo de división"
        verbose_name_plural = "Tipos de división"

    def __str__(self) -> str:
        return self.nombre


class Division(models.Model):
    """División específica dentro de una bodega.

    Ejemplo: Division(tipo_division=TipoDivision("Estantería"), bodega=Bodega(...), nombre="Estantería A").
    """

    tipo_division = models.ForeignKey(
        TipoDivision,
        on_delete=models.PROTECT,
        related_name="divisiones",
    )
    bodega = models.ForeignKey(
        Bodega,
        on_delete=models.CASCADE,
        related_name="divisiones",
    )
    nombre = models.CharField(max_length=120)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["bodega__nombre", "nombre"]
        verbose_name = "División"
        verbose_name_plural = "Divisiones"
        unique_together = ("bodega", "nombre")

    def __str__(self) -> str:
        return f"{self.nombre} - {self.bodega.nombre}"


class SubDivision(models.Model):
    """Subdivisión dentro de una división, como repisas o cajones específicos.

    Ejemplo: SubDivision(division=Division("Estantería A"), nombre="Estantería A - Nivel 2").
    """

    division = models.ForeignKey(
        Division,
        on_delete=models.CASCADE,
        related_name="subdivisiones",
    )
    nombre = models.CharField(max_length=120)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["division__nombre", "nombre"]
        verbose_name = "Subdivisión"
        verbose_name_plural = "Subdivisiones"
        unique_together = ("division", "nombre")

    def __str__(self) -> str:
        return f"{self.nombre} ({self.division.nombre})"
