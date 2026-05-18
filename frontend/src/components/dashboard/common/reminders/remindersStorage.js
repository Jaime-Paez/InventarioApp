import { API_URL, authFetch, resolveAuthToken } from '../../../../utils/api'

export const REMINDERS_STORAGE_KEY = 'inventario-recordatorios-v1'
export const REMINDERS_SYNC_EVENT = 'inventario-reminders-sync'
export const REMINDERS_TRANSFER_NOTIFICATION_EVENT = 'inventario-reminders-transfer-notification'
export const SPECIAL_TRANSFER_DECISION_KIND = 'solicitud_traslado_decision'
export const GARANTIA_APPROVAL_KIND = 'solicitud_garantia'
export const GARANTIA_RESULT_KIND = 'solicitud_garantia_resultado'
export const TRANSFER_RECEIPT_NOTIFICATION_KIND = 'solicitud_traslado_recepcion'
export const TRANSFER_ISSUE_NOTIFICATION_KIND = 'solicitud_traslado_inconveniente'
export const RANDOM_INSPECTION_KIND = 'inspeccion_aleatoria_diaria'
export const RANDOM_INSPECTION_VERIFY_KIND = 'inspeccion_aleatoria_verificacion'
export const RANDOM_INSPECTION_ADMIN_SUMMARY_KIND = 'inspeccion_aleatoria_resumen_admin'
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

  const result = { type, id, label }
  if (rawContext?.urgente !== undefined) {
    result.urgente = Boolean(rawContext.urgente)
  }
  const solicitanteId = normalizeId(rawContext?.sucursal_solicitante_id)
  if (solicitanteId) result.sucursal_solicitante_id = solicitanteId
  const proveedoraId = normalizeId(rawContext?.sucursal_proveedora_id)
  if (proveedoraId) result.sucursal_proveedora_id = proveedoraId
  if (Array.isArray(rawContext?.detalle_usuarios)) {
    const sanitized = rawContext.detalle_usuarios
      .filter((entry) => entry && typeof entry === 'object' && normalizeId(entry?.id))
      .map((entry) => ({
        id: normalizeId(entry.id),
        name: String(entry.name || 'Usuario').trim() || 'Usuario',
        completada: Boolean(entry.completada),
      }))
    if (sanitized.length > 0) {
      result.detalle_usuarios = sanitized
    }
  }
  return result
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
  if (normalized === 'cancelado' || normalized === 'cancelada') {
    return 'cancelado'
  }
  return 'pendiente'
}

const sanitizeReminderDecision = (rawDecision) => {
  const status = normalizeDecisionStatus(rawDecision?.status || rawDecision?.estado)
  const reason = String(rawDecision?.reason || rawDecision?.motivo || '').trim()
  const by = sanitizeRecipient(rawDecision?.by || rawDecision?.usuario)
  const at = parseIsoTimestamp(rawDecision?.at || rawDecision?.fecha)
  const assignedRecipients = (Array.isArray(rawDecision?.assignedRecipients)
    ? rawDecision.assignedRecipients
    : Array.isArray(rawDecision?.assigned_recipients)
      ? rawDecision.assigned_recipients
      : Array.isArray(rawDecision?.recipients)
        ? rawDecision.recipients
        : []
  )
    .map(sanitizeRecipient)
    .filter(Boolean)
    .filter(
      (recipient, index, source) =>
        source.findIndex((item) => normalizeId(item?.id) === normalizeId(recipient?.id)) === index
    )

  return {
    status,
    reason,
    by,
    at,
    assignedRecipients,
  }
}

const normalizeTransferHistoryStage = (value) => {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  if (normalized === 'pendiente' || normalized === 'solicitud' || normalized === 'creada') return 'pendiente'
  if (normalized === 'aceptada' || normalized === 'aprobada' || normalized === 'approved') return 'aceptada'
  if (normalized === 'rechazada' || normalized === 'rechazar' || normalized === 'rejected' || normalized === 'cancelada') return 'rechazada'
  if (
    normalized === 'enviado' ||
    normalized === 'enviada' ||
    normalized === 'en_traslado' ||
    normalized === 'en traslado' ||
    normalized === 'en_transito' ||
    normalized === 'sent' ||
    normalized === 'shipped'
  ) {
    return 'enviado'
  }
  if (normalized === 'completo' || normalized === 'recibido_completo' || normalized === 'llego_completo') return 'completo'
  if (normalized === 'incompleto' || normalized === 'recibido_incompleto' || normalized === 'llego_incompleto') return 'incompleto'
  if (normalized === 'cancelado' || normalized === 'cancelado_por_solicitante') return 'cancelado'
  return ''
}

const buildTransferHistoryTimestampFromReminder = (reminder) => {
  const reminderDate = String(reminder?.date || '').trim()
  const reminderTime = String(reminder?.time || '').trim()
  if (reminderDate && reminderTime) {
    const parsed = parseIsoTimestamp(`${reminderDate}T${reminderTime}:00`)
    if (parsed) return parsed
  }
  return parseIsoTimestamp(reminder?.createdAt) || new Date().toISOString()
}

const sanitizeTransferHistoryEntry = (rawEntry) => {
  const stage = normalizeTransferHistoryStage(
    rawEntry?.stage || rawEntry?.status || rawEntry?.key
  )
  if (!stage) return null

  return {
    stage,
    label: String(rawEntry?.label || '').trim(),
    description: String(rawEntry?.description || rawEntry?.descripcion || '').trim(),
    at: parseIsoTimestamp(rawEntry?.at || rawEntry?.fecha) || new Date().toISOString(),
    actor: sanitizeRecipient(rawEntry?.actor || rawEntry?.by || rawEntry?.usuario),
  }
}

const inferLegacyTransferHistoryEntry = (reminder) => {
  const contextType = normalizeText(reminder?.context?.type).replace(/[\s-]+/g, '_')
  if (contextType !== 'solicitud_traslado') return null

  const description = String(reminder?.description || '').trim()
  const comparableDescription = normalizeComparableText(description)
  const decisionStatus = normalizeDecisionStatus(reminder?.decision?.status)
  let stage = ''
  if (comparableDescription.includes('llego incompleto')) {
    stage = 'incompleto'
  } else if (comparableDescription.includes('llego completo')) {
    stage = 'completo'
  } else if (decisionStatus && decisionStatus !== 'pendiente') {
    stage = decisionStatus
  } else if (isSpecialTransferDecisionReminder(reminder)) {
    stage = 'pendiente'
  } else if (comparableDescription.includes('fue aceptada')) {
    stage = 'aceptada'
  } else if (comparableDescription.includes('fue rechazada')) {
    stage = 'rechazada'
  } else if (comparableDescription.includes('en traslado') || comparableDescription.includes('fue enviada')) {
    stage = 'enviado'
  } else {
    stage = 'pendiente'
  }

  return {
    stage,
    label: '',
    description,
    at: buildTransferHistoryTimestampFromReminder(reminder),
    actor: sanitizeRecipient(reminder?.decision?.by || reminder?.creator),
  }
}

const sanitizeTransferHistory = (rawHistory, reminder) => {
  const bySignature = new Map()
  ;(Array.isArray(rawHistory) ? rawHistory : []).forEach((entry) => {
    const normalized = sanitizeTransferHistoryEntry(entry)
    if (!normalized?.stage) return
    const actorId = normalizeId(normalized?.actor?.id)
    const signature = [
      normalized.stage,
      String(normalized?.at || '').trim(),
      actorId,
      normalizeComparableText(normalized?.description),
    ].join('|')
    if (!signature.replace(/\|/g, '')) return
    bySignature.set(signature, normalized)
  })

  if (!bySignature.size) {
    const legacyEntry = inferLegacyTransferHistoryEntry(reminder)
    if (legacyEntry?.stage) {
      const actorId = normalizeId(legacyEntry?.actor?.id)
      const signature = [
        legacyEntry.stage,
        String(legacyEntry?.at || '').trim(),
        actorId,
        normalizeComparableText(legacyEntry?.description),
      ].join('|')
      bySignature.set(signature, legacyEntry)
    }
  }

  return collapseDuplicateTransferHistoryEntries(
    Array.from(bySignature.values()).sort((a, b) =>
      String(a?.at || '').localeCompare(String(b?.at || ''))
    )
  )
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
  const transferHistory = sanitizeTransferHistory(
    reminder?.transferHistory || reminder?.transfer_history || reminder?.history,
    reminder
  )

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
    transferHistory,
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

  const localSnapshot = readRemindersFromStorage()
  if (pendingServerSnapshot || isServerSyncInFlight) {
    return localSnapshot
  }

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
    if (pendingServerSnapshot || isServerSyncInFlight) {
      return existing
    }
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

export const isGarantiaApprovalReminder = (reminder) =>
  normalizeId(reminder?.kind) === GARANTIA_APPROVAL_KIND

export const isGarantiaResultReminder = (reminder) =>
  normalizeId(reminder?.kind) === GARANTIA_RESULT_KIND

export const isRandomInspectionDailyReminder = (reminder) => {
  const kind = normalizeId(reminder?.kind)
  if (kind === RANDOM_INSPECTION_KIND) return true
  const contextType = normalizeText(reminder?.context?.type).replace(/[\s-]+/g, '_')
  return contextType === RANDOM_INSPECTION_CONTEXT_TYPE && kind !== RANDOM_INSPECTION_VERIFY_KIND
}

export const isRandomInspectionVerifyReminder = (reminder) =>
  normalizeId(reminder?.kind) === RANDOM_INSPECTION_VERIFY_KIND

export const isRandomInspectionAdminSummaryReminder = (reminder) =>
  normalizeId(reminder?.kind) === RANDOM_INSPECTION_ADMIN_SUMMARY_KIND

export const isRandomInspectionReminder = (reminder) =>
  isRandomInspectionDailyReminder(reminder) ||
  isRandomInspectionVerifyReminder(reminder) ||
  isRandomInspectionAdminSummaryReminder(reminder)

const normalizeComparableText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()

export const getTransferReminderHistory = (reminder) =>
  sanitizeTransferHistory(reminder?.transferHistory || reminder?.history, reminder)

export const getLatestTransferHistoryEntry = (reminder) => {
  const history = getTransferReminderHistory(reminder)
  return history.length ? history[history.length - 1] : null
}

export const getTransferReminderPendingSnapshotKey = (reminder) => {
  const reminderId = normalizeId(reminder?.id)
  if (!reminderId) return ''
  const latestEntry = getLatestTransferHistoryEntry(reminder)
  const stage = normalizeTransferHistoryStage(latestEntry?.stage)
  const at = String(latestEntry?.at || '').trim()
  return [reminderId, stage || 'unknown', at || String(reminder?.createdAt || '').trim()].join(':')
}

export const isTransferDecisionAllowedForUser = (reminder, userIdSet) => {
  if (!userIdSet?.size) return false
  const assignedRecipientIds = (
    Array.isArray(reminder?.decision?.assignedRecipients)
      ? reminder.decision.assignedRecipients
      : []
  )
    .map((recipient) => normalizeId(recipient?.id))
    .filter(Boolean)

  if (assignedRecipientIds.length) {
    return assignedRecipientIds.some((id) => userIdSet.has(id))
  }
  return reminderRecipientIds(reminder).some((id) => userIdSet.has(id))
}

export const getTransferReceiptOutcome = (reminder) => {
  const contextType = normalizeText(reminder?.context?.type).replace(/[\s-]+/g, '_')
  if (contextType !== 'solicitud_traslado') return ''

  const latestHistoryStage = normalizeTransferHistoryStage(getLatestTransferHistoryEntry(reminder)?.stage)
  if (latestHistoryStage === 'completo') return 'completo'
  if (latestHistoryStage === 'incompleto') return 'incompleto'

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

export const isTransferIssueReminder = (reminder) =>
  normalizeId(reminder?.kind) === TRANSFER_ISSUE_NOTIFICATION_KIND

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
  const latestHistoryStage = normalizeTransferHistoryStage(getLatestTransferHistoryEntry(reminder)?.stage)
  if (latestHistoryStage === 'pendiente') return 'pendiente'
  if (latestHistoryStage === 'aceptada' || latestHistoryStage === 'rechazada' || latestHistoryStage === 'enviado' || latestHistoryStage === 'cancelado') {
    return latestHistoryStage
  }
  const explicitStatus = normalizeDecisionStatus(reminder?.decision?.status)
  if (explicitStatus !== 'pendiente') return explicitStatus
  return inferTransferDecisionStatusFromDescription(reminder)
}

const collapseDuplicateTransferHistoryEntries = (entries) => {
  const collapsed = []

  const areTimestampsEquivalent = (firstValue, secondValue) => {
    const firstTimestamp = Date.parse(String(firstValue || '').trim())
    const secondTimestamp = Date.parse(String(secondValue || '').trim())

    if (Number.isFinite(firstTimestamp) && Number.isFinite(secondTimestamp)) {
      return Math.abs(firstTimestamp - secondTimestamp) <= 2000
    }

    return String(firstValue || '').trim() === String(secondValue || '').trim()
  }

  const areActorsEquivalent = (firstEntry, secondEntry) => {
    const firstActorId = normalizeId(firstEntry?.actor?.id)
    const secondActorId = normalizeId(secondEntry?.actor?.id)
    if (!firstActorId || !secondActorId) return true
    return firstActorId === secondActorId
  }

  const areDescriptionsEquivalent = (firstEntry, secondEntry) => {
    const firstDescription = normalizeComparableText(firstEntry?.description)
    const secondDescription = normalizeComparableText(secondEntry?.description)
    if (!firstDescription || !secondDescription) return true
    return firstDescription === secondDescription
  }

  const areEquivalentEntries = (firstEntry, secondEntry) => {
    const sameStage = normalizeTransferHistoryStage(firstEntry?.stage) === normalizeTransferHistoryStage(secondEntry?.stage)
    if (!sameStage) return false
    if (!areTimestampsEquivalent(firstEntry?.at, secondEntry?.at)) return false
    if (!areActorsEquivalent(firstEntry, secondEntry)) return false
    if (!areDescriptionsEquivalent(firstEntry, secondEntry)) return false
    return true
  }

  const pickPreferredEntry = (currentEntry, candidateEntry) => {
    const currentDescription = String(currentEntry?.description || '').trim()
    const candidateDescription = String(candidateEntry?.description || '').trim()
    const currentLabel = String(currentEntry?.label || '').trim()
    const candidateLabel = String(candidateEntry?.label || '').trim()
    const candidateActorId = normalizeId(candidateEntry?.actor?.id)

    return {
      ...(currentEntry || {}),
      ...(candidateEntry || {}),
      description: candidateDescription || currentDescription,
      label: candidateLabel || currentLabel,
      actor: candidateActorId ? candidateEntry?.actor : currentEntry?.actor,
      at: String(candidateEntry?.at || '').trim() || String(currentEntry?.at || '').trim(),
    }
  }

  ;(Array.isArray(entries) ? entries : []).forEach((entry) => {
    const duplicateIndex = collapsed.findIndex((existingEntry) =>
      areEquivalentEntries(existingEntry, entry)
    )

    if (duplicateIndex >= 0) {
      collapsed[duplicateIndex] = pickPreferredEntry(collapsed[duplicateIndex], entry)
      return
    }

    collapsed.push(entry)
  })

  return [...collapsed].sort((a, b) =>
    String(a?.at || '').localeCompare(String(b?.at || ''))
  )
}

const mergeTransferHistoryEntries = (...sources) => {
  const bySignature = new Map()
  sources.forEach((source) => {
    ;(Array.isArray(source) ? source : []).forEach((entry) => {
      const normalized = sanitizeTransferHistoryEntry(entry)
      if (!normalized?.stage) return
      const actorId = normalizeId(normalized?.actor?.id)
      const description = normalizeComparableText(normalized?.description)
      const signature = [normalized.stage, String(normalized.at || '').trim(), actorId, description].join('|')
      bySignature.set(signature, normalized)
    })
  })
  return collapseDuplicateTransferHistoryEntries(
    Array.from(bySignature.values()).sort((a, b) =>
      String(a?.at || '').localeCompare(String(b?.at || ''))
    )
  )
}

export const buildTransferHistoryEntry = ({
  stage,
  description = '',
  at = '',
  actor = null,
  label = '',
}) => {
  return sanitizeTransferHistoryEntry({
    stage,
    description,
    at,
    actor,
    label,
  })
}

export const upsertTransferReminder = (reminders, transferReminder) => {
  const incoming = sanitizeReminder(transferReminder)
  if (!incoming) return Array.isArray(reminders) ? reminders : []

  const contextType = normalizeText(incoming?.context?.type).replace(/[\s-]+/g, '_')
  const contextId = normalizeId(incoming?.context?.id)
  if (contextType !== 'solicitud_traslado' || !contextId) {
    return [incoming, ...(Array.isArray(reminders) ? reminders : [])]
  }

  const source = Array.isArray(reminders) ? reminders : []
  const matching = source.filter((reminder) =>
    normalizeText(reminder?.context?.type).replace(/[\s-]+/g, '_') === 'solicitud_traslado' &&
    normalizeId(reminder?.context?.id) === contextId
  )

  const oldestMatch = [...matching].sort((a, b) =>
    String(a?.createdAt || '').localeCompare(String(b?.createdAt || ''))
  )[0] || null

  const merged = sanitizeReminder({
    ...(oldestMatch || incoming),
    ...incoming,
    id: normalizeId(oldestMatch?.id) || normalizeId(incoming?.id) || createReminderId(),
    creator: incoming?.creator || oldestMatch?.creator,
    recipients: [
      ...(Array.isArray(oldestMatch?.recipients) ? oldestMatch.recipients : []),
      ...(Array.isArray(incoming?.recipients) ? incoming.recipients : []),
      ...matching.flatMap((reminder) => (Array.isArray(reminder?.recipients) ? reminder.recipients : [])),
    ],
    completedBy: [
      ...(Array.isArray(oldestMatch?.completedBy) ? oldestMatch.completedBy : []),
      ...(Array.isArray(incoming?.completedBy) ? incoming.completedBy : []),
      ...matching.flatMap((reminder) => (Array.isArray(reminder?.completedBy) ? reminder.completedBy : [])),
    ],
    decision: {
      ...(oldestMatch?.decision || {}),
      ...(incoming?.decision || {}),
      assignedRecipients: [
        ...(Array.isArray(oldestMatch?.decision?.assignedRecipients) ? oldestMatch.decision.assignedRecipients : []),
        ...(Array.isArray(incoming?.decision?.assignedRecipients) ? incoming.decision.assignedRecipients : []),
      ],
    },
    transferHistory: mergeTransferHistoryEntries(
      ...matching.map((reminder) => getTransferReminderHistory(reminder)),
      getTransferReminderHistory(oldestMatch),
      getTransferReminderHistory(incoming),
      incoming?.transferHistory
    ),
    createdAt: String(oldestMatch?.createdAt || incoming?.createdAt || new Date().toISOString()).trim(),
  })

  const previousStage = normalizeTransferHistoryStage(getLatestTransferHistoryEntry(oldestMatch)?.stage)
  const nextStage = normalizeTransferHistoryStage(getLatestTransferHistoryEntry(merged)?.stage)
  if (nextStage && nextStage !== previousStage) {
    merged.completedBy = Array.isArray(incoming?.completedBy) ? incoming.completedBy : []
  }

  const remainder = source.filter((reminder) =>
    !(
      normalizeText(reminder?.context?.type).replace(/[\s-]+/g, '_') === 'solicitud_traslado' &&
      normalizeId(reminder?.context?.id) === contextId
    )
  )

  return [merged, ...remainder]
}

export const isSpecialReminderResolved = (reminder) => {
  if (!isSpecialTransferDecisionReminder(reminder)) return false
  const status = getReminderDecisionStatus(reminder)
  return status === 'aceptada' || status === 'rechazada' || status === 'cancelado'
}

export const isReminderPendingForCurrentUser = (reminder, userIdSet) => {
  if (!isReminderForCurrentUser(reminder, userIdSet)) return false
  if (isReminderSeenByCurrentUser(reminder, userIdSet)) return false

  // Inspections only appear once their scheduled time has arrived
  if (isRandomInspectionReminder(reminder)) {
    const timestamp = getReminderTimestamp(reminder)
    if (!Number.isFinite(timestamp)) return true
    return timestamp <= Date.now()
  }

  const decisionStatus = getReminderDecisionStatus(reminder)
  const isTransferContext =
    normalizeText(reminder?.context?.type).replace(/[\s-]+/g, '_') === 'solicitud_traslado'

  if (isTransferContext && decisionStatus === 'cancelado') return false

  const isTransferResponseReminder =
    isTransferContext &&
    !isSpecialTransferDecisionReminder(reminder) &&
    (decisionStatus === 'aceptada' || decisionStatus === 'rechazada' || decisionStatus === 'enviado')
  if (isTransferResponseReminder) return true

  if (isSpecialReminderResolved(reminder)) return false
  if (isSpecialTransferDecisionReminder(reminder)) return true

  // All other unseen reminders stay pending indefinitely — no expiry
  return true
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
  const isTransferIssue = isTransferIssueReminder(reminder)
  const isRandomInspectionDaily = isRandomInspectionDailyReminder(reminder)
  const isRandomInspectionVerify = isRandomInspectionVerifyReminder(reminder)
  const isRandomInspectionAdminSummary = isRandomInspectionAdminSummaryReminder(reminder)
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

  if (isTransferIssue) {
    if (seenByCurrentUser) {
      return {
        label: 'Cumplido',
        className: 'arrived',
        canMarkSeen: false,
      }
    }
    return {
      label: 'Pendiente',
      className: 'rejected',
      canMarkSeen: false,
    }
  }

  if (transferReceiptOutcome === 'completo') {
    return {
      label: 'Llego',
      className: 'arrived',
      canMarkSeen: false,
    }
  }

  if (transferReceiptOutcome === 'incompleto') {
    return {
      label: 'Entregada con novedades',
      className: 'issue',
      canMarkSeen: false,
    }
  }

  if ((isSpecialReminder || isTransferContext) && decisionStatus === 'cancelado') {
    return {
      label: 'Cancelado',
      className: 'cancelled',
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

  if (isRandomInspectionAdminSummary) {
    if (seenByCurrentUser) {
      return {
        label: 'Completado',
        className: 'seen',
        canMarkSeen: false,
      }
    }
    return {
      label: 'Pendiente',
      className: 'pending',
      canMarkSeen: false,
    }
  }

  if (seenByCurrentUser) {
    return {
      label: 'Visto',
      className: 'seen',
      canMarkSeen: false,
    }
  }

  const canResolveTransferDecision = isSpecialReminder && isTransferDecisionAllowedForUser(reminder, userIdSet)
  return {
    label: isSpecialReminder
      ? (canResolveTransferDecision ? 'Por decidir' : 'Pendiente')
      : 'Pendiente',
    className: 'pending',
    canMarkSeen: !isSpecialReminder,
  }
}
