import { API_URL, authFetch, resolveAuthToken } from '../../../../utils/api'

export const REMINDERS_STORAGE_KEY = 'inventario-recordatorios-v1'
export const REMINDERS_SYNC_EVENT = 'inventario-reminders-sync'
export const REMINDERS_TRANSFER_NOTIFICATION_EVENT = 'inventario-reminders-transfer-notification'
export const SPECIAL_TRANSFER_DECISION_KIND = 'solicitud_traslado_decision'
export const TRANSFER_RECEIPT_NOTIFICATION_KIND = 'solicitud_traslado_recepcion'
export const RANDOM_INSPECTION_KIND = 'inspeccion_aleatoria_diaria'
export const RANDOM_INSPECTION_VERIFY_KIND = 'inspeccion_aleatoria_verificacion'
export const RANDOM_INSPECTION_CONTEXT_TYPE = 'inspeccion_aleatoria'
export const REMINDERS_BACKEND_ENDPOINT = `${API_URL}/recordatorios/estado/`

export const normalizeId = (value) => (value == null ? '' : String(value).trim())
export const normalizeText = (value) => String(value || '').trim().toLowerCase()

export const createReminderId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `rem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const extractUserId = (user) =>
  normalizeId(
    user?.usuarioInternoId ||
      user?.usuario_interno_id ||
      user?.usuario_id ||
      user?.user_id ||
      user?.id
  )

export const buildUserIdSet = (candidate) => {
  const ids = [
    candidate?.usuarioInternoId,
    candidate?.usuario_interno_id,
    candidate?.usuario_id,
    candidate?.user_id,
    candidate?.id,
  ]
    .map(normalizeId)
    .filter(Boolean)

  return new Set(ids)
}

export const formatCurrentUserName = (user) =>
  [
    user?.nombres || user?.nombre || user?.first_name,
    user?.apellidos || user?.apellido || user?.last_name,
  ]
    .filter(Boolean)
    .join(' ')
    .trim() || user?.username || user?.correo || 'Usuario'

export const reminderRecipientIds = (reminder) =>
  (Array.isArray(reminder?.recipients) ? reminder.recipients : [])
    .map((recipient) => normalizeId(recipient?.id))
    .filter(Boolean)

export const reminderCompletedByIds = (reminder) =>
  (Array.isArray(reminder?.completedBy) ? reminder.completedBy : [])
    .map((id) => normalizeId(id))
    .filter(Boolean)

export const reminderCreatorId = (reminder) => normalizeId(reminder?.creator?.id)

export const getReminderTimestamp = (reminder) => {
  const date = String(reminder?.date || '').trim()
  const time = String(reminder?.time || '').trim()
  if (!date || !time) return Number.NaN
  const parsed = Date.parse(`${date}T${time}:00`)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

export const getReminderDeadlineTimestamp = (reminder) => {
  const explicitDeadline = String(reminder?.deadlineAt || '').trim()
  if (explicitDeadline) {
    const explicit = Date.parse(explicitDeadline)
    if (Number.isFinite(explicit)) return explicit
  }

  const date = String(reminder?.date || '').trim()
  if (!date) return Number.NaN
  const parsed = Date.parse(`${date}T23:59:59`)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

export const formatReminderDateTime = (reminder) => {
  const date = String(reminder?.date || '').trim()
  const time = String(reminder?.time || '').trim()
  if (!date || !time) return 'Sin fecha u hora'

  const timestamp = Date.parse(`${date}T${time}:00`)
  if (!Number.isFinite(timestamp)) return `${date} ${time}`

  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

export const sanitizeRecipient = (recipient) => {
  const id = normalizeId(recipient?.id || recipient?.usuario_id || recipient?.user_id)
  if (!id) return null

  const name = String(recipient?.name || recipient?.nombre || recipient?.label || 'Usuario').trim() || 'Usuario'

  return { id, name }
}

const sanitizeReminderContext = (rawContext) => {
  const type = normalizeId(rawContext?.type || rawContext?.modulo || rawContext?.entidad || rawContext?.tabla)
  const id = normalizeId(rawContext?.id || rawContext?.entidad_id || rawContext?.objeto_id)
  const label = String(rawContext?.label || rawContext?.nombre || '').trim()

  if (!type || !id) return null

  return {
    type,
    id,
    label,
  }
}

const parseIsoTimestamp = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const timestamp = Date.parse(raw)
  if (!Number.isFinite(timestamp)) return ''
  return new Date(timestamp).toISOString()
}

const normalizeDecisionStatus = (value) => {
  const normalized = normalizeText(value)
  if (
    normalized === 'aceptada' ||
    normalized === 'aprobada' ||
    normalized === 'approved'
  ) {
    return 'aceptada'
  }
  if (
    normalized === 'enviado' ||
    normalized === 'enviada' ||
    normalized === 'en_transito' ||
    normalized === 'en_traslado' ||
    normalized === 'en traslado' ||
    normalized === 'shipped' ||
    normalized === 'sent'
  ) {
    return 'enviado'
  }
  if (
    normalized === 'rechazada' ||
    normalized === 'rechazar' ||
    normalized === 'rejected'
  ) {
    return 'rechazada'
  }
  return 'pendiente'
}

const sanitizeReminderDecision = (rawDecision) => {
  const status = normalizeDecisionStatus(rawDecision?.status || rawDecision?.estado)
  const reason = String(rawDecision?.reason || rawDecision?.motivo || '').trim()
  const by = sanitizeRecipient(rawDecision?.by || rawDecision?.usuario)
  const at = parseIsoTimestamp(rawDecision?.at || rawDecision?.fecha)

  return {
    status,
    reason,
    by,
    at,
  }
}

export const sanitizeReminder = (reminder) => {
  const date = String(reminder?.date || reminder?.fecha || '').trim()
  const time = String(reminder?.time || reminder?.hora || '').trim()
  const description = String(reminder?.description || reminder?.descripcion || '').trim()

  const recipientsRaw = Array.isArray(reminder?.recipients)
    ? reminder.recipients
    : Array.isArray(reminder?.destinatarios)
      ? reminder.destinatarios
      : []
  const recipients = recipientsRaw.map(sanitizeRecipient).filter(Boolean)

  if (!date || !time || !recipients.length) return null

  const creatorId = normalizeId(
    reminder?.creator?.id || reminder?.creatorId || reminder?.usuario_creador_id
  )
  const creatorName = String(
    reminder?.creator?.name || reminder?.creatorName || reminder?.usuario_creador_nombre || 'Usuario'
  ).trim() || 'Usuario'

  const context = sanitizeReminderContext(
    reminder?.context || {
      type: reminder?.contextType,
      id: reminder?.contextId,
      label: reminder?.contextLabel,
    }
  )
  const kind = normalizeId(reminder?.kind || reminder?.tipo)
  const deadlineAt = parseIsoTimestamp(reminder?.deadlineAt || reminder?.deadline_at)
  const decision = sanitizeReminderDecision(reminder?.decision || reminder?.resolucion)

  return {
    id: normalizeId(reminder?.id) || createReminderId(),
    date,
    time,
    description,
    creator: {
      id: creatorId,
      name: creatorName,
    },
    recipients,
    context,
    kind,
    deadlineAt,
    decision,
    createdAt: parseIsoTimestamp(reminder?.createdAt || reminder?.creado_en) || new Date().toISOString(),
    completedBy: reminderCompletedByIds(reminder),
  }
}

const writeRemindersToLocalCache = (reminders) => {
  const normalized = (Array.isArray(reminders) ? reminders : []).map(sanitizeReminder).filter(Boolean)
  if (typeof window === 'undefined') return normalized

  try {
    window.localStorage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // Ignore storage errors (quota/private mode).
  }

  return normalized
}

const areRemindersEqual = (first, second) => {
  if (!Array.isArray(first) && !Array.isArray(second)) return true
  if (!Array.isArray(first) || !Array.isArray(second)) return false
  if (first.length !== second.length) return false
  for (let i = 0; i < first.length; i += 1) {
    if (JSON.stringify(first[i]) !== JSON.stringify(second[i])) {
      return false
    }
  }
  return true
}

let pendingServerSnapshot = null
let isServerSyncInFlight = false

export const syncRemindersToBackend = async (reminders, token) => {
  const normalized = (Array.isArray(reminders) ? reminders : []).map(sanitizeReminder).filter(Boolean)
  const effectiveToken = resolveAuthToken(token)
  if (!effectiveToken) return normalized

  try {
    const response = await authFetch(
      REMINDERS_BACKEND_ENDPOINT,
      {
        method: 'PUT',
        body: JSON.stringify({ reminders: normalized }),
      },
      effectiveToken
    )

    if (!response.ok) {
      return normalized
    }

    const payload = await response.json().catch(() => ({}))
    const backendReminders = Array.isArray(payload?.reminders)
      ? payload.reminders
      : Array.isArray(payload)
        ? payload
        : []
    const merged = backendReminders.map(sanitizeReminder).filter(Boolean)
    if (!merged.length) return normalized
    return writeRemindersToLocalCache(merged)
  } catch {
    return normalized
  }
}

const queueServerReminderSync = (reminders, token) => {
  if (typeof window === 'undefined') return

  pendingServerSnapshot = (Array.isArray(reminders) ? reminders : []).map(sanitizeReminder).filter(Boolean)
  if (!pendingServerSnapshot.length && !readRemindersFromStorage().length) {
    return
  }
  if (isServerSyncInFlight) return

  isServerSyncInFlight = true
  const flush = async () => {
    while (pendingServerSnapshot) {
      const snapshot = pendingServerSnapshot
      pendingServerSnapshot = null
      const synced = await syncRemindersToBackend(snapshot, token)
      writeRemindersToLocalCache(synced)
      emitRemindersSync()
    }
    isServerSyncInFlight = false
  }

  void flush()
}

export const fetchRemindersFromBackend = async (token) => {
  const effectiveToken = resolveAuthToken(token)
  if (!effectiveToken) return readRemindersFromStorage()

  try {
    const response = await authFetch(REMINDERS_BACKEND_ENDPOINT, {}, effectiveToken)
    if (!response.ok) return readRemindersFromStorage()

    const payload = await response.json().catch(() => ({}))
    const backendReminders = Array.isArray(payload?.reminders)
      ? payload.reminders
      : Array.isArray(payload)
        ? payload
        : []
    const normalized = backendReminders.map(sanitizeReminder).filter(Boolean)
    const existing = readRemindersFromStorage()
    const cached = writeRemindersToLocalCache(normalized)
    if (!areRemindersEqual(existing, normalized)) {
      emitRemindersSync()
    }
    return cached
  } catch {
    return readRemindersFromStorage()
  }
}

export const readRemindersFromStorage = () => {
  if (typeof window === 'undefined') return []

  try {
    const raw = window.localStorage.getItem(REMINDERS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(sanitizeReminder).filter(Boolean)
  } catch {
    return []
  }
}

export const writeRemindersToStorage = (reminders) => {
  const normalized = writeRemindersToLocalCache(reminders)
  queueServerReminderSync(normalized)
  return normalized
}

export const emitRemindersSync = () => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(REMINDERS_SYNC_EVENT))
}

export const emitTransferReminderNotification = (detail = {}) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(REMINDERS_TRANSFER_NOTIFICATION_EVENT, {
      detail,
    })
  )
}

export const isReminderForCurrentUser = (reminder, userIdSet) => {
  if (!userIdSet?.size) return false
  return reminderRecipientIds(reminder).some((id) => userIdSet.has(id))
}

export const isReminderCreatedByCurrentUser = (reminder, userIdSet, currentUserName) => {
  const creatorId = reminderCreatorId(reminder)
  if (creatorId && userIdSet.has(creatorId)) return true

  const creatorName = normalizeText(reminder?.creator?.name)
  const normalizedCurrentUserName = normalizeText(currentUserName)
  if (!creatorName || !normalizedCurrentUserName) return false

  return creatorName === normalizedCurrentUserName
}

export const isReminderSeenByCurrentUser = (reminder, userIdSet) => {
  if (!userIdSet?.size) return false
  return reminderCompletedByIds(reminder).some((id) => userIdSet.has(id))
}

export const isSpecialTransferDecisionReminder = (reminder) =>
  normalizeId(reminder?.kind) === SPECIAL_TRANSFER_DECISION_KIND

export const isRandomInspectionDailyReminder = (reminder) => {
  const kind = normalizeId(reminder?.kind)
  if (kind === RANDOM_INSPECTION_KIND) return true
  const contextType = normalizeText(reminder?.context?.type).replace(/[\s-]+/g, '_')
  return contextType === RANDOM_INSPECTION_CONTEXT_TYPE && kind !== RANDOM_INSPECTION_VERIFY_KIND
}

export const isRandomInspectionVerifyReminder = (reminder) =>
  normalizeId(reminder?.kind) === RANDOM_INSPECTION_VERIFY_KIND

export const isRandomInspectionReminder = (reminder) =>
  isRandomInspectionDailyReminder(reminder) || isRandomInspectionVerifyReminder(reminder)

const normalizeComparableText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()

export const getTransferReceiptOutcome = (reminder) => {
  const contextType = normalizeText(reminder?.context?.type).replace(/[\s-]+/g, '_')
  if (contextType !== 'solicitud_traslado') return ''

  const kind = normalizeId(reminder?.kind)
  const description = normalizeComparableText(reminder?.description)
  if (!description) return ''

  const mentionsTransferArrival = description.includes('envio de traslado') || kind === TRANSFER_RECEIPT_NOTIFICATION_KIND
  if (!mentionsTransferArrival) return ''

  if (description.includes('llego incompleto')) return 'incompleto'
  if (description.includes('llego completo')) return 'completo'
  return ''
}

export const isTransferReceiptNotificationReminder = (reminder) =>
  Boolean(getTransferReceiptOutcome(reminder))

const inferTransferDecisionStatusFromDescription = (reminder) => {
  const contextType = normalizeText(reminder?.context?.type).replace(/[\s-]+/g, '_')
  if (contextType !== 'solicitud_traslado') return 'pendiente'

  const description = normalizeText(reminder?.description)
  if (!description) return 'pendiente'

  if (
    description.includes('fue rechazada') ||
    description.includes('solicitud rechazada') ||
    description.includes('rechazada por')
  ) {
    return 'rechazada'
  }

  if (
    description.includes('fue enviada') ||
    description.includes('fue enviado') ||
    description.includes('solicitud enviada') ||
    description.includes('esta en envio') ||
    description.includes('está en envío') ||
    description.includes('en traslado')
  ) {
    return 'enviado'
  }

  if (
    description.includes('fue aceptada') ||
    description.includes('solicitud aceptada') ||
    description.includes('aceptada por')
  ) {
    return 'aceptada'
  }

  return 'pendiente'
}

export const getReminderDecisionStatus = (reminder) => {
  const explicitStatus = normalizeDecisionStatus(reminder?.decision?.status)
  if (explicitStatus !== 'pendiente') return explicitStatus
  return inferTransferDecisionStatusFromDescription(reminder)
}

export const isSpecialReminderResolved = (reminder) => {
  if (!isSpecialTransferDecisionReminder(reminder)) return false
  const status = getReminderDecisionStatus(reminder)
  return status === 'aceptada' || status === 'rechazada'
}

export const isReminderPendingForCurrentUser = (reminder, userIdSet) => {
  if (!isReminderForCurrentUser(reminder, userIdSet)) return false
  if (isReminderSeenByCurrentUser(reminder, userIdSet)) return false
  if (isRandomInspectionReminder(reminder)) return true

  const decisionStatus = getReminderDecisionStatus(reminder)
  const isTransferContext =
    normalizeText(reminder?.context?.type).replace(/[\s-]+/g, '_') === 'solicitud_traslado'
  const isTransferResponseReminder =
    isTransferContext &&
    !isSpecialTransferDecisionReminder(reminder) &&
    (decisionStatus === 'aceptada' || decisionStatus === 'rechazada' || decisionStatus === 'enviado')
  if (isTransferResponseReminder) return true

  if (isSpecialReminderResolved(reminder)) return false
  if (isSpecialTransferDecisionReminder(reminder)) return true

  const timestamp = getReminderTimestamp(reminder)
  if (!Number.isFinite(timestamp)) return true

  return timestamp >= Date.now()
}

export const isReminderForContext = (reminder, context) => {
  const contextType = normalizeId(context?.type)
  const contextId = normalizeId(context?.id)
  if (!contextType || !contextId) return false

  const reminderType = normalizeId(reminder?.context?.type)
  const reminderId = normalizeId(reminder?.context?.id)

  return reminderType === contextType && reminderId === contextId
}

export const sortRemindersForCurrentUser = (reminders, userIdSet) => {
  const list = Array.isArray(reminders) ? reminders : []

  return [...list].sort((a, b) => {
    const pendingA = isReminderPendingForCurrentUser(a, userIdSet)
    const pendingB = isReminderPendingForCurrentUser(b, userIdSet)
    if (pendingA !== pendingB) return pendingA ? -1 : 1

    const timeA = getReminderTimestamp(a)
    const timeB = getReminderTimestamp(b)

    if (Number.isFinite(timeA) && Number.isFinite(timeB)) return timeB - timeA
    if (Number.isFinite(timeA)) return -1
    if (Number.isFinite(timeB)) return 1

    return String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''))
  })
}

export const buildReminderStatusForUser = (reminder, userIdSet) => {
  const recipientIds = reminderRecipientIds(reminder)
  const isForCurrentUser = recipientIds.some((id) => userIdSet.has(id))
  const seenByCurrentUser = reminderCompletedByIds(reminder).some((id) => userIdSet.has(id))
  const isSpecialReminder = isSpecialTransferDecisionReminder(reminder)
  const isRandomInspectionDaily = isRandomInspectionDailyReminder(reminder)
  const isRandomInspectionVerify = isRandomInspectionVerifyReminder(reminder)
  const transferReceiptOutcome = getTransferReceiptOutcome(reminder)
  const decisionStatus = getReminderDecisionStatus(reminder)
  const contextType = normalizeText(reminder?.context?.type).replace(/[\s-]+/g, '_')
  const isTransferContext = contextType === 'solicitud_traslado'

  if (!isForCurrentUser) {
    return {
      label: 'Informativo',
      className: 'info',
      canMarkSeen: false,
    }
  }

  if (transferReceiptOutcome === 'completo') {
    return {
      label: 'Llego completo',
      className: 'info',
      canMarkSeen: false,
    }
  }

  if (transferReceiptOutcome === 'incompleto') {
    return {
      label: 'Llego incompleto',
      className: 'info',
      canMarkSeen: false,
    }
  }

  if ((isSpecialReminder || isTransferContext) && decisionStatus === 'aceptada') {
    return {
      label: 'Aceptada',
      className: 'accepted',
      canMarkSeen: false,
    }
  }

  if ((isSpecialReminder || isTransferContext) && decisionStatus === 'rechazada') {
    return {
      label: 'Rechazada',
      className: 'rejected',
      canMarkSeen: false,
    }
  }

  if ((isSpecialReminder || isTransferContext) && decisionStatus === 'enviado') {
    return {
      label: 'Enviado',
      className: 'sent',
      canMarkSeen: false,
    }
  }

  if (isRandomInspectionDaily) {
    if (seenByCurrentUser) {
      return {
        label: 'Completada',
        className: 'seen',
        canMarkSeen: false,
      }
    }
    return {
      label: 'Inspeccion',
      className: 'pending',
      canMarkSeen: false,
    }
  }

  if (isRandomInspectionVerify) {
    if (seenByCurrentUser) {
      return {
        label: 'Visto',
        className: 'seen',
        canMarkSeen: false,
      }
    }
    return {
      label: 'Por verificar',
      className: 'pending',
      canMarkSeen: true,
    }
  }

  if (seenByCurrentUser) {
    return {
      label: 'Visto',
      className: 'seen',
      canMarkSeen: false,
    }
  }

  const timestamp = isSpecialReminder
    ? getReminderDeadlineTimestamp(reminder)
    : getReminderTimestamp(reminder)
  if (Number.isFinite(timestamp) && timestamp < Date.now()) {
    return {
      label: isSpecialReminder ? 'Urgente' : 'Vencido',
      className: 'expired',
      canMarkSeen: !isSpecialReminder,
    }
  }

  return {
    label: isSpecialReminder ? 'Por decidir' : 'Pendiente',
    className: 'pending',
    canMarkSeen: !isSpecialReminder,
  }
}
