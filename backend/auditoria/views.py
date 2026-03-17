from django.contrib.auth import get_user_model
from django.db.models import Q
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import RegistroAuditoria


def _is_admin(user):
    return user is not None and getattr(user, "is_authenticated", False) and (
        getattr(user, "is_staff", False) or getattr(user, "is_superuser", False)
    )


def _serialize_registro(r):
    usuario = None
    if r.usuario_id is not None and r.usuario is not None:
        u = r.usuario
        nombre = " ".join(
            filter(None, [
                str(getattr(u, "first_name", "") or ""),
                str(getattr(u, "last_name", "") or ""),
            ])
        ).strip() or getattr(u, "email", "") or getattr(u, "username", str(u.pk))
        usuario = {
            "id": u.pk,
            "nombre": nombre,
            "email": str(getattr(u, "email", "") or ""),
        }
    return {
        "id": r.pk,
        "usuario": usuario,
        "accion": r.accion,
        "accion_display": r.get_accion_display(),
        "modelo": r.content_type.model if r.content_type_id else "",
        "app_label": r.content_type.app_label if r.content_type_id else "",
        "object_id": r.object_id,
        "representacion_objeto": r.representacion_objeto,
        "valores_previos": r.valores_previos,
        "valores_nuevos": r.valores_nuevos,
        "detalles": r.detalles,
        "registrado_en": r.registrado_en.isoformat() if r.registrado_en else None,
    }


class AuditoriaListAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not _is_admin(request.user):
            return Response(
                {"detail": "No tienes permiso para acceder a los registros de auditoría."},
                status=403,
            )

        qs = (
            RegistroAuditoria.objects
            .select_related("usuario", "content_type")
            .order_by("-registrado_en")
        )

        accion = request.query_params.get("accion", "").strip()
        if accion:
            qs = qs.filter(accion=accion)

        modelo = request.query_params.get("modelo", "").strip().lower()
        if modelo:
            qs = qs.filter(content_type__model=modelo)

        usuario_id = request.query_params.get("usuario_id", "").strip()
        if usuario_id:
            qs = qs.filter(usuario_id=usuario_id)

        fecha_desde = request.query_params.get("fecha_desde", "").strip()
        if fecha_desde:
            qs = qs.filter(registrado_en__date__gte=fecha_desde)

        fecha_hasta = request.query_params.get("fecha_hasta", "").strip()
        if fecha_hasta:
            qs = qs.filter(registrado_en__date__lte=fecha_hasta)

        search = request.query_params.get("search", "").strip()
        if search:
            qs = qs.filter(representacion_objeto__icontains=search)

        usuario_search = request.query_params.get("usuario_search", "").strip()
        if usuario_search:
            User = get_user_model()
            matching_ids = User.objects.filter(
                Q(first_name__icontains=usuario_search)
                | Q(last_name__icontains=usuario_search)
                | Q(email__icontains=usuario_search)
                | Q(username__icontains=usuario_search)
            ).values_list("id", flat=True)
            qs = qs.filter(usuario_id__in=list(matching_ids))

        try:
            page_size = min(int(request.query_params.get("page_size", 50)), 200)
        except (ValueError, TypeError):
            page_size = 50

        try:
            page = max(int(request.query_params.get("page", 1)), 1)
        except (ValueError, TypeError):
            page = 1

        total = qs.count()
        offset = (page - 1) * page_size
        records = qs[offset: offset + page_size]

        return Response({
            "count": total,
            "page": page,
            "page_size": page_size,
            "results": [_serialize_registro(r) for r in records],
        })
