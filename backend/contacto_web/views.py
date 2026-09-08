"""Endpoint publico para el formulario de contacto del sitio de Jaime Paez
(JaimePaezWebPage, un proyecto separado). No requiere autenticacion ni modelos:
solo valida los datos y envia un correo de notificacion via Django.
"""

from django.conf import settings
from django.core.mail import send_mail
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView


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

        destinatarios = list(getattr(settings, "CONTACTO_WEB_DESTINATARIOS", []) or [])
        if not destinatarios or not settings.EMAIL_HOST_USER:
            return Response(
                {"detail": "El envío de correo no está configurado."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        asunto = f"Nueva solicitud: {nombre} - {marca or 'Marca no indicada'} - {modelo}"
        cuerpo = "\n".join(
            [
                "Solicitud desde la página web — Jaime Páez",
                f"Nombre: {nombre}",
                f"Celular: {celular}",
                f"Marca: {marca or '-'}",
                f"Modelo: {modelo}",
                f"Año: {anio or '-'}",
                f"N° de chasis: {chasis or '-'}",
                f"Solicitud: {detalle}",
            ]
        )

        try:
            send_mail(
                subject=asunto,
                message=cuerpo,
                from_email=settings.DEFAULT_FROM_EMAIL,
                recipient_list=destinatarios,
                fail_silently=False,
            )
        except Exception:
            return Response(
                {"detail": "No se pudo enviar el correo. Intenta más tarde."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return Response({"ok": True})
