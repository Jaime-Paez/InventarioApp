from rest_framework import serializers

from tipos.models import Pais
from tipos.serializers import PaisSerializer

from .models import Marca


class MarcaSerializer(serializers.ModelSerializer):
    pais = PaisSerializer(read_only=True)
    pais_id = serializers.PrimaryKeyRelatedField(
        source="pais",
        queryset=Pais.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )

    class Meta:
        model = Marca
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
