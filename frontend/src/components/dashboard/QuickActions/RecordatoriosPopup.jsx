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
  getTransferReceiptOutcome,
  isRandomInspectionDailyReminder,
  isRandomInspectionVerifyReminder,
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

const buildTransferResponseDescription = (reminder, decisionStatus) => {
  const contextType = normalizeReminderContextType(reminder?.context?.type)
  if (contextType !== 'solicitud_traslado') return String(reminder?.description || '').trim() || '-'

  const contextLabel = String(reminder?.context?.label || '').trim()
  const contextReferenceRaw = contextLabel.replace(/^solicitud de traslado\s*/i, '').trim()
  const contextId = normalizeId(reminder?.context?.id)
  const contextReference = contextReferenceRaw || (contextId ? `#${contextId}` : '')

  if (decisionStatus === 'rechazada') {
    const explicitReason = String(reminder?.decision?.reason || '').trim()
    const description = String(reminder?.description || '').trim()
    const reasonMatch = description.match(/motivo:\s*(.+)$/i)
    const reason = explicitReason || String(reasonMatch?.[1] || '').trim()

    if (contextReference) {
      return reason
        ? `Su solicitud de traslado ${contextReference} fue rechazada. Motivo: ${reason}`
        : `Su solicitud de traslado ${contextReference} fue rechazada.`
    }
    return reason
      ? `Su solicitud de traslado fue rechazada. Motivo: ${reason}`
      : 'Su solicitud de traslado fue rechazada.'
  }

  if (decisionStatus === 'aceptada') {
    if (contextReference) return `Su solicitud de traslado ${contextReference} fue aceptada.`
    return 'Su solicitud de traslado fue aceptada.'
  }

  if (decisionStatus === 'enviado') {
    if (contextReference) return `Su solicitud de traslado ${contextReference} fue enviada y esta en traslado.`
    return 'Su solicitud de traslado fue enviada y esta en traslado.'
  }

  return String(reminder?.description || '').trim() || '-'
}

const normalizeReminderContextType = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')

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

const getTransferProgressStageLabel = (stage, receiptOutcome = '') => {
  const normalizedStage = normalizeTransferProgressStage(stage)
  if (normalizedStage === 'recibido') {
    const normalizedOutcome = normalizeStateText(receiptOutcome)
    if (normalizedOutcome === 'incompleto') return 'Llego incompleto'
    if (normalizedOutcome === 'completo') return 'Llego completo'
    return 'Recibido'
  }
  if (normalizedStage === 'enviado') return 'Enviado'
  if (normalizedStage === 'aceptada') return 'Aceptada'
  return 'Pendiente'
}

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
  onOpenTransferRequestInSalidas,
  onOpenRandomInspection,
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
  const [openingInspectionReminderId, setOpeningInspectionReminderId] = useState('')
  const [highlightedReminderId, setHighlightedReminderId] = useState('')
  const [pendingScrollReminderId, setPendingScrollReminderId] = useState('')
  const [transferLifecycleBySolicitudId, setTransferLifecycleBySolicitudId] = useState({})
  const transferLifecycleInFlightRef = useRef(new Set())
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
      setHighlightedReminderId('')
      setPendingScrollReminderId('')
      setTransferLifecycleBySolicitudId({})
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

      const creatorRecipient = sanitizeRecipient(reminder?.creator)
      if (creatorRecipient?.id) {
        const nowParts = getNowDateParts()
        const requesterLabel = String(reminder?.context?.label || `Solicitud de traslado #${solicitudId}`).trim()
        const requesterReference = requesterLabel.replace(/^solicitud de traslado\s*/i, '').trim()
        const fallbackReference = solicitudId ? `#${solicitudId}` : ''
        const transferReference = requesterReference || fallbackReference
        const responseDescription = resolvedDecision === 'rechazada'
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

        onApplyRemindersUpdate?.((prev) => [
          {
            id: createReminderId(),
            date: nowParts.date,
            time: nowParts.time,
            description: responseDescription,
            creator: {
              id: creatorRecipientId,
              name: creatorRecipientName,
            },
            recipients: [creatorRecipient],
            context: reminder?.context || null,
            kind: 'recordatorio_general',
            createdAt: resolutionDate,
            decision: {
              status: resolvedDecision,
              reason: resolvedDecision === 'rechazada' ? rejectionReasonValue : '',
              by: sanitizeRecipient({ id: creatorRecipientId, name: creatorRecipientName }),
              at: resolutionDate,
            },
            completedBy: [],
          },
          ...(Array.isArray(prev) ? prev : []),
        ])
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
      const findRealEntrada = (row) => !Boolean(row?.es_solicitud_traslado)

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
    if (!open || !token) return

    const remindersToResolve = selectedDayReminders.filter((reminder) => {
      const contextType = normalizeReminderContextType(reminder?.context?.type)
      if (contextType !== 'solicitud_traslado') return false
      if (!isSpecialTransferDecisionReminder(reminder)) return false
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
          notifyError('No se encontro la solicitud asociada a este recordatorio.')
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
        if (!movimientoSalidaId) {
          throw new Error('La solicitud todavia no tiene una salida generada.')
        }

        onOpenTransferRequestInSalidas({
          requestKey: `${Date.now()}-${solicitudId}`,
          solicitudId,
          sucursalProveedoraId: String(solicitudDetail?.sucursal_proveedora_id || '').trim(),
          movimientoSalidaId,
          solicitud: solicitudDetail,
          mode: 'view',
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
      if (!solicitudId) {
        if (!suppressError) {
          notifyError('No se encontro la solicitud asociada a este recordatorio.')
        }
        return false
      }

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
      }
    },
    [
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
        notifyError('No se encontro la solicitud asociada a este recordatorio.')
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
                        const transferReceiptOutcome = getTransferReceiptOutcome(reminder)
                        const isTransferContextReminder =
                          normalizeReminderContextType(reminder?.context?.type) === 'solicitud_traslado'
                        const solicitudId = normalizeId(reminder?.context?.id)
                        const transferLifecycle = transferLifecycleBySolicitudId?.[solicitudId] || null
                        const transferLifecycleStage = String(transferLifecycle?.stage || '').trim()
                        const isTransferLifecycleLoading = (
                          isSpecialReminder &&
                          isTransferContextReminder &&
                          decisionStatus === 'aceptada' &&
                          (!transferLifecycle || Boolean(transferLifecycle?.loading))
                        )
                        const canResolveDecision = (
                          isSpecialReminder &&
                          decisionStatus === 'pendiente' &&
                          status.className !== 'info'
                        )
                        const canCreateSalidaFromReminder = (
                          isSpecialReminder &&
                          isTransferContextReminder &&
                          decisionStatus === 'aceptada' &&
                          transferLifecycleStage === 'aceptada' &&
                          typeof onTransferDecisionAccepted === 'function'
                        )
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
                        const latestTransferStageLabel = getTransferProgressStageLabel(
                          latestTransferStage,
                          latestTransferStage === 'recibido'
                            ? (latestTransferReceiptOutcome || transferReceiptOutcome)
                            : ''
                        )
                        const reminderDescriptionNormalized = normalizeStateText(reminder?.description)
                        const reminderIndicatesOwnShipment = reminderDescriptionNormalized.includes('su envio de traslado')
                        const latestProgressPreferredTarget = latestTransferStage === 'recibido'
                          ? (reminderIndicatesOwnShipment || isSpecialReminder ? 'salidas' : 'entradas')
                          : 'salidas'
                        const currentReminderId = normalizeId(reminder?.id)
                        const isLatestTransferProgressReminder = Boolean(
                          latestTransferReminderId && latestTransferReminderId === currentReminderId
                        )
                        const latestProgressActionLabel = latestTransferStage === 'recibido'
                          ? (latestProgressPreferredTarget === 'salidas' ? 'Ver salida' : 'Ver entrada')
                          : 'Ver envio pendiente'
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
                        const canOpenTransferInEntradas = (
                          isTransferContextReminder &&
                          !isSpecialReminder &&
                          (
                            decisionStatus === 'rechazada' ||
                            decisionStatus === 'aceptada' ||
                            status.className === 'rejected' ||
                            status.className === 'accepted'
                          ) &&
                          typeof onOpenTransferRequestInEntradas === 'function'
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
                          decisionStatus === 'enviado' ||
                          (decisionStatus === 'aceptada' && hasSentReminderForSameRequest)
                        )
                        const isOpeningTransfer = (
                          normalizeId(openingTransferReminderId) &&
                          normalizeId(openingTransferReminderId) === currentReminderId
                        )
                        const isOpeningInspection = (
                          normalizeId(openingInspectionReminderId) &&
                          normalizeId(openingInspectionReminderId) === currentReminderId
                        )
                        const canOpenRandomInspectionAction = (
                          (
                            isRandomInspectionDailyReminder(reminder) ||
                            isRandomInspectionVerifyReminder(reminder)
                          ) &&
                          typeof onOpenRandomInspection === 'function'
                        )
                        const isHighlightedReminder = (
                          Boolean(currentReminderId) &&
                          normalizeId(highlightedReminderId) === currentReminderId
                        )
                        const recipients = Array.isArray(reminder?.recipients) ? reminder.recipients : []
                        const recipientNames = recipients
                          .map((recipient) => String(recipient?.name || '').trim())
                          .filter(Boolean)
                          .join(', ')
                        const timelineDescription = (
                          isTransferContextReminder && !isSpecialReminder
                            ? buildTransferResponseDescription(reminder, decisionStatus)
                            : String(reminder?.description || '').trim() || '-'
                        )

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
                              isHighlightedReminder ? ' recordatorios-popup__timeline-item--highlighted' : ''
                            }`}
                          >
                            <div className="recordatorios-popup__timeline-item-head">
                              <p className="recordatorios-popup__timeline-item-time">{formatReminderTimeLabel(reminder)}</p>
                              <span className={`recordatorios-popup__status recordatorios-popup__status--${status.className}`}>
                                {status.label}
                              </span>
                            </div>

                            <p className="recordatorios-popup__timeline-item-description" title={timelineDescription}>
                              {timelineDescription}
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
                                        : `Ver ultimo avance (${latestTransferStageLabel})`
                                    )}
                                </button>
                              ) : canOpenTransferInEntradas ? (
                                <button
                                  type="button"
                                  className="recordatorios-popup__mark-seen recordatorios-popup__mark-seen--decision"
                                  onClick={() => handleOpenTransferInEntradas(reminder)}
                                  disabled={isOpeningTransfer}
                                >
                                  {isOpeningTransfer
                                    ? 'Abriendo...'
                                    : (
                                      shouldUseSentCopyOnTransferEntryAction
                                        ? 'Solicitud ya enviada, ver envio pendiente'
                                        : 'Ver en entradas'
                                    )}
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
                                        ? 'Ir a revision por sucursal'
                                        : 'Realizar inspeccion'
                                    )}
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

