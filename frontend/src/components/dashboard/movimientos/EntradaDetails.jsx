import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Pencil } from 'lucide-react'
import '../admin/CreateUsuario/CreateUsuario.css'
import '../admin/UsersDetails/UsersDetails.css'
import './CreateSalida.css'
import { API_URL, authFetch } from '../../../utils/api'
import { getAppPortalRoot } from '../../../utils/portalRoot'
import { formatDate } from '../../../utils/dateFormat'
import useModalAnimation from '../common/useModalAnimation'
import useTableCellHover from '../common/useTableCellHover.jsx'
import EntityRemindersTab from '../common/reminders/EntityRemindersTab'
import StaticFieldDisplay from './StaticFieldDisplay'
import BlockerNotice from '../common/BlockerNotice'
import ProductListSearch, { ProductSearchEmptyRow } from '../common/ProductListSearch'
import { matchesFirst, productDetailMatches } from '../common/productDetailMatches'
import EntradaAjustePreview from './EntradaAjustePreview'
import {
  emitRemindersSync,
  extractUserId,
  formatCurrentUserName,
  normalizeId,
  sanitizeRecipient,
} from '../common/reminders/remindersStorage'
import useUnsavedChangesGuard from '../common/unsavedChanges/useUnsavedChangesGuard'

const DEFAULT_IVA_RATE = 0.15
const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const COMPRA_LOCAL_WIDTH = 1020
const VIEWPORT_PADDING = 12
const REJECTED_TRANSFER_EDITING_EVENT = 'inventario-rejected-transfer-editing'

const emptyForm = {
  sucursalId: '',
  subTipoId: '',
  subTipoNombre: '',
  estadoId: '',
  estadoNombre: '',
  fecha: '',
  no_documento: '',
  factura_referencia: '',
  descripcion: '',
  funcional: true,
  sucursalObjetivoId: '',
  cliente: '',
  descuento: '',
  iva_rate: String(DEFAULT_IVA_RATE),
  urgente: false,
  notaInconveniente: '',
  notaInconvenienteResolucion: '',
  esLegado: false,
}

const initialClienteForm = {
  nombres: '',
  apellidos: '',
  cedula_ruc: '',
  correo: '',
  telefono: '',
  direccion: '',
}

const initialDetail = {
  productoId: '',
  cantidad: '',
  valor: '',
  costo: '',
  descuentoPorcentaje: '',
}

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])

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
const normalizeValue = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()

const normalizeString = (value) => String(value ?? '').trim().toLowerCase()
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

const buildClienteFormFromText = (rawValue, normalizedValue = '') => {
  const raw = String(rawValue || '').trim()
  const normalized = String(normalizedValue || '').trim()
  if (!raw && !normalized) return { ...initialClienteForm }

  const legacyLabelMatch = /^([0-9A-Za-z.-]+)\s*:\s*(.+)$/.exec(raw)
  if (legacyLabelMatch) {
    return {
      ...initialClienteForm,
      cedula_ruc: String(legacyLabelMatch[1] || '').trim(),
      nombres: String(legacyLabelMatch[2] || '').trim(),
    }
  }

  if (/^[0-9A-Za-z.-]{6,}$/.test(raw)) {
    return {
      ...initialClienteForm,
      cedula_ruc: raw,
      nombres: normalized,
    }
  }

  return { ...initialClienteForm, nombres: normalized || raw }
}

const normalizeClienteTextForField = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''

  const separatorIndex = raw.indexOf(':')
  if (separatorIndex <= 0) return raw

  const left = raw.slice(0, separatorIndex).trim()
  const right = raw.slice(separatorIndex + 1).trim()
  if (!right) return raw
  if (/^[0-9A-Za-z.-]+$/.test(left)) return right
  return raw
}

const parseProductCode = (label) => {
  const raw = String(label ?? '').trim()
  if (!raw) return null

  const matchInParens = /\(([^)]+)\)\s*$/.exec(raw)
  if (matchInParens) return matchInParens[1].trim()

  const matchLeadingCode = /^([A-Za-z0-9._/-]+)\s*-\s+/.exec(raw)
  if (matchLeadingCode) return matchLeadingCode[1].trim()

  return null
}

const stripCodeFromProductLabel = (label, code) => {
  const raw = String(label ?? '').trim()
  if (!raw) return ''
  if (!code) return raw
  const escaped = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const withoutLeadingCode = raw.replace(new RegExp(`^${escaped}\\s*-\\s*`, 'i'), '').trim()
  return withoutLeadingCode || raw
}

const parseSubTipoLabel = (label) => {
  const text = String(label ?? '')
  if (!text) return ''
  const parts = text.split('-')
  return parts.length > 1 ? parts[parts.length - 1].trim() : text.trim()
}

const resolveMovementKey = (value) => {
  const normalized = normalizeValue(value)
  if (normalized.includes('devol')) return 'devol'
  if (normalized.includes('trasl')) return 'trasl'
  if (normalized.includes('vent')) return 'vent'
  if (normalized.includes('proform')) return 'proform'
  if (normalized.includes('factur')) return 'factur'
  if (normalized.includes('vendid')) return 'vendid'
  if (normalized.includes('enviad')) return 'enviad'
  if (normalized.includes('recibid')) return 'recibid'
  if (normalized.includes('parcial')) return 'parcial'
  return ''
}

const resolveCatalogItemByLabel = (list, label) => {
  const raw = String(label ?? '').trim()
  if (!raw) return null

  const normalizedRaw = normalizeValue(raw)
  const normalizedParsed = normalizeValue(parseSubTipoLabel(raw))
  const candidates = [normalizedRaw, normalizedParsed].filter(Boolean)

  for (const candidate of candidates) {
    const exact = list.find((item) => normalizeValue(item?.nombre) === candidate)
    if (exact) return exact
  }

  for (const candidate of candidates) {
    const fuzzy = list.find((item) => {
      const name = normalizeValue(item?.nombre)
      return name.includes(candidate) || candidate.includes(name)
    })
    if (fuzzy) return fuzzy
  }

  const key = candidates.map(resolveMovementKey).find(Boolean)
  if (!key) return null
  return list.find((item) => normalizeValue(item?.nombre).includes(key)) || null
}

const findByName = (list, name) =>
  list.find((item) => normalizeValue(item?.nombre) === normalizeValue(name))

const extractClienteFromDescripcion = (value) => {
  const raw = String(value ?? '')
  if (!raw) return { cliente: '', descripcion: '' }
  const lines = raw.split(/\r?\n/)
  const firstLine = String(lines[0] ?? '').trim()
  if (!normalizeValue(firstLine).startsWith('cliente:')) {
    return { cliente: '', descripcion: raw }
  }

  const separatorIndex = firstLine.indexOf(':')
  const cliente = separatorIndex >= 0 ? firstLine.slice(separatorIndex + 1).trim() : ''
  const descripcion = lines.slice(1).join('\n').trim()
  return { cliente, descripcion }
}

function EntradaDetails({
  open,
  entradaId,
  previewData = null,
  readOnly = false,
  token,
  onClose,
  onUpdated,
  onDeleted,
  onError,
  currentUser,
  allowEdit = true,
  allowDelete = true,
  onCancelTransfer,
  cancellingTransfer = false,
  onResubmitTransfer,
  resubmittingTransfer = false,
  onDistribuirCompra,
}) {
  const [formData, setFormData] = useState(emptyForm)
  const [creatorInfo, setCreatorInfo] = useState({
    creadoPorNombre: '',
    enviadoPorNombre: '',
    recibidoPorNombre: '',
  })
  const [rawApiEstadoNombre, setRawApiEstadoNombre] = useState('')
  const [originalData, setOriginalData] = useState(null)
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteInventoryAction, setDeleteInventoryAction] = useState('reverse')
  const [isEditing, setIsEditing] = useState(false)
  // Edicion de cantidades de una entrada recibida: donde sumar/restar cada
  // producto y el plan que devuelve el backend (se aplica solo la diferencia).
  const [ajusteOverrides, setAjusteOverrides] = useState({})
  const [ajustePlan, setAjustePlan] = useState(null)
  useEffect(() => {
    if (!isEditing) {
      setAjusteOverrides({})
      setAjustePlan(null)
    }
  }, [isEditing])
  const [, setError] = useState('')

  const [branches, setBranches] = useState([])
  const [tipoMovimientos, setTipoMovimientos] = useState([])
  const [subTipos, setSubTipos] = useState([])
  const [estados, setEstados] = useState([])
  const [productos, setProductos] = useState([])
  const [estadosProducto, setEstadosProducto] = useState([])

  const [details, setDetails] = useState([])
  // Buscador rapido de productos dentro de este movimiento.
  const [productSearch, setProductSearch] = useState('')
  // Lo que coincide va primero; el resto sigue visible debajo.
  const productMatchCount = useMemo(
    () => (productSearch.trim() ? details.filter((detail) => productDetailMatches(detail, productSearch)).length : details.length),
    [details, productSearch]
  )
  const filteredDetails = useMemo(
    () => (productSearch.trim() ? matchesFirst(details, (detail) => productDetailMatches(detail, productSearch)) : details),
    [details, productSearch]
  )
  const { showHover, hideHover, portal: cellHoverPortal } = useTableCellHover()
  // Tarjeta con la solucion de los faltantes de un producto (hover en el "(n)" rojo).
  const [faltantePopover, setFaltantePopover] = useState(null)
  const openFaltantePopover = useCallback((event, detail) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setFaltantePopover({
      uid: detail.uid,
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left - 120, window.innerWidth - 328)),
      codigo: detail.productoCodigo,
      detalles: detail.faltanteDetalles || [],
    })
  }, [])
  const closeFaltantePopover = useCallback(() => setFaltantePopover(null), [])
  useEffect(() => {
    if (!faltantePopover) return undefined
    window.addEventListener('scroll', closeFaltantePopover, true)
    window.addEventListener('resize', closeFaltantePopover)
    return () => {
      window.removeEventListener('scroll', closeFaltantePopover, true)
      window.removeEventListener('resize', closeFaltantePopover)
    }
  }, [faltantePopover, closeFaltantePopover])
  const [detailDraft, setDetailDraft] = useState(initialDetail)
  const [detailError, setDetailError] = useState('')
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [productDropdownDirection, setProductDropdownDirection] = useState('down')
  const [productDropdownMaxHeight, setProductDropdownMaxHeight] = useState(null)
  const [productQuery, setProductQuery] = useState('')
  const [productOptions, setProductOptions] = useState([])
  const [productLoading, setProductLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [selectedCliente, setSelectedCliente] = useState(null)
  const [clienteForm, setClienteForm] = useState(initialClienteForm)
  const [showClienteDropdown, setShowClienteDropdown] = useState(false)
  const [clienteQuery, setClienteQuery] = useState('')
  const [clienteOptions, setClienteOptions] = useState([])
  const [clienteLoading, setClienteLoading] = useState(false)
  const [stockByProduct, setStockByProduct] = useState({})
  const [stockLoading, setStockLoading] = useState(false)
  const [transferSolicitudId, setTransferSolicitudId] = useState('')
  const [reminderUsers, setReminderUsers] = useState([])
  const [reminderUsersLoading, setReminderUsersLoading] = useState(false)
  const [reminderUsersError, setReminderUsersError] = useState('')
  const [selectedReminderUserIds, setSelectedReminderUserIds] = useState([])
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })
  const [isMaximized, setIsMaximized] = useState(false)
  const [isResizingModal, setIsResizingModal] = useState(false)
  const modalRef = useRef(null)
  const productDropdownRef = useRef(null)
  const productDropdownTriggerRef = useRef(null)
  const productSearchSeqRef = useRef(0)
  const clienteDropdownRef = useRef(null)
  const clienteSearchTimerRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalResize = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const modalSizeRef = useRef(modalSize)
  const modalPositionRef = useRef(modalPosition)
  const modalRestoreRef = useRef(null)

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
  const getViewportMetrics = useCallback(() => {
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    return {
      availableWidth,
      availableHeight,
      minWidth: Math.min(MIN_WIDTH, availableWidth),
      minHeight: Math.min(MIN_HEIGHT, availableHeight),
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

  useEffect(() => {
    if (!detailError) return
    notifyError(detailError)
  }, [detailError, notifyError])

  const linkedSolicitudId = String(
    previewData?.solicitud_traslado_id ||
      previewData?.solicitudTrasladoId ||
      previewData?.id ||
      previewData?.solicitud_id ||
      formData.solicitudTrasladoId ||
      formData.solicitud_traslado?.id ||
      ''
  ).trim()
  const hasPreviewData = Boolean(previewData?.es_solicitud_traslado || linkedSolicitudId)
  const normalizedSolicitudStateName = normalizeValue(
    formData.estadoNombre ||
      previewData?.estado_nombre ||
      previewData?.estado ||
      ''
  )
  const isPreviewPendingSolicitud = hasPreviewData && normalizedSolicitudStateName.includes('pend')
  const isPreviewRejectedSolicitud =
    hasPreviewData &&
    (normalizedSolicitudStateName.includes('rechaz') || normalizedSolicitudStateName.includes('cancel'))
  const isPreviewGuardadoSolicitud = hasPreviewData && normalizedSolicitudStateName.includes('guardad')

  const entradaTipoId = useMemo(() => {
    const entrada = tipoMovimientos.find((tipo) => normalizeValue(tipo?.nombre).startsWith('ent'))
    return entrada?.id ?? ''
  }, [tipoMovimientos])

  const subTiposEntrada = useMemo(
    () => {
      if (!entradaTipoId) return subTipos
      const filtered = subTipos.filter(
        (sub) => String(sub?.tipo_movimiento?.id || '') === String(entradaTipoId)
      )
      return filtered.length ? filtered : subTipos
    },
    [subTipos, entradaTipoId]
  )

  const selectedSubTipo = useMemo(
    () =>
      subTipos.find((sub) => String(sub.id) === String(formData.subTipoId)) ||
      subTiposEntrada.find((sub) => String(sub.id) === String(formData.subTipoId)),
    [formData.subTipoId, subTipos, subTiposEntrada]
  )

  const selectedSubTipoName = normalizeValue(selectedSubTipo?.nombre || formData.subTipoNombre)
  const isDevolucion = selectedSubTipoName.includes('devol')
  const isTraslado = selectedSubTipoName.includes('trasl')
  const isVenta = selectedSubTipoName.includes('vent')
  const isCompraEntrada = selectedSubTipoName.includes('compra') || selectedSubTipoName.includes('import')
  const requiresSucursalObjetivo = isTraslado

  const selectedBranchName = useMemo(
    () => branches.find((b) => String(b.id) === String(formData.sucursalId))?.nombre || formData.sucursalId || '-',
    [branches, formData.sucursalId]
  )
  const selectedObjectiveBranchName = useMemo(
    () => branches.find((b) => String(b.id) === String(formData.sucursalObjetivoId))?.nombre || formData.sucursalObjetivoId || '-',
    [branches, formData.sucursalObjetivoId]
  )
  const formattedFecha = useMemo(() => formatDate(formData.fecha), [formData.fecha])

  const currentCreatorId = useMemo(() => normalizeId(extractUserId(currentUser)), [currentUser])
  const currentCreatorName = useMemo(() => formatCurrentUserName(currentUser), [currentUser])
  const currentCreatorEmail = String(currentUser?.correo || currentUser?.email || '').trim()
  const isCurrentUserAdmin = useMemo(
    () => hasUsersModuleAccess(currentUser?.permisos),
    [currentUser]
  )

  const selectedReminderTargetBranchId = String(formData.sucursalObjetivoId || '').trim()
  const hasSelectedReminderTargetBranch = Boolean(selectedReminderTargetBranchId)

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
  const proveedorSucursalLabel =
    String(branches.find((b) => String(b.id) === selectedReminderTargetBranchId)?.nombre || '').trim() ||
    'la sucursal proveedora'
  // Aviso persistente cuando la solicitud no se puede enviar por falta de destinatarios.
  let reminderBlocker = null
  if (isTraslado && isPreviewGuardadoSolicitud && hasSelectedReminderTargetBranch && !reminderUsersLoading) {
    if (reminderUsersError) {
      reminderBlocker = {
        title: 'No se puede crear la solicitud de traslado: no se cargaron los usuarios del recordatorio',
        reason: `${reminderUsersError} Sin esa lista no se puede elegir a quién avisar en ${proveedorSucursalLabel}. Vuelve a intentarlo.`,
        retry: true,
      }
    } else if (!hasAdminReminderRecipients) {
      reminderBlocker = {
        title: 'No se puede crear la solicitud de traslado: no hay administradores para el recordatorio',
        reason: 'Toda solicitud de traslado avisa obligatoriamente a los administradores y no se encontró ningún usuario administrador activo. Pide que se marque al menos un usuario activo como administrador en Administrar › Usuarios.',
        goTo: 'Administrar',
      }
    } else if (!selectableReminderUsers.length) {
      reminderBlocker = {
        title: `No se puede crear la solicitud de traslado: ${proveedorSucursalLabel} no tiene usuarios que puedan recibirla`,
        reason: `Se necesita al menos un usuario (además de los administradores) con permiso de crear y editar Salidas en ${proveedorSucursalLabel}. Asígnalo en Administrar › Usuarios › permisos de Movimientos - Salidas para ${proveedorSucursalLabel}.`,
        goTo: 'Administrar',
      }
    }
  }

  const toggleReminderUser = (userId) => {
    const normalizedId = normalizeId(userId)
    if (!normalizedId || adminReminderRecipientIds.has(normalizedId)) return

    setSelectedReminderUserIds((prev) =>
      prev.includes(normalizedId)
        ? prev.filter((id) => id !== normalizedId)
        : [...prev, normalizedId]
    )
  }

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
    if (!open || !isTraslado || !isPreviewGuardadoSolicitud) return
    fetchReminderUsers()
  }, [fetchReminderUsers, isPreviewGuardadoSolicitud, isTraslado, open])

  useEffect(() => {
    if (!open) {
      setSelectedReminderUserIds([])
      setReminderUsers([])
      setReminderUsersError('')
    }
  }, [open])

  useEffect(() => {
    if (!reminderUsersError) return
    notifyError(reminderUsersError)
  }, [notifyError, reminderUsersError])

  useEffect(() => {
    if ((!isTraslado || !isPreviewGuardadoSolicitud) && activeTab === 'recordatorio') {
      setActiveTab('general')
    }
    if (isTraslado && isPreviewGuardadoSolicitud && activeTab === 'recordatorios') {
      setActiveTab('general')
    }
  }, [activeTab, isPreviewGuardadoSolicitud, isTraslado])

  useEffect(() => {
    setSelectedReminderUserIds((prev) => {
      if (!prev.length) return prev
      const validIds = new Set(selectableReminderUsers.map((userItem) => normalizeId(userItem.id)).filter(Boolean))
      const filtered = prev.filter((id) => validIds.has(normalizeId(id)))
      return filtered.length === prev.length ? prev : filtered
    })
  }, [selectableReminderUsers])

  const stockBranchId = useMemo(() => {
    if (isTraslado) {
      return String(formData.sucursalObjetivoId || '').trim()
    }
    return String(formData.sucursalId || '').trim()
  }, [formData.sucursalId, formData.sucursalObjetivoId, isTraslado])
  // El chequeo de "stock disponible en la sucursal proveedora" solo tiene
  // sentido mientras el traslado sigue siendo una solicitud (todavia se
  // puede editar la cantidad). Una vez que ya se envio o se recibio, ese
  // stock "actual" ya no tiene relacion con lo que se envio en su momento
  // -- mostrarlo como advertencia ahi es enganoso, no un error real.
  const normalizedRawApiEstado = normalizeValue(rawApiEstadoNombre)
  const isAlreadyShippedMovement = Boolean(rawApiEstadoNombre) && (
    normalizedRawApiEstado.includes('enviado') ||
    normalizedRawApiEstado.includes('recib') ||
    normalizedRawApiEstado.includes('llego')
  )
  const showProveedorStockInfo = isTraslado && Boolean(stockBranchId) && !isAlreadyShippedMovement

  const devolucionEstadoOptions = useMemo(
    () =>
      estados.filter((estado) => normalizeValue(estado?.nombre) === 'recibido'),
    [estados]
  )

  const trasladoEstadoOptions = useMemo(() => {
    const allowed = new Set(['enviado', 'recibido', 'parcialmente recibido'])
    return estados.filter((estado) => {
      const normalized = normalizeValue(estado?.nombre)
      if (allowed.has(normalized)) return true
      return normalized.includes('solicitud')
    })
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

  const estadoCategoryIds = useMemo(() => {
    const pending = new Set()
    const sent = new Set()
    const accepted = new Set()
    const rejected = new Set()
    estados.forEach((estado) => {
      const id = String(estado?.id || '').trim()
      if (!id) return
      const normalized = normalizeValue(estado?.nombre)
      if (normalized.includes('rechaz')) {
        rejected.add(id)
        return
      }
      if (normalized.includes('acept')) {
        accepted.add(id)
        return
      }
      if (normalized.includes('pendient')) {
        pending.add(id)
        return
      }
      if (normalized.includes('envi')) {
        sent.add(id)
      }
    })
    return { pending, sent, accepted, rejected }
  }, [estados])

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

  const selectedEstadoName =
    estados.find((estado) => String(estado.id) === String(formData.estadoId))?.nombre ||
    estadoOptions.find((estado) => String(estado.id) === String(formData.estadoId))?.nombre ||
    formData.estadoNombre ||
    ''
  const normalizedSelectedEstadoName = normalizeValue(selectedEstadoName)
  const resolvedEstadoId = String(formData.estadoId || '').trim()
  const estadoMatchesPending =
    estadoCategoryIds.pending.has(resolvedEstadoId) ||
    normalizedSelectedEstadoName.includes('pendient')
  const estadoMatchesRejected =
    estadoCategoryIds.rejected.has(resolvedEstadoId) ||
    normalizedSelectedEstadoName.includes('rechaz') ||
    normalizedSelectedEstadoName.includes('cancel')
  const estadoMatchesGuardado = normalizedSelectedEstadoName.includes('guardad')
  const estadoMatchesAccepted =
    estadoCategoryIds.accepted.has(resolvedEstadoId) ||
    normalizedSelectedEstadoName.includes('acept') ||
    normalizedSelectedEstadoName.includes('aprob')
  const estadoMatchesSent =
    estadoCategoryIds.sent.has(resolvedEstadoId) ||
    (normalizedSelectedEstadoName.includes('envi') &&
      !estadoMatchesPending &&
      !estadoMatchesRejected &&
      !estadoMatchesAccepted)
  const isSentSolicitud = isTraslado && estadoMatchesSent
  const estadoMatchesReceived =
    (normalizedSelectedEstadoName.includes('recib') || normalizedSelectedEstadoName.includes('parcial')) &&
    !estadoMatchesPending && !estadoMatchesRejected && !estadoMatchesAccepted && !estadoMatchesSent
  const isPendingSolicitudRibbon = estadoMatchesPending
  const isRejectedSolicitudRibbon = estadoMatchesRejected
  const isGuardadoSolicitudRibbon = estadoMatchesGuardado
  const isAcceptedSolicitudRibbon = estadoMatchesAccepted
  const isSentSolicitudRibbon = estadoMatchesSent
  const isReceivedRibbon = estadoMatchesReceived
  const canEditTrasladoState = !isTraslado || estadoMatchesPending || estadoMatchesRejected || estadoMatchesGuardado
  const isReadOnlyMode = Boolean(
    readOnly ||
      isSentSolicitud ||
      formData.esLegado ||
      (isTraslado && !estadoMatchesPending && !estadoMatchesRejected && !estadoMatchesGuardado)
  )
  const effectiveAllowEdit =
    canEditTrasladoState &&
    (allowEdit || isPreviewPendingSolicitud || isPreviewRejectedSolicitud || isPreviewGuardadoSolicitud) &&
    !isSentSolicitud
  const canStartEditingPreviewSolicitud = Boolean(
    hasPreviewData &&
    !readOnly &&
    (isPreviewPendingSolicitud || isPreviewRejectedSolicitud || isPreviewGuardadoSolicitud) &&
    (allowEdit || isPreviewPendingSolicitud || isPreviewRejectedSolicitud || isPreviewGuardadoSolicitud)
  )
  const lineItemsReadOnly = Boolean(isReadOnlyMode || !isEditing)
  const showDetailActions = !isReadOnlyMode && !lineItemsReadOnly
  const isPendingSolicitudEntry = hasPreviewData && (isPreviewPendingSolicitud || isPreviewGuardadoSolicitud)

  useEffect(() => {
    if (open) return
    setShowDeleteConfirm(false)
    setDeleteInventoryAction(isPendingSolicitudEntry ? 'keep' : 'reverse')
  }, [isPendingSolicitudEntry, open])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const solicitudId = String(transferSolicitudId || linkedSolicitudId || '').trim()
    if (!solicitudId) return undefined

    const active = Boolean(open && (isRejectedSolicitudRibbon || isPreviewRejectedSolicitud))
    window.dispatchEvent(
      new CustomEvent(REJECTED_TRANSFER_EDITING_EVENT, {
        detail: { solicitudId, active },
      })
    )

    return () => {
      window.dispatchEvent(
        new CustomEvent(REJECTED_TRANSFER_EDITING_EVENT, {
          detail: { solicitudId, active: false },
        })
      )
    }
  }, [isPreviewRejectedSolicitud, isRejectedSolicitudRibbon, linkedSolicitudId, open, transferSolicitudId])

  const ivaRateValue = useMemo(() => {
    const parsed = parseNumber(formData.iva_rate)
    if (parsed === null || parsed < 0) return DEFAULT_IVA_RATE
    return parsed
  }, [formData.iva_rate])

  const draftLineTotal = useMemo(
    () => calculateLineTotal(detailDraft.cantidad, detailDraft.valor),
    [detailDraft.cantidad, detailDraft.valor]
  )

  const draftDescuentoValor = useMemo(
    () => calculateDescuentoValor(detailDraft.costo, detailDraft.descuentoPorcentaje),
    [detailDraft.costo, detailDraft.descuentoPorcentaje]
  )

  const draftCostoConIva = useMemo(
    () => calculateCostoConIva(detailDraft.costo, detailDraft.descuentoPorcentaje, ivaRateValue),
    [detailDraft.costo, detailDraft.descuentoPorcentaje, ivaRateValue]
  )

  const draftValorConIva = useMemo(
    () => calculatePrecioConIva(detailDraft.valor, ivaRateValue),
    [detailDraft.valor, ivaRateValue]
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

  const getProductReservedQuantity = useCallback(
    (productId) => {
      const normalizedId = String(productId ?? '').trim()
      if (!normalizedId) return 0
      return details.reduce((acc, detail) => {
        if (String(detail.productoId) !== normalizedId) return acc
        const qty = parseIntValue(detail.cantidad)
        return acc + (Number.isFinite(qty) ? qty : 0)
      }, 0)
    },
    [details]
  )

  const getProductStockAllowance = useCallback(
    (productId) => {
      const normalizedId = String(productId ?? '').trim()
      if (!normalizedId) return 0
      const base = Number(stockByProduct[normalizedId] ?? 0)
      return Number.isFinite(base) ? Math.max(0, base) : 0
    },
    [stockByProduct]
  )

  const hasInsufficientStockDetail = useMemo(() => {
    if (!showProveedorStockInfo || stockLoading) return false
    return details.some((detail) => {
      const productId = String(detail?.productoId || detail?.producto_id || '').trim()
      const currentQty = parseIntValue(detail?.cantidad) ?? 0
      const reservedQty = getProductReservedQuantity(productId)
      const others = Math.max(reservedQty - currentQty, 0)
      const allowance = getProductStockAllowance(productId)
      const remaining = Math.max(allowance - others, 0)
      return currentQty > remaining
    })
  }, [details, getProductReservedQuantity, getProductStockAllowance, showProveedorStockInfo, stockLoading])

  const selectedDraftProduct = useMemo(
    () => productos.find((producto) => String(producto.id) === String(detailDraft.productoId)) || null,
    [detailDraft.productoId, productos]
  )

  const draftStockRemaining = useMemo(() => {
    if (!isTraslado) return null
    const productoId = String(detailDraft.productoId || '').trim()
    if (!productoId) return null
    const available = Number(stockByProduct[productoId] ?? 0)
    const alreadyUsed = getProductReservedQuantity(productoId)
    return Math.max(available - alreadyUsed, 0)
  }, [detailDraft.productoId, getProductReservedQuantity, isTraslado, stockByProduct])

  const detailProductIdSet = useMemo(
    () => new Set(details.map((d) => String(d?.productoId || '').trim()).filter(Boolean)),
    [details]
  )

  const formatProductoBaseLabel = useCallback((producto) => {
    if (!producto) return ''
    const codigo = String(producto?.codigo || '').trim()
    const nombre = String(producto?.nombre || '').trim()
    return [codigo, nombre].filter(Boolean).join(' - ') || `ID: ${producto?.id ?? ''}`
  }, [])

  const formatProductoOptionLabel = useCallback(
    (producto) => {
      const baseLabel = formatProductoBaseLabel(producto)
      if (!baseLabel || !isTraslado) return baseLabel
      const available = getProductStockAllowance(String(producto?.id))
      return `${baseLabel} (Disp: ${Number.isFinite(available) ? available : 0})`
    },
    [formatProductoBaseLabel, isTraslado, getProductStockAllowance]
  )

  const searchProducts = useCallback(
    async (query) => {
      const requestSeq = productSearchSeqRef.current + 1
      productSearchSeqRef.current = requestSeq

      const term = String(query ?? '').trim()
    if (!term || !token || (isTraslado && !stockBranchId)) {
      if (requestSeq === productSearchSeqRef.current) setProductOptions([])
      return
    }

      setProductLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=25`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar los productos.')

        const payload = await response.json()
        const list = parseApiList(payload)
        const normalizedTerm = normalizeValue(term)
        const relevanceOf = (producto) => {
          const codigo = normalizeValue(producto?.codigo)
          if (codigo.startsWith(normalizedTerm)) return 0
          if (codigo.includes(normalizedTerm)) return 1
          return 2
        }
        list.sort((a, b) => {
          if (isTraslado) {
            const qa = getProductStockAllowance(String(a?.id))
            const qb = getProductStockAllowance(String(b?.id))
            const hasStockDiff = (qb > 0 ? 1 : 0) - (qa > 0 ? 1 : 0)
            if (hasStockDiff !== 0) return hasStockDiff
          }
          const relevanceDiff = relevanceOf(a) - relevanceOf(b)
          if (relevanceDiff !== 0) return relevanceDiff
          return normalizeValue(a?.codigo).localeCompare(normalizeValue(b?.codigo))
        })

        if (requestSeq === productSearchSeqRef.current) setProductOptions(list)
      } catch {
        if (requestSeq === productSearchSeqRef.current) setProductOptions([])
      } finally {
        if (requestSeq === productSearchSeqRef.current) setProductLoading(false)
      }
    },
    [stockBranchId, isTraslado, getProductStockAllowance, token]
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

  useEffect(() => {
    if (hasPreviewData || !open || !formData.subTipoId || !defaultEstadoMovimientoId) return
    setFormData((prev) => {
      const currentStateValid = estadoOptions.some((estado) => String(estado.id) === String(prev.estadoId))
      if (prev.estadoId && currentStateValid) return prev
      return { ...prev, estadoId: defaultEstadoMovimientoId }
    })
  }, [defaultEstadoMovimientoId, estadoOptions, formData.subTipoId, open, hasPreviewData])

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
      if (!next.fecha) {
        next.fecha = todayISO()
        changed = true
      }
      if (!String(next.iva_rate || '').trim()) {
        next.iva_rate = String(DEFAULT_IVA_RATE)
        changed = true
      }

      return changed ? next : prev
    })
  }, [formData.subTipoId, isDevolucion, isTraslado, isVenta])

  useEffect(() => {
    if (isVenta) return
    if (clienteSearchTimerRef.current) {
      clearTimeout(clienteSearchTimerRef.current)
      clienteSearchTimerRef.current = null
    }
    if (activeTab === 'cliente') {
      setActiveTab('general')
    }
    setSelectedCliente(null)
    setClienteForm(initialClienteForm)
    setShowClienteDropdown(false)
    setClienteQuery('')
    setClienteOptions([])
    setClienteLoading(false)
  }, [activeTab, isVenta])

  useEffect(() => {
    if (!formData.subTipoId) {
      setActiveTab('general')
    }
  }, [formData.subTipoId])

  const buildFormData = useCallback((salida, catalogs) => {
    const {
      branchesList,
      subTiposList,
      estadosList,
      productosList,
      estadosProductoList,
    } = catalogs

    const linkedSolicitud = salida?.solicitud_traslado || null
    const sucursalId =
      salida?.sucursal_id ??
      linkedSolicitud?.sucursal_solicitante_id ??
      findByName(branchesList, salida?.sucursal)?.id ??
      ''
    const sucursalObjetivoId =
      salida?.sucursal_objetivo_id ??
      linkedSolicitud?.sucursal_proveedora_id ??
      findByName(branchesList, salida?.sucursal_objetivo || salida?.sucursal_proveedora)?.id ??
      ''
    const subTipoLabel = String(salida?.sub_tipo_movimiento || '')
    const matchedSubTipo =
      (salida?.sub_tipo_movimiento_id &&
        subTiposList.find((sub) => String(sub?.id) === String(salida?.sub_tipo_movimiento_id))) ||
      resolveCatalogItemByLabel(subTiposList, subTipoLabel)
    const subTipoId = matchedSubTipo?.id ?? ''
    const subTipoNombre = matchedSubTipo?.nombre || parseSubTipoLabel(subTipoLabel) || subTipoLabel

    const estadoLabel = String(salida?.estado_movimiento || '')
    const matchedEstado =
      (salida?.estado_movimiento_id &&
        estadosList.find((estado) => String(estado?.id) === String(salida?.estado_movimiento_id))) ||
      findByName(estadosList, estadoLabel) ||
      resolveCatalogItemByLabel(estadosList, estadoLabel)
    const estadoId = matchedEstado?.id ?? ''
    const estadoNombre = matchedEstado?.nombre || estadoLabel
    const { cliente, descripcion } = extractClienteFromDescripcion(salida?.descripcion)
    const clienteRawValue = String(cliente || '').trim()
    const clienteFieldValue = normalizeClienteTextForField(clienteRawValue)
    const clienteForm = buildClienteFormFromText(clienteRawValue, clienteFieldValue)

    const faltantesTraslado = salida?.faltantes_traslado || {}
    const detalles = (Array.isArray(salida?.detalles) ? salida.detalles : []).map((detalle) => {
      const productLabel = String(detalle?.producto ?? '').trim()
      const code = parseProductCode(productLabel)
      // El id viene en la linea; el catalogo cargado es solo la primera pagina.
      const apiProductId = String(detalle?.producto_id ?? '').trim()
      const product =
        (apiProductId && productosList.find((item) => String(item?.id) === apiProductId)) ||
        productosList.find((item) => normalizeValue(item?.codigo) === normalizeValue(code)) ||
        productosList.find(
          (item) =>
            normalizeValue(productLabel).startsWith(`${normalizeValue(item?.codigo)} -`)
        ) ||
        productosList.find((item) => normalizeValue(item?.nombre) === normalizeValue(productLabel))
      const estadoProducto = findByName(estadosProductoList, detalle?.estado_producto)
      const cantidad = parseIntValue(detalle?.cantidad)
      const valor = parseNumber(detalle?.valor)
      const valorTotalSource = parseNumber(detalle?.valor_total)
      const valor_total =
        Number.isFinite(valorTotalSource) && valorTotalSource >= 0
          ? valorTotalSource
          : Number.isFinite(cantidad) && Number.isFinite(valor)
            ? cantidad * valor
            : 0
      const costo = parseNumber(detalle?.costo)
      const descuentoPorcentaje = parseNumber(detalle?.descuento_porcentaje)
      const productoPrecioBD = parseNumber(detalle?.precio_anterior)
      const productoReferencia = product?.referencia ?? ''
      const faltante = faltantesTraslado[apiProductId || String(product?.id ?? '')]
      const cantidadFaltante = parseIntValue(faltante?.cantidad)

      return {
        uid: `det-${Math.random().toString(36).slice(2, 8)}`,
        productoId: product?.id ? String(product.id) : apiProductId,
        productoCodigo: product?.codigo ?? code ?? '',
        productoNombre: product?.nombre ?? stripCodeFromProductLabel(productLabel, code) ?? productLabel,
        productoReferencia,
        estadoProductoId: estadoProducto?.id ? String(estadoProducto.id) : '',
        estadoProductoNombre: estadoProducto?.nombre ?? detalle?.estado_producto ?? '',
        cantidad: Number.isFinite(cantidad) ? cantidad : 0,
        valor: Number.isFinite(valor) ? valor : 0,
        valor_total,
        costo: Number.isFinite(costo) ? costo : null,
        descuentoPorcentaje: Number.isFinite(descuentoPorcentaje) ? descuentoPorcentaje : null,
        productoPrecioBD: Number.isFinite(productoPrecioBD) ? productoPrecioBD : null,
        cantidadFaltante: Number.isFinite(cantidadFaltante) && cantidadFaltante > 0 ? cantidadFaltante : 0,
        faltanteDetalles: Array.isArray(faltante?.detalles) ? faltante.detalles : [],
      }
    })

    return {
      form: {
        sucursalId: sucursalId ? String(sucursalId) : '',
        subTipoId: subTipoId ? String(subTipoId) : '',
        subTipoNombre: subTipoNombre || '',
        estadoId: estadoId ? String(estadoId) : '',
        estadoNombre: estadoNombre || '',
        fecha: salida?.fecha || todayISO(),
        no_documento: salida?.no_documento ?? '',
        factura_referencia: salida?.factura_referencia ?? '',
        descripcion,
        funcional: Boolean(salida?.funcional),
        sucursalObjetivoId: sucursalObjetivoId ? String(sucursalObjetivoId) : '',
        cliente: clienteFieldValue,
        descuento: salida?.descuento ?? '',
        iva_rate: String(salida?.iva_rate ?? DEFAULT_IVA_RATE),
        urgente: Boolean(linkedSolicitud?.urgente ?? salida?.urgente),
        notaInconveniente: String(salida?.nota_inconveniente || '').trim(),
        notaInconvenienteResolucion: String(salida?.nota_inconveniente_resolucion || '').trim(),
        esLegado: Boolean(salida?.es_legado),
        esSucursalMatriz: Boolean(salida?.es_sucursal_matriz),
        // null si no aplica; 0 = ya no queda nada de la compra por enviar.
        compraPorRepartir: Number.isFinite(salida?.compra_por_repartir) ? salida.compra_por_repartir : null,
      },
      clienteForm,
      detalles,
    }
  }, [])

const appendBranchIfMissing = (resolvedBranches, existingBranchIds, branchIdRaw, branchNameRaw) => {
  const branchId = String(branchIdRaw || '').trim()
  if (!branchId || existingBranchIds.has(branchId)) return
  resolvedBranches.push({
    id: branchId,
    nombre: String(branchNameRaw || '').trim() || `Sucursal ${branchId}`,
  })
  existingBranchIds.add(branchId)
}

  const hydrateFromPreviewData = useCallback((preview) => {
    const requestId = String(preview?.solicitud_traslado_id || '').trim()
    const noDocumento = String(preview?.no_documento || '').trim()
    const fecha = String(preview?.fecha || '').trim() || todayISO()
    const descripcion = String(preview?.descripcion || '').trim()
    const estadoNombre = String(preview?.estado_nombre || '').trim() || 'Pendiente'
    const subTipoNombre = String(preview?.sub_tipo_nombre || '').trim() || 'Traslado (Solicitud)'

    const solicitanteIdRaw = String(preview?.sucursal_solicitante_id || '').trim()
    const proveedoraIdRaw = String(preview?.sucursal_proveedora_id || '').trim()
    const solicitanteId = solicitanteIdRaw || `solicitud-${requestId || 'origen'}`
    const proveedoraId = proveedoraIdRaw || `solicitud-${requestId || 'destino'}-objetivo`

    const detalles = (Array.isArray(preview?.detalles) ? preview.detalles : []).map((detalle, index) => {
      const cantidad = parseIntValue(detalle?.cantidad) || 0
      const valor = parseNumber(detalle?.valor)
      const valorTotalRaw = parseNumber(detalle?.valor_total)
      const resolvedValor = Number.isFinite(valor) ? valor : 0
      const resolvedTotal = Number.isFinite(valorTotalRaw) ? valorTotalRaw : cantidad * resolvedValor
      return {
        uid: `sol-${requestId || 'tmp'}-${index}`,
        productoId: String(detalle?.producto_id || ''),
        productoCodigo: String(detalle?.producto_codigo || '').trim(),
        productoNombre: String(detalle?.producto_nombre || '').trim(),
        estadoProductoId: '',
        estadoProductoNombre: '',
        cantidad,
        valor: resolvedValor,
        valor_total: resolvedTotal,
      }
    })

    setStockByProduct({})
    setTransferSolicitudId(requestId)
    setCreatorInfo({
      creadoPorNombre: String(preview?.creado_por_nombre || '').trim(),
      enviadoPorNombre: String(preview?.enviado_por_nombre || '').trim(),
      recibidoPorNombre: String(preview?.recibido_por_nombre || '').trim(),
    })

    const nextForm = {
      sucursalId: solicitanteId,
      subTipoId: 'solicitud-traslado',
      subTipoNombre,
      estadoId: String(
        preview?.estado_movimiento_id ||
          preview?.estado_movimiento?.id ||
          preview?.estado_id ||
          preview?.estado?.id ||
          ''
      ).trim(),
      estadoNombre,
      fecha,
      no_documento: noDocumento,
      factura_referencia: '',
      descripcion,
      funcional: true,
      sucursalObjetivoId: proveedoraId,
      cliente: '',
      descuento: '',
      iva_rate: String(DEFAULT_IVA_RATE),
      urgente: Boolean(preview?.urgente),
    }

    setFormData(nextForm)
    setClienteQuery('')
    setSelectedCliente(null)
    setClienteForm(initialClienteForm)
    setShowClienteDropdown(false)
    setClienteOptions([])
    setClienteLoading(false)
    setDetails(detalles)
    setOriginalData({
      form: { ...nextForm },
      clienteForm: { ...initialClienteForm },
      detalles: detalles.map((detail) => ({ ...detail })),
    })
    setDetailDraft(initialDetail)
    setDetailError('')
    setActiveTab('general')
    setIsEditing(false)
  }, [])

  const fetchCatalogData = useCallback(
    async () => {
      const [
        branchesRes,
        tiposRes,
        subTiposRes,
        estadosRes,
        productosRes,
        estadosProductoRes,
      ] = await Promise.all([
        authFetch(`${API_URL}/inventario/sucursales/?modulo=movimientos_entradas`, {}, token),
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
        tiposData,
        subTiposData,
        estadosData,
        productosData,
        estadosProductoData,
      ] = await Promise.all([
        branchesRes.json(),
        tiposRes.json(),
        subTiposRes.json(),
        estadosRes.json(),
        productosRes.json(),
        estadosProductoRes.json(),
      ])

      return {
        branchesList: parseApiList(branchesData),
        tiposList: parseApiList(tiposData),
        subTiposList: parseApiList(subTiposData),
        estadosList: parseApiList(estadosData),
        productosList: parseApiList(productosData),
        estadosProductoList: parseApiList(estadosProductoData),
      }
    },
    [token]
  )

  const loadData = useCallback(async () => {
    if (!token || !entradaId) return
    setLoadingData(true)
    setError('')
    try {
      const catalogs = await fetchCatalogData()
      const salidaRes = await authFetch(`${API_URL}/movimientos/movimiento_inventario/${entradaId}/`, {}, token)
      if (!salidaRes.ok) throw new Error('No se pudo cargar la entrada.')
      const salidaData = await salidaRes.json()

      const {
        branchesList,
        tiposList,
        subTiposList,
        estadosList,
        productosList,
        estadosProductoList,
      } = catalogs

      const linkedSolicitud = salidaData?.solicitud_traslado || null
      setTransferSolicitudId(String(linkedSolicitud?.id || '').trim())
      setCreatorInfo({
        creadoPorNombre: String(salidaData?.creado_por_nombre || linkedSolicitud?.creado_por_nombre || '').trim(),
        enviadoPorNombre: String(linkedSolicitud?.enviado_por_nombre || '').trim(),
        recibidoPorNombre: String(linkedSolicitud?.recibido_por_nombre || '').trim(),
      })
      const resolvedBranches = [...branchesList]
      const existingBranchIds = new Set(
        resolvedBranches.map((branch) => String(branch?.id || '').trim()).filter(Boolean)
      )
      appendBranchIfMissing(
        resolvedBranches,
        existingBranchIds,
        linkedSolicitud?.sucursal_solicitante_id,
        salidaData?.sucursal
      )
      appendBranchIfMissing(
        resolvedBranches,
        existingBranchIds,
        linkedSolicitud?.sucursal_proveedora_id,
        salidaData?.sucursal_objetivo || salidaData?.sucursal_proveedora
      )

      setBranches(resolvedBranches)
      setTipoMovimientos(tiposList)
      setSubTipos(subTiposList)
      setEstados(estadosList)
      setProductos(productosList)
      setEstadosProducto(estadosProductoList)

      const normalized = buildFormData(salidaData, {
        branchesList: resolvedBranches,
        subTiposList,
        estadosList,
        productosList,
        estadosProductoList,
      })

      setFormData(normalized.form)
      setRawApiEstadoNombre(String(salidaData?.estado_movimiento || ''))
      setClienteQuery(String(normalized.form?.cliente || ''))
      setSelectedCliente(null)
      setClienteForm(normalized.clienteForm || initialClienteForm)
      setShowClienteDropdown(false)
      setClienteOptions([])
      setClienteLoading(false)
      setDetails(normalized.detalles)
      setOriginalData(normalized)
      setDetailDraft(initialDetail)
      setDetailError('')
      setIsEditing(false)
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al cargar la entrada.')
    } finally {
      setLoadingData(false)
    }
  }, [buildFormData, fetchCatalogData, notifyError, entradaId, token])

  const fetchStockByBranch = useCallback(
    async (sucursalId) => {
      if (!token || !sucursalId) {
        setStockByProduct({})
        return
      }
      setStockLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/stock-sucursal/?sucursal_id=${encodeURIComponent(sucursalId)}&modulo=movimientos_entradas`,
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
        setStockByProduct(map)
      } catch (err) {
        setStockByProduct({})
        notifyError(err?.message || 'No se pudo cargar el inventario de la sucursal seleccionada.')
      } finally {
        setStockLoading(false)
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
    setFormData(emptyForm)
    setRawApiEstadoNombre('')
    setDetails([])
    setDetailDraft(initialDetail)
    setDetailError('')
    setShowProductDropdown(false)
    setProductDropdownDirection('down')
    setProductDropdownMaxHeight(null)
    setProductQuery('')
    setProductOptions([])
    setProductLoading(false)
    setActiveTab('general')
    setSelectedCliente(null)
    setClienteForm(initialClienteForm)
    setShowClienteDropdown(false)
    setClienteQuery('')
    setClienteOptions([])
    setClienteLoading(false)
    setStockByProduct({})
    setTransferSolicitudId('')
    setOriginalData(null)
    setIsEditing(canStartEditingPreviewSolicitud)
    setIsMaximized(false)
    setIsResizingModal(false)
    modalRestoreRef.current = null
    setError('')
    if (hasPreviewData) {
      setLoadingData(true)
      fetchCatalogData()
        .then((catalogs) => {
          const {
            branchesList,
            tiposList,
            subTiposList,
            estadosList,
            productosList,
            estadosProductoList,
          } = catalogs
          const resolvedBranches = [...branchesList]
          const existingBranchIds = new Set(
            resolvedBranches.map((branch) => String(branch?.id || '').trim()).filter(Boolean)
          )
          appendBranchIfMissing(
            resolvedBranches,
            existingBranchIds,
            previewData?.sucursal_solicitante_id,
            previewData?.sucursal_nombre
          )
          appendBranchIfMissing(
            resolvedBranches,
            existingBranchIds,
            previewData?.sucursal_proveedora_id,
            previewData?.sucursal_objetivo_nombre || previewData?.sucursal_proveedora
          )

          setBranches(resolvedBranches)
          setTipoMovimientos(tiposList)
          setSubTipos(subTiposList)
          setEstados(estadosList)
          setProductos(productosList)
          setEstadosProducto(estadosProductoList)
          hydrateFromPreviewData(previewData)
        })
        .catch((err) => {
          notifyError(err?.message || 'No se pudieron cargar los catalogos de entrada.')
        })
        .finally(() => {
          setLoadingData(false)
        })
      return
    }
    loadData()
  }, [
    fetchCatalogData,
    hasPreviewData,
    hydrateFromPreviewData,
    loadData,
    notifyError,
    open,
    previewData,
    canStartEditingPreviewSolicitud,
  ])

  useEffect(
    () => () => {
      if (clienteSearchTimerRef.current) {
        clearTimeout(clienteSearchTimerRef.current)
      }
    },
    []
  )

  useEffect(() => {
    if (!open) {
      setLoadingData(true)
    }
  }, [open])

  useEffect(() => {
    if (!loadingData) return
    setShowProductDropdown(false)
    setShowClienteDropdown(false)
  }, [loadingData])

  useEffect(() => {
    if (!isReadOnlyMode || !isEditing) return
    setIsEditing(false)
  }, [isEditing, isReadOnlyMode])

  useEffect(() => {
    if (effectiveAllowEdit || !isEditing) return
    setIsEditing(false)
  }, [effectiveAllowEdit, isEditing])

  const updateProductDropdownPlacement = useCallback(() => {
    if (!showProductDropdown || !productDropdownTriggerRef.current) return
    const triggerRect = productDropdownTriggerRef.current.getBoundingClientRect()
    const spacing = 10
    const availableBelow = Math.max(
      Math.floor(window.innerHeight - triggerRect.bottom - VIEWPORT_PADDING - spacing),
      0
    )
    const availableAbove = Math.max(
      Math.floor(triggerRect.top - VIEWPORT_PADDING - spacing),
      0
    )
    const preferredPanelHeight = 270
    const openUp =
      availableBelow < preferredPanelHeight && availableAbove > availableBelow

    setProductDropdownDirection((prev) => (prev === (openUp ? 'up' : 'down') ? prev : openUp ? 'up' : 'down'))
    const availableSpace = openUp ? availableAbove : availableBelow
    const nextMaxHeight = Math.max(140, Math.min(320, availableSpace))
    setProductDropdownMaxHeight((prev) => (prev === nextMaxHeight ? prev : nextMaxHeight))
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
    }, 300)
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

  useEffect(() => {
    if (!open || (!showProductDropdown && !showClienteDropdown)) return undefined
    const handleClick = (event) => {
      if (productDropdownRef.current && !productDropdownRef.current.contains(event.target)) {
        setShowProductDropdown(false)
      }
      if (clienteDropdownRef.current && !clienteDropdownRef.current.contains(event.target)) {
        setShowClienteDropdown(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [open, showClienteDropdown, showProductDropdown])

  useEffect(() => {
    if (activeTab !== 'cliente' && showClienteDropdown) {
      setShowClienteDropdown(false)
    }
    if (activeTab !== 'general' && showProductDropdown) {
      setShowProductDropdown(false)
    }
  }, [activeTab, showClienteDropdown, showProductDropdown])

  useEffect(() => {
    if (!open || loadingData || isEditing || !isVenta) return
    if (selectedCliente?.id) return

    const preferredLookup = String(clienteForm.cedula_ruc || '').trim()
    const fallbackLookup = String(formData.cliente || '').trim()
    const lookup = preferredLookup || fallbackLookup
    if (!lookup || lookup.length < 2 || !token) return

    let ignore = false

    const resolveCliente = async () => {
      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/buscar-cliente/?q=${encodeURIComponent(lookup)}&page_size=10`,
          {},
          token
        )
        if (!response.ok || ignore) return
        const payload = await response.json().catch(() => ({}))
        if (ignore) return
        const options = parseApiList(payload)
        if (!options.length) return

        let matched = null
        if (preferredLookup) {
          const exactByCedula = options.filter(
            (item) => normalizeValue(item?.cedula_ruc) === normalizeValue(preferredLookup)
          )
          if (exactByCedula.length === 1) {
            matched = exactByCedula[0]
          }
        }

        if (!matched) {
          const normalizedName = normalizeValue(fallbackLookup)
          const exactByName = options.filter(
            (item) => normalizeValue(resolveClienteNombre(item)) === normalizedName
          )
          if (exactByName.length === 1) {
            matched = exactByName[0]
          }
        }

        if (!matched && options.length === 1) {
          matched = options[0]
        }

        if (!matched) return
        setSelectedCliente(matched)
        setClienteForm(normalizeClientePayload(matched))
        const fieldValue = formatClienteFieldValue(matched)
        setFormData((prev) => ({ ...prev, cliente: fieldValue }))
        setClienteQuery(fieldValue)
      } catch {
        // No bloquear la vista si no se puede resolver el cliente.
      }
    }

    resolveCliente()
    return () => {
      ignore = true
    }
  }, [clienteForm.cedula_ruc, formData.cliente, isEditing, isVenta, loadingData, open, selectedCliente, token])

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
    if (!open || !isTraslado || !stockBranchId) {
      setStockByProduct({})
      return
    }
    fetchStockByBranch(stockBranchId)
  }, [fetchStockByBranch, isTraslado, open, stockBranchId])

  useLayoutEffect(() => {
    if (!open || isMaximized) return
    const { availableWidth, availableHeight, minWidth, minHeight } = getViewportMetrics()
    const preferredWidth = isCompraEntrada ? COMPRA_LOCAL_WIDTH : MIN_WIDTH
    const width = Math.min(Math.max(preferredWidth, minWidth), availableWidth)
    const height = Math.min(Math.max(MIN_HEIGHT, minHeight), availableHeight)
    setModalSize({ width, height })
    setModalPosition({
      x: Math.max((window.innerWidth - width) / 2, VIEWPORT_PADDING),
      y: Math.max((window.innerHeight - height) / 2, VIEWPORT_PADDING),
    })
  }, [getViewportMetrics, isMaximized, isCompraEntrada, open])

  const handleModalMouseDown = (event) => {
    const target = event?.target
    if (target?.closest?.('.create-user__icon-button') || target?.closest?.('.create-user__resize-handle')) {
      return
    }

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
    const { minWidth, minHeight } = getViewportMetrics()
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
      const { minWidth, minHeight, availableWidth, availableHeight } = getViewportMetrics()

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
  }, [getViewportMetrics, isMaximized, open])

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
    if (!isEditing) return
    const { name, value, type, checked } = event.target
    if (name === 'factura_referencia') return
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  const handleClienteQueryChange = (event) => {
    if (!isEditing) return
    const value = event.target.value
    setClienteQuery(value)
    setShowClienteDropdown(Boolean(value))
    if (!value.trim()) {
      setSelectedCliente(null)
      setFormData((prev) => ({ ...prev, cliente: '' }))
      setClienteForm(initialClienteForm)
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
    if (!isEditing) return
    const { name, value } = event.target
    setClienteForm((prev) => ({ ...prev, [name]: value }))
    if (selectedCliente) {
      setSelectedCliente(null)
      setFormData((prev) => ({ ...prev, cliente: '' }))
      return
    }

    if (name === 'nombres' || name === 'apellidos') {
      setFormData((prev) => {
        const nombres = name === 'nombres' ? value : clienteForm.nombres
        const apellidos = name === 'apellidos' ? value : clienteForm.apellidos
        const clienteLabel = `${String(nombres || '').trim()} ${String(apellidos || '').trim()}`.trim()
        return { ...prev, cliente: clienteLabel }
      })
    }
  }

  const handleClienteSelect = (cliente) => {
    if (!isEditing) return
    const label = formatClienteFieldValue(cliente)
    if (!label) return
    setSelectedCliente(cliente || null)
    setFormData((prev) => ({ ...prev, cliente: label }))
    setClienteQuery(label)
    setClienteForm(normalizeClientePayload(cliente))
    setShowClienteDropdown(false)
    setClienteOptions([])
    setClienteLoading(false)
  }

  const handleDetailChange = (event) => {
    if (!isEditing || lineItemsReadOnly) return
    const { name, value } = event.target
    if (name !== 'cantidad' && name !== 'costo' && name !== 'descuentoPorcentaje') return
    setDetailError('')
    setDetailDraft((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleProductSelect = (producto) => {
    if (!isEditing || !producto?.id || lineItemsReadOnly) return
    if (detailProductIdSet.has(String(producto.id).trim())) {
      setDetailError('Este producto ya fue agregado al detalle.')
      return
    }
    const productPrice = resolveProductPrice(producto)
    const productCost = resolveProductCost(producto)
    setDetailError('')
    setDetailDraft((prev) => ({
      ...prev,
      productoId: String(producto.id),
      valor: productPrice,
      costo: productCost,
      descuentoPorcentaje: '',
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
    if (!isEditing || lineItemsReadOnly) return
    setDetailError('')
    const productoId = String(detailDraft.productoId || '').trim()
    const cantidad = parseIntValue(detailDraft.cantidad)
    const estadoProductoId = String(defaultEstadoProductoId || '').trim()
    const producto = productos.find((item) => String(item.id) === productoId)
    const valor = parseNumber(resolveProductPrice(producto))
    const costo = parseNumber(
      String(detailDraft.costo ?? '').trim() || resolveProductCost(producto)
    )
    const descuentoPorcentaje = Math.min(
      100,
      Math.max(0, parseNumber(detailDraft.descuentoPorcentaje) || 0)
    )

    if (isTraslado && !stockBranchId) {
      setDetailError('Selecciona primero la sucursal proveedora para cargar disponibilidad.')
      return
    }
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
      setDetailError('El producto seleccionado no tiene un precio valido.')
      return
    }
    if (isCompraEntrada && (!Number.isFinite(costo) || costo < 0)) {
      setDetailError('Ingresa un costo valido.')
      return
    }
    if (isTraslado) {
      const available = Number(stockByProduct[productoId] ?? 0)
      const alreadyUsed = details.reduce((acc, detail) => {
        if (String(detail.productoId) !== productoId) return acc
        const qty = parseIntValue(detail.cantidad)
        return acc + (Number.isFinite(qty) ? qty : 0)
      }, 0)
      const remaining = Math.max(available - alreadyUsed, 0)
      if (cantidad > remaining) {
        setDetailError(`Cantidad excede disponible en la sucursal proveedora seleccionada. Disponible: ${remaining}.`)
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
        valor,
        valor_total,
        costo: isCompraEntrada ? costo : null,
        descuentoPorcentaje: isCompraEntrada ? descuentoPorcentaje : null,
      },
    ])

    setDetailDraft(initialDetail)
    setShowProductDropdown(false)
    setProductQuery('')
    setProductOptions([])
  }

  const handleUpdateDetailQuantity = useCallback(
    (detailId, rawValue) => {
      if (!isEditing || lineItemsReadOnly) return
      const detail = details.find((item) => item.uid === detailId)
      if (!detail) return
      const trimmedValue = String(rawValue || '').trim()
      if (!trimmedValue) {
        setDetailError('')
        setDetails((prev) =>
          prev.map((item) =>
            item.uid !== detailId
              ? item
              : {
                  ...item,
                  cantidad: '',
                }
          )
        )
        return
      }
      const cantidad = parseIntValue(trimmedValue)
      if (!Number.isFinite(cantidad) || cantidad <= 0) {
        setDetailError('Ingresa una cantidad valida.')
        return
      }
      if (isTraslado) {
        const productId = String(detail.productoId)
        const currentQty = parseIntValue(detail.cantidad) ?? 0
        const totalReserved = getProductReservedQuantity(productId)
        const others = Math.max(totalReserved - currentQty, 0)
        const actualStock = getProductStockAllowance(productId)
        const remaining = Math.max(actualStock - others, 0)
        if (cantidad > remaining) {
          setDetailError(
            `Cantidad excede disponible en la sucursal proveedora seleccionada. Disponible: ${remaining}.`
          )
          return
        }
      }
      setDetailError('')
      setDetails((prev) =>
        prev.map((item) => {
          if (item.uid !== detailId) return item
          const valor = Number.isFinite(Number(item.valor)) ? Number(item.valor) : 0
          return {
            ...item,
            cantidad,
            valor_total: cantidad * valor,
          }
        })
      )
    },
    [details, getProductReservedQuantity, getProductStockAllowance, isEditing, isTraslado, lineItemsReadOnly]
  )

  const handleRemoveDetail = (uid) => {
    if (!isEditing || lineItemsReadOnly) return
    setDetails((prev) => prev.filter((detail) => detail.uid !== uid))
  }

  const handleCancelEdit = useCallback(() => {
    if (!originalData) {
      setIsEditing(false)
      return
    }

    setFormData({ ...originalData.form })
    setDetails(originalData.detalles.map((detail) => ({ ...detail })))
    setDetailDraft(initialDetail)
    setDetailError('')
    setShowProductDropdown(false)
    setProductDropdownDirection('down')
    setProductDropdownMaxHeight(null)
    setProductQuery('')
    setProductOptions([])
    setShowClienteDropdown(false)
    setClienteQuery(String(originalData.form?.cliente || ''))
    setClienteForm(originalData.clienteForm || initialClienteForm)
    setClienteOptions([])
    setClienteLoading(false)
    setSelectedCliente(null)
    setError('')
    setShowDeleteConfirm(false)
    setDeleteInventoryAction(isPendingSolicitudEntry ? 'keep' : 'reverse')
    setIsEditing(false)
  }, [isPendingSolicitudEntry, originalData])

  const handleEditToggleClick = useCallback(() => {
    if (isEditing) {
      handleCancelEdit()
      return
    }
    setIsEditing(true)
  }, [handleCancelEdit, isEditing])

  const buildDescripcion = useCallback((clienteLabel = '') => {
    const descripcionBase = String(formData.descripcion || '').trim()
    if (!isVenta) return descripcionBase
    const cliente = String(clienteLabel || '').trim()
    if (!cliente) return descripcionBase
    if (!descripcionBase) return `Cliente: ${cliente}`
    return `Cliente: ${cliente}\n${descripcionBase}`
  }, [formData.descripcion, isVenta])

  const handleUpdatePendingSolicitud = useCallback(
    async (ventaClienteLabel, options = {}) => {
      if (!token || !transferSolicitudId) {
        notifyError('No se encontró la solicitud de traslado.')
        return false
      }

      setSaving(true)
      try {
        const detallesPayload = details.map((detail) => {
          const cantidad = parseIntValue(detail.cantidad)
          const valor = parseNumber(detail.valor)
          return {
            producto_id: Number(detail.productoId),
            cantidad: Number.isFinite(cantidad) ? cantidad : 0,
            valor: Number.isFinite(valor) ? valor : 0,
          }
        })
        // Por defecto se preserva el estado actual: si sigue guardado, se
        // mantiene guardado (edicion normal); el boton "Crear solicitud"
        // pasa guardarBorrador:false explicitamente para finalizarla.
        const guardarBorrador = Object.prototype.hasOwnProperty.call(options, 'guardarBorrador')
          ? Boolean(options.guardarBorrador)
          : isPreviewGuardadoSolicitud

        const isFinalizing = isPreviewGuardadoSolicitud && !guardarBorrador
        const reminderRecipientIds = isFinalizing
          ? selectedReminderRecipients
              .map((recipient) => Number.parseInt(normalizeId(recipient?.id), 10))
              .filter((recipientId) => Number.isFinite(recipientId) && recipientId > 0)
          : []

        const payload = {
          sucursal_solicitante_id: Number(formData.sucursalId),
          sucursal_proveedora_id: Number(formData.sucursalObjetivoId),
          fecha: formData.fecha,
          descripcion: buildDescripcion(ventaClienteLabel),
          funcional: Boolean(formData.funcional),
          detalles: detallesPayload,
          guardar_borrador: guardarBorrador,
          ...(isFinalizing ? { recordatorio_destinatario_ids: reminderRecipientIds } : {}),
        }

        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${transferSolicitudId}/`,
          {
            method: 'PUT',
            body: JSON.stringify(payload),
          },
          token
        )
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(resolveApiErrorMessage(data, 'No se pudo actualizar la solicitud de traslado.'))
        }

        const updatedForm = {
          ...formData,
          cliente: ventaClienteLabel,
          ...(isFinalizing
            ? { estadoNombre: String(data?.estado_label || data?.estado || 'Pendiente').trim() }
            : {}),
        }
        setFormData(updatedForm)
        const nextOriginal = {
          form: { ...updatedForm },
          clienteForm: { ...clienteForm },
          detalles: details.map((detail) => ({ ...detail })),
        }
        setOriginalData(nextOriginal)
        setClienteQuery(String(updatedForm.cliente || ''))
        setShowClienteDropdown(false)
        setClienteOptions([])
        setClienteLoading(false)
        setDetailDraft(initialDetail)
        setDetailError('')
        setIsEditing(false)
        if (isFinalizing) emitRemindersSync()
        onUpdated?.(data)
        return true
      } catch (err) {
        notifyError(err?.message || 'No se pudo actualizar la solicitud de traslado.')
        return false
      } finally {
        setSaving(false)
      }
    },
    [
      buildDescripcion,
      clienteForm,
      details,
      formData,
      isPreviewGuardadoSolicitud,
      notifyError,
      onUpdated,
      selectedReminderRecipients,
      token,
      transferSolicitudId,
    ]
  )

  const handleCrearSolicitudDesdeGuardado = useCallback(async () => {
    if (!isPreviewGuardadoSolicitud || !transferSolicitudId || saving) return

    if (!String(formData.sucursalObjetivoId || '').trim()) {
      notifyError('Selecciona la sucursal proveedora.')
      return
    }

    if (String(formData.sucursalId) === String(formData.sucursalObjetivoId)) {
      notifyError('La sucursal proveedora debe ser diferente a la sucursal solicitante.')
      return
    }

    if (!details.length) {
      notifyError('Agrega al menos un producto.')
      return
    }

    const hasIncompleteDetail = details.some((detail) => {
      const productoId = String(detail?.productoId || '').trim()
      const cantidad = parseIntValue(detail?.cantidad)
      const valor = parseNumber(detail?.valor)
      return !productoId || !Number.isFinite(cantidad) || cantidad <= 0 || !Number.isFinite(valor) || valor < 0
    })

    if (hasIncompleteDetail) {
      notifyError('Hay productos con datos incompletos.')
      return
    }

    if (hasInsufficientStockDetail) {
      setActiveTab('general')
      notifyError('Hay productos con cantidad mayor al stock disponible en la sucursal proveedora.')
      return
    }

    if (reminderUsersLoading) {
      setActiveTab('recordatorio')
      notifyError('Espera a que se carguen los usuarios para recordatorios.')
      return
    }

    if (!hasAdminReminderRecipients) {
      setActiveTab('recordatorio')
      notifyError('No se puede crear la solicitud de traslado: no hay administradores activos para el recordatorio. Revisa el aviso en la pestaña Recordatorio.')
      return
    }

    if (!hasAdditionalReminderRecipients) {
      setActiveTab('recordatorio')
      notifyError(
        selectableReminderUsers.length
          ? 'Debes seleccionar al menos un usuario adicional para el recordatorio.'
          : 'No se puede crear la solicitud de traslado: la sucursal proveedora no tiene usuarios que puedan recibirla. Revisa el aviso en la pestaña Recordatorio.'
      )
      return
    }

    await handleUpdatePendingSolicitud('', { guardarBorrador: false })
  }, [
    details,
    formData.sucursalId,
    formData.sucursalObjetivoId,
    handleUpdatePendingSolicitud,
    hasAdditionalReminderRecipients,
    hasAdminReminderRecipients,
    hasInsufficientStockDetail,
    isPreviewGuardadoSolicitud,
    notifyError,
    reminderUsersLoading,
    saving,
    selectableReminderUsers.length,
    transferSolicitudId,
  ])

  const handleSave = async () => {
    if (!allowEdit) return
    if (isReadOnlyMode) return
    if (!isEditing || saving) return
    setError('')

    if (!entradaTipoId) {
      notifyError('No se encontro el tipo de movimiento de entrada.')
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
      notifyError('Selecciona la sucursal destino.')
      return
    }

    let ventaClienteLabel = String(formData.cliente || '').trim()
    if (isVenta) {
      if (selectedCliente?.id) {
        ventaClienteLabel = formatClienteFieldValue(selectedCliente)
      } else {
        const clientePayload = normalizeClientePayload(clienteForm)
        ventaClienteLabel = `${clientePayload.nombres} ${clientePayload.apellidos}`.trim()
      }

      if (!ventaClienteLabel) {
        notifyError('Ingresa los datos del cliente para la venta.')
        setActiveTab('cliente')
        return
      }
    }

    if (!isPreviewGuardadoSolicitud && !details.length) {
      notifyError('Agrega al menos un producto.')
      return
    }

    const detailsHaveRequiredData = details.every((detail) => {
      const hasProduct = Boolean(String(detail?.productoId || '').trim())
      const hasState = Boolean(String(detail?.estadoProductoId || defaultEstadoProductoId || '').trim())
      const qty = parseIntValue(detail?.cantidad)
      const val = parseNumber(detail?.valor)
      return hasProduct && hasState && Number.isFinite(qty) && qty > 0 && Number.isFinite(val) && val >= 0
    })

    if (!isPreviewGuardadoSolicitud && !detailsHaveRequiredData) {
      notifyError('Hay productos con datos incompletos.')
      return
    }

    if (!entradaId) {
      if ((isPendingSolicitudEntry || isPreviewRejectedSolicitud || isPreviewGuardadoSolicitud) && transferSolicitudId) {
        await handleUpdatePendingSolicitud(ventaClienteLabel)
        return
      }
      notifyError('La solicitud aún no genera una entrada; no se puede guardar aquí.')
      return
    }

    if (!formData.estadoId) {
      notifyError('Selecciona el estado del movimiento.')
      return
    }

    if (!formData.fecha) {
      notifyError('No se pudo resolver la fecha del movimiento.')
      return
    }

    if (!String(formData.no_documento || '').trim()) {
      notifyError('No se pudo resolver el codigo de la entrada.')
      return
    }

    if (isDevolucion && !String(formData.factura_referencia || '').trim()) {
      notifyError('Ingresa la factura de venta para la devolucion.')
      return
    }

    const descuentoIngresado = isVenta ? parseNumber(formData.descuento) : 0
    if (
      isVenta &&
      descuentoIngresado !== null &&
      (!Number.isFinite(descuentoIngresado) || descuentoIngresado < 0 || descuentoIngresado > 100)
    ) {
      notifyError('El descuento debe ser un porcentaje entre 0 y 100.')
      return
    }

    const descuento = isVenta ? Math.max(descuentoIngresado ?? 0, 0) : 0
    const ivaRate = parseNumber(formData.iva_rate)
    const lockedFacturaReferencia = String(
      originalData?.form?.factura_referencia ?? formData.factura_referencia ?? ''
    ).trim()

    const payload = {
      sucursal_id: Number(formData.sucursalId),
      tipo_movimiento_id: Number(entradaTipoId),
      sub_tipo_movimiento_id: Number(formData.subTipoId),
      descripcion: buildDescripcion(ventaClienteLabel),
      funcional: isDevolucion ? Boolean(formData.funcional) : true,
      sucursal_objetivo_id: requiresSucursalObjetivo ? Number(formData.sucursalObjetivoId) : null,
      estado_movimiento_id: Number(formData.estadoId),
      descuento,
      fecha: formData.fecha,
      no_documento: formData.no_documento.trim(),
      factura_referencia: lockedFacturaReferencia,
      detalles: details.map((detail) => {
        const cantidad = parseIntValue(detail.cantidad) || 0
        const valor = parseNumber(detail.valor) || 0
        const valorTotal = parseNumber(detail.valor_total)
        const costo = parseNumber(detail.costo)
        const descuentoPorcentaje = parseNumber(detail.descuentoPorcentaje)
        const precioAnterior = parseNumber(detail.productoPrecioBD)
        return {
          producto_id: Number(detail.productoId),
          cantidad,
          estado_producto_id: Number(detail.estadoProductoId || defaultEstadoProductoId),
          valor,
          valor_total: Number.isFinite(valorTotal) ? valorTotal : cantidad * valor,
          // Sin el costo, el backend rechazaba editar cualquier compra local.
          ...(isCompraEntrada
            ? {
                costo: Number.isFinite(costo) ? Math.max(0, costo) : 0,
                descuento_porcentaje: Number.isFinite(descuentoPorcentaje)
                  ? Math.min(100, Math.max(0, descuentoPorcentaje))
                  : 0,
                precio_anterior: Number.isFinite(precioAnterior) ? precioAnterior : null,
              }
            : {}),
        }
      }),
      ajustes_ubicacion: Object.entries(ajusteOverrides).map(([productoId, subdivisionId]) => ({
        producto_id: Number(productoId),
        subdivision_id: Number(subdivisionId),
      })),
    }

    if (ivaRate !== null) {
      payload.iva_rate = ivaRate
    }

    if (!entradaId) {
      notifyError('No se encontró la entrada a actualizar.')
      return
    }

    const hasInvalidDetail = details.some((detail) => {
      const raw = String(detail.cantidad ?? '').trim()
      const qty = parseIntValue(raw)
      return !raw || !Number.isFinite(qty) || qty <= 0
    })
    if (hasInvalidDetail) {
      setDetailError('Ingresa una cantidad válida en cada producto.')
      return
    }

    const ajusteError = (ajustePlan?.cambios || []).find((item) => item.error)
    if (ajusteError) {
      notifyError(ajusteError.error)
      return
    }

    setSaving(true)
    try {
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/${entradaId}/`,
        {
          method: 'PUT',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(resolveApiErrorMessage(data, 'No se pudo actualizar la entrada.'))
      }

      const updatedForm = { ...formData, cliente: ventaClienteLabel }
      setFormData(updatedForm)
      const nextOriginal = {
        form: { ...updatedForm },
        clienteForm: { ...clienteForm },
        detalles: details.map((detail) => ({ ...detail })),
      }
      setOriginalData(nextOriginal)
      setClienteQuery(String(updatedForm.cliente || ''))
      setShowClienteDropdown(false)
      setClienteOptions([])
      setClienteLoading(false)
      setIsEditing(false)
      onUpdated?.(data)
      submitSucceededRef.current = true
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al actualizar la entrada.')
    } finally {
      setSaving(false)
    }
  }

  const openDeleteConfirm = () => {
    if (!allowDelete) return
    if (isReadOnlyMode) return
    if (!isEditing || deleteLoading) return
    setDeleteInventoryAction(isPendingSolicitudEntry ? 'keep' : 'reverse')
    setShowDeleteConfirm(true)
  }

  const closeDeleteConfirm = () => {
    if (deleteLoading) return
    setShowDeleteConfirm(false)
  }

  const handleDelete = async () => {
    if (!showDeleteConfirm) return
    if (!allowDelete) return
    if (isReadOnlyMode) return
    if (!isEditing || deleteLoading) return
    setDeleteLoading(true)

    if (!isPendingSolicitudEntry && !entradaId) {
      notifyError('No se encontró la entrada para eliminar.')
      setDeleteLoading(false)
      return
    }

    try {
      const targetRequestId = transferSolicitudId
      let response
      if (isPendingSolicitudEntry && targetRequestId) {
        response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${targetRequestId}/`,
          { method: 'DELETE' },
          token
        )
      } else {
        const resolvedDeleteAction = deleteInventoryAction === 'keep' ? 'keep' : 'reverse'
        response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/${entradaId}/?inventory_action=${encodeURIComponent(
            resolvedDeleteAction
          )}`,
          { method: 'DELETE' },
          token
        )
      }

      if (!response.ok && response.status !== 204) {
        const data = await response.json().catch(() => ({}))
        throw new Error(resolveApiErrorMessage(data, 'No se pudo eliminar la entrada.'))
      }

      setShowDeleteConfirm(false)
      onDeleted?.(entradaId)
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al eliminar la entrada.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const { shouldRender, isClosing } = useModalAnimation(open)

  // "¿Guardar cambios?" al cerrar con cambios en modo edicion (tambien al
  // cerrar la pestana). Guardar = el mismo boton de guardar.
  const submitSucceededRef = useRef(false)
  const unsavedGuard = useUnsavedChangesGuard({
    watch: { formData, details },
    enabled: Boolean(isEditing),
    onSave: async () => {
      submitSucceededRef.current = false
      await handleSave()
      return submitSucceededRef.current
    },
    onClose: onClose,
    label: 'Entrada',
  })

  if (!shouldRender) return null

  const editorDisabled = !isEditing || saving || loadingData || isReadOnlyMode

  const overlayStyle = { padding: `${VIEWPORT_PADDING}px` }
  const modalStyle = {
    top: modalPosition.y,
    left: modalPosition.x,
    width: modalSize.width,
    height: modalSize.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    maxHeight: `calc(100dvh - ${VIEWPORT_PADDING * 2}px)`,
  }
  const showSolicitudRibbon =
    formData.esLegado ||
    isPendingSolicitudRibbon ||
    isRejectedSolicitudRibbon ||
    isAcceptedSolicitudRibbon ||
    isSentSolicitudRibbon ||
    isReceivedRibbon ||
    isGuardadoSolicitudRibbon
  const _ribbonStateLabel = rawApiEstadoNombre || selectedEstadoName || ''
  const solicitudRibbonLabel = formData.esLegado
    ? 'Registro previo a Kava'
    : isTraslado
      ? (isGuardadoSolicitudRibbon ? 'Guardado' : isRejectedSolicitudRibbon ? 'Solicitud rechazada' : isAcceptedSolicitudRibbon ? 'Solicitud aceptada' : isSentSolicitudRibbon ? 'Solicitud enviada' : 'Solicitud pendiente')
      : _ribbonStateLabel
  const solicitudRibbonTitle = formData.esLegado
    ? 'Registro previo a Kava: no se puede editar ni eliminar.'
    : isTraslado
      ? (isGuardadoSolicitudRibbon ? 'Pedido a sucursal guardado, aún falta completarlo.' : isRejectedSolicitudRibbon ? 'Solicitud rechazada por la sucursal proveedora' : isAcceptedSolicitudRibbon ? 'Solicitud aceptada por la sucursal proveedora' : isSentSolicitudRibbon ? 'Solicitud en estado de envio (traslado).' : 'Solicitud esperando a ser aceptada')
      : _ribbonStateLabel
  const solicitudRibbonDisplayLabel = formData.esLegado
    ? 'Previo a\nKava'
    : isReceivedRibbon
      ? _ribbonStateLabel.replace(' ', '\n')
      : isTraslado
        ? (isGuardadoSolicitudRibbon ? 'Guardado' : isRejectedSolicitudRibbon ? 'Solicitud\nrechazada' : isAcceptedSolicitudRibbon ? 'Solicitud\naceptada' : isSentSolicitudRibbon ? 'Solicitud\nenviada' : 'Solicitud\npendiente')
        : _ribbonStateLabel.replace(' ', '\n')
  const solicitudRejectionReason = String(previewData?.motivo_rechazo || '').trim()
  const resolvedSolicitudRejectionReason = (
    solicitudRejectionReason || 'Sin motivo de rechazo registrado.'
  )
  const canCancelTransfer = Boolean(
    hasPreviewData &&
    isRejectedSolicitudRibbon &&
    typeof onCancelTransfer === 'function'
  )
  const canResubmitTransfer = Boolean(
    hasPreviewData &&
    isRejectedSolicitudRibbon &&
    typeof onResubmitTransfer === 'function'
  )
  const productosTableClassName = [
    'create-user__locations-table',
    'create-salida__products-table',
    showDetailActions ? 'create-salida__products-table--with-actions' : '',
    isCompraEntrada ? 'create-salida__products-table--compra-local-view' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const modalClassName = [
    'create-user__modal',
    'create-salida__modal',
    showSolicitudRibbon ? 'entrada-details__modal--pending' : '',
    isClosing ? 'create-user__modal--closing' : '',
    isResizingModal ? 'create-salida__modal--resizing' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const headerTipo = selectedSubTipo?.nombre || formData.subTipoNombre || 'Tipo de entrada'
  const headerDocumento = String(formData.no_documento || '').trim() || 'No. de entrada'
  const modalTitle = hasPreviewData
    ? `Solicitud de traslado: ${headerDocumento}`
    : `${headerTipo}: ${headerDocumento}`

  const handleCancelTransfer = () => {
    if (!canCancelTransfer || cancellingTransfer) return
    onCancelTransfer?.(previewData)
  }

  const handleResubmitTransfer = () => {
    if (!canResubmitTransfer || resubmittingTransfer) return
    if (!formData.sucursalId) {
      notifyError('Selecciona la sucursal.')
      return
    }

    if (requiresSucursalObjetivo && !formData.sucursalObjetivoId) {
      notifyError('Selecciona la sucursal destino.')
      return
    }

    let ventaClienteLabel = String(formData.cliente || '').trim()
    if (isVenta) {
      if (selectedCliente?.id) {
        ventaClienteLabel = formatClienteFieldValue(selectedCliente)
      } else {
        const clientePayload = normalizeClientePayload(clienteForm)
        ventaClienteLabel = `${clientePayload.nombres} ${clientePayload.apellidos}`.trim()
      }

      if (!ventaClienteLabel) {
        notifyError('Ingresa los datos del cliente para la venta.')
        setActiveTab('cliente')
        return
      }
    }

    if (!details.length) {
      notifyError('Agrega al menos un producto.')
      return
    }

    const detailsHaveRequiredData = details.every((detail) => {
      const hasProduct = Boolean(String(detail?.productoId || '').trim())
      const hasState = Boolean(String(detail?.estadoProductoId || defaultEstadoProductoId || '').trim())
      const qty = parseIntValue(detail?.cantidad)
      const val = parseNumber(detail?.valor)
      return hasProduct && hasState && Number.isFinite(qty) && qty > 0 && Number.isFinite(val) && val >= 0
    })

    if (!detailsHaveRequiredData) {
      notifyError('Hay productos con datos incompletos.')
      return
    }

    const detallesPayload = details.map((detail) => {
      const cantidad = parseIntValue(detail.cantidad)
      const valor = parseNumber(detail.valor)
      return {
        producto_id: Number(detail.productoId),
        cantidad: Number.isFinite(cantidad) ? cantidad : 0,
        valor: Number.isFinite(valor) ? valor : 0,
      }
    })

    onResubmitTransfer?.({
      ...(previewData || {}),
      solicitud_traslado_id: transferSolicitudId || linkedSolicitudId,
      reactivationDraft: {
        sucursal_solicitante_id: Number(formData.sucursalId),
        sucursal_proveedora_id: Number(formData.sucursalObjetivoId),
        fecha: formData.fecha,
        descripcion: buildDescripcion(ventaClienteLabel),
        funcional: Boolean(formData.funcional),
        detalles: detallesPayload,
      },
    })
  }

  return (
    <div
      className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`}
      role="dialog"
      aria-modal="true"
      style={overlayStyle}
    >
      {unsavedGuard.dialog}
      <div ref={modalRef} {...unsavedGuard.interactionProps} className={modalClassName} style={modalStyle}>
        {showSolicitudRibbon && (
          <div
            className={`entrada-details__pending-ribbon${
              formData.esLegado
                ? ' entrada-details__pending-ribbon--legado'
                : isRejectedSolicitudRibbon
                  ? ' entrada-details__pending-ribbon--rejected'
                  : isAcceptedSolicitudRibbon
                    ? ' entrada-details__pending-ribbon--accepted'
                    : isSentSolicitudRibbon
                      ? ' entrada-details__pending-ribbon--sent'
                      : isReceivedRibbon
                        ? ' entrada-details__pending-ribbon--received'
                        : ' entrada-details__pending-ribbon--pending'
            }`}
            aria-label={solicitudRibbonLabel}
            title={solicitudRibbonTitle}
          >
            <span className="entrada-details__pending-ribbon-label">{solicitudRibbonDisplayLabel}</span>
          </div>
        )}
        <header className="create-user__header" onMouseDown={handleModalMouseDown}>
          <div className="create-user__header-text">
            <h3>{modalTitle}</h3>
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
              onClick={unsavedGuard.requestClose}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <form className="create-user__form" noValidate onSubmitCapture={(event) => event.currentTarget.classList.add('create-user__form--submitted')} onSubmit={(event) => event.preventDefault()}>
          {loadingData && (
            <div className="create-user__loading-overlay" role="status" aria-live="polite">
              <i className="pi pi-spin pi-spinner" aria-hidden="true" />
              <span>Cargando datos...</span>
            </div>
          )}
          <div className="create-user__tabs" role="tablist" aria-label="Secciones de entrada">
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'general' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('general')}
            >
              Datos de entrada
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
            {isTraslado && isPreviewGuardadoSolicitud && effectiveAllowEdit && (
              <button
                type="button"
                className={`create-user__tab ${activeTab === 'recordatorio' ? 'create-user__tab--active' : ''}`}
                onClick={() => setActiveTab('recordatorio')}
              >
                Recordatorio
              </button>
            )}
            {!(isTraslado && isPreviewGuardadoSolicitud) && (
              <button
                type="button"
                className={`create-user__tab ${activeTab === 'recordatorios' ? 'create-user__tab--active' : ''}`}
                onClick={() => setActiveTab('recordatorios')}
              >
                Recordatorios
              </button>
            )}
          </div>
          {isRejectedSolicitudRibbon && activeTab === 'general' && (
            <div className="entrada-details__rejection-reason" role="note" aria-live="polite">
              <strong>Motivo de rechazo:</strong>
              <span>{resolvedSolicitudRejectionReason}</span>
            </div>
          )}
          <div className="create-user__content create-salida__content">
              <div className="create-user__body">
                {activeTab === 'general' && (
                  <>
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Datos</p>
                      <h4>Informacion general</h4>
                    </div>
                    <span className="entrada-details__section-date">{formattedFecha}</span>
                  </div>

                  <div className="create-salida__field-groups">
                    <div className="create-salida__field-group create-salida__field-group--defined">
                      <div className={`create-user__grid create-user__grid--${isTraslado ? 'four' : 'three'}`}>
                        <StaticFieldDisplay label="Sucursal" value={selectedBranchName} />
                        {requiresSucursalObjetivo && (
                          <StaticFieldDisplay
                            label={isTraslado ? 'Sucursal proveedora' : 'Sucursal Destino'}
                            value={selectedObjectiveBranchName}
                          />
                        )}
                        {isDevolucion && (
                          <StaticFieldDisplay label="No. factura venta origen" value={formData.factura_referencia} />
                        )}
                        {(isCompraEntrada || isTraslado) && (
                          <StaticFieldDisplay label="No. de Factura" value={formData.factura_referencia} />
                        )}
                        {isTraslado && (
                          <StaticFieldDisplay label="Urgente" value={formData.urgente ? 'Sí' : 'No'} />
                        )}
                      </div>
                    </div>

                    {(isVenta || isDevolucion) && (
                      <div className="create-user__grid create-user__grid--two">
                        {isVenta && (
                          <label className="create-user__field">
                            <span>Descuento (%)</span>
                            <input
                              name="descuento"
                              type="number"
                              step="0.01"
                              min="0"
                              max="100"
                              value={formData.descuento}
                              onChange={handleChange}
                              disabled={editorDisabled}
                            />
                          </label>
                        )}

                        {isDevolucion && (
                          <label className="create-user__field">
                            <span>Funcional</span>
                            <select
                              name="funcional"
                              value={formData.funcional ? 'true' : 'false'}
                              onChange={(event) =>
                                isEditing &&
                                setFormData((prev) => ({ ...prev, funcional: event.target.value === 'true' }))
                              }
                              disabled={editorDisabled}
                            >
                              <option value="true">Si</option>
                              <option value="false">No</option>
                            </select>
                          </label>
                        )}
                      </div>
                    )}
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Detalle</p>
                      <h4>Listado de productos</h4>
                    </div>
                  </div>

                  {details.length > 0 && (
                    <ProductListSearch
                      value={productSearch}
                      onChange={setProductSearch}
                      shown={productMatchCount}
                      total={details.length}
                    />
                  )}

                  <div className={productosTableClassName}>
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>Codigo</span>
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
                      {showDetailActions && <span className="create-user__locations-cell--action">Acciones</span>}
                    </div>

                    {!isReadOnlyMode && !lineItemsReadOnly && (
                      <div className="create-user__locations-row create-user__locations-row--form">
                        <span className="create-salida__product-picker create-salida__product-picker--single">
                          <div className="create-user__dropdown create-salida__product-dropdown" ref={productDropdownRef}>
                            <button
                              type="button"
                              className="create-user__dropdown-trigger"
                              ref={productDropdownTriggerRef}
                              disabled={editorDisabled || (isTraslado && (!stockBranchId || stockLoading))}
                              onClick={() => {
                                const isOpening = !showProductDropdown
                                if (isOpening) {
                                  setProductDropdownDirection('down')
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
                                  ? formatProductoBaseLabel(selectedDraftProduct)
                                  : 'Selecciona un producto'}
                              </span>
                              {selectedDraftProduct && isTraslado && (
                                <small className="create-salida__row-stock">
                                  {Math.max(0, Math.trunc(getProductStockAllowance(String(selectedDraftProduct.id))))}
                                </small>
                              )}
                              <i className={`pi pi-chevron-${showProductDropdown ? 'up' : 'down'}`} />
                            </button>

                            {showProductDropdown && (
                              <div
                                className={`create-user__dropdown-panel ${
                                  productDropdownDirection === 'up' ? 'create-salida__product-panel--up' : ''
                                }`}
                                style={productDropdownMaxHeight ? { maxHeight: `${productDropdownMaxHeight}px` } : undefined}
                              >
                                <div className="create-user__dropdown-search">
                                  <i className="pi pi-search" />
                                  <input
                                    type="text"
                                    placeholder={isTraslado ? 'Buscar en sucursal' : 'Buscar productos'}
                                    value={productQuery}
                                    onChange={(event) => setProductQuery(event.target.value)}
                                    autoFocus
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
                                  {!productLoading && !productQuery.trim() && <small className="muted">Escribe para buscar.</small>}
                                  {!productLoading && productQuery.trim() && !productOptions.length && (
                                    <small className="muted">Sin resultados.</small>
                                  )}
                                  {productOptions.map((producto) => {
                                    const isSelected = String(producto.id) === String(detailDraft.productoId)
                                    const isAlreadyAdded = detailProductIdSet.has(String(producto.id).trim())
                                    const available = Number(stockByProduct[String(producto.id)] ?? 0)
                                    const isOutOfStock = isTraslado && available <= 0
                                    const isDisabled = isAlreadyAdded || isOutOfStock
                                    return (
                                      <button
                                        key={producto.id}
                                        type="button"
                                        className="create-user__result-option"
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={(event) => {
                                          event.preventDefault()
                                          event.stopPropagation()
                                          if (isDisabled) return
                                          handleProductSelect(producto)
                                        }}
                                        disabled={isDisabled}
                                        title={isAlreadyAdded ? 'Ya agregado' : isOutOfStock ? 'Sin stock en la sucursal proveedora' : undefined}
                                      >
                                        <div className="create-user__result-info">
                                          <strong>{formatProductoOptionLabel(producto)}</strong>
                                          <small>{isTraslado ? `Disponible: ${available}` : `Stock: ${Number(producto?.total_stock ?? 0)}`}</small>
                                        </div>
                                        {isSelected && <span className="create-user__result-tag is-selected">Seleccionado</span>}
                                        {isAlreadyAdded && <span className="create-user__result-tag is-added">Ya agregado</span>}
                                        {!isAlreadyAdded && isOutOfStock && <span className="create-user__result-tag is-added">Sin stock</span>}
                                      </button>
                                    )
                                  })}
                                  {!productLoading && productOptions.length > 0 && (
                                    <small className="muted create-salida__product-search-hint">
                                      Para resultados más precisos escribe un código más específico.
                                    </small>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        </span>
                        <span
                          onMouseEnter={(e) => showHover(e, [selectedDraftProduct?.nombre].filter(Boolean), 'Descripción')}
                          onMouseLeave={hideHover}
                        >
                          <span className="create-salida__table-static-value create-salida__table-static-value--name">
                            <span className="create-salida__product-name-text">{selectedDraftProduct?.nombre || '-'}</span>
                          </span>
                        </span>
                        {isCompraEntrada && (
                          <>
                            <span>
                              <input
                                name="costo"
                                type="number"
                                min="0"
                                step="0.01"
                                value={detailDraft.costo}
                                onChange={handleDetailChange}
                                disabled={editorDisabled}
                              />
                            </span>
                            <span>
                              <input
                                name="descuentoPorcentaje"
                                type="number"
                                min="0"
                                max="100"
                                step="0.01"
                                value={detailDraft.descuentoPorcentaje}
                                onChange={handleDetailChange}
                                disabled={editorDisabled}
                              />
                            </span>
                            <span className="create-salida__numeric">
                              {formatCurrency(draftDescuentoValor)}
                            </span>
                            <span className="create-salida__numeric">
                              {formatCurrency(draftCostoConIva)}
                            </span>
                          </>
                        )}
                        <span>
                          <span className="create-salida__table-static-value">
                            {formatCurrency(detailDraft.valor)}
                          </span>
                        </span>
                        {isCompraEntrada && (
                          <span className="create-salida__numeric">
                            {formatCurrency(draftValorConIva)}
                          </span>
                        )}
                        <span>
                          <input
                            name="cantidad"
                            type="number"
                            min="0"
                            step="1"
                            max={draftStockRemaining ?? undefined}
                            value={detailDraft.cantidad}
                            onChange={handleDetailChange}
                            disabled={editorDisabled}
                            title={draftStockRemaining !== null ? `Disponible: ${draftStockRemaining}` : undefined}
                          />
                        </span>
                        <span>
                          <input value={draftLineTotal !== null ? draftLineTotal.toFixed(2) : ''} readOnly disabled />
                        </span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button type="button" className="create-user__ghost create-user__ghost--success" onClick={handleAddDetail} disabled={editorDisabled}>
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

                    {details.length > 0 && !productMatchCount && <ProductSearchEmptyRow query={productSearch} />}

                    {filteredDetails.map((detail) => {
                        const productId = String(detail.productoId || detail.producto_id || '').trim()
                        const currentQty = parseIntValue(detail.cantidad) ?? 0
                        const reservedQty = getProductReservedQuantity(productId)
                        const others = Math.max(reservedQty - currentQty, 0)
                        const allowance = getProductStockAllowance(productId)
                        const remaining = Math.max(allowance - others, 0)
                        const stockLabel = showProveedorStockInfo
                          ? Math.max(0, Math.trunc(allowance))
                          : null
                        const insufficientStock = Boolean(
                          showProveedorStockInfo && !stockLoading && currentQty > remaining
                        )

                        const descuentoValor = isCompraEntrada
                          ? calculateDescuentoValor(detail.costo, detail.descuentoPorcentaje)
                          : null
                        const costoConIva = isCompraEntrada && Number.isFinite(detail.costo)
                          ? calculateCostoConIva(detail.costo, detail.descuentoPorcentaje, ivaRateValue)
                          : null
                        const valorConIva = isCompraEntrada
                          ? calculatePrecioConIva(detail.valor, ivaRateValue)
                          : null

                        return (
                          <div
                            key={detail.uid}
                            className={`create-user__locations-row${insufficientStock ? ' create-salida__row--insufficient' : ''}`}
                          >
                            <span>
                              {detail.productoCodigo || '-'}
                              {stockLabel !== null && (
                                <small className={`create-salida__row-stock${insufficientStock ? ' create-salida__row-stock--insufficient' : ''}`}>
                                  {stockLabel}
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
                              <span className="create-salida__numeric">{formatCurrency(detail.costo)}</span>
                              <span className="create-salida__numeric">
                                {Number.isFinite(detail.descuentoPorcentaje) ? `${detail.descuentoPorcentaje}%` : '-'}
                              </span>
                              <span className="create-salida__numeric">{formatCurrency(descuentoValor)}</span>
                              <span className="create-salida__numeric">{formatCurrency(costoConIva)}</span>
                              <span className="create-salida__numeric">
                                {detail.productoPrecioBD !== null ? formatCurrency(detail.productoPrecioBD) : '-'}
                              </span>
                            </>
                          )}
                          <span className="create-salida__numeric">{formatCurrency(detail.valor)}</span>
                          {isCompraEntrada && (
                            <span className="create-salida__numeric">{formatCurrency(valorConIva)}</span>
                          )}
                          <span>
                            {!isReadOnlyMode && !lineItemsReadOnly ? (
                                <input
                                  type="number"
                                  min="0"
                                  step="1"
                                  value={detail.cantidad ?? ''}
                                  onChange={(event) => handleUpdateDetailQuantity(detail.uid, event.target.value)}
                                  disabled={editorDisabled}
                                  max={remaining || undefined}
                                  className={insufficientStock ? 'create-salida__input--error' : undefined}
                                  title={insufficientStock ? `Disponible: ${remaining}` : undefined}
                                />
                            ) : (
                              <span
                                className={insufficientStock ? 'create-salida__cantidad--insufficient' : undefined}
                                title={insufficientStock ? `Disponible: ${remaining}` : undefined}
                              >
                                {detail.cantidad}
                                {detail.cantidadFaltante > 0 && (
                                  <>
                                    {' '}
                                    <span
                                      className="create-salida__cantidad-faltante"
                                      onMouseEnter={(event) => openFaltantePopover(event, detail)}
                                      onMouseLeave={closeFaltantePopover}
                                    >
                                      ({detail.cantidadFaltante})
                                    </span>
                                  </>
                                )}
                              </span>
                            )}
                          </span>
                          <span className="create-salida__numeric">{formatCurrency(detail.valor_total)}</span>
                          {showDetailActions && (
                            <span className="create-user__locations-cell create-user__locations-cell--action">
                              <button type="button" className="create-user__locations-remove" onClick={() => handleRemoveDetail(detail.uid)} disabled={editorDisabled}>
                                x
                              </button>
                            </span>
                          )}
                        </div>
                      )
                    })}

                    <div className="create-user__locations-row create-salida__totals-row">
                      <span className="create-salida__totals-label">{isTraslado ? 'Total' : 'Subtotal'}</span>
                      <span className="create-salida__totals-value">{formatCurrency(subtotalConBorrador)}</span>
                    </div>

                    {isVenta && (
                      <div className="create-user__locations-row create-salida__totals-row">
                        <span className="create-salida__totals-label">Descuento ({descuentoPercentLabel}%)</span>
                        <span className="create-salida__totals-value">-{formatCurrency(descuentoAplicado)}</span>
                      </div>
                    )}

                    {!isTraslado && (
                      <div className="create-user__locations-row create-salida__totals-row create-salida__totals-row--strong">
                        <span className="create-salida__totals-label">Total con IVA ({ivaPercent}%)</span>
                        <span className="create-salida__totals-value">
                          <strong>{formatCurrency(totalConIva)}</strong>
                        </span>
                      </div>
                    )}
                  </div>

                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Datos</p>
                      <h4>Nota</h4>
                    </div>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field create-user__field--full">
                      <input
                        name="descripcion"
                        type="text"
                        aria-label="Nota"
                        value={formData.descripcion}
                        onChange={handleChange}
                        disabled={editorDisabled}
                      />
                    </label>
                  </div>

                  {formData.notaInconveniente && (
                    <div className="create-user__grid create-user__grid--two">
                      <div className="create-user__field create-user__field--full create-salida__inconveniente-note">
                        <span>Nota de inconveniente</span>
                        <p>{formData.notaInconveniente}</p>
                      </div>
                    </div>
                  )}
                  {formData.notaInconvenienteResolucion && (
                    <div className="create-user__grid create-user__grid--two">
                      <div className="create-user__field create-user__field--full create-salida__inconveniente-resolucion-note">
                        <span>Resolución del inconveniente</span>
                        <p>{formData.notaInconvenienteResolucion}</p>
                      </div>
                    </div>
                  )}

                  {(creatorInfo.creadoPorNombre || creatorInfo.enviadoPorNombre || creatorInfo.recibidoPorNombre) && (
                    <p className="movimientos-details__creator-info">
                      {creatorInfo.creadoPorNombre && <span>Creado por: {creatorInfo.creadoPorNombre}</span>}
                      {isTraslado && creatorInfo.enviadoPorNombre && (
                        <span>Enviado por: {creatorInfo.enviadoPorNombre}</span>
                      )}
                      {isTraslado && creatorInfo.recibidoPorNombre && (
                        <span>Recibido por: {creatorInfo.recibidoPorNombre}</span>
                      )}
                    </p>
                  )}
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
                      <label className="create-user__field create-user__field--full">
                        <span>Cliente</span>
                        <div className="create-user__dropdown" ref={clienteDropdownRef}>
                          <input
                            type="text"
                            placeholder="Buscar por cedula o nombre"
                            value={clienteQuery}
                            onChange={handleClienteQueryChange}
                            onFocus={() => isEditing && setShowClienteDropdown(Boolean(clienteQuery))}
                            disabled={editorDisabled}
                            autoComplete="off"
                          />
                          {showClienteDropdown && isEditing && (
                            <div className="create-user__dropdown-panel create-salida__cliente-panel">
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
                            </div>
                          )}
                        </div>
                      </label>

                      <label className="create-user__field">
                        <span>Cedula/RUC</span>
                        <input
                          name="cedula_ruc"
                          type="text"
                          value={clienteForm.cedula_ruc}
                          onChange={handleClienteFieldChange}
                          disabled={editorDisabled}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Nombres</span>
                        <input
                          name="nombres"
                          type="text"
                          value={clienteForm.nombres}
                          onChange={handleClienteFieldChange}
                          disabled={editorDisabled}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Apellidos</span>
                        <input
                          name="apellidos"
                          type="text"
                          value={clienteForm.apellidos}
                          onChange={handleClienteFieldChange}
                          disabled={editorDisabled}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Correo</span>
                        <input
                          name="correo"
                          type="email"
                          value={clienteForm.correo}
                          onChange={handleClienteFieldChange}
                          disabled={editorDisabled}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Telefono</span>
                        <input
                          name="telefono"
                          type="text"
                          value={clienteForm.telefono}
                          onChange={handleClienteFieldChange}
                          disabled={editorDisabled}
                        />
                      </label>

                      <label className="create-user__field create-user__field--full">
                        <span>Direccion</span>
                        <input
                          name="direccion"
                          type="text"
                          value={clienteForm.direccion}
                          onChange={handleClienteFieldChange}
                          disabled={editorDisabled}
                        />
                      </label>
                    </div>

                    {selectedCliente?.id && (
                      <small className="muted">Cliente existente detectado. Se usara el registro actual al guardar.</small>
                    )}
                  </section>
                )}

                {isTraslado && isPreviewGuardadoSolicitud && effectiveAllowEdit && activeTab === 'recordatorio' && (
                  <section className="create-user__section">
                    <div className="create-user__section-header">
                      <div>
                        <p className="create-user__eyebrow">Recordatorio</p>
                        <h4>Usuarios a quienes recordar</h4>
                      </div>
                    </div>

                    <p className="create-salida__reminder-helper">
                      Al enviar la solicitud se genera automáticamente un recordatorio para administradores y usuarios seleccionados.
                    </p>
                    <div className="create-salida__reminder-rule" role="note">
                      Solo se listan usuarios con permisos de <strong>crear y editar</strong> en{' '}
                      <strong>Movimientos - Salidas</strong> de la <strong>sucursal proveedora</strong>.
                    </div>

                    {!hasSelectedReminderTargetBranch && (
                      <small className="muted">No se pudo resolver la sucursal proveedora para cargar usuarios.</small>
                    )}

                    {reminderBlocker && (
                      <BlockerNotice
                        title={reminderBlocker.title}
                        reason={reminderBlocker.reason}
                        goTo={reminderBlocker.goTo}
                        actionLabel={reminderBlocker.retry ? 'Reintentar' : null}
                        onAction={reminderBlocker.retry ? fetchReminderUsers : null}
                      />
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
                              <div key={`entrada-details-admin-recipient-${recipient.id}`} className="permissions-matrix__row">
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
                                  No hay usuarios administradores activos.
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
                                No se pudo resolver la sucursal proveedora.
                              </div>
                            </div>
                          )}

                          {hasSelectedReminderTargetBranch && !reminderUsersLoading && !selectableReminderUsers.length && (
                            <div className="permissions-matrix__row create-salida__reminder-row--empty">
                              <div className="permissions-matrix__cell permissions-matrix__cell--label">
                                Ningún usuario de {proveedorSucursalLabel} tiene permiso de crear y editar Salidas.
                              </div>
                            </div>
                          )}

                          {selectableReminderUsers.map((userItem) => {
                            const userId = normalizeId(userItem?.id)
                            const checked = selectedReminderUserIds.includes(userId)
                            return (
                              <div key={`entrada-details-reminder-user-${userId}`} className="permissions-matrix__row">
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
                                    disabled={saving || reminderUsersLoading || !hasSelectedReminderTargetBranch}
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

                {activeTab === 'recordatorios' && (
                  <EntityRemindersTab
                    token={token}
                    currentUser={currentUser}
                    entityType="entrada"
                    entityId={entradaId}
                    isOpen={open}
                    entityLabel={modalTitle}
                    transferSolicitudId={transferSolicitudId}
                    onError={notifyError}
                  />
                )}
              </div>
            </div>

          {reminderBlocker && effectiveAllowEdit && !isRejectedSolicitudRibbon && activeTab !== 'recordatorio' && (
            <div style={{ padding: '8px 15px 0' }}>
              <BlockerNotice
                compact
                title={reminderBlocker.title}
                reason={reminderBlocker.reason}
                goTo={reminderBlocker.goTo}
                actionLabel={reminderBlocker.retry ? 'Reintentar' : 'Ver recordatorio'}
                onAction={reminderBlocker.retry ? fetchReminderUsers : () => setActiveTab('recordatorio')}
              />
            </div>
          )}

          {isEditing && entradaId && !isReadOnlyMode && (
            <EntradaAjustePreview
              token={token}
              entradaId={entradaId}
              details={details}
              overrides={ajusteOverrides}
              onOverridesChange={setAjusteOverrides}
              onPlanChange={setAjustePlan}
            />
          )}

          <div className="create-user__footer">
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={isEditing ? handleCancelEdit : onClose}
                disabled={saving || loadingData}
              >
                {isReadOnlyMode && !isEditing ? 'Cerrar' : 'Cancelar'}
              </button>
              {!isReadOnlyMode && effectiveAllowEdit && (
                  <span className="entrada-details__edit-hint-wrapper">
                    {isRejectedSolicitudRibbon && !isEditing && (
                      <span className="entrada-details__edit-hint" role="note">
                        Presiona Editar para volver a intentar con la solicitud
                      </span>
                    )}
                    <button
                      type="button"
                      className={`create-user__action create-user__action--edit user-details__edit-toggle${isEditing ? ' user-details__edit-toggle--active' : ''}`}
                      onClick={handleEditToggleClick}
                      disabled={loadingData || saving || deleteLoading}
                    >
                    <span className="user-details__toggle-icon" aria-hidden="true">
                      {isEditing ? <Eye size={14} /> : <Pencil size={14} />}
                    </span>
                    <span>{isEditing ? 'Solo lectura' : 'Editar'}</span>
                  </button>
                  </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {isEditing && !isReadOnlyMode && (
                <>
                  {isRejectedSolicitudRibbon ? (
                    <button
                      type="button"
                      className="create-user__action user-details__delete"
                      onClick={handleCancelTransfer}
                      disabled={loadingData || cancellingTransfer || resubmittingTransfer}
                    >
                      {cancellingTransfer ? 'Cancelando...' : 'Cancelar pedido'}
                    </button>
                  ) : allowDelete && (
                    <button
                      type="button"
                      className="create-user__action user-details__delete"
                      onClick={openDeleteConfirm}
                      disabled={deleteLoading || saving}
                    >
                      {deleteLoading ? 'Eliminando...' : 'Eliminar'}
                    </button>
                  )}
                  {isRejectedSolicitudRibbon ? (
                    <button
                      type="button"
                      className="create-user__action create-user__action--primary"
                      onClick={handleResubmitTransfer}
                      disabled={loadingData || resubmittingTransfer || cancellingTransfer}
                    >
                      {resubmittingTransfer ? 'Reenviando...' : 'Volver a realizar la solicitud'}
                    </button>
                  ) : allowEdit && (
                    <button
                      type="button"
                      className="create-user__action create-user__action--secondary"
                      onClick={handleSave}
                      disabled={saving || loadingData}
                    >
                      {saving ? 'Guardando...' : 'Guardar cambios'}
                    </button>
                  )}
                </>
              )}
              {!isEditing && !hasPreviewData && selectedSubTipoName.includes('compra') && formData.esSucursalMatriz && formData.compraPorRepartir !== 0 && typeof onDistribuirCompra === 'function' && (
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={() => onDistribuirCompra(entradaId)}
                  disabled={loadingData}
                >
                  Enviar a sucursales
                </button>
              )}
              {isPreviewGuardadoSolicitud && effectiveAllowEdit && !isRejectedSolicitudRibbon && (
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={handleCrearSolicitudDesdeGuardado}
                  disabled={saving || loadingData || deleteLoading}
                >
                  {saving ? 'Guardando...' : 'Crear solicitud'}
                </button>
              )}
            </div>
          </div>
        </form>

        {showDeleteConfirm && (
          <div className="create-salida__confirm-overlay" onMouseDown={closeDeleteConfirm}>
            <div
              className="create-salida__confirm-card create-salida__confirm-card--cancel entrada-details__delete-confirm-card"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <h4>Eliminar entrada</h4>
              <p>
                Se eliminara la entrada <strong>{String(formData.no_documento || '').trim() || `#${entradaId}`}</strong>.
              </p>
               <p className="create-salida__confirm-warning">
                 {isPendingSolicitudEntry
                   ? 'Esta solicitud no movió inventario; al eliminarla no se ajustará el stock.'
                   : 'Elige cómo quieres manejar el inventario asociado a esta entrada.'}
               </p>
               {!isPendingSolicitudEntry && (
                 <fieldset className="entrada-details__delete-confirm-options">
                   <label className="entrada-details__delete-confirm-option">
                     <input
                       type="radio"
                       name="entry-delete-inventory-action"
                       value="keep"
                       checked={deleteInventoryAction === 'keep'}
                       onChange={() => setDeleteInventoryAction('keep')}
                       disabled={deleteLoading}
                     />
                     <span>
                       <strong>Mantener inventario actual</strong>
                       <small>Elimina el documento sin restar cantidades del inventario.</small>
                     </span>
                   </label>
                   <label className="entrada-details__delete-confirm-option">
                     <input
                       type="radio"
                       name="entry-delete-inventory-action"
                       value="reverse"
                       checked={deleteInventoryAction === 'reverse'}
                       onChange={() => setDeleteInventoryAction('reverse')}
                       disabled={deleteLoading}
                     />
                     <span>
                       <strong>Restar inventario ingresado</strong>
                       <small>Revierte las cantidades que esta entrada sumó al inventario.</small>
                     </span>
                   </label>
                 </fieldset>
               )}
              <div className="create-salida__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--cancel"
                  onClick={closeDeleteConfirm}
                  disabled={deleteLoading}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="create-user__action user-details__confirm-danger"
                  onClick={handleDelete}
                  disabled={deleteLoading}
                >
                  {deleteLoading ? 'Eliminando...' : 'Eliminar entrada'}
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
      {faltantePopover && createPortal(
        <div
          className="table-cell-hover-card create-salida__faltante-card"
          role="tooltip"
          style={{ top: faltantePopover.top, left: faltantePopover.left, pointerEvents: 'none' }}
        >
          <div className="table-cell-hover-card__title">
            Faltante {faltantePopover.codigo ? `de ${faltantePopover.codigo}` : ''}
          </div>
          {faltantePopover.detalles.map((item, index) => (
            <div key={index} className="table-cell-hover-card__row create-salida__faltante-card-item">
              <div className="create-salida__faltante-card-head">
                <strong>{item.cantidad} u.</strong>
                <span
                  className={`create-salida__faltante-card-solucion${item.pendiente ? ' create-salida__faltante-card-solucion--pendiente' : ''}`}
                >
                  {item.solucion}
                </span>
              </div>
              {item.sucursal && <div>Sucursal: {item.sucursal}</div>}
              {item.ubicacion && <div>Ubicación: {item.ubicacion}</div>}
              {item.nota && <div>{item.pendiente ? 'Novedad' : 'Nota'}: {item.nota}</div>}
              {(item.resuelto_por || item.fecha) && (
                <div className="create-salida__faltante-card-meta">
                  {[item.resuelto_por, item.fecha ? formatDate(item.fecha) : ''].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>,
        getAppPortalRoot()
      )}
    </div>
  )
}

export default EntradaDetails




