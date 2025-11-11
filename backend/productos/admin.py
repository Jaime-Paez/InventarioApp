from django.contrib import admin

from .models import (
    CasaCompra,
    CasaProducto,
    Pais,
    Producto,
    ProductoAlterno,
    ProductoOEM,
    ProductoReferencia,
)


@admin.register(Pais)
class PaisAdmin(admin.ModelAdmin):
    list_display = ("codigo_tais", "nombre")
    search_fields = ("codigo_tais", "nombre")


@admin.register(CasaProducto)
class CasaProductoAdmin(admin.ModelAdmin):
    list_display = ("codigo", "nombre", "pais")
    search_fields = ("codigo", "nombre", "pais__nombre")


@admin.register(CasaCompra)
class CasaCompraAdmin(admin.ModelAdmin):
    list_display = ("codigo", "nombre", "pais")
    search_fields = ("codigo", "nombre", "pais__nombre")


class ProductoReferenciaInline(admin.TabularInline):
    model = ProductoReferencia
    extra = 1


class ProductoOEMInline(admin.TabularInline):
    model = ProductoOEM
    extra = 1


class ProductoAlternoInline(admin.TabularInline):
    model = ProductoAlterno
    fk_name = "producto"
    extra = 1


@admin.register(Producto)
class ProductoAdmin(admin.ModelAdmin):
    list_display = ("codigo", "nombre", "casa_producto", "pieza_original")
    list_filter = ("pieza_original", "casa_producto")
    search_fields = ("codigo", "nombre", "casa_producto__nombre")
    inlines = [ProductoReferenciaInline, ProductoOEMInline, ProductoAlternoInline]


@admin.register(ProductoReferencia)
class ProductoReferenciaAdmin(admin.ModelAdmin):
    list_display = ("codigo", "producto")
    search_fields = ("codigo", "producto__codigo", "producto__nombre")


@admin.register(ProductoOEM)
class ProductoOEMAdmin(admin.ModelAdmin):
    list_display = ("codigo", "producto")
    search_fields = ("codigo", "producto__codigo", "producto__nombre")


@admin.register(ProductoAlterno)
class ProductoAlternoAdmin(admin.ModelAdmin):
    list_display = ("producto", "alterno")
    search_fields = (
        "producto__codigo",
        "producto__nombre",
        "alterno__codigo",
        "alterno__nombre",
    )
