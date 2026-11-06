from decimal import Decimal

from django.conf import settings
from django.db import models


class ManoObra(models.Model):
    """Catalogo de trabajos de mano de obra con su precio fijo.

    En la orden siempre se puede escribir cualquier otro trabajo a mano: el
    catalogo solo acelera lo frecuente.
    """

    nombre = models.CharField(max_length=200)
    precio = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("0"))
    activo = models.BooleanField(default=True)
    creado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Mano de obra"
        verbose_name_plural = "Mano de obra"

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.nombre} (${self.precio})"


class Tecnico(models.Model):
    """Tecnico del taller: se elige en cada orden y firma lo que recibe."""

    nombre = models.CharField(max_length=150)
    cedula = models.CharField(max_length=25, blank=True)
    telefono = models.CharField(max_length=50, blank=True)
    especialidad = models.CharField(max_length=120, blank=True)
    activo = models.BooleanField(default=True)
    creado_en = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["nombre"]
        verbose_name = "Técnico"
        verbose_name_plural = "Técnicos"

    def __str__(self) -> str:  # pragma: no cover
        return self.nombre


class OrdenTaller(models.Model):
    """Cotizacion de taller que, si el cliente acepta, pasa a orden de trabajo.

    Reemplaza la hoja fisica "Orden de Repuestos": numero de orden, pedido,
    tecnico, vehiculo (modelo/cilindraje, placa, VIN) y el detalle.
    """

    class Estados(models.TextChoices):
        COTIZACION = "cotizacion", "Cotización"
        RECHAZADA = "rechazada", "Rechazada"
        ORDEN = "orden", "Orden de trabajo"
        CERRADA = "cerrada", "Cerrada"
        ANULADA = "anulada", "Anulada"

    class TiposOrden(models.TextChoices):
        NORMAL = "normal", "Normal"
        GARANTIA = "garantia", "Garantía"

    numero = models.PositiveIntegerField(unique=True)
    tipo = models.CharField(max_length=20, choices=TiposOrden.choices, default=TiposOrden.NORMAL)
    garantia_de = models.ForeignKey(
        "self",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="garantias",
        help_text="Orden original cuando esta es una orden por garantia.",
    )
    sucursal = models.ForeignKey(
        "inventario.Sucursal",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="ordenes_taller",
        help_text="Sucursal de cuyo inventario salen los repuestos.",
    )
    # Numero de pedido: distinto del numero de orden (lo pide el negocio asi).
    numero_pedido = models.CharField(max_length=60, blank=True)
    estado = models.CharField(max_length=20, choices=Estados.choices, default=Estados.COTIZACION)

    asesor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="ordenes_taller_asesor",
        help_text="Asistente/asesor de servicio que creo la cotizacion.",
    )
    tecnico_asignado = models.ForeignKey(
        Tecnico,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="ordenes",
    )
    # Nombre del tecnico al momento de asignarlo (se ve aunque luego se renombre).
    tecnico = models.CharField(max_length=150, blank=True)

    cliente_nombre = models.CharField(max_length=255, blank=True)
    cliente_identificacion = models.CharField("Cédula/RUC", max_length=25, blank=True)
    cliente_telefono = models.CharField(max_length=50, blank=True)

    placa = models.CharField(max_length=20, blank=True)
    modelo = models.CharField("Modelo / cilindraje", max_length=200, blank=True)
    vin = models.CharField("VIN", max_length=40, blank=True)
    kilometraje = models.PositiveIntegerField(null=True, blank=True)

    observaciones = models.TextField(blank=True)
    motivo_rechazo = models.TextField(blank=True)

    numero_factura = models.CharField(max_length=60, blank=True)

    aceptada_en = models.DateTimeField(null=True, blank=True)
    aceptada_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    cerrada_en = models.DateTimeField(null=True, blank=True)
    cerrada_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    movimiento_salida = models.OneToOneField(
        "movimientos.MovimientoInventario",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="orden_taller",
    )
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-numero"]
        verbose_name = "Orden de taller"
        verbose_name_plural = "Órdenes de taller"
        indexes = [
            models.Index(fields=["estado"], name="taller_orden_estado_idx"),
            models.Index(fields=["placa"], name="taller_orden_placa_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"Orden {self.numero} ({self.get_estado_display()})"

    @property
    def es_editable(self) -> bool:
        return self.estado in (self.Estados.COTIZACION, self.Estados.ORDEN)


class OrdenTallerLinea(models.Model):
    """Una fila del detalle: repuesto, repuesto sin codigo, insumo o mano de obra."""

    class Tipos(models.TextChoices):
        REPUESTO = "repuesto", "Repuesto"
        SIN_CODIGO = "sin_codigo", "Repuesto sin código"
        INSUMO = "insumo", "Insumo"
        MANO_OBRA = "mano_obra", "Mano de obra"

    class EstadosPrecio(models.TextChoices):
        # Sin estado: el precio es el del inventario (o la linea no tiene PVP).
        NO_APLICA = "", "No aplica"
        PENDIENTE = "pendiente", "Por aprobar"
        APROBADO = "aprobado", "Aprobado"

    orden = models.ForeignKey(OrdenTaller, on_delete=models.CASCADE, related_name="lineas")
    tipo = models.CharField(max_length=20, choices=Tipos.choices)
    producto = models.ForeignKey(
        "productos.Producto",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="lineas_taller",
    )
    mano_obra = models.ForeignKey(
        ManoObra,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="lineas",
    )
    # OEM / referencia de un repuesto que todavia no existe en el catalogo.
    referencia = models.CharField(max_length=120, blank=True)
    descripcion = models.CharField(max_length=255, blank=True)
    cantidad = models.PositiveIntegerField(default=1)
    # PVP del inventario al momento de agregar la linea (solo repuestos).
    precio_lista = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    precio = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("0"))
    precio_estado = models.CharField(
        max_length=20,
        choices=EstadosPrecio.choices,
        blank=True,
        default=EstadosPrecio.NO_APLICA,
    )
    precio_revisado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    precio_revisado_en = models.DateTimeField(null=True, blank=True)
    # Unidades que el administrador ya entrego al taller (estan "en taller").
    cantidad_despachada = models.PositiveIntegerField(default=0)
    # En una orden por garantia: el repuesto va sin costo para el cliente.
    es_garantia = models.BooleanField(default=False)
    # Se agrego sin codigo y luego el administrador creo/vinculo el producto.
    era_sin_codigo = models.BooleanField(default=False)
    # True si se agrego despues de que el cliente acepto la cotizacion.
    agregada_en_orden = models.BooleanField(default=False)
    posicion = models.PositiveIntegerField(default=0)
    creado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["posicion", "id"]
        verbose_name = "Línea de orden de taller"
        verbose_name_plural = "Líneas de orden de taller"

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.get_tipo_display()} x{self.cantidad} - {self.descripcion}"

    @property
    def total(self) -> Decimal:
        return (self.precio or Decimal("0")) * Decimal(self.cantidad or 0)

    @property
    def pendiente_despacho(self) -> int:
        if self.tipo != self.Tipos.REPUESTO or not self.producto_id:
            return 0
        return max(0, int(self.cantidad or 0) - int(self.cantidad_despachada or 0))


class OrdenTallerEvento(models.Model):
    """Historial de la orden: quien hizo que y cuando."""

    orden = models.ForeignKey(OrdenTaller, on_delete=models.CASCADE, related_name="eventos")
    tipo = models.CharField(max_length=40)
    descripcion = models.TextField()
    usuario = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    creado_en = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-creado_en", "-id"]
        verbose_name = "Evento de orden de taller"
        verbose_name_plural = "Eventos de orden de taller"


class OrdenTallerPrueba(models.Model):
    """Repuesto en el taller que NO es parte de la orden.

    - origen "prueba": se pidio aparte para probar. Puede pasar a la orden o
      debe volver a bodega.
    - origen "quitado": estaba despachado en la orden y el administrador lo
      quito o bajo la cantidad; tiene que volver a bodega.
    """

    class Origenes(models.TextChoices):
        PRUEBA = "prueba", "A prueba"
        QUITADO = "quitado", "Quitado de la orden"

    orden = models.ForeignKey(OrdenTaller, on_delete=models.CASCADE, related_name="pruebas")
    producto = models.ForeignKey("productos.Producto", on_delete=models.PROTECT, related_name="pruebas_taller")
    origen = models.CharField(max_length=20, choices=Origenes.choices, default=Origenes.PRUEBA)
    cantidad_solicitada = models.PositiveIntegerField(default=1)
    cantidad_entregada = models.PositiveIntegerField(default=0)
    cantidad_usada = models.PositiveIntegerField(default=0)
    cantidad_devuelta = models.PositiveIntegerField(default=0)
    creado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    creado_en = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["id"]
        verbose_name = "Repuesto a prueba"
        verbose_name_plural = "Repuestos a prueba"

    @property
    def pendiente_entrega(self) -> int:
        return max(0, int(self.cantidad_solicitada) - int(self.cantidad_entregada))

    @property
    def en_taller(self) -> int:
        return max(0, int(self.cantidad_entregada) - int(self.cantidad_usada) - int(self.cantidad_devuelta))


class OrdenTallerEntrega(models.Model):
    """Entrega fisica de repuestos al taller (despacho), con firma de quien recibe."""

    class Tipos(models.TextChoices):
        ORDEN = "orden", "Repuestos de la orden"
        PRUEBA = "prueba", "Repuestos a prueba"

    orden = models.ForeignKey(OrdenTaller, on_delete=models.CASCADE, related_name="entregas")
    tipo = models.CharField(max_length=20, choices=Tipos.choices)
    entregado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        help_text="Administrador que despacho.",
    )
    recibido_por = models.CharField(max_length=150)
    recibido_rol = models.CharField(max_length=40, blank=True)
    firma = models.TextField(help_text="Firma en pantalla (imagen PNG en data URL).")
    nota = models.TextField(blank=True)
    creado_en = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-creado_en", "-id"]
        verbose_name = "Entrega a taller"
        verbose_name_plural = "Entregas a taller"


class OrdenTallerEntregaItem(models.Model):
    entrega = models.ForeignKey(OrdenTallerEntrega, on_delete=models.CASCADE, related_name="items")
    linea = models.ForeignKey(OrdenTallerLinea, on_delete=models.SET_NULL, null=True, blank=True, related_name="entregas")
    prueba = models.ForeignKey(OrdenTallerPrueba, on_delete=models.SET_NULL, null=True, blank=True, related_name="entregas")
    producto = models.ForeignKey("productos.Producto", on_delete=models.PROTECT, related_name="+")
    cantidad = models.PositiveIntegerField()
    # [{"subdivision_id", "ubicacion", "cantidad"}] de donde salio.
    ubicaciones = models.JSONField(default=list, blank=True)

    class Meta:
        ordering = ["id"]


class OrdenTallerDevolucion(models.Model):
    """Repuesto que volvio del taller a bodega, verificado por el administrador."""

    orden = models.ForeignKey(OrdenTaller, on_delete=models.CASCADE, related_name="devoluciones")
    prueba = models.ForeignKey(OrdenTallerPrueba, on_delete=models.SET_NULL, null=True, blank=True, related_name="devoluciones")
    producto = models.ForeignKey("productos.Producto", on_delete=models.PROTECT, related_name="+")
    cantidad = models.PositiveIntegerField()
    subdivision = models.ForeignKey("inventario.SubDivision", on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    ubicacion = models.CharField(max_length=255, blank=True)
    devuelto_por = models.CharField(max_length=150, blank=True)
    recibido_por = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        help_text="Administrador que verifico que se guardo.",
    )
    creado_en = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-creado_en", "-id"]
        verbose_name = "Devolución de taller"
        verbose_name_plural = "Devoluciones de taller"
