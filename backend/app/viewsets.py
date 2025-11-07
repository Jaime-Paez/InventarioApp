from rest_framework import viewsets
from rest_framework.response import Response

class ItemsViewSet(viewsets.ViewSet):
    """Inventario de partes (demo)"""
    def list(self, request):
        data = [
            {"id": 1, "sku": "FILTRO-208", "nombre": "Filtro de aceite", "stock": 14},
            {"id": 2, "sku": "PAST-3008", "nombre": "Pastillas de freno", "stock": 8},
        ]
        return Response(data)

class MovimientosViewSet(viewsets.ViewSet):
    """Entradas/Salidas (demo)"""
    def list(self, request):
        data = [
            {"id": 1, "tipo": "entrada", "sku": "FILTRO-208", "cant": 10},
            {"id": 2, "tipo": "salida",  "sku": "PAST-3008", "cant": 2},
        ]
        return Response(data)

class ProveedoresViewSet(viewsets.ViewSet):
    """Proveedores (demo)"""
    def list(self, request):
        data = [
            {"id": 1, "nombre": "ACDelco"},
            {"id": 2, "nombre": "Bosch"},
        ]
        return Response(data)

class CategoriasViewSet(viewsets.ViewSet):
    """Categorías (demo)"""
    def list(self, request):
        return Response(["Frenos", "Filtros", "Suspensión"])
