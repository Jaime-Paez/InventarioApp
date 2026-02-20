from django.contrib.auth import get_user_model
from django.db import transaction
from rest_framework import serializers

from inventario.models import Sucursal

from .models import (
    MODULOS_CON_ALCANCE_SUCURSAL,
    Rol,
    RolPermiso,
    UsuarioModuloSucursal,
    UsuarioSucursal,
)
from .utils import build_permissions_summary, get_personalized_role_for_email


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


def validate_scope_modules_uniqueness(scopes):
    seen = set()
    for scope in scopes:
        modulo = scope.get("modulo")
        if modulo in seen:
            raise serializers.ValidationError(
                "No se puede repetir el alcance de sucursales para el mismo modulo."
            )
        seen.add(modulo)
    return scopes


class RolPermisoSerializer(serializers.ModelSerializer):
    """Serializa los permisos de un rol por módulo."""

    modulo_display = serializers.CharField(
        source="get_modulo_display", read_only=True
    )
    submodulo = serializers.CharField(write_only=True, required=False, allow_blank=True, default="")

    class Meta:
        model = RolPermiso
        fields = [
            "id",
            "modulo",
            "modulo_display",
            "submodulo",
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


class ModuloSucursalScopeSerializer(serializers.Serializer):
    modulo = serializers.ChoiceField(choices=MODULOS_CON_ALCANCE_SUCURSAL)
    sucursales_ids = serializers.PrimaryKeyRelatedField(
        many=True,
        queryset=Sucursal.objects.all(),
        required=False,
    )


class UsuarioSerializer(serializers.ModelSerializer):
    """Serializa usuarios usando el modelo de Django."""

    permisos_personalizados = RolPermisoSerializer(many=True, required=False)
    permisos_resumen = serializers.SerializerMethodField()
    password = serializers.CharField(
        write_only=True, required=False, allow_blank=False, min_length=8
    )
    roles = serializers.PrimaryKeyRelatedField(
        many=True, queryset=Rol.objects.filter(activo=True), required=False
    )
    nombres = serializers.CharField(source="first_name")
    apellidos = serializers.CharField(source="last_name")
    correo = serializers.EmailField(source="email")
    activo = serializers.BooleanField(source="is_active", required=False)
    telefono = serializers.CharField(required=False, allow_blank=True, write_only=True)
    cargo = serializers.CharField(required=False, allow_blank=True, write_only=True)

    sucursales_por_modulo = ModuloSucursalScopeSerializer(
        many=True,
        required=False,
        write_only=True,
    )
    sucursales = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = User
        fields = [
            "id",
            "nombres",
            "apellidos",
            "correo",
            "telefono",
            "cargo",
            "activo",
            "roles",
            "sucursales",
            "sucursales_por_modulo",
            "permisos_personalizados",
            "permisos_resumen",
            "password",
        ]
        extra_kwargs = {"password": {"write_only": True}}

    def create(self, validated_data):
        permisos_personalizados = validated_data.pop("permisos_personalizados", None)
        roles = validated_data.pop("roles", [])
        password = validated_data.pop("password", None)
        sucursales_por_modulo = validated_data.pop("sucursales_por_modulo", None)
        validated_data.pop("telefono", None)
        validated_data.pop("cargo", None)

        with transaction.atomic():
            email = validated_data.get("email", "").strip().lower()
            validated_data["email"] = email
            validated_data["username"] = email
            if password:
                user = User.objects.create_user(password=password, **validated_data)
            else:
                user = User.objects.create_user(**validated_data)
                user.set_unusable_password()
                user.save(update_fields=["password"])

            if roles is not None:
                user.roles.set(roles)

            self._sync_personalized_permissions(user, permisos_personalizados)
            self._sync_sucursales_por_modulo(user, sucursales_por_modulo)
        return user

    def update(self, instance, validated_data):
        permisos_personalizados = validated_data.pop("permisos_personalizados", None)
        roles = validated_data.pop("roles", None)
        password = validated_data.pop("password", None)
        sucursales_por_modulo = validated_data.pop("sucursales_por_modulo", None)
        validated_data.pop("telefono", None)
        validated_data.pop("cargo", None)

        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        if "email" in validated_data:
            instance.username = (validated_data.get("email") or "").strip().lower()
        instance.save()

        if roles is not None:
            instance.roles.set(roles)

        self._sync_personalized_permissions(instance, permisos_personalizados)
        self._sync_sucursales_por_modulo(instance, sucursales_por_modulo)
        if password:
            instance.set_password(password)
            instance.save(update_fields=["password"])
        return instance

    def validate(self, attrs):
        if self.instance is None and not attrs.get("password"):
            raise serializers.ValidationError(
                {"password": "Debes definir una contraseña para el usuario."}
            )
        return super().validate(attrs)

    def validate_correo(self, value):
        email = value.strip().lower()
        qs = User.objects.filter(email__iexact=email)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError(
                "Ya existe una cuenta registrada con este correo."
            )
        return email

    def validate_permisos_personalizados(self, value):
        return validate_permissions_uniqueness(value)

    def validate_sucursales_por_modulo(self, value):
        return validate_scope_modules_uniqueness(value)

    def _sync_personalized_permissions(self, usuario, permisos_data):
        """Crea o actualiza el rol personalizado asociado al usuario."""

        if permisos_data is None:
            return

        if not permisos_data:
            self._remove_personalized_role(usuario)
            return

        role = get_personalized_role_for_email(usuario.email, create=True)
        created_role = False

        if role and not role.permisos.exists():
            created_role = True

        self._replace_permissions(role, permisos_data)
        if created_role:
            usuario.refresh_from_db()

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
        role = get_personalized_role_for_email(usuario.email)
        if role:
            role.permisos.all().delete()
            role.delete()

    def _sync_sucursales_por_modulo(self, usuario, scopes_data):
        if scopes_data is None:
            return

        UsuarioModuloSucursal.objects.filter(usuario=usuario).delete()

        instances = []
        for scope in scopes_data:
            modulo = scope.get("modulo")
            sucursales = scope.get("sucursales_ids") or []
            unique_ids = {int(sucursal.id) for sucursal in sucursales}
            for sucursal_id in unique_ids:
                instances.append(
                    UsuarioModuloSucursal(
                        usuario=usuario,
                        modulo=modulo,
                        sucursal_id=sucursal_id,
                    )
                )

        if instances:
            UsuarioModuloSucursal.objects.bulk_create(instances)

    def get_permisos_resumen(self, obj):
        return build_permissions_summary(
            obj.roles.all(),
            extra_roles=[get_personalized_role_for_email(obj.email)],
        )

    def to_representation(self, instance):
        data = super().to_representation(instance)
        role = get_personalized_role_for_email(instance.email)
        if role:
            data["permisos_personalizados"] = RolPermisoSerializer(
                role.permisos.all(), many=True
            ).data
        else:
            data["permisos_personalizados"] = []

        data["sucursales"] = self.get_sucursales(instance)
        data["sucursales_por_modulo"] = self.get_sucursales_por_modulo(instance)
        data.setdefault("telefono", "")
        data.setdefault("cargo", "")
        return data

    def get_sucursales(self, obj):
        asignaciones = obj.asignaciones.select_related("sucursal").all()
        return [
            {"id": asignacion.sucursal.id, "nombre": asignacion.sucursal.nombre}
            for asignacion in asignaciones
        ]

    def get_sucursales_por_modulo(self, obj):
        grouped = {}
        scopes = obj.alcances_sucursal.all()
        for scope in scopes:
            grouped.setdefault(scope.modulo, set()).add(int(scope.sucursal_id))

        return [
            {"modulo": modulo, "sucursales_ids": sorted(sucursal_ids)}
            for modulo, sucursal_ids in grouped.items()
        ]


class UsuarioSucursalSerializer(serializers.ModelSerializer):
    """Serializa la asignación de usuarios a sucursales."""

    usuario_id = serializers.PrimaryKeyRelatedField(
        source="usuario",
        queryset=User.objects.all(),
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
