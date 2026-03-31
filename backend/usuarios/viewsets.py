from django.contrib.auth import authenticate, get_user_model
from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from django.db.models import Q
from inventario.models import Sucursal
from rest_framework import filters, status, viewsets
from rest_framework.authtoken.models import Token
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from auditoria.models import RegistroAuditoria

from .models import Rol, RolPermiso, UsuarioSucursal
from .permissions import UsuariosModulePermission
from .serializers import (
    AuthUserSerializer,
    LoginSerializer,
    RegistroSerializer,
    RolSerializer,
    UsuarioDestinatarioSerializer,
    UsuarioSerializer,
    UsuarioSucursalSerializer,
)
from .utils import (
    ADMIN_ONLY_MODULES,
    build_full_permissions,
    build_permissions_summary,
    get_modulos_con_alcance_sucursal_options,
    get_permisos_efectivos,
    get_random_inspection_branch_ids,
    get_usuario_interno_por_correo,
    normalize_random_inspection_branch_ids,
    remove_personalized_role_for_email,
    sync_random_inspection_branch_assignment,
    user_has_module_action,
)


class RolViewSet(viewsets.ModelViewSet):
    """Gestión de roles y permisos."""

    queryset = (
        Rol.objects.prefetch_related("permisos")
        .filter(es_personalizado=False)
        .order_by("-id")
    )
    serializer_class = RolSerializer
    permission_classes = [IsAuthenticated, UsuariosModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class UsuarioViewSet(viewsets.ModelViewSet):
    """Gestión de usuarios usando el modelo de Django."""

    queryset = (
        get_user_model()
        .objects.select_related("preferencia_operativa")
        .prefetch_related(
            "roles__permisos",
            "asignaciones__sucursal",
            "alcances_sucursal__sucursal",
        )
        .all()
        .order_by("-date_joined", "-id")
    )
    serializer_class = UsuarioSerializer
    permission_classes = [IsAuthenticated, UsuariosModulePermission]
    pagination_class = None
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["first_name", "last_name", "email", "roles__nombre"]
    ordering_fields = ["last_name", "first_name", "email"]

    @staticmethod
    def _parse_bool_payload(value):
        if isinstance(value, bool):
            return value
        normalized = str(value or "").strip().lower()
        if normalized in {"true", "1", "si", "sí", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
        raise ValueError("Debes enviar un valor booleano valido.")

    @staticmethod
    def _format_display_name(instance):
        full_name = str(instance.get_full_name() or "").strip()
        if full_name:
            return full_name
        first_name = str(instance.first_name or "").strip()
        if first_name:
            return first_name
        email = str(instance.email or "").strip()
        return email or f"Usuario {instance.pk}"

    def _serialize_random_inspection_assignment(self, instance):
        inspection_branch_ids = get_random_inspection_branch_ids(instance)
        return {
            "id": int(instance.id),
            "nombres": str(instance.first_name or "").strip(),
            "apellidos": str(instance.last_name or "").strip(),
            "nombre_completo": self._format_display_name(instance),
            "correo": str(instance.email or "").strip(),
            "activo": bool(instance.is_active),
            "es_administrador": bool(instance.is_staff or instance.is_superuser),
            "inspeccion_aleatoria": bool(inspection_branch_ids),
            "inspeccion_aleatoria_sucursales": inspection_branch_ids,
            "puede_ver_inventario": user_has_module_action(
                instance,
                RolPermiso.Modulos.INVENTARIO,
                action_key="puede_leer",
            ),
        }

    @staticmethod
    def _is_protected_admin_user(instance):
        first_name = str(instance.first_name or "").strip().lower()
        last_name = str(instance.last_name or "").strip().lower()
        email = str(instance.email or "").strip().lower()
        username = str(instance.username or "").strip().lower()

        return (
            (first_name == "administrador" and last_name == "administrador")
            or email == "administrador@mail.com"
            or username == "administrador@mail.com"
        )

    @staticmethod
    def _usuario_tiene_registros_auditoria(instance):
        content_type = ContentType.objects.get_for_model(instance)
        return RegistroAuditoria.objects.filter(
            Q(usuario=instance)
            | Q(
                content_type=content_type,
                object_id=str(instance.pk),
            ),
        ).exists()

    @transaction.atomic
    def perform_destroy(self, instance):
        if self._is_protected_admin_user(instance):
            raise PermissionDenied("No se puede eliminar el usuario Administrador.")
        if self._usuario_tiene_registros_auditoria(instance):
            raise PermissionDenied(
                "No se puede eliminar un usuario que tenga registros en auditoría."
            )
        email = instance.email
        instance.delete()
        remove_personalized_role_for_email(email)

    @action(detail=True, methods=["get"], url_path="permisos-resumen")
    def permisos_resumen(self, request, pk=None):
        usuario = self.get_object()
        permisos = get_permisos_efectivos(usuario, usuario.email)
        return Response({"permisos": permisos})

    @action(
        detail=False,
        methods=["get"],
        url_path="inspeccion-aleatoria-asignaciones",
    )
    def inspeccion_aleatoria_asignaciones(self, request):
        search_term = str(request.query_params.get("search") or "").strip()
        queryset = self.get_queryset()
        if search_term:
            queryset = queryset.filter(
                Q(first_name__icontains=search_term)
                | Q(last_name__icontains=search_term)
                | Q(email__icontains=search_term)
            )

        queryset = queryset.order_by("is_active", "first_name", "last_name", "email")

        # Evaluate queryset once — prefetches roles__permisos and preferencia_operativa
        users = list(queryset)

        # 1 query for branches (reused for validation and response)
        branch_options = list(Sucursal.objects.order_by("nombre", "id").values("id", "nombre"))
        valid_branch_ids = frozenset(b["id"] for b in branch_options)

        # 1 query for all personalized roles (instead of 1 per user)
        user_emails_lower = [str(u.email or "").strip().lower() for u in users if u.email]
        role_names = [f"Permisos - {e}" for e in user_emails_lower]
        personalized_role_map = {
            str(r.nombre or "")[len("Permisos - "):].strip().lower(): r
            for r in Rol.objects.filter(es_personalizado=True, nombre__in=role_names)
            .prefetch_related("permisos")
        }

        payload = []
        for instance in users:
            email_key = str(instance.email or "").strip().lower()
            personalized_role = personalized_role_map.get(email_key)

            # Branch IDs — uses prefetched preferencia_operativa, no extra queries
            preference = getattr(instance, "preferencia_operativa", None)
            raw_ids = getattr(preference, "inspeccion_aleatoria_sucursales", []) or []
            inspection_branch_ids = [
                bid for bid in normalize_random_inspection_branch_ids(raw_ids)
                if bid in valid_branch_ids
            ]
            if not inspection_branch_ids and preference is not None and getattr(preference, "inspeccion_aleatoria", False):
                inspection_branch_ids = sorted(valid_branch_ids)

            # Permissions — uses prefetched roles__permisos, no extra queries
            if instance.is_staff or instance.is_superuser:
                puede_ver = True
            else:
                extra_roles = [personalized_role] if personalized_role else []
                permisos = build_permissions_summary(list(instance.roles.all()), extra_roles=extra_roles)
                puede_ver = any(
                    str(p.get("modulo") or "") == str(RolPermiso.Modulos.INVENTARIO)
                    and (p.get("puede_leer") or p.get("puede_crear") or p.get("puede_actualizar") or p.get("puede_eliminar"))
                    for p in permisos
                )

            payload.append({
                "id": int(instance.id),
                "nombres": str(instance.first_name or "").strip(),
                "apellidos": str(instance.last_name or "").strip(),
                "nombre_completo": self._format_display_name(instance),
                "correo": str(instance.email or "").strip(),
                "activo": bool(instance.is_active),
                "es_administrador": bool(instance.is_staff or instance.is_superuser),
                "inspeccion_aleatoria": bool(inspection_branch_ids),
                "inspeccion_aleatoria_sucursales": inspection_branch_ids,
                "puede_ver_inventario": puede_ver,
            })

        payload.sort(
            key=lambda row: (
                not bool(row.get("activo")),
                str(row.get("nombre_completo") or "").lower(),
                int(row.get("id") or 0),
            )
        )
        return Response({"results": payload, "sucursales": branch_options})

    @action(
        detail=True,
        methods=["patch"],
        url_path="inspeccion-aleatoria-asignacion",
    )
    @transaction.atomic
    def inspeccion_aleatoria_asignacion(self, request, pk=None):
        usuario = self.get_object()
        raw_branch_id = request.data.get("sucursal_id")
        if raw_branch_id is None:
            raw_branch_id = request.data.get("branch_id")
        try:
            branch_id = int(raw_branch_id)
        except (TypeError, ValueError):
            branch_id = 0
        if branch_id <= 0 or not Sucursal.objects.filter(pk=branch_id).exists():
            return Response(
                {"detail": "Debes enviar un `sucursal_id` valido."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        raw_enabled = request.data.get("habilitado")
        if raw_enabled is None:
            raw_enabled = request.data.get("enabled")
        if raw_enabled is None:
            raw_enabled = request.data.get("inspeccion_aleatoria")
        if raw_enabled is None:
            return Response(
                {"detail": "Debes enviar `habilitado` con un valor booleano."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            enabled = self._parse_bool_payload(raw_enabled)
        except ValueError as exc:
            return Response(
                {"detail": str(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )

        sync_random_inspection_branch_assignment(usuario, branch_id, enabled)
        usuario = self.get_queryset().filter(pk=usuario.pk).first()
        if usuario is None:
            return Response(
                {"detail": "No se pudo recargar el usuario actualizado."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return Response(
            self._serialize_random_inspection_assignment(usuario),
            status=status.HTTP_200_OK,
        )

    @action(
        detail=False,
        methods=["get"],
        url_path="destinatarios",
        permission_classes=[IsAuthenticated],
    )
    def destinatarios(self, request):
        queryset = self.get_queryset().filter(is_active=True)
        search_term = (request.query_params.get("search") or "").strip()
        if search_term:
            queryset = queryset.filter(
                Q(first_name__icontains=search_term)
                | Q(last_name__icontains=search_term)
                | Q(email__icontains=search_term)
            )

        serializer = UsuarioDestinatarioSerializer(queryset, many=True)
        return Response(serializer.data)


class UsuarioSucursalViewSet(viewsets.ModelViewSet):
    """Gestión de asignaciones de usuarios a sucursales."""

    queryset = (
        UsuarioSucursal.objects.select_related("usuario", "sucursal")
        .all()
        .order_by("-id")
    )
    serializer_class = UsuarioSucursalSerializer
    permission_classes = [IsAuthenticated, UsuariosModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "usuario__first_name",
        "usuario__last_name",
        "sucursal__nombre",
        "rol",
    ]
    ordering_fields = ["sucursal__nombre", "usuario__last_name"]


class RegistroAPIView(APIView):
    """Crea una nueva cuenta y retorna el token de autenticación."""

    permission_classes = [AllowAny]

    def post(self, request):
        serializer = RegistroSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        token, _ = Token.objects.get_or_create(user=user)
        return Response(
            {
                "token": token.key,
                "usuario": AuthUserSerializer(user).data,
            },
            status=status.HTTP_201_CREATED,
        )


class LoginAPIView(APIView):
    """Valida las credenciales y entrega un token de acceso."""

    permission_classes = [AllowAny]

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        email = serializer.validated_data["email"].lower()
        password = serializer.validated_data["password"]
        User = get_user_model()
        existing_user = User.objects.filter(email__iexact=email).first()
        if existing_user and not existing_user.is_active:
            if existing_user.check_password(password):
                return Response(
                    {
                        "detail": "Su cuenta está inactiva, comuníquese con el administrador."
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

        user = authenticate(username=email, password=password)
        if not user:
            return Response(
                {"detail": "Credenciales inválidas."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        token, _ = Token.objects.get_or_create(user=user)

        if user.is_staff or user.is_superuser:
            permisos = build_full_permissions()
            usuario_interno = get_usuario_interno_por_correo(email)
        else:
            usuario_interno = get_usuario_interno_por_correo(email)
            permisos = get_permisos_efectivos(usuario_interno, email)

        return Response(
            {
                "token": token.key,
                "usuario": AuthUserSerializer(user).data,
                "permisos": permisos,
                "usuario_interno_id": usuario_interno.id if usuario_interno else None,
            }
        )


class PerfilAPIView(APIView):
    """Devuelve información del usuario autenticado."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        email = request.user.email
        if request.user.is_staff or request.user.is_superuser:
            permisos = build_full_permissions()
            usuario_interno = get_usuario_interno_por_correo(email)
        else:
            usuario_interno = get_usuario_interno_por_correo(email)
            permisos = get_permisos_efectivos(usuario_interno, email)

        return Response(
            {
                "usuario": AuthUserSerializer(request.user).data,
                "permisos": permisos,
                "usuario_interno_id": usuario_interno.id if usuario_interno else None,
            }
        )


class PermisosDisponiblesAPIView(APIView):
    """Entrega la estructura de módulos y acciones disponibles para permisos."""

    permission_classes = [IsAuthenticated, UsuariosModulePermission]

    def get(self, request):
        acciones = [
            {"key": "puede_leer", "label": "Ver"},
            {"key": "puede_crear", "label": "Crear"},
            {"key": "puede_actualizar", "label": "Editar"},
            {"key": "puede_eliminar", "label": "Eliminar"},
        ]

        modulos = [
            {"key": modulo_key, "label": modulo_label}
            for modulo_key, modulo_label in RolPermiso.Modulos.choices
            if modulo_key not in ADMIN_ONLY_MODULES
        ]

        return Response(
            {
                "modulos": modulos,
                "acciones": acciones,
                "modulos_con_sucursales": get_modulos_con_alcance_sucursal_options(),
            }
        )
