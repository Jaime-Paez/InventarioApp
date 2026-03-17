from django.apps import AppConfig


class AuditoriaConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "auditoria"
    verbose_name = "Auditoría"

    def ready(self):
        from django.contrib.auth import get_user_model

        from inventario.models import Bodega, Inventario, Sucursal
        from movimientos.models import MovimientoInventario
        from productos.models import Producto
        from solicitudes.models import Cliente, Solicitud
        from app.models import InspeccionAleatoriaDiaria, InspeccionAleatoriaItem

        from .signals import register_audit_signals

        for model in [
            Inventario,
            Sucursal,
            Bodega,
            Producto,
            MovimientoInventario,
            Solicitud,
            Cliente,
            InspeccionAleatoriaDiaria,
            InspeccionAleatoriaItem,
            get_user_model(),
        ]:
            register_audit_signals(model)
