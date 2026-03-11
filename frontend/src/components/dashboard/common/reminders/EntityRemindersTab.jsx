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

function EntityRemindersTab({
  token,
  currentUser,
  entityType,
  entityId,
  entityLabel,
  canCreateReminder = true,
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

  const reminderContext = useMemo(() => {
    const type = normalizeId(entityType)
    const id = normalizeId(entityId)
    if (!type || !id) return null

    return {
      type,
      id,
      label: String(entityLabel || '').trim(),
    }
  }, [entityType, entityId, entityLabel])

  const normalizedTransferSolicitudId = useMemo(
    () => normalizeId(transferSolicitudId),
    [transferSolicitudId]
  )

  useEffect(() => {
    if (!usersError) return
    notifyError(usersError)
  }, [notifyError, usersError])

  useEffect(() => {
    if (!submitError) return
    notifyError(submitError)
  }, [notifyError, submitError])

  useEffect(() => {
    if (reminderContext) {
      missingContextToastRef.current = false
      return
    }
    if (missingContextToastRef.current) return
    missingContextToastRef.current = true
    notifyError('No se pudo resolver el registro para recordatorios.')
  }, [notifyError, reminderContext])

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

  useEffect(() => {
    const defaults = getNowDateParts()
    setDate(defaults.date)
    setTime(defaults.time)
    setDescription('')
    setSelectedRecipientIds([])
    setSubmitError('')
    setActiveView('list')
  }, [entityType, entityId])

  useEffect(() => {
    if (canCreateReminder || activeView !== 'create') return
    setSubmitError('')
    setActiveView('list')
  }, [canCreateReminder, activeView])

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

  const contextName = String(entityLabel || '').trim()

  return (
    <section className="create-user__section entity-reminders">
      <div className="entity-reminders__head">
        <div>
          <p className="create-user__eyebrow">Recordatorios</p>
          <h4>{contextName ? `Recordatorios de ${contextName}` : 'Recordatorios'}</h4>
        </div>
        {canCreateReminder ? (
          <button
            type="button"
            className="create-user__action create-user__action--primary entity-reminders__toggle"
            onClick={() => {
              setSubmitError('')
              setActiveView((prev) => (prev === 'create' ? 'list' : 'create'))
            }}
            disabled={!reminderContext}
          >
            {activeView === 'create' ? <Minus size={14} /> : <Plus size={14} />}
            {activeView === 'create' ? 'Ocultar formulario' : 'Anadir recordatorio'}
          </button>
        ) : (
          <span className="entity-reminders__na">
            Solo lectura
          </span>
        )}
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
                    <tr key={reminder.id}>
                      <td>{formatReminderDateTime(reminder)}</td>
                      <td>{reminder?.description || '-'}</td>
                      <td>{reminder?.creator?.name || 'Usuario'}</td>
                      <td>{recipientNames || 'Sin destinatarios'}</td>
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
                            onClick={() => handleMarkReminderSeen(reminder.id)}
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
    </section>
  )
}

export default EntityRemindersTab

