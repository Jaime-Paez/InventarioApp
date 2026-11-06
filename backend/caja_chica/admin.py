from django.contrib import admin

from .models import Arqueo, Caja, CategoriaGasto, MovimientoCaja

admin.site.register(Caja)
admin.site.register(CategoriaGasto)
admin.site.register(MovimientoCaja)
admin.site.register(Arqueo)
