import json
import re

from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import BorradorFormulario

FORMULARIO_RE = re.compile(r"^[a-z0-9_-]{1,60}$")
MAX_BYTES = 2_000_000


def _payload(borrador):
    if borrador is None:
        return {"datos": None, "actualizado_en": None}
    return {"datos": borrador.datos, "actualizado_en": borrador.actualizado_en}


class BorradorFormularioView(APIView):
    """GET / PUT / DELETE /borradores/<formulario>/ -- siempre el del usuario
    autenticado; nadie ve ni toca el borrador de otro."""

    permission_classes = [IsAuthenticated]

    def _check(self, formulario):
        if not FORMULARIO_RE.match(formulario or ""):
            return Response({"detail": "Formulario no válido."}, status=status.HTTP_400_BAD_REQUEST)
        return None

    def get(self, request, formulario):
        error = self._check(formulario)
        if error:
            return error
        borrador = BorradorFormulario.objects.filter(usuario=request.user, formulario=formulario).first()
        return Response(_payload(borrador))

    def put(self, request, formulario):
        error = self._check(formulario)
        if error:
            return error
        datos = request.data.get("datos") if isinstance(request.data, dict) else None
        if not isinstance(datos, dict):
            return Response({"detail": "Faltan los datos del borrador."}, status=status.HTTP_400_BAD_REQUEST)
        if len(json.dumps(datos, default=str)) > MAX_BYTES:
            return Response({"detail": "El borrador es demasiado grande."}, status=status.HTTP_400_BAD_REQUEST)
        borrador, _ = BorradorFormulario.objects.update_or_create(
            usuario=request.user, formulario=formulario, defaults={"datos": datos}
        )
        return Response(_payload(borrador))

    def delete(self, request, formulario):
        error = self._check(formulario)
        if error:
            return error
        BorradorFormulario.objects.filter(usuario=request.user, formulario=formulario).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
