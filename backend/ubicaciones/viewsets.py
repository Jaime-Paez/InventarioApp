from rest_framework import filters, viewsets

from .models import Bodega, Division, Sucursal, SubDivision, TipoDivision
from .serializers import (
    BodegaSerializer,
    DivisionSerializer,
    SucursalSerializer,
    SubDivisionSerializer,
    TipoDivisionSerializer,
)


class SucursalViewSet(viewsets.ModelViewSet):
    """API CRUD para las sucursales físicas."""

    queryset = Sucursal.objects.all().order_by("nombre")
    serializer_class = SucursalSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["codigo", "nombre", "ciudad"]
    ordering_fields = ["nombre", "codigo", "ciudad"]


class BodegaViewSet(viewsets.ModelViewSet):
    """API CRUD para bodegas dentro de una sucursal."""

    queryset = Bodega.objects.select_related("sucursal").all().order_by("sucursal__nombre", "nombre")
    serializer_class = BodegaSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "sucursal__nombre", "sucursal__codigo"]
    ordering_fields = ["nombre", "sucursal__nombre"]


class TipoDivisionViewSet(viewsets.ModelViewSet):
    """API CRUD para los tipos de división (estantería, repisa, mueble, etc.)."""

    queryset = TipoDivision.objects.all().order_by("nombre")
    serializer_class = TipoDivisionSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class DivisionViewSet(viewsets.ModelViewSet):
    """API CRUD para divisiones específicas dentro de una bodega."""

    queryset = (
        Division.objects.select_related("tipo_division", "bodega", "bodega__sucursal")
        .all()
        .order_by("bodega__nombre", "nombre")
    )
    serializer_class = DivisionSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "nombre",
        "tipo_division__nombre",
        "bodega__nombre",
        "bodega__sucursal__nombre",
    ]
    ordering_fields = ["nombre", "bodega__nombre", "tipo_division__nombre"]


class SubDivisionViewSet(viewsets.ModelViewSet):
    """API CRUD para subdivisiones (niveles, cajones o repisas)."""

    queryset = (
        SubDivision.objects.select_related(
            "division",
            "division__bodega",
            "division__bodega__sucursal",
            "division__tipo_division",
        )
        .all()
        .order_by("division__nombre", "nombre")
    )
    serializer_class = SubDivisionSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "division__nombre", "division__bodega__nombre"]
    ordering_fields = ["nombre", "division__nombre"]
