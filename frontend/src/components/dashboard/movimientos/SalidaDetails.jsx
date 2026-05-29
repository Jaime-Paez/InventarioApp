import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Eye, Pencil } from 'lucide-react'
import '../admin/CreateUsuario/CreateUsuario.css'
import '../admin/UsersDetails/UsersDetails.css'
import './CreateSalida.css'
import { API_URL, authFetch } from '../../../utils/api'
import useModalAnimation from '../common/useModalAnimation'
import EntityRemindersTab from '../common/reminders/EntityRemindersTab'
import { normalizeId } from '../common/reminders/remindersStorage'
import StaticFieldDisplay from './StaticFieldDisplay'

const DEFAULT_IVA_RATE = 0.15
const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

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
}

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeValue = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
const formatSalidaSubTipoLabel = (subTipo) => {
  const nombre = typeof subTipo === 'string' ? subTipo : String(subTipo?.nombre || '').trim()
  return normalizeValue(nombre) === 'devolucion' ? 'Garantia' : nombre
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

const formatDateDisplay = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const [year, month, day] = raw.split('-').map((part) => Number(part))
  if (!year || !month || !day) return raw
  const parsed = new Date(year, month - 1, day)
  if (Number.isNaN(parsed.getTime())) return raw
  return new Intl.DateTimeFormat('es-EC', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(parsed)
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

function SalidaDetails({
  open,
  salidaId,
  token,
  onClose,
  onUpdated,
  onDeleted,
  onError,
  currentUser,
  allowEdit = true,
  allowDelete = true,
}) {
  const [formData, setFormData] = useState(emptyForm)
  const [originalData, setOriginalData] = useState(null)
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteInventoryAction, setDeleteInventoryAction] = useState('reverse')
  const [isEditing, setIsEditing] = useState(false)
  const [formSubmitted, setFormSubmitted] = useState(false)
  const [, setError] = useState('')

  const [branches, setBranches] = useState([])
  const [tipoMovimientos, setTipoMovimientos] = useState([])
  const [subTipos, setSubTipos] = useState([])
  const [estados, setEstados] = useState([])
  const [productos, setProductos] = useState([])
  const [estadosProducto, setEstadosProducto] = useState([])

  const [details, setDetails] = useState([])
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
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })
  const [isMaximized, setIsMaximized] = useState(false)
  const [isResizingModal, setIsResizingModal] = useState(false)
  const modalRef = useRef(null)
  const productDropdownRef = useRef(null)
  const productDropdownTriggerRef = useRef(null)
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

  const salidaTipoId = useMemo(() => {
    const salida = tipoMovimientos.find((tipo) => normalizeValue(tipo?.nombre).startsWith('sal'))
    return salida?.id ?? ''
  }, [tipoMovimientos])

  const subTiposSalida = useMemo(
    () => {
      if (!salidaTipoId) return subTipos
      const filtered = subTipos.filter(
        (sub) => String(sub?.tipo_movimiento?.id || '') === String(salidaTipoId)
      )
      return filtered.length ? filtered : subTipos
    },
    [subTipos, salidaTipoId]
  )

  const selectedSubTipo = useMemo(
    () =>
      subTipos.find((sub) => String(sub.id) === String(formData.subTipoId)) ||
      subTiposSalida.find((sub) => String(sub.id) === String(formData.subTipoId)),
    [formData.subTipoId, subTipos, subTiposSalida]
  )

  const selectedSubTipoName = normalizeValue(selectedSubTipo?.nombre || formData.subTipoNombre)
  const isDevolucion = selectedSubTipoName.includes('devol')
  const isTraslado = selectedSubTipoName.includes('trasl')
  const isVenta = selectedSubTipoName.includes('vent')
  const restrictedEditMode = true
  const lineItemsReadOnly = restrictedEditMode
  const showDetailActions = !lineItemsReadOnly
  const clientDataReadOnly = restrictedEditMode
  const requiresStockValidation = isTraslado || isVenta || isDevolucion
  const requiresSucursalObjetivo = isTraslado
  const documentLabel = isTraslado ? 'No. de Traslado' : isDevolucion ? 'No. Garantía' : 'No. de Factura'
  const selectedSucursalName = branches.find((b) => String(b.id) === String(formData.sucursalId))?.nombre || ''
  const selectedObjetivoName = branches.find((b) => String(b.id) === String(formData.sucursalObjetivoId))?.nombre || ''
  const formattedFecha = formatDateDisplay(formData.fecha)

  const devolucionEstadoOptions = useMemo(
    () => {
      const devuelto = estados.filter((estado) => normalizeValue(estado?.nombre) === 'devuelto')
      if (devuelto.length) return devuelto
      return estados.filter((estado) => normalizeValue(estado?.nombre) === 'recibido')
    },
    [estados]
  )

  const trasladoEstadoOptions = useMemo(() => {
    const allowed = new Set(['enviado', 'recibido', 'parcialmente recibido'])
    return estados.filter((estado) => allowed.has(normalizeValue(estado?.nombre)))
  }, [estados])

  const ventaEstadoOptions = useMemo(() => {
    const vendidos = estados.filter((estado) => normalizeValue(estado?.nombre) === 'vendido')
    if (vendidos.length) return vendidos
    return estados.filter((estado) => normalizeValue(estado?.nombre).includes('vendid'))
  }, [estados])

  const estadoOptions = useMemo(() => {
    if (isDevolucion) return devolucionEstadoOptions
    if (isTraslado) return trasladoEstadoOptions
    if (isVenta) return ventaEstadoOptions
    return []
  }, [devolucionEstadoOptions, isDevolucion, isTraslado, isVenta, trasladoEstadoOptions, ventaEstadoOptions])

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
      const vendido = estadoOptions.find((estado) => normalizeValue(estado?.nombre) === 'vendido')
      if (vendido?.id) return String(vendido.id)
      return String(estadoOptions[0].id)
    }

    return String(estadoOptions[0].id)
  }, [estadoOptions, isDevolucion, isTraslado, isVenta])

  const defaultEstadoProductoId = useMemo(() => {
    if (!estadosProducto.length) return ''
    const preferred = estadosProducto.find((estado) =>
      normalizeValue(estado?.nombre).includes('enviad')
    )
    return String(preferred?.id ?? estadosProducto[0].id)
  }, [estadosProducto])

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
  const isReadOnlyMode = isSentSolicitud

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

  const selectedDraftProduct = useMemo(
    () => productos.find((producto) => String(producto.id) === String(detailDraft.productoId)) || null,
    [detailDraft.productoId, productos]
  )

  const originalQuantityByProduct = useMemo(() => {
    const map = {}
    const sourceDetails = Array.isArray(originalData?.detalles) ? originalData.detalles : []
    sourceDetails.forEach((detail) => {
      const productId = String(detail?.productoId || '').trim()
      if (!productId) return
      const qty = parseIntValue(detail?.cantidad)
      if (!Number.isFinite(qty) || qty <= 0) return
      map[productId] = (map[productId] || 0) + qty
    })
    return map
  }, [originalData])

  const formatProductoOptionLabel = useCallback(
    (producto) => {
      if (!producto) return ''
      const codigo = String(producto?.codigo || '').trim()
      const nombre = String(producto?.nombre || '').trim()
      const baseLabel = [codigo, nombre].filter(Boolean).join(' - ') || `ID: ${producto?.id ?? ''}`
      if (!requiresStockValidation) return baseLabel
      const available = Number(stockByProduct[String(producto?.id)] ?? 0)
      return `${baseLabel} (Disp: ${Number.isFinite(available) ? available : 0})`
    },
    [requiresStockValidation, stockByProduct]
  )

  const searchProducts = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token || (requiresStockValidation && !formData.sucursalId)) {
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
        let list = parseApiList(payload)
        if (requiresStockValidation) {
          list = list.filter((producto) => {
            const productId = String(producto?.id || '').trim()
            if (!productId) return false
            const available = Number(stockByProduct[productId] ?? 0)
            const originalQty = Number(originalQuantityByProduct[productId] ?? 0)
            return available + originalQty > 0
          })
        }
        list.sort((a, b) => {
          const qa = Number(stockByProduct[String(a.id)] ?? 0) + Number(originalQuantityByProduct[String(a.id)] ?? 0)
          const qb = Number(stockByProduct[String(b.id)] ?? 0) + Number(originalQuantityByProduct[String(b.id)] ?? 0)
          return (qb > 0 ? 1 : 0) - (qa > 0 ? 1 : 0)
        })

        setProductOptions(list)
      } catch {
        setProductOptions([])
      } finally {
        setProductLoading(false)
      }
    },
    [formData.sucursalId, originalQuantityByProduct, requiresStockValidation, stockByProduct, token]
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
    if (!open || !formData.subTipoId || !defaultEstadoMovimientoId) return
    setFormData((prev) => {
      const currentStateValid = estadoOptions.some((estado) => String(estado.id) === String(prev.estadoId))
      if (prev.estadoId && currentStateValid) return prev
      return { ...prev, estadoId: defaultEstadoMovimientoId }
    })
  }, [defaultEstadoMovimientoId, estadoOptions, formData.subTipoId, open])

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
      if (!next.funcional) {
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
      linkedSolicitud?.sucursal_proveedora_id ??
      findByName(branchesList, salida?.sucursal || salida?.sucursal_proveedora)?.id ??
      ''
    const sucursalObjetivoId =
      salida?.sucursal_objetivo_id ??
      linkedSolicitud?.sucursal_solicitante_id ??
      findByName(
        branchesList,
        salida?.sucursal_objetivo || salida?.sucursal_solicitante || salida?.destino
      )?.id ??
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

    const detalles = (Array.isArray(salida?.detalles) ? salida.detalles : []).map((detalle) => {
      const productLabel = String(detalle?.producto ?? '').trim()
      const code = parseProductCode(productLabel)
      const product =
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

      return {
        uid: `det-${Math.random().toString(36).slice(2, 8)}`,
        productoId: product?.id ? String(product.id) : '',
        productoCodigo: product?.codigo ?? code ?? '',
        productoNombre: product?.nombre ?? stripCodeFromProductLabel(productLabel, code) ?? productLabel,
        estadoProductoId: estadoProducto?.id ? String(estadoProducto.id) : '',
        estadoProductoNombre: estadoProducto?.nombre ?? detalle?.estado_producto ?? '',
        cantidad: Number.isFinite(cantidad) ? cantidad : 0,
        valor: Number.isFinite(valor) ? valor : 0,
        valor_total,
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
      },
      clienteForm,
      detalles,
    }
  }, [])

  const loadData = useCallback(async () => {
    if (!token || !salidaId) return
    setLoadingData(true)
    setError('')
    try {
      const [
        branchesRes,
        tiposRes,
        subTiposRes,
        estadosRes,
        productosRes,
        estadosProductoRes,
        salidaRes,
      ] = await Promise.all([
        authFetch(`${API_URL}/inventario/sucursales/?modulo=movimientos_salidas`, {}, token),
        authFetch(`${API_URL}/tipos/tipos-movimiento/`, {}, token),
        authFetch(`${API_URL}/tipos/subtipos-movimiento/`, {}, token),
        authFetch(`${API_URL}/tipos/estados-movimiento/`, {}, token),
        authFetch(`${API_URL}/productos/listado/`, {}, token),
        authFetch(`${API_URL}/tipos/estados-producto/`, {}, token),
        authFetch(`${API_URL}/movimientos/movimiento_inventario/${salidaId}/`, {}, token),
      ])

      if (!branchesRes.ok) throw new Error('No se pudieron cargar las sucursales.')
      if (!tiposRes.ok) throw new Error('No se pudieron cargar los tipos de movimiento.')
      if (!subTiposRes.ok) throw new Error('No se pudieron cargar los tipos de salida.')
      if (!estadosRes.ok) throw new Error('No se pudieron cargar los estados de movimiento.')
      if (!productosRes.ok) throw new Error('No se pudieron cargar los productos.')
      if (!estadosProductoRes.ok) throw new Error('No se pudieron cargar los estados de producto.')
      if (!salidaRes.ok) throw new Error('No se pudo cargar la salida.')

      const [
        branchesData,
        tiposData,
        subTiposData,
        estadosData,
        productosData,
        estadosProductoData,
        salidaData,
      ] = await Promise.all([
        branchesRes.json(),
        tiposRes.json(),
        subTiposRes.json(),
        estadosRes.json(),
        productosRes.json(),
        estadosProductoRes.json(),
        salidaRes.json(),
      ]) 

      const branchesList = parseApiList(branchesData)
      const tiposList = parseApiList(tiposData)
      const subTiposList = parseApiList(subTiposData)
      const estadosList = parseApiList(estadosData)
      const productosList = parseApiList(productosData)
      const estadosProductoList = parseApiList(estadosProductoData)
      const linkedSolicitud = salidaData?.solicitud_traslado || null
      const resolvedBranches = [...branchesList]
      const existingBranchIds = new Set(
        resolvedBranches.map((branch) => String(branch?.id || '').trim()).filter(Boolean)
      )
      const appendBranchIfMissing = (branchIdRaw, branchNameRaw) => {
        const branchId = String(branchIdRaw || '').trim()
        if (!branchId || existingBranchIds.has(branchId)) return
        resolvedBranches.push({
          id: branchId,
          nombre: String(branchNameRaw || '').trim() || `Sucursal ${branchId}`,
        })
        existingBranchIds.add(branchId)
      }
      appendBranchIfMissing(
        linkedSolicitud?.sucursal_proveedora_id,
        salidaData?.sucursal || salidaData?.sucursal_proveedora
      )
      appendBranchIfMissing(
        linkedSolicitud?.sucursal_solicitante_id,
        salidaData?.sucursal_objetivo || salidaData?.sucursal_solicitante || salidaData?.destino
      )

      setBranches(resolvedBranches)
      setTipoMovimientos(tiposList)
      setSubTipos(subTiposList)
      setEstados(estadosList)
      setProductos(productosList)
      setEstadosProducto(estadosProductoList)
      setTransferSolicitudId(String(linkedSolicitud?.id || '').trim())
      const normalized = buildFormData(salidaData, {
        branchesList: resolvedBranches,
        subTiposList,
        estadosList,
        productosList,
        estadosProductoList,
      })

      setFormData(normalized.form)
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
      setShowDeleteConfirm(false)
      setDeleteInventoryAction('reverse')
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al cargar la salida.')
    } finally {
      setLoadingData(false)
    }
  }, [buildFormData, notifyError, salidaId, token])

  const fetchStockByBranch = useCallback(
    async (sucursalId) => {
      if (!token || !sucursalId) {
        setStockByProduct({})
        return
      }
      setStockLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/movimientos/movimiento_inventario/stock-sucursal/?sucursal_id=${encodeURIComponent(sucursalId)}`,
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
    setIsEditing(false)
    setFormSubmitted(false)
    setShowDeleteConfirm(false)
    setDeleteInventoryAction('reverse')
    setIsMaximized(false)
    setIsResizingModal(false)
    modalRestoreRef.current = null
    setError('')
    loadData()
  }, [open, loadData])

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
    if (!isReadOnlyMode || !isEditing) return
    setIsEditing(false)
  }, [isEditing, isReadOnlyMode])

  useEffect(() => {
    if (allowEdit || !isEditing) return
    setIsEditing(false)
    setShowDeleteConfirm(false)
  }, [allowEdit, isEditing])

  useEffect(() => {
    if (isEditing) return
    setShowDeleteConfirm(false)
  }, [isEditing])

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
    if (!open || !requiresStockValidation || !formData.sucursalId) {
      setStockByProduct({})
      return
    }
    fetchStockByBranch(formData.sucursalId)
  }, [fetchStockByBranch, formData.sucursalId, open, requiresStockValidation])

  useLayoutEffect(() => {
    if (!open || isMaximized) return
    const { availableWidth, availableHeight, minWidth, minHeight } = getViewportMetrics()
    const width = Math.min(Math.max(MIN_WIDTH, minWidth), availableWidth)
    const height = Math.min(Math.max(MIN_HEIGHT, minHeight), availableHeight)
    setModalSize({ width, height })
    setModalPosition({
      x: Math.max((window.innerWidth - width) / 2, VIEWPORT_PADDING),
      y: Math.max((window.innerHeight - height) / 2, VIEWPORT_PADDING),
    })
  }, [getViewportMetrics, isMaximized, open])

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
    if (name !== 'descripcion' && name !== 'factura_referencia') return
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  const handleClienteQueryChange = (event) => {
    if (!isEditing || clientDataReadOnly) return
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
    if (!isEditing || clientDataReadOnly) return
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
    if (!isEditing || clientDataReadOnly) return
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
    if (name !== 'cantidad') return
    setDetailError('')
    setDetailDraft((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleProductSelect = (producto) => {
    if (!isEditing || lineItemsReadOnly || !producto?.id) return
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
    if (!isEditing || lineItemsReadOnly) return
    setDetailError('')
    const productoId = String(detailDraft.productoId || '').trim()
    const cantidad = parseIntValue(detailDraft.cantidad)
    const estadoProductoId = String(defaultEstadoProductoId || '').trim()
    const producto = productos.find((item) => String(item.id) === productoId)
    const valor = parseNumber(resolveProductPrice(producto))

    if (requiresStockValidation && !formData.sucursalId) {
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
      const availableNow = Number(stockByProduct[productoId] ?? 0)
      const originalQty = Number(originalQuantityByProduct[productoId] ?? 0)
      const maxAllowed = Math.max(availableNow + originalQty, 0)
      const alreadyUsed = details.reduce((acc, detail) => {
        if (String(detail.productoId) !== productoId) return acc
        const qty = parseIntValue(detail.cantidad)
        return acc + (Number.isFinite(qty) ? qty : 0)
      }, 0)
      const remaining = Math.max(maxAllowed - alreadyUsed, 0)
      if (cantidad > remaining) {
        setDetailError(`Cantidad excede disponible en sucursal seleccionada. Disponible: ${remaining}.`)
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

  const handleRemoveDetail = (uid) => {
    if (!isEditing || lineItemsReadOnly) return
    setDetails((prev) => prev.filter((detail) => detail.uid !== uid))
  }

  const handleCancelEdit = () => {
    setFormSubmitted(false)
    if (!originalData) {
      setIsEditing(false)
      setShowDeleteConfirm(false)
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
    setDeleteInventoryAction('reverse')
    setIsEditing(false)
  }

  const buildDescripcion = (clienteLabel = '') => {
    const descripcionBase = String(formData.descripcion || '').trim()
    if (!isVenta) return descripcionBase
    const cliente = String(clienteLabel || '').trim()
    if (!cliente) return descripcionBase
    if (!descripcionBase) return `Cliente: ${cliente}`
    return `Cliente: ${cliente}\n${descripcionBase}`
  }

  const handleSave = async () => {
    if (!allowEdit) return
    if (!isEditing || saving) return
    setFormSubmitted(true)
    setError('')

    const sourceForm = originalData?.form ? { ...originalData.form } : { ...formData }
    const sourceDetails = Array.isArray(originalData?.detalles)
      ? originalData.detalles.map((detail) => ({ ...detail }))
      : details.map((detail) => ({ ...detail }))

    if (!salidaTipoId) {
      notifyError('No se encontro el tipo de movimiento de salida.')
      return
    }

    if (!sourceForm.subTipoId) {
      notifyError('Selecciona el tipo de salida.')
      return
    }

    if (!sourceForm.sucursalId) {
      notifyError('Selecciona la sucursal.')
      return
    }

    if (requiresSucursalObjetivo && !sourceForm.sucursalObjetivoId) {
      notifyError('Selecciona la sucursal destino.')
      return
    }

    if (!sourceForm.estadoId) {
      notifyError('Selecciona el estado del movimiento.')
      return
    }

    if (!sourceForm.fecha) {
      notifyError('No se pudo resolver la fecha del movimiento.')
      return
    }

    if (!String(sourceForm.no_documento || '').trim()) {
      notifyError('Ingresa el numero de documento.')
      return
    }

    if ((isVenta || isDevolucion) && !String(formData.factura_referencia || '').trim()) {
      notifyError('El No. de Factura es obligatorio.')
      return
    }

    if (isDevolucion && !String(formData.descripcion || '').trim()) {
      notifyError('La Descripción es obligatoria para solicitudes de garantía.')
      return
    }

    let ventaClienteLabel = String(sourceForm.cliente || '').trim()
    if (isVenta) {
      if (!ventaClienteLabel) {
        notifyError('Ingresa los datos del cliente para la venta.')
        return
      }
    }

    if (!sourceDetails.length) {
      notifyError('Agrega al menos un producto.')
      return
    }

    const detailsHaveRequiredData = sourceDetails.every((detail) => {
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

    const descuentoIngresado = isVenta ? parseNumber(sourceForm.descuento) : 0
    if (
      isVenta &&
      descuentoIngresado !== null &&
      (!Number.isFinite(descuentoIngresado) || descuentoIngresado < 0 || descuentoIngresado > 100)
    ) {
      notifyError('El descuento debe ser un porcentaje entre 0 y 100.')
      return
    }

    const descuento = isVenta ? Math.max(descuentoIngresado ?? 0, 0) : 0
    const ivaRate = parseNumber(sourceForm.iva_rate)

    const payload = {
      sucursal_id: Number(sourceForm.sucursalId),
      tipo_movimiento_id: Number(salidaTipoId),
      sub_tipo_movimiento_id: Number(sourceForm.subTipoId),
      descripcion: buildDescripcion(ventaClienteLabel),
      funcional: true,
      factura_referencia: isVenta || isDevolucion ? String(formData.factura_referencia || '').trim() : '',
      sucursal_objetivo_id: requiresSucursalObjetivo ? Number(sourceForm.sucursalObjetivoId) : null,
      estado_movimiento_id: Number(sourceForm.estadoId),
      descuento,
      fecha: sourceForm.fecha,
      no_documento: String(sourceForm.no_documento || '').trim(),
      detalles: sourceDetails.map((detail) => {
        const cantidad = parseIntValue(detail.cantidad) || 0
        const valor = parseNumber(detail.valor) || 0
        const valorTotal = parseNumber(detail.valor_total)
        return {
          producto_id: Number(detail.productoId),
          cantidad,
          estado_producto_id: Number(detail.estadoProductoId || defaultEstadoProductoId),
          valor,
          valor_total: Number.isFinite(valorTotal) ? valorTotal : cantidad * valor,
        }
      }),
    }

    if (ivaRate !== null) {
      payload.iva_rate = ivaRate
    }

    setSaving(true)
    try {
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/${salidaId}/`,
        {
          method: 'PUT',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || 'No se pudo actualizar la salida.'
        throw new Error(detail)
      }

      const updatedForm = {
        ...sourceForm,
        descripcion: String(formData.descripcion || ''),
        factura_referencia: String(formData.factura_referencia || ''),
        funcional: true,
        cliente: ventaClienteLabel,
      }
      setFormData(updatedForm)
      const nextOriginal = {
        form: { ...updatedForm },
        clienteForm: { ...(originalData?.clienteForm || clienteForm) },
        detalles: sourceDetails.map((detail) => ({ ...detail })),
      }
      setOriginalData(nextOriginal)
      setClienteQuery(String(updatedForm.cliente || ''))
      setShowClienteDropdown(false)
      setClienteOptions([])
      setClienteLoading(false)
      setIsEditing(false)
      onUpdated?.(data)
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al actualizar la salida.')
    } finally {
      setSaving(false)
    }
  }

  const handleRequestDelete = () => {
    if (!allowDelete) return
    if (!isEditing || deleteLoading) return
    setShowDeleteConfirm(true)
  }

  const closeDeleteConfirm = () => {
    if (deleteLoading) return
    setShowDeleteConfirm(false)
  }

  const handleDelete = async () => {
    if (!showDeleteConfirm) return
    if (!allowDelete) return
    if (!isEditing || deleteLoading) return
    setDeleteLoading(true)

    try {
      const actionParam = deleteInventoryAction === 'keep' ? 'keep' : 'reverse'
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/${salidaId}/?inventory_action=${encodeURIComponent(
          actionParam
        )}`,
        { method: 'DELETE' },
        token
      )

      if (!response.ok && response.status !== 204) {
        const data = await response.json().catch(() => ({}))
        const detail = data?.detail || 'No se pudo eliminar la salida.'
        throw new Error(detail)
      }

      setShowDeleteConfirm(false)
      onDeleted?.(salidaId)
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al eliminar la salida.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const { shouldRender, isClosing } = useModalAnimation(open)

  if (!shouldRender) return null

  const editorDisabled = !isEditing || saving || loadingData || isReadOnlyMode
  const immutableFieldDisabled = editorDisabled || restrictedEditMode

  const overlayStyle = { padding: `${VIEWPORT_PADDING}px` }
  const modalStyle = {
    top: modalPosition.y,
    left: modalPosition.x,
    width: modalSize.width,
    height: modalSize.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
  }
  const isSentTransferRibbon = isSentSolicitud
  const modalClassName = [
    'create-user__modal',
    'create-salida__modal',
    isSentTransferRibbon ? 'entrada-details__modal--pending' : '',
    isClosing ? 'create-user__modal--closing' : '',
    isResizingModal ? 'create-salida__modal--resizing' : '',
    formSubmitted ? 'create-user__modal--submitted' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const headerTipo = formatSalidaSubTipoLabel(selectedSubTipo?.nombre || formData.subTipoNombre || 'Tipo de salida')
  const headerDocumento = String(formData.no_documento || '').trim() || 'No. de salida'
  const modalTitle = `${headerTipo}: ${headerDocumento}`

  return (
    <div
      className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`}
      role="dialog"
      aria-modal="true"
      style={overlayStyle}
    >
      <div ref={modalRef} className={modalClassName} style={modalStyle}>
        {isSentTransferRibbon && (
          <div
            className="entrada-details__pending-ribbon entrada-details__pending-ribbon--sent"
            aria-label="Solicitud enviada"
            title="Solicitud enviada"
          >
            <span className="entrada-details__pending-ribbon-label">{'Solicitud\nenviada'}</span>
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
              onClick={onClose}
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
          <div className="create-user__tabs" role="tablist" aria-label="Secciones de salida">
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
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'recordatorios' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('recordatorios')}
            >
              Recordatorios
            </button>
          </div>
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
                  </div>

                  <div className="create-salida__field-groups">
                    <div className="create-salida__field-group create-salida__field-group--defined">
                      <div className="create-user__grid create-user__grid--two">
                        <StaticFieldDisplay
                          label="Tipo de salida"
                          value={formatSalidaSubTipoLabel(selectedSubTipo?.nombre || formData.subTipoNombre || '')}
                        />

                        <StaticFieldDisplay label="Fecha" value={formattedFecha} />

                        <StaticFieldDisplay
                          label={isTraslado ? 'Sucursal proveedora' : 'Sucursal'}
                          value={selectedSucursalName}
                        />

                        {requiresSucursalObjetivo && (
                          <StaticFieldDisplay
                            label={isTraslado ? 'Sucursal solicitante (destino)' : 'Sucursal Destino'}
                            value={selectedObjetivoName}
                          />
                        )}

                        <StaticFieldDisplay label={documentLabel} value={formData.no_documento} />

                        <StaticFieldDisplay label="Estado del movimiento" value={selectedEstadoName} />
                      </div>
                    </div>

                    <div className="create-user__grid create-user__grid--two">
                      {isVenta && (
                        <StaticFieldDisplay label="Descuento (%)" value={formData.descuento} />
                      )}

                      {(isVenta || isDevolucion) && (
                        <label className="create-user__field create-user__field--full">
                          <span>No. de Factura</span>
                          <input
                            name="factura_referencia"
                            type="text"
                            value={formData.factura_referencia}
                            onChange={handleChange}
                            disabled={editorDisabled}
                            required={isVenta || isDevolucion}
                          />
                        </label>
                      )}

                      <label className={`create-user__field create-user__field--full${isDevolucion ? ' create-user__field--required' : ''}`}>
                        <span>Descripción</span>
                        <textarea
                          name="descripcion"
                          value={formData.descripcion}
                          onChange={handleChange}
                          disabled={editorDisabled}
                          rows={3}
                          required={isDevolucion}
                        />
                      </label>
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

                  <div className={`create-user__locations-table create-salida__products-table${showDetailActions ? ' create-salida__products-table--with-actions' : ''}`}>
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>Codigo</span>
                      <span>Nombre</span>
                      <span>Cantidad</span>
                      <span>Precio</span>
                      <span>Precio total</span>
                      {showDetailActions && <span>Acciones</span>}
                    </div>

                    {!lineItemsReadOnly && (
                    <div className="create-user__locations-row create-user__locations-row--form">
                      <span className="create-salida__product-picker">
                        <div className="create-user__dropdown create-salida__product-dropdown" ref={productDropdownRef}>
                          <button
                            type="button"
                            className="create-user__dropdown-trigger"
                            ref={productDropdownTriggerRef}
                            disabled={
                              editorDisabled ||
                              (requiresStockValidation && (!formData.sucursalId || stockLoading))
                            }
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
                                    requiresStockValidation
                                      ? 'Buscar en sucursal'
                                      : 'Buscar productos'
                                  }
                                  value={productQuery}
                                  onChange={(event) => setProductQuery(event.target.value)}
                                  autoFocus
                                  disabled={requiresStockValidation && stockLoading}
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
                                {!productLoading && !productQuery.trim() && <small className="muted">Escribe para buscar.</small>}
                                {!productLoading && productQuery.trim() && !productOptions.length && (
                                  <small className="muted">Sin resultados.</small>
                                )}
                                {productOptions.map((producto) => {
                                  const isSelected = String(producto.id) === String(detailDraft.productoId)
                                  const available = Number(stockByProduct[String(producto.id)] ?? 0)
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
                                          {requiresStockValidation
                                            ? `Disponible: ${available}`
                                            : `ID: ${producto.id}`}
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
                          name="cantidad"
                          type="number"
                          min="1"
                          step="1"
                          value={detailDraft.cantidad}
                          onChange={handleDetailChange}
                          disabled={editorDisabled || (requiresStockValidation && stockLoading)}
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
                          disabled={editorDisabled || (requiresStockValidation && stockLoading)}
                        />
                      </span>
                      <span>
                        <input value={draftLineTotal !== null ? draftLineTotal.toFixed(2) : ''} readOnly disabled />
                      </span>
                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={handleAddDetail}
                          disabled={editorDisabled || (requiresStockValidation && stockLoading)}
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
                        <span title={detail.productoNombre || undefined}>
                          <span className="create-salida__product-name-text">{detail.productoNombre || '-'}</span>
                        </span>
                        <span>{detail.cantidad}</span>
                        <span className="create-salida__numeric">{formatCurrency(detail.valor)}</span>
                        <span className="create-salida__numeric">{formatCurrency(detail.valor_total)}</span>
                        {showDetailActions && (
                          <span className="create-user__locations-cell create-user__locations-cell--action">
                            <button type="button" className="create-user__locations-remove" onClick={() => handleRemoveDetail(detail.uid)} disabled={editorDisabled}>
                              x
                            </button>
                          </span>
                        )}
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
                      <label className="create-user__field create-user__field--full">
                        <span>Cliente</span>
                        <div className="create-user__dropdown" ref={clienteDropdownRef}>
                          <input
                            type="text"
                            placeholder="Buscar por cedula o nombre"
                            value={clienteQuery}
                            onChange={handleClienteQueryChange}
                            onFocus={() => isEditing && !clientDataReadOnly && setShowClienteDropdown(Boolean(clienteQuery))}
                            disabled={editorDisabled || clientDataReadOnly}
                            autoComplete="off"
                          />
                          {showClienteDropdown && isEditing && !clientDataReadOnly && (
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
                          disabled={editorDisabled || clientDataReadOnly}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Nombres</span>
                        <input
                          name="nombres"
                          type="text"
                          value={clienteForm.nombres}
                          onChange={handleClienteFieldChange}
                          disabled={editorDisabled || clientDataReadOnly}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Apellidos</span>
                        <input
                          name="apellidos"
                          type="text"
                          value={clienteForm.apellidos}
                          onChange={handleClienteFieldChange}
                          disabled={editorDisabled || clientDataReadOnly}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Correo</span>
                        <input
                          name="correo"
                          type="email"
                          value={clienteForm.correo}
                          onChange={handleClienteFieldChange}
                          disabled={editorDisabled || clientDataReadOnly}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Telefono</span>
                        <input
                          name="telefono"
                          type="text"
                          value={clienteForm.telefono}
                          onChange={handleClienteFieldChange}
                          disabled={editorDisabled || clientDataReadOnly}
                        />
                      </label>

                      <label className="create-user__field create-user__field--full">
                        <span>Direccion</span>
                        <input
                          name="direccion"
                          type="text"
                          value={clienteForm.direccion}
                          onChange={handleClienteFieldChange}
                          disabled={editorDisabled || clientDataReadOnly}
                        />
                      </label>
                    </div>

                    {selectedCliente?.id && (
                      <small className="muted">Cliente existente detectado. Se usara el registro actual al guardar.</small>
                    )}
                  </section>
                )}

                {activeTab === 'recordatorios' && (
                  <EntityRemindersTab
                    token={token}
                    currentUser={currentUser}
                    entityType="salida"
                    entityId={salidaId}
                    isOpen={open}
                    entityLabel={modalTitle}
                    canCreateReminder={allowEdit && isEditing}
                    transferSolicitudId={transferSolicitudId}
                    onError={notifyError}
                  />
                )}
              </div>
            </div>

          <div className="create-user__footer">
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={isEditing ? handleCancelEdit : onClose}
                disabled={saving || loadingData}
              >
                Cancelar
              </button>
              {allowEdit && !isReadOnlyMode && (
                <button
                  type="button"
                  className={`create-user__action create-user__action--edit user-details__edit-toggle${isEditing ? ' user-details__edit-toggle--active' : ''}`}
                  onClick={() => setIsEditing((prev) => !prev)}
                  disabled={loadingData || saving || deleteLoading}
                >
                  <span className="user-details__toggle-icon" aria-hidden="true">
                    {isEditing ? <Eye size={14} /> : <Pencil size={14} />}
                  </span>
                  <span>{isEditing ? 'Solo lectura' : 'Editar'}</span>
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {isEditing && (
                <>
                  {allowDelete && (
                    <button
                      type="button"
                      className="create-user__action user-details__delete"
                      onClick={handleRequestDelete}
                      disabled={deleteLoading || saving}
                    >
                      {deleteLoading ? 'Eliminando...' : 'Eliminar'}
                    </button>
                  )}
                  {allowEdit && (
                    <button
                      type="button"
                      className="create-user__action create-user__action--primary"
                      onClick={handleSave}
                      disabled={saving || loadingData}
                    >
                      {saving ? 'Guardando...' : 'Guardar cambios'}
                    </button>
                  )}
                </>
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
              <h4>Eliminar salida</h4>
              <p>
                Se eliminara la salida <strong>{String(formData.no_documento || '').trim() || `#${salidaId}`}</strong>.
              </p>
              <p className="create-salida__confirm-warning">
                Elige como quieres manejar el inventario asociado a esta salida.
              </p>
              <fieldset className="entrada-details__delete-confirm-options">
                <label className="entrada-details__delete-confirm-option">
                  <input
                    type="radio"
                    name="salida-delete-inventory-action"
                    value="keep"
                    checked={deleteInventoryAction === 'keep'}
                    onChange={() => setDeleteInventoryAction('keep')}
                    disabled={deleteLoading}
                  />
                  <span>
                    <strong>Mantener inventario actual</strong>
                    <small>Elimina el documento sin sumar cantidades al inventario.</small>
                  </span>
                </label>
                <label className="entrada-details__delete-confirm-option">
                  <input
                    type="radio"
                    name="salida-delete-inventory-action"
                    value="reverse"
                    checked={deleteInventoryAction === 'reverse'}
                    onChange={() => setDeleteInventoryAction('reverse')}
                    disabled={deleteLoading}
                  />
                  <span>
                    <strong>Sumar cantidades de vuelta</strong>
                    <small>Revierte el impacto de esta salida y devuelve cantidades al inventario.</small>
                  </span>
                </label>
              </fieldset>
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
                  {deleteLoading ? 'Eliminando...' : 'Eliminar salida'}
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
    </div>
  )
}

export default SalidaDetails

