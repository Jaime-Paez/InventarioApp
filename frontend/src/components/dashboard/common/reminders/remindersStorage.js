export const REMINDERS_STORAGE_KEY = 'inventario-recordatorios-v1'
export const REMINDERS_SYNC_EVENT = 'inventario-reminders-sync'

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
    createdAt: String(reminder?.createdAt || reminder?.creado_en || new Date().toISOString()),
    completedBy: reminderCompletedByIds(reminder),
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
  const normalized = (Array.isArray(reminders) ? reminders : []).map(sanitizeReminder).filter(Boolean)
  if (typeof window === 'undefined') return normalized

  try {
    window.localStorage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // Ignore storage errors (quota/private mode).
  }

  return normalized
}

export const emitRemindersSync = () => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(REMINDERS_SYNC_EVENT))
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

export const isReminderPendingForCurrentUser = (reminder, userIdSet) => {
  if (!isReminderForCurrentUser(reminder, userIdSet)) return false
  if (isReminderSeenByCurrentUser(reminder, userIdSet)) return false

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

    if (Number.isFinite(timeA) && Number.isFinite(timeB)) return timeA - timeB
    if (Number.isFinite(timeA)) return -1
    if (Number.isFinite(timeB)) return 1

    return String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''))
  })
}

export const buildReminderStatusForUser = (reminder, userIdSet) => {
  const recipientIds = reminderRecipientIds(reminder)
  const isForCurrentUser = recipientIds.some((id) => userIdSet.has(id))
  const seenByCurrentUser = reminderCompletedByIds(reminder).some((id) => userIdSet.has(id))

  if (!isForCurrentUser) {
    return {
      label: 'Informativo',
      className: 'info',
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

  const timestamp = getReminderTimestamp(reminder)
  if (Number.isFinite(timestamp) && timestamp < Date.now()) {
    return {
      label: 'Vencido',
      className: 'expired',
      canMarkSeen: true,
    }
  }

  return {
    label: 'Pendiente',
    className: 'pending',
    canMarkSeen: true,
  }
}
