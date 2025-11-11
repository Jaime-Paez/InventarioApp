from django.contrib import admin
from django.urls import include, path

from app.routers import CustomRouter
from inventarios.viewsets import EstadoProductoViewSet, InventarioViewSet
from movimientos.viewsets import (
    DetalleMovimientoViewSet,
    EstadoMovimientoViewSet,
    MovimientoInventarioViewSet,
    TipoMovimientoViewSet,
    TipoPagoViewSet,
)
from productos.viewsets import (
    CasaCompraViewSet,
    CasaProductoViewSet,
    PaisViewSet,
    ProductoAlternoViewSet,
    ProductoOEMViewSet,
    ProductoReferenciaViewSet,
    ProductoViewSet,
)
from ubicaciones.viewsets import (
    BodegaViewSet,
    DivisionViewSet,
    SucursalViewSet,
    SubDivisionViewSet,
    TipoDivisionViewSet,
)
from usuarios.viewsets import UsuarioSucursalViewSet, UsuarioViewSet

router = CustomRouter()

# Ubicaciones
router.register(r"ubicaciones/sucursales", SucursalViewSet, basename="ubicaciones-sucursales")
router.register(r"ubicaciones/bodegas", BodegaViewSet, basename="ubicaciones-bodegas")
router.register(r"ubicaciones/tipos-division", TipoDivisionViewSet, basename="ubicaciones-tipos-division")
router.register(r"ubicaciones/divisiones", DivisionViewSet, basename="ubicaciones-divisiones")
router.register(r"ubicaciones/subdivisiones", SubDivisionViewSet, basename="ubicaciones-subdivisiones")

# Productos
router.register(r"productos/paises", PaisViewSet, basename="productos-paises")
router.register(r"productos/casas-producto", CasaProductoViewSet, basename="productos-casas-producto")
router.register(r"productos/casas-compra", CasaCompraViewSet, basename="productos-casas-compra")
router.register(r"productos/listado", ProductoViewSet, basename="productos-listado")
router.register(r"productos/referencias", ProductoReferenciaViewSet, basename="productos-referencias")
router.register(r"productos/codigos-oem", ProductoOEMViewSet, basename="productos-codigos-oem")
router.register(r"productos/alternos", ProductoAlternoViewSet, basename="productos-alternos")

# Inventarios
router.register(r"inventarios/estados-producto", EstadoProductoViewSet, basename="inventarios-estados-producto")
router.register(r"inventarios/lotes", InventarioViewSet, basename="inventarios-lotes")

# Movimientos
router.register(r"movimientos/tipos-pago", TipoPagoViewSet, basename="movimientos-tipos-pago")
router.register(r"movimientos/tipos", TipoMovimientoViewSet, basename="movimientos-tipos")
router.register(r"movimientos/estados", EstadoMovimientoViewSet, basename="movimientos-estados")
router.register(r"movimientos/encabezados", MovimientoInventarioViewSet, basename="movimientos-encabezados")
router.register(r"movimientos/detalles", DetalleMovimientoViewSet, basename="movimientos-detalles")

# Usuarios
router.register(r"usuarios/listado", UsuarioViewSet, basename="usuarios-listado")
router.register(r"usuarios/asignaciones", UsuarioSucursalViewSet, basename="usuarios-asignaciones")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include(router.urls)),
]
