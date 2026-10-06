import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpDown, Bell, Check, ChevronDown, Loader2, Moon, Search, SunMedium, X } from 'lucide-react'
import { Checkbox } from 'primereact/checkbox'
import { Toast } from 'primereact/toast'
import './QuickActions.css'
import RecordatoriosPopup from './RecordatoriosPopup'
import ReceiveCompleteDialog from './ReceiveCompleteDialog'
import notificationAudioSrc from '../common/reminders/notifications.mp3'
import urgentNotificationAudioSrc from '../common/reminders/urgentnotifications.mp3'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDate } from '../../../utils/dateFormat'
import {
  requestSystemNotificationPermission,
  showSystemNotification,
} from '../../../utils/systemNotifications'
import {
  REMINDERS_STORAGE_KEY,
  REMINDERS_SYNC_EVENT,
  RANDOM_INSPECTION_VERIFY_KIND,
  RANDOM_INSPECTION_ADMIN_SUMMARY_KIND,
  TRANSFER_RECEIPT_NOTIFICATION_KIND,
  buildTransferHistoryEntry,
  buildUserIdSet,
  createReminderId,
  emitTransferReminderNotification,
  emitRemindersSync,
  fetchRemindersFromBackend,
  formatCurrentUserName,
  getReminderActionSeverity,
  getReminderDecisionStatus,
  getReminderDeadlineTimestamp,
  getReminderTimestamp,
  getLatestTransferHistoryEntry,
  getResolvedTransferIssuesBySolicitudId,
  getTransferLatestProgressBySolicitudId,
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
  syncSolicitudWebReminders,
  upsertTransferReminder,
  writeRemindersToStorage,
} from '../common/reminders/remindersStorage'

const URGENT_SHIELD_NEAR_FULL_MS = 5 * 60 * 60 * 1000
const URGENT_URGENTE_NEAR_FULL_MS = 5 * 60 * 1000
const URGENT_DECISION_MESSAGE = 'Tienes una solicitud de traslado pendiente.'
const URGENT_URGENTE_DECISION_MESSAGE = '¡Urgente! Tienes una solicitud de traslado pendiente.'
const URGENT_SHIPMENT_MESSAGE = 'Tienes un envío pendiente por despachar.'
const URGENT_REJECTED_TRANSFER_MESSAGE = 'Corrige tu solicitud de traslado rechazada.'
const URGENT_URGENTE_REJECTED_TRANSFER_MESSAGE = '¡Urgente! Corrige tu solicitud de traslado rechazada.'
const URGENT_MESSAGE_REVEAL_PROGRESS = 0.48
const URGENT_SHIELD_TICK_MS = 1000
const REMINDERS_POLL_MS = 4000
const URGENT_DECISION_SHIELD_COLOR = '#FF7900'
const URGENT_URGENTE_SHIELD_COLOR = '#FFD700'
const URGENT_SHIPMENT_SHIELD_COLOR = '#15803d'
const URGENT_REJECTED_TRANSFER_SHIELD_COLOR = '#f94a15'
const URGENT_SHIELD_STACK_OFFSET_DESKTOP = 22
const URGENT_SHIELD_STACK_OFFSET_MOBILE = 14
const URGENT_SHIELD_STACK_SHADE_STEP = 0.3
const URGENT_SHIELD_STACK_SHADE_MAX = 0.6
const TRANSFER_SALIDA_MODAL_STATE_EVENT = 'inventario-transfer-salida-modal-state'
const REJECTED_TRANSFER_EDITING_EVENT = 'inventario-rejected-transfer-editing'
const RANDOM_INSPECTION_DETAIL_ENDPOINT = `${API_URL}/recordatorios/inspeccion-aleatoria`
const RANDOM_INSPECTION_VERIFY_ITEM_ENDPOINT = `${API_URL}/recordatorios/inspeccion-aleatoria/items`
const SOLICITUD_WEB_POLL_MS = 30000

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))
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
      subdivision_id: toPositiveInt(subdivision?.id, 0) || null,
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
const RANDOM_INSPECTION_SYNC_MS = 5000
const RANDOM_INSPECTION_DRAFT_SAVE_DEBOUNCE_MS = 700
const RANDOM_INSPECTION_CONFLICT_MESSAGE =
  'Esta inspección se actualizó desde otro dispositivo. Se cargaron los datos más recientes: revísalos y vuelve a intentarlo.'
// Lo que se guarda de un producto en el borrador del servidor, incluido el
// conteo por ubicacion (antes vivia solo en el navegador y se perdia al
// abrir la inspeccion en otro dispositivo).
const buildRandomInspectionItemDraftPayload = (row) => {
  const payload = {
    id: Number(normalizeId(row?.row_id || row?.id)),
    cantidad_reportada: row?.cantidad_reportada ?? null,
    observacion: String(row?.observacion || '').trim(),
    no_encontrado: Boolean(row?.no_encontrado),
  }
  if (row?.requiere_conteo_por_ubicacion) {
    payload.cantidad_por_ubicacion = (Array.isArray(row?.ubicaciones_bodega) ? row.ubicaciones_bodega : [])
      .filter((location) => Boolean(location?.key))
      .map((location) => ({
        key: location.key,
        subdivision_id: toPositiveInt(location?.subdivision_id, 0) || null,
        cantidad: String(location?.cantidad_contada_input ?? '').trim() === ''
          ? null
          : toPositiveInt(location?.cantidad_contada_input, 0),
      }))
  }
  return payload
}
// Trae del servidor los valores (cantidades, esperado, estado) sin perder
// las ubicaciones que este dispositivo ya tenia armadas.
const mergeRandomInspectionFromServer = (localInspection, serverInspection) => {
  if (!serverInspection || typeof serverInspection !== 'object') return localInspection
  if (!localInspection || typeof localInspection !== 'object') return serverInspection
  const localItems = Array.isArray(localInspection?.items) ? localInspection.items : []
  const serverItems = Array.isArray(serverInspection?.items) ? serverInspection.items : []
  const localIds = localItems.map((item) => normalizeId(item?.id)).sort().join(',')
  const serverIds = serverItems.map((item) => normalizeId(item?.id)).sort().join(',')
  if (localIds !== serverIds) return serverInspection

  const serverById = new Map(serverItems.map((item) => [normalizeId(item?.id), item]))
  return {
    ...localInspection,
    ...serverInspection,
    items: localItems.map((item) => {
      const serverItem = serverById.get(normalizeId(item?.id))
      if (!serverItem) return item
      const serverLocationsByKey = new Map(
        (Array.isArray(serverItem?.ubicaciones_bodega) ? serverItem.ubicaciones_bodega : [])
          .map((location) => [buildInspectionLocationKey(location), location])
      )
      const localLocations = Array.isArray(item?.ubicaciones_bodega) ? item.ubicaciones_bodega : []
      return {
        ...item,
        cantidad_esperada: serverItem.cantidad_esperada,
        cantidad_reportada: serverItem.cantidad_reportada,
        cantidad_primer_conteo: serverItem.cantidad_primer_conteo,
        conteo_ubicaciones: serverItem.conteo_ubicaciones,
        observacion: serverItem.observacion,
        no_encontrado: serverItem.no_encontrado,
        estado_revision: serverItem.estado_revision,
        verificacion_estado: serverItem.verificacion_estado,
        ubicaciones_bodega: localLocations.length
          ? localLocations.map((location) => {
            const serverLocation = serverLocationsByKey.get(buildInspectionLocationKey(location))
            return serverLocation
              ? {
                ...location,
                cantidad: serverLocation.cantidad,
                subdivision_id: location?.subdivision_id || serverLocation.subdivision_id,
              }
              : location
          })
          : serverItem.ubicaciones_bodega,
      }
    }),
  }
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

const isImportacionEnviadoReminder = (reminder) =>
  normalizeReminderContextType(reminder?.context?.type) === 'importacion' &&
  getReminderDecisionStatus(reminder) === 'enviado'

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

const resolveUrgentDecisionProgress = (reminder, nowValue, windowMs = URGENT_SHIELD_NEAR_FULL_MS) => {
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
  const growthWindow = Math.min(windowMs, deadlineWindow)
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
  onOpenSolicitudCliente,
  onOpenSolicitudWeb,
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
  const receiveShipmentDraftSaveDebounceRef = useRef(null)
  // Guardado del borrador de recepcion que aun esta esperando el debounce:
  // si la pagina se cierra o se oculta antes, se manda de inmediato.
  const receiveShipmentPendingDraftSaveRef = useRef(null)
  const receiveLocationSearchDebounceRef = useRef({})
  const receiveLocationDropdownRefs = useRef({})
  const audioContextRef = useRef(null)
  const notificationAudioRef = useRef(null)
  const urgentNotificationAudioRef = useRef(null)
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
  const didInitSolicitudWebSnapshotRef = useRef(false)
  const seenSolicitudWebIdsRef = useRef(new Set())
  const lastSyncedSolicitudWebSignatureRef = useRef('')
  const solicitudWebPollInFlightRef = useRef(false)
  const unreadSolicitudesWebRef = useRef([])
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
  const [unreadSolicitudesWeb, setUnreadSolicitudesWeb] = useState([])
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
  const [receiveShipmentShowErrors, setReceiveShipmentShowErrors] = useState(false)
  const [receiveShipmentShowSummary, setReceiveShipmentShowSummary] = useState(false)
  const [receiveShipmentHasGeneralIssue, setReceiveShipmentHasGeneralIssue] = useState(false)
  const [receiveShipmentGeneralNote, setReceiveShipmentGeneralNote] = useState('')
  const [receiveShipmentFilter, setReceiveShipmentFilter] = useState('')
  const [receiveShipmentSort, setReceiveShipmentSort] = useState('default')
  const [receiveShipmentSortOpen, setReceiveShipmentSortOpen] = useState(false)
  const receiveSortDropdownRef = useRef(null)
  const [activeRandomInspection, setActiveRandomInspection] = useState(null)
  const [randomInspectionDraftByItemId, setRandomInspectionDraftByItemId] = useState({})
  const [randomInspectionMode, setRandomInspectionMode] = useState('review')
  const [randomInspectionStepIndex, setRandomInspectionStepIndex] = useState(0)
  const [randomInspectionShowSummary, setRandomInspectionShowSummary] = useState(false)
  const [randomInspectionLoading, setRandomInspectionLoading] = useState(false)
  const [randomInspectionSubmitting, setRandomInspectionSubmitting] = useState(false)
  const [randomInspectionError, setRandomInspectionError] = useState('')
  const [randomInspectionHasGeneralIssue, setRandomInspectionHasGeneralIssue] = useState(false)
  const [randomInspectionGeneralNote, setRandomInspectionGeneralNote] = useState('')
  const [randomInspectionSearch, setRandomInspectionSearch] = useState('')
  // Sincronizacion del borrador entre dispositivos (misma cuenta en la compu
  // y en la tablet): version del servidor que tiene este dispositivo, que
  // productos cambiaron aca y todavia no se guardaron, y una cola para que
  // los guardados de este mismo dispositivo no se pisen entre si.
  const randomInspectionVersionRef = useRef(null)
  const randomInspectionDirtyItemsRef = useRef(new Map())
  const randomInspectionMetaDirtyRef = useRef(false)
  const randomInspectionSaveQueueRef = useRef(Promise.resolve())
  const randomInspectionSaveTimerRef = useRef(null)
  const randomInspectionRowsRef = useRef([])
  const randomInspectionMetaRef = useRef({})
  const randomInspectionLastSentMetaRef = useRef('')
  const randomInspectionActiveIdRef = useRef('')
  const randomInspectionSubmittingRef = useRef(false)
  const randomInspectionEditSeqRef = useRef(0)
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
  const hasUrgenteActiveRef = useRef(false)
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
      const [trasladoResponse, importacionResponse] = await Promise.all([
        authFetch(`${API_URL}/movimientos/movimiento_inventario/envios-en-camino/?page_size=200`, {}, token),
        authFetch(`${API_URL}/importaciones/importaciones/envios-pendientes/?page_size=200`, {}, token),
      ])

      if (!trasladoResponse.ok) {
        throw new Error('No se pudieron cargar los envíos en camino.')
      }

      const trasladoPayload = await trasladoResponse.json().catch(() => ({}))
      const trasladoRows = parseApiList(trasladoPayload).filter((s) => shouldIncludeInTransitShipment(s))

      const importacionRows = importacionResponse.ok
        ? parseApiList(await importacionResponse.json().catch(() => ({}))).filter(
            (s) => shouldIncludeInTransitShipment(s)
          )
        : []

      const rows = [...trasladoRows, ...importacionRows].sort((a, b) => {
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

  const fetchUnreadSolicitudesWeb = useCallback(async ({ silent = false } = {}) => {
    if (!token || !isAdministrator) {
      setUnreadSolicitudesWeb([])
      return []
    }

    if (solicitudWebPollInFlightRef.current) return []
    solicitudWebPollInFlightRef.current = true
    try {
      const response = await authFetch(
        `${API_URL}/contacto-web/solicitudes/?leido=false&page_size=200`,
        {},
        token
      )
      if (!response.ok) throw new Error('No se pudieron cargar las solicitudes web.')
      const payload = await response.json().catch(() => ({}))
      const rows = parseApiList(payload)
      setUnreadSolicitudesWeb(rows)
      return rows
    } catch {
      if (!silent) setUnreadSolicitudesWeb([])
      return []
    } finally {
      solicitudWebPollInFlightRef.current = false
    }
  }, [isAdministrator, token])

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
    const useUrgentTone = Boolean(options?.urgent)
    const audio = useUrgentTone
      ? (urgentNotificationAudioRef.current || notificationAudioRef.current)
      : notificationAudioRef.current
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
    () => reminders.filter((reminder) => {
      if (!isReminderPendingForCurrentUser(reminder, currentUserIds)) return false
      if (isSpecialTransferDecisionReminder(reminder) && isReminderCreatedByCurrentUser(reminder, currentUserIds, currentUserName)) return false
      return true
    }),
    [reminders, currentUserIds, currentUserName]
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
      .filter((reminder) => {
        const sucursalSolicitanteId = normalizeId(reminder?.context?.sucursal_solicitante_id)
        if (!sucursalSolicitanteId) return false
        return currentReceiveBranchIdSet.has(sucursalSolicitanteId)
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
  }, [canViewInTransitShipments, currentReceiveBranchIdSet, currentUserIds, inTransitShipments, reminders, user])

  const visibleInTransitShipments = useMemo(
    () => [
      ...(Array.isArray(inTransitShipments) ? inTransitShipments : []),
      ...fallbackInTransitShipments,
    ],
    [fallbackInTransitShipments, inTransitShipments]
  )

  const hasInTransitShipments = visibleInTransitShipments.length > 0
  const canOpenInTransitShipments = canViewInTransitShipments || fallbackInTransitShipments.length > 0

  const remindersTransferIssueResolutionBySolicitudId = useMemo(
    () => getResolvedTransferIssuesBySolicitudId(reminders),
    [reminders]
  )

  const remindersTransferLatestProgressBySolicitudId = useMemo(
    () => getTransferLatestProgressBySolicitudId(reminders),
    [reminders]
  )

  // A reminder only lights up the bell when it represents an unresolved action —
  // identical rule set to what colors a day red/yellow in the reminders timeline.
  const actionRequiredRemindersForCurrentUser = useMemo(
    () =>
      reminders.filter((reminder) => {
        if (!isReminderForCurrentUser(reminder, currentUserIds)) return false
        const severity = getReminderActionSeverity(reminder, {
          currentUserIdSet: currentUserIds,
          currentUserName,
          resolvedTransferIssuesBySolicitudId: remindersTransferIssueResolutionBySolicitudId,
          transferLatestProgressBySolicitudId: remindersTransferLatestProgressBySolicitudId,
        })
        return severity !== 'default'
      }),
    [
      reminders,
      currentUserIds,
      currentUserName,
      remindersTransferIssueResolutionBySolicitudId,
      remindersTransferLatestProgressBySolicitudId,
    ]
  )

  const hasPendingReminder = actionRequiredRemindersForCurrentUser.length > 0

  const generalPendingRemindersForCurrentUser = useMemo(
    () =>
      pendingRemindersForCurrentUser.filter((reminder) => {
        if (isRandomInspectionReminder(reminder)) return false
        if (isResolvedTransferResponseReminder(reminder)) return false
        if (isSpecialTransferDecisionReminder(reminder)) return false
        if (isImportacionEnviadoReminder(reminder)) return false
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

      const urgentNotificationAudio = urgentNotificationAudioRef.current
      urgentNotificationAudioRef.current = null
      if (urgentNotificationAudio) {
        try {
          urgentNotificationAudio.pause()
          urgentNotificationAudio.src = ''
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

    const urgentAudio = new Audio(urgentNotificationAudioSrc)
    urgentAudio.preload = 'auto'
    urgentAudio.volume = 0.9
    urgentNotificationAudioRef.current = urgentAudio
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
    seenSolicitudWebIdsRef.current = new Set()
    didInitSolicitudWebSnapshotRef.current = false
    lastSyncedSolicitudWebSignatureRef.current = ''
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
    if (typeof window === 'undefined') return undefined
    if (!token || !isAdministrator) {
      setUnreadSolicitudesWeb([])
      return undefined
    }

    let cancelled = false

    const syncSolicitudesWeb = async () => {
      if (cancelled) return
      await fetchUnreadSolicitudesWeb({ silent: true })
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      void syncSolicitudesWeb()
    }

    const handleFocus = () => {
      void syncSolicitudesWeb()
    }

    void fetchUnreadSolicitudesWeb()
    const intervalId = window.setInterval(syncSolicitudesWeb, SOLICITUD_WEB_POLL_MS)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [fetchUnreadSolicitudesWeb, isAdministrator, token])

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
      const latestStage = String(getLatestTransferHistoryEntry(reminder)?.stage || '').toLowerCase()
      if (latestStage === 'completo' || latestStage === 'incompleto' || latestStage === 'recibido') return false
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
            message: Boolean(reminder?.context?.urgente) ? URGENT_URGENTE_DECISION_MESSAGE : URGENT_DECISION_MESSAGE,
            priorityTimestamp: resolveReminderStateTimestamp(reminder) || parseEntityTimestamp(dateTimeCandidate),
            isUrgente: Boolean(reminder?.context?.urgente),
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
    let hasNewUrgente = false
    nextSnapshotKeys.forEach((snapshotKey) => {
      if (seenIds.has(snapshotKey)) return
      const reminderId = normalizeId(String(snapshotKey).split(':')[0])
      if (reminderId) newReminderIds.push(reminderId)
      const matchingReminder = eligibleUrgentDecisionReminders.find(
        (reminder) => getTransferReminderPendingSnapshotKey(reminder) === snapshotKey
      )
      if (matchingReminder?.context?.urgente) hasNewUrgente = true
    })
    seenUrgentReminderIdsRef.current = nextSnapshotKeys

    if (newReminderIds.length) {
      playNotificationTone({ forceForAdmin: true, urgent: hasNewUrgente })
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

  useEffect(() => {
    unreadSolicitudesWebRef.current = unreadSolicitudesWeb
  }, [unreadSolicitudesWeb])

  useEffect(() => {
    const nextIds = new Set(
      unreadSolicitudesWeb.map((row) => normalizeId(row?.id)).filter(Boolean)
    )

    if (!didInitSolicitudWebSnapshotRef.current) {
      seenSolicitudWebIdsRef.current = nextIds
      didInitSolicitudWebSnapshotRef.current = true
      playInitialPendingToneIfNeeded(nextIds, {
        type: 'solicitud_web_no_leida',
      }, { allowAdminTone: true })
    } else {
      const seenIds = seenSolicitudWebIdsRef.current
      const newIds = []
      nextIds.forEach((id) => {
        if (!seenIds.has(id)) newIds.push(id)
      })
      seenSolicitudWebIdsRef.current = nextIds

      if (newIds.length) {
        playNotificationTone({ forceForAdmin: true })
        void showSystemNotification({
          title: newIds.length > 1
            ? `Tienes ${newIds.length} solicitudes nuevas del sitio web.`
            : 'Tienes una solicitud nueva del sitio web.',
          body: 'Revisa el formulario de contacto en Configuración.',
          tag: 'inventario-solicitud-web',
          url: '/',
          requireInteraction: true,
        })
      }
    }

    // Ademas del sonido/badge, refleja estas solicitudes como tarjetas reales
    // dentro del popup de Recordatorios — solo cuando el conjunto de ids
    // realmente cambio, para no forzar un PUT al backend en cada poll.
    const signature = Array.from(nextIds).sort().join(',')
    if (signature !== lastSyncedSolicitudWebSignatureRef.current) {
      lastSyncedSolicitudWebSignatureRef.current = signature
      setReminders((prev) => {
        const source = Array.isArray(prev) ? prev : []
        const next = syncSolicitudWebReminders(source, unreadSolicitudesWeb, user)
        const normalized = writeRemindersToStorage(next)
        emitRemindersSync()
        return normalized
      })
    }
  }, [unreadSolicitudesWeb, playInitialPendingToneIfNeeded, playNotificationTone, user])

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
        reminder,
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
    let hasNewUrgente = false
    responseSnapshots.forEach(({ reminderId, snapshotKey, reminder }) => {
      if (seenIds.has(snapshotKey)) return
      nextReminderIdsSet.add(reminderId)
      if (reminder?.context?.urgente && getReminderDecisionStatus(reminder) === 'rechazada') {
        hasNewUrgente = true
      }
    })
    seenTransferResponseReminderIdsRef.current = nextIds
    const newReminderIds = Array.from(nextReminderIdsSet)

	    if (newReminderIds.length) {
	      playNotificationTone({ forceForAdmin: true, urgent: hasNewUrgente })
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
              const isUrgente = Boolean(reminder?.context?.urgente)

              return {
                id: targetId || `rejected-transfer-${reminderId}`,
                reminderId,
                kind: 'rejected_transfer',
                anchor: 'top_right',
                message: isUrgente ? URGENT_URGENTE_REJECTED_TRANSFER_MESSAGE : URGENT_REJECTED_TRANSFER_MESSAGE,
                priorityTimestamp: resolveReminderStateTimestamp(reminder) || parseEntityTimestamp(dateTimeCandidate),
                isUrgente,
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

      const windowMs = target?.isUrgente ? URGENT_URGENTE_NEAR_FULL_MS : URGENT_SHIELD_NEAR_FULL_MS
      map[targetId] = resolveUrgentDecisionProgress(target?.reminder, now, windowMs)
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
    const urgenteStackByAnchor = new Map()
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
      if (anchor === 'top_left') {
        return { x: 0, y: 0 }
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
        const isUrgente = Boolean(target?.isUrgente)
        const shadeMap = isUrgente ? urgenteStackByAnchor : stackByAnchor
        const anchorStackIndex = Number(shadeMap.get(anchor) || 0)
        shadeMap.set(anchor, anchorStackIndex + 1)
        const progress = clamp01(
          urgentVisualProgressById[targetId] ?? urgentProgressById[targetId]
        )
        const size = Math.max(44, Math.round(44 + maxCanvas * progress))
        const stackShade = Math.min(
          anchorStackIndex * URGENT_SHIELD_STACK_SHADE_STEP,
          URGENT_SHIELD_STACK_SHADE_MAX
        )
        const anchorCenter = resolveAnchorCenter(anchor)
        const centerX = anchorCenter.x
        const centerY = anchorCenter.y
        const urgentColor = isUrgente
          ? URGENT_URGENTE_SHIELD_COLOR
          : target?.kind === 'pending_shipment'
            ? URGENT_SHIPMENT_SHIELD_COLOR
            : target?.kind === 'rejected_transfer'
              ? URGENT_REJECTED_TRANSFER_SHIELD_COLOR
              : URGENT_DECISION_SHIELD_COLOR
        const zIndex = isUrgente
          ? String(1400 + Math.round(99 * (1 - progress)))
          : String(Math.round(1200 + 99 * (1 - progress)))

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
            '--urgent-color': urgentColor,
            zIndex,
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

  // Avance de la recepcion por partes, guardado en el servidor:
  // { producto_id: { recibido, por_ubicar, pendiente_guardar } }.
  const receiveShipmentProgress = useMemo(
    () => (activeInTransitShipment?.recepcion_progreso && typeof activeInTransitShipment.recepcion_progreso === 'object'
      ? activeInTransitShipment.recepcion_progreso
      : {}),
    [activeInTransitShipment]
  )

  const receiveShipmentRows = useMemo(() => {
    const rows = Object.values(receiveShipmentDraftByProductId || {}).sort(
      (first, second) => Number(first?.orden || 0) - Number(second?.orden || 0)
    )

    return rows.map((row) => {
        const sentQty = toPositiveInt(row?.cantidad_enviada, 0)
        const progress = receiveShipmentProgress?.[normalizeId(row?.producto_id)] || null
        const alreadyReceived = toPositiveInt(progress?.recibido, 0)
        const pendingToStore = toPositiveInt(progress?.pendiente_guardar, 0)
        // Ya recibido por partes: su cantidad queda fija (ya esta en el stock)
        // y al cerrar no se vuelve a sumar (sin ubicaciones nuevas).
        const isRegistered = alreadyReceived > 0
        const receivedQty = isRegistered ? alreadyReceived : toPositiveInt(row?.cantidad_recibida, 0)
        const receivedQtyInput = isRegistered
          ? String(alreadyReceived)
          : Object.prototype.hasOwnProperty.call(row, 'cantidad_recibida_input')
            ? String(row?.cantidad_recibida_input ?? '')
            : String(receivedQty)
        const missingQty = Math.max(0, sentQty - receivedQty)
        const surplusQty = Math.max(0, receivedQty - sentQty)
        const selectedSubdivisionId = normalizeId(row?.location_draft_subdivision_id)
        const locations = !isRegistered && selectedSubdivisionId && receivedQty > 0
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
          cantidad_sobrante: surplusQty,
          ubicaciones: locations,
          cantidad_asignada: isRegistered ? receivedQty : assignedQty,
          recepcion_registrada: isRegistered,
          ya_recibido: alreadyReceived,
          pendiente_guardar: pendingToStore,
          ...(isRegistered ? { recepcion_revisada: true } : {}),
        }
      })
  }, [receiveShipmentDraftByProductId, receiveShipmentProgress])

  const filteredReceiveShipmentRows = useMemo(() => {
    const term = receiveShipmentFilter.trim().toLowerCase()
    const filtered = term
      ? receiveShipmentRows.filter((row) => {
          const code = String(row?.producto_codigo || '').toLowerCase()
          const name = String(row?.producto_nombre || '').toLowerCase()
          return code.includes(term) || name.includes(term)
        })
      : [...receiveShipmentRows]

    if (receiveShipmentSort === 'bodega_first') {
      filtered.sort((a, b) => {
        const aHas = Boolean(a?.location_draft_bodega_id)
        const bHas = Boolean(b?.location_draft_bodega_id)
        if (aHas === bHas) return 0
        return aHas ? -1 : 1
      })
    } else if (receiveShipmentSort === 'codigo') {
      filtered.sort((a, b) =>
        String(a?.producto_codigo || '').localeCompare(String(b?.producto_codigo || ''))
      )
    } else if (receiveShipmentSort === 'nombre') {
      filtered.sort((a, b) =>
        String(a?.producto_nombre || '').localeCompare(String(b?.producto_nombre || ''))
      )
    }

    return filtered
  }, [receiveShipmentRows, receiveShipmentFilter, receiveShipmentSort])

  const receiveShipmentTransferCode = useMemo(
    () => String(activeInTransitShipment?.no_documento || activeInTransitShipment?.id || '').trim(),
    [activeInTransitShipment]
  )

  const receiveShipmentFacturaReferencia = useMemo(
    () => String(activeInTransitShipment?.factura_referencia || '').trim(),
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

      if (row?.recepcion_registrada) {
        // Ya esta en el stock; para cerrar solo falta guardar lo de POR UBICAR.
        return requireReviewed && toPositiveInt(row?.pendiente_guardar, 0) > 0
          ? `Guarda en su ubicacion ${productLabel} (esta en POR UBICAR).`
          : ''
      }
      if (requireReviewed && !row?.recepcion_revisada) {
        return `Debes marcar como revisado ${productLabel}.`
      }
      if (receivedQty === 0 && !row?.recepcion_revisada) {
        return `Ingresa la cantidad recibida de ${productLabel}.`
      }
      if (assignedQty !== receivedQty) {
        return `Selecciona una ubicacion valida para ${productLabel}.`
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
        // "No lo encontre" cuenta como 0 (en todas las ubicaciones).
        const notFound = Object.prototype.hasOwnProperty.call(draft, 'no_encontrado')
          ? Boolean(draft.no_encontrado)
          : Boolean(item?.no_encontrado)
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
            const rawInput = notFound
              ? '0'
              : Object.prototype.hasOwnProperty.call(locationCountDraft, location.key)
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
          : notFound
            ? '0'
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
          no_encontrado: notFound,
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

  const randomInspectionAnsweredCount = useMemo(
    () =>
      randomInspectionRows.filter((row) => row?.cantidad_reportada != null).length,
    [randomInspectionRows]
  )

  // Revision por division: se cuenta fila por fila (cada subdivision es un
  // paso con todos sus codigos en una tabla). Un producto que esta en varias
  // filas aparece en cada una con su cantidad por ubicacion.
  const isRandomInspectionTableMode = (
    !isRandomInspectionVerifyMode &&
    Boolean(activeRandomInspection?.es_por_division)
  )
  const randomInspectionGroups = useMemo(() => {
    if (!isRandomInspectionTableMode) return []
    const groups = []
    const byKey = new Map()
    const addEntry = (location, entry) => {
      const key = String(location?.subdivision_id || location?.label || 'sin-ubicacion')
      let group = byKey.get(key)
      if (!group) {
        group = {
          key,
          label: [location?.bodega_nombre, location?.division_nombre, location?.subdivision_nombre]
            .map((part) => String(part || '').trim())
            .filter(Boolean)
            .join(' / ') || 'Sin ubicación',
          entries: [],
        }
        byKey.set(key, group)
        groups.push(group)
      }
      group.entries.push(entry)
    }
    randomInspectionRows.forEach((row, rowIndex) => {
      const locations = Array.isArray(row?.ubicaciones_bodega) ? row.ubicaciones_bodega : []
      if (row?.requiere_conteo_por_ubicacion) {
        locations.forEach((location) => addEntry(location, { row, rowIndex, location }))
      } else {
        addEntry(locations[0] || null, { row, rowIndex, location: null })
      }
    })
    return groups
  }, [isRandomInspectionTableMode, randomInspectionRows])
  const randomInspectionStepCount = isRandomInspectionTableMode
    ? randomInspectionGroups.length
    : randomInspectionRows.length

  const activeRandomInspectionStepIndex = useMemo(() => {
    if (!randomInspectionStepCount) return 0
    return Math.min(randomInspectionStepIndex, randomInspectionStepCount - 1)
  }, [randomInspectionStepCount, randomInspectionStepIndex])

  const activeRandomInspectionGroup = isRandomInspectionTableMode
    ? randomInspectionGroups[activeRandomInspectionStepIndex] || null
    : null
  const activeRandomInspectionRow = useMemo(
    () => (
      activeRandomInspectionGroup
        ? activeRandomInspectionGroup.entries[0]?.row || null
        : randomInspectionRows[activeRandomInspectionStepIndex] || null
    ),
    [activeRandomInspectionGroup, activeRandomInspectionStepIndex, randomInspectionRows]
  )
  const isRandomInspectionSummaryVisible = !isRandomInspectionVerifyMode && randomInspectionShowSummary
  const randomInspectionAllAnswersReady = (
    randomInspectionRows.length > 0 &&
    randomInspectionAnsweredCount === randomInspectionRows.length
  )

  useEffect(() => {
    randomInspectionRowsRef.current = randomInspectionRows
  }, [randomInspectionRows])

  useEffect(() => {
    randomInspectionActiveIdRef.current = normalizeId(activeRandomInspection?.id)
  }, [activeRandomInspection?.id])

  useEffect(() => {
    randomInspectionMetaRef.current = {
      paso_actual: randomInspectionStepIndex,
      fase: randomInspectionShowSummary ? 'resumen' : 'conteo',
      tiene_novedad: randomInspectionHasGeneralIssue,
      nota_general: randomInspectionHasGeneralIssue ? randomInspectionGeneralNote : '',
    }
  }, [
    randomInspectionGeneralNote,
    randomInspectionHasGeneralIssue,
    randomInspectionShowSummary,
    randomInspectionStepIndex,
  ])

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
        // `remote` es un snapshot compartido (guardado por cualquier sesion
        // que haya escrito antes) -- puede traer tarjetas de "solicitud web"
        // que ya se resolvieron desde entonces (la solicitud ya se marco
        // leida, o se elimino) pero que nadie volvio a re-subir sin ellas
        // todavia. Se reconcilian aqui mismo, contra lo que esta sesion sabe
        // ahora mismo de /contacto-web/solicitudes/?leido=false, para que
        // este poll de cada 4s nunca reviva una tarjeta zombie encima del
        // pruning que hace el otro efecto (el de unreadSolicitudesWeb, que
        // solo corre cada 30s).
        const reconciled = syncSolicitudWebReminders(remote, unreadSolicitudesWebRef.current, user)
        setReminders(reconciled)
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
  }, [token, user])

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
    hasUrgenteActiveRef.current = urgentShieldTargets.some((t) => t?.isUrgente)
  }, [urgentShieldTargets])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const timer = window.setInterval(() => {
      if (hasUrgenteActiveRef.current) {
        playNotificationTone({ forceForAdmin: true, urgent: true })
      }
    }, 10 * 1000)
    return () => window.clearInterval(timer)
  }, [playNotificationTone])

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
    setReceiveShipmentShowErrors(false)
    setReceiveShipmentSubmitting(false)
    setReceiveShipmentShowSummary(false)
    setReceiveShipmentHasGeneralIssue(false)
    setReceiveShipmentGeneralNote('')
    setReceiveShipmentFilter('')
    setReceiveShipmentSort('default')
    setReceiveShipmentSortOpen(false)
  }, [])

  useEffect(() => {
    if (!receiveShipmentSortOpen) return undefined
    const handleClick = (event) => {
      if (receiveSortDropdownRef.current && !receiveSortDropdownRef.current.contains(event.target)) {
        setReceiveShipmentSortOpen(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [receiveShipmentSortOpen])

  useEffect(() => {
    const shipmentId = normalizeId(activeInTransitShipment?.id)
    if (!shipmentId || !isReceiveShipmentModalOpen) return

    clearTimeout(receiveShipmentDraftSaveDebounceRef.current)
    const saveDraft = ({ keepalive = false } = {}) => {
      receiveShipmentPendingDraftSaveRef.current = null
      if (!token || !shipmentId) return
      const items = {}
      Object.values(receiveShipmentDraftByProductId).forEach((row) => {
        const pid = normalizeId(row?.producto_id)
        if (!pid) return
        // La ubicacion que cuenta es la del selector de la fila (igual que al
        // confirmar, ver receiveShipmentRows). Antes se guardaba `ubicaciones`
        // del borrador, que solo traia la sugerencia inicial: lo que el
        // usuario elegia nunca llegaba al servidor y al reabrir se perdia.
        // Mientras el selector aun no se hidrata (catalogos cargando) se
        // conserva lo ya guardado para no borrarlo.
        const selectedSubdivisionId = normalizeId(row?.location_draft_subdivision_id)
        const receivedQty = toPositiveInt(row?.cantidad_recibida, 0)
        const ubicaciones = selectedSubdivisionId
          ? (receivedQty > 0 ? [{ subdivision_id: selectedSubdivisionId, cantidad: receivedQty }] : [])
          : (Array.isArray(row?.ubicaciones) ? row.ubicaciones : [])
        items[pid] = {
          cantidad_recibida: row?.cantidad_recibida ?? null,
          recepcion_revisada: Boolean(row?.recepcion_revisada),
          novedad: String(row?.novedad || '').trim(),
          ubicaciones,
        }
      })
      // Los envios de importacion tienen su propio borrador: antes se mandaban
      // al endpoint de traslados, respondia 404 y el avance se perdia.
      const isImportacionEnvio = activeInTransitShipment?._source === 'importacion'
      const draftUrl = isImportacionEnvio
        ? `${API_URL}/importaciones/importaciones/envios/${encodeURIComponent(normalizeId(activeInTransitShipment?.envio_id) || shipmentId)}/borrador-recepcion/`
        : `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(shipmentId)}/borrador-recepcion/`
      const meta = {
        tiene_novedad_general: Boolean(receiveShipmentHasGeneralIssue),
        nota_general: String(receiveShipmentGeneralNote || ''),
      }
      void authFetch(
        draftUrl,
        { method: 'PATCH', body: JSON.stringify({ items, ...meta }), keepalive },
        token
      )
        .then((response) => {
          if (!response?.ok) return
          // Ya esta en el servidor: el avance que se rescato del navegador
          // (version vieja de la app) ya no hace falta alli.
          // (No mientras quede alguna ubicacion del respaldo sin aplicar.)
          const legacyPending = Object.values(receiveShipmentDraftByProductId || {}).some(
            (row) => normalizeId(row?.legacy_location_subdivision_id)
          )
          if (!legacyPending) {
            try { localStorage.removeItem(`rs_draft_${shipmentId}`) } catch { /* noop */ }
          }
          // Mantener la lista en memoria al dia para que al reabrir el envio
          // sin recargar se vea el ultimo avance guardado.
          setInTransitShipments((prev) => (Array.isArray(prev)
            ? prev.map((row) => (
              normalizeId(row?.id) === shipmentId && row?._source === activeInTransitShipment?._source
                ? { ...row, borrador_recepcion: { ...items, __meta__: meta } }
                : row
            ))
            : prev))
        })
        .catch(() => {})
    }
    receiveShipmentPendingDraftSaveRef.current = saveDraft
    receiveShipmentDraftSaveDebounceRef.current = setTimeout(saveDraft, 1500)
  }, [
    receiveShipmentDraftByProductId,
    receiveShipmentHasGeneralIssue,
    receiveShipmentGeneralNote,
    activeInTransitShipment,
    isReceiveShipmentModalOpen,
    token,
  ])

  // Cerrar la pestana, recargar o mandar la app al fondo (telefono) dentro de
  // la espera del debounce ya no pierde los ultimos cambios.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const flushPendingDraft = () => {
      const pending = receiveShipmentPendingDraftSaveRef.current
      if (!pending) return
      clearTimeout(receiveShipmentDraftSaveDebounceRef.current)
      pending({ keepalive: true })
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') flushPendingDraft()
    }
    window.addEventListener('pagehide', flushPendingDraft)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('pagehide', flushPendingDraft)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
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
    setReceiveShipmentHasGeneralIssue(false)
    setReceiveShipmentGeneralNote('')
    setIsInTransitShipmentsOpen(false)
    setIsReceiveShipmentModalOpen(true)

    return nextLoadRequestId
  }, [])

  const randomInspectionApplyServerRef = useRef(null)
  const randomInspectionCompletedElsewhereRef = useRef(null)

  // Guarda en el servidor solo lo que cambio en ESTE dispositivo (productos
  // editados y, si cambio, en que paso/fase va) junto con la version que
  // tiene. Si otro dispositivo guardo algo antes, el servidor responde 409
  // con su estado: se adopta para lo que aca no se toco y se reintenta.
  const flushRandomInspectionDraft = useCallback((options = {}) => {
    const {
      includeAllItems = false,
      meta = null,
      reveal = false,
      includeInspection = false,
      keepalive = false,
    } = options
    if (randomInspectionSaveTimerRef.current) {
      clearTimeout(randomInspectionSaveTimerRef.current)
      randomInspectionSaveTimerRef.current = null
    }
    const inspectionId = normalizeId(randomInspectionActiveIdRef.current)
    if (!token || !inspectionId) return Promise.resolve(null)

    const dirtyItems = randomInspectionDirtyItemsRef.current
    const sentSeqById = new Map()
    const items = (randomInspectionRowsRef.current || [])
      .filter((row) => includeAllItems || dirtyItems.has(normalizeId(row?.row_id || row?.id)))
      .map((row) => {
        const rowId = normalizeId(row?.row_id || row?.id)
        if (dirtyItems.has(rowId)) sentSeqById.set(rowId, dirtyItems.get(rowId))
        return buildRandomInspectionItemDraftPayload(row)
      })

    const metaPayload = { ...randomInspectionMetaRef.current, ...(meta || {}) }
    const metaSignature = JSON.stringify(metaPayload)
    const sendMeta = Boolean(meta) || (
      randomInspectionMetaDirtyRef.current &&
      metaSignature !== randomInspectionLastSentMetaRef.current
    )
    randomInspectionMetaDirtyRef.current = false
    if (!items.length && !sendMeta && !reveal && !includeInspection) return Promise.resolve(null)
    if (sendMeta) randomInspectionLastSentMetaRef.current = metaSignature

    const body = {
      items,
      ...(sendMeta ? metaPayload : {}),
      ...(reveal ? { revelar: true } : {}),
      ...(includeInspection ? { incluir_inspeccion: true } : {}),
    }

    const isStillActive = () => normalizeId(randomInspectionActiveIdRef.current) === inspectionId

    const run = async () => {
      let version = isStillActive() ? randomInspectionVersionRef.current : null
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await authFetch(
          `${RANDOM_INSPECTION_DETAIL_ENDPOINT}/${encodeURIComponent(inspectionId)}/borrador/`,
          {
            method: 'PATCH',
            body: JSON.stringify({ ...body, version }),
            keepalive,
          },
          token
        )
        const payload = await response.json().catch(() => ({}))
        if (response.ok) {
          const nextVersion = Number(payload?.version)
          if (Number.isFinite(nextVersion) && isStillActive()) {
            randomInspectionVersionRef.current = nextVersion
          }
          sentSeqById.forEach((seq, rowId) => {
            if (dirtyItems.get(rowId) === seq) dirtyItems.delete(rowId)
          })
          return { ok: true, payload }
        }
        if (response.status === 409 && payload?.completed) {
          if (isStillActive()) randomInspectionCompletedElsewhereRef.current?.()
          return { ok: false, completed: true }
        }
        if (response.status === 409 && payload?.conflict && payload?.inspection) {
          version = Number(payload.inspection?.borrador_version)
          if (isStillActive()) randomInspectionApplyServerRef.current?.(payload.inspection)
          // Con todos los productos no se reintenta: se mandarian los
          // valores viejos de este dispositivo encima de los del otro.
          if (includeAllItems) return { ok: false, conflict: true }
          continue
        }
        if (sendMeta) randomInspectionMetaDirtyRef.current = true
        return { ok: false, payload }
      }
      return { ok: false, conflict: true }
    }

    const next = randomInspectionSaveQueueRef.current
      .then(run, run)
      .catch(() => {
        if (sendMeta) randomInspectionMetaDirtyRef.current = true
        return { ok: false }
      })
    randomInspectionSaveQueueRef.current = next
    return next
  }, [token])

  // Cerrar la pestana, recargar o mandar la app al fondo con cambios aun en
  // espera del debounce: se guardan de inmediato.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const flushPending = () => {
      if (!randomInspectionSaveTimerRef.current && randomInspectionDirtyItemsRef.current.size === 0) return
      void flushRandomInspectionDraft({ keepalive: true })
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') flushPending()
    }
    window.addEventListener('pagehide', flushPending)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('pagehide', flushPending)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [flushRandomInspectionDraft])

  const scheduleRandomInspectionDraftSave = useCallback(() => {
    if (randomInspectionSaveTimerRef.current) clearTimeout(randomInspectionSaveTimerRef.current)
    randomInspectionSaveTimerRef.current = setTimeout(() => {
      randomInspectionSaveTimerRef.current = null
      void flushRandomInspectionDraft()
    }, RANDOM_INSPECTION_DRAFT_SAVE_DEBOUNCE_MS)
  }, [flushRandomInspectionDraft])

  const markRandomInspectionItemDirty = useCallback((itemId) => {
    const normalizedItemId = normalizeId(itemId)
    if (!normalizedItemId) return
    randomInspectionEditSeqRef.current += 1
    randomInspectionDirtyItemsRef.current.set(normalizedItemId, randomInspectionEditSeqRef.current)
    scheduleRandomInspectionDraftSave()
  }, [scheduleRandomInspectionDraftSave])

  // Paso, fase (conteo/resumen) y nota general tambien viven en el
  // servidor, para retomar en otro dispositivo donde se quedo.
  const activeRandomInspectionId = normalizeId(activeRandomInspection?.id)
  const activeRandomInspectionStatus = String(activeRandomInspection?.estado || '').trim().toLowerCase()
  useEffect(() => {
    if (!isRandomInspectionModalOpen || randomInspectionMode !== 'review') return
    if (!activeRandomInspectionId || activeRandomInspectionStatus === 'completada') return
    const signature = JSON.stringify({
      paso_actual: randomInspectionStepIndex,
      fase: randomInspectionShowSummary ? 'resumen' : 'conteo',
      tiene_novedad: randomInspectionHasGeneralIssue,
      nota_general: randomInspectionHasGeneralIssue ? randomInspectionGeneralNote : '',
    })
    if (signature === randomInspectionLastSentMetaRef.current) return
    randomInspectionMetaDirtyRef.current = true
    scheduleRandomInspectionDraftSave()
  }, [
    activeRandomInspectionId,
    activeRandomInspectionStatus,
    isRandomInspectionModalOpen,
    randomInspectionGeneralNote,
    randomInspectionHasGeneralIssue,
    randomInspectionMode,
    randomInspectionShowSummary,
    randomInspectionStepIndex,
    scheduleRandomInspectionDraftSave,
  ])

  const closeRandomInspectionModal = useCallback(() => {
    // Lo que se conto aca y aun no se guardo se manda antes de cerrar.
    if (
      randomInspectionDirtyItemsRef.current.size > 0 ||
      randomInspectionMetaDirtyRef.current ||
      randomInspectionSaveTimerRef.current
    ) {
      void flushRandomInspectionDraft()
    }
    if (randomInspectionSaveTimerRef.current) {
      clearTimeout(randomInspectionSaveTimerRef.current)
      randomInspectionSaveTimerRef.current = null
    }
    randomInspectionDirtyItemsRef.current = new Map()
    randomInspectionMetaDirtyRef.current = false
    randomInspectionLastSentMetaRef.current = ''
    randomInspectionVersionRef.current = null
    randomInspectionActiveIdRef.current = ''
    randomInspectionSubmittingRef.current = false
    setIsRandomInspectionModalOpen(false)
    setActiveRandomInspection(null)
    setRandomInspectionDraftByItemId({})
    setRandomInspectionMode('review')
    setRandomInspectionStepIndex(0)
    setRandomInspectionShowSummary(false)
    setRandomInspectionSearch('')
    setRandomInspectionError('')
    setRandomInspectionSubmitting(false)
    setRandomInspectionLoading(false)
    setRandomInspectionHasGeneralIssue(false)
    setRandomInspectionGeneralNote('')
  }, [flushRandomInspectionDraft])

  const buildRandomInspectionDraft = useCallback((inspection) => {
    const rows = Array.isArray(inspection?.items) ? inspection.items : []
    return rows.reduce((acc, item) => {
      const itemId = normalizeId(item?.id)
      if (!itemId) return acc
      const locationCounts = (Array.isArray(item?.conteo_ubicaciones) ? item.conteo_ubicaciones : [])
        .reduce((counts, entry) => {
          const key = String(entry?.key || '').trim()
          if (!key || entry?.cantidad_contada == null) return counts
          counts[key] = String(toPositiveInt(entry.cantidad_contada, 0))
          return counts
        }, {})
      acc[itemId] = {
        id: itemId,
        cantidad_reportada_input: item?.cantidad_reportada == null
          ? ''
          : String(toPositiveInt(item?.cantidad_reportada, 0)),
        cantidad_reportada_por_ubicacion: locationCounts,
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

  // Adopta lo que dice el servidor para todo lo que no se edito en ESTE
  // dispositivo (lo editado aca todavia no llego al servidor y es mas nuevo).
  const applyServerRandomInspection = useCallback((serverInspection) => {
    if (!serverInspection || typeof serverInspection !== 'object') return
    const serverVersion = Number(serverInspection?.borrador_version)
    if (Number.isFinite(serverVersion)) randomInspectionVersionRef.current = serverVersion
    const dirtyItems = randomInspectionDirtyItemsRef.current
    const serverDraft = buildRandomInspectionDraft(serverInspection)
    setActiveRandomInspection((prev) => mergeRandomInspectionFromServer(prev, serverInspection))
    setRandomInspectionDraftByItemId((prev) => {
      const next = { ...(prev || {}) }
      Object.entries(serverDraft).forEach(([itemId, draft]) => {
        if (dirtyItems.has(itemId)) return
        next[itemId] = { ...(prev?.[itemId] || {}), ...draft }
      })
      return next
    })
  }, [buildRandomInspectionDraft])

  const handleRandomInspectionCompletedElsewhere = useCallback(() => {
    randomInspectionDirtyItemsRef.current = new Map()
    randomInspectionMetaDirtyRef.current = false
    closeRandomInspectionModal()
    toast.current?.show({
      severity: 'info',
      summary: 'Inspección aleatoria',
      detail: 'Esta inspección ya se envió desde otro dispositivo.',
      life: 4200,
    })
    if (token) {
      void fetchRemindersFromBackend(token)
        .then((remoteReminders) => setReminders(remoteReminders))
        .catch(() => {})
    }
  }, [closeRandomInspectionModal, token])

  useEffect(() => {
    randomInspectionApplyServerRef.current = applyServerRandomInspection
    randomInspectionCompletedElsewhereRef.current = handleRandomInspectionCompletedElsewhere
  }, [applyServerRandomInspection, handleRandomInspectionCompletedElsewhere])

  // Mientras la inspeccion esta abierta se trae lo que se haya guardado desde
  // otro dispositivo (antes el modal nunca se refrescaba y se podia enviar
  // con cantidades viejas). No mueve al usuario de paso: solo actualiza valores.
  useEffect(() => {
    if (!isRandomInspectionModalOpen || randomInspectionMode !== 'review' || !token) return undefined
    if (!activeRandomInspectionId || activeRandomInspectionStatus === 'completada') return undefined

    let cancelled = false
    let inFlight = false
    const syncFromServer = async () => {
      if (cancelled || inFlight || randomInspectionSubmittingRef.current) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      inFlight = true
      try {
        const response = await authFetch(
          `${RANDOM_INSPECTION_DETAIL_ENDPOINT}/${encodeURIComponent(activeRandomInspectionId)}/`,
          {},
          token
        )
        if (!response.ok) return
        const payload = await response.json().catch(() => ({}))
        const serverInspection = payload?.inspection
        if (cancelled || !serverInspection || randomInspectionSubmittingRef.current) return
        if (normalizeId(randomInspectionActiveIdRef.current) !== activeRandomInspectionId) return
        if (String(serverInspection?.estado || '').trim().toLowerCase() === 'completada') {
          handleRandomInspectionCompletedElsewhere()
          return
        }
        const serverVersion = Number(serverInspection?.borrador_version)
        const localVersion = Number(randomInspectionVersionRef.current)
        if (!Number.isFinite(serverVersion)) return
        if (Number.isFinite(localVersion) && serverVersion <= localVersion) return
        // Con cambios propios sin guardar no se pisa nada: al guardarlos el
        // servidor avisa el conflicto y ahi se combinan.
        if (randomInspectionDirtyItemsRef.current.size > 0 || randomInspectionSaveTimerRef.current) return
        applyServerRandomInspection(serverInspection)
      } catch {
        // Sin conexion: se reintenta en el siguiente ciclo.
      } finally {
        inFlight = false
      }
    }

    const intervalId = window.setInterval(() => { void syncFromServer() }, RANDOM_INSPECTION_SYNC_MS)
    const handleFocus = () => { void syncFromServer() }
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleFocus)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleFocus)
    }
  }, [
    activeRandomInspectionId,
    activeRandomInspectionStatus,
    applyServerRandomInspection,
    handleRandomInspectionCompletedElsewhere,
    isRandomInspectionModalOpen,
    randomInspectionMode,
    token,
  ])

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
            subdivision_id: location.subdivision_id,
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
      const isAdminSummaryReminder = reminderKind === RANDOM_INSPECTION_ADMIN_SUMMARY_KIND
      if ((isVerifyReminder || isAdminSummaryReminder) && typeof onOpenInventoryReviewSection === 'function') {
        const opened = onOpenInventoryReviewSection()
        return opened !== false
      }

      setRandomInspectionError('')
      setRandomInspectionLoading(true)
      setRandomInspectionMode(isVerifyReminder ? 'verify' : 'review')
      setRandomInspectionStepIndex(0)
      setRandomInspectionShowSummary(false)
      setRandomInspectionHasGeneralIssue(false)
      setRandomInspectionGeneralNote('')
      setIsRandomInspectionModalOpen(true)
      try {
        const inspection = await fetchRandomInspectionDetail(inspectionId)
        const inspectionStatus = String(inspection?.estado || '').trim().toLowerCase()
        if (!isVerifyReminder && inspectionStatus === 'completada') {
          closeRandomInspectionModal()
          showErrorToast('Esta inspección ya fue enviada y no puede volver a realizarse.')
          return false
        }
        randomInspectionDirtyItemsRef.current = new Map()
        randomInspectionMetaDirtyRef.current = false
        randomInspectionActiveIdRef.current = normalizeId(inspection?.id)
        const serverVersion = Number(inspection?.borrador_version)
        randomInspectionVersionRef.current = Number.isFinite(serverVersion) ? serverVersion : null
        setActiveRandomInspection(inspection)
        if (isVerifyReminder) {
          setRandomInspectionDraftByItemId(buildRandomInspectionVerificationDraft(inspection))
        } else {
          // El servidor es siempre la fuente de verdad (incluido el conteo por
          // ubicacion y en que paso/fase se iba): asi se continua exactamente
          // donde se quedo, aunque haya sido en otro dispositivo.
          setRandomInspectionDraftByItemId(buildRandomInspectionDraft(inspection))
          const serverStep = toPositiveInt(inspection?.borrador_paso_actual, 0)
          if (serverStep > 0) setRandomInspectionStepIndex(serverStep)
          const serverPhase = String(inspection?.borrador_fase || '').trim().toLowerCase()
          // conteo_revelado solo puede venir en true de una inspeccion que haya
          // quedado a medias con el flujo anterior (ya no lo activamos nosotros):
          // en ese caso se retoma directo en el resumen, sin fase de correccion.
          const resumesInSummary = Boolean(inspection?.conteo_revelado) && serverPhase !== 'conteo'
          if (resumesInSummary) setRandomInspectionShowSummary(true)
          if (inspection?.borrador_tiene_novedad) {
            setRandomInspectionHasGeneralIssue(true)
            setRandomInspectionGeneralNote(String(inspection?.borrador_nota_general || ''))
          }
          randomInspectionLastSentMetaRef.current = JSON.stringify({
            paso_actual: serverStep,
            fase: resumesInSummary ? 'resumen' : 'conteo',
            tiene_novedad: Boolean(inspection?.borrador_tiene_novedad),
            nota_general: inspection?.borrador_tiene_novedad ? String(inspection?.borrador_nota_general || '') : '',
          })
        }
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

      // El servidor es siempre la fuente de verdad (ver borrador de inspeccion
      // aleatoria mas abajo, mismo motivo): un borrador guardado solo en este
      // navegador puede quedar desactualizado si la misma cuenta recibe el
      // mismo envio desde otro dispositivo a la vez, y usarlo pisaria
      // cantidades ya guardadas con datos viejos.
      let serverDraft = (shipment?.borrador_recepcion && typeof shipment.borrador_recepcion === 'object')
        ? shipment.borrador_recepcion
        : null

      // Envios de importacion: hasta que tuvieron borrador en el servidor, el
      // avance solo quedaba en este navegador (rs_draft_<id>). Si el servidor
      // aun no tiene nada, se rescata ese avance y el guardado automatico lo
      // sube al servidor.
      // Un borrador del servidor "sin avance" (lo que guarda el autoguardado al
      // solo abrir el envio en otro dispositivo) no debe tapar el rescatado.
      const serverDraftHasProgress = Boolean(serverDraft) && Object.keys(initialDraft).some((productId) => {
        const saved = serverDraft[productId]
        if (!saved || typeof saved !== 'object') return false
        if (saved.recepcion_revisada) return true
        if (String(saved.novedad || '').trim()) return true
        if (Array.isArray(saved.ubicaciones) && saved.ubicaciones.length) return true
        return saved.cantidad_recibida != null
          && Number(saved.cantidad_recibida) !== Number(initialDraft[productId].cantidad_enviada)
      })
      let legacyDraft = null
      try {
        const legacyRaw = localStorage.getItem(`rs_draft_${shipmentId}`)
        const parsedLegacy = legacyRaw ? JSON.parse(legacyRaw) : null
        if (parsedLegacy && typeof parsedLegacy === 'object') legacyDraft = parsedLegacy
      } catch {
        // sin acceso a localStorage: se sigue sin borrador local
      }
      const getLegacyRow = (productId) => {
        const row = legacyDraft?.[productId]
        if (!row || typeof row !== 'object') return null
        if (normalizeId(row.producto_id) && normalizeId(row.producto_id) !== productId) return null
        return row
      }

      if (shipment?._source === 'importacion' && !serverDraftHasProgress) {
        try {
          if (legacyDraft) {
            const recovered = {}
            Object.keys(initialDraft).forEach((productId) => {
              const row = getLegacyRow(productId)
              if (!row) return
              recovered[productId] = {
                cantidad_recibida: row.cantidad_recibida ?? null,
                recepcion_revisada: Boolean(row.recepcion_revisada),
                novedad: String(row.novedad || '').trim(),
                ubicaciones: Array.isArray(row.ubicaciones) ? row.ubicaciones : [],
              }
            })
            if (Object.keys(recovered).length) serverDraft = recovered
          }
        } catch {
          // sin acceso a localStorage: se sigue sin borrador local
        }
      }

      if (serverDraft) {
        Object.keys(initialDraft).forEach((productId) => {
          const saved = serverDraft[productId]
          if (!saved || typeof saved !== 'object') return
          const cantidadEnviada = initialDraft[productId].cantidad_enviada
          const cantRecibida = saved.cantidad_recibida != null ? toPositiveInt(saved.cantidad_recibida, cantidadEnviada) : cantidadEnviada
          initialDraft[productId] = {
            ...initialDraft[productId],
            ...saved,
            cantidad_recibida: cantRecibida,
            cantidad_recibida_input: String(cantRecibida),
            recepcion_revisada: Boolean(saved.recepcion_revisada),
            novedad: String(saved.novedad || '').trim(),
            ubicaciones: Array.isArray(saved.ubicaciones) ? saved.ubicaciones : [],
          }
        })
      }

      // Ubicaciones elegidas en el selector que nunca llegaron al servidor
      // (antes solo se guardaba la sugerida) pero si quedaron en el respaldo
      // del navegador de la version anterior de la app. Se aplican al hidratar
      // el selector (ahi se conoce la sugerencia) y el guardado automatico las
      // sube; el respaldo se borra al guardar, asi que solo pasa una vez.
      if (legacyDraft) {
        Object.keys(initialDraft).forEach((productId) => {
          const legacySubdivisionId = normalizeId(getLegacyRow(productId)?.location_draft_subdivision_id)
          if (!legacySubdivisionId) return
          initialDraft[productId] = {
            ...initialDraft[productId],
            legacy_location_subdivision_id: legacySubdivisionId,
          }
        })
      }

      const loadRequestId = openReceiveShipmentModalShell({
        shipmentId,
        shipment,
        draftByProductId: initialDraft,
      })
      const savedMeta = shipment?.borrador_recepcion?.__meta__
      if (savedMeta && typeof savedMeta === 'object') {
        setReceiveShipmentHasGeneralIssue(Boolean(savedMeta.tiene_novedad_general))
        setReceiveShipmentGeneralNote(String(savedMeta.nota_general || ''))
      }

      // Open first and hydrate catalogs afterwards so the modal feels instant.
      void (async () => {
        try {
          // page_size=500 se quedaba corto: sucursales grandes (9 de Octubre
          // llega a 775 subdivisiones) superaban el limite y esas ubicaciones
          // nunca aparecian al recibir un envio. 2000 deja margen holgado
          // sobre la sucursal mas grande que existe hoy (775).
          const [bodegasResponse, divisionsResponse, subdivisionsResponse] = await Promise.all([
          authFetch(
            `${API_URL}/inventario/bodegas/?page_size=2000&sucursal_id=${encodeURIComponent(
              sucursalSolicitanteId
            )}`,
            {},
            token
          ),
          authFetch(
            `${API_URL}/inventario/divisiones/?page_size=2000&sucursal_id=${encodeURIComponent(
              sucursalSolicitanteId
            )}`,
            {},
            token
          ),
          authFetch(
            `${API_URL}/inventario/subdivisiones/?page_size=2000&sucursal_id=${encodeURIComponent(
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
        // POR UBICAR es la ubicacion temporal de la recepcion por partes: no se
        // ofrece como destino ni como sugerencia (sin ubicacion ya va ahi).
        const isPorUbicar = (name) => normalizeSearchText(name) === 'por ubicar'
        const divisions = parseApiList(divisionsPayload).filter((division) => !isPorUbicar(division?.nombre))
        const porUbicarDivisionIds = new Set(
          parseApiList(divisionsPayload)
            .filter((division) => isPorUbicar(division?.nombre))
            .map((division) => normalizeId(division?.id))
        )
        const subdivisions = parseApiList(subdivisionsPayload).filter((subdivision) => (
          !porUbicarDivisionIds.has(normalizeId(subdivision?.division?.id || subdivision?.division_id || '')) &&
          !isPorUbicar(subdivision?.division?.nombre)
        ))

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
            const alreadyHasUbicaciones = Array.isArray(updated[productId]?.ubicaciones) && updated[productId].ubicaciones.length > 0
            // Rescate del respaldo viejo: solo si lo guardado en el servidor
            // esta vacio o es la ubicacion sugerida (lo unico que se guardaba
            // antes). Si el servidor ya tiene otra, la eligio el usuario
            // despues del arreglo y esa manda.
            const legacySubdivisionId = normalizeId(updated[productId]?.legacy_location_subdivision_id)
            const legacySubdivision = legacySubdivisionId ? localSubdivisionsById.get(legacySubdivisionId) : null
            const savedSubdivisionId = normalizeId(updated[productId]?.ubicaciones?.[0]?.subdivision_id)
            if (legacySubdivision && (!savedSubdivisionId || savedSubdivisionId === suggestedSubdivisionId)) {
              updated[productId] = {
                ...updated[productId],
                legacy_location_subdivision_id: '',
                location_draft_bodega_id: normalizeId(
                  legacySubdivision?.division?.bodega?.id || legacySubdivision?.division?.bodega_id || ''
                ),
                location_draft_division_id: normalizeId(
                  legacySubdivision?.division?.id || legacySubdivision?.division_id || ''
                ),
                location_draft_subdivision_id: legacySubdivisionId,
              }
              return
            }
            if (legacySubdivisionId) {
              // No aplica (el usuario ya eligio otra o la ubicacion ya no existe).
              updated[productId] = { ...updated[productId], legacy_location_subdivision_id: '' }
            }
            if (suggestedSubdivisionId && suggestedDivisionId && suggestedBodegaId && !alreadyHasUbicaciones) {
              const cantidadEnviada = toPositiveInt(detail?.cantidad_enviada, 0)
              updated[productId] = {
                ...updated[productId],
                ubicaciones: [{ subdivision_id: suggestedSubdivisionId, cantidad: cantidadEnviada }],
                location_draft_bodega_id: suggestedBodegaId,
                location_draft_division_id: suggestedDivisionId,
                location_draft_subdivision_id: suggestedSubdivisionId,
              }
            } else if (alreadyHasUbicaciones && !updated[productId].location_draft_subdivision_id) {
              // Restaurar el selector desde la ubicacion guardada. Antes solo
              // pasaba si el producto tenia ubicacion sugerida, asi que los
              // productos nuevos en la sucursal reabrian sin ubicacion.
              const savedSubId = normalizeId(updated[productId]?.ubicaciones?.[0]?.subdivision_id)
              const savedSub = localSubdivisionsById.get(savedSubId) || null
              if (savedSub) {
                updated[productId] = {
                  ...updated[productId],
                  location_draft_bodega_id: normalizeId(savedSub?.division?.bodega?.id || savedSub?.division?.bodega_id || ''),
                  location_draft_division_id: normalizeId(savedSub?.division?.id || savedSub?.division_id || ''),
                  location_draft_subdivision_id: savedSubId,
                }
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
            factura_referencia: String(detail?.factura_referencia || '').trim(),
            descripcion: String(detail?.descripcion || '').trim(),
            borrador_recepcion: detail?.borrador_recepcion || {},
            recepcion_progreso: detail?.recepcion_progreso || {},
            nota_envio: String(detail?.nota_envio || '').trim(),
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
        next.no_encontrado = false
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
    if (field === 'cantidad_reportada' || field === 'observacion') {
      markRandomInspectionItemDirty(normalizedItemId)
    }
  }, [markRandomInspectionItemDirty])

  // Antes mandaba TODOS los productos en cada paso: un dispositivo con datos
  // viejos borraba lo contado en el otro. Ahora solo va lo que cambio aca.
  const saveInspectionDraftToBackend = useCallback(
    (stepIndex) => flushRandomInspectionDraft({ meta: { paso_actual: stepIndex, fase: 'conteo' } }),
    [flushRandomInspectionDraft]
  )

  // Conteo a ciegas de principio a fin: nunca se le revela al empleado el
  // inventario esperado ni si coincidio (eso queda solo para administracion
  // al revisar "Diferencias reportadas"). Por eso, al llegar al ultimo
  // producto, se pasa directo a un resumen neutral de lo contado -- sin
  // pedirle nada al servidor ni marcar la inspeccion como "revelada".
  const handleAdvanceRandomInspectionStep = useCallback(() => {
    if (randomInspectionSubmitting) return
    if (!randomInspectionRows.length) {
      setRandomInspectionError('No hay productos para revisar en esta inspección.')
      return
    }

    if (activeRandomInspectionGroup) {
      const missing = activeRandomInspectionGroup.entries.filter((entry) => (
        entry.location
          ? String(entry.location?.cantidad_contada_input ?? '').trim() === ''
          : entry.row?.cantidad_reportada == null
      ))
      if (missing.length) {
        setRandomInspectionError(
          `Falta la cantidad de ${missing.length} código(s) de esta fila (${missing
            .slice(0, 3)
            .map((entry) => entry.row?.producto_codigo || entry.row?.producto_nombre)
            .join(', ')}${missing.length > 3 ? '...' : ''}). Si no lo encuentras, toca "No lo encontré".`
        )
        return
      }
    } else if (activeRandomInspectionRow?.cantidad_reportada == null) {
      setRandomInspectionError(
        activeRandomInspectionRow?.requiere_conteo_por_ubicacion
          ? 'Completa la cantidad contada en cada ubicación antes de continuar.'
          : 'Ingresa la cantidad contada antes de continuar.'
      )
      return
    }

    setRandomInspectionError('')

    if (activeRandomInspectionStepIndex >= randomInspectionStepCount - 1) {
      setRandomInspectionShowSummary(true)
      void saveInspectionDraftToBackend(activeRandomInspectionStepIndex)
      return
    }
    const nextStep = activeRandomInspectionStepIndex + 1
    setRandomInspectionStepIndex(nextStep)
    void saveInspectionDraftToBackend(nextStep)
  }, [
    activeRandomInspectionGroup,
    activeRandomInspectionRow,
    activeRandomInspectionStepIndex,
    randomInspectionRows,
    randomInspectionStepCount,
    randomInspectionSubmitting,
    saveInspectionDraftToBackend,
  ])

  const handleGoBackRandomInspectionStep = useCallback(() => {
    setRandomInspectionError('')
    if (isRandomInspectionSummaryVisible) {
      setRandomInspectionShowSummary(false)
      setRandomInspectionStepIndex(0)
      void saveInspectionDraftToBackend(0)
      return
    }
    const prevStep = Math.max(0, activeRandomInspectionStepIndex - 1)
    setRandomInspectionStepIndex(prevStep)
    void saveInspectionDraftToBackend(prevStep)
  }, [
    activeRandomInspectionStepIndex,
    isRandomInspectionSummaryVisible,
    saveInspectionDraftToBackend,
  ])

  // Buscador del revisor: encuentra un producto (contado o no) y salta a el.
  const randomInspectionSearchMatches = useMemo(() => {
    const term = String(randomInspectionSearch || '').trim().toLowerCase()
    if (!term) return []
    return randomInspectionRows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => (
        String(row?.producto_codigo || '').toLowerCase().includes(term) ||
        String(row?.producto_nombre || '').toLowerCase().includes(term)
      ))
      .slice(0, 8)
  }, [randomInspectionRows, randomInspectionSearch])

  const [randomInspectionHighlightRowId, setRandomInspectionHighlightRowId] = useState('')
  const jumpToRandomInspectionStep = useCallback((rowIndex) => {
    if (randomInspectionSubmitting) return
    let step = rowIndex
    if (isRandomInspectionTableMode) {
      step = Math.max(0, randomInspectionGroups.findIndex((group) => (
        group.entries.some((entry) => entry.rowIndex === rowIndex)
      )))
      const rowId = normalizeId(randomInspectionRows[rowIndex]?.row_id || randomInspectionRows[rowIndex]?.id)
      setRandomInspectionHighlightRowId(rowId)
      window.setTimeout(() => {
        document.querySelector(`[data-inspection-row="${rowId}"] input`)?.focus()
        document.querySelector(`[data-inspection-row="${rowId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }, 60)
      window.setTimeout(() => setRandomInspectionHighlightRowId((current) => (current === rowId ? '' : current)), 2600)
    }
    setRandomInspectionError('')
    setRandomInspectionSearch('')
    setRandomInspectionShowSummary(false)
    setRandomInspectionStepIndex(step)
    void saveInspectionDraftToBackend(step)
  }, [
    isRandomInspectionTableMode,
    randomInspectionGroups,
    randomInspectionRows,
    randomInspectionSubmitting,
    saveInspectionDraftToBackend,
  ])

  // "No lo encontre": queda en 0 y marcado para que administracion decida
  // (puede reubicarlo). Pasa al siguiente producto como "Siguiente".
  const handleRandomInspectionNotFound = useCallback((targetRow = null, { advance = true } = {}) => {
    const row = targetRow || activeRandomInspectionRow
    if (randomInspectionSubmitting || !row) return
    const itemId = normalizeId(row?.row_id || row?.id)
    if (!itemId) return
    setRandomInspectionDraftByItemId((prev) => ({
      ...prev,
      [itemId]: {
        ...(prev?.[itemId] || {}),
        id: itemId,
        no_encontrado: true,
        cantidad_reportada_input: '',
        cantidad_reportada_por_ubicacion: {},
      },
    }))
    markRandomInspectionItemDirty(itemId)
    setRandomInspectionError('')
    if (!advance) return
    if (activeRandomInspectionStepIndex >= randomInspectionStepCount - 1) {
      setRandomInspectionShowSummary(true)
    } else {
      setRandomInspectionStepIndex(activeRandomInspectionStepIndex + 1)
    }
  }, [
    activeRandomInspectionRow,
    activeRandomInspectionStepIndex,
    markRandomInspectionItemDirty,
    randomInspectionStepCount,
    randomInspectionSubmitting,
  ])

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
          no_encontrado: false,
          cantidad_reportada_por_ubicacion: {
            ...currentLocationCounts,
            [normalizedLocationKey]: normalizeQuantityInputString(value),
          },
        },
      }
    })
    markRandomInspectionItemDirty(normalizedItemId)
  }, [markRandomInspectionItemDirty])

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

        // Siempre la cantidad realmente contada: el servidor decide si
        // coincide comparandola con el stock del sistema en este momento.
        const payloadRow = {
          ...buildRandomInspectionItemDraftPayload(row),
          estado_revision: normalizedEstadoRevision,
          cantidad_reportada: toPositiveInt(row?.cantidad_reportada, -1),
        }
        if (payloadRow.cantidad_reportada < 0) {
          setRandomInspectionError(
            `Debes indicar la cantidad real para ${row?.producto_nombre || row?.producto_codigo || `item ${rowId}`}.`
          )
          return
        }
        itemsPayload.push(payloadRow)
      }

      const generalNote = randomInspectionHasGeneralIssue ? randomInspectionGeneralNote.trim() : ''
      if (randomInspectionHasGeneralIssue && !generalNote) {
        setRandomInspectionError('Cuéntanos qué pasó: el campo es obligatorio si marcaste que algo no salió como lo esperado.')
        return
      }

      setRandomInspectionError('')
      setRandomInspectionSubmitting(true)
      randomInspectionSubmittingRef.current = true
      try {
        // Primero lo que falte guardar de este dispositivo (y, si otro
        // dispositivo cambio algo, se detecta aca y se combina).
        const flushResult = await flushRandomInspectionDraft()
        if (flushResult?.completed) return
        if (flushResult?.conflict) {
          setRandomInspectionError(RANDOM_INSPECTION_CONFLICT_MESSAGE)
          return
        }

        const response = await authFetch(
          `${RANDOM_INSPECTION_DETAIL_ENDPOINT}/${encodeURIComponent(inspectionId)}/responder/`,
          {
            method: 'POST',
            body: JSON.stringify({
              items: itemsPayload,
              nota_general: generalNote,
              version: randomInspectionVersionRef.current,
            }),
          },
          token
        )
        const payload = await response.json().catch(() => ({}))
        if (response.status === 409 && payload?.completed) {
          handleRandomInspectionCompletedElsewhere()
          return
        }
        if (response.status === 409 && payload?.conflict) {
          // Otro dispositivo guardo cantidades distintas: no se envia con
          // datos viejos; se cargan los del servidor para revisarlos.
          if (payload?.inspection) applyServerRandomInspection(payload.inspection)
          setRandomInspectionError(RANDOM_INSPECTION_CONFLICT_MESSAGE)
          return
        }
        if (!response.ok) {
          throw new Error(
            String(payload?.detail || '').trim() || 'No se pudo guardar la inspección.'
          )
        }

        // Nunca se le dice al empleado si hubo diferencias: eso solo lo ve
        // administracion en "Diferencias reportadas".
        toast.current?.show({
          severity: 'success',
          summary: 'Inspección registrada',
          detail: 'La inspección se guardó correctamente.',
          life: 3200,
        })

        randomInspectionDirtyItemsRef.current = new Map()
        randomInspectionMetaDirtyRef.current = false
        closeRandomInspectionModal()
        const remoteReminders = await fetchRemindersFromBackend(token)
        setReminders(remoteReminders)
      } catch (error) {
        setRandomInspectionError(
          error?.message || 'No se pudo guardar la inspección.'
        )
      } finally {
        randomInspectionSubmittingRef.current = false
        setRandomInspectionSubmitting(false)
      }
    },
    [
      activeRandomInspection,
      applyServerRandomInspection,
      closeRandomInspectionModal,
      flushRandomInspectionDraft,
      handleRandomInspectionCompletedElsewhere,
      randomInspectionRows,
      randomInspectionHasGeneralIssue,
      randomInspectionGeneralNote,
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

  const receiveShipmentActionUrl = useCallback((action) => {
    const isImportacionEnvio = activeInTransitShipment?._source === 'importacion'
    return isImportacionEnvio
      ? `${API_URL}/importaciones/importaciones/envios/${encodeURIComponent(normalizeId(activeInTransitShipment?.envio_id) || normalizeId(activeInTransitShipment?.id))}/${action}/`
      : `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(normalizeId(activeInTransitShipment?.id))}/${action}/`
  }, [activeInTransitShipment])

  const applyReceiveShipmentProgress = useCallback((progress) => {
    const incoming = progress && typeof progress === 'object' ? progress : {}
    const shipmentId = normalizeId(activeInTransitShipment?.id)
    const source = activeInTransitShipment?._source
    // Al marcar varios checks seguidos las respuestas pueden llegar en otro
    // orden: lo recibido solo crece, asi que por producto gana el que tenga
    // mas recibido (a igualdad, el que acaba de llegar).
    const merge = (current) => {
      const merged = { ...(current && typeof current === 'object' ? current : {}) }
      Object.entries(incoming).forEach(([productId, entry]) => {
        const previous = merged[productId]
        if (!previous || Number(entry?.recibido || 0) >= Number(previous?.recibido || 0)) {
          merged[productId] = entry
        }
      })
      return merged
    }
    const nextProgress = merge(activeInTransitShipment?.recepcion_progreso)
    setActiveInTransitShipment((prev) => (prev ? { ...prev, recepcion_progreso: merge(prev.recepcion_progreso) } : prev))
    setInTransitShipments((prev) => (Array.isArray(prev)
      ? prev.map((item) => (
        normalizeId(item?.id) === shipmentId && item?._source === source
          ? { ...item, recepcion_progreso: nextProgress }
          : item
      ))
      : prev))
  }, [activeInTransitShipment])

  // Recibir por partes: lo marcado entra ya al stock (en la ubicacion elegida
  // o, si no hay, en POR UBICAR) y la sucursal puede venderlo enseguida.
  const receiveShipmentReceivableRows = useMemo(
    () => receiveShipmentRows.filter((row) => (
      !row?.recepcion_registrada && row?.recepcion_revisada && toPositiveInt(row?.cantidad_recibida, 0) > 0
    )),
    [receiveShipmentRows]
  )
  const receiveShipmentStorableRows = useMemo(
    () => receiveShipmentRows.filter((row) => (
      row?.recepcion_registrada &&
      toPositiveInt(row?.pendiente_guardar, 0) > 0 &&
      normalizeId(row?.location_draft_subdivision_id)
    )),
    [receiveShipmentRows]
  )

  const [receivingProductIds, setReceivingProductIds] = useState(() => new Set())

  // Recibe ya estas filas (entran al stock). `blocking` deshabilita la
  // ventana mientras tanto (boton masivo); al marcar un check no se bloquea
  // para poder seguir marcando.
  const receiveRowsNow = useCallback(async (rowsToReceive, { blocking = false } = {}) => {
    const rows = (Array.isArray(rowsToReceive) ? rowsToReceive : []).filter((row) => (
      !row?.recepcion_registrada && toPositiveInt(row?.cantidad_recibida, 0) > 0
    ))
    if (!token || !activeInTransitShipment || !rows.length) return
    const ids = rows.map((row) => normalizeId(row?.producto_id))
    setReceiveShipmentError('')
    if (blocking) setReceiveShipmentSubmitting(true)
    setReceivingProductIds((prev) => new Set([...prev, ...ids]))
    const postRows = async (batch) => {
      const response = await authFetch(
        receiveShipmentActionUrl('recibir-parcial'),
        {
          method: 'POST',
          body: JSON.stringify({
            items: batch.map((row) => ({
              producto_id: toPositiveInt(row?.producto_id, 0),
              cantidad: toPositiveInt(row?.cantidad_recibida, 0),
              ...(normalizeId(row?.location_draft_subdivision_id)
                ? { subdivision_id: toPositiveInt(row.location_draft_subdivision_id, 0) }
                : {}),
            })),
          }),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudieron recibir los productos.')
      applyReceiveShipmentProgress(payload?.recepcion_progreso)
    }
    try {
      let receivedCount = rows.length
      try {
        await postRows(rows)
      } catch (batchError) {
        if (rows.length === 1) throw batchError
        receivedCount = 0
        const failed = []
        for (const row of rows) {
          try {
            await postRows([row])
            receivedCount += 1
          } catch (rowError) {
            failed.push(`${row?.producto_codigo || row?.producto_id}: ${rowError?.message || 'error'}`)
          }
        }
        if (failed.length) {
          setReceiveShipmentError(
            `No se pudieron recibir ${failed.length} producto(s): ${failed.slice(0, 3).join(' · ')}${failed.length > 3 ? '...' : ''}`
          )
        }
      }
      if (receivedCount > 0 && (blocking || rows.length > 1)) {
        toast.current?.show({
          severity: 'success',
          summary: 'Recibido',
          detail: `${receivedCount} producto(s) ya estan en stock y se pueden vender.`,
          life: 3200,
        })
      }
    } catch (error) {
      setReceiveShipmentError(error?.message || 'No se pudieron recibir los productos.')
    } finally {
      if (blocking) setReceiveShipmentSubmitting(false)
      setReceivingProductIds((prev) => {
        const next = new Set(prev)
        ids.forEach((id) => next.delete(id))
        return next
      })
    }
  }, [activeInTransitShipment, applyReceiveShipmentProgress, receiveShipmentActionUrl, token])

  const autoReceivedShipmentRef = useRef('')
  const activeInTransitShipmentKey = activeInTransitShipment
    ? `${activeInTransitShipment?._source || 'traslado'}-${normalizeId(activeInTransitShipment?.id)}`
    : ''
  useEffect(() => {
    if (!isReceiveShipmentModalOpen || !activeInTransitShipmentKey) {
      autoReceivedShipmentRef.current = ''
      return
    }
    if (autoReceivedShipmentRef.current === activeInTransitShipmentKey) return
    if (receiveShipmentSubmitting || !receiveShipmentRows.length) return
    // Esperar a que carguen las ubicaciones guardadas (llegan despues de
    // abrir); si se recibe antes, todo se iba a POR UBICAR. Si la carga
    // fallo no se hace nada automatico.
    if (inTransitSubdivisionsLoading || openingInTransitShipmentId || !inTransitSubdivisions.length) return
    autoReceivedShipmentRef.current = activeInTransitShipmentKey
    const withLocation = receiveShipmentReceivableRows.filter((row) => normalizeId(row?.location_draft_subdivision_id))
    // Marcados sin ubicacion: se les quita el check (no se reciben solos).
    receiveShipmentReceivableRows
      .filter((row) => !normalizeId(row?.location_draft_subdivision_id))
      .forEach((row) => handleReceiveShipmentReviewToggle(normalizeId(row?.producto_id), false))
    if (withLocation.length) {
      void receiveRowsNow(withLocation, { blocking: true })
    }
  }, [
    activeInTransitShipmentKey,
    handleReceiveShipmentReviewToggle,
    inTransitSubdivisions.length,
    inTransitSubdivisionsLoading,
    isReceiveShipmentModalOpen,
    openingInTransitShipmentId,
    receiveRowsNow,
    receiveShipmentReceivableRows,
    receiveShipmentRows.length,
    receiveShipmentSubmitting,
  ])

  const handleReceiveMarkedRows = useCallback(
    () => receiveRowsNow(receiveShipmentReceivableRows, { blocking: true }),
    [receiveRowsNow, receiveShipmentReceivableRows]
  )

  // Marcar el check = ya se recibe ese producto (no hace falta terminar el
  // envio para que entre al stock).
  const handleReceiveRowCheck = useCallback((productId, checked) => {
    handleReceiveShipmentReviewToggle(productId, checked)
    if (!checked) return
    const row = receiveShipmentRows.find((item) => normalizeId(item?.producto_id) === normalizeId(productId))
    if (row) void receiveRowsNow([row])
  }, [handleReceiveShipmentReviewToggle, receiveRowsNow, receiveShipmentRows])

  const handleReceiveAllCheck = useCallback((checked) => {
    handleReceiveShipmentToggleAllReviewed(checked)
    if (checked) void receiveRowsNow(receiveShipmentRows, { blocking: true })
  }, [handleReceiveShipmentToggleAllReviewed, receiveRowsNow, receiveShipmentRows])

  // Avance de la recepcion (barra arriba de la lista).
  const receiveShipmentProgressSummary = useMemo(() => {
    const total = receiveShipmentRows.length
    const received = receiveShipmentRows.filter((row) => row?.recepcion_registrada).length
    const unitsSent = receiveShipmentRows.reduce((sum, row) => sum + toPositiveInt(row?.cantidad_enviada, 0), 0)
    const unitsReceived = receiveShipmentRows.reduce((sum, row) => sum + toPositiveInt(row?.ya_recibido, 0), 0)
    const toStore = receiveShipmentRows.filter((row) => toPositiveInt(row?.pendiente_guardar, 0) > 0).length
    return {
      total,
      received,
      unitsSent,
      unitsReceived,
      toStore,
      percent: total ? Math.round((received / total) * 100) : 0,
    }
  }, [receiveShipmentRows])

  // Guardar: mueve desde POR UBICAR a la ubicacion elegida.
  const handleStoreReceivedRows = useCallback(async (rowsToStore) => {
    const rows = (Array.isArray(rowsToStore) ? rowsToStore : []).filter((row) => normalizeId(row?.location_draft_subdivision_id))
    if (!token || !activeInTransitShipment || !rows.length) return
    setReceiveShipmentError('')
    setReceiveShipmentSubmitting(true)
    try {
      const response = await authFetch(
        receiveShipmentActionUrl('guardar-ubicaciones'),
        {
          method: 'POST',
          body: JSON.stringify({
            items: rows.map((row) => ({
              producto_id: toPositiveInt(row?.producto_id, 0),
              subdivision_id: toPositiveInt(row?.location_draft_subdivision_id, 0),
            })),
          }),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudieron guardar las ubicaciones.')
      applyReceiveShipmentProgress(payload?.recepcion_progreso)
      toast.current?.show({
        severity: 'success',
        summary: 'Guardado',
        detail: `${rows.length} producto(s) guardados en su ubicacion.`,
        life: 2600,
      })
    } catch (error) {
      setReceiveShipmentError(error?.message || 'No se pudieron guardar las ubicaciones.')
    } finally {
      setReceiveShipmentSubmitting(false)
    }
  }, [activeInTransitShipment, applyReceiveShipmentProgress, receiveShipmentActionUrl, token])

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

      const generalNote = receiveShipmentHasGeneralIssue ? receiveShipmentGeneralNote.trim() : ''
      if (receiveShipmentHasGeneralIssue && !generalNote) {
        setReceiveShipmentError('Cuéntanos qué pasó: el campo es obligatorio si marcaste que algo no salió como lo esperado.')
        return
      }

      setReceiveShipmentError('')
      setReceiveShipmentSubmitting(true)
      try {
        const isImportacionEnvio = activeInTransitShipment?._source === 'importacion'
        const confirmUrl = isImportacionEnvio
          ? `${API_URL}/importaciones/importaciones/envios/${encodeURIComponent(normalizeId(activeInTransitShipment?.envio_id))}/confirmar-recepcion/`
          : `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(normalizeId(activeInTransitShipment?.id))}/confirmar-recepcion/`
        const response = await authFetch(
          confirmUrl,
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
              nota_general: generalNote,
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
        if (isImportacionEnvio) {
          try { localStorage.removeItem(`rs_draft_${normalizeId(activeInTransitShipment?.id)}`) } catch { /* noop */ }
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
      receiveShipmentGeneralNote,
      receiveShipmentHasGeneralIssue,
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

  // Todo recibido (y nada en POR UBICAR): popup de "completo" con confeti;
  // "Listo" confirma la recepcion y cierra el envio.
  const [receiveCompleteDismissedKey, setReceiveCompleteDismissedKey] = useState('')
  const receiveCompleteStats = useMemo(() => {
    const rows = receiveShipmentRows
    const allDone = rows.length > 0 && rows.every((row) => (
      row?.recepcion_registrada && toPositiveInt(row?.pendiente_guardar, 0) === 0
    ))
    const missingRows = rows.filter((row) => toPositiveInt(row?.cantidad_faltante, 0) > 0)
    return {
      allDone,
      productCount: rows.length,
      unitCount: rows.reduce((sum, row) => sum + toPositiveInt(row?.ya_recibido, 0), 0),
      missingUnits: missingRows.reduce((sum, row) => sum + toPositiveInt(row?.cantidad_faltante, 0), 0),
      missingProducts: missingRows.length,
    }
  }, [receiveShipmentRows])
  const showReceiveComplete = (
    isReceiveShipmentModalOpen &&
    Boolean(activeInTransitShipmentKey) &&
    receiveCompleteStats.allDone &&
    !receivingProductIds.size &&
    receiveCompleteDismissedKey !== activeInTransitShipmentKey
  )

  return (
    <>
      <Toast ref={toast} />
      <ReceiveCompleteDialog
        open={showReceiveComplete}
        title={activeInTransitShipment?._source === 'importacion' ? '¡Esta importación está completa!' : '¡Este traslado está completo!'}
        productCount={receiveCompleteStats.productCount}
        unitCount={receiveCompleteStats.unitCount}
        missingUnits={receiveCompleteStats.missingUnits}
        missingProducts={receiveCompleteStats.missingProducts}
        busy={receiveShipmentSubmitting}
        error={receiveShipmentError}
        onDone={() => void handleSubmitShipmentReception()}
        onBack={() => setReceiveCompleteDismissedKey(activeInTransitShipmentKey)}
      />
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
          {shield.target?.isUrgente && (
            <span className="quick-actions__urgent-exclamation" aria-hidden="true">!</span>
          )}
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
              <span className="quick-actions__pending-shipments-count">
                {inTransitShipmentsLoading ? '...' : visibleInTransitShipments.length}
              </span>
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
                                ? `Fecha: ${formatDate(fecha)}`
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
              <span className="quick-actions__pending-shipments-count">
                {pendingShipmentsLoading ? '...' : pendingShipments.length}
              </span>
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
                              (fecha ? `Fecha: ${formatDate(fecha)}` : 'Abrir en salidas')
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
            {(hasPendingReminder || unreadSolicitudesWeb.length > 0) && (
              <span className="quick-actions__pending-dots" aria-hidden="true">
                <span className="quick-actions__pending-dot quick-actions__pending-dot--1" />
              </span>
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
        currentReceiveBranchIds={currentReceiveBranchIds}
        reminders={personalReminders}
        allReminders={reminders}
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
        onOpenSolicitudCliente={onOpenSolicitudCliente}
        onOpenSolicitudWeb={onOpenSolicitudWeb}
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
                    ? `Fecha: ${formatDate(activeRandomInspection.fecha_programada)}`
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

                  {randomInspectionRows.length > 1 && (
                    <div className="quick-actions__inspection-search">
                      <Search size={14} aria-hidden="true" />
                      <input
                        type="search"
                        value={randomInspectionSearch}
                        onChange={(event) => setRandomInspectionSearch(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setRandomInspectionSearch('')
                          if (event.key === 'Enter' && randomInspectionSearchMatches.length) {
                            event.preventDefault()
                            jumpToRandomInspectionStep(randomInspectionSearchMatches[0].index)
                          }
                        }}
                        placeholder={`Buscar entre los ${randomInspectionRows.length} productos (${randomInspectionAnsweredCount} contados)`}
                        aria-label="Buscar producto en la revision"
                        disabled={randomInspectionSubmitting}
                      />
                      {String(randomInspectionSearch).trim() !== '' && (
                        <div className="quick-actions__inspection-search-results" role="listbox">
                          {!randomInspectionSearchMatches.length && (
                            <small className="quick-actions__inspection-search-empty">Ningun producto coincide.</small>
                          )}
                          {randomInspectionSearchMatches.map(({ row, index }) => (
                            <button
                              key={`inspection-search-${normalizeId(row?.row_id || row?.id)}`}
                              type="button"
                              className="quick-actions__inspection-search-row"
                              onClick={() => jumpToRandomInspectionStep(index)}
                            >
                              <span className="quick-actions__inspection-search-step">{index + 1}</span>
                              <span className="quick-actions__inspection-search-text">
                                <strong>{row?.producto_codigo || `Producto ${row?.row_id}`}</strong>
                                <small>{String(row?.producto_nombre || '').trim()}</small>
                              </span>
                              <span
                                className={`quick-actions__inspection-search-state${row?.cantidad_reportada == null ? '' : ' quick-actions__inspection-search-state--done'}`}
                              >
                                {row?.no_encontrado
                                  ? 'No encontrado'
                                  : row?.cantidad_reportada == null ? 'Sin contar' : `Contado: ${row.cantidad_reportada}`}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {!!randomInspectionRows.length && !isRandomInspectionSummaryVisible && activeRandomInspectionGroup && (
                    <div className="quick-actions__inspection-quiz">
                      <div className="quick-actions__inspection-progress" aria-hidden="true">
                        <div className="quick-actions__inspection-progress-bar">
                          <span
                            style={{
                              width: `${((activeRandomInspectionStepIndex + 1) / Math.max(randomInspectionStepCount, 1)) * 100}%`,
                            }}
                          />
                        </div>
                      </div>

                      <div className="quick-actions__inspection-rowhead">
                        <p className="quick-actions__inspection-stage-kicker">
                          {`Fila ${activeRandomInspectionStepIndex + 1} de ${randomInspectionStepCount}`}
                        </p>
                        <h5>{activeRandomInspectionGroup.label}</h5>
                        <p className="quick-actions__inspection-stage-help">
                          Cuenta todos los códigos de esta fila y escribe lo que encontraste de cada uno.
                        </p>
                      </div>

                      <div
                        key={`inspection-rowtable-${activeRandomInspectionGroup.key}`}
                        className="create-user__locations-table quick-actions__inspection-row-table"
                      >
                        <div className="create-user__locations-row create-user__locations-row--head">
                          <span>Código</span>
                          <span>Descripción</span>
                          <span>Contado</span>
                          <span />
                        </div>
                        {activeRandomInspectionGroup.entries.map((entry, entryIndex) => {
                          const row = entry.row
                          const rowId = normalizeId(row?.row_id || row?.id)
                          const value = entry.location
                            ? String(entry.location?.cantidad_contada_input ?? '')
                            : String(row?.cantidad_reportada_input ?? '')
                          const otherLocations = entry.location
                            ? (Array.isArray(row?.ubicaciones_bodega) ? row.ubicaciones_bodega : [])
                              .filter((location) => location?.key !== entry.location?.key)
                              .map((location) => String(location?.label || location?.subdivision_nombre || '').trim())
                              .filter(Boolean)
                            : []
                          return (
                            <div
                              key={`inspection-rowtable-${rowId}-${entry.location?.key || 'unica'}`}
                              data-inspection-row={rowId}
                              className={`create-user__locations-row${randomInspectionHighlightRowId === rowId ? ' quick-actions__inspection-row--highlight' : ''}`}
                            >
                              <span className="quick-actions__inspection-row-code">
                                <strong>{row?.producto_codigo || `Producto ${rowId}`}</strong>
                              </span>
                              <span className="quick-actions__inspection-row-name">
                                {String(row?.producto_nombre || '').trim()}
                                {otherLocations.length > 0 && (
                                  <small>{`También en: ${otherLocations.join(', ')} (se cuenta aparte)`}</small>
                                )}
                              </span>
                              <span>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  data-count-input
                                  value={value}
                                  onChange={(event) => {
                                    if (entry.location) {
                                      handleRandomInspectionLocationCountChange(rowId, entry.location?.key, event.target.value)
                                      return
                                    }
                                    handleRandomInspectionDraftFieldChange(
                                      rowId,
                                      'cantidad_reportada',
                                      normalizeQuantityInputString(event.target.value)
                                    )
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key !== 'Enter') return
                                    event.preventDefault()
                                    const inputs = Array.from(
                                      event.currentTarget
                                        .closest('.quick-actions__inspection-row-table')
                                        ?.querySelectorAll('input[data-count-input]') || []
                                    )
                                    const position = inputs.indexOf(event.currentTarget)
                                    if (position >= 0 && position < inputs.length - 1) {
                                      inputs[position + 1].focus()
                                      inputs[position + 1].select?.()
                                      return
                                    }
                                    handleAdvanceRandomInspectionStep()
                                  }}
                                  maxLength={4}
                                  placeholder="-"
                                  disabled={randomInspectionSubmitting}
                                  autoFocus={entryIndex === 0}
                                  aria-label={`Cantidad contada de ${row?.producto_codigo || 'producto'}`}
                                />
                              </span>
                              <span>
                                {row?.no_encontrado ? (
                                  <span className="quick-actions__inspection-notfound-tag">No encontrado</span>
                                ) : (
                                  <button
                                    type="button"
                                    className="quick-actions__inspection-row-notfound"
                                    onClick={() => handleRandomInspectionNotFound(row, { advance: false })}
                                    disabled={randomInspectionSubmitting}
                                  >
                                    No lo encontré
                                  </button>
                                )}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {!!randomInspectionRows.length && !isRandomInspectionSummaryVisible && !activeRandomInspectionGroup && activeRandomInspectionRow && (
                    <div className="quick-actions__inspection-quiz">
                      <div className="quick-actions__inspection-progress" aria-hidden="true">
                        <div className="quick-actions__inspection-progress-bar">
                          <span
                            style={{
                              width: `${((activeRandomInspectionStepIndex + 1) / Math.max(randomInspectionRows.length, 1)) * 100}%`,
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
                                ? 'Cuenta cada ubicación por separado.'
                                : 'Cuenta primero y responde solo con la cantidad encontrada.'}
                            </p>
                          </article>
                        ))}
                      </div>

                      <div className="quick-actions__inspection-notfound">
                        {activeRandomInspectionRow?.no_encontrado ? (
                          <p className="quick-actions__inspection-notfound-state">
                            Marcado como <strong>no encontrado</strong>. Si lo encuentras, escribe la cantidad.
                          </p>
                        ) : (
                          <button
                            type="button"
                            className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost quick-actions__inspection-notfound-btn"
                            onClick={() => handleRandomInspectionNotFound()}
                            disabled={randomInspectionSubmitting}
                            title="Administración verá que no lo encontraste y podrá indicar su nueva ubicación"
                          >
                            No lo encontré
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {!!randomInspectionRows.length && isRandomInspectionSummaryVisible && (
                    <div className="quick-actions__inspection-summary">
                      <div className="quick-actions__inspection-summary-head">
                        <div>
                          <p className="quick-actions__inspection-stage-kicker">Resumen del conteo</p>
                          <h5>Conteo completado</h5>
                          <p className="quick-actions__inspection-stage-help">
                            Revisa lo que contaste antes de guardar. Administración se encarga de comparar el resultado con el inventario.
                          </p>
                        </div>
                        <div className="quick-actions__inspection-summary-stats">
                          <span>
                            Productos contados
                            <strong>{randomInspectionAnsweredCount}</strong>
                          </span>
                        </div>
                      </div>

                      {/* Solo producto y lo contado: al revisor no se le muestra
                          nada mas (ni sucursal, ni esperado, ni diferencias). */}
                      <div className="create-user__locations-table quick-actions__inspection-count-table">
                        <div className="create-user__locations-row create-user__locations-row--head">
                          <span>Producto</span>
                          <span>Contado</span>
                        </div>
                        {randomInspectionRows.map((row) => {
                          const rowId = normalizeId(row?.row_id || row?.id)
                          const locations = (Array.isArray(row?.ubicaciones_bodega) ? row.ubicaciones_bodega : [])
                            .map((location) => ({
                              label: [location?.bodega_nombre, location?.division_nombre, location?.subdivision_nombre]
                                .map((part) => String(part || '').trim())
                                .filter(Boolean)
                                .join(' / '),
                              // Solo lo que conto el revisor en esa ubicacion (nunca lo del sistema).
                              counted: row?.requiere_conteo_por_ubicacion ? location?.cantidad_contada : null,
                            }))
                            .filter((location) => location.label)
                          return (
                            <div key={`inspection-summary-${rowId}`} className="create-user__locations-row">
                              <span className="quick-actions__inspection-count-table-product">
                                <span className="quick-actions__inspection-count-table-name">
                                  {row?.producto_codigo && <strong>{row.producto_codigo}</strong>}
                                  {row?.producto_codigo && ' - '}
                                  {row?.producto_nombre || `Producto ${rowId}`}
                                </span>
                                {locations.length > 0 && (
                                  <span className="quick-actions__inspection-count-table-locations">
                                    {locations.map((location, index) => (
                                      <span key={`inspection-summary-location-${rowId}-${index}`}>
                                        {location.label}
                                        {location.counted != null && (
                                          <>
                                            {' - '}
                                            <strong>{location.counted}</strong>
                                          </>
                                        )}
                                      </span>
                                    ))}
                                  </span>
                                )}
                              </span>
                              <span className="quick-actions__inspection-count-table-qty">
                                {row?.no_encontrado
                                  ? <span className="quick-actions__inspection-notfound-tag">No encontrado</span>
                                  : row?.cantidad_reportada == null ? '-' : toPositiveInt(row.cantidad_reportada, 0)}
                              </span>
                            </div>
                          )
                        })}
                      </div>

                      <label className="quick-actions__receive-general-issue">
                        <Checkbox
                          binary
                          inputId="random-inspection-general-issue"
                          checked={randomInspectionHasGeneralIssue}
                          onChange={(event) => {
                            const checked = event.checked
                            setRandomInspectionHasGeneralIssue(checked)
                            if (!checked) setRandomInspectionGeneralNote('')
                          }}
                          disabled={randomInspectionSubmitting}
                        />
                        <span>¿Algo no salió como lo esperado?</span>
                      </label>
                      {randomInspectionHasGeneralIssue && (
                        <label className="quick-actions__inspection-note quick-actions__receive-general-issue-note">
                          <span>Cuéntanos qué pasó (obligatorio)</span>
                          <textarea
                            rows={3}
                            value={randomInspectionGeneralNote}
                            onChange={(event) => setRandomInspectionGeneralNote(event.target.value)}
                            disabled={randomInspectionSubmitting}
                          />
                        </label>
                      )}
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
              {!isRandomInspectionVerifyMode &&
                !isRandomInspectionSummaryVisible &&
                randomInspectionStepCount > 1 && (
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
                  if (isRandomInspectionSummaryVisible) {
                    void handleSubmitRandomInspection()
                    return
                  }
                  handleAdvanceRandomInspectionStep()
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
                        (isRandomInspectionSummaryVisible && !randomInspectionAllAnswersReady) ||
                        (!isRandomInspectionSummaryVisible && !activeRandomInspectionRow)
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
                        activeRandomInspectionStepIndex >= randomInspectionStepCount - 1
                          ? 'Ver resumen'
                          : isRandomInspectionTableMode ? 'Siguiente fila' : 'Siguiente producto'
                      )
                    : 'Guardar inspecci\u00f3n'}
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
              <div className="quick-actions__receive-head-columns">
                <div className="quick-actions__receive-head-col">
                  <h4>
                    {`Traslado: ${
                      receiveShipmentTransferCode ? `#${receiveShipmentTransferCode.replace(/^#/, '')}` : 'sin codigo'
                    }`}
                  </h4>
                  {!!String(activeInTransitShipment?.nota_envio || '').trim() && (
                    <p className="quick-actions__receive-head-note">
                      <strong>Nota:</strong> {String(activeInTransitShipment.nota_envio).trim()}
                    </p>
                  )}
                </div>
                {!!receiveShipmentFacturaReferencia && (
                  <div className="quick-actions__receive-head-col">
                    <h4>{receiveShipmentFacturaReferencia}</h4>
                  </div>
                )}
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
                              handleReceiveAllCheck(event.target.checked)
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
                          <strong>
                            {receiveShipmentFilter.trim()
                              ? `${filteredReceiveShipmentRows.length}/${receiveShipmentRows.length}`
                              : receiveShipmentRows.length}
                          </strong>
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

                  <div
                    className="quick-actions__receive-progressbar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={receiveShipmentProgressSummary.total}
                    aria-valuenow={receiveShipmentProgressSummary.received}
                  >
                    <div className="quick-actions__receive-progressbar-head">
                      <strong>
                        {`Recibidos ${receiveShipmentProgressSummary.received} de ${receiveShipmentProgressSummary.total} productos`}
                      </strong>
                      <span>
                        {`${receiveShipmentProgressSummary.unitsReceived} de ${receiveShipmentProgressSummary.unitsSent} unidades · ${receiveShipmentProgressSummary.percent}%`}
                        {receiveShipmentProgressSummary.toStore > 0 ? ` · ${receiveShipmentProgressSummary.toStore} por guardar` : ''}
                      </span>
                    </div>
                    <div className="quick-actions__receive-progressbar-track">
                      <div
                        className="quick-actions__receive-progressbar-fill"
                        style={{ width: `${receiveShipmentProgressSummary.percent}%` }}
                      />
                    </div>
                  </div>

                  <div className="quick-actions__receive-search-bar">
                    <div className="quick-actions__receive-search">
                      <input
                        type="text"
                        placeholder="Buscar por código o descripción..."
                        value={receiveShipmentFilter}
                        onChange={(event) => setReceiveShipmentFilter(event.target.value)}
                      />
                      {receiveShipmentFilter && (
                        <button
                          type="button"
                          className="quick-actions__receive-search-clear"
                          onClick={() => setReceiveShipmentFilter('')}
                          aria-label="Limpiar búsqueda"
                        >
                          ×
                        </button>
                      )}
                    </div>
                    {receiveShipmentFilter.trim() && (
                      <span className="quick-actions__receive-search-count">
                        {filteredReceiveShipmentRows.length} de {receiveShipmentRows.length}
                      </span>
                    )}
                    <div className="quick-actions__receive-sort" ref={receiveSortDropdownRef}>
                      <button
                        type="button"
                        className={`quick-actions__receive-sort-trigger${receiveShipmentSort !== 'default' ? ' quick-actions__receive-sort-trigger--active' : ''}`}
                        onClick={() => setReceiveShipmentSortOpen((prev) => !prev)}
                        aria-haspopup="listbox"
                        aria-expanded={receiveShipmentSortOpen}
                      >
                        <ArrowUpDown size={14} />
                        <span>
                          {receiveShipmentSort === 'bodega_first' && 'Con bodega primero'}
                          {receiveShipmentSort === 'codigo' && 'Código A–Z'}
                          {receiveShipmentSort === 'nombre' && 'Descripción A–Z'}
                          {receiveShipmentSort === 'default' && 'Ordenar'}
                        </span>
                        <ChevronDown size={12} />
                      </button>
                      {receiveShipmentSortOpen && (
                        <div className="quick-actions__receive-sort-panel" role="listbox">
                          {[
                            { value: 'default', label: 'Orden original' },
                            { value: 'bodega_first', label: 'Con bodega primero' },
                            { value: 'codigo', label: 'Código A–Z' },
                            { value: 'nombre', label: 'Descripción A–Z' },
                          ].map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              role="option"
                              aria-selected={receiveShipmentSort === option.value}
                              className={`quick-actions__receive-sort-option${receiveShipmentSort === option.value ? ' quick-actions__receive-sort-option--selected' : ''}`}
                              onClick={() => {
                                setReceiveShipmentSort(option.value)
                                setReceiveShipmentSortOpen(false)
                              }}
                            >
                              {option.label}
                              {receiveShipmentSort === option.value && <Check size={13} />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

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
                    {filteredReceiveShipmentRows.length === 0 && receiveShipmentFilter.trim() && (
                      <div className="quick-actions__receive-empty-filter">
                        <span>Sin resultados para "<strong>{receiveShipmentFilter.trim()}</strong>"</span>
                      </div>
                    )}
                    {filteredReceiveShipmentRows.map((row, index) => {
                      const rowProductId = normalizeId(row?.producto_id)
                      const missingQty = toPositiveInt(row?.cantidad_faltante, 0)
                      const sentQty = toPositiveInt(row?.cantidad_enviada, 0)
                      const receivedQty = toPositiveInt(row?.cantidad_recibida, 0)
                      const isReviewed = Boolean(row?.recepcion_revisada)
                      const rowSummaryValidationMessage = receiveShipmentShowErrors
                        ? getReceiveShipmentRowValidationMessage(row, { requireReviewed: true })
                        : ''
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
                      const isRegistered = Boolean(row?.recepcion_registrada)
                      const pendingToStore = toPositiveInt(row?.pendiente_guardar, 0)
                      const statusLabel = isRegistered
                        ? (pendingToStore > 0 ? 'Por guardar' : 'Recibido')
                        : !isReviewed
                          ? 'Por revisar'
                          : 'Listo para recibir'
                      const hintMessage = rowSummaryValidationMessage
                        || (isRegistered
                          ? (pendingToStore > 0
                            ? `Ya esta en stock (en POR UBICAR). Elige su ubicacion y guardalo.`
                            : '')
                          : !isReviewed
                            ? 'Marca esta linea cuando termines de revisar el producto.'
                            : selectedSubdivisionId
                              ? ''
                              : 'Sin ubicacion: al recibirlo queda en POR UBICAR y ya se puede vender.')

                      return (
                        <article
                          key={`receive-item-${rowProductId}`}
                          className={`quick-actions__receive-item${isReviewed ? ' is-reviewed' : ''}${!isReviewed || (isRegistered && pendingToStore > 0) ? ' is-pending' : ' is-ready'}${isRegistered ? ' is-registered' : ''}${rowSummaryValidationMessage ? ' has-validation-error' : ''}`}
                        >
                          <div className="quick-actions__receive-item-head quick-actions__receive-item-head--check">
                            <label className="quick-actions__receive-check quick-actions__receive-check--row">
                              <Checkbox
                                binary
                                inputId={`receive-reviewed-${rowProductId}`}
                                checked={isReviewed}
                                onChange={(event) =>
                                  handleReceiveRowCheck(rowProductId, event.checked)
                                }
                                disabled={receiveShipmentSubmitting || isRegistered || receivingProductIds.has(rowProductId)}
                                aria-label={`Marcar ${getReceiveShipmentRowLabel(row)} como revisado`}
                              />
                            </label>

                            <div
                              className="quick-actions__receive-item-title"
                              title={[row?.producto_codigo, String(row?.producto_nombre || '').trim()].filter(Boolean).join(' – ')}
                            >
                              <small className="quick-actions__receive-col-label">Producto</small>
                              <strong>{row?.producto_codigo || `Producto ${rowProductId}`}</strong>
                              {!!String(row?.producto_nombre || '').trim() && (
                                <p className="quick-actions__receive-item-name">
                                  {String(row.producto_nombre).trim()}
                                </p>
                              )}
                            </div>

                            <div className={`quick-actions__receive-item-badge${isRegistered ? (pendingToStore > 0 ? ' is-to-store' : ' is-received') : !isReviewed ? ' is-pending' : ' is-ready'}`}>
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
                            {pendingToStore > 0 && (
                              <span className="quick-actions__receive-item-meta-store">
                                Por guardar
                                <strong>{pendingToStore}</strong>
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
                              <small className="quick-actions__receive-col-label">Recibida</small>
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
                                disabled={receiveShipmentSubmitting || isRegistered}
                                title={isRegistered ? 'Ya recibido: esta cantidad ya entro al stock.' : undefined}
                                autoFocus={index === 0}
                              />
                            </label>

                            <div className="quick-actions__receive-destination">
                              <small>Sucursal destino</small>
                              <strong>{receiveShipmentDestinationBranchName}</strong>
                            </div>
                          </div>

                          {(!isRegistered || pendingToStore > 0) && (
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
                          )}

                          {/* Estado de la recepcion por partes (visible tambien en la lista). */}
                          {(isRegistered || (isReviewed && !selectedSubdivisionId)) && (
                            <div
                              className={`quick-actions__receive-item-state${
                                isRegistered ? (pendingToStore > 0 ? ' is-to-store' : ' is-received') : ' is-no-location'
                              }`}
                            >
                              {isRegistered ? (
                                pendingToStore > 0 ? (
                                  <>
                                    <span>
                                      <strong>{`Recibido · ${pendingToStore} en POR UBICAR`}</strong>
                                      {' — ya se puede vender. Elige su ubicacion y guardalo.'}
                                    </span>
                                    <button
                                      type="button"
                                      className="quick-actions__receive-btn quick-actions__receive-btn--primary quick-actions__receive-store-btn"
                                      onClick={() => void handleStoreReceivedRows([row])}
                                      disabled={receiveShipmentSubmitting || !selectedSubdivisionId}
                                      title={selectedSubdivisionId ? 'Mover desde POR UBICAR a esta ubicacion' : 'Elige primero la ubicacion'}
                                    >
                                      Guardar
                                    </button>
                                  </>
                                ) : (
                                  <span><strong>{`Recibido · ${row?.ya_recibido} en stock`}</strong>{' — guardado en su ubicacion.'}</span>
                                )
                              ) : (
                                <span>Sin ubicacion: al recibirlo queda en <strong>POR UBICAR</strong> y ya se puede vender.</span>
                              )}
                            </div>
                          )}

                          {missingQty > 0 && !isRegistered && (
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
                const surplusQty = toPositiveInt(row?.cantidad_sobrante, 0)
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
                      {surplusQty > 0 && (
                        <label className="quick-actions__receive-note">
                          <span>Sobrante: {surplusQty} unidad{surplusQty !== 1 ? 'es' : ''} de más — se creará un inconveniente para resolverlo.</span>
                          <textarea
                            rows={2}
                            placeholder="Novedad del sobrante (opcional)"
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

              {!inTransitSubdivisionsLoading && (
                <div className="quick-actions__receive-general-issue-block">
                  <label className="quick-actions__receive-general-issue">
                    <Checkbox
                      binary
                      inputId="receive-shipment-general-issue"
                      checked={receiveShipmentHasGeneralIssue}
                      onChange={(event) => {
                        const checked = event.checked
                        setReceiveShipmentHasGeneralIssue(checked)
                        if (!checked) setReceiveShipmentGeneralNote('')
                      }}
                      disabled={receiveShipmentSubmitting}
                    />
                    <span>¿Algo no salió como lo esperado?</span>
                  </label>
                  {receiveShipmentHasGeneralIssue && (
                    <label className="quick-actions__receive-note quick-actions__receive-general-issue-note">
                      <span>Cuéntanos qué pasó (obligatorio)</span>
                      <textarea
                        rows={3}
                        value={receiveShipmentGeneralNote}
                        onChange={(event) => setReceiveShipmentGeneralNote(event.target.value)}
                        disabled={receiveShipmentSubmitting}
                      />
                    </label>
                  )}
                </div>
              )}

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
                  {receiveShipmentStorableRows.length > 0 && (
                    <button
                      type="button"
                      className="quick-actions__receive-btn quick-actions__receive-btn--ghost"
                      onClick={() => void handleStoreReceivedRows(receiveShipmentStorableRows)}
                      disabled={receiveShipmentSubmitting}
                      title="Mover a su ubicacion los productos recibidos que estan en POR UBICAR"
                    >
                      {`Guardar ubicaciones (${receiveShipmentStorableRows.length})`}
                    </button>
                  )}
                  {receiveShipmentReceivableRows.length > 0 && (
                    <button
                      type="button"
                      className="quick-actions__receive-btn quick-actions__receive-btn--success"
                      onClick={() => void handleReceiveMarkedRows()}
                      disabled={receiveShipmentSubmitting}
                      title="Estos productos tienen check pero no se pudieron recibir; vuelve a intentarlo"
                    >
                      {receiveShipmentSubmitting ? 'Recibiendo...' : `Reintentar recibir (${receiveShipmentReceivableRows.length})`}
                    </button>
                  )}
                  <button
                    type="button"
                    className="quick-actions__receive-btn quick-actions__receive-btn--primary"
                    onClick={() => {
                      const invalidRows = receiveShipmentRows.filter((row) =>
                        getReceiveShipmentRowValidationMessage(row, { requireReviewed: true })
                      )
                      if (invalidRows.length > 0) {
                        setReceiveShipmentShowErrors(true)
                        setReceiveShipmentError(
                          invalidRows.length === 1
                            ? '1 producto requiere atención antes de continuar.'
                            : `${invalidRows.length} productos requieren atención antes de continuar.`
                        )
                        return
                      }
                      setReceiveShipmentShowErrors(false)
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
