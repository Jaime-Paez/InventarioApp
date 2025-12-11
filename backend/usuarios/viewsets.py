from django.contrib.auth import authenticate
from rest_framework import filters, status, viewsets
from rest_framework.authtoken.models import Token
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Rol, Usuario, UsuarioSucursal
from .serializers import (
    AuthUserSerializer,
    LoginSerializer,
    RegistroSerializer,
    RolSerializer,
    UsuarioSerializer,
    UsuarioSucursalSerializer,
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
        Usuario.objects.prefetch_related("roles__permisos")
        .all()
        .order_by("apellidos", "nombres")
    )
    serializer_class = UsuarioSerializer
    permission_classes = [AllowAny]
    pagination_class = None
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["nombres", "apellidos", "correo", "cargo", "roles__nombre"]
    ordering_fields = ["apellidos", "nombres", "correo"]


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
        return Response(
            {"token": token.key, "usuario": AuthUserSerializer(user).data}
        )


class PerfilAPIView(APIView):
    """Devuelve información del usuario autenticado."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({"usuario": AuthUserSerializer(request.user).data})
