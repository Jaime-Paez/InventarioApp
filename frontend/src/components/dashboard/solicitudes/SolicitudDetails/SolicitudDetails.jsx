import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../../admin/UsersDetails/UsersDetails.css'
import '../../movimientos/CreateSalida.css'
import './SolicitudDetails.css'
import { API_URL, authFetch } from '../../../../utils/api'
import useModalAnimation from '../../common/useModalAnimation'
import StaticFieldDisplay from '../../movimientos/StaticFieldDisplay'
import CreateProducto from '../../productos/CreateProducto/CreateProducto'
import ProductoDetails from '../../productos/ProductoDetails/ProductoDetails'

const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const PRODUCT_MODAL_MIN_WIDTH = 680
const PRODUCT_MODAL_MIN_HEIGHT = 460
const REVIEW_MODAL_WIDTH = 760
const REVIEW_MODAL_HEIGHT = 640
const VIEWPORT_PADDING = 12

const emptyForm = {
  codigo: '',
  grupoCodigo: '',
  tabla: '',
  fecha: '',
  sucursalId: '',
  marca: '',
  modelo: '',
  motor: '',
  anio: '',
  descripcionGeneral: '',
  comentario: '',
  cantidad: '1',
  productoId: '',
  productoCodigo: '',
  productoNombre: '',
  casaComercialId: '',
  casaComercialNombre: '',
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

const createEmptyRevisarDraft = () => ({
  casaComercialId: '',
  casaComercialNombre: '',
  casaComercialCodigo: '',
  referencia: '',
})
const emptyRevisarRef = () => ({
  uid: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  ...createEmptyRevisarDraft(),
})

const normalizeText = (value) => String(value ?? '').trim()
const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
const isReviewedEstado = (value) => ['revisado', 'archivado'].includes(String(value || '').trim().toLowerCase())
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
    marca: String(solicitud?.marca || ''),
    modelo: String(solicitud?.modelo || ''),
    motor: String(solicitud?.motor || ''),
    anio: String(solicitud?.anio || ''),
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
    casaComercialId: String(
      tabla === 'producto_solicitado'
        ? productoSolicitado?.casa_comercial_id || productoSolicitado?.casa_comercial_data?.id || ''
        : ''
    ),
    casaComercialNombre: String(
      tabla === 'producto_solicitado'
        ? productoSolicitado?.casa_comercial_data?.nombre || productoSolicitado?.casa_comercial_nombre || ''
        : ''
    ),
    productoDescripcion: String(
      tabla === 'producto' ? productoCatalogo?.descripcion || '' : productoSolicitado?.descripcion || ''
    ),
    productoOems: tabla === 'producto'
      ? (Array.isArray(productoCatalogo?.oem_codigos) ? productoCatalogo.oem_codigos.join(', ') : '')
      : (Array.isArray(productoSolicitado?.oem_codigos) ? productoSolicitado.oem_codigos.join(', ') : ''),
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
  const estado = String(solicitud?.estado || 'solicitado')
  const catalogProductId =
    tabla === 'producto'
      ? Number(solicitud?.producto_id || productoCatalogo?.id || 0)
      : Number(
          productoSolicitado?.producto_id || productoSolicitado?.producto_data?.id || 0
        )
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
    casaComercialNombre: String(
      tabla === 'producto_solicitado'
        ? productoSolicitado?.casa_comercial_data?.nombre || productoSolicitado?.casa_comercial_nombre || ''
        : ''
    ),
    productoOems: tabla === 'producto'
      ? (Array.isArray(productoCatalogo?.oem_codigos) ? productoCatalogo.oem_codigos : [])
      : (Array.isArray(productoSolicitado?.oem_codigos) ? productoSolicitado.oem_codigos : []),
    cantidad: Number(solicitud?.cantidad || 0),
    comentario: String(solicitud?.comentario || ''),
    catalogProductId,
    createdFromSolicitud:
      tabla === 'producto_solicitado' &&
      Number(productoSolicitado?.producto_id || productoSolicitado?.producto_data?.id || 0) > 0,
    existsInCatalog: catalogProductId > 0,
    isReviewed: isReviewedEstado(estado),
    isAccepted: estado === 'revisado',
    estado,
    revisiones: Array.isArray(solicitud?.revisiones) ? solicitud.revisiones : [],
  }
}

const formatResolvedProductLocations = (productDetail) => {
  const entries = Array.isArray(productDetail?.inventario_context?.inventario_entries)
    ? productDetail.inventario_context.inventario_entries
    : []
  if (!entries.length) return 'Sin ubicaciones registradas.'

  return entries
    .map((entry) => {
      const subdivision = entry?.subdivision || {}
      const division = subdivision?.division || {}
      const bodega = division?.bodega || {}
      const sucursal = bodega?.sucursal || {}
      const locationPath = [
        sucursal?.nombre,
        bodega?.nombre,
        division?.nombre,
        subdivision?.nombre,
      ]
        .map((value) => normalizeText(value))
        .filter(Boolean)
        .join(' / ')
      const referencia = normalizeText(entry?.referencia)
      const cantidad = Number(entry?.cantidad || 0)
      const suffix = [
        referencia ? `Ref: ${referencia}` : '',
        Number.isFinite(cantidad) && cantidad > 0 ? `Cant.: ${cantidad}` : '',
      ]
        .filter(Boolean)
        .join(' | ')

      return [locationPath || 'Ubicacion', suffix].filter(Boolean).join(' - ')
    })
    .join('\n')
}

function SolicitudDetails({
  open,
  solicitudId,
  token,
  onClose,
  onUpdated,
  onDeleted,
  onError,
  onOpenReviewedProduct,
  currentUser,
  allowEdit = true,
  allowDelete = true,
}) {
  const [solicitud, setSolicitud] = useState(null)
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
  const [resolvedProductDetail, setResolvedProductDetail] = useState(null)
  const [resolvedProductLoading, setResolvedProductLoading] = useState(false)
  const [linkingCreatedProduct, setLinkingCreatedProduct] = useState(false)
  const [openingProductSelection, setOpeningProductSelection] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [revisarTarget, setRevisarTarget] = useState(null)
  const [isRevisarModalOpen, setIsRevisarModalOpen] = useState(false)
  const [revisarFilas, setRevisarFilas] = useState([])
  const [revisarDraft, setRevisarDraft] = useState(createEmptyRevisarDraft())
  const [revisarLoading, setRevisarLoading] = useState(false)
  const [revisarError, setRevisarError] = useState('')
  const [revisarCasasOptions, setRevisarCasasOptions] = useState([])
  const [revisarCasasLoading, setRevisarCasasLoading] = useState(false)
  const [showRevisarCasaDropdown, setShowRevisarCasaDropdown] = useState(false)
  const [revisarCasaQuery, setRevisarCasaQuery] = useState('')
  const [revisarOemProducts, setRevisarOemProducts] = useState([])
  const [revisarOemProductsLoading, setRevisarOemProductsLoading] = useState(false)
  const [oemTableHover, setOemTableHover] = useState(null)
  const oemTableHoverTimerRef = useRef(null)
  const [activeTab, setActiveTab] = useState('productos')
  const [isEditing, setIsEditing] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [isProductModalOpen, setIsProductModalOpen] = useState(false)
  const [isCatalogProductModalOpen, setIsCatalogProductModalOpen] = useState(false)
  const [isCreateProductModalOpen, setIsCreateProductModalOpen] = useState(false)
  const [isProductModalMaximized, setIsProductModalMaximized] = useState(false)
  const [catalogProductId, setCatalogProductId] = useState(null)
  const [catalogProductNotice, setCatalogProductNotice] = useState('')
  const [catalogProductSolicitudComment, setCatalogProductSolicitudComment] = useState('')
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
  const revisarCasaDropdownRef = useRef(null)
  const revisarCasaSearchTimerRef = useRef(null)
  const revisarCasaSearchSeqRef = useRef(0)
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const productDragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const rootSolicitudRequestSeqRef = useRef(0)
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

  useEffect(() => {
    if (allowDelete || !showDeleteDialog) return
    setShowDeleteDialog(false)
  }, [allowDelete, showDeleteDialog])

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
    async (baseSolicitud, requestSeq = null) => {
      const grupoCodigo = normalizeText(baseSolicitud?.grupo_codigo)
      const isStaleRequest = () =>
        requestSeq != null && requestSeq !== rootSolicitudRequestSeqRef.current
      if (!grupoCodigo || !token) {
        if (!isStaleRequest()) {
          setGroupItems(baseSolicitud ? [buildGroupItem(baseSolicitud)] : [])
        }
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
        if (isStaleRequest()) return

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
        if (!isStaleRequest()) {
          setGroupItems(baseSolicitud ? [buildGroupItem(baseSolicitud)] : [])
        }
      }
    },
    [token]
  )

  const loadSolicitud = useCallback(
    async (id) => {
      if (!id || !token) return
      const requestSeq = rootSolicitudRequestSeqRef.current + 1
      rootSolicitudRequestSeqRef.current = requestSeq
      setLoading(true)
      try {
        const response = await authFetch(`${API_URL}/solicitudes/solicitudes/${id}/`, {}, token)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.detail || 'No se pudo cargar la solicitud.')
        if (requestSeq !== rootSolicitudRequestSeqRef.current) return
        applySolicitudState(data)
        await fetchGroupItems(data, requestSeq)
      } catch (err) {
        if (requestSeq !== rootSolicitudRequestSeqRef.current) return
        notifyError(err?.message || 'No se pudo cargar la solicitud.')
      } finally {
        if (requestSeq === rootSolicitudRequestSeqRef.current) {
          setLoading(false)
        }
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
        return data
      } catch (err) {
        notifyError(err?.message || 'No se pudo cargar el producto.')
        return null
      } finally {
        setProductLoading(false)
      }
    },
    [applyProductState, notifyError, token]
  )

  const loadResolvedProductDetail = useCallback(
    async (productId) => {
      if (!productId || !token) {
        setResolvedProductDetail(null)
        setResolvedProductLoading(false)
        return
      }

      setResolvedProductLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/productos/listado/${productId}/?include_inventory_context=1`,
          {},
          token
        )
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(data?.detail || 'No se pudo cargar el producto ligado.')
        }
        setResolvedProductDetail(data)
      } catch (err) {
        setResolvedProductDetail(null)
        notifyError(err?.message || 'No se pudo cargar el producto ligado.')
      } finally {
        setResolvedProductLoading(false)
      }
    },
    [notifyError, token]
  )

  const resolveCatalogProductByCode = useCallback(
    async (codigo) => {
      const normalizedCode = normalizeText(codigo)
      if (!normalizedCode || !token) return null

      try {
        const response = await authFetch(
          `${API_URL}/productos/listado/?codigo=${encodeURIComponent(normalizedCode)}&page_size=5`,
          {},
          token
        )
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error()
        const exactMatch = parseApiList(data).find(
          (item) => normalizeText(item?.codigo).toLowerCase() === normalizedCode.toLowerCase()
        )
        return exactMatch || null
      } catch {
        return null
      }
    },
    [token]
  )

  useEffect(() => {
    rootSolicitudRequestSeqRef.current += 1
    if (!open) return
    setActiveTab('productos')
    setIsEditing(false)
    setIsMaximized(false)
    setIsProductModalOpen(false)
    setIsCatalogProductModalOpen(false)
    setIsCreateProductModalOpen(false)
    setIsProductModalMaximized(false)
    setProductCodeExists(false)
    setProductCodeCheckLoading(false)
    setResolvedProductDetail(null)
    setResolvedProductLoading(false)
    setLinkingCreatedProduct(false)
    setCatalogProductId(null)
    setCatalogProductNotice('')
    setCatalogProductSolicitudComment('')
    productCodeCheckSeqRef.current = 0
    restoreRef.current = null
    productRestoreRef.current = null
    setSolicitud(null)
    setProductSolicitud(null)
    setGroupItems([])
    setSelectedSolicitudId(null)
    setProductFormData(emptyForm)
  }, [open, solicitudId])

  useEffect(() => {
    if (!open || !solicitudId) return
    loadSolicitud(solicitudId)
  }, [open, solicitudId, loadSolicitud])

  useEffect(() => {
    if (!open || !isProductModalOpen || !selectedSolicitudId) return
    if (String(productSolicitud?.id || '') === String(selectedSolicitudId)) return
    loadProductSolicitud(selectedSolicitudId)
  }, [isProductModalOpen, loadProductSolicitud, open, productSolicitud?.id, selectedSolicitudId])

  useEffect(() => {
    const resolvedProductId = Number(productSolicitud?.producto_resuelto_data?.id || 0)
    if (!open || !isProductModalOpen || !resolvedProductId) {
      setResolvedProductDetail(null)
      setResolvedProductLoading(false)
      return
    }

    loadResolvedProductDetail(resolvedProductId)
  }, [
    isProductModalOpen,
    loadResolvedProductDetail,
    open,
    productSolicitud?.producto_resuelto_data?.id,
  ])

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
          `${API_URL}/productos/listado/?codigo=${encodeURIComponent(codigo)}&page_size=5`,
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
    setResolvedProductDetail(null)
    setResolvedProductLoading(false)
    productRestoreRef.current = null
    setSelectedSolicitudId(null)
    setProductSolicitud(null)
    setProductFormData(emptyForm)
  }

  const handleCloseCatalogProductModal = () => {
    setIsCatalogProductModalOpen(false)
    setCatalogProductId(null)
    setCatalogProductNotice('')
    setCatalogProductSolicitudComment('')
  }

  const handleOpenCatalogProductModal = useCallback((productId, options = {}) => {
    const nextProductId = Number(productId || 0)
    if (!nextProductId) return
    const createdFromSolicitud = Boolean(options.createdFromSolicitud)
    const solicitudComment = String(options.solicitudComment || '').trim()

    setIsProductModalOpen(false)
    setCatalogProductId(nextProductId)
    setCatalogProductNotice(createdFromSolicitud ? 'Creado desde esta solicitud.' : '')
    setCatalogProductSolicitudComment(createdFromSolicitud ? solicitudComment : '')
    setIsCatalogProductModalOpen(true)
  }, [])

  const handleSelectGroupItem = async (itemId) => {
    if (loading || saving || openingProductSelection) return
    const targetItem = groupItems.find((item) => String(item.id || '') === String(itemId || ''))
    if (!targetItem) return

    setOpeningProductSelection(true)
    try {
      setProductSolicitud(null)
      setProductFormData(emptyForm)
      setProductCodeExists(false)
      setProductCodeCheckLoading(false)
      setResolvedProductDetail(null)
      setResolvedProductLoading(false)
      setIsCatalogProductModalOpen(false)
      setCatalogProductId(null)
      setCatalogProductNotice('')
      setCatalogProductSolicitudComment('')
      setSelectedSolicitudId(itemId)

      const directProductId = Number(targetItem.catalogProductId || 0)
      if (directProductId > 0) {
        handleOpenCatalogProductModal(directProductId, {
          createdFromSolicitud: targetItem.createdFromSolicitud,
          solicitudComment: targetItem.comentario,
        })
        return
      }

      const existingProduct = await resolveCatalogProductByCode(targetItem.productoCodigo)
      if (existingProduct?.id) {
        handleOpenCatalogProductModal(existingProduct.id, {
          createdFromSolicitud: false,
          solicitudComment: '',
        })
        return
      }

      await loadProductSolicitud(itemId)
      setIsProductModalOpen(true)
    } finally {
      setOpeningProductSelection(false)
    }
  }

  const handleOpenCreateProductModal = () => {
    if (
      productCodeCheckLoading ||
      !canCreateProducts ||
      productCodeExists ||
      productSolicitud?.producto_resuelto_data?.id
    ) {
      return
    }
    setIsProductModalOpen(false)
    setIsCreateProductModalOpen(true)
  }

  const handleCloseCreateProductModal = () => {
    setIsCreateProductModalOpen(false)
    if (selectedSolicitudId) {
      setIsProductModalOpen(true)
    }
  }

  const handleProductCreated = async (createdProduct) => {
    const createdProductId = Number(createdProduct?.id || 0)
    setLinkingCreatedProduct(true)

    try {
      if (!selectedSolicitudId || !createdProductId) {
        throw new Error('No se pudo identificar el producto creado para ligarlo a la solicitud.')
      }

      const response = await authFetch(
        `${API_URL}/solicitudes/solicitudes/${selectedSolicitudId}/ligar-producto-creado/`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ producto_id: createdProductId }),
        },
        token
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(
          resolveApiErrorMessage(data, 'No se pudo ligar el producto creado a la solicitud.')
        )
      }

      setIsCreateProductModalOpen(false)
      setProductCodeExists(true)
      setIsProductModalOpen(false)

      await Promise.all([
        loadSolicitud(solicitudId || selectedSolicitudId),
        loadProductSolicitud(selectedSolicitudId),
        loadResolvedProductDetail(createdProductId),
      ])
      handleOpenCatalogProductModal(createdProductId, {
        createdFromSolicitud: true,
        solicitudComment: String(data?.comentario || productFormData.comentario || '').trim(),
      })
      onUpdated?.()
    } catch (err) {
      setIsCreateProductModalOpen(false)
      if (selectedSolicitudId) {
        setIsProductModalOpen(true)
      }
      notifyError(err?.message || 'No se pudo ligar el producto creado a la solicitud.')
    } finally {
      setLinkingCreatedProduct(false)
    }
  }

  const handleSave = async () => {
    if (!isEditing || saving || !solicitudId) return

    const payload = {
      marca: normalizeText(formData.marca),
      modelo: normalizeText(formData.modelo),
      motor: normalizeText(formData.motor),
      anio: normalizeText(formData.anio),
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
        `${API_URL}/solicitudes/solicitudes/${solicitudId}/`,
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

  const handleRevisado = (updatedSolicitud) => {
    setIsRevisarModalOpen(false)
    setRevisarTarget(null)
    setRevisarFilas([])
    setRevisarDraft(createEmptyRevisarDraft())
    setShowRevisarCasaDropdown(false)
    setRevisarCasaQuery('')
    setRevisarCasasOptions([])
    setRevisarCasasLoading(false)
    setRevisarError('')
    setRevisarOemProducts([])
    setRevisarOemProductsLoading(false)
    setOemTableHover(null)
    if (updatedSolicitud?.id) {
      setGroupItems((prev) =>
        prev.map((item) =>
          String(item.id) === String(updatedSolicitud.id)
            ? buildGroupItem(updatedSolicitud)
            : item
        )
      )
    }
    onUpdated?.()
  }

  const handleOpenRevisarModal = (item) => {
    const canAcceptWithoutReferences = Boolean(item?.existsInCatalog || item?.tabla === 'producto')
    setRevisarTarget({
      id: item.id,
      nombre: item.productoNombre,
      canAcceptWithoutReferences,
      oems: item.productoOems || [],
    })
    setRevisarFilas([])
    setRevisarDraft(createEmptyRevisarDraft())
    setRevisarError('')
    setShowRevisarCasaDropdown(false)
    setRevisarCasaQuery('')
    setRevisarCasasOptions([])
    setRevisarCasasLoading(false)
    setIsRevisarModalOpen(true)
  }

  const handleCloseRevisarModal = () => {
    if (revisarLoading) return
    setIsRevisarModalOpen(false)
    setRevisarTarget(null)
    setRevisarFilas([])
    setRevisarDraft(createEmptyRevisarDraft())
    setRevisarError('')
    setShowRevisarCasaDropdown(false)
    setRevisarCasaQuery('')
    setRevisarCasasOptions([])
    setRevisarCasasLoading(false)
    setRevisarOemProducts([])
    setRevisarOemProductsLoading(false)
    setOemTableHover(null)
  }

  const handleRevisarCasaSelect = (casaOption) => {
    if (!casaOption?.id) return
    setRevisarDraft((prev) => ({
      ...prev,
      casaComercialId: String(casaOption.id),
      casaComercialNombre: String(casaOption.nombre || '').trim(),
      casaComercialCodigo: String(casaOption.codigo || '').trim(),
    }))
    setShowRevisarCasaDropdown(false)
    setRevisarCasaQuery('')
    setRevisarCasasOptions([])
    setRevisarCasasLoading(false)
  }

  const handleClearRevisarCasa = () => {
    setRevisarDraft((prev) => ({
      ...prev,
      casaComercialId: '',
      casaComercialNombre: '',
      casaComercialCodigo: '',
    }))
    setRevisarCasaQuery('')
    setRevisarCasasOptions([])
    setRevisarCasasLoading(false)
  }

  const handleRevisarCasaSearchChange = (event) => {
    const value = event.target.value
    setRevisarCasaQuery(value)
    if (!showRevisarCasaDropdown) {
      setShowRevisarCasaDropdown(true)
    }
    if (!String(value || '').trim()) {
      setRevisarCasasOptions([])
      setRevisarCasasLoading(false)
    }
  }

  const handleRevisarCasaDropdownToggle = () => {
    if (showRevisarCasaDropdown) {
      setShowRevisarCasaDropdown(false)
      return
    }
    setRevisarCasaQuery('')
    setRevisarCasasOptions([])
    setRevisarCasasLoading(false)
    setShowRevisarCasaDropdown(true)
  }

  const handleRevisarReferenciaChange = (value) => {
    setRevisarDraft((prev) => ({ ...prev, referencia: value }))
  }

  const handleRevisarAddFila = () => {
    const referencia = String(revisarDraft.referencia || '').trim()
    if (!revisarDraft.casaComercialId && !referencia) {
      setRevisarError('Selecciona una casa comercial o escribe una referencia antes de agregar.')
      return
    }
    setRevisarFilas((prev) => [
      ...prev,
      {
        ...emptyRevisarRef(),
        casaComercialId: revisarDraft.casaComercialId,
        casaComercialNombre: revisarDraft.casaComercialNombre,
        casaComercialCodigo: revisarDraft.casaComercialCodigo,
        referencia,
      },
    ])
    setRevisarDraft(createEmptyRevisarDraft())
    setRevisarError('')
    setShowRevisarCasaDropdown(false)
    setRevisarCasaQuery('')
    setRevisarCasasOptions([])
    setRevisarCasasLoading(false)
  }

  const handleRevisarRemoveFila = (uid) => {
    setRevisarFilas((prev) => prev.filter((f) => f.uid !== uid))
  }

  const handleRevisarGuardar = async () => {
    const draftReferencia = String(revisarDraft.referencia || '').trim()
    const preparedFilas = [
      ...revisarFilas,
      ...(
        revisarDraft.casaComercialId || draftReferencia
          ? [{
              ...revisarDraft,
              referencia: draftReferencia,
            }]
          : []
      ),
    ]
    const validFilas = preparedFilas.filter((f) => f.casaComercialId || String(f.referencia || '').trim())
    if (!revisarTarget?.canAcceptWithoutReferences && !validFilas.length) {
      setRevisarError('Agrega al menos una referencia.')
      return
    }
    setRevisarLoading(true)
    setRevisarError('')
    try {
      const referencias = validFilas.map((f) => ({
        casa_comercial_id: f.casaComercialId ? Number(f.casaComercialId) : null,
        referencia: String(f.referencia || '').trim(),
      }))
      const res = await authFetch(
        `${API_URL}/solicitudes/solicitudes/${revisarTarget.id}/revisar/`,
        { method: 'POST', body: JSON.stringify({ referencias }), headers: { 'Content-Type': 'application/json' } },
        token
      )
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(payload?.detail || payload?.referencias || 'No se pudo revisar el producto.')
      }
      const data = await res.json().catch(() => ({}))
      handleRevisado(data)
    } catch (err) {
      setRevisarError(String(err?.message || 'Ocurrió un error al aceptar.'))
    } finally {
      setRevisarLoading(false)
    }
  }

  const handleRevisarArchivar = async () => {
    if (!revisarTarget?.id) return
    setRevisarLoading(true)
    setRevisarError('')
    try {
      const draftReferencia = String(revisarDraft.referencia || '').trim()
      const preparedFilas = [
        ...revisarFilas,
        ...(
          revisarDraft.casaComercialId || draftReferencia
            ? [{ ...revisarDraft, referencia: draftReferencia }]
            : []
        ),
      ]
      const referencias = preparedFilas
        .filter((f) => f.casaComercialId || String(f.referencia || '').trim())
        .map((f) => ({
          casa_comercial_id: f.casaComercialId ? Number(f.casaComercialId) : null,
          referencia: String(f.referencia || '').trim(),
        }))
      const res = await authFetch(
        `${API_URL}/solicitudes/solicitudes/${revisarTarget.id}/archivar/`,
        { method: 'POST', body: JSON.stringify({ referencias }), headers: { 'Content-Type': 'application/json' } },
        token
      )
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(payload?.detail || 'No se pudo archivar el producto.')
      }
      const data = await res.json().catch(() => ({}))
      handleArchivado(data)
    } catch (err) {
      setRevisarError(String(err?.message || 'Ocurrió un error al archivar.'))
    } finally {
      setRevisarLoading(false)
    }
  }

  const handleArchivado = (updatedSolicitud) => {
    setIsRevisarModalOpen(false)
    setRevisarTarget(null)
    setRevisarFilas([])
    setRevisarDraft(createEmptyRevisarDraft())
    setShowRevisarCasaDropdown(false)
    setRevisarCasaQuery('')
    setRevisarCasasOptions([])
    setRevisarCasasLoading(false)
    setRevisarError('')
    setRevisarOemProducts([])
    setRevisarOemProductsLoading(false)
    setOemTableHover(null)
    if (updatedSolicitud?.id) {
      setGroupItems((prev) =>
        prev.map((item) =>
          String(item.id) === String(updatedSolicitud.id)
            ? buildGroupItem(updatedSolicitud)
            : item
        )
      )
    }
    onUpdated?.()
  }

  const handleDelete = async () => {
    const deleteTargetId = Number(solicitudId || 0)
    if (!allowDelete || !deleteTargetId || deleteLoading) return

    setDeleteLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/solicitudes/solicitudes/${deleteTargetId}/`,
        { method: 'DELETE' },
        token
      )

      if (!response.ok && response.status !== 204) {
        const responseClone = response.clone()
        const data = await response.json().catch(() => null)
        const rawText = data == null ? await responseClone.text().catch(() => '') : ''
        const safeRawText = rawText && !/<[a-z][\s\S]*>/i.test(rawText) ? rawText.trim() : ''
        throw new Error(
          resolveApiErrorMessage(data || { detail: safeRawText }, 'No se pudo eliminar la solicitud.')
        )
      }

      setShowDeleteDialog(false)
      onDeleted?.(deleteTargetId)
    } catch (err) {
      notifyError(err?.message || 'No se pudo eliminar la solicitud.')
    } finally {
      setDeleteLoading(false)
    }
  }

  useEffect(() => {
    if (!open || !isRevisarModalOpen || !showRevisarCasaDropdown) return
    const term = String(revisarCasaQuery || '').trim()
    if (!term || term.length < 2 || !token) {
      setRevisarCasasOptions([])
      setRevisarCasasLoading(false)
      return
    }

    if (revisarCasaSearchTimerRef.current) {
      clearTimeout(revisarCasaSearchTimerRef.current)
    }

    setRevisarCasasLoading(true)
    revisarCasaSearchTimerRef.current = setTimeout(async () => {
      const requestId = revisarCasaSearchSeqRef.current + 1
      revisarCasaSearchSeqRef.current = requestId

      try {
        const response = await authFetch(
          `${API_URL}/casa-comercial/casas/?search=${encodeURIComponent(term)}&page_size=5`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las casas comerciales.')
        const data = await response.json()
        if (requestId !== revisarCasaSearchSeqRef.current) return
        setRevisarCasasOptions(parseApiList(data))
      } catch {
        if (requestId !== revisarCasaSearchSeqRef.current) return
        setRevisarCasasOptions([])
      } finally {
        if (requestId === revisarCasaSearchSeqRef.current) {
          setRevisarCasasLoading(false)
        }
      }
    }, 320)

    return () => {
      if (revisarCasaSearchTimerRef.current) {
        clearTimeout(revisarCasaSearchTimerRef.current)
        revisarCasaSearchTimerRef.current = null
      }
    }
  }, [isRevisarModalOpen, open, revisarCasaQuery, showRevisarCasaDropdown, token])

  useEffect(() => {
    if (!isRevisarModalOpen || !revisarTarget?.canAcceptWithoutReferences) {
      setRevisarOemProducts([])
      setRevisarOemProductsLoading(false)
      return
    }
    const oems = revisarTarget.oems || []
    if (!oems.length || !token) {
      setRevisarOemProducts([])
      return
    }
    setRevisarOemProductsLoading(true)
    let cancelled = false
    authFetch(
      `${API_URL}/productos/listado/?oem=${encodeURIComponent(oems[0])}&page_size=20`,
      {},
      token
    )
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((payload) => {
        if (!cancelled) setRevisarOemProducts(Array.isArray(payload) ? payload : (payload?.results || []))
      })
      .catch(() => { if (!cancelled) setRevisarOemProducts([]) })
      .finally(() => { if (!cancelled) setRevisarOemProductsLoading(false) })
    return () => { cancelled = true }
  }, [isRevisarModalOpen, revisarTarget, token])

  const showOemTableHover = useCallback((event, items, label) => {
    if (!items.length) return
    if (oemTableHoverTimerRef.current) clearTimeout(oemTableHoverTimerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    setOemTableHover({ top: rect.bottom + 4, left: rect.left, items, label })
  }, [])

  const hideOemTableHover = useCallback(() => {
    if (oemTableHoverTimerRef.current) clearTimeout(oemTableHoverTimerRef.current)
    oemTableHoverTimerRef.current = setTimeout(() => { oemTableHoverTimerRef.current = null; setOemTableHover(null) }, 120)
  }, [])

  const clearOemTableHoverTimer = useCallback(() => {
    if (oemTableHoverTimerRef.current) { clearTimeout(oemTableHoverTimerRef.current); oemTableHoverTimerRef.current = null }
  }, [])

  useEffect(() => {
    if (!showRevisarCasaDropdown) return
    const handleClickOutside = (event) => {
      if (revisarCasaDropdownRef.current && !revisarCasaDropdownRef.current.contains(event.target)) {
        setShowRevisarCasaDropdown(false)
      }
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [showRevisarCasaDropdown])

  const { shouldRender, isClosing } = useModalAnimation(open)
  if (!shouldRender) return null

  const editorDisabled = loading || saving || !isEditing
  const productPopupLoading =
    productLoading ||
    linkingCreatedProduct ||
    (isProductModalOpen && Boolean(selectedSolicitudId) && !productSolicitud)
  const groupTableGridTemplate =
    'minmax(80px, 0.72fr) minmax(0, 1.24fr) minmax(0, 0.68fr) minmax(0, 1.04fr) minmax(52px, 0.3fr) 72px 100px'
  const selectedGroupItem = groupItems.find(
    (item) => String(item.id || '') === String(selectedSolicitudId || '')
  )
  const rootGroupItem = groupItems.find(
    (item) => String(item.id || '') === String(solicitudId || '')
  )
  const modalTitle =
    rootGroupItem?.codigo ||
    solicitud?.codigo ||
    (solicitudId ? `Solicitud #${solicitudId}` : 'Detalle de solicitud')
  const allGroupItemsReviewed = groupItems.length > 0 && groupItems.every((item) => item.isReviewed)
  const solicitudFormattedFecha = formData.fecha
    ? new Date(formData.fecha + 'T12:00:00').toLocaleDateString('es-EC', { day: 'numeric', month: 'short', year: 'numeric' })
    : ''
  const productModalTitle = [
    selectedGroupItem?.productoCodigo || productFormData.productoCodigo || 'Producto',
    selectedGroupItem?.productoNombre || productFormData.productoNombre || '',
  ]
    .filter(Boolean)
    .join(' - ')
  const resolvedProductId = Number(productSolicitud?.producto_resuelto_data?.id || 0)
  const resolvedProductSummary = normalizeText(
    resolvedProductDetail
      ? `${resolvedProductDetail.codigo || ''} ${resolvedProductDetail.nombre || ''}`
      : productSolicitud?.producto_conseguido || ''
  )
  const resolvedProductLocations = formatResolvedProductLocations(resolvedProductDetail)
  const shouldShowCreateProductButton = Boolean(
    isProductModalOpen &&
      !productPopupLoading &&
      canCreateProducts &&
      productFormData.tabla === 'producto_solicitado' &&
      normalizeText(productFormData.productoCodigo) &&
      !productCodeCheckLoading &&
      !productCodeExists &&
      !resolvedProductId &&
      !selectedGroupItem?.isReviewed
  )
  const createProductInitialData = {
    codigo: productFormData.productoCodigo,
    nombre: productFormData.productoNombre,
    descripcion: productFormData.productoDescripcion,
    casaComercialId: productFormData.casaComercialId,
    casaComercialNombre: productFormData.casaComercialNombre,
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

                {productFormData.tabla === 'producto_solicitado' && !resolvedProductId && !selectedGroupItem?.isReviewed && (
                  <div
                    style={{
                      margin: '0 0 14px',
                      padding: '12px 14px',
                      borderRadius: '12px',
                      border:
                        '1px solid color-mix(in srgb, var(--color-primary-dark) 28%, var(--color-border))',
                      background:
                        'color-mix(in srgb, var(--color-primary-dark) 8%, var(--modal-color))',
                      color: 'var(--color-text-primary)',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '10px',
                    }}
                  >
                    <Info
                      size={18}
                      style={{
                        flexShrink: 0,
                        marginTop: '1px',
                        color: 'var(--color-primary-dark)',
                      }}
                    />
                    <p style={{ margin: 0, fontWeight: 700, lineHeight: 1.35 }}>
                      Este producto aun no existe en la base de datos.
                    </p>
                  </div>
                )}

                {selectedGroupItem?.isReviewed && (
                  <div style={{ margin: '0 0 14px', padding: '10px 14px', borderRadius: '10px', border: `1px solid ${selectedGroupItem.estado === 'archivado' ? 'var(--color-error-border, #fca5a5)' : 'var(--color-success-border, #86efac)'}`, background: selectedGroupItem.estado === 'archivado' ? 'var(--color-error-surface, #fef2f2)' : 'var(--color-success-surface, #f0fdf4)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: '0.85rem', color: selectedGroupItem.estado === 'archivado' ? 'var(--color-error-text, #ef4444)' : 'var(--color-success-text, #16a34a)' }}>
                      {selectedGroupItem.estado === 'archivado' ? 'Archivado' : 'Aceptado'}
                    </span>
                  </div>
                )}

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
                        <span>Casa comercial</span>
                        <input
                          name="casaComercialNombre"
                          value={productFormData.casaComercialNombre || ''}
                          placeholder="Sin casa comercial"
                          disabled
                        />
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
                  {productFormData.tabla === 'producto_solicitado' && resolvedProductId > 0 && (
                    <>
                      <label className="create-user__field">
                        <span>Producto creado</span>
                        <input value={resolvedProductSummary || '-'} disabled />
                      </label>
                      <label className="create-user__field">
                        <span>Historial</span>
                        <input value="Creado desde esta solicitud" disabled />
                      </label>
                      <label className="create-user__field create-user__field--full">
                        <span>Ubicaciones del producto creado</span>
                        <textarea
                          value={
                            resolvedProductLoading
                              ? 'Cargando ubicaciones del producto creado...'
                              : resolvedProductLocations
                          }
                          disabled
                        />
                      </label>
                    </>
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
      lockModal
      initialData={createProductInitialData}
      showCostField={Boolean(currentUser?.es_administrador)}
    />
  ) : null
  const catalogProductModal = isCatalogProductModalOpen && catalogProductId ? (
    <ProductoDetails
      open={isCatalogProductModalOpen}
      productoId={catalogProductId}
      token={token}
      onClose={handleCloseCatalogProductModal}
      onUpdated={async (...args) => {
        if (solicitudId) {
          await loadSolicitud(solicitudId)
        }
        onUpdated?.(...args)
      }}
      onDeleted={async (...args) => {
        handleCloseCatalogProductModal()
        if (solicitudId) {
          await loadSolicitud(solicitudId)
        }
        onUpdated?.(...args)
      }}
      onError={notifyError}
      currentUser={currentUser}
      contextNotice={catalogProductNotice}
      contextComment={catalogProductSolicitudComment}
    />
  ) : null

  const revisarModalOverlay = isRevisarModalOpen && revisarTarget ? (
    <div
      className="create-user__overlay"
      role="dialog"
      aria-modal="true"
      style={{
        padding: `${VIEWPORT_PADDING}px`,
        background: 'rgba(15, 23, 42, 0.28)',
        backdropFilter: 'blur(1px)',
        zIndex: 10030,
      }}
    >
      <div
        className="create-user__modal"
        style={{
          inset: 0,
          margin: 'auto',
          width: REVIEW_MODAL_WIDTH,
          height: REVIEW_MODAL_HEIGHT,
          maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
          maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
        }}
      >
        <header className="create-user__header" style={{ cursor: 'default' }}>
          <div className="create-user__header-text" style={{ cursor: 'default' }}>
            <h3>Revisar producto</h3>
          </div>
          <div className="create-user__header-actions">
            <button
              type="button"
              className="create-user__icon-button"
              onClick={handleCloseRevisarModal}
              disabled={revisarLoading}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="create-user__content">
          <div className="create-user__body">
            <section className="create-user__section">
              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Solicitudes</p>
                  <h4>{revisarTarget.nombre || 'Producto'}</h4>
                </div>
              </div>

              <div className="create-solicitud-details__review-layout">
                <div className="create-solicitud-details__review-helper">
                  <span className="create-solicitud-details__review-helper-label">
                    {revisarTarget.canAcceptWithoutReferences ? 'Producto existente' : 'Producto nuevo'}
                  </span>
                  <p>
                    {revisarTarget.canAcceptWithoutReferences
                      ? 'Este producto ya existe en el catálogo. Puedes agregar nuevas referencias de casas comerciales si es necesario, o aceptarlo directamente.'
                      : 'Agrega una o varias referencias con su casa comercial.'}
                  </p>
                </div>

                {revisarTarget.canAcceptWithoutReferences && (
                  <div className="create-solicitud-details__oem-section">
                    <span className="create-solicitud-details__oem-section-label">Productos en catálogo con este OEM</span>
                    {revisarOemProductsLoading && <small className="muted" style={{ padding: '6px 0' }}>Cargando...</small>}
                    {!revisarOemProductsLoading && revisarOemProducts.length === 0 && (
                      <small className="muted" style={{ padding: '6px 0' }}>Sin resultados.</small>
                    )}
                    {!revisarOemProductsLoading && revisarOemProducts.length > 0 && (
                      <div className="create-user__locations-table create-solicitud-details__oem-table">
                        <div className="create-user__locations-row create-user__locations-row--head">
                          <span>Código</span>
                          <span>Nombre</span>
                          <span>Referencia</span>
                          <span>OEM</span>
                          <span>Casas comerciales</span>
                        </div>
                        {revisarOemProducts.map((prod) => {
                          const casasList = (prod.casas_comerciales || []).map((c) => c.nombre).filter(Boolean)
                          const casasLabel = casasList[0] || '-'
                          const oemList = (prod.oem_productos || []).map((r) => r?.oem?.codigo || '').filter(Boolean)
                          const oemLabel = oemList[0] || '-'
                          return (
                            <div key={prod.id} className="create-user__locations-row">
                              <span>{prod.codigo || '-'}</span>
                              <span title={prod.nombre}>
                                <span className="create-salida__table-static-value create-salida__table-static-value--name">{prod.nombre || '-'}</span>
                              </span>
                              <span>{prod.referencia || '-'}</span>
                              <span>
                                <div className="create-solicitud-details__oem-cell">
                                  <span className="create-salida__table-static-value" title={oemLabel}>{oemLabel}</span>
                                  {oemList.length > 1 && (
                                    <button
                                      type="button"
                                      className="create-solicitud-details__eye-btn"
                                      aria-label="Ver todos los OEM"
                                      onMouseEnter={(e) => showOemTableHover(e, oemList, 'OEM')}
                                      onMouseLeave={hideOemTableHover}
                                      onFocus={(e) => showOemTableHover(e, oemList, 'OEM')}
                                      onBlur={hideOemTableHover}
                                    >
                                      <i className="pi pi-eye" aria-hidden="true" />
                                    </button>
                                  )}
                                </div>
                              </span>
                              <span>
                                <div className="create-solicitud-details__oem-cell">
                                  <span className="create-salida__table-static-value create-salida__table-static-value--name" title={casasLabel}>{casasLabel}</span>
                                  {casasList.length > 1 && (
                                    <button
                                      type="button"
                                      className="create-solicitud-details__eye-btn"
                                      aria-label="Ver todas las casas comerciales"
                                      onMouseEnter={(e) => showOemTableHover(e, casasList, 'Casas comerciales')}
                                      onMouseLeave={hideOemTableHover}
                                      onFocus={(e) => showOemTableHover(e, casasList, 'Casas comerciales')}
                                      onBlur={hideOemTableHover}
                                    >
                                      <i className="pi pi-eye" aria-hidden="true" />
                                    </button>
                                  )}
                                </div>
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}

                <div className="create-user__locations-table create-salida__products-table create-solicitud-details__review-table">
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>Casa comercial</span>
                      <span>Referencia</span>
                      <span>Acciones</span>
                    </div>

                    <div className="create-user__locations-row create-user__locations-row--form">
                      <span className="create-solicitud-details__review-picker">
                        <div
                          className="create-user__dropdown create-solicitud-details__supplier-dropdown"
                          ref={revisarCasaDropdownRef}
                        >
                          <button
                            type="button"
                            className="create-user__dropdown-trigger"
                            onClick={handleRevisarCasaDropdownToggle}
                            disabled={revisarLoading}
                          >
                            <span>
                              {revisarDraft.casaComercialNombre || 'Selecciona una casa comercial'}
                            </span>
                            <i className={`pi pi-chevron-${showRevisarCasaDropdown ? 'up' : 'down'}`} />
                          </button>

                          {showRevisarCasaDropdown && (
                            <div className="create-user__dropdown-panel">
                              <div className="create-user__dropdown-search">
                                <i className="pi pi-search" />
                                <input
                                  type="text"
                                  placeholder="Buscar casas comerciales"
                                  value={revisarCasaQuery}
                                  onChange={handleRevisarCasaSearchChange}
                                  autoFocus
                                  disabled={revisarLoading}
                                />
                              </div>

                              <div className="create-user__dropdown-results">
                                {revisarDraft.casaComercialId && (
                                  <button
                                    type="button"
                                    className="create-user__result-option"
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={(event) => {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      handleClearRevisarCasa()
                                    }}
                                  >
                                    <div className="create-user__result-info">
                                      <strong>Sin casa comercial</strong>
                                      <small>Quitar la selección actual</small>
                                    </div>
                                  </button>
                                )}
                                {revisarCasasLoading && <small className="muted">Buscando casas comerciales...</small>}
                                {!revisarCasasLoading && String(revisarCasaQuery || '').trim().length < 2 && (
                                  <small className="muted">Escribe al menos 2 caracteres.</small>
                                )}
                                {!revisarCasasLoading &&
                                  String(revisarCasaQuery || '').trim().length >= 2 &&
                                  !revisarCasasOptions.length && (
                                    <small className="muted">Sin resultados.</small>
                                  )}
                                {revisarCasasOptions.map((casa) => {
                                  const isSelected =
                                    String(revisarDraft.casaComercialId || '') === String(casa.id)
                                  return (
                                    <button
                                      key={`rev-casa-${casa.id}`}
                                      type="button"
                                      className="create-user__result-option"
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={(event) => {
                                        event.preventDefault()
                                        event.stopPropagation()
                                        handleRevisarCasaSelect(casa)
                                      }}
                                    >
                                      <div className="create-user__result-info">
                                        <strong>{String(casa?.nombre || '').trim() || `Casa #${casa.id}`}</strong>
                                        <small>
                                          {String(casa?.codigo || '').trim()
                                            ? `Código: ${String(casa.codigo).trim()}`
                                            : `ID: ${casa.id}`}
                                        </small>
                                      </div>
                                      {isSelected && (
                                        <span className="create-user__result-tag is-selected">Seleccionado</span>
                                      )}
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
                          type="text"
                          value={revisarDraft.referencia}
                          placeholder="Referencia"
                          disabled={revisarLoading}
                          onChange={(event) => handleRevisarReferenciaChange(event.target.value)}
                        />
                      </span>

                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={handleRevisarAddFila}
                          disabled={revisarLoading}
                        >
                          Agregar
                        </button>
                      </span>
                    </div>

                    {!revisarFilas.length && (
                      <div className="create-user__locations-row create-user__locations-row--empty">
                        <span>Sin referencias agregadas.</span>
                      </div>
                    )}

                    {revisarFilas.map((fila) => {
                      const casaLabel = [
                        String(fila.casaComercialCodigo || '').trim(),
                        String(fila.casaComercialNombre || '').trim(),
                      ]
                        .filter(Boolean)
                        .join(' - ')

                      return (
                        <div key={fila.uid} className="create-user__locations-row">
                          <span title={casaLabel || undefined}>
                            <span className="create-salida__table-static-value create-salida__table-static-value--name">
                              {casaLabel || '-'}
                            </span>
                          </span>
                          <span title={fila.referencia || undefined}>
                            <span className="create-salida__table-static-value create-salida__table-static-value--name">
                              {fila.referencia || '-'}
                            </span>
                          </span>
                          <span className="create-user__locations-cell create-user__locations-cell--action">
                            <button
                              type="button"
                              className="create-user__locations-remove"
                              onClick={() => handleRevisarRemoveFila(fila.uid)}
                              disabled={revisarLoading}
                              title="Eliminar referencia"
                            >
                              <i className="pi pi-trash" aria-hidden="true" />
                            </button>
                          </span>
                        </div>
                      )
                    })}
                  </div>
              </div>

              {revisarError && (
                <p className="create-user__error" style={{ margin: '10px 0 0' }}>
                  {revisarError}
                </p>
              )}
            </section>
          </div>
        </div>

        <div className="create-user__footer">
          <div className="user-details__footer-left">
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={handleCloseRevisarModal}
              disabled={revisarLoading}
            >
              Cancelar
            </button>
          </div>
          <div className="user-details__footer-right">
            <button
              type="button"
              className="create-user__action create-user__action--secondary create-salida__action--danger-solid"
              onClick={handleRevisarArchivar}
              disabled={revisarLoading}
            >
              {revisarLoading ? 'Procesando...' : 'Archivar'}
            </button>
            <button
              type="button"
              className="create-user__action create-user__action--primary"
              onClick={handleRevisarGuardar}
              disabled={revisarLoading}
            >
              {revisarLoading ? 'Procesando...' : 'Aceptar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null

  const oemTableHoverPortal = oemTableHover && createPortal(
    <div
      className="create-solicitud-details__oem-hover-card"
      style={{ top: oemTableHover.top, left: oemTableHover.left }}
      onMouseEnter={clearOemTableHoverTimer}
      onMouseLeave={hideOemTableHover}
    >
      <div className="create-solicitud-details__oem-hover-title">{oemTableHover.label}</div>
      {oemTableHover.items.map((item, i) => (
        <div key={i} className="create-solicitud-details__oem-hover-row">{item}</div>
      ))}
    </div>,
    document.body
  )

  return (
    <>
      <div
        className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-hidden={isCreateProductModalOpen || isCatalogProductModalOpen ? 'true' : undefined}
        style={{
          ...overlayStyle,
          pointerEvents: isCreateProductModalOpen || isCatalogProductModalOpen ? 'none' : undefined,
          userSelect: isCreateProductModalOpen || isCatalogProductModalOpen ? 'none' : undefined,
        }}
      >
        <div
          className={`create-user__modal${isClosing ? ' create-user__modal--closing' : ''}`}
          ref={modalRef}
          style={modalStyle}
        >
        {openingProductSelection ? (
          <div className="create-user__loading-overlay" role="status" aria-live="polite" style={{ zIndex: 80 }}>
            <i className="pi pi-spin pi-spinner" aria-hidden="true" />
            <span>Abriendo producto...</span>
          </div>
        ) : null}
        {groupItems.length > 0 && (
          <div
            className={`entrada-details__pending-ribbon${allGroupItemsReviewed ? ' entrada-details__pending-ribbon--accepted' : ' entrada-details__pending-ribbon--pending'}`}
            aria-label={allGroupItemsReviewed ? 'Solicitud revisada' : 'Solicitud pendiente'}
          >
            <span className="entrada-details__pending-ribbon-label">
              {allGroupItemsReviewed ? 'Solicitud\nrevisada' : 'Solicitud\npendiente'}
            </span>
          </div>
        )}
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
          </div>

          <div className="create-user__body">
            {loading && (
              <div className="spinner-container">
                <div className="spinner" />
              </div>
            )}

            {!loading && solicitud && activeTab === 'productos' && (
              <div className="create-solicitud-details__review-layout">
                <section className="create-user__section create-solicitud-details__general-section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Solicitud</p>
                      <h4>Datos generales</h4>
                    </div>
                  </div>

                  <div className="create-salida__field-group create-salida__field-group--defined create-solicitud-details__general-card">
                    <div className="create-user__grid create-solicitud-details__general-grid">
                      <StaticFieldDisplay label="Codigo" value={formData.codigo} />
                      <StaticFieldDisplay label="Fecha" value={solicitudFormattedFecha} />
                      <StaticFieldDisplay label="Sucursal" value={solicitud?.sucursal_data?.nombre} />
                    </div>
                  </div>
                </section>

                <section className="create-user__section create-solicitud-details__products-section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Detalle</p>
                      <h4>Productos de la solicitud</h4>
                      <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: '0.92rem' }}>
                        Selecciona un producto para abrir su popup.
                      </p>
                    </div>
                  </div>

                  <div className="create-user__locations-table create-solicitud-details__items-table">
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>OEM</span>
                      <span>Nombre</span>
                      <span>Código</span>
                      <span>Comentario</span>
                      <span>Cantidad</span>
                      <span>Revisado</span>
                      <span>Acciones</span>
                    </div>

                    {groupItems.map((item) => (
                      <div
                        key={item.id}
                        className="create-user__locations-row create-solicitud-details__items-row"
                        onClick={() => !loading && !saving && !openingProductSelection && handleSelectGroupItem(item.id)}
                        style={{ cursor: loading || saving || openingProductSelection ? 'wait' : 'pointer' }}
                      >
                        <span
                          className="create-solicitud-details__cell-tip"
                          onMouseEnter={(e) => showOemTableHover(e, [item.productoOems.length ? item.productoOems.join(', ') : item.productoCodigo].filter(Boolean), 'OEM / Código')}
                          onMouseLeave={hideOemTableHover}
                        >
                          <span className="create-solicitud-details__cell-text">{item.productoOems.length ? item.productoOems.join(', ') : (item.productoCodigo || '-')}</span>
                        </span>
                        <span
                          className="create-solicitud-details__cell-tip"
                          onMouseEnter={(e) => showOemTableHover(e, [item.productoNombre].filter(Boolean), 'Nombre')}
                          onMouseLeave={hideOemTableHover}
                        >
                          <span className="create-solicitud-details__cell-text">{item.productoNombre || '-'}</span>
                        </span>
                        <span
                          className="create-solicitud-details__cell-tip"
                          onMouseEnter={(e) => showOemTableHover(e, [item.productoCodigo].filter(Boolean), 'Código')}
                          onMouseLeave={hideOemTableHover}
                        >
                          <span className="create-solicitud-details__cell-text">{item.productoCodigo || '-'}</span>
                        </span>
                        <span
                          className="create-solicitud-details__cell-tip"
                          onMouseEnter={(e) => showOemTableHover(e, [item.comentario].filter(Boolean), 'Comentario')}
                          onMouseLeave={hideOemTableHover}
                        >
                          <span className="create-solicitud-details__cell-text">{item.comentario || '-'}</span>
                        </span>
                        <span>{item.cantidad || '-'}</span>
                        <span aria-label={item.isReviewed ? 'Revisado' : 'Sin revisar'}>
                          <i
                            className={`pi pi-${item.isReviewed ? 'check-circle' : 'times-circle'}`}
                            style={{ color: item.isReviewed ? (item.isAccepted ? '#22c55e' : 'var(--color-error-text, #ef4444)') : '#9ca3af' }}
                            aria-hidden="true"
                          />
                        </span>
                        <span onClick={(e) => e.stopPropagation()}>
                          {item.isReviewed ? (
                            <span style={{ fontSize: '0.75rem', color: item.estado === 'archivado' ? 'var(--color-error-text, #ef4444)' : '#22c55e', fontWeight: 600 }}>
                              {item.estado === 'archivado' ? 'Archivado' : 'Aceptado'}
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="create-user__ghost"
                              style={{ padding: '2px 7px', fontSize: '0.75rem' }}
                              disabled={loading || saving}
                              onClick={() => handleOpenRevisarModal(item)}
                              title="Revisar producto"
                            >
                              Revisar
                            </button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {!loading && solicitud && activeTab === 'cliente' && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Cliente</p>
                    <h4>Datos del cliente</h4>
                  </div>
                </div>
                <div className="create-salida__field-group create-salida__field-group--defined">
                  <div className="create-user__grid create-user__grid--two">
                    <StaticFieldDisplay label="Cedula/RUC" value={clienteData.cedula_ruc} />
                    <StaticFieldDisplay label="Nombres" value={clienteData.nombres} />
                    <StaticFieldDisplay label="Apellidos" value={clienteData.apellidos} />
                    <StaticFieldDisplay label="Correo" value={clienteData.correo} />
                    <StaticFieldDisplay label="Telefono" value={clienteData.telefono} />
                    <StaticFieldDisplay label="Direccion" value={clienteData.direccion} fullWidth />
                  </div>
                </div>
                <div className="create-salida__field-group create-salida__field-group--defined">
                  <div className="create-user__section-header create-solicitud-details__subsection-header">
                    <div>
                      <h4>Vehiculo</h4>
                    </div>
                  </div>
                  <div className="create-user__grid create-solicitud-details__vehicle-grid">
                    <StaticFieldDisplay label="Marca" value={formData.marca} />
                    <StaticFieldDisplay label="Modelo" value={formData.modelo} />
                    <StaticFieldDisplay label="Motor" value={formData.motor} />
                    <StaticFieldDisplay label="Año" value={formData.anio} />
                  </div>
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
              onClick={onClose}
              disabled={loading || deleteLoading}
            >
              Cerrar
            </button>
          </div>
          <div className="user-details__footer-right">
            {allowDelete && (
              <button
                type="button"
                className="create-user__action user-details__delete"
                onClick={() => setShowDeleteDialog(true)}
                disabled={loading || deleteLoading}
              >
                {deleteLoading ? 'Eliminando...' : 'Eliminar'}
              </button>
            )}
          </div>
        </div>

        {allowDelete && showDeleteDialog && (
          <div className="user-details__confirm-overlay">
            <div className="user-details__confirm-dialog">
              <div className="user-details__confirm-icon">
                <Info size={18} />
              </div>
              <div className="user-details__confirm-content">
                <h4>Eliminar solicitud</h4>
                <p>Deseas eliminar esta solicitud y todos sus productos? Esta accion no se puede deshacer.</p>
              </div>
              <div className="user-details__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--cancel"
                  onClick={() => setShowDeleteDialog(false)}
                  disabled={deleteLoading}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="create-user__action user-details__delete"
                  onClick={handleDelete}
                  disabled={deleteLoading}
                >
                  {deleteLoading ? 'Eliminando...' : 'Eliminar solicitud'}
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
      {productModalOverlay && (canUsePortal ? createPortal(productModalOverlay, document.body) : productModalOverlay)}
      {catalogProductModal && (canUsePortal ? createPortal(catalogProductModal, document.body) : catalogProductModal)}
      {createProductModal && (canUsePortal ? createPortal(createProductModal, document.body) : createProductModal)}
      {revisarModalOverlay && (canUsePortal ? createPortal(revisarModalOverlay, document.body) : revisarModalOverlay)}
      {oemTableHoverPortal}
    </>
  )
}

export default SolicitudDetails
