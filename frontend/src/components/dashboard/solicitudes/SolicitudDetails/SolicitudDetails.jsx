import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Pencil } from 'lucide-react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../../admin/UsersDetails/UsersDetails.css'
import { API_URL, authFetch } from '../../../../utils/api'
import useModalAnimation from '../../common/useModalAnimation'
import EntityRemindersTab from '../../common/reminders/EntityRemindersTab'
import CreateProducto from '../../productos/CreateProducto/CreateProducto'

const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const PRODUCT_MODAL_MIN_WIDTH = 680
const PRODUCT_MODAL_MIN_HEIGHT = 460
const VIEWPORT_PADDING = 12

const emptyForm = {
  codigo: '',
  grupoCodigo: '',
  tabla: '',
  fecha: '',
  sucursalId: '',
  placa: '',
  descripcionGeneral: '',
  comentario: '',
  cantidad: '1',
  productoId: '',
  productoCodigo: '',
  productoNombre: '',
  productoMarca: '',
  productoDescripcion: '',
  productoOems: '',
}

const emptyCliente = {
  id: '',
  nombres: '',
  apellidos: '',
  cedula_ruc: '',
  correo: '',
  telefono: '',
  direccion: '',
}

const normalizeText = (value) => String(value ?? '').trim()
const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
const normalizeScopeModuleKey = (value) => String(value ?? '').trim().toLowerCase()
const normalizeScopeBranchId = (value) => String(value ?? '').trim()
const getModuleCreateBranchIdSet = (rawScopes, moduleKey) => {
  const normalizedModuleKey = normalizeScopeModuleKey(moduleKey)
  if (!normalizedModuleKey) return new Set()

  const moduleScope = (Array.isArray(rawScopes) ? rawScopes : []).find(
    (scope) => normalizeScopeModuleKey(scope?.modulo) === normalizedModuleKey
  )
  if (!moduleScope) return new Set()

  const createIds = (Array.isArray(moduleScope?.acciones_por_sucursal)
    ? moduleScope.acciones_por_sucursal
    : []
  )
    .filter((entry) => Boolean(entry?.puede_crear))
    .map((entry) => normalizeScopeBranchId(entry?.sucursal_id))
    .filter(Boolean)

  return new Set(createIds)
}

const buildFormData = (solicitud) => {
  const productoSolicitado = solicitud?.producto_solicitado_data || null
  const productoCatalogo = solicitud?.producto_data || null
  const tabla = String(solicitud?.tabla || '').trim()
  return {
    codigo: normalizeText(solicitud?.codigo),
    grupoCodigo: normalizeText(solicitud?.grupo_codigo),
    tabla,
    fecha: normalizeText(solicitud?.fecha),
    sucursalId: String(solicitud?.sucursal_data?.id || solicitud?.sucursal_id || ''),
    placa: String(solicitud?.placa || ''),
    descripcionGeneral: String(solicitud?.descripcion_general || ''),
    comentario: String(solicitud?.comentario || ''),
    cantidad: String(solicitud?.cantidad || '1'),
    productoId:
      tabla === 'producto'
        ? String(solicitud?.producto_id || productoCatalogo?.id || '')
        : String(productoSolicitado?.id || solicitud?.producto_id || ''),
    productoCodigo: String(
      tabla === 'producto' ? productoCatalogo?.codigo || '' : productoSolicitado?.codigo || ''
    ),
    productoNombre: String(
      tabla === 'producto'
        ? productoCatalogo?.nombre || solicitud?.producto_referencia || ''
        : productoSolicitado?.nombre || solicitud?.producto_referencia || ''
    ),
    productoMarca: String(
      tabla === 'producto'
        ? productoCatalogo?.marca?.nombre || productoCatalogo?.marca || ''
        : productoSolicitado?.marca || ''
    ),
    productoDescripcion: String(
      tabla === 'producto' ? productoCatalogo?.descripcion || '' : productoSolicitado?.descripcion || ''
    ),
    productoOems: Array.isArray(productoSolicitado?.oem_codigos)
      ? productoSolicitado.oem_codigos.join(', ')
      : '',
  }
}

const buildClienteData = (solicitud) => {
  const cliente = solicitud?.cliente_data || null
  return {
    id: String(cliente?.id || solicitud?.cliente_id || ''),
    nombres: String(cliente?.nombres || ''),
    apellidos: String(cliente?.apellidos || ''),
    cedula_ruc: String(cliente?.cedula_ruc || ''),
    correo: String(cliente?.correo || ''),
    telefono: String(cliente?.telefono || ''),
    direccion: String(cliente?.direccion || ''),
  }
}

const buildGroupItem = (solicitud) => {
  const productoSolicitado = solicitud?.producto_solicitado_data || null
  const productoCatalogo = solicitud?.producto_data || null
  const tabla = String(solicitud?.tabla || '').trim()
  return {
    id: Number(solicitud?.id || 0),
    codigo: normalizeText(solicitud?.codigo) || `Solicitud #${solicitud?.id || '-'}`,
    tabla,
    productoCodigo: String(
      tabla === 'producto' ? productoCatalogo?.codigo || '' : productoSolicitado?.codigo || ''
    ),
    productoNombre: String(
      tabla === 'producto'
        ? productoCatalogo?.nombre || solicitud?.producto_referencia || ''
        : productoSolicitado?.nombre || solicitud?.producto_referencia || ''
    ),
    productoMarca: String(
      tabla === 'producto'
        ? productoCatalogo?.marca?.nombre || productoCatalogo?.marca || ''
        : productoSolicitado?.marca || ''
    ),
    productoOems: Array.isArray(productoSolicitado?.oem_codigos)
      ? productoSolicitado.oem_codigos
      : [],
    cantidad: Number(solicitud?.cantidad || 0),
  }
}

function SolicitudDetails({
  open,
  solicitudId,
  token,
  onClose,
  onUpdated,
  onError,
  currentUser,
  allowEdit = true,
}) {
  const [solicitud, setSolicitud] = useState(null)
  const [rootSolicitudId, setRootSolicitudId] = useState(null)
  const [selectedSolicitudId, setSelectedSolicitudId] = useState(null)
  const [productSolicitud, setProductSolicitud] = useState(null)
  const [groupItems, setGroupItems] = useState([])
  const [formData, setFormData] = useState(emptyForm)
  const [originalFormData, setOriginalFormData] = useState(emptyForm)
  const [productFormData, setProductFormData] = useState(emptyForm)
  const [clienteData, setClienteData] = useState(emptyCliente)
  const [originalClienteData, setOriginalClienteData] = useState(emptyCliente)
  const [loading, setLoading] = useState(false)
  const [productLoading, setProductLoading] = useState(false)
  const [productCodeExists, setProductCodeExists] = useState(false)
  const [productCodeCheckLoading, setProductCodeCheckLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState('productos')
  const [isEditing, setIsEditing] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [isProductModalOpen, setIsProductModalOpen] = useState(false)
  const [isCreateProductModalOpen, setIsCreateProductModalOpen] = useState(false)
  const [isProductModalMaximized, setIsProductModalMaximized] = useState(false)
  const [position, setPosition] = useState({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
  const [modalSize, setModalSize] = useState({
    width: MIN_WIDTH,
    height: MIN_HEIGHT,
  })
  const [productModalPosition, setProductModalPosition] = useState({
    x: VIEWPORT_PADDING,
    y: VIEWPORT_PADDING,
  })
  const [productModalSize, setProductModalSize] = useState({
    width: PRODUCT_MODAL_MIN_WIDTH,
    height: PRODUCT_MODAL_MIN_HEIGHT,
  })

  const modalRef = useRef(null)
  const productModalRef = useRef(null)
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const productDragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const positionRef = useRef(position)
  const modalSizeRef = useRef(modalSize)
  const productModalPositionRef = useRef(productModalPosition)
  const productModalSizeRef = useRef(productModalSize)
  const restoreRef = useRef(null)
  const productRestoreRef = useRef(null)
  const productCodeCheckSeqRef = useRef(0)

  const notifyError = useCallback(
    (message) => {
      if (!message) return
      onError?.(message)
    },
    [onError]
  )

  const getViewportMetrics = useCallback((baseMinWidth = MIN_WIDTH, baseMinHeight = MIN_HEIGHT) => {
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    return {
      availableWidth,
      availableHeight,
      minWidth: Math.min(baseMinWidth, availableWidth),
      minHeight: Math.min(baseMinHeight, availableHeight),
    }
  }, [])

  const applySolicitudState = useCallback((data) => {
    const nextForm = buildFormData(data)
    const nextCliente = buildClienteData(data)
    setSolicitud(data)
    setFormData(nextForm)
    setOriginalFormData(nextForm)
    setClienteData(nextCliente)
    setOriginalClienteData(nextCliente)
  }, [])

  const applyProductState = useCallback((data) => {
    setProductSolicitud(data)
    setProductFormData(buildFormData(data))
  }, [])

  const productCreateBranchIds = useMemo(
    () => getModuleCreateBranchIdSet(currentUser?.sucursales_por_modulo, 'productos'),
    [currentUser]
  )
  const canCreateProducts = Boolean(currentUser?.es_administrador) || productCreateBranchIds.size > 0

  const fetchGroupItems = useCallback(
    async (baseSolicitud) => {
      const grupoCodigo = normalizeText(baseSolicitud?.grupo_codigo)
      if (!grupoCodigo || !token) {
        setGroupItems(baseSolicitud ? [buildGroupItem(baseSolicitud)] : [])
        return
      }

      try {
        const response = await authFetch(
          `${API_URL}/solicitudes/solicitudes/?grupo_codigo=${encodeURIComponent(grupoCodigo)}&page_size=100`,
          {},
          token
        )
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error()

        const mergedById = new Map()
        parseApiList(data).forEach((item) => {
          if (item?.id != null) mergedById.set(String(item.id), item)
        })
        if (baseSolicitud?.id != null) mergedById.set(String(baseSolicitud.id), baseSolicitud)

        setGroupItems(
          Array.from(mergedById.values())
            .sort((left, right) => Number(left?.id || 0) - Number(right?.id || 0))
            .map((item) => buildGroupItem(item))
        )
      } catch {
        setGroupItems(baseSolicitud ? [buildGroupItem(baseSolicitud)] : [])
      }
    },
    [token]
  )

  const loadSolicitud = useCallback(
    async (id) => {
      if (!id || !token) return
      setLoading(true)
      try {
        const response = await authFetch(`${API_URL}/solicitudes/solicitudes/${id}/`, {}, token)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.detail || 'No se pudo cargar la solicitud.')
        applySolicitudState(data)
        await fetchGroupItems(data)
      } catch (err) {
        notifyError(err?.message || 'No se pudo cargar la solicitud.')
      } finally {
        setLoading(false)
      }
    },
    [applySolicitudState, fetchGroupItems, notifyError, token]
  )

  const loadProductSolicitud = useCallback(
    async (id) => {
      if (!id || !token) return
      setProductLoading(true)
      try {
        const response = await authFetch(`${API_URL}/solicitudes/solicitudes/${id}/`, {}, token)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.detail || 'No se pudo cargar el producto.')
        applyProductState(data)
      } catch (err) {
        notifyError(err?.message || 'No se pudo cargar el producto.')
      } finally {
        setProductLoading(false)
      }
    },
    [applyProductState, notifyError, token]
  )

  useEffect(() => {
    if (!open) return
    setActiveTab('productos')
    setIsEditing(false)
    setIsMaximized(false)
    setIsProductModalOpen(false)
    setIsCreateProductModalOpen(false)
    setIsProductModalMaximized(false)
    setProductCodeExists(false)
    setProductCodeCheckLoading(false)
    productCodeCheckSeqRef.current = 0
    restoreRef.current = null
    productRestoreRef.current = null
    setSolicitud(null)
    setProductSolicitud(null)
    setGroupItems([])
    setRootSolicitudId(solicitudId || null)
    setSelectedSolicitudId(null)
    setProductFormData(emptyForm)
  }, [open, solicitudId])

  useEffect(() => {
    if (!open || !rootSolicitudId) return
    loadSolicitud(rootSolicitudId)
  }, [open, rootSolicitudId, loadSolicitud])

  useEffect(() => {
    if (!open || !isProductModalOpen || !selectedSolicitudId) return
    loadProductSolicitud(selectedSolicitudId)
  }, [isProductModalOpen, loadProductSolicitud, open, selectedSolicitudId])

  useEffect(() => {
    if (!open || !isProductModalOpen) {
      setProductCodeExists(false)
      setProductCodeCheckLoading(false)
      return
    }

    if (productFormData.tabla === 'producto') {
      setProductCodeExists(true)
      setProductCodeCheckLoading(false)
      return
    }

    const codigo = normalizeText(productFormData.productoCodigo)
    if (!codigo || !token) {
      setProductCodeExists(false)
      setProductCodeCheckLoading(false)
      return
    }

    const seq = ++productCodeCheckSeqRef.current
    setProductCodeCheckLoading(true)

    const run = async () => {
      try {
        const response = await authFetch(
          `${API_URL}/productos/listado/?search=${encodeURIComponent(codigo)}&page_size=5`,
          {},
          token
        )
        if (!response.ok) throw new Error()
        const payload = await response.json().catch(() => ({}))
        if (seq !== productCodeCheckSeqRef.current) return
        const exists = parseApiList(payload).some(
          (item) => normalizeText(item?.codigo).toLowerCase() === codigo.toLowerCase()
        )
        setProductCodeExists(exists)
      } catch {
        if (seq !== productCodeCheckSeqRef.current) return
        setProductCodeExists(false)
      } finally {
        if (seq === productCodeCheckSeqRef.current) {
          setProductCodeCheckLoading(false)
        }
      }
    }

    run()
  }, [isProductModalOpen, open, productFormData.productoCodigo, productFormData.tabla, token])

  useEffect(() => {
    if (allowEdit || !isEditing) return
    setIsEditing(false)
  }, [allowEdit, isEditing])

  useLayoutEffect(() => {
    if (!open) return
    const { availableWidth, availableHeight } = getViewportMetrics()
    const nextSize = {
      width: Math.min(MIN_WIDTH, availableWidth),
      height: Math.min(MIN_HEIGHT, availableHeight),
    }
    setModalSize(nextSize)
    setPosition({
      x: Math.max((window.innerWidth - nextSize.width) / 2, VIEWPORT_PADDING),
      y: Math.max((window.innerHeight - nextSize.height) / 2, VIEWPORT_PADDING),
    })
  }, [getViewportMetrics, open])

  useLayoutEffect(() => {
    if (!open || !isProductModalOpen) return
    const { availableWidth, availableHeight } = getViewportMetrics(
      PRODUCT_MODAL_MIN_WIDTH,
      PRODUCT_MODAL_MIN_HEIGHT
    )
    const nextSize = {
      width: Math.min(PRODUCT_MODAL_MIN_WIDTH, availableWidth),
      height: Math.min(PRODUCT_MODAL_MIN_HEIGHT, availableHeight),
    }
    setProductModalSize(nextSize)
    setProductModalPosition({
      x: Math.max((window.innerWidth - nextSize.width) / 2, VIEWPORT_PADDING),
      y: Math.max((window.innerHeight - nextSize.height) / 2, VIEWPORT_PADDING),
    })
  }, [getViewportMetrics, isProductModalOpen, open])

  useEffect(() => {
    positionRef.current = position
  }, [position])

  useEffect(() => {
    modalSizeRef.current = modalSize
  }, [modalSize])

  useEffect(() => {
    productModalPositionRef.current = productModalPosition
  }, [productModalPosition])

  useEffect(() => {
    productModalSizeRef.current = productModalSize
  }, [productModalSize])

  const handleHeaderMouseDown = (event) => {
    if (event.button !== 0) return
    if (isMaximized) {
      const restore = restoreRef.current
      const fallbackSize = modalSizeRef.current
      const restoredSize = restore?.size || fallbackSize
      const restoredPosition = restore?.position || {
        x: Math.max((window.innerWidth - restoredSize.width) / 2, VIEWPORT_PADDING),
        y: Math.max((window.innerHeight - restoredSize.height) / 2, VIEWPORT_PADDING),
      }

      modalSizeRef.current = restoredSize
      positionRef.current = restoredPosition
      setModalSize(restoredSize)
      setPosition(restoredPosition)
      setIsMaximized(false)

      const offsetX = Math.min(
        Math.max(event.clientX - restoredPosition.x, 24),
        Math.max(restoredSize.width - 24, 24)
      )
      const offsetY = Math.min(Math.max(event.clientY - restoredPosition.y, 12), 56)
      dragData.current = {
        active: true,
        offsetX,
        offsetY,
      }
      return
    }

    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    dragData.current = {
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
    resizeData.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: modalSizeRef.current.width,
      startHeight: modalSizeRef.current.height,
    }

    const handleResizeMove = (moveEvent) => {
      if (!resizeData.current.active) return
      const deltaX = moveEvent.clientX - resizeData.current.startX
      const deltaY = moveEvent.clientY - resizeData.current.startY
      const maxWidth = Math.max(
        minWidth,
        window.innerWidth - positionRef.current.x - VIEWPORT_PADDING
      )
      const maxHeight = Math.max(
        minHeight,
        window.innerHeight - positionRef.current.y - VIEWPORT_PADDING
      )
      const width = clamp(resizeData.current.startWidth + deltaX, minWidth, maxWidth)
      const height = clamp(resizeData.current.startHeight + deltaY, minHeight, maxHeight)
      setModalSize({ width, height })
    }

    const handleResizeUp = () => {
      resizeData.current.active = false
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }

    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }

  const handleProductHeaderMouseDown = () => {}

  const handleProductResizeMouseDown = () => {}

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!dragData.current.active) return
      event.preventDefault()
      const nextX = event.clientX - dragData.current.offsetX
      const nextY = event.clientY - dragData.current.offsetY
      const maxX = Math.max(
        window.innerWidth - modalSizeRef.current.width - VIEWPORT_PADDING,
        VIEWPORT_PADDING
      )
      const maxY = Math.max(
        window.innerHeight - modalSizeRef.current.height - VIEWPORT_PADDING,
        VIEWPORT_PADDING
      )
      setPosition({
        x: clamp(nextX, VIEWPORT_PADDING, maxX),
        y: clamp(nextY, VIEWPORT_PADDING, maxY),
      })
    }

    const handleMouseUp = () => {
      dragData.current.active = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!productDragData.current.active) return
      event.preventDefault()
      const nextX = event.clientX - productDragData.current.offsetX
      const nextY = event.clientY - productDragData.current.offsetY
      const maxX = Math.max(
        window.innerWidth - productModalSizeRef.current.width - VIEWPORT_PADDING,
        VIEWPORT_PADDING
      )
      const maxY = Math.max(
        window.innerHeight - productModalSizeRef.current.height - VIEWPORT_PADDING,
        VIEWPORT_PADDING
      )
      setProductModalPosition({
        x: clamp(nextX, VIEWPORT_PADDING, maxX),
        y: clamp(nextY, VIEWPORT_PADDING, maxY),
      })
    }

    const handleMouseUp = () => {
      productDragData.current.active = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  useEffect(() => {
    const handleWindowResize = () => {
      const { minWidth, minHeight, availableWidth, availableHeight } = getViewportMetrics()

      if (isMaximized) {
        setModalSize({ width: availableWidth, height: availableHeight })
        setPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }

      setModalSize((prev) => {
        const width = clamp(prev.width, minWidth, availableWidth)
        const height = clamp(prev.height, minHeight, availableHeight)

        setPosition((prevPosition) => ({
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
  }, [getViewportMetrics, isMaximized])

  useEffect(() => {
    const handleWindowResize = () => {
      const { minWidth, minHeight, availableWidth, availableHeight } = getViewportMetrics(
        PRODUCT_MODAL_MIN_WIDTH,
        PRODUCT_MODAL_MIN_HEIGHT
      )

      if (isProductModalMaximized) {
        setProductModalSize({ width: availableWidth, height: availableHeight })
        setProductModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }

      setProductModalSize((prev) => {
        const width = clamp(prev.width, minWidth, availableWidth)
        const height = clamp(prev.height, minHeight, availableHeight)

        setProductModalPosition((prevPosition) => ({
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
  }, [getViewportMetrics, isProductModalMaximized])

  const toggleMaximize = () => {
    if (isMaximized) {
      const restore = restoreRef.current
      if (restore) {
        setModalSize(restore.size)
        setPosition(restore.position)
      }
      setIsMaximized(false)
      return
    }

    restoreRef.current = {
      size: modalSizeRef.current,
      position: positionRef.current,
    }
    const { availableWidth, availableHeight } = getViewportMetrics()
    setModalSize({ width: availableWidth, height: availableHeight })
    setPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  const toggleProductModalMaximize = () => {
    if (isProductModalMaximized) {
      const restore = productRestoreRef.current
      if (restore) {
        setProductModalSize(restore.size)
        setProductModalPosition(restore.position)
      }
      setIsProductModalMaximized(false)
      return
    }

    productRestoreRef.current = {
      size: productModalSizeRef.current,
      position: productModalPositionRef.current,
    }
    const { availableWidth, availableHeight } = getViewportMetrics(
      PRODUCT_MODAL_MIN_WIDTH,
      PRODUCT_MODAL_MIN_HEIGHT
    )
    setProductModalSize({ width: availableWidth, height: availableHeight })
    setProductModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsProductModalMaximized(true)
  }

  const handleFormFieldChange = (event) => {
    const { name, value } = event.target
    setFormData((prev) => ({ ...prev, [name]: value }))
  }

  const handleClienteFieldChange = (event) => {
    const { name, value } = event.target
    setClienteData((prev) => ({ ...prev, [name]: value }))
  }

  const handleCancelEdit = () => {
    setFormData(originalFormData)
    setClienteData(originalClienteData)
    setIsEditing(false)
  }

  const handleCloseProductModal = () => {
    setIsProductModalOpen(false)
    setIsProductModalMaximized(false)
    setProductCodeExists(false)
    setProductCodeCheckLoading(false)
    productRestoreRef.current = null
    setSelectedSolicitudId(null)
    setProductSolicitud(null)
    setProductFormData(emptyForm)
  }

  const handleSelectGroupItem = (itemId) => {
    if (loading || saving) return
    setProductSolicitud(null)
    setProductFormData(emptyForm)
    setProductCodeExists(false)
    setProductCodeCheckLoading(false)
    setSelectedSolicitudId(itemId)
    setIsProductModalOpen(true)
  }

  const handleOpenCreateProductModal = () => {
    if (productCodeCheckLoading || !canCreateProducts || productCodeExists) return
    setIsProductModalOpen(false)
    setIsCreateProductModalOpen(true)
  }

  const handleCloseCreateProductModal = () => {
    setIsCreateProductModalOpen(false)
    if (selectedSolicitudId) {
      setIsProductModalOpen(true)
    }
  }

  const handleProductCreated = () => {
    setIsCreateProductModalOpen(false)
    setProductCodeExists(true)
    if (selectedSolicitudId) {
      setIsProductModalOpen(true)
    }
  }

  const handleSave = async () => {
    if (!isEditing || saving || !rootSolicitudId) return

    const payload = {
      placa: normalizeText(formData.placa),
      descripcion_general: normalizeText(formData.descripcionGeneral),
    }

    const hasClientData =
      Boolean(clienteData.id) ||
      Object.entries(clienteData).some(([key, value]) => key !== 'id' && Boolean(normalizeText(value)))

    if (hasClientData) {
      if (clienteData.id) payload.cliente_id = Number(clienteData.id)
      payload.cliente_nombres = normalizeText(clienteData.nombres)
      payload.cliente_apellidos = normalizeText(clienteData.apellidos)
      payload.cliente_cedula_ruc = normalizeText(clienteData.cedula_ruc)
      payload.cliente_correo = normalizeText(clienteData.correo)
      payload.cliente_telefono = normalizeText(clienteData.telefono)
      payload.cliente_direccion = normalizeText(clienteData.direccion)
    }

    setSaving(true)
    try {
      const response = await authFetch(
        `${API_URL}/solicitudes/solicitudes/${rootSolicitudId}/`,
        { method: 'PATCH', body: JSON.stringify(payload) },
        token
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.detail || 'No se pudo actualizar la solicitud.')
      applySolicitudState(data)
      await fetchGroupItems(data)
      setIsEditing(false)
      onUpdated?.(data)
    } catch (err) {
      notifyError(err?.message || 'No se pudo actualizar la solicitud.')
    } finally {
      setSaving(false)
    }
  }

  const { shouldRender, isClosing } = useModalAnimation(open)
  if (!shouldRender) return null

  const editorDisabled = loading || saving || !isEditing
  const productPopupLoading =
    productLoading || (isProductModalOpen && Boolean(selectedSolicitudId) && !productSolicitud)
  const selectedGroupItem = groupItems.find(
    (item) => String(item.id || '') === String(selectedSolicitudId || '')
  )
  const rootGroupItem = groupItems.find(
    (item) => String(item.id || '') === String(rootSolicitudId || '')
  )
  const modalTitle =
    rootGroupItem?.codigo ||
    solicitud?.codigo ||
    (rootSolicitudId ? `Solicitud #${rootSolicitudId}` : 'Detalle de solicitud')
  const productModalTitle = [
    selectedGroupItem?.productoCodigo || productFormData.productoCodigo || 'Producto',
    selectedGroupItem?.productoNombre || productFormData.productoNombre || '',
  ]
    .filter(Boolean)
    .join(' - ')
  const shouldShowCreateProductButton = Boolean(
    isProductModalOpen &&
      !productPopupLoading &&
      canCreateProducts &&
      productFormData.tabla === 'producto_solicitado' &&
      normalizeText(productFormData.productoCodigo) &&
      !productCodeCheckLoading &&
      !productCodeExists
  )
  const createProductInitialData = {
    codigo: productFormData.productoCodigo,
    nombre: productFormData.productoNombre,
    descripcion: productFormData.productoDescripcion,
    marcaNombre: productFormData.productoMarca,
    oemItems: String(productFormData.productoOems || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  }
  const overlayStyle = { padding: `${VIEWPORT_PADDING}px` }
  const modalStyle = {
    top: position.y,
    left: position.x,
    width: modalSize.width,
    height: modalSize.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
  }
  const productModalStyle = {
    top: productModalPosition.y,
    left: productModalPosition.x,
    width: productModalSize.width,
    height: productModalSize.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
  }
  const canUsePortal = typeof document !== 'undefined'
  const productModalOverlay = isProductModalOpen ? (
    <div
      className="create-user__overlay"
      role="dialog"
      aria-modal="true"
      style={{
        padding: `${VIEWPORT_PADDING}px`,
        background: 'rgba(15, 23, 42, 0.28)',
        backdropFilter: 'blur(1px)',
        zIndex: 10020,
      }}
    >
      <div className="create-user__modal" ref={productModalRef} style={productModalStyle}>
        <header
          className="create-user__header"
          onMouseDown={handleProductHeaderMouseDown}
          style={{ cursor: 'default' }}
        >
          <div className="create-user__header-text" style={{ cursor: 'default' }}>
            <h3>{productModalTitle || 'Detalle del producto'}</h3>
          </div>
          <div className="create-user__header-actions">
            <button
              type="button"
              className="create-user__icon-button create-user__icon-button--maximize"
              style={{ display: 'none' }}
              hidden
              tabIndex={-1}
              aria-hidden="true"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={toggleProductModalMaximize}
              aria-label={isProductModalMaximized ? 'Restaurar' : 'Maximizar'}
            >
              <i
                className={
                  isProductModalMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'
                }
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              className="create-user__icon-button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={handleCloseProductModal}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="create-user__content">
          <div className="create-user__body">
            {productPopupLoading ? (
              <div className="spinner-container">
                <div className="spinner" />
              </div>
            ) : (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Producto</p>
                    <h4>
                      {productFormData.tabla === 'producto'
                        ? 'Producto de catalogo'
                        : 'Producto solicitado'}
                    </h4>
                  </div>
                </div>

                <div className="create-user__grid create-user__grid--two">
                  <label className="create-user__field">
                    <span>Codigo</span>
                    <input name="productoCodigo" value={productFormData.productoCodigo} disabled />
                  </label>
                  <label className="create-user__field">
                    <span>Nombre</span>
                    <input name="productoNombre" value={productFormData.productoNombre} disabled />
                  </label>
                  {productFormData.tabla === 'producto_solicitado' && (
                    <>
                      <label className="create-user__field">
                        <span>Marca</span>
                        <input name="productoMarca" value={productFormData.productoMarca} disabled />
                      </label>
                      <label className="create-user__field">
                        <span>OEM</span>
                        <input name="productoOems" value={productFormData.productoOems} disabled />
                      </label>
                    </>
                  )}
                  <label className="create-user__field">
                    <span>Cantidad</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      name="cantidad"
                      value={productFormData.cantidad}
                      disabled
                    />
                  </label>
                  <label className="create-user__field">
                    <span>Conseguido</span>
                    <input value={productSolicitud?.conseguido ? 'Si' : 'No'} disabled />
                  </label>
                  {productFormData.tabla === 'producto_solicitado' && (
                    <label className="create-user__field create-user__field--full">
                      <span>Descripcion</span>
                      <textarea
                        name="productoDescripcion"
                        value={productFormData.productoDescripcion}
                        disabled
                      />
                    </label>
                  )}
                  <label className="create-user__field create-user__field--full">
                    <span>Comentario por producto</span>
                    <input name="comentario" value={productFormData.comentario} disabled />
                  </label>
                </div>
              </section>
            )}
          </div>
        </div>

        <div className="create-user__footer">
          <div className="user-details__footer-left">
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={handleCloseProductModal}
              disabled={productLoading}
            >
              Cerrar
            </button>
          </div>
          <div className="user-details__footer-right">
            {shouldShowCreateProductButton && (
              <button
                type="button"
                className="create-user__action create-user__action--primary"
                onClick={handleOpenCreateProductModal}
              >
                Crear producto
              </button>
            )}
          </div>
        </div>

        <button
          type="button"
          aria-label="Cambiar tamano de ventana"
          className="create-user__resize-handle"
          style={{ display: 'none' }}
          hidden
          tabIndex={-1}
          aria-hidden="true"
          onMouseDown={handleProductResizeMouseDown}
        />
      </div>
    </div>
  ) : null
  const createProductModal = isCreateProductModalOpen ? (
    <CreateProducto
      open={isCreateProductModalOpen}
      onClose={handleCloseCreateProductModal}
      onCreated={handleProductCreated}
      token={token}
      onError={notifyError}
      currentUser={currentUser}
      initialData={createProductInitialData}
    />
  ) : null

  return (
    <>
      <div
        className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`}
        role="dialog"
        aria-modal="true"
        style={overlayStyle}
      >
        <div
          className={`create-user__modal${isClosing ? ' create-user__modal--closing' : ''}`}
          ref={modalRef}
          style={modalStyle}
        >
        <header className="create-user__header" onMouseDown={handleHeaderMouseDown}>
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
              <i
                className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'}
                aria-hidden="true"
              />
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

        <div className="create-user__content">
          <div className="create-user__tabs" role="tablist" aria-label="Secciones de solicitud">
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'productos' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('productos')}
            >
              Productos
            </button>
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'cliente' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('cliente')}
            >
              Datos del cliente
            </button>
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'recordatorios' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('recordatorios')}
            >
              Recordatorios
            </button>
          </div>

          <div className="create-user__body">
            {loading && (
              <div className="spinner-container">
                <div className="spinner" />
              </div>
            )}

            {!loading && solicitud && activeTab === 'productos' && (
              <>
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Solicitud</p>
                      <h4>Datos generales</h4>
                    </div>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field">
                      <span>Codigo</span>
                      <input value={formData.codigo || '-'} disabled />
                    </label>
                    <label className="create-user__field">
                      <span>Fecha</span>
                      <input type="date" value={formData.fecha} disabled />
                    </label>
                    <label className="create-user__field">
                      <span>Sucursal</span>
                      <input
                        value={solicitud?.sucursal_data?.nombre || '-'}
                        disabled
                      />
                    </label>
                    <label className="create-user__field">
                      <span>Placa</span>
                      <input
                        name="placa"
                        value={formData.placa}
                        onChange={handleFormFieldChange}
                        disabled={editorDisabled}
                      />
                    </label>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Detalle</p>
                      <h4>Productos de la solicitud</h4>
                      <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: '0.92rem' }}>
                        Selecciona un producto para abrir su popup.
                      </p>
                    </div>
                  </div>

                  <div className="create-user__locations-table">
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>Codigo</span>
                      <span>Nombre</span>
                      <span>Marca</span>
                      <span>OEM</span>
                      <span>Cantidad</span>
                    </div>

                    {groupItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="create-user__locations-row"
                        onClick={() => handleSelectGroupItem(item.id)}
                        disabled={loading || saving}
                        style={{
                          width: '100%',
                          border: 0,
                          color: 'inherit',
                          textAlign: 'left',
                          cursor: loading || saving ? 'wait' : 'pointer',
                          background: 'transparent',
                          boxShadow: 'none',
                        }}
                      >
                        <span>{item.productoCodigo || '-'}</span>
                        <span>
                          {item.productoNombre || '-'}
                          {item.tabla === 'producto' && (
                            <small className="create-solicitud__chip">Catalogo</small>
                          )}
                        </span>
                        <span>{item.productoMarca || '-'}</span>
                        <span>{item.productoOems.length ? item.productoOems.join(', ') : '-'}</span>
                        <span>{item.cantidad || '-'}</span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Solicitud</p>
                      <h4>Comentario general</h4>
                    </div>
                  </div>
                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field create-user__field--full">
                      <span>Descripcion general</span>
                      <textarea
                        name="descripcionGeneral"
                        value={formData.descripcionGeneral}
                        onChange={handleFormFieldChange}
                        disabled={editorDisabled}
                      />
                    </label>
                  </div>
                </section>

              </>
            )}

            {!loading && solicitud && activeTab === 'cliente' && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Cliente</p>
                    <h4>Datos del cliente</h4>
                  </div>
                </div>
                <div className="create-user__grid create-user__grid--two">
                  <label className="create-user__field">
                    <span>Nombres</span>
                    <input
                      name="nombres"
                      value={clienteData.nombres}
                      onChange={handleClienteFieldChange}
                      disabled={editorDisabled}
                    />
                  </label>
                  <label className="create-user__field">
                    <span>Apellidos</span>
                    <input
                      name="apellidos"
                      value={clienteData.apellidos}
                      onChange={handleClienteFieldChange}
                      disabled={editorDisabled}
                    />
                  </label>
                  <label className="create-user__field">
                    <span>Cedula/RUC</span>
                    <input
                      name="cedula_ruc"
                      value={clienteData.cedula_ruc}
                      onChange={handleClienteFieldChange}
                      disabled={editorDisabled}
                    />
                  </label>
                  <label className="create-user__field">
                    <span>Correo</span>
                    <input
                      type="email"
                      name="correo"
                      value={clienteData.correo}
                      onChange={handleClienteFieldChange}
                      disabled={editorDisabled}
                    />
                  </label>
                  <label className="create-user__field">
                    <span>Telefono</span>
                    <input
                      name="telefono"
                      value={clienteData.telefono}
                      onChange={handleClienteFieldChange}
                      disabled={editorDisabled}
                    />
                  </label>
                  <label className="create-user__field create-user__field--full">
                    <span>Direccion</span>
                    <input
                      name="direccion"
                      value={clienteData.direccion}
                      onChange={handleClienteFieldChange}
                      disabled={editorDisabled}
                    />
                  </label>
                </div>
              </section>
            )}

            {!loading && activeTab === 'recordatorios' && (
              <EntityRemindersTab
                token={token}
                currentUser={currentUser}
                entityType="solicitud"
                entityId={rootSolicitudId}
                isOpen={open}
                entityLabel={modalTitle}
                canCreateReminder={allowEdit && isEditing}
                onError={notifyError}
              />
            )}
          </div>
        </div>

        <div className="create-user__footer">
          <div className="user-details__footer-left">
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={isEditing ? handleCancelEdit : onClose}
              disabled={loading || saving}
            >
              Cancelar
            </button>
            {allowEdit && (
              <button
                type="button"
                className={`create-user__action create-user__action--edit user-details__edit-toggle${isEditing ? ' user-details__edit-toggle--active' : ''}`}
                onClick={() => (isEditing ? handleCancelEdit() : setIsEditing(true))}
                disabled={loading || saving}
              >
                <span className="user-details__toggle-icon" aria-hidden="true">
                  {isEditing ? <Eye size={14} /> : <Pencil size={14} />}
                </span>
                <span>{isEditing ? 'Solo lectura' : 'Editar'}</span>
              </button>
            )}
          </div>
          <div className="user-details__footer-right">
            {isEditing && (
              <button
                type="button"
                className="create-user__action create-user__action--primary"
                onClick={handleSave}
                disabled={loading || saving}
              >
                {saving ? 'Guardando...' : 'Guardar cambios'}
              </button>
            )}
          </div>
        </div>

        <button
          type="button"
          aria-label="Cambiar tamano de ventana"
          className="create-user__resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
        </div>
      </div>
      {productModalOverlay && (canUsePortal ? createPortal(productModalOverlay, document.body) : productModalOverlay)}
      {createProductModal && (canUsePortal ? createPortal(createProductModal, document.body) : createProductModal)}
    </>
  )
}

export default SolicitudDetails
