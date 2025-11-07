from django.contrib import admin
from django.urls import path, include
from app.routers import CustomRouter
from app.viewsets import (
    ItemsViewSet, MovimientosViewSet, ProveedoresViewSet, CategoriasViewSet
)

router = CustomRouter()
# Los nombres de prefijo son las claves que verás en el root JSON:
router.register(r"inventario", ItemsViewSet, basename="inventario")
router.register(r"movimientos", MovimientosViewSet, basename="movimientos")
router.register(r"proveedores", ProveedoresViewSet, basename="proveedores")
router.register(r"categorias", CategoriasViewSet, basename="categorias")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include(router.urls)),        # root como en tu imagen
    # Si prefieres bajo /api/:
    # path("api/", include(router.urls)),
]
