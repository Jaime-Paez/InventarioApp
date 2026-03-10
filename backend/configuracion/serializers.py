from rest_framework import serializers

from usuarios.models import RolPermiso

from .models import ConfiguracionSistema


def _can_manage_random_inspection_items(user):
    if user is None or not getattr(user, "is_authenticated", False):
        return False
    if getattr(user, "is_staff", False) or getattr(user, "is_superuser", False):
        return True
    return user.roles.filter(
        permisos__modulo=RolPermiso.Modulos.USUARIOS,
        permisos__puede_actualizar=True,
    ).exists()


class ConfiguracionSistemaSerializer(serializers.ModelSerializer):
    def validate(self, attrs):
        attrs = super().validate(attrs)
        if "random_inspection_items_per_day" not in attrs:
            return attrs

        request = self.context.get("request")
        if request is None:
            return attrs
        if _can_manage_random_inspection_items(getattr(request, "user", None)):
            return attrs

        raise serializers.ValidationError(
            {
                "random_inspection_items_per_day": (
                    "Solo un administrador puede cambiar esta configuracion."
                )
            }
        )

    class Meta:
        model = ConfiguracionSistema
        fields = [
            "id",
            "iva_rate",
            "random_inspection_items_per_day",
            "actualizado_en",
        ]
        read_only_fields = ["id", "actualizado_en"]
