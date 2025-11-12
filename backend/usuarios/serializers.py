from rest_framework import serializers

from inventario.models import Sucursal

from .models import Rol, RolPermiso, Usuario, UsuarioSucursal


class RolPermisoSerializer(serializers.ModelSerializer):
    """Serializa los permisos de un rol por módulo."""

    modulo_display = serializers.CharField(
        source="get_modulo_display", read_only=True
    )

    class Meta:
        model = RolPermiso
        fields = [
            "id",
            "modulo",
            "modulo_display",
            "puede_crear",
            "puede_leer",
            "puede_actualizar",
            "puede_eliminar",
        ]


class RolSerializer(serializers.ModelSerializer):
    """Serializa roles y sus permisos asociados."""

    permisos = RolPermisoSerializer(many=True, required=False)

    class Meta:
        model = Rol
        fields = ["id", "nombre", "descripcion", "activo", "permisos"]

    def create(self, validated_data):
        permisos_data = validated_data.pop("permisos", [])
        rol = Rol.objects.create(**validated_data)
        self._replace_permissions(rol, permisos_data)
        return rol

    def update(self, instance, validated_data):
        permisos_data = validated_data.pop("permisos", None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        if permisos_data is not None:
            self._replace_permissions(instance, permisos_data)

        return instance

    def _replace_permissions(self, rol, permisos_data):
        rol.permisos.all().delete()
        permisos_instances = []
        for permiso in permisos_data:
            permiso_data = permiso.copy()
            permiso_data.pop("id", None)
            permisos_instances.append(RolPermiso(rol=rol, **permiso_data))
        RolPermiso.objects.bulk_create(permisos_instances)


class UsuarioSerializer(serializers.ModelSerializer):
    """Serializa usuarios internos."""

    roles = serializers.PrimaryKeyRelatedField(
        many=True,
        queryset=Rol.objects.all(),
        required=False,
    )
    roles_detalle = RolSerializer(source="roles", many=True, read_only=True)

    class Meta:
        model = Usuario
        fields = [
            "id",
            "nombres",
            "apellidos",
            "correo",
            "telefono",
            "cargo",
            "activo",
            "roles",
            "roles_detalle",
        ]


class UsuarioSucursalSerializer(serializers.ModelSerializer):
    """Serializa la asignación de usuarios a sucursales."""

    usuario_id = serializers.PrimaryKeyRelatedField(
        source="usuario",
        queryset=Usuario.objects.all(),
        write_only=True,
    )
    sucursal_id = serializers.PrimaryKeyRelatedField(
        source="sucursal",
        queryset=Sucursal.objects.all(),
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
        self.fields["sucursal_id"].queryset = Sucursal.objects.all()
