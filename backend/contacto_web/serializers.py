from rest_framework import serializers

from .models import SolicitudWeb


class SolicitudWebSerializer(serializers.ModelSerializer):
    class Meta:
        model = SolicitudWeb
        fields = [
            "id",
            "nombre",
            "celular",
            "marca",
            "modelo",
            "anio",
            "chasis",
            "detalle",
            "creado_en",
            "leido",
            "contactado",
        ]
        read_only_fields = [
            "id",
            "nombre",
            "celular",
            "marca",
            "modelo",
            "anio",
            "chasis",
            "detalle",
            "creado_en",
        ]
