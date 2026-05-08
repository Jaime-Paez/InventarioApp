import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bell, Loader2, Moon, Search, SunMedium, X } from 'lucide-react'
import { Checkbox } from 'primereact/checkbox'
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
  buildTransferHistoryEntry,
  buildUserIdSet,
  createReminderId,
  emitTransferReminderNotification,
  emitRemindersSync,
  fetchRemindersFromBackend,
  formatCurrentUserName,
  getReminderDecisionStatus,
  getReminderDeadlineTimestamp,
  getReminderTimestamp,
  getLatestTransferHistoryEntry,
  getTransferReminderHistory,
  getTransferReminderPendingSnapshotKey,
  isReminderCreatedByCurrentUser,
  isReminderForCurrentUser,
  isReminderPendingForCurrentUser,
  isReminderSeenByCurrentUser,
  isRandomInspectionReminder,
  isSpecialTransferDecisionReminder,
  isTransferDecisionAllowedForUser,
  normalizeId,
  readRemindersFromStorage,
  reminderCompletedByIds,
  sanitizeRecipient,
  sortRemindersForCurrentUser,
  upsertTransferReminder,
  writeRemindersToStorage,
} from '../common/reminders/remindersStorage'

const URGENT_SHIELD_NEAR_FULL_MS = 60 * 60 * 1000
const URGENT_DECISION_MESSAGE = 'Tienes una solicitud de traslado pendiente.'
const URGENT_SHIPMENT_MESSAGE = 'Tienes un envío pendiente por despachar.'
const URGENT_REJECTED_TRANSFER_MESSAGE = 'Corrige tu solicitud de traslado rechazada.'
const URGENT_MESSAGE_REVEAL_PROGRESS = 0.48
const URGENT_SHIELD_TICK_MS = 1000
const REMINDERS_POLL_MS = 4000
const URGENT_DECISION_SHIELD_COLOR = '#0b4f79'
const URGENT_SHIPMENT_SHIELD_COLOR = '#15803d'
const URGENT_REJECTED_TRANSFER_SHIELD_COLOR = '#f94a15'
const URGENT_SHIELD_STACK_OFFSET_DESKTOP = 22
const URGENT_SHIELD_STACK_OFFSET_MOBILE = 14
const URGENT_SHIELD_STACK_SHADE_STEP = 0.1
const URGENT_SHIELD_STACK_SHADE_MAX = 0.4
const TRANSFER_SALIDA_MODAL_STATE_EVENT = 'inventario-transfer-salida-modal-state'
const REJECTED_TRANSFER_EDITING_EVENT = 'inventario-rejected-transfer-editing'
const RANDOM_INSPECTION_DETAIL_ENDPOINT = `${API_URL}/recordatorios/inspeccion-aleatoria`
const RANDOM_INSPECTION_VERIFY_ITEM_ENDPOINT = `${API_URL}/recordatorios/inspeccion-aleatoria/items`

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))
const isSundayReminderDate = (value) => {
  const raw = String(value || '').trim()
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return false

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
    return false
  }

  return parsed.getDay() === 0
}
const toPositiveInt = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, parsed)
}
const normalizeQuantityInputString = (value) => String(value ?? '').replace(/\D+/g, '').slice(0, 4)
const normalizeIntegerInputString = (value) => {
  const text = normalizeQuantityInputString(value)
  if (!text) return ''
  const parsed = Number.parseInt(text, 10)
  if (!Number.isFinite(parsed)) return ''
  return String(Math.max(0, parsed))
}
const formatSignedInteger = (value) => {
  const normalized = toPositiveInt(Math.abs(Number(value) || 0), 0)
  if (Number(value) > 0) return `+${normalized}`
  if (Number(value) < 0) return `-${normalized}`
  return '0'
}
const readProductInventoryEntries = (payload) => {
  const inventoryContext = payload?.inventario_context ?? payload?.inventory_context
  if (!inventoryContext || typeof inventoryContext !== 'object') return []
  if (Array.isArray(inventoryContext?.inventario_entries)) return inventoryContext.inventario_entries
  if (Array.isArray(inventoryContext?.inventarioEntries)) return inventoryContext.inventarioEntries
  return []
}
const buildInspectionLocationsFromProductPayload = (payload, branchId) => {
  const normalizedBranchId = normalizeId(branchId)
  const entries = readProductInventoryEntries(payload)
  if (!entries.length || !normalizedBranchId) return []

  return entries.reduce((acc, entry) => {
    const subdivision = entry?.subdivision
    const division = subdivision?.division
    const bodega = division?.bodega
    const sucursalId = normalizeId(bodega?.sucursal?.id ?? bodega?.sucursal_id)
    if (!sucursalId || sucursalId !== normalizedBranchId) return acc

    const bodegaNombre = String(bodega?.nombre || '').trim()
    const divisionNombre = String(division?.nombre || '').trim()
    const subdivisionNombre = String(subdivision?.nombre || '').trim()
    const cantidad = toPositiveInt(entry?.cantidad, 0)
    const key = [bodegaNombre, divisionNombre, subdivisionNombre].join('::')
    const existingIndex = acc.findIndex((location) => location.key === key)

    if (existingIndex >= 0) {
      acc[existingIndex] = {
        ...acc[existingIndex],
        cantidad: toPositiveInt(acc[existingIndex]?.cantidad, 0) + cantidad,
      }
      return acc
    }

    acc.push({
      key,
      sucursal_id: toPositiveInt(sucursalId, 0),
      sucursal_nombre: String(bodega?.sucursal?.nombre || '').trim(),
      bodega_nombre: bodegaNombre,
      division_nombre: divisionNombre,
      subdivision_nombre: subdivisionNombre,
      cantidad,
      label: [bodegaNombre, divisionNombre, subdivisionNombre].filter(Boolean).join(' / '),
    })
    return acc
  }, [])
}
const buildInspectionLocationKey = (location) => [
  normalizeId(location?.sucursal_id),
  normalizeString(location?.bodega_nombre),
  normalizeString(location?.division_nombre),
  normalizeString(location?.subdivision_nombre),
].join('::')
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

const normalizeTransferHistoryStage = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return ''
  if (normalized === 'aceptada' || normalized === 'aprobada' || normalized === 'approved') {
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
  if (normalized === 'rechazada' || normalized === 'rechazar' || normalized === 'rejected') {
    return 'rechazada'
  }
  if (normalized === 'pendiente' || normalized === 'creada' || normalized === 'solicitud') {
    return 'pendiente'
  }
  if (normalized === 'completo' || normalized === 'recibido_completo' || normalized === 'llego_completo') {
    return 'completo'
  }
  if (normalized === 'incompleto' || normalized === 'recibido_incompleto' || normalized === 'llego_incompleto') {
    return 'incompleto'
  }
  if (normalized === 'cancelado' || normalized === 'cancelada') {
    return 'cancelado'
  }
  return ''
}

const getEntityTransferHistoryEntries = (entity) => {
  const rawHistory = Array.isArray(entity?.historial_transfer)
    ? entity.historial_transfer
    : Array.isArray(entity?.transferHistory)
      ? entity.transferHistory
      : Array.isArray(entity?.history)
        ? entity.history
        : []

  return rawHistory
    .map((entry) => {
      const stage = normalizeTransferHistoryStage(entry?.stage || entry?.status || entry?.key)
      const at = String(entry?.at || entry?.fecha || '').trim()
      if (!stage) return null
      return { stage, at }
    })
    .filter(Boolean)
    .sort((a, b) => String(a?.at || '').localeCompare(String(b?.at || '')))
}

const getLatestEntityTransferHistoryEntry = (entity, allowedStages = []) => {
  const normalizedAllowedStages = (Array.isArray(allowedStages) ? allowedStages : [])
    .map(normalizeTransferHistoryStage)
    .filter(Boolean)
  const entries = getEntityTransferHistoryEntries(entity)

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!normalizedAllowedStages.length || normalizedAllowedStages.includes(entry.stage)) {
      return entry
    }
  }

  return null
}

const getReminderUrgentSnapshotKey = (reminder, prefix = '') => {
  const snapshotKey = getTransferReminderPendingSnapshotKey(reminder)
  const reminderId = normalizeId(reminder?.id)
  const baseKey = snapshotKey || reminderId
  if (!baseKey) return ''
  return prefix ? `${prefix}-${baseKey}` : baseKey
}

const resolvePendingShipmentStateTimestamp = (shipment) => {
  const latestRelevantEntry = getLatestEntityTransferHistoryEntry(shipment, ['aceptada', 'enviado'])
  return parseEntityTimestamp(
    latestRelevantEntry?.at,
    shipment?.updated_at,
    shipment?.created_at,
    shipment?.createdAt,
    shipment?.fecha
  )
}

const getPendingShipmentUrgentSnapshotKey = (shipment) => {
  const solicitudId = normalizeId(shipment?.id)
  if (!solicitudId) return ''

  const latestRelevantEntry = getLatestEntityTransferHistoryEntry(shipment, ['aceptada', 'enviado'])
  const snapshotStage = latestRelevantEntry?.stage || 'aprobada'
  const snapshotAt = String(
    latestRelevantEntry?.at ||
      shipment?.updated_at ||
      shipment?.created_at ||
      shipment?.createdAt ||
      shipment?.fecha ||
      ''
  ).trim()

  return ['pending-shipment', solicitudId, snapshotStage, snapshotAt].join(':')
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

const normalizeModuleScopeActions = (rawScopes) => {
  const scopes = {}
  ;(Array.isArray(rawScopes) ? rawScopes : []).forEach((item) => {
    const moduleKey = normalizeString(item?.modulo)
    if (!moduleKey) return
    const branchActions = {}
    ;(Array.isArray(item?.acciones_por_sucursal) ? item.acciones_por_sucursal : []).forEach((entry) => {
      const branchId = normalizeId(entry?.sucursal_id)
      if (!branchId) return
      branchActions[branchId] = {
        puede_crear: Boolean(entry?.puede_crear),
        puede_actualizar: Boolean(entry?.puede_actualizar),
        puede_leer: Boolean(entry?.puede_leer),
      }
    })
    if (Object.keys(branchActions).length) scopes[moduleKey] = branchActions
  })
  return scopes
}

const hasAnyModuleScopeAccess = (moduleScopeActions, moduleKey, actionKeys = ['puede_crear', 'puede_actualizar']) => {
  const normalizedModule = normalizeString(moduleKey)
  if (!normalizedModule) return false
  const branchActions = moduleScopeActions?.[normalizedModule]
  if (!branchActions || typeof branchActions !== 'object') return false
  return Object.values(branchActions).some((actions) =>
    actionKeys.some((key) => Boolean(actions?.[key]))
  )
}

const extractTransferDocumentNumber = (value) => {
  const match = String(value || '').match(/#([A-Za-z0-9._-]+)/)
  return match ? String(match[1] || '').trim() : ''
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

const resolveUrgentDecisionProgress = (reminder, nowValue) => {
  const deadline = getReminderDeadlineTimestamp(reminder)
  const stateStartedAt = resolveReminderStateTimestamp(reminder)
  const now = Number(nowValue || Date.now())

  if (!Number.isFinite(stateStartedAt)) {
    if (!Number.isFinite(deadline)) return 0
    return now >= deadline ? 1 : 0
  }

  const elapsed = Math.max(0, now - stateStartedAt)
  const deadlineWindow = Number.isFinite(deadline)
    ? Math.max(1, deadline - stateStartedAt)
    : Number.POSITIVE_INFINITY
  const growthWindow = Math.min(URGENT_SHIELD_NEAR_FULL_MS, deadlineWindow)
  const ratio = elapsed / growthWindow
  return clamp01(ratio)
}

const resolveReminderStateTimestamp = (reminder) => {
  const latestHistoryAt = getLatestTransferHistoryEntry(reminder)?.at
  const decisionAt = String(reminder?.decision?.at || '').trim()
  const date = String(reminder?.date || '').trim()
  const time = String(reminder?.time || '').trim()
  const dateTimeCandidate = date ? `${date}T${time || '00:00'}:00` : ''

  return parseEntityTimestamp(
    latestHistoryAt,
    decisionAt,
    dateTimeCandidate,
    reminder?.createdAt
  )
}

const resolveUrgentShipmentProgress = (shipment, nowValue) => {
  const createdAt = resolvePendingShipmentStateTimestamp(shipment)
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
  onOpenTransferIssuesSection,
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
  const receiveShipmentLoadRequestRef = useRef(0)
  const receiveLocationSearchDebounceRef = useRef({})
  const receiveLocationDropdownRefs = useRef({})
  const audioContextRef = useRef(null)
  const notificationAudioRef = useRef(null)
  const didPlayLoginToneRef = useRef(false)
  const didInitUrgentSnapshotRef = useRef(false)
  const seenUrgentReminderIdsRef = useRef(new Set())
  const didInitGeneralPendingSnapshotRef = useRef(false)
  const seenGeneralPendingReminderIdsRef = useRef(new Set())
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
  const [receiveShipmentShowSummary, setReceiveShipmentShowSummary] = useState(false)
  const [activeRandomInspection, setActiveRandomInspection] = useState(null)
  const [randomInspectionDraftByItemId, setRandomInspectionDraftByItemId] = useState({})
  const [randomInspectionMode, setRandomInspectionMode] = useState('review')
  const [randomInspectionStepIndex, setRandomInspectionStepIndex] = useState(0)
  const [randomInspectionShowSummary, setRandomInspectionShowSummary] = useState(false)
  const [randomInspectionLoading, setRandomInspectionLoading] = useState(false)
  const [randomInspectionSubmitting, setRandomInspectionSubmitting] = useState(false)
  const [randomInspectionError, setRandomInspectionError] = useState('')
  const [activeReceiveLocationDropdown, setActiveReceiveLocationDropdown] = useState({
    productId: '',
    field: '',
  })
  const [receiveLocationPanelRect, setReceiveLocationPanelRect] = useState(null)
  const receiveLocationPortalPanelRef = useRef(null)
  const [editingRejectedTransferSolicitudIds, setEditingRejectedTransferSolicitudIds] = useState(
    () => new Set()
  )
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
  const shouldAnimatePendingShipments = !suppressAdminAlerts && hasPendingShipments
  const currentUserModuleScopes = useMemo(
    () => normalizeModuleScopes(user?.sucursales_por_modulo),
    [user?.sucursales_por_modulo]
  )
  const currentUserModuleScopeActions = useMemo(
    () => normalizeModuleScopeActions(user?.sucursales_por_modulo),
    [user?.sucursales_por_modulo]
  )
  const canDecideTransferRequest = useMemo(() => {
    if (user?.is_staff || user?.is_superuser) return true
    const permissions = Array.isArray(user?.permisos) ? user.permisos : []
    const salidasPermission = permissions.find(
      (permission) => String(permission?.modulo || '').trim().toLowerCase() === 'movimientos_salidas'
    )
    if (salidasPermission?.puede_crear || salidasPermission?.puede_actualizar) return true
    return hasAnyModuleScopeAccess(currentUserModuleScopeActions, 'movimientos_salidas')
  }, [currentUserModuleScopeActions, user])
  const canReceiveTransferRequest = useMemo(() => {
    if (user?.is_staff || user?.is_superuser) return true
    const permissions = Array.isArray(user?.permisos) ? user.permisos : []
    const entradasPermission = permissions.find(
      (permission) => String(permission?.modulo || '').trim().toLowerCase() === 'movimientos_entradas'
    )
    if (entradasPermission?.puede_crear || entradasPermission?.puede_actualizar) return true
    return hasAnyModuleScopeAccess(currentUserModuleScopeActions, 'movimientos_entradas')
  }, [currentUserModuleScopeActions, user])
  const canViewInTransitShipments = canReceiveTransferRequest
  const currentReceiveBranchIds = useMemo(() => {
    if (user?.is_staff || user?.is_superuser) return []

    const branchIds = new Set()
    const branchActions = currentUserModuleScopeActions?.movimientos_entradas
    if (branchActions && typeof branchActions === 'object') {
      Object.entries(branchActions).forEach(([branchId, actions]) => {
        if (actions?.puede_crear || actions?.puede_actualizar || actions?.puede_leer) {
          const normalizedBranchId = normalizeId(branchId)
          if (normalizedBranchId) branchIds.add(normalizedBranchId)
        }
      })
    }

    const scopedBranchIds = currentUserModuleScopes?.movimientos_entradas
    if (Array.isArray(scopedBranchIds)) {
      scopedBranchIds.forEach((branchId) => {
        const normalizedBranchId = normalizeId(branchId)
        if (normalizedBranchId) branchIds.add(normalizedBranchId)
      })
    }

    if (!branchIds.size) {
      ;(Array.isArray(user?.sucursales) ? user.sucursales : []).forEach((branch) => {
        const normalizedBranchId = normalizeId(branch?.id)
        if (normalizedBranchId) branchIds.add(normalizedBranchId)
      })
    }

    return Array.from(branchIds)
  }, [currentUserModuleScopeActions, currentUserModuleScopes, user])
  const currentReceiveBranchIdSet = useMemo(
    () => new Set(currentReceiveBranchIds),
    [currentReceiveBranchIds]
  )
  const shouldIncludeInTransitShipment = useCallback((shipment) => {
    if (user?.is_staff || user?.is_superuser) return true
    if (!currentReceiveBranchIdSet.size) return true

    const destinationBranchId = normalizeId(shipment?.sucursal_solicitante_id)
    if (!destinationBranchId) return false
    return currentReceiveBranchIdSet.has(destinationBranchId)
  }, [currentReceiveBranchIdSet, user])

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
        throw new Error('No se pudieron cargar los envíos pendientes.')
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
        showErrorToast(error?.message || 'No se pudieron cargar los envíos pendientes.')
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
        throw new Error('No se pudieron cargar los envíos en camino.')
      }

      const payload = await response.json().catch(() => ({}))
      const rows = parseApiList(payload)
        .filter((shipment) => shouldIncludeInTransitShipment(shipment))
        .sort((a, b) => {
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
        showErrorToast(error?.message || 'No se pudieron cargar los envíos en camino.')
      }
      return []
    } finally {
      inTransitShipmentsPollInFlightRef.current = false
      if (!silent) setInTransitShipmentsLoading(false)
    }
  }, [canViewInTransitShipments, showErrorToast, shouldIncludeInTransitShipment, token])

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
      title = count > 1 ? `Tienes ${count} envíos pendientes por despachar.` : 'Tienes un envío pendiente por despachar.'
      body = 'Abre Envíos pendientes para continuar.'
    } else if (notificationType === 'solicitud_traslado_resuelta') {
      title = count > 1 ? `Tienes ${count} novedades de traslados.` : 'Tienes una novedad de traslado.'
      body = 'Revisa Recordatorios para ver el último avance.'
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

  const fallbackInTransitShipments = useMemo(() => {
    const existingShipmentIds = new Set(
      (Array.isArray(inTransitShipments) ? inTransitShipments : [])
        .map((shipment) => normalizeId(shipment?.id))
        .filter(Boolean)
    )

    return reminders
      .filter((reminder) => isReminderForCurrentUser(reminder, currentUserIds))
      .filter((reminder) => normalizeReminderContextType(reminder?.context?.type) === 'solicitud_traslado')
      .filter((reminder) => !isSpecialTransferDecisionReminder(reminder))
      .filter((reminder) => getReminderDecisionStatus(reminder) === 'enviado')
      .filter(() => canViewInTransitShipments)
      .filter((reminder) => {
        const solicitudId = normalizeId(reminder?.context?.id)
        return Boolean(solicitudId) && !existingShipmentIds.has(solicitudId)
      })
      .map((reminder) => {
        const solicitudId = normalizeId(reminder?.context?.id)
        const contextLabel = String(reminder?.context?.label || '').trim()
        const documentNumber = extractTransferDocumentNumber(contextLabel || reminder?.description || '')
        return {
          id: solicitudId,
          no_documento: documentNumber,
          fecha: String(reminder?.date || '').trim(),
          sucursal_solicitante: '',
          sucursal_proveedora: '',
          reminder,
          isReminderFallback: true,
          description: String(reminder?.description || '').trim(),
        }
      })
      .sort((a, b) => getReminderTimestamp(b?.reminder) - getReminderTimestamp(a?.reminder))
  }, [canViewInTransitShipments, currentUserIds, inTransitShipments, reminders])

  const visibleInTransitShipments = useMemo(
    () => [
      ...(Array.isArray(inTransitShipments) ? inTransitShipments : []),
      ...fallbackInTransitShipments,
    ],
    [fallbackInTransitShipments, inTransitShipments]
  )

  const hasInTransitShipments = visibleInTransitShipments.length > 0
  const canOpenInTransitShipments = canViewInTransitShipments || fallbackInTransitShipments.length > 0

  const hasPendingReminder = useMemo(
    () => pendingRemindersForCurrentUser.length > 0,
    [pendingRemindersForCurrentUser]
  )

  const generalPendingRemindersForCurrentUser = useMemo(
    () =>
      pendingRemindersForCurrentUser.filter((reminder) => {
        if (isRandomInspectionReminder(reminder)) return false
        if (isResolvedTransferResponseReminder(reminder)) return false
        if (isSpecialTransferDecisionReminder(reminder)) return false
        return true
      }),
    [pendingRemindersForCurrentUser]
  )

  const mobileShipmentCount = canOpenInTransitShipments
    ? pendingShipments.length + visibleInTransitShipments.length
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
          const createdAtA = resolveReminderStateTimestamp(a)
          const createdAtB = resolveReminderStateTimestamp(b)
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
    seenGeneralPendingReminderIdsRef.current = new Set()
    didInitGeneralPendingSnapshotRef.current = false
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
    if (!token || !canOpenInTransitShipments) {
      setInTransitShipments([])
      setInTransitShipmentsLoading(false)
      setIsInTransitShipmentsOpen(false)
      setOpeningInTransitShipmentId('')
      return
    }
    if (!canViewInTransitShipments) {
      setInTransitShipments([])
      setInTransitShipmentsLoading(false)
      setOpeningInTransitShipmentId('')
      return
    }
    void fetchInTransitTransferShipments()
  }, [canOpenInTransitShipments, canViewInTransitShipments, fetchInTransitTransferShipments, token])

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
      if (contextType !== 'solicitud_traslado') return false
      if (isReminderCreatedByCurrentUser(reminder, currentUserIds, currentUserName)) return false
      return isTransferDecisionAllowedForUser(reminder, currentUserIds)
    })
  }, [
    allowVisualUrgentShield,
    canDecideTransferRequest,
    currentUserIds,
    currentUserName,
    pendingSpecialDecisionReminders,
  ])

  const pendingShipmentUrgentTargets = useMemo(() => {
    if (!allowVisualUrgentShield || !canDecideTransferRequest || !hasPendingShipments || isTransferSendModalOpen) return []

    return (Array.isArray(pendingShipments) ? pendingShipments : [])
      .map((solicitud) => {
        const solicitudId = normalizeId(solicitud?.id)
        if (!solicitudId) return null
        const snapshotKey = getPendingShipmentUrgentSnapshotKey(solicitud)

        return {
          id: snapshotKey || `pending-shipment-${solicitudId}`,
          kind: 'pending_shipment',
          anchor: 'pending_shipments',
          message: URGENT_SHIPMENT_MESSAGE,
          priorityTimestamp: resolvePendingShipmentStateTimestamp(solicitud),
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
          const targetId = getReminderUrgentSnapshotKey(reminder, 'decision')

          return {
            id: targetId || reminderId,
            reminderId,
            kind: 'decision',
            anchor: 'top_right',
            message: URGENT_DECISION_MESSAGE,
            priorityTimestamp: resolveReminderStateTimestamp(reminder) || parseEntityTimestamp(dateTimeCandidate),
            reminder,
          }
        })
        .filter(Boolean),
    [eligibleUrgentDecisionReminders]
  )

  useEffect(() => {
    const nextIds = new Set(
      generalPendingRemindersForCurrentUser
        .map((reminder) => normalizeId(reminder?.id))
        .filter(Boolean)
    )

    if (!didInitGeneralPendingSnapshotRef.current) {
      seenGeneralPendingReminderIdsRef.current = nextIds
      didInitGeneralPendingSnapshotRef.current = true
      return
    }

    const seenIds = seenGeneralPendingReminderIdsRef.current
    const hasNewReminder = Array.from(nextIds).some((id) => !seenIds.has(id))
    seenGeneralPendingReminderIdsRef.current = nextIds

    if (hasNewReminder) {
      playNotificationTone({ forceForAdmin: true })
    }
  }, [generalPendingRemindersForCurrentUser, playNotificationTone])

  useEffect(() => {
    const nextPendingReminderIds = eligibleUrgentDecisionReminders
      .map((reminder) => normalizeId(reminder?.id))
      .filter(Boolean)
    const nextSnapshotKeys = new Set(
      eligibleUrgentDecisionReminders
        .map((reminder) => getTransferReminderPendingSnapshotKey(reminder))
        .filter(Boolean)
    )

    if (!didInitUrgentSnapshotRef.current) {
      seenUrgentReminderIdsRef.current = nextSnapshotKeys
      didInitUrgentSnapshotRef.current = true
      playInitialPendingToneIfNeeded(nextPendingReminderIds, {
        type: 'solicitud_traslado_pendiente',
      }, { allowAdminTone: true })
      return
    }

    const seenIds = seenUrgentReminderIdsRef.current
    const newReminderIds = []
    nextSnapshotKeys.forEach((snapshotKey) => {
      if (seenIds.has(snapshotKey)) return
      const reminderId = normalizeId(String(snapshotKey).split(':')[0])
      if (reminderId) newReminderIds.push(reminderId)
    })
    seenUrgentReminderIdsRef.current = nextSnapshotKeys

    if (newReminderIds.length) {
      playNotificationTone({ forceForAdmin: true })
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
          isReminderPendingForCurrentUser(reminder, currentUserIds)
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
      }, { allowAdminTone: true })
      return
    }

    const seenIds = seenRandomInspectionReminderIdsRef.current
    const newReminderIds = []
    nextIds.forEach((id) => {
      if (!seenIds.has(id)) newReminderIds.push(id)
    })
    seenRandomInspectionReminderIdsRef.current = nextIds

    if (newReminderIds.length) {
      playNotificationTone({ forceForAdmin: true })
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

  const pendingRejectedTransferCorrectionReminders = useMemo(
    () =>
      pendingTransferResponseReminders.filter(
        (reminder) =>
          getReminderDecisionStatus(reminder) === 'rechazada' &&
          isReminderCreatedByCurrentUser(reminder, currentUserIds, currentUserName) &&
          !editingRejectedTransferSolicitudIds.has(normalizeId(reminder?.context?.id))
      ),
    [currentUserIds, currentUserName, editingRejectedTransferSolicitudIds, pendingTransferResponseReminders]
  )

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handleRejectedTransferEditing = (event) => {
      const solicitudId = normalizeId(event?.detail?.solicitudId)
      if (!solicitudId) return

      setEditingRejectedTransferSolicitudIds((prev) => {
        const next = new Set(prev)
        if (event?.detail?.active) next.add(solicitudId)
        else next.delete(solicitudId)
        return next
      })
    }

    window.addEventListener(REJECTED_TRANSFER_EDITING_EVENT, handleRejectedTransferEditing)
    return () => {
      window.removeEventListener(REJECTED_TRANSFER_EDITING_EVENT, handleRejectedTransferEditing)
    }
  }, [])

  useEffect(() => {
    const responseSnapshots = pendingTransferResponseReminders
      .map((reminder) => ({
        reminderId: normalizeId(reminder?.id),
        snapshotKey: getTransferReminderPendingSnapshotKey(reminder) || normalizeId(reminder?.id),
      }))
      .filter((item) => item.reminderId && item.snapshotKey)
    const nextReminderIds = responseSnapshots.map((item) => item.reminderId)
    const nextIds = new Set(responseSnapshots.map((item) => item.snapshotKey))

	    if (!didInitTransferResponseSnapshotRef.current) {
	      seenTransferResponseReminderIdsRef.current = nextIds
	      didInitTransferResponseSnapshotRef.current = true
	      playInitialPendingToneIfNeeded(nextReminderIds, {
	        type: 'solicitud_traslado_resuelta',
	      }, { allowAdminTone: true })
	      return
	    }

    const seenIds = seenTransferResponseReminderIdsRef.current
    const nextReminderIdsSet = new Set()
    responseSnapshots.forEach(({ reminderId, snapshotKey }) => {
      if (!seenIds.has(snapshotKey)) nextReminderIdsSet.add(reminderId)
    })
    seenTransferResponseReminderIdsRef.current = nextIds
    const newReminderIds = Array.from(nextReminderIdsSet)

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

  const urgentRejectedTransferTargets = useMemo(
    () =>
      !allowUrgentShield
        ? []
        : pendingRejectedTransferCorrectionReminders
            .map((reminder) => {
              const reminderId = normalizeId(reminder?.id)
              if (!reminderId) return null

              const date = String(reminder?.date || '').trim()
              const time = String(reminder?.time || '').trim()
              const dateTimeCandidate = date ? `${date}T${time || '00:00'}:00` : ''
              const targetId = getReminderUrgentSnapshotKey(reminder, 'rejected-transfer')

              return {
                id: targetId || `rejected-transfer-${reminderId}`,
                reminderId,
                kind: 'rejected_transfer',
                anchor: 'top_right',
                message: URGENT_REJECTED_TRANSFER_MESSAGE,
                priorityTimestamp: resolveReminderStateTimestamp(reminder) || parseEntityTimestamp(dateTimeCandidate),
                reminder,
              }
            })
            .filter(Boolean),
    [allowUrgentShield, pendingRejectedTransferCorrectionReminders]
  )

  const urgentShieldTargets = useMemo(() => {
    const merged = [...urgentRejectedTransferTargets, ...urgentDecisionTargets]
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
  }, [urgentDecisionTargets, urgentRejectedTransferTargets])

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
    const viewportHeight = window.innerHeight
    const maxCanvasBase = Math.max(viewportWidth, viewportHeight) * 1.35
    const viewportLimit = Math.max(viewportWidth * 1.3, viewportHeight * 1.1)
    const maxCanvas = Math.min(maxCanvasBase, viewportLimit)
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
        const stackShade = Math.min(
          anchorStackIndex * URGENT_SHIELD_STACK_SHADE_STEP,
          URGENT_SHIELD_STACK_SHADE_MAX
        )
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
            '--urgent-stack-shade': String(stackShade.toFixed(3)),
            '--urgent-color':
              target?.kind === 'pending_shipment'
                ? URGENT_SHIPMENT_SHIELD_COLOR
                : target?.kind === 'rejected_transfer'
                  ? URGENT_REJECTED_TRANSFER_SHIELD_COLOR
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
    const isCompactDesktop = !isMobileViewport && viewportWidth <= 1400
    const mobileScale = isMobileViewport
      ? Math.max(0.7, Math.min(1, viewportWidth / 420))
      : 1
    const compactDesktopScale = isCompactDesktop ? Math.min(1, viewportWidth / 1440) : 1

    const shieldCenterX = shieldLeft + shieldSize / 2
    const shieldCenterY = shieldTop + shieldSize / 2
    const viewportCenterX = viewportWidth / 2
    const viewportCenterY = viewportHeight / 2
    const vectorX = viewportCenterX - shieldCenterX
    const vectorY = viewportCenterY - shieldCenterY

    const edgePadding = isMobileViewport ? 8 : 12
    const radius = shieldSize / 2
    const usableRadius = Math.max(1, radius - edgePadding)

    const minFont = isMobileViewport ? 8 : isCompactDesktop ? 9 : 11
    const desktopMaxFont = 52
    const maxFont = isMobileViewport
      ? Math.round(28 * mobileScale * compactDesktopScale)
      : Math.round(desktopMaxFont * compactDesktopScale)
    let fontSize = Math.round(minFont + (maxFont - minFont) * progress)

    const minWidth = isMobileViewport
      ? Math.max(100, Math.round(viewportWidth * 0.28))
      : Math.max(180, Math.round(viewportWidth * 0.2))
    const maxWidth = isMobileViewport
      ? Math.min(360, Math.round(viewportWidth * 0.7))
      : Math.min(840, viewportWidth - edgePadding * 2)
    const absoluteMinWidth = isMobileViewport ? 100 : 150
    const shieldInset = isMobileViewport ? 24 : 14
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
    const verticalBias = isMobileViewport
      ? Math.round(shieldSize * 0.12)
      : isCompactDesktop
        ? Math.round(shieldSize * 0.08)
        : Math.round(shieldSize * 0.04)
    const centerX = shieldCenterX + vectorX * travel
    const centerY = shieldCenterY + vectorY * travel + verticalBias
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
    const now = Date.now()
    const related = reminders.filter((reminder) => {
      if (!isReminderForCurrentUser(reminder, currentUserIds)) return false

      // Inspections only appear in the list once their scheduled time has arrived
      if (isRandomInspectionReminder(reminder) && !isReminderSeenByCurrentUser(reminder, currentUserIds)) {
        const timestamp = getReminderTimestamp(reminder)
        if (Number.isFinite(timestamp) && timestamp > now) return false
      }

      return true
    })
    return sortRemindersForCurrentUser(related, currentUserIds)
  }, [reminders, currentUserIds])

  const receiveLocationBodegas = useMemo(() => {
    const map = new Map()
    ;(Array.isArray(inTransitBodegas) ? inTransitBodegas : []).forEach((bodega) => {
      const bodegaId = normalizeId(bodega?.id)
      if (!bodegaId || map.has(bodegaId)) return
      map.set(bodegaId, bodega)
    })
    ;(Array.isArray(inTransitDivisions) ? inTransitDivisions : []).forEach((division) => {
      const bodega = division?.bodega
      const bodegaId = normalizeId(bodega?.id || division?.bodega_id || '')
      if (!bodegaId || map.has(bodegaId)) return
      map.set(bodegaId, bodega)
    })
    ;(Array.isArray(inTransitSubdivisions) ? inTransitSubdivisions : []).forEach((subdivision) => {
      const bodega = subdivision?.division?.bodega
      const bodegaId = normalizeId(bodega?.id || subdivision?.division?.bodega_id || '')
      if (!bodegaId || map.has(bodegaId)) return
      map.set(bodegaId, bodega)
    })
    return Array.from(map.values()).sort((a, b) =>
      String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es')
    )
  }, [inTransitBodegas, inTransitDivisions, inTransitSubdivisions])

  const receiveLocationDivisions = useMemo(() => {
    const map = new Map()
    ;(Array.isArray(inTransitDivisions) ? inTransitDivisions : []).forEach((division) => {
      const divisionId = normalizeId(division?.id)
      if (!divisionId || map.has(divisionId)) return
      map.set(divisionId, division)
    })
    ;(Array.isArray(inTransitSubdivisions) ? inTransitSubdivisions : []).forEach((subdivision) => {
      const division = subdivision?.division
      const divisionId = normalizeId(division?.id || subdivision?.division_id || '')
      if (!divisionId || map.has(divisionId)) return
      map.set(divisionId, division)
    })
    return Array.from(map.values()).sort((a, b) =>
      String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es')
    )
  }, [inTransitDivisions, inTransitSubdivisions])

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
        receiveLocationBodegas.map((bodega) => [
          normalizeId(bodega?.id),
          bodega,
        ])
      ),
    [receiveLocationBodegas]
  )

  const inTransitDivisionById = useMemo(
    () =>
      new Map(
        receiveLocationDivisions.map((division) => [
          normalizeId(division?.id),
          division,
        ])
      ),
    [receiveLocationDivisions]
  )

  const inTransitDivisionsByBodegaId = useMemo(() => {
    const map = new Map()
    receiveLocationDivisions.forEach((division) => {
      const bodegaId = normalizeId(division?.bodega?.id || division?.bodega_id || '')
      if (!bodegaId) return
      const current = map.get(bodegaId) || []
      map.set(bodegaId, [...current, division])
    })
    return map
  }, [receiveLocationDivisions])

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

  const receiveShipmentRows = useMemo(() => {
    const rows = Object.values(receiveShipmentDraftByProductId || {}).sort(
      (first, second) => Number(first?.orden || 0) - Number(second?.orden || 0)
    )

    return rows.map((row) => {
        const sentQty = toPositiveInt(row?.cantidad_enviada, 0)
        const receivedQty = toPositiveInt(row?.cantidad_recibida, 0)
        const receivedQtyInput = Object.prototype.hasOwnProperty.call(row, 'cantidad_recibida_input')
          ? String(row?.cantidad_recibida_input ?? '')
          : String(receivedQty)
        const missingQty = Math.max(0, sentQty - receivedQty)
        const selectedSubdivisionId = normalizeId(row?.location_draft_subdivision_id)
        const locations = selectedSubdivisionId && receivedQty > 0
          ? [{ subdivision_id: selectedSubdivisionId, cantidad: receivedQty }]
          : []
        const assignedQty = locations.reduce(
          (total, location) => total + toPositiveInt(location?.cantidad, 0),
          0
        )
        return {
          ...row,
          cantidad_enviada: sentQty,
          cantidad_recibida: receivedQty,
          cantidad_recibida_input: receivedQtyInput,
          cantidad_faltante: missingQty,
          ubicaciones: locations,
          cantidad_asignada: assignedQty,
        }
      })
  }, [receiveShipmentDraftByProductId])

  const receiveShipmentSourceBranchName = useMemo(
    () => String(activeInTransitShipment?.sucursal_proveedora || 'Sucursal proveedora').trim(),
    [activeInTransitShipment]
  )

  const receiveShipmentTransferCode = useMemo(
    () => String(activeInTransitShipment?.no_documento || activeInTransitShipment?.id || '').trim(),
    [activeInTransitShipment]
  )

  const receiveShipmentDestinationBranchName = useMemo(
    () => String(activeInTransitShipment?.sucursal_solicitante || 'Sucursal destino').trim(),
    [activeInTransitShipment]
  )

  const getReceiveShipmentRowLabel = useCallback((row) => {
    const fallbackId = normalizeId(row?.producto_id)
    return (
      String(row?.producto_nombre || row?.producto_codigo || '').trim() ||
      `producto ${fallbackId || '-'}`
    )
  }, [])

  const getReceiveShipmentRowValidationMessage = useCallback(
    (row, { requireReviewed = false } = {}) => {
      const productLabel = getReceiveShipmentRowLabel(row)
      const receivedQty = toPositiveInt(row?.cantidad_recibida, 0)
      const assignedQty = toPositiveInt(row?.cantidad_asignada, 0)

      if (requireReviewed && !row?.recepcion_revisada) {
        return `Debes marcar como revisado ${productLabel}.`
      }
      if (receivedQty > 0 && assignedQty !== receivedQty) {
        return `No hay una ubicacion valida para ${productLabel}.`
      }
      return ''
    },
    [getReceiveShipmentRowLabel]
  )

  const receiveShipmentReviewedCount = useMemo(
    () => receiveShipmentRows.filter((row) => Boolean(row?.recepcion_revisada)).length,
    [receiveShipmentRows]
  )

  const receiveShipmentAllReviewed = (
    receiveShipmentRows.length > 0 &&
    receiveShipmentReviewedCount === receiveShipmentRows.length
  )
  const receiveShipmentSomeReviewed = (
    receiveShipmentReviewedCount > 0 &&
    receiveShipmentReviewedCount < receiveShipmentRows.length
  )

  const receiveShipmentReadyCount = useMemo(
    () =>
      receiveShipmentRows.filter((row) => !getReceiveShipmentRowValidationMessage(row)).length,
    [getReceiveShipmentRowValidationMessage, receiveShipmentRows]
  )

  const activeReceiveShipmentStepIndex = 0
  const activeReceiveShipmentRow = receiveShipmentRows[activeReceiveShipmentStepIndex] || null

  const randomInspectionRows = useMemo(
    () =>
      (Array.isArray(activeRandomInspection?.items) ? activeRandomInspection.items : []).map((item) => {
        const itemId = normalizeId(item?.id)
        const draft = randomInspectionDraftByItemId?.[itemId] || {}
        const expectedQty = toPositiveInt(item?.cantidad_esperada, 0)
        const locations = (Array.isArray(item?.ubicaciones_bodega) ? item.ubicaciones_bodega : [])
          .map((location) => ({
            ...location,
            key: buildInspectionLocationKey(location),
          }))
          .filter((location) => Boolean(location.key))
        const useLocationInputs = locations.length > 1
        const baseReportInput = item?.cantidad_reportada == null
          ? ''
          : String(toPositiveInt(item?.cantidad_reportada, expectedQty))
        const locationCountDraft = (
          draft?.cantidad_reportada_por_ubicacion &&
          typeof draft.cantidad_reportada_por_ubicacion === 'object'
        )
          ? draft.cantidad_reportada_por_ubicacion
          : {}
        const locationInputs = useLocationInputs
          ? locations.map((location) => {
            const rawInput = Object.prototype.hasOwnProperty.call(locationCountDraft, location.key)
              ? String(locationCountDraft?.[location.key] || '')
              : ''
            return {
              ...location,
              cantidad_contada_input: rawInput,
              cantidad_contada: rawInput ? toPositiveInt(rawInput, 0) : null,
            }
          })
          : []
        const allLocationInputsAnswered = useLocationInputs
          ? locationInputs.every((location) => String(location?.cantidad_contada_input || '').trim() !== '')
          : false
        const reportInput = useLocationInputs
          ? (allLocationInputsAnswered
            ? String(locationInputs.reduce((total, location) => total + toPositiveInt(location?.cantidad_contada, 0), 0))
            : '')
          : (
            Object.prototype.hasOwnProperty.call(draft, 'cantidad_reportada_input')
              ? String(draft?.cantidad_reportada_input || '')
              : baseReportInput
          )
        const normalizedItemState = String(item?.estado_revision || '').trim().toLowerCase()
        const isAnswered = useLocationInputs
          ? allLocationInputsAnswered
          : String(reportInput).trim() !== ''
        const reportedQty = isAnswered ? toPositiveInt(reportInput, expectedQty) : null
        let estadoRevision = 'pendiente'
        if (normalizedItemState === 'coincide' || normalizedItemState === 'no_coincide') {
          estadoRevision = normalizedItemState
        } else if (reportedQty != null) {
          estadoRevision = reportedQty === expectedQty ? 'coincide' : 'no_coincide'
        }
        return {
          ...item,
          row_id: itemId,
          estado_revision: estadoRevision,
          cantidad_esperada: expectedQty,
          cantidad_reportada: reportedQty,
          cantidad_reportada_input: reportInput,
          cantidad_reportada_por_ubicacion: locationCountDraft,
          ubicaciones_bodega: useLocationInputs ? locationInputs : locations,
          requiere_conteo_por_ubicacion: useLocationInputs,
          respondido: isAnswered,
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

  const randomInspectionAnsweredCount = useMemo(
    () =>
      randomInspectionRows.filter((row) => row?.cantidad_reportada != null).length,
    [randomInspectionRows]
  )

  const activeRandomInspectionStepIndex = useMemo(() => {
    if (!randomInspectionRows.length) return 0
    return Math.min(randomInspectionStepIndex, randomInspectionRows.length - 1)
  }, [randomInspectionRows.length, randomInspectionStepIndex])

  const activeRandomInspectionRow = useMemo(
    () => randomInspectionRows[activeRandomInspectionStepIndex] || null,
    [activeRandomInspectionStepIndex, randomInspectionRows]
  )
  const isRandomInspectionSummaryVisible = (
    !isRandomInspectionVerifyMode &&
    randomInspectionShowSummary
  )
  const randomInspectionMatchedCount = Math.max(
    0,
    randomInspectionAnsweredCount - randomInspectionMismatchCount
  )
  const randomInspectionAllAnswersReady = (
    randomInspectionRows.length > 0 &&
    randomInspectionAnsweredCount === randomInspectionRows.length
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

  const toggleReceiveLocationDropdown = useCallback((productId, field, usePortal = false) => {
    const normalizedProductId = normalizeId(productId)
    const normalizedField = String(field || '').trim().toLowerCase()
    if (!normalizedProductId || !normalizedField) return
    setActiveReceiveLocationDropdown((prev) => {
      const prevProductId = normalizeId(prev?.productId)
      const prevField = String(prev?.field || '').trim().toLowerCase()
      if (prevProductId === normalizedProductId && prevField === normalizedField) {
        setReceiveLocationPanelRect(null)
        return { productId: '', field: '' }
      }
      if (usePortal) {
        const key = buildReceiveLocationDropdownKey(normalizedProductId, normalizedField)
        const wrapper = receiveLocationDropdownRefs.current?.[key]
        if (wrapper) {
          const trigger = wrapper.querySelector('.quick-actions__receive-dropdown-trigger')
          if (trigger) {
            const rect = trigger.getBoundingClientRect()
            setReceiveLocationPanelRect({ top: rect.bottom + 6, left: rect.left, width: rect.width })
          }
        }
      } else {
        setReceiveLocationPanelRect(null)
      }
      return {
        productId: normalizedProductId,
        field: normalizedField,
      }
    })
  }, [buildReceiveLocationDropdownKey])

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

    if (isSundayReminderDate(normalizedDate)) {
      showErrorToast('Los recordatorios no se pueden programar en domingo.')
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
            const isRejectedCorrectionReminder = (
              getReminderDecisionStatus(reminder) === 'rechazada' &&
              isReminderCreatedByCurrentUser(reminder, currentUserIds, currentUserName)
            )
            if (isRejectedCorrectionReminder) return reminder

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
    [applyReminderUpdate, currentUserIdValues, currentUserIds, currentUserName]
  )

  const closeReminderModal = useCallback(() => {
    setIsReminderModalOpen(false)
    setFocusReminderId('')
  }, [])

  const closeReceiveShipmentModal = useCallback(() => {
    receiveShipmentLoadRequestRef.current += 1
    Object.values(receiveLocationSearchDebounceRef.current || {}).forEach((timerId) => {
      clearTimeout(timerId)
    })
    receiveLocationSearchDebounceRef.current = {}
    receiveLocationDropdownRefs.current = {}
    setActiveReceiveLocationDropdown({ productId: '', field: '' })
    setIsReceiveShipmentModalOpen(false)
    setOpeningInTransitShipmentId('')
    setActiveInTransitShipment(null)
    setInTransitBodegas([])
    setInTransitDivisions([])
    setInTransitSubdivisions([])
    setInTransitSubdivisionsLoading(false)
    setReceiveShipmentDraftByProductId({})
    setReceiveShipmentError('')
    setReceiveShipmentSubmitting(false)
    setReceiveShipmentShowSummary(false)
  }, [])

  const openReceiveShipmentModalShell = useCallback(({ shipmentId, shipment, draftByProductId = {} }) => {
    const nextLoadRequestId = receiveShipmentLoadRequestRef.current + 1
    receiveShipmentLoadRequestRef.current = nextLoadRequestId

    setOpeningInTransitShipmentId(shipmentId)
    setReceiveShipmentError('')
    setInTransitBodegas([])
    setInTransitDivisions([])
    setInTransitSubdivisions([])
    setInTransitSubdivisionsLoading(true)
    setReceiveShipmentDraftByProductId(draftByProductId)
    setActiveInTransitShipment(shipment)
    setReceiveShipmentShowSummary(false)
    setIsInTransitShipmentsOpen(false)
    setIsReceiveShipmentModalOpen(true)

    return nextLoadRequestId
  }, [])

  const closeRandomInspectionModal = useCallback(() => {
    setIsRandomInspectionModalOpen(false)
    setActiveRandomInspection(null)
    setRandomInspectionDraftByItemId({})
    setRandomInspectionMode('review')
    setRandomInspectionStepIndex(0)
    setRandomInspectionShowSummary(false)
    setRandomInspectionError('')
    setRandomInspectionSubmitting(false)
    setRandomInspectionLoading(false)
  }, [])

  const buildRandomInspectionDraft = useCallback((inspection) => {
    const rows = Array.isArray(inspection?.items) ? inspection.items : []
    return rows.reduce((acc, item) => {
      const itemId = normalizeId(item?.id)
      if (!itemId) return acc
      acc[itemId] = {
        id: itemId,
        cantidad_reportada_input: item?.cantidad_reportada == null
          ? ''
          : String(toPositiveInt(item?.cantidad_reportada, 0)),
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

  const enrichRandomInspectionWithProductLocations = useCallback(
    async (inspection) => {
      const rows = Array.isArray(inspection?.items) ? inspection.items : []
      if (!token || !rows.length) return inspection

      const rowsMissingLocations = rows.filter((item) => {
        const locations = Array.isArray(item?.ubicaciones_bodega) ? item.ubicaciones_bodega : []
        return locations.length <= 0
      })
      if (!rowsMissingLocations.length) return inspection

      const uniqueProductIds = Array.from(
        new Set(
          rowsMissingLocations
            .map((item) => normalizeId(item?.producto_id))
            .filter(Boolean)
        )
      )
      if (!uniqueProductIds.length) return inspection

      const productLocationMap = new Map()
      await Promise.all(uniqueProductIds.map(async (productId) => {
        const response = await authFetch(
          `${API_URL}/productos/listado/${encodeURIComponent(productId)}/?include_inventory_context=1`,
          {},
          token
        )
        if (!response.ok) return
        const payload = await response.json().catch(() => ({}))
        productLocationMap.set(String(productId), payload)
      }))

      const nextItems = rows.map((item) => {
        const currentLocations = Array.isArray(item?.ubicaciones_bodega) ? item.ubicaciones_bodega : []
        if (currentLocations.length > 0) return item

        const productPayload = productLocationMap.get(normalizeId(item?.producto_id))
        const locations = buildInspectionLocationsFromProductPayload(productPayload, item?.sucursal_id)
        if (!locations.length) return item

        return {
          ...item,
          ubicaciones_bodega: locations.map((location) => ({
            sucursal_id: location.sucursal_id,
            sucursal_nombre: location.sucursal_nombre,
            bodega_nombre: location.bodega_nombre,
            division_nombre: location.division_nombre,
            subdivision_nombre: location.subdivision_nombre,
            cantidad: location.cantidad,
            label: location.label,
          })),
          ubicacion_bodega: locations.map((location) => `${location.label} (${toPositiveInt(location?.cantidad, 0)} uds)`).join('\n'),
        }
      })

      return {
        ...inspection,
        items: nextItems,
      }
    },
    [token]
  )

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
      return enrichRandomInspectionWithProductLocations(inspection)
    },
    [enrichRandomInspectionWithProductLocations, token]
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
      setRandomInspectionStepIndex(0)
      setRandomInspectionShowSummary(false)
      setIsRandomInspectionModalOpen(true)
      try {
        const inspection = await fetchRandomInspectionDetail(inspectionId)
        const inspectionStatus = String(inspection?.estado || '').trim().toLowerCase()
        if (!isVerifyReminder && inspectionStatus === 'completada') {
          closeRandomInspectionModal()
          showErrorToast('Esta inspección ya fue enviada y no puede volver a realizarse.')
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
      if (receiveLocationPortalPanelRef.current?.contains(event.target)) return
      setReceiveLocationPanelRect(null)
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
      const currentTransferReminder = existingReminders.find(
        (reminder) =>
          normalizeReminderContextType(reminder?.context?.type) === 'solicitud_traslado' &&
          normalizeId(reminder?.context?.id) === solicitudId
      ) || null
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

      const providerRecipients = await resolveProviderReminderRecipients(
        shipment?.sucursal_proveedora_id
      )
      providerRecipients.forEach((recipient) => {
        appendUniqueRecipient(reminderRecipients, recipient)
      })

      if (!reminderRecipients.length) return

      const now = nowReminderDateTime()
      const requesterName = String(shipment?.sucursal_solicitante || '').trim() || 'Sucursal solicitante'
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
        : `${shortReference} llego completo en ${requesterName}.`

      const reminder = {
        id: normalizeId(currentTransferReminder?.id) || createReminderId(),
        date: now.date,
        time: now.time,
        description,
        creator: currentTransferReminder?.creator || currentActorRecipient,
        recipients: reminderRecipients,
        context: {
          type: 'solicitud_traslado',
          id: solicitudId,
          label: contextLabel,
        },
        kind: 'recordatorio_general',
        createdAt: currentTransferReminder?.createdAt || now.iso,
        decision: {
          ...(currentTransferReminder?.decision || {}),
          assignedRecipients: currentTransferReminder?.decision?.assignedRecipients || [],
        },
        transferHistory: [
          ...getTransferReminderHistory(currentTransferReminder),
          buildTransferHistoryEntry({
            stage: result === 'incompleto' ? 'incompleto' : 'completo',
            description,
            at: now.iso,
            actor: currentActorRecipient,
          }),
        ],
        completedBy: [],
      }

      writeRemindersToStorage(upsertTransferReminder(existingReminders, reminder))
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

  const toggleInTransitShipmentsPanel = () => {
    if (!canOpenInTransitShipments) return
    if (isInTransitShipmentsOpen) {
      setIsInTransitShipmentsOpen(false)
      return
    }
    setIsPendingShipmentsOpen(false)
    setIsInTransitShipmentsOpen(true)
    if (canViewInTransitShipments) {
      void fetchInTransitTransferShipments()
    }
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
    (shipment) => {
      if (!token) return
      const shipmentId = normalizeId(shipment?.id)
      if (!shipmentId) {
        showErrorToast('No se pudo abrir el envío en camino.')
        return
      }
      const sucursalSolicitanteId = normalizeId(shipment?.sucursal_solicitante_id)
      if (!sucursalSolicitanteId) {
        showErrorToast('No se pudo resolver la sucursal solicitante para recibir el traslado.')
        return
      }
      const details = Array.isArray(shipment?.detalles) ? shipment.detalles : []
      if (!details.length) {
        showErrorToast('Este envío no tiene productos para registrar recepción.')
        return
      }

      // Phase 1: open the modal immediately with an empty-location draft
      const initialDraft = {}
      details.forEach((detail, index) => {
        const productId = normalizeId(detail?.producto_id)
        if (!productId) return
        const cantidadEnviada = toPositiveInt(detail?.cantidad_enviada, 0)
        initialDraft[productId] = {
          orden: index,
          producto_id: toPositiveInt(detail?.producto_id, 0),
          producto_codigo: String(detail?.producto_codigo || '').trim(),
          producto_nombre: String(detail?.producto_nombre || '').trim(),
          cantidad_enviada: cantidadEnviada,
          cantidad_recibida: cantidadEnviada,
          cantidad_recibida_input: String(cantidadEnviada),
          recepcion_revisada: false,
          novedad: '',
          ubicaciones: [],
          location_draft_bodega_id: '',
          location_draft_bodega_query_input: '',
          location_draft_bodega_query: '',
          location_draft_division_id: '',
          location_draft_division_query_input: '',
          location_draft_division_query: '',
          location_draft_subdivision_id: '',
          location_draft_subdivision_query_input: '',
          location_draft_subdivision_query: '',
        }
      })

      const loadRequestId = openReceiveShipmentModalShell({
        shipmentId,
        shipment,
        draftByProductId: initialDraft,
      })

      // Open first and hydrate catalogs afterwards so the modal feels instant.
      void (async () => {
        try {
          const [bodegasResponse, divisionsResponse, subdivisionsResponse] = await Promise.all([
          authFetch(
            `${API_URL}/inventario/bodegas/?page_size=500&sucursal_id=${encodeURIComponent(
              sucursalSolicitanteId
            )}`,
            {},
            token
          ),
          authFetch(
            `${API_URL}/inventario/divisiones/?page_size=500&sucursal_id=${encodeURIComponent(
              sucursalSolicitanteId
            )}`,
            {},
            token
          ),
          authFetch(
            `${API_URL}/inventario/subdivisiones/?page_size=500&sucursal_id=${encodeURIComponent(
              sucursalSolicitanteId
            )}`,
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
        if (receiveShipmentLoadRequestRef.current !== loadRequestId) return
        const bodegas = parseApiList(bodegasPayload)
        const divisions = parseApiList(divisionsPayload)
        const subdivisions = parseApiList(subdivisionsPayload)

        const preferredSubdivisionByProductId = await fetchPreferredReceiveSubdivisions({
          sucursalSolicitanteId,
          productIds: details.map((detail) => detail?.producto_id),
        })
        if (receiveShipmentLoadRequestRef.current !== loadRequestId) return

        const localSubdivisionsById = new Map()
        subdivisions.forEach((subdivision) => {
          const subdivisionId = normalizeId(subdivision?.id)
          if (!subdivisionId) return
          localSubdivisionsById.set(subdivisionId, subdivision)
        })

        setInTransitBodegas(bodegas)
        setInTransitDivisions(divisions)
        setInTransitSubdivisions(subdivisions)

        // Patch the draft with preferred locations now that subdivision data is available
        setReceiveShipmentDraftByProductId((prev) => {
          if (receiveShipmentLoadRequestRef.current !== loadRequestId) return prev
          const updated = { ...prev }
          details.forEach((detail) => {
            const productId = normalizeId(detail?.producto_id)
            if (!productId || !updated[productId]) return
            const preferredSubdivisionId = normalizeId(
              preferredSubdivisionByProductId.get(productId) || ''
            )
            const suggestedSubdivision = localSubdivisionsById.get(preferredSubdivisionId) || null
            const suggestedSubdivisionId = normalizeId(suggestedSubdivision?.id || '')
            const suggestedDivisionId = normalizeId(
              suggestedSubdivision?.division?.id || suggestedSubdivision?.division_id || ''
            )
            const suggestedBodegaId = normalizeId(
              suggestedSubdivision?.division?.bodega?.id ||
                suggestedSubdivision?.division?.bodega_id ||
                ''
            )
            if (suggestedSubdivisionId && suggestedDivisionId && suggestedBodegaId) {
              const cantidadEnviada = toPositiveInt(detail?.cantidad_enviada, 0)
              updated[productId] = {
                ...updated[productId],
                ubicaciones: [{ subdivision_id: suggestedSubdivisionId, cantidad: cantidadEnviada }],
                location_draft_bodega_id: suggestedBodegaId,
                location_draft_division_id: suggestedDivisionId,
                location_draft_subdivision_id: suggestedSubdivisionId,
              }
            }
          })
          return updated
        })
      } catch (error) {
        if (receiveShipmentLoadRequestRef.current !== loadRequestId) return
        showErrorToast(error?.message || 'No se pudieron cargar las ubicaciones del envío.')
        } finally {
          if (receiveShipmentLoadRequestRef.current === loadRequestId) {
            setOpeningInTransitShipmentId('')
            setInTransitSubdivisionsLoading(false)
          }
        }
      })()
    },
    [fetchPreferredReceiveSubdivisions, openReceiveShipmentModalShell, showErrorToast, token]
  )

  const handleOpenInTransitShipmentFromReminder = useCallback(
    async (reminder) => {
      if (!token) return false

      const solicitudId = normalizeId(reminder?.context?.id)
      if (!solicitudId) {
        showErrorToast('No se pudo identificar el envío en camino del recordatorio.')
        return false
      }

      let availableShipments = Array.isArray(inTransitShipments) ? inTransitShipments : []
      let targetShipment = availableShipments.find(
        (shipment) => normalizeId(shipment?.id) === solicitudId
      ) || null

      if (!targetShipment) {
        availableShipments = await fetchInTransitTransferShipments({ silent: true })
        targetShipment = (Array.isArray(availableShipments) ? availableShipments : []).find(
          (shipment) => normalizeId(shipment?.id) === solicitudId
        ) || null
      }

      if (!targetShipment) {
        openReceiveShipmentModalShell({
          shipmentId: solicitudId,
          shipment: {
            id: Number(solicitudId) || solicitudId,
            no_documento: extractTransferDocumentNumber(
              String(reminder?.context?.label || '').trim() || reminder?.description || ''
            ),
            fecha: String(reminder?.date || '').trim(),
            sucursal_solicitante: '',
            sucursal_proveedora: '',
            reminder,
          },
          draftByProductId: {},
        })

        const detail = await fetchTransferSolicitudDetail(solicitudId)
        if (detail?.movimiento_entrada_id && Array.isArray(detail?.detalles) && detail.detalles.length) {
          targetShipment = {
            id: Number(solicitudId) || solicitudId,
            no_documento: String(detail?.no_documento || '').trim(),
            fecha: detail?.fecha || '',
            sucursal_solicitante_id: toPositiveInt(detail?.sucursal_solicitante_id, 0),
            sucursal_solicitante: String(detail?.sucursal_solicitante_nombre || '').trim(),
            sucursal_proveedora_id: toPositiveInt(detail?.sucursal_proveedora_id, 0),
            sucursal_proveedora: String(detail?.sucursal_proveedora_nombre || '').trim(),
            movimiento_salida_id: toPositiveInt(detail?.movimiento_salida_id, 0),
            movimiento_entrada_id: toPositiveInt(detail?.movimiento_entrada_id, 0),
            descripcion: String(detail?.descripcion || '').trim(),
            detalles: detail.detalles.map((row) => ({
              producto_id: toPositiveInt(row?.producto_id, 0),
              producto_codigo: String(row?.producto_codigo || '').trim(),
              producto_nombre: String(row?.producto_nombre || '').trim(),
              cantidad_enviada: toPositiveInt(row?.cantidad, 0),
            })),
          }
        }
      }

      if (!targetShipment) {
        closeReceiveShipmentModal()
        showErrorToast('No se encontró el envío en camino asociado a este recordatorio.')
        return false
      }

      handleOpenInTransitShipment(targetShipment)
      return true
    },
    [
      closeReceiveShipmentModal,
      fetchInTransitTransferShipments,
      fetchTransferSolicitudDetail,
      handleOpenInTransitShipment,
      inTransitShipments,
      openReceiveShipmentModalShell,
      showErrorToast,
      token,
    ]
  )

  const handleReceiveShipmentDraftFieldChange = useCallback((productId, field, value) => {
    const normalizedProductId = normalizeId(productId)
    if (!normalizedProductId) return
    setReceiveShipmentError('')

    setReceiveShipmentDraftByProductId((prev) => {
      const current = prev?.[normalizedProductId]
      if (!current) return prev

      const nextRow = { ...current }
      if (field === 'cantidad_recibida') {
        const normalizedInput = normalizeIntegerInputString(value)
        const parsed = normalizedInput === '' ? 0 : toPositiveInt(normalizedInput, 0)
        nextRow.cantidad_recibida_input = normalizedInput
        nextRow.cantidad_recibida = parsed
        const assigned = (Array.isArray(nextRow.ubicaciones) ? nextRow.ubicaciones : []).reduce(
          (total, row) => total + toPositiveInt(row?.cantidad, 0),
          0
        )
        if (assigned > parsed) {
          nextRow.ubicaciones = []
        }
      } else if (field === 'recepcion_revisada') {
        nextRow.recepcion_revisada = Boolean(value)
      } else if (field === 'novedad') {
        nextRow.novedad = String(value || '')
      } else if (field === 'location_draft_bodega_id') {
        const selectedBodegaId = normalizeId(value)
        nextRow.location_draft_bodega_id = selectedBodegaId
        nextRow.location_draft_bodega_query_input = ''
        nextRow.location_draft_bodega_query = ''
        const bodegaDivisions = selectedBodegaId
          ? inTransitDivisionsByBodegaId.get(selectedBodegaId) || []
          : receiveLocationDivisions
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
    inTransitDivisionsByBodegaId,
    inTransitSubdivisionsByDivisionId,
    receiveLocationDivisions,
  ])

  const handleReceiveShipmentReviewToggle = useCallback(
    (productId, reviewed) => {
      handleReceiveShipmentDraftFieldChange(productId, 'recepcion_revisada', reviewed)
    },
    [handleReceiveShipmentDraftFieldChange]
  )

  const handleReceiveShipmentToggleAllReviewed = useCallback((reviewed) => {
    const nextReviewed = Boolean(reviewed)
    setReceiveShipmentError('')
    setReceiveShipmentDraftByProductId((prev) => {
      const entries = Object.entries(prev || {})
      if (!entries.length) return prev

      let changed = false
      const next = {}
      entries.forEach(([productId, row]) => {
        if (Boolean(row?.recepcion_revisada) !== nextReviewed) {
          changed = true
        }
        next[productId] = {
          ...row,
          recepcion_revisada: nextReviewed,
        }
      })

      return changed ? next : prev
    })
  }, [])

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
        next.cantidad_reportada_input = normalizeIntegerInputString(value)
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

  const handleAdvanceRandomInspectionStep = useCallback(() => {
    if (!randomInspectionRows.length) {
      setRandomInspectionError('No hay productos para revisar en esta inspección.')
      return
    }

    if (activeRandomInspectionRow?.cantidad_reportada == null) {
      setRandomInspectionError(
        activeRandomInspectionRow?.requiere_conteo_por_ubicacion
          ? 'Completa la cantidad contada en cada ubicación antes de continuar.'
          : 'Ingresa la cantidad contada antes de continuar.'
      )
      return
    }

    setRandomInspectionError('')
    if (activeRandomInspectionStepIndex >= randomInspectionRows.length - 1) {
      setRandomInspectionShowSummary(true)
      return
    }
    setRandomInspectionStepIndex((prev) => prev + 1)
  }, [
    activeRandomInspectionRow,
    activeRandomInspectionStepIndex,
    randomInspectionRows,
  ])

  const handleGoBackRandomInspectionStep = useCallback(() => {
    setRandomInspectionError('')
    if (isRandomInspectionSummaryVisible) {
      setRandomInspectionShowSummary(false)
      return
    }
    setRandomInspectionStepIndex((prev) => Math.max(0, prev - 1))
  }, [isRandomInspectionSummaryVisible])

  const handleRandomInspectionLocationCountChange = useCallback((itemId, locationKey, value) => {
    const normalizedItemId = normalizeId(itemId)
    const normalizedLocationKey = String(locationKey || '').trim()
    if (!normalizedItemId || !normalizedLocationKey) return

    setRandomInspectionDraftByItemId((prev) => {
      const current = prev?.[normalizedItemId] || {}
      const currentLocationCounts = (
        current?.cantidad_reportada_por_ubicacion &&
        typeof current.cantidad_reportada_por_ubicacion === 'object'
      )
        ? current.cantidad_reportada_por_ubicacion
        : {}

      return {
        ...prev,
        [normalizedItemId]: {
          ...current,
          id: normalizedItemId,
          cantidad_reportada_por_ubicacion: {
            ...currentLocationCounts,
            [normalizedLocationKey]: normalizeQuantityInputString(value),
          },
        },
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
          'Esta inspección ya fue enviada y no puede volver a realizarse.'
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

        if (row?.cantidad_reportada == null) {
          setRandomInspectionError(
            `Debes ingresar la cantidad contada para ${row?.producto_codigo || row?.producto_nombre || `item ${rowId}`}.`
          )
          return
        }
        const normalizedEstadoRevision = (
          toPositiveInt(row?.cantidad_reportada, 0) === toPositiveInt(row?.cantidad_esperada, 0)
            ? 'coincide'
            : 'no_coincide'
        )

        const payloadRow = {
          id: Number(rowId),
          estado_revision: normalizedEstadoRevision,
          observacion: String(row?.observacion || '').trim(),
        }
        if (normalizedEstadoRevision === 'no_coincide') {
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
        setRandomInspectionError('Esta inspección no tiene diferencias por verificar.')
        return
      }

      const pendingRows = randomInspectionRowsToVerify.filter((row) => {
        const verificationState = String(row?.verificacion_estado || '').trim().toLowerCase()
        return verificationState === 'pendiente'
      })
      if (!pendingRows.length) {
        setRandomInspectionError('No hay diferencias pendientes de verificación.')
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
              String(payload?.detail || '').trim() || 'No se pudo verificar un ítem de la inspección.'
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
          summary: 'Verificación completada',
          detail: 'Se aplicaron las verificaciones de inventario reportadas.',
          life: 3200,
        })
        closeRandomInspectionModal()
      } catch (error) {
        setRandomInspectionError(
          error?.message || 'No se pudo completar la verificación de la inspección.'
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

      const rows = receiveShipmentRows
      if (!rows.length) {
        setReceiveShipmentError('No hay productos para registrar recepción.')
        return
      }

      const builtItems = []
      let totalMissing = 0
      for (const row of rows) {
        const rowValidationMessage = getReceiveShipmentRowValidationMessage(row, {
          requireReviewed: true,
        })
        if (rowValidationMessage) {
          setReceiveShipmentError(rowValidationMessage)
          return
        }

        const productId = toPositiveInt(row?.producto_id, 0)
        const sentQty = toPositiveInt(row?.cantidad_enviada, 0)
        const receivedQty = toPositiveInt(row?.cantidad_recibida, 0)
        const missingQty = Math.max(0, sentQty - receivedQty)
        const locations = (Array.isArray(row?.ubicaciones) ? row.ubicaciones : [])
          .map((location) => ({
            subdivision_id: toPositiveInt(location?.subdivision_id, 0),
            cantidad: toPositiveInt(location?.cantidad, 0),
          }))
          .filter((location) => location.subdivision_id > 0 && location.cantidad > 0)

        totalMissing += missingQty
        builtItems.push({
          producto_id: productId,
          cantidad_recibida: receivedQty,
          novedad: missingQty > 0
            ? String(row?.novedad || 'Faltante reportado en recepcion.').trim()
            : String(row?.novedad || '').trim(),
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
            String(payload?.detail || '').trim() || 'No se pudo confirmar la recepción del envío.'
          )
        }

        const backendReminderSent = Boolean(payload?.recordatorio_enviado)
        if (backendReminderSent) {
          const remoteReminders = await fetchRemindersFromBackend(token)
          setReminders(remoteReminders)
        } else {
          await appendShipmentReceptionReminder({
            shipment: activeInTransitShipment,
            result: normalizedResult,
            totalMissing,
            items: builtItems,
          })
        }
        closeReceiveShipmentModal()
        await fetchInTransitTransferShipments({ silent: true })
      } catch (error) {
        setReceiveShipmentError(
          error?.message || 'No se pudo confirmar la recepción del envío.'
        )
      } finally {
        setReceiveShipmentSubmitting(false)
      }
    },
    [
      activeInTransitShipment,
      appendShipmentReceptionReminder,
      closeReceiveShipmentModal,
      fetchInTransitTransferShipments,
      getReceiveShipmentRowValidationMessage,
      receiveShipmentRows,
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
              ? 'Abrir envío pendiente de traslado'
              : shield.kind === 'rejected_transfer'
                ? 'Corregir solicitud de traslado rechazada'
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
        {canOpenInTransitShipments && hasInTransitShipments && (
          <div
            ref={inTransitShipmentsRef}
            className={`quick-actions__pending-shipments quick-actions__in-transit${isInTransitShipmentsOpen ? ' is-open' : ''}`}
          >
            <button
              ref={handleInTransitShipmentsTriggerRef}
              type="button"
              className="quick-actions__pending-shipments-trigger quick-actions__in-transit-trigger"
              onClick={() => void toggleInTransitShipmentsPanel()}
              aria-label="Envíos en camino"
            >
              <span>Envíos en camino</span>
              {!suppressAdminAlerts && (
                <span className="quick-actions__pending-shipments-count">
                  {inTransitShipmentsLoading ? '...' : visibleInTransitShipments.length}
                </span>
              )}
            </button>

            {isInTransitShipmentsOpen && (
              <div className="quick-actions__pending-shipments-panel quick-actions__in-transit-panel" role="dialog" aria-label="Envíos en camino">
                <div className="quick-actions__pending-shipments-head">
                  <strong>Envíos por recibir</strong>
                  <button
                    type="button"
                    className="quick-actions__pending-shipments-refresh"
                    onClick={() => void fetchInTransitTransferShipments()}
                    disabled={inTransitShipmentsLoading}
                    aria-label="Actualizar envíos en camino"
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
                      <span>Cargando envíos en camino...</span>
                    </p>
                  ) : !visibleInTransitShipments.length ? (
                    <p className="quick-actions__pending-shipments-empty">No hay envíos en camino.</p>
                  ) : (
                    visibleInTransitShipments.map((shipment) => {
                      const shipmentId = normalizeId(shipment?.id)
                      const isOpening = shipmentId && openingInTransitShipmentId === shipmentId
                      const doc = String(shipment?.no_documento || shipmentId || '').trim()
                      const providerBranch = String(shipment?.sucursal_proveedora || '').trim()
                      const receiveBranch = String(shipment?.sucursal_solicitante || '').trim()
                      const fecha = String(shipment?.fecha || '').trim()
                      const relatedReminder = shipment?.reminder || null

                      return (
                        <button
                          key={`in-transit-shipment-${shipmentId || doc || 'row'}`}
                          type="button"
                          className="quick-actions__pending-shipments-item quick-actions__in-transit-item"
                          onClick={() => {
                            if (relatedReminder) {
                              void handleOpenInTransitShipmentFromReminder(relatedReminder)
                              return
                            }
                            void handleOpenInTransitShipment(shipment)
                          }}
                          disabled={Boolean(isOpening)}
                        >
                          <span className="quick-actions__pending-shipments-item-title">
                            {doc ? `#${doc}` : 'Traslado sin documento'}
                          </span>
                          <span className="quick-actions__pending-shipments-item-meta">
                            {providerBranch ? `Desde: ${providerBranch}` : 'Desde: traslado enviado'}
                          </span>
                          <span className="quick-actions__pending-shipments-item-meta">
                            {receiveBranch ? `Hacia: ${receiveBranch}` : 'Hacia: sucursal destino'}
                          </span>
                          <span className="quick-actions__pending-shipments-item-meta">
                            {isOpening
                              ? 'Abriendo...'
                              : (fecha
                                ? `Fecha: ${fecha}`
                                : (relatedReminder ? 'Abrir envío en camino' : 'Abrir recepción'))}
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
              aria-label="Envíos pendientes"
            >
              <span>Envíos pendientes</span>
              {!suppressAdminAlerts && (
                <span className="quick-actions__pending-shipments-count">
                  {pendingShipmentsLoading ? '...' : pendingShipments.length}
                </span>
              )}
            </button>

            {isPendingShipmentsOpen && (
              <div className="quick-actions__pending-shipments-panel" role="dialog" aria-label="Envíos pendientes">
                <div className="quick-actions__pending-shipments-head">
                  <strong>Solicitudes por enviar</strong>
                  <button
                    type="button"
                    className="quick-actions__pending-shipments-refresh"
                    onClick={() => void fetchPendingTransferShipments()}
                    disabled={pendingShipmentsLoading}
                    aria-label="Actualizar envíos pendientes"
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
                      <span>Cargando envíos pendientes...</span>
                    </p>
                  ) : !pendingShipments.length ? (
                    <p className="quick-actions__pending-shipments-empty">No hay envíos pendientes.</p>
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
                            {isOpening ? (
                              <span className="quick-actions__pending-shipments-loading" aria-live="polite">
                                <Loader2 size={14} className="quick-actions__pending-shipments-loading-icon" />
                                <span>Generando número...</span>
                              </span>
                            ) : (
                              (fecha ? `Fecha: ${fecha}` : 'Abrir en salidas')
                            )}
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
        allReminders={reminders}
        onCreateReminder={handleCreateReminder}
        onMarkReminderSeen={handleMarkReminderSeen}
        darkMode={darkMode}
        onError={showErrorToast}
        onApplyRemindersUpdate={applyReminderUpdate}
        focusReminderId={focusReminderId}
        onFocusReminderHandled={() => setFocusReminderId('')}
        onTransferDecisionAccepted={onTransferDecisionAccepted}
        onOpenTransferRequestInEntradas={onOpenTransferRequestInEntradas}
        onOpenTransferRequestInTransit={handleOpenInTransitShipmentFromReminder}
        onOpenTransferRequestInSalidas={onOpenTransferRequestInSalidas}
        onOpenRandomInspection={handleOpenRandomInspectionFromReminder}
        onOpenTransferIssuesSection={onOpenTransferIssuesSection}
      />

      {isRandomInspectionModalOpen && (
        <div
          className={`quick-actions__inspection-overlay${darkMode ? ' dark' : ''}`}
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
                <h4>{isRandomInspectionVerifyMode ? 'Verificación de inspección aleatoria' : 'Inspección aleatoria diaria'}</h4>
                <p>
                  {activeRandomInspection?.fecha_programada
                    ? `Fecha: ${String(activeRandomInspection.fecha_programada).trim()}`
                    : (isRandomInspectionVerifyMode ? 'Revisión administrativa de diferencias' : 'Revisión diaria de inventario')}
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
                  Cargando inspección...
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
                            <span>Decisión</span>
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
                          <span>Nota de verificación (opcional)</span>
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

                  {!!randomInspectionRows.length && !isRandomInspectionSummaryVisible && activeRandomInspectionRow && (
                    <div className="quick-actions__inspection-quiz">
                      <div className="quick-actions__inspection-progress" aria-hidden="true">
                        <div className="quick-actions__inspection-progress-bar">
                          <span
                            style={{
                              width: `${(randomInspectionAnsweredCount / Math.max(randomInspectionRows.length, 1)) * 100}%`,
                            }}
                          />
                        </div>
                      </div>

                      <div className={activeRandomInspectionRow?.requiere_conteo_por_ubicacion ? 'quick-actions__inspection-stage-list' : undefined}>
                        {(
                          activeRandomInspectionRow?.requiere_conteo_por_ubicacion
                            ? (Array.isArray(activeRandomInspectionRow?.ubicaciones_bodega)
                              ? activeRandomInspectionRow.ubicaciones_bodega
                              : [])
                            : [null]
                        ).map((location, index) => (
                          <article
                            key={
                              activeRandomInspectionRow?.requiere_conteo_por_ubicacion
                                ? `inspection-stage-location-${normalizeId(activeRandomInspectionRow?.row_id || activeRandomInspectionRow?.id)}-${index}`
                                : `inspection-stage-single-${normalizeId(activeRandomInspectionRow?.row_id || activeRandomInspectionRow?.id)}`
                            }
                            className="quick-actions__inspection-stage"
                          >
                            <div className="quick-actions__inspection-stage-copy">
                              <p className="quick-actions__inspection-stage-kicker">Código a revisar</p>
                              <h5>
                                {activeRandomInspectionRow?.producto_codigo || `Producto ${activeRandomInspectionRow?.row_id}`}
                              </h5>
                              {!!String(activeRandomInspectionRow?.producto_nombre || '').trim() && (
                                <p className="quick-actions__inspection-stage-name">
                                  {String(activeRandomInspectionRow?.producto_nombre || '').trim()}
                                </p>
                              )}
                            </div>

                            <div className="quick-actions__inspection-stage-meta quick-actions__inspection-stage-meta--split">
                              <div className="quick-actions__inspection-stage-meta-block">
                                <strong>{String(activeRandomInspectionRow?.sucursal_nombre || 'Sucursal').trim()}</strong>
                              </div>

                              <div className="quick-actions__inspection-stage-meta-block">
                                {activeRandomInspectionRow?.requiere_conteo_por_ubicacion ? (
                                  <div className="quick-actions__inspection-location-row">
                                    <div>
                                      <small>Bodega</small>
                                      <strong>{String(location?.bodega_nombre || '-').trim()}</strong>
                                    </div>
                                    <div>
                                      <small>Division</small>
                                      <strong>{String(location?.division_nombre || '-').trim()}</strong>
                                    </div>
                                    <div>
                                      <small>Subdivision</small>
                                      <strong>{String(location?.subdivision_nombre || '-').trim()}</strong>
                                    </div>
                                  </div>
                                ) : Array.isArray(activeRandomInspectionRow?.ubicaciones_bodega) && activeRandomInspectionRow.ubicaciones_bodega.length > 0 ? (
                                  <div className="quick-actions__inspection-location-list">
                                    {activeRandomInspectionRow.ubicaciones_bodega.map((location, index) => (
                                      <div
                                        key={`inspection-location-${normalizeId(activeRandomInspectionRow?.row_id || activeRandomInspectionRow?.id)}-${index}`}
                                        className="quick-actions__inspection-location-row"
                                      >
                                        <div>
                                          <small>Bodega</small>
                                          <strong>{String(location?.bodega_nombre || '-').trim()}</strong>
                                        </div>
                                        <div>
                                          <small>Division</small>
                                          <strong>{String(location?.division_nombre || '-').trim()}</strong>
                                        </div>
                                        <div>
                                          <small>Subdivision</small>
                                          <strong>{String(location?.subdivision_nombre || '-').trim()}</strong>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <strong>
                                    {String(activeRandomInspectionRow?.ubicacion_bodega || 'Ubicación no disponible').trim()}
                                  </strong>
                                )}
                              </div>
                            </div>

                            <label className="quick-actions__inspection-count-field">
                              <span>Cantidad contada</span>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={activeRandomInspectionRow?.requiere_conteo_por_ubicacion
                                  ? String(location?.cantidad_contada_input || '')
                                  : String(activeRandomInspectionRow?.cantidad_reportada_input || '')}
                                onChange={(event) => {
                                  if (activeRandomInspectionRow?.requiere_conteo_por_ubicacion) {
                                    handleRandomInspectionLocationCountChange(
                                      activeRandomInspectionRow?.row_id || activeRandomInspectionRow?.id,
                                      location?.key,
                                      event.target.value
                                    )
                                    return
                                  }

                                  handleRandomInspectionDraftFieldChange(
                                    activeRandomInspectionRow?.row_id || activeRandomInspectionRow?.id,
                                    'cantidad_reportada',
                                    normalizeQuantityInputString(event.target.value)
                                  )
                                }}
                                onKeyDown={(event) => {
                                  if (event.key !== 'Enter') return
                                  event.preventDefault()
                                  handleAdvanceRandomInspectionStep()
                                }}
                                maxLength={4}
                                placeholder="0"
                                disabled={randomInspectionSubmitting}
                                autoFocus={index === 0}
                              />
                            </label>

                            <p className="quick-actions__inspection-stage-help">
                              {activeRandomInspectionRow?.requiere_conteo_por_ubicacion
                                ? 'Cuenta cada ubicación por separado. El inventario esperado se mostrará al final.'
                                : 'Cuenta primero y responde solo con la cantidad encontrada. El inventario esperado se mostrara al final.'}
                            </p>
                          </article>
                        ))}
                      </div>
                    </div>
                  )}

                  {!!randomInspectionRows.length && isRandomInspectionSummaryVisible && (
                    <div className="quick-actions__inspection-summary">
                      <div className="quick-actions__inspection-summary-head">
                        <div>
                          <p className="quick-actions__inspection-stage-kicker">Resultado de la prueba</p>
                          <h5>
                            {randomInspectionMismatchCount > 0
                              ? `Se encontraron ${randomInspectionMismatchCount} diferencia(s)`
                              : 'Todo coincide con el inventario'}
                          </h5>
                          <p className="quick-actions__inspection-stage-help">
                            Aqui ya puedes ver lo esperado frente a lo que realmente contaste.
                          </p>
                        </div>
                        <div className="quick-actions__inspection-summary-stats">
                          <span>
                            Coinciden
                            <strong>{randomInspectionMatchedCount}</strong>
                          </span>
                          <span>
                            Diferencias
                            <strong>{randomInspectionMismatchCount}</strong>
                          </span>
                        </div>
                      </div>

                      <div className="quick-actions__inspection-list">
                        {randomInspectionRows.map((row) => {
                          const rowId = normalizeId(row?.row_id || row?.id)
                          const expectedQty = toPositiveInt(row?.cantidad_esperada, 0)
                          const countedQty = toPositiveInt(row?.cantidad_reportada, 0)
                          const delta = countedQty - expectedQty
                          const isMismatch = countedQty !== expectedQty
                          return (
                            <article key={`inspection-summary-${rowId}`} className="quick-actions__inspection-item">
                              <div className="quick-actions__inspection-item-head">
                                <strong>
                                  {row?.producto_codigo ? `${row.producto_codigo} - ` : ''}
                                  {row?.producto_nombre || `Producto ${rowId}`}
                                </strong>
                                <span>{String(row?.sucursal_nombre || 'Sucursal').trim()}</span>
                              </div>

                              <div className="quick-actions__inspection-summary-row">
                                <div>
                                  <small>Esperado</small>
                                  <strong>{expectedQty}</strong>
                                </div>
                                <div>
                                  <small>Contado</small>
                                  <strong>{countedQty}</strong>
                                </div>
                                <div>
                                  <small>Diferencia</small>
                                  <strong>{formatSignedInteger(delta)}</strong>
                                </div>
                                <span className={`quick-actions__inspection-summary-badge${isMismatch ? ' is-mismatch' : ' is-match'}`}>
                                  {isMismatch ? 'No coincide' : 'Coincide'}
                                </span>
                              </div>
                            </article>
                          )
                        })}
                      </div>
                    </div>
                  )}
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
              {!isRandomInspectionVerifyMode && !isRandomInspectionSummaryVisible && randomInspectionRows.length > 1 && (
                <button
                  type="button"
                  className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost"
                  onClick={handleGoBackRandomInspectionStep}
                  disabled={randomInspectionSubmitting || activeRandomInspectionStepIndex <= 0}
                >
                  Anterior
                </button>
              )}
              {!isRandomInspectionVerifyMode && isRandomInspectionSummaryVisible && (
                <button
                  type="button"
                  className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost"
                  onClick={handleGoBackRandomInspectionStep}
                  disabled={randomInspectionSubmitting}
                >
                  Volver a revisar
                </button>
              )}
              <button
                type="button"
                className="quick-actions__inspection-btn quick-actions__inspection-btn--primary"
                onClick={() => {
                  if (isRandomInspectionVerifyMode) {
                    void handleVerifyRandomInspection()
                    return
                  }
                  if (!isRandomInspectionSummaryVisible) {
                    handleAdvanceRandomInspectionStep()
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
                      : (
                        !randomInspectionRows.length ||
                        (!isRandomInspectionSummaryVisible && !activeRandomInspectionRow) ||
                        (isRandomInspectionSummaryVisible && !randomInspectionAllAnswersReady)
                      )
                  )
                }
              >
                {randomInspectionSubmitting
                  ? 'Guardando...'
                  : isRandomInspectionVerifyMode
                    ? (
                      randomInspectionPendingVerificationCount > 0
                        ? `Aplicar verificación (${randomInspectionPendingVerificationCount} pendiente(s))`
                        : 'Sin pendientes por verificar'
                    )
                    : isRandomInspectionAlreadyCompleted
                      ? 'Inspección ya enviada'
                    : !isRandomInspectionSummaryVisible
                      ? (
                        activeRandomInspectionStepIndex >= randomInspectionRows.length - 1
                          ? 'Ver resultado'
                          : 'Siguiente producto'
                      )
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
          className={`quick-actions__receive-overlay ${darkMode ? 'dark' : 'light'}`}
          onMouseDown={() => {
            if (receiveShipmentSubmitting) return
            closeReceiveShipmentModal()
          }}
        >
          <div
            className={`quick-actions__receive-dialog ${darkMode ? 'dark' : 'light'}`}
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Registrar recepcion de envio"
          >
            <header className="quick-actions__receive-head">
              <div>
                <h4>{receiveShipmentSourceBranchName || 'Sucursal proveedora'}</h4>
                <p>{receiveShipmentTransferCode ? `#${receiveShipmentTransferCode.replace(/^#/, '')}` : 'Traslado sin codigo'}</p>
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
              {receiveShipmentShowSummary ? (
                <div className="quick-actions__receive-summary">
                  <p className="quick-actions__receive-summary-title">Resumen de recepcion</p>
                  <table className="quick-actions__receive-summary-table">
                    <thead>
                      <tr>
                        <th>Producto</th>
                        <th>Enviado</th>
                        <th>Recibido</th>
                        <th>Diferencia</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receiveShipmentRows.map((row) => {
                        const sent = toPositiveInt(row?.cantidad_enviada, 0)
                        const received = toPositiveInt(row?.cantidad_recibida, 0)
                        const diff = received - sent
                        return (
                          <tr
                            key={`summary-row-${normalizeId(row?.producto_id)}`}
                            className={diff < 0 ? 'quick-actions__receive-summary-row--missing' : diff > 0 ? 'quick-actions__receive-summary-row--extra' : ''}
                          >
                            <td>
                              <strong>{row?.producto_codigo || `#${normalizeId(row?.producto_id)}`}</strong>
                              {!!String(row?.producto_nombre || '').trim() && (
                                <span>{String(row.producto_nombre).trim()}</span>
                              )}
                            </td>
                            <td>{sent}</td>
                            <td>{received}</td>
                            <td className="quick-actions__receive-summary-diff">
                              {diff === 0 ? <span className="quick-actions__receive-summary-ok">OK</span> : diff > 0 ? `+${diff}` : diff}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {receiveShipmentTotalMissing > 0 && (
                    <p className="quick-actions__receive-summary-missing-note">
                      Faltan <strong>{receiveShipmentTotalMissing}</strong> unidad(es) en total.
                    </p>
                  )}
                </div>
              ) : inTransitSubdivisionsLoading ? (
                <p className="quick-actions__receive-loading">
                  <Loader2 size={14} />
                  Cargando ubicaciones...
                </p>
              ) : receiveShipmentRows.length ? (
                <div className="quick-actions__receive-step quick-actions__receive-step--list">
                  <article className="quick-actions__receive-stage quick-actions__receive-stage--list">
                    <div className="quick-actions__receive-stage-head">
                      <div className="quick-actions__receive-stage-copy">
                        <p className="quick-actions__receive-stage-kicker">Barrido de recepcion</p>
                        <h5>Revisa todos los productos en una sola lista</h5>
                        <p className="quick-actions__receive-stage-name">
                          Marca cada linea cuando la confirmes fisicamente y ajusta solo donde haga falta.
                        </p>
                      </div>

                      <div className="quick-actions__receive-stage-toolbar">
                        <label className="quick-actions__receive-check quick-actions__receive-check--bulk">
                          <input
                            type="checkbox"
                            checked={receiveShipmentAllReviewed}
                            ref={(element) => {
                              if (element) {
                                element.indeterminate = receiveShipmentSomeReviewed && !receiveShipmentAllReviewed
                              }
                            }}
                            onChange={(event) =>
                              handleReceiveShipmentToggleAllReviewed(event.target.checked)
                            }
                            disabled={receiveShipmentSubmitting}
                          />
                          <span>Marcar todo revisado</span>
                        </label>
                      </div>
                    </div>

                    <div className="quick-actions__receive-stage-meta quick-actions__receive-stage-meta--split">
                      <div className="quick-actions__receive-stage-meta-block">
                        <small className="quick-actions__receive-destination-label">Sucursal destino</small>
                        <strong>{receiveShipmentDestinationBranchName}</strong>
                      </div>
                      <div className="quick-actions__receive-stage-stats">
                        <span className="quick-actions__receive-stage-stat">
                          Productos
                          <strong>{receiveShipmentRows.length}</strong>
                        </span>
                        <span className="quick-actions__receive-stage-stat">
                          Revisados
                          <strong>{receiveShipmentReviewedCount}</strong>
                        </span>
                        <span className="quick-actions__receive-stage-stat">
                          Datos completos
                          <strong>{receiveShipmentReadyCount}</strong>
                        </span>
                      </div>
                    </div>
                  </article>

                  <div className="quick-actions__receive-list">
                    <div className="quick-actions__receive-list-header" aria-hidden="true">
                      <span className="quick-actions__receive-list-header-cell quick-actions__receive-list-header-cell--product">
                        Producto
                      </span>
                      <div className="quick-actions__receive-list-header-locations">
                        <span className="quick-actions__receive-list-header-cell">Bodega</span>
                        <span className="quick-actions__receive-list-header-cell">Division</span>
                        <span className="quick-actions__receive-list-header-cell">Subdivision</span>
                      </div>
                      <span className="quick-actions__receive-list-header-cell quick-actions__receive-list-header-cell--stat quick-actions__receive-list-header-cell--expected">
                        Esperado
                      </span>
                      <span className="quick-actions__receive-list-header-cell quick-actions__receive-list-header-cell--stat quick-actions__receive-list-header-cell--received">
                        Recibida
                      </span>
                      <span className="quick-actions__receive-list-header-cell quick-actions__receive-list-header-cell--check" />
                    </div>
                    {receiveShipmentRows.map((row, index) => {
                      const rowProductId = normalizeId(row?.producto_id)
                      const missingQty = toPositiveInt(row?.cantidad_faltante, 0)
                      const sentQty = toPositiveInt(row?.cantidad_enviada, 0)
                      const receivedQty = toPositiveInt(row?.cantidad_recibida, 0)
                      const isReviewed = Boolean(row?.recepcion_revisada)
                      const rowValidationMessage = getReceiveShipmentRowValidationMessage(row)
                      const selectedBodegaId = normalizeId(row?.location_draft_bodega_id)
                      const availableDivisions = selectedBodegaId
                        ? inTransitDivisionsByBodegaId.get(selectedBodegaId) || []
                        : []
                      const selectedDivisionId = normalizeId(row?.location_draft_division_id)
                      const availableSubdivisions = selectedDivisionId
                        ? inTransitSubdivisionsByDivisionId.get(selectedDivisionId) || []
                        : []
                      const selectedSubdivisionId = normalizeId(row?.location_draft_subdivision_id)
                      const selectedBodega = inTransitBodegaById.get(selectedBodegaId) || null
                      const selectedDivision = inTransitDivisionById.get(selectedDivisionId) || null
                      const selectedSubdivision = inTransitSubdivisionById.get(selectedSubdivisionId) || null
                      const statusLabel = !isReviewed
                        ? 'Por revisar'
                        : rowValidationMessage
                          ? 'Falta info'
                          : 'Listo'
                      const hintMessage = !isReviewed
                        ? 'Marca esta linea cuando termines de revisar el producto.'
                        : rowValidationMessage

                      return (
                        <article
                          key={`receive-item-${rowProductId}`}
                          className={`quick-actions__receive-item${isReviewed ? ' is-reviewed' : ''}${!isReviewed || rowValidationMessage ? ' is-pending' : ' is-ready'}`}
                        >
                          <div className="quick-actions__receive-item-head quick-actions__receive-item-head--check">
                            <label className="quick-actions__receive-check quick-actions__receive-check--row">
                              <Checkbox
                                binary
                                inputId={`receive-reviewed-${rowProductId}`}
                                checked={isReviewed}
                                onChange={(event) =>
                                  handleReceiveShipmentReviewToggle(rowProductId, event.checked)
                                }
                                disabled={receiveShipmentSubmitting}
                                aria-label={`Marcar ${getReceiveShipmentRowLabel(row)} como revisado`}
                              />
                            </label>

                            <div
                              className="quick-actions__receive-item-title"
                              title={[row?.producto_codigo, String(row?.producto_nombre || '').trim()].filter(Boolean).join(' – ')}
                            >
                              <strong>{row?.producto_codigo || `Producto ${rowProductId}`}</strong>
                              {!!String(row?.producto_nombre || '').trim() && (
                                <p className="quick-actions__receive-item-name">
                                  {String(row.producto_nombre).trim()}
                                </p>
                              )}
                            </div>

                            <div className={`quick-actions__receive-item-badge${!isReviewed || rowValidationMessage ? ' is-pending' : ' is-ready'}`}>
                              {statusLabel}
                            </div>
                          </div>

                          <div className="quick-actions__receive-item-meta">
                            <span>
                              Esperado
                              <strong>{sentQty}</strong>
                            </span>
                            <span>
                              Recibida
                              <strong>{receivedQty}</strong>
                            </span>
                            {missingQty > 0 && (
                              <span className="quick-actions__receive-item-meta-alert">
                                Faltan
                                <strong>{missingQty}</strong>
                              </span>
                            )}
                          </div>

                          <div className="quick-actions__receive-grid quick-actions__receive-grid--receive">
                            <label className="quick-actions__receive-count-field quick-actions__receive-count-field--inline">
                              <span>
                                Cantidad recibida{' '}
                                <span className="quick-actions__receive-expected-hint">
                                  (esperada: {sentQty})
                                </span>
                              </span>
                              <input
                                type="text"
                                inputMode="numeric"
                                maxLength={6}
                                placeholder="0"
                                value={String(row?.cantidad_recibida_input ?? '')}
                                onChange={(event) =>
                                  handleReceiveShipmentDraftFieldChange(
                                    rowProductId,
                                    'cantidad_recibida',
                                    event.target.value
                                  )
                                }
                                disabled={receiveShipmentSubmitting}
                                autoFocus={index === 0}
                              />
                            </label>

                            <div className="quick-actions__receive-destination">
                              <small>Sucursal destino</small>
                              <strong>{receiveShipmentDestinationBranchName}</strong>
                            </div>
                          </div>

                          <div className="quick-actions__receive-location-row quick-actions__receive-location-row--review">
                            <div className="quick-actions__receive-location-field">
                              <small>Bodega</small>
                              <div className="quick-actions__receive-dropdown" ref={setReceiveLocationDropdownRef(rowProductId, 'bodega')}>
                                <button
                                  type="button"
                                  className="quick-actions__receive-dropdown-trigger quick-actions__receive-dropdown-trigger--review"
                                  title={String(selectedBodega?.nombre || 'Selecciona').trim()}
                                  aria-label={selectedBodega?.nombre ? `Bodega: ${String(selectedBodega.nombre).trim()}` : 'Seleccionar bodega'}
                                  onClick={() => toggleReceiveLocationDropdown(rowProductId, 'bodega', true)}
                                  disabled={receiveShipmentSubmitting || !inTransitBodegas.length}
                                >
                                  <span>{String(selectedBodega?.nombre || 'Selecciona').trim()}</span>
                                  <i className={`pi pi-chevron-${isReceiveLocationDropdownOpen(rowProductId, 'bodega') ? 'up' : 'down'}`} />
                                </button>
                              </div>
                            </div>

                            <div className="quick-actions__receive-location-field">
                              <small>Division</small>
                              <div className="quick-actions__receive-dropdown" ref={setReceiveLocationDropdownRef(rowProductId, 'division')}>
                                <button
                                  type="button"
                                  className="quick-actions__receive-dropdown-trigger quick-actions__receive-dropdown-trigger--review"
                                  title={String(selectedDivision?.nombre || 'Selecciona').trim()}
                                  aria-label={selectedDivision?.nombre ? `Division: ${String(selectedDivision.nombre).trim()}` : 'Seleccionar division'}
                                  onClick={() => toggleReceiveLocationDropdown(rowProductId, 'division', true)}
                                  disabled={receiveShipmentSubmitting || !availableDivisions.length}
                                >
                                  <span>{String(selectedDivision?.nombre || 'Selecciona').trim()}</span>
                                  <i className={`pi pi-chevron-${isReceiveLocationDropdownOpen(rowProductId, 'division') ? 'up' : 'down'}`} />
                                </button>
                              </div>
                            </div>

                            <div className="quick-actions__receive-location-field">
                              <small>Subdivision</small>
                              <div className="quick-actions__receive-dropdown" ref={setReceiveLocationDropdownRef(rowProductId, 'subdivision')}>
                                <button
                                  type="button"
                                  className="quick-actions__receive-dropdown-trigger quick-actions__receive-dropdown-trigger--review"
                                  title={String(selectedSubdivision?.nombre || 'Selecciona').trim()}
                                  aria-label={selectedSubdivision?.nombre ? `Subdivision: ${String(selectedSubdivision.nombre).trim()}` : 'Seleccionar subdivision'}
                                  onClick={() => toggleReceiveLocationDropdown(rowProductId, 'subdivision', true)}
                                  disabled={receiveShipmentSubmitting || !availableSubdivisions.length}
                                >
                                  <span>{String(selectedSubdivision?.nombre || 'Selecciona').trim()}</span>
                                  <i className={`pi pi-chevron-${isReceiveLocationDropdownOpen(rowProductId, 'subdivision') ? 'up' : 'down'}`} />
                                </button>
                              </div>
                            </div>
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
                                  )
                                }
                                disabled={receiveShipmentSubmitting}
                              />
                            </label>
                          )}

                          {hintMessage && (
                            <p className="quick-actions__receive-item-hint quick-actions__receive-item-hint--warning">
                              {hintMessage}
                            </p>
                          )}

                          <div className="quick-actions__receive-list-sep quick-actions__receive-list-sep--loc" />
                          <div className="quick-actions__receive-list-sep quick-actions__receive-list-sep--qty" />
                        </article>
                      )
                    })}
                  </div>
                </div>
              ) : activeReceiveShipmentRow ? (() => {
                const row = activeReceiveShipmentRow
                const rowProductId = normalizeId(row?.producto_id)
                const missingQty = toPositiveInt(row?.cantidad_faltante, 0)
                const selectedBodegaId = normalizeId(row?.location_draft_bodega_id)
                const selectedBodega = inTransitBodegaById.get(selectedBodegaId) || null
                const bodegaQuery = normalizeSearchText(row?.location_draft_bodega_query || '')
                const filteredBodegas = bodegaQuery
                  ? inTransitBodegas.filter((b) => normalizeSearchText(b?.nombre).includes(bodegaQuery))
                  : inTransitBodegas
                const availableDivisions = selectedBodegaId
                  ? inTransitDivisionsByBodegaId.get(selectedBodegaId) || []
                  : []
                const selectedDivisionId = normalizeId(row?.location_draft_division_id)
                const selectedDivision = inTransitDivisionById.get(selectedDivisionId) || null
                const divisionQuery = normalizeSearchText(row?.location_draft_division_query || '')
                const filteredDivisions = divisionQuery
                  ? availableDivisions.filter((d) => normalizeSearchText(d?.nombre).includes(divisionQuery))
                  : availableDivisions
                const availableSubdivisions = selectedDivisionId
                  ? inTransitSubdivisionsByDivisionId.get(selectedDivisionId) || []
                  : []
                const subdivisionQuery = normalizeSearchText(row?.location_draft_subdivision_query || '')
                const filteredSubdivisions = subdivisionQuery
                  ? availableSubdivisions.filter((s) => normalizeSearchText(s?.nombre).includes(subdivisionQuery))
                  : availableSubdivisions
                const selectedSubdivision = inTransitSubdivisionById.get(
                  normalizeId(row?.location_draft_subdivision_id)
                ) || null
                const destinationBranchName = String(
                  activeInTransitShipment?.sucursal_solicitante || 'Sucursal destino'
                ).trim()
                return (
                  <div className="quick-actions__receive-step">
                    <div className="quick-actions__receive-progress-head">
                      <span>Producto {activeReceiveShipmentStepIndex + 1} de {receiveShipmentRows.length}</span>
                    </div>
                    <div className="quick-actions__receive-progress-track">
                      <div
                        className="quick-actions__receive-progress-fill"
                        style={{ width: `${((activeReceiveShipmentStepIndex + 1) / Math.max(receiveShipmentRows.length, 1)) * 100}%` }}
                      />
                    </div>

                    <article className="quick-actions__receive-stage">
                      <div className="quick-actions__receive-stage-copy">
                        <p className="quick-actions__receive-stage-kicker">Producto a recibir</p>
                        <h5>{row?.producto_codigo || `Producto ${rowProductId}`}</h5>
                        {!!String(row?.producto_nombre || '').trim() && (
                          <p className="quick-actions__receive-stage-name">{String(row.producto_nombre).trim()}</p>
                        )}
                      </div>

                      <div className="quick-actions__receive-stage-meta quick-actions__receive-stage-meta--split">
                        <div className="quick-actions__receive-stage-meta-block">
                          <strong>{destinationBranchName}</strong>
                        </div>

                        <div className="quick-actions__receive-stage-meta-block">
                          <div className="quick-actions__receive-location-row quick-actions__receive-location-row--review">
                            <div className="quick-actions__receive-location-field">
                              <small>Bodega</small>
                              <div className="quick-actions__receive-dropdown" ref={setReceiveLocationDropdownRef(rowProductId, 'bodega')}>
                                <button
                                  type="button"
                                  className="quick-actions__receive-dropdown-trigger quick-actions__receive-dropdown-trigger--review"
                                  onClick={() => toggleReceiveLocationDropdown(rowProductId, 'bodega')}
                                  disabled={receiveShipmentSubmitting || !inTransitBodegas.length}
                                >
                                  <span>{String(selectedBodega?.nombre || 'Selecciona').trim()}</span>
                                  <i className={`pi pi-chevron-${isReceiveLocationDropdownOpen(rowProductId, 'bodega') ? 'up' : 'down'}`} />
                                </button>
                                {isReceiveLocationDropdownOpen(rowProductId, 'bodega') && (
                                  <div className="quick-actions__receive-dropdown-panel">
                                    <div className="quick-actions__receive-dropdown-search">
                                      <Search size={13} />
                                      <input
                                        type="text"
                                        placeholder="Buscar bodega"
                                        value={String(row?.location_draft_bodega_query_input || '')}
                                        onChange={(event) => handleReceiveShipmentLocationSearchInput(rowProductId, 'bodega', event.target.value)}
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
                                            handleReceiveShipmentDraftFieldChange(rowProductId, 'location_draft_bodega_id', bodega.id)
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
                            </div>

                            <div className="quick-actions__receive-location-field">
                              <small>Division</small>
                              <div className="quick-actions__receive-dropdown" ref={setReceiveLocationDropdownRef(rowProductId, 'division')}>
                                <button
                                  type="button"
                                  className="quick-actions__receive-dropdown-trigger quick-actions__receive-dropdown-trigger--review"
                                  onClick={() => toggleReceiveLocationDropdown(rowProductId, 'division')}
                                  disabled={receiveShipmentSubmitting || !availableDivisions.length}
                                >
                                  <span>{String(selectedDivision?.nombre || 'Selecciona').trim()}</span>
                                  <i className={`pi pi-chevron-${isReceiveLocationDropdownOpen(rowProductId, 'division') ? 'up' : 'down'}`} />
                                </button>
                                {isReceiveLocationDropdownOpen(rowProductId, 'division') && (
                                  <div className="quick-actions__receive-dropdown-panel">
                                    <div className="quick-actions__receive-dropdown-search">
                                      <Search size={13} />
                                      <input
                                        type="text"
                                        placeholder="Buscar division"
                                        value={String(row?.location_draft_division_query_input || '')}
                                        onChange={(event) => handleReceiveShipmentLocationSearchInput(rowProductId, 'division', event.target.value)}
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
                                            handleReceiveShipmentDraftFieldChange(rowProductId, 'location_draft_division_id', division.id)
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
                            </div>

                            <div className="quick-actions__receive-location-field">
                              <small>Subdivision</small>
                              <div className="quick-actions__receive-dropdown" ref={setReceiveLocationDropdownRef(rowProductId, 'subdivision')}>
                                <button
                                  type="button"
                                  className="quick-actions__receive-dropdown-trigger quick-actions__receive-dropdown-trigger--review"
                                  onClick={() => toggleReceiveLocationDropdown(rowProductId, 'subdivision')}
                                  disabled={receiveShipmentSubmitting || !availableSubdivisions.length}
                                >
                                  <span>{String(selectedSubdivision?.nombre || 'Selecciona').trim()}</span>
                                  <i className={`pi pi-chevron-${isReceiveLocationDropdownOpen(rowProductId, 'subdivision') ? 'up' : 'down'}`} />
                                </button>
                                {isReceiveLocationDropdownOpen(rowProductId, 'subdivision') && (
                                  <div className="quick-actions__receive-dropdown-panel">
                                    <div className="quick-actions__receive-dropdown-search">
                                      <Search size={13} />
                                      <input
                                        type="text"
                                        placeholder="Buscar subdivision"
                                        value={String(row?.location_draft_subdivision_query_input || '')}
                                        onChange={(event) => handleReceiveShipmentLocationSearchInput(rowProductId, 'subdivision', event.target.value)}
                                        disabled={receiveShipmentSubmitting}
                                      />
                                    </div>
                                    <div className="quick-actions__receive-dropdown-results">
                                      {!filteredSubdivisions.length && <small className="muted">Sin resultados.</small>}
                                      {filteredSubdivisions.map((subdivision) => (
                                        <button
                                          key={`receive-subdivision-option-${subdivision.id}`}
                                          type="button"
                                          className="quick-actions__receive-dropdown-option"
                                          onMouseDown={(event) => event.preventDefault()}
                                          onClick={(event) => {
                                            event.preventDefault()
                                            event.stopPropagation()
                                            handleReceiveShipmentDraftFieldChange(rowProductId, 'location_draft_subdivision_id', subdivision.id)
                                            setActiveReceiveLocationDropdown({ productId: '', field: '' })
                                          }}
                                          disabled={receiveShipmentSubmitting}
                                        >
                                          <strong>{String(subdivision?.nombre || `Subdivision ${subdivision.id}`).trim()}</strong>
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      <label className="quick-actions__receive-count-field">
                        <span>Cantidad recibida <span className="quick-actions__receive-expected-hint">(esperada: {toPositiveInt(row?.cantidad_enviada, 0)})</span></span>
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          placeholder="0"
                          value={String(row?.cantidad_recibida_input ?? '')}
                          onChange={(event) =>
                            handleReceiveShipmentDraftFieldChange(
                              rowProductId,
                              'cantidad_recibida',
                              event.target.value
                            )
                          }
                          disabled={receiveShipmentSubmitting}
                          autoFocus
                        />
                      </label>

                      <p className="quick-actions__receive-stage-help">
                        Registra la cantidad que llegó físicamente y la ubicación donde se va a guardar.
                      </p>

                      {missingQty > 0 && (
                        <label className="quick-actions__receive-note">
                          <span>Novedad del faltante (obligatoria)</span>
                          <textarea
                            rows={2}
                            value={String(row?.novedad || '')}
                            onChange={(event) => {
                              handleReceiveShipmentDraftFieldChange(rowProductId, 'novedad', event.target.value)
                              if (receiveShipmentError) setReceiveShipmentError('')
                            }}
                            disabled={receiveShipmentSubmitting}
                          />
                        </label>
                      )}
                    </article>
                  </div>
                )
              })() : null}

              {receiveShipmentError && (
                <p className="quick-actions__receive-error">{receiveShipmentError}</p>
              )}
            </div>

            <footer className="quick-actions__receive-actions">
              <button
                type="button"
                className="quick-actions__receive-btn quick-actions__receive-btn--cancel"
                onClick={closeReceiveShipmentModal}
                disabled={receiveShipmentSubmitting}
              >
                Cancelar
              </button>
              {receiveShipmentShowSummary ? (
                <>
                  <button
                    type="button"
                    className="quick-actions__receive-btn quick-actions__receive-btn--ghost"
                    onClick={() => setReceiveShipmentShowSummary(false)}
                    disabled={receiveShipmentSubmitting}
                  >
                    Volver
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
                      : receiveShipmentAutoResult === 'incompleto'
                        ? 'Confirmar (pedido incompleto)'
                        : 'Confirmar recepcion'}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="quick-actions__receive-btn quick-actions__receive-btn--primary"
                    onClick={() => {
                      for (const row of receiveShipmentRows) {
                        const rowValidationMessage = getReceiveShipmentRowValidationMessage(row, {
                          requireReviewed: true,
                        })
                        if (rowValidationMessage) {
                          setReceiveShipmentError(rowValidationMessage)
                          return
                        }
                      }
                      setReceiveShipmentError('')
                      setReceiveShipmentShowSummary(true)
                    }}
                    disabled={receiveShipmentSubmitting || !receiveShipmentRows.length}
                  >
                    Ver resumen
                  </button>
                </>
              )}
            </footer>
          </div>
        </div>
      )}
      {receiveLocationPanelRect && activeReceiveLocationDropdown?.productId && (() => {
        const activeProductId = normalizeId(activeReceiveLocationDropdown.productId)
        const activeField = String(activeReceiveLocationDropdown.field || '').trim().toLowerCase()
        const activeRow = receiveShipmentDraftByProductId?.[activeProductId]
        if (!activeRow) return null

        const selectedBodegaId = normalizeId(activeRow?.location_draft_bodega_id)
        let options = []
        let queryInput = ''
        let placeholder = ''
        let draftFieldKey = ''

        if (activeField === 'bodega') {
          const bodegaQuery = normalizeSearchText(activeRow?.location_draft_bodega_query || '')
          options = bodegaQuery
            ? inTransitBodegas.filter((b) => normalizeSearchText(b?.nombre).includes(bodegaQuery))
            : inTransitBodegas
          queryInput = String(activeRow?.location_draft_bodega_query_input || '')
          placeholder = 'Buscar bodega'
          draftFieldKey = 'location_draft_bodega_id'
        } else if (activeField === 'division') {
          const availableDivisions = selectedBodegaId
            ? inTransitDivisionsByBodegaId.get(selectedBodegaId) || []
            : []
          const divisionQuery = normalizeSearchText(activeRow?.location_draft_division_query || '')
          options = divisionQuery
            ? availableDivisions.filter((d) => normalizeSearchText(d?.nombre).includes(divisionQuery))
            : availableDivisions
          queryInput = String(activeRow?.location_draft_division_query_input || '')
          placeholder = 'Buscar division'
          draftFieldKey = 'location_draft_division_id'
        } else if (activeField === 'subdivision') {
          const selectedDivisionId = normalizeId(activeRow?.location_draft_division_id)
          const availableSubdivisions = selectedDivisionId
            ? inTransitSubdivisionsByDivisionId.get(selectedDivisionId) || []
            : []
          const subdivisionQuery = normalizeSearchText(activeRow?.location_draft_subdivision_query || '')
          options = subdivisionQuery
            ? availableSubdivisions.filter((s) => normalizeSearchText(s?.nombre).includes(subdivisionQuery))
            : availableSubdivisions
          queryInput = String(activeRow?.location_draft_subdivision_query_input || '')
          placeholder = 'Buscar subdivision'
          draftFieldKey = 'location_draft_subdivision_id'
        }

        const getLabel = (option) => {
          if (activeField === 'bodega') return String(option?.nombre || `Bodega ${option.id}`).trim()
          if (activeField === 'division') return String(option?.nombre || `Division ${option.id}`).trim()
          return String(option?.nombre || `Subdivision ${option.id}`).trim()
        }

        return createPortal(
          <div
            ref={receiveLocationPortalPanelRef}
            className={`quick-actions__receive-dropdown-panel quick-actions__receive-dropdown-panel--portal ${darkMode ? 'dark' : 'light'}`}
            style={{
              position: 'fixed',
              top: receiveLocationPanelRect.top,
              left: receiveLocationPanelRect.left,
              width: receiveLocationPanelRect.width,
              zIndex: 9999,
            }}
          >
            <div className="quick-actions__receive-dropdown-search">
              <Search size={13} />
              <input
                type="text"
                placeholder={placeholder}
                value={queryInput}
                onChange={(event) => handleReceiveShipmentLocationSearchInput(activeProductId, activeField, event.target.value)}
                disabled={receiveShipmentSubmitting}
                autoFocus
              />
            </div>
            <div className="quick-actions__receive-dropdown-results">
              {!options.length && <small className="muted">Sin resultados.</small>}
              {options.map((option) => (
                <button
                  key={`receive-portal-${activeField}-${option.id}`}
                  type="button"
                  className="quick-actions__receive-dropdown-option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    handleReceiveShipmentDraftFieldChange(activeProductId, draftFieldKey, option.id)
                    setReceiveLocationPanelRect(null)
                    setActiveReceiveLocationDropdown({ productId: '', field: '' })
                  }}
                  disabled={receiveShipmentSubmitting}
                >
                  <strong>{getLabel(option)}</strong>
                </button>
              ))}
            </div>
          </div>,
          document.body
        )
      })()}
    </>
  )
}

export default QuickActions
