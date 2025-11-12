from django.contrib import admin
from django.urls import include, path

from app.routers import CustomRouter
from inventarios.viewsets import EstadoProductoViewSet, InventarioViewSet
from movimientos.viewsets import MovimientoInventarioViewSet
from casa_comercial.viewsets import CasaComercialViewSet
from marcas.viewsets import MarcaViewSet
from productos.viewsets import (
    OEMProductoViewSet,
    OEMViewSet,
    ProductoAlternoViewSet,
    ProductoViewSet,
)
from tipos.viewsets import (
    EstadoMovimientoViewSet,
    PaisViewSet,
    SubTipoMovimientoViewSet,
    TipoMovimientoViewSet,
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

# Ubicaciones agrupadas en inventario
router.register(r"inventario/sucursales", SucursalViewSet, basename="inventario-sucursales")
router.register(r"inventario/bodegas", BodegaViewSet, basename="inventario-bodegas")
router.register(r"inventario/divisiones", DivisionViewSet, basename="inventario-divisiones")
router.register(r"inventario/subdivisiones", SubDivisionViewSet, basename="inventario-subdivisiones")

# Tipos
router.register(r"tipos/paises", PaisViewSet, basename="tipos-paises")
router.register(r"tipos/tipos-division", TipoDivisionViewSet, basename="tipos-tipos-division")
router.register(r"tipos/estados-producto", EstadoProductoViewSet, basename="tipos-estados-producto")
router.register(r"tipos/estados-movimiento", EstadoMovimientoViewSet, basename="tipos-estados-movimiento")
router.register(r"tipos/tipos-movimiento", TipoMovimientoViewSet, basename="tipos-tipos-movimiento")
router.register(
    r"tipos/subtipos-movimiento",
    SubTipoMovimientoViewSet,
    basename="tipos-subtipos-movimiento",
)

# Casas comerciales
router.register(r"casa-comercial/casas", CasaComercialViewSet, basename="casa-comercial-casas")
# Marcas
router.register(r"marcas/listado", MarcaViewSet, basename="marcas-listado")

# Productos
router.register(r"productos/listado", ProductoViewSet, basename="productos-listado")
router.register(r"productos/oem", OEMViewSet, basename="productos-oem")
router.register(r"productos/oem-producto", OEMProductoViewSet, basename="productos-oem-producto")
router.register(r"productos/alternos", ProductoAlternoViewSet, basename="productos-alternos")

# Inventarios
router.register(r"inventario/inventario", InventarioViewSet, basename="inventario-inventario")

# Movimientos
router.register(
    r"movimientos/movimiento_inventario",
    MovimientoInventarioViewSet,
    basename="movimientos-movimiento-inventario",
)

# Usuarios
router.register(r"usuarios/listado", UsuarioViewSet, basename="usuarios-listado")
router.register(r"usuarios/asignaciones", UsuarioSucursalViewSet, basename="usuarios-asignaciones")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include(router.urls)),
]
