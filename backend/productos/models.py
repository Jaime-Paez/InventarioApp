from django.db import models


class Pais(models.Model):
    """País de origen o comercialización.

    Ejemplo: Pais(codigo_tais="MX", nombre="México").
    """

    codigo_tais = models.CharField(max_length=10, unique=True)
    nombre = models.CharField(max_length=120)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "País"
        verbose_name_plural = "Países"

    def __str__(self) -> str:
        return self.nombre


class CasaProducto(models.Model):
    """Fabricante o marca del producto."""

    nombre = models.CharField(max_length=150)
    codigo = models.CharField(max_length=50, unique=True)
    descripcion = models.TextField(blank=True)
    pais = models.ForeignKey(
        Pais,
        on_delete=models.SET_NULL,
        related_name="casas_producto",
        null=True,
        blank=True,
    )

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Casa de producto"
        verbose_name_plural = "Casas de producto"

    def __str__(self) -> str:
        return f"{self.nombre} ({self.codigo})"


class CasaCompra(models.Model):
    """Proveedor o casa comercial donde se adquiere el producto."""

    nombre = models.CharField(max_length=150)
    codigo = models.CharField(max_length=50, unique=True)
    descripcion = models.TextField(blank=True)
    pais = models.ForeignKey(
        Pais,
        on_delete=models.SET_NULL,
        related_name="casas_compra",
        null=True,
        blank=True,
    )
    telefono = models.CharField(max_length=30, blank=True)
    correo = models.EmailField(blank=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Casa de compra"
        verbose_name_plural = "Casas de compra"

    def __str__(self) -> str:
        return f"{self.nombre} ({self.codigo})"


class Producto(models.Model):
    """Producto disponible para inventario y movimientos.

    Ejemplo: Producto(codigo="FILTRO-ACD123", nombre="Filtro de aceite ACDelco", pieza_original=True).
    """

    codigo = models.CharField(max_length=80, unique=True)
    nombre = models.CharField(max_length=200)
    descripcion = models.TextField(blank=True)
    pieza_original = models.BooleanField(default=False)
    casa_producto = models.ForeignKey(
        CasaProducto,
        on_delete=models.PROTECT,
        related_name="productos",
    )
    casa_compra = models.ForeignKey(
        CasaCompra,
        on_delete=models.SET_NULL,
        related_name="productos",
        null=True,
        blank=True,
    )
    referencia_fabricante = models.CharField(max_length=120, blank=True)
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Producto"
        verbose_name_plural = "Productos"

    def __str__(self) -> str:
        return f"{self.nombre} ({self.codigo})"


class ProductoReferencia(models.Model):
    """Códigos alternativos del mismo producto (OCP_PRO en el diagrama).

    Ejemplo: ProductoReferencia(producto=Producto(...), codigo="OC-1234", descripcion="Código interno").
    """

    producto = models.ForeignKey(
        Producto,
        on_delete=models.CASCADE,
        related_name="referencias",
    )
    codigo = models.CharField(max_length=80)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["codigo"]
        verbose_name = "Referencia de producto"
        verbose_name_plural = "Referencias de producto"
        unique_together = ("producto", "codigo")

    def __str__(self) -> str:
        return f"{self.codigo} - {self.producto.codigo}"


class ProductoOEM(models.Model):
    """Códigos OEM proporcionados por el fabricante."""

    producto = models.ForeignKey(
        Producto,
        on_delete=models.CASCADE,
        related_name="codigos_oem",
    )
    codigo = models.CharField(max_length=80)
    descripcion = models.TextField(blank=True)

    class Meta:
        ordering = ["codigo"]
        verbose_name = "Código OEM"
        verbose_name_plural = "Códigos OEM"
        unique_together = ("producto", "codigo")

    def __str__(self) -> str:
        return f"{self.codigo} - {self.producto.codigo}"


class ProductoAlterno(models.Model):
    """Relación entre un producto y sus alternativas compatibles."""

    producto = models.ForeignKey(
        Producto,
        on_delete=models.CASCADE,
        related_name="alternativas",
    )
    alterno = models.ForeignKey(
        Producto,
        on_delete=models.CASCADE,
        related_name="alternativas_para",
    )
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Producto alterno"
        verbose_name_plural = "Productos alternos"
        unique_together = ("producto", "alterno")

    def __str__(self) -> str:
        return f"Alterno de {self.producto.codigo}: {self.alterno.codigo}"
