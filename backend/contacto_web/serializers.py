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
            "correo_enviado",
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
            "correo_enviado",
        ]
