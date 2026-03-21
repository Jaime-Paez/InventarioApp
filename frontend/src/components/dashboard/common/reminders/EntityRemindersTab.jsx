import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Minus, Plus } from 'lucide-react'
import { API_URL, authFetch } from '../../../../utils/api'
import {
  REMINDERS_STORAGE_KEY,
  REMINDERS_SYNC_EVENT,
  buildReminderStatusForUser,
  buildUserIdSet,
  createReminderId,
  emitRemindersSync,
  extractUserId,
  fetchRemindersFromBackend,
  formatCurrentUserName,
  formatReminderDateTime,
  getReminderDecisionStatus,
  getReminderTimestamp,
  getTransferReceiptOutcome,
  isReminderCreatedByCurrentUser,
  isReminderForContext,
  isReminderForCurrentUser,
  isSpecialTransferDecisionReminder,
  normalizeId,
  readRemindersFromStorage,
  reminderCompletedByIds,
  writeRemindersToStorage,
} from './remindersStorage'
import './EntityRemindersTab.css'

const normalizeReminderContextType = (value) =>
  normalizeId(value)
    .toLowerCase()
    .replace(/[\s-]+/g, '_')

const resolveReminderSortTimestamp = (reminder) => {
  const timestamp = getReminderTimestamp(reminder)
  if (Number.isFinite(timestamp)) return timestamp

  const createdAt = Date.parse(String(reminder?.createdAt || '').trim())
  if (Number.isFinite(createdAt)) return createdAt
  return 0
}

const sortRemindersNewestFirst = (rows) =>
  [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const timeA = resolveReminderSortTimestamp(a)
    const timeB = resolveReminderSortTimestamp(b)
    if (timeA !== timeB) return timeB - timeA
    return String(b?.id || '').localeCompare(String(a?.id || ''))
  })

const resolveTransferStageFromReminder = (reminder) => {
  const transferReceiptOutcome = getTransferReceiptOutcome(reminder)
  if (transferReceiptOutcome === 'completo') {
    return {
      key: 'recepcion_completa',
      label: 'Llego completo',
      className: 'recepcion-completa',
    }
  }

  if (transferReceiptOutcome === 'incompleto') {
    return {
      key: 'recepcion_incompleta',
      label: 'Llego incompleto',
      className: 'recepcion-incompleta',
    }
  }

  if (isSpecialTransferDecisionReminder(reminder)) {
    return {
      key: 'solicitud',
      label: 'Solicitud',
      className: 'solicitud',
    }
  }

  const decisionStatus = getReminderDecisionStatus(reminder)
  if (decisionStatus === 'enviado') {
    return {
      key: 'envio',
      label: 'Enviado',
      className: 'envio',
    }
  }
  if (decisionStatus === 'aceptada') {
    return {
      key: 'aceptacion',
      label: 'Aceptada',
      className: 'aceptacion',
    }
  }
  if (decisionStatus === 'rechazada') {
    return {
      key: 'rechazo',
      label: 'Rechazada',
      className: 'rechazo',
    }
  }

  if (decisionStatus === 'pendiente') {
    return {
      key: 'solicitud',
      label: 'Solicitud',
      className: 'solicitud',
    }
  }

  return null
}

const getNowDateParts = () => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  }
}

const formatIsoDateTime = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return '-'

  const timestamp = Date.parse(raw)
  if (!Number.isFinite(timestamp)) return raw

  return new Intl.DateTimeFormat('es-EC', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

const formatDecisionStatusLabel = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'aceptada') return 'Aceptada'
  if (normalized === 'rechazada') return 'Rechazada'
  if (normalized === 'enviado') return 'Enviado'
  return 'Pendiente'
}

const formatReminderContextTypeLabel = (value) => {
  const normalized = normalizeReminderContextType(value)
  const knownLabels = {
    producto: 'Producto',
    inventario: 'Inventario',
    entrada: 'Entrada',
    salida: 'Salida',
    solicitud: 'Solicitud',
    cliente: 'Cliente',
    solicitud_traslado: 'Solicitud de traslado',
  }
  if (knownLabels[normalized]) return knownLabels[normalized]
  if (!normalized) return 'Registro'
  return normalized
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

const buildReminderContextLabel = (reminder, fallbackEntityLabel = '') => {
  const normalizedFallback = String(fallbackEntityLabel || '').trim()
  const normalizedContextType = normalizeReminderContextType(reminder?.context?.type)
  if (
    normalizedFallback &&
    (normalizedContextType === 'producto' || normalizedContextType === 'inventario')
  ) {
    return normalizedFallback
  }

  const explicitLabel = String(reminder?.context?.label || '').trim()
  if (explicitLabel) return explicitLabel

  const contextType = normalizeId(reminder?.context?.type)
  const contextId = normalizeId(reminder?.context?.id)
  if (!contextType || !contextId) return '-'
  return `${contextType} #${contextId}`
}

function EntityRemindersTab({
  token,
  currentUser,
  entityType,
  entityId,
  entityLabel,
  canCreateReminder = true,
  isOpen = true,
  transferSolicitudId = '',
  onError,
}) {
  const [allReminders, setAllReminders] = useState(() => readRemindersFromStorage())
  const [users, setUsers] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [usersError, setUsersError] = useState('')
  const [activeView, setActiveView] = useState('list')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [description, setDescription] = useState('')
  const [selectedRecipientIds, setSelectedRecipientIds] = useState([])
  const [submitError, setSubmitError] = useState('')
  const [activeReminderDetailId, setActiveReminderDetailId] = useState('')
  const missingContextToastRef = useRef(false)

  const notifyError = useCallback(
    (message) => {
      if (!message) return
      onError?.(message)
    },
    [onError]
  )

  const currentUserName = useMemo(() => formatCurrentUserName(currentUser), [currentUser])
  const currentUserIdValues = useMemo(
    () => Array.from(buildUserIdSet(currentUser)).map(normalizeId).filter(Boolean),
    [currentUser]
  )

  const currentUserIdSet = useMemo(() => new Set(currentUserIdValues), [currentUserIdValues])
  const currentPrimaryUserId = currentUserIdValues[0] || ''
  const creatorRecipientId = currentPrimaryUserId || extractUserId(currentUser)
  const creatorRecipientName = currentUserName || formatCurrentUserName(currentUser)

  const normalizedTransferSolicitudId = useMemo(
    () => normalizeId(transferSolicitudId),
    [transferSolicitudId]
  )

  const reminderContext = useMemo(() => {
    const type = normalizeId(entityType)
    const id = normalizeId(entityId)
    if (type && id) {
      return {
        type,
        id,
        label: String(entityLabel || '').trim(),
      }
    }

    if (normalizedTransferSolicitudId) {
      return {
        type: 'solicitud_traslado',
        id: normalizedTransferSolicitudId,
        label: String(entityLabel || '').trim() || 'Solicitud de traslado',
      }
    }

    return null
  }, [entityType, entityId, entityLabel, normalizedTransferSolicitudId])
  const contextName = String(entityLabel || '').trim()

  useEffect(() => {
    if (!usersError) return
    notifyError(usersError)
  }, [notifyError, usersError])

  useEffect(() => {
    if (!submitError) return
    notifyError(submitError)
  }, [notifyError, submitError])

  useEffect(() => {
    if (!isOpen) return
    if (reminderContext) {
      missingContextToastRef.current = false
      return
    }
    if (missingContextToastRef.current) return
    missingContextToastRef.current = true
    notifyError('No se pudo resolver el registro para recordatorios.')
  }, [isOpen, notifyError, reminderContext])

  const selectableUsers = useMemo(
    () => users.filter((userItem) => userItem.id !== creatorRecipientId),
    [users, creatorRecipientId]
  )

  const relatedReminders = useMemo(() => {
    if (!reminderContext) return []

    const filtered = allReminders.filter(
      (reminder) =>
        isReminderForContext(reminder, reminderContext) &&
        (isReminderForCurrentUser(reminder, currentUserIdSet) ||
          isReminderCreatedByCurrentUser(reminder, currentUserIdSet, currentUserName))
    )

    return sortRemindersNewestFirst(filtered)
  }, [allReminders, currentUserIdSet, currentUserName, reminderContext])

  const transferTimelineRows = useMemo(() => {
    if (!normalizedTransferSolicitudId) return []

    const rows = allReminders
      .filter((reminder) => {
        const contextType = normalizeReminderContextType(reminder?.context?.type)
        if (contextType !== 'solicitud_traslado') return false
        if (normalizeId(reminder?.context?.id) !== normalizedTransferSolicitudId) return false

        return (
          isReminderForCurrentUser(reminder, currentUserIdSet) ||
          isReminderCreatedByCurrentUser(reminder, currentUserIdSet, currentUserName)
        )
      })
      .map((reminder, index) => {
        const stage = resolveTransferStageFromReminder(reminder)
        if (!stage) return null

        return {
          id:
            normalizeId(reminder?.id) ||
            `${stage.key}-${String(reminder?.date || '').trim()}-${String(reminder?.time || '').trim()}-${index}`,
          stageKey: stage.key,
          stageLabel: stage.label,
          stageClassName: stage.className,
          dateTime: formatReminderDateTime(reminder),
          description: String(reminder?.description || '').trim() || '-',
          sortTimestamp: resolveReminderSortTimestamp(reminder),
        }
      })
      .filter(Boolean)
      .sort((a, b) => {
        const timeA = Number(a?.sortTimestamp || 0)
        const timeB = Number(b?.sortTimestamp || 0)
        if (timeA !== timeB) return timeB - timeA
        return String(b?.id || '').localeCompare(String(a?.id || ''))
      })

    const uniqueByStage = new Set()
    const dedupedRows = []
    rows.forEach((row) => {
      const stageKey = String(row?.stageKey || '').trim()
      if (!stageKey || uniqueByStage.has(stageKey)) return
      uniqueByStage.add(stageKey)
      dedupedRows.push(row)
    })

    return dedupedRows
  }, [allReminders, currentUserIdSet, currentUserName, normalizedTransferSolicitudId])

  const activeReminderDetail = useMemo(() => {
    const targetId = normalizeId(activeReminderDetailId)
    if (!targetId) return null
    return (
      relatedReminders.find((reminder) => normalizeId(reminder?.id) === targetId) || null
    )
  }, [activeReminderDetailId, relatedReminders])

  const activeReminderDetailStatus = useMemo(() => {
    if (!activeReminderDetail) return null
    return buildReminderStatusForUser(activeReminderDetail, currentUserIdSet)
  }, [activeReminderDetail, currentUserIdSet])

  const activeReminderDecisionStatus = useMemo(() => {
    if (!activeReminderDetail) return ''
    return getReminderDecisionStatus(activeReminderDetail)
  }, [activeReminderDetail])

  const activeReminderRecipientsLabel = useMemo(() => {
    if (!activeReminderDetail) return ''
    return (Array.isArray(activeReminderDetail?.recipients) ? activeReminderDetail.recipients : [])
      .map((recipient) => String(recipient?.name || '').trim())
      .filter(Boolean)
      .join(', ')
  }, [activeReminderDetail])

  const activeReminderContextLabel = useMemo(() => {
    if (!activeReminderDetail) return '-'
    return buildReminderContextLabel(activeReminderDetail, contextName)
  }, [activeReminderDetail, contextName])

  const activeReminderContextTypeLabel = useMemo(() => {
    if (!activeReminderDetail) return 'Registro'
    return formatReminderContextTypeLabel(activeReminderDetail?.context?.type)
  }, [activeReminderDetail])

  const showDetailDecision = useMemo(() => {
    if (!activeReminderDetail) return false
    const contextType = normalizeReminderContextType(activeReminderDetail?.context?.type)
    return isSpecialTransferDecisionReminder(activeReminderDetail) || contextType === 'solicitud_traslado'
  }, [activeReminderDetail])

  useEffect(() => {
    const defaults = getNowDateParts()
    setDate(defaults.date)
    setTime(defaults.time)
    setDescription('')
    setSelectedRecipientIds([])
    setSubmitError('')
    setActiveReminderDetailId('')
    setActiveView('list')
  }, [entityType, entityId])

  useEffect(() => {
    if (canCreateReminder || activeView !== 'create') return
    setSubmitError('')
    setActiveView('list')
  }, [canCreateReminder, activeView])

  useEffect(() => {
    const targetId = normalizeId(activeReminderDetailId)
    if (!targetId) return
    const exists = relatedReminders.some((reminder) => normalizeId(reminder?.id) === targetId)
    if (!exists) {
      setActiveReminderDetailId('')
    }
  }, [activeReminderDetailId, relatedReminders])

  useEffect(() => {
    if (!activeReminderDetailId || typeof window === 'undefined') return undefined
    const handleEscape = (event) => {
      if (event.key !== 'Escape') return
      setActiveReminderDetailId('')
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [activeReminderDetailId])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const syncFromStorage = (event) => {
      if (event?.type === 'storage' && event.key && event.key !== REMINDERS_STORAGE_KEY) return
      setAllReminders(readRemindersFromStorage())
    }

    window.addEventListener('storage', syncFromStorage)
    window.addEventListener(REMINDERS_SYNC_EVENT, syncFromStorage)

    return () => {
      window.removeEventListener('storage', syncFromStorage)
      window.removeEventListener(REMINDERS_SYNC_EVENT, syncFromStorage)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const hydrateReminders = async () => {
      if (!token) {
        setAllReminders([])
        return
      }

      const remote = await fetchRemindersFromBackend(token)
      if (cancelled) return
      setAllReminders(remote)
    }

    hydrateReminders()
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    let cancelled = false

    const ensureCurrentUserInList = (list) => {
      const currentUserId = currentPrimaryUserId || extractUserId(currentUser)
      if (!currentUserId) return list
      if (list.some((userItem) => userItem.id === currentUserId)) return list

      return [
        {
          id: currentUserId,
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
  }, [token, currentPrimaryUserId, currentUser, currentUserName])

  const applyReminderUpdate = (updater) => {
    setAllReminders((prev) => {
      const source = Array.isArray(prev) ? prev : []
      const next = typeof updater === 'function' ? updater(source) : updater
      const normalized = writeRemindersToStorage(next)
      emitRemindersSync()
      return normalized
    })
  }

  const toggleRecipient = (recipientId) => {
    const normalizedId = normalizeId(recipientId)
    if (!normalizedId) return

    setSelectedRecipientIds((prev) =>
      prev.includes(normalizedId)
        ? prev.filter((id) => id !== normalizedId)
        : [...prev, normalizedId]
    )
  }

  const handleCreateReminder = (event) => {
    event.preventDefault()
    setSubmitError('')

    if (!canCreateReminder) {
      setSubmitError('No tienes permisos para crear recordatorios en este registro.')
      return
    }

    if (!reminderContext) {
      setSubmitError('No se pudo resolver el registro actual.')
      return
    }

    if (!date || !time) {
      setSubmitError('Debes completar fecha y hora.')
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

    const reminder = {
      id: createReminderId(),
      date,
      time,
      description: normalizedDescription,
      creator: {
        id: creatorRecipientId,
        name: creatorRecipientName,
      },
      recipients,
      context: reminderContext,
      createdAt: new Date().toISOString(),
      completedBy: [],
    }

    applyReminderUpdate((prev) => [reminder, ...prev])

    const defaults = getNowDateParts()
    setDate(defaults.date)
    setTime(defaults.time)
    setDescription('')
    setSelectedRecipientIds([])
    setSubmitError('')
    setActiveView('list')
  }

  const handleMarkReminderSeen = (reminderId) => {
    const normalizedReminderId = normalizeId(reminderId)
    if (!normalizedReminderId || !currentUserIdValues.length) return

    applyReminderUpdate((prev) =>
      prev.map((reminder) => {
        if (normalizeId(reminder?.id) !== normalizedReminderId) return reminder
        const completedBySet = new Set(reminderCompletedByIds(reminder))
        currentUserIdValues.forEach((id) => completedBySet.add(id))

        return {
          ...reminder,
          completedBy: Array.from(completedBySet),
        }
      })
    )
  }

  const openReminderDetail = (reminderId) => {
    const normalized = normalizeId(reminderId)
    if (!normalized) return
    setActiveReminderDetailId(normalized)
  }

  const closeReminderDetail = () => {
    setActiveReminderDetailId('')
  }

  return (
    <section className="create-user__section entity-reminders">
      <div className="entity-reminders__head">
        <div>
          <p className="create-user__eyebrow">Recordatorios</p>
          <h4>{contextName ? `Recordatorios de ${contextName}` : 'Recordatorios'}</h4>
        </div>
        <button
          type="button"
          className="create-user__action create-user__action--primary entity-reminders__toggle"
          onClick={() => {
            if (!canCreateReminder) return
            setSubmitError('')
            setActiveView((prev) => (prev === 'create' ? 'list' : 'create'))
          }}
          disabled={!reminderContext || !canCreateReminder}
          title={!canCreateReminder ? 'No tienes permiso para crear recordatorios.' : undefined}
        >
          {activeView === 'create' && canCreateReminder ? <Minus size={14} /> : <Plus size={14} />}
          {activeView === 'create' && canCreateReminder ? 'Ocultar formulario' : 'Anadir recordatorio'}
        </button>
      </div>

      {activeView === 'create' ? (
        <div className="entity-reminders__pane entity-reminders__pane--form">
          <form className="entity-reminders__form" noValidate onSubmit={handleCreateReminder}>
            <div className="entity-reminders__form-top">
              <div className="entity-reminders__datetime-stack">
                <label className="create-user__field">
                  <span>Fecha</span>
                  <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
                </label>

                <label className="create-user__field">
                  <span>Hora</span>
                  <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
                </label>
              </div>

              <label className="create-user__field entity-reminders__description-field">
                <span>Descripcion</span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Escribe de que trata este recordatorio"
                  required
                />
              </label>
            </div>

            <section className="entity-reminders__recipients">
              <div className="entity-reminders__recipients-head">
                <h5>Dirigido a</h5>
                {loadingUsers && (
                  <span className="entity-reminders__loading">
                    <Loader2 size={13} />
                    Cargando usuarios...
                  </span>
                )}
              </div>

              <p className="entity-reminders__helper">El creador siempre esta incluido.</p>
              <div className="entity-reminders__recipient-list">
                {!selectableUsers.length && !loadingUsers && (
                  <p className="entity-reminders__empty">No hay mas usuarios disponibles.</p>
                )}

                {selectableUsers.map((userItem) => {
                  const checked = selectedRecipientIds.includes(userItem.id)
                  return (
                    <label key={userItem.id} className="entity-reminders__recipient-item">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleRecipient(userItem.id)}
                      />
                      <div>
                        <strong>{userItem.name}</strong>
                        {userItem.email && <small>{userItem.email}</small>}
                      </div>
                    </label>
                  )
                })}
              </div>
            </section>

            <div className="entity-reminders__actions">
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={() => {
                  setSubmitError('')
                  setActiveView('list')
                }}
              >
                Cancelar
              </button>
              <button type="submit" className="create-user__action create-user__action--primary">
                Guardar recordatorio
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="entity-reminders__pane entity-reminders__pane--list entity-reminders__table-wrap">
          {normalizedTransferSolicitudId && (
            <div className="entity-reminders__transfer-history">
              <div className="entity-reminders__transfer-head">
                <h5>Historial del traslado</h5>
                <span>{transferTimelineRows.length} evento(s)</span>
              </div>

              {!transferTimelineRows.length ? (
                <p className="entity-reminders__empty">
                  Este traslado todavia no tiene hitos registrados.
                </p>
              ) : (
                <ol className="entity-reminders__transfer-list">
                  {transferTimelineRows.map((row) => (
                    <li key={row.id} className="entity-reminders__transfer-item">
                      <div className="entity-reminders__transfer-meta">
                        <span
                          className={`entity-reminders__transfer-stage entity-reminders__transfer-stage--${row.stageClassName}`}
                        >
                          {row.stageLabel}
                        </span>
                        <span>{row.dateTime}</span>
                      </div>
                      <p className="entity-reminders__transfer-description">{row.description}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {!relatedReminders.length ? (
            <p className="entity-reminders__empty">No hay recordatorios para este registro.</p>
          ) : (
            <table className="entity-reminders__table">
              <thead>
                <tr>
                  <th>Fecha y hora</th>
                  <th>Descripcion</th>
                  <th>Creador</th>
                  <th>Dirigido a</th>
                  <th>Estado</th>
                  <th>Accion</th>
                </tr>
              </thead>
              <tbody>
                {relatedReminders.map((reminder) => {
                  const status = buildReminderStatusForUser(reminder, currentUserIdSet)
                  const recipients = Array.isArray(reminder?.recipients) ? reminder.recipients : []
                  const recipientNames = recipients
                    .map((recipient) => String(recipient?.name || '').trim())
                    .filter(Boolean)
                    .join(', ')

                  return (
                    <tr
                      key={reminder.id}
                      className="entity-reminders__row"
                      role="button"
                      tabIndex={0}
                      onClick={() => openReminderDetail(reminder.id)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        openReminderDetail(reminder.id)
                      }}
                    >
                      <td title={formatReminderDateTime(reminder)}>
                        <span className="entity-reminders__cell-text">
                          {formatReminderDateTime(reminder)}
                        </span>
                      </td>
                      <td title={reminder?.description || '-'}>
                        <span className="entity-reminders__cell-text">
                          {reminder?.description || '-'}
                        </span>
                      </td>
                      <td title={reminder?.creator?.name || 'Usuario'}>
                        <span className="entity-reminders__cell-text">
                          {reminder?.creator?.name || 'Usuario'}
                        </span>
                      </td>
                      <td title={recipientNames || 'Sin destinatarios'}>
                        <span className="entity-reminders__cell-text">
                          {recipientNames || 'Sin destinatarios'}
                        </span>
                      </td>
                      <td>
                        <span className={`entity-reminders__status entity-reminders__status--${status.className}`}>
                          {status.label}
                        </span>
                      </td>
                      <td>
                        {status.canMarkSeen ? (
                          <button
                            type="button"
                            className="entity-reminders__mark-seen"
                            onClick={(event) => {
                              event.stopPropagation()
                              handleMarkReminderSeen(reminder.id)
                            }}
                          >
                            Marcar como visto
                          </button>
                        ) : (
                          <span className="entity-reminders__na">No aplica</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeReminderDetail && activeReminderDetailStatus && (
        <div
          className="entity-reminders__detail-overlay"
          role="presentation"
          onMouseDown={closeReminderDetail}
        >
          <article
            className="entity-reminders__detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Detalle del recordatorio"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="entity-reminders__detail-head">
              <div className="entity-reminders__detail-head-main">
                <h5>{`Recordatorio para ${activeReminderContextTypeLabel}`}</h5>
                <p className="entity-reminders__detail-context-ref">{activeReminderContextLabel}</p>
              </div>
              <button
                type="button"
                className="entity-reminders__detail-close"
                onClick={closeReminderDetail}
              >
                Cerrar
              </button>
            </header>

            <div className="entity-reminders__detail-body">
              <div className="entity-reminders__detail-top">
                <div className="entity-reminders__detail-item">
                  <span className="entity-reminders__detail-label">Fecha y hora</span>
                  <strong>{formatReminderDateTime(activeReminderDetail)}</strong>
                </div>

                <div className="entity-reminders__detail-item">
                  <span className="entity-reminders__detail-label">Estado</span>
                  <span
                    className={`entity-reminders__status entity-reminders__status--${activeReminderDetailStatus.className}`}
                  >
                    {activeReminderDetailStatus.label}
                  </span>
                </div>
              </div>

              <section className="entity-reminders__detail-section entity-reminders__detail-section--description">
                <h6>Descripcion</h6>
                <p className="entity-reminders__detail-description">
                  {String(activeReminderDetail?.description || '').trim() || '-'}
                </p>
              </section>

              <div className="entity-reminders__detail-bottom">
                <div className="entity-reminders__detail-item">
                  <span className="entity-reminders__detail-label">Creador</span>
                  <strong>{activeReminderDetail?.creator?.name || 'Usuario'}</strong>
                  <small className="entity-reminders__detail-meta">
                    Creado: {formatIsoDateTime(activeReminderDetail?.createdAt)}
                  </small>
                </div>

                <div className="entity-reminders__detail-item">
                  <span className="entity-reminders__detail-label">Dirigido a</span>
                  <strong title={activeReminderRecipientsLabel || '-'}>
                    {activeReminderRecipientsLabel || '-'}
                  </strong>
                </div>
              </div>

              {showDetailDecision && (
                <div className="entity-reminders__detail-bottom">
                  <div className="entity-reminders__detail-item">
                    <span className="entity-reminders__detail-label">Resolucion</span>
                    <strong>{formatDecisionStatusLabel(activeReminderDecisionStatus)}</strong>
                  </div>
                </div>
              )}

              {showDetailDecision && String(activeReminderDetail?.decision?.reason || '').trim() && (
                <section className="entity-reminders__detail-section">
                  <h6>Motivo</h6>
                  <p className="entity-reminders__detail-description">
                    {String(activeReminderDetail?.decision?.reason || '').trim()}
                  </p>
                </section>
              )}

            </div>

            {activeReminderDetailStatus.canMarkSeen && (
              <footer className="entity-reminders__detail-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={() => handleMarkReminderSeen(activeReminderDetail.id)}
                >
                  Marcar como visto
                </button>
              </footer>
            )}
          </article>
        </div>
      )}
    </section>
  )
}

export default EntityRemindersTab

