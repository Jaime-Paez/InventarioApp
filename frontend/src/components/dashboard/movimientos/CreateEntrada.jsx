import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'
import '../admin/CreateUsuario/CreateUsuario.css'
import '../admin/UsersDetails/UsersDetails.css'
import './CreateSalida.css'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDate } from '../../../utils/dateFormat'
import useModalAnimation from '../common/useModalAnimation'
import useTableCellHover from '../common/useTableCellHover.jsx'
import SubTipoButtonSelector from './SubTipoButtonSelector'
import StaticFieldDisplay from './StaticFieldDisplay'
import {
  emitRemindersSync,
  extractUserId,
  formatCurrentUserName,
  normalizeId,
  sanitizeRecipient,
} from '../common/reminders/remindersStorage'

const DEFAULT_IVA_RATE = 0.15
const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const SELECTOR_WIDTH = 520
const COMPRA_LOCAL_WIDTH = 1100
const SELECTOR_HEIGHT = 360
const CASA_SELECTOR_HEIGHT_EMPTY = 210
const CASA_SELECTOR_HEIGHT_FULL = 500
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
  urgente: false,
  descripcion_urgencia: '',
  funcional: true,
  sucursalObjetivoId: '',
  cliente: '',
  descuento: '',
  iva_rate: String(DEFAULT_IVA_RATE),
}

const initialDetail = {
  productoId: '',
  cantidad: '',
  valor: '',
  costo: '',
  descuentoPorcentaje: '',
}

const initialClienteForm = {
  nombres: '',
  apellidos: '',
  cedula_ruc: '',
  correo: '',
  telefono: '',
  direccion: '',
}

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeValue = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
const normalizeString = (value) => String(value ?? '').trim().toLowerCase()
const getNowDateParts = () => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  }
}
const hasUsersModuleAccess = (permissions) =>
  (Array.isArray(permissions) ? permissions : []).some((permission) => {
    if (normalizeString(permission?.modulo) !== 'usuarios') return false
    return Boolean(
      permission?.puede_crear ||
        permission?.puede_actualizar ||
        permission?.puede_eliminar
    )
  })

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
        puede_crear_compra_local: Boolean(entry?.puede_crear_compra_local),
        puede_crear_importacion: Boolean(entry?.puede_crear_importacion),
        puede_crear_traslado: Boolean(entry?.puede_crear_traslado),
        puede_crear_devolucion: Boolean(entry?.puede_crear_devolucion),
      }
    })

    if (Object.keys(branchActions).length) {
      scopes[moduleKey] = branchActions
    }
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

const hasModuleBranchCreateAndUpdateAccess = (userItem, moduleKey, branchId) => {
  if (!hasModuleBranchAccess(userItem, moduleKey, branchId)) return false
  const normalizedModule = normalizeString(moduleKey)
  const normalizedBranchId = normalizeId(branchId)
  const moduleActions = userItem?.moduleScopeActions?.[normalizedModule]
  const branchActions = moduleActions?.[normalizedBranchId]
  if (!branchActions) return false
  return Boolean(branchActions?.puede_crear && branchActions?.puede_actualizar)
}

const formatSubTipoLabel = (subTipo) => {
  const nombre = String(subTipo?.nombre || '').trim()
  if (!nombre) return ''
  return normalizeValue(nombre).includes('trasl') ? 'Solicitud de traslado' : nombre
}
const formatSubdivisionLocationLabel = (subdivision) => {
  const bodega = String(subdivision?.division?.bodega?.nombre || '').trim()
  const division = String(subdivision?.division?.nombre || '').trim()
  const sub = String(subdivision?.nombre || '').trim()
  return [bodega, division, sub].filter(Boolean).join(' / ')
}
const formatDivisionLocationLabel = (division) => {
  const bodega = String(division?.bodega?.nombre || '').trim()
  const divisionName = String(division?.nombre || '').trim()
  return [bodega, divisionName].filter(Boolean).join(' / ')
}
const formatBodegaLocationLabel = (bodega) => String(bodega?.nombre || '').trim()
const createEmptyLocationAssignment = () => ({
  bodegaId: '',
  divisionId: '',
  subdivisionId: '',
})
const normalizeLocationAssignment = (value) => {
  if (typeof value === 'string') {
    return {
      bodegaId: '',
      divisionId: '',
      subdivisionId: String(value || '').trim(),
    }
  }
  if (!value || typeof value !== 'object') {
    return createEmptyLocationAssignment()
  }
  return {
    bodegaId: String(value?.bodegaId || '').trim(),
    divisionId: String(value?.divisionId || '').trim(),
    subdivisionId: String(value?.subdivisionId || '').trim(),
  }
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

const calculateDescuentoValor = (costo, descuentoPorcentaje) => {
  const costoNum = parseNumber(costo)
  if (!Number.isFinite(costoNum) || costoNum < 0) return null
  const descuentoNum = parseNumber(descuentoPorcentaje)
  if (!Number.isFinite(descuentoNum) || descuentoNum <= 0) return 0
  return costoNum * (descuentoNum / 100)
}

const calculateCostoConIva = (costo, descuentoPorcentaje, ivaRate) => {
  const costoNum = parseNumber(costo)
  if (!Number.isFinite(costoNum) || costoNum < 0) return null
  const descuentoValor = calculateDescuentoValor(costo, descuentoPorcentaje) || 0
  return (costoNum - descuentoValor) * (1 + ivaRate)
}

// Igual que en Importaciones: los campos de dinero (Costo, PVP Nuevo) se
// guardan como string de centavos (solo digitos) y se formatean siempre como
// "0.00", para que escribir "5" de $0.00 pase a $0.05, "50" a $0.50, etc. —
// sin arrastrar un valor previo que haya que borrar primero. Desc. (%) no usa
// este formato porque no es dinero.
const formatCentavos = (centsStr) => {
  const digits = String(centsStr || '').replace(/\D/g, '')
  if (!digits) return '0.00'
  const n = parseInt(digits, 10)
  const intPart = Math.floor(n / 100)
  const decPart = n % 100
  return `${intPart.toLocaleString('en-US')}.${String(decPart).padStart(2, '0')}`
}

const centavosToNumber = (centsStr) => {
  const digits = String(centsStr || '').replace(/\D/g, '')
  if (!digits) return 0
  return parseInt(digits, 10) / 100
}

const decimalToCentavos = (value) => {
  const parsed = parseNumber(value)
  if (!Number.isFinite(parsed) || parsed < 0) return ''
  return String(Math.round(parsed * 100))
}

const calculatePrecioConIva = (precio, ivaRate) => {
  const precioNum = parseNumber(precio)
  if (!Number.isFinite(precioNum) || precioNum < 0) return null
  return precioNum * (1 + ivaRate)
}

const resolveProductPrice = (producto) => {
  const parsed = parseNumber(producto?.precio)
  if (parsed === null || parsed < 0) return ''
  const raw = String(producto?.precio ?? '').trim()
  return raw || parsed.toFixed(2)
}

const resolveProductCost = (producto) => {
  const parsed = parseNumber(producto?.costo_minimo)
  if (parsed === null || parsed < 0) return ''
  const raw = String(producto?.costo_minimo ?? '').trim()
  return raw || parsed.toFixed(2)
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

const clienteRequiredFields = ['nombres', 'apellidos', 'cedula_ruc']
const CLIENT_MODE_EXISTING = 'existing'
const CLIENT_MODE_NEW = 'new'
const DOCUMENT_STATUS = {
  idle: 'idle',
  invalid: 'invalid',
  checking: 'checking',
  available: 'available',
  duplicate: 'duplicate',
  error: 'error',
}

function CreateEntrada({
  open,
  onClose,
  onCreated,
  token,
  onError,
  preloadedTipoMovimientos = [],
  preloadedSubTipos = [],
  prefilledSucursalId = '',
  prefilledTransferRequest = null,
  currentUser = null,
}) {
  const [formData, setFormData] = useState(initialForm)
  const [loading, setLoading] = useState(false)
  const [, setError] = useState('')

  const [branches, setBranches] = useState([])
  const [providerBranches, setProviderBranches] = useState([])
  const [catalogsLoading, setCatalogsLoading] = useState(false)
  const [tipoMovimientos, setTipoMovimientos] = useState(() => preloadedTipoMovimientos)
  const [subTipos, setSubTipos] = useState(() => preloadedSubTipos)
  const [estados, setEstados] = useState([])
  const [productos, setProductos] = useState([])
  const [estadosProducto, setEstadosProducto] = useState([])

  const [details, setDetails] = useState([])
  const [detailDraft, setDetailDraft] = useState(initialDetail)
  const [detailError, setDetailError] = useState('')
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
  const [showClienteDropdown, setShowClienteDropdown] = useState(false)
  const [clienteDropdownStyle, setClienteDropdownStyle] = useState({})
  const [clienteQuery, setClienteQuery] = useState('')
  const [clienteOptions, setClienteOptions] = useState([])
  const [clienteLoading, setClienteLoading] = useState(false)
  const [stockByProduct, setStockByProduct] = useState({})
  const [stockLoading, setStockLoading] = useState(false)
  const [showLocationResolver, setShowLocationResolver] = useState(false)
  const [locationResolverLoading, setLocationResolverLoading] = useState(false)
  const [locationResolverSubmitting, setLocationResolverSubmitting] = useState(false)
  const [locationResolverError, setLocationResolverError] = useState('')
  const [checkingLocationCoverage, setCheckingLocationCoverage] = useState(false)
  const [missingLocationProducts, setMissingLocationProducts] = useState([])
  const [locationResolverSubdivisions, setLocationResolverSubdivisions] = useState([])
  const [locationAssignmentsByProduct, setLocationAssignmentsByProduct] = useState({})
  const [locationDropdownProductId, setLocationDropdownProductId] = useState('')
  const [locationDropdownField, setLocationDropdownField] = useState('')
  const [locationDropdownMaxHeight, setLocationDropdownMaxHeight] = useState(null)
  const [locationDropdownStyle, setLocationDropdownStyle] = useState({})
  const [locationQuery, setLocationQuery] = useState('')
  const [locationDebouncedQuery, setLocationDebouncedQuery] = useState('')
  const [reminderUsers, setReminderUsers] = useState([])
  const [reminderUsersLoading, setReminderUsersLoading] = useState(false)
  const [reminderUsersError, setReminderUsersError] = useState('')
  const [selectedReminderUserIds, setSelectedReminderUserIds] = useState([])
  const [documentStatus, setDocumentStatus] = useState(DOCUMENT_STATUS.invalid)
  const [showUrgenteConfirm, setShowUrgenteConfirm] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [trasladoConflict, setTrasladoConflict] = useState(null)
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })
  const [isMaximized, setIsMaximized] = useState(false)
  const [isResizingModal, setIsResizingModal] = useState(false)
  const [selectedCasaComercial, setSelectedCasaComercial] = useState(null)
  const [casaComercialDraft, setCasaComercialDraft] = useState(null)
  const [casaComercialQuery, setCasaComercialQuery] = useState('')
  const [casaComercialOptions, setCasaComercialOptions] = useState([])
  const [casaComercialLoading, setCasaComercialLoading] = useState(false)
  const [showCasaComercialDropdown, setShowCasaComercialDropdown] = useState(false)
  const [casaComercialDropdownStyle, setCasaComercialDropdownStyle] = useState({})
  const [facturaError, setFacturaError] = useState(false)
  const [detailFieldErrors, setDetailFieldErrors] = useState({})
  const modalRef = useRef(null)
  const productDropdownRef = useRef(null)
  const productDropdownTriggerRef = useRef(null)
  const productDropdownPanelRef = useRef(null)
  const clienteDropdownRef = useRef(null)
  const clienteDropdownTriggerRef = useRef(null)
  const clienteDropdownPanelRef = useRef(null)
  const casaComercialDropdownRef = useRef(null)
  const casaComercialDropdownPanelRef = useRef(null)
  const locationDropdownRef = useRef(null)
  const locationDropdownPanelRef = useRef(null)
  // Un ref por campo (en vez de un unico ref compartido y reasignado segun
  // cual esta abierto): con un solo ref, al pasar de un campo abierto a otro
  // (p. ej. Division -> Subdivision) el lookup del trigger podia quedarse
  // apuntando al elemento equivocado y el ultimo dropdown de la fila no
  // llegaba a posicionarse (por eso parecia "no abrir").
  // Se indexa por "productoId:campo" (no solo por campo) para que, si hay
  // varios productos sin ubicacion en la lista, cada fila tenga su propio
  // trigger y no se pisen entre si.
  const locationTriggerRefs = useRef({})
  const clienteSearchTimerRef = useRef(null)
  const casaComercialTimerRef = useRef(null)
  const documentCheckTimerRef = useRef(null)
  const documentCheckSequenceRef = useRef(0)
  const trasladoConflictTimerRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalResize = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const justTransitionedFromCasaRef = useRef(false)
  const modalSizeRef = useRef(modalSize)
  const modalPositionRef = useRef(modalPosition)
  const modalRestoreRef = useRef(null)
  const appliedPrefillTransferKeyRef = useRef('')

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

  const [liveUserScopes, setLiveUserScopes] = useState(null)

  useEffect(() => {
    if (!open || !token) return
    let cancelled = false
    authFetch(`${API_URL}/auth/me/`, { headers: { Authorization: `Token ${token}` } }, token)
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        if (cancelled) return
        setLiveUserScopes(data?.usuario?.sucursales_por_modulo ?? null)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [open, token])

  const effectiveScopes = liveUserScopes ?? currentUser?.sucursales_por_modulo

  const currentCreatorId = useMemo(() => normalizeId(extractUserId(currentUser)), [currentUser])
  const currentCreatorName = useMemo(() => formatCurrentUserName(currentUser), [currentUser])
  const currentCreatorEmail = String(currentUser?.correo || currentUser?.email || '').trim()
  const isCurrentUserAdmin = useMemo(
    () => hasUsersModuleAccess(currentUser?.permisos),
    [currentUser]
  )

  const currentUserEntradasSubtypeActions = useMemo(() => {
    const branchId = normalizeId(prefilledSucursalId || formData.sucursalId)
    if (!branchId) return null
    const actions = normalizeModuleScopeActions(effectiveScopes)
    return actions?.['movimientos_entradas']?.[branchId] ?? null
  }, [prefilledSucursalId, formData.sucursalId, effectiveScopes])

  useEffect(() => {
    if (!detailError) return
    notifyError(detailError)
  }, [detailError, notifyError])

  const entradaTipoId = useMemo(() => {
    const entrada = tipoMovimientos.find((tipo) => normalizeValue(tipo?.nombre).startsWith('ent'))
    return entrada?.id ?? ''
  }, [tipoMovimientos])

  const subTiposEntrada = useMemo(
    () =>
      subTipos.filter(
        (sub) => String(sub?.tipo_movimiento?.id || '') === String(entradaTipoId)
      ),
    [subTipos, entradaTipoId]
  )

  const selectedSubTipo = useMemo(
    () => subTiposEntrada.find((sub) => String(sub.id) === String(formData.subTipoId)),
    [subTiposEntrada, formData.subTipoId]
  )
  const entradaSubTipoOptions = useMemo(
    () =>
      subTiposEntrada
        .filter((subTipo) => !normalizeValue(subTipo?.nombre).includes('import'))
        .map((subTipo, index) => {
          const normalizedName = normalizeValue(subTipo?.nombre)
          let label = formatSubTipoLabel(subTipo)
          let description = 'Selecciona este tipo de entrada.'
          let order = 90 + index

          if (normalizedName.includes('compra')) {
            label = 'Compra local'
            description = 'Proceso para recibir productos de compra local en el mismo país.'
            order = 1
          } else if (normalizedName.includes('trasl')) {
            label = 'Pedido a sucursal'
            description = 'Hacer una solicitud para pedir productos de otra sucursal.'
            order = 2
          } else if (normalizedName.includes('devol')) {
            label = 'Devolución'
            description = 'Cuando un cliente pide hacer una devolución de algo que no funciona o no se usó.'
            order = 3
          }

          const isCompra = normalizedName.includes('compra')
          let blocked = false
          if (currentUserEntradasSubtypeActions) {
            if (isCompra) blocked = !currentUserEntradasSubtypeActions.puede_crear_compra_local
            else if (normalizedName.includes('trasl')) blocked = !currentUserEntradasSubtypeActions.puede_crear_traslado
            else if (normalizedName.includes('devol')) blocked = !currentUserEntradasSubtypeActions.puede_crear_devolucion
          }

          return {
            value: String(subTipo?.id || ''),
            label,
            description,
            icon: isCompra
              ? 'purchase'
              : normalizedName.includes('trasl')
                ? 'branch'
                : normalizedName.includes('devol')
                  ? 'return'
                  : 'branch',
            order,
            index,
            blocked,
          }
        })
        .sort((first, second) => first.order - second.order || first.index - second.index),
    [subTiposEntrada, currentUserEntradasSubtypeActions]
  )
  const selectedSubTipoLabel = useMemo(
    () =>
      entradaSubTipoOptions.find((option) => option.value === String(formData.subTipoId))?.label ||
      formatSubTipoLabel(selectedSubTipo),
    [entradaSubTipoOptions, formData.subTipoId, selectedSubTipo]
  )

  const selectedSubTipoName = normalizeValue(selectedSubTipo?.nombre)
  const isDevolucion = selectedSubTipoName.includes('devol')
  const isTraslado = selectedSubTipoName.includes('trasl')
  const isVenta = selectedSubTipoName.includes('vent')
  const isCompraEntrada = selectedSubTipoName.includes('compra')
  const isEditableEntryDate = !isTraslado && !isDevolucion
  const useExistingCliente = clienteMode === CLIENT_MODE_EXISTING
  const useNewCliente = clienteMode === CLIENT_MODE_NEW
  const isSelectorStep = !formData.subTipoId
  const isCasaComercialStep = Boolean(formData.subTipoId) && isCompraEntrada && !selectedCasaComercial
  const isMaximizableStep = !isSelectorStep && !isCasaComercialStep
  const requiresSucursalObjetivo = isTraslado
  const normalizedPrefilledSucursalId = String(prefilledSucursalId || '').trim()
  const isSucursalPrincipalLocked = Boolean(normalizedPrefilledSucursalId)
  const selectedSucursalId = String(formData.sucursalId || '').trim()
  const hasSelectedSucursal = Boolean(selectedSucursalId)
  const selectedSucursalName = useMemo(() => {
    const branch = branches.find(
      (item) => String(item?.id || '').trim() === selectedSucursalId
    )
    return String(branch?.nombre || '').trim()
  }, [branches, selectedSucursalId])
  const selectedProveedorSucursalId = String(formData.sucursalObjetivoId || '').trim()
  const hasSelectedProveedorSucursal = Boolean(selectedProveedorSucursalId)
  const selectedReminderTargetBranchId = selectedProveedorSucursalId
  const hasSelectedReminderTargetBranch = Boolean(selectedReminderTargetBranchId)
  const hasProductSourceBranch = isTraslado ? hasSelectedProveedorSucursal : hasSelectedSucursal
  const providerBranchPool = providerBranches.length ? providerBranches : branches
  const destinationBranches = useMemo(() => {
    return providerBranchPool.filter((branch) => String(branch?.id || '').trim() !== selectedSucursalId)
  }, [providerBranchPool, selectedSucursalId])
  const formattedFecha = useMemo(() => formatDate(formData.fecha, ''), [formData.fecha])

  const devolucionEstadoOptions = useMemo(
    () =>
      estados.filter((estado) => normalizeValue(estado?.nombre) === 'recibido'),
    [estados]
  )

  const trasladoEstadoOptions = useMemo(() => {
    const allowed = new Set(['enviado', 'recibido', 'parcialmente recibido'])
    return estados.filter((estado) => allowed.has(normalizeValue(estado?.nombre)))
  }, [estados])

  const ventaEstadoOptions = useMemo(() => {
    const allowed = new Set(['vendido', 'proformado', 'facturado'])
    return estados.filter((estado) => allowed.has(normalizeValue(estado?.nombre)))
  }, [estados])

  const compraEstadoOptions = useMemo(() => {
    const recibidos = estados.filter((estado) => normalizeValue(estado?.nombre) === 'recibido')
    if (recibidos.length) return recibidos
    return estados.filter((estado) => normalizeValue(estado?.nombre).includes('recib'))
  }, [estados])

  const estadoOptions = useMemo(() => {
    if (isDevolucion) return devolucionEstadoOptions
    if (isTraslado) return trasladoEstadoOptions
    if (isVenta) return ventaEstadoOptions
    if (isCompraEntrada) return compraEstadoOptions
    return []
  }, [
    compraEstadoOptions,
    devolucionEstadoOptions,
    isCompraEntrada,
    isDevolucion,
    isTraslado,
    isVenta,
    trasladoEstadoOptions,
    ventaEstadoOptions,
  ])
  const defaultEstadoMovimientoId = useMemo(() => {
    if (!estadoOptions.length) return ''

    if (isTraslado) {
      const enviado = estadoOptions.find((estado) => normalizeValue(estado?.nombre) === 'enviado')
      return String(enviado?.id ?? estadoOptions[0].id)
    }

    if (isDevolucion) {
      return String(estadoOptions[0].id)
    }

    if (isVenta) {
      const preferredOrder = ['proformado', 'facturado', 'vendido']
      for (const key of preferredOrder) {
        const matched = estadoOptions.find((estado) => normalizeValue(estado?.nombre) === key)
        if (matched?.id) return String(matched.id)
      }
      return String(estadoOptions[0].id)
    }

    if (isCompraEntrada) {
      return String(estadoOptions[0].id)
    }

    return String(estadoOptions[0].id)
  }, [estadoOptions, isCompraEntrada, isDevolucion, isTraslado, isVenta])

  const defaultEstadoProductoId = useMemo(() => {
    if (!estadosProducto.length) return ''
    const preferred = estadosProducto.find((estado) =>
      normalizeValue(estado?.nombre).includes('enviad')
    )
    return String(preferred?.id ?? estadosProducto[0].id)
  }, [estadosProducto])

  const ivaRateValue = useMemo(() => {
    const parsed = parseNumber(formData.iva_rate)
    if (parsed === null || parsed < 0) return DEFAULT_IVA_RATE
    return parsed
  }, [formData.iva_rate])

  const draftCostoDecimal = useMemo(() => centavosToNumber(detailDraft.costo), [detailDraft.costo])
  const draftDescuentoPorcentajeDecimal = useMemo(
    () => parseNumber(detailDraft.descuentoPorcentaje),
    [detailDraft.descuentoPorcentaje]
  )
  const draftValorDecimal = useMemo(
    () => (isCompraEntrada ? centavosToNumber(detailDraft.valor) : parseNumber(detailDraft.valor)),
    [isCompraEntrada, detailDraft.valor]
  )

  const draftLineTotal = useMemo(
    () => calculateLineTotal(detailDraft.cantidad, draftValorDecimal),
    [detailDraft.cantidad, draftValorDecimal]
  )

  const draftDescuentoValor = useMemo(
    () => calculateDescuentoValor(draftCostoDecimal, draftDescuentoPorcentajeDecimal),
    [draftCostoDecimal, draftDescuentoPorcentajeDecimal]
  )

  const draftCostoConIva = useMemo(
    () => calculateCostoConIva(draftCostoDecimal, draftDescuentoPorcentajeDecimal, ivaRateValue),
    [draftCostoDecimal, draftDescuentoPorcentajeDecimal, ivaRateValue]
  )

  const draftValorConIva = useMemo(
    () => calculatePrecioConIva(draftValorDecimal, ivaRateValue),
    [draftValorDecimal, ivaRateValue]
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
  const selectedDraftProduct = useMemo(
    () => productos.find((producto) => String(producto.id) === String(detailDraft.productoId)) || null,
    [detailDraft.productoId, productos]
  )
  const selectedDraftProductName = useMemo(
    () => String(selectedDraftProduct?.nombre || '').trim(),
    [selectedDraftProduct]
  )
  const detailProductIdSet = useMemo(
    () =>
      new Set(
        details
          .map((detail) => String(detail?.productoId || '').trim())
          .filter(Boolean)
      ),
    [details]
  )
  const showProveedorStockInfo = isTraslado && Boolean(String(formData.sucursalObjetivoId || '').trim())
  const selectedDraftProductId = String(detailDraft.productoId || '').trim()
  const selectedDraftCantidad = parseIntValue(detailDraft.cantidad)
  const selectedDraftStockDisponible = useMemo(() => {
    if (!showProveedorStockInfo || !selectedDraftProductId) return 0
    const raw = Number(stockByProduct[selectedDraftProductId] ?? 0)
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0
  }, [selectedDraftProductId, showProveedorStockInfo, stockByProduct])
  const selectedDraftCantidadYaSolicitada = useMemo(() => {
    if (!selectedDraftProductId) return 0
    return details.reduce((acc, detail) => {
      if (String(detail.productoId || '') !== selectedDraftProductId) return acc
      const qty = parseIntValue(detail.cantidad)
      return acc + (Number.isFinite(qty) ? qty : 0)
    }, 0)
  }, [details, selectedDraftProductId])
  const selectedDraftStockRestante = Math.max(
    selectedDraftStockDisponible - selectedDraftCantidadYaSolicitada,
    0
  )
  const draftCantidadExceedsProveedorStock = Boolean(
    showProveedorStockInfo &&
    selectedDraftProductId &&
    Number.isFinite(selectedDraftCantidad) &&
    selectedDraftCantidad > selectedDraftStockRestante
  )
  const disableAddByProveedorStock = Boolean(
    showProveedorStockInfo &&
    selectedDraftProductId &&
    (
      selectedDraftStockRestante <= 0 ||
      draftCantidadExceedsProveedorStock
    )
  )
  const proveedorStockDisabledMessage = 'No hay suficientes en la sucursal proveedora.'
  const proveedorStockDisabledMessageWithAvailable = (
    `${proveedorStockDisabledMessage} Disponible: ${selectedDraftStockRestante}.`
  )
  const reminderBranchUsers = useMemo(() => {
    if (!isTraslado || !selectedReminderTargetBranchId) return []
    return reminderUsers.filter((userItem) =>
      hasModuleBranchCreateAndUpdateAccess(
        userItem,
        'movimientos_salidas',
        selectedReminderTargetBranchId
      )
    )
  }, [isTraslado, reminderUsers, selectedReminderTargetBranchId])

  const adminReminderRecipients = useMemo(() => {
    if (!isTraslado) return []
    return reminderUsers
      .filter((userItem) => userItem.isAdmin)
      .map((userItem) => sanitizeRecipient({ id: userItem.id, name: userItem.name }))
      .filter(Boolean)
      .filter(
        (recipient, index, list) =>
          list.findIndex((item) => normalizeId(item?.id) === normalizeId(recipient?.id)) === index
      )
  }, [isTraslado, reminderUsers])

  const adminReminderRecipientIds = useMemo(
    () => new Set(adminReminderRecipients.map((recipient) => normalizeId(recipient?.id)).filter(Boolean)),
    [adminReminderRecipients]
  )

  const reminderUsersById = useMemo(
    () => new Map(reminderUsers.map((userItem) => [normalizeId(userItem?.id), userItem])),
    [reminderUsers]
  )

  const reminderBranchUsersById = useMemo(
    () =>
      new Map(reminderBranchUsers.map((userItem) => [normalizeId(userItem?.id), userItem])),
    [reminderBranchUsers]
  )

  const adminReminderRows = useMemo(
    () =>
      adminReminderRecipients
        .map((recipient) => {
          const recipientId = normalizeId(recipient?.id)
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
    () => reminderBranchUsers.filter((userItem) => !adminReminderRecipientIds.has(normalizeId(userItem.id))),
    [adminReminderRecipientIds, reminderBranchUsers]
  )

  const selectedReminderRecipients = useMemo(() => {
    if (!selectedReminderUserIds.length) return []
    const usersMap = new Map(reminderBranchUsers.map((userItem) => [normalizeId(userItem.id), userItem]))
    return selectedReminderUserIds
      .map((recipientId) => usersMap.get(normalizeId(recipientId)))
      .filter(Boolean)
      .map((userItem) => sanitizeRecipient({ id: userItem.id, name: userItem.name }))
      .filter(Boolean)
      .filter(
        (recipient, index, list) =>
          list.findIndex((item) => normalizeId(item?.id) === normalizeId(recipient?.id)) === index
      )
  }, [reminderBranchUsers, selectedReminderUserIds])

  const hasAdminReminderRecipients = adminReminderRecipients.length > 0
  const hasAdditionalReminderRecipients = selectedReminderRecipients.length > 0
  const locationResolverBodegas = useMemo(() => {
    const map = new Map()
    locationResolverSubdivisions.forEach((subdivision) => {
      const bodega = subdivision?.division?.bodega
      const bodegaId = String(bodega?.id || '').trim()
      if (!bodegaId || map.has(bodegaId)) return
      map.set(bodegaId, { ...bodega, id: bodegaId })
    })
    return Array.from(map.values()).sort((a, b) =>
      String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es', { sensitivity: 'base' })
    )
  }, [locationResolverSubdivisions])

  const locationResolverDivisionsByBodega = useMemo(() => {
    const map = new Map()
    locationResolverSubdivisions.forEach((subdivision) => {
      const division = subdivision?.division
      const divisionId = String(division?.id || '').trim()
      const bodega = division?.bodega
      const bodegaId = String(bodega?.id || '').trim()
      if (!divisionId || !bodegaId) return
      if (!map.has(bodegaId)) map.set(bodegaId, new Map())
      const divisionsMap = map.get(bodegaId)
      if (divisionsMap.has(divisionId)) return
      divisionsMap.set(divisionId, {
        ...division,
        id: divisionId,
        bodega: { ...bodega, id: bodegaId },
      })
    })

    const grouped = new Map()
    map.forEach((divisionsMap, bodegaId) => {
      grouped.set(
        bodegaId,
        Array.from(divisionsMap.values()).sort((a, b) =>
          String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es', { sensitivity: 'base' })
        )
      )
    })
    return grouped
  }, [locationResolverSubdivisions])

  const locationResolverSubdivisionsByDivision = useMemo(() => {
    const map = new Map()
    locationResolverSubdivisions.forEach((subdivision) => {
      const divisionId = String(subdivision?.division?.id || '').trim()
      const subdivisionId = String(subdivision?.id || '').trim()
      if (!divisionId || !subdivisionId) return
      if (!map.has(divisionId)) map.set(divisionId, new Map())
      const subdivisionsMap = map.get(divisionId)
      if (subdivisionsMap.has(subdivisionId)) return
      subdivisionsMap.set(subdivisionId, {
        ...subdivision,
        id: subdivisionId,
      })
    })

    const grouped = new Map()
    map.forEach((subdivisionsMap, divisionId) => {
      grouped.set(
        divisionId,
        Array.from(subdivisionsMap.values()).sort((a, b) =>
          String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es', { sensitivity: 'base' })
        )
      )
    })
    return grouped
  }, [locationResolverSubdivisions])

  useEffect(() => {
    if (!preloadedTipoMovimientos.length) return
    setTipoMovimientos((prev) => (prev.length ? prev : preloadedTipoMovimientos))
  }, [preloadedTipoMovimientos])

  useEffect(() => {
    if (!preloadedSubTipos.length) return
    setSubTipos((prev) => (prev.length ? prev : preloadedSubTipos))
  }, [preloadedSubTipos])

  const formatProductoOptionLabel = useCallback(
    (producto) => {
      if (!producto) return ''
      const codigo = String(producto?.codigo || '').trim()
      return codigo || `ID ${producto?.id ?? ''}`
    },
    []
  )

  const searchProducts = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token || !hasProductSourceBranch) {
        setProductOptions([])
        return
      }

      setProductLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=5`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar los productos.')

        const payload = await response.json()
        const list = parseApiList(payload)
        list.sort((a, b) => {
          const qa = Number(stockByProduct[String(a.id)] ?? 0)
          const qb = Number(stockByProduct[String(b.id)] ?? 0)
          return (qb > 0 ? 1 : 0) - (qa > 0 ? 1 : 0)
        })
        setProductOptions(list)
      } catch {
        setProductOptions([])
      } finally {
        setProductLoading(false)
      }
    },
    [hasProductSourceBranch, stockByProduct, token]
  )

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

  const searchCasasComerciales = useCallback(
    async (query, tipo) => {
      if (!token) return
      setCasaComercialLoading(true)
      try {
        const params = new URLSearchParams()
        params.set('page_size', '10')
        params.set('tipo', tipo)
        if (query) params.set('search', query)
        const response = await authFetch(`${API_URL}/casa-comercial/casas/?${params.toString()}`, {}, token)
        if (!response.ok) throw new Error('No se pudieron cargar las casas comerciales.')
        const payload = await response.json().catch(() => ({}))
        setCasaComercialOptions(parseApiList(payload))
      } catch {
        setCasaComercialOptions([])
      } finally {
        setCasaComercialLoading(false)
      }
    },
    [token]
  )

  const fetchSuggestedDocumentNumber = useCallback(
    async ({ subTipoId, sucursalId, sucursalObjetivoId }) => {
      if (!token) {
        setDocumentStatus(DOCUMENT_STATUS.error)
        return false
      }

      const requestSequence = documentCheckSequenceRef.current + 1
      documentCheckSequenceRef.current = requestSequence
      setDocumentStatus(DOCUMENT_STATUS.checking)

      const params = new URLSearchParams({
        sub_tipo_movimiento_id: String(subTipoId || '').trim(),
        sucursal_id: String(sucursalId || '').trim(),
      })
      const objectiveId = String(sucursalObjetivoId || '').trim()
      if (objectiveId) params.set('sucursal_objetivo_id', objectiveId)

      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/siguiente-documento-entrada/?${params.toString()}`,
          {},
          token
        )
        const payload = await response.json().catch(() => ({}))
        if (requestSequence !== documentCheckSequenceRef.current) return false
        if (!response.ok) {
          setDocumentStatus(DOCUMENT_STATUS.error)
          return false
        }

        const generated = String(payload?.no_documento || '').trim()
        if (!generated) {
          setDocumentStatus(DOCUMENT_STATUS.error)
          return false
        }

        setFormData((prev) => (
          prev.no_documento === generated
            ? prev
            : { ...prev, no_documento: generated }
        ))
        setDocumentStatus(DOCUMENT_STATUS.available)
        return true
      } catch {
        if (requestSequence === documentCheckSequenceRef.current) {
          setDocumentStatus(DOCUMENT_STATUS.error)
        }
        return false
      }
    },
    [token]
  )

  useEffect(() => {
    if (!open || !formData.subTipoId || !defaultEstadoMovimientoId) return
    setFormData((prev) =>
      prev.estadoId === defaultEstadoMovimientoId ? prev : { ...prev, estadoId: defaultEstadoMovimientoId }
    )
  }, [defaultEstadoMovimientoId, formData.subTipoId, open])

  useEffect(() => {
    if (!formData.subTipoId) return
    setFormData((prev) => {
      let changed = false
      const next = { ...prev }

      if (!isTraslado && next.sucursalObjetivoId) {
        next.sucursalObjetivoId = ''
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
      if (!isDevolucion && !next.funcional) {
        next.funcional = true
        changed = true
      }
      if (!isDevolucion && !isCompraEntrada && next.factura_referencia) {
        next.factura_referencia = ''
        changed = true
      }

      return changed ? next : prev
    })
  }, [formData.subTipoId, isCompraEntrada, isDevolucion, isTraslado, isVenta])

  useEffect(() => {
    if (!isCompraEntrada) setFacturaError(false)
  }, [isCompraEntrada])

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
    setShowClienteDropdown(false)
    setClienteQuery('')
    setClienteOptions([])
    setClienteLoading(false)
  }, [isVenta])

  useEffect(() => {
    if (!isTraslado && activeTab === 'recordatorio') {
      setActiveTab('general')
    }
  }, [activeTab, isTraslado])

  useEffect(() => {
    if (!reminderUsersError) return
    notifyError(reminderUsersError)
  }, [notifyError, reminderUsersError])

  useEffect(() => {
    setSelectedReminderUserIds((prev) => {
      if (!prev.length) return prev
      const validIds = new Set(selectableReminderUsers.map((userItem) => normalizeId(userItem.id)).filter(Boolean))
      const filtered = prev.filter((id) => validIds.has(normalizeId(id)))
      return filtered.length === prev.length ? prev : filtered
    })
  }, [selectableReminderUsers])

  const fetchCatalogs = useCallback(async () => {
    if (!token) return
    setCatalogsLoading(true)
    try {
      const [
        branchesRes,
        providerBranchesRes,
        tiposRes,
        subTiposRes,
        estadosRes,
        productosRes,
        estadosProductoRes,
      ] = await Promise.all([
        authFetch(`${API_URL}/inventario/sucursales/?modulo=movimientos_entradas&page_size=500`, {}, token),
        authFetch(`${API_URL}/movimientos/movimiento_inventario/sucursales-traslado-proveedoras/`, {}, token),
        authFetch(`${API_URL}/tipos/tipos-movimiento/`, {}, token),
        authFetch(`${API_URL}/tipos/subtipos-movimiento/`, {}, token),
        authFetch(`${API_URL}/tipos/estados-movimiento/`, {}, token),
        authFetch(`${API_URL}/productos/listado/`, {}, token),
        authFetch(`${API_URL}/tipos/estados-producto/`, {}, token),
      ])

      if (!branchesRes.ok) throw new Error('No se pudieron cargar las sucursales.')
      if (!tiposRes.ok) throw new Error('No se pudieron cargar los tipos de movimiento.')
      if (!subTiposRes.ok) throw new Error('No se pudieron cargar los tipos de entrada.')
      if (!estadosRes.ok) throw new Error('No se pudieron cargar los estados de movimiento.')
      if (!productosRes.ok) throw new Error('No se pudieron cargar los productos.')
      if (!estadosProductoRes.ok) throw new Error('No se pudieron cargar los estados de producto.')

      const [
        branchesData,
        providerBranchesData,
        tiposData,
        subTiposData,
        estadosData,
        productosData,
        estadosProductoData,
      ] = await Promise.all([
        branchesRes.json(),
        providerBranchesRes.ok ? providerBranchesRes.json().catch(() => null) : Promise.resolve(null),
        tiposRes.json(),
        subTiposRes.json(),
        estadosRes.json(),
        productosRes.json(),
        estadosProductoRes.json(),
      ])

      const entradasBranches = parseApiList(branchesData)
      const trasladoProviderBranches = parseApiList(providerBranchesData)

      setBranches(entradasBranches)
      setProviderBranches(trasladoProviderBranches.length ? trasladoProviderBranches : entradasBranches)
      setTipoMovimientos(parseApiList(tiposData))
      setSubTipos(parseApiList(subTiposData))
      setEstados(parseApiList(estadosData))
      setProductos(parseApiList(productosData))
      setEstadosProducto(parseApiList(estadosProductoData))

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
      if (list.some((userItem) => normalizeId(userItem.id) === currentCreatorId)) return list

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
        if (!response.ok) {
          throw new Error('No se pudo cargar la lista de usuarios para recordatorios.')
        }

        const payload = await response.json().catch(() => ({}))
        if (Array.isArray(payload)) {
          rows.push(...payload)
          url = null
        } else {
          const pageResults = Array.isArray(payload?.results) ? payload.results : []
          rows.push(...pageResults)
          url = payload?.next || null
        }
      }

      const seenIds = new Set()
      const normalizedUsers = []
      rows.forEach((item) => {
        const userId = normalizeId(extractUserId(item))
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
  }, [
    currentCreatorEmail,
    currentCreatorId,
    currentCreatorName,
    currentUser,
    isCurrentUserAdmin,
    token,
  ])

  useEffect(() => {
    if (trasladoConflictTimerRef.current) {
      clearTimeout(trasladoConflictTimerRef.current)
      trasladoConflictTimerRef.current = null
    }

    if (!open || !isTraslado || formData.urgente || !token) {
      setTrasladoConflict(null)
      return undefined
    }

    const sucursalSolicitanteId = String(formData.sucursalId || '').trim()
    const sucursalProveedoraId = String(formData.sucursalObjetivoId || '').trim()
    if (!sucursalSolicitanteId || !sucursalProveedoraId) {
      setTrasladoConflict(null)
      return undefined
    }

    trasladoConflictTimerRef.current = setTimeout(async () => {
      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/conflicto/` +
            `?sucursal_solicitante_id=${encodeURIComponent(sucursalSolicitanteId)}` +
            `&sucursal_proveedora_id=${encodeURIComponent(sucursalProveedoraId)}`,
          {},
          token
        )
        if (!response.ok) {
          setTrasladoConflict(null)
          return
        }
        const data = await response.json().catch(() => ({}))
        if (data?.conflicto) {
          setTrasladoConflict(data)
          const isGuardado = String(data?.estado || '').trim().toLowerCase() === 'guardado'
          notifyError(
            isGuardado
              ? 'Ya hay un pedido a sucursal guardado a esta sucursal, edítalo o complétalo para poder hacer más solicitudes a esa sucursal.'
              : `Ya existe una solicitud pendiente para estas sucursales (${data?.no_documento || ''}). Debes aceptarla o rechazarla antes de crear otra.`
          )
        } else {
          setTrasladoConflict(null)
        }
      } catch {
        setTrasladoConflict(null)
      }
    }, 350)

    return () => {
      if (trasladoConflictTimerRef.current) {
        clearTimeout(trasladoConflictTimerRef.current)
        trasladoConflictTimerRef.current = null
      }
    }
  }, [open, isTraslado, formData.urgente, formData.sucursalId, formData.sucursalObjetivoId, token, notifyError])

  const fetchStockByBranch = useCallback(
    async (sucursalId) => {
      if (!token || !sucursalId) {
        setStockByProduct({})
        return
      }
      setStockLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/stock-sucursal-global/?sucursal_id=${encodeURIComponent(sucursalId)}`,
          {},
          token
        )
        if (!response.ok) {
          setStockByProduct({})
          return
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
        setStockByProduct(map)
      } catch {
        setStockByProduct({})
      } finally {
        setStockLoading(false)
      }
    },
    [token]
  )

  const fetchSubdivisionsForLocationResolver = useCallback(
    async (sucursalId) => {
      if (!token || !sucursalId) return []
      const response = await authFetch(
        `${API_URL}/inventario/subdivisiones/?page_size=500&sucursal_id=${encodeURIComponent(
          sucursalId
        )}&modulo=movimientos_entradas`,
        {},
        token
      )
      if (!response.ok) {
        throw new Error('No se pudieron cargar las ubicaciones de la sucursal.')
      }
      const data = await response.json().catch(() => ({}))
      return parseApiList(data)
    },
    [token]
  )

  const checkMissingLocationsByProduct = useCallback(
    async (sucursalId, detailRows) => {
      const uniqueProductRows = []
      const seenProductIds = new Set()

      ;(Array.isArray(detailRows) ? detailRows : []).forEach((detail) => {
        const productId = String(detail?.productoId || '').trim()
        if (!productId || seenProductIds.has(productId)) return
        seenProductIds.add(productId)
        uniqueProductRows.push({
          productoId: productId,
          productoCodigo: String(detail?.productoCodigo || '').trim(),
          productoNombre: String(detail?.productoNombre || '').trim(),
        })
      })

      if (!uniqueProductRows.length) return []

      const productIdsParam = uniqueProductRows.map((item) => item.productoId).join(',')
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/ubicaciones-productos-sucursal/?sucursal_id=${encodeURIComponent(
          sucursalId
        )}&producto_ids=${encodeURIComponent(productIdsParam)}`,
        {},
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(
          resolveApiErrorMessage(
            payload,
            'No se pudo validar si los productos tienen ubicaciones en la sucursal.'
          )
        )
      }

      const productsWithLocation = new Set(
        (Array.isArray(payload?.producto_ids_con_ubicacion) ? payload.producto_ids_con_ubicacion : [])
          .map((productId) => String(productId || '').trim())
          .filter(Boolean)
      )

      return uniqueProductRows.filter(
        (item) => !productsWithLocation.has(String(item.productoId || '').trim())
      )
    },
    [token]
  )

  const openLocationResolverForProducts = useCallback(
    async (missingProducts, sucursalId) => {
      const normalizedBranchId = String(sucursalId || '').trim()
      if (!normalizedBranchId || !missingProducts.length) return

      setLocationResolverLoading(true)
      setLocationResolverError('')
      setLocationDropdownProductId('')
      setLocationDropdownField('')
      setLocationQuery('')
      setLocationDebouncedQuery('')

      try {
        const subdivisions = await fetchSubdivisionsForLocationResolver(normalizedBranchId)
        if (!subdivisions.length) {
          throw new Error(
            'La sucursal seleccionada no tiene subdivisiones configuradas para registrar la entrada.'
          )
        }

        const missingIds = new Set(
          missingProducts.map((item) => String(item?.productoId || '').trim()).filter(Boolean)
        )
        const subdivisionPathById = new Map()
        const divisionIdsByBodega = new Map()
        const subdivisionIdsByDivision = new Map()
        subdivisions.forEach((subdivision) => {
          const subdivisionId = String(subdivision?.id || '').trim()
          const division = subdivision?.division
          const divisionId = String(division?.id || '').trim()
          const bodega = division?.bodega
          const bodegaId = String(bodega?.id || '').trim()
          if (!subdivisionId || !divisionId || !bodegaId) return

          subdivisionPathById.set(subdivisionId, {
            subdivisionId,
            divisionId,
            bodegaId,
          })

          if (!divisionIdsByBodega.has(bodegaId)) divisionIdsByBodega.set(bodegaId, new Set())
          divisionIdsByBodega.get(bodegaId).add(divisionId)

          if (!subdivisionIdsByDivision.has(divisionId)) subdivisionIdsByDivision.set(divisionId, new Set())
          subdivisionIdsByDivision.get(divisionId).add(subdivisionId)
        })

        setLocationResolverSubdivisions(subdivisions)
        setMissingLocationProducts(missingProducts)
        setLocationAssignmentsByProduct((prev) => {
          const next = {}
          missingIds.forEach((productId) => {
            const normalizedCurrent = normalizeLocationAssignment(prev?.[productId])
            const subdivisionPath = normalizedCurrent.subdivisionId
              ? subdivisionPathById.get(normalizedCurrent.subdivisionId) || null
              : null

            let bodegaId = normalizedCurrent.bodegaId
            let divisionId = normalizedCurrent.divisionId
            let subdivisionId = normalizedCurrent.subdivisionId

            if (subdivisionPath) {
              bodegaId = subdivisionPath.bodegaId
              divisionId = subdivisionPath.divisionId
              subdivisionId = subdivisionPath.subdivisionId
            }

            const validDivisionIds = bodegaId ? divisionIdsByBodega.get(bodegaId) : null
            if (!bodegaId || !validDivisionIds) {
              next[productId] = createEmptyLocationAssignment()
              return
            }

            if (!divisionId || !validDivisionIds.has(divisionId)) {
              next[productId] = {
                bodegaId,
                divisionId: '',
                subdivisionId: '',
              }
              return
            }

            const validSubdivisionIds = subdivisionIdsByDivision.get(divisionId)
            if (!subdivisionId || !validSubdivisionIds?.has(subdivisionId)) {
              next[productId] = {
                bodegaId,
                divisionId,
                subdivisionId: '',
              }
              return
            }

            next[productId] = {
              bodegaId,
              divisionId,
              subdivisionId,
            }
          })
          return next
        })
        setShowLocationResolver(true)
      } catch (err) {
        notifyError(
          err?.message ||
            'No se pudieron cargar las ubicaciones de la sucursal para completar la entrada.'
        )
      } finally {
        setLocationResolverLoading(false)
      }
    },
    [fetchSubdivisionsForLocationResolver, notifyError]
  )

  const closeLocationResolver = useCallback(() => {
    if (locationResolverSubmitting) return
    setShowLocationResolver(false)
    setLocationResolverError('')
    setLocationDropdownProductId('')
    setLocationDropdownField('')
    setLocationDropdownMaxHeight(null)
    setLocationQuery('')
    setLocationDebouncedQuery('')
  }, [locationResolverSubmitting])

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
    setFormData({
      ...initialForm,
      fecha: todayISO(),
      sucursalId: normalizedPrefilledSucursalId,
    })
    setDetails([])
    setDetailDraft(initialDetail)
    setDetailError('')
    setDetailFieldErrors({})
    setShowProductDropdown(false)
    setProductDropdownMaxHeight(null)
    setProductQuery('')
    setProductOptions([])
    setProductLoading(false)
    setClienteMode(CLIENT_MODE_EXISTING)
    setActiveTab('general')
    setSelectedCliente(null)
    setClienteForm(initialClienteForm)
    setShowClienteDropdown(false)
    setClienteQuery('')
    setClienteOptions([])
    setClienteLoading(false)
    setStockByProduct({})
    setShowLocationResolver(false)
    setLocationResolverLoading(false)
    setLocationResolverSubmitting(false)
    setLocationResolverError('')
    setCheckingLocationCoverage(false)
    setMissingLocationProducts([])
    setLocationResolverSubdivisions([])
    setLocationAssignmentsByProduct({})
    setLocationDropdownProductId('')
    setLocationDropdownField('')
    setLocationDropdownMaxHeight(null)
    setLocationQuery('')
    setLocationDebouncedQuery('')
    setReminderUsers([])
    setReminderUsersLoading(false)
    setReminderUsersError('')
    setSelectedReminderUserIds([])
    setDocumentStatus(DOCUMENT_STATUS.invalid)
    setIsMaximized(false)
    setIsResizingModal(false)
    modalRestoreRef.current = null
    setError('')
    setSelectedCasaComercial(null)
    setCasaComercialDraft(null)
    setCasaComercialQuery('')
    setCasaComercialOptions([])
    setCasaComercialLoading(false)
    setShowCasaComercialDropdown(false)
    fetchCatalogs()
    fetchReminderUsers()
  }, [fetchCatalogs, fetchReminderUsers, normalizedPrefilledSucursalId, open])

  useEffect(() => {
    if (!open) {
      setCatalogsLoading(false)
      setLiveUserScopes(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      appliedPrefillTransferKeyRef.current = ''
      return
    }

    const request = prefilledTransferRequest
    const requestKey = String(request?.requestKey || '').trim()
    if (!requestKey) return
    if (appliedPrefillTransferKeyRef.current === requestKey) return

    const preview = request?.previewData
    if (!preview || typeof preview !== 'object') return

    const trasladoSubTipo = (subTiposEntrada.length ? subTiposEntrada : subTipos).find(
      (item) => normalizeValue(item?.nombre).includes('trasl')
    )
    if (!trasladoSubTipo?.id) return

    const solicitanteId = String(
      preview?.sucursal_solicitante_id || preview?.sucursalId || normalizedPrefilledSucursalId || ''
    ).trim()
    const proveedoraId = String(
      preview?.sucursal_proveedora_id || preview?.sucursalObjetivoId || ''
    ).trim()

    const prefilledDetalles = (Array.isArray(preview?.detalles) ? preview.detalles : [])
      .map((detalle, index) => {
        const productoId = String(detalle?.producto_id || detalle?.productoId || '').trim()
        if (!productoId) return null

        const cantidad = parseIntValue(detalle?.cantidad)
        const valor = parseNumber(detalle?.valor)
        const safeCantidad = Number.isFinite(cantidad) && cantidad > 0 ? cantidad : 0
        const safeValor = Number.isFinite(valor) && valor >= 0 ? valor : 0
        const valorTotalRaw = parseNumber(detalle?.valor_total)
        const valorTotal = Number.isFinite(valorTotalRaw) ? valorTotalRaw : safeCantidad * safeValor

        return {
          uid: `prefill-${requestKey}-${index}`,
          productoId,
          productoCodigo: String(detalle?.producto_codigo || detalle?.productoCodigo || '').trim(),
          productoNombre: String(detalle?.producto_nombre || detalle?.productoNombre || '').trim(),
          estadoProductoId: '',
          estadoProductoNombre: '',
          cantidad: safeCantidad,
          valor: safeValor,
          valor_total: valorTotal,
        }
      })
      .filter(Boolean)

    setFormData((prev) => ({
      ...prev,
      sucursalId: solicitanteId || prev.sucursalId,
      subTipoId: String(trasladoSubTipo.id),
      estadoId: '',
      fecha: todayISO(),
      no_documento: '',
      descripcion: String(preview?.descripcion || '').trim(),
      funcional: true,
      sucursalObjetivoId: proveedoraId,
      cliente: '',
      descuento: '',
      factura_referencia: '',
    }))
    setDetails(prefilledDetalles)
    setDetailDraft(initialDetail)
    setDetailError('')
    setActiveTab('general')
    setShowProductDropdown(false)
    setProductQuery('')
    setProductOptions([])
    setDocumentStatus(DOCUMENT_STATUS.invalid)
    appliedPrefillTransferKeyRef.current = requestKey
  }, [
    normalizedPrefilledSucursalId,
    open,
    prefilledTransferRequest,
    subTipos,
    subTiposEntrada,
  ])

  useEffect(() => {
    if (!open) return
    if (!normalizedPrefilledSucursalId) return
    setFormData((prev) => {
      if (String(prev.sucursalId || '').trim()) return prev
      return { ...prev, sucursalId: normalizedPrefilledSucursalId }
    })
  }, [normalizedPrefilledSucursalId, open])

  useEffect(() => {
    if (!open) return
    if (!isSucursalPrincipalLocked) return
    setFormData((prev) => {
      if (String(prev.sucursalId || '').trim() === normalizedPrefilledSucursalId) return prev
      const next = { ...prev, sucursalId: normalizedPrefilledSucursalId }
      if (String(next.sucursalObjetivoId || '').trim() === normalizedPrefilledSucursalId) {
        next.sucursalObjetivoId = ''
      }
      return next
    })
  }, [isSucursalPrincipalLocked, normalizedPrefilledSucursalId, open])

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

  const updateCasaComercialDropdownPosition = useCallback(() => {
    if (!casaComercialDropdownRef.current) return
    const rect = casaComercialDropdownRef.current.getBoundingClientRect()
    setCasaComercialDropdownStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      zIndex: 9999,
    })
  }, [])

  useEffect(() => {
    if (!open || !showCasaComercialDropdown) return undefined
    updateCasaComercialDropdownPosition()
    const handleReposition = () => updateCasaComercialDropdownPosition()
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [open, showCasaComercialDropdown, updateCasaComercialDropdownPosition])

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

  const updateLocationDropdownPlacement = useCallback(() => {
    if (!showLocationResolver || !locationDropdownProductId || !locationDropdownField) {
      return
    }
    const trigger = locationTriggerRefs.current[`${locationDropdownProductId}:${locationDropdownField}`]
    if (!trigger) return
    const triggerRect = trigger.getBoundingClientRect()
    const spacing = 10
    const availableBelow = Math.max(
      Math.floor(window.innerHeight - triggerRect.bottom - VIEWPORT_PADDING - spacing),
      0
    )
    const availableAbove = Math.max(
      Math.floor(triggerRect.top - VIEWPORT_PADDING - spacing),
      0
    )
    const nextDirection = availableBelow < 220 && availableAbove > availableBelow ? 'up' : 'down'
    const availableSpace = nextDirection === 'up' ? availableAbove : availableBelow
    const nextMaxHeight = Math.max(140, Math.min(320, availableSpace))
    setLocationDropdownMaxHeight((prev) => (prev === nextMaxHeight ? prev : nextMaxHeight))
    // Se renderiza con un portal a document.body (como el resto de dropdowns)
    // para que no quede detras de las filas de Bodega/Division/Subdivision
    // que le siguen dentro del mismo contenedor.
    setLocationDropdownStyle({
      position: 'fixed',
      left: triggerRect.left,
      width: triggerRect.width,
      maxHeight: `${nextMaxHeight}px`,
      zIndex: 9999,
      ...(nextDirection === 'up'
        ? { bottom: Math.max(window.innerHeight - triggerRect.top + spacing, VIEWPORT_PADDING) }
        : { top: triggerRect.bottom + spacing }),
    })
  }, [locationDropdownField, locationDropdownProductId, showLocationResolver])

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
    if (!open || !showLocationResolver || !locationDropdownProductId || !locationDropdownField) {
      setLocationDebouncedQuery('')
      return
    }
    const handle = setTimeout(() => {
      setLocationDebouncedQuery(normalizeValue(locationQuery))
    }, 260)
    return () => clearTimeout(handle)
  }, [locationDropdownField, locationDropdownProductId, locationQuery, open, showLocationResolver])

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

  useEffect(() => {
    if (!open || !isCasaComercialStep) return
    if (casaComercialTimerRef.current) {
      clearTimeout(casaComercialTimerRef.current)
      casaComercialTimerRef.current = null
    }
    casaComercialTimerRef.current = setTimeout(() => {
      searchCasasComerciales(casaComercialQuery.trim(), 'local')
    }, 320)
    return () => {
      if (casaComercialTimerRef.current) {
        clearTimeout(casaComercialTimerRef.current)
        casaComercialTimerRef.current = null
      }
    }
  }, [casaComercialQuery, isCasaComercialStep, open, searchCasasComerciales])

  useEffect(() => {
    if (!open) return

    const subTipoId = String(formData.subTipoId || '').trim()
    const sucursalId = String(formData.sucursalId || '').trim()
    const sucursalObjetivoId = String(formData.sucursalObjetivoId || '').trim()
    const requiresObjective = isTraslado
    const hasRequiredInput = Boolean(
      subTipoId && sucursalId && (!requiresObjective || sucursalObjetivoId)
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
      fetchSuggestedDocumentNumber({
        subTipoId,
        sucursalId,
        sucursalObjetivoId,
      })
    }, 220)

    return () => {
      if (documentCheckTimerRef.current) {
        clearTimeout(documentCheckTimerRef.current)
        documentCheckTimerRef.current = null
      }
    }
  }, [
    fetchSuggestedDocumentNumber,
    formData.subTipoId,
    formData.sucursalId,
    formData.sucursalObjetivoId,
    isTraslado,
    open,
  ])

  useEffect(() => {
    if (
      !open ||
      (!showProductDropdown && !showClienteDropdown && !showCasaComercialDropdown && !locationDropdownProductId && !locationDropdownField)
    ) {
      return undefined
    }
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
      const casaComercialTouched =
        (casaComercialDropdownRef.current && casaComercialDropdownRef.current.contains(event.target)) ||
        (casaComercialDropdownPanelRef.current && casaComercialDropdownPanelRef.current.contains(event.target))
      if (!casaComercialTouched) {
        setShowCasaComercialDropdown(false)
      }
      const locationTouched =
        (locationDropdownRef.current && locationDropdownRef.current.contains(event.target)) ||
        (locationDropdownPanelRef.current && locationDropdownPanelRef.current.contains(event.target))
      if (!locationTouched) {
        setLocationDropdownProductId('')
        setLocationDropdownField('')
        setLocationDropdownMaxHeight(null)
        setLocationQuery('')
        setLocationDebouncedQuery('')
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [locationDropdownField, locationDropdownProductId, open, showCasaComercialDropdown, showClienteDropdown, showProductDropdown])

  useEffect(() => {
    if (activeTab !== 'cliente' && showClienteDropdown) {
      setShowClienteDropdown(false)
    }
    if (activeTab !== 'general' && showProductDropdown) {
      setShowProductDropdown(false)
    }
  }, [activeTab, showClienteDropdown, showProductDropdown])

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
    if (!open || !showLocationResolver || !locationDropdownProductId || !locationDropdownField) {
      return undefined
    }
    updateLocationDropdownPlacement()
    const handleReposition = () => {
      updateLocationDropdownPlacement()
    }
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [
    locationDropdownField,
    locationDropdownProductId,
    open,
    showLocationResolver,
    updateLocationDropdownPlacement,
  ])

  useEffect(() => {
    if (!open || !isTraslado || !formData.sucursalObjetivoId) {
      setStockByProduct({})
      return
    }
    fetchStockByBranch(formData.sucursalObjetivoId)
  }, [fetchStockByBranch, formData.sucursalObjetivoId, isTraslado, open])

  useLayoutEffect(() => {
    if (!open || isMaximized) return
    const compactMode = isSelectorStep || isCasaComercialStep
    const { availableWidth, availableHeight, minWidth, minHeight } = getViewportMetrics(compactMode)
    const preferredWidth = compactMode
      ? SELECTOR_WIDTH
      : (isCompraEntrada ? COMPRA_LOCAL_WIDTH : MIN_WIDTH)
    const width = Math.min(Math.max(preferredWidth, minWidth), availableWidth)

    if (isCasaComercialStep) {
      const estimatedHeight = casaComercialDraft
        ? 390 +
          (casaComercialDraft.telefono ? 48 : 0) +
          (casaComercialDraft.correo ? 48 : 0) +
          (casaComercialDraft.descripcion ? 48 : 0)
        : CASA_SELECTOR_HEIGHT_EMPTY
      const boundsHeight = Math.min(modalRef.current?.offsetHeight || estimatedHeight, availableHeight)
      setModalSize({ width, height: 'auto' })
      setModalPosition({
        x: Math.max((window.innerWidth - width) / 2, VIEWPORT_PADDING),
        y: Math.max((window.innerHeight - boundsHeight) / 2, VIEWPORT_PADDING),
      })
      return
    }

    const preferredHeight = compactMode ? SELECTOR_HEIGHT : MIN_HEIGHT
    const height = Math.min(Math.max(preferredHeight, minHeight), availableHeight)
    setModalSize({ width, height })
    setModalPosition({
      x: Math.max((window.innerWidth - width) / 2, VIEWPORT_PADDING),
      y: Math.max((window.innerHeight - height) / 2, VIEWPORT_PADDING),
    })
  }, [getViewportMetrics, isMaximized, isSelectorStep, isCasaComercialStep, isCompraEntrada, casaComercialDraft, open])

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
    const { minWidth, minHeight } = getViewportMetrics(isSelectorStep || isCasaComercialStep)
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
      const currentHeight =
        modalSizeRef.current.height === 'auto'
          ? modalRef.current?.offsetHeight || 0
          : modalSizeRef.current.height
      const maxX = Math.max(window.innerWidth - modalSizeRef.current.width - VIEWPORT_PADDING, VIEWPORT_PADDING)
      const maxY = Math.max(window.innerHeight - currentHeight - VIEWPORT_PADDING, VIEWPORT_PADDING)
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
      const { minWidth, minHeight, availableWidth, availableHeight } = getViewportMetrics(isSelectorStep || isCasaComercialStep)

      if (isMaximized) {
        setModalSize({ width: availableWidth, height: availableHeight })
        setModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }

      setModalSize((prev) => {
        const width = clamp(prev.width, minWidth, availableWidth)
        const height = prev.height === 'auto' ? 'auto' : clamp(prev.height, minHeight, availableHeight)
        const boundsHeight = height === 'auto' ? (modalRef.current?.offsetHeight || minHeight) : height

        setModalPosition((prevPosition) => ({
          x: Math.min(
            Math.max(prevPosition.x, VIEWPORT_PADDING),
            Math.max(window.innerWidth - width - VIEWPORT_PADDING, VIEWPORT_PADDING)
          ),
          y: Math.min(
            Math.max(prevPosition.y, VIEWPORT_PADDING),
            Math.max(window.innerHeight - boundsHeight - VIEWPORT_PADDING, VIEWPORT_PADDING)
          ),
        }))

        return { width, height }
      })
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [getViewportMetrics, isMaximized, isSelectorStep, isCasaComercialStep, open])

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

  const handleChange = (event) => {
    const { name, value, type, checked } = event.target
    const nextValue = type === 'checkbox' ? checked : value
    setFormData((prev) => {
      if (name === 'no_documento') {
        return prev
      }
      if (name === 'sucursalId' && isSucursalPrincipalLocked) {
        return prev
      }
      const next = {
        ...prev,
        [name]: nextValue,
      }

      if (name === 'sucursalId') {
        if (String(next.sucursalObjetivoId || '').trim() === String(nextValue || '').trim()) {
          next.sucursalObjetivoId = ''
        }
      }

      if (name === 'sucursalObjetivoId' && String(prev.sucursalId || '').trim() === String(nextValue || '').trim()) {
        next.sucursalObjetivoId = ''
      }

      return next
    })
  }

  const handleSubTipoSelect = (subTipoId) => {
    setSelectedCasaComercial(null)
    setCasaComercialDraft(null)
    setCasaComercialQuery('')
    setCasaComercialOptions([])
    setShowCasaComercialDropdown(false)
    handleChange({
      target: {
        name: 'subTipoId',
        value: String(subTipoId || ''),
        type: 'button',
      },
    })
  }

  const handleUseExistingCliente = () => {
    setError('')
    setClienteMode(CLIENT_MODE_EXISTING)
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
  }

  const handleClienteQueryChange = (event) => {
    const value = event.target.value
    setError('')
    setClienteQuery(value)
    setShowClienteDropdown(Boolean(value))
    if (!value.trim()) {
      if (selectedCliente) {
        setSelectedCliente(null)
        setFormData((prev) => ({ ...prev, cliente: '' }))
      }
      setClienteOptions([])
      setClienteLoading(false)
      return
    }

    const currentLabel = formatClienteFieldValue(selectedCliente)
    if (selectedCliente && normalizeValue(value) !== normalizeValue(currentLabel)) {
      setSelectedCliente(null)
      setFormData((prev) => ({ ...prev, cliente: '' }))
    }
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
    setClienteQuery(label)
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

  // Permite moverse de input en input dentro de una fila con las flechas
  // izquierda/derecha, saltando las celdas de solo lectura (Desc. ($),
  // Costo + IVA, etc.) igual que en una hoja de calculo.
  const focusAdjacentRowInput = (currentEl, direction) => {
    const row = currentEl?.closest('.create-user__locations-row')
    if (!row) return
    const focusables = Array.from(row.querySelectorAll('input:not(:disabled)'))
    const index = focusables.indexOf(currentEl)
    if (index === -1) return
    const nextEl = focusables[index + direction]
    if (nextEl) nextEl.focus()
  }

  const handleRowArrowKeyDown = (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusAdjacentRowInput(event.currentTarget, -1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusAdjacentRowInput(event.currentTarget, 1)
    }
  }

  const handleDraftCentavosKeyDown = (field, currentDigits, { maxValue } = {}) => (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      handleRowArrowKeyDown(event)
      return
    }
    if (event.key === 'Backspace') {
      event.preventDefault()
      setDetailDraft((prev) => ({
        ...prev,
        [field]: String(currentDigits || '').replace(/\D/g, '').slice(0, -1),
      }))
      return
    }
    if (/^\d$/.test(event.key)) {
      event.preventDefault()
      const nextDigits = String(currentDigits || '').replace(/\D/g, '') + event.key
      if (Number.isFinite(maxValue) && centavosToNumber(nextDigits) > maxValue) return
      setDetailDraft((prev) => ({ ...prev, [field]: nextDigits }))
    }
  }

  const handleProductSelect = (producto) => {
    if (!producto?.id) return
    const normalizedProductId = String(producto.id || '').trim()
    if (detailProductIdSet.has(normalizedProductId)) {
      setDetailError('Este producto ya fue agregado al detalle.')
      return
    }
    const productPrice = resolveProductPrice(producto)
    setDetailError('')
    setDetailDraft((prev) => ({
      ...prev,
      productoId: String(producto.id),
      valor: isCompraEntrada ? '' : productPrice,
      costo: '',
      descuentoPorcentaje: '',
      cantidad: '',
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
    const productoId = String(detailDraft.productoId || '').trim()
    const cantidad = parseIntValue(detailDraft.cantidad)
    const estadoProductoId = String(defaultEstadoProductoId || '').trim()
    const producto = productos.find((item) => String(item.id) === productoId)
    const valorDigits = String(detailDraft.valor ?? '').trim()
    const valor = isCompraEntrada
      ? (valorDigits ? centavosToNumber(valorDigits) : parseNumber(resolveProductPrice(producto)))
      : parseNumber(valorDigits || resolveProductPrice(producto))
    const costoDigits = String(detailDraft.costo ?? '').trim()
    const costo = costoDigits ? centavosToNumber(costoDigits) : parseNumber(resolveProductCost(producto))
    const descuentoPorcentaje = Math.min(100, Math.max(0, parseNumber(detailDraft.descuentoPorcentaje) || 0))

    if (!productoId) {
      setDetailError('Selecciona un producto.')
      return
    }
    if (detailProductIdSet.has(productoId)) {
      setDetailError('Este producto ya fue agregado al detalle.')
      return
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      setDetailError('Ingresa una cantidad valida.')
      return
    }
    if (!Number.isFinite(valor) || valor < 0) {
      setDetailError('Ingresa un precio valido.')
      return
    }
    if (isCompraEntrada && (!Number.isFinite(costo) || costo < 0)) {
      setDetailError('Ingresa un costo valido.')
      return
    }
    if (isTraslado) {
      if (!formData.sucursalObjetivoId) {
        notifyError('Selecciona la sucursal proveedora para validar disponibilidad.')
        return
      }
      if (stockLoading) {
        notifyError('Espera a que se actualice el stock de la sucursal proveedora.')
        return
      }
      const remaining = (
        productoId === selectedDraftProductId
          ? selectedDraftStockRestante
          : Math.max(
              Number(stockByProduct[productoId] ?? 0) -
                details.reduce((acc, detail) => {
                  if (String(detail.productoId) !== productoId) return acc
                  const qty = parseIntValue(detail.cantidad)
                  return acc + (Number.isFinite(qty) ? qty : 0)
                }, 0),
              0
            )
      )
      if (remaining <= 0) {
        notifyError(`${proveedorStockDisabledMessage} Disponible: 0.`)
        return
      }
      if (cantidad > remaining) {
        notifyError(`${proveedorStockDisabledMessage} Disponible: ${remaining}.`)
        return
      }
    }
    if (!estadoProductoId) {
      setDetailError('No hay estado de producto configurado.')
      return
    }

    const valor_total = cantidad * valor
    const estadoProducto = estadosProducto.find((item) => String(item.id) === estadoProductoId)

    setDetails((prev) => [
      ...prev,
      {
        uid: `det-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        productoId,
        productoCodigo: producto?.codigo ?? '',
        productoNombre: producto?.nombre ?? '',
        productoReferencia: producto?.referencia ?? '',
        productoPrecioBD: resolveProductPrice(producto),
        estadoProductoId,
        estadoProductoNombre: estadoProducto?.nombre ?? '',
        cantidad,
        valor: isCompraEntrada ? decimalToCentavos(valor) : valor,
        valor_total,
        costo: isCompraEntrada ? decimalToCentavos(costo) : null,
        descuentoPorcentaje: isCompraEntrada ? descuentoPorcentaje : null,
      },
    ])

    setDetailDraft(initialDetail)
    setShowProductDropdown(false)
    setProductQuery('')
    setProductOptions([])
  }

  const handleBlockedAddByProveedorStock = useCallback(
    (event) => {
      if (!disableAddByProveedorStock) return
      event?.preventDefault?.()
      event?.stopPropagation?.()
      notifyError(proveedorStockDisabledMessageWithAvailable)
    },
    [disableAddByProveedorStock, notifyError, proveedorStockDisabledMessageWithAvailable]
  )

  const toggleReminderUser = (userId) => {
    const normalizedId = normalizeId(userId)
    if (!normalizedId || adminReminderRecipientIds.has(normalizedId)) return

    setSelectedReminderUserIds((prev) =>
      prev.includes(normalizedId)
        ? prev.filter((id) => id !== normalizedId)
        : [...prev, normalizedId]
    )
  }

  const handleRemoveDetail = (uid) => {
    setDetails((prev) => prev.filter((detail) => detail.uid !== uid))
    setDetailFieldErrors((prev) => {
      if (!(uid in prev)) return prev
      const next = { ...prev }
      delete next[uid]
      return next
    })
  }

  const clearDetailFieldError = (uid, field) => {
    setDetailFieldErrors((prev) => {
      if (!prev[uid]?.[field]) return prev
      const nextRow = { ...prev[uid] }
      delete nextRow[field]
      const next = { ...prev }
      if (Object.keys(nextRow).length) next[uid] = nextRow
      else delete next[uid]
      return next
    })
  }

  const handleDetailFieldChange = (uid, field, rawValue) => {
    clearDetailFieldError(uid, field)
    setDetails((prev) =>
      prev.map((detail) => {
        if (detail.uid !== uid) return detail
        if (field === 'valor') {
          const valor = parseNumber(rawValue)
          const safeValor = Number.isFinite(valor) && valor >= 0 ? valor : 0
          return { ...detail, valor: rawValue, valor_total: detail.cantidad * safeValor }
        }
        if (field === 'descuentoPorcentaje') {
          return { ...detail, descuentoPorcentaje: rawValue }
        }
        return detail
      })
    )
  }

  // Costo y PVP Nuevo (compra local) se editan tecla por tecla
  // como centavos (igual que en Importaciones): Backspace quita el ultimo
  // digito, cada digito nuevo se agrega al final, y se formatea como "0.00".
  const applyDetailCentavos = (uid, field, nextDigits) => {
    clearDetailFieldError(uid, field)
    setDetails((prev) =>
      prev.map((detail) => {
        if (detail.uid !== uid) return detail
        if (field === 'valor') {
          const nextValorDecimal = centavosToNumber(nextDigits)
          return { ...detail, valor: nextDigits, valor_total: detail.cantidad * nextValorDecimal }
        }
        return { ...detail, [field]: nextDigits }
      })
    )
  }

  const handleDetailCentavosKeyDown = (uid, field, currentDigits, { maxValue } = {}) => (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      handleRowArrowKeyDown(event)
      return
    }
    if (event.key === 'Backspace') {
      event.preventDefault()
      applyDetailCentavos(uid, field, String(currentDigits || '').replace(/\D/g, '').slice(0, -1))
      return
    }
    if (/^\d$/.test(event.key)) {
      event.preventDefault()
      const nextDigits = String(currentDigits || '').replace(/\D/g, '') + event.key
      if (Number.isFinite(maxValue) && centavosToNumber(nextDigits) > maxValue) return
      applyDetailCentavos(uid, field, nextDigits)
    }
  }

  const handleResetDetailPrecio = (uid) => {
    setDetails((prev) =>
      prev.map((detail) => {
        if (detail.uid !== uid) return detail
        const valor = parseNumber(detail.productoPrecioBD)
        const currentValorDecimal = isCompraEntrada ? centavosToNumber(detail.valor) : detail.valor
        const nextValorDecimal = Number.isFinite(valor) && valor >= 0 ? valor : currentValorDecimal
        const nextValorStored = isCompraEntrada ? decimalToCentavos(nextValorDecimal) : nextValorDecimal
        return { ...detail, valor: nextValorStored, valor_total: detail.cantidad * nextValorDecimal }
      })
    )
  }

  const buildDescripcion = (clienteLabel = '') => {
    const descripcionBase = String(formData.descripcion || '').trim()
    if (!isVenta) return descripcionBase
    const cliente = String(clienteLabel || '').trim()
    if (!cliente) return descripcionBase
    if (!descripcionBase) return `Cliente: ${cliente}`
    return `Cliente: ${cliente}\n${descripcionBase}`
  }

  const createEntradaMovimiento = useCallback(
    async (ubicacionesIniciales = []) => {
      const descuentoIngresado = isVenta ? parseNumber(formData.descuento) : 0
      if (
        isVenta &&
        descuentoIngresado !== null &&
        (!Number.isFinite(descuentoIngresado) || descuentoIngresado < 0 || descuentoIngresado > 100)
      ) {
        notifyError('El descuento debe ser un porcentaje entre 0 y 100.')
        return false
      }

      setLoading(true)
      try {
        let ventaCliente = selectedCliente
        let ventaClienteLabel = String(formData.cliente || '').trim()

        if (isVenta) {
          if (useExistingCliente) {
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
            setClienteQuery(ventaClienteLabel)
            setClienteMode(CLIENT_MODE_EXISTING)
          }

          if (!useExistingCliente && !useNewCliente) {
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
          tipo_movimiento_id: Number(entradaTipoId),
          sub_tipo_movimiento_id: Number(formData.subTipoId),
          descripcion: buildDescripcion(ventaClienteLabel),
          funcional: isDevolucion ? Boolean(formData.funcional) : true,
          sucursal_objetivo_id: requiresSucursalObjetivo ? Number(formData.sucursalObjetivoId) : null,
          casa_comercial_id: isCompraEntrada && selectedCasaComercial?.id ? Number(selectedCasaComercial.id) : null,
          estado_movimiento_id: Number(formData.estadoId),
          descuento,
          fecha: formData.fecha,
          no_documento: formData.no_documento.trim(),
          factura_referencia: String(formData.factura_referencia || '').trim(),
          detalles: details.map((detail) => ({
            producto_id: Number(detail.productoId),
            cantidad: detail.cantidad,
            estado_producto_id: Number(detail.estadoProductoId),
            valor: isCompraEntrada
              ? Math.max(0, centavosToNumber(detail.valor))
              : Math.max(0, parseNumber(detail.valor) ?? 0),
            valor_total: detail.valor_total,
            costo: isCompraEntrada ? Math.max(0, centavosToNumber(detail.costo)) : null,
            descuento_porcentaje: isCompraEntrada
              ? Math.min(100, Math.max(0, parseNumber(detail.descuentoPorcentaje) ?? 0))
              : null,
            precio_anterior: isCompraEntrada && Number.isFinite(parseNumber(detail.productoPrecioBD))
              ? parseNumber(detail.productoPrecioBD)
              : null,
          })),
          ubicaciones_iniciales: (Array.isArray(ubicacionesIniciales) ? ubicacionesIniciales : [])
            .map((item) => ({
              producto_id: Number(item?.producto_id),
              subdivision_id: Number(item?.subdivision_id),
            }))
            .filter((item) => Number.isFinite(item.producto_id) && Number.isFinite(item.subdivision_id)),
        }

        if (ivaRate !== null) {
          payload.iva_rate = ivaRate
        }

        if (isVenta) {
          setFormData((prev) => ({ ...prev, cliente: ventaClienteLabel }))
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
        const detail = resolveApiErrorMessage(data, 'No se pudo crear la entrada.')
        throw new Error(detail)
      }

      if (data?.reminders_sync_required) {
        emitRemindersSync()
      }

      onCreated?.(data)
      return true
      } catch (err) {
        notifyError(err.message || 'Ocurrió un error al crear la entrada.')
        return false
      } finally {
        setLoading(false)
      }
    },
    [
      buildDescripcion,
      clienteForm,
      details,
      entradaTipoId,
      formData.cliente,
      formData.descuento,
      formData.estadoId,
      formData.factura_referencia,
      formData.fecha,
      formData.funcional,
      formData.iva_rate,
      formData.no_documento,
      formData.sucursalId,
      formData.sucursalObjetivoId,
      formData.subTipoId,
      isDevolucion,
      isVenta,
      notifyError,
      onCreated,
      requiresSucursalObjetivo,
      selectedCliente,
      token,
      useExistingCliente,
      useNewCliente,
    ]
  )

  const closeLocationDropdown = useCallback(() => {
    setLocationDropdownProductId('')
    setLocationDropdownField('')
    setLocationDropdownMaxHeight(null)
    setLocationQuery('')
    setLocationDebouncedQuery('')
  }, [])

  const toggleLocationDropdown = useCallback(
    (productId, field) => {
      // Igual que el dropdown de casa comercial/cliente: clickear el trigger
      // siempre ABRE (nunca cierra por segundo click sobre si mismo). Cerrar
      // es responsabilidad exclusiva del click afuera o de elegir una
      // opcion. Esto evita que un click en el propio trigger se interprete
      // como "abrir" y "cerrar" a la vez segun el orden mousedown/click.
      const normalizedProductId = String(productId || '').trim()
      const normalizedField = String(field || '').trim()
      if (!normalizedProductId || !normalizedField) return
      setLocationDropdownProductId(normalizedProductId)
      setLocationDropdownField(normalizedField)
      setLocationDropdownMaxHeight(null)
      setLocationQuery('')
      setLocationDebouncedQuery('')
      // No se reposiciona aqui con requestAnimationFrame: ese callback capturaba
      // updateLocationDropdownPlacement del render anterior (aun con el campo
      // previo, p. ej. "division"). Al cambiar de un campo abierto a otro sin
      // pasar por cerrado, ese rAF corria DESPUES del efecto de abajo y
      // sobrescribia la posicion/alto con los del trigger equivocado, haciendo
      // que el dropdown recien abierto (p. ej. Subdivision) pareciera
      // "aparecer y desaparecer". El useEffect que observa locationDropdownField
      // ya reposiciona con el closure correcto en cada cambio.
    },
    []
  )

  const filterLocationResolverOptions = useCallback(
    (options, getSearchLabel) => {
      const term = String(locationDebouncedQuery || '').trim()
      if (!term) return options
      return (Array.isArray(options) ? options : []).filter((option) =>
        normalizeValue(String(getSearchLabel?.(option) || '')).includes(term)
      )
    },
    [locationDebouncedQuery]
  )

  const handleLocationAssignmentPick = useCallback(
    (productId, field, optionId) => {
      const normalizedProductId = String(productId || '').trim()
      const normalizedField = String(field || '').trim().toLowerCase()
      const normalizedOptionId = String(optionId || '').trim()
      if (!normalizedProductId || !normalizedField || !normalizedOptionId) return

      setLocationAssignmentsByProduct((prev) => {
        const current = normalizeLocationAssignment(prev?.[normalizedProductId])
        if (normalizedField === 'bodega') {
          return {
            ...prev,
            [normalizedProductId]: {
              bodegaId: normalizedOptionId,
              divisionId: '',
              subdivisionId: '',
            },
          }
        }

        if (normalizedField === 'division') {
          if (!current.bodegaId) return prev
          const availableDivisions = locationResolverDivisionsByBodega.get(current.bodegaId) || []
          const isValidDivision = availableDivisions.some(
            (division) => String(division?.id || '') === normalizedOptionId
          )
          if (!isValidDivision) return prev
          return {
            ...prev,
            [normalizedProductId]: {
              bodegaId: current.bodegaId,
              divisionId: normalizedOptionId,
              subdivisionId: '',
            },
          }
        }

        if (normalizedField === 'subdivision') {
          if (!current.divisionId) return prev
          const availableSubdivisions =
            locationResolverSubdivisionsByDivision.get(current.divisionId) || []
          const isValidSubdivision = availableSubdivisions.some(
            (subdivision) => String(subdivision?.id || '') === normalizedOptionId
          )
          if (!isValidSubdivision) return prev
          return {
            ...prev,
            [normalizedProductId]: {
              bodegaId: current.bodegaId,
              divisionId: current.divisionId,
              subdivisionId: normalizedOptionId,
            },
          }
        }

        return prev
      })

      setLocationResolverError('')
      closeLocationDropdown()
    },
    [
      closeLocationDropdown,
      locationResolverDivisionsByBodega,
      locationResolverSubdivisionsByDivision,
    ]
  )

  const handleConfirmLocationResolver = async () => {
    if (locationResolverSubmitting) return
    const missingAssignments = missingLocationProducts.filter((item) => {
      const productId = String(item?.productoId || '').trim()
      const assignment = normalizeLocationAssignment(locationAssignmentsByProduct?.[productId])
      return (
        !productId ||
        !assignment.bodegaId ||
        !assignment.divisionId ||
        !assignment.subdivisionId
      )
    })

    if (missingAssignments.length > 0) {
      setLocationResolverError(
        'Debes seleccionar bodega, división y subdivisión para cada producto sin ubicación en la sucursal.'
      )
      return
    }

    const ubicacionesIniciales = missingLocationProducts
      .map((item) => {
        const productId = Number(item?.productoId)
        const assignment = normalizeLocationAssignment(
          locationAssignmentsByProduct?.[String(item?.productoId || '').trim()]
        )
        const subdivisionId = Number(assignment.subdivisionId)
        if (!Number.isFinite(productId) || !Number.isFinite(subdivisionId)) return null
        return {
          producto_id: productId,
          subdivision_id: subdivisionId,
        }
      })
      .filter(Boolean)

    setLocationResolverSubmitting(true)
    const created = await createEntradaMovimiento(ubicacionesIniciales)
    setLocationResolverSubmitting(false)

    if (created) {
      setShowLocationResolver(false)
      setLocationResolverError('')
      closeLocationDropdown()
    }
  }

  const handleSubmit = async (event, options = {}) => {
    event.preventDefault()
    if (isCasaComercialStep || justTransitionedFromCasaRef.current) return
    const guardarBorrador = Boolean(options?.guardarBorrador) && isTraslado
    setError('')

    if (!entradaTipoId) {
      notifyError('No se encontró el tipo de movimiento de entrada.')
      return
    }

    if (!formData.subTipoId) {
      notifyError('Selecciona el tipo de entrada.')
      return
    }

    if (!formData.sucursalId) {
      notifyError('Selecciona la sucursal.')
      return
    }

    if (requiresSucursalObjetivo && !formData.sucursalObjetivoId) {
      notifyError(isTraslado ? 'Selecciona la sucursal proveedora.' : 'Selecciona la sucursal destino.')
      return
    }

    if (isTraslado && !formData.urgente && trasladoConflict?.conflicto) {
      const isGuardadoConflict = String(trasladoConflict?.estado || '').trim().toLowerCase() === 'guardado'
      notifyError(
        isGuardadoConflict
          ? 'Ya hay un pedido a sucursal guardado a esta sucursal, edítalo o complétalo para poder hacer más solicitudes a esa sucursal.'
          : `Ya existe una solicitud pendiente para estas sucursales (${trasladoConflict?.no_documento || ''}). Debes aceptarla o rechazarla antes de crear otra.`
      )
      return
    }

    if (!isTraslado && !formData.estadoId) {
      notifyError('No se pudo resolver el estado del movimiento.')
      return
    }

    if (!formData.fecha) {
      notifyError('No se pudo resolver la fecha del movimiento.')
      return
    }

    if (!String(formData.no_documento || '').trim()) {
      notifyError('Espera a que se genere el código del documento.')
      return
    }

    if (documentStatus === DOCUMENT_STATUS.checking) {
      notifyError('Espera a que se genere el código del documento.')
      return
    }
    if (documentStatus === DOCUMENT_STATUS.error) {
      notifyError('No se pudo generar el código del documento. Intenta de nuevo.')
      return
    }

    if (isDevolucion && !String(formData.factura_referencia || '').trim()) {
      notifyError('Ingresa la factura de venta para la devolucion.')
      return
    }

    if (isCompraEntrada && !String(formData.factura_referencia || '').trim()) {
      setFacturaError(true)
      notifyError('Ingresa el numero de factura.')
      return
    }

    if (!guardarBorrador && !details.length) {
      notifyError('Agrega al menos un producto.')
      return
    }

    const nextDetailFieldErrors = {}
    details.forEach((detail) => {
      const productoId = String(detail?.productoId || '').trim()
      const cantidad = parseIntValue(detail?.cantidad)
      const valorDecimal = isCompraEntrada ? centavosToNumber(detail?.valor) : parseNumber(detail?.valor)
      const estadoProductoId = String(detail?.estadoProductoId || '').trim()
      const rowErrors = {}

      if (!Number.isFinite(cantidad) || cantidad <= 0) rowErrors.cantidad = true
      if (!Number.isFinite(valorDecimal) || valorDecimal < 0) rowErrors.valor = true
      if (isCompraEntrada && !String(detail?.costo ?? '').trim()) rowErrors.costo = true
      if (!productoId || (!isTraslado && !estadoProductoId)) rowErrors.producto = true

      if (Object.keys(rowErrors).length) nextDetailFieldErrors[detail.uid] = rowErrors
    })

    const hasIncompleteDetail = Object.keys(nextDetailFieldErrors).length > 0

    if (hasIncompleteDetail) {
      setDetailFieldErrors(nextDetailFieldErrors)
      notifyError('Hay productos con datos incompletos.')
      return
    }

    if (isTraslado) {
      if (String(formData.sucursalId) === String(formData.sucursalObjetivoId)) {
        notifyError('La sucursal proveedora debe ser diferente a la sucursal solicitante.')
        return
      }

      if (!guardarBorrador) {
        if (reminderUsersLoading) {
          setActiveTab('recordatorio')
          notifyError('Espera a que se carguen los usuarios para recordatorios.')
          return
        }

        if (!hasAdminReminderRecipients) {
          setActiveTab('recordatorio')
          notifyError('No se pudo resolver un administrador para el recordatorio obligatorio.')
          return
        }

        if (!hasAdditionalReminderRecipients) {
          setActiveTab('recordatorio')
          notifyError('Debes seleccionar al menos un usuario adicional para el recordatorio.')
          return
        }
      }

      setLoading(true)
      try {
        const reminderRecipientIds = selectedReminderRecipients
          .map((recipient) => Number.parseInt(normalizeId(recipient?.id), 10))
          .filter((recipientId) => Number.isFinite(recipientId) && recipientId > 0)
        const payload = {
          fecha: formData.fecha,
          descripcion: String(formData.descripcion || '').trim(),
          urgente: Boolean(formData.urgente),
          descripcion_urgencia: formData.urgente ? String(formData.descripcion_urgencia || '').trim() : '',
          sucursal_solicitante_id: Number(formData.sucursalId),
          sucursal_proveedora_id: Number(formData.sucursalObjetivoId),
          recordatorio_destinatario_ids: reminderRecipientIds,
          detalles: details.map((detail) => ({
            producto_id: Number(detail.productoId),
            cantidad: Number(detail.cantidad),
            valor: Math.max(0, parseNumber(detail.valor) ?? 0),
          })),
          guardar_borrador: guardarBorrador,
        }

        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/`,
          {
            method: 'POST',
            body: JSON.stringify(payload),
          },
          token
        )

        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const detail = resolveApiErrorMessage(data, 'No se pudo crear la solicitud de traslado.')
          throw new Error(detail)
        }

        emitRemindersSync()
        onCreated?.(data)
      } catch (err) {
        notifyError(err.message || 'Ocurrió un error al crear la solicitud de traslado.')
      } finally {
        setLoading(false)
      }
      return
    }

    if (showLocationResolver || locationResolverLoading || locationResolverSubmitting) return

    if (!isDevolucion || formData.funcional) {
      try {
        setCheckingLocationCoverage(true)
        const missingProducts = await checkMissingLocationsByProduct(formData.sucursalId, details)
        if (missingProducts.length > 0) {
          await openLocationResolverForProducts(missingProducts, formData.sucursalId)
          return
        }
      } catch (err) {
        notifyError(
          err?.message ||
            'No se pudo validar si los productos tienen ubicación en la sucursal seleccionada.'
        )
        return
      } finally {
        setCheckingLocationCoverage(false)
      }
    }

    await createEntradaMovimiento([])
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
    showLocationResolver ? 'create-salida__modal--resolver-open' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const showTabs = isVenta || isTraslado
  const showGeneralTab = !showTabs || activeTab === 'general'
  const defaultHeaderTitle = 'Nueva entrada'
  const rawHeaderDocumentTitle = String(formData.no_documento || '').trim()
  const headerDocumentTitle =
    rawHeaderDocumentTitle && selectedSubTipoLabel
      ? `${selectedSubTipoLabel}: ${rawHeaderDocumentTitle}`
      : rawHeaderDocumentTitle
  const headerTitle =
    !isSelectorStep && !isCasaComercialStep
      ? headerDocumentTitle || (isTraslado && selectedSubTipoLabel ? `${selectedSubTipoLabel}: -` : defaultHeaderTitle)
      : defaultHeaderTitle
  // El "¿Guardar cambios?" al cerrar solo tiene sentido para Pedido a
  // sucursal, que es el unico subtipo con un estado real de borrador
  // guardado en el backend. Los demas (compra local, devolucion, etc.) no
  // soportan guardar incompleto, asi que cerrar ahi no debe ofrecer esa
  // opcion: solo se crean completas o no se crean.
  const hasUnsavedProgress = isTraslado && Boolean(formData.subTipoId) && (
    details.length > 0 ||
    Boolean(String(formData.sucursalObjetivoId || '').trim()) ||
    Boolean(String(formData.descripcion || '').trim()) ||
    Boolean(formData.urgente) ||
    Boolean(String(formData.factura_referencia || '').trim()) ||
    Boolean(String(formData.cliente || '').trim()) ||
    selectedReminderUserIds.length > 0
  )
  const attemptClose = () => {
    if (loading) return
    if (hasUnsavedProgress) {
      setShowCloseConfirm(true)
      return
    }
    onClose?.()
  }

  return (
    <div
      className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`}
      role="dialog"
      aria-modal="true"
      style={overlayStyle}
    >
      <div ref={modalRef} className={modalClassName} style={modalStyle}>
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
            {isMaximizableStep && (
              <button
                type="button"
                className="create-user__icon-button create-user__icon-button--maximize"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={toggleMaximize}
                aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
              >
                <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
              </button>
            )}
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
                    <h4>Selecciona tipo de entrada</h4>
                  </div>
                </div>
                <div className="create-salida__selector-inner">
                  <div className="create-user__field create-user__field--required create-salida__selector-field">
                    <SubTipoButtonSelector
                      ariaLabel="Tipo de entrada"
                      options={entradaSubTipoOptions}
                      value={formData.subTipoId}
                      onChange={handleSubTipoSelect}
                      disabled={loading}
                    />
                  </div>
                </div>
              </section>
            </div>
          ) : isCasaComercialStep ? (
            <div className="create-salida__selector-shell" style={{ flex: 'none', overflow: 'visible' }}>
              <section className="create-user__section create-salida__selector-card">
                <div className="create-user__section-header">
                  <div>
                    <h4>Selecciona proveedor</h4>
                  </div>
                </div>
                <div className="create-salida__selector-inner">
                  <div className="create-user__field create-salida__selector-field">
                    <div
                      className="create-user__dropdown"
                      ref={casaComercialDropdownRef}
                      style={{ width: '100%' }}
                    >
                      <div
                        className="create-user__dropdown-trigger"
                        style={{ cursor: 'text', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px' }}
                        onClick={() => {
                          setShowCasaComercialDropdown(true)
                          requestAnimationFrame(() => updateCasaComercialDropdownPosition())
                        }}
                      >
                        <i className="pi pi-search" style={{ color: 'var(--color-muted, #888)', flexShrink: 0 }} />
                        <input
                          type="text"
                          placeholder="Busca por nombre, código o país..."
                          value={casaComercialQuery}
                          onChange={(event) => {
                            setCasaComercialQuery(event.target.value)
                            setCasaComercialDraft(null)
                            setShowCasaComercialDropdown(true)
                            requestAnimationFrame(() => updateCasaComercialDropdownPosition())
                          }}
                          onFocus={() => {
                            setShowCasaComercialDropdown(true)
                            requestAnimationFrame(() => updateCasaComercialDropdownPosition())
                          }}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
                          style={{ border: 'none', outline: 'none', flex: 1, background: 'transparent', fontSize: 'inherit', color: 'inherit' }}
                          autoComplete="off"
                        />
                        {casaComercialLoading && <i className="pi pi-spin pi-spinner" style={{ flexShrink: 0 }} />}
                      </div>

                      {showCasaComercialDropdown && createPortal(
                        <div
                          ref={casaComercialDropdownPanelRef}
                          className="create-user__dropdown-panel"
                          style={casaComercialDropdownStyle}
                        >
                          <div className="create-user__dropdown-results">
                            {casaComercialLoading && <small className="muted">Buscando...</small>}
                            {!casaComercialLoading && !casaComercialOptions.length && (
                              <small className="muted">
                                {casaComercialQuery.trim() ? 'Sin resultados.' : 'Escribe para buscar.'}
                              </small>
                            )}
                            {casaComercialOptions.map((casa) => (
                              <button
                                key={`casa-option-${casa.id}`}
                                type="button"
                                className="create-user__result-option"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  setCasaComercialDraft(casa)
                                  setCasaComercialQuery('')
                                  setShowCasaComercialDropdown(false)
                                  setCasaComercialOptions([])
                                }}
                              >
                                <div className="create-user__result-info">
                                  <strong>{String(casa?.nombre || '').trim()}</strong>
                                  <small>
                                    {[
                                      String(casa?.codigo || '').trim(),
                                      String(casa?.pais?.nombre || '').trim(),
                                    ].filter(Boolean).join(' · ')}
                                  </small>
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>,
                        document.body
                      )}
                    </div>
                  </div>

                  {casaComercialDraft ? (
                    <div className="create-salida__field-group create-salida__field-group--defined" style={{ marginTop: '14px' }}>
                      <div className="create-user__grid create-user__grid--two">
                        <StaticFieldDisplay label="Descripción" value={casaComercialDraft.nombre} fullWidth />
                        <StaticFieldDisplay label="Código" value={casaComercialDraft.codigo} />
                        <StaticFieldDisplay label="País" value={casaComercialDraft.pais?.nombre} />
                        <StaticFieldDisplay
                          label="Días de entrega"
                          value={casaComercialDraft.dias_entrega != null ? `${casaComercialDraft.dias_entrega} días` : ''}
                        />
                        {casaComercialDraft.telefono && (
                          <StaticFieldDisplay label="Teléfono" value={casaComercialDraft.telefono} />
                        )}
                        {casaComercialDraft.correo && (
                          <StaticFieldDisplay label="Correo" value={casaComercialDraft.correo} />
                        )}
                        {casaComercialDraft.descripcion && (
                          <StaticFieldDisplay label="Nota" value={casaComercialDraft.descripcion} fullWidth />
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>
            </div>
          ) : (
            <>
              {showTabs && (
                <div
                  className="create-user__tabs create-salida__tabs"
                  role="tablist"
                  aria-label={isTraslado ? 'Secciones de solicitud de traslado' : 'Secciones de entrada'}
                >
                  <button
                    type="button"
                    className={`create-user__tab ${activeTab === 'general' ? 'create-user__tab--active' : ''}`}
                    onClick={() => setActiveTab('general')}
                  >
                    {isTraslado ? 'Datos de solicitud' : 'Datos de entrada'}
                  </button>
                  {isTraslado && (
                    <button
                      type="button"
                      className={`create-user__tab ${activeTab === 'recordatorio' ? 'create-user__tab--active' : ''}`}
                      onClick={() => setActiveTab('recordatorio')}
                    >
                      Recordatorio
                    </button>
                  )}
                  {isVenta && (
                    <button
                      type="button"
                      className={`create-user__tab ${activeTab === 'cliente' ? 'create-user__tab--active' : ''}`}
                      onClick={() => setActiveTab('cliente')}
                    >
                      Datos del cliente
                    </button>
                  )}
                </div>
              )}

              <div className="create-user__content create-salida__content">
              <div className="create-user__body">
                {showGeneralTab && (
                  <>
                    <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Datos</p>
                      <h4>Informacion general</h4>
                    </div>
                    {!isEditableEntryDate && (
                      <span className="create-salida__static-value">{formattedFecha || '-'}</span>
                    )}
                  </div>

                  <div className="create-salida__field-groups">
                    {isSucursalPrincipalLocked && (
                      <div className="create-salida__field-group create-salida__field-group--defined create-salida__field-group--paired">
                        <div className={`create-user__grid ${isDevolucion || isCompraEntrada ? 'create-user__grid--three' : 'create-user__grid--two'}`}>
                          <StaticFieldDisplay
                            label={isTraslado ? 'Sucursal destino' : 'Sucursal'}
                            value={selectedSucursalName}
                          />
                          {isCompraEntrada && (
                            <label className="create-user__field create-user__field--required">
                              <span>No. de Factura</span>
                              <input
                                name="factura_referencia"
                                type="text"
                                value={formData.factura_referencia}
                                onChange={(event) => {
                                  handleChange(event)
                                  setFacturaError(false)
                                }}
                                disabled={loading}
                                className={facturaError ? 'create-salida__input--error' : ''}
                                placeholder="Factura del proveedor"
                              />
                            </label>
                          )}
                          {!isTraslado && isEditableEntryDate && (
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
                          )}
                          {isTraslado && (
                            <label className="create-user__field">
                              <span>Sucursal proveedora</span>
                              <select
                                name="sucursalObjetivoId"
                                value={formData.sucursalObjetivoId}
                                onChange={handleChange}
                                disabled={loading}
                                required={requiresSucursalObjetivo}
                                className={
                                  !formData.urgente && trasladoConflict?.conflicto
                                    ? 'create-salida__input--error'
                                    : ''
                                }
                              >
                                <option value="">Selecciona una sucursal</option>
                                {destinationBranches.map((branch) => (
                                  <option key={branch.id} value={branch.id}>
                                    {branch.nombre || `Sucursal ${branch.id}`}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          {isDevolucion && (
                            <>
                              <label className="create-user__field">
                                <span>No. de Factura</span>
                                <input
                                  name="factura_referencia"
                                  type="text"
                                  value={formData.factura_referencia}
                                  onChange={handleChange}
                                  disabled={loading}
                                  required={isDevolucion}
                                  placeholder="Factura emitida en la venta"
                                />
                              </label>

                              <label className="create-user__field">
                                <span>Funcional</span>
                                <select
                                  name="funcional"
                                  value={formData.funcional ? 'true' : 'false'}
                                  onChange={(event) =>
                                    setFormData((prev) => ({ ...prev, funcional: event.target.value === 'true' }))
                                  }
                                  disabled={loading}
                                >
                                  <option value="true">Sí</option>
                                  <option value="false">No</option>
                                </select>
                              </label>
                            </>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="create-user__grid create-user__grid--two">
                      {isTraslado ? (
                        <>
                          {!isSucursalPrincipalLocked && (
                            <label className="create-user__field">
                              <span>Sucursal destino</span>
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

                          {!isSucursalPrincipalLocked && (
                            <label className="create-user__field create-user__field--full">
                              <span>Sucursal proveedora</span>
                              <select
                                name="sucursalObjetivoId"
                                value={formData.sucursalObjetivoId}
                                onChange={handleChange}
                                disabled={loading}
                                required={requiresSucursalObjetivo}
                                className={
                                  !formData.urgente && trasladoConflict?.conflicto
                                    ? 'create-salida__input--error'
                                    : ''
                                }
                              >
                                <option value="">Selecciona una sucursal</option>
                                {destinationBranches.map((branch) => (
                                  <option key={branch.id} value={branch.id}>
                                    {branch.nombre || `Sucursal ${branch.id}`}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </>
                      ) : !isEditableEntryDate ? (
                        <>
                          {!isSucursalPrincipalLocked && (
                            <label className="create-user__field create-user__field--full">
                              <span>Sucursal</span>
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

                          {!isSucursalPrincipalLocked && (
                            <label className="create-user__field">
                              <span>No. de Factura</span>
                              <input
                                name="factura_referencia"
                                type="text"
                                value={formData.factura_referencia}
                                onChange={handleChange}
                                disabled={loading}
                                required={isDevolucion}
                                placeholder="Factura emitida en la venta"
                              />
                            </label>
                          )}

                          {!isSucursalPrincipalLocked && (
                            <label className="create-user__field">
                              <span>Funcional</span>
                              <select
                                name="funcional"
                                value={formData.funcional ? 'true' : 'false'}
                                onChange={(event) =>
                                  setFormData((prev) => ({ ...prev, funcional: event.target.value === 'true' }))
                                }
                                disabled={loading}
                              >
                                <option value="true">Sí</option>
                                <option value="false">No</option>
                              </select>
                            </label>
                          )}
                        </>
                      ) : (
                        <>
                          {!isSucursalPrincipalLocked && (
                            <label className="create-user__field">
                              <span>Sucursal</span>
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

                          {!isSucursalPrincipalLocked && isCompraEntrada && (
                            <label className="create-user__field create-user__field--required">
                              <span>No. de Factura</span>
                              <input
                                name="factura_referencia"
                                type="text"
                                value={formData.factura_referencia}
                                onChange={(event) => {
                                  handleChange(event)
                                  setFacturaError(false)
                                }}
                                disabled={loading}
                                className={facturaError ? 'create-salida__input--error' : ''}
                                placeholder="Factura del proveedor"
                              />
                            </label>
                          )}

                          {!isSucursalPrincipalLocked && (
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
                          )}
                        </>
                      )}

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

                  <div
                    className={`create-user__locations-table create-salida__products-table create-salida__products-table--with-actions${isCompraEntrada ? ' create-salida__products-table--compra-local' : ''}`}
                  >
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>Código</span>
                      {isCompraEntrada && <span>Referencia</span>}
                      <span>Descripción</span>
                      {isCompraEntrada && (
                        <>
                          <span>Costo</span>
                          <span>Desc. (%)</span>
                          <span>Desc. ($)</span>
                          <span>Costo + IVA</span>
                          <span>PVP Act.</span>
                        </>
                      )}
                      <span>{isCompraEntrada ? 'PVP Nue.' : 'Precio'}</span>
                      {isCompraEntrada && <span>PVP + IVA</span>}
                      <span>Cantidad</span>
                      <span>{isCompraEntrada ? 'PVP Total' : 'Precio total'}</span>
                      <span className="create-user__locations-cell--action">Acciones</span>
                    </div>

                    <div className="create-user__locations-row create-user__locations-row--form">
                      <span className="create-salida__product-picker create-salida__product-code-cell">
                        <div className="create-user__dropdown create-salida__product-dropdown" ref={productDropdownRef}>
                          <button
                            type="button"
                            className="create-user__dropdown-trigger"
                            ref={productDropdownTriggerRef}
                            disabled={loading || !hasProductSourceBranch}
                            title={
                              !hasProductSourceBranch
                                ? (isTraslado
                                    ? 'Selecciona una sucursal proveedora primero.'
                                    : 'Selecciona una sucursal primero.')
                                : undefined
                            }
                            onClick={() => {
                              if (!hasProductSourceBranch) return
                              const isOpening = !showProductDropdown
                              if (isOpening) {
                                setProductDropdownMaxHeight(null)
                                setProductQuery('')
                                setProductOptions([])
                                requestAnimationFrame(() => {
                                  updateProductDropdownPlacement()
                                })
                              }
                              setShowProductDropdown((prev) => !prev)
                            }}
                          >
                            <span>
                              {selectedDraftProduct
                                ? formatProductoOptionLabel(selectedDraftProduct)
                                : 'Selecciona un código'}
                            </span>
                            {selectedDraftProduct && showProveedorStockInfo && (
                              <span className="create-salida__trigger-stock">
                                {Math.max(0, Math.trunc(Number(stockByProduct[String(selectedDraftProduct.id)] ?? 0)))}
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
                                    hasProductSourceBranch
                                      ? 'Buscar código o nombre'
                                      : (isTraslado
                                          ? 'Selecciona una sucursal proveedora primero'
                                          : 'Selecciona una sucursal primero')
                                  }
                                  value={productQuery}
                                  onChange={(event) => setProductQuery(event.target.value)}
                                  autoFocus
                                  disabled={!hasProductSourceBranch}
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
                                {showProveedorStockInfo && stockLoading && !productLoading && (
                                  <small className="muted">Actualizando stock de la sucursal proveedora...</small>
                                )}
                                {!hasProductSourceBranch && !productLoading && (
                                  <small className="muted">
                                    {isTraslado
                                      ? 'Selecciona una sucursal proveedora para buscar productos.'
                                      : 'Selecciona una sucursal para buscar productos.'}
                                  </small>
                                )}
                                {!productLoading && hasProductSourceBranch && !productQuery.trim() && (
                                  <small className="muted">Escribe para buscar.</small>
                                )}
                                {!productLoading && productQuery.trim() && !productOptions.length && (
                                  <small className="muted">Sin resultados.</small>
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
                                  const isSelected =
                                    normalizedProductId === String(detailDraft.productoId || '').trim()
                                  const isAlreadyAdded = detailProductIdSet.has(normalizedProductId)
                                  const stockEnSucursalProveedora = Number(
                                    stockByProduct[String(producto.id)] ?? 0
                                  )
                                  const isZeroStock = showProveedorStockInfo && stockEnSucursalProveedora === 0
                                  const codigo = String(producto?.codigo || '').trim() || `ID ${producto.id}`
                                  const nombre = String(producto?.nombre || '').trim()
                                  const dispLabel = showProveedorStockInfo
                                    ? String(Math.max(0, Math.trunc(stockEnSucursalProveedora)))
                                    : String(Number(producto?.total_stock ?? 0))
                                  return (
                                    <button
                                      key={producto.id}
                                      type="button"
                                      className={`create-salida__result-row${isSelected ? ' is-selected' : ''}${isAlreadyAdded ? ' is-added' : ''}${isZeroStock ? ' is-zero-stock' : ''}`}
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={(event) => {
                                        event.preventDefault()
                                        event.stopPropagation()
                                        if (isAlreadyAdded || isZeroStock) return
                                        handleProductSelect(producto)
                                      }}
                                      disabled={isAlreadyAdded || isZeroStock}
                                      title={isZeroStock ? 'Sin stock disponible' : isAlreadyAdded ? 'Ya agregado' : undefined}
                                    >
                                      <span className="result-codigo">{codigo}</span>
                                      <span className="result-nombre">{nombre || '-'}</span>
                                      <span className="result-stock">{dispLabel}</span>
                                    </button>
                                  )
                                })}
                              </div>
                            </div>,
                            document.body
                          )}
                        </div>
                      </span>
                      {isCompraEntrada && (
                        <span
                          onMouseEnter={(e) => showHover(e, [selectedDraftProduct?.referencia].filter(Boolean), 'Referencia')}
                          onMouseLeave={hideHover}
                        >
                          <span className="create-salida__table-static-value">
                            {selectedDraftProduct?.referencia || '-'}
                          </span>
                        </span>
                      )}
                      <span
                        className="create-salida__product-name-cell"
                        onMouseEnter={(e) => showHover(e, [selectedDraftProductName].filter(Boolean), 'Descripción')}
                        onMouseLeave={hideHover}
                      >
                        <span className="create-salida__table-static-value create-salida__table-static-value--name">
                          <span className="create-salida__product-name-text">{selectedDraftProductName || '-'}</span>
                        </span>
                      </span>
                      {isCompraEntrada && (
                        <>
                          <span>
                            <input
                              type="text"
                              inputMode="numeric"
                              readOnly
                              className="create-salida__numeric-input"
                              value={formatCentavos(detailDraft.costo)}
                              onChange={() => {}}
                              onKeyDown={handleDraftCentavosKeyDown('costo', detailDraft.costo)}
                              disabled={loading || !selectedDraftProductId}
                            />
                          </span>
                          <span>
                            <input
                              name="descuentoPorcentaje"
                              type="number"
                              min="0"
                              max="100"
                              step="0.01"
                              className="create-salida__numeric-input"
                              value={detailDraft.descuentoPorcentaje}
                              onChange={handleDetailChange}
                              onKeyDown={handleRowArrowKeyDown}
                              disabled={loading || !selectedDraftProductId}
                            />
                          </span>
                          <span>
                            <span className="create-salida__table-static-value">
                              {formatCurrency(draftDescuentoValor)}
                            </span>
                          </span>
                          <span>
                            <span className="create-salida__table-static-value">
                              {formatCurrency(draftCostoConIva)}
                            </span>
                          </span>
                          <span>
                            <span className="create-salida__table-static-value">
                              {selectedDraftProduct ? formatCurrency(resolveProductPrice(selectedDraftProduct)) : '-'}
                            </span>
                          </span>
                        </>
                      )}
                      <span>
                        {isCompraEntrada ? (
                          <input
                            type="text"
                            inputMode="numeric"
                            readOnly
                            className="create-salida__numeric-input"
                            value={formatCentavos(detailDraft.valor)}
                            onChange={() => {}}
                            onKeyDown={handleDraftCentavosKeyDown('valor', detailDraft.valor)}
                            disabled={loading || !selectedDraftProductId}
                          />
                        ) : (
                          <input
                            name="valor"
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="0.00"
                            value={detailDraft.valor}
                            onChange={handleDetailChange}
                            onKeyDown={handleRowArrowKeyDown}
                            disabled={loading || !selectedDraftProductId}
                          />
                        )}
                      </span>
                      {isCompraEntrada && (
                        <span>
                          <span className="create-salida__table-static-value">
                            {formatCurrency(draftValorConIva)}
                          </span>
                        </span>
                      )}
                      <span>
                        <input
                          className={draftCantidadExceedsProveedorStock ? 'create-salida__input--invalid' : ''}
                          name="cantidad"
                          type="number"
                          min="1"
                          step="1"
                          value={detailDraft.cantidad}
                          onChange={handleDetailChange}
                          onKeyDown={handleRowArrowKeyDown}
                          disabled={loading || !selectedDraftProductId}
                          aria-invalid={draftCantidadExceedsProveedorStock ? 'true' : 'false'}
                        />
                      </span>
                      <span>
                        <span className="create-salida__table-static-value">
                          {draftLineTotal !== null ? draftLineTotal.toFixed(2) : '-'}
                        </span>
                      </span>
                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button
                          type="button"
                          className={`create-user__ghost${disableAddByProveedorStock ? ' create-salida__ghost-disabled' : ''}`}
                          title={disableAddByProveedorStock ? proveedorStockDisabledMessageWithAvailable : ''}
                          aria-disabled={disableAddByProveedorStock ? 'true' : 'false'}
                          onClick={(event) => {
                            if (disableAddByProveedorStock) {
                              handleBlockedAddByProveedorStock(event)
                              return
                            }
                            handleAddDetail()
                          }}
                          disabled={loading}
                        >
                          Agregar
                        </button>
                      </span>
                    </div>

                    {!details.length && (
                      <div className="create-user__locations-row create-user__locations-row--empty">
                        <span>Sin productos agregados.</span>
                      </div>
                    )}

                    {details.map((detail) => {
                      const stockAvailable = Number(
                        stockByProduct[String(detail.productoId || detail.producto_id || '')] ?? 0
                      )
                      const stockLabel = showProveedorStockInfo
                        ? Math.max(0, Math.trunc(stockAvailable))
                        : null

                      const detailCostoDecimal = centavosToNumber(detail.costo)
                      const detailDescuentoPorcentajeDecimal = parseNumber(detail.descuentoPorcentaje)
                      const detailValorDecimal = isCompraEntrada
                        ? centavosToNumber(detail.valor)
                        : parseNumber(detail.valor)
                      const descuentoValor = isCompraEntrada
                        ? calculateDescuentoValor(detailCostoDecimal, detailDescuentoPorcentajeDecimal)
                        : null
                      const costoConIva = isCompraEntrada
                        ? calculateCostoConIva(detailCostoDecimal, detailDescuentoPorcentajeDecimal, ivaRateValue)
                        : null
                      const valorConIva = isCompraEntrada
                        ? calculatePrecioConIva(detailValorDecimal, ivaRateValue)
                        : null

                      return (
                        <div key={detail.uid} className="create-user__locations-row">
                          <span>
                            {detail.productoCodigo || '-'}
                            {stockLabel !== null && (
                              <small className="create-salida__row-stock">
                                {String(stockLabel)}
                              </small>
                            )}
                          </span>
                          {isCompraEntrada && (
                            <span
                              onMouseEnter={(e) => showHover(e, [detail.productoReferencia].filter(Boolean), 'Referencia')}
                              onMouseLeave={hideHover}
                            >
                              {detail.productoReferencia || '-'}
                            </span>
                          )}
                          <span
                            onMouseEnter={(e) => showHover(e, [detail.productoNombre].filter(Boolean), 'Descripción')}
                            onMouseLeave={hideHover}
                          >
                            <span className="create-salida__product-name-text">{detail.productoNombre || '-'}</span>
                          </span>
                          {isCompraEntrada && (
                            <>
                              <span>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  readOnly
                                  className={`create-salida__numeric-input${detailFieldErrors[detail.uid]?.costo ? ' create-salida__input--error' : ''}`}
                                  value={formatCentavos(detail.costo)}
                                  onChange={() => {}}
                                  onKeyDown={handleDetailCentavosKeyDown(detail.uid, 'costo', detail.costo)}
                                  disabled={loading}
                                />
                              </span>
                              <span>
                                <input
                                  type="number"
                                  min="0"
                                  max="100"
                                  step="0.01"
                                  className="create-salida__numeric-input"
                                  value={detail.descuentoPorcentaje ?? ''}
                                  onChange={(event) => handleDetailFieldChange(detail.uid, 'descuentoPorcentaje', event.target.value)}
                                  onKeyDown={handleRowArrowKeyDown}
                                  disabled={loading}
                                />
                              </span>
                              <span className="create-salida__numeric">{formatCurrency(descuentoValor)}</span>
                              <span className="create-salida__numeric">{formatCurrency(costoConIva)}</span>
                              <span className="create-salida__numeric">{formatCurrency(detail.productoPrecioBD)}</span>
                            </>
                          )}
                          <span>
                            {isCompraEntrada ? (
                              <input
                                type="text"
                                inputMode="numeric"
                                readOnly
                                className={`create-salida__numeric-input${detailFieldErrors[detail.uid]?.valor ? ' create-salida__input--error' : ''}`}
                                value={formatCentavos(detail.valor)}
                                onChange={() => {}}
                                onKeyDown={handleDetailCentavosKeyDown(detail.uid, 'valor', detail.valor)}
                                onDoubleClick={() => handleResetDetailPrecio(detail.uid)}
                                title="Doble clic para restaurar el precio guardado en la base de datos"
                                disabled={loading}
                              />
                            ) : (
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="0.00"
                                className={detailFieldErrors[detail.uid]?.valor ? 'create-salida__input--error' : ''}
                                value={detail.valor}
                                onChange={(event) => handleDetailFieldChange(detail.uid, 'valor', event.target.value)}
                                onKeyDown={handleRowArrowKeyDown}
                                onDoubleClick={() => handleResetDetailPrecio(detail.uid)}
                                title="Doble clic para restaurar el precio guardado en la base de datos"
                                disabled={loading}
                              />
                            )}
                          </span>
                          {isCompraEntrada && (
                            <span className="create-salida__numeric">{formatCurrency(valorConIva)}</span>
                          )}
                          <span>{detail.cantidad}</span>
                          <span className="create-salida__numeric">{formatCurrency(detail.valor_total)}</span>
                          <span className="create-user__locations-cell create-user__locations-cell--action">
                            <button type="button" className="create-user__locations-remove" onClick={() => handleRemoveDetail(detail.uid)} disabled={loading}>
                              x
                            </button>
                          </span>
                        </div>
                      )
                    })}

                    <div className="create-user__locations-row create-salida__totals-row">
                      <span className="create-salida__totals-label">Subtotal</span>
                      <span className="create-salida__totals-value">{formatCurrency(subtotalConBorrador)}</span>
                      <span className="create-salida__totals-spacer" />
                    </div>

                    {isVenta && (
                      <div className="create-user__locations-row create-salida__totals-row">
                        <span className="create-salida__totals-label">Descuento ({descuentoPercentLabel}%)</span>
                        <span className="create-salida__totals-value">-{formatCurrency(descuentoAplicado)}</span>
                        <span className="create-salida__totals-spacer" />
                      </div>
                    )}

                    <div className="create-user__locations-row create-salida__totals-row create-salida__totals-row--strong">
                      <span className="create-salida__totals-label">Total con IVA ({ivaPercent}%)</span>
                      <span className="create-salida__totals-value">
                        <strong>{formatCurrency(totalConIva)}</strong>
                      </span>
                      <span className="create-salida__totals-spacer" />
                    </div>
                  </div>

                </section>

                <section className="create-user__section">
                  <label className="create-user__field create-user__field--full">
                    <span>Nota</span>
                    <input
                      name="descripcion"
                      type="text"
                      value={formData.descripcion}
                      onChange={handleChange}
                      disabled={loading}
                    />
                  </label>
                </section>

                {isTraslado && (
                  <section className="create-entrada__urgente-zone">
                    <div className="create-entrada__urgente-zone-header">
                      <span className="create-entrada__urgente-zone-title">Urgente</span>
                    </div>
                    <div className="create-entrada__urgente-zone-body">
                      <label className="create-entrada__urgente-check-row">
                        <input
                          type="checkbox"
                          className="create-entrada__urgente-checkbox"
                          checked={formData.urgente}
                          onChange={(event) => {
                            if (event.target.checked) {
                              setShowUrgenteConfirm(true)
                            } else {
                              setFormData((prev) => ({ ...prev, urgente: false }))
                            }
                          }}
                          disabled={loading}
                        />
                        <span>Marcar solicitud como urgente</span>
                      </label>
                    </div>
                  </section>
                )}

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
                        </div>
                      </div>

                      {useExistingCliente && (
                        <label className="create-user__field create-user__field--full">
                          <span>Cliente</span>
                          <div className="create-user__dropdown" ref={clienteDropdownRef}>
                            <input
                              ref={clienteDropdownTriggerRef}
                              type="text"
                              placeholder="Buscar por cedula o nombre"
                              value={clienteQuery}
                              onChange={handleClienteQueryChange}
                              onFocus={() => {
                                setShowClienteDropdown(Boolean(clienteQuery))
                                requestAnimationFrame(() => updateClienteDropdownPosition())
                              }}
                              disabled={loading}
                              autoComplete="off"
                            />
                            {showClienteDropdown && createPortal(
                              <div
                                ref={clienteDropdownPanelRef}
                                className="create-user__dropdown-panel create-salida__cliente-panel"
                                style={clienteDropdownStyle}
                              >
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
                                    const optionLabel = formatClienteDropdownLabel(cliente)
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
                                          <small>ID: {cliente.id}</small>
                                        </div>
                                        {selected && <span className="create-user__result-tag is-selected">Seleccionado</span>}
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>,
                              document.body
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
                              required
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
                              required
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
                              required
                            />
                          </label>
                        </>
                      )}
                    </div>

                    {useExistingCliente && selectedCliente?.id && (
                      <small className="muted">Cliente existente detectado. Se usara el registro actual al guardar.</small>
                    )}
                  </section>
                )}

                {isTraslado && activeTab === 'recordatorio' && (
                  <section className="create-user__section">
                    <div className="create-user__section-header">
                      <div>
                        <p className="create-user__eyebrow">Recordatorio</p>
                        <h4>Usuarios a quienes recordar</h4>
                      </div>
                    </div>

                    <p className="create-salida__reminder-helper">
                      Al crear la solicitud se genera automáticamente un recordatorio para administradores y usuarios seleccionados.
                    </p>
                    <div className="create-salida__reminder-rule" role="note">
                      Solo se listan usuarios con permisos de <strong>crear y editar</strong> en{' '}
                      <strong>Movimientos - Salidas</strong> de la <strong>sucursal proveedora</strong>.
                    </div>

                    {!hasSelectedReminderTargetBranch && (
                      <small className="muted">Selecciona primero una sucursal proveedora para cargar usuarios.</small>
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
                              <div key={`entrada-admin-recipient-${recipient.id}`} className="permissions-matrix__row">
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
                                  No se detectaron administradores para la sucursal proveedora seleccionada.
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className={`create-salida__reminder-block create-salida__reminder-block--matrix${hasSelectedReminderTargetBranch && !reminderUsersLoading && !hasAdditionalReminderRecipients ? ' create-salida__reminder-block--invalid' : ''}`}>
                      <div className="create-salida__reminder-head">
                        <h5>Usuarios adicionales</h5>
                        <span className="create-salida__reminder-count">{selectedReminderUserIds.length}</span>
                      </div>
                      {hasSelectedReminderTargetBranch && !reminderUsersLoading && !hasAdditionalReminderRecipients && (
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
                                Debes seleccionar una sucursal proveedora.
                              </div>
                            </div>
                          )}

                          {hasSelectedReminderTargetBranch && !reminderUsersLoading && !selectableReminderUsers.length && (
                            <div className="permissions-matrix__row create-salida__reminder-row--empty">
                              <div className="permissions-matrix__cell permissions-matrix__cell--label">
                                No hay usuarios disponibles con permisos de crear y editar en salidas para esta sucursal.
                              </div>
                            </div>
                          )}

                          {selectableReminderUsers.map((userItem) => {
                            const userId = normalizeId(userItem?.id)
                            const checked = selectedReminderUserIds.includes(userId)
                            return (
                              <div key={`entrada-reminder-user-${userId}`} className="permissions-matrix__row">
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

          <div className="create-user__footer">
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={isCasaComercialStep
                ? () => {
                    setFormData((prev) => ({ ...prev, subTipoId: '' }))
                    setSelectedCasaComercial(null)
                    setCasaComercialDraft(null)
                    setCasaComercialQuery('')
                    setCasaComercialOptions([])
                    setShowCasaComercialDropdown(false)
                  }
                : attemptClose}
              disabled={loading || checkingLocationCoverage}
            >
              {isCasaComercialStep ? 'Atrás' : 'Cancelar'}
            </button>
            {isCasaComercialStep ? (
              <button
                type="button"
                className="create-user__action create-user__action--primary"
                disabled={!casaComercialDraft}
                onClick={() => {
                  justTransitionedFromCasaRef.current = true
                  setTimeout(() => { justTransitionedFromCasaRef.current = false }, 500)
                  setSelectedCasaComercial(casaComercialDraft)
                }}
              >
                Siguiente
              </button>
            ) : formData.subTipoId && (
              <button
                type="submit"
                className="create-user__action create-user__action--primary"
                disabled={loading || checkingLocationCoverage}
              >
                {loading
                  ? 'Guardando...'
                  : checkingLocationCoverage
                    ? 'Verificando ubicaciones...'
                    : (isTraslado ? 'Crear solicitud de traslado' : 'Crear entrada')}
              </button>
            )}
          </div>
        </form>

        {showUrgenteConfirm && (
          <div
            className="create-salida__confirm-overlay"
            onMouseDown={() => setShowUrgenteConfirm(false)}
          >
            <div
              className="create-salida__confirm-card create-salida__confirm-card--urgente"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <h4>Confirmar urgencia</h4>
              <p>¿Está seguro de que esta solicitud es urgente?</p>
              <div className="create-salida__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary"
                  onClick={() => setShowUrgenteConfirm(false)}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="create-user__action create-salida__confirm-danger"
                  onClick={() => {
                    setFormData((prev) => ({ ...prev, urgente: true }))
                    setShowUrgenteConfirm(false)
                  }}
                >
                  Sí, es urgente
                </button>
              </div>
            </div>
          </div>
        )}

        {showCloseConfirm && (
          <div
            className="user-details__confirm-overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !loading) setShowCloseConfirm(false)
            }}
          >
            <div className="user-details__confirm-dialog">
              <div className="user-details__confirm-icon">
                <Info size={18} />
              </div>
              <div className="user-details__confirm-content">
                <h4>¿Guardar cambios?</h4>
                <p>¿Quieres guardar los cambios antes de cerrar?</p>
              </div>
              <div className="user-details__confirm-actions">
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
                  className="create-user__action create-user__action--primary"
                  onClick={() => {
                    setShowCloseConfirm(false)
                    handleSubmit({ preventDefault: () => {} }, { guardarBorrador: true })
                  }}
                  disabled={loading}
                >
                  {loading ? 'Guardando...' : (isTraslado ? 'Guardar solicitud y cerrar' : 'Guardar y cerrar')}
                </button>
              </div>
            </div>
          </div>
        )}

        {showLocationResolver && (
          <div
            className="create-salida__confirm-overlay"
            onMouseDown={() => {
              if (locationResolverSubmitting || locationResolverLoading) return
              closeLocationResolver()
            }}
          >
            <div
              className="create-salida__confirm-card create-salida__confirm-card--cancel"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <h4>Asignar ubicaciones faltantes</h4>
              <p>
                Algunos productos no tienen ubicación en{' '}
                <strong>{selectedSucursalName || 'la sucursal seleccionada'}</strong>. Selecciona
                bodega, division y subdivision para cada producto y luego confirma la creacion.
              </p>

              {locationResolverLoading ? (
                <p className="muted">Cargando ubicaciones disponibles...</p>
              ) : (
                <div className="permissions-matrix__table" role="grid">
                  <div className="permissions-matrix__row permissions-matrix__row--head">
                    <div className="permissions-matrix__cell permissions-matrix__cell--label">Producto</div>
                    <div className="permissions-matrix__cell permissions-matrix__cell--label">Ubicacion inicial</div>
                  </div>

                  {missingLocationProducts.map((item) => {
                    const productId = String(item?.productoId || '').trim()
                    const isOpen = locationDropdownProductId === productId
                    const assignment = normalizeLocationAssignment(
                      locationAssignmentsByProduct?.[productId]
                    )
                    const selectedBodegaId = assignment.bodegaId
                    const selectedDivisionId = assignment.divisionId
                    const selectedSubdivisionId = assignment.subdivisionId
                    const bodegaOptions = locationResolverBodegas
                    const divisionOptions =
                      locationResolverDivisionsByBodega.get(selectedBodegaId) || []
                    const subdivisionOptions =
                      locationResolverSubdivisionsByDivision.get(selectedDivisionId) || []
                    const selectedBodega =
                      bodegaOptions.find((bodega) => String(bodega?.id || '') === selectedBodegaId) ||
                      null
                    const selectedDivision =
                      divisionOptions.find((division) => String(division?.id || '') === selectedDivisionId) ||
                      null
                    const selectedSubdivision =
                      subdivisionOptions.find(
                        (subdivision) => String(subdivision?.id || '') === selectedSubdivisionId
                      ) || null
                    const isBodegaOpen = isOpen && locationDropdownField === 'bodega'
                    const isDivisionOpen = isOpen && locationDropdownField === 'division'
                    const isSubdivisionOpen = isOpen && locationDropdownField === 'subdivision'
                    const filteredBodegas = isBodegaOpen
                      ? filterLocationResolverOptions(
                          bodegaOptions,
                          (bodega) =>
                            `${formatBodegaLocationLabel(bodega)} ${String(bodega?.sucursal?.nombre || '').trim()}`
                        )
                      : bodegaOptions
                    const filteredDivisions = isDivisionOpen
                      ? filterLocationResolverOptions(
                          divisionOptions,
                          (division) =>
                            `${formatDivisionLocationLabel(division)} ${String(
                              division?.bodega?.sucursal?.nombre || ''
                            ).trim()}`
                        )
                      : divisionOptions
                    const filteredSubdivisions = isSubdivisionOpen
                      ? filterLocationResolverOptions(
                          subdivisionOptions,
                          (subdivision) =>
                            `${formatSubdivisionLocationLabel(subdivision)} ${String(
                              subdivision?.division?.bodega?.sucursal?.nombre || ''
                            ).trim()}`
                        )
                      : subdivisionOptions

                    return (
                      <div key={`entry-location-product-${productId}`} className="permissions-matrix__row">
                        <div className="permissions-matrix__cell permissions-matrix__cell--label">
                          {[
                            String(item?.productoCodigo || '').trim(),
                            String(item?.productoNombre || '').trim(),
                          ]
                            .filter(Boolean)
                            .join(' - ') || `Producto #${productId}`}
                        </div>
                        <div className="permissions-matrix__cell permissions-matrix__cell--action">
                          <div className="create-entrada__location-picker-grid">
                            <div className="create-entrada__location-picker-item">
                              <small>Bodega</small>
                              <div
                                className="create-user__dropdown create-salida__product-dropdown"
                                ref={isBodegaOpen ? locationDropdownRef : null}
                              >
                                <button
                                  type="button"
                                  ref={(el) => { locationTriggerRefs.current[`${productId}:bodega`] = el }}
                                  className="create-user__dropdown-trigger"
                                  onMouseDown={(event) => event.stopPropagation()}
                                  onClick={() => toggleLocationDropdown(productId, 'bodega')}
                                  disabled={locationResolverSubmitting}
                                >
                                  <span>
                                    {selectedBodega
                                      ? formatBodegaLocationLabel(selectedBodega)
                                      : 'Selecciona una bodega'}
                                  </span>
                                  <i className={`pi pi-chevron-${isBodegaOpen ? 'up' : 'down'}`} />
                                </button>

                                {isBodegaOpen && createPortal(
                                  <div
                                    ref={locationDropdownPanelRef}
                                    className="create-user__dropdown-panel"
                                    style={locationDropdownStyle}
                                  >
                                    <div className="create-user__dropdown-search">
                                      <i className="pi pi-search" />
                                      <input
                                        type="text"
                                        placeholder="Buscar bodega"
                                        value={locationQuery}
                                        onChange={(event) => setLocationQuery(event.target.value)}
                                        disabled={locationResolverSubmitting}
                                      />
                                    </div>
                                    <div
                                      className="create-user__dropdown-results"
                                      style={
                                        locationDropdownMaxHeight
                                          ? {
                                              maxHeight: `${Math.max(locationDropdownMaxHeight - 72, 84)}px`,
                                            }
                                          : undefined
                                      }
                                    >
                                      {!filteredBodegas.length && <small className="muted">Sin resultados.</small>}
                                      {filteredBodegas.map((bodega) => (
                                        <button
                                          key={`entry-location-bodega-option-${productId}-${bodega.id}`}
                                          type="button"
                                          className="create-user__result-option"
                                          onMouseDown={(event) => event.preventDefault()}
                                          onClick={(event) => {
                                            event.preventDefault()
                                            event.stopPropagation()
                                            handleLocationAssignmentPick(productId, 'bodega', bodega.id)
                                          }}
                                          disabled={locationResolverSubmitting}
                                        >
                                          <div className="create-user__result-info">
                                            <strong>
                                              {String(bodega?.nombre || `Bodega ${bodega.id}`).trim()}
                                            </strong>
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  </div>,
                                  document.body
                                )}
                              </div>
                            </div>

                            <div className="create-entrada__location-picker-item">
                              <small>Division</small>
                              <div
                                className="create-user__dropdown create-salida__product-dropdown"
                                ref={isDivisionOpen ? locationDropdownRef : null}
                              >
                                <button
                                  type="button"
                                  ref={(el) => { locationTriggerRefs.current[`${productId}:division`] = el }}
                                  className="create-user__dropdown-trigger"
                                  onMouseDown={(event) => event.stopPropagation()}
                                  onClick={() => toggleLocationDropdown(productId, 'division')}
                                  disabled={locationResolverSubmitting || !selectedBodegaId}
                                >
                                  <span>
                                    {selectedDivision
                                      ? String(selectedDivision?.nombre || '').trim()
                                      : 'Selecciona una division'}
                                  </span>
                                  <i className={`pi pi-chevron-${isDivisionOpen ? 'up' : 'down'}`} />
                                </button>

                                {isDivisionOpen && createPortal(
                                  <div
                                    ref={locationDropdownPanelRef}
                                    className="create-user__dropdown-panel"
                                    style={locationDropdownStyle}
                                  >
                                    <div className="create-user__dropdown-search">
                                      <i className="pi pi-search" />
                                      <input
                                        type="text"
                                        placeholder="Buscar division"
                                        value={locationQuery}
                                        onChange={(event) => setLocationQuery(event.target.value)}
                                        disabled={locationResolverSubmitting}
                                      />
                                    </div>
                                    <div
                                      className="create-user__dropdown-results"
                                      style={
                                        locationDropdownMaxHeight
                                          ? {
                                              maxHeight: `${Math.max(locationDropdownMaxHeight - 72, 84)}px`,
                                            }
                                          : undefined
                                      }
                                    >
                                      {!filteredDivisions.length && <small className="muted">Sin resultados.</small>}
                                      {filteredDivisions.map((division) => (
                                        <button
                                          key={`entry-location-division-option-${productId}-${division.id}`}
                                          type="button"
                                          className="create-user__result-option"
                                          onMouseDown={(event) => event.preventDefault()}
                                          onClick={(event) => {
                                            event.preventDefault()
                                            event.stopPropagation()
                                            handleLocationAssignmentPick(productId, 'division', division.id)
                                          }}
                                          disabled={locationResolverSubmitting}
                                        >
                                          <div className="create-user__result-info">
                                            <strong>
                                              {String(division?.nombre || `Division ${division.id}`).trim()}
                                            </strong>
                                            <small>{formatDivisionLocationLabel(division)}</small>
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  </div>,
                                  document.body
                                )}
                              </div>
                            </div>

                            <div className="create-entrada__location-picker-item">
                              <small>Subdivision</small>
                              <div
                                className="create-user__dropdown create-salida__product-dropdown"
                                ref={isSubdivisionOpen ? locationDropdownRef : null}
                              >
                                <button
                                  type="button"
                                  ref={(el) => { locationTriggerRefs.current[`${productId}:subdivision`] = el }}
                                  className="create-user__dropdown-trigger"
                                  onMouseDown={(event) => event.stopPropagation()}
                                  onClick={() => toggleLocationDropdown(productId, 'subdivision')}
                                  disabled={locationResolverSubmitting || !selectedDivisionId}
                                >
                                  <span>
                                    {selectedSubdivision
                                      ? String(selectedSubdivision?.nombre || '').trim()
                                      : 'Selecciona una subdivision'}
                                  </span>
                                  <i className={`pi pi-chevron-${isSubdivisionOpen ? 'up' : 'down'}`} />
                                </button>

                                {isSubdivisionOpen && createPortal(
                                  <div
                                    ref={locationDropdownPanelRef}
                                    className="create-user__dropdown-panel"
                                    style={locationDropdownStyle}
                                  >
                                    <div className="create-user__dropdown-search">
                                      <i className="pi pi-search" />
                                      <input
                                        type="text"
                                        placeholder="Buscar subdivision"
                                        value={locationQuery}
                                        onChange={(event) => setLocationQuery(event.target.value)}
                                        disabled={locationResolverSubmitting}
                                      />
                                    </div>
                                    <div
                                      className="create-user__dropdown-results"
                                      style={
                                        locationDropdownMaxHeight
                                          ? {
                                              maxHeight: `${Math.max(locationDropdownMaxHeight - 72, 84)}px`,
                                            }
                                          : undefined
                                      }
                                    >
                                      {!filteredSubdivisions.length && (
                                        <small className="muted">Sin resultados.</small>
                                      )}
                                      {filteredSubdivisions.map((subdivision) => (
                                        <button
                                          key={`entry-location-subdivision-option-${productId}-${subdivision.id}`}
                                          type="button"
                                          className="create-user__result-option"
                                          onMouseDown={(event) => event.preventDefault()}
                                          onClick={(event) => {
                                            event.preventDefault()
                                            event.stopPropagation()
                                            handleLocationAssignmentPick(productId, 'subdivision', subdivision.id)
                                          }}
                                          disabled={locationResolverSubmitting}
                                        >
                                          <div className="create-user__result-info">
                                            <strong>
                                              {String(
                                                subdivision?.nombre || `Subdivision ${subdivision.id}`
                                              ).trim()}
                                            </strong>
                                            <small>{formatSubdivisionLocationLabel(subdivision)}</small>
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  </div>,
                                  document.body
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {locationResolverError && (
                <p className="create-salida__confirm-error">{locationResolverError}</p>
              )}

              <div className="create-salida__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary"
                  onClick={closeLocationResolver}
                  disabled={locationResolverSubmitting || locationResolverLoading}
                >
                  Volver
                </button>
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={handleConfirmLocationResolver}
                  disabled={locationResolverSubmitting || locationResolverLoading}
                >
                  {locationResolverSubmitting ? 'Creando entrada...' : 'Confirmar y crear entrada'}
                </button>
              </div>
            </div>
          </div>
        )}

        {isMaximizableStep && (
          <button
            type="button"
            aria-label="Cambiar tamano de ventana"
            className="create-user__resize-handle"
            onMouseDown={handleResizeMouseDown}
          />
        )}
      </div>
      {cellHoverPortal}
    </div>
  )
}

export default CreateEntrada
