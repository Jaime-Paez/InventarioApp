from django.contrib.auth import get_user_model
from django.db import transaction
from rest_framework import serializers

from inventario.models import Sucursal

from .models import Rol, RolPermiso, UsuarioPerfil, UsuarioSucursal
from .utils import build_permissions_summary, ensure_personalized_role


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


class UsuarioSerializer(serializers.ModelSerializer):
    """Serializa usuarios autenticados."""

    codigo = serializers.SerializerMethodField()
    nombres = serializers.CharField(source="first_name")
    apellidos = serializers.CharField(source="last_name")
    correo = serializers.EmailField(source="email")
    activo = serializers.BooleanField(source="is_active", required=False)
    telefono = serializers.CharField(
        source="perfil.telefono", required=False, allow_blank=True
    )
    cargo = serializers.CharField(
        source="perfil.cargo", required=False, allow_blank=True
    )
    permisos_personalizados = RolPermisoSerializer(many=True, required=False)
    permisos_resumen = serializers.SerializerMethodField()
    password = serializers.CharField(
        write_only=True, required=False, allow_blank=False, min_length=8
    )
    roles = serializers.PrimaryKeyRelatedField(
        many=True, queryset=Rol.objects.filter(activo=True), required=False
    )

    sucursales_ids = serializers.PrimaryKeyRelatedField(
        many=True,
        queryset=Sucursal.objects.all(),
        required=False,
        write_only=True,
    )
    sucursales = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = User
        fields = [
            "id",
            "codigo",
            "nombres",
            "apellidos",
            "correo",
            "telefono",
            "cargo",
            "activo",
            "roles",
            "sucursales",
            "sucursales_ids",
            "permisos_personalizados",
            "permisos_resumen",
            "password",
        ]
        extra_kwargs = {"password": {"write_only": True}}

    def create(self, validated_data):
        permisos_personalizados = validated_data.pop("permisos_personalizados", None)
        roles = validated_data.pop("roles", [])
        password = validated_data.pop("password", None)
        sucursales = validated_data.pop("sucursales_ids", None)
        perfil_data = validated_data.pop("perfil", {})
        email = validated_data.get("email", "").strip().lower()
        if email:
            validated_data["email"] = email
            validated_data.setdefault("username", email)

        with transaction.atomic():
            usuario = User.objects.create(**validated_data)
            if password:
                usuario.set_password(password)
                usuario.save(update_fields=["password"])
            if roles is not None:
                usuario.roles.set(roles)

            perfil = self._sync_profile(usuario, perfil_data)
            self._sync_personalized_permissions(usuario, perfil, permisos_personalizados)
            self._sync_sucursales(usuario, sucursales)
        return usuario

    def update(self, instance, validated_data):
        permisos_personalizados = validated_data.pop("permisos_personalizados", None)
        roles = validated_data.pop("roles", None)
        password = validated_data.pop("password", None)
        sucursales = validated_data.pop("sucursales_ids", None)
        perfil_data = validated_data.pop("perfil", {})
        email = validated_data.get("email")

        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        if email and instance.username != email:
            instance.username = email
        instance.save()

        if roles is not None:
            instance.roles.set(roles)

        perfil = self._sync_profile(instance, perfil_data)
        self._sync_personalized_permissions(instance, perfil, permisos_personalizados)
        self._sync_sucursales(instance, sucursales)
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

    def get_codigo(self, obj):
        return obj.id

    def validate_permisos_personalizados(self, value):
        return validate_permissions_uniqueness(value)

    def _sync_profile(self, usuario, perfil_data):
        perfil, _ = UsuarioPerfil.objects.get_or_create(usuario=usuario)
        if perfil_data:
            telefono = perfil_data.get("telefono", perfil.telefono)
            cargo = perfil_data.get("cargo", perfil.cargo)
            updates = []
            if telefono != perfil.telefono:
                perfil.telefono = telefono
                updates.append("telefono")
            if cargo != perfil.cargo:
                perfil.cargo = cargo
                updates.append("cargo")
            if updates:
                perfil.save(update_fields=updates)
        return perfil

    def _sync_personalized_permissions(self, usuario, perfil, permisos_data):
        """Crea o actualiza el rol personalizado asociado al usuario."""

        if permisos_data is None:
            return

        if not permisos_data:
            self._remove_personalized_role(perfil)
            return

        role = ensure_personalized_role(usuario)
        self._replace_permissions(role, permisos_data)

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

    def _remove_personalized_role(self, perfil):
        if perfil and perfil.rol_personalizado:
            perfil.rol_personalizado.permisos.all().delete()
            perfil.rol_personalizado.delete()
            perfil.rol_personalizado = None
            perfil.save(update_fields=["rol_personalizado"])

    def _sync_sucursales(self, usuario, sucursales):
        """Crea o elimina las asignaciones de sucursales para el usuario."""

        if sucursales is None:
            return

        target_ids = set(str(sucursal.id) for sucursal in sucursales)
        current_ids = set(
            str(sucursal_id)
            for sucursal_id in usuario.asignaciones.values_list("sucursal_id", flat=True)
        )

        # Remover asignaciones que ya no aplican
        remove_ids = current_ids - target_ids
        if remove_ids:
            UsuarioSucursal.objects.filter(usuario=usuario, sucursal_id__in=remove_ids).delete()

        # Crear nuevas asignaciones
        create_ids = target_ids - current_ids
        UsuarioSucursal.objects.bulk_create(
            [
                UsuarioSucursal(usuario=usuario, sucursal_id=sucursal_id)
                for sucursal_id in create_ids
            ]
        )

    def get_permisos_resumen(self, obj):
        return build_permissions_summary(
            obj.roles.all(),
            extra_roles=[
                getattr(obj.perfil, "rol_personalizado", None)
                if hasattr(obj, "perfil")
                else None
            ],
        )

    def to_representation(self, instance):
        data = super().to_representation(instance)
        perfil = getattr(instance, "perfil", None)
        if perfil and perfil.rol_personalizado:
            data["permisos_personalizados"] = RolPermisoSerializer(
                perfil.rol_personalizado.permisos.all(), many=True
            ).data
        else:
            data["permisos_personalizados"] = []

        data["sucursales"] = self.get_sucursales(instance)
        return data

    def get_sucursales(self, obj):
        asignaciones = obj.asignaciones.select_related("sucursal").all()
        return [
            {"id": asignacion.sucursal.id, "nombre": asignacion.sucursal.nombre}
            for asignacion in asignaciones
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
