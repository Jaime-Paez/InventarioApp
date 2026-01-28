from django.contrib.auth import authenticate, get_user_model
from django.db import transaction
from rest_framework import filters, status, viewsets
from rest_framework.authtoken.models import Token
from rest_framework.decorators import action
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
    UsuarioSerializer,
    UsuarioSucursalSerializer,
    build_permissions_summary,
)
from .utils import (
    get_permisos_efectivos,
    get_usuario_interno_por_correo,
)


class RolViewSet(viewsets.ModelViewSet):
    """Gestión de roles y permisos."""

    queryset = Rol.objects.prefetch_related("permisos").all().order_by("nombre")
    serializer_class = RolSerializer
    permission_classes = [IsAuthenticated, UsuariosModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class UsuarioViewSet(viewsets.ModelViewSet):
    """Gestión de usuarios autenticados."""

    queryset = (
        get_user_model()
        .objects.select_related("perfil", "perfil__rol_personalizado")
        .prefetch_related("roles", "roles__permisos")
        .all()
        .order_by("last_name", "first_name")
    )
    serializer_class = UsuarioSerializer
    permission_classes = [IsAuthenticated, UsuariosModulePermission]
    pagination_class = None
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["first_name", "last_name", "email", "perfil__cargo", "roles__nombre"]
    ordering_fields = ["last_name", "first_name", "email"]

    @transaction.atomic
    def perform_destroy(self, instance):
        instance.delete()

    @action(detail=True, methods=["get"], url_path="permisos-resumen")
    def permisos_resumen(self, request, pk=None):
        usuario = self.get_object()
        perfil = getattr(usuario, "perfil", None)
        permisos = build_permissions_summary(
            [], extra_roles=[perfil.rol_personalizado if perfil else None]
        )
        return Response({"permisos": permisos})


class UsuarioSucursalViewSet(viewsets.ModelViewSet):
    """Gestión de asignaciones de usuarios a sucursales."""

    queryset = (
        UsuarioSucursal.objects.select_related("usuario", "sucursal")
        .all()
        .order_by("sucursal__nombre", "usuario__last_name")
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

        identifier = serializer.validated_data["email"].strip()
        password = serializer.validated_data["password"]
        user = authenticate(username=identifier, password=password)
        if not user:
            user_by_email = (
                get_user_model().objects.filter(email__iexact=identifier).first()
            )
            if user_by_email:
                user = authenticate(
                    username=user_by_email.username,
                    password=password,
                )
        if not user or not user.is_active:
            return Response(
                {"detail": "Credenciales inválidas o usuario inactivo."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        token, _ = Token.objects.get_or_create(user=user)

        email = user.email.lower() if user.email else identifier.lower()
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
        ]

        return Response({"modulos": modulos, "acciones": acciones})
