from rest_framework import serializers

from .models import ConfiguracionSistema


class ConfiguracionSistemaSerializer(serializers.ModelSerializer):
    class Meta:
        model = ConfiguracionSistema
        fields = ["id", "iva_rate", "actualizado_en"]
        read_only_fields = ["id", "actualizado_en"]
