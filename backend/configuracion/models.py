from decimal import Decimal

from django.db import models


class ConfiguracionSistema(models.Model):
    """Configuracion global del sistema (singleton)."""

    iva_rate = models.DecimalField(
        max_digits=5,
        decimal_places=4,
        default=Decimal("0.15"),
        help_text="IVA aplicado en el sistema, expresado como decimal (ej: 0.15).",
    )
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Configuracion del sistema"
        verbose_name_plural = "Configuracion del sistema"

    def __str__(self) -> str:  # pragma: no cover - representacion legible
        return f"IVA {self.iva_rate:.2%}"

    @classmethod
    def get_solo(cls):
        instance = cls.objects.order_by("id").first()
        if instance:
            return instance
        return cls.objects.create(iva_rate=Decimal("0.15"))
