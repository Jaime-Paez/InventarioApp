import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Minus, Plus } from 'lucide-react'
import { API_URL, authFetch } from '../../../../utils/api'
import { formatDateTime } from '../../../../utils/dateFormat'
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
  getTransferReminderHistory,
  isReminderCreatedByCurrentUser,
  isReminderForContext,
  isReminderForCurrentUser,
  isSpecialTransferDecisionReminder,
  normalizeId,
  readRemindersFromStorage,
  reminderCompletedByIds,
  writeRemindersToStorage,
} from './remindersStorage'
import '../../QuickActions/RecordatoriosPopup.css'
import './EntityRemindersTab.css'

const normalizeReminderContextType = (value) =>
  normalizeId(value)
    .toLowerCase()
    .replace(/[\s-]+/g, '_')

const normalizeStateText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()

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

const getTransferHistoryStageLabel = (stage) => {
  const normalized = normalizeStateText(stage)
  if (normalized === 'pendiente') return 'Solicitud creada'
  if (normalized === 'aceptada') return 'Solicitud aceptada'
  if (normalized === 'rechazada') return 'Solicitud rechazada'
  if (normalized === 'cancelado') return 'Solicitud cancelada'
  if (normalized === 'enviado') return 'Solicitud enviada'
  if (normalized === 'recibido') return 'Solicitud recibida'
  if (normalized === 'completo') return 'Solicitud recibida completa'
  if (normalized === 'incompleto') return 'Solicitud recibida incompleta'
  return String(stage || 'Evento').trim() || 'Evento'
}

const getTransferHistoryTimelineStage = (stage) => {
  const normalized = normalizeStateText(stage)
  if (normalized === 'aceptada') return 'aceptada'
  if (normalized === 'rechazada') return 'rechazada'
  if (normalized === 'cancelado') return 'cancelado'
  if (normalized === 'enviado') return 'enviado'
  if (normalized === 'completo' || normalized === 'incompleto' || normalized === 'recibido') return 'recibido'
  return 'pendiente'
}

const getTransferHistoryDisplayLabel = (entry, previousEntries = []) => {
  const normalized = normalizeStateText(entry?.stage)
  if (normalized === 'pendiente') {
    const comesFromCorrection = previousEntries.some((previousEntry) => {
      const previousStage = normalizeStateText(previousEntry?.stage)
      return previousStage === 'rechazada' || previousStage === 'cancelado'
    })

    if (comesFromCorrection) return 'Solicitud corregida'
  }

  return String(entry?.label || '').trim() || getTransferHistoryStageLabel(entry?.stage)
}

const getTransferHistoryVisualStatus = (stage, customLabel = '') => {
  const normalized = normalizeStateText(stage)
  const label = String(customLabel || '').trim() || getTransferHistoryStageLabel(stage)

  if (normalized === 'aceptada') return { label, className: 'accepted' }
  if (normalized === 'rechazada') return { label, className: 'rejected' }
  if (normalized === 'cancelado') return { label, className: 'cancelled' }
  if (normalized === 'enviado') return { label, className: 'sent' }
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

const mergeTransferHistoryForContext = (reminders, contextId) => {
  const normalizedContextId = normalizeId(contextId)
  if (!normalizedContextId) return []

  const bySignature = new Map()
  ;(Array.isArray(reminders) ? reminders : []).forEach((reminder) => {
    if (normalizeReminderContextType(reminder?.context?.type) !== 'solicitud_traslado') return
    if (normalizeId(reminder?.context?.id) !== normalizedContextId) return

    getTransferReminderHistory(reminder).forEach((entry) => {
      const actorId = normalizeId(entry?.actor?.id)
      const signature = [
        String(entry?.stage || '').trim(),
        String(entry?.at || '').trim(),
        actorId,
        String(entry?.description || '').trim(),
      ].join('|')
      if (!signature.replace(/\|/g, '')) return
      bySignature.set(signature, entry)
    })
  })

  return Array.from(bySignature.values()).sort((a, b) =>
    String(a?.at || '').localeCompare(String(b?.at || ''))
  )
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

  return formatDateTime(raw, raw)
}

const formatDecisionStatusLabel = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'aceptada') return 'Aceptada'
  if (normalized === 'rechazada') return 'Rechazada'
  if (normalized === 'enviado') return 'Enviado'
  return 'Pendiente'
}

const extractReminderDecisionReason = (reminder) => {
  const decisionStatus = getReminderDecisionStatus(reminder)
  if (decisionStatus !== 'rechazada') return ''

  const explicitReason = String(reminder?.decision?.reason || reminder?.decision?.motivo || '').trim()
  if (explicitReason) return explicitReason

  const description = String(reminder?.description || '').trim()
  if (!description) return ''

  const reasonMatch = description.match(/motivo:\s*(.+)$/i)
  return String(reasonMatch?.[1] || '').trim()
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
  showCreateButton = true,
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

  const transferTimelineItems = useMemo(() => {
    if (!normalizedTransferSolicitudId) return []

    const matchingReminders = allReminders.filter((reminder) => {
      const contextType = normalizeReminderContextType(reminder?.context?.type)
      if (contextType !== 'solicitud_traslado') return false
      if (normalizeId(reminder?.context?.id) !== normalizedTransferSolicitudId) return false

      return (
        isReminderForCurrentUser(reminder, currentUserIdSet) ||
        isReminderCreatedByCurrentUser(reminder, currentUserIdSet, currentUserName)
      )
    })

    const mergedHistory = mergeTransferHistoryForContext(matchingReminders, normalizedTransferSolicitudId)
    const oldestReminder = [...matchingReminders].sort((a, b) =>
      String(a?.createdAt || '').localeCompare(String(b?.createdAt || ''))
    )[0] || null
    const fallbackCreatedAt = String(oldestReminder?.createdAt || '').trim()
    const fallbackCreator = oldestReminder?.creator || null

    const hasInitialPendingEntry = mergedHistory.some((entry, index) => {
      const stage = normalizeStateText(entry?.stage)
      if (stage !== 'pendiente') return false
      return !mergedHistory.slice(0, index).some((previousEntry) => {
        const previousStage = normalizeStateText(previousEntry?.stage)
        return previousStage === 'rechazada' || previousStage === 'cancelado'
      })
    })

    const historyWithInitialCreation = !hasInitialPendingEntry && fallbackCreatedAt
      ? [
        {
          stage: 'pendiente',
          label: '',
          description: '',
          at: fallbackCreatedAt,
          actor: fallbackCreator,
        },
        ...mergedHistory,
      ].sort((a, b) => String(a?.at || '').localeCompare(String(b?.at || '')))
      : mergedHistory

    const labeledHistory = historyWithInitialCreation.map((entry, index) => ({
      ...entry,
      displayLabel: getTransferHistoryDisplayLabel(entry, historyWithInitialCreation.slice(0, index)),
    }))

    const latestBaseStageIndex = labeledHistory.reduce((maxIndex, entry) => {
      const stage = getTransferHistoryTimelineStage(entry?.stage)
      const indexByStage = {
        pendiente: 0,
        aceptada: 1,
        enviado: 2,
        recibido: 3,
      }
      const stageIndex = indexByStage[stage]
      return Number.isInteger(stageIndex) && stageIndex > maxIndex ? stageIndex : maxIndex
    }, -1)

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

    const actualTimelineItems = [...timelineItems].reverse()
    const upcomingBaseStages = ['pendiente', 'aceptada', 'enviado', 'recibido']
      .slice(Math.max(latestBaseStageIndex + 1, 1))
      .map((stage) => {
        const historyStatus = getTransferHistoryVisualStatus(stage, getTransferHistoryStageLabel(stage))
        return {
          id: `upcoming-${stage}`,
          label: historyStatus.label,
          className: historyStatus.className,
          actorName: '',
          timestamp: '',
          isPlaceholder: true,
        }
      })

    return [...upcomingBaseStages.reverse(), ...actualTimelineItems]
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

  const activeReminderDecisionReason = useMemo(() => {
    if (!activeReminderDetail) return ''
    return extractReminderDecisionReason(activeReminderDetail)
  }, [activeReminderDetail])

  const activeReminderRecipients = useMemo(() => {
    if (!activeReminderDetail) return []
    return (Array.isArray(activeReminderDetail?.recipients) ? activeReminderDetail.recipients : [])
      .map((recipient) => String(recipient?.name || '').trim())
      .filter(Boolean)
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
        {showCreateButton && (
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
                <span>Nota</span>
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
              </div>

              {!transferTimelineItems.length ? (
                <p className="entity-reminders__empty">
                  Este traslado todavia no tiene hitos registrados.
                </p>
              ) : (
                <div className="recordatorios-popup__detail-history">
                  <ol className="recordatorios-popup__detail-history-list">
                    {transferTimelineItems.map((entry, index) => (
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
                                  ? formatDateTime(entry.timestamp)
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
                    ))}
                  </ol>
                </div>
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
                  <th>Nota</th>
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
                <h6>Nota</h6>
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
                  {activeReminderRecipients.length ? (
                    <ul className="entity-reminders__detail-recipients">
                      {activeReminderRecipients.map((recipientName, index) => (
                        <li key={`${recipientName}-${index}`}>{recipientName}</li>
                      ))}
                    </ul>
                  ) : (
                    <strong>-</strong>
                  )}
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

              {showDetailDecision && activeReminderDecisionReason && (
                <section className="entity-reminders__detail-section">
                  <h6>Motivo</h6>
                  <p className="entity-reminders__detail-description">
                    {activeReminderDecisionReason}
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

