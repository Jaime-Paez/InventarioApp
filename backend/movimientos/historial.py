"""Historial de un movimiento (entrada/salida): creacion, ediciones, cambios de
estado, etapas del traslado, envios de una compra local a otras sucursales y
los inconvenientes con sus resoluciones.

No hay una tabla propia de eventos: se arma con lo que ya se guarda
(auditoria, SolicitudTraslado.historial_transfer, ImportacionEnvio e
historiales de inconvenientes). Cada evento:

    {"at": iso, "solo_fecha": bool, "tipo": str, "titulo": str,
     "detalle": str, "actor": str}
"""

from datetime import date, datetime, time, timedelta

from django.contrib.contenttypes.models import ContentType
from django.utils import timezone

from auditoria.models import RegistroAuditoria
from importaciones.models import ImportacionInconveniente
from tipos.models import EstadoMovimiento

from .models import MovimientoInventario, SolicitudTraslado, TrasladoInconveniente
from .serializers import format_actor_display_name

# Campos que se guardan solos (borradores, progreso) y no son una edicion.
_NOISE_FIELDS = {"borrador_distribucion", "borrador_recepcion", "recepcion_progreso"}

_FIELD_LABELS = {
    "no_documento": "No. de documento",
    "fecha": "Fecha",
    "nota": "Nota",
    "observacion": "Observacion",
    "sucursal_id": "Sucursal",
    "sucursal_destino_id": "Sucursal destino",
    "cliente_id": "Cliente",
    "sub_tipo_movimiento_id": "Tipo",
    "proveedor_id": "Proveedor",
    "casa_comercial_id": "Casa comercial",
}

_GARANTIA_LABELS = dict(MovimientoInventario.EstadoGarantia.choices)

_TRANSFER_STAGE_TITLES = {
    "pendiente": "Solicitud de traslado creada",
    "aceptada": "Solicitud aceptada",
    "rechazada": "Solicitud rechazada o cancelada",
    "enviado": "Traslado enviado",
    "completo": "Traslado recibido completo",
    "incompleto": "Traslado recibido con faltantes",
}

_TRANSFER_STAGES_WITH_DETAIL = {"rechazada", "incompleto"}

_INCONVENIENTE_TITLES = {
    "detectado": "Inconveniente detectado",
}

# Ediciones seguidas del mismo usuario dentro de este lapso se muestran como una.
_EDIT_MERGE_WINDOW = timedelta(minutes=3)


def _as_datetime(value):
    if value is None:
        return None, False
    if isinstance(value, datetime):
        if timezone.is_naive(value):
            value = timezone.make_aware(value, timezone.get_current_timezone())
        return value, False
    if isinstance(value, date):
        aware = timezone.make_aware(datetime.combine(value, time.min), timezone.get_current_timezone())
        return aware, True
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None, False
        return _as_datetime(parsed)
    return None, False


def _event(at, tipo, titulo, detalle="", actor=""):
    moment, solo_fecha = _as_datetime(at)
    if moment is None:
        return None
    return {
        "at": moment.isoformat(),
        "solo_fecha": solo_fecha,
        "tipo": tipo,
        "titulo": titulo,
        "detalle": str(detalle or "").strip(),
        "actor": str(actor or "").strip(),
        "_sort": moment,
    }


def _audit_events(movimiento):
    content_type = ContentType.objects.get_for_model(MovimientoInventario)
    registros = (
        RegistroAuditoria.objects.filter(content_type=content_type, object_id=str(movimiento.pk))
        .select_related("usuario")
        .order_by("registrado_en", "id")
    )
    estados = {}
    events = []
    has_creation = False
    last_edit = None
    for registro in registros:
        actor = format_actor_display_name(registro.usuario) if registro.usuario_id else ""
        if registro.accion == RegistroAuditoria.Acciones.CREACION:
            has_creation = True
            events.append(_event(registro.registrado_en, "creacion", "Creado", actor=actor))
            last_edit = None
            continue
        if registro.accion != RegistroAuditoria.Acciones.ACTUALIZACION:
            continue

        previos = registro.valores_previos or {}
        nuevos = registro.valores_nuevos or {}
        changed = [
            key
            for key in set(previos) | set(nuevos)
            if key not in _NOISE_FIELDS and previos.get(key) != nuevos.get(key)
        ]
        if not changed:
            continue

        if "estado_movimiento_id" in changed:
            estado_id = nuevos.get("estado_movimiento_id")
            if estado_id not in estados:
                estados[estado_id] = (
                    EstadoMovimiento.objects.filter(pk=estado_id).values_list("nombre", flat=True).first() or ""
                )
            nombre = estados[estado_id]
            events.append(
                _event(registro.registrado_en, "estado", f"Estado: {nombre}" if nombre else "Cambio de estado", actor=actor)
            )
            changed.remove("estado_movimiento_id")
            last_edit = None
        if "estado_garantia" in changed:
            label = _GARANTIA_LABELS.get(nuevos.get("estado_garantia"), nuevos.get("estado_garantia") or "")
            events.append(_event(registro.registrado_en, "estado", f"Garantia: {label}", actor=actor))
            changed.remove("estado_garantia")
            last_edit = None

        labels = sorted({_FIELD_LABELS[key] for key in changed if key in _FIELD_LABELS})
        if not changed:
            continue
        detalle = f"Cambios en: {', '.join(labels)}" if labels else ""
        if (
            last_edit is not None
            and last_edit["actor"] == actor
            and registro.registrado_en - last_edit["_sort"] <= _EDIT_MERGE_WINDOW
        ):
            if labels:
                previous = set(filter(None, last_edit.get("_labels", [])))
                merged = sorted(previous | set(labels))
                last_edit["_labels"] = merged
                last_edit["detalle"] = f"Cambios en: {', '.join(merged)}"
            continue
        last_edit = _event(registro.registrado_en, "edicion", "Editado", detalle, actor)
        last_edit["_labels"] = labels
        events.append(last_edit)
    return events, has_creation


def _transfer_events(movimiento):
    solicitud = (
        SolicitudTraslado.objects.filter(movimiento_salida=movimiento).first()
        or SolicitudTraslado.objects.filter(movimiento_entrada=movimiento).first()
    )
    if solicitud is None:
        return []
    events = []
    stages = set()
    for entry in solicitud.historial_transfer or []:
        if not isinstance(entry, dict):
            continue
        stage = str(entry.get("stage") or "").strip().lower()
        stages.add(stage)
        actor = entry.get("actor") or {}
        events.append(
            _event(
                entry.get("at"),
                "traslado",
                _TRANSFER_STAGE_TITLES.get(stage) or str(entry.get("label") or "Traslado").strip(),
                # El texto del recordatorio solo aporta en un rechazo (motivo)
                # o en una recepcion con faltantes.
                (entry.get("description") or "") if stage in _TRANSFER_STAGES_WITH_DETAIL else "",
                actor.get("name") if isinstance(actor, dict) else "",
            )
        )
    if "pendiente" not in stages and solicitud.created_at:
        events.append(
            _event(
                solicitud.created_at,
                "traslado",
                _TRANSFER_STAGE_TITLES["pendiente"],
                actor=format_actor_display_name(solicitud.creado_por),
            )
        )

    for inconveniente in TrasladoInconveniente.objects.filter(solicitud=solicitud).prefetch_related(
        "historial__actor"
    ).select_related("producto"):
        events.extend(_inconveniente_events(inconveniente))
    return events


def _inconveniente_events(inconveniente):
    producto = getattr(inconveniente, "producto", None)
    codigo = str(getattr(producto, "codigo", "") or "").strip()
    events = []
    for item in inconveniente.historial.all():
        accion = str(item.accion or "").strip()
        titulo = _INCONVENIENTE_TITLES.get(accion.lower()) or f"Inconveniente: {accion}"
        if codigo:
            titulo = f"{titulo} ({codigo})"
        events.append(
            _event(item.created_at, "inconveniente", titulo, item.detalle, format_actor_display_name(item.actor))
        )
    return events


def _compra_local_events(movimiento):
    events = []
    envios = movimiento.envios_compra.select_related("sucursal", "llegada_confirmada_por", "recibido_por")
    for envio in envios:
        sucursal = str(getattr(envio.sucursal, "nombre", "") or "").strip() or "otra sucursal"
        documento = str(envio.no_documento or "").strip()
        events.append(
            _event(
                envio.fecha,
                "envio",
                f"Enviado a {sucursal}",
                f"Documento: {documento}" if documento else "",
            )
        )
        if envio.llegada_confirmada_en:
            events.append(
                _event(
                    envio.llegada_confirmada_en,
                    "envio",
                    f"Llego a {sucursal}",
                    actor=format_actor_display_name(envio.llegada_confirmada_por),
                )
            )
        if envio.fecha_recepcion:
            events.append(
                _event(
                    envio.fecha_recepcion,
                    "envio",
                    f"Recibido en {sucursal}",
                    actor=format_actor_display_name(envio.recibido_por),
                )
            )

    for inconveniente in ImportacionInconveniente.objects.filter(compra_local=movimiento).prefetch_related(
        "historial__actor"
    ).select_related("producto"):
        events.extend(_inconveniente_events(inconveniente))
    return events


def build_movement_history(movimiento):
    events, has_creation = _audit_events(movimiento)
    if not has_creation and movimiento.fecha:
        events.append(
            _event(movimiento.fecha, "creacion", "Creado", actor=format_actor_display_name(movimiento.creado_por))
        )
    events.extend(_transfer_events(movimiento))
    events.extend(_compra_local_events(movimiento))

    events = [event for event in events if event]
    # Dia completo (sin hora) va al inicio de su dia; mas reciente primero.
    events.sort(key=lambda event: event["_sort"], reverse=True)
    for event in events:
        event.pop("_sort", None)
        event.pop("_labels", None)
    return events
