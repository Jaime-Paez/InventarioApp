import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import '../admin/CreateUsuario/CreateUsuario.css'
import './CreateSalida.css'
import { API_URL, authFetch } from '../../../utils/api'

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

function CreateSalida({
  open,
  onClose,
  onCreated,
  token,
  onError,
  preloadedTipoMovimientos = [],
  preloadedSubTipos = [],
}) {
  const [formData, setFormData] = useState(initialForm)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [branches, setBranches] = useState([])
  const [tipoMovimientos, setTipoMovimientos] = useState(() => preloadedTipoMovimientos)
  const [subTipos, setSubTipos] = useState(() => preloadedSubTipos)
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

  const selectedSubTipo = useMemo(
    () => subTiposSalida.find((sub) => String(sub.id) === String(formData.subTipoId)),
    [subTiposSalida, formData.subTipoId]
  )

  const selectedSubTipoName = normalizeValue(selectedSubTipo?.nombre)
  const isDevolucion = selectedSubTipoName.includes('devol')
  const isTraslado = selectedSubTipoName.includes('trasl')
  const isVenta = selectedSubTipoName.includes('vent')
  const isSelectorStep = !formData.subTipoId
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

  const fetchCatalogs = useCallback(async () => {
    if (!token) return
    try {
      const [
        branchesRes,
        tiposRes,
        subTiposRes,
        estadosRes,
        productosRes,
        estadosProductoRes,
      ] = await Promise.all([
        authFetch(`${API_URL}/inventario/sucursales/?modulo=movimientos_salidas`, {}, token),
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

      setBranches(parseApiList(branchesData))
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
    setFormData({ ...initialForm, fecha: todayISO() })
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
    setIsMaximized(false)
    setIsResizingModal(false)
    modalRestoreRef.current = null
    setError('')
    fetchCatalogs()
  }, [open, fetchCatalogs])

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
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
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
    setDetails((prev) => prev.filter((detail) => detail.uid !== uid))
  }

  const buildDescripcion = () => {
    const descripcionBase = String(formData.descripcion || '').trim()
    if (!isVenta) return descripcionBase
    const cliente = String(formData.cliente || '').trim()
    if (!cliente) return descripcionBase
    if (!descripcionBase) return `Cliente: ${cliente}`
    return `Cliente: ${cliente}\n${descripcionBase}`
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
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

    if (isVenta && !String(formData.cliente || '').trim()) {
      notifyError('Ingresa el cliente para la venta.')
      return
    }

    if (!details.length) {
      notifyError('Agrega al menos un producto.')
      return
    }

    if (details.some((detail) => !detail.productoId || !detail.estadoProductoId)) {
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

    setLoading(true)
    try {
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
        const detail = data?.detail || 'No se pudo crear la salida.'
        throw new Error(detail)
      }

      onCreated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrio un error al crear la salida.')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

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

  return (
    <div className="create-user__overlay" role="dialog" aria-modal="true" style={overlayStyle}>
      <div ref={modalRef} className={modalClassName} style={modalStyle}>
        <header className="create-user__header" onMouseDown={handleModalMouseDown}>
          <div className="create-user__header-text">
            <h3>Nueva salida</h3>
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

        <form className="create-user__form" onSubmit={handleSubmit}>
          {!formData.subTipoId ? (
            <div className="create-salida__selector-shell">
              <section className="create-user__section create-salida__selector-card">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Datos</p>
                    <h4>Selecciona tipo de salida</h4>
                  </div>
                </div>
                <div className="create-salida__selector-inner">
                  <label className="create-user__field create-salida__selector-field">
                    <span>Tipo de salida</span>
                    <select
                      name="subTipoId"
                      value={formData.subTipoId}
                      onChange={handleChange}
                      disabled={loading}
                      className={`create-salida__tipo-select${!formData.subTipoId ? ' is-placeholder' : ''}`}
                    >
                      <option value="">Selecciona un tipo</option>
                      {subTiposSalida.map((subTipo) => (
                        <option key={subTipo.id} value={subTipo.id}>
                          {subTipo.nombre}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>
            </div>
          ) : (
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
                      <select
                        name="subTipoId"
                        value={formData.subTipoId}
                        onChange={handleChange}
                        disabled={loading}
                        className={`create-salida__tipo-select${!formData.subTipoId ? ' is-placeholder' : ''}`}
                      >
                        <option value="">Selecciona un tipo</option>
                        {subTiposSalida.map((subTipo) => (
                          <option key={subTipo.id} value={subTipo.id}>
                            {subTipo.nombre}
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
                      <select name="sucursalId" value={formData.sucursalId} onChange={handleChange} disabled={loading}>
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
                          disabled={loading}
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
                        disabled={loading}
                      />
                    </label>

                    {!isVenta && (
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

                    {isVenta && (
                      <label className="create-user__field">
                        <span>Estado del movimiento</span>
                        <select name="estadoId" value={formData.estadoId} onChange={handleChange} disabled={loading}>
                          <option value="">Selecciona un estado</option>
                          {ventaEstadoOptions.map((estado) => (
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
                        <input name="cliente" type="text" value={formData.cliente} onChange={handleChange} disabled={loading} />
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
                            disabled={loading || (isTraslado && (!formData.sucursalId || stockLoading))}
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
                          disabled={loading}
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
                        <button type="button" className="create-user__ghost" onClick={handleAddDetail} disabled={loading}>
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
          )}

          {error && <div className="create-user__error">{error}</div>}

          <div className="create-user__footer">
            <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose} disabled={loading}>
              Cancelar
            </button>
            {formData.subTipoId && (
              <button type="submit" className="create-user__action create-user__action--primary" disabled={loading}>
                {loading ? 'Guardando...' : 'Crear salida'}
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

export default CreateSalida
