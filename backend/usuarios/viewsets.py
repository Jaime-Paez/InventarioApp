from django.contrib.auth import authenticate
from rest_framework import filters, status, viewsets
from rest_framework.authtoken.models import Token
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Rol, RolPermiso, Usuario, UsuarioSucursal
from .serializers import (
    AuthUserSerializer,
    LoginSerializer,
    RegistroSerializer,
    RolSerializer,
    UsuarioSerializer,
    UsuarioSucursalSerializer,
    build_permissions_summary,
)


class RolViewSet(viewsets.ModelViewSet):
    """Gestión de roles y permisos."""

    queryset = Rol.objects.prefetch_related("permisos").all().order_by("nombre")
    serializer_class = RolSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombre"]
    ordering_fields = ["nombre"]


class UsuarioViewSet(viewsets.ModelViewSet):
    """Gestión de usuarios internos."""

    queryset = (
        Usuario.objects.prefetch_related(
            "rol_personalizado__permisos",
        )
        .all()
        .order_by("apellidos", "nombres")
    )
    serializer_class = UsuarioSerializer
    permission_classes = [AllowAny]
    pagination_class = None
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombres", "apellidos", "correo", "cargo", "roles__nombre"]
    ordering_fields = ["apellidos", "nombres", "correo"]

    @action(detail=True, methods=["get"], url_path="permisos-resumen")
    def permisos_resumen(self, request, pk=None):
        usuario = self.get_object()
        permisos = build_permissions_summary(
            [], extra_roles=[usuario.rol_personalizado]
        )
        return Response({"permisos": permisos})


class UsuarioSucursalViewSet(viewsets.ModelViewSet):
    """Gestión de asignaciones de usuarios a sucursales."""

    queryset = (
        UsuarioSucursal.objects.select_related("usuario", "sucursal")
        .all()
        .order_by("sucursal__nombre", "usuario__apellidos")
    )
    serializer_class = UsuarioSucursalSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "usuario__nombres",
        "usuario__apellidos",
        "sucursal__nombre",
        "rol",
    ]
    ordering_fields = ["sucursal__nombre", "usuario__apellidos"]


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
        user = authenticate(username=email, password=password)
        if not user:
            return Response(
                {"detail": "Credenciales inválidas."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        token, _ = Token.objects.get_or_create(user=user)

        usuario_interno = (
            Usuario.objects.prefetch_related(
                "rol_personalizado__permisos",
                "roles__permisos",
            )
            .filter(correo__iexact=email)
            .first()
        )

        permisos = self._get_effective_permissions(usuario_interno, email)

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
        usuario_interno = (
            Usuario.objects.prefetch_related(
                "rol_personalizado__permisos",
                "roles__permisos",
            )
            .filter(correo__iexact=email)
            .first()
        )

        permisos = self._get_effective_permissions(usuario_interno, email)

        return Response(
            {
                "usuario": AuthUserSerializer(request.user).data,
                "permisos": permisos,
                "usuario_interno_id": usuario_interno.id if usuario_interno else None,
            }
        )

    @staticmethod
    def _get_effective_permissions(usuario_interno, email):
        """Devuelve los permisos consolidados para el usuario autenticado.

        Prioriza el usuario interno asociado; si no existe, intenta localizar un rol
        personalizado con el patrón "Permisos - <correo>" para no devolver una lista vacía.
        """

        roles = []
        extra_roles = []

        if usuario_interno:
            roles = list(usuario_interno.roles.all())
            if usuario_interno.rol_personalizado:
                extra_roles.append(usuario_interno.rol_personalizado)
        else:
            fallback_role = (
                Rol.objects.prefetch_related("permisos")
                .filter(es_personalizado=True, nombre__iexact=f"Permisos - {email}")
                .first()
            )
            if fallback_role:
                extra_roles.append(fallback_role)

        return build_permissions_summary(roles, extra_roles=extra_roles)


class PermisosDisponiblesAPIView(APIView):
    """Entrega la estructura de módulos y acciones disponibles para permisos."""

    permission_classes = [IsAuthenticated]

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
