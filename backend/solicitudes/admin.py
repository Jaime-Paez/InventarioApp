from django.contrib import admin

from .models import Cliente, OEMProductoSolicitado, ProductoSolicitado, Solicitud


@admin.register(Cliente)
class ClienteAdmin(admin.ModelAdmin):
    list_display = ("nombre", "correo", "telefono", "cedula_ruc")
    search_fields = ("nombre", "correo", "telefono", "cedula_ruc")


@admin.register(ProductoSolicitado)
class ProductoSolicitadoAdmin(admin.ModelAdmin):
    list_display = ("nombre", "conseguido", "producto")
    list_filter = ("conseguido",)
    search_fields = ("nombre", "descripcion", "producto__nombre", "producto__codigo")


@admin.register(Solicitud)
class SolicitudAdmin(admin.ModelAdmin):
    list_display = ("id", "cliente", "tabla", "cantidad", "fecha", "sucursal")
    list_filter = ("tabla", "fecha", "sucursal")
    search_fields = (
        "cliente__nombre",
        "cliente__cedula_ruc",
        "producto__nombre",
        "producto_solicitado__nombre",
    )


@admin.register(OEMProductoSolicitado)
class OEMProductoSolicitadoAdmin(admin.ModelAdmin):
    list_display = ("producto_solicitado", "oem")
    search_fields = ("producto_solicitado__nombre", "oem__codigo")
