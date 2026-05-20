import re
import uuid
import unicodedata

from django.core.exceptions import ValidationError
from django.db import models

from casa_comercial.models import CasaComercial


def normalize_sucursal_name(value):
    raw_value = str(value or "").strip()
    if not raw_value:
        return ""
    normalized = unicodedata.normalize("NFKD", raw_value)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    collapsed = re.sub(r"[^a-zA-Z0-9]+", " ", ascii_text).strip().lower()
    return re.sub(r"\s+", " ", collapsed)


def resolve_solicitud_sucursal_code(sucursal):
    normalized_name = normalize_sucursal_name(getattr(sucursal, "nombre", ""))
    if not normalized_name:
        return "SUC"

    if "norte" in normalized_name:
        return "NOR"
    if "sur" in normalized_name:
        return "SUR"
    if "octubre" in normalized_name and "9" in normalized_name:
        return "9OCT"

    tokens = re.findall(r"[a-z0-9]+", normalized_name)
    compact = "".join(tokens).upper()
    if not compact:
        return "SUC"
    if compact[0].isdigit():
        return compact[:4]
    return compact[:3]


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
        on_delete=models.PROTECT,
        related_name="autos",
    )
    placa = models.CharField(max_length=20)
    modelo = models.CharField(max_length=120)
    anio = models.PositiveSmallIntegerField("Anio")
    marca = models.CharField(max_length=120, blank=True)
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
    casa_comercial = models.ForeignKey(
        CasaComercial,
        on_delete=models.PROTECT,
        related_name="productos_solicitados",
        null=True,
        blank=True,
    )
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

    class Estado(models.TextChoices):
        SOLICITADO = "solicitado", "Solicitado"
        REVISADO = "revisado", "Revisado"
        ARCHIVADO = "archivado", "Archivado"

    codigo = models.CharField(max_length=80, blank=True, default="", db_index=True)
    grupo_codigo = models.CharField(max_length=80, blank=True, default="", db_index=True)
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
    comentario = models.TextField(blank=True)
    marca = models.CharField(max_length=120, blank=True, default="")
    modelo = models.CharField(max_length=120, blank=True, default="")
    motor = models.CharField(max_length=120, blank=True, default="")
    anio = models.CharField(max_length=10, blank=True, default="")
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
    estado = models.CharField(
        max_length=20,
        choices=Estado.choices,
        default=Estado.SOLICITADO,
    )

    class Meta:
        ordering = ["-fecha", "id"]
        verbose_name = "Solicitud"
        verbose_name_plural = "Solicitudes"

    @classmethod
    def build_codigo_base(cls, sucursal):
        branch_code = resolve_solicitud_sucursal_code(sucursal)
        return f"SOL-{branch_code}"

    @classmethod
    def generate_next_codigo(cls, sucursal, exclude_id=None):
        base = cls.build_codigo_base(sucursal)
        queryset = cls.objects.filter(codigo__istartswith=f"{base}-")
        if exclude_id is not None:
            queryset = queryset.exclude(pk=exclude_id)

        matcher = re.compile(rf"^{re.escape(base)}-(\d+)$", flags=re.IGNORECASE)
        max_number = 0
        for raw_codigo in queryset.values_list("codigo", flat=True).distinct():
            matched = matcher.match(str(raw_codigo or "").strip())
            if not matched:
                continue
            try:
                max_number = max(max_number, int(matched.group(1)))
            except (TypeError, ValueError):
                continue

        return f"{base}-{max_number + 1}"

    def should_regenerate_codigo(self):
        if not self.sucursal_id:
            return False
        current_codigo = str(self.codigo or "").strip().upper()
        expected_prefix = f"{self.build_codigo_base(self.sucursal)}-"
        return not current_codigo or not current_codigo.startswith(expected_prefix)

    def __str__(self) -> str:  # pragma: no cover - representación legible
        if self.tabla == self.Tabla.PRODUCTO and self.producto:
            referencia = self.producto.nombre
        elif self.producto_solicitado:
            referencia = self.producto_solicitado.nombre
        else:  # pragma: no cover - fallback seguro
            referencia = "Producto"
        codigo = str(self.codigo or "").strip() or f"Solicitud #{self.pk or 'nuevo'}"
        return f"{codigo} - {referencia}"

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
        if not self.grupo_codigo:
            self.grupo_codigo = uuid.uuid4().hex
            update_fields = kwargs.get("update_fields")
            if update_fields is not None:
                updated = set(update_fields)
                updated.add("grupo_codigo")
                kwargs["update_fields"] = list(updated)
        if self.should_regenerate_codigo():
            self.codigo = self.generate_next_codigo(self.sucursal, exclude_id=self.pk)
            update_fields = kwargs.get("update_fields")
            if update_fields is not None:
                updated = set(update_fields)
                updated.add("codigo")
                kwargs["update_fields"] = list(updated)
        self.full_clean()
        return super().save(*args, **kwargs)


class RevisionReferencia(models.Model):
    """Referencias de casas comerciales agregadas al revisar una solicitud."""

    solicitud = models.ForeignKey(
        Solicitud,
        on_delete=models.CASCADE,
        related_name="revisiones",
    )
    casa_comercial = models.ForeignKey(
        CasaComercial,
        on_delete=models.SET_NULL,
        related_name="revisiones_solicitud",
        null=True,
        blank=True,
    )
    referencia = models.CharField(max_length=255, blank=True)
    creado_en = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["creado_en"]
        verbose_name = "Revisión de referencia"
        verbose_name_plural = "Revisiones de referencia"

    def __str__(self) -> str:  # pragma: no cover
        casa = self.casa_comercial.nombre if self.casa_comercial else "sin casa"
        return f"{self.solicitud} - {casa}: {self.referencia}"


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
