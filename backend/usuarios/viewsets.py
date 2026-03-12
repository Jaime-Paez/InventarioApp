from django.contrib.auth import authenticate, get_user_model
from django.db import transaction
from django.db.models import Q
from rest_framework import filters, status, viewsets
from rest_framework.authtoken.models import Token
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

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
    get_modulos_con_alcance_sucursal_options,
    get_permisos_efectivos,
    get_usuario_interno_por_correo,
    remove_personalized_role_for_email,
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

    @transaction.atomic
    def perform_destroy(self, instance):
        if self._is_protected_admin_user(instance):
            raise PermissionDenied("No se puede eliminar el usuario Administrador.")
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
