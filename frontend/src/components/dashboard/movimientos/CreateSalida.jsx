import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import '../admin/CreateUsuario/CreateUsuario.css'
import './CreateSalida.css'
import '../clientes/CreateCliente/CreateCliente.css'
import { Loader2 } from 'lucide-react'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDate } from '../../../utils/dateFormat'
import { isBulkProductPasteText, parseBulkProductPasteText, formatInvalidBulkPasteLines } from '../../../utils/bulkProductPaste'
import { getAppPortalRoot } from '../../../utils/portalRoot'
import { useCloseDropdownsOnTabSwitch } from '../../../hooks/useCloseDropdownsOnTabSwitch'
import useModalAnimation from '../common/useModalAnimation'
import useTableCellHover from '../common/useTableCellHover.jsx'
import SubTipoButtonSelector from './SubTipoButtonSelector'
import BlockerNotice from '../common/BlockerNotice'
import StaticFieldDisplay from './StaticFieldDisplay'
import {
  buildTransferHistoryEntry,
  createReminderId,
  emitRemindersSync,
  extractUserId,
  fetchRemindersFromBackend,
  formatCurrentUserName,
  getTransferReminderHistory,
  normalizeId as normalizeReminderId,
  readRemindersFromStorage,
  sanitizeRecipient,
  upsertTransferReminder,
  writeRemindersToStorage,
} from '../common/reminders/remindersStorage'
import { TIPO_ENVIO_OPTIONS } from './tipoEnvio'
import useUnsavedChangesGuard, { useUnsavedChangesRegistration } from '../common/unsavedChanges/useUnsavedChangesGuard'

const DEFAULT_IVA_RATE = 0.15
const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const SELECTOR_WIDTH = 520
const SELECTOR_HEIGHT = 360
const SELECTOR_MIN_WIDTH = 420
const SELECTOR_MIN_HEIGHT = 340
const VIEWPORT_PADDING = 12

const initialForm = {
  sucursalId: '',
  subTipoId: '',
  estadoId: '',
  fecha: '',
  no_documento: '',
  factura_referencia: '',
  descripcion: '',
  funcional: true,
  sucursalObjetivoId: '',
  cliente: '',
  descuento: '',
  iva_rate: String(DEFAULT_IVA_RATE),
  solicitudTrasladoId: '',
  tipo_pago: '',
  tipo_envio: '',
}

const TIPO_PAGO_OPTIONS = [
  'EFECTIVO',
  'TARJETA',
  'TRANSFERENCIA',
  'DEPÓSITO',
  'CRÉDITO',
  'CHEQUE',
  'MIXTO',
]

const initialDetail = {
  productoId: '',
  cantidad: '',
  valor: '',
}

const initialClienteForm = {
  nombres: '',
  apellidos: '',
  cedula_ruc: '',
  correo: '',
  telefono: '',
  direccion: '',
}

const emptyAuto = { vin: '', modelo: '', motor: '', anio: '' }

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeReminderContextType = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
const normalizeModuleScopes = (rawScopes) => {
  const scopes = {}
  ;(Array.isArray(rawScopes) ? rawScopes : []).forEach((item) => {
    const moduleKey = normalizeValue(item?.modulo)
    if (!moduleKey) return
    const ids = (Array.isArray(item?.sucursales_ids) ? item.sucursales_ids : [])
      .map((branchId) => normalizeReminderId(branchId))
      .filter(Boolean)
    if (!ids.length) return
    scopes[moduleKey] = ids
  })
  return scopes
}
const hasModuleBranchAccess = (userItem, moduleKey, branchId) => {
  const normalizedModule = normalizeValue(moduleKey)
  const normalizedBranchId = normalizeReminderId(branchId)
  if (!normalizedModule || !normalizedBranchId) return false
  const ids = userItem?.moduleScopes?.[normalizedModule]
  return Array.isArray(ids) && ids.includes(normalizedBranchId)
}
const normalizeModuleScopeActions = (rawScopes) => {
  const scopes = {}
  ;(Array.isArray(rawScopes) ? rawScopes : []).forEach((item) => {
    const moduleKey = normalizeValue(item?.modulo)
    if (!moduleKey) return
    const branchActions = {}
    ;(Array.isArray(item?.acciones_por_sucursal) ? item.acciones_por_sucursal : []).forEach((entry) => {
      const branchId = normalizeReminderId(entry?.sucursal_id)
      if (!branchId) return
      branchActions[branchId] = {
        puede_crear: Boolean(entry?.puede_crear),
        puede_actualizar: Boolean(entry?.puede_actualizar),
        puede_crear_venta: Boolean(entry?.puede_crear_venta),
        puede_crear_traslado: Boolean(entry?.puede_crear_traslado),
        puede_crear_devolucion: Boolean(entry?.puede_crear_devolucion),
      }
    })
    if (Object.keys(branchActions).length) scopes[moduleKey] = branchActions
  })
  return scopes
}
const hasModuleBranchCreateAndUpdateAccess = (userItem, moduleKey, branchId) => {
  if (!hasModuleBranchAccess(userItem, moduleKey, branchId)) return false
  const normalizedModule = normalizeValue(moduleKey)
  const normalizedBranchId = normalizeReminderId(branchId)
  const moduleActions = userItem?.moduleScopeActions?.[normalizedModule]
  const branchActions = moduleActions?.[normalizedBranchId]
  if (!branchActions) return false
  return Boolean(branchActions?.puede_crear && branchActions?.puede_actualizar)
}
const normalizeValue = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
const formatSalidaSubTipoLabel = (subTipo) => {
  const nombre = typeof subTipo === 'string' ? subTipo : String(subTipo?.nombre || '').trim()
  return normalizeValue(nombre) === 'devolucion' ? 'Garantía' : nombre
}
const matchesNormalizedStem = (value, stem) =>
  normalizeValue(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .some((token) => token.startsWith(stem))
const findEstadoByPreference = (options, preferred = []) => {
  const list = Array.isArray(options) ? options : []
  if (!list.length) return null

  for (const key of preferred) {
    const exact = list.find((estado) => normalizeValue(estado?.nombre) === key)
    if (exact?.id) return exact
  }

  const stemByKey = {
    enviado: 'envi',
    recibido: 'recib',
    'parcialmente recibido': 'parcial',
    proformado: 'proform',
    facturado: 'factur',
    vendido: 'vend',
    'en camino': 'camin',
  }
  for (const key of preferred) {
    const stem = stemByKey[key]
    if (!stem) continue
    const partial = list.find((estado) => matchesNormalizedStem(estado?.nombre, stem))
    if (partial?.id) return partial
  }

  return list.find((estado) => estado?.id != null) || null
}

const parseNumber = (value) => {
  const cleaned = String(value ?? '').replace(',', '.').trim()
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

const parseIntValue = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.floor(parsed))
}

const parseApiErrorValue = (value) => {
  if (!value) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = parseApiErrorValue(entry)
      if (parsed) return parsed
    }
    return ''
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value)) {
      const parsed = parseApiErrorValue(entry)
      if (parsed) return parsed
    }
  }
  return ''
}

const resolveApiErrorMessage = (payload, fallback) => {
  const detail = parseApiErrorValue(payload?.detail)
  if (detail) return detail
  const fallbackFromBody = parseApiErrorValue(payload)
  if (fallbackFromBody) return fallbackFromBody
  return fallback
}

const todayISO = () => {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const nowReminderDateTime = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')

  return {
    date: `${year}-${month}-${day}`,
    time: `${hours}:${minutes}`,
    iso: now.toISOString(),
  }
}

const formatCurrency = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '$0.00'
  return `$${parsed.toFixed(2)}`
}

const calculateLineTotal = (cantidad, precio) => {
  const qty = parseIntValue(cantidad)
  const value = parseNumber(precio)
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(value) || value < 0) return null
  return qty * value
}

const formatDescuentoPrecise = (value) => {
  let str = value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
  if (str.includes('.')) {
    const [intPart, decPart] = str.split('.')
    return `${intPart}.${decPart.padEnd(2, '0')}`
  }
  return `${str}.00`
}

const formatTwoDecimals = (value) => {
  const parsed = parseNumber(value)
  if (!Number.isFinite(parsed) || parsed < 0) return '0.00'
  return parsed.toFixed(2)
}

const sanitizeDecimalRawInput = (rawValue) => {
  const normalized = String(rawValue ?? '').replace(',', '.')
  const cleaned = normalized.replace(/[^\d.]/g, '')
  const firstDotIndex = cleaned.indexOf('.')
  if (firstDotIndex === -1) return cleaned
  return (
    cleaned.slice(0, firstDotIndex + 1) +
    cleaned.slice(firstDotIndex + 1).replace(/\./g, '')
  )
}

const resolveProductPrice = (producto) => {
  const parsed = parseNumber(producto?.precio)
  if (parsed === null || parsed < 0) return ''
  const raw = String(producto?.precio ?? '').trim()
  return raw || parsed.toFixed(2)
}

const buildDetailRowFromProduct = (producto, cantidad, { estadoProductoId, estadoProductoNombre }) => {
  const valorRaw = parseNumber(resolveProductPrice(producto))
  const valor = Number.isFinite(valorRaw) ? valorRaw : 0
  const valor_total = cantidad * valor
  return {
    uid: `det-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    productoId: String(producto.id),
    productoCodigo: producto?.codigo ?? '',
    productoNombre: producto?.nombre ?? '',
    estadoProductoId,
    estadoProductoNombre,
    cantidad,
    valor,
    valor_total,
  }
}

const resolveClienteNombre = (cliente) => {
  const nombreCompleto = String(
    cliente?.nombre_completo || `${cliente?.nombres || ''} ${cliente?.apellidos || ''}`
  ).trim()
  return nombreCompleto
}

const formatClienteDropdownLabel = (cliente) => {
  if (!cliente) return ''
  const cedula = String(cliente?.cedula_ruc || '').trim()
  const nombre = resolveClienteNombre(cliente)
  if (cedula && nombre) return `${cedula}: ${nombre}`
  if (cedula) return cedula
  if (nombre) return nombre
  return ''
}

const formatClienteFieldValue = (cliente) => {
  if (!cliente) return ''
  const nombre = resolveClienteNombre(cliente)
  if (nombre) return nombre
  return String(cliente?.cedula_ruc || '').trim()
}

const normalizeClientePayload = (cliente) => ({
  nombres: String(cliente?.nombres || '').trim(),
  apellidos: String(cliente?.apellidos || '').trim(),
  cedula_ruc: String(cliente?.cedula_ruc || '').trim(),
  correo: String(cliente?.correo || '').trim(),
  telefono: String(cliente?.telefono || '').trim(),
  direccion: String(cliente?.direccion || '').trim(),
})

const clienteRequiredFields = ['nombres', 'cedula_ruc']
const CLIENT_MODE_EXISTING = 'existing'
const CLIENT_MODE_NEW = 'new'
const CLIENT_MODE_CONSUMIDOR_FINAL = 'consumidor_final'
const CONSUMIDOR_FINAL_CEDULA = '000000000'
const DOCUMENT_STATUS = {
  idle: 'idle',
  invalid: 'invalid',
  checking: 'checking',
  available: 'available',
  duplicate: 'duplicate',
  error: 'error',
}

function CreateSalida({
  open,
  onClose,
  onCreated,
  onTransferCancelled,
  currentUser = null,
  token,
  onError,
  onSuccess,
  preloadedTipoMovimientos = [],
  preloadedSubTipos = [],
  prefilledSucursalId = '',
  prefillTransferRequest = null,
  prefillGuardadoTraslado = null,
}) {
  const [formData, setFormData] = useState(initialForm)
  const [loading, setLoading] = useState(false)
  const [, setError] = useState('')
  const [totalRawInput, setTotalRawInput] = useState('')
  const [isEditingTotal, setIsEditingTotal] = useState(false)
  const [descuentoRawInput, setDescuentoRawInput] = useState('')
  const [isEditingDescuento, setIsEditingDescuento] = useState(false)

  const [branches, setBranches] = useState([])
  const [allBranches, setAllBranches] = useState([])
  const [catalogsLoading, setCatalogsLoading] = useState(false)
  const [catalogsLoaded, setCatalogsLoaded] = useState(false)
  const [tipoMovimientos, setTipoMovimientos] = useState(() => preloadedTipoMovimientos)
  const [subTipos, setSubTipos] = useState(() => preloadedSubTipos)
  const [estados, setEstados] = useState([])
  const [productos, setProductos] = useState([])
  const [estadosProducto, setEstadosProducto] = useState([])

  const [details, setDetails] = useState([])
  const [detailDraft, setDetailDraft] = useState(initialDetail)
  const [detailError, setDetailError] = useState('')
  const [duplicateProductConfirm, setDuplicateProductConfirm] = useState(null)
  const { showHover, hideHover, portal: cellHoverPortal } = useTableCellHover()
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [productDropdownMaxHeight, setProductDropdownMaxHeight] = useState(null)
  const [productDropdownStyle, setProductDropdownStyle] = useState({})
  const [productQuery, setProductQuery] = useState('')
  const [productOptions, setProductOptions] = useState([])
  const [productLoading, setProductLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [clienteMode, setClienteMode] = useState(CLIENT_MODE_EXISTING)
  const [selectedCliente, setSelectedCliente] = useState(null)
  const [clienteForm, setClienteForm] = useState(initialClienteForm)
  const [clienteAutos, setClienteAutos] = useState([])
  const [clienteAutoDraft, setClienteAutoDraft] = useState({ ...emptyAuto })
  const [selectedClienteAutos, setSelectedClienteAutos] = useState([])
  const [autoConfirmData, setAutoConfirmData] = useState(null)
  const [savingAuto, setSavingAuto] = useState(false)
  const [showCedulaPrompt, setShowCedulaPrompt] = useState(false)
  const [cedulaPromptValue, setCedulaPromptValue] = useState('')
  const [savingCedulaPrompt, setSavingCedulaPrompt] = useState(false)
  const [pendingClienteAutoDraft, setPendingClienteAutoDraft] = useState({ placa: '', modelo: '', anio: '', marca: '' })
  const [fetchingClienteAutos, setFetchingClienteAutos] = useState(false)
  const [showClienteDropdown, setShowClienteDropdown] = useState(false)
  const [clienteDropdownStyle, setClienteDropdownStyle] = useState({})
  const [showTipoPagoDropdown, setShowTipoPagoDropdown] = useState(false)
  const [tipoPagoDropdownStyle, setTipoPagoDropdownStyle] = useState({})
  const [formSubmitted, setFormSubmitted] = useState(false)
  const [clienteQuery, setClienteQuery] = useState('')
  const [clienteOptions, setClienteOptions] = useState([])
  const [clienteLoading, setClienteLoading] = useState(false)
  const [stockByProduct, setStockByProduct] = useState({})
  const [stockLoadError, setStockLoadError] = useState(false)
  const [consumidorFinalMissing, setConsumidorFinalMissing] = useState(false)
  const [stockLoading, setStockLoading] = useState(false)
  const [solicitudesTraslado, setSolicitudesTraslado] = useState([])
  const [solicitudesTrasladoLoading, setSolicitudesTrasladoLoading] = useState(false)
  const [documentStatus, setDocumentStatus] = useState(DOCUMENT_STATUS.invalid)
  const [isTransferSendConfirmOpen, setIsTransferSendConfirmOpen] = useState(false)
  const [isTransferCancelModalOpen, setIsTransferCancelModalOpen] = useState(false)
  const [transferCancelReason, setTransferCancelReason] = useState('')
  const [transferCancelReasonError, setTransferCancelReasonError] = useState('')
  const [transferCancelSubmitting, setTransferCancelSubmitting] = useState(false)
  const [isTransferWithoutRequest, setIsTransferWithoutRequest] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [reminderUsers, setReminderUsers] = useState([])
  const [reminderUsersLoading, setReminderUsersLoading] = useState(false)
  const [reminderUsersError, setReminderUsersError] = useState('')
  const [selectedReminderUserIds, setSelectedReminderUserIds] = useState([])
  const [documentLoading, setDocumentLoading] = useState(false)
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })
  const [isMaximized, setIsMaximized] = useState(false)
  const [isResizingModal, setIsResizingModal] = useState(false)
  const modalRef = useRef(null)
  const productDropdownRef = useRef(null)
  const productDropdownTriggerRef = useRef(null)
  const productDropdownPanelRef = useRef(null)
  const clienteDropdownRef = useRef(null)
  const clienteDropdownTriggerRef = useRef(null)
  const clienteDropdownPanelRef = useRef(null)
  const tipoPagoDropdownRef = useRef(null)
  const tipoPagoTriggerRef = useRef(null)
  const tipoPagoPanelRef = useRef(null)
  const clienteSearchTimerRef = useRef(null)
  const documentCheckTimerRef = useRef(null)
  const documentCheckSequenceRef = useRef(0)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalResize = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const modalSizeRef = useRef(modalSize)
  const modalPositionRef = useRef(modalPosition)
  const modalRestoreRef = useRef(null)
  const appliedPrefillRequestKeyRef = useRef('')
  const appliedGuardadoPrefillIdRef = useRef('')
  const documentRequestSeqRef = useRef(0)
  const stockByProductRef = useRef({})
  const loadedStockBranchIdRef = useRef('')
  const pendingStockBranchIdRef = useRef('')
  const pendingStockPromiseRef = useRef(null)
  const selectedStockBranchIdRef = useRef('')

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
  const getViewportMetrics = useCallback((compactMode = false) => {
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    const targetMinWidth = compactMode ? SELECTOR_MIN_WIDTH : MIN_WIDTH
    const targetMinHeight = compactMode ? SELECTOR_MIN_HEIGHT : MIN_HEIGHT
    return {
      availableWidth,
      availableHeight,
      minWidth: Math.min(targetMinWidth, availableWidth),
      minHeight: Math.min(targetMinHeight, availableHeight),
    }
  }, [])

  const notifyError = useCallback(
    (message) => {
      if (!message) return
      if (onError) {
        onError(message)
        return
      }
      setError(message)
    },
    [onError]
  )

  const notifySuccess = useCallback(
    (message) => {
      if (!message) return
      if (onSuccess) {
        onSuccess(message)
        return
      }
      setError(message)
    },
    [onSuccess]
  )

  useEffect(() => {
    if (!detailError) return
    notifyError(detailError)
  }, [detailError, notifyError])

  useEffect(() => {
    if (!reminderUsersError) return
    notifyError(reminderUsersError)
  }, [notifyError, reminderUsersError])

  useEffect(() => {
    stockByProductRef.current = stockByProduct
  }, [stockByProduct])

  useEffect(() => {
    selectedStockBranchIdRef.current = String(formData.sucursalId || '').trim()
  }, [formData.sucursalId])

  const salidaTipoId = useMemo(() => {
    const salida = tipoMovimientos.find((tipo) => normalizeValue(tipo?.nombre).startsWith('sal'))
    return salida?.id ?? ''
  }, [tipoMovimientos])

  const subTiposSalida = useMemo(
    () =>
      subTipos.filter(
        (sub) => String(sub?.tipo_movimiento?.id || '') === String(salidaTipoId)
      ),
    [subTipos, salidaTipoId]
  )

  const isCurrentUserAdmin = useMemo(() => Boolean(currentUser?.es_administrador), [currentUser])

  const currentUserSalidasSubtypeActions = useMemo(() => {
    if (isCurrentUserAdmin) return null
    const branchId = normalizeReminderId(prefilledSucursalId || formData.sucursalId)
    if (!branchId) return null
    const actions = normalizeModuleScopeActions(currentUser?.sucursales_por_modulo)
    return actions?.['movimientos_salidas']?.[branchId] ?? null
  }, [isCurrentUserAdmin, prefilledSucursalId, formData.sucursalId, currentUser])

  const selectedSubTipo = useMemo(
    () => subTiposSalida.find((sub) => String(sub.id) === String(formData.subTipoId)),
    [subTiposSalida, formData.subTipoId]
  )
  const salidaSubTipoOptions = useMemo(
    () =>
      subTiposSalida
        .map((subTipo, index) => {
          const normalizedName = normalizeValue(subTipo?.nombre)
          let label = formatSalidaSubTipoLabel(subTipo)
          let description = 'Selecciona este tipo de salida.'
          let order = 90 + index

          if (normalizedName.includes('vent')) {
            label = 'Cliente'
            description = 'Ventas hacia clientes.'
            order = 0
          } else if (normalizedName.includes('trasl')) {
            label = 'Sucursal'
            description = 'Enviar productos a otra sucursal.'
            order = 1
          } else if (normalizedName.includes('devol')) {
            label = 'Garantía'
            description = 'Regresar productos con garantía al proveedor.'
            order = 2
          }

          let blocked = false
          if (currentUserSalidasSubtypeActions) {
            if (normalizedName.includes('vent')) blocked = !currentUserSalidasSubtypeActions.puede_crear_venta
            else if (normalizedName.includes('trasl')) blocked = !currentUserSalidasSubtypeActions.puede_crear_traslado
            else if (normalizedName.includes('devol')) blocked = !currentUserSalidasSubtypeActions.puede_crear_devolucion
          }

          return {
            value: String(subTipo?.id || ''),
            label,
            description,
            icon: normalizedName.includes('vent')
              ? 'customer'
              : normalizedName.includes('trasl')
                ? 'branch'
                : normalizedName.includes('devol')
                  ? 'guarantee'
                  : 'branch',
            order,
            index,
            blocked,
          }
        })
        .sort((first, second) => first.order - second.order || first.index - second.index),
    [subTiposSalida, currentUserSalidasSubtypeActions]
  )
  const selectedSubTipoLabel = useMemo(
    () =>
      salidaSubTipoOptions.find((option) => option.value === String(formData.subTipoId))?.label ||
      formatSalidaSubTipoLabel(selectedSubTipo),
    [formData.subTipoId, salidaSubTipoOptions, selectedSubTipo]
  )

  const selectedSubTipoName = normalizeValue(selectedSubTipo?.nombre)
  const isDevolucion = selectedSubTipoName.includes('devol')
  const isTraslado = selectedSubTipoName.includes('trasl')
  const isVenta = selectedSubTipoName.includes('vent')
  const requiresStockValidation = isTraslado || isVenta || isDevolucion
  const useExistingCliente = clienteMode === CLIENT_MODE_EXISTING
  const useNewCliente = clienteMode === CLIENT_MODE_NEW
  const useConsumidorFinal = clienteMode === CLIENT_MODE_CONSUMIDOR_FINAL
  const selectedClienteLabel = useMemo(
    () => formatClienteDropdownLabel(selectedCliente) || formatClienteFieldValue(selectedCliente),
    [selectedCliente]
  )
  const isSelectorStep = !formData.subTipoId
  const requiresSucursalObjetivo = isTraslado
  const normalizedPrefilledSucursalId = String(prefilledSucursalId || '').trim()
  const selectedSucursalId = String(formData.sucursalId || '').trim()
  const hasSelectedSucursal = Boolean(selectedSucursalId)
  const isSucursalPrincipalLocked = Boolean(normalizedPrefilledSucursalId)
  const prefillTransferRequestKey = String(prefillTransferRequest?.requestKey || '').trim()
  const prefillTransferSolicitudId = String(prefillTransferRequest?.solicitudId || '').trim()
  const prefillTransferRequestSucursalId = String(prefillTransferRequest?.sucursalProveedoraId || '').trim()
  const isPrefilledTransfer = Boolean(prefillTransferRequestKey && prefillTransferSolicitudId)
  const effectivePrefilledSucursalId = normalizedPrefilledSucursalId || prefillTransferRequestSucursalId
  const selectedSucursalName = useMemo(() => {
    const branch = branches.find(
      (item) => String(item?.id || '').trim() === selectedSucursalId
    )
    return String(branch?.nombre || '').trim()
  }, [branches, selectedSucursalId])
  const destinationBranches = useMemo(() => {
    const source = allBranches.length > 0 ? allBranches : branches
    return source.filter((branch) => String(branch?.id || '').trim() !== selectedSucursalId)
  }, [allBranches, branches, selectedSucursalId])

  const selectedObjetivoBranchName = useMemo(() => {
    const objetivoId = String(formData.sucursalObjetivoId || '').trim()
    if (!objetivoId) return ''
    const source = allBranches.length > 0 ? allBranches : branches
    const branch = source.find((item) => String(item?.id || '').trim() === objetivoId)
    return String(branch?.nombre || '').trim()
  }, [allBranches, branches, formData.sucursalObjetivoId])
  const formattedFecha = useMemo(() => formatDate(formData.fecha, ''), [formData.fecha])

  const fetchNextDocumentNumber = useCallback(
    async ({ subTipoId, sucursalId, sucursalObjetivoId, clienteId, clienteIdentificacion }) => {
      if (!token || !salidaTipoId) {
        setDocumentStatus(DOCUMENT_STATUS.error)
        return false
      }
      if (!sucursalId || !subTipoId) return false

      const requestKey = Date.now()
      documentRequestSeqRef.current = requestKey
      setDocumentStatus(DOCUMENT_STATUS.checking)
      setDocumentLoading(true)

      try {
        const params = new URLSearchParams({
          tipo_movimiento_id: String(salidaTipoId),
          sub_tipo_movimiento_id: String(subTipoId || '').trim(),
          sucursal_id: String(sucursalId || '').trim(),
        })
        const objetivoId = String(sucursalObjetivoId || '').trim()
        if (objetivoId) {
          params.set('sucursal_objetivo_id', objetivoId)
        }
        const normalizedClienteId = String(clienteId || '').trim()
        if (normalizedClienteId) {
          params.set('cliente_id', normalizedClienteId)
        }
        const normalizedClienteIdentificacion = String(clienteIdentificacion || '').trim()
        if (normalizedClienteIdentificacion) {
          params.set('cliente_identificacion', normalizedClienteIdentificacion)
        }

        const endpoint = `${API_URL}/movimientos/movimiento_inventario/next-document-number/?${params.toString()}`
        const response = await authFetch(endpoint, {}, token)
        const data = await response.json().catch(() => ({}))
        if (documentRequestSeqRef.current !== requestKey) return false
        if (!response.ok) {
          setDocumentStatus(DOCUMENT_STATUS.error)
          return false
        }

        const nextDoc = String(data?.no_documento || '').trim()
        if (!nextDoc) {
          setDocumentStatus(DOCUMENT_STATUS.error)
          return false
        }

        setFormData((prev) => (
          prev.no_documento === nextDoc
            ? prev
            : { ...prev, no_documento: nextDoc }
        ))
        setDocumentStatus(DOCUMENT_STATUS.available)
        return true
      } catch {
        if (documentRequestSeqRef.current === requestKey) {
          setDocumentStatus(DOCUMENT_STATUS.error)
        }
        return false
      } finally {
        if (documentRequestSeqRef.current === requestKey) {
          setDocumentLoading(false)
        }
      }
    },
    [salidaTipoId, token]
  )

  useEffect(() => {
    // Al retomar un traslado directo guardado como borrador, el
    // no_documento ya existe (se genero cuando se guardo por primera vez)
    // -- no hay que regenerarlo, igual que con isPrefilledTransfer.
    const isResumingGuardadoDraft = isTraslado && isTransferWithoutRequest && Boolean(formData.solicitudTrasladoId)
    if (!open || isPrefilledTransfer || isResumingGuardadoDraft) return

    const subTipoId = String(formData.subTipoId || '').trim()
    const sucursalId = String(formData.sucursalId || '').trim()
    const sucursalObjetivoId = String(formData.sucursalObjetivoId || '').trim()
    const clienteId = String(selectedCliente?.id || '').trim()
    // El cliente puede aun no estar guardado (modo "Crear nuevo cliente"), asi
    // que se usa la cedula/RUC que se este escribiendo en cualquiera de los
    // dos modos, sin esperar a que el cliente exista en la base de datos.
    const clienteIdentificacion = String(
      selectedCliente?.cedula_ruc || clienteForm.cedula_ruc || ''
    ).trim()
    const requiresObjective = isTraslado
    const requiresCliente = isVenta
    const hasRequiredInput = Boolean(
      subTipoId &&
      sucursalId &&
      (!requiresObjective || sucursalObjetivoId) &&
      (!requiresCliente || clienteIdentificacion)
    )

    if (!hasRequiredInput) {
      setDocumentStatus(DOCUMENT_STATUS.invalid)
      setFormData((prev) => (
        prev.no_documento
          ? { ...prev, no_documento: '' }
          : prev
      ))
      return
    }

    if (documentCheckTimerRef.current) {
      clearTimeout(documentCheckTimerRef.current)
      documentCheckTimerRef.current = null
    }

    setFormData((prev) => (
      prev.no_documento
        ? { ...prev, no_documento: '' }
        : prev
    ))

    documentCheckTimerRef.current = setTimeout(() => {
      void fetchNextDocumentNumber({
        subTipoId,
        sucursalId,
        sucursalObjetivoId,
        clienteId,
        clienteIdentificacion,
      })
    }, 220)

    return () => {
      if (documentCheckTimerRef.current) {
        clearTimeout(documentCheckTimerRef.current)
        documentCheckTimerRef.current = null
      }
    }
  }, [
    fetchNextDocumentNumber,
    formData.solicitudTrasladoId,
    formData.subTipoId,
    formData.sucursalId,
    formData.sucursalObjetivoId,
    isPrefilledTransfer,
    isTraslado,
    isTransferWithoutRequest,
    isVenta,
    selectedCliente?.id,
    selectedCliente?.cedula_ruc,
    clienteForm.cedula_ruc,
    open,
  ])

  const devolucionEstadoOptions = useMemo(
    () => {
      const devuelto = estados.filter((estado) => normalizeValue(estado?.nombre) === 'devuelto')
      if (devuelto.length) return devuelto
      return estados.filter((estado) => normalizeValue(estado?.nombre) === 'recibido')
    },
    [estados]
  )

  const trasladoEstadoOptions = useMemo(() => {
    const strictAllowed = new Set(['enviado', 'recibido', 'parcialmente recibido'])
    const strictMatches = estados.filter((estado) =>
      strictAllowed.has(normalizeValue(estado?.nombre))
    )
    if (strictMatches.length) return strictMatches
    return estados.filter(
      (estado) =>
        matchesNormalizedStem(estado?.nombre, 'envi') ||
        matchesNormalizedStem(estado?.nombre, 'recib') ||
        matchesNormalizedStem(estado?.nombre, 'parcial')
    )
  }, [estados])

  const ventaEstadoOptions = useMemo(() => {
    const vendidos = estados.filter((estado) => normalizeValue(estado?.nombre) === 'vendido')
    if (vendidos.length) return vendidos
    return estados.filter((estado) => matchesNormalizedStem(estado?.nombre, 'vendid'))
  }, [estados])

  const estadoOptions = useMemo(() => {
    if (isDevolucion) return devolucionEstadoOptions
    if (isTraslado) return trasladoEstadoOptions
    if (isVenta) return ventaEstadoOptions
    return []
  }, [devolucionEstadoOptions, isDevolucion, isTraslado, isVenta, trasladoEstadoOptions, ventaEstadoOptions])

  const defaultEstadoMovimientoId = useMemo(() => {
    if (!estadoOptions.length) {
      if (!isTraslado) return ''
      const fallback = findEstadoByPreference(estados, [
        'enviado',
        'recibido',
        'parcialmente recibido',
      ])
      return fallback?.id ? String(fallback.id) : ''
    }

    if (isTraslado) {
      const enviado = findEstadoByPreference(estadoOptions, ['enviado'])
      return String(enviado?.id ?? estadoOptions[0].id)
    }

    if (isDevolucion) {
      return String(estadoOptions[0].id)
    }

    if (isVenta) {
      const vendido = findEstadoByPreference(estadoOptions, ['vendido'])
      if (vendido?.id) return String(vendido.id)
      return String(estadoOptions[0].id)
    }

    return String(estadoOptions[0].id)
  }, [estadoOptions, estados, isDevolucion, isTraslado, isVenta])

  const estadoReadOnlyOptions = useMemo(
    () => (estadoOptions.length ? estadoOptions : estados),
    [estadoOptions, estados]
  )

  const resolvedEstadoMovimientoId = useMemo(() => {
    const selectedId = String(formData.estadoId || '').trim()
    if (selectedId) return selectedId
    if (defaultEstadoMovimientoId) return defaultEstadoMovimientoId
    if (!isTraslado) return ''
    const fallback = findEstadoByPreference(estados, [
      'enviado',
      'recibido',
      'parcialmente recibido',
    ])
    return fallback?.id ? String(fallback.id) : ''
  }, [defaultEstadoMovimientoId, estados, formData.estadoId, isTraslado])
  // Solo se avisa cuando los catalogos cargaron bien: si fallaron, el problema es otro.
  const missingEstadoMovimiento = Boolean(
    formData.subTipoId && catalogsLoaded && !catalogsLoading && !resolvedEstadoMovimientoId
  )
  const expectedEstadoMovimientoName = isVenta
    ? 'Vendido'
    : isTraslado
      ? 'Enviado'
      : isDevolucion
        ? 'Devuelto'
        : formatSalidaSubTipoLabel(selectedSubTipo)
  const defaultEstadoProductoId = useMemo(() => {
    if (!estadosProducto.length) return ''
    const preferred = estadosProducto.find((estado) =>
      normalizeValue(estado?.nombre).includes('enviad')
    )
    return String(preferred?.id ?? estadosProducto[0].id)
  }, [estadosProducto])
  const missingEstadoProducto = Boolean(
    formData.subTipoId && catalogsLoaded && !catalogsLoading && !defaultEstadoProductoId
  )

  const ivaRateValue = useMemo(() => {
    const parsed = parseNumber(formData.iva_rate)
    if (parsed === null || parsed < 0) return DEFAULT_IVA_RATE
    return parsed
  }, [formData.iva_rate])

  const draftLineTotal = useMemo(
    () => calculateLineTotal(detailDraft.cantidad, detailDraft.valor),
    [detailDraft.cantidad, detailDraft.valor]
  )

  const subtotal = useMemo(
    () =>
      details.reduce((acc, detail) => {
        const total = parseNumber(detail.valor_total)
        return acc + (Number.isFinite(total) ? total : 0)
      }, 0),
    [details]
  )

  const subtotalConBorrador = useMemo(() => {
    const draftTotal = Number.isFinite(draftLineTotal) ? draftLineTotal : 0
    return subtotal + draftTotal
  }, [draftLineTotal, subtotal])

  const descuentoPercent = useMemo(() => {
    if (!isVenta) return 0
    const parsed = parseNumber(formData.descuento)
    if (!Number.isFinite(parsed) || parsed <= 0) return 0
    return Math.min(parsed, 100)
  }, [formData.descuento, isVenta])

  const descuentoAplicado = useMemo(
    () => subtotalConBorrador * (descuentoPercent / 100),
    [descuentoPercent, subtotalConBorrador]
  )

  const subtotalNeto = Math.max(subtotalConBorrador - descuentoAplicado, 0)
  const totalConIva = subtotalNeto * (1 + ivaRateValue)
  const ivaPercent = (ivaRateValue * 100).toFixed(2).replace(/\.00$/, '')
  const descuentoPercentLabel = descuentoPercent.toFixed(2).replace(/\.00$/, '')

  useEffect(() => {
    if (isEditingTotal) return
    setTotalRawInput(formatTwoDecimals(totalConIva))
  }, [totalConIva, isEditingTotal])

  const applyDesiredTotal = (desiredTotal) => {
    if (!Number.isFinite(desiredTotal) || desiredTotal < 0 || subtotalConBorrador <= 0) return

    const desiredSubtotalNeto = desiredTotal / (1 + ivaRateValue)
    const desiredDescuentoAplicado = subtotalConBorrador - desiredSubtotalNeto
    const desiredDescuentoPercent = Math.min(
      100,
      Math.max(0, (desiredDescuentoAplicado / subtotalConBorrador) * 100)
    )
    setFormData((prev) => ({ ...prev, descuento: formatDescuentoPrecise(desiredDescuentoPercent) }))
  }

  const handleTotalFocus = (event) => {
    setIsEditingTotal(true)
    event.target.select()
  }

  const handleTotalChange = (event) => {
    const sanitized = sanitizeDecimalRawInput(event.target.value)
    setTotalRawInput(sanitized)
    const parsed = parseNumber(sanitized)
    if (parsed !== null) applyDesiredTotal(parsed)
  }

  const handleTotalBlur = () => {
    setIsEditingTotal(false)
  }

  useEffect(() => {
    if (isEditingDescuento) return
    setDescuentoRawInput(formatTwoDecimals(formData.descuento))
  }, [formData.descuento, isEditingDescuento])

  const handleDescuentoFocus = (event) => {
    setIsEditingDescuento(true)
    event.target.select()
  }

  const handleDescuentoChange = (event) => {
    const sanitized = sanitizeDecimalRawInput(event.target.value)
    setDescuentoRawInput(sanitized)
    setFormData((prev) => ({ ...prev, descuento: sanitized }))
  }

  const handleDescuentoBlur = () => {
    setIsEditingDescuento(false)
  }
  const selectedDraftProduct = useMemo(
    () => productos.find((producto) => String(producto.id) === String(detailDraft.productoId)) || null,
    [detailDraft.productoId, productos]
  )
  const selectedDraftProductName = useMemo(
    () => String(selectedDraftProduct?.nombre || '').trim(),
    [selectedDraftProduct]
  )
  const selectedDraftRemainingStock = useMemo(() => {
    if (!selectedDraftProduct) return 0
    const rawAvailable = Number(stockByProduct[String(selectedDraftProduct.id)] ?? 0)
    const alreadyAddedQty = details.reduce((acc, detail) => {
      if (String(detail.productoId) !== String(selectedDraftProduct.id)) return acc
      const qty = parseIntValue(detail.cantidad)
      return acc + (Number.isFinite(qty) ? qty : 0)
    }, 0)
    return Math.max((Number.isFinite(rawAvailable) ? rawAvailable : 0) - alreadyAddedQty, 0)
  }, [selectedDraftProduct, stockByProduct, details])
  const detailProductIdSet = useMemo(
    () =>
      new Set(
        details
          .map((detail) => String(detail?.productoId || '').trim())
          .filter(Boolean)
      ),
    [details]
  )

  const selectedSolicitudTraslado = useMemo(
    () =>
      solicitudesTraslado.find(
        (solicitud) => String(solicitud?.id) === String(formData.solicitudTrasladoId)
      ) || null,
    [formData.solicitudTrasladoId, solicitudesTraslado]
  )
  const selectedSolicitudDoc = String(
    selectedSolicitudTraslado?.no_documento || selectedSolicitudTraslado?.id || ''
  ).trim()
  const transferDraftStateLabel = useMemo(() => {
    if (!isTraslado) return ''
    if (!String(formData.solicitudTrasladoId || '').trim()) return ''
    const normalizedRequestState = normalizeValue(
      selectedSolicitudTraslado?.estado_label || selectedSolicitudTraslado?.estado
    )
    if (normalizedRequestState.includes('rechaz')) return 'Rechazado'
    if (normalizedRequestState.includes('cancel')) return 'Cancelado'
    return 'Aceptado'
  }, [formData.solicitudTrasladoId, isTraslado, selectedSolicitudTraslado])
  const solicitudRequesterBranchId = String(
    selectedSolicitudTraslado?.sucursal_solicitante_id || ''
  ).trim()
  const solicitudRequesterBranchName = String(
    selectedSolicitudTraslado?.sucursal_solicitante || ''
  ).trim()
  const transferTargetBranchLabel = solicitudRequesterBranchName || selectedObjetivoBranchName || 'sucursal solicitante'
  const transferTargetBranchButtonLabel = useMemo(() => {
    const raw = String(transferTargetBranchLabel || '').trim()
    if (!raw) return 'sucursal solicitante'
    const compact = raw.replace(/\s*\([^)]*\)\s*$/, '').trim()
    return compact || raw
  }, [transferTargetBranchLabel])
  const transferSourceBranchLabel =
    selectedSucursalName ||
    String(selectedSolicitudTraslado?.sucursal_proveedora || '').trim() ||
    'sucursal proveedora'
  const currentActorRecipient = useMemo(() => {
    const userId = String(
      currentUser?.usuarioInternoId ||
        currentUser?.usuario_interno_id ||
        currentUser?.usuario_id ||
        currentUser?.user_id ||
        currentUser?.id ||
        'system'
    ).trim()
    const name = [
      currentUser?.nombres || currentUser?.nombre || currentUser?.first_name,
      currentUser?.apellidos || currentUser?.apellido || currentUser?.last_name,
    ]
      .filter(Boolean)
      .join(' ')
      .trim() || currentUser?.username || currentUser?.correo || 'Usuario'

    return (
      sanitizeRecipient({ id: userId, name }) || {
        id: 'system',
        name: 'Usuario',
      }
    )
  }, [currentUser])
  const currentCreatorId = useMemo(() => normalizeReminderId(extractUserId(currentUser)), [currentUser])
  const currentCreatorName = useMemo(() => formatCurrentUserName(currentUser), [currentUser])
  const currentCreatorEmail = String(currentUser?.correo || currentUser?.email || '').trim()

  const resolveProviderReminderRecipients = useCallback(
    async (providerBranchId) => {
      const normalizedProviderBranchId = normalizeReminderId(providerBranchId)
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

        const recipients = []
        const seenIds = new Set()
        rows.forEach((item) => {
          const hasSalidaPermission = (Array.isArray(item?.permisos_resumen) ? item.permisos_resumen : []).some(
            (permission) => {
              if (normalizeValue(permission?.modulo) !== 'movimientos_salidas') return false
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
            name:
              [
                item?.nombres || item?.nombre || item?.first_name,
                item?.apellidos || item?.apellido || item?.last_name,
              ]
                .filter(Boolean)
                .join(' ')
                .trim() || item?.username || item?.correo || 'Usuario',
          })
          if (!recipient?.id) return

          const normalizedRecipientId = normalizeReminderId(recipient.id)
          if (!normalizedRecipientId || seenIds.has(normalizedRecipientId)) return

          const hasScopedAccess = hasModuleBranchAccess(
            {
              moduleScopes: normalizeModuleScopes(item?.sucursales_por_modulo),
            },
            'movimientos_salidas',
            normalizedProviderBranchId
          )
          const hasAssignedBranch = (Array.isArray(item?.sucursales) ? item.sucursales : []).some(
            (branch) => normalizeReminderId(branch?.id) === normalizedProviderBranchId
          )
          if (!hasScopedAccess && !hasAssignedBranch) return

          seenIds.add(normalizedRecipientId)
          recipients.push(recipient)
        })

        return recipients
      } catch {
        return []
      }
    },
    [token]
  )

  const fetchReminderUsers = useCallback(async () => {
    if (!token) {
      setReminderUsers([])
      setReminderUsersLoading(false)
      setReminderUsersError('')
      return
    }

    setReminderUsersLoading(true)
    setReminderUsersError('')

    const ensureCurrentCreator = (list) => {
      if (!currentCreatorId) return list
      if (list.some((userItem) => normalizeReminderId(userItem.id) === currentCreatorId)) return list
      return [
        {
          id: currentCreatorId,
          name: currentCreatorName || 'Usuario',
          email: currentCreatorEmail,
          isAdmin: isCurrentUserAdmin,
          moduleScopes: normalizeModuleScopes(currentUser?.sucursales_por_modulo),
          moduleScopeActions: normalizeModuleScopeActions(currentUser?.sucursales_por_modulo),
        },
        ...list,
      ]
    }

    try {
      const rows = []
      let url = `${API_URL}/usuarios/listado/destinatarios/?page_size=200`

      while (url) {
        const response = await authFetch(url, {}, token)
        if (!response.ok) throw new Error('No se pudo cargar la lista de usuarios para recordatorios.')
        const payload = await response.json().catch(() => ({}))
        if (Array.isArray(payload)) {
          rows.push(...payload)
          url = null
        } else {
          rows.push(...(Array.isArray(payload?.results) ? payload.results : []))
          url = payload?.next || null
        }
      }

      const seenIds = new Set()
      const normalizedUsers = []
      rows.forEach((item) => {
        const userId = normalizeReminderId(extractUserId(item))
        if (!userId || seenIds.has(userId)) return
        seenIds.add(userId)
        normalizedUsers.push({
          id: userId,
          name: formatCurrentUserName(item),
          email: String(item?.correo || item?.email || '').trim(),
          isAdmin: Boolean(item?.es_administrador),
          moduleScopes: normalizeModuleScopes(item?.sucursales_por_modulo),
          moduleScopeActions: normalizeModuleScopeActions(item?.sucursales_por_modulo),
        })
      })

      const withCreator = ensureCurrentCreator(normalizedUsers).sort((a, b) =>
        String(a?.name || '').localeCompare(String(b?.name || ''), 'es', { sensitivity: 'base' })
      )
      setReminderUsers(withCreator)
    } catch (err) {
      setReminderUsersError(err?.message || 'No se pudieron cargar los usuarios para recordatorios.')
      setReminderUsers(ensureCurrentCreator([]))
    } finally {
      setReminderUsersLoading(false)
    }
  }, [currentCreatorEmail, currentCreatorId, currentCreatorName, currentUser, isCurrentUserAdmin, token])

  const transferDestinationBranches = useMemo(() => {
    if (!isTraslado) return destinationBranches
    if (!solicitudRequesterBranchId) return destinationBranches
    const hasTarget = destinationBranches.some(
      (branch) => String(branch?.id || '').trim() === solicitudRequesterBranchId
    )
    if (hasTarget) return destinationBranches
    return [
      {
        id: solicitudRequesterBranchId,
        nombre: transferTargetBranchLabel,
      },
      ...destinationBranches,
    ]
  }, [
    destinationBranches,
    isTraslado,
    solicitudRequesterBranchId,
    transferTargetBranchLabel,
  ])
  const isManualTransferMode = isTraslado && isTransferWithoutRequest
  const transferRequiresRequest = isTraslado && !isTransferWithoutRequest
  // Solo se llega a esta combinacion precargando un traslado directo que
  // se habia guardado como borrador (ver prefillGuardadoTraslado) -- el
  // otro flujo que setea solicitudTrasladoId (aceptar una solicitud ya
  // aprobada) usa transferRequiresRequest, no isManualTransferMode.
  const isEditingGuardadoDraft = isManualTransferMode && Boolean(formData.solicitudTrasladoId)

  const selectedReminderTargetBranchId = String(formData.sucursalObjetivoId || '').trim()
  const hasSelectedReminderTargetBranch = Boolean(selectedReminderTargetBranchId)

  const reminderBranchUsers = useMemo(() => {
    if (!isManualTransferMode || !selectedReminderTargetBranchId) return []
    return reminderUsers.filter((userItem) =>
      hasModuleBranchCreateAndUpdateAccess(userItem, 'movimientos_salidas', selectedReminderTargetBranchId)
    )
  }, [isManualTransferMode, reminderUsers, selectedReminderTargetBranchId])

  const adminReminderRecipients = useMemo(() => {
    if (!isManualTransferMode) return []
    return reminderUsers
      .filter((userItem) => userItem.isAdmin)
      .map((userItem) => sanitizeRecipient({ id: userItem.id, name: userItem.name }))
      .filter(Boolean)
      .filter(
        (recipient, index, list) =>
          list.findIndex((item) => normalizeReminderId(item?.id) === normalizeReminderId(recipient?.id)) === index
      )
  }, [isManualTransferMode, reminderUsers])

  const adminReminderRecipientIds = useMemo(
    () => new Set(adminReminderRecipients.map((r) => normalizeReminderId(r?.id)).filter(Boolean)),
    [adminReminderRecipients]
  )

  const reminderUsersById = useMemo(
    () => new Map(reminderUsers.map((userItem) => [normalizeReminderId(userItem?.id), userItem])),
    [reminderUsers]
  )

  const adminReminderRows = useMemo(
    () =>
      adminReminderRecipients
        .map((recipient) => {
          const recipientId = normalizeReminderId(recipient?.id)
          if (!recipientId) return null
          const matchedUser = reminderUsersById.get(recipientId)
          const fallbackEmail = recipientId === currentCreatorId ? currentCreatorEmail : ''
          return {
            id: recipientId,
            name: String(recipient?.name || 'Administrador').trim() || 'Administrador',
            email: String(matchedUser?.email || fallbackEmail || '').trim(),
          }
        })
        .filter(Boolean),
    [adminReminderRecipients, currentCreatorEmail, currentCreatorId, reminderUsersById]
  )

  const selectableReminderUsers = useMemo(
    () => reminderBranchUsers.filter((userItem) => !adminReminderRecipientIds.has(normalizeReminderId(userItem.id))),
    [adminReminderRecipientIds, reminderBranchUsers]
  )

  const selectedReminderRecipients = useMemo(() => {
    if (!selectedReminderUserIds.length) return []
    const usersMap = new Map(reminderBranchUsers.map((userItem) => [normalizeReminderId(userItem.id), userItem]))
    return selectedReminderUserIds
      .map((recipientId) => usersMap.get(normalizeReminderId(recipientId)))
      .filter(Boolean)
      .map((userItem) => sanitizeRecipient({ id: userItem.id, name: userItem.name }))
      .filter(Boolean)
      .filter(
        (recipient, index, list) =>
          list.findIndex((item) => normalizeReminderId(item?.id) === normalizeReminderId(recipient?.id)) === index
      )
  }, [reminderBranchUsers, selectedReminderUserIds])

  const hasAdminReminderRecipients = adminReminderRecipients.length > 0
  const hasAdditionalReminderRecipients = selectedReminderRecipients.length > 0

  const documentHelperText = useMemo(() => {
    if (documentStatus === DOCUMENT_STATUS.error) return 'No se pudo generar el código automáticamente.'
    if (documentStatus === DOCUMENT_STATUS.duplicate) return 'No se puede usar dos iguales.'
    return ''
  }, [documentStatus])
  const documentHelperTone =
    documentStatus === DOCUMENT_STATUS.duplicate || documentStatus === DOCUMENT_STATUS.error
      ? 'error'
      : 'muted'
  const appendTransferCancellationReminder = useCallback(
    (solicitud, motivo) => {
      const solicitudId = String(
        solicitud?.id || formData.solicitudTrasladoId || prefillTransferSolicitudId || ''
      ).trim()
      if (!solicitudId) return

      const existingReminders = readRemindersFromStorage()
      const contextMatchesSolicitud = (reminder) =>
        normalizeReminderContextType(reminder?.context?.type) === 'solicitud_traslado' &&
        normalizeReminderId(reminder?.context?.id) === solicitudId

      const contextReminder = (
        existingReminders.find(
          (reminder) =>
            contextMatchesSolicitud(reminder) &&
            normalizeReminderId(reminder?.kind) === 'solicitud_traslado_decision'
        ) ||
        existingReminders.find(contextMatchesSolicitud) ||
        null
      )

      const requesterRecipient = sanitizeRecipient(contextReminder?.creator)
      if (!requesterRecipient?.id) {
        notifyError(
          'El envío se canceló, pero no se pudo enviar el recordatorio al solicitante.'
        )
        return
      }

      const transferDoc = String(solicitud?.no_documento || selectedSolicitudDoc || '').trim()
      const contextLabel = transferDoc
        ? `Traslado #${transferDoc}`
        : `Traslado #${solicitudId}`
      const transferReference = contextLabel.replace(/^traslado\s*/i, '').trim() || `#${solicitudId}`
      const reason = String(motivo || '').trim()
      const description = transferReference
        ? `Su traslado ${transferReference} fue rechazado. Motivo: ${reason}`
        : `Su traslado fue rechazado. Motivo: ${reason}`
      const now = nowReminderDateTime()

      const reminder = {
        id: normalizeReminderId(contextReminder?.id) || createReminderId(),
        date: now.date,
        time: now.time,
        description,
        creator: contextReminder?.creator || currentActorRecipient,
        recipients: [requesterRecipient],
        context: {
          type: 'solicitud_traslado',
          id: solicitudId,
          label: contextLabel,
        },
        kind: 'recordatorio_general',
        createdAt: contextReminder?.createdAt || now.iso,
        decision: {
          status: 'rechazada',
          reason,
          by: currentActorRecipient,
          at: now.iso,
          assignedRecipients: contextReminder?.decision?.assignedRecipients || [],
        },
        transferHistory: [
          ...getTransferReminderHistory(contextReminder),
          buildTransferHistoryEntry({
            stage: 'rechazada',
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
    [
      currentActorRecipient,
      formData.solicitudTrasladoId,
      notifyError,
      prefillTransferSolicitudId,
      selectedSolicitudDoc,
    ]
  )
  const appendTransferShipmentReminder = useCallback(
    async (solicitud) => {
      const solicitudId = String(
        solicitud?.id || formData.solicitudTrasladoId || prefillTransferSolicitudId || ''
      ).trim()
      if (!solicitudId) return

      const existingReminders = readRemindersFromStorage()
      const contextMatchesSolicitud = (reminder) =>
        normalizeReminderContextType(reminder?.context?.type) === 'solicitud_traslado' &&
        normalizeReminderId(reminder?.context?.id) === solicitudId

      const contextReminder = (
        existingReminders.find(
          (reminder) =>
            contextMatchesSolicitud(reminder) &&
            normalizeReminderId(reminder?.kind) === 'solicitud_traslado_decision'
        ) ||
        existingReminders.find(contextMatchesSolicitud) ||
        null
      )

      const requesterRecipient = sanitizeRecipient(contextReminder?.creator)

      const appendUniqueRecipient = (list, candidate) => {
        const normalized = sanitizeRecipient(candidate)
        if (!normalized?.id) return
        const alreadyExists = list.some(
          (recipient) => normalizeReminderId(recipient?.id) === normalizeReminderId(normalized.id)
        )
        if (!alreadyExists) list.push(normalized)
      }

      const reminderRecipients = []
      const providerRecipients = await resolveProviderReminderRecipients(
        solicitud?.sucursal_proveedora_id || formData.sucursalId
      )
      providerRecipients.forEach((recipient) => {
        appendUniqueRecipient(reminderRecipients, recipient)
      })
      appendUniqueRecipient(reminderRecipients, requesterRecipient)

      if (!reminderRecipients.length) {
        notifyError(
          'La salida se creó, pero no se pudo enviar el recordatorio de envío.'
        )
        return
      }

      const transferDoc = String(solicitud?.no_documento || selectedSolicitudDoc || '').trim()
      const contextLabel = transferDoc
        ? `Traslado #${transferDoc}`
        : `Traslado #${solicitudId}`
      const transferReference = contextLabel.replace(/^traslado\s*/i, '').trim() || `#${solicitudId}`
      const description = transferReference
        ? `El traslado ${transferReference} fue enviado y está en camino.`
        : 'El traslado fue enviado y está en camino.'
      const now = nowReminderDateTime()

      const reminder = {
        id: normalizeReminderId(contextReminder?.id) || createReminderId(),
        date: now.date,
        time: now.time,
        description,
        creator: contextReminder?.creator || currentActorRecipient,
        recipients: reminderRecipients,
        context: {
          type: 'solicitud_traslado',
          id: solicitudId,
          label: contextLabel,
          sucursal_solicitante_id: String(
            contextReminder?.context?.sucursal_solicitante_id ||
            solicitud?.sucursal_solicitante_id || ''
          ).trim(),
          sucursal_proveedora_id: String(
            contextReminder?.context?.sucursal_proveedora_id ||
            solicitud?.sucursal_proveedora_id || ''
          ).trim(),
        },
        kind: 'recordatorio_general',
        createdAt: contextReminder?.createdAt || now.iso,
        decision: {
          status: 'enviado',
          reason: '',
          by: currentActorRecipient,
          at: now.iso,
          assignedRecipients: contextReminder?.decision?.assignedRecipients || [],
        },
        transferHistory: [
          ...getTransferReminderHistory(contextReminder),
          buildTransferHistoryEntry({
            stage: 'enviado',
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
    [
      currentActorRecipient,
      formData.solicitudTrasladoId,
      formData.sucursalId,
      notifyError,
      prefillTransferSolicitudId,
      resolveProviderReminderRecipients,
      selectedSolicitudDoc,
    ]
  )

  useEffect(() => {
    if (!preloadedTipoMovimientos.length) return
    setTipoMovimientos((prev) => (prev.length ? prev : preloadedTipoMovimientos))
  }, [preloadedTipoMovimientos])

  useEffect(() => {
    if (!preloadedSubTipos.length) return
    setSubTipos((prev) => (prev.length ? prev : preloadedSubTipos))
  }, [preloadedSubTipos])

  const formatProductoTriggerLabel = useCallback(
    (producto) => {
      if (!producto) return ''
      const codigo = String(producto?.codigo || '').trim()
      return codigo || `ID ${producto?.id ?? ''}`
    },
    []
  )

  const resetStockLookup = useCallback(() => {
    loadedStockBranchIdRef.current = ''
    pendingStockBranchIdRef.current = ''
    pendingStockPromiseRef.current = null
    stockByProductRef.current = {}
    setStockByProduct({})
    setStockLoading(false)
    setStockLoadError(false)
  }, [])

  const searchClientes = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || term.length < 2 || !token) {
        setClienteOptions([])
        setClienteLoading(false)
        return
      }

      setClienteLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/buscar-cliente/?q=${encodeURIComponent(term)}&page_size=10`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar los clientes.')
        const payload = await response.json().catch(() => ({}))
        setClienteOptions(parseApiList(payload))
      } catch {
        setClienteOptions([])
      } finally {
        setClienteLoading(false)
      }
    },
    [token]
  )

  const validateDocumentNumber = useCallback(
    async (inputValue) => {
      const normalized = String(inputValue || '').trim()
      if (!normalized) {
        setDocumentStatus(DOCUMENT_STATUS.invalid)
        return false
      }
      if (!salidaTipoId || !token) {
        setDocumentStatus(DOCUMENT_STATUS.error)
        return false
      }

      const requestSequence = documentCheckSequenceRef.current + 1
      documentCheckSequenceRef.current = requestSequence
      setDocumentStatus(DOCUMENT_STATUS.checking)

      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/validar-documento/?tipo_movimiento_id=${encodeURIComponent(
            salidaTipoId
          )}&no_documento=${encodeURIComponent(normalized)}`,
          {},
          token
        )
        const payload = await response.json().catch(() => ({}))
        if (requestSequence !== documentCheckSequenceRef.current) return false
        if (!response.ok) {
          setDocumentStatus(DOCUMENT_STATUS.error)
          return false
        }

        const available = Boolean(payload?.is_available)
        setDocumentStatus(available ? DOCUMENT_STATUS.available : DOCUMENT_STATUS.duplicate)
        return available
      } catch {
        if (requestSequence === documentCheckSequenceRef.current) {
          setDocumentStatus(DOCUMENT_STATUS.error)
        }
        return false
      }
    },
    [salidaTipoId, token]
  )

  useEffect(() => {
    if (!open || !formData.subTipoId || !resolvedEstadoMovimientoId) return
    setFormData((prev) => {
      const currentEstadoId = String(prev.estadoId || '').trim()
      const currentStateValid =
        currentEstadoId &&
        estadoReadOnlyOptions.some((estado) => String(estado.id) === currentEstadoId)
      if (currentStateValid) return prev
      return { ...prev, estadoId: resolvedEstadoMovimientoId }
    })
  }, [estadoReadOnlyOptions, formData.subTipoId, open, resolvedEstadoMovimientoId])

  useEffect(() => {
    if (!formData.subTipoId) return
    setFormData((prev) => {
      let changed = false
      const next = { ...prev }

      if (!isTraslado && next.sucursalObjetivoId) {
        next.sucursalObjetivoId = ''
        changed = true
      }
      if (!isTraslado && next.solicitudTrasladoId) {
        next.solicitudTrasladoId = ''
        changed = true
      }
      if (!isVenta && next.cliente) {
        next.cliente = ''
        changed = true
      }
      if (!isVenta && next.descuento) {
        next.descuento = ''
        changed = true
      }
      if (!next.funcional) {
        next.funcional = true
        changed = true
      }
      if (!isVenta && !isDevolucion && !isTraslado && next.factura_referencia) {
        next.factura_referencia = ''
        changed = true
      }

      return changed ? next : prev
    })
  }, [formData.subTipoId, isDevolucion, isTraslado, isVenta])

  useEffect(() => {
    if (!isTraslado && isTransferWithoutRequest) {
      setIsTransferWithoutRequest(false)
    }
    if (!isManualTransferMode) {
      setSelectedReminderUserIds([])
      setReminderUsers([])
    }
  }, [isTraslado, isTransferWithoutRequest, isManualTransferMode])

  useEffect(() => {
    if (formData.solicitudTrasladoId && isTransferWithoutRequest) {
      setIsTransferWithoutRequest(false)
    }
  }, [formData.solicitudTrasladoId, isTransferWithoutRequest])

  useEffect(() => {
    if (!formData.subTipoId) {
      setClienteMode(CLIENT_MODE_EXISTING)
      setActiveTab('general')
    }
  }, [formData.subTipoId])

  useEffect(() => {
    if (isVenta) return
    if (clienteSearchTimerRef.current) {
      clearTimeout(clienteSearchTimerRef.current)
      clienteSearchTimerRef.current = null
    }
    setClienteMode(CLIENT_MODE_EXISTING)
    setActiveTab('general')
    setSelectedCliente(null)
    setClienteForm(initialClienteForm)
    setClienteAutos([])
    setClienteAutoDraft({ ...emptyAuto })
    setSelectedClienteAutos([])
    setAutoConfirmData(null)
    setSavingAuto(false)
    setPendingClienteAutoDraft({ placa: '', modelo: '', anio: '', marca: '' })
    setFetchingClienteAutos(false)
    setShowClienteDropdown(false)
    setClienteQuery('')
    setClienteOptions([])
    setClienteLoading(false)
  }, [isVenta])

  const fetchCatalogs = useCallback(async () => {
    if (!token) return
    setCatalogsLoading(true)
    setCatalogsLoaded(false)
    try {
      const [
        branchesRes,
        allBranchesRes,
        tiposRes,
        subTiposRes,
        estadosRes,
        productosRes,
        estadosProductoRes,
      ] = await Promise.all([
        authFetch(`${API_URL}/inventario/sucursales/?modulo=movimientos_salidas`, {}, token),
        authFetch(`${API_URL}/movimientos/movimiento_inventario/sucursales-traslado-proveedoras/`, {}, token),
        authFetch(`${API_URL}/tipos/tipos-movimiento/`, {}, token),
        authFetch(`${API_URL}/tipos/subtipos-movimiento/`, {}, token),
        authFetch(`${API_URL}/tipos/estados-movimiento/`, {}, token),
        authFetch(`${API_URL}/productos/listado/`, {}, token),
        authFetch(`${API_URL}/tipos/estados-producto/`, {}, token),
      ])

      if (!branchesRes.ok) throw new Error('No se pudieron cargar las sucursales.')
      if (!tiposRes.ok) throw new Error('No se pudieron cargar los tipos de movimiento.')
      if (!subTiposRes.ok) throw new Error('No se pudieron cargar los tipos de salida.')
      if (!estadosRes.ok) throw new Error('No se pudieron cargar los estados de movimiento.')
      if (!productosRes.ok) throw new Error('No se pudieron cargar los productos.')
      if (!estadosProductoRes.ok) throw new Error('No se pudieron cargar los estados de producto.')

      const [
        branchesData,
        allBranchesData,
        tiposData,
        subTiposData,
        estadosData,
        productosData,
        estadosProductoData,
      ] = await Promise.all([
        branchesRes.json(),
        allBranchesRes.ok ? allBranchesRes.json() : Promise.resolve([]),
        tiposRes.json(),
        subTiposRes.json(),
        estadosRes.json(),
        productosRes.json(),
        estadosProductoRes.json(),
      ])

      setBranches(parseApiList(branchesData))
      setAllBranches(parseApiList(allBranchesData))
      setTipoMovimientos(parseApiList(tiposData))
      setSubTipos(parseApiList(subTiposData))
      setEstados(parseApiList(estadosData))
      setProductos(parseApiList(productosData))
      setEstadosProducto(parseApiList(estadosProductoData))
      setCatalogsLoaded(true)

      const configRes = await authFetch(`${API_URL}/configuracion/sistema/`, {}, token)
      if (configRes.ok) {
        const configData = await configRes.json().catch(() => ({}))
        const parsedIva = parseNumber(configData?.iva_rate)
        if (parsedIva !== null && parsedIva >= 0) {
          setFormData((prev) => ({ ...prev, iva_rate: String(parsedIva) }))
        }
      }
    } catch (err) {
      notifyError(err?.message || 'Ocurrió un error al cargar los catálogos.')
    } finally {
      setCatalogsLoading(false)
    }
  }, [notifyError, token])

  const fetchStockByBranch = useCallback(
    async (sucursalId, { force = false } = {}) => {
      const normalizedBranchId = String(sucursalId || '').trim()
      if (!token || !normalizedBranchId) {
        resetStockLookup()
        return {}
      }
      if (!force && loadedStockBranchIdRef.current === normalizedBranchId) {
        return stockByProductRef.current
      }
      if (
        pendingStockPromiseRef.current &&
        pendingStockBranchIdRef.current === normalizedBranchId
      ) {
        return pendingStockPromiseRef.current
      }

      setStockLoading(true)
      pendingStockBranchIdRef.current = normalizedBranchId
      let request = null
      request = (async () => {
        try {
          const response = await authFetch(
            `${API_URL}/movimientos/movimiento_inventario/stock-sucursal-global/?sucursal_id=${encodeURIComponent(
              normalizedBranchId
            )}`,
            {},
            token
          )
          if (!response.ok) {
            throw new Error('No se pudo cargar el inventario de la sucursal seleccionada.')
          }

          const payload = await response.json().catch(() => [])
          const map = {}
          const rows = parseApiList(payload)
          rows.forEach((row) => {
            const productId = String(row?.producto_id || '').trim()
            if (!productId) return
            const qty = Number(row?.cantidad_disponible)
            map[productId] = Number.isFinite(qty) && qty > 0 ? qty : 0
          })

          if (selectedStockBranchIdRef.current === normalizedBranchId) {
            stockByProductRef.current = map
            loadedStockBranchIdRef.current = normalizedBranchId
            setStockByProduct(map)
            setStockLoadError(false)
          }

          return map
        } catch (err) {
          if (selectedStockBranchIdRef.current === normalizedBranchId) {
            stockByProductRef.current = {}
            loadedStockBranchIdRef.current = ''
            setStockByProduct({})
            setStockLoadError(true)
          }
          notifyError(err?.message || 'No se pudo cargar el inventario de la sucursal seleccionada.')
          throw err
        } finally {
          if (pendingStockPromiseRef.current === request) {
            pendingStockPromiseRef.current = null
            pendingStockBranchIdRef.current = ''
            setStockLoading(false)
          }
        }
      })()

      pendingStockPromiseRef.current = request
      return request
    },
    [notifyError, resetStockLookup, token]
  )

  const retryStockLoad = useCallback(() => {
    const branchId = String(formData.sucursalId || '').trim()
    if (!branchId) return
    fetchStockByBranch(branchId, { force: true }).catch(() => {})
  }, [fetchStockByBranch, formData.sucursalId])

  const searchProducts = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token || !hasSelectedSucursal) {
        setProductOptions([])
        return
      }

      setProductLoading(true)
      try {
        const selectedBranchId = String(formData.sucursalId || '').trim()
        const stockPromise = requiresStockValidation && selectedBranchId
          ? fetchStockByBranch(selectedBranchId)
          : Promise.resolve(stockByProductRef.current)
        const [response, stockMap] = await Promise.all([
          authFetch(
            `${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=25`,
            {},
            token
          ),
          stockPromise,
        ])
        if (!response.ok) throw new Error('No se pudieron cargar los productos.')

        const payload = await response.json()
        const list = parseApiList(payload)
        list.sort((a, b) => {
          const qa = Number(stockMap[String(a.id)] ?? 0)
          const qb = Number(stockMap[String(b.id)] ?? 0)
          return (qb > 0 ? 1 : 0) - (qa > 0 ? 1 : 0)
        })
        setProductOptions(list)
      } catch {
        setProductOptions([])
      } finally {
        setProductLoading(false)
      }
    },
    [fetchStockByBranch, formData.sucursalId, hasSelectedSucursal, requiresStockValidation, token]
  )

  const fetchSolicitudesTraslado = useCallback(
    async (sucursalId) => {
      if (!token || !sucursalId) {
        setSolicitudesTraslado([])
        return
      }

      setSolicitudesTrasladoLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/?sucursal_proveedora_id=${encodeURIComponent(
            sucursalId
          )}&estado=aprobada&page_size=100`,
          {},
          token
        )
        if (!response.ok) {
          throw new Error('No se pudieron cargar las solicitudes de traslado aceptadas.')
        }

        const payload = await response.json().catch(() => ({}))
        const rows = parseApiList(payload).filter(
          (solicitud) => !solicitud?.movimiento_salida_id && !solicitud?.movimiento_entrada_id
        )
        setSolicitudesTraslado(rows)
      } catch (err) {
        setSolicitudesTraslado([])
        notifyError(err?.message || 'No se pudieron cargar las solicitudes de traslado aceptadas.')
      } finally {
        setSolicitudesTrasladoLoading(false)
      }
    },
    [notifyError, token]
  )

  useEffect(() => {
    if (!open) return
    if (clienteSearchTimerRef.current) {
      clearTimeout(clienteSearchTimerRef.current)
      clienteSearchTimerRef.current = null
    }
    if (documentCheckTimerRef.current) {
      clearTimeout(documentCheckTimerRef.current)
      documentCheckTimerRef.current = null
    }
    documentCheckSequenceRef.current = 0
    appliedPrefillRequestKeyRef.current = ''
    appliedGuardadoPrefillIdRef.current = ''
    setFormData({
      ...initialForm,
      fecha: todayISO(),
      sucursalId: normalizedPrefilledSucursalId,
    })
    setDetails([])
    setDetailDraft(initialDetail)
    setDetailError('')
    setShowProductDropdown(false)
    setProductDropdownMaxHeight(null)
    setProductQuery('')
    setProductOptions([])
    setProductLoading(false)
    setClienteMode(CLIENT_MODE_EXISTING)
    setActiveTab('general')
    setSelectedCliente(null)
    setClienteForm(initialClienteForm)
    setClienteAutos([])
    setClienteAutoDraft({ ...emptyAuto })
    setSelectedClienteAutos([])
    setAutoConfirmData(null)
    setSavingAuto(false)
    setPendingClienteAutoDraft({ placa: '', modelo: '', anio: '', marca: '' })
    setFetchingClienteAutos(false)
    setShowClienteDropdown(false)
    setClienteQuery('')
    setClienteOptions([])
    setClienteLoading(false)
    resetStockLookup()
    setSolicitudesTraslado([])
    setSolicitudesTrasladoLoading(false)
    setDocumentStatus(DOCUMENT_STATUS.invalid)
    setIsTransferSendConfirmOpen(false)
    setIsTransferCancelModalOpen(false)
    setTransferCancelReason('')
    setTransferCancelReasonError('')
    setTransferCancelSubmitting(false)
    setIsTransferWithoutRequest(false)
    setReminderUsers([])
    setReminderUsersLoading(false)
    setReminderUsersError('')
    setSelectedReminderUserIds([])
    setConsumidorFinalMissing(false)
    setIsMaximized(false)
    setIsResizingModal(false)
    modalRestoreRef.current = null
    setError('')
    setFormSubmitted(false)
    fetchCatalogs()
  }, [fetchCatalogs, normalizedPrefilledSucursalId, open, resetStockLookup])

  useEffect(() => {
    if (!open) {
      setCatalogsLoading(false)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const solicitud = prefillTransferRequest?.solicitud
    const solicitudId = String(solicitud?.id || '').trim()
    if (!solicitud || !solicitudId) return
    setSolicitudesTraslado((prev) => {
      const list = Array.isArray(prev) ? prev : []
      if (list.some((item) => String(item?.id || '').trim() === solicitudId)) return list
      return [solicitud, ...list]
    })
  }, [open, prefillTransferRequest])

  useEffect(() => {
    if (!open) return
    if (!prefillTransferRequestKey || !prefillTransferSolicitudId) return
    if (appliedPrefillRequestKeyRef.current === prefillTransferRequestKey) return
    if (!subTiposSalida.length) return

    const trasladoSubTipo = subTiposSalida.find((subTipo) =>
      normalizeValue(subTipo?.nombre).includes('trasl')
    )
    if (!trasladoSubTipo?.id) return

    const solicitudDoc = String(
      prefillTransferRequest?.solicitud?.no_documento || prefillTransferSolicitudId
    ).trim()
    const prefilledDocNumber = solicitudDoc.slice(0, 80)

    setFormData((prev) => ({
      ...prev,
      subTipoId: String(trasladoSubTipo.id),
      solicitudTrasladoId: prefillTransferSolicitudId,
      no_documento: String(prev.no_documento || '').trim() || prefilledDocNumber,
    }))
    setActiveTab('general')
    appliedPrefillRequestKeyRef.current = prefillTransferRequestKey
  }, [
    open,
    prefillTransferRequest,
    prefillTransferRequestKey,
    prefillTransferSolicitudId,
    subTiposSalida,
  ])

  useEffect(() => {
    if (!open) return
    const guardadoId = String(prefillGuardadoTraslado?.solicitud_traslado_id || prefillGuardadoTraslado?.id || '').trim()
    if (!guardadoId) return
    if (appliedGuardadoPrefillIdRef.current === guardadoId) return
    if (!subTiposSalida.length) return

    const trasladoSubTipo = subTiposSalida.find((subTipo) =>
      normalizeValue(subTipo?.nombre).includes('trasl')
    )
    if (!trasladoSubTipo?.id) return

    const estadoProductoId = String(defaultEstadoProductoId || '').trim()
    const estadoProducto = estadosProducto.find((item) => String(item.id) === estadoProductoId)
    const prefilledDetails = (
      Array.isArray(prefillGuardadoTraslado?.detalles) ? prefillGuardadoTraslado.detalles : []
    ).map((detalle) => {
      const cantidad = Number(detalle?.cantidad) || 0
      const valor = Number(detalle?.valor) || 0
      return {
        uid: `det-guardado-${detalle?.id ?? guardadoId}-${detalle?.producto_id ?? ''}`,
        productoId: String(detalle?.producto_id || ''),
        productoCodigo: String(detalle?.producto_codigo || ''),
        productoNombre: String(detalle?.producto_nombre || ''),
        estadoProductoId,
        estadoProductoNombre: estadoProducto?.nombre ?? '',
        cantidad,
        valor,
        valor_total: cantidad * valor,
      }
    })

    setIsTransferWithoutRequest(true)
    setFormData((prev) => ({
      ...prev,
      subTipoId: String(trasladoSubTipo.id),
      solicitudTrasladoId: guardadoId,
      sucursalId: String(prefillGuardadoTraslado?.sucursal_proveedora_id || '').trim(),
      sucursalObjetivoId: String(prefillGuardadoTraslado?.sucursal_solicitante_id || '').trim(),
      fecha: String(prefillGuardadoTraslado?.fecha || prev.fecha || ''),
      descripcion: String(prefillGuardadoTraslado?.descripcion || ''),
      no_documento: String(prefillGuardadoTraslado?.no_documento || '').trim(),
    }))
    setDetails(prefilledDetails)
    setActiveTab('general')
    appliedGuardadoPrefillIdRef.current = guardadoId
  }, [
    defaultEstadoProductoId,
    estadosProducto,
    open,
    prefillGuardadoTraslado,
    subTiposSalida,
  ])

  useEffect(() => {
    if (!open) return
    if (!effectivePrefilledSucursalId) return
    setFormData((prev) => {
      if (String(prev.sucursalId || '').trim()) return prev
      return { ...prev, sucursalId: effectivePrefilledSucursalId }
    })
  }, [effectivePrefilledSucursalId, open])

  useEffect(() => {
    if (!open) return
    if (isPrefilledTransfer) return
    setIsTransferWithoutRequest(isTraslado)
  }, [open, isPrefilledTransfer, isTraslado])

  useEffect(() => {
    if (!open || !isManualTransferMode) return
    fetchReminderUsers()
  }, [fetchReminderUsers, isManualTransferMode, open])

  useEffect(() => {
    if (!isManualTransferMode) return
    setSelectedReminderUserIds((prev) => {
      if (!prev.length) return prev
      const validIds = new Set(selectableReminderUsers.map((u) => normalizeReminderId(u.id)).filter(Boolean))
      const filtered = prev.filter((id) => validIds.has(normalizeReminderId(id)))
      return filtered.length === prev.length ? prev : filtered
    })
  }, [isManualTransferMode, selectableReminderUsers])

  useEffect(
    () => () => {
      if (clienteSearchTimerRef.current) {
        clearTimeout(clienteSearchTimerRef.current)
      }
      if (documentCheckTimerRef.current) {
        clearTimeout(documentCheckTimerRef.current)
      }
    },
    []
  )

  const updateProductDropdownPlacement = useCallback(() => {
    if (!showProductDropdown || !productDropdownTriggerRef.current) return
    const triggerRect = productDropdownTriggerRef.current.getBoundingClientRect()
    const spacing = 10
    const availableAbove = Math.max(
      Math.floor(triggerRect.top - VIEWPORT_PADDING - spacing),
      0
    )
    const nextMaxHeight = Math.max(140, Math.min(320, availableAbove))
    setProductDropdownMaxHeight((prev) => (prev === nextMaxHeight ? prev : nextMaxHeight))
    setProductDropdownStyle({
      left: triggerRect.left,
      bottom: Math.max(window.innerHeight - triggerRect.top + spacing, VIEWPORT_PADDING),
      maxHeight: nextMaxHeight,
    })
  }, [showProductDropdown])

  useEffect(() => {
    modalSizeRef.current = modalSize
  }, [modalSize])

  useEffect(() => {
    modalPositionRef.current = modalPosition
  }, [modalPosition])

  useEffect(() => {
    if (!open || !showProductDropdown) return
    const term = productQuery.trim()
    if (!term) {
      setProductOptions([])
      return
    }
    const handle = setTimeout(() => {
      searchProducts(term)
    }, 550)
    return () => clearTimeout(handle)
  }, [open, productQuery, searchProducts, showProductDropdown])

  useEffect(() => {
    if (!open || !isVenta || !showClienteDropdown) return
    const term = clienteQuery.trim()
    if (!term || term.length < 2) {
      if (clienteSearchTimerRef.current) {
        clearTimeout(clienteSearchTimerRef.current)
        clienteSearchTimerRef.current = null
      }
      setClienteOptions([])
      setClienteLoading(false)
      return
    }

    if (clienteSearchTimerRef.current) {
      clearTimeout(clienteSearchTimerRef.current)
      clienteSearchTimerRef.current = null
    }

    clienteSearchTimerRef.current = setTimeout(() => {
      searchClientes(term)
    }, 320)

    return () => {
      if (clienteSearchTimerRef.current) {
        clearTimeout(clienteSearchTimerRef.current)
        clienteSearchTimerRef.current = null
      }
    }
  }, [clienteQuery, isVenta, open, searchClientes, showClienteDropdown])

  const updateClienteDropdownPosition = useCallback(() => {
    if (!clienteDropdownTriggerRef.current) return
    const rect = clienteDropdownTriggerRef.current.getBoundingClientRect()
    setClienteDropdownStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      zIndex: 9999,
    })
  }, [])

  useEffect(() => {
    if (!open || !showClienteDropdown) return undefined
    updateClienteDropdownPosition()
    const handleReposition = () => updateClienteDropdownPosition()
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [open, showClienteDropdown, updateClienteDropdownPosition])

  const updateTipoPagoDropdownPosition = useCallback(() => {
    if (!tipoPagoTriggerRef.current) return
    const rect = tipoPagoTriggerRef.current.getBoundingClientRect()
    setTipoPagoDropdownStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      zIndex: 9999,
    })
  }, [])

  useEffect(() => {
    if (!open || !showTipoPagoDropdown) return undefined
    updateTipoPagoDropdownPosition()
    const handleReposition = () => updateTipoPagoDropdownPosition()
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [open, showTipoPagoDropdown, updateTipoPagoDropdownPosition])

  useEffect(() => {
    if (!open || (!showProductDropdown && !showClienteDropdown && !showTipoPagoDropdown)) return undefined
    const handleClick = (event) => {
      const productTouched =
        (productDropdownRef.current && productDropdownRef.current.contains(event.target)) ||
        (productDropdownPanelRef.current && productDropdownPanelRef.current.contains(event.target))
      if (!productTouched) {
        setShowProductDropdown(false)
      }
      const clienteTouched =
        (clienteDropdownRef.current && clienteDropdownRef.current.contains(event.target)) ||
        (clienteDropdownPanelRef.current && clienteDropdownPanelRef.current.contains(event.target))
      if (!clienteTouched) {
        setShowClienteDropdown(false)
      }
      const tipoPagoTouched =
        (tipoPagoDropdownRef.current && tipoPagoDropdownRef.current.contains(event.target)) ||
        (tipoPagoPanelRef.current && tipoPagoPanelRef.current.contains(event.target))
      if (!tipoPagoTouched) {
        setShowTipoPagoDropdown(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [open, showClienteDropdown, showProductDropdown, showTipoPagoDropdown])

  useEffect(() => {
    if (activeTab !== 'cliente' && showClienteDropdown) {
      setShowClienteDropdown(false)
    }
    if (activeTab !== 'general' && showTipoPagoDropdown) {
      setShowTipoPagoDropdown(false)
    }
    if (activeTab !== 'general' && showProductDropdown) {
      setShowProductDropdown(false)
    }
  }, [activeTab, showClienteDropdown, showProductDropdown, showTipoPagoDropdown])

  useCloseDropdownsOnTabSwitch(
    useCallback(() => {
      setShowClienteDropdown(false)
      setShowTipoPagoDropdown(false)
      setShowProductDropdown(false)
    }, [])
  )

  useEffect(() => {
    if (!open || !showProductDropdown) return undefined
    updateProductDropdownPlacement()
    const handleReposition = () => {
      updateProductDropdownPlacement()
    }
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [open, showProductDropdown, updateProductDropdownPlacement])

  useEffect(() => {
    const currentBranchId = String(formData.sucursalId || '').trim()
    if (!open || !requiresStockValidation || !currentBranchId) {
      resetStockLookup()
      return
    }
    if (
      (loadedStockBranchIdRef.current && loadedStockBranchIdRef.current !== currentBranchId) ||
      (pendingStockBranchIdRef.current && pendingStockBranchIdRef.current !== currentBranchId)
    ) {
      loadedStockBranchIdRef.current = ''
      pendingStockBranchIdRef.current = ''
      pendingStockPromiseRef.current = null
      stockByProductRef.current = {}
      setStockByProduct({})
      setStockLoading(false)
      setStockLoadError(false)
    }
  }, [formData.sucursalId, open, requiresStockValidation, resetStockLookup])

  useEffect(() => {
    if (!open || !isTraslado || !formData.sucursalId) {
      setSolicitudesTraslado([])
      setSolicitudesTrasladoLoading(false)
      return
    }
    fetchSolicitudesTraslado(formData.sucursalId)
  }, [fetchSolicitudesTraslado, formData.sucursalId, isTraslado, open])

  useEffect(() => {
    if (!open || !isTraslado) return

    const solicitudId = String(formData.solicitudTrasladoId || '').trim()
    if (!solicitudId) {
      if (!isManualTransferMode) {
        setDetails([])
        setDetailDraft(initialDetail)
        setDetailError('')
      }
      if (transferRequiresRequest) {
        setFormData((prev) => {
          if (!prev.sucursalObjetivoId) return prev
          return { ...prev, sucursalObjetivoId: '' }
        })
      }
      return
    }

    if (!selectedSolicitudTraslado) return

    const objetivoId = String(selectedSolicitudTraslado.sucursal_solicitante_id || '').trim()
    setFormData((prev) => {
      const next = { ...prev }
      let changed = false

      if (String(next.sucursalObjetivoId) !== objetivoId) {
        next.sucursalObjetivoId = objetivoId
        changed = true
      }

      return changed ? next : prev
    })

    const estadoProductoId = String(defaultEstadoProductoId || '').trim()
    const estadoProducto = estadosProducto.find(
      (item) => String(item.id) === estadoProductoId
    )
    const detalleRows = Array.isArray(selectedSolicitudTraslado?.detalles)
      ? selectedSolicitudTraslado.detalles
      : []
    const mappedDetails = detalleRows
      .map((row) => {
        const productoId = String(row?.producto_id || '').trim()
        const cantidad = parseIntValue(row?.cantidad)
        if (!productoId || !Number.isFinite(cantidad) || cantidad <= 0) return null

        const producto = productos.find((item) => String(item.id) === productoId)
        const valorParsed = parseNumber(row?.valor)
        const fallbackValor = parseNumber(resolveProductPrice(producto))
        const valor = Number.isFinite(valorParsed) ? valorParsed : (Number.isFinite(fallbackValor) ? fallbackValor : 0)
        const valorTotal = cantidad * valor

        return {
          uid: `sol-${selectedSolicitudTraslado.id}-${productoId}`,
          productoId,
          productoCodigo: String(row?.producto_codigo || producto?.codigo || '').trim(),
          productoNombre: String(row?.producto_nombre || producto?.nombre || '').trim(),
          estadoProductoId,
          estadoProductoNombre: estadoProducto?.nombre || '',
          cantidad,
          valor,
          valor_total: valorTotal,
        }
      })
      .filter(Boolean)

    setDetails(mappedDetails)
    setDetailDraft(initialDetail)
    setDetailError('')
    setShowProductDropdown(false)
    setProductQuery('')
    setProductOptions([])
  }, [
    defaultEstadoProductoId,
    estadosProducto,
    formData.solicitudTrasladoId,
    isManualTransferMode,
    isTraslado,
    open,
    productos,
    selectedSolicitudTraslado,
    transferRequiresRequest,
  ])

  useLayoutEffect(() => {
    if (!open || isMaximized) return
    const compactMode = isSelectorStep
    const { availableWidth, availableHeight, minWidth, minHeight } = getViewportMetrics(compactMode)
    const preferredWidth = compactMode ? SELECTOR_WIDTH : MIN_WIDTH
    const preferredHeight = compactMode ? SELECTOR_HEIGHT : MIN_HEIGHT
    const width = Math.min(Math.max(preferredWidth, minWidth), availableWidth)
    const height = Math.min(Math.max(preferredHeight, minHeight), availableHeight)
    setModalSize({ width, height })
    setModalPosition({
      x: Math.max((window.innerWidth - width) / 2, VIEWPORT_PADDING),
      y: Math.max((window.innerHeight - height) / 2, VIEWPORT_PADDING),
    })
  }, [getViewportMetrics, isMaximized, isSelectorStep, open])

  const handleModalMouseDown = (event) => {
    const target = event?.target
    if (target?.closest?.('.create-user__icon-button')) return

    if (isMaximized) {
      const restore = modalRestoreRef.current
      const fallbackSize = modalSizeRef.current
      const restoredSize = restore?.size || fallbackSize
      const restoredPosition = restore?.position || {
        x: Math.max((window.innerWidth - restoredSize.width) / 2, VIEWPORT_PADDING),
        y: Math.max((window.innerHeight - restoredSize.height) / 2, VIEWPORT_PADDING),
      }

      modalSizeRef.current = restoredSize
      modalPositionRef.current = restoredPosition
      setModalSize(restoredSize)
      setModalPosition(restoredPosition)
      setIsMaximized(false)

      const offsetX = Math.min(
        Math.max(event.clientX - restoredPosition.x, 24),
        Math.max(restoredSize.width - 24, 24)
      )
      const offsetY = Math.min(
        Math.max(event.clientY - restoredPosition.y, 12),
        56
      )
      modalDrag.current = {
        active: true,
        offsetX,
        offsetY,
      }
      return
    }

    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    modalDrag.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }

  const handleResizeMouseDown = (event) => {
    if (isMaximized) return
    event.preventDefault()
    event.stopPropagation()
    const { minWidth, minHeight } = getViewportMetrics(isSelectorStep)
    setIsResizingModal(true)
    modalResize.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: modalSizeRef.current.width,
      startHeight: modalSizeRef.current.height,
    }

    const handleResizeMove = (moveEvent) => {
      if (!modalResize.current.active) return
      const deltaX = moveEvent.clientX - modalResize.current.startX
      const deltaY = moveEvent.clientY - modalResize.current.startY
      const maxWidth = Math.max(minWidth, window.innerWidth - modalPositionRef.current.x - VIEWPORT_PADDING)
      const maxHeight = Math.max(minHeight, window.innerHeight - modalPositionRef.current.y - VIEWPORT_PADDING)
      const width = clamp(modalResize.current.startWidth + deltaX, minWidth, maxWidth)
      const height = clamp(modalResize.current.startHeight + deltaY, minHeight, maxHeight)
      setModalSize({ width, height })
    }

    const handleResizeUp = () => {
      modalResize.current.active = false
      setIsResizingModal(false)
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }

    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }

  useEffect(() => {
    if (!open) return undefined
    const handleMouseMove = (event) => {
      if (isMaximized || !modalDrag.current.active) return
      event.preventDefault()
      const maxX = Math.max(window.innerWidth - modalSizeRef.current.width - VIEWPORT_PADDING, VIEWPORT_PADDING)
      const maxY = Math.max(window.innerHeight - modalSizeRef.current.height - VIEWPORT_PADDING, VIEWPORT_PADDING)
      const x = event.clientX - modalDrag.current.offsetX
      const y = event.clientY - modalDrag.current.offsetY
      setModalPosition({
        x: Math.min(Math.max(x, VIEWPORT_PADDING), maxX),
        y: Math.min(Math.max(y, VIEWPORT_PADDING), maxY),
      })
    }

    const handleMouseUp = () => {
      modalDrag.current.active = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [open, isMaximized])

  useEffect(() => {
    if (!open) return undefined
    const handleWindowResize = () => {
      const { minWidth, minHeight, availableWidth, availableHeight } = getViewportMetrics(isSelectorStep)

      if (isMaximized) {
        setModalSize({ width: availableWidth, height: availableHeight })
        setModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }

      setModalSize((prev) => {
        const width = clamp(prev.width, minWidth, availableWidth)
        const height = clamp(prev.height, minHeight, availableHeight)

        setModalPosition((prevPosition) => ({
          x: Math.min(
            Math.max(prevPosition.x, VIEWPORT_PADDING),
            Math.max(window.innerWidth - width - VIEWPORT_PADDING, VIEWPORT_PADDING)
          ),
          y: Math.min(
            Math.max(prevPosition.y, VIEWPORT_PADDING),
            Math.max(window.innerHeight - height - VIEWPORT_PADDING, VIEWPORT_PADDING)
          ),
        }))

        return { width, height }
      })
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [getViewportMetrics, isMaximized, isSelectorStep, open])

  const toggleMaximize = () => {
    modalDrag.current.active = false
    modalResize.current.active = false
    setIsResizingModal(false)

    if (isMaximized) {
      const restore = modalRestoreRef.current
      if (restore) {
        setModalSize(restore.size)
        setModalPosition(restore.position)
      }
      setIsMaximized(false)
      return
    }

    modalRestoreRef.current = {
      size: { ...modalSizeRef.current },
      position: { ...modalPositionRef.current },
    }
    const { availableWidth, availableHeight } = getViewportMetrics()
    setModalSize({ width: availableWidth, height: availableHeight })
    setModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  const handleToggleTransferWithoutRequest = useCallback(
    (value) => {
      setError('')
      setIsTransferWithoutRequest(value)
      if (value) {
        setFormData((prev) => ({ ...prev, solicitudTrasladoId: '' }))
      }
    },
    [setError, setFormData, setIsTransferWithoutRequest]
  )

  const handleChange = (event) => {
    const { name, value, type, checked } = event.target
    const nextValue = type === 'checkbox' ? checked : value
    setFormData((prev) => {
      if (name === 'sucursalId' && isSucursalPrincipalLocked) return prev

      const next = {
        ...prev,
        [name]: nextValue,
      }

      if (name === 'sucursalId' && String(prev.sucursalId) !== String(nextValue)) {
        next.solicitudTrasladoId = ''
        if (isTraslado || String(next.sucursalObjetivoId || '').trim() === String(nextValue || '').trim()) {
          next.sucursalObjetivoId = ''
        }
      }

      if (name === 'sucursalObjetivoId' && String(prev.sucursalId || '').trim() === String(nextValue || '').trim()) {
        next.sucursalObjetivoId = ''
      }

      if (name === 'subTipoId' && String(prev.subTipoId) !== String(nextValue)) {
        next.solicitudTrasladoId = ''
      }

      return next
    })
  }

  const handleSubTipoSelect = (subTipoId) => {
    handleChange({
      target: {
        name: 'subTipoId',
        value: String(subTipoId || ''),
        type: 'button',
      },
    })
  }

  const fetchClienteAutosData = useCallback(async (clienteId) => {
    if (!token || !clienteId) return
    setFetchingClienteAutos(true)
    try {
      const response = await authFetch(`${API_URL}/solicitudes/clientes/${clienteId}/`, {}, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return
      setSelectedClienteAutos(Array.isArray(data?.autos) ? data.autos : [])
    } catch {
      setSelectedClienteAutos([])
    } finally {
      setFetchingClienteAutos(false)
    }
  }, [token])

  const handleAutoAgregarClick = () => {
    const { placa, modelo, anio, marca } = pendingClienteAutoDraft
    if (!placa.trim() && !modelo.trim()) return
    setAutoConfirmData({ placa: placa.trim(), modelo: modelo.trim(), anio: anio.trim(), marca: marca.trim() })
  }

  const handleConfirmAddAuto = async () => {
    if (!autoConfirmData || !selectedCliente?.id) return
    setSavingAuto(true)
    try {
      const allAutos = [
        ...selectedClienteAutos.map((a) => ({
          placa: String(a.placa || '').trim(),
          modelo: String(a.modelo || '').trim(),
          anio: a.anio ? Number(a.anio) : null,
          marca: String(a.marca || '').trim(),
          color: String(a.color || '').trim(),
        })),
        {
          placa: autoConfirmData.placa,
          modelo: autoConfirmData.modelo,
          anio: autoConfirmData.anio ? Number(autoConfirmData.anio) : null,
          marca: autoConfirmData.marca,
          color: '',
        },
      ]
      const res = await authFetch(
        `${API_URL}/solicitudes/clientes/${selectedCliente.id}/`,
        { method: 'PATCH', body: JSON.stringify({ autos: allAutos }) },
        token
      )
      const resData = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(resolveApiErrorMessage(resData, 'No se pudo agregar el vehículo.'))
      }
      setSelectedClienteAutos(Array.isArray(resData?.autos) ? resData.autos : allAutos)
      setAutoConfirmData(null)
      setPendingClienteAutoDraft({ placa: '', modelo: '', anio: '', marca: '' })
    } catch (err) {
      setError(err?.message || 'No se pudo agregar el vehículo.')
    } finally {
      setSavingAuto(false)
    }
  }

  const lookupClienteByCedula = async (cedula) => {
    const normalized = String(cedula || '').trim()
    if (normalized.length < 5) return null
    try {
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/buscar-cliente/?q=${encodeURIComponent(normalized)}&page_size=10`,
        {},
        token
      )
      if (!response.ok) return null
      const data = await response.json()
      const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : [])
      return (
        results.find((c) => String(c.cedula_ruc || '').trim().toLowerCase() === normalized.toLowerCase()) ||
        null
      )
    } catch {
      return null
    }
  }

  const handleCedulaBlur = async () => {
    const cedula = String(clienteForm.cedula_ruc || '').trim()
    if (cedula.length < 5 || loading) return
    const exactMatch = await lookupClienteByCedula(cedula)
    if (exactMatch) {
      handleClienteSelect(exactMatch)
      notifyError('Ya existe un cliente con esa cédula/RUC. Se seleccionó automáticamente.')
    }
  }

  const handleUseExistingCliente = () => {
    if (useExistingCliente) return
    setError('')
    setClienteMode(CLIENT_MODE_EXISTING)
    setSelectedCliente(null)
    setFormData((prev) => ({ ...prev, cliente: '' }))
    setClienteQuery('')
    setShowClienteDropdown(false)
    setClienteOptions([])
    setClienteLoading(false)
    setSelectedClienteAutos([])
    setAutoConfirmData(null)
    setPendingClienteAutoDraft({ placa: '', modelo: '', anio: '', marca: '' })
  }

  const handleCreateNewCliente = () => {
    setError('')
    setClienteMode(CLIENT_MODE_NEW)
    setSelectedCliente(null)
    setFormData((prev) => ({ ...prev, cliente: '' }))
    setClienteQuery('')
    setShowClienteDropdown(false)
    setClienteOptions([])
    setClienteLoading(false)
    setClienteForm(initialClienteForm)
    setClienteAutos([])
    setClienteAutoDraft({ ...emptyAuto })
    setSelectedClienteAutos([])
    setAutoConfirmData(null)
    setPendingClienteAutoDraft({ placa: '', modelo: '', anio: '', marca: '' })
  }

  const handleUseConsumidorFinal = async () => {
    if (loading) return
    setError('')
    const existing = await lookupClienteByCedula(CONSUMIDOR_FINAL_CEDULA)
    if (!existing) {
      setConsumidorFinalMissing(true)
      notifyError('No se encontró el cliente "Consumidor Final". Contacta al administrador.')
      return
    }
    setConsumidorFinalMissing(false)
    setClienteMode(CLIENT_MODE_CONSUMIDOR_FINAL)
    setSelectedCliente(existing)
    setFormData((prev) => ({ ...prev, cliente: formatClienteFieldValue(existing) }))
    setClienteQuery('')
    setShowClienteDropdown(false)
    setClienteOptions([])
    setClienteLoading(false)
    setClienteForm(normalizeClientePayload(existing))
    setSelectedClienteAutos([])
    setAutoConfirmData(null)
    setPendingClienteAutoDraft({ placa: '', modelo: '', anio: '', marca: '' })
  }

  const handleAddClienteAuto = () => {
    const { vin, modelo, motor, anio } = clienteAutoDraft
    if (!vin.trim() && !modelo.trim() && !motor.trim() && !anio.trim()) return
    setClienteAutos((prev) => [...prev, { vin: vin.trim(), modelo: modelo.trim(), motor: motor.trim(), anio: anio.trim() }])
    setClienteAutoDraft({ ...emptyAuto })
  }

  const handleRemoveClienteAuto = (index) => {
    setClienteAutos((prev) => prev.filter((_, i) => i !== index))
  }

  const handleClienteQueryChange = (event) => {
    const value = event.target.value
    setError('')
    setClienteQuery(value)
    if (!value.trim()) {
      setClienteOptions([])
      setClienteLoading(false)
      return
    }
  }

  const handleClienteDropdownToggle = () => {
    if (loading) return
    setError('')
    setShowClienteDropdown((prev) => {
      const next = !prev
      if (next) {
        setClienteQuery('')
        setClienteOptions([])
        setClienteLoading(false)
      }
      return next
    })
  }

  const handleClienteFieldChange = (event) => {
    const { name, value } = event.target
    setError('')
    setClienteForm((prev) => ({ ...prev, [name]: value }))
    if (selectedCliente) {
      setSelectedCliente(null)
      setFormData((prev) => ({ ...prev, cliente: '' }))
    }
  }

  const handleClienteSelect = (cliente) => {
    const label = formatClienteFieldValue(cliente)
    if (!label) return
    setClienteMode(CLIENT_MODE_EXISTING)
    setSelectedCliente(cliente || null)
    setFormData((prev) => ({ ...prev, cliente: label }))
    setClienteQuery('')
    setSelectedClienteAutos([])
    setAutoConfirmData(null)
    setPendingClienteAutoDraft({ placa: '', modelo: '', anio: '', marca: '' })
    if (cliente?.id) fetchClienteAutosData(cliente.id)
    setClienteForm(normalizeClientePayload(cliente))
    setShowClienteDropdown(false)
    setClienteOptions([])
    setClienteLoading(false)
  }

  const handleDetailChange = (event) => {
    const { name, value } = event.target
    setDetailDraft((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleProductSelect = (producto) => {
    if (!producto?.id) return
    const productPrice = resolveProductPrice(producto)
    setDetailError('')
    setDetailDraft((prev) => ({
      ...prev,
      productoId: String(producto.id),
      valor: productPrice,
    }))
    setProductos((prev) => {
      if (prev.some((item) => String(item.id) === String(producto.id))) return prev
      return [producto, ...prev]
    })
    setShowProductDropdown(false)
    setProductQuery('')
    setProductOptions([])
  }

  const handleAddDetail = () => {
    setDetailError('')
    if (transferRequiresRequest) {
      setDetailError('Los productos del traslado se cargan desde la solicitud seleccionada.')
      return
    }
    const productoId = String(detailDraft.productoId || '').trim()
    const cantidad = parseIntValue(detailDraft.cantidad)
    const estadoProductoId = String(defaultEstadoProductoId || '').trim()
    const producto = productos.find((item) => String(item.id) === productoId)
    const valorRaw = parseNumber(resolveProductPrice(producto))
    const valor = isTraslado ? (valorRaw ?? 0) : valorRaw

    if (isTraslado && !formData.sucursalId) {
      setDetailError('Selecciona primero la sucursal para cargar disponibilidad.')
      return
    }
    if (!productoId) {
      setDetailError('Selecciona un producto.')
      return
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      setDetailError('Ingresa una cantidad valida.')
      return
    }
    if (!Number.isFinite(valor) || valor < 0) {
      setDetailError('El producto seleccionado no tiene un precio valido.')
      return
    }
    if (requiresStockValidation) {
      const available = Number(stockByProduct[productoId] ?? 0)
      const alreadyUsed = details.reduce((acc, detail) => {
        if (String(detail.productoId) !== productoId) return acc
        const qty = parseIntValue(detail.cantidad)
        return acc + (Number.isFinite(qty) ? qty : 0)
      }, 0)
      const remaining = Math.max(available - alreadyUsed, 0)
      if (cantidad > remaining) {
        setDetailError(`Cantidad excede disponible en sucursal seleccionada. Disponible: ${remaining}.`)
        return
      }
    }
    if (!estadoProductoId) {
      setDetailError('No hay estado de producto configurado.')
      return
    }

    const estadoProducto = estadosProducto.find((item) => String(item.id) === estadoProductoId)

    const existingDetail = details.find((detail) => String(detail.productoId) === productoId)
    if (existingDetail) {
      const existingQty = parseIntValue(existingDetail.cantidad)
      setDuplicateProductConfirm({
        productoId,
        productoCodigo: producto?.codigo ?? existingDetail.productoCodigo ?? '',
        productoNombre: producto?.nombre ?? existingDetail.productoNombre ?? '',
        existingUid: existingDetail.uid,
        existingQty: Number.isFinite(existingQty) ? existingQty : 0,
        cantidad,
      })
      return
    }

    setDetails((prev) => [...prev, buildDetailRow(productoId, producto, estadoProductoId, estadoProducto, cantidad, valor)])

    setDetailDraft(initialDetail)
    setShowProductDropdown(false)
    setProductQuery('')
    setProductOptions([])
  }

  const buildDetailRow = (productoId, producto, estadoProductoId, estadoProducto, cantidad, valor) => ({
    uid: `det-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    productoId,
    productoCodigo: producto?.codigo ?? '',
    productoNombre: producto?.nombre ?? '',
    estadoProductoId,
    estadoProductoNombre: estadoProducto?.nombre ?? '',
    cantidad,
    valor,
    valor_total: cantidad * valor,
  })

  const handleCancelDuplicateProduct = () => {
    setDuplicateProductConfirm(null)
  }

  const handleConfirmDuplicateProduct = () => {
    if (!duplicateProductConfirm) return
    const { existingUid, cantidad } = duplicateProductConfirm
    setDetails((prev) =>
      prev.map((detail) => {
        if (detail.uid !== existingUid) return detail
        const nuevaCantidad = parseIntValue(detail.cantidad) + cantidad
        return {
          ...detail,
          cantidad: nuevaCantidad,
          valor_total: nuevaCantidad * detail.valor,
        }
      })
    )
    setDuplicateProductConfirm(null)
    setDetailDraft(initialDetail)
    setShowProductDropdown(false)
    setProductQuery('')
    setProductOptions([])
  }

  const handleBulkAddProducts = useCallback(
    async (text) => {
      const { entries, invalidLines } = parseBulkProductPasteText(text)
      if (!entries.length) {
        const detalle = invalidLines.length ? ` No se pudo leer: ${formatInvalidBulkPasteLines(invalidLines)}.` : ''
        setDetailError(`No se encontraron filas validas para pegar. Se espera codigo y cantidad separados por tabulaciones.${detalle}`)
        return
      }
      if (transferRequiresRequest) {
        setDetailError('Los productos del traslado se cargan desde la solicitud seleccionada.')
        return
      }
      if (!hasSelectedSucursal) {
        setDetailError('Selecciona una sucursal primero.')
        return
      }
      const estadoProductoId = String(defaultEstadoProductoId || '').trim()
      if (!estadoProductoId) {
        setDetailError('No hay estado de producto configurado.')
        return
      }

      const mergedByCodigo = new Map()
      entries.forEach(({ codigo, cantidad }) => {
        const key = codigo.toUpperCase()
        const prev = mergedByCodigo.get(key)
        mergedByCodigo.set(key, { codigo, cantidad: (prev?.cantidad || 0) + cantidad })
      })

      setDetailError('')
      setProductLoading(true)
      try {
        const codigosParam = Array.from(mergedByCodigo.values()).map((item) => item.codigo)
        const response = await authFetch(
          `${API_URL}/productos/listado/?codigos=${encodeURIComponent(codigosParam.join(','))}&page_size=${codigosParam.length}`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron buscar los productos.')
        const payload = await response.json()
        const found = parseApiList(payload)
        const foundByCodigo = new Map(
          found.map((producto) => [String(producto?.codigo || '').trim().toUpperCase(), producto])
        )

        const estadoProducto = estadosProducto.find((item) => String(item.id) === estadoProductoId)
        const addedIds = new Set(detailProductIdSet)
        const newRows = []
        const notFound = []
        const skipped = []

        mergedByCodigo.forEach(({ codigo, cantidad }) => {
          const producto = foundByCodigo.get(codigo.toUpperCase())
          if (!producto) {
            notFound.push(codigo)
            return
          }
          const productoId = String(producto.id)
          if (addedIds.has(productoId)) {
            skipped.push(`${codigo} (ya agregado)`)
            return
          }

          let finalCantidad = cantidad
          if (requiresStockValidation) {
            const available = Number(stockByProduct[productoId] ?? 0)
            if (available <= 0) {
              skipped.push(`${codigo} (sin stock disponible)`)
              return
            }
            if (finalCantidad > available) finalCantidad = available
          }

          addedIds.add(productoId)
          newRows.push(
            buildDetailRowFromProduct(producto, finalCantidad, {
              estadoProductoId,
              estadoProductoNombre: estadoProducto?.nombre ?? '',
            })
          )
        })

        if (newRows.length) {
          setDetails((prev) => [...prev, ...newRows])
          setProductos((prev) => {
            const existingIds = new Set(prev.map((item) => String(item.id)))
            const additions = newRows
              .map((row) => foundByCodigo.get(String(row.productoCodigo || '').toUpperCase()))
              .filter((producto) => producto && !existingIds.has(String(producto.id)))
            return additions.length ? [...additions, ...prev] : prev
          })
        }

        const issues = []
        if (notFound.length) issues.push(`No encontrados: ${notFound.join(', ')}.`)
        if (skipped.length) issues.push(`Omitidos: ${skipped.join(', ')}.`)
        if (invalidLines.length) issues.push(`No se pudo leer: ${formatInvalidBulkPasteLines(invalidLines)}.`)

        if (newRows.length && !issues.length) {
          notifySuccess(`Se agregaron ${newRows.length} producto(s).`)
        } else if (newRows.length) {
          notifyError(`Se agregaron ${newRows.length} producto(s). ${issues.join(' ')}`)
        } else {
          setDetailError(issues.join(' ') || 'No se agrego ningun producto.')
        }

        setShowProductDropdown(false)
        setProductQuery('')
        setProductOptions([])
      } catch {
        setDetailError('No se pudieron buscar los productos pegados.')
      } finally {
        setProductLoading(false)
      }
    },
    [
      transferRequiresRequest,
      hasSelectedSucursal,
      defaultEstadoProductoId,
      estadosProducto,
      detailProductIdSet,
      requiresStockValidation,
      stockByProduct,
      token,
      notifySuccess,
      notifyError,
    ]
  )

  const handleRemoveDetail = (uid) => {
    if (transferRequiresRequest) return
    setDetails((prev) => prev.filter((detail) => detail.uid !== uid))
  }

  const buildDescripcion = (clienteLabel = '') => {
    const descripcionBase = String(formData.descripcion || '').trim()
    if (!isVenta) return descripcionBase
    const cliente = String(clienteLabel || '').trim()
    if (!cliente) return descripcionBase
    if (!descripcionBase) return `Cliente: ${cliente}`
    return `Cliente: ${cliente}\n${descripcionBase}`
  }

  const toggleReminderUser = (userId) => {
    const normalizedId = normalizeReminderId(userId)
    if (!normalizedId || adminReminderRecipientIds.has(normalizedId)) return
    setSelectedReminderUserIds((prev) =>
      prev.includes(normalizedId)
        ? prev.filter((id) => id !== normalizedId)
        : [...prev, normalizedId]
    )
  }

  const submitSalida = async ({ skipTransferConfirmation = false, guardarBorrador = false, skipCedulaPrompt = false } = {}) => {
    setError('')
    const solicitudIdValue = String(formData.solicitudTrasladoId || '').trim()

    // Traslado directo guardado como borrador: a diferencia del resto de
    // salidas, esto NO crea un MovimientoInventario (no toca stock todavia)
    // -- solo guarda/actualiza la SolicitudTraslado en estado GUARDADO, el
    // mismo mecanismo que ya usa "Pedido a sucursal" en Entradas. Por eso
    // se resuelve aparte, antes de las validaciones de mas abajo que son
    // especificas de crear un movimiento real (no_documento, factura,
    // estado_movimiento, etc. no aplican a un borrador a medio llenar).
    if (guardarBorrador && isManualTransferMode) {
      if (!formData.sucursalId) {
        notifyError('Selecciona la sucursal.')
        return false
      }
      if (!formData.sucursalObjetivoId) {
        notifyError('Selecciona la sucursal destino.')
        return false
      }
      if (String(formData.sucursalId) === String(formData.sucursalObjetivoId)) {
        notifyError('La sucursal destino debe ser diferente a la sucursal principal.')
        return false
      }
      if (!formData.fecha) {
        notifyError('No se pudo resolver la fecha del movimiento.')
        return false
      }

      setLoading(true)
      try {
        const reminderRecipientIds = [
          ...adminReminderRecipients.map((r) => normalizeReminderId(r?.id)).filter(Boolean).map(Number).filter(Boolean),
          ...selectedReminderUserIds.map(Number).filter(Boolean),
        ].filter((id, index, arr) => arr.indexOf(id) === index)

        const payload = {
          fecha: formData.fecha,
          descripcion: String(formData.descripcion || '').trim(),
          sucursal_solicitante_id: Number(formData.sucursalObjetivoId),
          sucursal_proveedora_id: Number(formData.sucursalId),
          recordatorio_destinatario_ids: reminderRecipientIds,
          detalles: details
            .filter((detail) => detail.productoId)
            .map((detail) => ({
              producto_id: Number(detail.productoId),
              cantidad: Number(detail.cantidad) || 0,
              valor: Math.max(0, parseNumber(detail.valor) ?? 0),
            })),
          guardar_borrador: true,
        }

        const isUpdatingDraft = Boolean(solicitudIdValue)
        const response = await authFetch(
          isUpdatingDraft
            ? `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(solicitudIdValue)}/`
            : `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/`,
          {
            method: isUpdatingDraft ? 'PUT' : 'POST',
            body: JSON.stringify(payload),
          },
          token
        )

        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const detail = resolveApiErrorMessage(data, 'No se pudo guardar el traslado.')
          throw new Error(detail)
        }

        onCreated?.(data)
        return true
      } catch (err) {
        notifyError(err.message || 'Ocurrió un error al guardar el traslado.')
        return false
      } finally {
        setLoading(false)
      }
    }

    const estadoMovimientoId = String(formData.estadoId || resolvedEstadoMovimientoId || '').trim()

    if (!salidaTipoId) {
      notifyError('No se encontró el tipo de movimiento de salida.')
      return false
    }

    if (!formData.subTipoId) {
      notifyError('Selecciona el tipo de salida.')
      return false
    }

    if (!formData.sucursalId) {
      notifyError('Selecciona la sucursal.')
      return false
    }

    if (requiresSucursalObjetivo && !formData.sucursalObjetivoId) {
      notifyError('Selecciona la sucursal destino.')
      return false
    }

    if (requiresSucursalObjetivo && String(formData.sucursalId) === String(formData.sucursalObjetivoId)) {
      notifyError('La sucursal destino debe ser diferente a la sucursal principal.')
      return false
    }

    if (!estadoMovimientoId) {
      notifyError('No se pudo resolver el estado del movimiento.')
      return false
    }
    if (estadoMovimientoId !== String(formData.estadoId || '').trim()) {
      setFormData((prev) => ({ ...prev, estadoId: estadoMovimientoId }))
    }

    if (!formData.fecha) {
      notifyError('No se pudo resolver la fecha del movimiento.')
      return false
    }

    if (isVenta && !String(selectedCliente?.cedula_ruc || clienteForm.cedula_ruc || '').trim()) {
      setActiveTab('cliente')
      notifyError('Selecciona un cliente existente o crea uno nuevo antes de continuar.')
      return false
    }

    if (!String(formData.no_documento || '').trim()) {
      notifyError('Espera a que se genere el código del documento.')
      return false
    }

    if (!isPrefilledTransfer) {
      // Cuando el traslado viene prefilled de una solicitud aceptada, el
      // no_documento es el codigo de esa solicitud (unico desde su creacion)
      // y no lo edita el usuario, asi que esta verificacion es redundante ahi
      // y a veces daba falso positivo. En cualquier otro caso (traslado
      // manual, venta, devolucion) el numero se genera por secuencia y si
      // puede chocar entre dos envios casi simultaneos, asi que ahi la
      // verificacion sigue aplicando. Ver el efecto que llama a
      // fetchNextDocumentNumber: usa exactamente esta misma condicion
      // (isPrefilledTransfer) para decidir si autogenera el numero o no.
      const documentoDisponible = await validateDocumentNumber(formData.no_documento)
      if (!documentoDisponible) {
        notifyError('No se puede usar dos iguales.')
        return false
      }
    }

    if ((isVenta || isDevolucion || isTraslado) && !String(formData.factura_referencia || '').trim()) {
      notifyError('El No. de Factura es obligatorio.')
      return false
    }

    // Sin valor por defecto: quien envia tiene que elegir como sale.
    if (isTraslado && !String(formData.tipo_envio || '').trim()) {
      notifyError('Selecciona el tipo de salida.')
      return false
    }

    if (isDevolucion && !String(formData.descripcion || '').trim()) {
      notifyError('La Nota es obligatoria para solicitudes de garantía.')
      return false
    }

    if (isVenta && !String(formData.tipo_pago || '').trim()) {
      notifyError('El Tipo de pago es obligatorio para ventas.')
      return false
    }

    if (!details.length) {
      notifyError('Agrega al menos un producto.')
      return false
    }

    if (details.some((detail) => !detail.productoId || !detail.estadoProductoId)) {
      notifyError('Hay productos con datos incompletos.')
      return false
    }

    const descuentoIngresado = isVenta ? parseNumber(formData.descuento) : 0
    if (
      isVenta &&
      descuentoIngresado !== null &&
      (!Number.isFinite(descuentoIngresado) || descuentoIngresado < 0 || descuentoIngresado > 100)
    ) {
      notifyError('El descuento debe ser un porcentaje entre 0 y 100.')
      return false
    }

    if (isManualTransferMode) {
      if (reminderUsersLoading) {
        setActiveTab('notificacion')
        notifyError('Espera a que se carguen los usuarios para el recordatorio.')
        return false
      }
      if (!hasAdminReminderRecipients) {
        setActiveTab('notificacion')
        notifyError('No se pudo resolver un administrador para el recordatorio obligatorio.')
        return false
      }
      if (!hasAdditionalReminderRecipients) {
        setActiveTab('notificacion')
        notifyError('Debes seleccionar al menos un usuario adicional para el recordatorio.')
        return false
      }
    }

    if (isTraslado && !skipTransferConfirmation) {
      setIsTransferSendConfirmOpen(true)
      return false
    }

    // Muchos clientes migrados del sistema anterior no tienen cedula/RUC
    // guardada -- el backend ya no bloquea la venta por eso, pero antes de
    // crearla se le pregunta al usuario si quiere aprovechar y completarla
    // ahora (opcional). Solo se pregunta una vez por intento de envio.
    if (
      isVenta &&
      useExistingCliente &&
      selectedCliente?.id &&
      !String(selectedCliente?.cedula_ruc || '').trim() &&
      !skipCedulaPrompt
    ) {
      setCedulaPromptValue('')
      setShowCedulaPrompt(true)
      return false
    }

    setLoading(true)
    try {
      let ventaCliente = selectedCliente
      let ventaClienteLabel = String(formData.cliente || '').trim()

      if (isVenta) {
        if (useExistingCliente || useConsumidorFinal) {
          if (!ventaCliente?.id) {
            setActiveTab('cliente')
            throw new Error('Selecciona un cliente existente o usa "Crear nuevo cliente".')
          }
          ventaClienteLabel = formatClienteFieldValue(ventaCliente)

        }

        if (useNewCliente) {
          const clientePayload = normalizeClientePayload(clienteForm)
          const missingRequiredField = clienteRequiredFields.find((field) => !clientePayload[field])
          if (missingRequiredField) {
            setActiveTab('cliente')
            throw new Error('Completa todos los datos del nuevo cliente para continuar.')
          }

          const autosPayload = clienteAutos
            .map((a) => ({
              vin: String(a.vin || '').trim(),
              modelo: String(a.modelo || '').trim(),
              motor: String(a.motor || '').trim(),
              anio: a.anio ? Number(a.anio) : null,
            }))
            .filter((a) => a.vin || a.modelo || a.motor || a.anio)
          if (autosPayload.length) clientePayload.autos = autosPayload

          const createClienteResponse = await authFetch(
            `${API_URL}/solicitudes/clientes/`,
            {
              method: 'POST',
              body: JSON.stringify(clientePayload),
            },
            token
          )
          const createClienteData = await createClienteResponse.json().catch(() => ({}))
          if (!createClienteResponse.ok) {
            const detail = resolveApiErrorMessage(createClienteData, 'No se pudo crear el cliente.')
            setActiveTab('cliente')
            throw new Error(detail)
          }

          ventaCliente = createClienteData
          ventaClienteLabel =
            formatClienteFieldValue(createClienteData) ||
            formatClienteDropdownLabel(createClienteData) ||
            formatClienteFieldValue(clientePayload)

          setSelectedCliente(createClienteData)
          setClienteForm(normalizeClientePayload(createClienteData))
          setClienteQuery('')
          setClienteMode(CLIENT_MODE_EXISTING)
        }

        if (!useExistingCliente && !useNewCliente && !useConsumidorFinal) {
          setActiveTab('cliente')
          throw new Error('Selecciona como deseas asociar el cliente.')
        }

        if (!ventaClienteLabel) {
          setActiveTab('cliente')
          throw new Error('No se pudo resolver la información del cliente para la venta.')
        }
      }

      const descuento = isVenta ? Math.max(descuentoIngresado ?? 0, 0) : 0
      const ivaRate = parseNumber(formData.iva_rate)
      const payload = {
        sucursal_id: Number(formData.sucursalId),
        tipo_movimiento_id: Number(salidaTipoId),
        sub_tipo_movimiento_id: Number(formData.subTipoId),
        solicitud_traslado_id: solicitudIdValue ? Number(solicitudIdValue) : null,
        recipients_ids: isManualTransferMode
          ? [
              ...adminReminderRecipients.map((r) => normalizeReminderId(r?.id)).filter(Boolean).map(Number).filter(Boolean),
              ...selectedReminderUserIds.map(Number).filter(Boolean),
            ].filter((id, index, arr) => arr.indexOf(id) === index)
          : undefined,
        descripcion: buildDescripcion(ventaClienteLabel),
        factura_referencia: isVenta || isDevolucion || isTraslado ? String(formData.factura_referencia || '').trim() : '',
        ...(isTraslado ? { tipo_envio: formData.tipo_envio } : {}),
        funcional: true,
        sucursal_objetivo_id: requiresSucursalObjetivo ? Number(formData.sucursalObjetivoId) : null,
        estado_movimiento_id: Number(estadoMovimientoId),
        descuento,
        fecha: formData.fecha,
        no_documento: formData.no_documento.trim(),
        detalles: details.map((detail) => ({
          producto_id: Number(detail.productoId),
          cantidad: detail.cantidad,
          estado_producto_id: Number(detail.estadoProductoId),
          valor: detail.valor,
          valor_total: detail.valor_total,
        })),
      }

      if (ivaRate !== null) {
        payload.iva_rate = ivaRate
      }

      if (isVenta) {
        setFormData((prev) => ({ ...prev, cliente: ventaClienteLabel }))
        const tipoPago = String(formData.tipo_pago || '').trim()
        if (tipoPago) payload.tipo_pago = tipoPago
      }

      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = resolveApiErrorMessage(data, 'No se pudo crear la salida.')
        throw new Error(detail)
      }

      if (transferRequiresRequest && (selectedSolicitudTraslado || data?.solicitud)) {
        if (data?.reminders_sync_required) {
          await fetchRemindersFromBackend(token)
        } else {
          await appendTransferShipmentReminder(data?.solicitud || selectedSolicitudTraslado)
        }
      } else if (data?.reminders_sync_required) {
        await fetchRemindersFromBackend(token)
      }

      if (isManualTransferMode && solicitudIdValue) {
        // Se estaba terminando (enviando de verdad) un traslado directo que
        // veniamos editando desde un borrador guardado. El envio real crea
        // su propia SolicitudTraslado (ya aprobada) -- hay que borrar la
        // vieja en GUARDADO para no dejarla duplicada y huerfana.
        try {
          await authFetch(
            `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(solicitudIdValue)}/`,
            { method: 'DELETE' },
            token
          )
        } catch {
          // No bloquea la creacion si esto falla; la salida real ya se
          // creo correctamente, solo quedaria el borrador viejo huerfano.
        }
      }

      onCreated?.(data)
      return true
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al crear la salida.')
      return false
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = (event, options = {}) => {
    event.preventDefault()
    setFormSubmitted(true)
    void submitSalida(options)
  }

  const hasUnsavedProgress = isManualTransferMode && (
    details.length > 0 ||
    Boolean(String(formData.sucursalObjetivoId || '').trim()) ||
    Boolean(String(formData.descripcion || '').trim()) ||
    selectedReminderUserIds.length > 0
  )

  const closeAllDropdowns = () => {
    setShowProductDropdown(false)
    setShowClienteDropdown(false)
  }

  // Salida a sucursal (traslado manual): su propio "¿Guardar cambios?" con
  // guardar como borrador. Cerrar la pestana tambien lo ofrece.
  useUnsavedChangesRegistration({
    dirty: Boolean(open) && hasUnsavedProgress,
    onSave: async () => {
      setFormSubmitted(true)
      return (await submitSalida({ guardarBorrador: true })) === true
    },
    label: 'Nueva salida a sucursal',
  })
  // Resto de salidas (venta, garantia...): no hay borrador; "guardar" seria
  // registrar la venta, asi que solo se pregunta antes de perder lo ingresado.
  const unsavedGuard = useUnsavedChangesGuard({
    watch: { formData, details },
    enabled: Boolean(open) && !isManualTransferMode,
    onClose,
    label: 'Nueva salida',
  })

  const attemptClose = () => {
    if (loading) return
    if (hasUnsavedProgress) {
      closeAllDropdowns()
      setShowCloseConfirm(true)
      return
    }
    unsavedGuard.requestClose()
  }

  const handleConfirmTransferSend = () => {
    if (loading) return
    setIsTransferSendConfirmOpen(false)
    void submitSalida({ skipTransferConfirmation: true })
  }

  const handleSkipCedulaPrompt = () => {
    if (savingCedulaPrompt) return
    setShowCedulaPrompt(false)
    void submitSalida({ skipCedulaPrompt: true })
  }

  const handleSaveCedulaAndContinue = async () => {
    const cedula = cedulaPromptValue.trim()
    if (!cedula || !selectedCliente?.id) {
      handleSkipCedulaPrompt()
      return
    }
    setSavingCedulaPrompt(true)
    try {
      const response = await authFetch(
        `${API_URL}/solicitudes/clientes/${selectedCliente.id}/`,
        { method: 'PATCH', body: JSON.stringify({ cedula_ruc: cedula }) },
        token
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(resolveApiErrorMessage(data, 'No se pudo guardar la cédula/RUC.'))
      }
      setSelectedCliente(data)
      setShowCedulaPrompt(false)
      void submitSalida({ skipCedulaPrompt: true })
    } catch (err) {
      notifyError(err?.message || 'No se pudo guardar la cédula/RUC.')
    } finally {
      setSavingCedulaPrompt(false)
    }
  }

  const openTransferCancelModal = () => {
    if (!isTraslado || !formData.solicitudTrasladoId) return
    setTransferCancelReason('')
    setTransferCancelReasonError('')
    setIsTransferCancelModalOpen(true)
  }

  const closeTransferCancelModal = () => {
    if (transferCancelSubmitting) return
    setTransferCancelReasonError('')
    setIsTransferCancelModalOpen(false)
  }

  const handleConfirmTransferCancel = async () => {
    if (transferCancelSubmitting) return

    const solicitudId = String(formData.solicitudTrasladoId || '').trim()
    if (!solicitudId) {
      setTransferCancelReasonError('No se encontró la solicitud de traslado a cancelar.')
      return
    }

    const motivo = String(transferCancelReason || '').trim()
    if (!motivo) {
      setTransferCancelReasonError('Debes indicar el motivo de cancelación.')
      return
    }

    setTransferCancelSubmitting(true)
    setTransferCancelReasonError('')

    try {
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(solicitudId)}/cancelar-envio/`,
        {
          method: 'POST',
          body: JSON.stringify({ motivo }),
        },
        token
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = resolveApiErrorMessage(data, 'No se pudo cancelar el envío.')
        throw new Error(detail)
      }

      appendTransferCancellationReminder(data?.solicitud || selectedSolicitudTraslado, motivo)
      setIsTransferCancelModalOpen(false)
      if (typeof onTransferCancelled === 'function') {
        onTransferCancelled(data)
      } else {
        onClose?.()
      }
    } catch (error) {
      const message = error?.message || 'No se pudo cancelar el envío.'
      setTransferCancelReasonError(message)
    } finally {
      setTransferCancelSubmitting(false)
    }
  }

  const { shouldRender, isClosing } = useModalAnimation(open)

  if (!shouldRender) return null

  const overlayStyle = { padding: `${VIEWPORT_PADDING}px` }
  const modalStyle = {
    top: modalPosition.y,
    left: modalPosition.x,
    width: modalSize.width,
    height: modalSize.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
  }
  const modalClassName = [
    'create-user__modal',
    'create-salida__modal',
    isClosing ? 'create-user__modal--closing' : '',
    isResizingModal ? 'create-salida__modal--resizing' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const transferSubmitLabel = isTraslado
    ? `Enviar a ${transferTargetBranchButtonLabel}`
    : isDevolucion
      ? 'Solicitar garantía'
      : 'Crear salida'
  const transferSummaryLabel = selectedSolicitudDoc || formData.solicitudTrasladoId || 'N/A'
  const defaultHeaderTitle = 'Nueva salida'
  const rawHeaderDocumentTitle = String(formData.no_documento || '').trim()
  const headerSubTipoLabel = isVenta ? 'cliente' : isTraslado ? 'sucursal' : isDevolucion ? 'garantía' : ''
  const headerDocumentTitle = headerSubTipoLabel
    ? `Nueva salida ${headerSubTipoLabel}: ${rawHeaderDocumentTitle || '-'}`
    : rawHeaderDocumentTitle
  const headerTitle = !isSelectorStep && headerSubTipoLabel ? headerDocumentTitle : defaultHeaderTitle

  return (
    <div
      className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`}
      role="dialog"
      aria-modal="true"
      style={overlayStyle}
    >
      {unsavedGuard.dialog}
      <div ref={modalRef} {...unsavedGuard.interactionProps} className={modalClassName} style={modalStyle}>
        {catalogsLoading && (
          <div className="create-user__modal-loading">
            <div className="spinner" />
            <small className="muted">Cargando opciones...</small>
          </div>
        )}
        <header className="create-user__header" onMouseDown={handleModalMouseDown}>
          <div className="create-user__header-text">
            <div className="create-salida__header-title-group">
              <h3>{headerTitle}</h3>
            </div>
          </div>
          <div className="create-user__header-actions">
            <button
              type="button"
              className="create-user__icon-button create-user__icon-button--maximize"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={toggleMaximize}
              aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
            >
              <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="create-user__icon-button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={attemptClose}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <form className="create-user__form create-user__form--create" noValidate onSubmitCapture={(event) => event.currentTarget.classList.add('create-user__form--submitted')} onSubmit={handleSubmit}>
          {!formData.subTipoId ? (
            <div className="create-salida__selector-shell">
              <section className="create-user__section create-salida__selector-card">
                <div className="create-user__section-header">
                  <div>
                    <h4>Selecciona tipo de salida</h4>
                  </div>
                </div>
                <div className="create-salida__selector-inner">
                  <div className="create-user__field create-user__field--required create-salida__selector-field">
                    <SubTipoButtonSelector
                      ariaLabel="Tipo de salida"
                      options={salidaSubTipoOptions}
                      value={formData.subTipoId}
                      onChange={handleSubTipoSelect}
                      disabled={loading}
                      movimientoLabel="salida"
                    />
                  </div>
                </div>
              </section>
            </div>
          ) : (
            <>
              {(isVenta || isManualTransferMode) && (
                <div className="create-user__tabs create-salida__tabs" role="tablist" aria-label="Secciones de salida">
                  <button
                    type="button"
                    className={`create-user__tab ${activeTab === 'general' ? 'create-user__tab--active' : ''}`}
                    onClick={() => setActiveTab('general')}
                  >
                    Datos de salida
                  </button>
                  {isVenta && (
                    <button
                      type="button"
                      className={`create-user__tab ${activeTab === 'cliente' ? 'create-user__tab--active' : ''}`}
                      onClick={() => setActiveTab('cliente')}
                    >
                      Datos del cliente
                    </button>
                  )}
                  {isManualTransferMode && (
                    <button
                      type="button"
                      className={`create-user__tab ${activeTab === 'notificacion' ? 'create-user__tab--active' : ''}`}
                      onClick={() => setActiveTab('notificacion')}
                    >
                      Recordatorio
                    </button>
                  )}
                </div>
              )}

              <div className="create-user__content create-salida__content">
              <div className="create-user__body">
                {isTraslado && documentLoading && (
                  <div className="create-salida__loading-overlay" aria-live="polite">
                    <div className="create-salida__loading-content">
                      <Loader2 size={18} className="create-salida__loading-icon" />
                      <span>Preparando la información...</span>
                    </div>
                  </div>
                )}
                {(activeTab === 'general' || (!isVenta && !isManualTransferMode) || (isManualTransferMode && activeTab === 'general')) && (
                  <>
                    <section className="create-user__section">
                      <div className="create-user__section-header">
                        <div>
                          <p className="create-user__eyebrow">Datos</p>
                          <h4>Informacion general</h4>
                        </div>
                        {!isVenta && (
                          <span className="create-salida__static-value">{formattedFecha || '-'}</span>
                        )}
                      </div>

                      <div className="create-salida__field-groups">
                          <div className="create-salida__field-group create-salida__field-group--defined create-salida__field-group--paired">
                            <div
                              className={`create-user__grid create-user__grid--${isTraslado ? 'four' : isVenta ? 'three' : 'two'}${
                                isPrefilledTransfer ? ' create-salida__prefill-grid' : ''
                              }`}
                            >
                              {!isVenta && isSucursalPrincipalLocked && (
                                <StaticFieldDisplay
                                  label={isTraslado ? 'Sucursal proveedora' : 'Sucursal'}
                                  value={selectedSucursalName}
                                />
                              )}

                              {(isDevolucion || isTraslado) && (
                                <label className="create-user__field create-user__field--required">
                                  <span>No. de Factura</span>
                                  <input
                                    name="factura_referencia"
                                    type="text"
                                    value={formData.factura_referencia}
                                    onChange={handleChange}
                                    disabled={loading}
                                    required
                                  />
                                </label>
                              )}

                              {!isVenta && requiresSucursalObjetivo &&
                                (isPrefilledTransfer || (transferRequiresRequest && selectedObjetivoBranchName)) && (
                                  <StaticFieldDisplay
                                    label="Sucursal destino"
                                    value={selectedObjetivoBranchName}
                                  />
                                )}

                              {!isVenta && requiresSucursalObjetivo &&
                                !(isPrefilledTransfer || (transferRequiresRequest && selectedObjetivoBranchName)) && (
                                  <label className="create-user__field">
                                    <span>Sucursal destino</span>
                                    <select
                                      name="sucursalObjetivoId"
                                      value={formData.sucursalObjetivoId}
                                      onChange={handleChange}
                                      disabled={loading || transferRequiresRequest}
                                      required={requiresSucursalObjetivo}
                                    >
                                      <option value="">Selecciona una sucursal</option>
                                      {transferDestinationBranches.map((branch) => (
                                        <option key={branch.id} value={branch.id}>
                                          {branch.nombre || `Sucursal ${branch.id}`}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                )}

                              {isTraslado && (
                                <label className="create-user__field create-user__field--required">
                                  <span>Tipo de salida</span>
                                  <select
                                    name="tipo_envio"
                                    value={formData.tipo_envio || ''}
                                    onChange={handleChange}
                                    disabled={loading}
                                    required
                                    className={formSubmitted && !formData.tipo_envio ? 'create-salida__input--invalid' : undefined}
                                  >
                                    <option value="" disabled>Selecciona un tipo</option>
                                    {TIPO_ENVIO_OPTIONS.map((option) => (
                                      <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                  </select>
                                </label>
                              )}

                              {isVenta && (
                                <>
                                  <label className="create-user__field create-user__field--required">
                                    <span>No. de Factura</span>
                                    <div>
                                      <input
                                        name="factura_referencia"
                                        type="text"
                                        value={formData.factura_referencia}
                                        onChange={handleChange}
                                        disabled={loading}
                                        required
                                      />
                                      {documentHelperText && (
                                        <small className={documentHelperTone === 'error' ? 'create-user__field-error' : 'muted'}>
                                          {documentHelperText}
                                        </small>
                                      )}
                                    </div>
                                  </label>

                                  <label className="create-user__field create-user__field--required">
                                    <span>Tipo de pago</span>
                                    <div className="create-user__dropdown" ref={tipoPagoDropdownRef}>
                                      <button
                                        ref={tipoPagoTriggerRef}
                                        type="button"
                                        className={`create-user__dropdown-trigger${!formData.tipo_pago ? ' create-salida__cliente-trigger--placeholder' : ''}${formSubmitted && !formData.tipo_pago ? ' create-salida__input--invalid' : ''}`}
                                        onClick={() => {
                                          if (!showTipoPagoDropdown) updateTipoPagoDropdownPosition()
                                          setShowTipoPagoDropdown((prev) => !prev)
                                        }}
                                        disabled={loading}
                                        aria-haspopup="listbox"
                                        aria-expanded={showTipoPagoDropdown}
                                      >
                                        <span>{formData.tipo_pago || 'Seleccionar tipo de pago'}</span>
                                        <i className={`pi pi-chevron-${showTipoPagoDropdown ? 'up' : 'down'}`} />
                                      </button>
                                    </div>
                                    {showTipoPagoDropdown && createPortal(
                                      <div
                                        ref={tipoPagoPanelRef}
                                        className="create-user__dropdown-panel create-salida__cliente-panel"
                                        style={tipoPagoDropdownStyle}
                                      >
                                        <div className="create-user__dropdown-results">
                                          {TIPO_PAGO_OPTIONS.map((opt) => (
                                            <button
                                              key={opt}
                                              type="button"
                                              className="create-user__result-option"
                                              onMouseDown={(e) => e.preventDefault()}
                                              onClick={() => {
                                                setError('')
                                                setFormData((prev) => ({ ...prev, tipo_pago: opt }))
                                                setShowTipoPagoDropdown(false)
                                              }}
                                            >
                                              <div className="create-user__result-info">
                                                <strong>{opt}</strong>
                                              </div>
                                              {formData.tipo_pago === opt && (
                                                <span className="create-user__result-tag is-selected">Seleccionado</span>
                                              )}
                                            </button>
                                          ))}
                                        </div>
                                      </div>,
                                      getAppPortalRoot()
                                    )}
                                  </label>

                                  <label className="create-user__field">
                                    <span>Fecha</span>
                                    <input
                                      name="fecha"
                                      type="date"
                                      value={formData.fecha}
                                      onChange={handleChange}
                                      disabled={loading}
                                      required
                                    />
                                  </label>
                                </>
                              )}
                            </div>
                          </div>

                        <div
                          className={`create-user__grid create-user__grid--two${
                            isPrefilledTransfer ? ' create-salida__prefill-grid' : ''
                          }`}
                        >
                          {!isSucursalPrincipalLocked && (
                            <label className="create-user__field">
                              <span>{isTraslado ? 'Sucursal proveedora' : 'Sucursal'}</span>
                              <select
                                name="sucursalId"
                                value={formData.sucursalId}
                                onChange={handleChange}
                                disabled={loading || isSucursalPrincipalLocked}
                                required
                              >
                                <option value="">Selecciona una sucursal</option>
                                {branches.map((branch) => (
                                  <option key={branch.id} value={branch.id}>
                                    {branch.nombre || `Sucursal ${branch.id}`}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}

                    {isPrefilledTransfer && <input type="hidden" name="solicitudTrasladoId" value={formData.solicitudTrasladoId} />}
                        </div>
                      </div>
                    </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Detalle</p>
                      <h4>Listado de productos</h4>
                    </div>
                  </div>

                  {missingEstadoProducto && (
                    <BlockerNotice
                      title="No se pueden agregar productos: no hay estado de producto configurado"
                      reason="El catálogo de estados de producto está vacío y cada producto de la salida necesita uno. Pide al administrador que cree al menos un estado de producto (por ejemplo, «Enviado»)."
                    />
                  )}
                  {stockLoadError && requiresStockValidation && hasSelectedSucursal && (
                    <BlockerNotice
                      title={`No se pudo cargar el stock de ${selectedSucursalName || 'la sucursal seleccionada'}`}
                      reason="Sin el inventario de la sucursal todos los productos aparecen sin stock y no se pueden agregar. Revisa tu conexión y vuelve a intentarlo."
                      actionLabel="Reintentar"
                      onAction={retryStockLoad}
                    />
                  )}

                  <div className={`create-user__locations-table create-salida__products-table${!isPrefilledTransfer ? ' create-salida__products-table--with-actions' : ''}`}>
                      <div className="create-user__locations-row create-user__locations-row--head">
                        <span>Código</span>
                        <span>Descripción</span>
                        <span>Cantidad</span>
                        <span>Precio</span>
                        <span>Precio total</span>
                        {!isPrefilledTransfer && <span>Acciones</span>}
                      </div>

                    {!isPrefilledTransfer && (
                      <div className="create-user__locations-row create-user__locations-row--form">
                      <span className="create-salida__product-picker create-salida__product-code-cell">
                        <div className="create-user__dropdown create-salida__product-dropdown" ref={productDropdownRef}>
                          <button
                            type="button"
                            className="create-user__dropdown-trigger"
                            ref={productDropdownTriggerRef}
                            disabled={
                              loading ||
                              transferRequiresRequest ||
                              !hasSelectedSucursal
                            }
                            title={
                              !hasSelectedSucursal
                                ? 'Selecciona una sucursal primero.'
                                : (
                                  transferRequiresRequest
                                    ? 'Selecciona una solicitud de traslado.'
                                    : undefined
                                )
                            }
                            onClick={() => {
                              if (
                                !hasSelectedSucursal ||
                                transferRequiresRequest
                              ) {
                                return
                              }
                              const isOpening = !showProductDropdown
                              if (isOpening) {
                                setProductDropdownMaxHeight(null)
                                setProductQuery('')
                                setProductOptions([])
                                if (requiresStockValidation && formData.sucursalId) {
                                  fetchStockByBranch(formData.sucursalId, { force: true })
                                }
                                requestAnimationFrame(() => {
                                  updateProductDropdownPlacement()
                                })
                              }
                              setShowProductDropdown((prev) => !prev)
                            }}
                          >
                            <span>
                              {selectedDraftProduct
                                ? formatProductoTriggerLabel(selectedDraftProduct)
                                : 'Selecciona un producto'}
                            </span>
                            {selectedDraftProduct && requiresStockValidation && (
                              <span
                                className={`create-salida__trigger-stock${
                                  selectedDraftRemainingStock === 0 && detailProductIdSet.has(String(selectedDraftProduct.id))
                                    ? ' is-depleted-added'
                                    : ''
                                }`}
                              >
                                {selectedDraftRemainingStock}
                              </span>
                            )}
                            <i className={`pi pi-chevron-${showProductDropdown ? 'up' : 'down'}`} />
                          </button>

                          {showProductDropdown && createPortal(
                            <div
                              ref={productDropdownPanelRef}
                              className="create-user__dropdown-panel create-salida__product-panel"
                              style={productDropdownStyle}
                            >
                              <div className="create-user__dropdown-search">
                                <i className="pi pi-search" />
                                <input
                                  type="text"
                                  placeholder={
                                    !hasSelectedSucursal
                                      ? 'Selecciona una sucursal primero'
                                      : (
                                        transferRequiresRequest
                                          ? 'Selecciona una solicitud de traslado'
                                          : 'Buscar productos'
                                      )
                                  }
                                  value={productQuery}
                                  onChange={(event) => setProductQuery(event.target.value)}
                                  onPaste={(event) => {
                                    const text = event.clipboardData?.getData('text') || ''
                                    if (!isBulkProductPasteText(text)) return
                                    event.preventDefault()
                                    handleBulkAddProducts(text)
                                  }}
                                  autoFocus
                                  disabled={
                                    transferRequiresRequest ||
                                    !hasSelectedSucursal
                                  }
                                />
                              </div>

                              <div
                                className="create-user__dropdown-results"
                                style={
                                  productDropdownMaxHeight
                                    ? { maxHeight: `${Math.max(productDropdownMaxHeight - 72, 84)}px` }
                                    : undefined
                                }
                              >
                                {productLoading && <small className="muted">Buscando productos...</small>}
                                {!productLoading && requiresStockValidation && stockLoading && (
                                  <small className="muted">Cargando inventario de la sucursal...</small>
                                )}
                                {!hasSelectedSucursal && !productLoading && (
                                  <small className="muted">Selecciona una sucursal para buscar productos.</small>
                                )}
                                {!productLoading && productQuery.trim() && !productOptions.length && (
                                  <small className="muted">Sin resultados.</small>
                                )}
                                {!productLoading && !stockLoading && requiresStockValidation && stockLoadError && hasSelectedSucursal && (
                                  <BlockerNotice
                                    compact
                                    title={`No se pudo cargar el stock de ${selectedSucursalName || 'la sucursal seleccionada'}`}
                                    reason="Por eso todos los productos aparecen sin stock."
                                    actionLabel="Reintentar"
                                    onAction={retryStockLoad}
                                  />
                                )}
                                {!productLoading &&
                                  !stockLoading &&
                                  requiresStockValidation &&
                                  !stockLoadError &&
                                  productOptions.length > 0 &&
                                  productOptions.every((producto) => !(Number(stockByProduct[String(producto.id)] ?? 0) > 0)) && (
                                  <BlockerNotice
                                    compact
                                    title={`Ningún resultado tiene stock en ${selectedSucursalName || 'la sucursal seleccionada'}`}
                                    reason="Para venderlo o sacarlo, primero regístralo con una entrada o un traslado."
                                  />
                                )}
                                {productOptions.length > 0 && (
                                  <div className="create-salida__results-header">
                                    <span>Código</span>
                                    <span>Descripción</span>
                                    <span>Cantidad</span>
                                  </div>
                                )}
                                {productOptions.map((producto) => {
                                  const normalizedProductId = String(producto.id || '').trim()
                                  const isSelected = normalizedProductId === String(detailDraft.productoId || '').trim()
                                  const isAlreadyAdded = detailProductIdSet.has(normalizedProductId)
                                  const addedQtyRaw = isAlreadyAdded
                                    ? parseIntValue(
                                        details.find((detail) => String(detail.productoId) === normalizedProductId)?.cantidad
                                      )
                                    : 0
                                  const addedQty = Number.isFinite(addedQtyRaw) ? addedQtyRaw : 0
                                  const available = Number(stockByProduct[String(producto.id)] ?? 0)
                                  const remainingAvailable = requiresStockValidation
                                    ? Math.max((Number.isFinite(available) ? available : 0) - addedQty, 0)
                                    : available
                                  const isZeroStock = requiresStockValidation && remainingAvailable === 0
                                  const codigo = String(producto?.codigo || '').trim() || `ID ${producto.id}`
                                  const nombre = String(producto?.nombre || '').trim()
                                  const dispLabel = requiresStockValidation
                                    ? String(remainingAvailable)
                                    : String(Number(producto?.total_stock ?? 0))
                                  return (
                                    <button
                                      key={producto.id}
                                      type="button"
                                      className={`create-salida__result-row${isSelected ? ' is-selected' : ''}${isAlreadyAdded ? ' is-added' : ''}${isZeroStock ? ' is-zero-stock' : ''}${isZeroStock && isAlreadyAdded ? ' is-depleted-added' : ''}`}
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={(event) => {
                                        event.preventDefault()
                                        event.stopPropagation()
                                        if (isZeroStock) return
                                        handleProductSelect(producto)
                                      }}
                                      disabled={isZeroStock}
                                      title={
                                        isZeroStock
                                          ? (isAlreadyAdded
                                              ? `Ya agregaste todo el stock disponible (cantidad: ${addedQty})`
                                              : 'Sin stock disponible')
                                          : isAlreadyAdded
                                            ? `Ya agregado (cantidad: ${addedQty})`
                                            : undefined
                                      }
                                    >
                                      <span className="result-codigo">
                                        {codigo}
                                        {isAlreadyAdded && (
                                          <span className="create-salida__result-added-badge">
                                            en esta salida: {Number.isFinite(addedQty) ? addedQty : 0}
                                          </span>
                                        )}
                                      </span>
                                      <span className="result-nombre">{nombre || '-'}</span>
                                      <span className="result-stock">{dispLabel}</span>
                                    </button>
                                  )
                                })}
                              </div>
                            </div>,
                            getAppPortalRoot()
                          )}
                        </div>
                      </span>
                      <span className="create-salida__product-name-cell">
                        <span
                          className="create-salida__table-static-value create-salida__table-static-value--name"
                          title={selectedDraftProductName || undefined}
                        >
                          {selectedDraftProductName || '-'}
                        </span>
                      </span>
                      <span>
                        <input
                          name="cantidad"
                          type="number"
                          min="1"
                          step="1"
                          value={detailDraft.cantidad}
                          onChange={handleDetailChange}
                          disabled={loading || transferRequiresRequest || (requiresStockValidation && stockLoading)}
                        />
                      </span>
                      <span>
                        <span className="create-salida__table-static-value">
                          {detailDraft.valor || '-'}
                        </span>
                      </span>
                      <span>
                        <span className="create-salida__table-static-value">
                          {draftLineTotal !== null ? draftLineTotal.toFixed(2) : '-'}
                        </span>
                      </span>
                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button
                          type="button"
                          className="create-user__ghost create-salida__ghost--add"
                          onClick={handleAddDetail}
                          disabled={loading || transferRequiresRequest || (requiresStockValidation && stockLoading)}
                        >
                          Agregar
                        </button>
                      </span>
                      </div>
                    )}

                    {!details.length && (
                      <div className="create-user__locations-row create-user__locations-row--empty">
                        <span>Sin productos agregados.</span>
                      </div>
                    )}

                    {details.map((detail) => (
                      <div key={detail.uid} className="create-user__locations-row">
                        <span>{detail.productoCodigo || '-'}</span>
                        <span
                          onMouseEnter={(e) => showHover(e, [detail.productoNombre].filter(Boolean), 'Descripción')}
                          onMouseLeave={hideHover}
                        >
                          <span className="create-salida__product-name-text">{detail.productoNombre || '-'}</span>
                        </span>
                        <span>{detail.cantidad}</span>
                        <span className="create-salida__numeric">{formatCurrency(detail.valor)}</span>
                        <span className="create-salida__numeric">{formatCurrency(detail.valor_total)}</span>
                        {!isPrefilledTransfer && (
                          <span className="create-user__locations-cell create-user__locations-cell--action">
                            <button
                              type="button"
                              className="create-user__locations-remove"
                              onClick={() => handleRemoveDetail(detail.uid)}
                              disabled={loading || transferRequiresRequest}
                            >
                              x
                            </button>
                          </span>
                        )}
                      </div>
                    ))}

                    <div className="create-user__locations-row create-salida__totals-row">
                      <span className="create-salida__totals-label">{isTraslado ? 'Total' : 'Subtotal'}</span>
                      <span className="create-salida__totals-value">{formatCurrency(subtotalConBorrador)}</span>
                    </div>

                    {isVenta && (
                      <div className="create-user__locations-row create-salida__totals-row">
                        <span className="create-salida__totals-label">
                          Descuento&nbsp;(
                          <input
                            name="descuento"
                            type="text"
                            inputMode="decimal"
                            value={descuentoRawInput}
                            onChange={handleDescuentoChange}
                            onFocus={handleDescuentoFocus}
                            onBlur={handleDescuentoBlur}
                            disabled={loading}
                            className="create-salida__discount-inline-input"
                          />
                          %)
                        </span>
                        <span className="create-salida__totals-value">-{formatCurrency(descuentoAplicado)}</span>
                      </div>
                    )}

                    {!isTraslado && (
                      <div className="create-user__locations-row create-salida__totals-row create-salida__totals-row--strong">
                        <span className="create-salida__totals-label">Total con IVA ({ivaPercent}%)</span>
                        <span className="create-salida__totals-value">
                          {isVenta && subtotalConBorrador > 0 ? (
                            <input
                              type="text"
                              inputMode="decimal"
                              value={totalRawInput}
                              onFocus={handleTotalFocus}
                              onChange={handleTotalChange}
                              onBlur={handleTotalBlur}
                              disabled={loading}
                              className="create-salida__total-inline-input"
                            />
                          ) : (
                            <strong>{formatCurrency(totalConIva)}</strong>
                          )}
                        </span>
                      </div>
                    )}
                  </div>

                </section>

                <section className="create-user__section">
                  <label className={`create-user__field create-user__field--full${isDevolucion ? ' create-user__field--required' : ''}`}>
                    <span>Nota</span>
                    <textarea
                      name="descripcion"
                      value={formData.descripcion}
                      onChange={handleChange}
                      disabled={loading}
                      rows={3}
                      required={isDevolucion}
                      placeholder={
                        isTraslado
                          ? 'Escribe detalles de cómo vas a enviar esta salida, la forma de empacar, el vehículo o lo que creas necesario.'
                          : undefined
                      }
                    />
                  </label>
                </section>
                  </>
                )}

                {isVenta && activeTab === 'cliente' && (
                  <section className="create-user__section">
                    <div className="create-user__section-header">
                      <div>
                        <p className="create-user__eyebrow">Cliente</p>
                        <h4>Datos del cliente</h4>
                      </div>
                    </div>

                    <div className="create-user__grid create-user__grid--two">
                      <div className="create-user__field create-user__field--full">
                        <span>Modo de cliente</span>
                        <div className="create-salida__cliente-mode">
                          <button
                            type="button"
                            className={`create-user__ghost create-salida__cliente-mode-btn ${
                              useExistingCliente ? 'is-active' : ''
                            }`}
                            onClick={handleUseExistingCliente}
                            disabled={loading}
                          >
                            Seleccionar existente
                          </button>
                          <button
                            type="button"
                            className={`create-user__ghost create-salida__cliente-mode-btn ${
                              useNewCliente ? 'is-active' : ''
                            }`}
                            onClick={handleCreateNewCliente}
                            disabled={loading}
                          >
                            Crear nuevo cliente
                          </button>
                          <button
                            type="button"
                            className={`create-user__ghost create-salida__cliente-mode-btn ${
                              useConsumidorFinal ? 'is-active' : ''
                            }`}
                            onClick={handleUseConsumidorFinal}
                            disabled={loading}
                          >
                            Consumidor final
                          </button>
                        </div>
                      </div>

                      {consumidorFinalMissing && !useConsumidorFinal && (
                        <BlockerNotice
                          compact
                          className="create-user__field--full"
                          title="No se puede usar Consumidor Final"
                          reason={`No existe el cliente con cédula ${CONSUMIDOR_FINAL_CEDULA}. Créalo en Clientes (o pide al administrador que lo cree) y vuelve a intentarlo.`}
                          goTo="Clientes"
                        />
                      )}

                      {useExistingCliente && (
                        <label className="create-user__field create-user__field--full">
                          <span>Cliente</span>
                          <div className="create-user__dropdown create-salida__cliente-dropdown" ref={clienteDropdownRef}>
                            <button
                              type="button"
                              ref={clienteDropdownTriggerRef}
                              className={`create-user__dropdown-trigger${
                                !selectedClienteLabel ? ' create-salida__cliente-trigger--placeholder' : ''
                              }${
                                formSubmitted && !String(selectedCliente?.cedula_ruc || '').trim()
                                  ? ' create-salida__input--invalid'
                                  : ''
                              }`}
                              onClick={handleClienteDropdownToggle}
                              disabled={loading}
                              aria-haspopup="listbox"
                              aria-expanded={showClienteDropdown}
                            >
                              <span>{selectedClienteLabel || 'Selecciona un cliente'}</span>
                              <i className={`pi pi-chevron-${showClienteDropdown ? 'up' : 'down'}`} />
                            </button>
                            {showClienteDropdown && createPortal(
                              <div
                                ref={clienteDropdownPanelRef}
                                className="create-user__dropdown-panel create-salida__cliente-panel"
                                style={clienteDropdownStyle}
                              >
                                <div className="create-user__dropdown-search">
                                  <i className="pi pi-search" />
                                  <input
                                    type="text"
                                    placeholder="Buscar por cedula o nombre"
                                    value={clienteQuery}
                                    onChange={handleClienteQueryChange}
                                    disabled={loading}
                                    autoComplete="off"
                                    autoFocus
                                  />
                                </div>
                                <div className="create-user__dropdown-results">
                                  {clienteLoading && <small className="muted">Buscando cliente...</small>}
                                  {!clienteLoading && !clienteQuery.trim() && (
                                    <small className="muted">Escribe para buscar.</small>
                                  )}
                                  {!clienteLoading && clienteQuery.trim() && clienteQuery.trim().length < 2 && (
                                    <small className="muted">Escribe al menos 2 caracteres.</small>
                                  )}
                                  {!clienteLoading && clienteQuery.trim().length >= 2 && !clienteOptions.length && (
                                    <small className="muted">Sin resultados.</small>
                                  )}
                                  {clienteOptions.map((cliente) => {
                                    const optionLabel = resolveClienteNombre(cliente)
                                    const selected = String(selectedCliente?.id || '') === String(cliente?.id || '')
                                    return (
                                      <button
                                        key={cliente.id}
                                        type="button"
                                        className="create-user__result-option"
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => handleClienteSelect(cliente)}
                                      >
                                        <div className="create-user__result-info">
                                          <strong>{optionLabel || `Cliente ${cliente.id}`}</strong>
                                          <small>Cédula: {cliente.cedula_ruc || '-'}</small>
                                        </div>
                                        {selected && <span className="create-user__result-tag is-selected">Seleccionado</span>}
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>,
                              getAppPortalRoot()
                            )}
                          </div>
                        </label>
                      )}

                      {useNewCliente && (
                        <>
                          <label className="create-user__field">
                            <span>Cedula/RUC</span>
                            <input
                              name="cedula_ruc"
                              type="text"
                              value={clienteForm.cedula_ruc}
                              onChange={handleClienteFieldChange}
                              onBlur={handleCedulaBlur}
                              disabled={loading}
                              required
                            />
                          </label>

                          <label className="create-user__field">
                            <span>Nombres</span>
                            <input
                              name="nombres"
                              type="text"
                              value={clienteForm.nombres}
                              onChange={handleClienteFieldChange}
                              disabled={loading}
                              required
                            />
                          </label>

                          <label className="create-user__field">
                            <span>Apellidos</span>
                            <input
                              name="apellidos"
                              type="text"
                              value={clienteForm.apellidos}
                              onChange={handleClienteFieldChange}
                              disabled={loading}
                            />
                          </label>

                          <label className="create-user__field">
                            <span>Correo</span>
                            <input
                              name="correo"
                              type="email"
                              value={clienteForm.correo}
                              onChange={handleClienteFieldChange}
                              disabled={loading}
                            />
                          </label>

                          <label className="create-user__field">
                            <span>Telefono</span>
                            <input
                              name="telefono"
                              type="text"
                              value={clienteForm.telefono}
                              onChange={handleClienteFieldChange}
                              disabled={loading}
                            />
                          </label>

                          <label className="create-user__field create-user__field--full">
                            <span>Direccion</span>
                            <input
                              name="direccion"
                              type="text"
                              value={clienteForm.direccion}
                              onChange={handleClienteFieldChange}
                              disabled={loading}
                            />
                          </label>
                        </>
                      )}
                    </div>

                    {useNewCliente && (
                      <>
                        <div className="create-user__section-header" style={{ marginTop: 18 }}>
                          <div>
                            <p className="create-user__eyebrow">Autos</p>
                            <h4>Vehículos asociados <small className="muted">(opcional)</small></h4>
                          </div>
                        </div>

                        <div className="create-user__locations-table create-clientes__autos-table">
                          <div className="create-user__locations-row create-user__locations-row--head">
                            <span>VIN</span>
                            <span>Modelo</span>
                            <span>Motor</span>
                            <span>Año</span>
                            <span>Acciones</span>
                          </div>

                          <div className="create-user__locations-row create-user__locations-row--form">
                            <span>
                              <input type="text" placeholder="VIN" value={clienteAutoDraft.vin}
                                onChange={(e) => setClienteAutoDraft((p) => ({ ...p, vin: e.target.value }))} disabled={loading} />
                            </span>
                            <span>
                              <input type="text" placeholder="Modelo" value={clienteAutoDraft.modelo}
                                onChange={(e) => setClienteAutoDraft((p) => ({ ...p, modelo: e.target.value }))} disabled={loading} />
                            </span>
                            <span>
                              <input type="text" placeholder="Motor" value={clienteAutoDraft.motor}
                                onChange={(e) => setClienteAutoDraft((p) => ({ ...p, motor: e.target.value }))} disabled={loading} />
                            </span>
                            <span>
                              <input type="text" placeholder="Año" value={clienteAutoDraft.anio}
                                onChange={(e) => setClienteAutoDraft((p) => ({ ...p, anio: e.target.value }))} disabled={loading} />
                            </span>
                            <span className="create-user__locations-cell create-user__locations-cell--action">
                              <button type="button" className="create-user__ghost" onClick={handleAddClienteAuto} disabled={loading}>
                                Agregar
                              </button>
                            </span>
                          </div>

                          {!clienteAutos.length && (
                            <div className="create-user__locations-row create-user__locations-row--empty">
                              <span>Sin vehículos agregados.</span>
                            </div>
                          )}

                          {clienteAutos.map((auto, index) => (
                            <div key={`auto-sal-${index}`} className="create-user__locations-row">
                              <span>{auto.vin || '-'}</span>
                              <span>{auto.modelo || '-'}</span>
                              <span>{auto.motor || '-'}</span>
                              <span>{auto.anio || '-'}</span>
                              <span className="create-user__locations-cell create-user__locations-cell--action">
                                <button type="button" className="create-user__locations-remove"
                                  onClick={() => handleRemoveClienteAuto(index)} disabled={loading} aria-label="Eliminar vehículo">
                                  X
                                </button>
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {useExistingCliente && selectedCliente?.id && (
                      <>
                        <div className="create-user__section-header" style={{ marginTop: 18 }}>
                          <div>
                            <p className="create-user__eyebrow">Autos</p>
                            <h4>Vehículos del cliente <small className="muted">(opcional)</small></h4>
                          </div>
                        </div>

                        <div className="create-user__locations-table create-clientes__autos-table">
                          <div className="create-user__locations-row create-user__locations-row--head">
                            <span>Placa</span>
                            <span>Modelo</span>
                            <span>Año</span>
                            <span>Marca</span>
                            <span>Acciones</span>
                          </div>

                          <div className="create-user__locations-row create-user__locations-row--form">
                            <span>
                              <input type="text" placeholder="Placa" value={pendingClienteAutoDraft.placa}
                                onChange={(e) => setPendingClienteAutoDraft((p) => ({ ...p, placa: e.target.value }))} disabled={loading} />
                            </span>
                            <span>
                              <input type="text" placeholder="Modelo" value={pendingClienteAutoDraft.modelo}
                                onChange={(e) => setPendingClienteAutoDraft((p) => ({ ...p, modelo: e.target.value }))} disabled={loading} />
                            </span>
                            <span>
                              <input type="text" placeholder="Año" value={pendingClienteAutoDraft.anio}
                                onChange={(e) => setPendingClienteAutoDraft((p) => ({ ...p, anio: e.target.value }))} disabled={loading} />
                            </span>
                            <span>
                              <input type="text" placeholder="Marca (opcional)" value={pendingClienteAutoDraft.marca}
                                onChange={(e) => setPendingClienteAutoDraft((p) => ({ ...p, marca: e.target.value }))} disabled={loading} />
                            </span>
                            <span className="create-user__locations-cell create-user__locations-cell--action">
                              <button type="button" className="create-user__ghost" onClick={handleAutoAgregarClick} disabled={loading || savingAuto}>
                                Agregar
                              </button>
                            </span>
                          </div>

                          {!selectedClienteAutos.length && (
                            <div className="create-user__locations-row create-user__locations-row--empty">
                              <span>{fetchingClienteAutos ? 'Cargando vehículos...' : 'Sin vehículos registrados.'}</span>
                            </div>
                          )}

                          {selectedClienteAutos.map((auto, index) => (
                            <div key={`sel-auto-sal-${index}`} className="create-user__locations-row">
                              <span>{auto.placa || '-'}</span>
                              <span>{auto.modelo || '-'}</span>
                              <span>{auto.anio || '-'}</span>
                              <span>{auto.marca || '-'}</span>
                              <span />
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </section>
                )}

                {isManualTransferMode && activeTab === 'notificacion' && (
                  <section className="create-user__section">
                    <div className="create-user__section-header">
                      <div>
                        <p className="create-user__eyebrow">Recordatorio</p>
                        <h4>Usuarios a quienes recordar</h4>
                      </div>
                    </div>

                    <p className="create-salida__reminder-helper">
                      Al crear el envío se genera automáticamente un recordatorio para administradores y usuarios seleccionados.
                    </p>
                    <div className="create-salida__reminder-rule" role="note">
                      Solo se listan usuarios con permisos de <strong>crear y editar</strong> en{' '}
                      <strong>Movimientos - Salidas</strong> de la <strong>sucursal destino</strong>.
                    </div>

                    {!hasSelectedReminderTargetBranch && (
                      <small className="muted">Selecciona primero una sucursal destino para cargar usuarios.</small>
                    )}

                    <div className={`create-salida__reminder-block create-salida__reminder-block--matrix${hasSelectedReminderTargetBranch && !reminderUsersLoading && !hasAdminReminderRecipients ? ' create-salida__reminder-block--invalid' : ''}`}>
                      <div className="create-salida__reminder-head">
                        <h5>Administradores incluidos</h5>
                        <span className="create-salida__reminder-count">{adminReminderRows.length}</span>
                      </div>
                      {reminderUsersLoading ? (
                        <p className="muted">Cargando administradores...</p>
                      ) : (
                        <div className="create-salida__reminder-table-wrap">
                          <div className="permissions-matrix__table create-salida__reminder-table" role="grid">
                            <div className="permissions-matrix__row permissions-matrix__row--head">
                              <div className="permissions-matrix__cell permissions-matrix__cell--label">Usuario</div>
                              <div className="permissions-matrix__cell permissions-matrix__cell--label">Correo</div>
                              <div className="permissions-matrix__cell permissions-matrix__cell--action">Estado</div>
                            </div>

                            {adminReminderRows.map((recipient) => (
                              <div key={`salida-admin-recipient-${recipient.id}`} className="permissions-matrix__row">
                                <div className="permissions-matrix__cell permissions-matrix__cell--label">
                                  {recipient.name}
                                </div>
                                <div className="permissions-matrix__cell create-salida__reminder-email">
                                  {recipient.email || '-'}
                                </div>
                                <div className="permissions-matrix__cell permissions-matrix__cell--action">
                                  <span className="create-salida__reminder-badge">Incluido</span>
                                </div>
                              </div>
                            ))}

                            {!adminReminderRows.length && (
                              <div className="permissions-matrix__row create-salida__reminder-row--empty">
                                <div className="permissions-matrix__cell permissions-matrix__cell--label">
                                  No se detectaron administradores.
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      {hasSelectedReminderTargetBranch && !reminderUsersLoading && !reminderUsersError && !hasAdminReminderRecipients && (
                        <BlockerNotice
                          title="No se puede enviar el traslado: no hay un administrador para el recordatorio"
                          reason="El recordatorio del envío siempre incluye a un administrador y no se encontró ningún usuario administrador. Pide que se marque al menos un usuario como administrador en Administrar › Usuarios."
                          goTo="Administrar"
                        />
                      )}
                    </div>

                    <div className={`create-salida__reminder-block create-salida__reminder-block--matrix${hasSelectedReminderTargetBranch && !reminderUsersLoading && !hasAdditionalReminderRecipients ? ' create-salida__reminder-block--invalid' : ''}`}>
                      <div className="create-salida__reminder-head">
                        <h5>Usuarios adicionales</h5>
                        <span className="create-salida__reminder-count">{selectedReminderUserIds.length}</span>
                      </div>
                      {hasSelectedReminderTargetBranch && !reminderUsersLoading && reminderUsersError && (
                        <BlockerNotice
                          title="No se pudieron cargar los usuarios para el recordatorio"
                          reason="Sin la lista de usuarios no se puede elegir a quién recordar y el envío no se puede completar. Revisa tu conexión y vuelve a intentarlo."
                          actionLabel="Reintentar"
                          onAction={fetchReminderUsers}
                        />
                      )}
                      {hasSelectedReminderTargetBranch && !reminderUsersLoading && !reminderUsersError && !selectableReminderUsers.length && (
                        <BlockerNotice
                          title={`No se puede enviar el traslado a ${selectedObjetivoBranchName || 'esta sucursal'}: no hay usuarios para el recordatorio`}
                          reason={`El envío necesita al menos un usuario adicional que reciba el recordatorio, y ningún usuario tiene permiso de crear y editar en Movimientos - Salidas de ${selectedObjetivoBranchName || 'esta sucursal'}. Pide al administrador que asigne ese permiso a un usuario de la sucursal en Administrar › Usuarios › permisos.`}
                          goTo="Administrar"
                        />
                      )}
                      {hasSelectedReminderTargetBranch && !reminderUsersLoading && selectableReminderUsers.length > 0 && !hasAdditionalReminderRecipients && (
                        <small className="create-user__field-error">Debes seleccionar al menos un usuario adicional.</small>
                      )}
                      <div className="create-salida__reminder-table-wrap">
                        <div className="permissions-matrix__table create-salida__reminder-table" role="grid">
                          <div className="permissions-matrix__row permissions-matrix__row--head">
                            <div className="permissions-matrix__cell permissions-matrix__cell--label">Usuario</div>
                            <div className="permissions-matrix__cell permissions-matrix__cell--label">Correo</div>
                            <div className="permissions-matrix__cell permissions-matrix__cell--action">Incluir</div>
                          </div>

                          {!hasSelectedReminderTargetBranch && (
                            <div className="permissions-matrix__row create-salida__reminder-row--empty">
                              <div className="permissions-matrix__cell permissions-matrix__cell--label">
                                Debes seleccionar una sucursal destino.
                              </div>
                            </div>
                          )}

                          {hasSelectedReminderTargetBranch && !reminderUsersLoading && !selectableReminderUsers.length && (
                            <div className="permissions-matrix__row create-salida__reminder-row--empty">
                              <div className="permissions-matrix__cell permissions-matrix__cell--label">
                                Sin usuarios disponibles.
                              </div>
                            </div>
                          )}

                          {selectableReminderUsers.map((userItem) => {
                            const userId = normalizeReminderId(userItem?.id)
                            const checked = selectedReminderUserIds.includes(userId)
                            return (
                              <div key={`salida-reminder-user-${userId}`} className="permissions-matrix__row">
                                <div className="permissions-matrix__cell permissions-matrix__cell--label">
                                  {userItem.name || 'Usuario'}
                                </div>
                                <div className="permissions-matrix__cell create-salida__reminder-email">
                                  {userItem.email || '-'}
                                </div>
                                <label className="permissions-matrix__cell permissions-matrix__cell--action">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleReminderUser(userId)}
                                    disabled={loading || reminderUsersLoading || !hasSelectedReminderTargetBranch}
                                  />
                                </label>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  </section>
                )}
              </div>
            </div>
            </>
          )}

          {missingEstadoMovimiento && (
            <BlockerNotice
              className="create-salida__footer-blocker"
              title={`No se puede crear la salida: falta configurar el estado de movimiento «${expectedEstadoMovimientoName}»`}
              reason={`El catálogo de estados de movimiento no tiene un estado para este tipo de salida, y sin él no se puede registrar. Pide al administrador que configure el estado «${expectedEstadoMovimientoName}» en el catálogo de estados de movimiento.`}
            />
          )}

          <div className="create-user__footer">
            <button type="button" className="create-user__action create-user__action--cancel" onClick={attemptClose} disabled={loading}>
              Cancelar
            </button>
            <div className="create-salida__footer-actions">
              {formData.subTipoId && isTraslado && formData.solicitudTrasladoId && !isEditingGuardadoDraft && (
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary create-salida__action--danger"
                  onClick={openTransferCancelModal}
                  disabled={loading || transferCancelSubmitting}
                >
                  Cancelar envío
                </button>
              )}
              {formData.subTipoId && isManualTransferMode && (
                <button
                  type="button"
                  className="create-user__action create-user__action--info"
                  disabled={loading || !hasUnsavedProgress}
                  onClick={(event) => handleSubmit(event, { guardarBorrador: true })}
                >
                  {loading ? 'Guardando...' : 'Guardar'}
                </button>
              )}
              {formData.subTipoId && (
                <button
                  type="submit"
                  className="create-user__action create-user__action--primary"
                  disabled={loading || !resolvedEstadoMovimientoId}
                >
                  {loading ? 'Guardando...' : transferSubmitLabel}
                </button>
              )}
            </div>
          </div>
        </form>

        {showCloseConfirm && (
          <div
            className="create-salida__confirm-overlay"
            onMouseDown={() => { if (!loading) setShowCloseConfirm(false) }}
          >
            <div className="create-salida__confirm-card" onMouseDown={(event) => event.stopPropagation()}>
              <h4>¿Guardar cambios?</h4>
              <p>¿Quieres guardar los cambios antes de cerrar?</p>
              <div className="create-salida__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--cancel"
                  onClick={() => setShowCloseConfirm(false)}
                  disabled={loading}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary"
                  onClick={() => {
                    setShowCloseConfirm(false)
                    onClose?.()
                  }}
                  disabled={loading}
                >
                  No guardar
                </button>
                <button
                  type="button"
                  className="create-user__action create-user__action--info"
                  onClick={() => {
                    setShowCloseConfirm(false)
                    handleSubmit({ preventDefault: () => {} }, { guardarBorrador: true })
                  }}
                  disabled={loading}
                >
                  {loading ? 'Guardando...' : 'Guardar traslado y cerrar'}
                </button>
              </div>
            </div>
          </div>
        )}

        {autoConfirmData && (
          <div
            className="create-salida__confirm-overlay"
            onMouseDown={() => { if (!savingAuto) setAutoConfirmData(null) }}
          >
            <div className="create-salida__confirm-card" onMouseDown={(e) => e.stopPropagation()}>
              <h4>Agregar vehículo</h4>
              <p>
                ¿Agregar este vehículo al cliente{' '}
                <strong>
                  {String(selectedCliente?.nombre_completo || `${selectedCliente?.nombres || ''} ${selectedCliente?.apellidos || ''}`).trim() || `Cliente ${selectedCliente?.id}`}
                </strong>?
              </p>
              <p>
                <strong>
                  {[autoConfirmData.placa, autoConfirmData.modelo, autoConfirmData.anio, autoConfirmData.marca]
                    .filter(Boolean)
                    .join(' · ')}
                </strong>
              </p>
              <div className="create-salida__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary"
                  onClick={() => setAutoConfirmData(null)}
                  disabled={savingAuto}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={handleConfirmAddAuto}
                  disabled={savingAuto}
                >
                  {savingAuto ? 'Guardando...' : 'Sí, agregar'}
                </button>
              </div>
            </div>
          </div>
        )}

        {isTransferSendConfirmOpen && (
          <div
            className="create-salida__confirm-overlay"
            onMouseDown={() => {
              if (loading) return
              setIsTransferSendConfirmOpen(false)
            }}
          >
            <div className="create-salida__confirm-card" onMouseDown={(event) => event.stopPropagation()}>
              <h4>Confirmar envío</h4>
              <p>
                Vas a enviar la solicitud <strong>{transferSummaryLabel}</strong> de{' '}
                <strong>{transferSourceBranchLabel}</strong> a <strong>{transferTargetBranchLabel}</strong>.
              </p>
              <p className="create-salida__confirm-warning">
                Se restará el inventario y el traslado quedará en estado de envío.
              </p>
              <div className="create-salida__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary"
                  onClick={() => setIsTransferSendConfirmOpen(false)}
                  disabled={loading}
                >
                  Volver
                </button>
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={handleConfirmTransferSend}
                  disabled={loading}
                >
                  {loading ? 'Enviando...' : 'Confirmar envío'}
                </button>
              </div>
            </div>
          </div>
        )}

        {showCedulaPrompt && (
          <div
            className="create-salida__confirm-overlay"
            onMouseDown={() => {
              if (savingCedulaPrompt) return
              handleSkipCedulaPrompt()
            }}
          >
            <div className="create-salida__confirm-card" onMouseDown={(event) => event.stopPropagation()}>
              <h4>Cédula/RUC del cliente</h4>
              <p>
                <strong>{selectedClienteLabel || 'Este cliente'}</strong> no tiene cédula o RUC registrada
                (frecuente en clientes migrados del sistema anterior). Es opcional, pero si la tienes a
                mano puedes agregarla ahora.
              </p>
              <label className="create-user__field create-user__field--full">
                <span>Cédula/RUC (opcional)</span>
                <input
                  type="text"
                  value={cedulaPromptValue}
                  onChange={(event) => setCedulaPromptValue(event.target.value)}
                  disabled={savingCedulaPrompt}
                  autoFocus
                />
              </label>
              <div className="create-salida__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary"
                  onClick={handleSkipCedulaPrompt}
                  disabled={savingCedulaPrompt}
                >
                  Continuar sin agregar
                </button>
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={handleSaveCedulaAndContinue}
                  disabled={savingCedulaPrompt || !cedulaPromptValue.trim()}
                >
                  {savingCedulaPrompt ? 'Guardando...' : 'Guardar y continuar'}
                </button>
              </div>
            </div>
          </div>
        )}

        {duplicateProductConfirm && (
          <div
            className="create-salida__confirm-overlay"
            onMouseDown={handleCancelDuplicateProduct}
          >
            <div className="create-salida__confirm-card" onMouseDown={(event) => event.stopPropagation()}>
              <h4>Producto ya agregado</h4>
              <p>
                <strong>
                  {duplicateProductConfirm.productoCodigo}
                  {duplicateProductConfirm.productoNombre ? ` - ${duplicateProductConfirm.productoNombre}` : ''}
                </strong>{' '}
                ya está en el detalle con <strong>{duplicateProductConfirm.existingQty}</strong> unidad(es).
              </p>
              <p>
                ¿Deseas agregar <strong>{duplicateProductConfirm.cantidad}</strong> más? Quedarían{' '}
                <strong>{duplicateProductConfirm.existingQty + duplicateProductConfirm.cantidad}</strong> en total.
              </p>
              <div className="create-salida__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary"
                  onClick={handleCancelDuplicateProduct}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={handleConfirmDuplicateProduct}
                >
                  Sí, agregar
                </button>
              </div>
            </div>
          </div>
        )}

        {isTransferCancelModalOpen && (
          <div className="create-salida__confirm-overlay" onMouseDown={closeTransferCancelModal}>
            <div className="create-salida__confirm-card create-salida__confirm-card--cancel" onMouseDown={(event) => event.stopPropagation()}>
              <h4>Cancelar envío</h4>
              <p>
                La solicitud <strong>{transferSummaryLabel}</strong> pasará a estado rechazada/cancelada.
              </p>
              <label className="create-salida__confirm-field">
                <span>Motivo de cancelación (obligatorio)</span>
                <textarea
                  value={transferCancelReason}
                  onChange={(event) => setTransferCancelReason(event.target.value)}
                  rows={4}
                  maxLength={400}
                  disabled={transferCancelSubmitting}
                />
              </label>
              {transferCancelReasonError && (
                <p className="create-salida__confirm-error">{transferCancelReasonError}</p>
              )}
              <div className="create-salida__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary"
                  onClick={closeTransferCancelModal}
                  disabled={transferCancelSubmitting}
                >
                  Volver
                </button>
                <button
                  type="button"
                  className="create-user__action create-salida__action--danger-solid"
                  onClick={handleConfirmTransferCancel}
                  disabled={transferCancelSubmitting}
                >
                  {transferCancelSubmitting ? 'Cancelando...' : 'Confirmar cancelación'}
                </button>
              </div>
            </div>
          </div>
        )}

        <button
          type="button"
          aria-label="Cambiar tamano de ventana"
          className="create-user__resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      </div>
      {cellHoverPortal}
    </div>
  )
}

export default CreateSalida
