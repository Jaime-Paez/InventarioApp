from django.contrib import admin

from .models import OEM, OEMProducto, Producto, ProductoAlterno, ProductoCalificacion


class OEMProductoInline(admin.TabularInline):
    model = OEMProducto
    extra = 1


class ProductoAlternoInline(admin.TabularInline):
    model = ProductoAlterno
    fk_name = "producto"
    extra = 1


@admin.register(Producto)
class ProductoAdmin(admin.ModelAdmin):
    list_display = (
        "codigo",
        "nombre",
        "marca",
        "mostrar_casas_comerciales",
        "pieza_original",
    )
    list_filter = (
        "pieza_original",
        "marca",
        ("casas_comerciales", admin.RelatedOnlyFieldListFilter),
    )
    search_fields = (
        "codigo",
        "nombre",
        "marca__nombre",
        "casas_comerciales__nombre",
    )
    inlines = [OEMProductoInline, ProductoAlternoInline]

    @admin.display(description="Casas comerciales")
    def mostrar_casas_comerciales(self, obj):
        return ", ".join(obj.casas_comerciales.values_list("nombre", flat=True)) or "-"


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


@admin.register(ProductoCalificacion)
class ProductoCalificacionAdmin(admin.ModelAdmin):
    list_display = ("producto", "usuario", "estrellas", "created_at")
    list_filter = ("estrellas", "created_at")
    search_fields = (
        "producto__codigo",
        "producto__nombre",
        "usuario__email",
        "comentario",
    )
