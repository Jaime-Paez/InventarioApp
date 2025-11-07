from rest_framework import serializers

from usuarios.models import Usuario


class UsuarioSerializer(serializers.ModelSerializer):
    sucursal_nombre = serializers.CharField(source="sucursal.nombre", read_only=True)

    class Meta:
        model = Usuario
        fields = [
            "id",
            "nombre",
            "email",
            "telefono",
            "rol",
            "sucursal",
            "sucursal_nombre",
            "activo",
        ]
