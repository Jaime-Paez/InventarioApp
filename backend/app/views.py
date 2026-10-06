import math
import random
import re
import json
from datetime import date as dt_date, datetime, timedelta, time as dt_time, timezone as dt_timezone
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Count, Max, Q, Sum
from django.http import JsonResponse
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from configuracion.models import ConfiguracionSistema
from inventario.models import Bodega, Division, Inventario, SubDivision
from usuarios.models import RolPermiso
from usuarios.sucursal_scope import get_allowed_sucursal_ids
from usuarios.utils import (
    build_full_permissions,
    get_permisos_efectivos,
    get_random_inspection_branch_ids,
    get_usuario_interno_por_correo,
    is_app_admin,
)

from .models import (
    InspeccionAleatoriaDiaria,
    InspeccionAleatoriaConfiguracion,
    InspeccionAleatoriaItem,
    ReminderState,
    UsuarioPreferencia,
)


def _normalize_id(value):
    if value is None:
        return ""
    return str(value).strip()


def _normalize_text(value):
    if value is None:
        return ""
    return str(value).strip()


def _normalize_context_type(value):
    normalized = _normalize_id(value).lower()
    if not normalized:
        return ""
    return re.sub(r"[\s-]+", "_", normalized)


def _purge_reminders_for_context(context_type, context_id):
    normalized_type = _normalize_context_type(context_type)
    normalized_id = _normalize_id(context_id)
    if not normalized_type or not normalized_id:
        return False

    with transaction.atomic():
        store = ReminderState.get_global(for_update=True)
        current = _normalize_reminder_list(store.payload)
        filtered = []
        changed = False
        for reminder in current:
            context = reminder.get("context")
            if not isinstance(context, dict):
                filtered.append(reminder)
                continue
            if (
                _normalize_context_type(context.get("type")) == normalized_type
                and _normalize_id(context.get("id")) == normalized_id
            ):
                changed = True
                continue
            filtered.append(reminder)
        if changed:
            store.payload = filtered
            store.save(update_fields=["payload", "updated_at"])
        return changed


def _get_permission_index_for_user(user):
    if user is None or not getattr(user, "is_authenticated", False):
        return {}

    if is_app_admin(user):
        permisos = build_full_permissions()
    else:
        email = str(getattr(user, "email", "") or "").strip().lower()
        usuario_interno = get_usuario_interno_por_correo(email)
        permisos = get_permisos_efectivos(usuario_interno, email)

    index = {}
    for permiso in permisos:
        module_key = permiso.get("modulo")
        if not module_key:
            continue

        current = index.get(
            module_key,
            {
                "puede_crear": False,
                "puede_leer": False,
                "puede_actualizar": False,
                "puede_eliminar": False,
            },
        )
        index[module_key] = {
            "puede_crear": current["puede_crear"] or bool(permiso.get("puede_crear")),
            "puede_leer": current["puede_leer"] or bool(permiso.get("puede_leer")),
            "puede_actualizar": current["puede_actualizar"]
            or bool(permiso.get("puede_actualizar")),
            "puede_eliminar": current["puede_eliminar"]
            or bool(permiso.get("puede_eliminar")),
        }

    return index


def _can_create_product_inventory_reminders(user):
    permission_index = _get_permission_index_for_user(user)
    products_permissions = permission_index.get(RolPermiso.Modulos.PRODUCTOS, {})
    return bool(products_permissions.get("puede_actualizar"))


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
    if normalized in {
        "enviado",
        "enviada",
        "en_traslado",
        "en traslado",
        "en_transito",
        "sent",
        "shipped",
    }:
        return "enviado"
    if normalized in {"rechazada", "rechazar", "rejected"}:
        return "rechazada"
    return "pendiente"


def _sanitize_recipient_list(raw_list):
    if not isinstance(raw_list, list):
        return []

    recipients = []
    seen_recipient_ids = set()
    for recipient_raw in raw_list:
        recipient = _sanitize_recipient(recipient_raw)
        if recipient is None:
            continue
        recipient_id = recipient["id"]
        if recipient_id in seen_recipient_ids:
            continue
        seen_recipient_ids.add(recipient_id)
        recipients.append(recipient)
    return recipients


def _sanitize_decision(raw):
    source = raw if isinstance(raw, dict) else {}
    return {
        "status": _normalize_decision_status(
            source.get("status") or source.get("estado")
        ),
        "reason": _normalize_text(source.get("reason") or source.get("motivo")),
        "by": _sanitize_recipient(source.get("by") or source.get("usuario")),
        "at": _parse_iso_timestamp(source.get("at") or source.get("fecha")),
        "assignedRecipients": _sanitize_recipient_list(
            source.get("assignedRecipients")
            or source.get("assigned_recipients")
            or source.get("recipients")
            or []
        ),
    }


def _normalize_transfer_history_stage(value):
    normalized = _normalize_text(value).lower()
    if normalized in {"pendiente", "solicitud", "creada", "solicitada"}:
        return "pendiente"
    if normalized in {"aceptada", "aprobada", "approved"}:
        return "aceptada"
    if normalized in {"rechazada", "rechazar", "rejected", "cancelada", "cancelado"}:
        return "rechazada"
    if normalized in {
        "enviado",
        "enviada",
        "en_traslado",
        "en traslado",
        "en_transito",
        "sent",
        "shipped",
    }:
        return "enviado"
    if normalized in {"completo", "recibido_completo", "llego_completo"}:
        return "completo"
    if normalized in {"incompleto", "recibido_incompleto", "llego_incompleto"}:
        return "incompleto"
    return ""


def _sanitize_transfer_history_entry(raw):
    if not isinstance(raw, dict):
        return None

    stage = _normalize_transfer_history_stage(
        raw.get("stage") or raw.get("status") or raw.get("key")
    )
    if not stage:
        return None

    at = _parse_iso_timestamp(raw.get("at") or raw.get("fecha"))
    if not at:
        at = _iso_now()

    return {
        "stage": stage,
        "label": _normalize_text(raw.get("label")),
        "description": _normalize_text(raw.get("description") or raw.get("descripcion")),
        "at": at,
        "actor": _sanitize_recipient(raw.get("actor") or raw.get("by") or raw.get("usuario")),
    }


def _infer_transfer_history_entry_from_reminder(reminder):
    if not isinstance(reminder, dict):
        return None

    context = _sanitize_context(reminder.get("context"))
    if context is None:
        context = _sanitize_context(
            {
                "type": reminder.get("contextType"),
                "id": reminder.get("contextId"),
                "label": reminder.get("contextLabel"),
            }
        )
    if context is None or _normalize_context_type(context.get("type")) != "solicitud_traslado":
        return None

    decision = _sanitize_decision(reminder.get("decision") or reminder.get("resolucion"))
    decision_status = _normalize_decision_status(decision.get("status"))
    description = _normalize_text(reminder.get("description") or reminder.get("descripcion"))
    stage = ""

    if "llego incompleto" in description:
        stage = "incompleto"
    elif "llego completo" in description:
        stage = "completo"
    elif decision_status in {"aceptada", "rechazada", "enviado"}:
        stage = decision_status
    elif _normalize_id(reminder.get("kind")) == "solicitud_traslado_decision":
        stage = "pendiente"
    elif "aceptada" in description:
        stage = "aceptada"
    elif "rechazada" in description:
        stage = "rechazada"
    elif "en traslado" in description or "fue enviada" in description:
        stage = "enviado"
    elif _normalize_context_type(context.get("type")) == "solicitud_traslado":
        stage = "pendiente"

    if not stage:
        return None

    timestamp = _parse_iso_timestamp(reminder.get("createdAt") or reminder.get("creado_en"))
    if not timestamp:
        date = _normalize_text(reminder.get("date") or reminder.get("fecha"))
        time = _normalize_text(reminder.get("time") or reminder.get("hora"))
        if date and time:
            timestamp = _parse_iso_timestamp(f"{date}T{time}:00")
    if not timestamp:
        timestamp = _iso_now()

    return {
        "stage": stage,
        "label": "",
        "description": description,
        "at": timestamp,
        "actor": _sanitize_recipient(decision.get("by") or reminder.get("creator")),
    }


def _sanitize_transfer_history(raw_history, reminder=None):
    entries = []
    by_signature = {}

    for item in raw_history if isinstance(raw_history, list) else []:
        entry = _sanitize_transfer_history_entry(item)
        if entry is None:
            continue
        actor = entry.get("actor") if isinstance(entry.get("actor"), dict) else {}
        signature = (
            entry.get("stage") or "",
            entry.get("at") or "",
            _normalize_id(actor.get("id")),
            _normalize_text(entry.get("description")),
        )
        by_signature[signature] = entry

    if not by_signature and reminder is not None:
        legacy_entry = _infer_transfer_history_entry_from_reminder(reminder)
        if legacy_entry is not None:
            actor = (
                legacy_entry.get("actor")
                if isinstance(legacy_entry.get("actor"), dict)
                else {}
            )
            signature = (
                legacy_entry.get("stage") or "",
                legacy_entry.get("at") or "",
                _normalize_id(actor.get("id")),
                _normalize_text(legacy_entry.get("description")),
            )
            by_signature[signature] = legacy_entry

    entries = list(by_signature.values())
    entries.sort(key=lambda row: _parse_iso_timestamp(row.get("at")) or "")
    return _collapse_duplicate_transfer_history_entries(entries)


def _collapse_duplicate_transfer_history_entries(entries):
    collapsed = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue

        previous = collapsed[-1] if collapsed else None
        if previous is None:
            collapsed.append(entry)
            continue

        current_actor = entry.get("actor") if isinstance(entry.get("actor"), dict) else {}
        previous_actor = (
            previous.get("actor") if isinstance(previous.get("actor"), dict) else {}
        )

        same_stage = _normalize_transfer_history_stage(entry.get("stage")) == _normalize_transfer_history_stage(
            previous.get("stage")
        )
        same_actor = _normalize_id(current_actor.get("id")) == _normalize_id(
            previous_actor.get("id")
        )
        same_description = _normalize_text(entry.get("description")) == _normalize_text(
            previous.get("description")
        )

        if same_stage and same_actor and same_description:
            current_timestamp = _parse_iso_timestamp(entry.get("at"))
            previous_timestamp = _parse_iso_timestamp(previous.get("at"))

            if current_timestamp and previous_timestamp:
                if str(current_timestamp)[:19] == str(previous_timestamp)[:19]:
                    continue
            elif str(entry.get("at") or "").strip() == str(previous.get("at") or "").strip():
                continue

        collapsed.append(entry)

    return collapsed


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

    result = {
        "type": context_type,
        "id": context_id,
        "label": _normalize_text(source.get("label") or source.get("nombre")),
    }
    sucursal_solicitante_id = _normalize_id(source.get("sucursal_solicitante_id"))
    if sucursal_solicitante_id:
        result["sucursal_solicitante_id"] = sucursal_solicitante_id
    sucursal_proveedora_id = _normalize_id(source.get("sucursal_proveedora_id"))
    if sucursal_proveedora_id:
        result["sucursal_proveedora_id"] = sucursal_proveedora_id
    if "urgente" in source:
        result["urgente"] = bool(source.get("urgente"))
    detalle_usuarios = source.get("detalle_usuarios")
    if isinstance(detalle_usuarios, list):
        sanitized_detalle = []
        for entry in detalle_usuarios:
            if not isinstance(entry, dict):
                continue
            uid = _normalize_id(entry.get("id"))
            if not uid:
                continue
            sanitized_detalle.append({
                "id": uid,
                "name": str(entry.get("name") or "").strip() or "Usuario",
                "completada": bool(entry.get("completada")),
                "disculpada": bool(entry.get("disculpada")),
            })
        if sanitized_detalle:
            result["detalle_usuarios"] = sanitized_detalle
    return result


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

    recipients = _sanitize_recipient_list(recipients_source)
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
        "transferHistory": _sanitize_transfer_history(
            raw.get("transferHistory") or raw.get("transfer_history") or raw.get("history"),
            reminder=raw,
        ),
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
        incoming["assignedRecipients"] = _merge_recipients(
            existing.get("assignedRecipients") or [],
            incoming.get("assignedRecipients") or [],
        )
        return incoming

    merged = existing if _is_resolved_decision(existing_status) else incoming
    merged["assignedRecipients"] = _merge_recipients(
        existing.get("assignedRecipients") or [],
        incoming.get("assignedRecipients") or [],
    )
    return merged


def _merge_transfer_history(existing_history, incoming_history):
    merged_by_signature = {}
    for source in (existing_history, incoming_history):
        for raw in source if isinstance(source, list) else []:
            entry = _sanitize_transfer_history_entry(raw)
            if entry is None:
                continue
            actor = entry.get("actor") if isinstance(entry.get("actor"), dict) else {}
            signature = (
                entry.get("stage") or "",
                entry.get("at") or "",
                _normalize_id(actor.get("id")),
                _normalize_text(entry.get("description")),
            )
            merged_by_signature[signature] = entry

    merged = list(merged_by_signature.values())
    merged.sort(key=lambda row: _parse_iso_timestamp(row.get("at")) or "")
    return _collapse_duplicate_transfer_history_entries(merged)


def _hydrate_transfer_history_from_solicitudes(reminders):
    normalized = _normalize_reminder_list(reminders)
    solicitud_ids = set()

    for reminder in normalized:
        context = reminder.get("context") if isinstance(reminder.get("context"), dict) else {}
        context_type = _normalize_context_type(context.get("type"))
        context_id = _normalize_id(context.get("id"))
        if context_type != "solicitud_traslado" or not context_id.isdigit():
            continue
        solicitud_ids.add(int(context_id))

    if not solicitud_ids:
        return normalized, False

    from movimientos.models import SolicitudTraslado

    persisted_history_by_id = {}
    for solicitud_id, historial_transfer in (
        SolicitudTraslado.objects.filter(id__in=sorted(solicitud_ids))
        .values_list("id", "historial_transfer")
    ):
        persisted_history_by_id[str(int(solicitud_id))] = _sanitize_transfer_history(
            historial_transfer
        )

    hydrated = []
    changed = False
    for reminder in normalized:
        context = reminder.get("context") if isinstance(reminder.get("context"), dict) else {}
        context_type = _normalize_context_type(context.get("type"))
        context_id = _normalize_id(context.get("id"))
        if context_type != "solicitud_traslado" or not context_id:
            hydrated.append(reminder)
            continue

        persisted_history = persisted_history_by_id.get(context_id) or []
        if not persisted_history:
            hydrated.append(reminder)
            continue

        merged_history = _merge_transfer_history(
            persisted_history,
            reminder.get("transferHistory") or [],
        )
        if merged_history == (reminder.get("transferHistory") or []):
            hydrated.append(reminder)
            continue

        updated_reminder = dict(reminder)
        updated_reminder["transferHistory"] = merged_history
        hydrated.append(updated_reminder)
        changed = True

    return hydrated, changed


def _hydrate_urgente_from_solicitudes(reminders):
    normalized = _normalize_reminder_list(reminders)
    solicitud_ids = set()

    for reminder in normalized:
        context = reminder.get("context") if isinstance(reminder.get("context"), dict) else {}
        context_type = _normalize_context_type(context.get("type"))
        context_id = _normalize_id(context.get("id"))
        if context_type != "solicitud_traslado" or not context_id.isdigit():
            continue
        solicitud_ids.add(int(context_id))

    if not solicitud_ids:
        return normalized, False

    from movimientos.models import SolicitudTraslado

    urgente_by_id = {}
    for solicitud_id, urgente in (
        SolicitudTraslado.objects.filter(id__in=sorted(solicitud_ids))
        .values_list("id", "urgente")
    ):
        urgente_by_id[str(int(solicitud_id))] = bool(urgente)

    hydrated = []
    changed = False
    for reminder in normalized:
        context = reminder.get("context") if isinstance(reminder.get("context"), dict) else {}
        context_type = _normalize_context_type(context.get("type"))
        context_id = _normalize_id(context.get("id"))
        if context_type != "solicitud_traslado" or not context_id:
            hydrated.append(reminder)
            continue

        if context_id not in urgente_by_id:
            hydrated.append(reminder)
            continue

        current_urgente = context.get("urgente")
        db_urgente = urgente_by_id[context_id]
        if current_urgente == db_urgente:
            hydrated.append(reminder)
            continue

        updated_context = dict(context)
        updated_context["urgente"] = db_urgente
        updated_reminder = dict(reminder)
        updated_reminder["context"] = updated_context
        hydrated.append(updated_reminder)
        changed = True

    return hydrated, changed


def _latest_transfer_history_stage(history):
    if not isinstance(history, list) or not history:
        return ""
    latest = history[-1] if history else {}
    return _normalize_transfer_history_stage(latest.get("stage"))


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

    _incoming_ctx = incoming.get("context") or {}
    _existing_ctx = existing.get("context") or {}
    if _incoming_ctx:
        _merged_ctx = dict(_incoming_ctx)
        for _ctx_key in ("sucursal_solicitante_id", "sucursal_proveedora_id"):
            if not _merged_ctx.get(_ctx_key) and _existing_ctx.get(_ctx_key):
                _merged_ctx[_ctx_key] = _existing_ctx[_ctx_key]
        merged["context"] = _merged_ctx
    else:
        merged["context"] = _existing_ctx or None
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
    merged["transferHistory"] = _merge_transfer_history(
        existing.get("transferHistory") or [],
        incoming.get("transferHistory") or [],
    )
    previous_stage = _latest_transfer_history_stage(existing.get("transferHistory") or [])
    incoming_stage = _latest_transfer_history_stage(incoming.get("transferHistory") or [])

    if incoming_stage and incoming_stage != previous_stage:
        merged["completedBy"] = list(incoming.get("completedBy") or [])
        if incoming_stage == "pendiente":
            merged["decision"] = _sanitize_decision(incoming.get("decision") or {})
            merged["decision"]["assignedRecipients"] = _merge_recipients(
                existing.get("decision", {}).get("assignedRecipients") or [],
                incoming.get("decision", {}).get("assignedRecipients") or [],
            )

    if not merged["recipients"]:
        return None

    return merged


RANDOM_INSPECTION_CONTEXT_TYPE = "inspeccion_aleatoria"
RANDOM_INSPECTION_KIND = "inspeccion_aleatoria_diaria"
RANDOM_INSPECTION_VERIFY_KIND = "inspeccion_aleatoria_verificacion"
RANDOM_INSPECTION_ADMIN_SUMMARY_KIND = "inspeccion_aleatoria_resumen_admin"
RANDOM_INSPECTION_START_HOUR = 9
RANDOM_INSPECTION_DEFAULT_ITEMS_PER_DAY = 5
RANDOM_INSPECTION_MIN_ITEMS_PER_DAY = 1
RANDOM_INSPECTION_MAX_ITEMS_PER_DAY = 200
RANDOM_INSPECTION_ROTATION_DAYS = 90


def _normalize_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _resolve_random_inspection_items_per_day():
    configured_value = RANDOM_INSPECTION_DEFAULT_ITEMS_PER_DAY
    config = ConfiguracionSistema.get_solo()
    if config is not None:
        configured_value = _normalize_int(
            getattr(config, "random_inspection_items_per_day", configured_value),
            configured_value,
        )

    configured_value = max(
        RANDOM_INSPECTION_MIN_ITEMS_PER_DAY,
        configured_value,
    )
    configured_value = min(
        RANDOM_INSPECTION_MAX_ITEMS_PER_DAY,
        configured_value,
    )
    return configured_value


def _format_user_display_name(user):
    full_name = ""
    if user is not None:
        full_name = str(getattr(user, "get_full_name", lambda: "")() or "").strip()
        if not full_name:
            full_name = str(getattr(user, "first_name", "") or "").strip()
        if not full_name:
            full_name = str(getattr(user, "username", "") or "").strip()
        if not full_name:
            full_name = str(getattr(user, "email", "") or "").strip()
    return full_name or "Usuario"


def _is_random_inspection_enabled_for_user(user):
    return bool(_get_random_inspection_branch_ids_for_user(user))


def _get_allowed_inventory_branch_ids_for_user(user):
    allowed = get_allowed_sucursal_ids(user, RolPermiso.Modulos.INVENTARIO)
    if allowed is None:
        return None
    return {int(branch_id) for branch_id in allowed if branch_id is not None}


def _get_random_inspection_branch_ids_for_user(user):
    if user is None or not getattr(user, "is_authenticated", False):
        return set()

    branch_ids = {
        int(branch_id)
        for branch_id in get_random_inspection_branch_ids(user)
        if branch_id is not None
    }
    if not branch_ids:
        return set()

    allowed_branch_ids = _get_allowed_inventory_branch_ids_for_user(user)
    if allowed_branch_ids is None:
        return branch_ids
    return branch_ids.intersection(allowed_branch_ids)


def _collect_inspection_candidates(*, branch_ids=None, division_id=None, subdivision_id=None):
    """Productos contables en el alcance dado (sucursales, division y/o subdivision).

    Incluye tambien los productos que el sistema tiene en 0 pero con fila de
    inventario en el alcance (`sin_stock`): son justo los que nunca se
    revisaban y donde suele esconderse una entrada no registrada.
    """
    queryset = Inventario.objects.all()
    if branch_ids is not None:
        queryset = queryset.filter(
            subdivision__division__bodega__sucursal_id__in=sorted(branch_ids)
        )
    if division_id is not None:
        queryset = queryset.filter(subdivision__division_id=division_id)
    if subdivision_id is not None:
        queryset = queryset.filter(subdivision_id=subdivision_id)

    rows = (
        queryset.values(
            "subdivision__division__bodega__sucursal_id",
            "subdivision__division__bodega__sucursal__nombre",
            "producto_id",
            "producto__codigo",
            "producto__nombre",
            "producto__precio",
        )
        .annotate(cantidad_esperada=Sum("cantidad"))
        .order_by(
            "subdivision__division__bodega__sucursal_id",
            "producto_id",
        )
    )

    candidates = []
    for row in rows:
        sucursal_id = _normalize_int(
            row.get("subdivision__division__bodega__sucursal_id"),
            0,
        )
        producto_id = _normalize_int(row.get("producto_id"), 0)
        cantidad_esperada = max(0, _normalize_int(row.get("cantidad_esperada"), 0))
        if sucursal_id <= 0 or producto_id <= 0:
            continue
        try:
            precio = float(row.get("producto__precio") or 0)
        except (TypeError, ValueError):
            precio = 0.0
        candidates.append(
            {
                "sucursal_id": sucursal_id,
                "sucursal_nombre": _normalize_text(
                    row.get("subdivision__division__bodega__sucursal__nombre")
                )
                or f"Sucursal {sucursal_id}",
                "producto_id": producto_id,
                "producto_codigo": _normalize_text(row.get("producto__codigo")),
                "producto_nombre": _normalize_text(row.get("producto__nombre"))
                or f"Producto {producto_id}",
                "cantidad_esperada": cantidad_esperada,
                "sin_stock": cantidad_esperada <= 0,
                "valor_stock": max(0.0, precio) * cantidad_esperada,
            }
        )
    return candidates


def _collect_random_inspection_candidates(user):
    allowed_branch_ids = _get_random_inspection_branch_ids_for_user(user)
    if not allowed_branch_ids:
        return []
    return _collect_inspection_candidates(branch_ids=allowed_branch_ids)


def _collect_branch_inspection_candidates(branch_id):
    """Collect inventory candidates for a single branch."""
    return _collect_inspection_candidates(branch_ids={int(branch_id)})


def _natural_sort_key(value):
    """"Nivel 2" antes que "Nivel 10" (los numeros se comparan como numeros)."""
    parts = re.split(r"(\d+)", _normalize_text(value).lower())
    return tuple((0, int(part), "") if part.isdigit() else (1, 0, part) for part in parts if part)


def _sort_candidates_by_location(candidates, *, division_id, subdivision_id=None):
    """Ordena los productos como estan en la percha: por division y
    subdivision (orden natural de sus nombres) y dentro de cada una por codigo.

    Las revisiones por division/subdivision se recorren fisicamente de la
    primera ubicacion a la ultima; con el orden por id de producto el revisor
    saltaba de un lado a otro.
    """
    product_ids = {int(candidate["producto_id"]) for candidate in candidates}
    if not product_ids:
        return list(candidates)
    rows = Inventario.objects.filter(
        producto_id__in=sorted(product_ids), subdivision__division_id=int(division_id)
    )
    if subdivision_id:
        rows = rows.filter(subdivision_id=int(subdivision_id))
    stocked_keys = {}
    any_keys = {}
    for row in rows.values(
        "producto_id", "cantidad", "subdivision_id", "subdivision__nombre", "subdivision__division__nombre"
    ):
        key = (
            _natural_sort_key(row.get("subdivision__division__nombre")),
            _natural_sort_key(row.get("subdivision__nombre")),
            _normalize_int(row.get("subdivision_id"), 0),
        )
        product_id = _normalize_int(row.get("producto_id"), 0)
        target = stocked_keys if _normalize_int(row.get("cantidad"), 0) > 0 else any_keys
        if product_id not in target or key < target[product_id]:
            target[product_id] = key

    def sort_key(candidate):
        product_id = int(candidate["producto_id"])
        location_key = stocked_keys.get(product_id) or any_keys.get(product_id)
        return (
            0 if location_key else 1,
            location_key or (),
            _natural_sort_key(candidate.get("producto_codigo")),
            product_id,
        )

    return sorted(candidates, key=sort_key)


def _collect_division_inspection_candidates(division_id, subdivision_id=None):
    """Candidatos de una division (todas sus subdivisiones, o solo una)."""
    return _collect_inspection_candidates(
        division_id=int(division_id),
        subdivision_id=int(subdivision_id) if subdivision_id else None,
    )


def _collect_random_inspection_history(branch_ids):
    """Historial GLOBAL (de cualquier revisor) por (sucursal, producto).

    Antes era por usuario: dos revisores de la misma sucursal repetian los
    mismos productos mientras otros nunca se contaban.
    """
    queryset = InspeccionAleatoriaItem.objects.exclude(
        estado_revision=InspeccionAleatoriaItem.EstadosRevision.PENDIENTE
    ).exclude(
        verificacion_estado=InspeccionAleatoriaItem.EstadosVerificacion.PENDIENTE
    )
    if branch_ids is not None:
        queryset = queryset.filter(sucursal_id__in=sorted(branch_ids))
    rows = (
        queryset.values("sucursal_id", "producto_id")
        .annotate(total_revisiones=Count("id"), ultima_revision=Max("revisado_en"))
    )
    history = {}
    for row in rows:
        sucursal_id = _normalize_int(row.get("sucursal_id"), 0)
        producto_id = _normalize_int(row.get("producto_id"), 0)
        if sucursal_id <= 0 or producto_id <= 0:
            continue
        history[(sucursal_id, producto_id)] = {
            "total_revisiones": _normalize_int(row.get("total_revisiones"), 0),
            "ultima_revision": row.get("ultima_revision"),
        }
    return history


def _collect_random_inspection_rotation(branch_ids, scheduled_date):
    """Unidades que salieron por (sucursal, producto) en los ultimos 90 dias."""
    from movimientos.models import DetalleMovimiento  # Import tardio para evitar ciclos

    queryset = DetalleMovimiento.objects.filter(
        movimiento_inventario__fecha__gte=scheduled_date - timedelta(days=RANDOM_INSPECTION_ROTATION_DAYS),
        movimiento_inventario__tipo_movimiento__nombre__istartswith="sal",
    )
    if branch_ids is not None:
        queryset = queryset.filter(movimiento_inventario__sucursal_id__in=sorted(branch_ids))
    rows = queryset.values("movimiento_inventario__sucursal_id", "producto_id").annotate(
        total=Sum("cantidad")
    )
    return {
        (
            _normalize_int(row.get("movimiento_inventario__sucursal_id"), 0),
            _normalize_int(row.get("producto_id"), 0),
        ): max(0, _normalize_int(row.get("total"), 0))
        for row in rows
    }


def _random_inspection_candidate_weight(candidate, rotation):
    """Peso tipo ABC: lo que mas se mueve o mas vale sale mas seguido."""
    key = (candidate["sucursal_id"], candidate["producto_id"])
    units_out = rotation.get(key, 0)
    stock_value = float(candidate.get("valor_stock") or 0)
    return 1.0 + math.log1p(units_out) + 0.5 * math.log1p(stock_value / 10.0)


def _get_random_inspection_keys_assigned_on(scheduled_date, *, exclude_user_id=None):
    queryset = InspeccionAleatoriaItem.objects.filter(
        inspeccion__fecha_programada=scheduled_date
    )
    if exclude_user_id is not None:
        queryset = queryset.exclude(inspeccion__usuario_id=exclude_user_id)
    return {
        (int(sucursal_id), int(producto_id))
        for sucursal_id, producto_id in queryset.values_list("sucursal_id", "producto_id")
    }


def _select_random_inspection_candidates(
    user,
    scheduled_date,
    candidates,
    *,
    items_per_day=RANDOM_INSPECTION_DEFAULT_ITEMS_PER_DAY,
    excluded_keys=None,
):
    excluded_keys = excluded_keys or set()
    candidates = [
        candidate
        for candidate in (candidates or [])
        if (candidate["sucursal_id"], candidate["producto_id"]) not in excluded_keys
    ]
    if not candidates:
        return []

    resolved_items_per_day = _normalize_int(
        items_per_day,
        RANDOM_INSPECTION_DEFAULT_ITEMS_PER_DAY,
    )
    resolved_items_per_day = max(RANDOM_INSPECTION_MIN_ITEMS_PER_DAY, resolved_items_per_day)
    resolved_items_per_day = min(RANDOM_INSPECTION_MAX_ITEMS_PER_DAY, resolved_items_per_day)
    target_count = min(resolved_items_per_day, len(candidates))
    if target_count <= 0:
        return []

    branch_ids = {candidate["sucursal_id"] for candidate in candidates}
    history = _collect_random_inspection_history(branch_ids)
    rotation = _collect_random_inspection_rotation(branch_ids, scheduled_date)
    rng = random.Random(f"{user.id}-{scheduled_date.isoformat()}-{len(candidates)}")

    def _ordered(group):
        # Primero lo menos revisado (por cualquiera) y lo revisado hace mas
        # tiempo; entre empates, sorteo ponderado (Efraimidis-Spirakis) en vez
        # del orden por id, que antes sesgaba siempre a los productos viejos.
        ordered = []
        for candidate in group:
            key = (candidate["sucursal_id"], candidate["producto_id"])
            stats = history.get(key, {})
            total_revisiones = _normalize_int(stats.get("total_revisiones"), 0)
            last_reviewed = stats.get("ultima_revision")
            last_ts = 0.0
            if isinstance(last_reviewed, datetime):
                aware = last_reviewed
                if timezone.is_naive(aware):
                    aware = timezone.make_aware(aware, timezone.get_current_timezone())
                last_ts = aware.timestamp()
            weight = _random_inspection_candidate_weight(candidate, rotation)
            lottery = rng.random() ** (1.0 / weight)
            ordered.append((total_revisiones, last_ts, -lottery, candidate))
        ordered.sort(key=lambda row: (row[0], row[1], row[2]))
        return [row[3] for row in ordered]

    stocked = _ordered([candidate for candidate in candidates if not candidate.get("sin_stock")])
    without_stock = _ordered([candidate for candidate in candidates if candidate.get("sin_stock")])

    zero_slots = min(len(without_stock), (target_count + 2) // 5)
    unique = stocked[: target_count - zero_slots] + without_stock[:zero_slots]
    seen = {(candidate["sucursal_id"], candidate["producto_id"]) for candidate in unique}
    # Si un grupo no alcanza, se completa con el otro.
    for candidate in stocked + without_stock:
        if len(unique) >= target_count:
            break
        key = (candidate["sucursal_id"], candidate["producto_id"])
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    rng.shuffle(unique)
    return unique[:target_count]


def _stocked_candidate_keys(candidates):
    # La cobertura se mide sobre lo que hay en stock (como siempre); los
    # productos en 0 que ahora tambien se sortean no inflan el denominador.
    return {
        (candidate["sucursal_id"], candidate["producto_id"])
        for candidate in candidates
        if not candidate.get("sin_stock")
    }


def _build_random_inspection_item(inspection, candidate, *, sucursal_id=None):
    cantidad = int(candidate["cantidad_esperada"])
    return InspeccionAleatoriaItem(
        inspeccion=inspection,
        sucursal_id=int(sucursal_id if sucursal_id is not None else candidate["sucursal_id"]),
        producto_id=int(candidate["producto_id"]),
        cantidad_esperada=cantidad,
        cantidad_esperada_inicial=cantidad,
    )


def _calculate_random_inspection_coverage(user, candidate_keys):
    if not candidate_keys:
        return 0.0

    reviewed_rows = InspeccionAleatoriaItem.objects.filter(
        inspeccion__usuario=user
    ).exclude(
        estado_revision=InspeccionAleatoriaItem.EstadosRevision.PENDIENTE
    ).exclude(
        verificacion_estado=InspeccionAleatoriaItem.EstadosVerificacion.PENDIENTE
    ).values_list("sucursal_id", "producto_id")
    reviewed_keys = {
        (int(sucursal_id), int(producto_id))
        for sucursal_id, producto_id in reviewed_rows
        if sucursal_id is not None and producto_id is not None
    }
    reviewed_in_scope = len(candidate_keys.intersection(reviewed_keys))
    return round((reviewed_in_scope / len(candidate_keys)) * 100, 2)


def _build_random_inspection_reminder(inspection, user, *, branch_nombre=None, time_str=None):
    date_value = inspection.fecha_programada.isoformat()
    reminder_id = f"insp-{int(inspection.id)}"
    created_at = _parse_iso_timestamp(getattr(inspection, "created_at", None)) or _iso_now()
    recipient = {
        "id": str(int(user.id)),
        "name": _format_user_display_name(user),
    }
    total_items = _normalize_int(getattr(inspection, "total_items", 0), 0)
    if total_items <= 0:
        total_items = RANDOM_INSPECTION_DEFAULT_ITEMS_PER_DAY
    items_label = "producto" if total_items == 1 else "productos"
    if branch_nombre:
        description = (
            f"Inspeccion aleatoria: revisa {total_items} {items_label} de {branch_nombre} y confirma "
            "si coinciden con el sistema."
        )
    else:
        description = (
            f"Inspeccion aleatoria diaria: revisa {total_items} {items_label} del inventario y confirma "
            "si coinciden con el sistema."
        )
    reminder_time = time_str if time_str else f"{RANDOM_INSPECTION_START_HOUR:02d}:00"
    return {
        "id": reminder_id,
        "date": date_value,
        "time": reminder_time,
        "description": description,
        "creator": {"id": "sistema", "name": "Sistema"},
        "recipients": [recipient],
        "context": {
            "type": RANDOM_INSPECTION_CONTEXT_TYPE,
            "id": str(int(inspection.id)),
            "label": f"Inspeccion aleatoria {date_value}",
        },
        "kind": RANDOM_INSPECTION_KIND,
        "deadlineAt": "",
        "decision": {
            "status": "pendiente",
            "reason": "",
            "by": None,
            "at": "",
        },
        "createdAt": created_at,
        "completedBy": [],
    }


def _upsert_random_inspection_reminder(
    store,
    inspection,
    user,
    *,
    mark_completed=False,
    branch_nombre=None,
    time_str=None,
):
    existing_payload = (
        list(store.payload)
        if isinstance(store.payload, list)
        else []
    )
    reminder = _sanitize_reminder(_build_random_inspection_reminder(inspection, user, branch_nombre=branch_nombre, time_str=time_str))
    if reminder is None:
        return False

    context_id = _normalize_id(reminder.get("context", {}).get("id"))
    reminder_id = _normalize_id(reminder.get("id"))
    recipient_id = str(int(user.id))
    target_index = None

    for index, existing in enumerate(existing_payload):
        if not isinstance(existing, dict):
            continue
        existing_context = existing.get("context") if isinstance(existing, dict) else None
        existing_context_type = _normalize_id(
            existing_context.get("type") if isinstance(existing_context, dict) else ""
        )
        existing_context_id = _normalize_id(
            existing_context.get("id") if isinstance(existing_context, dict) else ""
        )
        existing_kind = _normalize_id(existing.get("kind"))
        existing_id = _normalize_id(existing.get("id"))
        if existing_id == reminder_id:
            target_index = index
            break
        if (
            existing_kind == RANDOM_INSPECTION_KIND
            and existing_context_type == RANDOM_INSPECTION_CONTEXT_TYPE
            and existing_context_id == context_id
        ):
            target_index = index
            break

    if target_index is not None:
        merged = _merge_reminder(existing_payload[target_index], reminder)
        if merged is None:
            return False
        if mark_completed or inspection.estado == InspeccionAleatoriaDiaria.Estados.COMPLETADA:
            completed_by = set(_merge_completed_by(merged.get("completedBy") or [], [recipient_id]))
            merged["completedBy"] = sorted(completed_by)
        existing_payload[target_index] = merged
    else:
        if mark_completed or inspection.estado == InspeccionAleatoriaDiaria.Estados.COMPLETADA:
            reminder["completedBy"] = sorted(
                set(_merge_completed_by(reminder.get("completedBy") or [], [recipient_id]))
            )
        existing_payload = [reminder, *existing_payload]

    normalized_payload = _normalize_reminder_list(existing_payload)
    changed = normalized_payload != (
        store.payload if isinstance(store.payload, list) else []
    )
    if changed:
        store.payload = normalized_payload
    return changed


def _ensure_daily_random_inspection_for_user(user, store):
    if not _is_random_inspection_enabled_for_user(user):
        return None, False

    now_local = timezone.localtime()

    # Use hora_recordatorio from config if set, otherwise fall back to RANDOM_INSPECTION_START_HOUR
    config = InspeccionAleatoriaConfiguracion.get_global()
    hora_config = config.hora_recordatorio
    if hora_config is None:
        return None, False

    if now_local.time() < hora_config:
        return None, False

    scheduled_date = now_local.date()
    inspection = (
        InspeccionAleatoriaDiaria.objects.select_for_update()
        .filter(usuario=user, fecha_programada=scheduled_date, sucursal__isnull=True)
        .first()
    )

    changed_payload = False
    if inspection is None:
        # Si el admin ya le mando una inspeccion hoy ("enviar ahora" o por
        # division), no se le suma ademas la automatica: era trabajo doble.
        # Una lista especifica no la reemplaza: es un control puntual aparte.
        if InspeccionAleatoriaDiaria.objects.filter(
            usuario=user, fecha_programada=scheduled_date, es_por_lista=False
        ).exists():
            return None, False

        candidates = _collect_random_inspection_candidates(user)
        if not candidates:
            return None, False

        items_per_day = _resolve_random_inspection_items_per_day()
        selected = _select_random_inspection_candidates(
            user,
            scheduled_date,
            candidates,
            items_per_day=items_per_day,
            excluded_keys=_get_random_inspection_keys_assigned_on(
                scheduled_date, exclude_user_id=user.id
            ),
        )
        if not selected:
            return None, False

        coverage = _calculate_random_inspection_coverage(
            user, _stocked_candidate_keys(candidates)
        )

        inspection = InspeccionAleatoriaDiaria.objects.create(
            usuario=user,
            sucursal=None,
            fecha_programada=scheduled_date,
            estado=InspeccionAleatoriaDiaria.Estados.PENDIENTE,
            total_items=len(selected),
            cobertura_porcentaje=coverage,
        )

        InspeccionAleatoriaItem.objects.bulk_create(
            [_build_random_inspection_item(inspection, row) for row in selected]
        )

    time_str = f"{hora_config.hour:02d}:{hora_config.minute:02d}"
    changed_payload = _upsert_random_inspection_reminder(
        store,
        inspection,
        user,
        mark_completed=inspection.estado == InspeccionAleatoriaDiaria.Estados.COMPLETADA,
        time_str=time_str,
    )
    return inspection, changed_payload


def _purge_orphan_random_inspection_reminders(store):
    """Quita recordatorios de inspecciones que ya no existen en la base.

    Si una inspeccion se borra (p. ej. desde el admin de Django o un script),
    su recordatorio -- y sobre todo el de "verificar diferencias" -- quedaba
    pendiente para siempre y no habia forma de cerrarlo desde la app.
    """
    payload = store.payload if isinstance(store.payload, list) else []
    inspection_kinds = {RANDOM_INSPECTION_KIND, RANDOM_INSPECTION_VERIFY_KIND}

    def _inspection_id(reminder):
        if not isinstance(reminder, dict):
            return None
        if _normalize_id(reminder.get("kind")) not in inspection_kinds:
            return None
        context = reminder.get("context") if isinstance(reminder.get("context"), dict) else {}
        if _normalize_context_type(context.get("type")) != RANDOM_INSPECTION_CONTEXT_TYPE:
            return None
        inspection_id = _normalize_int(context.get("id"), 0)
        return inspection_id if inspection_id > 0 else None

    referenced_ids = {inspection_id for inspection_id in map(_inspection_id, payload) if inspection_id}
    if not referenced_ids:
        return False
    existing_ids = set(
        InspeccionAleatoriaDiaria.objects.filter(pk__in=referenced_ids).values_list("id", flat=True)
    )
    if referenced_ids <= existing_ids:
        return False
    store.payload = [
        reminder
        for reminder in payload
        if _inspection_id(reminder) is None or _inspection_id(reminder) in existing_ids
    ]
    return True


def _ensure_daily_random_inspections_for_all_users(store):
    """Genera la inspeccion del dia a TODOS los revisores habilitados.

    Antes solo se creaba cuando el propio revisor abria la app, asi que quien
    no entraba no tenia inspeccion y el resumen del admin no lo mostraba como
    pendiente (parecia que "todos completaron"). Se invoca desde el sondeo de
    recordatorios de cualquier usuario; debe llamarse con `store` bloqueado.
    """
    changed = False
    preferences = (
        UsuarioPreferencia.objects.filter(
            inspeccion_aleatoria=True,
            usuario__is_active=True,
        )
        .select_related("usuario")
        .order_by("usuario_id")
    )
    for preference in preferences:
        _, user_changed = _ensure_daily_random_inspection_for_user(preference.usuario, store)
        changed = changed or user_changed
    return changed


def _ensure_all_admin_summaries(user, store):
    """
    Refresh every admin summary reminder in the store from DB.
    Covers: today, yesterday, and any other dates already present in the payload.
    This ensures completions/disculpadas from any day are reflected on next fetch.
    """
    if not _can_verify_random_inspection(user):
        return False

    config = InspeccionAleatoriaConfiguracion.get_global()
    hora_config = config.hora_recordatorio
    time_str = (
        f"{hora_config.hour:02d}:{hora_config.minute:02d}"
        if hora_config is not None
        else f"{RANDOM_INSPECTION_START_HOUR:02d}:00"
    )

    today = timezone.localdate()
    yesterday = today - timedelta(days=1)

    # Collect all dates that already have an admin summary in the store
    dates_to_refresh = {today, yesterday}
    existing_payload = store.payload if isinstance(store.payload, list) else []
    for item in existing_payload:
        if not isinstance(item, dict):
            continue
        if _normalize_id(item.get("kind")) == RANDOM_INSPECTION_ADMIN_SUMMARY_KIND:
            raw_date = str(item.get("date") or "").strip()
            if raw_date:
                try:
                    from datetime import date as _date
                    dates_to_refresh.add(_date.fromisoformat(raw_date))
                except ValueError:
                    pass

    changed = False
    for d in sorted(dates_to_refresh):
        changed = _upsert_random_inspection_admin_summary_reminder(
            store, d, time_str=time_str, reminder_date=d,
        ) or changed
    return changed


def _inspection_division_scope(inspection):
    """Division a la que se limita el conteo (solo inspecciones por division)."""
    if inspection is not None and getattr(inspection, "es_por_division", False):
        return getattr(inspection, "division_id", None)
    return None


def _inspection_subdivision_scope(inspection):
    """Subdivision a la que se limita el conteo (division con subdivision elegida)."""
    if (
        inspection is not None
        and getattr(inspection, "es_por_division", False)
        and getattr(inspection, "es_por_subdivision", False)
    ):
        return getattr(inspection, "subdivision_id", None)
    return None


def _inspection_stock_queryset(*, branch_ids, product_ids, division_id=None, subdivision_id=None):
    queryset = Inventario.objects.filter(
        producto_id__in=sorted(product_ids),
        subdivision__division__bodega__sucursal_id__in=sorted(branch_ids),
    )
    if division_id is not None:
        queryset = queryset.filter(subdivision__division_id=division_id)
    if subdivision_id is not None:
        queryset = queryset.filter(subdivision_id=subdivision_id)
    return queryset


def _live_expected_quantities(items, *, division_id=None, subdivision_id=None):
    """Stock actual del sistema por (sucursal, producto) en el alcance.

    Es contra esto que se compara el conteo: la foto tomada al generar la
    inspeccion queda vieja apenas hay una venta o una entrada, y ajustar con
    ella duplicaba esos movimientos al aprobar una diferencia.
    """
    keys = {
        (int(item.sucursal_id), int(item.producto_id))
        for item in items
        if getattr(item, "sucursal_id", None) and getattr(item, "producto_id", None)
    }
    if not keys:
        return {}
    rows = (
        _inspection_stock_queryset(
            branch_ids={branch_id for branch_id, _ in keys},
            product_ids={product_id for _, product_id in keys},
            division_id=division_id,
            subdivision_id=subdivision_id,
        )
        .values("subdivision__division__bodega__sucursal_id", "producto_id")
        .annotate(total=Sum("cantidad"))
    )
    quantities = {key: 0 for key in keys}
    for row in rows:
        key = (
            _normalize_int(row.get("subdivision__division__bodega__sucursal_id"), 0),
            _normalize_int(row.get("producto_id"), 0),
        )
        if key in quantities:
            quantities[key] = max(0, _normalize_int(row.get("total"), 0))
    return quantities


def _serialize_random_inspection_item(item, *, hide_expected=False, live_expected=None):
    location_payload = getattr(item, "_inspection_location_payload", None) or {}
    locations = location_payload.get("ubicaciones_bodega", []) or []
    location_text = _normalize_text(location_payload.get("ubicacion_bodega"))
    expected = int(item.cantidad_esperada or 0) if live_expected is None else int(live_expected)
    conteo_ubicaciones = item.conteo_ubicaciones if isinstance(item.conteo_ubicaciones, list) else []
    if hide_expected:
        # Conteo a ciegas: hasta que el revisor termina el primer conteo no se
        # le manda ninguna cantidad del sistema (ni total ni por ubicacion).
        expected = None
        locations = [{**location, "cantidad": None} for location in locations]
        location_text = "\n".join(location.get("label", "") for location in locations)
        conteo_ubicaciones = [
            {**entry, "cantidad_sistema": None}
            for entry in conteo_ubicaciones
            if isinstance(entry, dict)
        ]
    serialized_result = {
        "estado_revision": str(item.estado_revision or "").strip(),
        "observacion": _normalize_text(item.observacion),
        "verificacion_estado": str(item.verificacion_estado or "").strip(),
        "cantidad_confirmada": (
            int(item.cantidad_confirmada)
            if item.cantidad_confirmada is not None
            else None
        ),
        "nota_verificacion": _normalize_text(item.nota_verificacion),
        "verificado_en": _parse_iso_timestamp(item.verificado_en),
        "verificado_por": _format_user_display_name(getattr(item, "verificado_por", None))
        if getattr(item, "verificado_por_id", None)
        else "",
    }
    if hide_expected:
        # Tampoco si coincidio ni lo que decidio administracion; y se quitan
        # las notas automaticas del sistema (delatan una diferencia).
        serialized_result = {
            "estado_revision": (
                InspeccionAleatoriaItem.EstadosRevision.PENDIENTE
                if item.estado_revision == InspeccionAleatoriaItem.EstadosRevision.PENDIENTE
                else "revisado"
            ),
            "observacion": "\n".join(
                line
                for line in _normalize_text(item.observacion).splitlines()
                if not line.strip().startswith("[Sistema]")
            ).strip(),
            "verificacion_estado": "",
            "cantidad_confirmada": None,
            "nota_verificacion": "",
            "verificado_en": None,
            "verificado_por": "",
        }
    return {
        "id": int(item.id),
        "sucursal_id": int(item.sucursal_id),
        "sucursal_nombre": _normalize_text(
            getattr(getattr(item, "sucursal", None), "nombre", "")
        ),
        "producto_id": int(item.producto_id),
        "producto_codigo": _normalize_text(
            getattr(getattr(item, "producto", None), "codigo", "")
        ),
        "producto_nombre": _normalize_text(
            getattr(getattr(item, "producto", None), "nombre", "")
        ),
        "ubicacion_bodega": location_text,
        "ubicaciones_bodega": locations,
        "cantidad_esperada": expected,
        "cantidad_esperada_inicial": (
            int(item.cantidad_esperada_inicial)
            if item.cantidad_esperada_inicial is not None and not hide_expected
            else None
        ),
        "cantidad_reportada": (
            int(item.cantidad_reportada)
            if item.cantidad_reportada is not None
            else None
        ),
        "cantidad_primer_conteo": (
            int(item.cantidad_primer_conteo)
            if item.cantidad_primer_conteo is not None
            else None
        ),
        "conteo_ubicaciones": conteo_ubicaciones,
        "revisado_en": _parse_iso_timestamp(item.revisado_en),
        "no_encontrado": bool(getattr(item, "no_encontrado", False)),
        "reubicado_a": (
            _subdivision_label(getattr(item, "reubicado_a", None))
            if getattr(item, "reubicado_a_id", None) and not hide_expected
            else ""
        ),
        **serialized_result,
    }


def _subdivision_label(subdivision):
    if subdivision is None:
        return ""
    division = getattr(subdivision, "division", None)
    bodega = getattr(division, "bodega", None)
    return " / ".join(
        part
        for part in (
            _normalize_text(getattr(bodega, "nombre", "")),
            _normalize_text(getattr(division, "nombre", "")),
            _normalize_text(getattr(subdivision, "nombre", "")),
        )
        if part
    )


def _attach_random_inspection_locations(items, *, division_id=None, subdivision_id=None):
    inspection_items = list(items or [])
    if not inspection_items:
        return inspection_items

    target_keys = {
        (int(item.sucursal_id), int(item.producto_id))
        for item in inspection_items
        if getattr(item, "sucursal_id", None) and getattr(item, "producto_id", None)
    }
    if not target_keys:
        return inspection_items

    rows = (
        _inspection_stock_queryset(
            branch_ids={branch_id for branch_id, _ in target_keys},
            product_ids={product_id for _, product_id in target_keys},
            division_id=division_id,
            subdivision_id=subdivision_id,
        )
        .values(
            "producto_id",
            "subdivision_id",
            "subdivision__division__bodega__sucursal_id",
            "subdivision__division__bodega__sucursal__nombre",
            "subdivision__division__bodega__nombre",
            "subdivision__division__nombre",
            "subdivision__nombre",
        )
        .annotate(cantidad_total=Sum("cantidad"))
        .order_by(
            "subdivision__division__bodega__sucursal_id",
            "producto_id",
            "subdivision__division__bodega__nombre",
            "subdivision__division__nombre",
            "subdivision__nombre",
            "subdivision_id",
        )
    )

    stocked_map = {}
    empty_map = {}
    for row in rows:
        branch_id = _normalize_int(row.get("subdivision__division__bodega__sucursal_id"), 0)
        product_id = _normalize_int(row.get("producto_id"), 0)
        key = (branch_id, product_id)
        if key not in target_keys:
            continue

        sucursal_nombre = _normalize_text(
            row.get("subdivision__division__bodega__sucursal__nombre")
        )
        bodega_nombre = _normalize_text(row.get("subdivision__division__bodega__nombre"))
        division_nombre = _normalize_text(row.get("subdivision__division__nombre"))
        subdivision_nombre = _normalize_text(row.get("subdivision__nombre"))
        cantidad_total = max(0, _normalize_int(row.get("cantidad_total"), 0))

        parts = [part for part in [bodega_nombre, division_nombre, subdivision_nombre] if part]
        if not parts:
            continue

        # Los productos en 0 no tienen ubicacion "con stock": se muestran las
        # filas vacias que tienen para saber donde buscarlos.
        target_map = stocked_map if cantidad_total > 0 else empty_map
        target_map.setdefault(key, []).append(
            {
                "sucursal_id": branch_id,
                "producto_id": product_id,
                "subdivision_id": _normalize_int(row.get("subdivision_id"), 0) or None,
                "sucursal_nombre": sucursal_nombre,
                "bodega_nombre": bodega_nombre,
                "division_nombre": division_nombre,
                "subdivision_nombre": subdivision_nombre,
                "cantidad": cantidad_total,
                "label": " / ".join(parts),
            }
        )

    for item in inspection_items:
        key = (int(item.sucursal_id), int(item.producto_id))
        locations = stocked_map.get(key) or empty_map.get(key, [])
        item._inspection_location_payload = {
            "ubicacion_bodega": "\n".join(
                f'{location["label"]} ({int(location["cantidad"])} uds)'
                for location in locations
            ),
            "ubicaciones_bodega": locations,
        }

    return inspection_items


def _is_random_inspection_pending(inspection):
    return (
        str(getattr(inspection, "estado", "") or "").strip().lower()
        != InspeccionAleatoriaDiaria.Estados.COMPLETADA
    )


def _serialize_random_inspection(inspection, *, viewer=None):
    division_id = _inspection_division_scope(inspection)
    subdivision_id = _inspection_subdivision_scope(inspection)
    inspection_items = list(
        inspection.items.select_related("sucursal", "producto", "verificado_por").all()
    )
    inspection_items = _attach_random_inspection_locations(
        inspection_items, division_id=division_id, subdivision_id=subdivision_id
    )
    is_pending = _is_random_inspection_pending(inspection)
    viewer_id = getattr(viewer, "id", None)
    viewer_is_assignee = viewer_id is not None and int(viewer_id) == int(inspection.usuario_id)
    # El revisor nunca ve el inventario esperado ni si coincidio (ni antes ni
    # despues de enviar): eso lo decide solo administracion. Si el revisor
    # tambien es administrador, se le oculta solo mientras cuenta.
    hide_expected = bool(
        viewer_is_assignee
        and (
            not _can_verify_random_inspection(viewer)
            or (is_pending and not inspection.conteo_revelado)
        )
    )
    live_expected = (
        _live_expected_quantities(
            inspection_items, division_id=division_id, subdivision_id=subdivision_id
        )
        if is_pending
        else {}
    )
    division = getattr(inspection, "division", None) if inspection.division_id else None
    subdivision = getattr(inspection, "subdivision", None) if inspection.subdivision_id else None
    return {
        "id": int(inspection.id),
        "usuario_id": int(inspection.usuario_id),
        "fecha_programada": inspection.fecha_programada.isoformat(),
        "estado": str(inspection.estado or "").strip(),
        "total_items": int(inspection.total_items or len(inspection_items)),
        "cobertura_porcentaje": float(inspection.cobertura_porcentaje or 0),
        "completada_en": _parse_iso_timestamp(inspection.completada_en),
        "borrador_paso_actual": int(inspection.borrador_paso_actual or 0),
        "borrador_version": int(inspection.borrador_version or 0),
        "borrador_fase": str(inspection.borrador_fase or "").strip(),
        "borrador_indice_correccion": int(inspection.borrador_indice_correccion or 0),
        "borrador_tiene_novedad": bool(inspection.borrador_tiene_novedad),
        "borrador_nota_general": str(inspection.borrador_nota_general or ""),
        "conteo_revelado": bool(inspection.conteo_revelado),
        "es_por_division": bool(inspection.es_por_division),
        "es_por_lista": bool(inspection.es_por_lista),
        "division_id": int(inspection.division_id) if inspection.division_id else None,
        "division_nombre": _normalize_text(getattr(division, "nombre", "")),
        "es_por_subdivision": bool(inspection.es_por_subdivision),
        "subdivision_id": int(inspection.subdivision_id) if inspection.subdivision_id else None,
        "subdivision_nombre": _normalize_text(getattr(subdivision, "nombre", "")),
        "nota_general": str(inspection.nota_general or "").strip(),
        "items": [
            _serialize_random_inspection_item(
                item,
                hide_expected=hide_expected,
                live_expected=live_expected.get((int(item.sucursal_id), int(item.producto_id)))
                if is_pending
                else None,
            )
            for item in inspection_items
        ],
    }


def _random_inspection_subdivision_labels(items):
    """{subdivision_id: "Bodega / Division / Subdivision"} de los conteos por ubicacion."""
    subdivision_ids = set()
    for item in items:
        for entry in item.conteo_ubicaciones if isinstance(item.conteo_ubicaciones, list) else []:
            subdivision_id = _normalize_int((entry or {}).get("subdivision_id"), 0) if isinstance(entry, dict) else 0
            if subdivision_id > 0:
                subdivision_ids.add(subdivision_id)
    if not subdivision_ids:
        return {}
    rows = SubDivision.objects.filter(pk__in=subdivision_ids).values(
        "id", "nombre", "division__nombre", "division__bodega__nombre"
    )
    return {
        int(row["id"]): " / ".join(
            part
            for part in (
                _normalize_text(row.get("division__bodega__nombre")),
                _normalize_text(row.get("division__nombre")),
                _normalize_text(row.get("nombre")),
            )
            if part
        )
        for row in rows
    }


def _serialize_random_inspection_admin_item(item, subdivision_labels=None):
    serialized = _serialize_random_inspection_item(item)
    inspection = getattr(item, "inspeccion", None)
    inspection_user = getattr(inspection, "usuario", None)
    subdivision_labels = subdivision_labels or {}
    # Conteo por ubicacion con nombre legible, para que administracion vea
    # donde estuvo la diferencia (lo contado vs lo que habia en el sistema).
    location_counts = []
    for entry in item.conteo_ubicaciones if isinstance(item.conteo_ubicaciones, list) else []:
        if not isinstance(entry, dict):
            continue
        subdivision_id = _normalize_int(entry.get("subdivision_id"), 0)
        label = subdivision_labels.get(subdivision_id) or " / ".join(
            part for part in str(entry.get("key") or "").split("::")[1:] if part
        )
        location_counts.append(
            {
                "subdivision_id": subdivision_id or None,
                "label": label or "Ubicacion",
                "cantidad_contada": entry.get("cantidad_contada"),
                "cantidad_sistema": entry.get("cantidad_sistema"),
            }
        )
    serialized["ubicaciones_conteo"] = location_counts
    serialized.update(
        {
            "inspeccion_id": int(item.inspeccion_id),
            "fecha_programada": (
                inspection.fecha_programada.isoformat()
                if inspection is not None and getattr(inspection, "fecha_programada", None)
                else ""
            ),
            "inspeccion_estado": (
                str(getattr(inspection, "estado", "") or "").strip()
                if inspection is not None
                else ""
            ),
            "inspeccion_usuario_id": (
                int(inspection.usuario_id)
                if inspection is not None and getattr(inspection, "usuario_id", None) is not None
                else None
            ),
            "inspeccion_usuario_nombre": _format_user_display_name(inspection_user)
            if inspection_user is not None
            else "",
        }
    )
    return serialized


def _normalize_random_inspection_review_state(value):
    normalized = _normalize_text(value).lower()
    if normalized in {"coincide", "ok", "completo", "si", "true", "1"}:
        return InspeccionAleatoriaItem.EstadosRevision.COINCIDE
    if normalized in {
        "no_coincide",
        "no coincide",
        "incompleto",
        "no",
        "false",
        "0",
    }:
        return InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE
    return InspeccionAleatoriaItem.EstadosRevision.PENDIENTE


def _can_verify_random_inspection(user):
    if user is None or not getattr(user, "is_authenticated", False):
        return False
    if is_app_admin(user):
        return True
    return user.roles.filter(
        permisos__modulo=RolPermiso.Modulos.USUARIOS,
        permisos__puede_actualizar=True,
    ).exists()


def _get_random_inspection_verify_recipients():
    user_model = get_user_model()
    queryset = (
        user_model.objects.filter(is_active=True)
        .filter(
            Q(preferencia_operativa__es_administrador=True)
            | Q(is_superuser=True)
            | Q(
                roles__permisos__modulo=RolPermiso.Modulos.USUARIOS,
                roles__permisos__puede_actualizar=True,
            )
        )
        .distinct()
        .order_by("id")
    )
    recipients = []
    for user in queryset:
        recipient = _sanitize_recipient(
            {"id": str(int(user.id)), "name": _format_user_display_name(user)}
        )
        if recipient is not None:
            recipients.append(recipient)
    return recipients


def _upsert_random_inspection_verify_reminder(store, inspection, mismatch_count, actor_user):
    recipients = _get_random_inspection_verify_recipients()
    if not recipients:
        return False

    actor_name = _format_user_display_name(actor_user)
    inspection_ref = f"#{int(inspection.id)}"
    reminder = _sanitize_reminder(
        {
            "id": f"insp-verify-{int(inspection.id)}",
            "date": timezone.localdate().isoformat(),
            "time": timezone.localtime().strftime("%H:%M"),
            "description": (
                f"{actor_name} reporto diferencias en la inspeccion aleatoria "
                f"{inspection_ref} ({mismatch_count} producto(s))."
            ),
            "creator": {"id": str(int(actor_user.id)), "name": actor_name},
            "recipients": recipients,
            "context": {
                "type": RANDOM_INSPECTION_CONTEXT_TYPE,
                "id": str(int(inspection.id)),
                "label": f"Inspeccion aleatoria {inspection_ref}",
            },
            "kind": RANDOM_INSPECTION_VERIFY_KIND,
            "createdAt": _iso_now(),
            "completedBy": [],
        }
    )
    if reminder is None:
        return False

    existing_payload = (
        list(store.payload)
        if isinstance(store.payload, list)
        else []
    )
    reminder_id = _normalize_id(reminder.get("id"))
    target_index = None
    for index, existing in enumerate(existing_payload):
        if _normalize_id(existing.get("id")) == reminder_id:
            target_index = index
            break

    if target_index is None:
        existing_payload = [reminder, *existing_payload]
    else:
        merged = _merge_reminder(existing_payload[target_index], reminder)
        if merged is None:
            return False
        existing_payload[target_index] = merged

    normalized_payload = _normalize_reminder_list(existing_payload)
    changed = normalized_payload != (
        store.payload if isinstance(store.payload, list) else []
    )
    if changed:
        store.payload = normalized_payload
    return changed


def _build_random_inspection_admin_summary_reminder(today, user_summaries, admin_recipients, *, time_str=None, reminder_date=None):
    if not admin_recipients or not user_summaries:
        return None
    pending_count = sum(1 for u in user_summaries if not u["completada"] and not u.get("disculpada", False))
    completed_count = sum(1 for u in user_summaries if u["completada"] or u.get("disculpada", False))
    total_count = len(user_summaries)
    if pending_count == 0:
        description = f"Todos los usuarios ({total_count}) completaron su inspeccion aleatoria del dia."
    else:
        description = (
            f"Resumen de inspecciones del dia: {completed_count}/{total_count} completadas, "
            f"{pending_count} pendiente(s)."
        )
    date_str = (reminder_date or today).isoformat()
    reminder_time = time_str or f"{RANDOM_INSPECTION_START_HOUR:02d}:00"
    return {
        "id": f"insp-admin-summary-{date_str}",
        "date": date_str,
        "time": reminder_time,
        "description": description,
        "creator": {"id": "sistema", "name": "Sistema"},
        "recipients": admin_recipients,
        "context": {
            "type": RANDOM_INSPECTION_CONTEXT_TYPE,
            "id": date_str,
            "label": f"Resumen inspecciones {date_str}",
            "detalle_usuarios": user_summaries,
        },
        "kind": RANDOM_INSPECTION_ADMIN_SUMMARY_KIND,
        "deadlineAt": "",
        "decision": {"status": "pendiente", "reason": "", "by": None, "at": ""},
        "createdAt": _iso_now(),
        "completedBy": [],
    }


def _upsert_random_inspection_admin_summary_reminder(store, today, *, time_str=None, reminder_date=None):
    inspections_today = list(
        InspeccionAleatoriaDiaria.objects
        .filter(fecha_programada=today)
        .select_related("usuario")
    )
    if not inspections_today:
        return False

    user_map = {}
    for inspection in inspections_today:
        user = inspection.usuario
        if user is None:
            continue
        user_id = str(int(user.id))
        is_completed = inspection.estado == InspeccionAleatoriaDiaria.Estados.COMPLETADA
        is_disculpada = bool(inspection.disculpada)
        nota_general = str(inspection.nota_general or "").strip()
        # Un usuario puede tener varias inspecciones el mismo dia (la
        # automatica, "enviar ahora", por division). Antes bastaba con que UNA
        # estuviera completada o disculpada para mostrarlo como terminado, y
        # quedaban ocultas otras a medio contar. Ahora tienen que estar todas.
        if user_id not in user_map:
            user_map[user_id] = {
                "id": user_id,
                "name": _format_user_display_name(user),
                "completada": is_completed,
                "disculpada": is_disculpada and not is_completed,
                "nota_general": nota_general,
            }
        else:
            current = user_map[user_id]
            all_closed = (
                (current["completada"] or current["disculpada"])
                and (is_completed or is_disculpada)
            )
            all_completed = current["completada"] and is_completed
            current["completada"] = all_completed
            current["disculpada"] = all_closed and not all_completed
            if nota_general:
                existing_note = user_map[user_id].get("nota_general") or ""
                user_map[user_id]["nota_general"] = (
                    f"{existing_note}; {nota_general}" if existing_note else nota_general
                )

    if not user_map:
        return False

    user_summaries = sorted(user_map.values(), key=lambda u: u["name"])
    admin_recipients = _get_random_inspection_verify_recipients()
    if not admin_recipients:
        return False

    reminder = _sanitize_reminder(
        _build_random_inspection_admin_summary_reminder(
            today, user_summaries, admin_recipients, time_str=time_str, reminder_date=reminder_date
        )
    )
    if reminder is None:
        return False

    all_completed = all(u["completada"] or u.get("disculpada", False) for u in user_summaries)
    existing_payload = list(store.payload) if isinstance(store.payload, list) else []
    reminder_id = _normalize_id(reminder.get("id"))

    target_index = None
    for index, existing in enumerate(existing_payload):
        if not isinstance(existing, dict):
            continue
        if _normalize_id(existing.get("id")) == reminder_id:
            target_index = index
            break
        if _normalize_id(existing.get("kind")) == RANDOM_INSPECTION_ADMIN_SUMMARY_KIND:
            check_date = (reminder_date or today).isoformat()
            if str(existing.get("date") or "").strip() == check_date:
                target_index = index
                break

    if target_index is not None:
        merged = _merge_reminder(existing_payload[target_index], reminder)
        if merged is None:
            return False
        admin_ids = sorted(r["id"] for r in admin_recipients)
        merged["completedBy"] = sorted(set(admin_ids)) if all_completed else []
        existing_payload[target_index] = merged
    else:
        admin_ids = sorted(r["id"] for r in admin_recipients)
        reminder["completedBy"] = sorted(set(admin_ids)) if all_completed else []
        existing_payload = [reminder, *existing_payload]

    normalized_payload = _normalize_reminder_list(existing_payload)
    changed = normalized_payload != (store.payload if isinstance(store.payload, list) else [])
    if changed:
        store.payload = normalized_payload
    return changed


def _inspection_scope_stock_rows(*, sucursal_id, producto_id, division_id=None, subdivision_id=None):
    queryset = Inventario.objects.select_for_update().filter(
        producto_id=int(producto_id),
        subdivision__division__bodega__sucursal_id=int(sucursal_id),
    )
    if division_id is not None:
        queryset = queryset.filter(subdivision__division_id=int(division_id))
    if subdivision_id is not None:
        queryset = queryset.filter(subdivision_id=int(subdivision_id))
    return queryset.order_by("id")


def _take_from_inventory_rows(rows, required):
    remaining = int(required)
    for row in rows:
        if remaining <= 0:
            break
        current_qty = int(row.cantidad or 0)
        take = min(current_qty, remaining)
        if take <= 0:
            continue
        row.cantidad = current_qty - take
        row.save(update_fields=["cantidad"])
        remaining -= take
    return remaining


def _adjust_inventory_for_inspection_verification(
    *, sucursal_id, producto_id, delta, division_id=None, subdivision_id=None
):
    delta = int(delta or 0)
    if delta == 0:
        return

    stock_queryset = _inspection_scope_stock_rows(
        sucursal_id=sucursal_id,
        producto_id=producto_id,
        division_id=division_id,
        subdivision_id=subdivision_id,
    )

    if delta < 0:
        required = abs(delta)
        rows = list(stock_queryset)
        available = sum(int(item.cantidad or 0) for item in rows)
        if available < required:
            raise ValidationError(
                {
                    "detail": (
                        "No hay suficiente inventario actual para aplicar la reduccion confirmada."
                    )
                }
            )
        _take_from_inventory_rows(rows, required)
        return

    target = stock_queryset.filter(cantidad__gt=0).first() or stock_queryset.first()
    if target is not None:
        target.cantidad = int(target.cantidad or 0) + delta
        target.save(update_fields=["cantidad"])
        return

    subdivisions = SubDivision.objects.select_related("division__bodega").filter(
        division__bodega__sucursal_id=int(sucursal_id)
    )
    if division_id is not None:
        subdivisions = subdivisions.filter(division_id=int(division_id))
    if subdivision_id is not None:
        subdivisions = subdivisions.filter(pk=int(subdivision_id))
    subdivision = subdivisions.order_by("id").first()
    if subdivision is None:
        raise ValidationError(
            {
                "detail": (
                    "La sucursal no tiene subdivisiones configuradas para ajustar inventario."
                )
            }
        )

    inventory_row, _ = Inventario.objects.select_for_update().get_or_create(
        subdivision=subdivision,
        producto_id=int(producto_id),
        referencia="",
        defaults={"cantidad": 0},
    )
    inventory_row.cantidad = int(inventory_row.cantidad or 0) + delta
    inventory_row.save(update_fields=["cantidad"])


def _adjust_inventory_at_subdivision(
    *, subdivision_id, sucursal_id, producto_id, delta, division_id=None, scope_subdivision_id=None
):
    """Aplica `delta` en la ubicacion contada (y no en "la primera por id").

    Si al restar esa ubicacion ya no tiene suficiente (se movio stock despues
    del conteo), el faltante se toma del resto del alcance.
    """
    delta = int(delta or 0)
    if delta == 0:
        return

    location_rows = list(
        Inventario.objects.select_for_update()
        .filter(
            producto_id=int(producto_id),
            subdivision_id=int(subdivision_id),
            subdivision__division__bodega__sucursal_id=int(sucursal_id),
        )
        .order_by("id")
    )

    if delta > 0:
        if location_rows:
            target = location_rows[0]
            target.cantidad = int(target.cantidad or 0) + delta
            target.save(update_fields=["cantidad"])
            return
        if not SubDivision.objects.filter(
            pk=int(subdivision_id), division__bodega__sucursal_id=int(sucursal_id)
        ).exists():
            _adjust_inventory_for_inspection_verification(
                sucursal_id=sucursal_id,
                producto_id=producto_id,
                delta=delta,
                division_id=division_id,
                subdivision_id=scope_subdivision_id,
            )
            return
        inventory_row, _ = Inventario.objects.select_for_update().get_or_create(
            subdivision_id=int(subdivision_id),
            producto_id=int(producto_id),
            referencia="",
            defaults={"cantidad": 0},
        )
        inventory_row.cantidad = int(inventory_row.cantidad or 0) + delta
        inventory_row.save(update_fields=["cantidad"])
        return

    remaining = _take_from_inventory_rows(location_rows, abs(delta))
    if remaining > 0:
        _adjust_inventory_for_inspection_verification(
            sucursal_id=sucursal_id,
            producto_id=producto_id,
            delta=-remaining,
            division_id=division_id,
            subdivision_id=scope_subdivision_id,
        )


def _valid_location_counts(item):
    entries = item.conteo_ubicaciones if isinstance(item.conteo_ubicaciones, list) else []
    valid = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        subdivision_id = _normalize_int(entry.get("subdivision_id"), 0)
        contada = entry.get("cantidad_contada")
        sistema = entry.get("cantidad_sistema")
        if subdivision_id <= 0 or contada is None or sistema is None:
            continue
        valid.append(
            {
                "subdivision_id": subdivision_id,
                "cantidad_contada": max(0, _normalize_int(contada, 0)),
                "cantidad_sistema": max(0, _normalize_int(sistema, 0)),
            }
        )
    return valid


def _apply_random_inspection_adjustment(item, cantidad_confirmada, confirmed_by_location=None):
    """Deja el stock en lo confirmado, medido contra el stock AL CONTAR.

    delta = confirmado - stock_al_contar, aplicado al stock actual: asi las
    ventas/entradas hechas entre el conteo y la aprobacion no se cuentan dos
    veces. Si el conteo fue por ubicacion, cada ubicacion queda corregida por
    separado: con la cantidad que el admin confirmo para cada una
    (`confirmed_by_location` = {subdivision_id: cantidad}) o, si no la paso,
    con lo contado cuando el total confirmado coincide con lo contado.
    """
    division_id = _inspection_division_scope(item.inspeccion)
    scope_subdivision_id = _inspection_subdivision_scope(item.inspeccion)
    total_delta = int(cantidad_confirmada) - int(item.cantidad_esperada or 0)
    location_counts = _valid_location_counts(item)
    if confirmed_by_location:
        location_counts = [
            {
                **entry,
                "cantidad_contada": int(
                    confirmed_by_location.get(entry["subdivision_id"], entry["cantidad_contada"])
                ),
            }
            for entry in location_counts
        ]
    applied = 0
    per_location = []
    if location_counts and int(cantidad_confirmada) == sum(
        entry["cantidad_contada"] for entry in location_counts
    ):
        # Primero las restas: si algo no alcanza, falla antes de sumar nada.
        ordered = sorted(
            location_counts,
            key=lambda entry: entry["cantidad_contada"] - entry["cantidad_sistema"],
        )
        for entry in ordered:
            location_delta = entry["cantidad_contada"] - entry["cantidad_sistema"]
            if location_delta == 0:
                continue
            _adjust_inventory_at_subdivision(
                subdivision_id=entry["subdivision_id"],
                sucursal_id=item.sucursal_id,
                producto_id=item.producto_id,
                delta=location_delta,
                division_id=division_id,
                scope_subdivision_id=scope_subdivision_id,
            )
            applied += location_delta
            per_location.append({"subdivision_id": entry["subdivision_id"], "delta": location_delta})

    residual = total_delta - applied
    if residual:
        _adjust_inventory_for_inspection_verification(
            sucursal_id=item.sucursal_id,
            producto_id=item.producto_id,
            delta=residual,
            division_id=division_id,
            subdivision_id=scope_subdivision_id,
        )
    return {"delta_total": total_delta, "por_ubicacion": per_location, "residual": residual}


def _relocate_random_inspection_item(item):
    """Total correcto pero repartido distinto: corrige solo las ubicaciones.

    No cambia la cantidad total (suma 0), por eso no pasa por verificacion.
    Solo aplica si se contaron todas las ubicaciones con stock del producto.
    """
    location_counts = _valid_location_counts(item)
    if len(location_counts) < 2:
        return None
    if sum(entry["cantidad_sistema"] for entry in location_counts) != int(item.cantidad_esperada or 0):
        return None
    if sum(entry["cantidad_contada"] for entry in location_counts) != int(item.cantidad_esperada or 0):
        return None
    if all(entry["cantidad_contada"] == entry["cantidad_sistema"] for entry in location_counts):
        return None
    return _apply_random_inspection_adjustment(item, int(item.cantidad_esperada or 0))


def _move_inspection_item_stock(item, target_subdivision):
    """"No lo encontre" + el admin sabe donde esta: mueve todo el stock del
    producto que hay en el alcance revisado a `target_subdivision`."""
    rows = list(
        _inspection_scope_stock_rows(
            sucursal_id=item.sucursal_id,
            producto_id=item.producto_id,
            division_id=_inspection_division_scope(item.inspeccion),
            subdivision_id=_inspection_subdivision_scope(item.inspeccion),
        ).exclude(subdivision_id=int(target_subdivision.id))
    )
    moved = 0
    origins = []
    for row in rows:
        quantity = int(row.cantidad or 0)
        if quantity <= 0:
            continue
        origins.append({"subdivision_id": int(row.subdivision_id), "cantidad": quantity})
        moved += quantity
        row.cantidad = 0
        row.save(update_fields=["cantidad"])
    if moved:
        target_row, _ = Inventario.objects.select_for_update().get_or_create(
            subdivision=target_subdivision,
            producto_id=int(item.producto_id),
            referencia="",
            defaults={"cantidad": 0},
        )
        target_row.cantidad = int(target_row.cantidad or 0) + moved
        target_row.save(update_fields=["cantidad"])
    return {"cantidad": moved, "origenes": origins}


def _record_random_inspection_audit(item, actor_user, detalle, valores):
    from django.contrib.contenttypes.models import ContentType

    from auditoria.models import RegistroAuditoria

    RegistroAuditoria.objects.create(
        usuario=actor_user if getattr(actor_user, "is_authenticated", False) else None,
        accion=RegistroAuditoria.Acciones.OTRO,
        content_type=ContentType.objects.get_for_model(InspeccionAleatoriaItem),
        object_id=str(item.pk),
        representacion_objeto=str(item)[:255],
        valores_nuevos=valores,
        detalles=detalle,
    )


def _pending_warranty_quantities(keys):
    """Unidades en salidas de garantia aun sin aprobar por (sucursal, producto).

    Esas salidas no descuentan stock hasta que el admin las acepta, pero el
    producto ya puede no estar fisicamente: explica faltantes al contar.
    """
    from movimientos.models import DetalleMovimiento, MovimientoInventario  # Import tardio

    if not keys:
        return {}
    rows = (
        DetalleMovimiento.objects.filter(
            movimiento_inventario__garantia_pendiente=True,
            movimiento_inventario__estado_garantia=MovimientoInventario.EstadoGarantia.SOLICITADA,
            movimiento_inventario__sucursal_id__in=sorted({branch_id for branch_id, _ in keys}),
            producto_id__in=sorted({product_id for _, product_id in keys}),
        )
        .values("movimiento_inventario__sucursal_id", "producto_id")
        .annotate(total=Sum("cantidad"))
    )
    return {
        (
            _normalize_int(row.get("movimiento_inventario__sucursal_id"), 0),
            _normalize_int(row.get("producto_id"), 0),
        ): max(0, _normalize_int(row.get("total"), 0))
        for row in rows
    }


def _subdivision_stock_quantities(subdivision_ids, product_ids):
    if not subdivision_ids or not product_ids:
        return {}
    rows = (
        Inventario.objects.filter(
            subdivision_id__in=sorted(subdivision_ids),
            producto_id__in=sorted(product_ids),
        )
        .values("subdivision_id", "producto_id")
        .annotate(total=Sum("cantidad"))
    )
    return {
        (_normalize_int(row.get("subdivision_id"), 0), _normalize_int(row.get("producto_id"), 0)):
            max(0, _normalize_int(row.get("total"), 0))
        for row in rows
    }


def _parse_random_inspection_location_counts(raw_value):
    """Normaliza el conteo por ubicacion que manda el cliente.

    Acepta [{key, subdivision_id, cantidad}] o {key: cantidad}. Devuelve None
    si no vino (para no pisar lo guardado) y [] si vino vacio.
    """
    if raw_value is None:
        return None
    if isinstance(raw_value, dict):
        raw_value = [{"key": key, "cantidad": value} for key, value in raw_value.items()]
    if not isinstance(raw_value, list):
        return None
    parsed = []
    seen = set()
    for entry in raw_value[:100]:
        if not isinstance(entry, dict):
            continue
        key = _normalize_text(entry.get("key"))[:300]
        subdivision_id = _normalize_int(entry.get("subdivision_id"), 0) or None
        if not key and not subdivision_id:
            continue
        identity = (key, subdivision_id)
        if identity in seen:
            continue
        seen.add(identity)
        raw_qty = entry.get("cantidad", entry.get("cantidad_contada"))
        quantity = None
        if raw_qty is not None and str(raw_qty).strip() != "":
            quantity = _normalize_int(raw_qty, -1)
            if quantity < 0:
                quantity = None
        parsed.append(
            {"key": key, "subdivision_id": subdivision_id, "cantidad_contada": quantity}
        )
    return parsed


def _parse_optional_quantity(raw_value):
    if raw_value is None or str(raw_value).strip() == "":
        return None
    quantity = _normalize_int(raw_value, -1)
    return quantity if quantity >= 0 else -1


# Health check usado por Render para verificar que el servicio esté vivo.
def ping(request):
    return JsonResponse({"message": "pong", "framework": "Django"})


TABLE_LAYOUT_SCOPE_SET = {"local", "session"}
TABLE_LAYOUT_KEY_PATTERN = re.compile(
    r"^(?P<scope>local|session):(?P<key>[a-z0-9][a-z0-9_-]{0,119}-table-(?:columns|state)(?:-[a-z0-9_-]{1,40})?)$",
    re.IGNORECASE,
)
MAX_TABLE_LAYOUT_ENTRIES_PER_USER = 300
MAX_TABLE_LAYOUT_VALUE_LENGTH = 120_000


def _normalize_table_layout_composite_key(raw_value):
    text = _normalize_text(raw_value)
    if not text:
        return ""

    match = TABLE_LAYOUT_KEY_PATTERN.match(text)
    if not match:
        return ""

    scope = _normalize_text(match.group("scope")).lower()
    key = _normalize_text(match.group("key"))
    if scope not in TABLE_LAYOUT_SCOPE_SET or not key:
        return ""
    return f"{scope}:{key}"


def _normalize_table_layout_value(raw_value, *, allow_null=False):
    if raw_value is None:
        return None if allow_null else ""

    if isinstance(raw_value, str):
        value = raw_value
    else:
        try:
            value = json.dumps(raw_value, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            return None

    if len(value) > MAX_TABLE_LAYOUT_VALUE_LENGTH:
        return None
    return value


def _sanitize_table_layout_map(raw_map):
    if not isinstance(raw_map, dict):
        return {}

    cleaned = {}
    for raw_key, raw_value in raw_map.items():
        key = _normalize_table_layout_composite_key(raw_key)
        if not key:
            continue
        value = _normalize_table_layout_value(raw_value)
        if value is None:
            continue
        cleaned[key] = value
        if len(cleaned) >= MAX_TABLE_LAYOUT_ENTRIES_PER_USER:
            break
    return cleaned


USER_THEMES = {"light", "dark"}


class UserThemeAPIView(APIView):
    """Tema claro/oscuro del usuario, guardado en la base (no en el navegador)."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        preference = UsuarioPreferencia.objects.filter(usuario=request.user).only("tema").first()
        tema = str(getattr(preference, "tema", "") or "")
        return Response({"tema": tema if tema in USER_THEMES else ""}, status=status.HTTP_200_OK)

    def put(self, request):
        tema = _normalize_text(request.data.get("tema")).lower()
        if tema not in USER_THEMES:
            return Response(
                {"detail": "El tema debe ser `light` o `dark`."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        preference, _ = UsuarioPreferencia.objects.get_or_create(usuario=request.user)
        if preference.tema != tema:
            preference.tema = tema
            preference.save(update_fields=["tema", "updated_at"])
        return Response({"tema": tema}, status=status.HTTP_200_OK)


class UserTableLayoutsAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        with transaction.atomic():
            preference, _ = UsuarioPreferencia.objects.select_for_update().get_or_create(
                usuario=request.user
            )
            normalized_layouts = _sanitize_table_layout_map(
                getattr(preference, "table_layouts", {})
            )
            if normalized_layouts != getattr(preference, "table_layouts", {}):
                preference.table_layouts = normalized_layouts
                preference.save(update_fields=["table_layouts", "updated_at"])

        return Response(
            {
                "layouts": normalized_layouts,
                "updated_at": preference.updated_at,
            },
            status=status.HTTP_200_OK,
        )

    def put(self, request):
        incoming_layouts = request.data.get("layouts")
        if not isinstance(incoming_layouts, dict):
            return Response(
                {
                    "detail": (
                        "Debes enviar un objeto en `layouts` con claves `local:<key>` o "
                        "`session:<key>`."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        errors = {}
        normalized_updates = {}
        for raw_key, raw_value in incoming_layouts.items():
            key = _normalize_table_layout_composite_key(raw_key)
            if not key:
                errors[str(raw_key)] = (
                    "Clave invalida. Usa `local:<tabla-table-columns>` o "
                    "`session:<tabla-table-state>`."
                )
                continue

            value = _normalize_table_layout_value(raw_value, allow_null=True)
            if raw_value is not None and value is None:
                errors[key] = (
                    "El valor del layout es invalido o supera el tamaño permitido."
                )
                continue

            normalized_updates[key] = value

        if errors:
            return Response(
                {"detail": "No se pudo guardar uno o más layouts.", "errors": errors},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            preference, _ = UsuarioPreferencia.objects.select_for_update().get_or_create(
                usuario=request.user
            )
            current_layouts = _sanitize_table_layout_map(
                getattr(preference, "table_layouts", {})
            )

            for key, value in normalized_updates.items():
                if value is None:
                    current_layouts.pop(key, None)
                    continue
                current_layouts[key] = value

            if len(current_layouts) > MAX_TABLE_LAYOUT_ENTRIES_PER_USER:
                return Response(
                    {
                        "detail": (
                            "Se supero el limite de layouts por usuario. "
                            "Elimina algunos y vuelve a intentar."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

            preference.table_layouts = current_layouts
            preference.save(update_fields=["table_layouts", "updated_at"])

        return Response(
            {
                "layouts": current_layouts,
                "updated_at": preference.updated_at,
            },
            status=status.HTTP_200_OK,
        )


_INSPECTION_CHECK_THROTTLE = timedelta(seconds=60)
_last_inspection_check_by_user = {}
# Clave para la generacion de inspecciones de todos los revisores, con el
# mismo limite de una vez por minuto (por proceso).
_ALL_USERS_INSPECTION_CHECK_KEY = "__todos__"


def _annotate_random_inspection_progress(reminders):
    """Marca `context.en_progreso` en los recordatorios de inspeccion aleatoria.

    Se calcula al leer, desde la base (borrador guardado en el servidor), y no
    se escribe en ReminderState: antes salia de un borrador en localStorage
    que ya no existe, asi que el aviso "en progreso" nunca se encendia.
    """
    inspection_ids = set()
    for reminder in reminders:
        context = reminder.get("context") if isinstance(reminder, dict) else None
        if not isinstance(context, dict):
            continue
        if _normalize_id(context.get("type")) != RANDOM_INSPECTION_CONTEXT_TYPE:
            continue
        inspection_id = _normalize_int(context.get("id"), 0)
        if inspection_id > 0:
            inspection_ids.add(inspection_id)
    if not inspection_ids:
        return reminders

    in_progress_ids = {
        int(pk)
        for pk in InspeccionAleatoriaDiaria.objects.filter(
            pk__in=inspection_ids, borrador_version__gt=0
        ).values_list("pk", flat=True)
    }
    annotated = []
    for reminder in reminders:
        context = reminder.get("context") if isinstance(reminder, dict) else None
        if (
            isinstance(context, dict)
            and _normalize_id(context.get("type")) == RANDOM_INSPECTION_CONTEXT_TYPE
        ):
            inspection_id = _normalize_int(context.get("id"), 0)
            reminder = {
                **reminder,
                "context": {**context, "en_progreso": inspection_id in in_progress_ids},
            }
        annotated.append(reminder)
    return annotated


class ReminderStateAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        # El frontend sondea este endpoint cada 4 segundos, por cada usuario
        # conectado (ver REMINDERS_POLL_MS). Tomar select_for_update() sobre
        # la unica fila global en cada uno de esos polls serializa a todos
        # los usuarios entre si -- y si UNA sola consulta se cuelga (una
        # conexion de red rota, por ejemplo), el resto se apila detras
        # esperando el mismo bloqueo hasta tumbar el servicio (ver incidente
        # de app_reminderstate). Por eso: una lectura normal, sin bloqueo,
        # cubre el caso comun de "nada cambio"; el bloqueo solo se toma
        # cuando de verdad hace falta escribir. La revision de inspeccion
        # aleatoria / resumen admin (la unica parte que puede crear filas
        # nuevas) se limita a como mucho una vez por minuto por usuario en
        # vez de en cada poll -- no cambia que hace, solo cada cuanto se
        # invoca.
        store = ReminderState.get_global(for_update=False)
        current_payload = (
            store.payload
            if isinstance(store.payload, list)
            else []
        )
        reminders = _normalize_reminder_list(current_payload)
        reminders, transfer_history_changed = _hydrate_transfer_history_from_solicitudes(reminders)
        reminders, urgente_changed = _hydrate_urgente_from_solicitudes(reminders)
        needs_write = reminders != current_payload or transfer_history_changed or urgente_changed

        user_id = getattr(request.user, "id", None)
        now = timezone.now()
        last_checked = _last_inspection_check_by_user.get(user_id)
        due_for_inspection_check = last_checked is None or (now - last_checked) >= _INSPECTION_CHECK_THROTTLE

        if needs_write or due_for_inspection_check:
            with transaction.atomic():
                store = ReminderState.get_global(for_update=True)
                current_payload = (
                    store.payload
                    if isinstance(store.payload, list)
                    else []
                )
                reminders = _normalize_reminder_list(current_payload)
                reminders, transfer_history_changed = _hydrate_transfer_history_from_solicitudes(
                    reminders
                )
                reminders, urgente_changed = _hydrate_urgente_from_solicitudes(reminders)
                payload_changed = reminders != current_payload or transfer_history_changed or urgente_changed
                if payload_changed:
                    store.payload = reminders

                if due_for_inspection_check:
                    _last_inspection_check_by_user[user_id] = now
                    _, inspection_payload_changed = _ensure_daily_random_inspection_for_user(
                        request.user,
                        store,
                    )
                    last_all_checked = _last_inspection_check_by_user.get(
                        _ALL_USERS_INSPECTION_CHECK_KEY
                    )
                    if (
                        last_all_checked is None
                        or (now - last_all_checked) >= _INSPECTION_CHECK_THROTTLE
                    ):
                        _last_inspection_check_by_user[_ALL_USERS_INSPECTION_CHECK_KEY] = now
                        inspection_payload_changed = (
                            _ensure_daily_random_inspections_for_all_users(store)
                            or inspection_payload_changed
                        )
                        inspection_payload_changed = (
                            _purge_orphan_random_inspection_reminders(store)
                            or inspection_payload_changed
                        )
                    summary_changed = _ensure_all_admin_summaries(request.user, store)
                    payload_changed = payload_changed or inspection_payload_changed or summary_changed

                if payload_changed:
                    store.save(update_fields=["payload", "updated_at"])
                reminders = _normalize_reminder_list(store.payload)
                reminders, transfer_history_changed = _hydrate_transfer_history_from_solicitudes(
                    reminders
                )
                reminders, urgente_changed2 = _hydrate_urgente_from_solicitudes(reminders)
                if transfer_history_changed or urgente_changed2:
                    store.payload = reminders
                    store.save(update_fields=["payload", "updated_at"])

        return Response(
            {
                "reminders": _annotate_random_inspection_progress(reminders),
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
        incoming, _ = _hydrate_transfer_history_from_solicitudes(incoming)

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            existing = _normalize_reminder_list(store.payload)
            existing, _ = _hydrate_transfer_history_from_solicitudes(existing)
            existing_by_id = {
                _normalize_id(item.get("id")): item
                for item in existing
                if _normalize_id(item.get("id"))
            }

            can_create_product_inventory = _can_create_product_inventory_reminders(
                request.user
            )
            if not can_create_product_inventory:
                for reminder in incoming:
                    reminder_id = _normalize_id(reminder.get("id"))
                    if reminder_id in existing_by_id:
                        continue

                    context = (
                        reminder.get("context")
                        if isinstance(reminder.get("context"), dict)
                        else {}
                    )
                    context_type = _normalize_context_type(context.get("type"))
                    if context_type in {"producto", "inventario"}:
                        return Response(
                            {
                                "detail": (
                                    "No tienes permisos para crear recordatorios en "
                                    "productos o inventario."
                                )
                            },
                            status=status.HTTP_403_FORBIDDEN,
                        )

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
            merged, _ = _hydrate_transfer_history_from_solicitudes(merged)

            store.payload = merged
            store.save(update_fields=["payload", "updated_at"])

        return Response(
            {
                "reminders": _annotate_random_inspection_progress(merged),
                "updated_at": store.updated_at,
            },
            status=status.HTTP_200_OK,
        )


def _normalize_random_inspection_verify_action(value):
    normalized = _normalize_text(value).lower()
    if normalized in {"aprobar", "aprobada", "confirmar", "ajustar"}:
        return "aprobar"
    if normalized in {"rechazar", "rechazada", "descartar"}:
        return "rechazar"
    if normalized in {"reubicar", "reubicada", "mover"}:
        return "reubicar"
    return ""


def _get_random_inspection_queryset():
    return (
        InspeccionAleatoriaDiaria.objects.select_related("usuario", "division", "subdivision")
        .prefetch_related("items__sucursal", "items__producto", "items__verificado_por")
        .order_by("-fecha_programada", "-id")
    )


def _can_access_random_inspection(user, inspection):
    if inspection is None or user is None or not getattr(user, "is_authenticated", False):
        return False
    if int(inspection.usuario_id) == int(user.id):
        return True
    return _can_verify_random_inspection(user)


class RandomInspectionCurrentAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            payload = store.payload if isinstance(store.payload, list) else []
            normalized_payload = _normalize_reminder_list(payload)
            payload_changed = normalized_payload != payload
            if payload_changed:
                store.payload = normalized_payload

            inspection, inspection_payload_changed = _ensure_daily_random_inspection_for_user(
                request.user,
                store,
            )
            payload_changed = payload_changed or inspection_payload_changed

            if payload_changed:
                store.save(update_fields=["payload", "updated_at"])

        if inspection is None:
            return Response(
                {"inspection": None, "detail": "No hay inspeccion aleatoria para este usuario."},
                status=status.HTTP_200_OK,
            )

        inspection = (
            _get_random_inspection_queryset()
            .filter(pk=inspection.pk)
            .first()
        )
        if inspection is None:
            return Response(
                {"inspection": None, "detail": "No se encontro la inspeccion aleatoria."},
                status=status.HTTP_404_NOT_FOUND,
            )

        return Response(
            {"inspection": _serialize_random_inspection(inspection, viewer=request.user)},
            status=status.HTTP_200_OK,
        )


class RandomInspectionDetailAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, inspection_id):
        inspection = (
            _get_random_inspection_queryset()
            .filter(pk=inspection_id)
            .first()
        )
        if inspection is None:
            return Response(
                {"detail": "No se encontro la inspeccion aleatoria."},
                status=status.HTTP_404_NOT_FOUND,
            )

        if not _can_access_random_inspection(request.user, inspection):
            return Response(
                {"detail": "No tienes permiso para acceder a esta inspeccion."},
                status=status.HTTP_403_FORBIDDEN,
            )

        return Response(
            {"inspection": _serialize_random_inspection(inspection, viewer=request.user)},
            status=status.HTTP_200_OK,
        )


RANDOM_INSPECTION_DRAFT_PHASES = {"", "conteo", "resumen", "correccion"}
RANDOM_INSPECTION_CONFLICT_DETAIL = (
    "Esta inspeccion se actualizo desde otro dispositivo. Se cargaron los datos "
    "mas recientes: revisalos antes de continuar."
)


def _parse_client_draft_version(data):
    raw_value = data.get("version") if hasattr(data, "get") else None
    if raw_value is None or str(raw_value).strip() == "":
        return None
    version = _normalize_int(raw_value, -1)
    return version if version >= 0 else None


def _lock_random_inspection(inspection_id):
    # of=("self",): la division es opcional (LEFT JOIN) y Postgres no permite
    # FOR UPDATE sobre el lado nulo de un OUTER JOIN.
    return (
        InspeccionAleatoriaDiaria.objects.select_for_update(of=("self",))
        .select_related("usuario", "division", "subdivision")
        .filter(pk=inspection_id)
        .first()
    )


def _random_inspection_conflict_response(inspection_id, request):
    inspection = _get_random_inspection_queryset().filter(pk=inspection_id).first()
    return Response(
        {
            "detail": RANDOM_INSPECTION_CONFLICT_DETAIL,
            "conflict": True,
            "inspection": (
                _serialize_random_inspection(inspection, viewer=request.user)
                if inspection is not None
                else None
            ),
        },
        status=status.HTTP_409_CONFLICT,
    )


def _random_inspection_completed_response():
    return Response(
        {
            "detail": "Esta inspeccion ya fue enviada y no puede volver a realizarse.",
            "completed": True,
        },
        status=status.HTTP_409_CONFLICT,
    )


class RandomInspectionRespondAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, inspection_id):
        payload_items = request.data.get("items")
        if not isinstance(payload_items, list):
            return Response(
                {"detail": "Debes enviar un arreglo en `items`."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            inspection = _lock_random_inspection(inspection_id)
            if inspection is None:
                return Response(
                    {"detail": "No se encontro la inspeccion aleatoria."},
                    status=status.HTTP_404_NOT_FOUND,
                )

            if int(inspection.usuario_id) != int(request.user.id):
                return Response(
                    {"detail": "Solo el usuario asignado puede responder esta inspeccion."},
                    status=status.HTTP_403_FORBIDDEN,
                )

            if not _is_random_inspection_pending(inspection):
                return _random_inspection_completed_response()

            # Un dispositivo que quedo con datos viejos (la misma cuenta abierta
            # en la compu y en la tablet) no puede enviar: sus diferencias
            # saldrian calculadas con cantidades que ya cambiaron en el otro.
            client_version = _parse_client_draft_version(request.data)
            if client_version is not None and client_version != int(inspection.borrador_version or 0):
                return _random_inspection_conflict_response(inspection.id, request)

            inspection_items = list(
                inspection.items.select_related("sucursal", "producto").order_by("id")
            )
            if not inspection_items:
                return Response(
                    {"detail": "La inspeccion no tiene productos para revisar."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            payload_by_id = {}
            for row in payload_items:
                if not isinstance(row, dict):
                    continue
                item_id = _normalize_int(row.get("id"), 0)
                if item_id > 0:
                    payload_by_id[item_id] = row

            missing_item_ids = [
                int(item.id)
                for item in inspection_items
                if int(item.id) not in payload_by_id
            ]
            if missing_item_ids:
                return Response(
                    {
                        "detail": (
                            "Debes responder todos los productos de la inspeccion antes de guardar."
                        ),
                        "items_faltantes": missing_item_ids,
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

            division_id = _inspection_division_scope(inspection)
            subdivision_id = _inspection_subdivision_scope(inspection)
            keys = {(int(item.sucursal_id), int(item.producto_id)) for item in inspection_items}
            # Bloquea el stock de estos productos para que la "foto" del
            # sistema al contar sea consistente con lo que se guarda.
            list(
                _inspection_stock_queryset(
                    branch_ids={branch_id for branch_id, _ in keys},
                    product_ids={product_id for _, product_id in keys},
                    division_id=division_id,
                    subdivision_id=subdivision_id,
                )
                .select_for_update()
                .values_list("id", flat=True)
            )
            live_expected = _live_expected_quantities(
                inspection_items, division_id=division_id, subdivision_id=subdivision_id
            )
            _attach_random_inspection_locations(
                inspection_items, division_id=division_id, subdivision_id=subdivision_id
            )

            # 1a pasada: cantidades y conteo por ubicacion de cada producto.
            parsed_rows = {}
            subdivision_ids = set()
            for item in inspection_items:
                row = payload_by_id.get(int(item.id), {})
                location_counts = _parse_random_inspection_location_counts(
                    row.get("cantidad_por_ubicacion")
                )
                if location_counts is None:
                    location_counts = _parse_random_inspection_location_counts(
                        item.conteo_ubicaciones
                    ) or []
                locations_complete = len(location_counts) > 1 and all(
                    entry["cantidad_contada"] is not None for entry in location_counts
                )

                not_found = (
                    bool(row.get("no_encontrado")) if "no_encontrado" in row else bool(item.no_encontrado)
                )
                reported = _parse_optional_quantity(row.get("cantidad_reportada"))
                if locations_complete:
                    reported = sum(entry["cantidad_contada"] for entry in location_counts)
                if not_found:
                    # "No lo encontre" cuenta como 0 en todas las ubicaciones.
                    reported = 0
                    location_counts = [{**entry, "cantidad_contada": 0} for entry in location_counts]
                    locations_complete = len(location_counts) > 1
                if reported is None:
                    legacy_state = _normalize_random_inspection_review_state(
                        row.get("estado_revision") or row.get("estado") or row.get("resultado")
                    )
                    if legacy_state == InspeccionAleatoriaItem.EstadosRevision.COINCIDE:
                        reported = int(item.cantidad_esperada or 0)
                if reported is None:
                    return Response(
                        {
                            "detail": "Debes ingresar la cantidad contada de todos los productos.",
                            "item_id": int(item.id),
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if reported < 0:
                    return Response(
                        {
                            "detail": "La cantidad reportada debe ser un numero valido.",
                            "item_id": int(item.id),
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                if not locations_complete:
                    stocked_locations = [
                        location
                        for location in (
                            getattr(item, "_inspection_location_payload", {}) or {}
                        ).get("ubicaciones_bodega", [])
                        if location.get("subdivision_id") and int(location.get("cantidad") or 0) > 0
                    ]
                    if len(stocked_locations) == 1:
                        # Una sola ubicacion: el conteo total ES el de esa ubicacion.
                        location_counts = [
                            {
                                "key": "",
                                "subdivision_id": int(stocked_locations[0]["subdivision_id"]),
                                "cantidad_contada": int(reported),
                            }
                        ]
                        locations_complete = True
                    else:
                        location_counts = [
                            entry for entry in location_counts if entry["cantidad_contada"] is not None
                        ]
                        locations_complete = False

                for entry in location_counts:
                    if entry.get("subdivision_id"):
                        subdivision_ids.add(int(entry["subdivision_id"]))
                parsed_rows[int(item.id)] = {
                    "row": row,
                    "not_found": not_found,
                    "reported": int(reported),
                    "location_counts": location_counts,
                    "locations_complete": locations_complete,
                }

            subdivision_stock = _subdivision_stock_quantities(
                subdivision_ids,
                {product_id for _, product_id in keys},
            )
            pending_warranty = _pending_warranty_quantities(keys)

            # 2a pasada: se compara contra el stock del sistema AHORA (al contar).
            now = timezone.now()
            mismatch_count = 0
            for item in inspection_items:
                parsed = parsed_rows[int(item.id)]
                row = parsed["row"]
                key = (int(item.sucursal_id), int(item.producto_id))
                system_qty = int(live_expected.get(key, 0))
                reported = parsed["reported"]

                location_counts = []
                for entry in parsed["location_counts"]:
                    subdivision_id = entry.get("subdivision_id")
                    location_counts.append(
                        {
                            "key": entry.get("key", ""),
                            "subdivision_id": subdivision_id,
                            "cantidad_contada": entry.get("cantidad_contada"),
                            "cantidad_sistema": (
                                subdivision_stock.get((int(subdivision_id), int(item.producto_id)), 0)
                                if subdivision_id and parsed["locations_complete"]
                                else None
                            ),
                        }
                    )

                if reported == system_qty:
                    estado_revision = InspeccionAleatoriaItem.EstadosRevision.COINCIDE
                    verificacion_estado = InspeccionAleatoriaItem.EstadosVerificacion.SIN_NOVEDAD
                else:
                    estado_revision = InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE
                    verificacion_estado = InspeccionAleatoriaItem.EstadosVerificacion.PENDIENTE
                    mismatch_count += 1

                if "observacion" in row or "novedad" in row:
                    observacion = _normalize_text(row.get("observacion") or row.get("novedad"))
                else:
                    observacion = _normalize_text(item.observacion)
                warranty_qty = pending_warranty.get(key, 0)
                if estado_revision == InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE and reported < system_qty and warranty_qty:
                    note = (
                        f"[Sistema] Hay {warranty_qty} unidad(es) en salidas de garantia "
                        "pendientes de aprobacion que aun no descuentan stock."
                    )
                    observacion = f"{observacion}\n{note}".strip() if observacion else note

                item.estado_revision = estado_revision
                item.no_encontrado = bool(parsed["not_found"])
                item.cantidad_esperada = system_qty
                item.cantidad_reportada = reported
                if item.cantidad_primer_conteo is None:
                    item.cantidad_primer_conteo = reported
                item.conteo_ubicaciones = location_counts
                item.observacion = observacion
                item.revisado_en = now
                item.verificacion_estado = verificacion_estado
                item.updated_at = now

            InspeccionAleatoriaItem.objects.bulk_update(
                inspection_items,
                [
                    "estado_revision",
                    "no_encontrado",
                    "cantidad_esperada",
                    "cantidad_reportada",
                    "cantidad_primer_conteo",
                    "conteo_ubicaciones",
                    "observacion",
                    "revisado_en",
                    "verificacion_estado",
                    "updated_at",
                ],
            )

            for item in inspection_items:
                if item.estado_revision != InspeccionAleatoriaItem.EstadosRevision.COINCIDE:
                    continue
                relocation = _relocate_random_inspection_item(item)
                if relocation:
                    _record_random_inspection_audit(
                        item,
                        request.user,
                        "Reubicacion por inspeccion aleatoria: el total coincide pero "
                        "el conteo por ubicacion no; se corrigio cada ubicacion.",
                        relocation,
                    )

            if "nota_general" in request.data:
                nota_general = _normalize_text(request.data.get("nota_general"))
            else:
                nota_general = (
                    _normalize_text(inspection.borrador_nota_general)
                    if inspection.borrador_tiene_novedad
                    else ""
                )

            inspection.estado = InspeccionAleatoriaDiaria.Estados.COMPLETADA
            inspection.total_items = len(inspection_items)
            inspection.completada_en = now
            inspection.borrador_paso_actual = 0
            inspection.borrador_fase = ""
            inspection.borrador_indice_correccion = 0
            inspection.borrador_version = int(inspection.borrador_version or 0) + 1
            inspection.conteo_revelado = True
            inspection.nota_general = nota_general
            inspection.save(
                update_fields=[
                    "estado",
                    "total_items",
                    "completada_en",
                    "borrador_paso_actual",
                    "borrador_fase",
                    "borrador_indice_correccion",
                    "borrador_version",
                    "conteo_revelado",
                    "nota_general",
                    "updated_at",
                ]
            )

            store = ReminderState.get_global(for_update=True)
            existing_payload = store.payload if isinstance(store.payload, list) else []
            normalized_payload = _normalize_reminder_list(existing_payload)
            payload_changed = normalized_payload != existing_payload
            if payload_changed:
                store.payload = normalized_payload

            payload_changed = _upsert_random_inspection_reminder(
                store,
                inspection,
                request.user,
                mark_completed=True,
            ) or payload_changed

            if mismatch_count > 0:
                payload_changed = _upsert_random_inspection_verify_reminder(
                    store,
                    inspection,
                    mismatch_count,
                    request.user,
                ) or payload_changed

            payload_changed = _upsert_random_inspection_admin_summary_reminder(
                store, timezone.localdate()
            ) or payload_changed

            if payload_changed:
                store.save(update_fields=["payload", "updated_at"])

            inspection = (
                _get_random_inspection_queryset()
                .filter(pk=inspection.pk)
                .first()
            )

        if inspection is None:
            return Response(
                {"detail": "No se pudo cargar la inspeccion luego de guardar."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        response_payload = {
            "inspection": _serialize_random_inspection(inspection, viewer=request.user),
        }
        # Cuantas diferencias hubo solo lo sabe administracion.
        if _can_verify_random_inspection(request.user):
            response_payload["mismatch_count"] = int(mismatch_count)
        return Response(response_payload, status=status.HTTP_200_OK)


class RandomInspectionSaveDraftAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def patch(self, request, inspection_id):
        payload_items = request.data.get("items", [])
        if not isinstance(payload_items, list):
            return Response(
                {"detail": "Debes enviar un arreglo en `items`."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            inspection = _lock_random_inspection(inspection_id)
            if inspection is None:
                return Response(
                    {"detail": "No se encontro la inspeccion aleatoria."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            if int(inspection.usuario_id) != int(request.user.id):
                return Response(
                    {"detail": "Solo el usuario asignado puede modificar este borrador."},
                    status=status.HTTP_403_FORBIDDEN,
                )
            if not _is_random_inspection_pending(inspection):
                return _random_inspection_completed_response()

            client_version = _parse_client_draft_version(request.data)
            if client_version is not None and client_version != int(inspection.borrador_version or 0):
                return _random_inspection_conflict_response(inspection.id, request)

            payload_by_id = {}
            for row in payload_items:
                if not isinstance(row, dict):
                    continue
                item_id = _normalize_int(row.get("id"), 0)
                if item_id > 0:
                    payload_by_id[item_id] = row

            # Solo se tocan los productos (y los campos) que el cliente mando:
            # asi un dispositivo no borra lo que se conto en otro.
            if payload_by_id:
                items_to_update = list(
                    InspeccionAleatoriaItem.objects.filter(
                        inspeccion=inspection, pk__in=payload_by_id.keys()
                    )
                )
                for item in items_to_update:
                    row = payload_by_id.get(int(item.id), {})
                    if "cantidad_reportada" in row:
                        quantity = _parse_optional_quantity(row.get("cantidad_reportada"))
                        if quantity is not None and quantity < 0:
                            return Response(
                                {
                                    "detail": "La cantidad reportada debe ser un numero valido.",
                                    "item_id": int(item.id),
                                },
                                status=status.HTTP_400_BAD_REQUEST,
                            )
                        item.cantidad_reportada = quantity
                    if "cantidad_por_ubicacion" in row:
                        location_counts = _parse_random_inspection_location_counts(
                            row.get("cantidad_por_ubicacion")
                        )
                        item.conteo_ubicaciones = location_counts or []
                    if "observacion" in row:
                        item.observacion = str(row.get("observacion") or "").strip()
                    if "no_encontrado" in row:
                        item.no_encontrado = bool(row.get("no_encontrado"))
                if items_to_update:
                    InspeccionAleatoriaItem.objects.bulk_update(
                        items_to_update,
                        ["cantidad_reportada", "conteo_ubicaciones", "observacion", "no_encontrado"],
                    )

            update_fields = {"borrador_version", "updated_at"}
            if request.data.get("paso_actual") is not None:
                inspection.borrador_paso_actual = max(0, _normalize_int(request.data.get("paso_actual"), 0))
                update_fields.add("borrador_paso_actual")
            if "fase" in request.data:
                fase = _normalize_text(request.data.get("fase")).lower()
                if fase in RANDOM_INSPECTION_DRAFT_PHASES:
                    inspection.borrador_fase = fase
                    update_fields.add("borrador_fase")
            if request.data.get("indice_correccion") is not None:
                inspection.borrador_indice_correccion = max(
                    0, _normalize_int(request.data.get("indice_correccion"), 0)
                )
                update_fields.add("borrador_indice_correccion")
            if "tiene_novedad" in request.data:
                inspection.borrador_tiene_novedad = bool(request.data.get("tiene_novedad"))
                update_fields.add("borrador_tiene_novedad")
            if "nota_general" in request.data:
                inspection.borrador_nota_general = str(request.data.get("nota_general") or "")
                update_fields.add("borrador_nota_general")

            revealed_now = False
            if bool(request.data.get("revelar")) and not inspection.conteo_revelado:
                # Se puede ver el resultado aunque falten productos por contar
                # (asi funcionaba antes: desde el ultimo producto se abria la
                # lista completa). Queda fijado el primer conteo a ciegas de
                # los que ya se contaron; las correcciones posteriores (ya
                # viendo lo esperado) no lo cambian.
                all_items = list(inspection.items.order_by("id"))
                for item in all_items:
                    if item.cantidad_primer_conteo is None and item.cantidad_reportada is not None:
                        item.cantidad_primer_conteo = item.cantidad_reportada
                InspeccionAleatoriaItem.objects.bulk_update(all_items, ["cantidad_primer_conteo"])
                inspection.conteo_revelado = True
                update_fields.add("conteo_revelado")
                revealed_now = True

            inspection.borrador_version = int(inspection.borrador_version or 0) + 1
            inspection.save(update_fields=sorted(update_fields))
            version = int(inspection.borrador_version)

        response_payload = {"ok": True, "version": version}
        if revealed_now or bool(request.data.get("incluir_inspeccion")):
            refreshed = _get_random_inspection_queryset().filter(pk=inspection_id).first()
            if refreshed is not None:
                response_payload["inspection"] = _serialize_random_inspection(
                    refreshed, viewer=request.user
                )
        return Response(response_payload, status=status.HTTP_200_OK)


class RandomInspectionVerifyItemAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, item_id):
        if not _can_verify_random_inspection(request.user):
            return Response(
                {"detail": "No tienes permiso para verificar inspecciones aleatorias."},
                status=status.HTTP_403_FORBIDDEN,
            )

        with transaction.atomic():
            item = (
                InspeccionAleatoriaItem.objects.select_for_update(of=("self",))
                .select_related("inspeccion", "sucursal", "producto", "verificado_por")
                .filter(pk=item_id)
                .first()
            )
            if item is None:
                return Response(
                    {"detail": "No se encontro el item de inspeccion."},
                    status=status.HTTP_404_NOT_FOUND,
                )

            if (
                item.estado_revision
                != InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE
            ):
                return Response(
                    {
                        "detail": (
                            "Solo se pueden verificar items reportados como no coincide."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if item.verificacion_estado in {
                InspeccionAleatoriaItem.EstadosVerificacion.APROBADA,
                InspeccionAleatoriaItem.EstadosVerificacion.RECHAZADA,
            }:
                return Response(
                    {"detail": "Este item ya fue verificado previamente."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            action = _normalize_random_inspection_verify_action(
                request.data.get("accion") or request.data.get("estado")
            )
            if not action:
                return Response(
                    {"detail": "Debes enviar una accion valida (`aprobar` o `rechazar`)."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            now = timezone.now()
            note = _normalize_text(
                request.data.get("nota") or request.data.get("observacion")
            )

            if action == "reubicar":
                target = (
                    SubDivision.objects.select_related("division__bodega")
                    .filter(
                        pk=_normalize_int(request.data.get("subdivision_id"), 0),
                        division__bodega__sucursal_id=int(item.sucursal_id),
                    )
                    .first()
                )
                if target is None:
                    return Response(
                        {"detail": "Elige la nueva ubicacion (de la misma sucursal)."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                moved = _move_inspection_item_stock(item, target)
                if moved["cantidad"] <= 0:
                    return Response(
                        {"detail": "No hay stock de este producto en las ubicaciones revisadas para mover."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                target_label = _subdivision_label(target)
                _record_random_inspection_audit(
                    item,
                    request.user,
                    (
                        f"Reubicacion por inspeccion aleatoria #{int(item.inspeccion_id)}: "
                        f"no se encontro; {moved['cantidad']} unidad(es) movidas a {target_label}."
                    ),
                    {**moved, "subdivision_destino_id": int(target.id)},
                )
                item.reubicado_a = target
                # El total no cambia: solo cambia donde esta.
                item.verificacion_estado = InspeccionAleatoriaItem.EstadosVerificacion.APROBADA
                item.cantidad_confirmada = int(item.cantidad_esperada or 0)
                note = note or f"Reubicado a {target_label}."
            elif action == "aprobar":
                # Cantidad confirmada por ubicacion (cuando se conto en varias):
                # [{subdivision_id, cantidad}]. El total es la suma de ellas.
                confirmed_by_location = {}
                raw_by_location = request.data.get("cantidades_por_ubicacion")
                if raw_by_location:
                    if not isinstance(raw_by_location, list):
                        return Response(
                            {"detail": "Las cantidades por ubicacion deben enviarse como lista."},
                            status=status.HTTP_400_BAD_REQUEST,
                        )
                    counted_subdivisions = {
                        entry["subdivision_id"] for entry in _valid_location_counts(item)
                    }
                    for entry in raw_by_location:
                        if not isinstance(entry, dict):
                            continue
                        subdivision_id = _normalize_int(entry.get("subdivision_id"), 0)
                        quantity = _normalize_int(entry.get("cantidad"), -1)
                        if subdivision_id not in counted_subdivisions:
                            return Response(
                                {"detail": "Una de las ubicaciones no pertenece a este conteo."},
                                status=status.HTTP_400_BAD_REQUEST,
                            )
                        if quantity < 0:
                            return Response(
                                {"detail": "Cada ubicacion debe tener una cantidad valida mayor o igual a cero."},
                                status=status.HTTP_400_BAD_REQUEST,
                            )
                        confirmed_by_location[subdivision_id] = quantity

                cantidad_confirmada_raw = request.data.get("cantidad_confirmada")
                if confirmed_by_location:
                    cantidad_confirmada_raw = sum(
                        confirmed_by_location.get(entry["subdivision_id"], entry["cantidad_contada"])
                        for entry in _valid_location_counts(item)
                    )
                if cantidad_confirmada_raw is None:
                    cantidad_confirmada_raw = item.cantidad_reportada
                cantidad_confirmada = _normalize_int(cantidad_confirmada_raw, -1)
                if cantidad_confirmada < 0:
                    return Response(
                        {
                            "detail": (
                                "La cantidad confirmada debe ser un numero valido y mayor o igual a cero."
                            )
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                adjustment = _apply_random_inspection_adjustment(
                    item, int(cantidad_confirmada), confirmed_by_location or None
                )
                if confirmed_by_location:
                    # Queda registrado lo confirmado en cada ubicacion.
                    item.conteo_ubicaciones = [
                        {
                            **entry,
                            "cantidad_confirmada": confirmed_by_location.get(
                                _normalize_int(entry.get("subdivision_id"), 0)
                            ),
                        }
                        if isinstance(entry, dict)
                        else entry
                        for entry in (item.conteo_ubicaciones or [])
                    ]
                if adjustment["delta_total"] or adjustment["por_ubicacion"]:
                    _record_random_inspection_audit(
                        item,
                        request.user,
                        (
                            f"Ajuste por inspeccion aleatoria #{int(item.inspeccion_id)}: "
                            f"stock al contar {int(item.cantidad_esperada or 0)}, "
                            f"confirmado {int(cantidad_confirmada)}."
                        ),
                        {
                            **adjustment,
                            "cantidad_esperada_al_contar": int(item.cantidad_esperada or 0),
                            "cantidad_confirmada": int(cantidad_confirmada),
                        },
                    )
                item.verificacion_estado = (
                    InspeccionAleatoriaItem.EstadosVerificacion.APROBADA
                )
                item.cantidad_confirmada = int(cantidad_confirmada)
            else:
                item.verificacion_estado = (
                    InspeccionAleatoriaItem.EstadosVerificacion.RECHAZADA
                )
                item.cantidad_confirmada = int(item.cantidad_esperada or 0)

            item.nota_verificacion = note
            item.verificado_por = request.user
            item.verificado_en = now
            item.save(
                update_fields=[
                    "verificacion_estado",
                    "cantidad_confirmada",
                    "conteo_ubicaciones",
                    "reubicado_a",
                    "nota_verificacion",
                    "verificado_por",
                    "verificado_en",
                    "updated_at",
                ]
            )

            has_pending_verification = (
                InspeccionAleatoriaItem.objects.filter(
                    inspeccion_id=item.inspeccion_id,
                    estado_revision=InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE,
                    verificacion_estado=InspeccionAleatoriaItem.EstadosVerificacion.PENDIENTE,
                ).exists()
            )

            if not has_pending_verification:
                store = ReminderState.get_global(for_update=True)
                existing_payload = (
                    store.payload
                    if isinstance(store.payload, list)
                    else []
                )
                normalized_payload = _normalize_reminder_list(existing_payload)
                payload_changed = normalized_payload != existing_payload

                verify_reminder_id = f"insp-verify-{int(item.inspeccion_id)}"
                actor_id = str(int(request.user.id))
                for idx, reminder in enumerate(normalized_payload):
                    if _normalize_id(reminder.get("id")) != verify_reminder_id:
                        continue
                    completed_ids = sorted(
                        set(
                            _merge_completed_by(
                                reminder.get("completedBy") or [],
                                [actor_id],
                            )
                        )
                    )
                    if completed_ids != list(reminder.get("completedBy") or []):
                        updated_reminder = dict(reminder)
                        updated_reminder["completedBy"] = completed_ids
                        normalized_payload[idx] = updated_reminder
                        payload_changed = True
                    break

                if payload_changed:
                    store.payload = normalized_payload
                    store.save(update_fields=["payload", "updated_at"])

            inspection = (
                _get_random_inspection_queryset()
                .filter(pk=item.inspeccion_id)
                .first()
            )

        if inspection is None:
            return Response(
                {"detail": "No se pudo cargar la inspeccion actualizada."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return Response(
            {
                "inspection": _serialize_random_inspection(inspection, viewer=request.user),
                "item_id": int(item_id),
                "accion": action,
            },
            status=status.HTTP_200_OK,
        )


class RandomInspectionAdminExcuseAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not _can_verify_random_inspection(request.user):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta acción."},
                status=status.HTTP_403_FORBIDDEN,
            )

        usuario_id = request.data.get("usuario_id")
        fecha_str = request.data.get("fecha")

        if not usuario_id or not fecha_str:
            return Response(
                {"detail": "Se requieren usuario_id y fecha."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            fecha = dt_date.fromisoformat(str(fecha_str))
        except (ValueError, TypeError):
            return Response(
                {"detail": "Formato de fecha inválido. Use YYYY-MM-DD."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)

            # El resumen del admin agrupa por usuario, asi que disculpar cubre
            # todas sus inspecciones de ese dia (la automatica, las de "enviar
            # ahora" por sucursal y las por division), no solo la automatica.
            inspections = list(
                InspeccionAleatoriaDiaria.objects.select_for_update().filter(
                    usuario_id=int(usuario_id),
                    fecha_programada=fecha,
                )
            )
            if not inspections:
                return Response(
                    {"detail": "No se encontró la inspección para ese usuario y fecha."},
                    status=status.HTTP_404_NOT_FOUND,
                )

            for inspection in inspections:
                if inspection.estado != InspeccionAleatoriaDiaria.Estados.COMPLETADA:
                    inspection.disculpada = True
                    inspection.save(update_fields=["disculpada", "updated_at"])

            # Mark the user's own inspection reminders as seen by the user
            existing_payload = list(store.payload) if isinstance(store.payload, list) else []
            insp_id_strs = {str(int(inspection.id)) for inspection in inspections}
            user_id_str = str(int(usuario_id))
            for rem in existing_payload:
                if not isinstance(rem, dict):
                    continue
                ctx = rem.get("context") or {}
                if (
                    str(ctx.get("type") or "") == RANDOM_INSPECTION_CONTEXT_TYPE
                    and str(ctx.get("id") or "") in insp_id_strs
                    and str(rem.get("kind") or "") == RANDOM_INSPECTION_KIND
                ):
                    completed_by = list(rem.get("completedBy") or [])
                    if user_id_str not in completed_by:
                        completed_by.append(user_id_str)
                    rem["completedBy"] = sorted(completed_by)

            store.payload = _normalize_reminder_list(existing_payload)

            # Refresh admin summary for that date
            config = InspeccionAleatoriaConfiguracion.get_global()
            hora_config = config.hora_recordatorio
            time_str = (
                f"{hora_config.hour:02d}:{hora_config.minute:02d}"
                if hora_config is not None
                else f"{RANDOM_INSPECTION_START_HOUR:02d}:00"
            )
            _upsert_random_inspection_admin_summary_reminder(
                store,
                fecha,
                time_str=time_str,
                reminder_date=fecha,
            )

            # Mark admin summary as completed if all users are now done/disculpada
            admin_ids = sorted(r["id"] for r in _get_random_inspection_verify_recipients())
            summary_id = f"insp-admin-summary-{fecha.isoformat()}"
            for rem in store.payload:
                if not isinstance(rem, dict):
                    continue
                if _normalize_id(rem.get("id")) == _normalize_id(summary_id):
                    users = rem.get("context", {}).get("detalle_usuarios") or []
                    all_done = all(u.get("completada") or u.get("disculpada") for u in users)
                    if all_done:
                        rem["completedBy"] = admin_ids
                    else:
                        rem["completedBy"] = []
                    break

            store.save(update_fields=["payload", "updated_at"])

        return Response({"detail": "Disculpa aplicada correctamente."}, status=status.HTTP_200_OK)


def _parse_optional_date(value):
    text = _normalize_text(value)
    if not text:
        return None
    try:
        return dt_date.fromisoformat(text[:10])
    except ValueError:
        return None


class RandomInspectionCoverageMapAPIView(APIView):
    """Croquis de conteo por sucursal: por percha (division) y nivel
    (subdivision), cuantos productos con stock hay y cuantos ya se contaron.

    Un producto de una ubicacion cuenta como contado si un revisor lo conto
    (en el rango de fechas, si se pide) en una revision que cubria esa
    ubicacion: la de toda la sucursal o una lista cubren todas; una por
    division, esa division; una por subdivision, esa subdivision.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not _can_verify_random_inspection(request.user):
            return Response(
                {"detail": "No tienes permiso para consultar inspecciones aleatorias."},
                status=status.HTTP_403_FORBIDDEN,
            )
        sucursal_id = _normalize_int(request.query_params.get("sucursal_id"), 0)
        if sucursal_id <= 0:
            return Response({"detail": "Debes indicar la sucursal."}, status=status.HTTP_400_BAD_REQUEST)
        allowed_branch_ids = _get_allowed_inventory_branch_ids_for_user(request.user)
        if allowed_branch_ids is not None and sucursal_id not in set(allowed_branch_ids):
            return Response({"detail": "No tienes acceso a esa sucursal."}, status=status.HTTP_403_FORBIDDEN)

        desde = _parse_optional_date(request.query_params.get("desde"))
        hasta = _parse_optional_date(request.query_params.get("hasta"))

        counted_qs = InspeccionAleatoriaItem.objects.filter(sucursal_id=sucursal_id).exclude(
            estado_revision=InspeccionAleatoriaItem.EstadosRevision.PENDIENTE
        )
        if desde:
            counted_qs = counted_qs.filter(revisado_en__date__gte=desde)
        if hasta:
            counted_qs = counted_qs.filter(revisado_en__date__lte=hasta)

        branch_wide = {}
        by_division = {}
        by_subdivision = {}

        def remember(target, product_id, revisado_en):
            previous = target.get(product_id)
            if previous is None or (revisado_en and revisado_en > previous):
                target[product_id] = revisado_en

        for row in counted_qs.values(
            "producto_id",
            "revisado_en",
            "inspeccion__es_por_division",
            "inspeccion__division_id",
            "inspeccion__es_por_subdivision",
            "inspeccion__subdivision_id",
        ):
            product_id = _normalize_int(row.get("producto_id"), 0)
            revisado_en = row.get("revisado_en")
            if row.get("inspeccion__es_por_division"):
                if row.get("inspeccion__es_por_subdivision") and row.get("inspeccion__subdivision_id"):
                    remember(
                        by_subdivision.setdefault(int(row["inspeccion__subdivision_id"]), {}),
                        product_id,
                        revisado_en,
                    )
                elif row.get("inspeccion__division_id"):
                    remember(
                        by_division.setdefault(int(row["inspeccion__division_id"]), {}),
                        product_id,
                        revisado_en,
                    )
                continue
            remember(branch_wide, product_id, revisado_en)

        def counted_at(product_id, division_id, subdivision_id):
            dates = [
                source.get(product_id)
                for source in (
                    branch_wide,
                    by_division.get(division_id, {}),
                    by_subdivision.get(subdivision_id, {}),
                )
                if product_id in source
            ]
            if not dates:
                return False, None
            stamped = [value for value in dates if value]
            return True, (max(stamped) if stamped else None)

        bodegas = list(
            Bodega.objects.filter(sucursal_id=sucursal_id).order_by("nombre", "id")
        )
        divisions = {}
        for division in Division.objects.filter(bodega__sucursal_id=sucursal_id).order_by("nombre", "id"):
            divisions[int(division.id)] = {
                "id": int(division.id),
                "nombre": division.nombre,
                "bodega_id": int(division.bodega_id),
                "total": 0,
                "contados": 0,
                "ultimo_conteo": None,
                "subdivisiones": {},
            }

        rows = (
            Inventario.objects.filter(
                cantidad__gt=0, subdivision__division__bodega__sucursal_id=sucursal_id
            )
            .values(
                "producto_id",
                "producto__codigo",
                "producto__nombre",
                "subdivision_id",
                "subdivision__nombre",
                "subdivision__division_id",
            )
            .annotate(total=Sum("cantidad"))
        )
        for row in rows:
            division = divisions.get(_normalize_int(row.get("subdivision__division_id"), 0))
            if division is None:
                continue
            subdivision_id = _normalize_int(row.get("subdivision_id"), 0)
            product_id = _normalize_int(row.get("producto_id"), 0)
            subdivision = division["subdivisiones"].setdefault(
                subdivision_id,
                {
                    "id": subdivision_id,
                    "nombre": _normalize_text(row.get("subdivision__nombre")),
                    "total": 0,
                    "contados": 0,
                    "pendientes": [],
                },
            )
            is_counted, when = counted_at(product_id, division["id"], subdivision_id)
            division["total"] += 1
            subdivision["total"] += 1
            if is_counted:
                division["contados"] += 1
                subdivision["contados"] += 1
                if when and (division["ultimo_conteo"] is None or when > division["ultimo_conteo"]):
                    division["ultimo_conteo"] = when
            else:
                subdivision["pendientes"].append(
                    {
                        "producto_id": product_id,
                        "codigo": _normalize_text(row.get("producto__codigo")),
                        "nombre": _normalize_text(row.get("producto__nombre")),
                        "cantidad": _normalize_int(row.get("total"), 0),
                    }
                )

        divisions_payload = []
        for division in divisions.values():
            subdivisions = sorted(
                division["subdivisiones"].values(),
                key=lambda item: (_natural_sort_key(item["nombre"]), item["id"]),
            )
            for subdivision in subdivisions:
                subdivision["pendientes"].sort(key=lambda item: _natural_sort_key(item["codigo"]))
            divisions_payload.append(
                {
                    **division,
                    "ultimo_conteo": _parse_iso_timestamp(division["ultimo_conteo"])
                    if division["ultimo_conteo"]
                    else "",
                    "subdivisiones": subdivisions,
                }
            )

        return Response(
            {
                "sucursal_id": sucursal_id,
                "desde": desde.isoformat() if desde else "",
                "hasta": hasta.isoformat() if hasta else "",
                "bodegas": [
                    {
                        "id": int(bodega.id),
                        "nombre": bodega.nombre,
                        "ancho_metros": float(bodega.ancho_metros or 0),
                        "alto_metros": float(bodega.alto_metros or 0),
                        "ubicaciones": bodega.ubicaciones if isinstance(bodega.ubicaciones, list) else [],
                    }
                    for bodega in bodegas
                ],
                "divisiones": divisions_payload,
            },
            status=status.HTTP_200_OK,
        )


RECENTLY_COUNTED_DAYS = 30


class RandomInspectionRecentlyCountedAPIView(APIView):
    """Antes de mandar una revision: cuantos de esos productos ya se contaron
    en la sucursal en los ultimos 30 dias (para avisar "ya fue contado").

    Body: {sucursal_id, producto_ids} o {division_id[, subdivision_id]}.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not _can_verify_random_inspection(request.user):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta accion."},
                status=status.HTTP_403_FORBIDDEN,
            )
        division_id = _normalize_int(request.data.get("division_id"), 0)
        subdivision_id = _normalize_int(request.data.get("subdivision_id"), 0) or None
        sucursal_id = _normalize_int(request.data.get("sucursal_id"), 0)
        product_ids = set()
        if division_id > 0:
            division = Division.objects.select_related("bodega").filter(pk=division_id).first()
            if division is None:
                return Response({"detail": "La division no existe."}, status=status.HTTP_404_NOT_FOUND)
            sucursal_id = int(division.bodega.sucursal_id)
            product_ids = {
                int(candidate["producto_id"])
                for candidate in _collect_division_inspection_candidates(division_id, subdivision_id)
            }
        else:
            raw_ids = request.data.get("producto_ids") or []
            if not isinstance(raw_ids, list):
                return Response({"detail": "producto_ids debe ser una lista."}, status=status.HTTP_400_BAD_REQUEST)
            product_ids = {pid for pid in (_normalize_int(raw, 0) for raw in raw_ids) if pid > 0}
        if sucursal_id <= 0:
            return Response({"detail": "Debes indicar la sucursal."}, status=status.HTTP_400_BAD_REQUEST)

        since = timezone.now() - timedelta(days=RECENTLY_COUNTED_DAYS)
        latest_by_product = {}
        if product_ids:
            rows = (
                InspeccionAleatoriaItem.objects.filter(
                    sucursal_id=sucursal_id,
                    producto_id__in=sorted(product_ids),
                    revisado_en__gte=since,
                )
                .exclude(estado_revision=InspeccionAleatoriaItem.EstadosRevision.PENDIENTE)
                .values("producto_id", "producto__codigo", "revisado_en")
            )
            for row in rows:
                pid = int(row["producto_id"])
                current = latest_by_product.get(pid)
                if current is None or row["revisado_en"] > current["revisado_en"]:
                    latest_by_product[pid] = row
        ordered = sorted(latest_by_product.values(), key=lambda row: row["revisado_en"], reverse=True)
        return Response(
            {
                "total": len(product_ids),
                "contados": len(latest_by_product),
                "dias": RECENTLY_COUNTED_DAYS,
                "ultimo_conteo": _parse_iso_timestamp(ordered[0]["revisado_en"]) if ordered else "",
                "productos": [
                    {"codigo": _normalize_text(row["producto__codigo"]), "revisado_en": _parse_iso_timestamp(row["revisado_en"])}
                    for row in ordered[:10]
                ],
            },
            status=status.HTTP_200_OK,
        )


class RandomInspectionAdminSummaryAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not _can_verify_random_inspection(request.user):
            return Response(
                {"detail": "No tienes permiso para consultar inspecciones aleatorias."},
                status=status.HTTP_403_FORBIDDEN,
            )

        allowed_branch_ids = _get_allowed_inventory_branch_ids_for_user(request.user)

        inventory_qs = Inventario.objects.filter(cantidad__gt=0)
        inspected_qs = InspeccionAleatoriaItem.objects.all()
        if allowed_branch_ids is not None:
            allowed_list = sorted(allowed_branch_ids)
            inventory_qs = inventory_qs.filter(
                subdivision__division__bodega__sucursal_id__in=allowed_list
            )
            inspected_qs = inspected_qs.filter(sucursal_id__in=allowed_list)

        inventory_rows = (
            inventory_qs.values(
                "subdivision__division__bodega__sucursal_id",
                "subdivision__division__bodega__sucursal__nombre",
            )
            .annotate(
                total_productos=Count("producto_id", distinct=True),
                total_unidades=Sum("cantidad"),
            )
            .order_by("subdivision__division__bodega__sucursal__nombre", "subdivision__division__bodega__sucursal_id")
        )

        inspected_rows = (
            inspected_qs.values("sucursal_id", "sucursal__nombre")
            .annotate(
                productos_revisados=Count(
                    "producto_id",
                    distinct=True,
                    filter=(
                        ~Q(
                            estado_revision=InspeccionAleatoriaItem.EstadosRevision.PENDIENTE
                        )
                        & ~Q(
                            verificacion_estado=InspeccionAleatoriaItem.EstadosVerificacion.PENDIENTE
                        )
                    ),
                ),
                inspecciones_totales=Count("inspeccion_id", distinct=True),
                items_revisados=Count(
                    "id",
                    filter=(
                        ~Q(
                            estado_revision=InspeccionAleatoriaItem.EstadosRevision.PENDIENTE
                        )
                        & ~Q(
                            verificacion_estado=InspeccionAleatoriaItem.EstadosVerificacion.PENDIENTE
                        )
                    ),
                ),
                diferencias_reportadas=Count(
                    "id",
                    filter=Q(
                        estado_revision=InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE
                    ),
                ),
                pendientes_verificacion=Count(
                    "id",
                    filter=Q(
                        estado_revision=InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE,
                        verificacion_estado=InspeccionAleatoriaItem.EstadosVerificacion.PENDIENTE,
                    ),
                ),
                ultima_revision=Max("revisado_en"),
                ultima_verificacion=Max("verificado_en"),
            )
            .order_by("sucursal__nombre", "sucursal_id")
        )

        summary_by_branch = {}
        for row in inventory_rows:
            branch_id = _normalize_int(
                row.get("subdivision__division__bodega__sucursal_id"), 0
            )
            if branch_id <= 0:
                continue
            summary_by_branch[branch_id] = {
                "sucursal_id": branch_id,
                "sucursal_nombre": _normalize_text(
                    row.get("subdivision__division__bodega__sucursal__nombre")
                )
                or f"Sucursal {branch_id}",
                "total_productos_inventario": _normalize_int(
                    row.get("total_productos"), 0
                ),
                "total_unidades_inventario": _normalize_int(
                    row.get("total_unidades"), 0
                ),
                "productos_revisados": 0,
                "inspecciones_totales": 0,
                "items_revisados": 0,
                "diferencias_reportadas": 0,
                "pendientes_verificacion": 0,
                "cobertura_porcentaje": 0.0,
                "ultima_revision": "",
                "ultima_verificacion": "",
            }

        for row in inspected_rows:
            branch_id = _normalize_int(row.get("sucursal_id"), 0)
            if branch_id <= 0:
                continue

            current = summary_by_branch.get(branch_id) or {
                "sucursal_id": branch_id,
                "sucursal_nombre": _normalize_text(row.get("sucursal__nombre"))
                or f"Sucursal {branch_id}",
                "total_productos_inventario": 0,
                "total_unidades_inventario": 0,
                "productos_revisados": 0,
                "inspecciones_totales": 0,
                "items_revisados": 0,
                "diferencias_reportadas": 0,
                "pendientes_verificacion": 0,
                "cobertura_porcentaje": 0.0,
                "ultima_revision": "",
                "ultima_verificacion": "",
            }

            current["productos_revisados"] = _normalize_int(
                row.get("productos_revisados"), 0
            )
            current["inspecciones_totales"] = _normalize_int(
                row.get("inspecciones_totales"), 0
            )
            current["items_revisados"] = _normalize_int(row.get("items_revisados"), 0)
            current["diferencias_reportadas"] = _normalize_int(
                row.get("diferencias_reportadas"), 0
            )
            current["pendientes_verificacion"] = _normalize_int(
                row.get("pendientes_verificacion"), 0
            )
            current["ultima_revision"] = _parse_iso_timestamp(row.get("ultima_revision"))
            current["ultima_verificacion"] = _parse_iso_timestamp(
                row.get("ultima_verificacion")
            )

            total_products = _normalize_int(
                current.get("total_productos_inventario"), 0
            )
            reviewed_products = _normalize_int(current.get("productos_revisados"), 0)
            if total_products > 0:
                current["cobertura_porcentaje"] = round(
                    min(100.0, (reviewed_products / total_products) * 100.0),
                    2,
                )
            else:
                current["cobertura_porcentaje"] = 0.0

            summary_by_branch[branch_id] = current

        rows = sorted(
            summary_by_branch.values(),
            key=lambda row: (
                str(row.get("sucursal_nombre") or "").lower(),
                int(row.get("sucursal_id") or 0),
            ),
        )
        return Response(
            {
                "results": rows,
                "generated_at": _iso_now(),
            },
            status=status.HTTP_200_OK,
        )


class RandomInspectionAdminItemsAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not _can_verify_random_inspection(request.user):
            return Response(
                {"detail": "No tienes permiso para consultar inspecciones aleatorias."},
                status=status.HTTP_403_FORBIDDEN,
            )

        sucursal_id = _normalize_int(request.query_params.get("sucursal_id"), 0)
        if sucursal_id <= 0:
            return Response(
                {"detail": "Debes enviar un `sucursal_id` valido."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        estado = _normalize_text(request.query_params.get("estado")).lower() or "pendiente"
        page = _normalize_int(request.query_params.get("page"), 1)
        if page <= 0:
            page = 1
        page_size = _normalize_int(request.query_params.get("page_size"), 20)
        if page_size <= 0:
            page_size = 20
        page_size = min(page_size, 100)

        allowed_branch_ids = _get_allowed_inventory_branch_ids_for_user(request.user)
        if allowed_branch_ids is not None and sucursal_id not in allowed_branch_ids:
            return Response(
                {"detail": "No tienes acceso a esta sucursal."},
                status=status.HTTP_403_FORBIDDEN,
            )

        queryset = (
            InspeccionAleatoriaItem.objects.select_related(
                "inspeccion",
                "inspeccion__usuario",
                "sucursal",
                "producto",
                "verificado_por",
            )
            .filter(sucursal_id=sucursal_id)
            .order_by("-updated_at", "-revisado_en", "-id")
        )

        if estado == "pendiente":
            queryset = queryset.filter(
                estado_revision=InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE,
                verificacion_estado=InspeccionAleatoriaItem.EstadosVerificacion.PENDIENTE,
            )
        elif estado == "verificado":
            queryset = queryset.filter(
                estado_revision=InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE,
            ).exclude(
                verificacion_estado=InspeccionAleatoriaItem.EstadosVerificacion.PENDIENTE
            )
        elif estado == "diferencias":
            queryset = queryset.filter(
                estado_revision=InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE
            )
        elif estado != "todos":
            return Response(
                {
                    "detail": (
                        "El parametro `estado` debe ser uno de: pendiente, verificado, diferencias, todos."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        total_count = queryset.count()
        total_pages = (
            max(1, ((total_count - 1) // page_size) + 1) if total_count > 0 else 1
        )
        current_page = min(page, total_pages)
        offset = (current_page - 1) * page_size
        rows = list(queryset[offset : offset + page_size])
        subdivision_labels = _random_inspection_subdivision_labels(rows)
        serialized = [
            _serialize_random_inspection_admin_item(item, subdivision_labels) for item in rows
        ]

        return Response(
            {
                "results": serialized,
                "count": int(total_count),
                "page": int(current_page),
                "page_size": int(page_size),
                "total_pages": int(total_pages),
                "sucursal_id": int(sucursal_id),
                "estado": estado,
            },
            status=status.HTTP_200_OK,
        )


class RandomInspectionConfigAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not _can_verify_random_inspection(request.user):
            return Response(
                {"detail": "No tienes permiso para consultar esta configuracion."},
                status=status.HTTP_403_FORBIDDEN,
            )
        config = InspeccionAleatoriaConfiguracion.get_global()
        sys_config = ConfiguracionSistema.get_solo()
        hora = config.hora_recordatorio
        return Response(
            {
                "hora_recordatorio": hora.strftime("%H:%M") if hora else "",
                "cantidad_productos": int(sys_config.random_inspection_items_per_day),
            },
            status=status.HTTP_200_OK,
        )

    def patch(self, request):
        if not _can_verify_random_inspection(request.user):
            return Response(
                {"detail": "No tienes permiso para actualizar esta configuracion."},
                status=status.HTTP_403_FORBIDDEN,
            )
        with transaction.atomic():
            config = InspeccionAleatoriaConfiguracion.get_global(for_update=True)
            hora_raw = _normalize_text(request.data.get("hora_recordatorio", ""))
            if not hora_raw:
                return Response(
                    {"detail": "La hora de envio del recordatorio es requerida."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            parts = hora_raw.split(":")
            try:
                hour = int(parts[0])
                minute = int(parts[1]) if len(parts) > 1 else 0
                if not (0 <= hour <= 23 and 0 <= minute <= 59):
                    raise ValueError()
                config.hora_recordatorio = dt_time(hour, minute)
            except (ValueError, IndexError):
                return Response(
                    {"detail": "Formato de hora invalido. Usa HH:MM."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            config.save(update_fields=["hora_recordatorio", "updated_at"])

            cantidad_raw = request.data.get("cantidad_productos")
            if cantidad_raw not in (None, ""):
                cantidad = _normalize_int(cantidad_raw, 0)
                if cantidad < 1 or cantidad > 200:
                    return Response(
                        {"detail": "La cantidad de productos debe estar entre 1 y 200."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                sys_config = ConfiguracionSistema.get_solo()
                sys_config.random_inspection_items_per_day = cantidad
                sys_config.save(update_fields=["random_inspection_items_per_day"])
            else:
                sys_config = ConfiguracionSistema.get_solo()

        hora = config.hora_recordatorio
        return Response(
            {
                "hora_recordatorio": hora.strftime("%H:%M") if hora else "",
                "cantidad_productos": int(sys_config.random_inspection_items_per_day),
            },
            status=status.HTTP_200_OK,
        )


def _parse_reminder_time(raw_value):
    """Valida "HH:MM" para el recordatorio de hoy.

    Si la hora ya paso (por ejemplo, se eligio la hora actual y el reloj
    avanzo un minuto antes de enviar, o el reloj del navegador va un poco
    atrasado), no se rechaza: se envia igual con la hora actual.

    Devuelve (time_str, error_detail): si error_detail no es None, time_str
    queda en "" y el detail ya esta listo para responder un 400.
    """
    hora_raw = _normalize_text(raw_value)
    if not hora_raw:
        return "", "Debes especificar la hora del recordatorio."

    parts = hora_raw.split(":")
    try:
        h = int(parts[0])
        m = int(parts[1]) if len(parts) > 1 else 0
        if not (0 <= h <= 23 and 0 <= m <= 59):
            raise ValueError()
    except (ValueError, IndexError):
        return "", "Formato de hora invalido. Usa HH:MM."

    now = timezone.localtime().time()
    if (h, m) < (now.hour, now.minute):
        h, m = now.hour, now.minute

    return f"{h:02d}:{m:02d}", None


class RandomInspectionSendNowAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not _can_verify_random_inspection(request.user):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta accion."},
                status=status.HTTP_403_FORBIDDEN,
            )

        # Parse cantidad_productos
        cantidad_raw = request.data.get("cantidad_productos")
        cantidad = _normalize_int(cantidad_raw, 0)
        if cantidad <= 0:
            cantidad = _resolve_random_inspection_items_per_day()
        cantidad = max(RANDOM_INSPECTION_MIN_ITEMS_PER_DAY, min(RANDOM_INSPECTION_MAX_ITEMS_PER_DAY, cantidad))

        # Parse hora_recordatorio (solo para hoy)
        time_str, time_error = _parse_reminder_time(request.data.get("hora_recordatorio", ""))
        if time_error:
            return Response({"detail": time_error}, status=status.HTTP_400_BAD_REQUEST)

        usuario_ids_raw = request.data.get("usuario_ids")
        if usuario_ids_raw is not None:
            try:
                usuario_ids = [int(uid) for uid in usuario_ids_raw]
            except (TypeError, ValueError):
                return Response(
                    {"detail": "usuario_ids debe ser una lista de IDs de usuario."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if not usuario_ids:
                return Response(
                    {"detail": "Debes seleccionar al menos un revisor."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        else:
            usuario_ids = None

        enabled_prefs = UsuarioPreferencia.objects.filter(
            inspeccion_aleatoria=True,
            usuario__is_active=True,
        ).select_related("usuario")

        if usuario_ids is not None:
            enabled_prefs = enabled_prefs.filter(usuario_id__in=usuario_ids)

        dispatched = []
        scheduled_date = timezone.localdate()

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)

            # Sin repetir productos: ni dentro de este envio ni con lo que ya
            # se asigno hoy (la inspeccion automatica u otros envios).
            used_keys = _get_random_inspection_keys_assigned_on(scheduled_date)

            for pref in enabled_prefs:
                user = pref.usuario
                # Mismo criterio que la inspeccion automatica: lista vacia con
                # la inspeccion habilitada = todas las sucursales permitidas.
                branch_ids = sorted(_get_random_inspection_branch_ids_for_user(user))

                for branch_id in branch_ids:
                    inspection = (
                        InspeccionAleatoriaDiaria.objects.select_for_update()
                        .filter(
                            usuario=user,
                            sucursal_id=branch_id,
                            es_por_division=False,
                            es_por_lista=False,
                            fecha_programada=scheduled_date,
                        )
                        .first()
                    )

                    if inspection is not None:
                        # Ya tiene la de hoy para esta sucursal: solo se le
                        # vuelve a avisar (no se le agregan productos).
                        branch_nombre = (
                            InspeccionAleatoriaItem.objects.filter(inspeccion=inspection)
                            .values_list("sucursal__nombre", flat=True)
                            .first()
                        ) or f"Sucursal {branch_id}"
                        product_count = inspection.items.count()
                    else:
                        all_candidates = _collect_branch_inspection_candidates(branch_id)
                        selected = _select_random_inspection_candidates(
                            user,
                            scheduled_date,
                            all_candidates,
                            items_per_day=cantidad,
                            excluded_keys=used_keys,
                        )
                        if not selected:
                            continue

                        for item in selected:
                            used_keys.add((item["sucursal_id"], item["producto_id"]))

                        branch_nombre = selected[0].get("sucursal_nombre") or f"Sucursal {branch_id}"
                        coverage = _calculate_random_inspection_coverage(
                            user, _stocked_candidate_keys(all_candidates)
                        )

                        inspection = InspeccionAleatoriaDiaria.objects.create(
                            usuario=user,
                            sucursal_id=branch_id,
                            fecha_programada=scheduled_date,
                            estado=InspeccionAleatoriaDiaria.Estados.PENDIENTE,
                            total_items=len(selected),
                            cobertura_porcentaje=coverage,
                        )

                        InspeccionAleatoriaItem.objects.bulk_create([
                            _build_random_inspection_item(inspection, item, sucursal_id=branch_id)
                            for item in selected
                        ])
                        product_count = len(selected)

                    _upsert_random_inspection_reminder(
                        store,
                        inspection,
                        user,
                        branch_nombre=branch_nombre,
                        time_str=time_str,
                    )

                    dispatched.append({
                        "usuario_id": int(user.id),
                        "nombre": _format_user_display_name(user),
                        "sucursal_id": branch_id,
                        "sucursal_nombre": branch_nombre,
                        "inspeccion_id": int(inspection.id),
                        "productos": product_count,
                    })

            _upsert_random_inspection_admin_summary_reminder(store, scheduled_date, time_str=time_str)
            store.save()

        return Response(
            {
                "dispatched": dispatched,
                "count": len(dispatched),
            },
            status=status.HTTP_200_OK,
        )


class RandomInspectionSendDivisionAPIView(APIView):
    """Envia a un revisor puntual una inspeccion que cubre TODOS los
    productos de una division especifica de una bodega, en vez de la
    muestra aleatoria diaria. Opcionalmente (`subdivision_id`) se limita a
    una sola subdivision de esa division."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not _can_verify_random_inspection(request.user):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta accion."},
                status=status.HTTP_403_FORBIDDEN,
            )

        division_id = _normalize_int(request.data.get("division_id"), 0)
        subdivision_id = _normalize_int(request.data.get("subdivision_id"), 0) or None
        usuario_id = _normalize_int(request.data.get("usuario_id"), 0)
        if division_id <= 0 or usuario_id <= 0:
            return Response(
                {"detail": "Debes seleccionar una division y un revisor."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        time_str, time_error = _parse_reminder_time(request.data.get("hora_recordatorio", ""))
        if time_error:
            return Response({"detail": time_error}, status=status.HTTP_400_BAD_REQUEST)

        division = (
            Division.objects.select_related("bodega", "bodega__sucursal")
            .filter(id=division_id)
            .first()
        )
        if division is None:
            return Response({"detail": "La division no existe."}, status=status.HTTP_404_NOT_FOUND)

        subdivision = None
        if subdivision_id is not None:
            subdivision = SubDivision.objects.filter(id=subdivision_id, division_id=division_id).first()
            if subdivision is None:
                return Response(
                    {"detail": "La subdivision no existe o no pertenece a esa division."},
                    status=status.HTTP_404_NOT_FOUND,
                )
        scope_label = f"{division.nombre} / {subdivision.nombre}" if subdivision else division.nombre
        scope_word = "subdivision" if subdivision else "division"

        sucursal_id = division.bodega.sucursal_id
        sucursal_nombre = division.bodega.sucursal.nombre

        user_model = get_user_model()
        user = user_model.objects.filter(id=usuario_id, is_active=True).first()
        if user is None:
            return Response(
                {"detail": "El usuario no existe o esta inactivo."},
                status=status.HTTP_404_NOT_FOUND,
            )

        pref = UsuarioPreferencia.objects.filter(usuario_id=usuario_id).first()
        if pref is None or not pref.inspeccion_aleatoria:
            return Response(
                {"detail": "Este usuario no tiene habilitada la inspeccion aleatoria."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Mismo criterio que la inspeccion automatica y "enviar ahora": lista
        # vacia con la inspeccion habilitada = todas las sucursales permitidas.
        if sucursal_id not in _get_random_inspection_branch_ids_for_user(user):
            return Response(
                {"detail": "Este usuario no esta asignado a la sucursal de esa division."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        candidates = _collect_division_inspection_candidates(division_id, subdivision_id)
        if not candidates:
            return Response(
                {"detail": f"Esta {scope_word} no tiene inventario disponible para revisar."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        scheduled_date = timezone.localdate()

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)

            # Registro propio por division: antes se sumaba a la inspeccion de
            # la sucursal y, si esa ya estaba completada, los productos nuevos
            # quedaban pendientes para siempre (responder daba 409).
            scope_filter = (
                {"subdivision_id": subdivision_id, "es_por_subdivision": True}
                if subdivision is not None
                else {"division_id": division_id, "es_por_subdivision": False}
            )
            inspection = (
                InspeccionAleatoriaDiaria.objects.select_for_update()
                .filter(
                    usuario=user,
                    es_por_division=True,
                    fecha_programada=scheduled_date,
                    **scope_filter,
                )
                .first()
            )

            if inspection is not None and not _is_random_inspection_pending(inspection):
                return Response(
                    {
                        "detail": f"Este usuario ya completo hoy la revision de esta {scope_word}.",
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

            existing_producto_ids = set()
            if inspection is not None:
                existing_producto_ids = set(inspection.items.values_list("producto_id", flat=True))

            new_items = [c for c in candidates if c["producto_id"] not in existing_producto_ids]
            if not new_items:
                return Response(
                    {
                        "detail": f"Todos los productos de esta {scope_word} ya estaban en la "
                        "inspeccion de hoy de este usuario.",
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if inspection is None:
                coverage = _calculate_random_inspection_coverage(
                    user,
                    _stocked_candidate_keys(_collect_branch_inspection_candidates(sucursal_id)),
                )

                inspection = InspeccionAleatoriaDiaria.objects.create(
                    usuario=user,
                    sucursal_id=sucursal_id,
                    division=division,
                    es_por_division=True,
                    subdivision=subdivision,
                    es_por_subdivision=subdivision is not None,
                    fecha_programada=scheduled_date,
                    estado=InspeccionAleatoriaDiaria.Estados.PENDIENTE,
                    total_items=len(new_items),
                    cobertura_porcentaje=coverage,
                )
            else:
                inspection.total_items = inspection.total_items + len(new_items)
                inspection.save(update_fields=["total_items"])

            # Los items se muestran por id: se crean ya en el orden de la percha.
            new_items = _sort_candidates_by_location(
                new_items, division_id=division_id, subdivision_id=subdivision_id
            )
            InspeccionAleatoriaItem.objects.bulk_create(
                [
                    _build_random_inspection_item(inspection, item, sucursal_id=sucursal_id)
                    for item in new_items
                ],
                ignore_conflicts=True,
            )

            _upsert_random_inspection_reminder(
                store,
                inspection,
                user,
                branch_nombre=f"{scope_label} - {sucursal_nombre}",
                time_str=time_str,
            )
            _upsert_random_inspection_admin_summary_reminder(store, scheduled_date, time_str=time_str)
            store.save()

        return Response(
            {
                "usuario_id": int(user.id),
                "nombre": _format_user_display_name(user),
                "sucursal_id": sucursal_id,
                "sucursal_nombre": sucursal_nombre,
                "division_id": int(division.id),
                "division_nombre": division.nombre,
                "subdivision_id": int(subdivision.id) if subdivision else None,
                "subdivision_nombre": subdivision.nombre if subdivision else "",
                "inspeccion_id": int(inspection.id),
                "productos": len(new_items),
            },
            status=status.HTTP_200_OK,
        )


RANDOM_INSPECTION_LIST_MAX_ITEMS = 200


class RandomInspectionSendListAPIView(APIView):
    """Envia a un revisor una inspeccion con una lista de productos elegida
    por el admin (por id o por codigo), en vez de la muestra aleatoria.

    Es un registro aparte (es_por_lista): se pueden mandar varias listas el
    mismo dia y no reemplaza a la inspeccion aleatoria automatica.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not _can_verify_random_inspection(request.user):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta accion."},
                status=status.HTTP_403_FORBIDDEN,
            )

        sucursal_id = _normalize_int(request.data.get("sucursal_id"), 0)
        usuario_id = _normalize_int(request.data.get("usuario_id"), 0)
        if sucursal_id <= 0 or usuario_id <= 0:
            return Response(
                {"detail": "Debes seleccionar una sucursal y un revisor."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        time_str, time_error = _parse_reminder_time(request.data.get("hora_recordatorio", ""))
        if time_error:
            return Response({"detail": time_error}, status=status.HTTP_400_BAD_REQUEST)

        raw_ids = request.data.get("producto_ids") or []
        raw_codes = request.data.get("codigos") or []
        if not isinstance(raw_ids, list) or not isinstance(raw_codes, list):
            return Response(
                {"detail": "Los productos y los codigos deben enviarse como listas."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        from inventario.models import Sucursal  # Import tardio para evitar ciclos
        from productos.models import Producto

        sucursal = Sucursal.objects.filter(pk=sucursal_id).first()
        if sucursal is None:
            return Response({"detail": "La sucursal no existe."}, status=status.HTTP_404_NOT_FOUND)

        user = get_user_model().objects.filter(id=usuario_id, is_active=True).first()
        if user is None:
            return Response(
                {"detail": "El usuario no existe o esta inactivo."},
                status=status.HTTP_404_NOT_FOUND,
            )

        pref = UsuarioPreferencia.objects.filter(usuario_id=usuario_id).first()
        if pref is None or not pref.inspeccion_aleatoria:
            return Response(
                {"detail": "Este usuario no tiene habilitada la inspeccion aleatoria."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if sucursal_id not in _get_random_inspection_branch_ids_for_user(user):
            return Response(
                {"detail": "Este usuario no esta asignado a esa sucursal."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        product_ids = []
        for raw_id in raw_ids:
            product_id = _normalize_int(raw_id, 0)
            if product_id > 0 and product_id not in product_ids:
                product_ids.append(product_id)
        found_by_id = set(
            Producto.objects.filter(pk__in=product_ids).values_list("id", flat=True)
        )
        product_ids = [product_id for product_id in product_ids if product_id in found_by_id]

        # Codigos pegados por el admin: coincidencia exacta sin distinguir
        # mayusculas, y se informan los que no existen en el catalogo.
        codes = []
        seen_codes = set()
        for raw_code in raw_codes:
            code = _normalize_text(raw_code)
            if code and code.upper() not in seen_codes:
                seen_codes.add(code.upper())
                codes.append(code)
        not_found_codes = []
        if codes:
            code_filter = Q()
            for code in codes:
                code_filter |= Q(codigo__iexact=code)
            by_code = {
                str(codigo).upper(): product_id
                for product_id, codigo in Producto.objects.filter(code_filter).values_list("id", "codigo")
            }
            for code in codes:
                product_id = by_code.get(code.upper())
                if product_id is None:
                    not_found_codes.append(code)
                elif product_id not in product_ids:
                    product_ids.append(product_id)

        if not product_ids:
            return Response(
                {
                    "detail": "No hay productos validos en la lista.",
                    "codigos_no_encontrados": not_found_codes,
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(product_ids) > RANDOM_INSPECTION_LIST_MAX_ITEMS:
            return Response(
                {
                    "detail": (
                        f"La lista no puede tener mas de {RANDOM_INSPECTION_LIST_MAX_ITEMS} productos."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        stock_rows = (
            Inventario.objects.filter(
                producto_id__in=product_ids,
                subdivision__division__bodega__sucursal_id=sucursal_id,
            )
            .values("producto_id")
            .annotate(total=Sum("cantidad"))
        )
        stock_by_product = {
            int(row["producto_id"]): max(0, _normalize_int(row.get("total"), 0))
            for row in stock_rows
        }
        scheduled_date = timezone.localdate()

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)

            coverage = _calculate_random_inspection_coverage(
                user,
                _stocked_candidate_keys(_collect_branch_inspection_candidates(sucursal_id)),
            )
            inspection = InspeccionAleatoriaDiaria.objects.create(
                usuario=user,
                sucursal_id=sucursal_id,
                es_por_lista=True,
                fecha_programada=scheduled_date,
                estado=InspeccionAleatoriaDiaria.Estados.PENDIENTE,
                total_items=len(product_ids),
                cobertura_porcentaje=coverage,
            )
            InspeccionAleatoriaItem.objects.bulk_create(
                [
                    _build_random_inspection_item(
                        inspection,
                        {
                            "producto_id": product_id,
                            "cantidad_esperada": stock_by_product.get(product_id, 0),
                        },
                        sucursal_id=sucursal_id,
                    )
                    for product_id in product_ids
                ]
            )

            _upsert_random_inspection_reminder(
                store,
                inspection,
                user,
                branch_nombre=f"{sucursal.nombre} (lista especifica)",
                time_str=time_str,
            )
            _upsert_random_inspection_admin_summary_reminder(store, scheduled_date, time_str=time_str)
            store.save()

        return Response(
            {
                "usuario_id": int(user.id),
                "nombre": _format_user_display_name(user),
                "sucursal_id": sucursal_id,
                "sucursal_nombre": sucursal.nombre,
                "inspeccion_id": int(inspection.id),
                "productos": len(product_ids),
                "codigos_no_encontrados": not_found_codes,
            },
            status=status.HTTP_200_OK,
        )
