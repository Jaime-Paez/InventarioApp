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
from .utils import (
    ADMIN_ONLY_MODULES,
    build_permissions_summary,
    build_sucursal_scope_summary,
    get_random_inspection_branch_ids,
    get_personalized_role_for_email,
    is_app_admin,
    sync_random_inspection_assignment,
)


User = get_user_model()


def _normalize_submodule(value):
    return value or ""


SCOPE_ACTION_KEYS = (
    "puede_crear",
    "puede_leer",
    "puede_actualizar",
    "puede_eliminar",
)


def normalize_scope_action_flags(source):
    flags = {key: bool(source.get(key)) for key in SCOPE_ACTION_KEYS}

    if flags["puede_eliminar"]:
        flags["puede_crear"] = True
        flags["puede_actualizar"] = True

    if flags["puede_crear"] or flags["puede_actualizar"] or flags["puede_eliminar"]:
        flags["puede_leer"] = True

    if not flags["puede_leer"]:
        flags["puede_crear"] = False
        flags["puede_actualizar"] = False
        flags["puede_eliminar"] = False

    return flags


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


def _is_admin_only_module(module_key):
    return str(module_key or "").strip() in ADMIN_ONLY_MODULES


def _filter_admin_only_permissions(permisos):
    return [
        permiso
        for permiso in permisos or []
        if not _is_admin_only_module(permiso.get("modulo"))
    ]


def _filter_admin_only_scopes(scopes):
    return [
        scope
        for scope in scopes or []
        if not _is_admin_only_module(scope.get("modulo"))
    ]


def _filter_admin_only_summary(permisos):
    return [
        permiso
        for permiso in permisos or []
        if not _is_admin_only_module(permiso.get("modulo"))
    ]


def build_sucursal_scope_payload(scopes):
    grouped = {}
    for scope in scopes:
        modulo = str(getattr(scope, "modulo", "") or "").strip()
        if not modulo:
            continue

        branch_id = getattr(scope, "sucursal_id", None)
        if branch_id is None:
            continue

        branch_id = int(branch_id)
        normalized_flags = normalize_scope_action_flags(
            {
                "puede_crear": getattr(scope, "puede_crear", False),
                "puede_leer": getattr(scope, "puede_leer", False),
                "puede_actualizar": getattr(scope, "puede_actualizar", False),
                "puede_eliminar": getattr(scope, "puede_eliminar", False),
            }
        )
        if not any(normalized_flags.values()):
            continue

        normalized_flags["puede_crear_compra_local"] = bool(
            getattr(scope, "puede_crear_compra_local", False)
        )
        normalized_flags["puede_crear_importacion"] = bool(
            getattr(scope, "puede_crear_importacion", False)
        )

        grouped.setdefault(modulo, {})
        grouped[modulo][branch_id] = normalized_flags

    payload = []
    for modulo, action_by_branch in grouped.items():
        branch_ids = sorted(action_by_branch.keys())
        payload.append(
            {
                "modulo": modulo,
                "sucursales_ids": branch_ids,
                "acciones_por_sucursal": [
                    {"sucursal_id": branch_id, **action_by_branch[branch_id]}
                    for branch_id in branch_ids
                ],
            }
        )

    return payload


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


class ModuloSucursalActionSerializer(serializers.Serializer):
    sucursal_id = serializers.PrimaryKeyRelatedField(queryset=Sucursal.objects.all())
    puede_crear = serializers.BooleanField(required=False, default=False)
    puede_leer = serializers.BooleanField(required=False, default=False)
    puede_actualizar = serializers.BooleanField(required=False, default=False)
    puede_eliminar = serializers.BooleanField(required=False, default=False)
    puede_crear_compra_local = serializers.BooleanField(required=False, default=False)
    puede_crear_importacion = serializers.BooleanField(required=False, default=False)

    def validate(self, attrs):
        flags = normalize_scope_action_flags(attrs)
        if not flags.get("puede_crear"):
            flags["puede_crear_compra_local"] = False
            flags["puede_crear_importacion"] = False
        else:
            flags["puede_crear_compra_local"] = bool(attrs.get("puede_crear_compra_local", False))
            flags["puede_crear_importacion"] = bool(attrs.get("puede_crear_importacion", False))
        return {
            "sucursal_id": attrs["sucursal_id"],
            **flags,
        }


class ModuloSucursalScopeSerializer(serializers.Serializer):
    modulo = serializers.ChoiceField(choices=MODULOS_CON_ALCANCE_SUCURSAL)
    sucursales_ids = serializers.PrimaryKeyRelatedField(
        many=True,
        queryset=Sucursal.objects.all(),
        required=False,
    )
    acciones_por_sucursal = ModuloSucursalActionSerializer(many=True, required=False)

    def validate(self, attrs):
        acciones_por_sucursal = attrs.get("acciones_por_sucursal") or []
        sucursales_ids = attrs.get("sucursales_ids") or []

        if acciones_por_sucursal:
            by_branch = {}
            for scope_item in acciones_por_sucursal:
                branch_id = int(scope_item["sucursal_id"].id)
                if branch_id in by_branch:
                    raise serializers.ValidationError(
                        {
                            "acciones_por_sucursal": (
                                "No se puede repetir la misma sucursal dentro del "
                                "mismo modulo."
                            )
                        }
                    )
                by_branch[branch_id] = scope_item

            attrs["acciones_por_sucursal"] = list(by_branch.values())
            attrs["sucursales_ids"] = [entry["sucursal_id"] for entry in attrs["acciones_por_sucursal"]]
            return attrs

        if sucursales_ids:
            attrs["sucursales_ids"] = list(
                {int(sucursal.id): sucursal for sucursal in sucursales_ids}.values()
            )

        return attrs


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
    es_administrador = serializers.SerializerMethodField()
    telefono = serializers.CharField(required=False, allow_blank=True, write_only=True)
    cargo = serializers.CharField(required=False, allow_blank=True, write_only=True)
    inspeccion_aleatoria = serializers.BooleanField(
        required=False,
        write_only=True,
    )

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
            "inspeccion_aleatoria",
            "activo",
            "es_administrador",
            "roles",
            "sucursales",
            "sucursales_por_modulo",
            "permisos_personalizados",
            "permisos_resumen",
            "password",
        ]
        extra_kwargs = {"password": {"write_only": True}}

    def get_es_administrador(self, obj):
        return is_app_admin(obj)

    def to_internal_value(self, data):
        es_admin_raw = data.get("es_administrador")
        result = super().to_internal_value(data)
        if "es_administrador" in data:
            result["es_administrador"] = bool(es_admin_raw)
        return result

    def _set_es_administrador(self, user, es_administrador):
        from app.models import UsuarioPreferencia
        pref, _ = UsuarioPreferencia.objects.get_or_create(usuario=user)
        pref.es_administrador = bool(es_administrador)
        pref.save(update_fields=["es_administrador"])

    def create(self, validated_data):
        permisos_personalizados = validated_data.pop("permisos_personalizados", None)
        roles = validated_data.pop("roles", [])
        password = validated_data.pop("password", None)
        sucursales_por_modulo = validated_data.pop("sucursales_por_modulo", None)
        inspeccion_aleatoria = bool(validated_data.pop("inspeccion_aleatoria", False))
        es_administrador = bool(validated_data.pop("es_administrador", False))
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

            self._set_es_administrador(user, es_administrador)
            sync_random_inspection_assignment(user, inspeccion_aleatoria)
            if es_administrador:
                self._sync_personalized_permissions(user, [])
                self._sync_sucursales_por_modulo(user, [])
            else:
                self._sync_personalized_permissions(user, permisos_personalizados)
                self._sync_sucursales_por_modulo(user, sucursales_por_modulo)
        return user

    def update(self, instance, validated_data):
        permisos_personalizados = validated_data.pop("permisos_personalizados", None)
        roles = validated_data.pop("roles", None)
        password = validated_data.pop("password", None)
        sucursales_por_modulo = validated_data.pop("sucursales_por_modulo", None)
        inspeccion_aleatoria = validated_data.pop("inspeccion_aleatoria", None)
        es_administrador = validated_data.pop("es_administrador", None)
        validated_data.pop("telefono", None)
        validated_data.pop("cargo", None)

        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        if "email" in validated_data:
            instance.username = (validated_data.get("email") or "").strip().lower()
        instance.save()

        if roles is not None:
            instance.roles.set(roles)

        if inspeccion_aleatoria is not None:
            sync_random_inspection_assignment(instance, bool(inspeccion_aleatoria))

        if es_administrador is not None:
            self._set_es_administrador(instance, es_administrador)

        admin_flag = es_administrador if es_administrador is not None else is_app_admin(instance)
        if admin_flag:
            self._sync_personalized_permissions(instance, [])
            self._sync_sucursales_por_modulo(instance, [])
        else:
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
        filtered = _filter_admin_only_permissions(value)
        return validate_permissions_uniqueness(filtered)

    def validate_sucursales_por_modulo(self, value):
        filtered = _filter_admin_only_scopes(value)
        return validate_scope_modules_uniqueness(filtered)

    def _sync_personalized_permissions(self, usuario, permisos_data):
        """Crea o actualiza el rol personalizado asociado al usuario."""

        if permisos_data is None:
            return

        filtered_permissions = _filter_admin_only_permissions(permisos_data)
        if not filtered_permissions:
            self._remove_personalized_role(usuario)
            return

        role = get_personalized_role_for_email(usuario.email, create=True)
        created_role = False

        if role and not role.permisos.exists():
            created_role = True

        self._replace_permissions(role, filtered_permissions)
        if created_role:
            usuario.refresh_from_db()

    def _replace_permissions(self, rol, permisos_data):
        rol.permisos.all().delete()
        permisos_instances = []
        for permiso in _filter_admin_only_permissions(permisos_data):
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
        for scope in _filter_admin_only_scopes(scopes_data):
            modulo = scope.get("modulo")
            if not modulo:
                continue

            acciones_por_sucursal = scope.get("acciones_por_sucursal") or []
            action_map = {}
            for action_scope in acciones_por_sucursal:
                sucursal_obj = action_scope.get("sucursal_id")
                if sucursal_obj is None:
                    continue

                branch_id = int(sucursal_obj.id if isinstance(sucursal_obj, Sucursal) else sucursal_obj)
                flags = normalize_scope_action_flags(action_scope)
                if not any(flags.values()):
                    continue
                if not flags.get("puede_crear"):
                    flags["puede_crear_compra_local"] = False
                    flags["puede_crear_importacion"] = False
                else:
                    flags["puede_crear_compra_local"] = bool(action_scope.get("puede_crear_compra_local", False))
                    flags["puede_crear_importacion"] = bool(action_scope.get("puede_crear_importacion", False))
                action_map[branch_id] = flags

            if action_map:
                for sucursal_id, flags in action_map.items():
                    instances.append(
                        UsuarioModuloSucursal(
                            usuario=usuario,
                            modulo=modulo,
                            sucursal_id=sucursal_id,
                            **flags,
                        )
                    )
                continue

            sucursales = scope.get("sucursales_ids") or []
            unique_ids = {int(sucursal.id) for sucursal in sucursales}
            for sucursal_id in unique_ids:
                instances.append(
                    UsuarioModuloSucursal(
                        usuario=usuario,
                        modulo=modulo,
                        sucursal_id=sucursal_id,
                        puede_crear=True,
                        puede_leer=True,
                        puede_actualizar=True,
                        puede_eliminar=True,
                    )
                )

        if instances:
            UsuarioModuloSucursal.objects.bulk_create(instances)

    def get_permisos_resumen(self, obj):
        summary = build_permissions_summary(
            obj.roles.all(),
            extra_roles=[get_personalized_role_for_email(obj.email)],
        )
        if is_app_admin(obj):
            return summary
        return _filter_admin_only_summary(summary)

    def to_representation(self, instance):
        data = super().to_representation(instance)
        role = get_personalized_role_for_email(instance.email)
        if role:
            data["permisos_personalizados"] = RolPermisoSerializer(
                role.permisos.exclude(modulo__in=ADMIN_ONLY_MODULES), many=True
            ).data
        else:
            data["permisos_personalizados"] = []

        data["sucursales"] = self.get_sucursales(instance)
        data["sucursales_por_modulo"] = self.get_sucursales_por_modulo(instance)
        data["inspeccion_aleatoria"] = self.get_inspeccion_aleatoria(instance)
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
        return build_sucursal_scope_payload(
            obj.alcances_sucursal.exclude(modulo__in=ADMIN_ONLY_MODULES).all()
        )

    def get_inspeccion_aleatoria(self, obj):
        return bool(get_random_inspection_branch_ids(obj))


class UsuarioDestinatarioSerializer(serializers.ModelSerializer):
    """Serializa datos mínimos de usuarios para selección de destinatarios."""

    nombres = serializers.CharField(source="first_name", read_only=True)
    apellidos = serializers.CharField(source="last_name", read_only=True)
    correo = serializers.EmailField(source="email", read_only=True)
    activo = serializers.BooleanField(source="is_active", read_only=True)
    es_administrador = serializers.SerializerMethodField()
    permisos_resumen = serializers.SerializerMethodField()
    sucursales = serializers.SerializerMethodField()
    sucursales_por_modulo = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id",
            "nombres",
            "apellidos",
            "correo",
            "activo",
            "es_administrador",
            "permisos_resumen",
            "sucursales",
            "sucursales_por_modulo",
        ]

    def get_es_administrador(self, obj):
        return is_app_admin(obj)

    def get_permisos_resumen(self, obj):
        summary = build_permissions_summary(
            obj.roles.all(),
            extra_roles=[get_personalized_role_for_email(obj.email)],
        )
        if is_app_admin(obj):
            return summary
        return _filter_admin_only_summary(summary)

    def get_sucursales(self, obj):
        asignaciones = obj.asignaciones.select_related("sucursal").all()
        return [
            {"id": asignacion.sucursal.id, "nombre": asignacion.sucursal.nombre}
            for asignacion in asignaciones
        ]

    def get_sucursales_por_modulo(self, obj):
        return build_sucursal_scope_payload(
            obj.alcances_sucursal.exclude(modulo__in=ADMIN_ONLY_MODULES).all()
        )


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
    es_administrador = serializers.SerializerMethodField()
    sucursales_por_modulo = serializers.SerializerMethodField()

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
            "es_administrador",
            "sucursales_por_modulo",
        ]

    def get_es_administrador(self, obj):
        return is_app_admin(obj)

    def get_sucursales_por_modulo(self, obj):
        if is_app_admin(obj):
            return None
        return build_sucursal_scope_summary(obj)


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
