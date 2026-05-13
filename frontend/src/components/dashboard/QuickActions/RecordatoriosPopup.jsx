import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Loader2, Plus, X } from 'lucide-react'
import useModalAnimation from '../common/useModalAnimation'
import { API_URL, authFetch } from '../../../utils/api'
import {
  buildTransferHistoryEntry,
  buildReminderStatusForUser,
  createReminderId,
  extractUserId,
  fetchRemindersFromBackend,
  formatCurrentUserName,
  getReminderDecisionStatus,
  getTransferReminderHistory,
  getTransferReceiptOutcome,
  isReminderCreatedByCurrentUser,
  isRandomInspectionDailyReminder,
  isRandomInspectionVerifyReminder,
  isReminderForContext,
  isTransferIssueReminder,
  reminderCompletedByIds,
  isTransferDecisionAllowedForUser,
  isSpecialTransferDecisionReminder,
  normalizeId,
  sanitizeRecipient,
  upsertTransferReminder,
} from '../common/reminders/remindersStorage'
import './RecordatoriosPopup.css'

const REJECTED_TRANSFER_EDITING_EVENT = 'inventario-rejected-transfer-editing'

const getNowDateParts = () => {
  const now = new Date()
  return {
    date: normalizeWorkingDateKey(formatDateKey(now)) || formatDateKey(now),
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  }
}

const TRANSFER_CONTEXT_DEFAULT_TITLE = 'Traslado'

const getTransferContextPresentation = (reminder) => {
  const rawLabel = String(reminder?.context?.label || '').trim()
  const contextId = normalizeId(reminder?.context?.id)
  const extractedReference = extractTransferDocumentNumber(rawLabel || reminder?.description || '')
  const reference = extractedReference ? `#${extractedReference}` : (contextId ? `#${contextId}` : '')
  const baseLabel = rawLabel.replace(/\s*#[A-Za-z0-9._-]+.*$/, '').trim()

  let title = TRANSFER_CONTEXT_DEFAULT_TITLE
  if (/^traslado directo\b/i.test(baseLabel)) {
    title = 'Traslado directo'
  } else if (/^solicitud(?: de)? traslado\b/i.test(baseLabel)) {
    title = TRANSFER_CONTEXT_DEFAULT_TITLE
  } else if (/^traslado\b/i.test(baseLabel)) {
    title = TRANSFER_CONTEXT_DEFAULT_TITLE
  } else if (baseLabel) {
    title = baseLabel
  }

  return {
    title,
    reference,
    fullLabel: reference ? `${title} ${reference}` : title,
  }
}

const formatReminderContext = (reminder) => {
  if (normalizeReminderContextType(reminder?.context?.type) === 'solicitud_traslado') {
    return getTransferContextPresentation(reminder).fullLabel
  }

  const label = String(reminder?.context?.label || '').trim()
  if (label) return label

  const type = String(reminder?.context?.type || '').trim()
  if (!type) return 'General'

  if (type === 'solicitud_traslado') return 'Traslado'

  const formatted = type.replace(/[_-]+/g, ' ')
  return formatted.charAt(0).toUpperCase() + formatted.slice(1)
}

const buildTransferResponseDescription = (reminder, decisionStatus) => {
  const contextType = normalizeReminderContextType(reminder?.context?.type)
  if (contextType !== 'solicitud_traslado') return String(reminder?.description || '').trim() || '-'

  const { reference: contextReference } = getTransferContextPresentation(reminder)

  if (decisionStatus === 'enviado') {
    if (contextReference) return `El traslado ${contextReference} fue enviado y está en camino.`
    return 'El traslado fue enviado y está en camino.'
  }

  if (decisionStatus === 'recibido') {
    if (contextReference) return `El traslado ${contextReference} fue entregado y recibido.`
    return 'El traslado fue entregado y recibido.'
  }

  if (decisionStatus === 'rechazada') {
    const explicitReason = String(reminder?.decision?.reason || '').trim()
    const description = String(reminder?.description || '').trim()
    const reasonMatch = description.match(/motivo:\s*(.+)$/i)
    const reason = explicitReason || String(reasonMatch?.[1] || '').trim()

    if (contextReference) {
      return reason
        ? `Su traslado ${contextReference} fue rechazado. Motivo: ${reason}`
        : `Su traslado ${contextReference} fue rechazado.`
    }
    return reason
      ? `Su traslado fue rechazado. Motivo: ${reason}`
      : 'Su traslado fue rechazado.'
  }

  if (decisionStatus === 'aceptada') {
    if (contextReference) return `Su traslado ${contextReference} fue aceptado.`
    return 'Su traslado fue aceptado.'
  }

  if (decisionStatus === 'cancelado') {
    if (contextReference) return `Su traslado ${contextReference} fue cancelado.`
    return 'Su traslado fue cancelado.'
  }

  return String(reminder?.description || '').trim() || '-'
}

const normalizeTransferHistoryDescription = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()

const normalizeTransferHistoryTimestamp = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''

  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) return raw
  return new Date(parsed).toISOString()
}

const areTransferHistoryTimestampsEquivalent = (firstValue, secondValue) => {
  const firstTimestamp = Date.parse(normalizeTransferHistoryTimestamp(firstValue))
  const secondTimestamp = Date.parse(normalizeTransferHistoryTimestamp(secondValue))

  if (Number.isFinite(firstTimestamp) && Number.isFinite(secondTimestamp)) {
    return Math.abs(firstTimestamp - secondTimestamp) <= 2000
  }

  return normalizeTransferHistoryTimestamp(firstValue) === normalizeTransferHistoryTimestamp(secondValue)
}

const areTransferHistoryActorsEquivalent = (firstEntry, secondEntry) => {
  const firstActorId = normalizeId(firstEntry?.actor?.id)
  const secondActorId = normalizeId(secondEntry?.actor?.id)
  if (!firstActorId || !secondActorId) return true
  return firstActorId === secondActorId
}

const areTransferHistoryDescriptionsEquivalent = (firstEntry, secondEntry) => {
  const firstDescription = normalizeTransferHistoryDescription(firstEntry?.description)
  const secondDescription = normalizeTransferHistoryDescription(secondEntry?.description)
  if (!firstDescription || !secondDescription) return true
  return firstDescription === secondDescription
}

const areTransferHistoryEntriesEquivalent = (firstEntry, secondEntry, { ignoreDescription = false } = {}) => {
  const sameStage = normalizeStateText(firstEntry?.stage) === normalizeStateText(secondEntry?.stage)
  if (!sameStage) return false
  if (!areTransferHistoryTimestampsEquivalent(firstEntry?.at, secondEntry?.at)) return false
  if (!areTransferHistoryActorsEquivalent(firstEntry, secondEntry)) return false
  if (!ignoreDescription && !areTransferHistoryDescriptionsEquivalent(firstEntry, secondEntry)) return false
  return true
}

const pickPreferredTransferHistoryEntry = (currentEntry, candidateEntry) => {
  const currentDescription = String(currentEntry?.description || '').trim()
  const candidateDescription = String(candidateEntry?.description || '').trim()
  const currentLabel = String(currentEntry?.label || '').trim()
  const candidateLabel = String(candidateEntry?.label || '').trim()
  const candidateActorId = normalizeId(candidateEntry?.actor?.id)
  const currentTimestamp = normalizeTransferHistoryTimestamp(currentEntry?.at)
  const candidateTimestamp = normalizeTransferHistoryTimestamp(candidateEntry?.at)

  return {
    ...(currentEntry || {}),
    ...(candidateEntry || {}),
    description: candidateDescription || currentDescription,
    label: candidateLabel || currentLabel,
    actor: candidateActorId ? candidateEntry?.actor : currentEntry?.actor,
    at: candidateTimestamp || currentTimestamp,
  }
}

const hasEquivalentTransferHistoryEntry = (entries, candidateEntry, options = {}) =>
  (Array.isArray(entries) ? entries : []).some((entry) =>
    areTransferHistoryEntriesEquivalent(entry, candidateEntry, options)
  )

const collapseTransferHistoryDuplicates = (entries) => {
  const collapsed = []

  ;(Array.isArray(entries) ? entries : []).forEach((entry) => {
    const duplicateIndex = collapsed.findIndex((existingEntry) =>
      areTransferHistoryEntriesEquivalent(existingEntry, entry)
    )

    if (duplicateIndex >= 0) {
      collapsed[duplicateIndex] = pickPreferredTransferHistoryEntry(collapsed[duplicateIndex], entry)
      return
    }

    collapsed.push(entry)
  })

  return [...collapsed].sort((a, b) =>
    String(a?.at || '').localeCompare(String(b?.at || ''))
  )
}

const mergeTransferHistoryEntriesBySignature = (...sources) => {
  const bySignature = new Map()

  sources.forEach((source) => {
    ;(Array.isArray(source) ? source : []).forEach((entry) => {
      const actorId = normalizeId(entry?.actor?.id)
      const signature = [
        String(entry?.stage || '').trim(),
        normalizeTransferHistoryTimestamp(entry?.at),
        actorId,
        normalizeTransferHistoryDescription(entry?.description),
      ].join('|')
      if (!signature.replace(/\|/g, '')) return
      bySignature.set(signature, entry)
    })
  })

  return collapseTransferHistoryDuplicates(
    Array.from(bySignature.values()).sort((a, b) =>
      String(a?.at || '').localeCompare(String(b?.at || ''))
    )
  )
}

const getReminderRawTransferHistory = (reminder) => (
  Array.isArray(reminder?.transferHistory)
    ? reminder.transferHistory
    : Array.isArray(reminder?.history)
      ? reminder.history
      : []
)

const mergeTransferHistoryForContext = (reminders, contextType, contextId) => {
  const normalizedContextType = normalizeReminderContextType(contextType)
  const normalizedContextId = normalizeId(contextId)
  if (normalizedContextType !== 'solicitud_traslado' || !normalizedContextId) return []

  const explicitHistories = []
  const fallbackHistories = []
  ;(Array.isArray(reminders) ? reminders : []).forEach((reminder) => {
    if (normalizeReminderContextType(reminder?.context?.type) !== normalizedContextType) return
    if (normalizeId(reminder?.context?.id) !== normalizedContextId) return

    const rawHistory = getReminderRawTransferHistory(reminder)
    if (rawHistory.length) {
      explicitHistories.push(getTransferReminderHistory({
        ...reminder,
        transferHistory: rawHistory,
      }))
      return
    }

    fallbackHistories.push(getTransferReminderHistory(reminder))
  })

  if (explicitHistories.length) {
    return mergeTransferHistoryEntriesBySignature(...explicitHistories)
  }

  return mergeTransferHistoryEntriesBySignature(...fallbackHistories)
}

const normalizeReminderContextType = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')

const emitRejectedTransferEditingState = (solicitudId, active) => {
  if (typeof window === 'undefined') return
  const normalizedSolicitudId = normalizeId(solicitudId)
  if (!normalizedSolicitudId) return

  window.dispatchEvent(
    new CustomEvent(REJECTED_TRANSFER_EDITING_EVENT, {
      detail: {
        solicitudId: normalizedSolicitudId,
        active: Boolean(active),
      },
    })
  )
}

const normalizeStateText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()

const TRANSFER_PROGRESS_STAGE_RANK = {
  pendiente: 0,
  aceptada: 1,
  enviado: 2,
  recibido: 3,
}

const normalizeTransferProgressStage = (value) => {
  const normalized = normalizeStateText(value)
  if (!normalized) return 'pendiente'
  if (normalized.includes('recib') || normalized.includes('llego')) {
    return 'recibido'
  }
  if (normalized.includes('envi') || normalized.includes('traslado') || normalized.includes('transito')) {
    return 'enviado'
  }
  if (normalized.includes('acept')) return 'aceptada'
  return 'pendiente'
}

const getTransferProgressStageLabel = (stage) => {
  const normalizedStage = normalizeTransferProgressStage(stage)
  if (normalizedStage === 'recibido') {
    return 'Llego'
  }
  if (normalizedStage === 'enviado') return 'Enviado'
  if (normalizedStage === 'aceptada') return 'Aceptada'
  return 'Pendiente'
}

const getTransferHistoryStageLabel = (stage) => {
  const normalized = normalizeStateText(stage)
  if (normalized === 'pendiente') return 'Traslado creado'
  if (normalized === 'aceptada') return 'Traslado aceptado'
  if (normalized === 'rechazada') return 'Traslado rechazado'
  if (normalized === 'cancelado') return 'Traslado cancelado'
  if (normalized === 'enviado') return 'Traslado enviado'
  if (normalized === 'recibido') return 'Traslado recibido'
  if (normalized === 'completo') return 'Traslado recibido completo'
  if (normalized === 'incompleto') return 'Traslado recibido incompleto'
  return String(stage || 'Evento').trim() || 'Evento'
}

const getTransferHistoryDisplayLabel = (entry, previousEntries = []) => {
  const normalized = normalizeStateText(entry?.stage)
  if (normalized === 'pendiente') {
    const comesFromCorrection = previousEntries.some((previousEntry) => {
      const previousStage = normalizeStateText(previousEntry?.stage)
      return previousStage === 'rechazada' || previousStage === 'cancelado'
    })

    if (comesFromCorrection) return 'Traslado corregido'
  }

  return String(entry?.label || '').trim() || getTransferHistoryStageLabel(entry?.stage)
}

const getTransferHistoryVisualStatus = (stage, customLabel = '') => {
  const normalized = normalizeStateText(stage)
  const label = String(customLabel || '').trim() || getTransferHistoryStageLabel(stage)

  if (normalized === 'aceptada') {
    return { label, className: 'accepted' }
  }
  if (normalized === 'rechazada') {
    return { label, className: 'rejected' }
  }
  if (normalized === 'cancelado') {
    return { label, className: 'cancelled' }
  }
  if (normalized === 'enviado') {
    return { label, className: 'sent' }
  }
  if (normalized === 'completo' || normalized === 'incompleto' || normalized === 'recibido') {
    return { label, className: 'arrived' }
  }

  return { label, className: 'pending' }
}

const extractTransferHistoryRejectionReason = (entry) => {
  const normalizedStage = normalizeStateText(entry?.stage)
  if (normalizedStage !== 'rechazada') return ''

  const explicitReason = String(entry?.reason || entry?.motivo || '').trim()
  if (explicitReason) return explicitReason

  const description = String(entry?.description || '').trim()
  if (!description) return ''

  const reasonMatch = description.match(/motivo:\s*(.+)$/i)
  return String(reasonMatch?.[1] || '').trim()
}

const buildInferredDecisionHistoryEntry = (reminder) => {
  const decisionStatus = normalizeStateText(reminder?.decision?.status)
  if (!['aceptada', 'rechazada', 'cancelado'].includes(decisionStatus)) return null
 
  const at = normalizeTransferHistoryTimestamp(reminder?.decision?.at)
  if (!at) return null

  const actor = sanitizeRecipient(reminder?.decision?.by)
  const description = buildTransferResponseDescription(reminder, decisionStatus)

  return {
    stage: decisionStatus,
    label: '',
    description,
    at,
    actor,
  }
}

const getTransferVisualDecisionStatus = ({
  decisionStatus,
  latestTransferStage,
  receiptOutcome = '',
}) => {
  if (receiptOutcome === 'completo' || receiptOutcome === 'incompleto') {
    return 'recibido'
  }
  const normalizedStage = normalizeTransferProgressStage(latestTransferStage)
  if (normalizedStage === 'recibido') return 'recibido'
  if (normalizedStage === 'enviado') return 'enviado'
  if (normalizedStage === 'aceptada') return 'aceptada'
  return decisionStatus
}

const getTransferVisualStatus = (baseStatus, visualDecisionStatus) => {
  if (visualDecisionStatus === 'recibido') {
    return {
      label: 'Cumplido',
      className: 'arrived',
      canMarkSeen: false,
    }
  }
  if (visualDecisionStatus === 'enviado') {
    return {
      label: 'Enviado',
      className: 'sent',
      canMarkSeen: false,
    }
  }
  if (visualDecisionStatus === 'aceptada') {
    return {
      label: 'Aceptada',
      className: 'accepted',
      canMarkSeen: false,
    }
  }
  if (visualDecisionStatus === 'rechazada') {
    return {
      label: 'Rechazada',
      className: 'rejected',
      canMarkSeen: false,
    }
  }
  if (visualDecisionStatus === 'cancelado') {
    return {
      label: 'Cancelado',
      className: 'cancelled',
      canMarkSeen: false,
    }
  }
  return baseStatus
}

const extractTransferDocumentNumber = (value) => {
  const match = String(value || '').match(/#([A-Za-z0-9._-]+)/)
  return match ? String(match[1] || '').trim() : ''
}

const getTimelineReminderContextTitle = (reminder) => {
  const contextType = normalizeReminderContextType(reminder?.context?.type)
  if (isTransferIssueReminder(reminder) || contextType === 'solicitud_traslado') {
    return getTransferContextPresentation(reminder).title
  }
  return formatReminderContext(reminder)
}

const getTimelineReminderContextReference = (reminder) => {
  const contextType = normalizeReminderContextType(reminder?.context?.type)
  if (isTransferIssueReminder(reminder) || contextType === 'solicitud_traslado') {
    return getTransferContextPresentation(reminder).reference
  }
  return ''
}

const getTimelineReminderSummary = ({
  reminder,
  isTransferIssue,
  isTransferContextReminder,
  isSpecialReminder,
  visualDecisionStatus,
  displayStatus,
}) => {
  if (isTransferIssue) {
    const normalizedDescription = normalizeStateText(reminder?.description)
    if (normalizedDescription.includes('resuelto')) return 'Resuelto.'
    if (normalizedDescription.includes('perdido')) return 'Marcado como perdido.'
    return displayStatus?.label === 'Cumplido' ? 'Resuelto.' : 'Pendiente por resolver.'
  }

  if (isTransferContextReminder && !isSpecialReminder) {
    if (visualDecisionStatus === 'recibido') return 'Entregado y recibido.'
    if (visualDecisionStatus === 'enviado') return 'En camino.'
    if (visualDecisionStatus === 'aceptada') return 'Aceptado.'
    if (visualDecisionStatus === 'rechazada') return 'Rechazado.'
    if (visualDecisionStatus === 'cancelado') return 'Cancelado.'
  }

  if (isTransferContextReminder && isSpecialReminder) {
    return 'Pendiente de decisión.'
  }

  return String(reminder?.description || '').trim() || '-'
}

const parseNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const resolveTransferEstadoLabel = (rawEstadoLabel, rawEstado) => {
  const estadoLabel = String(rawEstadoLabel || '').trim()
  if (estadoLabel) return estadoLabel

  const estado = String(rawEstado || '').trim().toLowerCase()
  if (estado === 'cancelada' || estado === 'rechazada') return 'Rechazada'
  if (estado === 'aprobada' || estado === 'aceptada') return 'Solicitud aceptada'
  if (estado === 'pendiente') return 'Solicitud pendiente'
  return 'Solicitud pendiente'
}

const mapTransferRowToEntradaPreview = (row) => {
  const solicitudId = String(row?.solicitud_traslado_id || '').trim()
  const isSolicitudTraslado = Boolean(row?.es_solicitud_traslado)
  const rowId = normalizeId(row?.id)
  const movimientoEntradaId = normalizeId(row?.movimiento_entrada_id) || (!isSolicitudTraslado ? rowId : '')
  const detalles = (Array.isArray(row?.detalles) ? row.detalles : []).map((detalle) => {
    const cantidad = parseNumber(detalle?.cantidad)
    const valor = parseNumber(detalle?.valor)
    const valorTotalRaw = Number(detalle?.valor_total)
    const valorTotal = Number.isFinite(valorTotalRaw) ? valorTotalRaw : cantidad * valor
    return {
      id: detalle?.id,
      producto_id: detalle?.producto_id,
      producto_codigo: String(detalle?.producto_codigo || '').trim(),
      producto_nombre: String(detalle?.producto_nombre || '').trim(),
      cantidad,
      valor,
      valor_total: valorTotal,
    }
  })

  const totalRaw = Number(row?.total)
  const total = Number.isFinite(totalRaw)
    ? totalRaw
    : detalles.reduce((acc, detalle) => acc + parseNumber(detalle?.valor_total), 0)

  return {
    id: row?.id || (solicitudId ? `solicitud-${solicitudId}` : undefined),
    no_documento: String(row?.no_documento || '').trim(),
    fecha: row?.fecha || '',
    sucursal_nombre: String(row?.sucursal_nombre || '').trim() || '-',
    sub_tipo_nombre: String(row?.sub_tipo_nombre || '').trim() || 'Traslado (Solicitud)',
    estado_nombre: String(row?.estado_nombre || '').trim() || 'Solicitud pendiente',
    sucursal_objetivo_nombre: String(row?.sucursal_objetivo_nombre || '').trim() || '-',
    funcional: false,
    funcional_label: '-',
    total,
    es_solicitud_traslado: isSolicitudTraslado,
    solicitud_traslado_id: solicitudId || null,
    sucursal_id: row?.sucursal_id || '',
    sucursal_solicitante_id: row?.sucursal_solicitante_id || '',
    sucursal_proveedora_id: row?.sucursal_proveedora_id || '',
    descripcion: String(row?.descripcion || '').trim(),
    motivo_rechazo: String(row?.motivo_rechazo || '').trim(),
    detalles,
    movimiento_salida_id: row?.movimiento_salida_id ?? null,
    movimiento_entrada_id: movimientoEntradaId || null,
  }
}

const mapTransferDetailToEntradaPreview = (detail) => {
  const solicitudId = String(detail?.id || '').trim()
  const detalles = (Array.isArray(detail?.detalles) ? detail.detalles : []).map((detalle) => {
    const cantidad = parseNumber(detalle?.cantidad)
    const valor = parseNumber(detalle?.valor)
    const valorTotal = cantidad * valor
    return {
      id: detalle?.id,
      producto_id: detalle?.producto_id,
      producto_codigo: String(detalle?.producto_codigo || '').trim(),
      producto_nombre: String(detalle?.producto_nombre || '').trim(),
      cantidad,
      valor,
      valor_total: valorTotal,
    }
  })

  return {
    id: solicitudId ? `solicitud-${solicitudId}` : undefined,
    no_documento: String(detail?.no_documento || '').trim(),
    fecha: detail?.fecha || '',
    sucursal_nombre: String(detail?.sucursal_solicitante || '').trim() || '-',
    sub_tipo_nombre: 'Traslado (Solicitud)',
    estado_nombre: resolveTransferEstadoLabel(detail?.estado_label, detail?.estado),
    sucursal_objetivo_nombre: String(detail?.sucursal_proveedora || '').trim() || '-',
    funcional: false,
    funcional_label: '-',
    total: detalles.reduce((acc, detalle) => acc + parseNumber(detalle?.valor_total), 0),
    es_solicitud_traslado: true,
    solicitud_traslado_id: solicitudId || null,
    sucursal_solicitante_id: detail?.sucursal_solicitante_id || '',
    sucursal_proveedora_id: detail?.sucursal_proveedora_id || '',
    descripcion: String(detail?.descripcion || '').trim(),
    motivo_rechazo: String(detail?.motivo_rechazo || '').trim(),
    detalles,
    movimiento_salida_id: detail?.movimiento_salida_id ?? null,
    movimiento_entrada_id: detail?.movimiento_entrada_id ?? null,
  }
}

const parseDateKey = (value) => {
  const raw = String(value || '').trim()
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(year, month - 1, day)
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null
  }
  return parsed
}

const formatDateKey = (value) => {
  const date = value instanceof Date ? value : parseDateKey(value)
  if (!date || Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const isSundayDateKey = (value) => {
  const parsed = parseDateKey(value)
  return Boolean(parsed && parsed.getDay() === 0)
}

const normalizeWorkingDateKey = (value) => {
  const parsed = parseDateKey(value)
  if (!parsed || Number.isNaN(parsed.getTime())) return ''
  if (parsed.getDay() !== 0) return formatDateKey(parsed)

  const shifted = new Date(parsed)
  shifted.setDate(shifted.getDate() + 1)
  return formatDateKey(shifted)
}

const getTodayDateKey = () => formatDateKey(new Date())
const getTodayWorkingDateKey = () => normalizeWorkingDateKey(getTodayDateKey()) || getTodayDateKey()

const addDaysToDateKey = (value, delta) => {
  const parsed = parseDateKey(value) || new Date()
  const shifted = new Date(parsed)
  shifted.setDate(shifted.getDate() + Number(delta || 0))
  return formatDateKey(shifted)
}

const getWeekStartDate = (value) => {
  const parsed = parseDateKey(value) || new Date()
  const start = new Date(parsed)
  const day = start.getDay()
  const diffToMonday = (day + 6) % 7
  start.setDate(start.getDate() - diffToMonday)
  return start
}

const formatWeekRangeLabel = (startDate, endDate) => {
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) return ''
  if (!(endDate instanceof Date) || Number.isNaN(endDate.getTime())) return ''

  const startLabel = new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: 'short' }).format(startDate)
  const endLabel = new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }).format(endDate)
  return `${startLabel} - ${endLabel}`
}

const formatTimelineDayName = (dateKey) => {
  const parsed = parseDateKey(dateKey)
  if (!parsed) return '-'
  const label = new Intl.DateTimeFormat('es-CO', { weekday: 'long' }).format(parsed)
  const clean = label.replace('.', '')
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

const formatTimelineDayDate = (dateKey) => {
  const parsed = parseDateKey(dateKey)
  if (!parsed) return '-'
  return new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: '2-digit' }).format(parsed)
}

const formatTimelineFullDate = (dateKey) => {
  const parsed = parseDateKey(dateKey)
  if (!parsed) return 'Fecha no disponible'
  return new Intl.DateTimeFormat('es-CO', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(parsed)
}

const getReminderDateTimeTimestamp = (reminder) => {
  const dateKey = formatDateKey(reminder?.date)
  if (!dateKey) return Number.NaN

  const rawTime = String(reminder?.time || '').trim()
  const timestamp = Date.parse(`${dateKey}T${rawTime || '00:00'}:00`)
  if (Number.isFinite(timestamp)) return timestamp

  const fallback = Date.parse(`${dateKey}T00:00:00`)
  return Number.isFinite(fallback) ? fallback : Number.NaN
}

const formatReminderTimeLabel = (reminder) => {
  const timestamp = getReminderDateTimeTimestamp(reminder)
  if (!Number.isFinite(timestamp)) return String(reminder?.time || 'Sin hora')
  return new Intl.DateTimeFormat('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

const formatTransferIssueValue = (value, fallback = '-') => {
  const normalized = String(value || '').trim()
  if (!normalized) return fallback

  return normalized
    .split(/[_\s]+/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join(' ')
}

function RecordatoriosPopup({
  open,
  onClose,
  token,
  currentUser,
  currentUserName,
  currentUserIds,
  currentReceiveBranchIds,
  reminders,
  allReminders,
  onCreateReminder,
  onMarkReminderSeen,
  darkMode,
  onError,
  onApplyRemindersUpdate,
  focusReminderId,
  onFocusReminderHandled,
  onTransferDecisionAccepted,
  onOpenTransferRequestInEntradas,
  onOpenTransferRequestInTransit,
  onOpenTransferRequestInSalidas,
  onOpenRandomInspection,
  onOpenTransferIssuesSection,
}) {
  const { shouldRender, isClosing } = useModalAnimation(open)
  const [users, setUsers] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [usersError, setUsersError] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [description, setDescription] = useState('')
  const [selectedRecipientIds, setSelectedRecipientIds] = useState([])
  const [submitError, setSubmitError] = useState('')
  const [activeView, setActiveView] = useState('list')
  const previousViewRef = useRef('list')
  const [activeDecisionReminderId, setActiveDecisionReminderId] = useState('')
  const [decisionDetail, setDecisionDetail] = useState(null)
  const [decisionLoading, setDecisionLoading] = useState(false)
  const [decisionSubmitting, setDecisionSubmitting] = useState(false)
  const [decisionError, setDecisionError] = useState('')
  const [rejectionReason, setRejectionReason] = useState('')
  const [isRejectReasonModalOpen, setIsRejectReasonModalOpen] = useState(false)
  const [rejectReasonError, setRejectReasonError] = useState('')
  const [selectedTimelineDate, setSelectedTimelineDate] = useState(() => getTodayWorkingDateKey())
  const [openingTransferReminderId, setOpeningTransferReminderId] = useState('')
  const [openingInspectionReminderId, setOpeningInspectionReminderId] = useState('')
  const [highlightedReminderId, setHighlightedReminderId] = useState('')
  const [pendingScrollReminderId, setPendingScrollReminderId] = useState('')
  const [transferLifecycleBySolicitudId, setTransferLifecycleBySolicitudId] = useState({})
  const [activeDetailReminderId, setActiveDetailReminderId] = useState('')
  const [activeDetailSolicitud, setActiveDetailSolicitud] = useState(null)
  const [activeDetailSolicitudLoading, setActiveDetailSolicitudLoading] = useState(false)
  const [activeDetailIssues, setActiveDetailIssues] = useState([])
  const [activeDetailIssuesLoading, setActiveDetailIssuesLoading] = useState(false)
  const [activeDetailIssuesError, setActiveDetailIssuesError] = useState('')
  const transferLifecycleInFlightRef = useRef(new Set())
  const activeDetailSolicitudCacheRef = useRef(new Map())
  const activeDetailIssuesCacheRef = useRef(new Map())
  const reminderItemRefs = useRef(new Map())

  const notifyError = useCallback(
    (message) => {
      if (!message) return
      onError?.(message)
    },
    [onError]
  )

  const currentUserIdSet = useMemo(
    () => new Set((Array.isArray(currentUserIds) ? currentUserIds : []).map(normalizeId).filter(Boolean)),
    [currentUserIds]
  )

  const currentReceiveBranchIdSet = useMemo(
    () => new Set((Array.isArray(currentReceiveBranchIds) ? currentReceiveBranchIds : []).map(normalizeId).filter(Boolean)),
    [currentReceiveBranchIds]
  )

  const currentPrimaryUserId = useMemo(() => {
    const values = Array.from(currentUserIdSet)
    return values[0] || ''
  }, [currentUserIdSet])

  const reminderStatusSource = useMemo(
    () => (Array.isArray(allReminders) && allReminders.length ? allReminders : reminders),
    [allReminders, reminders]
  )

  const resolvedTransferIssuesBySolicitudId = useMemo(() => {
    const source = Array.isArray(reminderStatusSource) ? reminderStatusSource : []
    const bySolicitudId = new Map()

    source.forEach((reminder) => {
      if (!isTransferIssueReminder(reminder)) return

      const solicitudId = normalizeId(reminder?.context?.id)
      if (!solicitudId) return

      const timestamp = Number.isFinite(getReminderDateTimeTimestamp(reminder))
        ? getReminderDateTimeTimestamp(reminder)
        : Date.parse(String(reminder?.createdAt || '').trim()) || 0
      const description = String(reminder?.description || '').toLowerCase()
      const isResolved = (
        reminderCompletedByIds(reminder).length > 0 ||
        description.includes('resuelto') ||
        description.includes('resueltos') ||
        description.includes('perdido')
      )

      const previous = bySolicitudId.get(solicitudId)
      if (!previous || timestamp >= previous.timestamp) {
        bySolicitudId.set(solicitudId, { resolved: isResolved, timestamp })
      }
    })

    return bySolicitudId
  }, [reminderStatusSource])

  const creatorRecipientId = currentPrimaryUserId || extractUserId(currentUser)
  const creatorRecipientName = currentUserName || formatCurrentUserName(currentUser)

  const activeDecisionReminder = useMemo(() => {
    const normalizedId = normalizeId(activeDecisionReminderId)
    if (!normalizedId) return null
    return (Array.isArray(reminders) ? reminders : []).find(
      (reminder) => normalizeId(reminder?.id) === normalizedId
    ) || null
  }, [activeDecisionReminderId, reminders])

  const normalizedSelectedTimelineDate = useMemo(
    () => normalizeWorkingDateKey(selectedTimelineDate) || getTodayWorkingDateKey(),
    [selectedTimelineDate]
  )

  const remindersByDate = useMemo(() => {
    const grouped = new Map()
    ;(Array.isArray(reminders) ? reminders : []).forEach((reminder) => {
      const dateKey = formatDateKey(reminder?.date)
      if (!dateKey) return
      if (!grouped.has(dateKey)) grouped.set(dateKey, [])
      grouped.get(dateKey).push(reminder)
    })

    grouped.forEach((dayReminders, dateKey) => {
      grouped.set(
        dateKey,
        [...dayReminders].sort((a, b) => {
          const timestampA = getReminderDateTimeTimestamp(a)
          const timestampB = getReminderDateTimeTimestamp(b)

          if (Number.isFinite(timestampA) && Number.isFinite(timestampB)) {
            return timestampB - timestampA
          }
          if (Number.isFinite(timestampA)) return -1
          if (Number.isFinite(timestampB)) return 1

          const createdAtA = Date.parse(String(a?.createdAt || ''))
          const createdAtB = Date.parse(String(b?.createdAt || ''))
          if (Number.isFinite(createdAtA) && Number.isFinite(createdAtB)) {
            return createdAtB - createdAtA
          }
          if (Number.isFinite(createdAtA)) return -1
          if (Number.isFinite(createdAtB)) return 1

          return String(b?.id || '').localeCompare(String(a?.id || ''))
        })
      )
    })

    return grouped
  }, [reminders])

  const selectedDayReminders = useMemo(
    () => remindersByDate.get(normalizedSelectedTimelineDate) || [],
    [remindersByDate, normalizedSelectedTimelineDate]
  )

  const transferLatestProgressBySolicitudId = useMemo(() => {
    const stageRank = TRANSFER_PROGRESS_STAGE_RANK
    const map = {}
    ;(Array.isArray(reminders) ? reminders : []).forEach((reminder) => {
      if (normalizeReminderContextType(reminder?.context?.type) !== 'solicitud_traslado') return

      const solicitudId = normalizeId(reminder?.context?.id)
      if (!solicitudId) return

      const receiptOutcome = getTransferReceiptOutcome(reminder)
      const decisionStatus = getReminderDecisionStatus(reminder)
      const stage = receiptOutcome
        ? 'recibido'
        : (
          decisionStatus === 'enviado'
            ? 'enviado'
            : (
              decisionStatus === 'aceptada'
                ? 'aceptada'
                : 'pendiente'
            )
        )
      const rank = stageRank[stage] ?? 0
      const timestamp = getReminderDateTimeTimestamp(reminder)
      const safeTimestamp = Number.isFinite(timestamp) ? timestamp : 0
      const reminderId = normalizeId(reminder?.id)
      const reminderDateKey = formatDateKey(reminder?.date) || ''

      const current = map[solicitudId]
      if (!current || rank > current.rank || (rank === current.rank && safeTimestamp >= current.timestamp)) {
        map[solicitudId] = {
          stage,
          rank,
          receiptOutcome: receiptOutcome || '',
          timestamp: safeTimestamp,
          reminderId,
          dateKey: reminderDateKey,
        }
      }
    })
    return map
  }, [reminders])

  const getTimelineDaySeverityForReminder = useCallback((reminder) => {
    const baseStatus = buildReminderStatusForUser(reminder, currentUserIdSet)
    const isTransferIssue = isTransferIssueReminder(reminder)
    const isTransferContextReminder =
      normalizeReminderContextType(reminder?.context?.type) === 'solicitud_traslado'
    const decisionStatus = getReminderDecisionStatus(reminder)
    const transferReceiptOutcome = getTransferReceiptOutcome(reminder)
    const solicitudId = normalizeId(reminder?.context?.id)
    const transferLifecycle = transferLifecycleBySolicitudId?.[solicitudId] || null
    const latestTransferProgress = solicitudId
      ? (transferLatestProgressBySolicitudId?.[solicitudId] || null)
      : null
    const latestTransferReceiptOutcome = String(
      latestTransferProgress?.receiptOutcome || ''
    ).trim()
    const latestTransferStageFromReminders = normalizeTransferProgressStage(
      latestTransferProgress?.stage
    )
    const latestTransferStageFromLifecycle = normalizeTransferProgressStage(transferLifecycle?.stage || '')
    const latestTransferStage = (() => {
      const reminderRank = TRANSFER_PROGRESS_STAGE_RANK[latestTransferStageFromReminders] ?? 0
      const lifecycleRank = TRANSFER_PROGRESS_STAGE_RANK[latestTransferStageFromLifecycle] ?? 0
      return lifecycleRank > reminderRank
        ? latestTransferStageFromLifecycle
        : latestTransferStageFromReminders
    })()
    const visualDecisionStatus = getTransferVisualDecisionStatus({
      decisionStatus,
      latestTransferStage,
      receiptOutcome: transferReceiptOutcome,
    })
    const status = getTransferVisualStatus(baseStatus, visualDecisionStatus)
    const issueResolution = solicitudId
      ? resolvedTransferIssuesBySolicitudId.get(solicitudId)
      : null
    const isIssueResolved = Boolean(issueResolution?.resolved)
    const isReminderOwnedByCurrentUser = isReminderCreatedByCurrentUser(
      reminder,
      currentUserIdSet,
      currentUserName
    )
    const displayStatus = (() => {
      if (visualDecisionStatus === 'recibido') {
        const outcomeForLabel = latestTransferReceiptOutcome || transferReceiptOutcome
        if (isTransferIssue) {
          return isIssueResolved
            ? { ...status, label: 'Cumplido', className: 'arrived' }
            : { ...status, label: 'Pendiente', className: 'pending' }
        }
        if (outcomeForLabel === 'incompleto' && !isIssueResolved) {
          return { ...status, label: 'Entregada con novedades', className: 'issue' }
        }
        if (isReminderOwnedByCurrentUser) {
          return { ...status, label: 'Cumplido', className: 'arrived' }
        }
        return { ...status, label: 'Entregada y recibida', className: 'arrived' }
      }
      return status
    })()
    const isPendingInspectionAlert = (
      status.className === 'pending' &&
      (
        isRandomInspectionDailyReminder(reminder) ||
        isRandomInspectionVerifyReminder(reminder)
      )
    )

    if (
      displayStatus.className === 'rejected' ||
      displayStatus.className === 'issue' ||
      isPendingInspectionAlert
    ) {
      return 'critical'
    }

    if (
      isTransferContextReminder &&
      visualDecisionStatus === 'rechazada' &&
      !isReminderOwnedByCurrentUser
    ) {
      return 'critical'
    }

    return 'default'
  }, [
    currentUserIdSet,
    currentUserName,
    resolvedTransferIssuesBySolicitudId,
    transferLifecycleBySolicitudId,
    transferLatestProgressBySolicitudId,
  ])

  const handleJumpToLatestTransferReminder = useCallback((reminder) => {
    const solicitudId = normalizeId(reminder?.context?.id)
    if (!solicitudId) return false

    const latestProgress = transferLatestProgressBySolicitudId?.[solicitudId] || null
    const targetReminderId = normalizeId(latestProgress?.reminderId)
    const fallbackReminderId = normalizeId(reminder?.id)
    const reminderIdToFocus = targetReminderId || fallbackReminderId
    if (!reminderIdToFocus) return false

    const targetDateKey = formatDateKey(latestProgress?.dateKey || reminder?.date)
    if (targetDateKey && targetDateKey !== normalizedSelectedTimelineDate) {
      setSelectedTimelineDate(targetDateKey)
    }
    setPendingScrollReminderId(reminderIdToFocus)
    setHighlightedReminderId(reminderIdToFocus)
    return reminderIdToFocus === fallbackReminderId
  }, [normalizedSelectedTimelineDate, transferLatestProgressBySolicitudId])

  useEffect(() => {
    const targetReminderId = normalizeId(pendingScrollReminderId)
    if (!targetReminderId) return undefined

    const targetElement = reminderItemRefs.current.get(targetReminderId)
    if (!targetElement) return undefined

    targetElement.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    })
    setPendingScrollReminderId('')

    const clearTimer = setTimeout(() => {
      setHighlightedReminderId((previous) => (previous === targetReminderId ? '' : previous))
    }, 2600)

    return () => {
      clearTimeout(clearTimer)
    }
  }, [pendingScrollReminderId, selectedDayReminders])

  const timelineWeekDays = useMemo(() => {
    const start = getWeekStartDate(normalizedSelectedTimelineDate)

    return Array.from({ length: 6 }, (_, offset) => {
      const date = new Date(start)
      date.setDate(start.getDate() + offset)
      const dateKey = formatDateKey(date)
      const dayReminders = remindersByDate.get(dateKey) || []
      const count = dayReminders.length
      const severity = dayReminders.some(
        (reminder) => getTimelineDaySeverityForReminder(reminder) === 'critical'
      )
        ? 'critical'
        : 'default'
      return {
        dateKey,
        count,
        severity,
        dayName: formatTimelineDayName(dateKey),
        dayDate: formatTimelineDayDate(dateKey),
      }
    })
  }, [getTimelineDaySeverityForReminder, normalizedSelectedTimelineDate, remindersByDate])

  const prevWeekHasCritical = useMemo(() => {
    const start = getWeekStartDate(normalizedSelectedTimelineDate)
    return Array.from({ length: 6 }, (_, offset) => {
      const date = new Date(start)
      date.setDate(start.getDate() - 7 + offset)
      const dateKey = formatDateKey(date)
      const dayReminders = remindersByDate.get(dateKey) || []
      return dayReminders.some((reminder) => getTimelineDaySeverityForReminder(reminder) === 'critical')
    }).some(Boolean)
  }, [getTimelineDaySeverityForReminder, normalizedSelectedTimelineDate, remindersByDate])

  const nextWeekHasCritical = useMemo(() => {
    const start = getWeekStartDate(normalizedSelectedTimelineDate)
    return Array.from({ length: 6 }, (_, offset) => {
      const date = new Date(start)
      date.setDate(start.getDate() + 7 + offset)
      const dateKey = formatDateKey(date)
      const dayReminders = remindersByDate.get(dateKey) || []
      return dayReminders.some((reminder) => getTimelineDaySeverityForReminder(reminder) === 'critical')
    }).some(Boolean)
  }, [getTimelineDaySeverityForReminder, normalizedSelectedTimelineDate, remindersByDate])

  const timelineWeekRangeLabel = useMemo(() => {
    const first = timelineWeekDays[0]?.dateKey
    const last = timelineWeekDays[timelineWeekDays.length - 1]?.dateKey
    if (!first || !last) return ''
    return formatWeekRangeLabel(parseDateKey(first), parseDateKey(last))
  }, [timelineWeekDays])

  const selectedTimelineFullDateLabel = useMemo(
    () => formatTimelineFullDate(normalizedSelectedTimelineDate),
    [normalizedSelectedTimelineDate]
  )

  const activeDetailReminder = useMemo(() => {
    const nId = normalizeId(activeDetailReminderId)
    if (!nId) return null
    const source = Array.isArray(reminders) ? reminders : []
    const selectedReminder = source.find((r) => normalizeId(r?.id) === nId) || null
    if (!selectedReminder) return null

    if (isTransferIssueReminder(selectedReminder)) return selectedReminder

    const contextType = normalizeReminderContextType(selectedReminder?.context?.type)
    const contextId = normalizeId(selectedReminder?.context?.id)
    if (contextType !== 'solicitud_traslado' || !contextId) return selectedReminder

    const matchingReminders = source.filter((reminder) =>
      normalizeReminderContextType(reminder?.context?.type) === contextType &&
      normalizeId(reminder?.context?.id) === contextId
    )
    if (matchingReminders.length <= 1) return selectedReminder

    const mergedReminders = matchingReminders.reduce(
      (currentList, reminder) => upsertTransferReminder(currentList, reminder),
      []
    )
    return mergedReminders[0] || selectedReminder
  }, [activeDetailReminderId, reminders])

  const activeDetailIsTransferIssue = useMemo(
    () => isTransferIssueReminder(activeDetailReminder),
    [activeDetailReminder]
  )

  const activeDetailIsTransferContext = useMemo(
    () => (
      !activeDetailIsTransferIssue &&
      normalizeReminderContextType(activeDetailReminder?.context?.type) === 'solicitud_traslado'
    ),
    [activeDetailIsTransferIssue, activeDetailReminder]
  )

  const activeDetailSolicitudId = useMemo(
    () => normalizeId(activeDetailReminder?.context?.id),
    [activeDetailReminder]
  )

  const activeDetailReminderStatus = useMemo(() => {
    if (!activeDetailReminder) return null
    const baseStatus = buildReminderStatusForUser(activeDetailReminder, currentUserIdSet)
    if (!activeDetailIsTransferContext) return baseStatus

    const solicitudId = normalizeId(activeDetailReminder?.context?.id)
    const issueResolution = solicitudId ? resolvedTransferIssuesBySolicitudId.get(solicitudId) : null
    const isIssueResolved = Boolean(issueResolution?.resolved)
    const transferLifecycle = solicitudId ? transferLifecycleBySolicitudId?.[solicitudId] || null : null
    const latestProgressFromReminders = solicitudId
      ? transferLatestProgressBySolicitudId?.[solicitudId] || null
      : null
    const latestStageFromReminders = normalizeTransferProgressStage(latestProgressFromReminders?.stage || '')
    const latestStageFromLifecycle = normalizeTransferProgressStage(transferLifecycle?.stage || '')
    const latestStage = (() => {
      const rRank = TRANSFER_PROGRESS_STAGE_RANK[latestStageFromReminders] ?? 0
      const lRank = TRANSFER_PROGRESS_STAGE_RANK[latestStageFromLifecycle] ?? 0
      return lRank > rRank ? latestStageFromLifecycle : latestStageFromReminders
    })()
    const visualDecisionStatus = getTransferVisualDecisionStatus({
      decisionStatus: getReminderDecisionStatus(activeDetailReminder),
      latestTransferStage: latestStage,
      receiptOutcome: getTransferReceiptOutcome(activeDetailReminder),
    })
    const outcomeForLabel = String(
      latestProgressFromReminders?.receiptOutcome || getTransferReceiptOutcome(activeDetailReminder) || ''
    ).trim()
    const vs = getTransferVisualStatus(baseStatus, visualDecisionStatus)
    if (visualDecisionStatus === 'recibido') {
      if (outcomeForLabel === 'incompleto' && !isIssueResolved) {
        return { label: 'Entregada con novedades', className: 'issue', canMarkSeen: false }
      }

      if (!isReminderCreatedByCurrentUser(activeDetailReminder, currentUserIdSet, currentUserName)) {
        return { ...vs, label: 'Entregada y recibida', className: 'arrived' }
      }
    }
    return vs
  }, [
    activeDetailIsTransferContext,
    activeDetailReminder,
    currentUserIdSet,
    currentUserName,
    resolvedTransferIssuesBySolicitudId,
    transferLifecycleBySolicitudId,
    transferLatestProgressBySolicitudId,
  ])

  const activeDetailReminderDescription = useMemo(() => {
    if (!activeDetailReminder) return '-'
    const solicitudId = normalizeId(activeDetailReminder?.context?.id)
    const transferLifecycle = solicitudId ? transferLifecycleBySolicitudId?.[solicitudId] || null : null
    const decisionStatus = getTransferVisualDecisionStatus({
      decisionStatus: getReminderDecisionStatus(activeDetailReminder),
      latestTransferStage: transferLifecycle?.stage || '',
      receiptOutcome: getTransferReceiptOutcome(activeDetailReminder),
    })
    const isTransferContext = activeDetailIsTransferContext
    const isSpecial = isSpecialTransferDecisionReminder(activeDetailReminder)
    if (isTransferContext && !isSpecial) {
      return buildTransferResponseDescription(activeDetailReminder, decisionStatus)
    }
    return String(activeDetailReminder?.description || '').trim() || '-'
  }, [activeDetailIsTransferContext, activeDetailReminder, transferLifecycleBySolicitudId])

  const activeDetailReminderRecipients = useMemo(() => {
    if (!activeDetailReminder) return []
    const creatorId = activeDetailReminder?.creator?.id
    return (Array.isArray(activeDetailReminder?.recipients) ? activeDetailReminder.recipients : [])
      .filter((recipient) => !creatorId || String(recipient?.id) !== String(creatorId))
      .map((recipient) => String(recipient?.name || '').trim())
      .filter(Boolean)
  }, [activeDetailReminder])

  const activeDetailIssueRows = useMemo(
    () => (Array.isArray(activeDetailIssues) ? activeDetailIssues : []).map((issue, index) => {
      const issueId = normalizeId(issue?.id)
      const productId = normalizeId(issue?.producto_id)
      return {
        id: issueId || `${activeDetailSolicitudId}-${productId || index}`,
        productoCodigo: String(issue?.producto_codigo || '').trim() || '-',
        productoNombre: String(issue?.producto_nombre || '').trim() || 'Producto sin nombre',
        cantidadFaltante: Number.parseInt(String(issue?.cantidad_faltante || 0), 10) || 0,
        estadoLabel: formatTransferIssueValue(issue?.estado, 'Pendiente'),
      }
    }),
    [activeDetailIssues, activeDetailSolicitudId]
  )

  const activeDetailTransferHistory = useMemo(() => {
    if (!activeDetailReminder || !activeDetailIsTransferContext) return []
    const contextType = normalizeReminderContextType(activeDetailReminder?.context?.type)
    const contextId = normalizeId(activeDetailReminder?.context?.id)
    const reminderHistory = mergeTransferHistoryForContext(reminders, contextType, contextId)
    const hasCachedBackendHistory = Array.isArray(activeDetailSolicitud?.historial_transfer) && activeDetailSolicitud.historial_transfer.length > 0
    if (activeDetailIsTransferContext && activeDetailSolicitudLoading && !hasCachedBackendHistory && !reminderHistory.length) {
      return []
    }
    const backendHistory = getTransferReminderHistory({
      transferHistory: Array.isArray(activeDetailSolicitud?.historial_transfer)
        ? activeDetailSolicitud.historial_transfer
        : [],
      context: activeDetailReminder?.context || null,
      description: activeDetailReminder?.description || '',
      decision: activeDetailReminder?.decision || {},
      creator: activeDetailReminder?.creator || null,
      createdAt: activeDetailReminder?.createdAt || '',
      date: activeDetailReminder?.date || '',
      time: activeDetailReminder?.time || '',
    })
    const mergedHistory = backendHistory.length
      ? mergeTransferHistoryEntriesBySignature(backendHistory)
      : mergeTransferHistoryEntriesBySignature(reminderHistory)
    const inferredDecisionEntry = mergedHistory.length
      ? null
      : buildInferredDecisionHistoryEntry(activeDetailReminder)
    const historyWithDecisionEntry = (() => {
      if (!inferredDecisionEntry) return mergedHistory

      if (hasEquivalentTransferHistoryEntry(mergedHistory, inferredDecisionEntry)) return mergedHistory

      return collapseTransferHistoryDuplicates([...mergedHistory, inferredDecisionEntry]).sort((a, b) =>
        String(a?.at || '').localeCompare(String(b?.at || ''))
      )
    })()
    const initialCreationEntry = String(activeDetailReminder?.createdAt || '').trim()
      ? {
        stage: 'pendiente',
        label: '',
        description: '',
        at: String(activeDetailReminder.createdAt).trim(),
        actor: sanitizeRecipient(activeDetailReminder?.creator),
      }
      : null
    const shouldInjectInitialCreationEntry = (
      initialCreationEntry &&
      isSpecialTransferDecisionReminder(activeDetailReminder)
    )
    const hasInitialCreationEntry = shouldInjectInitialCreationEntry
      ? hasEquivalentTransferHistoryEntry(historyWithDecisionEntry, initialCreationEntry, {
        ignoreDescription: true,
      })
      : true
    const historyWithInitialCreation = shouldInjectInitialCreationEntry && !hasInitialCreationEntry
      ? [
          initialCreationEntry,
          ...historyWithDecisionEntry,
        ].sort((a, b) => String(a?.at || '').localeCompare(String(b?.at || '')))
      : historyWithDecisionEntry
    const labeledHistory = historyWithInitialCreation.map((entry, index) => ({
      ...entry,
      displayLabel: getTransferHistoryDisplayLabel(entry, historyWithInitialCreation.slice(0, index)),
    }))

    const timelineItems = labeledHistory.map((entry, index) => {
      const displayLabel = String(entry?.displayLabel || '').trim() || getTransferHistoryStageLabel(entry?.stage)
      const historyStatus = getTransferHistoryVisualStatus(entry?.stage, displayLabel)
      const rejectionReason = extractTransferHistoryRejectionReason(entry)

      return {
        id: `actual-${String(entry?.stage || 'stage').trim()}-${String(entry?.at || index).trim()}`,
        label: historyStatus.label,
        className: historyStatus.className,
        actorName: String(entry?.actor?.name || '').trim(),
        detailText: rejectionReason ? `Motivo: ${rejectionReason}` : '',
        timestamp: String(entry?.at || '').trim(),
        isPlaceholder: false,
      }
    })

    return [...timelineItems].reverse()
  }, [activeDetailIsTransferContext, activeDetailReminder, activeDetailSolicitud, activeDetailSolicitudLoading, reminders])

  const shiftTimelineDay = useCallback((offset) => {
    setSelectedTimelineDate((current) => normalizeWorkingDateKey(addDaysToDateKey(current, offset)))
  }, [])

  const handleDateChange = useCallback((event) => {
    const nextDate = String(event?.target?.value || '').trim()
    if (!nextDate) {
      setDate('')
      return
    }

    setDate(normalizeWorkingDateKey(nextDate) || nextDate)
  }, [])

  const closeDecisionPanel = useCallback(() => {
    setActiveDecisionReminderId('')
    setDecisionDetail(null)
    setDecisionLoading(false)
    setDecisionSubmitting(false)
    setDecisionError('')
    setRejectionReason('')
    setIsRejectReasonModalOpen(false)
    setRejectReasonError('')
  }, [])

  const loadDecisionDetail = useCallback(
    async (reminder) => {
      const solicitudId = normalizeId(reminder?.context?.id)
      if (!solicitudId || !token) {
        setDecisionDetail(null)
        return
      }

      setDecisionLoading(true)
      setDecisionError('')
      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(solicitudId)}/`,
          {},
          token
        )
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const detail = String(data?.detail || '').trim() || 'No se pudo cargar la solicitud de traslado.'
          throw new Error(detail)
        }
        setDecisionDetail(data)
      } catch (error) {
        const message = error?.message || 'No se pudo cargar la solicitud de traslado.'
        setDecisionError(message)
      } finally {
        setDecisionLoading(false)
      }
    },
    [token]
  )

  const openDecisionPanel = useCallback(
    (reminder) => {
      const reminderId = normalizeId(reminder?.id)
      if (!reminderId) return
      setActiveDecisionReminderId(reminderId)
      setDecisionDetail(null)
      setDecisionError('')
      setRejectionReason('')
      setIsRejectReasonModalOpen(false)
      setRejectReasonError('')
      loadDecisionDetail(reminder)
    },
    [loadDecisionDetail]
  )

  const selectableUsers = useMemo(
    () => users.filter((userItem) => userItem.id !== creatorRecipientId),
    [users, creatorRecipientId]
  )

  useEffect(() => {
    if (!open) {
      closeDecisionPanel()
      setOpeningTransferReminderId('')
      setHighlightedReminderId('')
      setPendingScrollReminderId('')
      setTransferLifecycleBySolicitudId({})
      setActiveDetailReminderId('')
      setActiveDetailSolicitud(null)
      setActiveDetailSolicitudLoading(false)
      setActiveDetailIssues([])
      setActiveDetailIssuesLoading(false)
      setActiveDetailIssuesError('')
      activeDetailSolicitudCacheRef.current = new Map()
      activeDetailIssuesCacheRef.current = new Map()
      transferLifecycleInFlightRef.current = new Set()
      reminderItemRefs.current = new Map()
      return
    }
    const defaults = getNowDateParts()
    setDate(defaults.date)
    setTime(defaults.time)
    setDescription('')
    setSelectedRecipientIds([])
    setSubmitError('')
    setSelectedTimelineDate(defaults.date)
    setActiveView('list')
    previousViewRef.current = 'list'
    setOpeningTransferReminderId('')
    setHighlightedReminderId('')
    setPendingScrollReminderId('')
    setActiveDetailReminderId('')
    setActiveDetailSolicitud(null)
    setActiveDetailSolicitudLoading(false)
    setActiveDetailIssues([])
    setActiveDetailIssuesLoading(false)
    setActiveDetailIssuesError('')
    closeDecisionPanel()
  }, [open, currentPrimaryUserId, closeDecisionPanel])

  useEffect(() => {
    if (!usersError) return
    notifyError(usersError)
  }, [notifyError, usersError])

  useEffect(() => {
    if (!submitError) return
    notifyError(submitError)
  }, [notifyError, submitError])

  useEffect(() => {
    if (!open) return undefined

    let cancelled = false

    const ensureCurrentUserInList = (list) => {
      const currentId = currentPrimaryUserId || extractUserId(currentUser)
      if (!currentId) return list
      if (list.some((userItem) => userItem.id === currentId)) return list

      return [
        {
          id: currentId,
          name: currentUserName || formatCurrentUserName(currentUser),
          email: currentUser?.correo || currentUser?.email || '',
        },
        ...list,
      ]
    }

    const fetchUsers = async () => {
      if (!token) {
        setLoadingUsers(false)
        setUsers(ensureCurrentUserInList([]))
        setUsersError('')
        return
      }

      setLoadingUsers(true)
      setUsersError('')

      try {
        const list = []
        let url = `${API_URL}/usuarios/listado/destinatarios/?page_size=200`

        while (url) {
          const response = await authFetch(url, {}, token)
          if (!response.ok) throw new Error('No se pudo cargar la lista de usuarios.')

          const data = await response.json()
          if (Array.isArray(data)) {
            list.push(...data)
            url = null
          } else {
            const pageResults = Array.isArray(data?.results) ? data.results : []
            list.push(...pageResults)
            url = data?.next || null
          }
        }

        if (cancelled) return

        const dedupedUsers = []
        const seenIds = new Set()
        list.forEach((item) => {
          const id = extractUserId(item)
          if (!id || seenIds.has(id)) return
          seenIds.add(id)
          dedupedUsers.push({
            id,
            name: formatCurrentUserName(item),
            email: item?.correo || item?.email || '',
          })
        })

        const withCurrentUser = ensureCurrentUserInList(dedupedUsers).sort((a, b) =>
          String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' })
        )

        setUsers(withCurrentUser)
      } catch (error) {
        if (cancelled) return
        setUsersError(error?.message || 'No se pudieron cargar los usuarios.')
        setUsers(ensureCurrentUserInList([]))
      } finally {
        if (!cancelled) {
          setLoadingUsers(false)
        }
      }
    }

    fetchUsers()

    return () => {
      cancelled = true
    }
  }, [open, token, currentPrimaryUserId, currentUser, currentUserName])

  useEffect(() => {
    if (!open) return undefined

    const handleEscape = (event) => {
      if (event.key !== 'Escape') return
      if (activeDecisionReminderId) {
        if (isRejectReasonModalOpen) {
          setIsRejectReasonModalOpen(false)
          setRejectReasonError('')
          return
        }
        closeDecisionPanel()
        return
      }
      onClose?.()
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [open, onClose, activeDecisionReminderId, closeDecisionPanel, isRejectReasonModalOpen])

  useEffect(() => {
    if (!open) return
    const targetReminderId = normalizeId(focusReminderId)
    if (!targetReminderId) return

    const reminder = (Array.isArray(reminders) ? reminders : []).find(
      (item) => normalizeId(item?.id) === targetReminderId
    )
    const reminderDateKey = formatDateKey(reminder?.date)
    if (reminderDateKey) {
      setSelectedTimelineDate(normalizeWorkingDateKey(reminderDateKey) || reminderDateKey)
    }
    if (reminder && isSpecialTransferDecisionReminder(reminder)) {
      setActiveView('list')
      openDecisionPanel(reminder)
    }
    onFocusReminderHandled?.()
  }, [focusReminderId, onFocusReminderHandled, open, openDecisionPanel, reminders])

  const toggleRecipient = (recipientId) => {
    const normalizedId = normalizeId(recipientId)
    if (!normalizedId) return

    setSelectedRecipientIds((prev) =>
      prev.includes(normalizedId)
        ? prev.filter((id) => id !== normalizedId)
        : [...prev, normalizedId]
    )
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    setSubmitError('')

    if (!date || !time) {
      setSubmitError('Debes completar fecha y hora.')
      return
    }

    if (isSundayDateKey(date)) {
      setSubmitError('Los recordatorios no se pueden programar en domingo.')
      return
    }

    const normalizedDescription = String(description || '').trim()
    if (!normalizedDescription) {
      setSubmitError('Debes escribir la descripcion del recordatorio.')
      return
    }

    if (!creatorRecipientId) {
      setSubmitError('No se pudo resolver el usuario creador.')
      return
    }

    const usersById = new Map(users.map((userItem) => [userItem.id, userItem]))
    const selectedRecipients = selectedRecipientIds
      .map((recipientId) => {
        const userItem = usersById.get(recipientId)
        if (!userItem) return null

        return {
          id: userItem.id,
          name: userItem.name,
        }
      })
      .filter(Boolean)

    const recipients = [
      { id: creatorRecipientId, name: creatorRecipientName },
      ...selectedRecipients,
    ].filter((recipient, index, list) => list.findIndex((item) => item.id === recipient.id) === index)

    if (!recipients.length) {
      setSubmitError('No se pudo resolver la lista de destinatarios.')
      return
    }

    const created = onCreateReminder?.({
      date,
      time,
      description: normalizedDescription,
      recipients,
    })

    if (created === false) {
      setSubmitError('No se pudo crear el recordatorio.')
      return
    }

    const defaults = getNowDateParts()
    setDate(defaults.date)
    setTime(defaults.time)
    setDescription('')
    setSelectedRecipientIds([])
    setActiveView(previousViewRef.current || 'list')
  }

  const handleOpenCreateView = () => {
    previousViewRef.current = activeView || 'list'
    setSubmitError('')
    setActiveView('create')
  }

  const handleCloseCreateView = () => {
    setSubmitError('')
    setActiveView(previousViewRef.current || 'list')
  }

  const handleTransferDecision = async (decisionType) => {
    const reminder = activeDecisionReminder
    const solicitudId = normalizeId(reminder?.context?.id)
    if (!solicitudId || !token) {
      setDecisionError('No se pudo resolver la solicitud del recordatorio.')
      return false
    }

    const decision = String(decisionType || '').trim().toLowerCase()
    if (decision === 'rechazar' && !String(rejectionReason || '').trim()) {
      setRejectReasonError('Debes escribir un motivo de rechazo.')
      return false
    }

    setDecisionSubmitting(true)
    setDecisionError('')
    setRejectReasonError('')

    try {
      const payload =
        decision === 'rechazar'
          ? { decision: 'rechazar', motivo: String(rejectionReason || '').trim() }
          : { decision: 'aceptar' }

      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(solicitudId)}/decision/`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        token
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = String(data?.detail || data?.motivo || '').trim() || 'No se pudo registrar la decisión.'
        throw new Error(detail)
      }

      const resolvedDecision = decision === 'rechazar' ? 'rechazada' : 'aceptada'
      const resolutionDate = new Date().toISOString()
      const context = reminder?.context || null
      const rejectionReasonValue = String(rejectionReason || '').trim()
      const creatorRecipient = sanitizeRecipient(reminder?.creator)
      const nowParts = getNowDateParts()
      const requesterLabel = String(reminder?.context?.label || `Solicitud de traslado #${solicitudId}`).trim()
      const requesterReference = requesterLabel.replace(/^solicitud de traslado\s*/i, '').trim()
      const fallbackReference = solicitudId ? `#${solicitudId}` : ''
      const transferReference = requesterReference || fallbackReference
      const resolvedDescription = resolvedDecision === 'rechazada'
        ? (
          transferReference
            ? `Su solicitud de traslado ${transferReference} fue rechazada. Motivo: ${rejectionReasonValue}`
            : `Su solicitud de traslado fue rechazada. Motivo: ${rejectionReasonValue}`
        )
        : (
          transferReference
            ? `Su solicitud de traslado ${transferReference} fue aceptada.`
            : 'Su solicitud de traslado fue aceptada.'
        )

      if (token) {
        const remoteReminders = await fetchRemindersFromBackend(token)
        onApplyRemindersUpdate?.(remoteReminders)
      } else {
        onApplyRemindersUpdate?.((prev) => {
          const currentList = Array.isArray(prev) ? prev : []
          const currentReminder = currentList.find((item) => isReminderForContext(item, context)) || reminder

          return upsertTransferReminder(currentList, {
            id: normalizeId(currentReminder?.id) || createReminderId(),
            date: nowParts.date,
            time: nowParts.time,
            description: resolvedDescription,
            creator: currentReminder?.creator || {
              id: creatorRecipientId,
              name: creatorRecipientName,
            },
            recipients: creatorRecipient?.id
              ? [
                ...(Array.isArray(currentReminder?.recipients) ? currentReminder.recipients : []),
                creatorRecipient,
              ]
              : (Array.isArray(currentReminder?.recipients) ? currentReminder.recipients : []),
            context: reminder?.context || null,
            kind: 'recordatorio_general',
            createdAt: currentReminder?.createdAt || resolutionDate,
            decision: {
              ...(currentReminder?.decision || {}),
              status: resolvedDecision,
              reason: resolvedDecision === 'rechazada' ? rejectionReasonValue : '',
              by: sanitizeRecipient({ id: creatorRecipientId, name: creatorRecipientName }),
              at: resolutionDate,
              assignedRecipients: currentReminder?.decision?.assignedRecipients || [],
            },
            transferHistory: [
              ...getTransferReminderHistory(currentReminder),
              buildTransferHistoryEntry({
                stage: resolvedDecision,
                description: resolvedDescription,
                at: resolutionDate,
                actor: sanitizeRecipient({ id: creatorRecipientId, name: creatorRecipientName }),
              }),
            ],
            completedBy: [],
          })
        })
      }

      const responseSolicitud = data?.solicitud
      if (responseSolicitud) {
        setDecisionDetail(responseSolicitud)
      }
      if (resolvedDecision === 'aceptada') {
        onTransferDecisionAccepted?.({
          solicitudId: Number(solicitudId),
          solicitud: responseSolicitud || null,
          nextAction: data?.next_action || null,
        })
        closeDecisionPanel()
        onClose?.()
        return true
      }
      closeDecisionPanel()
      return true
    } catch (error) {
      const message = error?.message || 'No se pudo registrar la decisión.'
      setDecisionError(message)
      return false
    } finally {
      setDecisionSubmitting(false)
    }
  }

  const activeDecisionStatus = getReminderDecisionStatus(activeDecisionReminder)
  const canSubmitDecision = activeDecisionStatus === 'pendiente'
  const decisionDetalles = Array.isArray(decisionDetail?.detalles) ? decisionDetail.detalles : []

  const handleRejectButtonClick = () => {
    if (!canSubmitDecision || decisionSubmitting || decisionLoading) return
    setDecisionError('')
    setRejectReasonError('')
    setIsRejectReasonModalOpen(true)
  }

  const handleCloseRejectReasonModal = () => {
    if (decisionSubmitting) return
    setRejectReasonError('')
    setIsRejectReasonModalOpen(false)
  }

  const handleConfirmRejectDecision = async () => {
    if (decisionSubmitting || decisionLoading) return
    const resolved = await handleTransferDecision('rechazar')
    if (resolved) {
      setIsRejectReasonModalOpen(false)
    }
  }

  const fetchTransferPreviewFromEntradaTable = useCallback(
    async (reminder) => {
      if (!token) return null

      const solicitudId = normalizeId(reminder?.context?.id)
      const documentNumber = extractTransferDocumentNumber(reminder?.context?.label || reminder?.description)
      const params = new URLSearchParams()
      params.set('tipo', 'entrada')
      params.set('subtipo', 'traslado')
      params.set('page', '1')
      params.set('page_size', '100')
      if (documentNumber) {
        params.set('search', documentNumber)
      } else if (solicitudId) {
        params.set('search', solicitudId)
      }

      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/tabla/?${params.toString()}`,
        {},
        token
      )
      if (!response.ok) return null

      const data = await response.json().catch(() => ({}))
      const rows = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : []
      if (!rows.length) return null

      const normalizedDocument = String(documentNumber || '').trim().toLowerCase()
      const findBySolicitudId = (row) => normalizeId(row?.solicitud_traslado_id) === solicitudId
      const findByDocument = (row) => {
        if (!normalizedDocument) return false
        const noDocumento = String(row?.no_documento || '').trim().toLowerCase()
        const descripcion = String(row?.descripcion || '').trim().toLowerCase()
        return noDocumento.includes(normalizedDocument) || descripcion.includes(`#${normalizedDocument}`)
      }
      const findRealEntrada = (row) => !row?.es_solicitud_traslado

      const targetRow = (
        rows.find((row) => findBySolicitudId(row) && findRealEntrada(row)) ||
        rows.find((row) => findByDocument(row) && findRealEntrada(row)) ||
        (solicitudId ? rows.find(findBySolicitudId) : null) ||
        (documentNumber ? rows.find(findByDocument) : null) ||
        rows.find(findRealEntrada) ||
        rows.find((row) => Boolean(row?.es_solicitud_traslado)) ||
        null
      )

      if (!targetRow) return null
      return mapTransferRowToEntradaPreview(targetRow)
    },
    [token]
  )

  const fetchTransferSolicitudDetail = useCallback(
    async (solicitudId) => {
      if (!token || !solicitudId) return null

      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(solicitudId)}/`,
        {},
        token
      )
      if (!response.ok) return null

      const data = await response.json().catch(() => ({}))
      if (!data || typeof data !== 'object') return null
      return data
    },
    [token]
  )

  const fetchTransferIssueDetails = useCallback(
    async (solicitudId) => {
      if (!token || !solicitudId) return []

      const params = new URLSearchParams()
      params.set('solicitud_id', solicitudId)

      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/traslados-inconvenientes/?${params.toString()}`,
        {},
        token
      )
      const data = await response.json().catch(() => ([]))
      if (!response.ok) {
        const detail = String(data?.detail || '').trim() || 'No se pudieron cargar los productos con inconvenientes.'
        throw new Error(detail)
      }

      const rows = Array.isArray(data) ? data : []
      return rows.filter((row) => normalizeId(row?.solicitud_id) === normalizeId(solicitudId))
    },
    [token]
  )

  const resolveTransferLifecycleStage = useCallback(
    async (solicitudDetail) => {
      if (!solicitudDetail || typeof solicitudDetail !== 'object') return 'aceptada'

      const hasSalida = Boolean(solicitudDetail?.movimiento_salida_id)
      if (!hasSalida) return 'aceptada'

      const movimientoEntradaId = normalizeId(solicitudDetail?.movimiento_entrada_id)
      if (!movimientoEntradaId || !token) return 'enviado'

      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/${encodeURIComponent(movimientoEntradaId)}/`,
          {},
          token
        )
        if (!response.ok) return 'enviado'

        const movimientoEntrada = await response.json().catch(() => ({}))
        const normalizedEstado = normalizeStateText(
          movimientoEntrada?.estado_movimiento ||
          movimientoEntrada?.estado_nombre ||
          movimientoEntrada?.estado
        )
        if (normalizedEstado.includes('recib') || normalizedEstado.includes('parcial')) {
          return 'recibido'
        }
      } catch {
        // Ignore and keep default stage.
      }

      return 'enviado'
    },
    [token]
  )

  const fetchTransferPreviewFromDetail = useCallback(
    async (solicitudId) => {
      const detail = await fetchTransferSolicitudDetail(solicitudId)
      if (!detail) return null
      return mapTransferDetailToEntradaPreview(detail)
    },
    [fetchTransferSolicitudDetail]
  )

  useEffect(() => {
    let cancelled = false
    const solicitudId = activeDetailSolicitudId
    const isTransferContext = activeDetailIsTransferContext

    if (!open || !token || !isTransferContext || !solicitudId) {
      setActiveDetailSolicitud(null)
      setActiveDetailSolicitudLoading(false)
      return undefined
    }

    const cachedDetail = activeDetailSolicitudCacheRef.current.get(solicitudId) || null
    if (cachedDetail) {
      setActiveDetailSolicitud((previous) => {
        if (normalizeId(previous?.id) === solicitudId) return previous || cachedDetail
        return cachedDetail
      })
      setActiveDetailSolicitudLoading(false)
      return undefined
    }

    setActiveDetailSolicitudLoading(true)
    void (async () => {
      try {
        const detail = await fetchTransferSolicitudDetail(solicitudId)
        if (!cancelled) {
          if (detail) {
            activeDetailSolicitudCacheRef.current.set(solicitudId, detail)
          }
          setActiveDetailSolicitud(detail || null)
          setActiveDetailSolicitudLoading(false)
        }
      } catch {
        if (!cancelled) {
          setActiveDetailSolicitud(null)
          setActiveDetailSolicitudLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeDetailIsTransferContext, activeDetailSolicitudId, fetchTransferSolicitudDetail, open, token])

  useEffect(() => {
    let cancelled = false
    const solicitudId = activeDetailSolicitudId

    if (!open || !token || !activeDetailIsTransferIssue || !solicitudId) {
      setActiveDetailIssues([])
      setActiveDetailIssuesLoading(false)
      setActiveDetailIssuesError('')
      return undefined
    }

    const cachedIssues = activeDetailIssuesCacheRef.current.get(solicitudId)
    if (Array.isArray(cachedIssues)) {
      setActiveDetailIssues(cachedIssues)
      setActiveDetailIssuesLoading(false)
      setActiveDetailIssuesError('')
      return undefined
    }

    setActiveDetailIssues([])
    setActiveDetailIssuesLoading(true)
    setActiveDetailIssuesError('')

    void (async () => {
      try {
        const issues = await fetchTransferIssueDetails(solicitudId)
        if (cancelled) return
        activeDetailIssuesCacheRef.current.set(solicitudId, issues)
        setActiveDetailIssues(issues)
      } catch (error) {
        if (cancelled) return
        setActiveDetailIssues([])
        setActiveDetailIssuesError(
          error?.message || 'No se pudieron cargar los productos con inconvenientes.'
        )
      } finally {
        if (!cancelled) {
          setActiveDetailIssuesLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeDetailIsTransferIssue, activeDetailSolicitudId, fetchTransferIssueDetails, open, token])

  useEffect(() => {
    if (!open || !token) return

    const remindersToResolve = selectedDayReminders.filter((reminder) => {
      const contextType = normalizeReminderContextType(reminder?.context?.type)
      if (contextType !== 'solicitud_traslado') return false
      return getReminderDecisionStatus(reminder) === 'aceptada'
    })

    remindersToResolve.forEach((reminder) => {
      const solicitudId = normalizeId(reminder?.context?.id)
      if (!solicitudId) return
      if (transferLifecycleBySolicitudId[solicitudId]) return
      if (transferLifecycleInFlightRef.current.has(solicitudId)) return

      setTransferLifecycleBySolicitudId((prev) => {
        if (prev[solicitudId]) return prev
        return {
          ...prev,
          [solicitudId]: {
            stage: '',
            loading: true,
          },
        }
      })
      transferLifecycleInFlightRef.current.add(solicitudId)

      void (async () => {
        try {
          const solicitudDetail = await fetchTransferSolicitudDetail(solicitudId)
          const stage = await resolveTransferLifecycleStage(solicitudDetail)
          setTransferLifecycleBySolicitudId((prev) => ({
            ...prev,
            [solicitudId]: {
              stage,
              loading: false,
            },
          }))
        } catch {
          setTransferLifecycleBySolicitudId((prev) => ({
            ...prev,
            [solicitudId]: {
              stage: 'aceptada',
              loading: false,
            },
          }))
        } finally {
          transferLifecycleInFlightRef.current.delete(solicitudId)
        }
      })()
    })
  }, [
    fetchTransferSolicitudDetail,
    open,
    resolveTransferLifecycleStage,
    selectedDayReminders,
    token,
    transferLifecycleBySolicitudId,
  ])

  const handleOpenTransferInSalidas = useCallback(
    async (reminder, options = {}) => {
      const suppressError = Boolean(options?.suppressError)
      if (typeof onOpenTransferRequestInSalidas !== 'function') return false
      const solicitudId = normalizeId(reminder?.context?.id)
      const reminderId = normalizeId(reminder?.id) || solicitudId
      if (!solicitudId) {
        if (!suppressError) {
          notifyError('No se encontró la solicitud asociada a este recordatorio.')
        }
        return false
      }

      setOpeningTransferReminderId(reminderId)
      try {
        const solicitudDetail = await fetchTransferSolicitudDetail(solicitudId)
        if (!solicitudDetail) {
          throw new Error('No se pudo abrir la solicitud en Salidas.')
        }

        const movimientoSalidaId = normalizeId(solicitudDetail?.movimiento_salida_id)
        onOpenTransferRequestInSalidas({
          requestKey: `${Date.now()}-${solicitudId}`,
          solicitudId,
          sucursalProveedoraId: String(solicitudDetail?.sucursal_proveedora_id || '').trim(),
          movimientoSalidaId,
          solicitud: solicitudDetail,
          mode: movimientoSalidaId ? 'view' : 'preview',
        })
        onClose?.()
        return true
      } catch (error) {
        if (!suppressError) {
          notifyError(error?.message || 'No se pudo abrir la salida asociada al traslado.')
        }
        return false
      } finally {
        setOpeningTransferReminderId('')
      }
    },
    [
      fetchTransferSolicitudDetail,
      notifyError,
      onClose,
      onOpenTransferRequestInSalidas,
    ]
  )

  const handleOpenTransferInEntradas = useCallback(
    async (reminder, options = {}) => {
      const suppressError = Boolean(options?.suppressError)
      if (typeof onOpenTransferRequestInEntradas !== 'function') return false
      const solicitudId = normalizeId(reminder?.context?.id)
      const reminderId = normalizeId(reminder?.id) || solicitudId
      const shouldHideRejectedIndicatorImmediately = (
        getReminderDecisionStatus(reminder) === 'rechazada' &&
        isReminderCreatedByCurrentUser(reminder, currentUserIdSet, currentUserName)
      )
      if (!solicitudId) {
        if (!suppressError) {
          notifyError('No se encontró la solicitud asociada a este recordatorio.')
        }
        return false
      }

      if (shouldHideRejectedIndicatorImmediately) {
        emitRejectedTransferEditingState(solicitudId, true)
      }

      let keepRejectedTransferEditingActive = false
      setOpeningTransferReminderId(reminderId)
      try {
        const previewFromTable = await fetchTransferPreviewFromEntradaTable(reminder)
        const solicitudDetail = previewFromTable
          ? null
          : await fetchTransferSolicitudDetail(solicitudId)
        const movimientoEntradaIdFromDetail = normalizeId(solicitudDetail?.movimiento_entrada_id)
        const previewFromDetail = previewFromTable
          ? null
          : (
            solicitudDetail
              ? mapTransferDetailToEntradaPreview(solicitudDetail)
              : await fetchTransferPreviewFromDetail(solicitudId)
          )
        const previewData = previewFromTable || previewFromDetail

        const previewEntradaIdRaw = (
          previewData?.movimiento_entrada_id ||
          (!previewData?.es_solicitud_traslado ? previewData?.id : '')
        )
        const previewEntradaId = normalizeId(previewEntradaIdRaw)
        const movimientoEntradaId = movimientoEntradaIdFromDetail || previewEntradaId

        const sucursalSolicitanteId = String(
          solicitudDetail?.sucursal_solicitante_id ||
          previewData?.sucursal_solicitante_id ||
          previewData?.sucursal_id ||
          ''
        ).trim()

        if (movimientoEntradaId) {
          keepRejectedTransferEditingActive = shouldHideRejectedIndicatorImmediately
          onOpenTransferRequestInEntradas({
            requestKey: `${Date.now()}-${solicitudId}`,
            solicitudId,
            sucursalSolicitanteId,
            previewData,
            movimientoEntradaId,
            mode: 'view',
          })
          onClose?.()
          return true
        }

        if (!previewData) {
          throw new Error('No se pudo abrir la solicitud en Entradas.')
        }

        keepRejectedTransferEditingActive = shouldHideRejectedIndicatorImmediately
        onOpenTransferRequestInEntradas({
          requestKey: `${Date.now()}-${solicitudId}`,
          solicitudId,
          sucursalSolicitanteId,
          previewData,
          mode: 'preview',
        })
        onClose?.()
        return true
      } catch (error) {
        if (!suppressError) {
          notifyError(error?.message || 'No se pudo abrir la solicitud en Entradas.')
        }
        return false
      } finally {
        setOpeningTransferReminderId('')
        if (shouldHideRejectedIndicatorImmediately && !keepRejectedTransferEditingActive) {
          emitRejectedTransferEditingState(solicitudId, false)
        }
      }
    },
    [
      currentUserIdSet,
      currentUserName,
      fetchTransferSolicitudDetail,
      fetchTransferPreviewFromDetail,
      fetchTransferPreviewFromEntradaTable,
      notifyError,
      onClose,
      onOpenTransferRequestInEntradas,
    ]
  )

  const handleOpenTransferByPreferredTarget = useCallback(
    async (reminder, preferredTarget = 'entradas') => {
      const firstTarget = String(preferredTarget || '').trim().toLowerCase() === 'salidas'
        ? 'salidas'
        : 'entradas'
      const targets = firstTarget === 'salidas' ? ['salidas', 'entradas'] : ['entradas', 'salidas']

      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index]
        const suppressError = index < targets.length - 1
        const opened = target === 'salidas'
          ? await handleOpenTransferInSalidas(reminder, { suppressError })
          : await handleOpenTransferInEntradas(reminder, { suppressError })
        if (opened) return true
      }

      return false
    },
    [handleOpenTransferInEntradas, handleOpenTransferInSalidas]
  )

  const handleCreateSalidaFromReminder = useCallback(
    async (reminder) => {
      if (typeof onTransferDecisionAccepted !== 'function') return
      const solicitudId = normalizeId(reminder?.context?.id)
      const reminderId = normalizeId(reminder?.id) || solicitudId
      if (!solicitudId) {
        notifyError('No se encontró la solicitud asociada a este recordatorio.')
        return
      }

      setOpeningTransferReminderId(reminderId)
      try {
        const solicitudDetail = await fetchTransferSolicitudDetail(solicitudId)
        if (!solicitudDetail) {
          throw new Error('No se pudo abrir la solicitud en Salidas.')
        }

        onTransferDecisionAccepted({
          solicitudId,
          solicitud: solicitudDetail,
          nextAction: {
            sucursal_proveedora_id: String(solicitudDetail?.sucursal_proveedora_id || '').trim(),
          },
        })
        onClose?.()
      } catch (error) {
        notifyError(error?.message || 'No se pudo abrir la solicitud en Salidas.')
      } finally {
        setOpeningTransferReminderId('')
      }
    },
    [
      fetchTransferSolicitudDetail,
      notifyError,
      onClose,
      onTransferDecisionAccepted,
    ]
  )

  const handleOpenRandomInspection = useCallback(
    async (reminder) => {
      if (typeof onOpenRandomInspection !== 'function') return false
      const reminderId = normalizeId(reminder?.id)
      const inspectionId = normalizeId(reminder?.context?.id)
      if (!inspectionId) {
        notifyError('No se encontró la inspección asociada a este recordatorio.')
        return false
      }

      if (reminderId) {
        setOpeningInspectionReminderId(reminderId)
      }

      try {
        const opened = await onOpenRandomInspection(reminder)
        if (!opened) {
          notifyError('No se pudo abrir la inspección aleatoria.')
          return false
        }
        onClose?.()
        return true
      } catch (error) {
        notifyError(error?.message || 'No se pudo abrir la inspección aleatoria.')
        return false
      } finally {
        setOpeningInspectionReminderId('')
      }
    },
    [notifyError, onClose, onOpenRandomInspection]
  )

  const handleOpenTransferInTransit = useCallback(
    async (reminder) => {
      if (typeof onOpenTransferRequestInTransit !== 'function') return false
      const reminderId = normalizeId(reminder?.id) || normalizeId(reminder?.context?.id)
      const solicitudId = normalizeId(reminder?.context?.id)
      if (!solicitudId) {
        notifyError('No se encontró el envío en camino asociado a este recordatorio.')
        return false
      }

      if (reminderId) {
        setOpeningTransferReminderId(reminderId)
      }

      try {
        const opened = await onOpenTransferRequestInTransit(reminder)
        if (!opened) {
          notifyError('No se pudo abrir el envío en camino.')
          return false
        }
        onClose?.()
        return true
      } catch (error) {
        notifyError(error?.message || 'No se pudo abrir el envío en camino.')
        return false
      } finally {
        setOpeningTransferReminderId('')
      }
    },
    [notifyError, onClose, onOpenTransferRequestInTransit]
  )

  const handleOpenTransferIssueResolution = useCallback(
    async (reminder) => {
      if (typeof onOpenTransferIssuesSection !== 'function') return false
      const reminderId = normalizeId(reminder?.id) || normalizeId(reminder?.context?.id)
      if (reminderId) {
        setOpeningTransferReminderId(reminderId)
      }

      try {
        const opened = await onOpenTransferIssuesSection(reminder)
        if (!opened) {
          notifyError('No se pudo abrir la seccion de inconvenientes.')
          return false
        }
        onClose?.()
        return true
      } catch (error) {
        notifyError(error?.message || 'No se pudo abrir la seccion de inconvenientes.')
        return false
      } finally {
        setOpeningTransferReminderId('')
      }
    },
    [notifyError, onClose, onOpenTransferIssuesSection]
  )

  if (!shouldRender || typeof document === 'undefined') return null

  return createPortal(
    <div
      className={`recordatorios-popup__overlay${isClosing ? ' recordatorios-popup__overlay--closing' : ''}${darkMode ? ' is-dark' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Recordatorios"
      onMouseDown={() => onClose?.()}
    >
      <div
        className={`recordatorios-popup__dialog${isClosing ? ' recordatorios-popup__dialog--closing' : ''}${darkMode ? ' is-dark' : ''}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="recordatorios-popup__header">
          <div className="recordatorios-popup__header-title">
            <h3>Recordatorios</h3>
            {activeView !== 'create' && (
              <button
                type="button"
                className="recordatorios-popup__button recordatorios-popup__button--primary recordatorios-popup__add-header"
                onClick={handleOpenCreateView}
                aria-label="Añadir recordatorio"
              >
                +
              </button>
            )}
          </div>
          <button type="button" className="recordatorios-popup__close" onClick={() => onClose?.()} aria-label="Cerrar recordatorios">
            <X />
          </button>
        </header>

        <div className="recordatorios-popup__content">
          {activeView === 'create' ? (
            <form className="recordatorios-popup__form recordatorios-popup__form--fullscreen" noValidate onSubmit={handleSubmit}>
              <div className="recordatorios-popup__section-head">
                <h4>Nuevo recordatorio</h4>
                {loadingUsers && (
                  <span className="recordatorios-popup__loading">
                    <Loader2 />
                    Cargando usuarios...
                  </span>
                )}
              </div>

              <div className="recordatorios-popup__grid">
                <label className="recordatorios-popup__field">
                  <span>Fecha</span>
                  <input type="date" value={date} onChange={handleDateChange} required />
                  <small className="recordatorios-popup__helper">No se programan recordatorios los domingos.</small>
                </label>

                <label className="recordatorios-popup__field">
                  <span>Hora</span>
                  <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
                </label>

                <label className="recordatorios-popup__field recordatorios-popup__field--full">
                  <span>Descripción</span>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Escribe de que trata este recordatorio"
                    required
                  />
                </label>
              </div>

              <section className="recordatorios-popup__recipients">
                <div className="recordatorios-popup__section-head">
                  <h4>Dirigido a</h4>
                </div>
                <p className="recordatorios-popup__helper">El creador siempre esta incluido.</p>

                <div className="recordatorios-popup__recipient-list recordatorios-popup__recipient-list--fullscreen">
                  {!selectableUsers.length && !loadingUsers && (
                    <p className="recordatorios-popup__empty-list">No hay mas usuarios disponibles.</p>
                  )}

                  {selectableUsers.map((userItem) => {
                    const checked = selectedRecipientIds.includes(userItem.id)
                    return (
                      <label key={userItem.id} className="recordatorios-popup__recipient">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleRecipient(userItem.id)}
                        />
                        <span className="recordatorios-popup__recipient-name">{userItem.name}</span>
                        {userItem.email && (
                          <small className="recordatorios-popup__recipient-meta">{userItem.email}</small>
                        )}
                      </label>
                    )
                  })}
                </div>
              </section>

              <div className="recordatorios-popup__actions">
                <button
                  type="button"
                  className="recordatorios-popup__button recordatorios-popup__button--ghost"
                  onClick={handleCloseCreateView}
                >
                  Cancelar
                </button>
                <button type="submit" className="recordatorios-popup__button recordatorios-popup__button--primary">
                  Guardar recordatorio
                </button>
              </div>
            </form>
          ) : (
            <section className="recordatorios-popup__history recordatorios-popup__history--fullscreen">
<>
                <section className="recordatorios-popup__timeline" aria-label="Linea de tiempo semanal">
                  <div className="recordatorios-popup__timeline-head">
                    <button
                      type="button"
                      className={`recordatorios-popup__timeline-arrow${prevWeekHasCritical ? ' is-critical' : ''}`}
                      onClick={() => shiftTimelineDay(-7)}
                      aria-label="Semana anterior"
                    >
                      <ChevronLeft />
                    </button>

                    <div className="recordatorios-popup__timeline-title">
                      <p>{timelineWeekRangeLabel}</p>
                    </div>

                    <button
                      type="button"
                      className={`recordatorios-popup__timeline-arrow${nextWeekHasCritical ? ' is-critical' : ''}`}
                      onClick={() => shiftTimelineDay(7)}
                      aria-label="Semana siguiente"
                    >
                      <ChevronRight />
                    </button>
                  </div>

                  <div className="recordatorios-popup__timeline-week" role="tablist" aria-label="Dias de la semana">
                    {timelineWeekDays.map((day) => {
                      const isSelected = day.dateKey === normalizedSelectedTimelineDate
                      return (
                        <button
                          key={day.dateKey}
                          type="button"
                          role="tab"
                          aria-selected={isSelected}
                          className={`recordatorios-popup__timeline-day${
                            isSelected ? ' is-selected' : ''
                          }${
                            day.severity === 'critical' ? ' is-critical' : ''
                          }`}
                          onClick={() => setSelectedTimelineDate(day.dateKey)}
                          title={`${day.dayName} ${day.dayDate}: ${day.count} recordatorio(s)`}
                          aria-label={`${day.dayName} ${day.dayDate}: ${day.count} recordatorio(s)`}
                        >
                          <span className="recordatorios-popup__timeline-day-label">
                            <span className="recordatorios-popup__timeline-day-name">{day.dayName}</span>
                            <span className="recordatorios-popup__timeline-day-date">{day.dayDate}</span>
                          </span>
                          <span className="recordatorios-popup__timeline-day-count">{day.count} rec.</span>
                        </button>
                      )
                    })}
                  </div>
                </section>

                <div className="recordatorios-popup__timeline-day-header">
                  <h5>{selectedTimelineFullDateLabel}</h5>
                  <p>{selectedDayReminders.length} recordatorio(s)</p>
                </div>

                <div className="recordatorios-popup__timeline-list">
                  {!selectedDayReminders.length ? (
                    <p className="recordatorios-popup__empty-list">
                      {!Array.isArray(reminders) || !reminders.length
                        ? 'No hay recordatorios.'
                        : 'No hay recordatorios para este dia.'}
                    </p>
                  ) : (
                    selectedDayReminders.map((reminder) => {
                        const baseStatus = buildReminderStatusForUser(reminder, currentUserIdSet)
                        const isSpecialReminder = isSpecialTransferDecisionReminder(reminder)
                        const isTransferIssue = isTransferIssueReminder(reminder)
                        const decisionStatus = getReminderDecisionStatus(reminder)
                        const transferReceiptOutcome = getTransferReceiptOutcome(reminder)
                        const isTransferContextReminder =
                          normalizeReminderContextType(reminder?.context?.type) === 'solicitud_traslado'
                        const solicitudId = normalizeId(reminder?.context?.id)
                        const transferLifecycle = transferLifecycleBySolicitudId?.[solicitudId] || null
                        const transferLifecycleStage = String(transferLifecycle?.stage || '').trim()
                        const latestTransferProgress = solicitudId
                          ? (transferLatestProgressBySolicitudId?.[solicitudId] || null)
                          : null
                        const latestTransferReminderId = normalizeId(latestTransferProgress?.reminderId)
                        const latestTransferStageFromReminders = normalizeTransferProgressStage(
                          latestTransferProgress?.stage
                        )
                        const latestTransferReceiptOutcome = String(
                          latestTransferProgress?.receiptOutcome || ''
                        ).trim()
                        const latestTransferStageFromLifecycle = normalizeTransferProgressStage(transferLifecycleStage)
                        const latestTransferStage = (() => {
                          const reminderRank = TRANSFER_PROGRESS_STAGE_RANK[latestTransferStageFromReminders] ?? 0
                          const lifecycleRank = TRANSFER_PROGRESS_STAGE_RANK[latestTransferStageFromLifecycle] ?? 0
                          return lifecycleRank > reminderRank
                            ? latestTransferStageFromLifecycle
                            : latestTransferStageFromReminders
                        })()
                        const visualDecisionStatus = getTransferVisualDecisionStatus({
                          decisionStatus,
                          latestTransferStage,
                          receiptOutcome: transferReceiptOutcome,
                        })
                        const status = getTransferVisualStatus(baseStatus, visualDecisionStatus)
                        const isTransferLifecycleLoading = (
                          isTransferContextReminder &&
                          decisionStatus === 'aceptada' &&
                          latestTransferStage !== 'recibido' &&
                          (!transferLifecycle || Boolean(transferLifecycle?.loading))
                        )
                        const isReminderOwnedByCurrentUser = isReminderCreatedByCurrentUser(
                          reminder,
                          currentUserIdSet,
                          currentUserName
                        )
                        const isAdminUser = Boolean(currentUser?.es_administrador)
                        const isCurrentUserSolicitante = (() => {
                          const solicitanteId = normalizeId(reminder?.context?.sucursal_solicitante_id)
                          if (solicitanteId && currentReceiveBranchIdSet.size) {
                            return currentReceiveBranchIdSet.has(solicitanteId)
                          }
                          return !isReminderOwnedByCurrentUser
                        })()
                        const issueResolution = solicitudId
                          ? resolvedTransferIssuesBySolicitudId.get(solicitudId)
                          : null
                        const isIssueResolved = Boolean(issueResolution?.resolved)
                        const displayStatus = (() => {
                          if (visualDecisionStatus === 'recibido') {
                            const outcomeForLabel = latestTransferReceiptOutcome || transferReceiptOutcome
                            if (isTransferIssue) {
                              return isIssueResolved
                                ? { ...status, label: 'Cumplido', className: 'arrived' }
                                : { ...status, label: 'Pendiente', className: 'pending' }
                            }
                            if (outcomeForLabel === 'incompleto' && !isIssueResolved) {
                              return { ...status, label: 'Entregada con novedades', className: 'issue' }
                            }
                            if (isReminderOwnedByCurrentUser) {
                              return { ...status, label: 'Cumplido', className: 'arrived' }
                            }
                            return { ...status, label: 'Entregada y recibida', className: 'arrived' }
                          }
                          return status
                        })()
                        const isRejectedByCurrentUser = (
                          visualDecisionStatus === 'rechazada' &&
                          currentUserIdSet.has(normalizeId(reminder?.decision?.by?.id))
                        )
                        const canResolveDecision = (
                          isSpecialReminder &&
                          decisionStatus === 'pendiente' &&
                          status.className !== 'info' &&
                          !isReminderOwnedByCurrentUser &&
                          isTransferDecisionAllowedForUser(reminder, currentUserIdSet)
                        )
                        const canViewTransferRequest = (
                          isTransferContextReminder &&
                          !canResolveDecision &&
                          typeof onOpenTransferRequestInEntradas === 'function' &&
                          (
                            visualDecisionStatus === 'pendiente' ||
                            visualDecisionStatus === 'aceptada' ||
                            (visualDecisionStatus === 'rechazada' && !isRejectedByCurrentUser) ||
                            status.className === 'accepted' ||
                            (status.className === 'rejected' && !isRejectedByCurrentUser) ||
                            (isSpecialReminder && !isTransferDecisionAllowedForUser(reminder, currentUserIdSet))
                          )
                        )
                        const canCreateSalidaFromReminder = (
                          isTransferContextReminder &&
                          visualDecisionStatus === 'aceptada' &&
                          transferLifecycleStage === 'aceptada' &&
                          !isReminderOwnedByCurrentUser &&
                          isTransferDecisionAllowedForUser(reminder, currentUserIdSet) &&
                          typeof onTransferDecisionAccepted === 'function'
                        )
                        const shouldShowCorrectionAction = (
                          visualDecisionStatus === 'rechazada' &&
                          isReminderOwnedByCurrentUser
                        )
                        const canOpenInTransitTransferFromReminder = (
                          isTransferContextReminder &&
                          visualDecisionStatus === 'enviado' &&
                          typeof onOpenTransferRequestInTransit === 'function' &&
                          !isAdminUser &&
                          isCurrentUserSolicitante
                        )
                        const canOpenSalidaAsProvider = (
                          isTransferContextReminder &&
                          visualDecisionStatus === 'enviado' &&
                          typeof onOpenTransferRequestInSalidas === 'function' &&
                          !isAdminUser &&
                          !isCurrentUserSolicitante
                        )
                        const latestTransferStageLabel = getTransferProgressStageLabel(
                          latestTransferStage,
                          latestTransferStage === 'recibido'
                            ? (latestTransferReceiptOutcome || transferReceiptOutcome)
                            : ''
                        )
                        const latestProgressPreferredTarget = latestTransferStage === 'recibido'
                          ? (isReminderOwnedByCurrentUser ? 'salidas' : 'entradas')
                          : 'salidas'
                        const currentReminderId = normalizeId(reminder?.id)
                        const isLatestTransferProgressReminder = Boolean(
                          latestTransferReminderId && latestTransferReminderId === currentReminderId
                        )
                        const latestProgressActionLabel = latestTransferStage === 'recibido'
                          ? (latestProgressPreferredTarget === 'salidas' ? 'Ver salida' : 'Ver entrada')
                          : (isCurrentUserSolicitante ? 'Ver envío en camino' : 'Ver salida en envío')
                        const canOpenLatestTransferProgress = (
                          isTransferContextReminder &&
                          !canResolveDecision &&
                          (
                            latestTransferStage === 'enviado' ||
                            latestTransferStage === 'recibido'
                          ) &&
                          (
                            typeof onOpenTransferRequestInSalidas === 'function' ||
                            typeof onOpenTransferRequestInEntradas === 'function'
                          )
                        )
                        const reminderTransferReference = (
                          extractTransferDocumentNumber(reminder?.context?.label || reminder?.description) ||
                          ''
                        ).toLowerCase()
                        const hasSentReminderForSameRequest = (
                          isTransferContextReminder &&
                          (Boolean(solicitudId) || Boolean(reminderTransferReference)) &&
                          (Array.isArray(reminders) ? reminders : []).some((candidate) => (
                            normalizeReminderContextType(candidate?.context?.type) === 'solicitud_traslado' &&
                            normalizeId(candidate?.id) !== normalizeId(reminder?.id) &&
                            getReminderDecisionStatus(candidate) === 'enviado' &&
                            (
                              (Boolean(solicitudId) && normalizeId(candidate?.context?.id) === solicitudId) ||
                              (
                                Boolean(reminderTransferReference) &&
                                (
                                  extractTransferDocumentNumber(
                                    candidate?.context?.label || candidate?.description
                                  ) || ''
                                ).toLowerCase() === reminderTransferReference
                              )
                            )
                          ))
                        )
                        const shouldUseSentCopyOnTransferEntryAction = (
                          visualDecisionStatus === 'enviado' ||
                          (visualDecisionStatus === 'aceptada' && hasSentReminderForSameRequest)
                        )
                        const transferEntryActionLabel = shouldUseSentCopyOnTransferEntryAction
                          ? 'Traslado ya enviado, ver envío en camino'
                          : (shouldShowCorrectionAction ? 'Corregir traslado' : 'Ver traslado')
                        const isOpeningTransfer = (
                          normalizeId(openingTransferReminderId) &&
                          normalizeId(openingTransferReminderId) === currentReminderId
                        )
                        const isOpeningInspection = (
                          normalizeId(openingInspectionReminderId) &&
                          normalizeId(openingInspectionReminderId) === currentReminderId
                        )
                        const canOpenRandomInspectionAction = (
                          status.className === 'pending' &&
                          (
                            isRandomInspectionDailyReminder(reminder) ||
                            isRandomInspectionVerifyReminder(reminder)
                          ) &&
                          typeof onOpenRandomInspection === 'function'
                        )
                        const canOpenTransferIssueAction = (
                          isTransferIssue &&
                          displayStatus.label === 'Pendiente' &&
                          typeof onOpenTransferIssuesSection === 'function'
                        )
                        const receiptOutcomeForIssue = latestTransferReceiptOutcome || transferReceiptOutcome
                        const canOpenIssueFromReceiptReminder = (
                          !isTransferIssue &&
                          isTransferContextReminder &&
                          receiptOutcomeForIssue === 'incompleto' &&
                          !isIssueResolved &&
                          isAdminUser &&
                          typeof onOpenTransferIssuesSection === 'function'
                        )
                        const isPendingInspectionAlert = (
                          status.className === 'pending' &&
                          (
                            isRandomInspectionDailyReminder(reminder) ||
                            isRandomInspectionVerifyReminder(reminder)
                          )
                        )
                        const isHighlightedReminder = (
                          Boolean(currentReminderId) &&
                          normalizeId(highlightedReminderId) === currentReminderId
                        )
                        const isTransferRelatedReminder = isTransferContextReminder || isTransferIssue
                        const canAdminOpenEntradaAction = (
                          isAdminUser &&
                          isTransferRelatedReminder &&
                          typeof onOpenTransferRequestInEntradas === 'function'
                        )
                        const canAdminOpenSalidaAction = (
                          isAdminUser &&
                          isTransferRelatedReminder &&
                          typeof onOpenTransferRequestInSalidas === 'function'
                        )
                        const shouldUseAdminTransferActions = canAdminOpenEntradaAction || canAdminOpenSalidaAction
                        const adminTransferSalidaLabel = canCreateSalidaFromReminder ? 'Crear salida' : 'Ver salida'
                        const timelineContextTitle = getTimelineReminderContextTitle(reminder)
                        const timelineContextReference = getTimelineReminderContextReference(reminder)
                        const timelineDescription = getTimelineReminderSummary({
                          reminder,
                          isTransferIssue,
                          isTransferContextReminder,
                          isSpecialReminder,
                          visualDecisionStatus,
                          displayStatus,
                        })

                        return (
                          <article
                            key={reminder.id}
                            ref={(node) => {
                              if (!currentReminderId) return
                              if (node) {
                                reminderItemRefs.current.set(currentReminderId, node)
                              } else {
                                reminderItemRefs.current.delete(currentReminderId)
                              }
                            }}
                            className={`recordatorios-popup__timeline-item${
                              displayStatus.className === 'pending' ? ' recordatorios-popup__timeline-item--pending' : ''
                            }${
                              displayStatus.className === 'rejected' ? ' recordatorios-popup__timeline-item--rejected' : ''
                            }${
                              displayStatus.className === 'accepted' ? ' recordatorios-popup__timeline-item--accepted' : ''
                            }${
                              displayStatus.className === 'sent' ? ' recordatorios-popup__timeline-item--sent' : ''
                            }${
                              displayStatus.className === 'cancelled' ? ' recordatorios-popup__timeline-item--cancelled' : ''
                            }${
                              displayStatus.className === 'issue' ? ' recordatorios-popup__timeline-item--issue' : ''
                            }${
                              isPendingInspectionAlert ? ' recordatorios-popup__timeline-item--inspection-alert' : ''
                            }${
                              isHighlightedReminder ? ' recordatorios-popup__timeline-item--highlighted' : ''
                            }`}
                          >
                            <div
                              className="recordatorios-popup__timeline-item-col recordatorios-popup__timeline-item-col--tema recordatorios-popup__timeline-item-col--clickable"
                              onClick={() => setActiveDetailReminderId(String(reminder?.id || ''))}
                            >
                              <strong className="recordatorios-popup__timeline-item-context">
                                {timelineContextTitle}
                              </strong>
                              {!!timelineContextReference && (
                                <span className="recordatorios-popup__timeline-item-context-ref">
                                  {timelineContextReference}
                                </span>
                              )}
                            </div>

                            <div
                              className="recordatorios-popup__timeline-item-col recordatorios-popup__timeline-item-col--details recordatorios-popup__timeline-item-col--clickable"
                              onClick={() => setActiveDetailReminderId(String(reminder?.id || ''))}
                            >
                              <p className="recordatorios-popup__timeline-item-time">{formatReminderTimeLabel(reminder)}</p>
                              <p className="recordatorios-popup__timeline-item-description" title={timelineDescription}>
                                {timelineDescription}
                              </p>
                            </div>

                            <div className="recordatorios-popup__timeline-item-col recordatorios-popup__timeline-item-col--estado" onClick={(e) => e.stopPropagation()}>
                              <span className={`recordatorios-popup__status recordatorios-popup__status--${displayStatus.className}`}>
                                {displayStatus.label}
                              </span>
                              <div className="recordatorios-popup__timeline-item-actions">
                                {canResolveDecision && (
                                  <button
                                    type="button"
                                    className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                    onClick={() => openDecisionPanel(reminder)}
                                  >
                                    Resolver traslado
                                  </button>
                                )}

                                {shouldUseAdminTransferActions ? (
                                  <>
                                    {isTransferLifecycleLoading && !canResolveDecision && (
                                      <button
                                        type="button"
                                        className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                        disabled
                                      >
                                        <Loader2 className="recordatorios-popup__inline-spinner" />
                                        Validando estado...
                                      </button>
                                    )}

                                    {canAdminOpenEntradaAction && (
                                      <button
                                        type="button"
                                        className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                        onClick={() => handleOpenTransferInEntradas(reminder)}
                                        disabled={isOpeningTransfer}
                                      >
                                        {isOpeningTransfer ? 'Abriendo...' : 'Ver entrada'}
                                      </button>
                                    )}

                                    {canAdminOpenSalidaAction && (
                                      <button
                                        type="button"
                                        className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                        onClick={() => {
                                          if (canCreateSalidaFromReminder) {
                                            void handleCreateSalidaFromReminder(reminder)
                                            return
                                          }
                                          void handleOpenTransferInSalidas(reminder)
                                        }}
                                        disabled={isOpeningTransfer}
                                      >
                                        {isOpeningTransfer ? 'Abriendo...' : adminTransferSalidaLabel}
                                      </button>
                                    )}

                                    {shouldShowCorrectionAction && canAdminOpenEntradaAction && (
                                      <button
                                        type="button"
                                        className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                        onClick={() => handleOpenTransferInEntradas(reminder)}
                                        disabled={isOpeningTransfer}
                                      >
                                        {isOpeningTransfer ? 'Abriendo...' : 'Corregir'}
                                      </button>
                                    )}

                                    {canOpenIssueFromReceiptReminder && (
                                      <button
                                        type="button"
                                        className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                        onClick={() => {
                                          void handleOpenTransferIssueResolution(reminder)
                                        }}
                                        disabled={isOpeningTransfer}
                                      >
                                        {isOpeningTransfer ? 'Abriendo...' : 'Ver inconveniente'}
                                      </button>
                                    )}

                                    {canOpenTransferIssueAction && (
                                      <button
                                        type="button"
                                        className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                        onClick={() => {
                                          void handleOpenTransferIssueResolution(reminder)
                                        }}
                                        disabled={isOpeningTransfer}
                                      >
                                        {isOpeningTransfer ? 'Abriendo...' : 'Resolver inconveniente'}
                                      </button>
                                    )}
                                  </>
                                ) : isTransferLifecycleLoading ? (
                                  <button
                                    type="button"
                                    className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                    disabled
                                  >
                                    <Loader2 className="recordatorios-popup__inline-spinner" />
                                    Validando estado...
                                  </button>
                                ) : canCreateSalidaFromReminder ? (
                                  <button
                                    type="button"
                                    className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                    onClick={() => handleCreateSalidaFromReminder(reminder)}
                                    disabled={isOpeningTransfer}
                                  >
                                    {isOpeningTransfer ? 'Abriendo...' : 'Crear salida'}
                                  </button>
                                ) : canOpenSalidaAsProvider ? (
                                  <button
                                    type="button"
                                    className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                    onClick={() => {
                                      void handleOpenTransferInSalidas(reminder)
                                    }}
                                    disabled={isOpeningTransfer}
                                  >
                                    {isOpeningTransfer ? 'Abriendo...' : 'Ver salida en envío'}
                                  </button>
                                ) : canOpenInTransitTransferFromReminder ? (
                                  <button
                                    type="button"
                                    className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                    onClick={() => {
                                      void handleOpenTransferInTransit(reminder)
                                    }}
                                    disabled={isOpeningTransfer}
                                  >
                                    {isOpeningTransfer ? 'Abriendo...' : 'Ver envío en camino'}
                                  </button>
                                ) : canOpenIssueFromReceiptReminder ? (
                                  <button
                                    type="button"
                                    className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                    onClick={() => {
                                      void handleOpenTransferIssueResolution(reminder)
                                    }}
                                    disabled={isOpeningTransfer}
                                  >
                                    {isOpeningTransfer ? 'Abriendo...' : 'Ver inconveniente'}
                                  </button>
                                ) : canOpenLatestTransferProgress ? (
                                  <button
                                    type="button"
                                    className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                    onClick={() => {
                                      if (isLatestTransferProgressReminder) {
                                        void handleOpenTransferByPreferredTarget(
                                          reminder,
                                          latestProgressPreferredTarget
                                        )
                                        return
                                      }
                                      handleJumpToLatestTransferReminder(reminder)
                                    }}
                                    disabled={isOpeningTransfer && isLatestTransferProgressReminder}
                                  >
                                    {isOpeningTransfer
                                      ? 'Abriendo...'
                                      : (
                                        isLatestTransferProgressReminder
                                          ? latestProgressActionLabel
                                          : `Ver último avance (${latestTransferStageLabel})`
                                      )}
                                  </button>
                                ) : canViewTransferRequest ? (
                                  <button
                                    type="button"
                                    className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                    onClick={() => handleOpenTransferInEntradas(reminder)}
                                    disabled={isOpeningTransfer}
                                  >
                                    {isOpeningTransfer
                                      ? 'Abriendo...'
                                      : transferEntryActionLabel}
                                  </button>
                                ) : canOpenRandomInspectionAction ? (
                                  <button
                                    type="button"
                                    className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                    onClick={() => {
                                      void handleOpenRandomInspection(reminder)
                                    }}
                                    disabled={isOpeningInspection}
                                  >
                                    {isOpeningInspection
                                      ? 'Abriendo...'
                                      : (
                                        isRandomInspectionVerifyReminder(reminder)
                                          ? 'Ir a revisión por sucursal'
                                          : 'Realizar inspección'
                                      )}
                                  </button>
                                ) : canOpenTransferIssueAction ? (
                                  <button
                                    type="button"
                                    className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                    onClick={() => {
                                      void handleOpenTransferIssueResolution(reminder)
                                    }}
                                    disabled={isOpeningTransfer}
                                  >
                                    {isOpeningTransfer ? 'Abriendo...' : 'Resolver inconveniente'}
                                  </button>
                                ) : status.canMarkSeen ? (
                                  <button
                                    type="button"
                                    className="recordatorios-popup__mark-seen"
                                    onClick={() => onMarkReminderSeen?.(reminder.id)}
                                  >
                                    Marcar como visto
                                  </button>
                                ) : isSpecialReminder && !canResolveDecision ? (
                                  <span className="recordatorios-popup__action-placeholder">Decisión registrada</span>
                                ) : null}
                              </div>
                            </div>
                          </article>
                        )
                    })
                  )}
                </div>
              </>
            </section>
          )}
        </div>

        {activeDecisionReminder && (
          <div className="recordatorios-popup__decision-overlay" onMouseDown={() => closeDecisionPanel()}>
            <div className="recordatorios-popup__decision-card" onMouseDown={(event) => event.stopPropagation()}>
              <header className="recordatorios-popup__decision-head">
                <div>
                  <h4>Traslado</h4>
                  <p>{formatReminderContext(activeDecisionReminder) || 'Detalle del traslado'}</p>
                </div>
                <button
                  type="button"
                  className="recordatorios-popup__close"
                  onClick={closeDecisionPanel}
                  aria-label="Cerrar decisión"
                >
                  <X />
                </button>
              </header>

              <div className="recordatorios-popup__decision-body">
                {decisionLoading && (
                  <p className="recordatorios-popup__decision-muted">
                    <Loader2 />
                    Cargando detalle de solicitud...
                  </p>
                )}

                {!decisionLoading && (
                  <>
                    <div className="recordatorios-popup__decision-grid">
                      <label>
                        <span>Documento</span>
                        <strong>{decisionDetail?.no_documento || '-'}</strong>
                      </label>
                      <label>
                        <span>Fecha</span>
                        <strong>{decisionDetail?.fecha || '-'}</strong>
                      </label>
                      <label>
                        <span>Sucursal solicitante</span>
                        <strong>{decisionDetail?.sucursal_solicitante || '-'}</strong>
                      </label>
                      <label>
                        <span>Sucursal proveedora</span>
                        <strong>{decisionDetail?.sucursal_proveedora || '-'}</strong>
                      </label>
                    </div>

                    <label className="recordatorios-popup__decision-description">
                      <span>Descripción</span>
                      <p>{String(decisionDetail?.descripcion || '').trim() || '-'}</p>
                    </label>

                    <div className="recordatorios-popup__decision-table-wrap">
                      <table className="recordatorios-popup__decision-table">
                        <thead>
                          <tr>
                            <th>Código</th>
                            <th>Producto</th>
                            <th>Cantidad</th>
                          </tr>
                        </thead>
                        <tbody>
                          {!decisionDetalles.length && (
                            <tr>
                              <td colSpan={3}>Sin productos en esta solicitud.</td>
                            </tr>
                          )}
                          {decisionDetalles.map((detalle) => (
                            <tr key={detalle.id || `${detalle.producto_id}-${detalle.cantidad}`}>
                              <td>{detalle?.producto_codigo || '-'}</td>
                              <td>{detalle?.producto_nombre || '-'}</td>
                              <td>{detalle?.cantidad || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {decisionError && <p className="recordatorios-popup__error">{decisionError}</p>}
              </div>

              <div className="recordatorios-popup__decision-actions">
                {canSubmitDecision && (
                  <div className="recordatorios-popup__decision-actions-row">
                    <button
                      type="button"
                      className="recordatorios-popup__button recordatorios-popup__decision-button recordatorios-popup__decision-button--reject"
                      onClick={handleRejectButtonClick}
                      disabled={decisionSubmitting || decisionLoading}
                    >
                      {decisionSubmitting ? 'Guardando...' : 'Rechazar'}
                    </button>
                    <button
                      type="button"
                      className="recordatorios-popup__button recordatorios-popup__decision-button recordatorios-popup__decision-button--accept"
                      onClick={() => handleTransferDecision('aceptar')}
                      disabled={decisionSubmitting || decisionLoading}
                    >
                      {decisionSubmitting ? 'Guardando...' : 'Aceptar'}
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="recordatorios-popup__decision-close-link"
                  onClick={closeDecisionPanel}
                  disabled={decisionSubmitting}
                >
                  Cerrar
                </button>
              </div>

              {isRejectReasonModalOpen && (
                <div className="recordatorios-popup__reject-overlay" onMouseDown={handleCloseRejectReasonModal}>
                  <div className="recordatorios-popup__reject-card" onMouseDown={(event) => event.stopPropagation()}>
                    <header className="recordatorios-popup__reject-head">
                      <h5>Motivo de rechazo</h5>
                      <button
                        type="button"
                        className="recordatorios-popup__close"
                        onClick={handleCloseRejectReasonModal}
                        disabled={decisionSubmitting}
                        aria-label="Cerrar motivo de rechazo"
                      >
                        <X />
                      </button>
                    </header>

                    <div className="recordatorios-popup__reject-body">
                      <label className="recordatorios-popup__field recordatorios-popup__field--full">
                        <span>Descripción (obligatoria)</span>
                        <textarea
                          value={rejectionReason}
                          onChange={(event) => setRejectionReason(event.target.value)}
                          placeholder="Explica por qué rechazas la solicitud"
                          disabled={decisionSubmitting}
                        />
                      </label>
                      {rejectReasonError && <p className="recordatorios-popup__error">{rejectReasonError}</p>}
                      {decisionError && <p className="recordatorios-popup__error">{decisionError}</p>}
                    </div>

                    <div className="recordatorios-popup__reject-actions">
                      <button
                        type="button"
                        className="recordatorios-popup__button recordatorios-popup__button--ghost"
                        onClick={handleCloseRejectReasonModal}
                        disabled={decisionSubmitting}
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        className="recordatorios-popup__button recordatorios-popup__decision-button recordatorios-popup__decision-button--reject"
                        onClick={handleConfirmRejectDecision}
                        disabled={decisionSubmitting || decisionLoading}
                      >
                        {decisionSubmitting ? 'Guardando...' : 'Confirmar rechazo'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeDetailReminder && (
          <div className="recordatorios-popup__detail-overlay" onMouseDown={() => setActiveDetailReminderId('')}>
            <div className="recordatorios-popup__detail-card" onMouseDown={(e) => e.stopPropagation()}>
              <header className="recordatorios-popup__detail-head">
                <div>
                  <h4>{formatReminderContext(activeDetailReminder)}</h4>
                  <p>{formatTimelineFullDate(formatDateKey(activeDetailReminder?.date))}</p>
                </div>
                <button
                  type="button"
                  className="recordatorios-popup__close"
                  onClick={() => setActiveDetailReminderId('')}
                  aria-label="Cerrar detalle"
                >
                  <X />
                </button>
              </header>

              <div className="recordatorios-popup__detail-body">
                <div className="recordatorios-popup__detail-row">
                  <span>Hora</span>
                  <strong>{formatReminderTimeLabel(activeDetailReminder)}</strong>
                </div>

                <div className="recordatorios-popup__detail-row">
                  <span>Estado</span>
                  {activeDetailReminderStatus && (
                    <span className={`recordatorios-popup__status recordatorios-popup__status--${activeDetailReminderStatus.className}`}>
                      {activeDetailReminderStatus.label}
                    </span>
                  )}
                </div>

                <div className="recordatorios-popup__detail-description">
                  <span>Descripción</span>
                  <p>{activeDetailReminderDescription}</p>
                </div>

                {activeDetailIsTransferIssue && activeDetailIssuesLoading && (
                  <div className="recordatorios-popup__detail-history">
                    <span>Productos con inconvenientes</span>
                    <div className="recordatorios-popup__loading">
                      <Loader2 />
                      <small>Cargando productos...</small>
                    </div>
                  </div>
                )}

                {activeDetailIsTransferIssue && !activeDetailIssuesLoading && (
                  <div className="recordatorios-popup__detail-history">
                    <span>Productos con inconvenientes</span>
                    <div className="recordatorios-popup__decision-table-wrap">
                      <table className="recordatorios-popup__decision-table">
                        <thead>
                          <tr>
                            <th>Código</th>
                            <th>Producto</th>
                            <th>Faltante</th>
                            <th>Estado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {!activeDetailIssueRows.length && (
                            <tr>
                              <td colSpan={4}>No hay productos con inconvenientes para este recordatorio.</td>
                            </tr>
                          )}
                          {activeDetailIssueRows.map((issue) => (
                            <tr key={issue.id}>
                              <td>{issue.productoCodigo}</td>
                              <td>{issue.productoNombre}</td>
                              <td>{issue.cantidadFaltante}</td>
                              <td>{issue.estadoLabel}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {activeDetailIssuesError && (
                      <p className="recordatorios-popup__error">{activeDetailIssuesError}</p>
                    )}
                  </div>
                )}

                {activeDetailIsTransferContext && activeDetailSolicitudLoading && (
                  <div className="recordatorios-popup__detail-history">
                    <span>Historial del traslado</span>
                    <div className="recordatorios-popup__loading">
                      <Loader2 />
                      <small>Cargando historial...</small>
                    </div>
                  </div>
                )}

                {!activeDetailSolicitudLoading && !!activeDetailTransferHistory.length && (
                  <div className="recordatorios-popup__detail-history">
                    <span>Historial del traslado</span>
                    <ol className="recordatorios-popup__detail-history-list">
                      {activeDetailTransferHistory.map((entry, index) => {
                        return (
                          <li
                            key={String(entry?.id || index)}
                            className={`recordatorios-popup__detail-history-item recordatorios-popup__detail-history-item--${entry.className}${entry.isPlaceholder ? ' recordatorios-popup__detail-history-item--upcoming' : ''}`}
                          >
                            <span className="recordatorios-popup__detail-history-point" aria-hidden="true" />
                            <div className="recordatorios-popup__detail-history-card">
                              <div className="recordatorios-popup__detail-history-top">
                                <span className={`recordatorios-popup__status recordatorios-popup__status--${entry.className}`}>
                                  {entry.label}
                                </span>
                                {!!entry.timestamp && (
                                  <span className="recordatorios-popup__detail-history-time">
                                    {Number.isFinite(Date.parse(entry.timestamp))
                                      ? new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.timestamp))
                                      : '-'}
                                  </span>
                                )}
                              </div>
                              {!!entry.actorName && (
                                <small>Por {entry.actorName}</small>
                              )}
                              {!!entry.detailText && (
                                <p className="recordatorios-popup__detail-history-reason">{entry.detailText}</p>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ol>
                  </div>
                )}

                <div className="recordatorios-popup__detail-grid">
                  <div className="recordatorios-popup__detail-row">
                    <span>Creador</span>
                    <strong>{activeDetailReminder?.creator?.name || 'Usuario'}</strong>
                  </div>
                  <div className="recordatorios-popup__detail-row">
                    <span>Dirigido a</span>
                    {activeDetailReminderRecipients.length ? (
                      <ul className="recordatorios-popup__detail-recipients">
                        {activeDetailReminderRecipients.map((recipientName, index) => (
                          <li key={`${recipientName}-${index}`}>{recipientName}</li>
                        ))}
                      </ul>
                    ) : (
                      <strong>-</strong>
                    )}
                  </div>
                </div>
              </div>

              <footer className="recordatorios-popup__detail-footer">
                {isTransferIssueReminder(activeDetailReminder) && activeDetailReminderStatus?.label === 'Pendiente' && (
                  <button
                    type="button"
                    className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                    onClick={() => {
                      void handleOpenTransferIssueResolution(activeDetailReminder)
                    }}
                    disabled={normalizeId(openingTransferReminderId) === normalizeId(activeDetailReminder?.id)}
                  >
                    {normalizeId(openingTransferReminderId) === normalizeId(activeDetailReminder?.id)
                      ? 'Abriendo...'
                      : 'Resolver inconveniente'}
                  </button>
                )}
                <button
                  type="button"
                  className="recordatorios-popup__decision-close-link"
                  onClick={() => setActiveDetailReminderId('')}
                >
                  Cerrar
                </button>
              </footer>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

export default RecordatoriosPopup
