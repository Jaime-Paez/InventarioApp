from rest_framework import serializers

from .models import Usuario, UsuarioSucursal


class UsuarioSerializer(serializers.ModelSerializer):
    """Serializa usuarios internos."""

    class Meta:
        model = Usuario
        fields = ["id", "nombres", "apellidos", "correo", "telefono", "cargo", "activo"]


class UsuarioSucursalSerializer(serializers.ModelSerializer):
    """Serializa la asignación de usuarios a sucursales."""

    usuario_id = serializers.PrimaryKeyRelatedField(
        source="usuario",
        queryset=Usuario.objects.all(),
        write_only=True,
    )
    sucursal_id = serializers.PrimaryKeyRelatedField(
        source="sucursal",
        queryset=None,
        write_only=True,
    )
    usuario = UsuarioSerializer(read_only=True)
    sucursal = serializers.StringRelatedField(read_only=True)

    class Meta:
        model = UsuarioSucursal
        fields = [
            "id",
            "usuario",
            "usuario_id",
            "sucursal",
            "sucursal_id",
            "rol",
            "es_responsable",
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        from ubicaciones.models import Sucursal

        self.fields["sucursal_id"].queryset = Sucursal.objects.all()
