from rest_framework import serializers

from .models import CasaComercial
from tipos.models import Pais
from tipos.serializers import PaisSerializer
class CasaComercialSerializer(serializers.ModelSerializer):
    pais = PaisSerializer(read_only=True)
    pais_id = serializers.PrimaryKeyRelatedField(
        source="pais",
        queryset=Pais.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )

    class Meta:
        model = CasaComercial
        fields = [
            "id",
            "codigo",
            "nombre",
            "descripcion",
            "telefono",
            "correo",
            "pais",
            "pais_id",
        ]
