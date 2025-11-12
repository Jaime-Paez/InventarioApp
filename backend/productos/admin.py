from django.contrib import admin

from .models import OEM, OEMProducto, Producto, ProductoAlterno


class OEMProductoInline(admin.TabularInline):
    model = OEMProducto
    extra = 1


class ProductoAlternoInline(admin.TabularInline):
    model = ProductoAlterno
    fk_name = "producto"
    extra = 1


@admin.register(Producto)
class ProductoAdmin(admin.ModelAdmin):
    list_display = ("codigo", "nombre", "marca", "casa_comercial", "pieza_original")
    list_filter = ("pieza_original", "marca", "casa_comercial")
    search_fields = (
        "codigo",
        "nombre",
        "marca__nombre",
        "casa_comercial__nombre",
    )
    inlines = [OEMProductoInline, ProductoAlternoInline]


@admin.register(OEM)
class OEMAdmin(admin.ModelAdmin):
    list_display = ("codigo",)
    search_fields = ("codigo",)


@admin.register(OEMProducto)
class OEMProductoAdmin(admin.ModelAdmin):
    list_display = ("producto", "oem")
    search_fields = ("producto__codigo", "producto__nombre", "oem__codigo")


@admin.register(ProductoAlterno)
class ProductoAlternoAdmin(admin.ModelAdmin):
    list_display = ("producto", "alterno")
    search_fields = (
        "producto__codigo",
        "producto__nombre",
        "alterno__codigo",
        "alterno__nombre",
    )
