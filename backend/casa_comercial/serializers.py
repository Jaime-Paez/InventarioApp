from rest_framework import serializers

from .models import CasaComercial
from tipos.models import Pais
from tipos.serializers import PaisSerializer

CODIGO_LOCAL = "CL"
CODIGO_LOCAL_ORIGINAL = "CLO"


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
            "tipo",
            "descripcion",
            "telefono",
            "correo",
            "pais",
            "pais_id",
            "dias_entrega",
            "es_original",
        ]
        extra_kwargs = {
            "codigo": {"required": False, "allow_blank": True},
        }

    def validate(self, attrs):
        instance = self.instance
        tipo = attrs.get("tipo", getattr(instance, "tipo", CasaComercial.TIPO_LOCAL))
        es_original = attrs.get("es_original", getattr(instance, "es_original", False))

        if tipo == CasaComercial.TIPO_LOCAL:
            # Las casas locales no tienen un codigo propio: usan uno fijo segun
            # si venden repuestos originales o no, y pueden repetirse entre si.
            attrs["codigo"] = CODIGO_LOCAL_ORIGINAL if es_original else CODIGO_LOCAL
            return attrs

        codigo = str(
            attrs.get("codigo", getattr(instance, "codigo", "")) or ""
        ).strip().upper()
        if not codigo:
            raise serializers.ValidationError({"codigo": "El código no puede estar vacío."})

        duplicate = CasaComercial.objects.filter(codigo__iexact=codigo)
        if instance is not None:
            duplicate = duplicate.exclude(pk=instance.pk)
        if duplicate.exists():
            raise serializers.ValidationError(
                {"codigo": "Ya existe una casa comercial con este código."}
            )

        attrs["codigo"] = codigo
        return attrs
