from django.contrib.auth import get_user_model
from rest_framework import serializers

from inventario.models import Sucursal

from .models import Rol, RolPermiso, Usuario, UsuarioSucursal


User = get_user_model()


def _normalize_submodule(value):
    return value or ""


def validate_permissions_uniqueness(permisos):
    combos = set()
    for permiso in permisos:
        modulo = permiso.get("modulo")
        submodulo = _normalize_submodule(permiso.get("submodulo"))
        key = (modulo, submodulo)
        if key in combos:
            raise serializers.ValidationError(
                "No se pueden repetir permisos con el mismo módulo y submódulo."
            )
        combos.add(key)
    return permisos


def build_permissions_summary(roles, extra_roles=None):
    """Agrupa los permisos de una colección de roles en una lista consolidada."""

    roles_to_process = list(roles) + [r for r in extra_roles or [] if r]
    summary = {}

    for role in roles_to_process:
        for permiso in role.permisos.all():
            key = (permiso.modulo, _normalize_submodule(permiso.submodulo))
            if key not in summary:
                summary[key] = {
                    "modulo": permiso.modulo,
                    "submodulo": _normalize_submodule(permiso.submodulo),
                    "puede_crear": False,
                    "puede_leer": False,
                    "puede_actualizar": False,
                    "puede_eliminar": False,
                }

            summary[key]["puede_crear"] = (
                summary[key]["puede_crear"] or permiso.puede_crear
            )
            summary[key]["puede_leer"] = summary[key]["puede_leer"] or permiso.puede_leer
            summary[key]["puede_actualizar"] = (
                summary[key]["puede_actualizar"] or permiso.puede_actualizar
            )
            summary[key]["puede_eliminar"] = (
                summary[key]["puede_eliminar"] or permiso.puede_eliminar
            )

    return [
        value
        for value in summary.values()
        if value["puede_crear"]
        or value["puede_leer"]
        or value["puede_actualizar"]
        or value["puede_eliminar"]
    ]


class RolPermisoSerializer(serializers.ModelSerializer):
    """Serializa los permisos de un rol por módulo."""

    modulo_display = serializers.CharField(
        source="get_modulo_display", read_only=True
    )
    submodulo_display = serializers.CharField(
        source="get_submodulo_display", read_only=True
    )

    class Meta:
        model = RolPermiso
        fields = [
            "id",
            "modulo",
            "modulo_display",
            "submodulo",
            "submodulo_display",
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
        fields = [
            "id",
            "nombre",
            "descripcion",
            "activo",
            "es_personalizado",
            "permisos",
        ]
        read_only_fields = ["es_personalizado"]

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
            submodulo = _normalize_submodule(permiso_data.get("submodulo"))
            permiso_instance = RolPermiso(
                rol=rol,
                submodulo=submodulo,
                **{k: v for k, v in permiso_data.items() if k != "submodulo"},
            )
            permiso_instance.full_clean()
            permisos_instances.append(permiso_instance)
        RolPermiso.objects.bulk_create(permisos_instances)

    def validate_permisos(self, value):
        return validate_permissions_uniqueness(value)


class UsuarioSerializer(serializers.ModelSerializer):
    """Serializa usuarios internos."""

    permisos_personalizados = RolPermisoSerializer(many=True, required=False)
    permisos_resumen = serializers.SerializerMethodField()

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
            "permisos_personalizados",
            "permisos_resumen",
        ]

    def create(self, validated_data):
        permisos_personalizados = validated_data.pop("permisos_personalizados", None)
        usuario = Usuario.objects.create(**validated_data)

        self._sync_personalized_permissions(usuario, permisos_personalizados)
        return usuario

    def update(self, instance, validated_data):
        permisos_personalizados = validated_data.pop("permisos_personalizados", None)

        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        self._sync_personalized_permissions(instance, permisos_personalizados)
        return instance

    def validate_permisos_personalizados(self, value):
        return validate_permissions_uniqueness(value)

    def _sync_personalized_permissions(self, usuario, permisos_data):
        """Crea o actualiza el rol personalizado asociado al usuario."""

        if permisos_data is None:
            return

        if not permisos_data:
            self._remove_personalized_role(usuario)
            return

        role = usuario.rol_personalizado
        created_role = False
        if role is None:
            role = Rol.objects.create(
                nombre=f"Permisos - {usuario.correo}",
                descripcion="Permisos personalizados del usuario",
                activo=True,
                es_personalizado=True,
            )
            usuario.rol_personalizado = role
            usuario.save(update_fields=["rol_personalizado"])
            created_role = True

        self._replace_permissions(role, permisos_data)
        if created_role:
            usuario.refresh_from_db(fields=["rol_personalizado"])

    def _replace_permissions(self, rol, permisos_data):
        rol.permisos.all().delete()
        permisos_instances = []
        for permiso in permisos_data:
            permiso_data = permiso.copy()
            permiso_data.pop("id", None)
            submodulo = _normalize_submodule(permiso_data.get("submodulo"))
            permiso_instance = RolPermiso(
                rol=rol,
                submodulo=submodulo,
                **{k: v for k, v in permiso_data.items() if k != "submodulo"},
            )
            permiso_instance.full_clean()
            permisos_instances.append(permiso_instance)

        RolPermiso.objects.bulk_create(permisos_instances)

    def _remove_personalized_role(self, usuario):
        if usuario.rol_personalizado:
            usuario.rol_personalizado.permisos.all().delete()
            usuario.rol_personalizado.delete()
            usuario.rol_personalizado = None
            usuario.save(update_fields=["rol_personalizado"])

    def get_permisos_resumen(self, obj):
        return build_permissions_summary(
            obj.roles.all(),
            extra_roles=[obj.rol_personalizado],
        )

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if instance.rol_personalizado:
            data["permisos_personalizados"] = RolPermisoSerializer(
                instance.rol_personalizado.permisos.all(), many=True
            ).data
        else:
            data["permisos_personalizados"] = []
        return data


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


class AuthUserSerializer(serializers.ModelSerializer):
    """Serializa la información básica de un usuario autenticado."""

    nombre = serializers.CharField(source="first_name", read_only=True)
    apellido = serializers.CharField(source="last_name", read_only=True)

    class Meta:
        model = User
        fields = [
            "id",
            "username",
            "first_name",
            "last_name",
            "email",
            "nombre",
            "apellido",
        ]


class RegistroSerializer(serializers.Serializer):
    """Valida los datos para crear una nueva cuenta interna."""

    first_name = serializers.CharField(max_length=150)
    last_name = serializers.CharField(max_length=150)
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, min_length=8)

    def validate_email(self, value):
        if User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError(
                "Ya existe una cuenta registrada con este correo."
            )
        return value

    def create(self, validated_data):
        email = validated_data["email"].lower()
        username = email
        return User.objects.create_user(
            username=username,
            email=email,
            first_name=validated_data.get("first_name", ""),
            last_name=validated_data.get("last_name", ""),
            password=validated_data["password"],
        )


class LoginSerializer(serializers.Serializer):
    """Valida las credenciales de acceso."""

    email = serializers.EmailField()
    password = serializers.CharField(write_only=True)
