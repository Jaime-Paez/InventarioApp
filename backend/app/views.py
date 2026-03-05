from datetime import datetime, timezone as dt_timezone
from uuid import uuid4

from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ReminderState


def _normalize_id(value):
    if value is None:
        return ""
    return str(value).strip()


def _normalize_text(value):
    if value is None:
        return ""
    return str(value).strip()


def _parse_iso_timestamp(value):
    raw = _normalize_text(value)
    if not raw:
        return ""

    candidate = raw
    if candidate.endswith("Z"):
        candidate = f"{candidate[:-1]}+00:00"

    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return ""

    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())

    return parsed.astimezone(dt_timezone.utc).isoformat().replace("+00:00", "Z")


def _iso_now():
    return timezone.now().astimezone(dt_timezone.utc).isoformat().replace("+00:00", "Z")


def _sanitize_recipient(raw):
    if not isinstance(raw, dict):
        return None

    recipient_id = _normalize_id(
        raw.get("id") or raw.get("usuario_id") or raw.get("user_id")
    )
    if not recipient_id:
        return None

    name = (
        _normalize_text(raw.get("name"))
        or _normalize_text(raw.get("nombre"))
        or _normalize_text(raw.get("label"))
        or "Usuario"
    )

    return {
        "id": recipient_id,
        "name": name,
    }


def _normalize_decision_status(value):
    normalized = _normalize_text(value).lower()
    if normalized in {"aceptada", "aprobada", "approved"}:
        return "aceptada"
    if normalized in {"rechazada", "rechazar", "rejected"}:
        return "rechazada"
    return "pendiente"


def _sanitize_decision(raw):
    source = raw if isinstance(raw, dict) else {}
    return {
        "status": _normalize_decision_status(
            source.get("status") or source.get("estado")
        ),
        "reason": _normalize_text(source.get("reason") or source.get("motivo")),
        "by": _sanitize_recipient(source.get("by") or source.get("usuario")),
        "at": _parse_iso_timestamp(source.get("at") or source.get("fecha")),
    }


def _sanitize_context(raw):
    source = raw if isinstance(raw, dict) else {}
    context_type = _normalize_id(
        source.get("type")
        or source.get("modulo")
        or source.get("entidad")
        or source.get("tabla")
    )
    context_id = _normalize_id(
        source.get("id")
        or source.get("entidad_id")
        or source.get("objeto_id")
    )

    if not context_type or not context_id:
        return None

    return {
        "type": context_type,
        "id": context_id,
        "label": _normalize_text(source.get("label") or source.get("nombre")),
    }


def _sanitize_reminder(raw):
    if not isinstance(raw, dict):
        return None

    date = _normalize_text(raw.get("date") or raw.get("fecha"))
    time = _normalize_text(raw.get("time") or raw.get("hora"))
    description = _normalize_text(raw.get("description") or raw.get("descripcion"))
    if not date or not time:
        return None

    recipients_source = raw.get("recipients")
    if not isinstance(recipients_source, list):
        recipients_source = raw.get("destinatarios")
    if not isinstance(recipients_source, list):
        recipients_source = []

    recipients = []
    seen_recipient_ids = set()
    for recipient_raw in recipients_source:
        recipient = _sanitize_recipient(recipient_raw)
        if recipient is None:
            continue
        recipient_id = recipient["id"]
        if recipient_id in seen_recipient_ids:
            continue
        seen_recipient_ids.add(recipient_id)
        recipients.append(recipient)

    if not recipients:
        return None

    creator_source = raw.get("creator")
    if not isinstance(creator_source, dict):
        creator_source = {}

    creator_id = _normalize_id(
        creator_source.get("id")
        or raw.get("creatorId")
        or raw.get("usuario_creador_id")
    )
    creator_name = (
        _normalize_text(creator_source.get("name"))
        or _normalize_text(raw.get("creatorName"))
        or _normalize_text(raw.get("usuario_creador_nombre"))
        or "Usuario"
    )

    context_source = raw.get("context")
    if not isinstance(context_source, dict):
        context_source = {
            "type": raw.get("contextType"),
            "id": raw.get("contextId"),
            "label": raw.get("contextLabel"),
        }

    completed_by_raw = raw.get("completedBy")
    if not isinstance(completed_by_raw, list):
        completed_by_raw = []
    completed_by = []
    seen_completed_ids = set()
    for completed_item in completed_by_raw:
        completed_id = _normalize_id(completed_item)
        if not completed_id or completed_id in seen_completed_ids:
            continue
        seen_completed_ids.add(completed_id)
        completed_by.append(completed_id)

    reminder_id = _normalize_id(raw.get("id"))
    if not reminder_id:
        reminder_id = f"rem-{uuid4()}"

    created_at = _parse_iso_timestamp(raw.get("createdAt") or raw.get("creado_en"))
    if not created_at:
        created_at = _iso_now()

    return {
        "id": reminder_id,
        "date": date,
        "time": time,
        "description": description,
        "creator": {
            "id": creator_id,
            "name": creator_name,
        },
        "recipients": recipients,
        "context": _sanitize_context(context_source),
        "kind": _normalize_id(raw.get("kind") or raw.get("tipo")),
        "deadlineAt": _parse_iso_timestamp(raw.get("deadlineAt") or raw.get("deadline_at")),
        "decision": _sanitize_decision(raw.get("decision") or raw.get("resolucion")),
        "createdAt": created_at,
        "completedBy": completed_by,
    }


def _created_at_sort_key(reminder):
    timestamp = _parse_iso_timestamp(reminder.get("createdAt"))
    if not timestamp:
        return datetime.min.replace(tzinfo=dt_timezone.utc)

    candidate = timestamp
    if candidate.endswith("Z"):
        candidate = f"{candidate[:-1]}+00:00"

    try:
        return datetime.fromisoformat(candidate)
    except ValueError:
        return datetime.min.replace(tzinfo=dt_timezone.utc)


def _normalize_reminder_list(payload):
    if not isinstance(payload, list):
        return []

    normalized = []
    seen_ids = set()
    for raw in payload:
        reminder = _sanitize_reminder(raw)
        if reminder is None:
            continue
        reminder_id = reminder["id"]
        if reminder_id in seen_ids:
            continue
        seen_ids.add(reminder_id)
        normalized.append(reminder)

    normalized.sort(key=_created_at_sort_key, reverse=True)
    return normalized


def _merge_recipients(existing_recipients, incoming_recipients):
    merged = []
    seen_ids = set()
    for source in (existing_recipients, incoming_recipients):
        for recipient in source:
            clean = _sanitize_recipient(recipient)
            if clean is None:
                continue
            recipient_id = clean["id"]
            if recipient_id in seen_ids:
                continue
            seen_ids.add(recipient_id)
            merged.append(clean)
    return merged


def _merge_completed_by(existing_completed_by, incoming_completed_by):
    merged = []
    seen = set()
    for source in (existing_completed_by, incoming_completed_by):
        for raw in source:
            user_id = _normalize_id(raw)
            if not user_id or user_id in seen:
                continue
            seen.add(user_id)
            merged.append(user_id)
    return merged


def _is_resolved_decision(status_value):
    status = _normalize_decision_status(status_value)
    return status in {"aceptada", "rechazada"}


def _merge_decision(existing_decision, incoming_decision):
    existing = _sanitize_decision(existing_decision)
    incoming = _sanitize_decision(incoming_decision)

    existing_status = existing.get("status")
    incoming_status = incoming.get("status")

    # Avoid stale pending payloads overriding already resolved decisions.
    if _is_resolved_decision(existing_status) and not _is_resolved_decision(incoming_status):
        return existing

    if _is_resolved_decision(incoming_status):
        return incoming

    return existing if _is_resolved_decision(existing_status) else incoming


def _merge_reminder(existing_reminder, incoming_reminder):
    existing = _sanitize_reminder(existing_reminder) or {}
    incoming = _sanitize_reminder(incoming_reminder) or {}

    if not incoming:
        return existing or None
    if not existing:
        return incoming

    merged = dict(existing)
    merged.update(incoming)

    merged["creator"] = incoming.get("creator") or existing.get("creator") or {
        "id": "",
        "name": "Usuario",
    }

    merged["context"] = incoming.get("context") or existing.get("context")
    merged["kind"] = incoming.get("kind") or existing.get("kind") or ""
    merged["deadlineAt"] = incoming.get("deadlineAt") or existing.get("deadlineAt") or ""

    merged["recipients"] = _merge_recipients(
        existing.get("recipients") or [],
        incoming.get("recipients") or [],
    )
    merged["completedBy"] = _merge_completed_by(
        existing.get("completedBy") or [],
        incoming.get("completedBy") or [],
    )
    merged["decision"] = _merge_decision(
        existing.get("decision") or {},
        incoming.get("decision") or {},
    )

    if not merged["recipients"]:
        return None

    return merged


def ping(request):
    return JsonResponse({"message": "pong", "framework": "Django"})


class ReminderStateAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        store = ReminderState.get_global()
        reminders = _normalize_reminder_list(store.payload)

        if reminders != (store.payload if isinstance(store.payload, list) else []):
            store.payload = reminders
            store.save(update_fields=["payload", "updated_at"])

        return Response(
            {
                "reminders": reminders,
                "updated_at": store.updated_at,
            },
            status=status.HTTP_200_OK,
        )

    def put(self, request):
        reminders_payload = request.data.get("reminders")
        if not isinstance(reminders_payload, list):
            return Response(
                {"detail": "Debes enviar un arreglo en `reminders`."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        incoming = _normalize_reminder_list(reminders_payload)

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            existing = _normalize_reminder_list(store.payload)

            merged_by_id = {item["id"]: item for item in existing}
            for reminder in incoming:
                reminder_id = reminder["id"]
                previous = merged_by_id.get(reminder_id)
                merged = _merge_reminder(previous, reminder)
                if merged is None:
                    continue
                merged_by_id[reminder_id] = merged

            merged = list(merged_by_id.values())
            merged.sort(key=_created_at_sort_key, reverse=True)

            store.payload = merged
            store.save(update_fields=["payload", "updated_at"])

        return Response(
            {
                "reminders": merged,
                "updated_at": store.updated_at,
            },
            status=status.HTTP_200_OK,
        )
