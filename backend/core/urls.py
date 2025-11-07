from django.contrib import admin
from django.urls import path, include
from app.routers import CustomRouter
from catalogo.viewsets import (
    CategoriaViewSet,
    MarcaViewSet,
    ProductoViewSet,
    TipoCompraViewSet,
    TipoPagoViewSet,
)
from entradas.viewsets import (
    EntradaCompraViewSet,
    EntradaDetalleViewSet,
    EntradaDevolucionViewSet,
    EntradaViewSet,
)
from inventario.viewsets import InventarioViewSet
from salidas.viewsets import SalidaDetalleViewSet, SalidaSucursalViewSet, SalidaViewSet
from sucursales.viewsets import SucursalViewSet
from usuarios.viewsets import UsuarioViewSet

router = CustomRouter()
# Los nombres de prefijo son las claves que verás en el root JSON:
router.register(r"catalogo/marcas", MarcaViewSet, basename="catalogo-marcas")
router.register(r"catalogo/categorias", CategoriaViewSet, basename="catalogo-categorias")
router.register(r"catalogo/tipos-compra", TipoCompraViewSet, basename="catalogo-tipos-compra")
router.register(r"catalogo/tipos-pago", TipoPagoViewSet, basename="catalogo-tipos-pago")
router.register(r"catalogo/productos", ProductoViewSet, basename="catalogo-productos")
router.register(r"sucursales", SucursalViewSet, basename="sucursales")
router.register(r"usuarios", UsuarioViewSet, basename="usuarios")
router.register(r"entradas", EntradaViewSet, basename="entradas")
router.register(r"entradas/compras", EntradaCompraViewSet, basename="entradas-compras")
router.register(r"entradas/devoluciones", EntradaDevolucionViewSet, basename="entradas-devoluciones")
router.register(r"entradas/detalles", EntradaDetalleViewSet, basename="entradas-detalles")
router.register(r"salidas", SalidaViewSet, basename="salidas")
router.register(r"salidas/sucursales", SalidaSucursalViewSet, basename="salidas-sucursales")
router.register(r"salidas/detalles", SalidaDetalleViewSet, basename="salidas-detalles")
router.register(r"inventario", InventarioViewSet, basename="inventario")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include(router.urls)),        # root como en tu imagen
    # Si prefieres bajo /api/:
    # path("api/", include(router.urls)),
]
