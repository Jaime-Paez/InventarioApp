import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import '../admin/CreateUsuario/CreateUsuario.css'
import './CreateSalida.css'
import { API_URL, authFetch } from '../../../utils/api'
import useModalAnimation from '../common/useModalAnimation'
import {
  createReminderId,
  emitRemindersSync,
  extractUserId,
  formatCurrentUserName,
  normalizeId,
  readRemindersFromStorage,
  sanitizeRecipient,
  writeRemindersToStorage,
} from '../common/reminders/remindersStorage'

const DEFAULT_IVA_RATE = 0.15
const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const SELECTOR_WIDTH = 520
const SELECTOR_HEIGHT = 300
const SELECTOR_MIN_WIDTH = 420
const SELECTOR_MIN_HEIGHT = 260
const VIEWPORT_PADDING = 12

const initialForm = {
  sucursalId: '',
  subTipoId: '',
  estadoId: '',
  fecha: '',
  no_documento: '',
  descripcion: '',
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
  return {
    date: now.toISOString().slice(0, 10),
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
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

const hasModuleBranchAccess = (userItem, moduleKey, branchId) => {
  const normalizedModule = normalizeString(moduleKey)
  const normalizedBranchId = normalizeId(branchId)
  if (!normalizedModule || !normalizedBranchId) return false
  const ids = userItem?.moduleScopes?.[normalizedModule]
  return Array.isArray(ids) && ids.includes(normalizedBranchId)
}

const formatSubTipoLabel = (subTipo) => {
  const nombre = String(subTipo?.nombre || '').trim()
  if (!nombre) return ''
  return normalizeValue(nombre).includes('trasl') ? 'Solicitud de traslado' : nombre
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

const resolveProductPrice = (producto) => {
  const parsed = parseNumber(producto?.precio)
  if (parsed === null || parsed < 0) return ''
  const raw = String(producto?.precio ?? '').trim()
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

const clienteRequiredFields = ['nombres', 'apellidos', 'cedula_ruc', 'telefono', 'direccion']
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
  currentUser = null,
}) {
  const [formData, setFormData] = useState(initialForm)
  const [loading, setLoading] = useState(false)
  const [, setError] = useState('')

  const [branches, setBranches] = useState([])
  const [providerBranches, setProviderBranches] = useState([])
  const [tipoMovimientos, setTipoMovimientos] = useState(() => preloadedTipoMovimientos)
  const [subTipos, setSubTipos] = useState(() => preloadedSubTipos)
  const [estados, setEstados] = useState([])
  const [productos, setProductos] = useState([])
  const [estadosProducto, setEstadosProducto] = useState([])

  const [details, setDetails] = useState([])
  const [detailDraft, setDetailDraft] = useState(initialDetail)
  const [detailError, setDetailError] = useState('')
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [productDropdownDirection, setProductDropdownDirection] = useState('up')
  const [productDropdownMaxHeight, setProductDropdownMaxHeight] = useState(null)
  const [productQuery, setProductQuery] = useState('')
  const [productOptions, setProductOptions] = useState([])
  const [productLoading, setProductLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [clienteMode, setClienteMode] = useState(CLIENT_MODE_EXISTING)
  const [selectedCliente, setSelectedCliente] = useState(null)
  const [clienteForm, setClienteForm] = useState(initialClienteForm)
  const [showClienteDropdown, setShowClienteDropdown] = useState(false)
  const [clienteQuery, setClienteQuery] = useState('')
  const [clienteOptions, setClienteOptions] = useState([])
  const [clienteLoading, setClienteLoading] = useState(false)
  const [stockByProduct, setStockByProduct] = useState({})
  const [stockLoading, setStockLoading] = useState(false)
  const [reminderUsers, setReminderUsers] = useState([])
  const [reminderUsersLoading, setReminderUsersLoading] = useState(false)
  const [reminderUsersError, setReminderUsersError] = useState('')
  const [selectedReminderUserIds, setSelectedReminderUserIds] = useState([])
  const [documentStatus, setDocumentStatus] = useState(DOCUMENT_STATUS.invalid)
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })
  const [isMaximized, setIsMaximized] = useState(false)
  const [isResizingModal, setIsResizingModal] = useState(false)
  const modalRef = useRef(null)
  const productDropdownRef = useRef(null)
  const productDropdownTriggerRef = useRef(null)
  const clienteDropdownRef = useRef(null)
  const clienteSearchTimerRef = useRef(null)
  const documentCheckTimerRef = useRef(null)
  const documentCheckSequenceRef = useRef(0)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalResize = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const modalSizeRef = useRef(modalSize)
  const modalPositionRef = useRef(modalPosition)
  const modalRestoreRef = useRef(null)

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

  const currentCreatorId = useMemo(() => normalizeId(extractUserId(currentUser)), [currentUser])
  const currentCreatorName = useMemo(() => formatCurrentUserName(currentUser), [currentUser])
  const currentCreatorEmail = String(currentUser?.correo || currentUser?.email || '').trim()
  const isCurrentUserAdmin = useMemo(
    () => hasUsersModuleAccess(currentUser?.permisos),
    [currentUser]
  )

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

  const selectedSubTipoName = normalizeValue(selectedSubTipo?.nombre)
  const isDevolucion = selectedSubTipoName.includes('devol')
  const isTraslado = selectedSubTipoName.includes('trasl')
  const isVenta = selectedSubTipoName.includes('vent')
  const isCompraEntrada = selectedSubTipoName.includes('compra') || selectedSubTipoName.includes('import')
  const isEstadoEditable = isVenta || isCompraEntrada
  const useExistingCliente = clienteMode === CLIENT_MODE_EXISTING
  const useNewCliente = clienteMode === CLIENT_MODE_NEW
  const isSelectorStep = !formData.subTipoId
  const requiresSucursalObjetivo = isTraslado
  const documentLabel = isTraslado ? 'No. de Solicitud' : (isCompraEntrada ? 'No. de Compra' : 'No. de Factura')
  const normalizedPrefilledSucursalId = String(prefilledSucursalId || '').trim()
  const isSucursalPrincipalLocked = isTraslado && Boolean(normalizedPrefilledSucursalId)
  const selectedSucursalId = String(formData.sucursalId || '').trim()
  const hasSelectedSucursal = Boolean(selectedSucursalId)
  const selectedProveedorSucursalId = String(formData.sucursalObjetivoId || '').trim()
  const hasSelectedProveedorSucursal = Boolean(selectedProveedorSucursalId)
  const hasProductSourceBranch = isTraslado ? hasSelectedProveedorSucursal : hasSelectedSucursal
  const providerBranchPool = providerBranches.length ? providerBranches : branches
  const destinationBranches = useMemo(() => {
    return providerBranchPool.filter((branch) => String(branch?.id || '').trim() !== selectedSucursalId)
  }, [providerBranchPool, selectedSucursalId])

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
    const allowed = new Set(['en camino', 'recibido', 'parcialmente recibido'])
    const filtered = estados.filter((estado) => allowed.has(normalizeValue(estado?.nombre)))
    return filtered.length ? filtered : estados
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
      const preferredOrder = ['en camino', 'parcialmente recibido', 'recibido']
      for (const key of preferredOrder) {
        const matched = estadoOptions.find((estado) => normalizeValue(estado?.nombre) === key)
        if (matched?.id) return String(matched.id)
      }
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
  const estadoSelectOptions = isVenta ? ventaEstadoOptions : (isCompraEntrada ? compraEstadoOptions : estadoOptions)

  const selectedDraftProduct = useMemo(
    () => productos.find((producto) => String(producto.id) === String(detailDraft.productoId)) || null,
    [detailDraft.productoId, productos]
  )
  const proveedorBranchName = useMemo(() => {
    if (!isTraslado) return ''
    const selectedBranch = providerBranchPool.find(
      (branch) => String(branch?.id || '') === String(formData.sucursalObjetivoId || '')
    )
    return String(selectedBranch?.nombre || '').trim()
  }, [formData.sucursalObjetivoId, isTraslado, providerBranchPool])
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
    if (!isTraslado || !selectedProveedorSucursalId) return []
    return reminderUsers.filter((userItem) =>
      hasModuleBranchAccess(userItem, 'movimientos_salidas', selectedProveedorSucursalId)
    )
  }, [isTraslado, reminderUsers, selectedProveedorSucursalId])

  const adminReminderRecipients = useMemo(() => {
    const recipients = reminderBranchUsers
      .filter((userItem) => userItem.isAdmin)
      .map((userItem) => sanitizeRecipient({ id: userItem.id, name: userItem.name }))
      .filter(Boolean)

    if (!recipients.length && isCurrentUserAdmin && currentCreatorId) {
      const fallback = sanitizeRecipient({
        id: currentCreatorId,
        name: currentCreatorName || 'Administrador',
      })
      if (fallback) recipients.push(fallback)
    }

    return recipients.filter(
      (recipient, index, list) =>
        list.findIndex((item) => normalizeId(item?.id) === normalizeId(recipient?.id)) === index
    )
  }, [currentCreatorId, currentCreatorName, isCurrentUserAdmin, reminderBranchUsers])

  const adminReminderRecipientIds = useMemo(
    () => new Set(adminReminderRecipients.map((recipient) => normalizeId(recipient?.id)).filter(Boolean)),
    [adminReminderRecipients]
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
          const matchedUser = reminderBranchUsersById.get(recipientId)
          const fallbackEmail = recipientId === currentCreatorId ? currentCreatorEmail : ''
          return {
            id: recipientId,
            name: String(recipient?.name || 'Administrador').trim() || 'Administrador',
            email: String(matchedUser?.email || fallbackEmail || '').trim(),
          }
        })
        .filter(Boolean),
    [adminReminderRecipients, currentCreatorEmail, currentCreatorId, reminderBranchUsersById]
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
      const nombre = String(producto?.nombre || '').trim()
      return [codigo, nombre].filter(Boolean).join(' - ') || `ID: ${producto?.id ?? ''}`
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
          `${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=20`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar los productos.')

        const payload = await response.json()
        setProductOptions(parseApiList(payload))
      } catch {
        setProductOptions([])
      } finally {
        setProductLoading(false)
      }
    },
    [hasProductSourceBranch, token]
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

  const validateDocumentNumber = useCallback(
    async (inputValue) => {
      const normalized = String(inputValue || '').trim()
      if (!normalized) {
        setDocumentStatus(DOCUMENT_STATUS.invalid)
        return false
      }
      if (!entradaTipoId || !token) {
        setDocumentStatus(DOCUMENT_STATUS.error)
        return false
      }

      const requestSequence = documentCheckSequenceRef.current + 1
      documentCheckSequenceRef.current = requestSequence
      setDocumentStatus(DOCUMENT_STATUS.checking)

      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/validar-documento/?tipo_movimiento_id=${encodeURIComponent(
            entradaTipoId
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
    [entradaTipoId, token]
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

      return changed ? next : prev
    })
  }, [formData.subTipoId, isDevolucion, isTraslado, isVenta])

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
      notifyError(err?.message || 'Ocurrio un error al cargar los catalogos.')
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
        },
        ...list,
      ]
    }

    try {
      const rows = []
      let url = `${API_URL}/usuarios/listado/?page_size=200`

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
          isAdmin: hasUsersModuleAccess(item?.permisos_resumen),
          moduleScopes: normalizeModuleScopes(item?.sucursales_por_modulo),
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
    setShowProductDropdown(false)
    setProductDropdownDirection('up')
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
    setReminderUsers([])
    setReminderUsersLoading(false)
    setReminderUsersError('')
    setSelectedReminderUserIds([])
    setDocumentStatus(DOCUMENT_STATUS.invalid)
    setIsMaximized(false)
    setIsResizingModal(false)
    modalRestoreRef.current = null
    setError('')
    fetchCatalogs()
    fetchReminderUsers()
  }, [fetchCatalogs, fetchReminderUsers, normalizedPrefilledSucursalId, open])

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
    setProductDropdownDirection((prev) => (prev === 'up' ? prev : 'up'))
    const nextMaxHeight = Math.max(140, Math.min(320, availableAbove))
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
    if (!open || !formData.subTipoId) {
      setDocumentStatus(DOCUMENT_STATUS.invalid)
      return
    }

    const value = String(formData.no_documento || '').trim()
    if (!value) {
      setDocumentStatus(DOCUMENT_STATUS.invalid)
      if (documentCheckTimerRef.current) {
        clearTimeout(documentCheckTimerRef.current)
        documentCheckTimerRef.current = null
      }
      return
    }

    if (isTraslado) {
      setDocumentStatus(DOCUMENT_STATUS.available)
      if (documentCheckTimerRef.current) {
        clearTimeout(documentCheckTimerRef.current)
        documentCheckTimerRef.current = null
      }
      return
    }

    if (documentCheckTimerRef.current) {
      clearTimeout(documentCheckTimerRef.current)
      documentCheckTimerRef.current = null
    }

    setDocumentStatus(DOCUMENT_STATUS.checking)
    documentCheckTimerRef.current = setTimeout(() => {
      validateDocumentNumber(value)
    }, 320)

    return () => {
      if (documentCheckTimerRef.current) {
        clearTimeout(documentCheckTimerRef.current)
        documentCheckTimerRef.current = null
      }
    }
  }, [formData.no_documento, formData.subTipoId, isTraslado, open, validateDocumentNumber])

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
    if (!open || !isTraslado || !formData.sucursalObjetivoId) {
      setStockByProduct({})
      return
    }
    fetchStockByBranch(formData.sucursalObjetivoId)
  }, [fetchStockByBranch, formData.sucursalObjetivoId, isTraslado, open])

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
    if (isMaximized || !modalRef.current) return
    const target = event?.target
    if (target?.closest?.('.create-user__icon-button')) return
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

  const handleChange = (event) => {
    const { name, value, type, checked } = event.target
    const nextValue = type === 'checkbox' ? checked : value
    setFormData((prev) => {
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
    const productoId = String(detailDraft.productoId || '').trim()
    const cantidad = parseIntValue(detailDraft.cantidad)
    const estadoProductoId = String(defaultEstadoProductoId || '').trim()
    const producto = productos.find((item) => String(item.id) === productoId)
    const valor = parseNumber(resolveProductPrice(producto))

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
        estadoProductoId,
        estadoProductoNombre: estadoProducto?.nombre ?? '',
        cantidad,
        valor,
        valor_total,
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
  }

  const buildDescripcion = (clienteLabel = '') => {
    const descripcionBase = String(formData.descripcion || '').trim()
    if (!isVenta) return descripcionBase
    const cliente = String(clienteLabel || '').trim()
    if (!cliente) return descripcionBase
    if (!descripcionBase) return `Cliente: ${cliente}`
    return `Cliente: ${cliente}\n${descripcionBase}`
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
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
      notifyError(isTraslado ? 'Selecciona la sucursal proveedora.' : 'Selecciona la sucursal destino.')
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
      notifyError('Ingresa el numero de documento.')
      return
    }

    if (!isTraslado) {
      const documentoDisponible = await validateDocumentNumber(formData.no_documento)
      if (!documentoDisponible) {
        notifyError('No se puede usar dos iguales.')
        return
      }
    }

    if (!details.length) {
      notifyError('Agrega al menos un producto.')
      return
    }

    if (details.some((detail) => !detail.productoId || !detail.estadoProductoId)) {
      notifyError('Hay productos con datos incompletos.')
      return
    }

    if (isTraslado) {
      if (!formData.sucursalObjetivoId) {
        notifyError('Selecciona la sucursal proveedora.')
        return
      }

      if (String(formData.sucursalId) === String(formData.sucursalObjetivoId)) {
        notifyError('La sucursal proveedora debe ser diferente a la sucursal solicitante.')
        return
      }

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

      setLoading(true)
      try {
        const payload = {
          no_documento: formData.no_documento.trim(),
          fecha: formData.fecha,
          descripcion: String(formData.descripcion || '').trim(),
          sucursal_solicitante_id: Number(formData.sucursalId),
          sucursal_proveedora_id: Number(formData.sucursalObjetivoId),
          detalles: details.map((detail) => ({
            producto_id: Number(detail.productoId),
            cantidad: Number(detail.cantidad),
            valor: detail.valor,
          })),
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

        const creatorId = normalizeId(currentCreatorId)
        const creatorName = String(currentCreatorName || 'Usuario').trim() || 'Usuario'
        const now = getNowDateParts()
        const createdAt = new Date().toISOString()
        const solicitudId = normalizeId(data?.id)
        const solicitudDoc = String(data?.no_documento || formData.no_documento || '').trim()
        const solicitudLabel = solicitudDoc
          ? `Solicitud de traslado #${solicitudDoc}`
          : `Solicitud de traslado #${solicitudId || 'N/A'}`

        const normalizeRecipientList = (list) =>
          list
            .map((recipient) => sanitizeRecipient(recipient))
            .filter(Boolean)
            .filter(
              (recipient, index, source) =>
                source.findIndex((item) => normalizeId(item?.id) === normalizeId(recipient?.id)) === index
            )

        const adminRecipients = normalizeRecipientList(adminReminderRecipients)
        const additionalRecipients = normalizeRecipientList(selectedReminderRecipients)
        const context = solicitudId
          ? {
            type: 'solicitud_traslado',
            id: solicitudId,
            label: solicitudLabel,
          }
          : null

        const remindersToCreate = []
        if (adminRecipients.length) {
          remindersToCreate.push({
            id: createReminderId(),
            date: now.date,
            time: now.time,
            description: `${solicitudLabel}. Revisar gestion pendiente.`,
            creator: {
              id: creatorId,
              name: creatorName,
            },
            recipients: adminRecipients,
            context,
            kind: 'recordatorio_general',
            createdAt,
            completedBy: [],
          })
        }

        if (additionalRecipients.length) {
          const deadlineAt = new Date()
          deadlineAt.setHours(23, 59, 59, 999)
          remindersToCreate.push({
            id: createReminderId(),
            date: now.date,
            time: now.time,
            description: `${solicitudLabel}. Debes aceptar o rechazar hoy.`,
            creator: {
              id: creatorId,
              name: creatorName,
            },
            recipients: additionalRecipients,
            context,
            kind: 'solicitud_traslado_decision',
            deadlineAt: deadlineAt.toISOString(),
            decision: {
              status: 'pendiente',
              reason: '',
              by: null,
              at: '',
            },
            createdAt,
            completedBy: [],
          })
        }

        if (remindersToCreate.length) {
          try {
            const existingReminders = readRemindersFromStorage()
            writeRemindersToStorage([...remindersToCreate, ...existingReminders])
            emitRemindersSync()
          } catch {
            notifyError('La solicitud se creo, pero no se pudo generar el recordatorio obligatorio.')
          }
        } else {
          notifyError('La solicitud se creo, pero no se pudo generar el recordatorio obligatorio.')
        }

        onCreated?.(data)
      } catch (err) {
        notifyError(err.message || 'Ocurrio un error al crear la solicitud de traslado.')
      } finally {
        setLoading(false)
      }
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
          throw new Error('No se pudo resolver la informacion del cliente para la venta.')
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
        estado_movimiento_id: Number(formData.estadoId),
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

      onCreated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrio un error al crear la entrada.')
    } finally {
      setLoading(false)
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
  const showTabs = isVenta || isTraslado
  const showGeneralTab = !showTabs || activeTab === 'general'

  return (
    <div
      className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`}
      role="dialog"
      aria-modal="true"
      style={overlayStyle}
    >
      <div ref={modalRef} className={modalClassName} style={modalStyle}>
        <header className="create-user__header" onMouseDown={handleModalMouseDown}>
          <div className="create-user__header-text">
            <h3>{isTraslado ? 'Nueva solicitud de traslado' : 'Nueva entrada'}</h3>
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
              onClick={onClose}
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
                    <p className="create-user__eyebrow">Datos</p>
                    <h4>Selecciona tipo de entrada</h4>
                  </div>
                </div>
                <div className="create-salida__selector-inner">
                  <label className="create-user__field create-salida__selector-field">
                    <span>Tipo de entrada</span>
                    <select
                      name="subTipoId"
                      value={formData.subTipoId}
                      onChange={handleChange}
                      disabled={loading}
                      required
                      className={`create-salida__tipo-select${!formData.subTipoId ? ' is-placeholder' : ''}`}
                    >
                      <option value="">Selecciona un tipo</option>
                      {subTiposEntrada.map((subTipo) => (
                        <option key={subTipo.id} value={subTipo.id}>
                          {formatSubTipoLabel(subTipo)}
                        </option>
                      ))}
                    </select>
                  </label>
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
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field">
                      <span>Tipo de entrada</span>
                      <select
                        name="subTipoId"
                        value={formData.subTipoId}
                        onChange={handleChange}
                        disabled={loading}
                        required
                        className={`create-salida__tipo-select${!formData.subTipoId ? ' is-placeholder' : ''}`}
                      >
                        <option value="">Selecciona un tipo</option>
                        {subTiposEntrada.map((subTipo) => (
                          <option key={subTipo.id} value={subTipo.id}>
                            {formatSubTipoLabel(subTipo)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="create-user__field">
                      <span>Fecha</span>
                      <input name="fecha" type="date" value={formData.fecha} readOnly disabled />
                    </label>

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

                    {requiresSucursalObjetivo && (
                      <label className="create-user__field">
                        <span>{isTraslado ? 'Sucursal proveedora' : 'Sucursal Destino'}</span>
                        <select
                          name="sucursalObjetivoId"
                          value={formData.sucursalObjetivoId}
                          onChange={handleChange}
                          disabled={loading}
                          required={requiresSucursalObjetivo}
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

                    <label className="create-user__field">
                      <span>{documentLabel}</span>
                      <input
                        name="no_documento"
                        type="text"
                        value={formData.no_documento}
                        onChange={handleChange}
                        disabled={loading}
                        required
                      />
                      {!isTraslado && documentStatus === DOCUMENT_STATUS.duplicate && (
                        <small className="create-user__field-error">No se puede usar dos iguales.</small>
                      )}
                    </label>

                    {isTraslado && (
                      <label className="create-user__field">
                        <span>Estado de solicitud</span>
                        <input type="text" value="Pendiente" readOnly disabled />
                      </label>
                    )}

                    {!isTraslado && !isEstadoEditable && (
                      <label className="create-user__field">
                        <span>Estado del movimiento</span>
                        <input
                          type="text"
                          value={estadoOptions.find((estado) => String(estado.id) === String(formData.estadoId))?.nombre || ''}
                          readOnly
                          disabled
                        />
                      </label>
                    )}

                    {!isTraslado && isEstadoEditable && (
                      <label className="create-user__field">
                        <span>Estado del movimiento</span>
                        <select name="estadoId" value={formData.estadoId} onChange={handleChange} disabled={loading} required>
                          <option value="">Selecciona un estado</option>
                          {estadoSelectOptions.map((estado) => (
                            <option key={estado.id} value={estado.id}>
                              {estado.nombre}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

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
                          disabled={loading}
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
                            setFormData((prev) => ({ ...prev, funcional: event.target.value === 'true' }))
                          }
                          disabled={loading}
                        >
                          <option value="true">Si</option>
                          <option value="false">No</option>
                        </select>
                      </label>
                    )}

                    <label className="create-user__field create-user__field--full">
                      <span>Descripcion</span>
                      <input
                        name="descripcion"
                        type="text"
                        value={formData.descripcion}
                        onChange={handleChange}
                        disabled={loading}
                      />
                    </label>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Detalle</p>
                      <h4>Listado de productos</h4>
                    </div>
                  </div>

                  <div className="create-user__locations-table create-salida__products-table">
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>Codigo</span>
                      <span>Nombre</span>
                      <span>Cantidad</span>
                      <span>Precio</span>
                      <span>Precio total</span>
                      <span>Acciones</span>
                    </div>

                    <div className="create-user__locations-row create-user__locations-row--form">
                      <span className="create-salida__product-picker">
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
                                setProductDropdownDirection('up')
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
                                : 'Selecciona un producto'}
                            </span>
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
                                  placeholder={
                                    hasProductSourceBranch
                                      ? 'Buscar productos'
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
                                {productOptions.map((producto) => {
                                  const isSelected = String(producto.id) === String(detailDraft.productoId)
                                  const stockEnSucursalProveedora = Number(
                                    stockByProduct[String(producto.id)] ?? 0
                                  )
                                  return (
                                    <button
                                      key={producto.id}
                                      type="button"
                                      className="create-user__result-option"
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={(event) => {
                                        event.preventDefault()
                                        event.stopPropagation()
                                        handleProductSelect(producto)
                                      }}
                                    >
                                      <div className="create-user__result-info">
                                        <strong>{formatProductoOptionLabel(producto)}</strong>
                                        <small>
                                          ID: {producto.id}
                                          {showProveedorStockInfo && (
                                            ` | Stock en ${proveedorBranchName || 'sucursal proveedora'}: ${Math.max(
                                              0,
                                              Math.trunc(stockEnSucursalProveedora)
                                            )}`
                                          )}
                                        </small>
                                      </div>
                                      {isSelected && <span className="create-user__result-tag is-selected">Seleccionado</span>}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      </span>
                      <span>
                        <input
                          className={draftCantidadExceedsProveedorStock ? 'create-salida__input--invalid' : ''}
                          name="cantidad"
                          type="number"
                          min="1"
                          step="1"
                          value={detailDraft.cantidad}
                          onChange={handleDetailChange}
                          disabled={loading}
                          aria-invalid={draftCantidadExceedsProveedorStock ? 'true' : 'false'}
                        />
                      </span>
                      <span>
                        <input
                          name="valor"
                          type="number"
                          step="0.01"
                          min="0"
                          value={detailDraft.valor}
                          readOnly
                          disabled={loading}
                        />
                      </span>
                      <span>
                        <input value={draftLineTotal !== null ? draftLineTotal.toFixed(2) : ''} readOnly disabled />
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

                    {details.map((detail) => (
                      <div key={detail.uid} className="create-user__locations-row">
                        <span>{detail.productoCodigo || '-'}</span>
                        <span>{detail.productoNombre || '-'}</span>
                        <span>{detail.cantidad}</span>
                        <span className="create-salida__numeric">{formatCurrency(detail.valor)}</span>
                        <span className="create-salida__numeric">{formatCurrency(detail.valor_total)}</span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button type="button" className="create-user__locations-remove" onClick={() => handleRemoveDetail(detail.uid)} disabled={loading}>
                            x
                          </button>
                        </span>
                      </div>
                    ))}

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
                              type="text"
                              placeholder="Buscar por cedula o nombre"
                              value={clienteQuery}
                              onChange={handleClienteQueryChange}
                              onFocus={() => setShowClienteDropdown(Boolean(clienteQuery))}
                              disabled={loading}
                              autoComplete="off"
                            />
                            {showClienteDropdown && (
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
                      Al crear la solicitud se genera automaticamente un recordatorio para administradores y usuarios seleccionados.
                    </p>

                    {!selectedProveedorSucursalId && (
                      <small className="muted">Selecciona primero una sucursal proveedora para cargar usuarios.</small>
                    )}

                    <div className={`create-salida__reminder-block create-salida__reminder-block--matrix${selectedProveedorSucursalId && !reminderUsersLoading && !hasAdminReminderRecipients ? ' create-salida__reminder-block--invalid' : ''}`}>
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

                    <div className={`create-salida__reminder-block create-salida__reminder-block--matrix${selectedProveedorSucursalId && !reminderUsersLoading && !hasAdditionalReminderRecipients ? ' create-salida__reminder-block--invalid' : ''}`}>
                      <div className="create-salida__reminder-head">
                        <h5>Usuarios adicionales</h5>
                        <span className="create-salida__reminder-count">{selectedReminderUserIds.length}</span>
                      </div>
                      {selectedProveedorSucursalId && !reminderUsersLoading && !hasAdditionalReminderRecipients && (
                        <small className="create-user__field-error">Debes seleccionar al menos un usuario adicional.</small>
                      )}
                      <div className="create-salida__reminder-table-wrap">
                        <div className="permissions-matrix__table create-salida__reminder-table" role="grid">
                          <div className="permissions-matrix__row permissions-matrix__row--head">
                            <div className="permissions-matrix__cell permissions-matrix__cell--label">Usuario</div>
                            <div className="permissions-matrix__cell permissions-matrix__cell--label">Correo</div>
                            <div className="permissions-matrix__cell permissions-matrix__cell--action">Incluir</div>
                          </div>

                          {!selectedProveedorSucursalId && (
                            <div className="permissions-matrix__row create-salida__reminder-row--empty">
                              <div className="permissions-matrix__cell permissions-matrix__cell--label">
                                Debes seleccionar una sucursal proveedora.
                              </div>
                            </div>
                          )}

                          {selectedProveedorSucursalId && !reminderUsersLoading && !selectableReminderUsers.length && (
                            <div className="permissions-matrix__row create-salida__reminder-row--empty">
                              <div className="permissions-matrix__cell permissions-matrix__cell--label">
                                No hay usuarios disponibles para esta sucursal.
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
                                    disabled={loading || reminderUsersLoading || !selectedProveedorSucursalId}
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
            <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose} disabled={loading}>
              Cancelar
            </button>
            {formData.subTipoId && (
              <button type="submit" className="create-user__action create-user__action--primary" disabled={loading}>
                {loading ? 'Guardando...' : (isTraslado ? 'Crear solicitud de traslado' : 'Crear entrada')}
              </button>
            )}
          </div>
        </form>

        <button
          type="button"
          aria-label="Cambiar tamano de ventana"
          className="create-user__resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      </div>
    </div>
  )
}

export default CreateEntrada
