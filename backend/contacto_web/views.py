"""Endpoint publico para el formulario de contacto del sitio de Jaime Paez
(JaimePaezWebPage, un proyecto separado). No requiere autenticacion.

La solicitud se guarda en SolicitudWeb y queda visible en Kava, en
Configuración — no se envía ningún correo de notificación.
"""

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import SolicitudWeb


class ContactoWebAPIView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        data = request.data or {}
        nombre = str(data.get("nombre") or "").strip()
        celular = str(data.get("celular") or "").strip()
        marca = str(data.get("marca") or "").strip()
        modelo = str(data.get("modelo") or "").strip()
        anio = str(data.get("anio") or "").strip()
        chasis = str(data.get("chasis") or "").strip()
        detalle = str(data.get("detalle") or "").strip()

        if not nombre or not celular or not modelo or not detalle:
            return Response(
                {"detail": "Completa nombre, celular, modelo y descripción."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        SolicitudWeb.objects.create(
            nombre=nombre,
            celular=celular,
            marca=marca,
            modelo=modelo,
            anio=anio,
            chasis=chasis,
            detalle=detalle,
        )

        return Response({"ok": True})
