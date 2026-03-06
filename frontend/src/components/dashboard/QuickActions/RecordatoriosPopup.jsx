import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, ChevronLeft, ChevronRight, Loader2, Plus, X } from 'lucide-react'
import useModalAnimation from '../common/useModalAnimation'
import { API_URL, authFetch } from '../../../utils/api'
import {
  buildReminderStatusForUser,
  createReminderId,
  extractUserId,
  formatCurrentUserName,
  getReminderDecisionStatus,
  isReminderForContext,
  isSpecialTransferDecisionReminder,
  normalizeId,
  reminderCompletedByIds,
  sanitizeRecipient,
} from '../common/reminders/remindersStorage'
import './RecordatoriosPopup.css'

const getNowDateParts = () => {
  const now = new Date()
  return {
    date: formatDateKey(now),
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  }
}

const formatReminderContext = (reminder) => {
  const label = String(reminder?.context?.label || '').trim()
  if (label) return label

  const type = String(reminder?.context?.type || '').trim()
  if (!type) return 'General'

  if (type === 'solicitud_traslado') return 'Solicitud de traslado'

  const formatted = type.replace(/[_-]+/g, ' ')
  return formatted.charAt(0).toUpperCase() + formatted.slice(1)
}

const normalizeReminderContextType = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')

const extractTransferDocumentNumber = (value) => {
  const match = String(value || '').match(/#([A-Za-z0-9._-]+)/)
  return match ? String(match[1] || '').trim() : ''
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
    es_solicitud_traslado: true,
    solicitud_traslado_id: solicitudId || null,
    sucursal_solicitante_id: row?.sucursal_solicitante_id || '',
    sucursal_proveedora_id: row?.sucursal_proveedora_id || '',
    descripcion: String(row?.descripcion || '').trim(),
    detalles,
    movimiento_salida_id: row?.movimiento_salida_id ?? null,
    movimiento_entrada_id: row?.movimiento_entrada_id ?? null,
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

const getTodayDateKey = () => formatDateKey(new Date())

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
  const label = new Intl.DateTimeFormat('es-CO', { weekday: 'short' }).format(parsed)
  return label.replace('.', '')
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

function RecordatoriosPopup({
  open,
  onClose,
  token,
  currentUser,
  currentUserName,
  currentUserIds,
  reminders,
  onCreateReminder,
  onMarkReminderSeen,
  darkMode,
  onError,
  onApplyRemindersUpdate,
  focusReminderId,
  onFocusReminderHandled,
  onTransferDecisionAccepted,
  onOpenTransferRequestInEntradas,
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
  const [selectedTimelineDate, setSelectedTimelineDate] = useState(() => getTodayDateKey())
  const [openingTransferReminderId, setOpeningTransferReminderId] = useState('')

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

  const currentPrimaryUserId = useMemo(() => {
    const values = Array.from(currentUserIdSet)
    return values[0] || ''
  }, [currentUserIdSet])

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
    () => formatDateKey(selectedTimelineDate) || getTodayDateKey(),
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
            return timestampA - timestampB
          }
          if (Number.isFinite(timestampA)) return -1
          if (Number.isFinite(timestampB)) return 1
          return String(a?.id || '').localeCompare(String(b?.id || ''))
        })
      )
    })

    return grouped
  }, [reminders])

  const selectedDayReminders = useMemo(
    () => remindersByDate.get(normalizedSelectedTimelineDate) || [],
    [remindersByDate, normalizedSelectedTimelineDate]
  )

  const timelineWeekDays = useMemo(() => {
    const start = getWeekStartDate(normalizedSelectedTimelineDate)

    return Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(start)
      date.setDate(start.getDate() + offset)
      const dateKey = formatDateKey(date)
      const count = (remindersByDate.get(dateKey) || []).length
      return {
        dateKey,
        count,
        dayName: formatTimelineDayName(dateKey),
        dayDate: formatTimelineDayDate(dateKey),
      }
    })
  }, [normalizedSelectedTimelineDate, remindersByDate])

  const maxWeekDayCount = useMemo(
    () => Math.max(1, ...timelineWeekDays.map((day) => day.count)),
    [timelineWeekDays]
  )

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

  const shiftTimelineDay = useCallback((offset) => {
    setSelectedTimelineDate((current) => addDaysToDateKey(current, offset))
  }, [])

  const handleGoTodayTimeline = useCallback(() => {
    setSelectedTimelineDate(getTodayDateKey())
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
        let url = `${API_URL}/usuarios/listado/?page_size=200`

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
      setSelectedTimelineDate(reminderDateKey)
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
        const detail = String(data?.detail || data?.motivo || '').trim() || 'No se pudo registrar la decision.'
        throw new Error(detail)
      }

      const resolvedDecision = decision === 'rechazar' ? 'rechazada' : 'aceptada'
      const resolutionDate = new Date().toISOString()
      const context = reminder?.context || null
      const rejectionReasonValue = String(rejectionReason || '').trim()

      onApplyRemindersUpdate?.((prev) =>
        (Array.isArray(prev) ? prev : []).map((item) => {
          if (!isSpecialTransferDecisionReminder(item)) return item
          if (!isReminderForContext(item, context)) return item

          const completedBySet = new Set(reminderCompletedByIds(item))
          ;(Array.isArray(item?.recipients) ? item.recipients : []).forEach((recipient) => {
            const recipientId = normalizeId(recipient?.id)
            if (recipientId) completedBySet.add(recipientId)
          })

          return {
            ...item,
            completedBy: Array.from(completedBySet),
            decision: {
              status: resolvedDecision,
              reason: resolvedDecision === 'rechazada' ? rejectionReasonValue : '',
              by: sanitizeRecipient({ id: creatorRecipientId, name: creatorRecipientName }),
              at: resolutionDate,
            },
          }
        })
      )

      if (resolvedDecision === 'rechazada') {
        const creatorRecipient = sanitizeRecipient(reminder?.creator)
        if (creatorRecipient?.id) {
          const nowParts = getNowDateParts()
          const requesterLabel = String(reminder?.context?.label || `Solicitud de traslado #${solicitudId}`).trim()
          const rejectorName = String(creatorRecipientName || 'Usuario').trim() || 'Usuario'
          onApplyRemindersUpdate?.((prev) => [
            {
              id: createReminderId(),
              date: nowParts.date,
              time: nowParts.time,
              description: `${requesterLabel} rechazada por ${rejectorName}. Motivo: ${rejectionReasonValue}`,
              creator: {
                id: creatorRecipientId,
                name: creatorRecipientName,
              },
              recipients: [creatorRecipient],
              context: reminder?.context || null,
              kind: 'recordatorio_general',
              createdAt: resolutionDate,
              decision: {
                status: 'rechazada',
                reason: rejectionReasonValue,
                by: sanitizeRecipient({ id: creatorRecipientId, name: creatorRecipientName }),
                at: resolutionDate,
              },
              completedBy: [],
            },
            ...(Array.isArray(prev) ? prev : []),
          ])
        }
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
      const message = error?.message || 'No se pudo registrar la decision.'
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
        params.set('no_documento', documentNumber)
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

      const findBySolicitudId = (row) =>
        Boolean(row?.es_solicitud_traslado) &&
        normalizeId(row?.solicitud_traslado_id) === solicitudId
      const findByDocument = (row) =>
        Boolean(row?.es_solicitud_traslado) &&
        String(row?.no_documento || '').trim().toLowerCase() === documentNumber.toLowerCase()

      const targetRow = (
        (solicitudId ? rows.find(findBySolicitudId) : null) ||
        (documentNumber ? rows.find(findByDocument) : null) ||
        rows.find((row) => Boolean(row?.es_solicitud_traslado)) ||
        null
      )

      if (!targetRow) return null
      return mapTransferRowToEntradaPreview(targetRow)
    },
    [token]
  )

  const fetchTransferPreviewFromDetail = useCallback(
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
      return mapTransferDetailToEntradaPreview(data)
    },
    [token]
  )

  const handleOpenTransferInEntradas = useCallback(
    async (reminder) => {
      if (typeof onOpenTransferRequestInEntradas !== 'function') return
      const solicitudId = normalizeId(reminder?.context?.id)
      const reminderId = normalizeId(reminder?.id) || solicitudId
      if (!solicitudId) {
        notifyError('No se encontro la solicitud asociada a este recordatorio.')
        return
      }

      setOpeningTransferReminderId(reminderId)
      try {
        const previewFromTable = await fetchTransferPreviewFromEntradaTable(reminder)
        const previewFromDetail = previewFromTable
          ? null
          : await fetchTransferPreviewFromDetail(solicitudId)
        const previewData = previewFromTable || previewFromDetail
        if (!previewData) {
          throw new Error('No se pudo abrir la solicitud en Entradas.')
        }

        onOpenTransferRequestInEntradas({
          requestKey: `${Date.now()}-${solicitudId}`,
          solicitudId,
          sucursalSolicitanteId: String(previewData?.sucursal_solicitante_id || '').trim(),
          previewData,
        })
        onClose?.()
      } catch (error) {
        notifyError(error?.message || 'No se pudo abrir la solicitud en Entradas.')
      } finally {
        setOpeningTransferReminderId('')
      }
    },
    [
      fetchTransferPreviewFromDetail,
      fetchTransferPreviewFromEntradaTable,
      notifyError,
      onClose,
      onOpenTransferRequestInEntradas,
    ]
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
          <div>
            <h3>Recordatorios</h3>
            <p>Crea y revisa recordatorios personales.</p>
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
                  <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
                </label>

                <label className="recordatorios-popup__field">
                  <span>Hora</span>
                  <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
                </label>

                <label className="recordatorios-popup__field recordatorios-popup__field--full">
                  <span>Usuario creador</span>
                  <input type="text" value={creatorRecipientName} readOnly />
                </label>

                <label className="recordatorios-popup__field recordatorios-popup__field--full">
                  <span>Descripcion</span>
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
              <div className="recordatorios-popup__section-head">
                <h4>Recordatorios personales</h4>
                <button
                  type="button"
                  className="recordatorios-popup__button recordatorios-popup__button--primary recordatorios-popup__add-trigger"
                  onClick={handleOpenCreateView}
                >
                  <Plus />
                  Anadir recordatorio
                </button>
              </div>

              {!Array.isArray(reminders) || !reminders.length ? (
                <p className="recordatorios-popup__empty-list">No hay recordatorios personales.</p>
              ) : (
                <>
                  <section className="recordatorios-popup__timeline" aria-label="Linea de tiempo semanal">
                    <div className="recordatorios-popup__timeline-head">
                      <button
                        type="button"
                        className="recordatorios-popup__timeline-arrow"
                        onClick={() => shiftTimelineDay(-7)}
                        aria-label="Semana anterior"
                      >
                        <ChevronLeft />
                      </button>

                      <div className="recordatorios-popup__timeline-title">
                        <h5>Resumen semanal</h5>
                        <p>{timelineWeekRangeLabel}</p>
                      </div>

                      <button
                        type="button"
                        className="recordatorios-popup__timeline-arrow"
                        onClick={() => shiftTimelineDay(7)}
                        aria-label="Semana siguiente"
                      >
                        <ChevronRight />
                      </button>
                    </div>

                    <div className="recordatorios-popup__timeline-week" role="tablist" aria-label="Dias de la semana">
                      {timelineWeekDays.map((day) => {
                        const isSelected = day.dateKey === normalizedSelectedTimelineDate
                        const density = day.count / maxWeekDayCount
                        return (
                          <button
                            key={day.dateKey}
                            type="button"
                            role="tab"
                            aria-selected={isSelected}
                            className={`recordatorios-popup__timeline-day${isSelected ? ' is-selected' : ''}`}
                            style={{ '--recordatorios-density': String(density) }}
                            onClick={() => setSelectedTimelineDate(day.dateKey)}
                          >
                            <span className="recordatorios-popup__timeline-day-name">{day.dayName}</span>
                            <span className="recordatorios-popup__timeline-day-date">{day.dayDate}</span>
                            <span className="recordatorios-popup__timeline-day-count">{day.count} rec.</span>
                          </button>
                        )
                      })}
                    </div>

                    <div className="recordatorios-popup__timeline-controls">
                      <button
                        type="button"
                        className="recordatorios-popup__timeline-control"
                        onClick={() => shiftTimelineDay(-1)}
                      >
                        <ChevronLeft />
                        Dia anterior
                      </button>

                      <button
                        type="button"
                        className="recordatorios-popup__timeline-control recordatorios-popup__timeline-control--today"
                        onClick={handleGoTodayTimeline}
                      >
                        <CalendarDays />
                        Hoy
                      </button>

                      <button
                        type="button"
                        className="recordatorios-popup__timeline-control"
                        onClick={() => shiftTimelineDay(1)}
                      >
                        Dia siguiente
                        <ChevronRight />
                      </button>
                    </div>
                  </section>

                  <div className="recordatorios-popup__timeline-day-header">
                    <h5>{selectedTimelineFullDateLabel}</h5>
                    <p>{selectedDayReminders.length} recordatorio(s)</p>
                  </div>

                  <div className="recordatorios-popup__timeline-list">
                    {!selectedDayReminders.length ? (
                      <p className="recordatorios-popup__empty-list">No hay recordatorios para este dia.</p>
                    ) : (
                      selectedDayReminders.map((reminder) => {
                        const status = buildReminderStatusForUser(reminder, currentUserIdSet)
                        const isSpecialReminder = isSpecialTransferDecisionReminder(reminder)
                        const decisionStatus = getReminderDecisionStatus(reminder)
                        const isTransferContextReminder =
                          normalizeReminderContextType(reminder?.context?.type) === 'solicitud_traslado'
                        const canResolveDecision = (
                          isSpecialReminder &&
                          decisionStatus === 'pendiente' &&
                          status.className !== 'info'
                        )
                        const canOpenTransferInEntradas = (
                          isTransferContextReminder &&
                          !isSpecialReminder &&
                          decisionStatus === 'rechazada' &&
                          typeof onOpenTransferRequestInEntradas === 'function'
                        )
                        const isOpeningTransfer = (
                          normalizeId(openingTransferReminderId) &&
                          normalizeId(openingTransferReminderId) === normalizeId(reminder?.id)
                        )
                        const recipients = Array.isArray(reminder?.recipients) ? reminder.recipients : []
                        const recipientNames = recipients
                          .map((recipient) => String(recipient?.name || '').trim())
                          .filter(Boolean)
                          .join(', ')

                        return (
                          <article key={reminder.id} className="recordatorios-popup__timeline-item">
                            <div className="recordatorios-popup__timeline-item-head">
                              <p className="recordatorios-popup__timeline-item-time">{formatReminderTimeLabel(reminder)}</p>
                              <span className={`recordatorios-popup__status recordatorios-popup__status--${status.className}`}>
                                {status.label}
                              </span>
                            </div>

                            <p className="recordatorios-popup__timeline-item-description" title={String(reminder?.description || '-')}>
                              {reminder?.description || '-'}
                            </p>

                            <p className="recordatorios-popup__timeline-item-context">
                              {formatReminderContext(reminder)}
                            </p>

                            <div className="recordatorios-popup__timeline-item-meta">
                              <span>
                                <strong>Creador:</strong> {reminder?.creator?.name || 'Usuario'}
                              </span>
                              <span>
                                <strong>Dirigido a:</strong> {recipientNames || 'Sin destinatarios'}
                              </span>
                            </div>

                            <div className="recordatorios-popup__timeline-item-actions">
                              {canResolveDecision ? (
                                <button
                                  type="button"
                                  className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                  onClick={() => openDecisionPanel(reminder)}
                                >
                                  Resolver solicitud
                                </button>
                              ) : canOpenTransferInEntradas ? (
                                <button
                                  type="button"
                                  className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                  onClick={() => handleOpenTransferInEntradas(reminder)}
                                  disabled={isOpeningTransfer}
                                >
                                  {isOpeningTransfer ? 'Abriendo...' : 'Ver en entradas'}
                                </button>
                              ) : status.canMarkSeen ? (
                                <button
                                  type="button"
                                  className="recordatorios-popup__mark-seen"
                                  onClick={() => onMarkReminderSeen?.(reminder.id)}
                                >
                                  Marcar como visto
                                </button>
                              ) : isSpecialReminder ? (
                                <span className="recordatorios-popup__action-placeholder">Decision registrada</span>
                              ) : (
                                <span className="recordatorios-popup__action-placeholder">No aplica</span>
                              )}
                            </div>
                          </article>
                        )
                      })
                    )}
                  </div>
                </>
              )}
            </section>
          )}
        </div>

        {activeDecisionReminder && (
          <div className="recordatorios-popup__decision-overlay" onMouseDown={() => closeDecisionPanel()}>
            <div className="recordatorios-popup__decision-card" onMouseDown={(event) => event.stopPropagation()}>
              <header className="recordatorios-popup__decision-head">
                <div>
                  <h4>Solicitud de traslado</h4>
                  <p>{activeDecisionReminder?.context?.label || 'Detalle de solicitud'}</p>
                </div>
                <button
                  type="button"
                  className="recordatorios-popup__close"
                  onClick={closeDecisionPanel}
                  aria-label="Cerrar decision"
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
                      <span>Descripcion</span>
                      <p>{String(decisionDetail?.descripcion || '').trim() || '-'}</p>
                    </label>

                    <div className="recordatorios-popup__decision-table-wrap">
                      <table className="recordatorios-popup__decision-table">
                        <thead>
                          <tr>
                            <th>Codigo</th>
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
                        <span>Descripcion (obligatoria)</span>
                        <textarea
                          value={rejectionReason}
                          onChange={(event) => setRejectionReason(event.target.value)}
                          placeholder="Explica por que rechazas la solicitud"
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
      </div>
    </div>,
    document.body
  )
}

export default RecordatoriosPopup

