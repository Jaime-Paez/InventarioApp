import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bell, Loader2, Moon, Search, SunMedium, X } from 'lucide-react'
import { Toast } from 'primereact/toast'
import './QuickActions.css'
import RecordatoriosPopup from './RecordatoriosPopup'
import notificationAudioSrc from '../common/reminders/notifications.mp3'
import { API_URL, authFetch } from '../../../utils/api'
import {
  requestSystemNotificationPermission,
  showSystemNotification,
} from '../../../utils/systemNotifications'
import {
  REMINDERS_STORAGE_KEY,
  REMINDERS_SYNC_EVENT,
  RANDOM_INSPECTION_VERIFY_KIND,
  TRANSFER_RECEIPT_NOTIFICATION_KIND,
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
  isReminderSeenByCurrentUser,
  isRandomInspectionReminder,
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
const RANDOM_INSPECTION_DETAIL_ENDPOINT = `${API_URL}/recordatorios/inspeccion-aleatoria`
const RANDOM_INSPECTION_VERIFY_ITEM_ENDPOINT = `${API_URL}/recordatorios/inspeccion-aleatoria/items`

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))
const toPositiveInt = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, parsed)
}
const nowReminderDateTime = () => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    iso: now.toISOString(),
  }
}
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

const normalizeSearchText = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()

const normalizeString = (value) => String(value ?? '').trim().toLowerCase()

const normalizeModuleScopes = (rawScopes) => {
  const scopes = {}
  ;(Array.isArray(rawScopes) ? rawScopes : []).forEach((item) => {
    const moduleKey = normalizeString(item?.modulo)
    if (!moduleKey) return
    const ids = (Array.isArray(item?.sucursales_ids) ? item.sucursales_ids : [])
      .map((branchId) => normalizeId(branchId))
      .filter(Boolean)
    if (!ids.length) return
    scopes[moduleKey] = ids
  })
  return scopes
}

const hasModuleBranchAccess = (userItem, moduleKey, branchId) => {
  const normalizedModule = normalizeString(moduleKey)
  const normalizedBranchId = normalizeId(branchId)
  if (!normalizedModule || !normalizedBranchId) return false
  const ids = userItem?.moduleScopes?.[normalizedModule]
  return Array.isArray(ids) && ids.includes(normalizedBranchId)
}

const isResolvedTransferResponseReminder = (reminder) => {
  const contextType = normalizeReminderContextType(reminder?.context?.type)
  if (contextType !== 'solicitud_traslado') return false
  if (isSpecialTransferDecisionReminder(reminder)) return false

  const reminderKind = normalizeId(reminder?.kind)
  if (reminderKind === TRANSFER_RECEIPT_NOTIFICATION_KIND) return true

  const normalizedDescription = normalizeSearchText(reminder?.description)
  if (
    normalizedDescription.includes('llego completo') ||
    normalizedDescription.includes('llego incompleto')
  ) {
    return true
  }

  const decisionStatus = getReminderDecisionStatus(reminder)
  return decisionStatus === 'aceptada' || decisionStatus === 'rechazada' || decisionStatus === 'enviado'
}

const shouldHideSelfResolvedTransferResponseReminder = (reminder) => {
  if (!isResolvedTransferResponseReminder(reminder)) return false
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
  onOpenTransferRequestInSalidas,
  onOpenInventoryReviewSection,
  allowUrgentShield = true,
}) {
  const wrapRef = useRef(null)
  const btnRefs = useRef([])
  const reminderButtonRef = useRef(null)
  const pendingShipmentsRef = useRef(null)
  const pendingShipmentsTriggerRef = useRef(null)
  const inTransitShipmentsRef = useRef(null)
  const inTransitShipmentsTriggerRef = useRef(null)
  const moveTimerRef = useRef(null)
  const remindersPollInFlightRef = useRef(false)
  const pendingShipmentsPollInFlightRef = useRef(false)
  const inTransitShipmentsPollInFlightRef = useRef(false)
  const receiveLocationSearchDebounceRef = useRef({})
  const receiveLocationDropdownRefs = useRef({})
  const audioContextRef = useRef(null)
  const notificationAudioRef = useRef(null)
  const didPlayLoginToneRef = useRef(false)
  const didInitUrgentSnapshotRef = useRef(false)
  const seenUrgentReminderIdsRef = useRef(new Set())
  const didInitPendingShipmentUrgentSnapshotRef = useRef(false)
  const seenPendingShipmentUrgentIdsRef = useRef(new Set())
  const didInitTransferResponseSnapshotRef = useRef(false)
  const seenTransferResponseReminderIdsRef = useRef(new Set())
  const didInitRandomInspectionSnapshotRef = useRef(false)
  const seenRandomInspectionReminderIdsRef = useRef(new Set())
  const didPlayInitialPendingToneRef = useRef(false)
  const didRequestSystemNotificationPermissionRef = useRef(false)
  const toast = useRef(null)

  const [blob, setBlob] = useState({ x: 0, y: 0, w: 0, h: 0, visible: false })
  const [isMoving, setIsMoving] = useState(false)
  const [isReminderModalOpen, setIsReminderModalOpen] = useState(false)
  const [isPendingShipmentsOpen, setIsPendingShipmentsOpen] = useState(false)
  const [isInTransitShipmentsOpen, setIsInTransitShipmentsOpen] = useState(false)
  const [isTransferSendModalOpen, setIsTransferSendModalOpen] = useState(false)
  const [isReceiveShipmentModalOpen, setIsReceiveShipmentModalOpen] = useState(false)
  const [isRandomInspectionModalOpen, setIsRandomInspectionModalOpen] = useState(false)
  const [reminders, setReminders] = useState(() => readRemindersFromStorage())
  const [pendingShipments, setPendingShipments] = useState([])
  const [inTransitShipments, setInTransitShipments] = useState([])
  const [pendingShipmentsLoading, setPendingShipmentsLoading] = useState(false)
  const [inTransitShipmentsLoading, setInTransitShipmentsLoading] = useState(false)
  const [openingPendingShipmentId, setOpeningPendingShipmentId] = useState('')
  const [openingInTransitShipmentId, setOpeningInTransitShipmentId] = useState('')
  const [activeInTransitShipment, setActiveInTransitShipment] = useState(null)
  const [inTransitBodegas, setInTransitBodegas] = useState([])
  const [inTransitDivisions, setInTransitDivisions] = useState([])
  const [inTransitSubdivisions, setInTransitSubdivisions] = useState([])
  const [inTransitSubdivisionsLoading, setInTransitSubdivisionsLoading] = useState(false)
  const [receiveShipmentDraftByProductId, setReceiveShipmentDraftByProductId] = useState({})
  const [receiveShipmentSubmitting, setReceiveShipmentSubmitting] = useState(false)
  const [receiveShipmentError, setReceiveShipmentError] = useState('')
  const [activeRandomInspection, setActiveRandomInspection] = useState(null)
  const [randomInspectionDraftByItemId, setRandomInspectionDraftByItemId] = useState({})
  const [randomInspectionMode, setRandomInspectionMode] = useState('review')
  const [randomInspectionLoading, setRandomInspectionLoading] = useState(false)
  const [randomInspectionSubmitting, setRandomInspectionSubmitting] = useState(false)
  const [randomInspectionError, setRandomInspectionError] = useState('')
  const [activeReceiveLocationDropdown, setActiveReceiveLocationDropdown] = useState({
    productId: '',
    field: '',
  })
  const [clockTick, setClockTick] = useState(() => Date.now())
  const [focusReminderId, setFocusReminderId] = useState('')
  const [urgentVisualProgressById, setUrgentVisualProgressById] = useState({})
  const urgentVisualReminderIdsRef = useRef(new Set())
  const wasTransferSendModalOpenRef = useRef(false)

  const currentUserIds = useMemo(() => buildUserIdSet(user), [user])
  const currentUserIdValues = useMemo(() => Array.from(currentUserIds), [currentUserIds])
  const currentPrimaryUserId = currentUserIdValues[0] || ''
  const currentUserName = useMemo(() => formatCurrentUserName(user), [user])
  const isAdministrator = useMemo(
    () => Boolean(
      user?.is_superuser ||
        user?.is_staff ||
        user?.es_administrador ||
        normalizeString(user?.rol) === 'administrador'
    ),
    [user]
  )
  const suppressAdminAlerts = isAdministrator
  const allowVisualUrgentShield = allowUrgentShield && !suppressAdminAlerts
  const hasPendingShipments = pendingShipments.length > 0
  const hasInTransitShipments = inTransitShipments.length > 0
  const shouldAnimatePendingShipments = !suppressAdminAlerts && hasPendingShipments
  const canDecideTransferRequest = useMemo(() => {
    if (user?.is_staff || user?.is_superuser) return true
    if (!Array.isArray(user?.permisos)) return false
    const permissions = user.permisos
    const salidasPermission = permissions.find(
      (permission) => String(permission?.modulo || '').trim().toLowerCase() === 'movimientos_salidas'
    )
    return Boolean(salidasPermission?.puede_crear || salidasPermission?.puede_actualizar)
  }, [user])
  const canReceiveTransferRequest = useMemo(() => {
    if (user?.is_staff || user?.is_superuser) return true
    if (!Array.isArray(user?.permisos)) return false
    const permissions = user.permisos
    const entradasPermission = permissions.find(
      (permission) => String(permission?.modulo || '').trim().toLowerCase() === 'movimientos_entradas'
    )
    return Boolean(entradasPermission?.puede_crear || entradasPermission?.puede_actualizar)
  }, [user])
  const canViewInTransitShipments = isAdministrator && canReceiveTransferRequest

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

  const fetchInTransitTransferShipments = useCallback(async ({ silent = false } = {}) => {
    if (!token || !canViewInTransitShipments) {
      setInTransitShipments([])
      return []
    }

    if (inTransitShipmentsPollInFlightRef.current) return []
    inTransitShipmentsPollInFlightRef.current = true
    if (!silent) setInTransitShipmentsLoading(true)

    try {
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/envios-en-camino/?page_size=200`,
        {},
        token
      )
      if (!response.ok) {
        throw new Error('No se pudieron cargar los envios en camino.')
      }

      const payload = await response.json().catch(() => ({}))
      const rows = parseApiList(payload).sort((a, b) => {
        const dateA = parseEntityTimestamp(a?.fecha, a?.created_at, a?.updated_at)
        const dateB = parseEntityTimestamp(b?.fecha, b?.created_at, b?.updated_at)
        if (Number.isFinite(dateA) && Number.isFinite(dateB) && dateA !== dateB) {
          return dateB - dateA
        }
        return Number(b?.id || 0) - Number(a?.id || 0)
      })
      setInTransitShipments(rows)
      return rows
    } catch (error) {
      if (!silent) setInTransitShipments([])
      if (!silent) {
        showErrorToast(error?.message || 'No se pudieron cargar los envios en camino.')
      }
      return []
    } finally {
      inTransitShipmentsPollInFlightRef.current = false
      if (!silent) setInTransitShipmentsLoading(false)
    }
  }, [canReceiveTransferRequest, showErrorToast, token])

  const fetchPreferredReceiveSubdivisions = useCallback(
    async ({ sucursalSolicitanteId, productIds }) => {
      const targetBranchId = normalizeId(sucursalSolicitanteId)
      const normalizedProductIds = Array.from(
        new Set(
          (Array.isArray(productIds) ? productIds : [])
            .map((productId) => normalizeId(productId))
            .filter(Boolean)
        )
      )
      if (!token || !targetBranchId || !normalizedProductIds.length) {
        return new Map()
      }

      const baseUrl = `${API_URL}/inventario/inventario/?producto_ids=${encodeURIComponent(
        normalizedProductIds.join(',')
      )}&page_size=500`
      const allowedProductIds = new Set(normalizedProductIds)
      const totalsByProduct = new Map()

      try {
        let nextUrl = baseUrl
        let safety = 0
        while (nextUrl && safety < 10) {
          safety += 1
          const response = await authFetch(nextUrl, {}, token)
          if (!response.ok) {
            return new Map()
          }

          const payload = await response.json().catch(() => ({}))
          const rows = Array.isArray(payload) ? payload : parseApiList(payload)
          rows.forEach((row) => {
            const productId = normalizeId(row?.producto_id || row?.producto?.id || '')
            if (!productId || !allowedProductIds.has(productId)) return

            const subdivisionId = normalizeId(row?.subdivision_id || row?.subdivision?.id || '')
            if (!subdivisionId) return

            const branchId = normalizeId(
              row?.subdivision?.division?.bodega?.sucursal?.id ||
                row?.subdivision?.division?.bodega?.sucursal_id ||
                ''
            )
            if (branchId !== targetBranchId) return

            const qty = toPositiveInt(row?.cantidad, 0)
            if (qty <= 0) return

            const productTotals = totalsByProduct.get(productId) || new Map()
            productTotals.set(subdivisionId, toPositiveInt(productTotals.get(subdivisionId), 0) + qty)
            totalsByProduct.set(productId, productTotals)
          })

          if (Array.isArray(payload)) break
          nextUrl = payload?.next || null
        }

        const preferredByProduct = new Map()
        totalsByProduct.forEach((subdivisionTotals, productId) => {
          let bestSubdivisionId = ''
          let bestQty = -1
          subdivisionTotals.forEach((qty, subdivisionId) => {
            const numericSubdivisionId = Number.parseInt(String(subdivisionId), 10)
            const numericBestSubdivisionId = Number.parseInt(String(bestSubdivisionId), 10)
            const shouldReplace =
              qty > bestQty ||
              (qty === bestQty &&
                Number.isFinite(numericSubdivisionId) &&
                Number.isFinite(numericBestSubdivisionId) &&
                numericSubdivisionId < numericBestSubdivisionId)
            if (shouldReplace) {
              bestSubdivisionId = subdivisionId
              bestQty = qty
            }
          })
          if (bestSubdivisionId) {
            preferredByProduct.set(productId, bestSubdivisionId)
          }
        })

        return preferredByProduct
      } catch {
        return new Map()
      }
    },
    [token]
  )

  const ensureAudioContext = useCallback(() => {
    if (typeof window === 'undefined') return null
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext
    if (!AudioContextCtor) return null
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextCtor()
    }
    return audioContextRef.current
  }, [])

  const playNotificationTone = useCallback((options = {}) => {
    const forceForAdmin = Boolean(options?.forceForAdmin)
    if (suppressAdminAlerts && !forceForAdmin) return
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
  }, [ensureAudioContext, suppressAdminAlerts])

  const pushSystemTransferNotification = useCallback((notificationDetail) => {
    if (suppressAdminAlerts) return
    const notificationType = normalizeReminderContextType(notificationDetail?.type)
    if (!notificationType) return

    const reminderIds = Array.isArray(notificationDetail?.reminderIds)
      ? notificationDetail.reminderIds.filter(Boolean)
      : []
    const count = Math.max(1, reminderIds.length || Number(notificationDetail?.count) || 0)

    let title = ''
    let body = ''
    if (notificationType === 'solicitud_traslado_pendiente') {
      title = count > 1 ? `Tienes ${count} solicitudes de traslado pendientes.` : 'Tienes una solicitud de traslado pendiente.'
      body = 'Revisa Recordatorios para aceptar o rechazar.'
    } else if (notificationType === 'solicitud_traslado_envio_pendiente') {
      title = count > 1 ? `Tienes ${count} envios pendientes por despachar.` : 'Tienes un envio pendiente por despachar.'
      body = 'Abre Envios pendientes para continuar.'
    } else if (notificationType === 'solicitud_traslado_resuelta') {
      title = count > 1 ? `Tienes ${count} novedades de traslados.` : 'Tienes una novedad de traslado.'
      body = 'Revisa Recordatorios para ver el ultimo avance.'
    } else {
      return
    }

    void showSystemNotification({
      title,
      body,
      tag: `inventario-${notificationType}`,
      url: '/',
      requireInteraction: true,
    })
  }, [suppressAdminAlerts])

  const playInitialPendingToneIfNeeded = useCallback(
    (ids, notificationDetail, options = {}) => {
      const allowAdminTone = Boolean(options?.allowAdminTone)
      if (suppressAdminAlerts && !allowAdminTone) return
      if (didPlayInitialPendingToneRef.current) return
      const normalizedIds = Array.from(ids || []).map((id) => normalizeId(id)).filter(Boolean)
      if (!normalizedIds.length) return

      didPlayInitialPendingToneRef.current = true
      playNotificationTone({ forceForAdmin: allowAdminTone })
      if (notificationDetail?.type) {
        const nextDetail = {
          ...notificationDetail,
          reminderIds: normalizedIds,
        }
        emitTransferReminderNotification({
          ...nextDetail,
        })
        pushSystemTransferNotification(nextDetail)
      }
    },
    [playNotificationTone, pushSystemTransferNotification, suppressAdminAlerts]
  )

  const pendingRemindersForCurrentUser = useMemo(
    () => reminders.filter((reminder) => isReminderPendingForCurrentUser(reminder, currentUserIds)),
    [reminders, currentUserIds]
  )

  const hasPendingReminder = useMemo(
    () => !suppressAdminAlerts && pendingRemindersForCurrentUser.length > 0,
    [pendingRemindersForCurrentUser, suppressAdminAlerts]
  )

  const mobileShipmentCount = canViewInTransitShipments
    ? pendingShipments.length + inTransitShipments.length
    : 0

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
    if (suppressAdminAlerts) return undefined
    if (typeof window === 'undefined') return undefined

    const unlockAudioAndNotifications = () => {
      const context = ensureAudioContext()
      if (context && context.state === 'suspended') {
        void context.resume().catch(() => {})
      }

      if (didRequestSystemNotificationPermissionRef.current) return
      didRequestSystemNotificationPermissionRef.current = true
      void requestSystemNotificationPermission({ prompt: true })
    }

    window.addEventListener('pointerdown', unlockAudioAndNotifications, { once: true })
    window.addEventListener('keydown', unlockAudioAndNotifications, { once: true })

    return () => {
      window.removeEventListener('pointerdown', unlockAudioAndNotifications)
      window.removeEventListener('keydown', unlockAudioAndNotifications)
    }
  }, [ensureAudioContext, suppressAdminAlerts])

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
    if (suppressAdminAlerts) return
    if (typeof window === 'undefined') return
    const audio = new Audio(notificationAudioSrc)
    audio.preload = 'auto'
    audio.volume = 0.9
    notificationAudioRef.current = audio
  }, [suppressAdminAlerts])

  useEffect(() => {
    urgentVisualReminderIdsRef.current = new Set()
    seenUrgentReminderIdsRef.current = new Set()
    didInitUrgentSnapshotRef.current = false
    seenPendingShipmentUrgentIdsRef.current = new Set()
    didInitPendingShipmentUrgentSnapshotRef.current = false
    seenTransferResponseReminderIdsRef.current = new Set()
    didInitTransferResponseSnapshotRef.current = false
    didPlayInitialPendingToneRef.current = false
    setUrgentVisualProgressById({})
  }, [canDecideTransferRequest, token, currentPrimaryUserId, suppressAdminAlerts])

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
    if (!canViewInTransitShipments || !token) {
      setInTransitShipments([])
      setInTransitShipmentsLoading(false)
      setIsInTransitShipmentsOpen(false)
      setOpeningInTransitShipmentId('')
      return
    }
    void fetchInTransitTransferShipments()
  }, [canViewInTransitShipments, fetchInTransitTransferShipments, token])

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
    if (!token || !canViewInTransitShipments) return
    if (isReceiveShipmentModalOpen) return
    void fetchInTransitTransferShipments({ silent: true })
  }, [canViewInTransitShipments, fetchInTransitTransferShipments, isReceiveShipmentModalOpen, token])

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
    if (typeof window === 'undefined') return undefined
    if (!token || !canViewInTransitShipments) return undefined

    let cancelled = false

    const syncInTransitShipments = async () => {
      if (cancelled) return
      await fetchInTransitTransferShipments({ silent: true })
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      void syncInTransitShipments()
    }

    const handleFocus = () => {
      void syncInTransitShipments()
    }

    void syncInTransitShipments()
    const intervalId = window.setInterval(syncInTransitShipments, REMINDERS_POLL_MS)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [canViewInTransitShipments, fetchInTransitTransferShipments, token])

  useEffect(() => {
    if (hasPendingShipments) return
    setIsPendingShipmentsOpen(false)
  }, [hasPendingShipments])

  useEffect(() => {
    if (hasInTransitShipments) return
    setIsInTransitShipmentsOpen(false)
  }, [hasInTransitShipments])

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

  useEffect(() => {
    if (!isInTransitShipmentsOpen) return undefined

    const handleClickOutside = (event) => {
      if (inTransitShipmentsRef.current?.contains(event.target)) return
      setIsInTransitShipmentsOpen(false)
    }

    const handleEscape = (event) => {
      if (event.key !== 'Escape') return
      setIsInTransitShipmentsOpen(false)
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside, { passive: true })
    window.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [isInTransitShipmentsOpen])

  const eligibleUrgentDecisionReminders = useMemo(() => {
    if (!allowVisualUrgentShield || !canDecideTransferRequest) return []
    return pendingSpecialDecisionReminders.filter((reminder) => {
      const contextType = normalizeReminderContextType(reminder?.context?.type)
      return contextType === 'solicitud_traslado'
    })
  }, [allowVisualUrgentShield, canDecideTransferRequest, pendingSpecialDecisionReminders])

  const pendingShipmentUrgentTargets = useMemo(() => {
    if (!allowVisualUrgentShield || !canDecideTransferRequest || !hasPendingShipments || isTransferSendModalOpen) return []

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
  }, [allowVisualUrgentShield, canDecideTransferRequest, hasPendingShipments, isTransferSendModalOpen, pendingShipments])

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
      playInitialPendingToneIfNeeded(nextIds, {
        type: 'solicitud_traslado_pendiente',
      })
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
      const notificationDetail = {
        type: 'solicitud_traslado_pendiente',
        reminderIds: newReminderIds,
      }
      emitTransferReminderNotification(notificationDetail)
      pushSystemTransferNotification(notificationDetail)
    }
  }, [
    eligibleUrgentDecisionReminders,
    playInitialPendingToneIfNeeded,
    playNotificationTone,
    pushSystemTransferNotification,
  ])

  const randomInspectionReminders = useMemo(
    () =>
      reminders.filter(
        (reminder) =>
          isRandomInspectionReminder(reminder) &&
          isReminderForCurrentUser(reminder, currentUserIds) &&
          !isReminderSeenByCurrentUser(reminder, currentUserIds)
      ),
    [currentUserIds, reminders]
  )

  useEffect(() => {
    const nextIds = new Set(
      randomInspectionReminders
        .map((reminder) => normalizeId(reminder?.id))
        .filter(Boolean)
    )

    if (!didInitRandomInspectionSnapshotRef.current) {
      seenRandomInspectionReminderIdsRef.current = nextIds
      didInitRandomInspectionSnapshotRef.current = true
      playInitialPendingToneIfNeeded(nextIds, {
        type: 'inspeccion_aleatoria_diaria',
      })
      return
    }

    const seenIds = seenRandomInspectionReminderIdsRef.current
    const newReminderIds = []
    nextIds.forEach((id) => {
      if (!seenIds.has(id)) newReminderIds.push(id)
    })
    seenRandomInspectionReminderIdsRef.current = nextIds

    if (newReminderIds.length) {
      playNotificationTone()
      void showSystemNotification({
        title: 'Tienes una inspección aleatoria pendiente',
        body: `Revisa ${newReminderIds.length} recordatorio(s) de inspección.`,
        tag: 'inventario-inspeccion-aleatoria',
        url: '/',
        requireInteraction: true,
      })
    }
  }, [randomInspectionReminders, playInitialPendingToneIfNeeded, playNotificationTone])

  useEffect(() => {
    const nextIds = new Set(
      pendingShipmentUrgentTargets
        .map((target) => normalizeId(target?.id))
        .filter(Boolean)
    )

    if (!didInitPendingShipmentUrgentSnapshotRef.current) {
      seenPendingShipmentUrgentIdsRef.current = nextIds
      didInitPendingShipmentUrgentSnapshotRef.current = true
      playInitialPendingToneIfNeeded(nextIds, {
        type: 'solicitud_traslado_envio_pendiente',
      })
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
      const notificationDetail = {
        type: 'solicitud_traslado_envio_pendiente',
        reminderIds: newPendingShipmentIds,
      }
      emitTransferReminderNotification(notificationDetail)
      pushSystemTransferNotification(notificationDetail)
    }
  }, [
    pendingShipmentUrgentTargets,
    playInitialPendingToneIfNeeded,
    playNotificationTone,
    pushSystemTransferNotification,
  ])

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
	      playInitialPendingToneIfNeeded(nextIds, {
	        type: 'solicitud_traslado_resuelta',
	      }, { allowAdminTone: true })
	      return
	    }

    const seenIds = seenTransferResponseReminderIdsRef.current
    const newReminderIds = []
    nextIds.forEach((id) => {
      if (!seenIds.has(id)) newReminderIds.push(id)
    })
    seenTransferResponseReminderIdsRef.current = nextIds

	    if (newReminderIds.length) {
	      playNotificationTone({ forceForAdmin: true })
	      const notificationDetail = {
	        type: 'solicitud_traslado_resuelta',
	        reminderIds: newReminderIds,
      }
      emitTransferReminderNotification(notificationDetail)
      pushSystemTransferNotification(notificationDetail)
    }
  }, [
    pendingTransferResponseReminders,
    playInitialPendingToneIfNeeded,
    playNotificationTone,
    pushSystemTransferNotification,
  ])

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
      isReceiveShipmentModalOpen ||
      isRandomInspectionModalOpen ||
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
    isRandomInspectionModalOpen,
    isReceiveShipmentModalOpen,
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
        shouldHideSelfResolvedTransferResponseReminder(reminder) &&
        isReminderCreatedByCurrentUser(reminder, currentUserIds, currentUserName)
      ) {
        return false
      }

      return true
    })
    return sortRemindersForCurrentUser(related, currentUserIds)
  }, [reminders, currentUserIds, currentUserName])

  const inTransitSubdivisionById = useMemo(
    () =>
      new Map(
        (Array.isArray(inTransitSubdivisions) ? inTransitSubdivisions : []).map((subdivision) => [
          normalizeId(subdivision?.id),
          subdivision,
        ])
      ),
    [inTransitSubdivisions]
  )

  const inTransitBodegaById = useMemo(
    () =>
      new Map(
        (Array.isArray(inTransitBodegas) ? inTransitBodegas : []).map((bodega) => [
          normalizeId(bodega?.id),
          bodega,
        ])
      ),
    [inTransitBodegas]
  )

  const inTransitDivisionById = useMemo(
    () =>
      new Map(
        (Array.isArray(inTransitDivisions) ? inTransitDivisions : []).map((division) => [
          normalizeId(division?.id),
          division,
        ])
      ),
    [inTransitDivisions]
  )

  const inTransitDivisionsByBodegaId = useMemo(() => {
    const map = new Map()
    ;(Array.isArray(inTransitDivisions) ? inTransitDivisions : []).forEach((division) => {
      const bodegaId = normalizeId(division?.bodega?.id || division?.bodega_id || '')
      if (!bodegaId) return
      const current = map.get(bodegaId) || []
      map.set(bodegaId, [...current, division])
    })
    return map
  }, [inTransitDivisions])

  const inTransitSubdivisionsByDivisionId = useMemo(() => {
    const map = new Map()
    ;(Array.isArray(inTransitSubdivisions) ? inTransitSubdivisions : []).forEach((subdivision) => {
      const divisionId = normalizeId(subdivision?.division?.id || subdivision?.division_id || '')
      if (!divisionId) return
      const current = map.get(divisionId) || []
      map.set(divisionId, [...current, subdivision])
    })
    return map
  }, [inTransitSubdivisions])

  const receiveShipmentRows = useMemo(
    () =>
      Object.values(receiveShipmentDraftByProductId || {}).map((row) => {
        const sentQty = toPositiveInt(row?.cantidad_enviada, 0)
        const receivedQty = Math.min(sentQty, toPositiveInt(row?.cantidad_recibida, 0))
        const missingQty = Math.max(0, sentQty - receivedQty)
        const assignedQty = (Array.isArray(row?.ubicaciones) ? row.ubicaciones : []).reduce(
          (total, location) => total + toPositiveInt(location?.cantidad, 0),
          0
        )
        return {
          ...row,
          cantidad_enviada: sentQty,
          cantidad_recibida: receivedQty,
          cantidad_faltante: missingQty,
          cantidad_asignada: assignedQty,
        }
      }),
    [receiveShipmentDraftByProductId]
  )

  const randomInspectionRows = useMemo(
    () =>
      (Array.isArray(activeRandomInspection?.items) ? activeRandomInspection.items : []).map((item) => {
        const itemId = normalizeId(item?.id)
        const draft = randomInspectionDraftByItemId?.[itemId] || {}
        const estadoRevision = String(draft?.estado_revision || '').trim().toLowerCase() === 'no_coincide'
          ? 'no_coincide'
          : 'coincide'
        const expectedQty = toPositiveInt(item?.cantidad_esperada, 0)
        const reportedQty = toPositiveInt(
          draft?.cantidad_reportada,
          item?.cantidad_reportada == null
            ? expectedQty
            : toPositiveInt(item?.cantidad_reportada, expectedQty)
        )
        return {
          ...item,
          row_id: itemId,
          estado_revision: estadoRevision,
          cantidad_esperada: expectedQty,
          cantidad_reportada: reportedQty,
          observacion: String(draft?.observacion || item?.observacion || '').trim(),
        }
      }),
    [activeRandomInspection, randomInspectionDraftByItemId]
  )

  const isRandomInspectionVerifyMode = randomInspectionMode === 'verify'
  const isRandomInspectionAlreadyCompleted = (
    !isRandomInspectionVerifyMode &&
    String(activeRandomInspection?.estado || '').trim().toLowerCase() === 'completada'
  )

  const randomInspectionRowsToVerify = useMemo(
    () =>
      randomInspectionRows.filter(
        (row) => String(row?.estado_revision || '').trim().toLowerCase() === 'no_coincide'
      ),
    [randomInspectionRows]
  )

  const randomInspectionPendingVerificationCount = useMemo(
    () =>
      randomInspectionRowsToVerify.filter((row) => {
        const verificationState = String(row?.verificacion_estado || '').trim().toLowerCase()
        return verificationState === 'pendiente'
      }).length,
    [randomInspectionRowsToVerify]
  )

  const randomInspectionMismatchCount = useMemo(
    () =>
      randomInspectionRows.filter(
        (row) => String(row?.estado_revision || '').trim().toLowerCase() === 'no_coincide'
      ).length,
    [randomInspectionRows]
  )

  const receiveShipmentTotalMissing = useMemo(
    () => receiveShipmentRows.reduce((total, row) => total + toPositiveInt(row?.cantidad_faltante, 0), 0),
    [receiveShipmentRows]
  )

  const receiveShipmentAutoResult = useMemo(
    () => (receiveShipmentTotalMissing > 0 ? 'incompleto' : 'completo'),
    [receiveShipmentTotalMissing]
  )

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

  const handleInTransitShipmentsTriggerRef = useCallback((element) => {
    const hadButton = Boolean(inTransitShipmentsTriggerRef.current)
    inTransitShipmentsTriggerRef.current = element
    if (!hadButton && element) {
      setClockTick(Date.now())
    }
  }, [])

  const buildReceiveLocationDropdownKey = useCallback(
    (productId, field) => `${normalizeId(productId)}::${String(field || '').trim().toLowerCase()}`,
    []
  )

  const setReceiveLocationDropdownRef = useCallback(
    (productId, field) => (element) => {
      const key = buildReceiveLocationDropdownKey(productId, field)
      if (!key) return
      if (element) {
        receiveLocationDropdownRefs.current[key] = element
      } else {
        delete receiveLocationDropdownRefs.current[key]
      }
    },
    [buildReceiveLocationDropdownKey]
  )

  const isReceiveLocationDropdownOpen = useCallback(
    (productId, field) =>
      normalizeId(activeReceiveLocationDropdown?.productId) === normalizeId(productId) &&
      String(activeReceiveLocationDropdown?.field || '').trim().toLowerCase() ===
        String(field || '').trim().toLowerCase(),
    [activeReceiveLocationDropdown]
  )

  const toggleReceiveLocationDropdown = useCallback((productId, field) => {
    const normalizedProductId = normalizeId(productId)
    const normalizedField = String(field || '').trim().toLowerCase()
    if (!normalizedProductId || !normalizedField) return
    setActiveReceiveLocationDropdown((prev) => {
      const prevProductId = normalizeId(prev?.productId)
      const prevField = String(prev?.field || '').trim().toLowerCase()
      if (prevProductId === normalizedProductId && prevField === normalizedField) {
        return { productId: '', field: '' }
      }
      return {
        productId: normalizedProductId,
        field: normalizedField,
      }
    })
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
    didPlayLoginToneRef.current = false
  }, [token, currentPrimaryUserId])

  useEffect(() => {
    if (!token) return
    if (!pendingRemindersForCurrentUser.length) return
    if (didPlayLoginToneRef.current) return
    didPlayLoginToneRef.current = true
    playNotificationTone({ forceForAdmin: true })
  }, [token, currentPrimaryUserId, pendingRemindersForCurrentUser.length, playNotificationTone])

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
      setIsInTransitShipmentsOpen(false)
      setIsReminderModalOpen(true)
    },
    [applyReminderUpdate, currentUserIdValues, currentUserIds]
  )

  const closeReminderModal = useCallback(() => {
    setIsReminderModalOpen(false)
    setFocusReminderId('')
  }, [])

  const closeReceiveShipmentModal = useCallback(() => {
    Object.values(receiveLocationSearchDebounceRef.current || {}).forEach((timerId) => {
      clearTimeout(timerId)
    })
    receiveLocationSearchDebounceRef.current = {}
    receiveLocationDropdownRefs.current = {}
    setActiveReceiveLocationDropdown({ productId: '', field: '' })
    setIsReceiveShipmentModalOpen(false)
    setActiveInTransitShipment(null)
    setInTransitBodegas([])
    setInTransitDivisions([])
    setInTransitSubdivisions([])
    setReceiveShipmentDraftByProductId({})
    setReceiveShipmentError('')
    setReceiveShipmentSubmitting(false)
  }, [])

  const closeRandomInspectionModal = useCallback(() => {
    setIsRandomInspectionModalOpen(false)
    setActiveRandomInspection(null)
    setRandomInspectionDraftByItemId({})
    setRandomInspectionMode('review')
    setRandomInspectionError('')
    setRandomInspectionSubmitting(false)
    setRandomInspectionLoading(false)
  }, [])

  const buildRandomInspectionDraft = useCallback((inspection) => {
    const rows = Array.isArray(inspection?.items) ? inspection.items : []
    return rows.reduce((acc, item) => {
      const itemId = normalizeId(item?.id)
      if (!itemId) return acc
      const expectedQty = toPositiveInt(item?.cantidad_esperada, 0)
      const reportedQty = item?.cantidad_reportada == null
        ? expectedQty
        : toPositiveInt(item?.cantidad_reportada, expectedQty)
      const normalizedState = String(item?.estado_revision || '').trim().toLowerCase()
      const estadoRevision = normalizedState === 'no_coincide'
        ? 'no_coincide'
        : 'coincide'
      acc[itemId] = {
        id: itemId,
        estado_revision: estadoRevision,
        cantidad_reportada: reportedQty,
        observacion: String(item?.observacion || '').trim(),
      }
      return acc
    }, {})
  }, [])

  const buildRandomInspectionVerificationDraft = useCallback((inspection) => {
    const rows = Array.isArray(inspection?.items) ? inspection.items : []
    return rows.reduce((acc, item) => {
      const itemId = normalizeId(item?.id)
      if (!itemId) return acc
      const reviewState = String(item?.estado_revision || '').trim().toLowerCase()
      if (reviewState !== 'no_coincide') return acc
      const verificationState = String(item?.verificacion_estado || '').trim().toLowerCase()
      acc[itemId] = {
        id: itemId,
        accion: verificationState === 'rechazada' ? 'rechazar' : 'aprobar',
        cantidad_confirmada: toPositiveInt(
          item?.cantidad_confirmada,
          item?.cantidad_reportada == null
            ? toPositiveInt(item?.cantidad_esperada, 0)
            : toPositiveInt(item?.cantidad_reportada, 0)
        ),
        nota_verificacion: String(item?.nota_verificacion || '').trim(),
      }
      return acc
    }, {})
  }, [])

  const fetchRandomInspectionDetail = useCallback(
    async (inspectionId) => {
      const normalizedInspectionId = normalizeId(inspectionId)
      if (!token || !normalizedInspectionId) return null
      const response = await authFetch(
        `${RANDOM_INSPECTION_DETAIL_ENDPOINT}/${encodeURIComponent(normalizedInspectionId)}/`,
        {},
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(
          String(payload?.detail || '').trim() || 'No se pudo cargar la inspecci\u00f3n aleatoria.'
        )
      }
      const inspection = payload?.inspection
      if (!inspection || typeof inspection !== 'object') {
        throw new Error('La inspecci\u00f3n aleatoria no tiene datos v\u00e1lidos.')
      }
      return inspection
    },
    [token]
  )

  const handleOpenRandomInspectionFromReminder = useCallback(
    async (reminder) => {
      if (!token) return false
      const inspectionId = normalizeId(reminder?.context?.id)
      if (!inspectionId) {
        showErrorToast('No se encontr\u00f3 la inspecci\u00f3n asociada a este recordatorio.')
        return false
      }

      const reminderKind = normalizeId(reminder?.kind)
      const isVerifyReminder = reminderKind === RANDOM_INSPECTION_VERIFY_KIND
      if (isVerifyReminder && typeof onOpenInventoryReviewSection === 'function') {
        const opened = onOpenInventoryReviewSection()
        return opened !== false
      }

      setRandomInspectionError('')
      setRandomInspectionLoading(true)
      setRandomInspectionMode(isVerifyReminder ? 'verify' : 'review')
      setIsRandomInspectionModalOpen(true)
      try {
        const inspection = await fetchRandomInspectionDetail(inspectionId)
        const inspectionStatus = String(inspection?.estado || '').trim().toLowerCase()
        if (!isVerifyReminder && inspectionStatus === 'completada') {
          closeRandomInspectionModal()
          showErrorToast('Esta inspeccion ya fue enviada y no puede volver a realizarse.')
          return false
        }
        setActiveRandomInspection(inspection)
        setRandomInspectionDraftByItemId(
          isVerifyReminder
            ? buildRandomInspectionVerificationDraft(inspection)
            : buildRandomInspectionDraft(inspection)
        )
        return true
      } catch (error) {
        closeRandomInspectionModal()
        showErrorToast(error?.message || 'No se pudo abrir la inspecci\u00f3n aleatoria.')
        return false
      } finally {
        setRandomInspectionLoading(false)
      }
    },
    [
      buildRandomInspectionDraft,
      buildRandomInspectionVerificationDraft,
      closeRandomInspectionModal,
      fetchRandomInspectionDetail,
      onOpenInventoryReviewSection,
      showErrorToast,
      token,
    ]
  )

  useEffect(
    () => () => {
      Object.values(receiveLocationSearchDebounceRef.current || {}).forEach((timerId) => {
        clearTimeout(timerId)
      })
      receiveLocationSearchDebounceRef.current = {}
      receiveLocationDropdownRefs.current = {}
    },
    []
  )

  useEffect(() => {
    const activeProductId = normalizeId(activeReceiveLocationDropdown?.productId)
    const activeField = String(activeReceiveLocationDropdown?.field || '').trim().toLowerCase()
    if (!activeProductId || !activeField || !isReceiveShipmentModalOpen) return undefined

    const key = buildReceiveLocationDropdownKey(activeProductId, activeField)
    const handleMouseDown = (event) => {
      const node = receiveLocationDropdownRefs.current?.[key]
      if (!node || node.contains(event.target)) return
      setActiveReceiveLocationDropdown({ productId: '', field: '' })
    }

    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [
    activeReceiveLocationDropdown,
    buildReceiveLocationDropdownKey,
    isReceiveShipmentModalOpen,
  ])

  const resolveProviderReminderRecipients = useCallback(
    async (providerBranchId) => {
      const normalizedProviderBranchId = normalizeId(providerBranchId)
      if (!token || !normalizedProviderBranchId) return []

      try {
        const rows = []
        let url = `${API_URL}/usuarios/listado/destinatarios/?page_size=200`
        while (url) {
          const response = await authFetch(url, {}, token)
          if (!response.ok) return []

          const payload = await response.json().catch(() => ({}))
          if (Array.isArray(payload)) {
            rows.push(...payload)
            url = null
          } else {
            rows.push(...parseApiList(payload))
            url = payload?.next || null
          }
        }

        const seenUserIds = new Set()
        const recipients = []
        rows.forEach((item) => {
          const hasSalidaPermission = (Array.isArray(item?.permisos_resumen) ? item.permisos_resumen : []).some(
            (permission) => {
              if (normalizeString(permission?.modulo) !== 'movimientos_salidas') return false
              return Boolean(
                permission?.puede_crear ||
                permission?.puede_actualizar ||
                permission?.puede_leer
              )
            }
          )
          if (!hasSalidaPermission) return

          const recipient = sanitizeRecipient({
            id:
              item?.id ||
              item?.usuario_id ||
              item?.user_id ||
              item?.usuarioInternoId ||
              item?.usuario_interno_id,
            name: formatCurrentUserName(item),
          })
          if (!recipient?.id) return

          const normalizedRecipientId = normalizeId(recipient.id)
          if (!normalizedRecipientId || seenUserIds.has(normalizedRecipientId)) return

          const moduleScopes = normalizeModuleScopes(item?.sucursales_por_modulo)
          const hasScopedAccess = hasModuleBranchAccess(
            {
              moduleScopes,
            },
            'movimientos_salidas',
            normalizedProviderBranchId
          )
          const hasAssignedBranch = (Array.isArray(item?.sucursales) ? item.sucursales : []).some(
            (branch) => normalizeId(branch?.id) === normalizedProviderBranchId
          )
          const hasAccess = hasScopedAccess || hasAssignedBranch
          if (!hasAccess) return

          seenUserIds.add(normalizedRecipientId)
          recipients.push(recipient)
        })

        return recipients
      } catch {
        return []
      }
    },
    [token]
  )

  const appendShipmentReceptionReminder = useCallback(
    async ({ shipment, result, totalMissing, items }) => {
      const solicitudId = normalizeId(shipment?.id)
      if (!solicitudId) return

      const existingReminders = readRemindersFromStorage()
      const contextMatchesSolicitud = (reminder) =>
        normalizeReminderContextType(reminder?.context?.type) === 'solicitud_traslado' &&
        normalizeId(reminder?.context?.id) === solicitudId
      const relatedReminders = existingReminders.filter(contextMatchesSolicitud)

      const appendUniqueRecipient = (list, candidate) => {
        const normalized = sanitizeRecipient(candidate)
        if (!normalized?.id) return
        const alreadyExists = list.some(
          (recipient) => normalizeId(recipient?.id) === normalizeId(normalized.id)
        )
        if (!alreadyExists) list.push(normalized)
      }

      const currentActorRecipient = (
        sanitizeRecipient({
          id:
            user?.usuarioInternoId ||
            user?.usuario_interno_id ||
            user?.usuario_id ||
            user?.user_id ||
            user?.id ||
            'system',
          name: currentUserName,
        }) || {
          id: 'system',
          name: currentUserName || 'Usuario',
        }
      )

      const reminderRecipients = []
      appendUniqueRecipient(reminderRecipients, currentActorRecipient)
      relatedReminders.forEach((reminder) => {
        appendUniqueRecipient(reminderRecipients, reminder?.creator)
        ;(Array.isArray(reminder?.recipients) ? reminder.recipients : []).forEach((recipient) => {
          appendUniqueRecipient(reminderRecipients, recipient)
        })
      })

      const providerRecipients = await resolveProviderReminderRecipients(
        shipment?.sucursal_proveedora_id
      )
      providerRecipients.forEach((recipient) => {
        appendUniqueRecipient(reminderRecipients, recipient)
      })

      if (!reminderRecipients.length) return

      const now = nowReminderDateTime()
      const requesterName = String(shipment?.sucursal_solicitante || '').trim() || 'Sucursal solicitante'
      const providerName = String(shipment?.sucursal_proveedora || '').trim() || 'Sucursal proveedora'
      const contextLabel = `Solicitud de traslado #${String(shipment?.no_documento || solicitudId).trim()}`
      const shortReference = contextLabel.replace(/^solicitud de traslado\s*/i, '').trim()
      const missingLines = (Array.isArray(items) ? items : [])
        .filter((item) => toPositiveInt(item?.cantidad_faltante, 0) > 0)
        .map((item) => {
          const productName = String(item?.producto_nombre || item?.producto_codigo || 'Producto').trim()
          const missingQty = toPositiveInt(item?.cantidad_faltante, 0)
          const notes = String(item?.novedad || '').trim()
          return notes ? `${productName}: faltan ${missingQty} (${notes})` : `${productName}: faltan ${missingQty}`
        })

      const description = result === 'incompleto'
        ? `${shortReference} llego incompleto en ${requesterName}. Faltantes: ${missingLines.join('; ') || totalMissing}.`
        : `${shortReference} llego completo en ${requesterName}. Recepcion confirmada para ${providerName}.`

      const reminder = {
        id: createReminderId(),
        date: now.date,
        time: now.time,
        description,
        creator: currentActorRecipient,
        recipients: reminderRecipients,
        context: {
          type: 'solicitud_traslado',
          id: solicitudId,
          label: contextLabel,
        },
        kind: TRANSFER_RECEIPT_NOTIFICATION_KIND,
        createdAt: now.iso,
        completedBy: [],
      }

      writeRemindersToStorage([reminder, ...existingReminders])
      emitRemindersSync()
    },
    [currentUserName, resolveProviderReminderRecipients, user]
  )

  const togglePendingShipmentsPanel = async () => {
    if (!canDecideTransferRequest) return
    if (isPendingShipmentsOpen) {
      setIsPendingShipmentsOpen(false)
      return
    }
    setIsInTransitShipmentsOpen(false)
    setIsPendingShipmentsOpen(true)
    await fetchPendingTransferShipments()
  }

  const toggleInTransitShipmentsPanel = async () => {
    if (!canViewInTransitShipments) return
    if (isInTransitShipmentsOpen) {
      setIsInTransitShipmentsOpen(false)
      return
    }
    setIsPendingShipmentsOpen(false)
    setIsInTransitShipmentsOpen(true)
    await fetchInTransitTransferShipments()
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
        setIsInTransitShipmentsOpen(false)
      } catch (error) {
        setIsTransferSendModalOpen(false)
        showErrorToast(error?.message || 'No se pudo abrir la salida pendiente.')
      } finally {
        setOpeningPendingShipmentId('')
      }
    },
    [fetchTransferSolicitudDetail, onTransferDecisionAccepted, showErrorToast]
  )

  const handleOpenInTransitShipment = useCallback(
    async (shipment) => {
      if (!token) return
      const shipmentId = normalizeId(shipment?.id)
      if (!shipmentId) {
        showErrorToast('No se pudo abrir el envio en camino.')
        return
      }

      setOpeningInTransitShipmentId(shipmentId)
      setReceiveShipmentError('')
      setInTransitBodegas([])
      setInTransitDivisions([])
      setInTransitSubdivisions([])
      setInTransitSubdivisionsLoading(true)

      try {
        const sucursalSolicitanteId = normalizeId(shipment?.sucursal_solicitante_id)
        if (!sucursalSolicitanteId) {
          throw new Error('No se pudo resolver la sucursal solicitante para recibir el traslado.')
        }

        const [bodegasResponse, divisionsResponse, subdivisionsResponse] = await Promise.all([
          authFetch(
            `${API_URL}/inventario/bodegas/?page_size=500&sucursal_id=${encodeURIComponent(
              sucursalSolicitanteId
            )}&modulo=movimientos_entradas`,
            {},
            token
          ),
          authFetch(
            `${API_URL}/inventario/divisiones/?page_size=500&sucursal_id=${encodeURIComponent(
              sucursalSolicitanteId
            )}&modulo=movimientos_entradas`,
            {},
            token
          ),
          authFetch(
            `${API_URL}/inventario/subdivisiones/?page_size=500&sucursal_id=${encodeURIComponent(
              sucursalSolicitanteId
            )}&modulo=movimientos_entradas`,
            {},
            token
          ),
        ])
        if (!bodegasResponse.ok) {
          throw new Error('No se pudieron cargar las bodegas de la sucursal solicitante.')
        }
        if (!divisionsResponse.ok) {
          throw new Error('No se pudieron cargar las divisiones de la sucursal solicitante.')
        }
        if (!subdivisionsResponse.ok) {
          throw new Error('No se pudieron cargar las subdivisiones para ubicar los productos.')
        }
        const bodegasPayload = await bodegasResponse.json().catch(() => ({}))
        const divisionsPayload = await divisionsResponse.json().catch(() => ({}))
        const subdivisionsPayload = await subdivisionsResponse.json().catch(() => ({}))
        const bodegas = parseApiList(bodegasPayload)
        const divisions = parseApiList(divisionsPayload)
        const subdivisions = parseApiList(subdivisionsPayload)
        const details = Array.isArray(shipment?.detalles) ? shipment.detalles : []
        if (!details.length) {
          throw new Error('Este envio no tiene productos para registrar recepcion.')
        }

        const preferredSubdivisionByProductId = await fetchPreferredReceiveSubdivisions({
          sucursalSolicitanteId,
          productIds: details.map((detail) => detail?.producto_id),
        })

        const localDivisionsByBodega = new Map()
        divisions.forEach((division) => {
          const bodegaId = normalizeId(division?.bodega?.id || division?.bodega_id || '')
          if (!bodegaId) return
          const current = localDivisionsByBodega.get(bodegaId) || []
          localDivisionsByBodega.set(bodegaId, [...current, division])
        })

        const localSubdivisionsByDivision = new Map()
        subdivisions.forEach((subdivision) => {
          const divisionId = normalizeId(subdivision?.division?.id || subdivision?.division_id || '')
          if (!divisionId) return
          const current = localSubdivisionsByDivision.get(divisionId) || []
          localSubdivisionsByDivision.set(divisionId, [...current, subdivision])
        })
        const localSubdivisionsById = new Map()
        subdivisions.forEach((subdivision) => {
          const subdivisionId = normalizeId(subdivision?.id)
          if (!subdivisionId) return
          localSubdivisionsById.set(subdivisionId, subdivision)
        })
        const draft = {}
        details.forEach((detail) => {
          const productId = normalizeId(detail?.producto_id)
          if (!productId) return
          const cantidadEnviada = toPositiveInt(detail?.cantidad_enviada, 0)
          const preferredSubdivisionId = normalizeId(
            preferredSubdivisionByProductId.get(productId) || ''
          )
          const preferredSubdivision = localSubdivisionsById.get(preferredSubdivisionId) || null
          const preferredDivisionId = normalizeId(
            preferredSubdivision?.division?.id || preferredSubdivision?.division_id || ''
          )
          const preferredBodegaId = normalizeId(
            preferredSubdivision?.division?.bodega?.id || preferredSubdivision?.division?.bodega_id || ''
          )
          const hasSuggestedLocation = Boolean(
            preferredSubdivisionId && preferredDivisionId && preferredBodegaId
          )
          draft[productId] = {
            producto_id: toPositiveInt(detail?.producto_id, 0),
            producto_codigo: String(detail?.producto_codigo || '').trim(),
            producto_nombre: String(detail?.producto_nombre || '').trim(),
            cantidad_enviada: cantidadEnviada,
            cantidad_recibida: cantidadEnviada,
            novedad: '',
            ubicaciones: hasSuggestedLocation
              ? [{ subdivision_id: preferredSubdivisionId, cantidad: cantidadEnviada }]
              : [],
            location_draft_bodega_id: hasSuggestedLocation ? preferredBodegaId : '',
            location_draft_bodega_query_input: '',
            location_draft_bodega_query: '',
            location_draft_division_id: hasSuggestedLocation ? preferredDivisionId : '',
            location_draft_division_query_input: '',
            location_draft_division_query: '',
            location_draft_subdivision_id: hasSuggestedLocation ? preferredSubdivisionId : '',
            location_draft_subdivision_query_input: '',
            location_draft_subdivision_query: '',
          }
        })

        setInTransitBodegas(bodegas)
        setInTransitDivisions(divisions)
        setInTransitSubdivisions(subdivisions)
        setReceiveShipmentDraftByProductId(draft)
        setActiveInTransitShipment(shipment)
        setIsInTransitShipmentsOpen(false)
        setIsReceiveShipmentModalOpen(true)
      } catch (error) {
        showErrorToast(error?.message || 'No se pudo abrir el envio en camino.')
      } finally {
        setOpeningInTransitShipmentId('')
        setInTransitSubdivisionsLoading(false)
      }
    },
    [fetchPreferredReceiveSubdivisions, showErrorToast, token]
  )

  const handleReceiveShipmentDraftFieldChange = useCallback((productId, field, value) => {
    const normalizedProductId = normalizeId(productId)
    if (!normalizedProductId) return

    setReceiveShipmentDraftByProductId((prev) => {
      const current = prev?.[normalizedProductId]
      if (!current) return prev

      const nextRow = { ...current }
      if (field === 'cantidad_recibida') {
        const max = toPositiveInt(current?.cantidad_enviada, 0)
        const parsed = Math.min(max, toPositiveInt(value, 0))
        nextRow.cantidad_recibida = parsed
        const assigned = (Array.isArray(nextRow.ubicaciones) ? nextRow.ubicaciones : []).reduce(
          (total, row) => total + toPositiveInt(row?.cantidad, 0),
          0
        )
        if (assigned > parsed) {
          nextRow.ubicaciones = []
        }
      } else if (field === 'novedad') {
        nextRow.novedad = String(value || '')
      } else if (field === 'location_draft_bodega_id') {
        const selectedBodegaId = normalizeId(value)
        nextRow.location_draft_bodega_id = selectedBodegaId
        nextRow.location_draft_bodega_query_input = ''
        nextRow.location_draft_bodega_query = ''
        const bodegaDivisions = selectedBodegaId
          ? inTransitDivisionsByBodegaId.get(selectedBodegaId) || []
          : Array.isArray(inTransitDivisions)
            ? inTransitDivisions
            : []
        const firstDivisionId = normalizeId(bodegaDivisions?.[0]?.id)
        nextRow.location_draft_division_id = firstDivisionId
        nextRow.location_draft_division_query_input = ''
        nextRow.location_draft_division_query = ''
        const divisionSubdivisions = firstDivisionId
          ? inTransitSubdivisionsByDivisionId.get(firstDivisionId) || []
          : []
        nextRow.location_draft_subdivision_id = normalizeId(divisionSubdivisions?.[0]?.id)
        nextRow.location_draft_subdivision_query_input = ''
        nextRow.location_draft_subdivision_query = ''
      } else if (field === 'location_draft_division_id') {
        const selectedDivisionId = normalizeId(value)
        nextRow.location_draft_division_id = selectedDivisionId
        nextRow.location_draft_division_query_input = ''
        nextRow.location_draft_division_query = ''
        const divisionSubdivisions = selectedDivisionId
          ? inTransitSubdivisionsByDivisionId.get(selectedDivisionId) || []
          : []
        nextRow.location_draft_subdivision_id = normalizeId(divisionSubdivisions?.[0]?.id)
        nextRow.location_draft_subdivision_query_input = ''
        nextRow.location_draft_subdivision_query = ''
      } else if (field === 'location_draft_subdivision_id') {
        nextRow.location_draft_subdivision_id = normalizeId(value)
        nextRow.location_draft_subdivision_query_input = ''
        nextRow.location_draft_subdivision_query = ''
      }

      return {
        ...prev,
        [normalizedProductId]: nextRow,
      }
    })
  }, [
    inTransitDivisions,
    inTransitDivisionsByBodegaId,
    inTransitSubdivisionsByDivisionId,
  ])

  const handleReceiveShipmentLocationSearchInput = useCallback((productId, field, value) => {
    const normalizedProductId = normalizeId(productId)
    const normalizedField = String(field || '').trim().toLowerCase()
    if (!normalizedProductId || !normalizedField) return
    const inputKey = `location_draft_${normalizedField}_query_input`
    const queryKey = `location_draft_${normalizedField}_query`
    const rawValue = String(value || '')

    setReceiveShipmentDraftByProductId((prev) => {
      const current = prev?.[normalizedProductId]
      if (!current) return prev
      return {
        ...prev,
        [normalizedProductId]: {
          ...current,
          [inputKey]: rawValue,
        },
      }
    })

    const timerKey = buildReceiveLocationDropdownKey(normalizedProductId, normalizedField)
    const timers = receiveLocationSearchDebounceRef.current || {}
    if (timers[timerKey]) {
      clearTimeout(timers[timerKey])
    }

    timers[timerKey] = setTimeout(() => {
      setReceiveShipmentDraftByProductId((prev) => {
        const current = prev?.[normalizedProductId]
        if (!current) return prev
        return {
          ...prev,
          [normalizedProductId]: {
            ...current,
            [queryKey]: normalizeSearchText(rawValue),
          },
        }
      })
      delete timers[timerKey]
    }, 260)

    receiveLocationSearchDebounceRef.current = timers
  }, [buildReceiveLocationDropdownKey])

  const handleAddReceiveShipmentLocation = useCallback((productId) => {
    const normalizedProductId = normalizeId(productId)
    if (!normalizedProductId) return

    setReceiveShipmentDraftByProductId((prev) => {
      const current = prev?.[normalizedProductId]
      if (!current) return prev

      const subdivisionId = normalizeId(current?.location_draft_subdivision_id)
      if (!subdivisionId) return prev

      const assigned = (Array.isArray(current?.ubicaciones) ? current.ubicaciones : []).reduce(
        (total, row) => total + toPositiveInt(row?.cantidad, 0),
        0
      )
      const toAssign = toPositiveInt(current?.cantidad_recibida, 0) - assigned
      if (toAssign <= 0) return prev

      const nextLocations = Array.isArray(current?.ubicaciones) ? [...current.ubicaciones] : []
      const locationIndex = nextLocations.findIndex(
        (location) => normalizeId(location?.subdivision_id) === subdivisionId
      )
      if (locationIndex >= 0) {
        const existing = nextLocations[locationIndex]
        nextLocations[locationIndex] = {
          ...existing,
          cantidad: toPositiveInt(existing?.cantidad, 0) + toAssign,
        }
      } else {
        nextLocations.push({
          subdivision_id: subdivisionId,
          cantidad: toAssign,
        })
      }

      return {
        ...prev,
        [normalizedProductId]: {
          ...current,
          ubicaciones: nextLocations,
        },
      }
    })
  }, [])

  const handleRemoveReceiveShipmentLocation = useCallback((productId, locationIndex) => {
    const normalizedProductId = normalizeId(productId)
    if (!normalizedProductId) return

    setReceiveShipmentDraftByProductId((prev) => {
      const current = prev?.[normalizedProductId]
      if (!current) return prev
      const nextLocations = Array.isArray(current?.ubicaciones)
        ? current.ubicaciones.filter((_, index) => index !== locationIndex)
        : []
      return {
        ...prev,
        [normalizedProductId]: {
          ...current,
          ubicaciones: nextLocations,
        },
      }
    })
  }, [])

  const handleRandomInspectionDraftFieldChange = useCallback((itemId, field, value) => {
    const normalizedItemId = normalizeId(itemId)
    if (!normalizedItemId) return

    setRandomInspectionDraftByItemId((prev) => {
      const current = prev?.[normalizedItemId] || {}
      const next = {
        ...current,
        id: normalizedItemId,
      }

      if (field === 'estado_revision') {
        next.estado_revision = String(value || '').trim().toLowerCase() === 'no_coincide'
          ? 'no_coincide'
          : 'coincide'
      } else if (field === 'cantidad_reportada') {
        next.cantidad_reportada = toPositiveInt(value, 0)
      } else if (field === 'observacion') {
        next.observacion = String(value || '')
      } else if (field === 'accion') {
        next.accion = String(value || '').trim().toLowerCase() === 'rechazar'
          ? 'rechazar'
          : 'aprobar'
      } else if (field === 'cantidad_confirmada') {
        next.cantidad_confirmada = toPositiveInt(value, 0)
      } else if (field === 'nota_verificacion') {
        next.nota_verificacion = String(value || '')
      }

      return {
        ...prev,
        [normalizedItemId]: next,
      }
    })
  }, [])

  const handleSubmitRandomInspection = useCallback(
    async () => {
      const inspectionId = normalizeId(activeRandomInspection?.id)
      if (!token || !inspectionId) return
      const inspectionStatus = String(activeRandomInspection?.estado || '').trim().toLowerCase()
      if (inspectionStatus === 'completada') {
        setRandomInspectionError(
          'Esta inspeccion ya fue enviada y no puede volver a realizarse.'
        )
        return
      }

      if (!randomInspectionRows.length) {
        setRandomInspectionError('No hay productos para revisar en esta inspecci\u00f3n.')
        return
      }

      const itemsPayload = []
      for (const row of randomInspectionRows) {
        const rowId = normalizeId(row?.row_id || row?.id)
        if (!rowId) {
          setRandomInspectionError('Se encontr\u00f3 un item inv\u00e1lido en la inspecci\u00f3n.')
          return
        }

        const estadoRevision = String(row?.estado_revision || '').trim().toLowerCase()
        if (estadoRevision !== 'coincide' && estadoRevision !== 'no_coincide') {
          setRandomInspectionError('Debes indicar si cada producto coincide o no coincide.')
          return
        }

        const payloadRow = {
          id: Number(rowId),
          estado_revision: estadoRevision,
          observacion: String(row?.observacion || '').trim(),
        }
        if (estadoRevision === 'no_coincide') {
          payloadRow.cantidad_reportada = toPositiveInt(row?.cantidad_reportada, -1)
          if (payloadRow.cantidad_reportada < 0) {
            setRandomInspectionError(
              `Debes indicar la cantidad real para ${row?.producto_nombre || row?.producto_codigo || `item ${rowId}`}.`
            )
            return
          }
        } else {
          payloadRow.cantidad_reportada = toPositiveInt(row?.cantidad_esperada, 0)
        }
        itemsPayload.push(payloadRow)
      }

      setRandomInspectionError('')
      setRandomInspectionSubmitting(true)
      try {
        const response = await authFetch(
          `${RANDOM_INSPECTION_DETAIL_ENDPOINT}/${encodeURIComponent(inspectionId)}/responder/`,
          {
            method: 'POST',
            body: JSON.stringify({ items: itemsPayload }),
          },
          token
        )
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(
            String(payload?.detail || '').trim() || 'No se pudo guardar la inspecci\u00f3n.'
          )
        }

        const mismatchCount = toPositiveInt(payload?.mismatch_count, 0)
        if (mismatchCount > 0) {
          toast.current?.show({
            severity: 'warn',
            summary: 'Inspecci\u00f3n registrada',
            detail: `Se reportaron ${mismatchCount} diferencia(s). Se notific\u00f3 a administraci\u00f3n para verificar.`,
            life: 4200,
          })
        } else {
          toast.current?.show({
            severity: 'success',
            summary: 'Inspecci\u00f3n registrada',
            detail: 'La inspecci\u00f3n se guard\u00f3 correctamente.',
            life: 3200,
          })
        }

        closeRandomInspectionModal()
        const remoteReminders = await fetchRemindersFromBackend(token)
        setReminders(remoteReminders)
      } catch (error) {
        setRandomInspectionError(
          error?.message || 'No se pudo guardar la inspecci\u00f3n.'
        )
      } finally {
        setRandomInspectionSubmitting(false)
      }
    },
    [
      activeRandomInspection,
      closeRandomInspectionModal,
      randomInspectionRows,
      token,
    ]
  )

  const handleVerifyRandomInspection = useCallback(
    async () => {
      const inspectionId = normalizeId(activeRandomInspection?.id)
      if (!token || !inspectionId) return

      if (!randomInspectionRowsToVerify.length) {
        setRandomInspectionError('Esta inspeccion no tiene diferencias por verificar.')
        return
      }

      const pendingRows = randomInspectionRowsToVerify.filter((row) => {
        const verificationState = String(row?.verificacion_estado || '').trim().toLowerCase()
        return verificationState === 'pendiente'
      })
      if (!pendingRows.length) {
        setRandomInspectionError('No hay diferencias pendientes de verificacion.')
        return
      }

      setRandomInspectionError('')
      setRandomInspectionSubmitting(true)
      try {
        let latestInspection = activeRandomInspection
        for (const row of pendingRows) {
          const rowId = normalizeId(row?.row_id || row?.id)
          if (!rowId) continue

          const draft = randomInspectionDraftByItemId?.[rowId] || {}
          const action = String(draft?.accion || '').trim().toLowerCase() === 'rechazar'
            ? 'rechazar'
            : 'aprobar'
          const payloadBody = {
            accion: action,
            nota: String(draft?.nota_verificacion || '').trim(),
          }

          if (action === 'aprobar') {
            payloadBody.cantidad_confirmada = toPositiveInt(
              draft?.cantidad_confirmada,
              row?.cantidad_reportada == null
                ? toPositiveInt(row?.cantidad_esperada, 0)
                : toPositiveInt(row?.cantidad_reportada, 0)
            )
          }

          const response = await authFetch(
            `${RANDOM_INSPECTION_VERIFY_ITEM_ENDPOINT}/${encodeURIComponent(rowId)}/verificar/`,
            {
              method: 'POST',
              body: JSON.stringify(payloadBody),
            },
            token
          )
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) {
            throw new Error(
              String(payload?.detail || '').trim() || 'No se pudo verificar un item de la inspeccion.'
            )
          }

          if (payload?.inspection && typeof payload.inspection === 'object') {
            latestInspection = payload.inspection
          }
        }

        if (latestInspection && typeof latestInspection === 'object') {
          setActiveRandomInspection(latestInspection)
        }

        const remoteReminders = await fetchRemindersFromBackend(token)
        setReminders(remoteReminders)

        toast.current?.show({
          severity: 'success',
          summary: 'Verificacion completada',
          detail: 'Se aplicaron las verificaciones de inventario reportadas.',
          life: 3200,
        })
        closeRandomInspectionModal()
      } catch (error) {
        setRandomInspectionError(
          error?.message || 'No se pudo completar la verificacion de la inspeccion.'
        )
      } finally {
        setRandomInspectionSubmitting(false)
      }
    },
    [
      activeRandomInspection,
      closeRandomInspectionModal,
      randomInspectionDraftByItemId,
      randomInspectionRowsToVerify,
      token,
    ]
  )

  const handleSubmitShipmentReception = useCallback(
    async () => {
      if (!token || !activeInTransitShipment) return

      const rows = Object.values(receiveShipmentDraftByProductId || {})
      if (!rows.length) {
        setReceiveShipmentError('No hay productos para registrar recepcion.')
        return
      }

      const builtItems = []
      let totalMissing = 0
      for (const row of rows) {
        const productId = toPositiveInt(row?.producto_id, 0)
        const sentQty = toPositiveInt(row?.cantidad_enviada, 0)
        const receivedQty = Math.min(sentQty, toPositiveInt(row?.cantidad_recibida, 0))
        const missingQty = Math.max(0, sentQty - receivedQty)
        const locations = (Array.isArray(row?.ubicaciones) ? row.ubicaciones : [])
          .map((location) => ({
            subdivision_id: toPositiveInt(location?.subdivision_id, 0),
            cantidad: toPositiveInt(location?.cantidad, 0),
          }))
          .filter((location) => location.subdivision_id > 0 && location.cantidad > 0)
        const assigned = locations.reduce((total, location) => total + toPositiveInt(location.cantidad, 0), 0)

        if (receivedQty > 0 && assigned !== receivedQty) {
          setReceiveShipmentError(
            `Debes ubicar completamente el producto ${row?.producto_nombre || row?.producto_codigo || productId}.`
          )
          return
        }
        if (missingQty > 0 && !String(row?.novedad || '').trim()) {
          setReceiveShipmentError(
            `Debes indicar la novedad del faltante para ${row?.producto_nombre || row?.producto_codigo || productId}.`
          )
          return
        }

        totalMissing += missingQty
        builtItems.push({
          producto_id: productId,
          cantidad_recibida: receivedQty,
          novedad: String(row?.novedad || '').trim(),
          ubicaciones: locations,
          cantidad_faltante: missingQty,
          producto_nombre: row?.producto_nombre || '',
          producto_codigo: row?.producto_codigo || '',
        })
      }

      const normalizedResult = totalMissing > 0 ? 'incompleto' : 'completo'
      if (normalizedResult === 'completo' && totalMissing > 0) {
        setReceiveShipmentError('No puedes marcar completo si hay faltantes.')
        return
      }
      if (normalizedResult === 'incompleto' && totalMissing <= 0) {
        setReceiveShipmentError('Para marcar incompleto debe existir al menos un faltante.')
        return
      }

      setReceiveShipmentError('')
      setReceiveShipmentSubmitting(true)
      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(
            normalizeId(activeInTransitShipment?.id)
          )}/confirmar-recepcion/`,
          {
            method: 'POST',
            body: JSON.stringify({
              resultado: normalizedResult,
              items: builtItems.map((item) => ({
                producto_id: item.producto_id,
                cantidad_recibida: item.cantidad_recibida,
                novedad: item.novedad,
                ubicaciones: item.ubicaciones,
              })),
            }),
          },
          token
        )
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(
            String(payload?.detail || '').trim() || 'No se pudo confirmar la recepcion del envio.'
          )
        }

        const backendReminderSent = Boolean(payload?.recordatorio_enviado)
        if (!backendReminderSent) {
          await appendShipmentReceptionReminder({
            shipment: activeInTransitShipment,
            result: normalizedResult,
            totalMissing,
            items: builtItems,
          })
        }
        setIsReceiveShipmentModalOpen(false)
        setActiveInTransitShipment(null)
        setReceiveShipmentDraftByProductId({})
        await fetchInTransitTransferShipments({ silent: true })
      } catch (error) {
        setReceiveShipmentError(
          error?.message || 'No se pudo confirmar la recepcion del envio.'
        )
      } finally {
        setReceiveShipmentSubmitting(false)
      }
    },
    [
      activeInTransitShipment,
      appendShipmentReceptionReminder,
      fetchInTransitTransferShipments,
      receiveShipmentDraftByProductId,
      token,
    ]
  )

  const handleUrgentShieldClick = useCallback(
    (shield) => {
      if (!shield) return
      if (shield.kind === 'pending_shipment') {
        if (shield.target?.solicitud) {
          void handleOpenPendingShipment(shield.target.solicitud)
          return
        }
        setIsInTransitShipmentsOpen(false)
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
        {canViewInTransitShipments && hasInTransitShipments && (
          <div
            ref={inTransitShipmentsRef}
            className={`quick-actions__pending-shipments quick-actions__in-transit${isInTransitShipmentsOpen ? ' is-open' : ''}`}
          >
            <button
              ref={handleInTransitShipmentsTriggerRef}
              type="button"
              className="quick-actions__pending-shipments-trigger quick-actions__in-transit-trigger"
              onClick={() => void toggleInTransitShipmentsPanel()}
              aria-label="Envios en camino"
            >
              <span>Envios en camino</span>
              {!suppressAdminAlerts && (
                <span className="quick-actions__pending-shipments-count">
                  {inTransitShipmentsLoading ? '...' : inTransitShipments.length}
                </span>
              )}
            </button>

            {isInTransitShipmentsOpen && (
              <div className="quick-actions__pending-shipments-panel quick-actions__in-transit-panel" role="dialog" aria-label="Envios en camino">
                <div className="quick-actions__pending-shipments-head">
                  <strong>Envios por recibir</strong>
                  <button
                    type="button"
                    className="quick-actions__pending-shipments-refresh"
                    onClick={() => void fetchInTransitTransferShipments()}
                    disabled={inTransitShipmentsLoading}
                    aria-label="Actualizar envios en camino"
                  >
                    <i className="pi pi-refresh" aria-hidden="true" />
                  </button>
                </div>

                <div className="quick-actions__pending-shipments-list">
                  {inTransitShipmentsLoading ? (
                    <p
                      className="quick-actions__pending-shipments-empty quick-actions__pending-shipments-loading"
                      role="status"
                      aria-live="polite"
                    >
                      <Loader2 size={14} />
                      <span>Cargando envios en camino...</span>
                    </p>
                  ) : !inTransitShipments.length ? (
                    <p className="quick-actions__pending-shipments-empty">No hay envios en camino.</p>
                  ) : (
                    inTransitShipments.map((shipment) => {
                      const shipmentId = normalizeId(shipment?.id)
                      const isOpening = shipmentId && openingInTransitShipmentId === shipmentId
                      const doc = String(shipment?.no_documento || shipmentId || '').trim()
                      const providerBranch = String(shipment?.sucursal_proveedora || '').trim() || 'Sucursal proveedora'
                      const receiveBranch = String(shipment?.sucursal_solicitante || '').trim() || 'Sucursal solicitante'
                      const fecha = String(shipment?.fecha || '').trim()

                      return (
                        <button
                          key={`in-transit-shipment-${shipmentId || doc || 'row'}`}
                          type="button"
                          className="quick-actions__pending-shipments-item quick-actions__in-transit-item"
                          onClick={() => void handleOpenInTransitShipment(shipment)}
                          disabled={Boolean(isOpening || inTransitSubdivisionsLoading)}
                        >
                          <span className="quick-actions__pending-shipments-item-title">
                            {doc ? `#${doc}` : 'Traslado sin documento'}
                          </span>
                          <span className="quick-actions__pending-shipments-item-meta">
                            Desde: {providerBranch}
                          </span>
                          <span className="quick-actions__pending-shipments-item-meta">
                            Hacia: {receiveBranch}
                          </span>
                          <span className="quick-actions__pending-shipments-item-meta">
                            {isOpening ? 'Abriendo...' : (fecha ? `Fecha: ${fecha}` : 'Abrir recepcion')}
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

        {canDecideTransferRequest && hasPendingShipments && (
          <div
            ref={pendingShipmentsRef}
            className={`quick-actions__pending-shipments${isPendingShipmentsOpen ? ' is-open' : ''}${shouldAnimatePendingShipments ? ' has-login-animation' : ''}`}
          >
            <button
              ref={handlePendingShipmentsTriggerRef}
              type="button"
              className="quick-actions__pending-shipments-trigger"
              onClick={() => void togglePendingShipmentsPanel()}
              aria-label="Envios pendientes"
            >
              <span>Envios pendientes</span>
              {!suppressAdminAlerts && (
                <span className="quick-actions__pending-shipments-count">
                  {pendingShipmentsLoading ? '...' : pendingShipments.length}
                </span>
              )}
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
            {mobileShipmentCount > 0 && (
              <span className="quick-actions__mobile-count" aria-hidden="true">
                {mobileShipmentCount > 9 ? '9+' : mobileShipmentCount}
              </span>
            )}
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
        onOpenTransferRequestInSalidas={onOpenTransferRequestInSalidas}
        onOpenRandomInspection={handleOpenRandomInspectionFromReminder}
      />

      {isRandomInspectionModalOpen && (
        <div
          className="quick-actions__inspection-overlay"
          onMouseDown={() => {
            if (randomInspectionSubmitting) return
            closeRandomInspectionModal()
          }}
        >
          <div
            className="quick-actions__inspection-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Inspecci\u00f3n aleatoria diaria"
          >
            <header className="quick-actions__inspection-head">
              <div>
                <h4>{isRandomInspectionVerifyMode ? 'Verificacion de inspeccion aleatoria' : 'Inspeccion aleatoria diaria'}</h4>
                <p>
                  {activeRandomInspection?.fecha_programada
                    ? `Fecha: ${String(activeRandomInspection.fecha_programada).trim()}`
                    : (isRandomInspectionVerifyMode ? 'Revision administrativa de diferencias' : 'Revision diaria de inventario')}
                </p>
              </div>
              <button
                type="button"
                className="quick-actions__inspection-close"
                onClick={closeRandomInspectionModal}
                disabled={randomInspectionSubmitting}
                aria-label="Cerrar inspecci\u00f3n"
              >
                <X size={16} />
              </button>
            </header>

            <div className="quick-actions__inspection-body">
              {randomInspectionLoading ? (
                <p className="quick-actions__inspection-loading">
                  <Loader2 size={14} />
                  Cargando inspeccion...
                </p>
              ) : isRandomInspectionVerifyMode ? (
                <div className="quick-actions__inspection-list">
                  {!randomInspectionRowsToVerify.length && (
                    <p className="quick-actions__inspection-empty">
                      No hay diferencias reportadas para verificar.
                    </p>
                  )}

                  {randomInspectionRowsToVerify.map((row) => {
                    const rowId = normalizeId(row?.row_id || row?.id)
                    const verificationState = String(row?.verificacion_estado || '').trim().toLowerCase()
                    const isResolved = verificationState === 'aprobada' || verificationState === 'rechazada'
                    const draft = randomInspectionDraftByItemId?.[rowId] || {}
                    const selectedAction = String(draft?.accion || '').trim().toLowerCase() === 'rechazar'
                      ? 'rechazar'
                      : 'aprobar'
                    const confirmedQty = toPositiveInt(
                      draft?.cantidad_confirmada,
                      row?.cantidad_reportada == null
                        ? toPositiveInt(row?.cantidad_esperada, 0)
                        : toPositiveInt(row?.cantidad_reportada, 0)
                    )

                    return (
                      <article key={`inspection-row-${rowId}`} className="quick-actions__inspection-item">
                        <div className="quick-actions__inspection-item-head">
                          <strong>
                            {row?.producto_codigo ? `${row.producto_codigo} - ` : ''}
                            {row?.producto_nombre || `Producto ${rowId}`}
                          </strong>
                          <span>{String(row?.sucursal_nombre || 'Sucursal').trim()}</span>
                        </div>

                        <div className="quick-actions__inspection-item-expected">
                          Inventario esperado: <strong>{toPositiveInt(row?.cantidad_esperada, 0)}</strong>
                          {' | '}
                          Reportado: <strong>{toPositiveInt(row?.cantidad_reportada, 0)}</strong>
                        </div>

                        <div className="quick-actions__inspection-grid">
                          <label>
                            <span>Decision</span>
                            <select
                              value={selectedAction}
                              onChange={(event) =>
                                handleRandomInspectionDraftFieldChange(
                                  rowId,
                                  'accion',
                                  event.target.value
                                )}
                              disabled={randomInspectionSubmitting || isResolved}
                            >
                              <option value="aprobar">Aprobar ajuste</option>
                              <option value="rechazar">Rechazar ajuste</option>
                            </select>
                          </label>

                          <label>
                            <span>Cantidad confirmada</span>
                            <input
                              type="number"
                              min={0}
                              value={confirmedQty}
                              onChange={(event) =>
                                handleRandomInspectionDraftFieldChange(
                                  rowId,
                                  'cantidad_confirmada',
                                  event.target.value
                                )}
                              disabled={
                                randomInspectionSubmitting ||
                                isResolved ||
                                selectedAction !== 'aprobar'
                              }
                            />
                          </label>
                        </div>

                        <label className="quick-actions__inspection-note">
                          <span>Nota de verificacion (opcional)</span>
                          <textarea
                            rows={2}
                            value={String(draft?.nota_verificacion || '')}
                            onChange={(event) =>
                              handleRandomInspectionDraftFieldChange(
                                rowId,
                                'nota_verificacion',
                                event.target.value
                              )}
                            disabled={randomInspectionSubmitting || isResolved}
                          />
                        </label>

                        {isResolved && (
                          <p className="quick-actions__inspection-verify-state">
                            Verificado: {verificationState === 'aprobada' ? 'aprobado' : 'rechazado'}
                          </p>
                        )}
                      </article>
                    )
                  })}
                </div>
              ) : (
                <div className="quick-actions__inspection-list">
                  {!randomInspectionRows.length && (
                    <p className="quick-actions__inspection-empty">No hay productos por revisar.</p>
                  )}

                  {randomInspectionRows.map((row) => {
                    const rowId = normalizeId(row?.row_id || row?.id)
                    const isMismatch = String(row?.estado_revision || '').trim().toLowerCase() === 'no_coincide'
                    return (
                      <article key={`inspection-row-${rowId}`} className="quick-actions__inspection-item">
                        <div className="quick-actions__inspection-item-head">
                          <strong>
                            {row?.producto_codigo ? `${row.producto_codigo} - ` : ''}
                            {row?.producto_nombre || `Producto ${rowId}`}
                          </strong>
                          <span>{String(row?.sucursal_nombre || 'Sucursal').trim()}</span>
                        </div>

                        <div className="quick-actions__inspection-item-expected">
                          Inventario esperado: <strong>{toPositiveInt(row?.cantidad_esperada, 0)}</strong>
                        </div>

                        <div className="quick-actions__inspection-grid">
                          <label>
                            <span>Resultado</span>
                            <select
                              value={String(row?.estado_revision || 'coincide')}
                              onChange={(event) =>
                                handleRandomInspectionDraftFieldChange(
                                  rowId,
                                  'estado_revision',
                                  event.target.value
                                )}
                              disabled={randomInspectionSubmitting}
                            >
                              <option value="coincide">Si coincide con inventario</option>
                              <option value="no_coincide">No coincide</option>
                            </select>
                          </label>

                          <label>
                            <span>Cantidad real</span>
                            <input
                              type="number"
                              min={0}
                              value={toPositiveInt(
                                row?.cantidad_reportada,
                                toPositiveInt(row?.cantidad_esperada, 0)
                              )}
                              onChange={(event) =>
                                handleRandomInspectionDraftFieldChange(
                                  rowId,
                                  'cantidad_reportada',
                                  event.target.value
                                )}
                              disabled={randomInspectionSubmitting || !isMismatch}
                            />
                          </label>
                        </div>

                        <label className="quick-actions__inspection-note">
                          <span>Observacion (opcional)</span>
                          <textarea
                            rows={2}
                            value={String(row?.observacion || '')}
                            onChange={(event) =>
                              handleRandomInspectionDraftFieldChange(
                                rowId,
                                'observacion',
                                event.target.value
                              )}
                            disabled={randomInspectionSubmitting}
                          />
                        </label>
                      </article>
                    )
                  })}
                </div>
              )}
              {randomInspectionError && (
                <p className="quick-actions__inspection-error">{randomInspectionError}</p>
              )}
            </div>

            <footer className="quick-actions__inspection-actions">
              <button
                type="button"
                className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost"
                onClick={closeRandomInspectionModal}
                disabled={randomInspectionSubmitting}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="quick-actions__inspection-btn quick-actions__inspection-btn--primary"
                onClick={() => {
                  if (isRandomInspectionVerifyMode) {
                    void handleVerifyRandomInspection()
                    return
                  }
                  void handleSubmitRandomInspection()
                }}
                disabled={
                  randomInspectionSubmitting ||
                  randomInspectionLoading ||
                  (!isRandomInspectionVerifyMode && isRandomInspectionAlreadyCompleted) ||
                  (
                    isRandomInspectionVerifyMode
                      ? randomInspectionPendingVerificationCount <= 0
                      : !randomInspectionRows.length
                  )
                }
              >
                {randomInspectionSubmitting
                  ? 'Guardando...'
                  : isRandomInspectionVerifyMode
                    ? (
                      randomInspectionPendingVerificationCount > 0
                        ? `Aplicar verificacion (${randomInspectionPendingVerificationCount} pendiente(s))`
                        : 'Sin pendientes por verificar'
                    )
                    : isRandomInspectionAlreadyCompleted
                      ? 'Inspeccion ya enviada'
                    : (
                      randomInspectionMismatchCount > 0
                        ? `Guardar inspecci\u00f3n (${randomInspectionMismatchCount} con diferencia)`
                        : 'Guardar inspecci\u00f3n'
                    )}
              </button>
            </footer>
          </div>
        </div>
      )}

      {isReceiveShipmentModalOpen && (
        <div
          className="quick-actions__receive-overlay"
          onMouseDown={() => {
            if (receiveShipmentSubmitting) return
            closeReceiveShipmentModal()
          }}
        >
          <div
            className="quick-actions__receive-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Registrar recepcion de envio"
          >
            <header className="quick-actions__receive-head">
              <div>
                <h4>Envio en camino</h4>
                <p>
                  #{String(activeInTransitShipment?.no_documento || activeInTransitShipment?.id || '').trim()} desde{' '}
                  {String(activeInTransitShipment?.sucursal_proveedora || '').trim() || 'Sucursal proveedora'}
                </p>
              </div>
              <button
                type="button"
                className="quick-actions__receive-close"
                onClick={closeReceiveShipmentModal}
                disabled={receiveShipmentSubmitting}
                aria-label="Cerrar recepcion"
              >
                <X size={16} />
              </button>
            </header>

            <div className="quick-actions__receive-body">
              {inTransitSubdivisionsLoading ? (
                <p className="quick-actions__receive-loading">
                  <Loader2 size={14} />
                  Cargando bodegas, divisiones y subdivisiones...
                </p>
              ) : (
                <div className="quick-actions__receive-list">
	                  {receiveShipmentRows.map((row) => {
	                    const rowProductId = normalizeId(row?.producto_id)
	                    const missingQty = toPositiveInt(row?.cantidad_faltante, 0)
	                    const expectedQty = toPositiveInt(row?.cantidad_enviada, 0)
	                    const receivedQty = toPositiveInt(row?.cantidad_recibida, 0)
	                    const assignedQty = toPositiveInt(row?.cantidad_asignada, 0)
	                    const pendingAssignQty = Math.max(
	                      0,
	                      receivedQty - assignedQty
	                    )
                    const selectedBodegaId = normalizeId(row?.location_draft_bodega_id)
                    const selectedBodega = inTransitBodegaById.get(selectedBodegaId) || null
                    const bodegaQuery = normalizeSearchText(row?.location_draft_bodega_query || '')
                    const filteredBodegas = bodegaQuery
                      ? inTransitBodegas.filter((bodega) =>
                          normalizeSearchText(bodega?.nombre).includes(bodegaQuery)
                        )
                      : inTransitBodegas
                    const availableDivisions = selectedBodegaId
                      ? inTransitDivisionsByBodegaId.get(selectedBodegaId) || []
                      : []
                    const selectedDivisionId = normalizeId(row?.location_draft_division_id)
                    const selectedDivision = inTransitDivisionById.get(selectedDivisionId) || null
                    const divisionQuery = normalizeSearchText(row?.location_draft_division_query || '')
                    const filteredDivisions = divisionQuery
                      ? availableDivisions.filter((division) =>
                          normalizeSearchText(division?.nombre).includes(divisionQuery)
                        )
                      : availableDivisions
                    const availableSubdivisions = selectedDivisionId
                      ? inTransitSubdivisionsByDivisionId.get(selectedDivisionId) || []
                      : []
                    const subdivisionQuery = normalizeSearchText(
                      row?.location_draft_subdivision_query || ''
                    )
                    const filteredSubdivisions = subdivisionQuery
                      ? availableSubdivisions.filter((subdivision) =>
                          normalizeSearchText(subdivision?.nombre).includes(subdivisionQuery)
                        )
                      : availableSubdivisions
                    const selectedSubdivision = inTransitSubdivisionById.get(
                      normalizeId(row?.location_draft_subdivision_id)
                    ) || null
                    return (
                      <article key={`receive-shipment-row-${rowProductId}`} className="quick-actions__receive-item">
	                        <div className="quick-actions__receive-item-head">
	                          <strong>
	                            {row?.producto_codigo ? `${row.producto_codigo} - ` : ''}
	                            {row?.producto_nombre || `Producto ${rowProductId}`}
	                          </strong>
	                        </div>

                        <div className="quick-actions__receive-grid">
                          <label>
                            <span>Cantidad recibida</span>
	                            <input
	                              type="number"
	                              min={0}
	                              max={expectedQty}
	                              value={receivedQty}
	                              onChange={(event) =>
	                                handleReceiveShipmentDraftFieldChange(
	                                  rowProductId,
                                  'cantidad_recibida',
                                  event.target.value
                                )}
                              disabled={receiveShipmentSubmitting}
                            />
                          </label>
                          <label>
                            <span>Faltantes</span>
	                            <input type="number" value={missingQty} readOnly disabled />
	                          </label>
	                        </div>
	                        <p className="quick-actions__receive-item-expected">
	                          Cantidad esperada: <strong>{expectedQty}</strong> | Cantidad recibida: <strong>{receivedQty}</strong>
	                        </p>

                        <div className="quick-actions__receive-location">
                          <div className="quick-actions__receive-location-row quick-actions__receive-location-row--compose">
                            <div
                              className="quick-actions__receive-dropdown"
                              ref={setReceiveLocationDropdownRef(rowProductId, 'bodega')}
                            >
                              <button
                                type="button"
                                className="quick-actions__receive-dropdown-trigger"
                                onClick={() => toggleReceiveLocationDropdown(rowProductId, 'bodega')}
                                disabled={receiveShipmentSubmitting || !inTransitBodegas.length}
                              >
                                <span>
                                  {String(selectedBodega?.nombre || 'Selecciona bodega').trim()}
                                </span>
                                <i
                                  className={`pi pi-chevron-${
                                    isReceiveLocationDropdownOpen(rowProductId, 'bodega') ? 'up' : 'down'
                                  }`}
                                />
                              </button>

                              {isReceiveLocationDropdownOpen(rowProductId, 'bodega') && (
                                <div className="quick-actions__receive-dropdown-panel">
                                  <div className="quick-actions__receive-dropdown-search">
                                    <Search size={13} />
                                    <input
                                      type="text"
                                      placeholder="Buscar bodega"
                                      value={String(row?.location_draft_bodega_query_input || '')}
                                      onChange={(event) =>
                                        handleReceiveShipmentLocationSearchInput(
                                          rowProductId,
                                          'bodega',
                                          event.target.value
                                        )
                                      }
                                      disabled={receiveShipmentSubmitting}
                                    />
                                  </div>
                                  <div className="quick-actions__receive-dropdown-results">
                                    {!filteredBodegas.length && <small className="muted">Sin resultados.</small>}
                                    {filteredBodegas.map((bodega) => (
                                      <button
                                        key={`receive-bodega-option-${bodega.id}`}
                                        type="button"
                                        className="quick-actions__receive-dropdown-option"
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={(event) => {
                                          event.preventDefault()
                                          event.stopPropagation()
                                          handleReceiveShipmentDraftFieldChange(
                                            rowProductId,
                                            'location_draft_bodega_id',
                                            bodega.id
                                          )
                                          setActiveReceiveLocationDropdown({ productId: '', field: '' })
                                        }}
                                        disabled={receiveShipmentSubmitting}
                                      >
                                        <strong>{String(bodega?.nombre || `Bodega ${bodega.id}`).trim()}</strong>
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>

                            <div
                              className="quick-actions__receive-dropdown"
                              ref={setReceiveLocationDropdownRef(rowProductId, 'division')}
                            >
                              <button
                                type="button"
                                className="quick-actions__receive-dropdown-trigger"
                                onClick={() => toggleReceiveLocationDropdown(rowProductId, 'division')}
                                disabled={receiveShipmentSubmitting || !availableDivisions.length}
                              >
                                <span>
                                  {String(selectedDivision?.nombre || 'Selecciona division').trim()}
                                </span>
                                <i
                                  className={`pi pi-chevron-${
                                    isReceiveLocationDropdownOpen(rowProductId, 'division') ? 'up' : 'down'
                                  }`}
                                />
                              </button>

                              {isReceiveLocationDropdownOpen(rowProductId, 'division') && (
                                <div className="quick-actions__receive-dropdown-panel">
                                  <div className="quick-actions__receive-dropdown-search">
                                    <Search size={13} />
                                    <input
                                      type="text"
                                      placeholder="Buscar division"
                                      value={String(row?.location_draft_division_query_input || '')}
                                      onChange={(event) =>
                                        handleReceiveShipmentLocationSearchInput(
                                          rowProductId,
                                          'division',
                                          event.target.value
                                        )
                                      }
                                      disabled={receiveShipmentSubmitting}
                                    />
                                  </div>
                                  <div className="quick-actions__receive-dropdown-results">
                                    {!filteredDivisions.length && <small className="muted">Sin resultados.</small>}
                                    {filteredDivisions.map((division) => (
                                      <button
                                        key={`receive-division-option-${division.id}`}
                                        type="button"
                                        className="quick-actions__receive-dropdown-option"
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={(event) => {
                                          event.preventDefault()
                                          event.stopPropagation()
                                          handleReceiveShipmentDraftFieldChange(
                                            rowProductId,
                                            'location_draft_division_id',
                                            division.id
                                          )
                                          setActiveReceiveLocationDropdown({ productId: '', field: '' })
                                        }}
                                        disabled={receiveShipmentSubmitting}
                                      >
                                        <strong>{String(division?.nombre || `Division ${division.id}`).trim()}</strong>
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>

                            <div
                              className="quick-actions__receive-dropdown"
                              ref={setReceiveLocationDropdownRef(rowProductId, 'subdivision')}
                            >
                              <button
                                type="button"
                                className="quick-actions__receive-dropdown-trigger"
                                onClick={() => toggleReceiveLocationDropdown(rowProductId, 'subdivision')}
                                disabled={receiveShipmentSubmitting || !availableSubdivisions.length}
                              >
                                <span>
                                  {String(selectedSubdivision?.nombre || 'Selecciona subdivision').trim()}
                                </span>
                                <i
                                  className={`pi pi-chevron-${
                                    isReceiveLocationDropdownOpen(rowProductId, 'subdivision') ? 'up' : 'down'
                                  }`}
                                />
                              </button>

                              {isReceiveLocationDropdownOpen(rowProductId, 'subdivision') && (
                                <div className="quick-actions__receive-dropdown-panel">
                                  <div className="quick-actions__receive-dropdown-search">
                                    <Search size={13} />
                                    <input
                                      type="text"
                                      placeholder="Buscar subdivision"
                                      value={String(row?.location_draft_subdivision_query_input || '')}
                                      onChange={(event) =>
                                        handleReceiveShipmentLocationSearchInput(
                                          rowProductId,
                                          'subdivision',
                                          event.target.value
                                        )
                                      }
                                      disabled={receiveShipmentSubmitting}
                                    />
                                  </div>
                                  <div className="quick-actions__receive-dropdown-results">
                                    {!filteredSubdivisions.length && (
                                      <small className="muted">Sin resultados.</small>
                                    )}
                                    {filteredSubdivisions.map((subdivision) => (
                                      <button
                                        key={`receive-subdivision-option-${subdivision.id}`}
                                        type="button"
                                        className="quick-actions__receive-dropdown-option"
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={(event) => {
                                          event.preventDefault()
                                          event.stopPropagation()
                                          handleReceiveShipmentDraftFieldChange(
                                            rowProductId,
                                            'location_draft_subdivision_id',
                                            subdivision.id
                                          )
                                          setActiveReceiveLocationDropdown({ productId: '', field: '' })
                                        }}
                                        disabled={receiveShipmentSubmitting}
                                      >
                                        <strong>
                                          {String(
                                            subdivision?.nombre || `Subdivision ${subdivision.id}`
                                          ).trim()}
                                        </strong>
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              className="quick-actions__receive-location-add-btn"
                              onClick={() => handleAddReceiveShipmentLocation(rowProductId)}
                              disabled={
                                receiveShipmentSubmitting ||
                                !normalizeId(row?.location_draft_subdivision_id) ||
                                pendingAssignQty <= 0
                              }
                            >
                              Agregar
                            </button>
                          </div>
                          <p className="quick-actions__receive-location-meta">
                            Ubicado: {assignedQty} / {toPositiveInt(row?.cantidad_recibida, 0)}
                          </p>

                          {!!(Array.isArray(row?.ubicaciones) ? row.ubicaciones.length : 0) && (
                            <div className="quick-actions__receive-location-list">
                              {(Array.isArray(row?.ubicaciones) ? row.ubicaciones : []).map((location, index) => {
                                const subdivision = inTransitSubdivisionById.get(normalizeId(location?.subdivision_id))
                                const subdivisionName = String(subdivision?.nombre || `Subdivision ${location?.subdivision_id || '-'}`).trim()
                                const subdivisionBodegaName = String(
                                  subdivision?.division?.bodega?.nombre || ''
                                ).trim()
                                return (
                                  <div
                                    key={`receive-location-${rowProductId}-${normalizeId(location?.subdivision_id)}-${index}`}
                                    className="quick-actions__receive-location-chip"
                                  >
                                    <span>
                                      {subdivisionBodegaName
                                        ? `${subdivisionBodegaName} / ${subdivisionName}`
                                        : subdivisionName}
                                    </span>
                                    <strong>{toPositiveInt(location?.cantidad, 0)}</strong>
                                    <button
                                      type="button"
                                      onClick={() => handleRemoveReceiveShipmentLocation(rowProductId, index)}
                                      disabled={receiveShipmentSubmitting}
                                      aria-label="Quitar ubicacion"
                                    >
                                      <X size={12} />
                                    </button>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>

                        {missingQty > 0 && (
                          <label className="quick-actions__receive-note">
                            <span>Novedad del faltante (obligatoria)</span>
                            <textarea
                              rows={2}
                              value={String(row?.novedad || '')}
                              onChange={(event) =>
                                handleReceiveShipmentDraftFieldChange(
                                  rowProductId,
                                  'novedad',
                                  event.target.value
                                )}
                              disabled={receiveShipmentSubmitting}
                            />
                          </label>
                        )}
                      </article>
                    )
                  })}
                </div>
              )}

              {receiveShipmentError && (
                <p className="quick-actions__receive-error">{receiveShipmentError}</p>
              )}
            </div>

            <footer className="quick-actions__receive-actions">
              <button
                type="button"
                className="quick-actions__receive-btn quick-actions__receive-btn--ghost"
                onClick={closeReceiveShipmentModal}
                disabled={receiveShipmentSubmitting}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={`quick-actions__receive-btn ${
                  receiveShipmentAutoResult === 'incompleto'
                    ? 'quick-actions__receive-btn--danger'
                    : 'quick-actions__receive-btn--success'
                }`}
                onClick={() => void handleSubmitShipmentReception()}
                disabled={receiveShipmentSubmitting}
              >
                {receiveShipmentSubmitting
                  ? 'Guardando...'
                  : (
                    receiveShipmentAutoResult === 'incompleto'
                      ? 'Pedido llego incompleto'
                      : 'Pedido llego sin problemas'
                  )}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  )
}

export default QuickActions
