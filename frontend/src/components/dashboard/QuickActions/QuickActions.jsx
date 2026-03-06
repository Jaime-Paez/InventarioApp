import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bell, Loader2, Moon, Search, SunMedium } from 'lucide-react'
import { Toast } from 'primereact/toast'
import './QuickActions.css'
import RecordatoriosPopup from './RecordatoriosPopup'
import notificationAudioSrc from '../common/reminders/notifications.mp3'
import { API_URL, authFetch } from '../../../utils/api'
import {
  REMINDERS_STORAGE_KEY,
  REMINDERS_SYNC_EVENT,
  buildUserIdSet,
  createReminderId,
  emitTransferReminderNotification,
  emitRemindersSync,
  fetchRemindersFromBackend,
  formatCurrentUserName,
  getReminderDecisionStatus,
  getReminderDeadlineTimestamp,
  isReminderCreatedByCurrentUser,
  isReminderForCurrentUser,
  isReminderPendingForCurrentUser,
  isSpecialTransferDecisionReminder,
  normalizeId,
  readRemindersFromStorage,
  reminderCompletedByIds,
  sanitizeRecipient,
  sortRemindersForCurrentUser,
  writeRemindersToStorage,
} from '../common/reminders/remindersStorage'

const URGENT_SHIELD_NEAR_FULL_MS = 60 * 60 * 1000
const URGENT_DECISION_MESSAGE = 'Tienes una solicitud de traslado pendiente.'
const URGENT_SHIPMENT_MESSAGE = 'Tienes un envio pendiente por despachar.'
const URGENT_MESSAGE_REVEAL_PROGRESS = 0.48
const URGENT_SHIELD_TICK_MS = 1000
const REMINDERS_POLL_MS = 4000
const URGENT_DECISION_SHIELD_COLOR = '#0b4f79'
const URGENT_SHIPMENT_SHIELD_COLOR = '#15803d'
const URGENT_SHIELD_STACK_OFFSET_DESKTOP = 22
const URGENT_SHIELD_STACK_OFFSET_MOBILE = 14
const TRANSFER_SALIDA_MODAL_STATE_EVENT = 'inventario-transfer-salida-modal-state'

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))
const normalizeReminderContextType = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')

const parseEntityTimestamp = (...values) => {
  for (const value of values) {
    const raw = String(value || '').trim()
    if (!raw) continue
    const timestamp = Date.parse(raw)
    if (Number.isFinite(timestamp)) return timestamp
  }
  return Number.NaN
}

const isResolvedTransferResponseReminder = (reminder) => {
  const contextType = normalizeReminderContextType(reminder?.context?.type)
  if (contextType !== 'solicitud_traslado') return false
  if (isSpecialTransferDecisionReminder(reminder)) return false

  const decisionStatus = getReminderDecisionStatus(reminder)
  return decisionStatus === 'aceptada' || decisionStatus === 'rechazada'
}

const resolveUrgentDecisionProgress = (reminder, nowValue) => {
  const deadline = getReminderDeadlineTimestamp(reminder)
  const createdAt = parseEntityTimestamp(reminder?.createdAt)
  const now = Number(nowValue || Date.now())

  if (!Number.isFinite(createdAt)) {
    if (!Number.isFinite(deadline)) return 0
    return now >= deadline ? 1 : 0
  }

  const elapsed = Math.max(0, now - createdAt)
  const deadlineWindow = Number.isFinite(deadline) ? Math.max(1, deadline - createdAt) : Number.POSITIVE_INFINITY
  const growthWindow = Math.min(URGENT_SHIELD_NEAR_FULL_MS, deadlineWindow)
  const ratio = elapsed / growthWindow
  return clamp01(ratio)
}

const resolveUrgentShipmentProgress = (shipment, nowValue) => {
  const createdAt = parseEntityTimestamp(
    shipment?.created_at,
    shipment?.createdAt,
    shipment?.updated_at,
    shipment?.fecha
  )
  const now = Number(nowValue || Date.now())

  if (!Number.isFinite(createdAt)) return 0
  const elapsed = Math.max(0, now - createdAt)
  return clamp01(elapsed / URGENT_SHIELD_NEAR_FULL_MS)
}

function QuickActions({
  darkMode,
  onToggleTheme,
  token,
  user,
  onTransferDecisionAccepted,
  onOpenTransferRequestInEntradas,
  allowUrgentShield = true,
}) {
  const wrapRef = useRef(null)
  const btnRefs = useRef([])
  const reminderButtonRef = useRef(null)
  const pendingShipmentsRef = useRef(null)
  const pendingShipmentsTriggerRef = useRef(null)
  const moveTimerRef = useRef(null)
  const remindersPollInFlightRef = useRef(false)
  const pendingShipmentsPollInFlightRef = useRef(false)
  const audioContextRef = useRef(null)
  const notificationAudioRef = useRef(null)
  const didInitUrgentSnapshotRef = useRef(false)
  const seenUrgentReminderIdsRef = useRef(new Set())
  const didInitPendingShipmentUrgentSnapshotRef = useRef(false)
  const seenPendingShipmentUrgentIdsRef = useRef(new Set())
  const didInitTransferResponseSnapshotRef = useRef(false)
  const seenTransferResponseReminderIdsRef = useRef(new Set())
  const toast = useRef(null)

  const [blob, setBlob] = useState({ x: 0, y: 0, w: 0, h: 0, visible: false })
  const [isMoving, setIsMoving] = useState(false)
  const [isReminderModalOpen, setIsReminderModalOpen] = useState(false)
  const [isPendingShipmentsOpen, setIsPendingShipmentsOpen] = useState(false)
  const [isTransferSendModalOpen, setIsTransferSendModalOpen] = useState(false)
  const [reminders, setReminders] = useState(() => readRemindersFromStorage())
  const [pendingShipments, setPendingShipments] = useState([])
  const [pendingShipmentsLoading, setPendingShipmentsLoading] = useState(false)
  const [openingPendingShipmentId, setOpeningPendingShipmentId] = useState('')
  const [clockTick, setClockTick] = useState(() => Date.now())
  const [focusReminderId, setFocusReminderId] = useState('')
  const [urgentVisualProgressById, setUrgentVisualProgressById] = useState({})
  const urgentVisualReminderIdsRef = useRef(new Set())
  const wasTransferSendModalOpenRef = useRef(false)

  const currentUserIds = useMemo(() => buildUserIdSet(user), [user])
  const currentUserIdValues = useMemo(() => Array.from(currentUserIds), [currentUserIds])
  const currentPrimaryUserId = currentUserIdValues[0] || ''
  const currentUserName = useMemo(() => formatCurrentUserName(user), [user])
  const hasPendingShipments = pendingShipments.length > 0
  const canDecideTransferRequest = useMemo(() => {
    if (user?.is_staff || user?.is_superuser) return true
    if (!Array.isArray(user?.permisos)) return true
    const permissions = user.permisos
    const salidasPermission = permissions.find(
      (permission) => String(permission?.modulo || '').trim().toLowerCase() === 'movimientos_salidas'
    )
    return Boolean(salidasPermission?.puede_crear || salidasPermission?.puede_actualizar)
  }, [user])

  const showErrorToast = useCallback((message) => {
    if (!message) return
    toast.current?.show({
      severity: 'error',
      summary: 'Error',
      detail: message,
      life: 3400,
    })
  }, [])

  const fetchTransferSolicitudDetail = useCallback(
    async (solicitudId) => {
      const normalizedId = normalizeId(solicitudId)
      if (!token || !normalizedId) return null

      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(normalizedId)}/`,
        {},
        token
      )
      if (!response.ok) return null

      const payload = await response.json().catch(() => ({}))
      return payload && typeof payload === 'object' ? payload : null
    },
    [token]
  )

  const fetchPendingTransferShipments = useCallback(async ({ silent = false } = {}) => {
    if (!token || !canDecideTransferRequest) {
      setPendingShipments([])
      return []
    }

    if (pendingShipmentsPollInFlightRef.current) return []
    pendingShipmentsPollInFlightRef.current = true
    if (!silent) setPendingShipmentsLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/?estado=aprobada&page_size=200`,
        {},
        token
      )
      if (!response.ok) {
        throw new Error('No se pudieron cargar los envios pendientes.')
      }

      const payload = await response.json().catch(() => ({}))
      const rows = parseApiList(payload)
        .filter(
          (solicitud) => !solicitud?.movimiento_salida_id && !solicitud?.movimiento_entrada_id
        )
        .sort((a, b) => {
          const dateA = Date.parse(String(a?.fecha || ''))
          const dateB = Date.parse(String(b?.fecha || ''))
          if (Number.isFinite(dateA) && Number.isFinite(dateB) && dateA !== dateB) {
            return dateB - dateA
          }
          return Number(b?.id || 0) - Number(a?.id || 0)
        })

      setPendingShipments(rows)
      return rows
    } catch (error) {
      if (!silent) {
        setPendingShipments([])
      }
      if (!silent) {
        showErrorToast(error?.message || 'No se pudieron cargar los envios pendientes.')
      }
      return []
    } finally {
      pendingShipmentsPollInFlightRef.current = false
      if (!silent) setPendingShipmentsLoading(false)
    }
  }, [canDecideTransferRequest, showErrorToast, token])

  const ensureAudioContext = useCallback(() => {
    if (typeof window === 'undefined') return null
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext
    if (!AudioContextCtor) return null
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextCtor()
    }
    return audioContextRef.current
  }, [])

  const playNotificationTone = useCallback(() => {
    const audio = notificationAudioRef.current
    if (audio) {
      try {
        audio.currentTime = 0
        const playPromise = audio.play()
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {})
        }
        return
      } catch {
        // Fallback below if audio playback fails.
      }
    }

    const context = ensureAudioContext()
    if (!context) return

    const play = () => {
      try {
        const now = context.currentTime
        const gain = context.createGain()
        const oscillator = context.createOscillator()
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(932, now)

        gain.gain.setValueAtTime(0.0001, now)
        gain.gain.exponentialRampToValueAtTime(0.035, now + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24)

        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.start(now)
        oscillator.stop(now + 0.25)
      } catch {
        // Ignore audio errors (browser policies/devices).
      }
    }

    if (context.state === 'suspended') {
      void context.resume().then(play).catch(() => {})
      return
    }
    play()
  }, [ensureAudioContext])

  const hasPendingReminder = useMemo(
    () => reminders.some((reminder) => isReminderPendingForCurrentUser(reminder, currentUserIds)),
    [reminders, currentUserIds]
  )

  const pendingSpecialDecisionReminders = useMemo(
    () =>
      reminders
        .filter(
          (reminder) =>
            isSpecialTransferDecisionReminder(reminder) &&
            isReminderPendingForCurrentUser(reminder, currentUserIds)
        )
        .sort((a, b) => {
          const createdAtA = parseEntityTimestamp(a?.createdAt)
          const createdAtB = parseEntityTimestamp(b?.createdAt)
          if (Number.isFinite(createdAtA) && Number.isFinite(createdAtB) && createdAtA !== createdAtB) {
            return createdAtA - createdAtB
          }
          if (Number.isFinite(createdAtA) && !Number.isFinite(createdAtB)) return -1
          if (!Number.isFinite(createdAtA) && Number.isFinite(createdAtB)) return 1

          const deadlineA = getReminderDeadlineTimestamp(a)
          const deadlineB = getReminderDeadlineTimestamp(b)
          if (Number.isFinite(deadlineA) && Number.isFinite(deadlineB) && deadlineA !== deadlineB) {
            return deadlineA - deadlineB
          }
          if (Number.isFinite(deadlineA) && !Number.isFinite(deadlineB)) return -1
          if (!Number.isFinite(deadlineA) && Number.isFinite(deadlineB)) return 1

          return String(a?.id || '').localeCompare(String(b?.id || ''))
        }),
    [currentUserIds, reminders]
  )

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const unlockAudio = () => {
      const context = ensureAudioContext()
      if (!context || context.state !== 'suspended') return
      void context.resume().catch(() => {})
    }

    window.addEventListener('pointerdown', unlockAudio, { once: true })
    window.addEventListener('keydown', unlockAudio, { once: true })

    return () => {
      window.removeEventListener('pointerdown', unlockAudio)
      window.removeEventListener('keydown', unlockAudio)
    }
  }, [ensureAudioContext])

  useEffect(
    () => () => {
      const notificationAudio = notificationAudioRef.current
      notificationAudioRef.current = null
      if (notificationAudio) {
        try {
          notificationAudio.pause()
          notificationAudio.src = ''
        } catch {
          // Ignore cleanup errors.
        }
      }

      const context = audioContextRef.current
      audioContextRef.current = null
      if (context && typeof context.close === 'function') {
        void context.close().catch(() => {})
      }
    },
    []
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const audio = new Audio(notificationAudioSrc)
    audio.preload = 'auto'
    audio.volume = 0.9
    notificationAudioRef.current = audio
  }, [])

  useEffect(() => {
    urgentVisualReminderIdsRef.current = new Set()
    seenUrgentReminderIdsRef.current = new Set()
    didInitUrgentSnapshotRef.current = false
    seenPendingShipmentUrgentIdsRef.current = new Set()
    didInitPendingShipmentUrgentSnapshotRef.current = false
    seenTransferResponseReminderIdsRef.current = new Set()
    didInitTransferResponseSnapshotRef.current = false
    setUrgentVisualProgressById({})
  }, [canDecideTransferRequest, token, currentPrimaryUserId])

  useEffect(() => {
    if (!canDecideTransferRequest || !token) {
      setPendingShipments([])
      setPendingShipmentsLoading(false)
      setIsPendingShipmentsOpen(false)
      setOpeningPendingShipmentId('')
      return
    }
    void fetchPendingTransferShipments()
  }, [canDecideTransferRequest, fetchPendingTransferShipments, token])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handleTransferSalidaModalState = (event) => {
      const isOpen = Boolean(event?.detail?.open)
      setIsTransferSendModalOpen(isOpen)
    }

    window.addEventListener(TRANSFER_SALIDA_MODAL_STATE_EVENT, handleTransferSalidaModalState)
    return () => {
      window.removeEventListener(TRANSFER_SALIDA_MODAL_STATE_EVENT, handleTransferSalidaModalState)
    }
  }, [])

  useEffect(() => {
    const wasOpen = wasTransferSendModalOpenRef.current
    wasTransferSendModalOpenRef.current = isTransferSendModalOpen
    if (!wasOpen || isTransferSendModalOpen) return
    if (!canDecideTransferRequest || !token) return
    void fetchPendingTransferShipments({ silent: true })
  }, [canDecideTransferRequest, fetchPendingTransferShipments, isTransferSendModalOpen, token])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (!token || !canDecideTransferRequest) return undefined

    let cancelled = false

    const syncPendingShipments = async () => {
      if (cancelled) return
      await fetchPendingTransferShipments({ silent: true })
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      void syncPendingShipments()
    }

    const handleFocus = () => {
      void syncPendingShipments()
    }

    void syncPendingShipments()
    const intervalId = window.setInterval(syncPendingShipments, REMINDERS_POLL_MS)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [canDecideTransferRequest, fetchPendingTransferShipments, token])

  useEffect(() => {
    if (hasPendingShipments) return
    setIsPendingShipmentsOpen(false)
  }, [hasPendingShipments])

  useEffect(() => {
    if (!isPendingShipmentsOpen) return undefined

    const handleClickOutside = (event) => {
      if (pendingShipmentsRef.current?.contains(event.target)) return
      setIsPendingShipmentsOpen(false)
    }

    const handleEscape = (event) => {
      if (event.key !== 'Escape') return
      setIsPendingShipmentsOpen(false)
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside, { passive: true })
    window.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [isPendingShipmentsOpen])

  const eligibleUrgentDecisionReminders = useMemo(() => {
    if (!allowUrgentShield || !canDecideTransferRequest) return []
    return pendingSpecialDecisionReminders.filter((reminder) => {
      const contextType = normalizeReminderContextType(reminder?.context?.type)
      return contextType === 'solicitud_traslado'
    })
  }, [allowUrgentShield, canDecideTransferRequest, pendingSpecialDecisionReminders])

  const pendingShipmentUrgentTargets = useMemo(() => {
    if (!allowUrgentShield || !canDecideTransferRequest || !hasPendingShipments || isTransferSendModalOpen) return []

    return (Array.isArray(pendingShipments) ? pendingShipments : [])
      .map((solicitud) => {
        const solicitudId = normalizeId(solicitud?.id)
        if (!solicitudId) return null

        return {
          id: `pending-shipment-${solicitudId}`,
          kind: 'pending_shipment',
          anchor: 'pending_shipments',
          message: URGENT_SHIPMENT_MESSAGE,
          priorityTimestamp: parseEntityTimestamp(
            solicitud?.created_at,
            solicitud?.createdAt,
            solicitud?.fecha
          ),
          solicitudId,
          solicitud,
        }
      })
      .filter(Boolean)
      .sort((a, b) => {
        const timeA = Number(a?.priorityTimestamp)
        const timeB = Number(b?.priorityTimestamp)
        if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) {
          return timeA - timeB
        }
        if (Number.isFinite(timeA) && !Number.isFinite(timeB)) return -1
        if (!Number.isFinite(timeA) && Number.isFinite(timeB)) return 1
        return String(a?.solicitudId || '').localeCompare(String(b?.solicitudId || ''))
      })
  }, [allowUrgentShield, canDecideTransferRequest, hasPendingShipments, isTransferSendModalOpen, pendingShipments])

  const urgentDecisionTargets = useMemo(
    () =>
      eligibleUrgentDecisionReminders
        .map((reminder) => {
          const reminderId = normalizeId(reminder?.id)
          if (!reminderId) return null

          const date = String(reminder?.date || '').trim()
          const time = String(reminder?.time || '').trim()
          const dateTimeCandidate = date ? `${date}T${time || '00:00'}:00` : ''

          return {
            id: reminderId,
            reminderId,
            kind: 'decision',
            anchor: 'top_right',
            message: URGENT_DECISION_MESSAGE,
            priorityTimestamp: parseEntityTimestamp(reminder?.createdAt, dateTimeCandidate),
            reminder,
          }
        })
        .filter(Boolean),
    [eligibleUrgentDecisionReminders]
  )

  const urgentShieldTargets = useMemo(() => {
    const merged = [...urgentDecisionTargets, ...pendingShipmentUrgentTargets]
    return merged.sort((a, b) => {
      const timeA = Number(a?.priorityTimestamp)
      const timeB = Number(b?.priorityTimestamp)
      if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) {
        return timeA - timeB
      }
      if (Number.isFinite(timeA) && !Number.isFinite(timeB)) return -1
      if (!Number.isFinite(timeA) && Number.isFinite(timeB)) return 1
      return String(a?.id || '').localeCompare(String(b?.id || ''))
    })
  }, [pendingShipmentUrgentTargets, urgentDecisionTargets])

  useEffect(() => {
    const nextIds = new Set(
      eligibleUrgentDecisionReminders
        .map((reminder) => normalizeId(reminder?.id))
        .filter(Boolean)
    )

    if (!didInitUrgentSnapshotRef.current) {
      seenUrgentReminderIdsRef.current = nextIds
      didInitUrgentSnapshotRef.current = true
      return
    }

    const seenIds = seenUrgentReminderIdsRef.current
    const newReminderIds = []
    nextIds.forEach((id) => {
      if (!seenIds.has(id)) newReminderIds.push(id)
    })
    seenUrgentReminderIdsRef.current = nextIds

    if (newReminderIds.length) {
      playNotificationTone()
      emitTransferReminderNotification({
        type: 'solicitud_traslado_pendiente',
        reminderIds: newReminderIds,
      })
    }
  }, [eligibleUrgentDecisionReminders, playNotificationTone])

  useEffect(() => {
    const nextIds = new Set(
      pendingShipmentUrgentTargets
        .map((target) => normalizeId(target?.id))
        .filter(Boolean)
    )

    if (!didInitPendingShipmentUrgentSnapshotRef.current) {
      seenPendingShipmentUrgentIdsRef.current = nextIds
      didInitPendingShipmentUrgentSnapshotRef.current = true
      return
    }

    const seenIds = seenPendingShipmentUrgentIdsRef.current
    const newPendingShipmentIds = []
    nextIds.forEach((id) => {
      if (!seenIds.has(id)) newPendingShipmentIds.push(id)
    })
    seenPendingShipmentUrgentIdsRef.current = nextIds

    if (newPendingShipmentIds.length) {
      playNotificationTone()
      emitTransferReminderNotification({
        type: 'solicitud_traslado_envio_pendiente',
        reminderIds: newPendingShipmentIds,
      })
    }
  }, [pendingShipmentUrgentTargets, playNotificationTone])

  const pendingTransferResponseReminders = useMemo(
    () =>
      reminders.filter((reminder) => {
        if (!isResolvedTransferResponseReminder(reminder)) return false
        if (!isReminderForCurrentUser(reminder, currentUserIds)) return false
        return !reminderCompletedByIds(reminder).some((id) => currentUserIds.has(id))
      }),
    [currentUserIds, reminders]
  )

  useEffect(() => {
    const nextIds = new Set(
      pendingTransferResponseReminders
        .map((reminder) => normalizeId(reminder?.id))
        .filter(Boolean)
    )

    if (!didInitTransferResponseSnapshotRef.current) {
      seenTransferResponseReminderIdsRef.current = nextIds
      didInitTransferResponseSnapshotRef.current = true
      return
    }

    const seenIds = seenTransferResponseReminderIdsRef.current
    const newReminderIds = []
    nextIds.forEach((id) => {
      if (!seenIds.has(id)) newReminderIds.push(id)
    })
    seenTransferResponseReminderIdsRef.current = nextIds

    if (newReminderIds.length) {
      playNotificationTone()
      emitTransferReminderNotification({
        type: 'solicitud_traslado_resuelta',
        reminderIds: newReminderIds,
      })
    }
  }, [pendingTransferResponseReminders, playNotificationTone])

  const urgentProgressById = useMemo(() => {
    const map = {}
    const now = Number(clockTick || Date.now())
    urgentShieldTargets.forEach((target) => {
      const targetId = normalizeId(target?.id)
      if (!targetId) return

      if (target?.kind === 'pending_shipment') {
        map[targetId] = resolveUrgentShipmentProgress(target?.solicitud, now)
        return
      }

      map[targetId] = resolveUrgentDecisionProgress(target?.reminder, now)
    })
    return map
  }, [clockTick, urgentShieldTargets])

  useEffect(() => {
    const nextIds = Object.keys(urgentProgressById)
    if (!nextIds.length) {
      urgentVisualReminderIdsRef.current = new Set()
      setUrgentVisualProgressById({})
      return undefined
    }

    const nextIdSet = new Set(nextIds)
    const previousIds = urgentVisualReminderIdsRef.current
    const newIds = nextIds.filter((id) => !previousIds.has(id))
    urgentVisualReminderIdsRef.current = nextIdSet

    setUrgentVisualProgressById((prev) => {
      const next = {}
      nextIds.forEach((id) => {
        if (newIds.includes(id)) {
          next[id] = 0
          return
        }
        const previous = Number(prev?.[id])
        next[id] = Number.isFinite(previous) ? previous : Number(urgentProgressById[id] || 0)
      })
      return next
    })

    if (newIds.length && typeof window !== 'undefined') {
      const frameId = window.requestAnimationFrame(() => {
        setUrgentVisualProgressById({ ...urgentProgressById })
      })
      return () => window.cancelAnimationFrame(frameId)
    }

    setUrgentVisualProgressById({ ...urgentProgressById })
    return undefined
  }, [urgentProgressById])

  const urgentShieldStyles = useMemo(() => {
    if (
      !urgentShieldTargets.length ||
      isReminderModalOpen ||
      isTransferSendModalOpen ||
      typeof window === 'undefined'
    ) {
      return []
    }
    void clockTick
    const viewportWidth = window.innerWidth
    const maxCanvas = Math.max(window.innerWidth, window.innerHeight) * 1.35
    const isMobileViewport = window.innerWidth <= 900
    const stackOffset = isMobileViewport
      ? URGENT_SHIELD_STACK_OFFSET_MOBILE
      : URGENT_SHIELD_STACK_OFFSET_DESKTOP
    const stackByAnchor = new Map()
    const resolveAnchorCenter = (anchor) => {
      if (anchor === 'pending_shipments') {
        const rect = pendingShipmentsTriggerRef.current?.getBoundingClientRect()
        if (rect && Number.isFinite(rect.left) && Number.isFinite(rect.top)) {
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          }
        }
      }
      return {
        x: viewportWidth,
        y: 0,
      }
    }

    return urgentShieldTargets
      .map((target, index) => {
        const targetId = normalizeId(target?.id)
        if (!targetId) return null

        const anchor = String(target?.anchor || 'top_right')
        const anchorStackIndex = Number(stackByAnchor.get(anchor) || 0)
        stackByAnchor.set(anchor, anchorStackIndex + 1)
        const progress = clamp01(
          urgentVisualProgressById[targetId] ?? urgentProgressById[targetId]
        )
        const size = Math.max(44, Math.round(44 + maxCanvas * progress))
        const offset = anchorStackIndex * stackOffset
        const anchorCenter = resolveAnchorCenter(anchor)
        const centerX = anchorCenter.x - offset
        const centerY = anchorCenter.y + offset

        return {
          id: targetId,
          reminderId: normalizeId(target?.reminderId),
          kind: target?.kind || 'decision',
          solicitudId: normalizeId(target?.solicitudId),
          message: String(target?.message || '').trim() || URGENT_DECISION_MESSAGE,
          target,
          progress,
          style: {
            width: `${size}px`,
            height: `${size}px`,
            left: `${centerX - size / 2}px`,
            top: `${centerY - size / 2}px`,
            '--urgency': String(progress.toFixed(3)),
            '--urgent-color':
              target?.kind === 'pending_shipment'
                ? URGENT_SHIPMENT_SHIELD_COLOR
                : URGENT_DECISION_SHIELD_COLOR,
            zIndex: String(Math.max(1200, 1299 - index)),
          },
        }
      })
      .filter(Boolean)
  }, [
    clockTick,
    isReminderModalOpen,
    isTransferSendModalOpen,
    urgentProgressById,
    urgentShieldTargets,
    urgentVisualProgressById,
  ])

  const activeUrgentShield = useMemo(() => {
    if (!urgentShieldStyles.length) return null
    return urgentShieldStyles[0]
  }, [urgentShieldStyles])

  const urgentMessageStyle = useMemo(() => {
    if (!activeUrgentShield?.style) return null
    const progress = clamp01(activeUrgentShield.progress)
    if (progress < URGENT_MESSAGE_REVEAL_PROGRESS) return null
    const activeUrgentMessage = String(activeUrgentShield?.message || URGENT_DECISION_MESSAGE).trim()
    if (!activeUrgentMessage) return null

    const shieldSize = Number.parseFloat(activeUrgentShield.style.width)
    const shieldLeft = Number.parseFloat(activeUrgentShield.style.left)
    const shieldTop = Number.parseFloat(activeUrgentShield.style.top)
    if (!Number.isFinite(shieldSize) || !Number.isFinite(shieldLeft) || !Number.isFinite(shieldTop)) {
      return null
    }

    const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth
    const viewportHeight = typeof window === 'undefined' ? 720 : window.innerHeight
    const isMobileViewport = viewportWidth <= 900
    const mobileScale = isMobileViewport
      ? Math.max(0.7, Math.min(1, viewportWidth / 420))
      : 1

    const shieldCenterX = shieldLeft + shieldSize / 2
    const shieldCenterY = shieldTop + shieldSize / 2
    const viewportCenterX = viewportWidth / 2
    const viewportCenterY = viewportHeight / 2
    const vectorX = viewportCenterX - shieldCenterX
    const vectorY = viewportCenterY - shieldCenterY

    const edgePadding = isMobileViewport ? 8 : 12
    const radius = shieldSize / 2
    const usableRadius = Math.max(1, radius - edgePadding)

    const minFont = isMobileViewport ? 10 : 12
    const maxFont = isMobileViewport ? Math.round(34 * mobileScale) : 64
    let fontSize = Math.round(minFont + (maxFont - minFont) * progress)

    const minWidth = isMobileViewport
      ? Math.max(120, Math.round(viewportWidth * 0.34))
      : 240
    const maxWidth = isMobileViewport
      ? Math.min(420, Math.round(viewportWidth * 0.78))
      : Math.min(980, viewportWidth - edgePadding * 2)
    const absoluteMinWidth = isMobileViewport ? 120 : 180
    const shieldInset = isMobileViewport ? 30 : 16
    let width = Math.round(minWidth + (maxWidth - minWidth) * progress)
    width = Math.max(
      absoluteMinWidth,
      Math.min(width, maxWidth, Math.max(absoluteMinWidth, shieldSize - shieldInset))
    )

    const estimateHeight = (boxWidth, size) => {
      const charsPerLine = Math.max(10, Math.floor(boxWidth / Math.max(1, size * 0.55)))
      const lines = Math.max(1, Math.ceil(activeUrgentMessage.length / charsPerLine))
      return Math.max(size * 1.25, lines * size * 1.22)
    }

    let height = estimateHeight(width, fontSize)
    let halfDiagonal = Math.hypot(width / 2, height / 2)

    while (halfDiagonal > usableRadius && fontSize > 9) {
      fontSize -= 1
      height = estimateHeight(width, fontSize)
      halfDiagonal = Math.hypot(width / 2, height / 2)
    }

    if (halfDiagonal > usableRadius) {
      width = Math.max(130, Math.min(width, Math.max(130, usableRadius * 1.35)))
      height = estimateHeight(width, fontSize)
      halfDiagonal = Math.hypot(width / 2, height / 2)
    }

    while (halfDiagonal > usableRadius && fontSize > (isMobileViewport ? 5 : 6)) {
      fontSize -= 1
      height = estimateHeight(width, fontSize)
      halfDiagonal = Math.hypot(width / 2, height / 2)
    }

    const minCenterX = edgePadding + width / 2
    const maxCenterX = viewportWidth - edgePadding - width / 2
    const minCenterY = edgePadding + height / 2
    const maxCenterY = viewportHeight - edgePadding - height / 2

    let maxTViewport = 1
    if (Math.abs(vectorX) > 0.001) {
      const tX = vectorX > 0 ? (maxCenterX - shieldCenterX) / vectorX : (minCenterX - shieldCenterX) / vectorX
      maxTViewport = Math.min(maxTViewport, tX)
    }
    if (Math.abs(vectorY) > 0.001) {
      const tY = vectorY > 0 ? (maxCenterY - shieldCenterY) / vectorY : (minCenterY - shieldCenterY) / vectorY
      maxTViewport = Math.min(maxTViewport, tY)
    }
    maxTViewport = clamp01(maxTViewport)

    let maxTCircle = 1
    const absVx = Math.abs(vectorX)
    const absVy = Math.abs(vectorY)
    const A = absVx * absVx + absVy * absVy
    const B = absVx * width + absVy * height
    const C = (width / 2) ** 2 + (height / 2) ** 2 - usableRadius ** 2

    if (A <= 1e-8) {
      maxTCircle = C <= 0 ? 1 : 0
    } else {
      const discriminant = B * B - 4 * A * C
      if (discriminant < 0) {
        maxTCircle = 0
      } else {
        maxTCircle = (-B + Math.sqrt(discriminant)) / (2 * A)
      }
    }
    maxTCircle = clamp01(maxTCircle)

    const travel = clamp01(Math.min(progress, maxTViewport, maxTCircle))
    const centerX = shieldCenterX + vectorX * travel
    const centerY = shieldCenterY + vectorY * travel
    const localLeft = centerX - shieldLeft
    const localTop = centerY - shieldTop

    return {
      left: `${localLeft}px`,
      top: `${localTop}px`,
      width: `${width}px`,
      fontSize: `${fontSize}px`,
      transform: 'translate(-50%, -50%)',
      lineHeight: isMobileViewport ? '1.1' : '1.2',
    }
  }, [activeUrgentShield])

  const personalReminders = useMemo(() => {
    const related = reminders.filter((reminder) => {
      if (!isReminderForCurrentUser(reminder, currentUserIds)) return false

      if (
        isResolvedTransferResponseReminder(reminder) &&
        isReminderCreatedByCurrentUser(reminder, currentUserIds, currentUserName)
      ) {
        return false
      }

      return true
    })
    return sortRemindersForCurrentUser(related, currentUserIds)
  }, [reminders, currentUserIds, currentUserName])

  const setBtnRef = (index) => (element) => {
    btnRefs.current[index] = element
  }

  const handleReminderButtonRef = useCallback((element) => {
    btnRefs.current[1] = element
    const hadButton = Boolean(reminderButtonRef.current)
    reminderButtonRef.current = element
    if (!hadButton && element) {
      setClockTick(Date.now())
    }
  }, [])

  const handlePendingShipmentsTriggerRef = useCallback((element) => {
    const hadButton = Boolean(pendingShipmentsTriggerRef.current)
    pendingShipmentsTriggerRef.current = element
    if (!hadButton && element) {
      setClockTick(Date.now())
    }
  }, [])

  const measure = (index) => {
    const wrap = wrapRef.current
    const button = btnRefs.current[index]
    if (!wrap || !button) return null

    const wrapRect = wrap.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()

    return {
      x: buttonRect.left - wrapRect.left,
      y: buttonRect.top - wrapRect.top,
      w: buttonRect.width,
      h: buttonRect.height,
    }
  }

  const startMoveFx = () => {
    if (moveTimerRef.current) clearTimeout(moveTimerRef.current)
    setIsMoving(true)
    moveTimerRef.current = setTimeout(() => setIsMoving(false), 420)
  }

  const showAndMove = (index) => {
    const measured = measure(index)
    if (!measured) return

    setBlob((prev) => ({
      ...prev,
      ...measured,
      visible: true,
    }))

    startMoveFx()
  }

  const hideBlob = () => {
    setBlob((prev) => ({ ...prev, visible: false }))
    setIsMoving(false)
  }

  useEffect(() => {
    const handleResize = () => {
      hideBlob()
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    return () => {
      if (moveTimerRef.current) clearTimeout(moveTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !urgentShieldStyles.length || isReminderModalOpen) return undefined
    const timer = window.setInterval(() => setClockTick(Date.now()), URGENT_SHIELD_TICK_MS)
    return () => window.clearInterval(timer)
  }, [isReminderModalOpen, urgentShieldStyles.length])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (!token) {
      setReminders([])
      return undefined
    }

    let cancelled = false

    const syncRemindersFromServer = async () => {
      if (remindersPollInFlightRef.current) return
      remindersPollInFlightRef.current = true
      try {
        const remote = await fetchRemindersFromBackend(token)
        if (cancelled) return
        setReminders(remote)
      } finally {
        remindersPollInFlightRef.current = false
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      void syncRemindersFromServer()
    }

    const handleFocus = () => {
      void syncRemindersFromServer()
    }

    void syncRemindersFromServer()
    const intervalId = window.setInterval(syncRemindersFromServer, REMINDERS_POLL_MS)

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [token])

  useEffect(() => {
    if (typeof window === 'undefined' || !urgentShieldStyles.length || isReminderModalOpen) return undefined
    const syncLayout = () => setClockTick(Date.now())

    window.addEventListener('resize', syncLayout)
    window.addEventListener('scroll', syncLayout, true)

    return () => {
      window.removeEventListener('resize', syncLayout)
      window.removeEventListener('scroll', syncLayout, true)
    }
  }, [isReminderModalOpen, urgentShieldStyles.length])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const syncReminders = (event) => {
      if (event?.type === 'storage' && event.key && event.key !== REMINDERS_STORAGE_KEY) return
      setReminders(readRemindersFromStorage())
    }

    window.addEventListener('storage', syncReminders)
    window.addEventListener(REMINDERS_SYNC_EVENT, syncReminders)

    return () => {
      window.removeEventListener('storage', syncReminders)
      window.removeEventListener(REMINDERS_SYNC_EVENT, syncReminders)
    }
  }, [])

  const applyReminderUpdate = useCallback((updater) => {
    setReminders((prev) => {
      const source = Array.isArray(prev) ? prev : []
      const next = typeof updater === 'function' ? updater(source) : updater
      const normalized = writeRemindersToStorage(next)
      emitRemindersSync()
      return normalized
    })
  }, [])

  const handleCreateReminder = ({ date, time, description, recipients, context }) => {
    const normalizedDate = String(date || '').trim()
    const normalizedTime = String(time || '').trim()
    const normalizedDescription = String(description || '').trim()
    const normalizedRecipients = (Array.isArray(recipients) ? recipients : [])
      .map(sanitizeRecipient)
      .filter(Boolean)

    if (!normalizedDate || !normalizedTime || !normalizedDescription || !normalizedRecipients.length) {
      return false
    }

    const contextType = normalizeId(context?.type)
    const contextId = normalizeId(context?.id)
    const normalizedContext =
      contextType && contextId
        ? {
            type: contextType,
            id: contextId,
            label: String(context?.label || '').trim(),
          }
        : null

    applyReminderUpdate((prev) => [
      {
        id: createReminderId(),
        date: normalizedDate,
        time: normalizedTime,
        description: normalizedDescription,
        creator: {
          id: currentPrimaryUserId,
          name: currentUserName,
        },
        recipients: normalizedRecipients,
        context: normalizedContext,
        createdAt: new Date().toISOString(),
        completedBy: [],
      },
      ...prev,
    ])

    return true
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

  const openReminderModal = useCallback(
    (reminderId = '') => {
      const normalizedReminderId = normalizeId(reminderId)
      if (normalizedReminderId) {
        setFocusReminderId(normalizedReminderId)
      }

      if (currentUserIdValues.length) {
        applyReminderUpdate((prev) => {
          let changed = false
          const next = (Array.isArray(prev) ? prev : []).map((reminder) => {
            if (!isResolvedTransferResponseReminder(reminder)) return reminder
            if (!isReminderForCurrentUser(reminder, currentUserIds)) return reminder

            const completedBySet = new Set(reminderCompletedByIds(reminder))
            let reminderChanged = false
            currentUserIdValues.forEach((id) => {
              if (!completedBySet.has(id)) {
                completedBySet.add(id)
                changed = true
                reminderChanged = true
              }
            })

            if (!reminderChanged) return reminder
            return {
              ...reminder,
              completedBy: Array.from(completedBySet),
            }
          })
          return changed ? next : prev
        })
      }

      setIsPendingShipmentsOpen(false)
      setIsReminderModalOpen(true)
    },
    [applyReminderUpdate, currentUserIdValues, currentUserIds]
  )

  const closeReminderModal = useCallback(() => {
    setIsReminderModalOpen(false)
    setFocusReminderId('')
  }, [])

  const togglePendingShipmentsPanel = async () => {
    if (!canDecideTransferRequest) return
    if (isPendingShipmentsOpen) {
      setIsPendingShipmentsOpen(false)
      return
    }
    setIsPendingShipmentsOpen(true)
    await fetchPendingTransferShipments()
  }

  const handleOpenPendingShipment = useCallback(
    async (solicitud) => {
      if (typeof onTransferDecisionAccepted !== 'function') return
      const solicitudId = normalizeId(solicitud?.id)
      if (!solicitudId) {
        showErrorToast('No se pudo abrir la solicitud seleccionada.')
        return
      }

      setOpeningPendingShipmentId(solicitudId)
      try {
        let payloadSolicitud = solicitud
        const needsDetail =
          !payloadSolicitud ||
          !Array.isArray(payloadSolicitud?.detalles) ||
          !payloadSolicitud.detalles.length
        if (needsDetail) {
          const detail = await fetchTransferSolicitudDetail(solicitudId)
          if (!detail) throw new Error('No se pudo obtener el detalle de la solicitud.')
          payloadSolicitud = detail
        }

        setIsTransferSendModalOpen(true)
        onTransferDecisionAccepted({
          solicitudId,
          solicitud: payloadSolicitud,
          nextAction: {
            sucursal_proveedora_id: String(payloadSolicitud?.sucursal_proveedora_id || '').trim(),
          },
        })
        setIsPendingShipmentsOpen(false)
      } catch (error) {
        setIsTransferSendModalOpen(false)
        showErrorToast(error?.message || 'No se pudo abrir la salida pendiente.')
      } finally {
        setOpeningPendingShipmentId('')
      }
    },
    [fetchTransferSolicitudDetail, onTransferDecisionAccepted, showErrorToast]
  )

  const handleUrgentShieldClick = useCallback(
    (shield) => {
      if (!shield) return
      if (shield.kind === 'pending_shipment') {
        if (shield.target?.solicitud) {
          void handleOpenPendingShipment(shield.target.solicitud)
          return
        }
        if (!isPendingShipmentsOpen) {
          setIsPendingShipmentsOpen(true)
        }
        void fetchPendingTransferShipments()
        return
      }

      openReminderModal(shield.reminderId)
    },
    [fetchPendingTransferShipments, handleOpenPendingShipment, isPendingShipmentsOpen, openReminderModal]
  )

  return (
    <>
      <Toast ref={toast} />
      {urgentShieldStyles.map((shield) => (
        <button
          key={`quick-actions-urgent-shield-${shield.id}`}
          type="button"
          className="quick-actions__urgent-shield"
          style={shield.style}
          onClick={() => handleUrgentShieldClick(shield)}
          aria-label={
            shield.kind === 'pending_shipment'
              ? 'Abrir envio pendiente de traslado'
              : 'Resolver solicitud de traslado pendiente'
          }
        >
          {shield.id === activeUrgentShield?.id && urgentMessageStyle && (
            <span className="quick-actions__urgent-message" style={urgentMessageStyle} aria-hidden="true">
              {activeUrgentShield?.message || URGENT_DECISION_MESSAGE}
            </span>
          )}
        </button>
      ))}
      <div className={`quick-actions__dock ${darkMode ? 'dark' : 'light'}${urgentShieldStyles.length ? ' has-urgent-shield' : ''}`}>
        {canDecideTransferRequest && hasPendingShipments && (
          <div
            ref={pendingShipmentsRef}
            className={`quick-actions__pending-shipments${isPendingShipmentsOpen ? ' is-open' : ''}`}
          >
            <button
              ref={handlePendingShipmentsTriggerRef}
              type="button"
              className="quick-actions__pending-shipments-trigger"
              onClick={() => void togglePendingShipmentsPanel()}
              aria-label="Envios pendientes"
            >
              <span>Envios pendientes</span>
              <span className="quick-actions__pending-shipments-count">
                {pendingShipmentsLoading ? '...' : pendingShipments.length}
              </span>
            </button>

            {isPendingShipmentsOpen && (
              <div className="quick-actions__pending-shipments-panel" role="dialog" aria-label="Envios pendientes">
                <div className="quick-actions__pending-shipments-head">
                  <strong>Solicitudes por enviar</strong>
                  <button
                    type="button"
                    className="quick-actions__pending-shipments-refresh"
                    onClick={() => void fetchPendingTransferShipments()}
                    disabled={pendingShipmentsLoading}
                    aria-label="Actualizar envios pendientes"
                  >
                    <i className="pi pi-refresh" aria-hidden="true" />
                  </button>
                </div>

                <div className="quick-actions__pending-shipments-list">
                  {pendingShipmentsLoading ? (
                    <p
                      className="quick-actions__pending-shipments-empty quick-actions__pending-shipments-loading"
                      role="status"
                      aria-live="polite"
                    >
                      <Loader2 size={14} />
                      <span>Cargando envios pendientes...</span>
                    </p>
                  ) : !pendingShipments.length ? (
                    <p className="quick-actions__pending-shipments-empty">No hay envios pendientes.</p>
                  ) : (
                    pendingShipments.map((solicitud) => {
                      const solicitudId = normalizeId(solicitud?.id)
                      const isOpening = solicitudId && openingPendingShipmentId === solicitudId
                      const doc = String(solicitud?.no_documento || solicitudId || '').trim()
                      const solicitante = String(solicitud?.sucursal_solicitante || '').trim() || 'Sucursal solicitante'
                      const fecha = String(solicitud?.fecha || '').trim()

                      return (
                        <button
                          key={`pending-shipment-${solicitudId || doc || 'row'}`}
                          type="button"
                          className="quick-actions__pending-shipments-item"
                          onClick={() => void handleOpenPendingShipment(solicitud)}
                          disabled={Boolean(isOpening)}
                        >
                          <span className="quick-actions__pending-shipments-item-title">
                            {doc ? `#${doc}` : 'Solicitud sin documento'}
                          </span>
                          <span className="quick-actions__pending-shipments-item-meta">
                            Destino: {solicitante}
                          </span>
                          <span className="quick-actions__pending-shipments-item-meta">
                            {isOpening
                              ? 'Abriendo...'
                              : (fecha ? `Fecha: ${fecha}` : 'Abrir en salidas')}
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div
          ref={wrapRef}
          className={`quick-actions ${darkMode ? 'dark' : 'light'}${urgentShieldStyles.length ? ' has-urgent-shield' : ''}`}
          onMouseLeave={hideBlob}
        >
          <span
            className={[
              'quick-actions__blob',
              blob.visible ? 'is-visible' : '',
              isMoving ? 'is-moving' : '',
            ].join(' ')}
            style={{
              transform: `translate3d(${blob.x}px, ${blob.y}px, 0)`,
              width: `${blob.w}px`,
              height: `${blob.h}px`,
            }}
            aria-hidden="true"
          />

          <button
            ref={setBtnRef(0)}
            type="button"
            className="quick-actions__button"
            aria-label="Buscar"
            onMouseEnter={() => showAndMove(0)}
            onFocus={() => showAndMove(0)}
          >
            <Search />
          </button>

          <button
            ref={handleReminderButtonRef}
            type="button"
            className={`quick-actions__button quick-actions__button--reminders${isReminderModalOpen ? ' is-active' : ''}`}
            aria-label="Recordatorios"
            onClick={() => openReminderModal()}
            onMouseEnter={() => showAndMove(1)}
            onFocus={() => showAndMove(1)}
          >
            <Bell />
            {hasPendingReminder && (
              <span
                className="quick-actions__pending-dot"
                aria-hidden="true"
              />
            )}
          </button>

          <button
            ref={setBtnRef(2)}
            type="button"
            className="quick-actions__button"
            aria-label={darkMode ? 'Activar modo claro' : 'Activar modo oscuro'}
            onClick={onToggleTheme}
            onMouseEnter={() => showAndMove(2)}
            onFocus={() => showAndMove(2)}
          >
            {darkMode ? <SunMedium /> : <Moon />}
          </button>
        </div>
      </div>

      <RecordatoriosPopup
        open={isReminderModalOpen}
        onClose={closeReminderModal}
        token={token}
        currentUser={user}
        currentUserName={currentUserName}
        currentUserIds={currentUserIdValues}
        reminders={personalReminders}
        onCreateReminder={handleCreateReminder}
        onMarkReminderSeen={handleMarkReminderSeen}
        darkMode={darkMode}
        onError={showErrorToast}
        onApplyRemindersUpdate={applyReminderUpdate}
        focusReminderId={focusReminderId}
        onFocusReminderHandled={() => setFocusReminderId('')}
        onTransferDecisionAccepted={onTransferDecisionAccepted}
        onOpenTransferRequestInEntradas={onOpenTransferRequestInEntradas}
      />
    </>
  )
}

export default QuickActions
