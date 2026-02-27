import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import '../admin/CreateUsuario/CreateUsuario.css'
import './CreateSalida.css'
import { API_URL, authFetch } from '../../../utils/api'

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

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeValue = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()

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

const resolveProductPrice = (producto) => {
  const parsed = parseNumber(producto?.precio)
  if (parsed === null || parsed < 0) return ''
  const raw = String(producto?.precio ?? '').trim()
  return raw || parsed.toFixed(2)
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

function SalidaDetails({ open, salidaId, token, onClose, onUpdated, onDeleted, onError }) {
  const [formData, setFormData] = useState(emptyForm)
  const [originalData, setOriginalData] = useState(null)
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [error, setError] = useState('')

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
  const [stockByProduct, setStockByProduct] = useState({})
  const [stockLoading, setStockLoading] = useState(false)
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })
  const [isMaximized, setIsMaximized] = useState(false)
  const [isResizingModal, setIsResizingModal] = useState(false)
  const modalRef = useRef(null)
  const productDropdownRef = useRef(null)
  const productDropdownTriggerRef = useRef(null)
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
  const requiresSucursalObjetivo = isTraslado
  const documentLabel = isTraslado ? 'No. de Traslado' : 'No. de Factura'

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
      const preferredOrder = ['proformado', 'facturado', 'vendido']
      for (const key of preferredOrder) {
        const matched = estadoOptions.find((estado) => normalizeValue(estado?.nombre) === key)
        if (matched?.id) return String(matched.id)
      }
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

  const descuentoAplicado = useMemo(() => {
    if (!isVenta) return 0
    const parsed = parseNumber(formData.descuento)
    if (!Number.isFinite(parsed) || parsed < 0) return 0
    return parsed
  }, [formData.descuento, isVenta])

  const subtotalNeto = Math.max(subtotalConBorrador - descuentoAplicado, 0)
  const totalConIva = subtotalNeto * (1 + ivaRateValue)
  const ivaPercent = (ivaRateValue * 100).toFixed(2).replace(/\.00$/, '')

  const selectedDraftProduct = useMemo(
    () => productos.find((producto) => String(producto.id) === String(detailDraft.productoId)) || null,
    [detailDraft.productoId, productos]
  )

  const formatProductoOptionLabel = useCallback(
    (producto) => {
      if (!producto) return ''
      const codigo = String(producto?.codigo || '').trim()
      const nombre = String(producto?.nombre || '').trim()
      const baseLabel = [codigo, nombre].filter(Boolean).join(' - ') || `ID: ${producto?.id ?? ''}`
      if (!isTraslado) return baseLabel
      const available = Number(stockByProduct[String(producto?.id)] ?? 0)
      return `${baseLabel} (Disp: ${Number.isFinite(available) ? available : 0})`
    },
    [isTraslado, stockByProduct]
  )

  const searchProducts = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token || (isTraslado && !formData.sucursalId)) {
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
        let list = parseApiList(payload)
        if (isTraslado) {
          list = list.filter((producto) => Number(stockByProduct[String(producto?.id)] ?? 0) > 0)
        }

        setProductOptions(list)
      } catch {
        setProductOptions([])
      } finally {
        setProductLoading(false)
      }
    },
    [formData.sucursalId, isTraslado, stockByProduct, token]
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

  const buildFormData = useCallback((salida, catalogs) => {
    const {
      branchesList,
      subTiposList,
      estadosList,
      productosList,
      estadosProductoList,
    } = catalogs

    const sucursalId = salida?.sucursal_id ?? findByName(branchesList, salida?.sucursal)?.id ?? ''
    const sucursalObjetivoId =
      salida?.sucursal_objetivo_id ?? findByName(branchesList, salida?.sucursal_objetivo)?.id ?? ''
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
        descripcion,
        funcional: Boolean(salida?.funcional),
        sucursalObjetivoId: sucursalObjetivoId ? String(sucursalObjetivoId) : '',
        cliente,
        descuento: salida?.descuento ?? '',
        iva_rate: String(salida?.iva_rate ?? DEFAULT_IVA_RATE),
      },
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

      setBranches(branchesList)
      setTipoMovimientos(tiposList)
      setSubTipos(subTiposList)
      setEstados(estadosList)
      setProductos(productosList)
      setEstadosProducto(estadosProductoList)

      const normalized = buildFormData(salidaData, {
        branchesList,
        subTiposList,
        estadosList,
        productosList,
        estadosProductoList,
      })

      setFormData(normalized.form)
      setDetails(normalized.detalles)
      setOriginalData(normalized)
      setDetailDraft(initialDetail)
      setDetailError('')
      setIsEditing(false)
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
    setStockByProduct({})
    setOriginalData(null)
    setIsEditing(false)
    setIsMaximized(false)
    setIsResizingModal(false)
    modalRestoreRef.current = null
    setError('')
    loadData()
  }, [open, loadData])

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
    if (!open || !showProductDropdown) return undefined
    const handleClick = (event) => {
      if (productDropdownRef.current && !productDropdownRef.current.contains(event.target)) {
        setShowProductDropdown(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [open, showProductDropdown])

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
    if (!open || !isTraslado || !formData.sucursalId) {
      setStockByProduct({})
      return
    }
    fetchStockByBranch(formData.sucursalId)
  }, [fetchStockByBranch, formData.sucursalId, isTraslado, open])

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
    if (isMaximized || !modalRef.current) return
    const target = event?.target
    if (target?.closest?.('.create-user__icon-button') || target?.closest?.('.create-user__resize-handle')) {
      return
    }
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
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  const handleDetailChange = (event) => {
    if (!isEditing) return
    const { name, value } = event.target
    if (name !== 'cantidad') return
    setDetailError('')
    setDetailDraft((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleProductSelect = (producto) => {
    if (!isEditing || !producto?.id) return
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
    if (!isEditing) return
    setDetailError('')
    const productoId = String(detailDraft.productoId || '').trim()
    const cantidad = parseIntValue(detailDraft.cantidad)
    const estadoProductoId = String(defaultEstadoProductoId || '').trim()
    const producto = productos.find((item) => String(item.id) === productoId)
    const valor = parseNumber(resolveProductPrice(producto))

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
    if (isTraslado) {
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
    if (!isEditing) return
    setDetails((prev) => prev.filter((detail) => detail.uid !== uid))
  }

  const handleCancelEdit = () => {
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
    setError('')
    setIsEditing(false)
  }

  const buildDescripcion = () => {
    const descripcionBase = String(formData.descripcion || '').trim()
    if (!isVenta) return descripcionBase
    const cliente = String(formData.cliente || '').trim()
    if (!cliente) return descripcionBase
    if (!descripcionBase) return `Cliente: ${cliente}`
    return `Cliente: ${cliente}\n${descripcionBase}`
  }

  const handleSave = async () => {
    if (!isEditing || saving) return
    setError('')

    if (!salidaTipoId) {
      notifyError('No se encontro el tipo de movimiento de salida.')
      return
    }

    if (!formData.subTipoId) {
      notifyError('Selecciona el tipo de salida.')
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

    if (!formData.estadoId) {
      notifyError('Selecciona el estado del movimiento.')
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

    if (isVenta && !String(formData.cliente || '').trim()) {
      notifyError('Ingresa el cliente para la venta.')
      return
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

    const descuento = isVenta ? parseNumber(formData.descuento) ?? 0 : 0
    const ivaRate = parseNumber(formData.iva_rate)

    const payload = {
      sucursal_id: Number(formData.sucursalId),
      tipo_movimiento_id: Number(salidaTipoId),
      sub_tipo_movimiento_id: Number(formData.subTipoId),
      descripcion: buildDescripcion(),
      funcional: isDevolucion ? Boolean(formData.funcional) : true,
      sucursal_objetivo_id: requiresSucursalObjetivo ? Number(formData.sucursalObjetivoId) : null,
      estado_movimiento_id: Number(formData.estadoId),
      descuento,
      fecha: formData.fecha,
      no_documento: formData.no_documento.trim(),
      detalles: details.map((detail) => {
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

      const nextOriginal = {
        form: { ...formData },
        detalles: details.map((detail) => ({ ...detail })),
      }
      setOriginalData(nextOriginal)
      setIsEditing(false)
      onUpdated?.(data)
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al actualizar la salida.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!isEditing || deleteLoading) return
    setDeleteLoading(true)

    try {
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/${salidaId}/`,
        { method: 'DELETE' },
        token
      )

      if (!response.ok && response.status !== 204) {
        const data = await response.json().catch(() => ({}))
        const detail = data?.detail || 'No se pudo eliminar la salida.'
        throw new Error(detail)
      }

      onDeleted?.(salidaId)
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al eliminar la salida.')
    } finally {
      setDeleteLoading(false)
    }
  }

  if (!open) return null

  const editorDisabled = !isEditing || saving || loadingData

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
    isResizingModal ? 'create-salida__modal--resizing' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const selectedEstadoName =
    estados.find((estado) => String(estado.id) === String(formData.estadoId))?.nombre ||
    estadoOptions.find((estado) => String(estado.id) === String(formData.estadoId))?.nombre ||
    formData.estadoNombre ||
    ''

  return (
    <div className="create-user__overlay" role="dialog" aria-modal="true" style={overlayStyle}>
      <div ref={modalRef} className={modalClassName} style={modalStyle}>
        <header className="create-user__header" onMouseDown={handleModalMouseDown}>
          <div className="create-user__header-text">
            <h3>Detalle de salida</h3>
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

        <form className="create-user__form" onSubmit={(event) => event.preventDefault()}>
          <div className="create-user__content create-salida__content">
              <div className="create-user__body">
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Datos</p>
                      <h4>Informacion general</h4>
                    </div>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field">
                      <span>Tipo de salida</span>
                      <input
                        type="text"
                        value={selectedSubTipo?.nombre || formData.subTipoNombre || ''}
                        readOnly
                        disabled
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Fecha</span>
                      <input name="fecha" type="date" value={formData.fecha} readOnly disabled />
                    </label>

                    <label className="create-user__field">
                      <span>Sucursal</span>
                      <select name="sucursalId" value={formData.sucursalId} onChange={handleChange} disabled={editorDisabled}>
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
                        <span>Sucursal Destino</span>
                        <select
                          name="sucursalObjetivoId"
                          value={formData.sucursalObjetivoId}
                          onChange={handleChange}
                          disabled={editorDisabled}
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

                    <label className="create-user__field">
                      <span>{documentLabel}</span>
                      <input
                        name="no_documento"
                        type="text"
                        value={formData.no_documento}
                        onChange={handleChange}
                        disabled={editorDisabled}
                      />
                    </label>

                    {isDevolucion && (
                      <label className="create-user__field">
                        <span>Estado del movimiento</span>
                        <input type="text" value={selectedEstadoName} readOnly disabled />
                      </label>
                    )}

                    {isTraslado && (
                      <label className="create-user__field">
                        <span>Estado del movimiento</span>
                        <select name="estadoId" value={formData.estadoId} onChange={handleChange} disabled={editorDisabled}>
                          <option value="">Selecciona un estado</option>
                          {trasladoEstadoOptions.map((estado) => (
                            <option key={estado.id} value={estado.id}>
                              {estado.nombre}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    {isVenta && (
                      <label className="create-user__field">
                        <span>Estado del movimiento</span>
                        <select name="estadoId" value={formData.estadoId} onChange={handleChange} disabled={editorDisabled}>
                          <option value="">Selecciona un estado</option>
                          {ventaEstadoOptions.map((estado) => (
                            <option key={estado.id} value={estado.id}>
                              {estado.nombre}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    {!isDevolucion && !isTraslado && !isVenta && (
                      <label className="create-user__field">
                        <span>Estado del movimiento</span>
                        <select name="estadoId" value={formData.estadoId} onChange={handleChange} disabled={editorDisabled}>
                          <option value="">Selecciona un estado</option>
                          {(estadoOptions.length ? estadoOptions : estados).map((estado) => (
                            <option key={estado.id} value={estado.id}>
                              {estado.nombre}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    {isVenta && (
                      <label className="create-user__field">
                        <span>Cliente</span>
                        <input name="cliente" type="text" value={formData.cliente} onChange={handleChange} disabled={editorDisabled} />
                      </label>
                    )}

                    {isVenta && (
                      <label className="create-user__field">
                        <span>Descuento</span>
                        <input
                          name="descuento"
                          type="number"
                          step="0.01"
                          min="0"
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

                    <label className="create-user__field create-user__field--full">
                      <span>Descripcion</span>
                      <input
                        name="descripcion"
                        type="text"
                        value={formData.descripcion}
                        onChange={handleChange}
                        disabled={editorDisabled}
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
                            disabled={editorDisabled || (isTraslado && (!formData.sucursalId || stockLoading))}
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
                                        <small>{isTraslado ? `Disponible: ${available}` : `ID: ${producto.id}`}</small>
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
                          disabled={editorDisabled}
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
                          disabled={editorDisabled}
                        />
                      </span>
                      <span>
                        <input value={draftLineTotal !== null ? draftLineTotal.toFixed(2) : ''} readOnly disabled />
                      </span>
                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button type="button" className="create-user__ghost" onClick={handleAddDetail} disabled={editorDisabled}>
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
                          <button type="button" className="create-user__locations-remove" onClick={() => handleRemoveDetail(detail.uid)} disabled={editorDisabled}>
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
                        <span className="create-salida__totals-label">Descuento</span>
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

                  {detailError && <div className="create-user__error">{detailError}</div>}
                </section>
              </div>
            </div>

          {error && <div className="create-user__error">{error}</div>}

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
              <button
                type="button"
                className="create-user__action create-user__action--secondary"
                onClick={() => setIsEditing((prev) => !prev)}
                disabled={loadingData || saving || deleteLoading}
              >
                {isEditing ? 'Solo lectura' : 'Editar'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {isEditing && (
                <>
                  <button
                    type="button"
                    className="create-user__action create-user__action--secondary"
                    onClick={handleDelete}
                    disabled={deleteLoading || saving}
                  >
                    {deleteLoading ? 'Eliminando...' : 'Eliminar'}
                  </button>
                  <button
                    type="button"
                    className="create-user__action create-user__action--primary"
                    onClick={handleSave}
                    disabled={saving || loadingData}
                  >
                    {saving ? 'Guardando...' : 'Guardar cambios'}
                  </button>
                </>
              )}
            </div>
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

export default SalidaDetails

