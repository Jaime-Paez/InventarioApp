import random
import re
import json
from datetime import datetime, time as dt_time, timezone as dt_timezone
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
from inventario.models import Inventario, SubDivision
from usuarios.models import RolPermiso
from usuarios.sucursal_scope import get_allowed_sucursal_ids

from .models import (
    InspeccionAleatoriaDiaria,
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


RANDOM_INSPECTION_CONTEXT_TYPE = "inspeccion_aleatoria"
RANDOM_INSPECTION_KIND = "inspeccion_aleatoria_diaria"
RANDOM_INSPECTION_VERIFY_KIND = "inspeccion_aleatoria_verificacion"
RANDOM_INSPECTION_START_HOUR = 9
RANDOM_INSPECTION_DEFAULT_ITEMS_PER_DAY = 5
RANDOM_INSPECTION_MIN_ITEMS_PER_DAY = 1
RANDOM_INSPECTION_MAX_ITEMS_PER_DAY = 200


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
    if user is None or not getattr(user, "is_authenticated", False):
        return False
    preference = getattr(user, "preferencia_operativa", None)
    if preference is not None:
        return bool(getattr(preference, "inspeccion_aleatoria", False))
    return UsuarioPreferencia.objects.filter(
        usuario=user,
        inspeccion_aleatoria=True,
    ).exists()


def _get_allowed_inventory_branch_ids_for_user(user):
    allowed = get_allowed_sucursal_ids(user, RolPermiso.Modulos.INVENTARIO)
    if allowed is None:
        return None
    return {int(branch_id) for branch_id in allowed if branch_id is not None}


def _collect_random_inspection_candidates(user):
    allowed_branch_ids = _get_allowed_inventory_branch_ids_for_user(user)
    if allowed_branch_ids is not None and not allowed_branch_ids:
        return []

    queryset = Inventario.objects.filter(cantidad__gt=0)
    if allowed_branch_ids is not None:
        queryset = queryset.filter(
            subdivision__division__bodega__sucursal_id__in=sorted(allowed_branch_ids)
        )

    rows = (
        queryset.values(
            "subdivision__division__bodega__sucursal_id",
            "subdivision__division__bodega__sucursal__nombre",
            "producto_id",
            "producto__codigo",
            "producto__nombre",
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
        cantidad_esperada = _normalize_int(row.get("cantidad_esperada"), 0)
        if sucursal_id <= 0 or producto_id <= 0 or cantidad_esperada <= 0:
            continue
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
            }
        )
    return candidates


def _collect_random_inspection_history(user):
    rows = (
        InspeccionAleatoriaItem.objects.filter(inspeccion__usuario=user)
        .values("sucursal_id", "producto_id")
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


def _select_random_inspection_candidates(
    user,
    scheduled_date,
    candidates,
    *,
    items_per_day=RANDOM_INSPECTION_DEFAULT_ITEMS_PER_DAY,
):
    if not candidates:
        return []

    history = _collect_random_inspection_history(user)
    ordered = []
    for candidate in candidates:
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
        ordered.append((total_revisiones, last_ts, candidate))

    ordered.sort(key=lambda row: (row[0], row[1]))
    resolved_items_per_day = _normalize_int(
        items_per_day,
        RANDOM_INSPECTION_DEFAULT_ITEMS_PER_DAY,
    )
    resolved_items_per_day = max(RANDOM_INSPECTION_MIN_ITEMS_PER_DAY, resolved_items_per_day)
    resolved_items_per_day = min(RANDOM_INSPECTION_MAX_ITEMS_PER_DAY, resolved_items_per_day)
    target_count = min(resolved_items_per_day, len(ordered))
    if target_count <= 0:
        return []

    pool_size = min(len(ordered), max(target_count * 4, target_count))
    pool = [row[2] for row in ordered[:pool_size]]

    rng = random.Random(f"{user.id}-{scheduled_date.isoformat()}-{len(candidates)}")
    rng.shuffle(pool)

    selected = pool[:target_count]
    if len(selected) < target_count:
        selected_keys = {
            (item["sucursal_id"], item["producto_id"])
            for item in selected
        }
        for _, _, candidate in ordered:
            key = (candidate["sucursal_id"], candidate["producto_id"])
            if key in selected_keys:
                continue
            selected.append(candidate)
            selected_keys.add(key)
            if len(selected) >= target_count:
                break

    return selected


def _calculate_random_inspection_coverage(user, candidate_keys):
    if not candidate_keys:
        return 0.0

    reviewed_rows = InspeccionAleatoriaItem.objects.filter(
        inspeccion__usuario=user
    ).values_list("sucursal_id", "producto_id")
    reviewed_keys = {
        (int(sucursal_id), int(producto_id))
        for sucursal_id, producto_id in reviewed_rows
        if sucursal_id is not None and producto_id is not None
    }
    reviewed_in_scope = len(candidate_keys.intersection(reviewed_keys))
    return round((reviewed_in_scope / len(candidate_keys)) * 100, 2)


def _build_random_inspection_reminder(inspection, user):
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
    description = (
        f"Inspeccion aleatoria diaria: revisa {total_items} {items_label} del inventario y confirma "
        "si coinciden con el sistema."
    )
    return {
        "id": reminder_id,
        "date": date_value,
        "time": f"{RANDOM_INSPECTION_START_HOUR:02d}:00",
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
):
    existing_payload = (
        list(store.payload)
        if isinstance(store.payload, list)
        else []
    )
    reminder = _sanitize_reminder(_build_random_inspection_reminder(inspection, user))
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
    if now_local.time() < dt_time(hour=RANDOM_INSPECTION_START_HOUR):
        return None, False

    scheduled_date = now_local.date()
    inspection = (
        InspeccionAleatoriaDiaria.objects.select_for_update()
        .filter(usuario=user, fecha_programada=scheduled_date)
        .first()
    )

    changed_payload = False
    if inspection is None:
        candidates = _collect_random_inspection_candidates(user)
        if not candidates:
            return None, False

        items_per_day = _resolve_random_inspection_items_per_day()
        selected = _select_random_inspection_candidates(
            user,
            scheduled_date,
            candidates,
            items_per_day=items_per_day,
        )
        if not selected:
            return None, False

        candidate_keys = {
            (candidate["sucursal_id"], candidate["producto_id"])
            for candidate in candidates
        }
        coverage = _calculate_random_inspection_coverage(user, candidate_keys)

        inspection = InspeccionAleatoriaDiaria.objects.create(
            usuario=user,
            fecha_programada=scheduled_date,
            estado=InspeccionAleatoriaDiaria.Estados.PENDIENTE,
            total_items=len(selected),
            cobertura_porcentaje=coverage,
        )

        items = []
        for row in selected:
            items.append(
                InspeccionAleatoriaItem(
                    inspeccion=inspection,
                    sucursal_id=int(row["sucursal_id"]),
                    producto_id=int(row["producto_id"]),
                    cantidad_esperada=int(row["cantidad_esperada"]),
                )
            )
        InspeccionAleatoriaItem.objects.bulk_create(items)

    changed_payload = _upsert_random_inspection_reminder(
        store,
        inspection,
        user,
        mark_completed=inspection.estado == InspeccionAleatoriaDiaria.Estados.COMPLETADA,
    )
    return inspection, changed_payload


def _serialize_random_inspection_item(item):
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
        "cantidad_esperada": int(item.cantidad_esperada or 0),
        "estado_revision": str(item.estado_revision or "").strip(),
        "cantidad_reportada": (
            int(item.cantidad_reportada)
            if item.cantidad_reportada is not None
            else None
        ),
        "observacion": _normalize_text(item.observacion),
        "revisado_en": _parse_iso_timestamp(item.revisado_en),
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


def _serialize_random_inspection(inspection):
    inspection_items = list(
        inspection.items.select_related("sucursal", "producto", "verificado_por").all()
    )
    return {
        "id": int(inspection.id),
        "usuario_id": int(inspection.usuario_id),
        "fecha_programada": inspection.fecha_programada.isoformat(),
        "estado": str(inspection.estado or "").strip(),
        "total_items": int(inspection.total_items or len(inspection_items)),
        "cobertura_porcentaje": float(inspection.cobertura_porcentaje or 0),
        "completada_en": _parse_iso_timestamp(inspection.completada_en),
        "items": [_serialize_random_inspection_item(item) for item in inspection_items],
    }


def _serialize_random_inspection_admin_item(item):
    serialized = _serialize_random_inspection_item(item)
    inspection = getattr(item, "inspeccion", None)
    inspection_user = getattr(inspection, "usuario", None)
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
    if getattr(user, "is_staff", False) or getattr(user, "is_superuser", False):
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
            Q(is_staff=True)
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


def _adjust_inventory_for_inspection_verification(*, sucursal_id, producto_id, delta):
    delta = int(delta or 0)
    if delta == 0:
        return

    stock_queryset = (
        Inventario.objects.select_for_update()
        .filter(
            producto_id=int(producto_id),
            subdivision__division__bodega__sucursal_id=int(sucursal_id),
        )
        .order_by("id")
    )

    if delta < 0:
        required = abs(delta)
        available = sum(int(item.cantidad or 0) for item in stock_queryset)
        if available < required:
            raise ValidationError(
                {
                    "detail": (
                        "No hay suficiente inventario actual para aplicar la reduccion confirmada."
                    )
                }
            )

        remaining = required
        for row in stock_queryset:
            if remaining <= 0:
                break
            current_qty = int(row.cantidad or 0)
            take = min(current_qty, remaining)
            if take <= 0:
                continue
            row.cantidad = current_qty - take
            row.save(update_fields=["cantidad"])
            remaining -= take
        return

    target = stock_queryset.filter(cantidad__gt=0).first() or stock_queryset.first()
    if target is not None:
        target.cantidad = int(target.cantidad or 0) + delta
        target.save(update_fields=["cantidad"])
        return

    subdivision = (
        SubDivision.objects.select_related("division__bodega")
        .filter(division__bodega__sucursal_id=int(sucursal_id))
        .order_by("id")
        .first()
    )
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


class ReminderStateAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            current_payload = (
                store.payload
                if isinstance(store.payload, list)
                else []
            )
            reminders = _normalize_reminder_list(current_payload)
            payload_changed = reminders != current_payload
            if payload_changed:
                store.payload = reminders

            _, inspection_payload_changed = _ensure_daily_random_inspection_for_user(
                request.user,
                store,
            )
            payload_changed = payload_changed or inspection_payload_changed

            if payload_changed:
                store.save(update_fields=["payload", "updated_at"])
            reminders = _normalize_reminder_list(store.payload)

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


def _normalize_random_inspection_verify_action(value):
    normalized = _normalize_text(value).lower()
    if normalized in {"aprobar", "aprobada", "confirmar", "ajustar"}:
        return "aprobar"
    if normalized in {"rechazar", "rechazada", "descartar"}:
        return "rechazar"
    return ""


def _get_random_inspection_queryset():
    return (
        InspeccionAleatoriaDiaria.objects.select_related("usuario")
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
            {"inspection": _serialize_random_inspection(inspection)},
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
            {"inspection": _serialize_random_inspection(inspection)},
            status=status.HTTP_200_OK,
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
            inspection = (
                InspeccionAleatoriaDiaria.objects.select_for_update()
                .select_related("usuario")
                .prefetch_related("items__sucursal", "items__producto", "items__verificado_por")
                .filter(pk=inspection_id)
                .first()
            )
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

            if (
                str(inspection.estado).strip().lower()
                == InspeccionAleatoriaDiaria.Estados.COMPLETADA
            ):
                return Response(
                    {
                        "detail": (
                            "Esta inspeccion ya fue enviada y no puede volver a realizarse."
                        )
                    },
                    status=status.HTTP_409_CONFLICT,
                )

            inspection_items = list(inspection.items.all().order_by("id"))
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

            now = timezone.now()
            mismatch_count = 0
            for item in inspection_items:
                row = payload_by_id.get(int(item.id), {})
                estado_revision = _normalize_random_inspection_review_state(
                    row.get("estado_revision")
                    or row.get("estado")
                    or row.get("resultado")
                )
                if estado_revision == InspeccionAleatoriaItem.EstadosRevision.PENDIENTE:
                    return Response(
                        {
                            "detail": (
                                "Todos los productos deben marcarse como coincide o no coincide."
                            ),
                            "item_id": int(item.id),
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                cantidad_reportada = row.get("cantidad_reportada")
                if estado_revision == InspeccionAleatoriaItem.EstadosRevision.NO_COINCIDE:
                    if cantidad_reportada is None:
                        return Response(
                            {
                                "detail": (
                                    "Cuando un producto no coincide debes indicar la cantidad real."
                                ),
                                "item_id": int(item.id),
                            },
                            status=status.HTTP_400_BAD_REQUEST,
                        )

                    cantidad_reportada = _normalize_int(cantidad_reportada, -1)
                    if cantidad_reportada < 0:
                        return Response(
                            {
                                "detail": "La cantidad reportada debe ser un numero valido.",
                                "item_id": int(item.id),
                            },
                            status=status.HTTP_400_BAD_REQUEST,
                        )
                    mismatch_count += 1
                    verificacion_estado = InspeccionAleatoriaItem.EstadosVerificacion.PENDIENTE
                else:
                    cantidad_reportada = int(item.cantidad_esperada or 0)
                    verificacion_estado = InspeccionAleatoriaItem.EstadosVerificacion.SIN_NOVEDAD

                item.estado_revision = estado_revision
                item.cantidad_reportada = int(cantidad_reportada)
                item.observacion = _normalize_text(
                    row.get("observacion") or row.get("novedad")
                )
                item.revisado_en = now
                item.verificacion_estado = verificacion_estado
                item.save(
                    update_fields=[
                        "estado_revision",
                        "cantidad_reportada",
                        "observacion",
                        "revisado_en",
                        "verificacion_estado",
                        "updated_at",
                    ]
                )

            inspection.estado = InspeccionAleatoriaDiaria.Estados.COMPLETADA
            inspection.total_items = len(inspection_items)
            inspection.completada_en = now
            inspection.save(
                update_fields=["estado", "total_items", "completada_en", "updated_at"]
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

        return Response(
            {
                "inspection": _serialize_random_inspection(inspection),
                "mismatch_count": int(mismatch_count),
            },
            status=status.HTTP_200_OK,
        )


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
                InspeccionAleatoriaItem.objects.select_for_update()
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

            if action == "aprobar":
                cantidad_confirmada_raw = request.data.get("cantidad_confirmada")
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

                expected_qty = int(item.cantidad_esperada or 0)
                delta = int(cantidad_confirmada) - expected_qty
                _adjust_inventory_for_inspection_verification(
                    sucursal_id=item.sucursal_id,
                    producto_id=item.producto_id,
                    delta=delta,
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
                "inspection": _serialize_random_inspection(inspection),
                "item_id": int(item_id),
                "accion": action,
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
                productos_revisados=Count("producto_id", distinct=True),
                inspecciones_totales=Count("inspeccion_id", distinct=True),
                items_revisados=Count("id"),
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
        limit = _normalize_int(request.query_params.get("limit"), 200)
        if limit <= 0:
            limit = 200
        limit = min(limit, 500)

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
            .order_by("-revisado_en", "-id")
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

        rows = list(queryset[:limit])
        serialized = [_serialize_random_inspection_admin_item(item) for item in rows]

        return Response(
            {
                "results": serialized,
                "count": len(serialized),
                "sucursal_id": int(sucursal_id),
                "estado": estado,
            },
            status=status.HTTP_200_OK,
        )
