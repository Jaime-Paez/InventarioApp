from django.db.models.deletion import ProtectedError
from rest_framework import filters, status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.table_filters import apply_column_filters, parse_column_filters
from usuarios.permissions import ProveedoresCasasDependentReadPermission

from .models import CasaComercial
from .serializers import CasaComercialSerializer


class CasaComercialViewSet(viewsets.ModelViewSet):
    queryset = CasaComercial.objects.select_related("pais").all().order_by("-id")
    serializer_class = CasaComercialSerializer
    permission_classes = [IsAuthenticated, ProveedoresCasasDependentReadPermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre", "codigo", "pais__nombre", "telefono", "correo", "descripcion"]
    ordering_fields = ["nombre", "codigo", "pais__nombre", "telefono", "correo", "descripcion"]

    def get_queryset(self):
        queryset = super().get_queryset()
        params = self.request.query_params

        nombre = (params.get("nombre") or "").strip()
        if nombre:
            queryset = queryset.filter(nombre__icontains=nombre)

        codigo = (params.get("codigo") or "").strip()
        if codigo:
            queryset = queryset.filter(codigo__icontains=codigo)

        pais = (params.get("pais") or "").strip()
        if pais:
            queryset = queryset.filter(pais__nombre__icontains=pais)

        telefono = (params.get("telefono") or "").strip()
        if telefono:
            queryset = queryset.filter(telefono__icontains=telefono)

        correo = (params.get("correo") or "").strip()
        if correo:
            queryset = queryset.filter(correo__icontains=correo)

        descripcion = (params.get("descripcion") or "").strip()
        if descripcion:
            queryset = queryset.filter(descripcion__icontains=descripcion)

        tipo = (params.get("tipo") or "").strip()
        if tipo:
            queryset = queryset.filter(tipo=tipo)

        queryset = apply_column_filters(
            queryset,
            parse_column_filters(params.get("column_filters")),
            {
                "nombre": "nombre",
                "codigo": "codigo",
                "pais_nombre": "pais__nombre",
                "telefono": "telefono",
                "correo": "correo",
                "descripcion": "descripcion",
            },
        )

        return queryset.distinct()

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.productos.exists():
            return Response(
                {
                    "detail": "No se puede eliminar la casa comercial porque tiene productos asociados."
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            return super().destroy(request, *args, **kwargs)
        except ProtectedError:
            return Response(
                {
                    "detail": (
                        "No se puede eliminar la casa comercial porque esta ligada a registros historicos protegidos."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
