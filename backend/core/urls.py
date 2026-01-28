from django.contrib import admin
from django.urls import include, path

from app.routers import CustomRouter
from movimientos.viewsets import MovimientoInventarioViewSet
from inventario.viewsets import (
    BodegaViewSet,
    DivisionViewSet,
    InventarioViewSet,
    SucursalViewSet,
    SubDivisionViewSet,
)
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
    EstadoProductoViewSet,
    PaisViewSet,
    SubTipoMovimientoViewSet,
    TipoDivisionViewSet,
    TipoMovimientoViewSet,
    TipoPagoViewSet,
)
from usuarios.viewsets import (
    LoginAPIView,
    PermisosDisponiblesAPIView,
    PerfilAPIView,
    RegistroAPIView,
    RolViewSet,
    UsuarioViewSet,
)
from solicitudes.viewsets import (
    ClienteViewSet,
    OEMProductoSolicitadoViewSet,
    ProductoSolicitadoViewSet,
    SolicitudViewSet,
)

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
router.register(r"tipos/tipos-pago", TipoPagoViewSet, basename="tipos-tipos-pago")

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
router.register(r"usuarios/roles", RolViewSet, basename="usuarios-roles")

# Solicitudes
router.register(r"solicitudes/clientes", ClienteViewSet, basename="solicitudes-clientes")
router.register(
    r"solicitudes/productos-solicitados",
    ProductoSolicitadoViewSet,
    basename="solicitudes-productos-solicitados",
)
router.register(
    r"solicitudes/oem-productos",
    OEMProductoSolicitadoViewSet,
    basename="solicitudes-oem-productos",
)
router.register(r"solicitudes/solicitudes", SolicitudViewSet, basename="solicitudes-solicitudes")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("auth/register/", RegistroAPIView.as_view(), name="auth-register"),
    path("auth/login/", LoginAPIView.as_view(), name="auth-login"),
    path("auth/me/", PerfilAPIView.as_view(), name="auth-profile"),
    path(
        "usuarios/permisos/opciones/",
        PermisosDisponiblesAPIView.as_view(),
        name="usuarios-permisos-opciones",
    ),
    path("", include(router.urls)),
]
