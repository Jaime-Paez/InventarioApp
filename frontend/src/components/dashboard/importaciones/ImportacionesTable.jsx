import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import StaticFieldDisplay from '../movimientos/StaticFieldDisplay'
import { FilterMatchMode } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Button } from 'primereact/button'
import { PackagePlus, Plus, Search, Trash2 } from 'lucide-react'
import { API_URL, authFetch } from '../../../utils/api'
import { autoFitTableColumns, clearSavedColumnWidths } from '../../../utils/autoFitColumns'
import { buildFileName, exportToExcel, exportToPdf } from '../../../utils/exportUtils'
import '../admin/CreateUsuario/CreateUsuario.css'
import '../admin/UsersTable/UsersTable.css'
import '../movimientos/CreateSalida.css'
import './ImportacionesTable.css'

const STATUS_CONFIG = {
  borrador: { label: 'Borrador', empty: 'No hay importaciones en borrador.' },
  en_camino: { label: 'En camino', empty: 'No hay importaciones en camino.' },
  importada: { label: 'Importadas', empty: 'No hay importaciones importadas.' },
}

const IMP_HOVER_WIDTH = 560
const IMP_HOVER_MARGIN = 12

const STATUS_BADGE = {
  borrador: { label: 'Borrador', color: '#64748b', bg: 'rgba(100,116,139,0.1)' },
  en_camino: { label: 'En camino', color: '#d97706', bg: 'rgba(217,119,6,0.1)' },
  importada: { label: 'Importada', color: '#16a34a', bg: 'rgba(22,163,74,0.1)' },
}

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])

const todayISO = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const formatDate = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return '-'
  const [year, month, day] = raw.split('-').map(Number)
  if (!year || !month || !day) return raw
  return new Intl.DateTimeFormat('es-EC', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(year, month - 1, day))
}

const readErrorMessage = async (response, fallback) => {
  const payload = await response.json().catch(() => null)
  const visit = (value) => {
    if (!value) return ''
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(visit).find(Boolean) || ''
    if (typeof value === 'object') return Object.values(value).map(visit).find(Boolean) || ''
    return ''
  }
  return visit(payload?.detail) || visit(payload) || fallback
}

const getFlagUrl = (code) => {
  if (!code) return ''
  const clean = String(code).trim().toLowerCase()
  if (clean.length !== 2) return ''
  return `https://flagsapi.com/${clean.toUpperCase()}/flat/64.png`
}

const formatCasaLabel = (casa) => {
  if (!casa) return ''
  const codigo = String(casa?.codigo || '').trim()
  const nombre = String(casa?.nombre || '').trim()
  return [codigo, nombre].filter(Boolean).join(' - ')
}

const formatProductLabel = (product) => {
  if (!product) return ''
  const codigo = String(product?.codigo || '').trim()
  const nombre = String(product?.nombre || '').trim()
  const referencia = String(product?.referencia || '').trim()
  return [codigo, nombre, referencia ? `Ref. ${referencia}` : ''].filter(Boolean).join(' - ')
}

const MIN_WIDTH = 700
const MIN_HEIGHT = 520
const SELECTOR_WIDTH = 520
const SELECTOR_HEIGHT_EMPTY = 'auto'
const SELECTOR_HEIGHT_FULL = 'auto'
const VIEWPORT_PADDING = 12
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

function ImportacionDetailsModal({ imp, onClose }) {
  if (!imp) return null
  const detalles = imp.detalles || []
  const badge = STATUS_BADGE[imp.estado] || { label: imp.estado, color: '#64748b', bg: 'rgba(100,116,139,0.1)' }
  return createPortal(
    <div
      className="imp-aceptados-popup__overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="imp-aceptados-popup__dialog" style={{ width: 'min(680px, calc(100vw - 32px))', height: 'auto', maxHeight: 'min(82vh, 640px)' }}>
        <header className="imp-aceptados-popup__header">
          <div>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {imp.codigo}
              <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: badge.bg, color: badge.color }}>{badge.label}</span>
            </h3>
            <p>{imp.casa_nombre || imp.casa_comercial?.nombre || '-'}</p>
          </div>
          <button type="button" className="imp-aceptados-popup__close" onClick={onClose}><i className="pi pi-times" /></button>
        </header>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, padding: '12px 20px', borderBottom: '1px solid color-mix(in srgb, var(--border-color,rgba(148,163,184,0.35)) 75%, transparent)', flexShrink: 0 }}>
          {[
            { label: 'Fecha', value: imp.fecha || '-' },
            { label: 'Días estimados', value: imp.dias_entrega_estimados != null ? `${imp.dias_entrega_estimados} días` : '-' },
            { label: 'Total productos', value: imp.total_productos ?? detalles.length },
          ].map(({ label, value }) => (
            <div key={label}>
              <div style={{ fontSize: '0.72rem', color: 'var(--color-muted,#64748b)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>{label}</div>
              <div style={{ fontWeight: 600 }}>{value}</div>
            </div>
          ))}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
          <div className="create-user__locations-table" style={{ borderRadius: 8, overflow: 'hidden', background: 'var(--surface-section,#f8fafc)' }}>
            <div className="create-user__locations-row create-user__locations-row--head" style={{ gridTemplateColumns: 'minmax(90px,0.7fr) minmax(160px,1.6fr) minmax(110px,1fr) 60px' }}>
              <span>Código</span><span>Nombre</span><span>OEM</span><span style={{ justifyContent: 'center' }}>Cant.</span>
            </div>
            {!detalles.length ? (
              <div className="create-user__locations-row create-user__locations-row--empty" style={{ gridTemplateColumns: '1fr' }}><span>Sin productos.</span></div>
            ) : detalles.map((d, i) => {
              const sinCat = !d.producto?.id
              const codigo = d.producto?.codigo || d.codigo || '-'
              const nombre = d.producto?.nombre || d.nombre || '-'
              const oem = d.producto?.oem || d.oem || '-'
              return (
                <div key={d.id ?? i} className={`create-user__locations-row${sinCat ? ' importaciones-aceptados__row--no-catalogo' : ''}`} style={{ gridTemplateColumns: 'minmax(90px,0.7fr) minmax(160px,1.6fr) minmax(110px,1fr) 60px' }}>
                  <span title={codigo} style={{ overflow: 'hidden' }}>
                    <span className="imp-cell-text">{codigo}</span>
                    {sinCat && <span className="importaciones-aceptados__no-catalogo-badge" style={{ marginLeft: 4 }}>Sin catálogo</span>}
                  </span>
                  <span title={nombre} style={{ overflow: 'hidden' }}><span className="imp-cell-text">{nombre}</span></span>
                  <span title={oem} style={{ overflow: 'hidden' }}><span className="imp-cell-text">{oem}</span></span>
                  <span style={{ justifyContent: 'center', fontWeight: 600 }}>{d.cantidad}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="imp-aceptados-popup__footer" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function CreateImportacionModal({ open, token, onClose, onCreated, onError, onOpenBorrador }) {
  const [step, setStep] = useState('casa')
  const [nextCode, setNextCode] = useState('IMP-')
  const [selectedCasa, setSelectedCasa] = useState(null)
  const [casaDraft, setCasaDraft] = useState(null)
  const [casaQuery, setCasaQuery] = useState('')
  const [casaOptions, setCasaOptions] = useState([])
  const [casaLoading, setCasaLoading] = useState(false)
  const [showCasaDropdown, setShowCasaDropdown] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [detailDraft, setDetailDraft] = useState({ producto: null, cantidad: '' })
  const [productQuery, setProductQuery] = useState('')
  const [productOptions, setProductOptions] = useState([])
  const [productLoading, setProductLoading] = useState(false)
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [details, setDetails] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [invalidQtyKeys, setInvalidQtyKeys] = useState(new Set())
  const [showAceptadosView, setShowAceptadosView] = useState(false)
  const [aceptadosItems, setAceptadosItems] = useState([])
  const [aceptadosLoading, setAceptadosLoading] = useState(false)
  const [aceptadosSelected, setAceptadosSelected] = useState(new Set())
  const [aceptadosSearch, setAceptadosSearch] = useState('')
  const [aceptadosCount, setAceptadosCount] = useState(null)
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: SELECTOR_WIDTH, height: SELECTOR_HEIGHT_EMPTY })

  const modalRef = useRef(null)
  const toastRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalSizeRef = useRef(modalSize)
  const modalPositionRef = useRef(modalPosition)
  const casaTimerRef = useRef(null)
  const productTimerRef = useRef(null)
  const casaDropdownRef = useRef(null)
  const productDropdownRef = useRef(null)
  const isFirstOpenRef = useRef(true)
  const [casaPanelStyle, setCasaPanelStyle] = useState(null)
  const [productPanelStyle, setProductPanelStyle] = useState(null)
  const detailDraftQuantity = Number(detailDraft.cantidad)
  const canAddDetailDraft = Boolean(
    detailDraft.producto &&
    Number.isFinite(detailDraftQuantity) &&
    detailDraftQuantity > 0
  )

  useEffect(() => { modalSizeRef.current = modalSize }, [modalSize])
  useEffect(() => { modalPositionRef.current = modalPosition }, [modalPosition])

  useLayoutEffect(() => {
    if (!showCasaDropdown || !casaDropdownRef.current) {
      setCasaPanelStyle(null)
      return
    }
    const rect = casaDropdownRef.current.getBoundingClientRect()
    const panelMaxHeight = Math.min(260, window.innerHeight - rect.bottom - 8)
    setCasaPanelStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(panelMaxHeight, 120),
      zIndex: 9999,
    })
  }, [showCasaDropdown, modalPosition])

  useLayoutEffect(() => {
    if (!showProductDropdown || !productDropdownRef.current) {
      setProductPanelStyle(null)
      return
    }
    const rect = productDropdownRef.current.getBoundingClientRect()
    const panelMaxHeight = Math.min(280, window.innerHeight - rect.bottom - 8)
    const panelWidth = Math.min(Math.max(rect.width, 520), window.innerWidth - VIEWPORT_PADDING * 2)
    const panelLeft = clamp(rect.left, VIEWPORT_PADDING, Math.max(window.innerWidth - panelWidth - VIEWPORT_PADDING, VIEWPORT_PADDING))
    setProductPanelStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: panelLeft,
      width: panelWidth,
      maxHeight: Math.max(panelMaxHeight, 120),
      zIndex: 9999,
    })
  }, [showProductDropdown, modalPosition])

  useLayoutEffect(() => {
    if (!open) {
      isFirstOpenRef.current = true
      return
    }
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    const isSelectorStep = step === 'casa'

    if (isSelectorStep) {
      const nextWidth = Math.min(SELECTOR_WIDTH, availableWidth)
      const preferredHeight = casaDraft ? SELECTOR_HEIGHT_FULL : SELECTOR_HEIGHT_EMPTY
      const measuredHeight = modalRef.current?.offsetHeight || (casaDraft ? 420 : 190)
      const nextHeight = typeof preferredHeight === 'number'
        ? Math.min(preferredHeight, availableHeight)
        : preferredHeight
      const boundsHeight = typeof nextHeight === 'number' ? nextHeight : Math.min(measuredHeight, availableHeight)
      setModalSize({ width: nextWidth, height: nextHeight })
      const centerX = Math.max((window.innerWidth - nextWidth) / 2, VIEWPORT_PADDING)
      const centerY = Math.max((window.innerHeight - boundsHeight) / 2, VIEWPORT_PADDING)
      if (isFirstOpenRef.current) {
        isFirstOpenRef.current = false
      }
      setModalPosition({ x: centerX, y: centerY })
    } else {
      const nextWidth = Math.min(MIN_WIDTH, availableWidth)
      const nextHeight = Math.min(MIN_HEIGHT, availableHeight)
      const centerX = Math.max((window.innerWidth - nextWidth) / 2, VIEWPORT_PADDING)
      const centerY = Math.max((window.innerHeight - nextHeight) / 2, VIEWPORT_PADDING)
      setModalSize({ width: nextWidth, height: nextHeight })
      if (isFirstOpenRef.current) {
        isFirstOpenRef.current = false
      }
      setModalPosition({ x: centerX, y: centerY })
    }
  }, [open, step, casaDraft])

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!modalDrag.current.active) return
      event.preventDefault()
      const newX = event.clientX - modalDrag.current.offsetX
      const newY = event.clientY - modalDrag.current.offsetY
      const maxX = Math.max(window.innerWidth - modalSizeRef.current.width - VIEWPORT_PADDING, VIEWPORT_PADDING)
      const modalHeight = typeof modalSizeRef.current.height === 'number'
        ? modalSizeRef.current.height
        : (modalRef.current?.offsetHeight || 0)
      const maxY = Math.max(window.innerHeight - modalHeight - VIEWPORT_PADDING, VIEWPORT_PADDING)
      setModalPosition({
        x: clamp(newX, VIEWPORT_PADDING, maxX),
        y: clamp(newY, VIEWPORT_PADDING, maxY),
      })
    }
    const handleMouseUp = () => { modalDrag.current.active = false }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const handleModalMouseDown = (event) => {
    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    modalDrag.current = { active: true, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top }
  }

  const notifyError = useCallback((message) => {
    const clean = String(message || '').trim()
    if (!clean) return
    toastRef.current?.show({ severity: 'error', summary: 'Error', detail: clean, life: 4000 })
  }, [])

  const reset = useCallback(() => {
    setStep('casa')
    setActiveTab('general')
    setDetailDraft({ producto: null, cantidad: '' })
    setNextCode('IMP-')
    setSelectedCasa(null)
    setCasaDraft(null)
    setCasaQuery('')
    setCasaOptions([])
    setShowCasaDropdown(false)
    setProductQuery('')
    setProductOptions([])
    setShowProductDropdown(false)
    setDetails([])
    setSubmitting(false)
    setInvalidQtyKeys(new Set())
    setShowAceptadosView(false)
    setAceptadosItems([])
    setAceptadosLoading(false)
    setAceptadosSelected(new Set())
    setAceptadosSearch('')
    setAceptadosCount(null)
    setModalSize({ width: SELECTOR_WIDTH, height: SELECTOR_HEIGHT_EMPTY })
  }, [])

  useEffect(() => {
    if (!open) return
    reset()
  }, [open, reset])

  useEffect(() => {
    if (!open || !token) return
    let cancelled = false
    authFetch(`${API_URL}/importaciones/importaciones/next-code/`, {}, token)
      .then((response) => response.ok ? response.json() : Promise.reject(response))
      .then((payload) => {
        if (!cancelled) setNextCode(String(payload?.codigo || 'IMP-').trim() || 'IMP-')
      })
      .catch(() => {
        if (!cancelled) setNextCode('IMP-')
      })
    return () => { cancelled = true }
  }, [open, token])

  useEffect(() => {
    if (!selectedCasa?.id || !token) {
      setAceptadosCount(null)
      return undefined
    }
    let cancelled = false
    authFetch(`${API_URL}/solicitudes/solicitudes/aceptados-por-casa/?casa_comercial_id=${selectedCasa.id}`, {}, token)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((payload) => { if (!cancelled) setAceptadosCount(parseApiList(payload).length) })
      .catch(() => { if (!cancelled) setAceptadosCount(null) })
    return () => { cancelled = true }
  }, [selectedCasa?.id, token])

  useEffect(() => {
    if (!showAceptadosView || !selectedCasa?.id || !token) return undefined
    setAceptadosSelected(new Set())
    setAceptadosSearch('')
    setAceptadosLoading(true)
    let cancelled = false
    authFetch(`${API_URL}/solicitudes/solicitudes/aceptados-por-casa/?casa_comercial_id=${selectedCasa.id}`, {}, token)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((payload) => {
        if (!cancelled) {
          const loaded = parseApiList(payload)
          setAceptadosItems(loaded)
          setAceptadosSelected(new Set(
            loaded
              .filter((item) => item.producto_id
                ? alreadyAddedIds.has(String(item.producto_id))
                : alreadyAddedSolIds.has(String(item.solicitud_id)))
              .map((item) => item.solicitud_id)
          ))
        }
      })
      .catch(() => { if (!cancelled) setAceptadosItems([]) })
      .finally(() => { if (!cancelled) setAceptadosLoading(false) })
    return () => { cancelled = true }
  }, [showAceptadosView, selectedCasa?.id, token])

  useEffect(() => {
    if (!open) return undefined
    const handleMouseDown = (event) => {
      const inCasa = casaDropdownRef.current?.contains(event.target) || event.target.closest?.('[data-casa-portal]')
      if (!inCasa) setShowCasaDropdown(false)
      const inProduct = productDropdownRef.current?.contains(event.target) || event.target.closest?.('[data-product-portal]')
      if (!inProduct) setShowProductDropdown(false)
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    document.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  const searchCasas = useCallback((term) => {
    if (!token) return
    setCasaLoading(true)
    const params = new URLSearchParams()
    params.set('page_size', '10')
    params.set('tipo', 'importacion')
    if (term) params.set('search', term)

    authFetch(`${API_URL}/casa-comercial/casas/?${params.toString()}`, {}, token)
      .then(async (response) => {
        if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudieron cargar las casas comerciales.'))
        return response.json()
      })
      .then((payload) => setCasaOptions(parseApiList(payload)))
      .catch((error) => notifyError(error.message))
      .finally(() => setCasaLoading(false))
  }, [notifyError, token])

  useEffect(() => {
    if (!open || (!showCasaDropdown && step !== 'casa')) return undefined
    if (casaTimerRef.current) clearTimeout(casaTimerRef.current)
    casaTimerRef.current = setTimeout(() => searchCasas(casaQuery.trim()), 280)
    return () => clearTimeout(casaTimerRef.current)
  }, [casaQuery, open, searchCasas, showCasaDropdown, step])

  const searchProducts = useCallback((term) => {
    if (!token) return
    setProductLoading(true)
    const params = new URLSearchParams()
    params.set('page_size', '10')
    params.set('modulo', 'solicitudes')
    if (term) params.set('search', term)
    if (selectedCasa?.nombre) params.set('casa_comercial', selectedCasa.nombre)

    authFetch(`${API_URL}/productos/listado/?${params.toString()}`, {}, token)
      .then(async (response) => {
        if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudieron cargar los productos.'))
        return response.json()
      })
      .then((payload) => {
        const selectedIds = new Set(details.filter((item) => item.producto?.id).map((item) => String(item.producto.id)))
        setProductOptions(parseApiList(payload).filter((product) => !selectedIds.has(String(product.id))))
      })
      .catch((error) => notifyError(error.message))
      .finally(() => setProductLoading(false))
  }, [details, notifyError, selectedCasa, token])

  useEffect(() => {
    if (!open || !showProductDropdown) return undefined
    if (productTimerRef.current) clearTimeout(productTimerRef.current)
    productTimerRef.current = setTimeout(() => searchProducts(productQuery.trim()), 280)
    return () => clearTimeout(productTimerRef.current)
  }, [open, productQuery, searchProducts, showProductDropdown])

  const handleAddProduct = (product, cantidad = '') => {
    const normalizedQuantity = Number(cantidad)
    if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
      return
    }
    if (details.some((d) => d.producto?.id && String(d.producto.id) === String(product.id))) {
      toastRef.current?.show({ severity: 'warn', summary: 'Advertencia', detail: 'Este producto ya fue agregado.', life: 3000 })
      return
    }
    setDetails((prev) => [
      ...prev,
      {
        _key: String(product.id),
        producto: product,
        cantidad: String(cantidad).trim(),
      },
    ])
    setProductQuery('')
    setProductOptions([])
    setShowProductDropdown(false)
  }

  const handleQuantityChange = (_key, value) => {
    const clean = String(value || '').replace(/[^\d]/g, '')
    setDetails((prev) =>
      prev.map((item) =>
        item._key === _key
          ? { ...item, cantidad: clean }
          : item
      )
    )
    if (invalidQtyKeys.has(_key)) {
      setInvalidQtyKeys((prev) => { const next = new Set(prev); next.delete(_key); return next })
    }
  }

  const handleSubmit = async () => {
    if (!selectedCasa?.id) {
      notifyError('Selecciona una casa comercial.')
      return
    }
    if (!details.length) {
      setLocalError('')
      return
    }
    const normalizedDetails = details.map((item) => {
      if (item.producto?.id) {
        return { producto_id: item.producto.id, cantidad: Number(item.cantidad || 0) }
      }
      return { codigo: item.codigo || '', nombre: item.nombre || '', oem: item.oem || '', cantidad: Number(item.cantidad || 0) }
    })
    const badKeys = new Set(
      details
        .filter((item) => { const n = Number(item.cantidad || 0); return !Number.isFinite(n) || n <= 0 })
        .map((item) => item._key)
    )
    if (badKeys.size > 0) {
      setInvalidQtyKeys(badKeys)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'Todas las cantidades deben ser mayores a cero.', life: 4000 })
      return
    }

    setSubmitting(true)
    try {
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/`,
        {
          method: 'POST',
          body: JSON.stringify({
            casa_comercial_id: selectedCasa.id,
            detalles: normalizedDetails,
          }),
        },
        token
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo crear la importacion.'))
      const payload = await response.json()
      onCreated?.(payload)
      onClose?.()
    } catch (error) {
      notifyError(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  const alreadyAddedIds = useMemo(
    () => new Set(details.filter((d) => d.producto?.id).map((d) => String(d.producto.id))),
    [details]
  )

  const alreadyAddedSolIds = useMemo(
    () => new Set(details.filter((d) => !d.producto?.id && d._solId).map((d) => String(d._solId))),
    [details]
  )

  const filteredAceptados = useMemo(() => {
    const q = aceptadosSearch.trim().toLowerCase()
    if (!q) return aceptadosItems
    return aceptadosItems.filter((item) =>
      String(item.codigo || '').toLowerCase().includes(q) ||
      String(item.nombre || '').toLowerCase().includes(q) ||
      String(item.solicitud_codigo || '').toLowerCase().includes(q) ||
      (item.oem_codigos || []).some((oem) => String(oem).toLowerCase().includes(q))
    )
  }, [aceptadosItems, aceptadosSearch])

  const allSelectableSelected = filteredAceptados.length > 0 && filteredAceptados.every((item) => aceptadosSelected.has(item.solicitud_id))

  const handleToggleAceptado = (solId) => {
    setAceptadosSelected((prev) => {
      const next = new Set(prev)
      if (next.has(solId)) next.delete(solId)
      else next.add(solId)
      return next
    })
  }

  const handleToggleAllAceptados = () => {
    if (allSelectableSelected) {
      setAceptadosSelected(new Set())
    } else {
      setAceptadosSelected(new Set(filteredAceptados.map((i) => i.solicitud_id)))
    }
  }

  const handleConfirmAceptados = () => {
    const toRemove = aceptadosItems.filter((item) => {
      const wasAdded = item.producto_id
        ? alreadyAddedIds.has(String(item.producto_id))
        : alreadyAddedSolIds.has(String(item.solicitud_id))
      return wasAdded && !aceptadosSelected.has(item.solicitud_id)
    })
    const toAdd = aceptadosItems.filter((item) => {
      const wasAdded = item.producto_id
        ? alreadyAddedIds.has(String(item.producto_id))
        : alreadyAddedSolIds.has(String(item.solicitud_id))
      return !wasAdded && aceptadosSelected.has(item.solicitud_id)
    })
    if (toRemove.length > 0) {
      setDetails((prev) => prev.filter((d) => {
        if (d.producto?.id) return !toRemove.some((r) => r.producto_id && String(r.producto_id) === String(d.producto.id))
        return !toRemove.some((r) => !r.producto_id && String(r.solicitud_id) === String(d._solId))
      }))
    }
    if (toAdd.length > 0) handleAddFromAceptados(toAdd)
    setShowAceptadosView(false)
  }

  const handleAddFromAceptados = useCallback((aceptados) => {
    setDetails((prev) => {
      const next = [...prev]
      for (const item of aceptados) {
        if (item.producto_id) {
          const pid = String(item.producto_id)
          const existingIdx = next.findIndex((d) => d._key === pid)
          if (existingIdx >= 0) {
            const merged = { ...next[existingIdx] }
            merged.cantidad = String(Number(merged.cantidad || 0) + Number(item.cantidad || 0))
            next[existingIdx] = merged
          } else {
            next.push({
              _key: pid,
              producto: { id: item.producto_id, codigo: item.codigo, nombre: item.nombre, oem: (item.oem_codigos || []).join(', ') },
              cantidad: String(item.cantidad || ''),
            })
          }
        } else {
          const solKey = 'sol_' + item.solicitud_id
          const existingIdx = next.findIndex((d) => d._key === solKey)
          if (existingIdx >= 0) {
            const merged = { ...next[existingIdx] }
            merged.cantidad = String(Number(merged.cantidad || 0) + Number(item.cantidad || 0))
            next[existingIdx] = merged
          } else {
            next.push({
              _key: solKey,
              _solId: item.solicitud_id,
              producto: null,
              codigo: item.codigo || '',
              nombre: item.nombre || '',
              oem: (item.oem_codigos || []).join(', '),
              cantidad: String(item.cantidad || ''),
            })
          }
        }
      }
      return next
    })
  }, [])

  if (!open) return null

  return (
    <>
    <Toast ref={toastRef} baseZIndex={12100} />
    <div
      className="create-user__overlay"
      role="dialog"
      aria-modal="true"
      style={{ padding: `${VIEWPORT_PADDING}px` }}
    >
      <div
        ref={modalRef}
        className={`create-user__modal${step === 'casa' ? ' importaciones-modal--selector' : ''}`}
        style={{
          top: modalPosition.y,
          left: modalPosition.x,
          width: modalSize.width,
          height: modalSize.height,
          minWidth: 0,
          minHeight: 0,
          maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
          maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
        }}
      >
        <header className="create-user__header" onMouseDown={handleModalMouseDown}>
          <div className="create-user__header-text">
            <h3>Crear borrador</h3>
          </div>
          <div className="create-user__header-actions">
            <button
              type="button"
              className="create-user__icon-button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onClose}
              disabled={submitting}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <form
          className={`create-user__form${step === 'casa' ? ' importaciones-modal__selector-form' : ''}`}
          noValidate
          onSubmit={(e) => { e.preventDefault(); handleSubmit() }}
        >
          {step === 'casa' ? (
            <div className="create-salida__selector-shell" style={{ flex: 'none', overflow: 'visible' }}>
              <section className="create-user__section create-salida__selector-card">
                <div className="create-user__section-header">
                  <div>
                    <h4>Selecciona la casa comercial</h4>
                  </div>
                </div>
                <div className="create-salida__selector-inner">
                  <div className="create-user__field create-salida__selector-field">
                    <div
                      className="create-user__dropdown"
                      ref={casaDropdownRef}
                      style={{ width: '100%' }}
                    >
                      <div
                        className="create-user__dropdown-trigger"
                        style={{ cursor: 'text', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px' }}
                        onClick={() => setShowCasaDropdown(true)}
                      >
                        <i className="pi pi-search" style={{ color: 'var(--color-muted, #888)', flexShrink: 0 }} />
                        <input
                          type="text"
                          placeholder="Busca por nombre, código o país..."
                          value={casaQuery}
                          onChange={(e) => {
                            setCasaQuery(e.target.value)
                            setCasaDraft(null)
                            setShowCasaDropdown(true)
                          }}
                          onFocus={() => setShowCasaDropdown(true)}
                          style={{ border: 'none', outline: 'none', flex: 1, background: 'transparent', fontSize: 'inherit', color: 'inherit' }}
                          autoComplete="off"
                        />
                        {casaLoading && <i className="pi pi-spin pi-spinner" style={{ flexShrink: 0 }} />}
                      </div>
                    </div>

                    {showCasaDropdown && casaPanelStyle && createPortal(
                      <div data-casa-portal className="create-user__dropdown-panel" style={casaPanelStyle}>
                        <div className="create-user__dropdown-results">
                          {casaLoading && <small className="muted">Buscando...</small>}
                          {!casaLoading && !casaOptions.length && (
                            <small className="muted">
                              {casaQuery.trim() ? 'Sin resultados.' : 'Escribe para buscar.'}
                            </small>
                          )}
                          {casaOptions.map((casa) => (
                            <button
                              key={casa.id}
                              type="button"
                              className="create-user__result-option"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                setCasaDraft(casa)
                                setCasaQuery('')
                                setShowCasaDropdown(false)
                                setCasaOptions([])
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

                  {casaDraft && (
                    <div className="create-salida__field-group create-salida__field-group--defined" style={{ marginTop: '14px' }}>
                      <div className="create-user__grid create-user__grid--two">
                        <StaticFieldDisplay label="Código" value={casaDraft.codigo} />
                        <StaticFieldDisplay label="Nombre" value={casaDraft.nombre} />
                        <div className="create-user__field create-salida__static-field">
                          <span>País</span>
                          <div className="create-salida__static-value" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {(() => {
                              const flagUrl = getFlagUrl(casaDraft.pais?.codigo_pais)
                              return (
                                <span className={`create-user__flag${flagUrl ? '' : ' is-empty'}`} aria-hidden="true" style={{ flexShrink: 0 }}>
                                  {flagUrl ? <img src={flagUrl} alt="" /> : '□'}
                                </span>
                              )
                            })()}
                            {String(casaDraft.pais?.nombre || '—').trim()}
                          </div>
                        </div>
                        <StaticFieldDisplay
                          label="Días de entrega"
                          value={casaDraft.dias_entrega != null ? `${casaDraft.dias_entrega} días` : ''}
                        />
                        {casaDraft.descripcion && (
                          <StaticFieldDisplay label="Descripción" value={casaDraft.descripcion} fullWidth />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>
          ) : (
            <>
              <div className="create-user__tabs create-salida__tabs" role="tablist">
                <button
                  type="button"
                  className={`create-user__tab${activeTab === 'productos' ? ' create-user__tab--active' : ''}`}
                  onClick={() => setActiveTab('productos')}
                >
                  Productos {details.length > 0 && `(${details.length})`}
                </button>
                <button
                  type="button"
                  className={`create-user__tab${activeTab === 'general' ? ' create-user__tab--active' : ''}`}
                  onClick={() => setActiveTab('general')}
                >
                  General
                </button>
              </div>

              <div className="create-user__content create-salida__content">
                <div className="create-user__body">
                  {activeTab === 'general' && (
                    <section className="create-user__section">
                      <div className="create-user__section-header">
                        <div>
                          <p className="create-user__eyebrow">General</p>
                          <h4>Información de la importación</h4>
                        </div>
                      </div>
                      <div className="create-salida__field-groups">
                        <div className="create-salida__field-group create-salida__field-group--defined">
                          <div className="create-user__grid create-user__grid--two">
                            <StaticFieldDisplay label="Código" value={nextCode} />
                            <StaticFieldDisplay label="Fecha" value={formatDate(todayISO())} />
                            <StaticFieldDisplay label="Casa comercial" value={formatCasaLabel(selectedCasa)} fullWidth />
                            <StaticFieldDisplay
                              label="Días de entrega"
                              value={selectedCasa?.dias_entrega != null ? `${selectedCasa.dias_entrega} días` : ''}
                            />
                            {selectedCasa?.pais?.nombre && (
                              <div className="create-user__field create-salida__static-field">
                                <span>País</span>
                                <div className="create-salida__static-value" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  {(() => {
                                    const flagUrl = getFlagUrl(selectedCasa.pais?.codigo_pais)
                                    return (
                                      <span className={`create-user__flag${flagUrl ? '' : ' is-empty'}`} aria-hidden="true" style={{ flexShrink: 0 }}>
                                        {flagUrl ? <img src={flagUrl} alt="" /> : '□'}
                                      </span>
                                    )
                                  })()}
                                  {String(selectedCasa.pais.nombre).trim()}
                                </div>
                              </div>
                            )}
                            {selectedCasa?.descripcion && (
                              <StaticFieldDisplay label="Descripción" value={selectedCasa.descripcion} fullWidth />
                            )}
                          </div>
                        </div>
                      </div>
                    </section>
                  )}

                  {activeTab === 'productos' && !showAceptadosView && (
                    <section className="create-user__section">
                      <div className="create-user__section-header">
                        <div>
                          <p className="create-user__eyebrow">Productos</p>
                          <h4>Listado de productos</h4>
                        </div>
                        <span title={aceptadosCount === 0 ? 'No hay productos aceptados para esta casa comercial' : undefined}>
                          <button
                            type="button"
                            className="create-user__ghost"
                            onClick={() => setShowAceptadosView(true)}
                            style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}
                            disabled={aceptadosCount === 0}
                          >
                            + Aceptados de solicitudes
                          </button>
                        </span>
                      </div>

                      <div className="create-user__locations-table create-salida__products-table create-salida__products-table--with-actions importaciones-modal__products-table">
                        <div className="create-user__locations-row create-user__locations-row--head">
                          <span>Código</span>
                          <span>Nombre</span>
                          <span>OEM</span>
                          <span>Cantidad</span>
                          <span>Acciones</span>
                        </div>

                        <div className="create-user__locations-row create-user__locations-row--form">
                          <span className="create-salida__product-picker create-salida__product-code-cell">
                            <div className="create-user__dropdown create-salida__product-dropdown" ref={productDropdownRef}>
                              <button
                                type="button"
                                className="create-user__dropdown-trigger"
                                onClick={() => {
                                  setShowProductDropdown((prev) => !prev)
                                  if (!showProductDropdown) { setProductQuery(''); searchProducts('') }
                                }}
                              >
                                <span>{detailDraft.producto ? String(detailDraft.producto.codigo || '').trim() : 'Selecciona un código'}</span>
                                <i className={`pi pi-chevron-${showProductDropdown ? 'up' : 'down'}`} />
                              </button>

                              {showProductDropdown && productPanelStyle && createPortal(
                                <div data-product-portal className="create-user__dropdown-panel" style={productPanelStyle}>
                                  <div className="create-user__dropdown-search">
                                    <i className="pi pi-search" />
                                    <input
                                      type="text"
                                      placeholder="Buscar código o nombre"
                                      value={productQuery}
                                      onChange={(e) => setProductQuery(e.target.value)}
                                      autoFocus
                                      autoComplete="off"
                                    />
                                  </div>
                                  <div className="create-user__dropdown-results">
                                    {productLoading && <small className="muted">Buscando productos...</small>}
                                    {!productLoading && !productQuery.trim() && !productOptions.length && (
                                      <small className="muted">Escribe para buscar.</small>
                                    )}
                                    {!productLoading && productQuery.trim() && !productOptions.length && (
                                      <small className="muted">Sin resultados.</small>
                                    )}
                                    {productOptions.length > 0 && (
                                      <div className="create-salida__results-header">
                                        <span>Código</span>
                                        <span>Nombre</span>
                                        <span>Stock</span>
                                      </div>
                                    )}
                                    {productOptions.map((product) => {
                                      const isAlreadyAdded = details.some((d) => d.producto?.id && String(d.producto.id) === String(product.id))
                                      const isSelected = String(detailDraft.producto?.id) === String(product.id)
                                      return (
                                        <button
                                          key={product.id}
                                          type="button"
                                          className={`create-salida__result-row${isSelected ? ' is-selected' : ''}${isAlreadyAdded ? ' is-added' : ''}`}
                                          onMouseDown={(e) => e.preventDefault()}
                                          onClick={() => {
                                            setDetailDraft({ producto: product, cantidad: '' })
                                            setProductQuery('')
                                            setShowProductDropdown(false)
                                            setProductOptions([])
                                          }}
                                          disabled={isAlreadyAdded}
                                          title={isAlreadyAdded ? 'Ya agregado' : undefined}
                                        >
                                          <span className="result-codigo">{String(product.codigo || '').trim()}</span>
                                          <span className="result-nombre">{String(product.nombre || '').trim()}</span>
                                          <span className="result-stock">{Number(product.total_stock ?? 0)}</span>
                                        </button>
                                      )
                                    })}
                                  </div>
                                </div>,
                                document.body
                              )}
                            </div>
                          </span>
                          <span className="create-salida__product-name-cell">
                            <span className="create-salida__table-static-value create-salida__table-static-value--name">
                              {detailDraft.producto ? String(detailDraft.producto.nombre || '').trim() : '-'}
                            </span>
                          </span>
                          <span className="create-salida__table-static-value">
                            {detailDraft.producto ? String(detailDraft.producto.oem || detailDraft.producto.referencia || '').trim() || '-' : '-'}
                          </span>
                          <span>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={detailDraft.cantidad}
                              onChange={(e) => setDetailDraft((prev) => ({ ...prev, cantidad: e.target.value }))}
                              disabled={!detailDraft.producto}
                            />
                          </span>
                          <span className="create-user__locations-cell create-user__locations-cell--action">
                            <button
                              type="button"
                              className="create-user__ghost"
                              disabled={!canAddDetailDraft}
                              onClick={() => {
                                if (!canAddDetailDraft) return
                                handleAddProduct(detailDraft.producto, detailDraft.cantidad)
                                setDetailDraft({ producto: null, cantidad: '' })
                              }}
                            >
                              Agregar
                            </button>
                          </span>
                        </div>

                        {!details.length ? (
                          <div className="create-user__locations-row create-user__locations-row--empty">
                            <span>Sin productos agregados.</span>
                          </div>
                        ) : details.map((item) => {
                          const sinCatalogo = !item.producto?.id
                          const codigo = item.producto?.codigo || item.codigo || '—'
                          const nombre = item.producto?.nombre || item.nombre || ''
                          const oem = String(item.producto?.oem || item.oem || item.producto?.referencia || '').trim() || '-'
                          return (
                            <div key={item._key} className={`create-user__locations-row${sinCatalogo ? ' importaciones-aceptados__row--no-catalogo' : ''}`}>
                              <span>
                                {codigo}
                                {sinCatalogo && <span className="importaciones-aceptados__no-catalogo-badge" style={{ marginLeft: 6 }}>Sin catálogo</span>}
                              </span>
                              <span title={nombre}>
                                <span className="create-salida__product-name-text">{nombre}</span>
                              </span>
                              <span>{oem}</span>
                              <span>
                                <input
                                  type="number"
                                  value={item.cantidad}
                                  onChange={(e) => handleQuantityChange(item._key, e.target.value)}
                                  style={invalidQtyKeys.has(item._key) ? { borderColor: '#ef4444' } : undefined}
                                />
                              </span>
                              <span className="create-user__locations-cell create-user__locations-cell--action">
                                <button
                                  type="button"
                                  className="create-user__locations-remove"
                                  onClick={() => setDetails((prev) => prev.filter((d) => d._key !== item._key))}
                                >
                                  x
                                </button>
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  )}

                </div>
              </div>
            </>
          )}

          <div className="create-user__footer">
            <div className="user-details__footer-left">
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={onClose}
                disabled={submitting}
              >
                Cancelar
              </button>
            </div>
            <div className="user-details__footer-right">
              {step === 'casa' ? (
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  disabled={!casaDraft}
                  onClick={() => {
                    setSelectedCasa(casaDraft)
                    setActiveTab('productos')
                    setStep('form')
                  }}
                >
                  Siguiente
                </button>
              ) : (
                <button
                  type="submit"
                  className="create-user__action create-user__action--primary"
                  disabled={submitting}
                >
                  {submitting ? 'Guardando...' : 'Guardar proceso'}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>

      {showAceptadosView && createPortal(
        <div className="imp-aceptados-popup__overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAceptadosView(false) }}>
          <div className="imp-aceptados-popup__dialog">
            <header className="imp-aceptados-popup__header">
              <div>
                <h3>Aceptados de solicitudes</h3>
                {selectedCasa?.nombre && (
                  <p>{formatCasaLabel(selectedCasa)}</p>
                )}
              </div>
              <button type="button" className="imp-aceptados-popup__close" onClick={() => setShowAceptadosView(false)} aria-label="Cerrar">
                <i className="pi pi-times" />
              </button>
            </header>

            <div className="imp-aceptados-popup__search">
              <i className="pi pi-search" />
              <input
                type="text"
                placeholder="Buscar por código, nombre, OEM o solicitud..."
                value={aceptadosSearch}
                onChange={(e) => setAceptadosSearch(e.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="imp-aceptados-popup__body">
              <div className="create-user__locations-table importaciones-aceptados__table">
                <div className="create-user__locations-row create-user__locations-row--head">
                  <span>
                    <input type="checkbox" checked={allSelectableSelected} disabled={filteredAceptados.length === 0} onChange={handleToggleAllAceptados} title="Seleccionar todos" />
                  </span>
                  <span>Solicitud</span>
                  <span>Código JP</span>
                  <span>Nombre</span>
                  <span>OEMs</span>
                  <span>Cant.</span>
                </div>

                {aceptadosLoading && (
                  <div className="create-user__locations-row create-user__locations-row--empty"><span>Cargando...</span></div>
                )}
                {!aceptadosLoading && filteredAceptados.length === 0 && (
                  <div className="create-user__locations-row create-user__locations-row--empty">
                    <span>{aceptadosItems.length === 0 ? 'No hay productos aceptados.' : 'Sin resultados.'}</span>
                  </div>
                )}
                {!aceptadosLoading && filteredAceptados.map((item) => {
                  const noProducto = !item.producto_id
                  const isSelected = aceptadosSelected.has(item.solicitud_id)
                  const oemText = (item.oem_codigos || []).join(', ') || '-'
                  return (
                    <div
                      key={item.solicitud_id}
                      className={`create-user__locations-row importaciones-aceptados__row${isSelected ? ' importaciones-aceptados__row--selected' : ''}${noProducto ? ' importaciones-aceptados__row--no-catalogo' : ''}`}
                      style={{ cursor: 'pointer' }}
                      onClick={() => handleToggleAceptado(item.solicitud_id)}
                    >
                      <span>
                        <input type="checkbox" checked={isSelected} onChange={() => handleToggleAceptado(item.solicitud_id)} onClick={(e) => e.stopPropagation()} style={{ cursor: 'pointer' }} />
                      </span>
                      <span style={{ fontSize: '0.79rem', color: 'var(--color-muted, #888)' }}>
                        <span className="imp-cell-text">{item.solicitud_codigo || '-'}</span>
                      </span>
                      <span>
                        <span className="imp-cell-text">
                          {item.codigo || '-'}
                          {noProducto && <span className="importaciones-aceptados__no-catalogo-badge" title="Sin producto en catálogo">Sin catálogo</span>}
                        </span>
                      </span>
                      <span title={item.nombre}><span className="imp-cell-text">{item.nombre || '-'}</span></span>
                      <span style={{ fontSize: '0.8rem' }}><span className="imp-cell-text">{oemText}</span></span>
                      <span>{item.cantidad ?? '-'}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="imp-aceptados-popup__footer">
              <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setShowAceptadosView(false)}>Regresar</button>
              <button type="button" className="create-user__action create-user__action--primary" disabled={aceptadosSelected.size === 0} onClick={handleConfirmAceptados}>
                {aceptadosSelected.size > 0 ? `Agregar (${aceptadosSelected.size})` : 'Agregar'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
    </>
  )
}

function EditImportacionModal({ open, imp, token, onClose, onSaved, onOpenBorrador }) {
  const [activeTab, setActiveTab] = useState('productos')
  const [detailDraft, setDetailDraft] = useState({ producto: null, cantidad: '' })
  const [productQuery, setProductQuery] = useState('')
  const [productOptions, setProductOptions] = useState([])
  const [productLoading, setProductLoading] = useState(false)
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [details, setDetails] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [invalidQtyKeys, setInvalidQtyKeys] = useState(new Set())
  const [showAceptadosView, setShowAceptadosView] = useState(false)
  const [aceptadosItems, setAceptadosItems] = useState([])
  const [aceptadosLoading, setAceptadosLoading] = useState(false)
  const [aceptadosSelected, setAceptadosSelected] = useState(new Set())
  const [aceptadosSearch, setAceptadosSearch] = useState('')
  const [aceptadosCount, setAceptadosCount] = useState(null)
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const toastRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalSizeRef = useRef(modalSize)
  const productTimerRef = useRef(null)
  const productDropdownRef = useRef(null)
  const isFirstOpenRef = useRef(true)
  const [productPanelStyle, setProductPanelStyle] = useState(null)

  const selectedCasa = imp?.casa_comercial || null
  const detailDraftQuantity = Number(detailDraft.cantidad)
  const canAddDetailDraft = Boolean(
    detailDraft.producto && Number.isFinite(detailDraftQuantity) && detailDraftQuantity > 0
  )

  useEffect(() => { modalSizeRef.current = modalSize }, [modalSize])

  useLayoutEffect(() => {
    if (!open) { isFirstOpenRef.current = true; return }
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    const nextWidth = Math.min(MIN_WIDTH, availableWidth)
    const nextHeight = Math.min(MIN_HEIGHT, availableHeight)
    const centerX = Math.max((window.innerWidth - nextWidth) / 2, VIEWPORT_PADDING)
    const centerY = Math.max((window.innerHeight - nextHeight) / 2, VIEWPORT_PADDING)
    setModalSize({ width: nextWidth, height: nextHeight })
    if (isFirstOpenRef.current) isFirstOpenRef.current = false
    setModalPosition({ x: centerX, y: centerY })
  }, [open])

  useLayoutEffect(() => {
    if (!showProductDropdown || !productDropdownRef.current) { setProductPanelStyle(null); return }
    const rect = productDropdownRef.current.getBoundingClientRect()
    const panelMaxHeight = Math.min(280, window.innerHeight - rect.bottom - 8)
    const panelWidth = Math.min(Math.max(rect.width, 520), window.innerWidth - VIEWPORT_PADDING * 2)
    const panelLeft = clamp(rect.left, VIEWPORT_PADDING, Math.max(window.innerWidth - panelWidth - VIEWPORT_PADDING, VIEWPORT_PADDING))
    setProductPanelStyle({
      position: 'fixed', top: rect.bottom + 4, left: panelLeft, width: panelWidth,
      maxHeight: Math.max(panelMaxHeight, 120), zIndex: 9999,
    })
  }, [showProductDropdown, modalPosition])

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!modalDrag.current.active) return
      event.preventDefault()
      const newX = event.clientX - modalDrag.current.offsetX
      const newY = event.clientY - modalDrag.current.offsetY
      const maxX = Math.max(window.innerWidth - modalSizeRef.current.width - VIEWPORT_PADDING, VIEWPORT_PADDING)
      const modalHeight = typeof modalSizeRef.current.height === 'number'
        ? modalSizeRef.current.height : (modalRef.current?.offsetHeight || 0)
      const maxY = Math.max(window.innerHeight - modalHeight - VIEWPORT_PADDING, VIEWPORT_PADDING)
      setModalPosition({ x: clamp(newX, VIEWPORT_PADDING, maxX), y: clamp(newY, VIEWPORT_PADDING, maxY) })
    }
    const handleMouseUp = () => { modalDrag.current.active = false }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp) }
  }, [])

  const handleModalMouseDown = (event) => {
    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    modalDrag.current = { active: true, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top }
  }

  useEffect(() => {
    if (!open || !imp) return
    const loaded = (imp.detalles || []).map((d, i) => {
      if (d.producto?.id) {
        return { _key: String(d.producto.id), producto: d.producto, cantidad: String(d.cantidad || '') }
      }
      return {
        _key: 'sc_' + (d.id ?? i), producto: null,
        codigo: d.codigo || '', nombre: d.nombre || '', oem: d.oem || '',
        cantidad: String(d.cantidad || ''),
      }
    })
    setDetails(loaded)
    setDetailDraft({ producto: null, cantidad: '' })
    setActiveTab('productos')
    setInvalidQtyKeys(new Set())
    setShowAceptadosView(false)
    setAceptadosItems([])
    setAceptadosSelected(new Set())
    setAceptadosSearch('')
  }, [open, imp])

  useEffect(() => {
    if (!open) return undefined
    const handleMouseDown = (event) => {
      const inProduct = productDropdownRef.current?.contains(event.target) || event.target.closest?.('[data-product-portal-edit]')
      if (!inProduct) setShowProductDropdown(false)
    }
    const handleKeyDown = (event) => { if (event.key === 'Escape') onClose?.() }
    document.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => { document.removeEventListener('mousedown', handleMouseDown); window.removeEventListener('keydown', handleKeyDown) }
  }, [open, onClose])

  useEffect(() => {
    if (!selectedCasa?.id || !token || !open) { setAceptadosCount(null); return undefined }
    let cancelled = false
    authFetch(`${API_URL}/solicitudes/solicitudes/aceptados-por-casa/?casa_comercial_id=${selectedCasa.id}`, {}, token)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((payload) => { if (!cancelled) setAceptadosCount(parseApiList(payload).length) })
      .catch(() => { if (!cancelled) setAceptadosCount(null) })
    return () => { cancelled = true }
  }, [open, selectedCasa?.id, token])

  useEffect(() => {
    if (!showAceptadosView || !selectedCasa?.id || !token) return undefined
    setAceptadosSelected(new Set())
    setAceptadosSearch('')
    setAceptadosLoading(true)
    let cancelled = false
    authFetch(`${API_URL}/solicitudes/solicitudes/aceptados-por-casa/?casa_comercial_id=${selectedCasa.id}`, {}, token)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((payload) => {
        if (!cancelled) {
          const loaded = parseApiList(payload)
          setAceptadosItems(loaded)
          setAceptadosSelected(new Set(
            loaded
              .filter((item) => item.producto_id
                ? alreadyAddedIds.has(String(item.producto_id))
                : alreadyAddedSolIds.has(String(item.solicitud_id)))
              .map((item) => item.solicitud_id)
          ))
        }
      })
      .catch(() => { if (!cancelled) setAceptadosItems([]) })
      .finally(() => { if (!cancelled) setAceptadosLoading(false) })
    return () => { cancelled = true }
  }, [showAceptadosView, selectedCasa?.id, token])

  const searchProducts = useCallback((term) => {
    if (!token) return
    setProductLoading(true)
    const params = new URLSearchParams()
    params.set('page_size', '10')
    params.set('modulo', 'solicitudes')
    if (term) params.set('search', term)
    if (selectedCasa?.nombre) params.set('casa_comercial', selectedCasa.nombre)
    authFetch(`${API_URL}/productos/listado/?${params.toString()}`, {}, token)
      .then(async (response) => {
        if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudieron cargar los productos.'))
        return response.json()
      })
      .then((payload) => {
        const selectedIds = new Set(details.filter((item) => item.producto?.id).map((item) => String(item.producto.id)))
        setProductOptions(parseApiList(payload).filter((product) => !selectedIds.has(String(product.id))))
      })
      .catch((error) => toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 }))
      .finally(() => setProductLoading(false))
  }, [details, selectedCasa, token])

  useEffect(() => {
    if (!open || !showProductDropdown) return undefined
    if (productTimerRef.current) clearTimeout(productTimerRef.current)
    productTimerRef.current = setTimeout(() => searchProducts(productQuery.trim()), 280)
    return () => clearTimeout(productTimerRef.current)
  }, [open, productQuery, searchProducts, showProductDropdown])

  const handleAddProduct = (product, cantidad = '') => {
    const n = Number(cantidad)
    if (!Number.isFinite(n) || n <= 0) return
    if (details.some((d) => d.producto?.id && String(d.producto.id) === String(product.id))) {
      toastRef.current?.show({ severity: 'warn', summary: 'Advertencia', detail: 'Este producto ya fue agregado.', life: 3000 })
      return
    }
    setDetails((prev) => [...prev, { _key: String(product.id), producto: product, cantidad: String(cantidad).trim() }])
    setProductQuery('')
    setProductOptions([])
    setShowProductDropdown(false)
    setDetailDraft({ producto: null, cantidad: '' })
  }

  const handleQuantityChange = (_key, value) => {
    const clean = String(value || '').replace(/[^\d]/g, '')
    setDetails((prev) => prev.map((item) => item._key === _key ? { ...item, cantidad: clean } : item))
    if (invalidQtyKeys.has(_key)) {
      setInvalidQtyKeys((prev) => { const next = new Set(prev); next.delete(_key); return next })
    }
  }

  const handleSubmit = async () => {
    if (!details.length) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'Agrega al menos un producto.', life: 4000 })
      return
    }
    const badKeys = new Set(
      details.filter((item) => { const n = Number(item.cantidad || 0); return !Number.isFinite(n) || n <= 0 }).map((item) => item._key)
    )
    if (badKeys.size > 0) {
      setInvalidQtyKeys(badKeys)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'Todas las cantidades deben ser mayores a cero.', life: 4000 })
      return
    }
    const normalizedDetails = details.map((item) => {
      if (item.producto?.id) return { producto_id: item.producto.id, cantidad: Number(item.cantidad || 0) }
      return { codigo: item.codigo || '', nombre: item.nombre || '', oem: item.oem || '', cantidad: Number(item.cantidad || 0) }
    })
    setSubmitting(true)
    try {
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/`,
        { method: 'PATCH', body: JSON.stringify({ detalles: normalizedDetails }) },
        token
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo guardar la importación.'))
      const payload = await response.json()
      onSaved?.(payload)
      onClose?.()
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 })
    } finally {
      setSubmitting(false)
    }
  }

  const alreadyAddedIds = useMemo(
    () => new Set(details.filter((d) => d.producto?.id).map((d) => String(d.producto.id))),
    [details]
  )
  const alreadyAddedSolIds = useMemo(
    () => new Set(details.filter((d) => !d.producto?.id && d._solId).map((d) => String(d._solId))),
    [details]
  )

  const filteredAceptados = useMemo(() => {
    const q = aceptadosSearch.trim().toLowerCase()
    if (!q) return aceptadosItems
    return aceptadosItems.filter((item) =>
      String(item.codigo || '').toLowerCase().includes(q) ||
      String(item.nombre || '').toLowerCase().includes(q) ||
      String(item.solicitud_codigo || '').toLowerCase().includes(q) ||
      (item.oem_codigos || []).some((oem) => String(oem).toLowerCase().includes(q))
    )
  }, [aceptadosItems, aceptadosSearch])

  const allSelectableSelected = filteredAceptados.length > 0 && filteredAceptados.every((item) => aceptadosSelected.has(item.solicitud_id))

  const handleToggleAceptado = (solId) => {
    setAceptadosSelected((prev) => { const next = new Set(prev); if (next.has(solId)) next.delete(solId); else next.add(solId); return next })
  }
  const handleToggleAllAceptados = () => {
    if (allSelectableSelected) setAceptadosSelected(new Set())
    else setAceptadosSelected(new Set(filteredAceptados.map((i) => i.solicitud_id)))
  }
  const handleConfirmAceptados = () => {
    const toRemove = aceptadosItems.filter((item) => {
      const wasAdded = item.producto_id
        ? alreadyAddedIds.has(String(item.producto_id))
        : alreadyAddedSolIds.has(String(item.solicitud_id))
      return wasAdded && !aceptadosSelected.has(item.solicitud_id)
    })
    const toAdd = aceptadosItems.filter((item) => {
      const wasAdded = item.producto_id
        ? alreadyAddedIds.has(String(item.producto_id))
        : alreadyAddedSolIds.has(String(item.solicitud_id))
      return !wasAdded && aceptadosSelected.has(item.solicitud_id)
    })
    if (toRemove.length > 0) {
      setDetails((prev) => prev.filter((d) => {
        if (d.producto?.id) return !toRemove.some((r) => r.producto_id && String(r.producto_id) === String(d.producto.id))
        return !toRemove.some((r) => !r.producto_id && String(r.solicitud_id) === String(d._solId))
      }))
    }
    if (toAdd.length > 0) handleAddFromAceptados(toAdd)
    setShowAceptadosView(false)
  }
  const handleAddFromAceptados = useCallback((aceptados) => {
    setDetails((prev) => {
      const next = [...prev]
      for (const item of aceptados) {
        if (item.producto_id) {
          const pid = String(item.producto_id)
          const idx = next.findIndex((d) => d._key === pid)
          if (idx >= 0) {
            const merged = { ...next[idx] }
            merged.cantidad = String(Number(merged.cantidad || 0) + Number(item.cantidad || 0))
            next[idx] = merged
          } else {
            next.push({
              _key: pid,
              producto: { id: item.producto_id, codigo: item.codigo, nombre: item.nombre, oem: (item.oem_codigos || []).join(', ') },
              cantidad: String(item.cantidad || ''),
            })
          }
        } else {
          const solKey = 'sol_' + item.solicitud_id
          const idx = next.findIndex((d) => d._key === solKey)
          if (idx >= 0) {
            const merged = { ...next[idx] }
            merged.cantidad = String(Number(merged.cantidad || 0) + Number(item.cantidad || 0))
            next[idx] = merged
          } else {
            next.push({
              _key: solKey, _solId: item.solicitud_id, producto: null,
              codigo: item.codigo || '', nombre: item.nombre || '',
              oem: (item.oem_codigos || []).join(', '), cantidad: String(item.cantidad || ''),
            })
          }
        }
      }
      return next
    })
  }, [])

  if (!open || !imp) return null

  return (
    <>
      <Toast ref={toastRef} baseZIndex={12100} />
      <div className="create-user__overlay" role="dialog" aria-modal="true" style={{ padding: `${VIEWPORT_PADDING}px` }}>
        <div
          ref={modalRef}
          className="create-user__modal"
          style={{
            top: modalPosition.y, left: modalPosition.x,
            width: modalSize.width, height: modalSize.height,
            minWidth: 0, minHeight: 0,
            maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
            maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
          }}
        >
          <header className="create-user__header" onMouseDown={handleModalMouseDown}>
            <div className="create-user__header-text">
              <h3>Borrador: {imp.codigo}</h3>
            </div>
            <div className="create-user__header-actions">
              <button type="button" className="create-user__icon-button" onMouseDown={(e) => e.stopPropagation()} onClick={onClose} disabled={submitting} aria-label="Cerrar">
                <i className="pi pi-times" aria-hidden="true" />
              </button>
            </div>
          </header>

          <form className="create-user__form" noValidate onSubmit={(e) => { e.preventDefault(); handleSubmit() }}>
            <div className="create-user__tabs create-salida__tabs" role="tablist">
              <button type="button" className={`create-user__tab${activeTab === 'productos' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('productos')}>
                Productos {details.length > 0 && `(${details.length})`}
              </button>
              <button type="button" className={`create-user__tab${activeTab === 'general' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('general')}>
                General
              </button>
            </div>

            <div className="create-user__content create-salida__content">
              <div className="create-user__body">
                {activeTab === 'general' && (
                  <section className="create-user__section">
                    <div className="create-user__section-header">
                      <div>
                        <p className="create-user__eyebrow">General</p>
                        <h4>Información de la importación</h4>
                      </div>
                    </div>
                    <div className="create-salida__field-groups">
                      <div className="create-salida__field-group create-salida__field-group--defined">
                        <div className="create-user__grid create-user__grid--two">
                          <StaticFieldDisplay label="Código" value={imp.codigo} />
                          <StaticFieldDisplay label="Fecha" value={imp.fecha || '-'} />
                          <StaticFieldDisplay label="Casa comercial" value={formatCasaLabel(selectedCasa)} fullWidth />
                          <StaticFieldDisplay
                            label="Días de entrega"
                            value={imp.dias_entrega_estimados != null ? `${imp.dias_entrega_estimados} días` : ''}
                          />
                          {selectedCasa?.pais?.nombre && (
                            <div className="create-user__field create-salida__static-field">
                              <span>País</span>
                              <div className="create-salida__static-value" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                {(() => {
                                  const flagUrl = getFlagUrl(selectedCasa.pais?.codigo_pais)
                                  return (
                                    <span className={`create-user__flag${flagUrl ? '' : ' is-empty'}`} aria-hidden="true" style={{ flexShrink: 0 }}>
                                      {flagUrl ? <img src={flagUrl} alt="" /> : '□'}
                                    </span>
                                  )
                                })()}
                                {String(selectedCasa.pais.nombre).trim()}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </section>
                )}

                {activeTab === 'productos' && !showAceptadosView && (
                  <section className="create-user__section">
                    <div className="create-user__section-header">
                      <div>
                        <p className="create-user__eyebrow">Productos</p>
                        <h4>Listado de productos</h4>
                      </div>
                      <span title={aceptadosCount === 0 ? 'No hay productos aceptados para esta casa comercial' : undefined}>
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={() => setShowAceptadosView(true)}
                          style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}
                          disabled={aceptadosCount === 0}
                        >
                          + Aceptados de solicitudes
                        </button>
                      </span>
                    </div>

                    <div className="create-user__locations-table create-salida__products-table create-salida__products-table--with-actions importaciones-modal__products-table">
                      <div className="create-user__locations-row create-user__locations-row--head">
                        <span>Código</span><span>Nombre</span><span>OEM</span><span>Cantidad</span><span>Acciones</span>
                      </div>

                      <div className="create-user__locations-row create-user__locations-row--form">
                        <span className="create-salida__product-picker create-salida__product-code-cell">
                          <div className="create-user__dropdown create-salida__product-dropdown" ref={productDropdownRef}>
                            <button
                              type="button"
                              className="create-user__dropdown-trigger"
                              onClick={() => {
                                setShowProductDropdown((prev) => !prev)
                                if (!showProductDropdown) { setProductQuery(''); searchProducts('') }
                              }}
                            >
                              <span>{detailDraft.producto ? String(detailDraft.producto.codigo || '').trim() : 'Selecciona un código'}</span>
                              <i className={`pi pi-chevron-${showProductDropdown ? 'up' : 'down'}`} />
                            </button>
                            {showProductDropdown && productPanelStyle && createPortal(
                              <div data-product-portal-edit className="create-user__dropdown-panel" style={productPanelStyle}>
                                <div className="create-user__dropdown-search">
                                  <i className="pi pi-search" />
                                  <input
                                    type="text"
                                    placeholder="Buscar código o nombre"
                                    value={productQuery}
                                    onChange={(e) => setProductQuery(e.target.value)}
                                    autoFocus
                                    autoComplete="off"
                                  />
                                </div>
                                <div className="create-user__dropdown-results">
                                  {productLoading && <small className="muted">Buscando productos...</small>}
                                  {!productLoading && !productQuery.trim() && !productOptions.length && <small className="muted">Escribe para buscar.</small>}
                                  {!productLoading && productQuery.trim() && !productOptions.length && <small className="muted">Sin resultados.</small>}
                                  {productOptions.length > 0 && (
                                    <div className="create-salida__results-header">
                                      <span>Código</span><span>Nombre</span><span>Stock</span>
                                    </div>
                                  )}
                                  {productOptions.map((product) => {
                                    const isAlreadyAdded = details.some((d) => d.producto?.id && String(d.producto.id) === String(product.id))
                                    const isSelected = String(detailDraft.producto?.id) === String(product.id)
                                    return (
                                      <button
                                        key={product.id}
                                        type="button"
                                        className={`create-salida__result-row${isSelected ? ' is-selected' : ''}${isAlreadyAdded ? ' is-added' : ''}`}
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => { setDetailDraft({ producto: product, cantidad: '' }); setProductQuery(''); setShowProductDropdown(false); setProductOptions([]) }}
                                        disabled={isAlreadyAdded}
                                        title={isAlreadyAdded ? 'Ya agregado' : undefined}
                                      >
                                        <span className="result-codigo">{String(product.codigo || '').trim()}</span>
                                        <span className="result-nombre">{String(product.nombre || '').trim()}</span>
                                        <span className="result-stock">{Number(product.total_stock ?? 0)}</span>
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>,
                              document.body
                            )}
                          </div>
                        </span>
                        <span className="create-salida__product-name-cell">
                          <span className="create-salida__table-static-value create-salida__table-static-value--name">
                            {detailDraft.producto ? String(detailDraft.producto.nombre || '').trim() : '-'}
                          </span>
                        </span>
                        <span className="create-salida__table-static-value">
                          {detailDraft.producto ? String(detailDraft.producto.oem || detailDraft.producto.referencia || '').trim() || '-' : '-'}
                        </span>
                        <span>
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={detailDraft.cantidad}
                            onChange={(e) => setDetailDraft((prev) => ({ ...prev, cantidad: e.target.value }))}
                            disabled={!detailDraft.producto}
                          />
                        </span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button
                            type="button"
                            className="create-user__ghost"
                            disabled={!canAddDetailDraft}
                            onClick={() => { if (!canAddDetailDraft) return; handleAddProduct(detailDraft.producto, detailDraft.cantidad); setDetailDraft({ producto: null, cantidad: '' }) }}
                          >
                            Agregar
                          </button>
                        </span>
                      </div>

                      {!details.length ? (
                        <div className="create-user__locations-row create-user__locations-row--empty"><span>Sin productos agregados.</span></div>
                      ) : details.map((item) => {
                        const sinCatalogo = !item.producto?.id
                        const codigo = item.producto?.codigo || item.codigo || '—'
                        const nombre = item.producto?.nombre || item.nombre || ''
                        const oem = String(item.producto?.oem || item.oem || item.producto?.referencia || '').trim() || '-'
                        return (
                          <div key={item._key} className={`create-user__locations-row${sinCatalogo ? ' importaciones-aceptados__row--no-catalogo' : ''}`}>
                            <span>
                              {codigo}
                              {sinCatalogo && <span className="importaciones-aceptados__no-catalogo-badge" style={{ marginLeft: 6 }}>Sin catálogo</span>}
                            </span>
                            <span title={nombre}><span className="create-salida__product-name-text">{nombre}</span></span>
                            <span>{oem}</span>
                            <span>
                              <input
                                type="number"
                                value={item.cantidad}
                                onChange={(e) => handleQuantityChange(item._key, e.target.value)}
                                style={invalidQtyKeys.has(item._key) ? { borderColor: '#ef4444' } : undefined}
                              />
                            </span>
                            <span className="create-user__locations-cell create-user__locations-cell--action">
                              <button
                                type="button"
                                className="create-user__locations-remove"
                                onClick={() => setDetails((prev) => prev.filter((d) => d._key !== item._key))}
                              >
                                x
                              </button>
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                )}
              </div>
            </div>

            <div className="create-user__footer">
              <div className="user-details__footer-left">
                <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose} disabled={submitting}>
                  Cancelar
                </button>
              </div>
              <div className="user-details__footer-right">
                <button type="submit" className="create-user__action create-user__action--primary" disabled={submitting}>
                  {submitting ? 'Guardando...' : 'Guardar cambios'}
                </button>
              </div>
            </div>
          </form>
        </div>

        {showAceptadosView && createPortal(
          <div className="imp-aceptados-popup__overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAceptadosView(false) }}>
            <div className="imp-aceptados-popup__dialog">
              <header className="imp-aceptados-popup__header">
                <div>
                  <h3>Aceptados de solicitudes</h3>
                  {selectedCasa?.nombre && <p>{formatCasaLabel(selectedCasa)}</p>}
                </div>
                <button type="button" className="imp-aceptados-popup__close" onClick={() => setShowAceptadosView(false)} aria-label="Cerrar">
                  <i className="pi pi-times" />
                </button>
              </header>
              <div className="imp-aceptados-popup__search">
                <i className="pi pi-search" />
                <input
                  type="text"
                  placeholder="Buscar por código, nombre, OEM o solicitud..."
                  value={aceptadosSearch}
                  onChange={(e) => setAceptadosSearch(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="imp-aceptados-popup__body">
                <div className="create-user__locations-table importaciones-aceptados__table">
                  <div className="create-user__locations-row create-user__locations-row--head">
                    <span>
                      <input type="checkbox" checked={allSelectableSelected} disabled={filteredAceptados.length === 0} onChange={handleToggleAllAceptados} title="Seleccionar todos" />
                    </span>
                    <span>Solicitud</span><span>Código JP</span><span>Nombre</span><span>OEMs</span><span>Cant.</span>
                  </div>
                  {aceptadosLoading && (
                    <div className="create-user__locations-row create-user__locations-row--empty"><span>Cargando...</span></div>
                  )}
                  {!aceptadosLoading && filteredAceptados.length === 0 && (
                    <div className="create-user__locations-row create-user__locations-row--empty">
                      <span>{aceptadosItems.length === 0 ? 'No hay productos aceptados.' : 'Sin resultados.'}</span>
                    </div>
                  )}
                  {!aceptadosLoading && filteredAceptados.map((item) => {
                    const noProducto = !item.producto_id
                    const isSelected = aceptadosSelected.has(item.solicitud_id)
                    const oemText = (item.oem_codigos || []).join(', ') || '-'
                    return (
                      <div
                        key={item.solicitud_id}
                        className={`create-user__locations-row importaciones-aceptados__row${isSelected ? ' importaciones-aceptados__row--selected' : ''}${noProducto ? ' importaciones-aceptados__row--no-catalogo' : ''}`}
                        style={{ cursor: 'pointer' }}
                        onClick={() => handleToggleAceptado(item.solicitud_id)}
                      >
                        <span>
                          <input type="checkbox" checked={isSelected} onChange={() => handleToggleAceptado(item.solicitud_id)} onClick={(e) => e.stopPropagation()} style={{ cursor: 'pointer' }} />
                        </span>
                        <span style={{ fontSize: '0.79rem', color: 'var(--color-muted, #888)' }}>
                          <span className="imp-cell-text">{item.solicitud_codigo || '-'}</span>
                        </span>
                        <span>
                          <span className="imp-cell-text">
                            {item.codigo || '-'}
                            {noProducto && <span className="importaciones-aceptados__no-catalogo-badge" title="Sin producto en catálogo">Sin catálogo</span>}
                          </span>
                        </span>
                        <span title={item.nombre}><span className="imp-cell-text">{item.nombre || '-'}</span></span>
                        <span style={{ fontSize: '0.8rem' }}><span className="imp-cell-text">{oemText}</span></span>
                        <span>{item.cantidad ?? '-'}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
              <div className="imp-aceptados-popup__footer">
                <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setShowAceptadosView(false)}>Regresar</button>
                <button type="button" className="create-user__action create-user__action--primary" disabled={aceptadosSelected.size === 0} onClick={handleConfirmAceptados}>
                  {aceptadosSelected.size > 0 ? `Agregar (${aceptadosSelected.size})` : 'Agregar'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      </div>
    </>
  )
}

function ImportacionesTable({ token, moduleActions, status: statusProp, onError, pendingOpenBorradorData, onPendingOpenBorradorHandled }) {
  const toast = useRef(null)
  const tableWrapperRef = useRef(null)
  const _widthsClearedRef = useRef(null)
  if (_widthsClearedRef.current === null) {
    _widthsClearedRef.current = true
    clearSavedColumnWidths('importaciones-table-state')
  }

  const [activeStatus, setActiveStatus] = useState('borrador')
  const status = statusProp || activeStatus
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [selectedImp, setSelectedImp] = useState(null)
  const [showImpDetails, setShowImpDetails] = useState(false)
  const [editImp, setEditImp] = useState(null)
  const [showEditImp, setShowEditImp] = useState(false)

  useEffect(() => {
    if (!pendingOpenBorradorData) return
    setEditImp(pendingOpenBorradorData)
    setShowEditImp(true)
    onPendingOpenBorradorHandled?.()
  }, [pendingOpenBorradorData]) // eslint-disable-line react-hooks/exhaustive-deps

  const [productHoverCard, setProductHoverCard] = useState(null)
  const productHoverHideTimerRef = useRef(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')
  const [isGlobalSearchPending, setIsGlobalSearchPending] = useState(false)
  const globalSearchDebounceRef = useRef(null)
  const [filters, setFilters] = useState({
    global: { value: null, matchMode: FilterMatchMode.CONTAINS },
  })
  const [pageFirst, setPageFirst] = useState(0)
  const pageSize = 25

  const statusConfig = STATUS_CONFIG[status] || STATUS_CONFIG.en_proceso
  const canCreate = moduleActions?.puede_crear !== false

  const normalizeList = useCallback((list) =>
    list.map((item) => {
      const detalles = item?.detalles || []
      const productos = detalles.map((d) => ({
        codigo: d.producto?.codigo || d.codigo || '-',
        nombre: d.producto?.nombre || d.nombre || '-',
        oem: d.producto?.oem || d.oem || '-',
        cantidad: d.cantidad ?? 0,
        sinCatalogo: !d.producto?.id,
      }))
      return {
        ...item,
        casa_nombre: item?.casa_comercial?.nombre ?? '-',
        productos_resumen: detalles.slice(0, 3).map((d) => `${d.producto?.codigo || d.codigo || 'Prod'} x${d.cantidad}`).join(', ') + (detalles.length > 3 ? ` +${detalles.length - 3}` : ''),
        productos,
      }
    })
  , [])

  const fetchItems = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    params.set('estado', status)
    params.set('page_size', '200')
    try {
      const response = await authFetch(`${API_URL}/importaciones/importaciones/?${params.toString()}`, {}, token)
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudieron cargar las importaciones.'))
      const payload = await response.json()
      setItems(normalizeList(parseApiList(payload)))
    } catch (err) {
      const message = err.message || 'No se pudieron cargar las importaciones.'
      setError(message)
      toast.current?.show({ severity: 'error', summary: 'Error', detail: message, life: 4000 })
    } finally {
      setLoading(false)
    }
  }, [normalizeList, status, token])

  useEffect(() => { fetchItems() }, [fetchItems])

  useEffect(() => {
    setPageFirst(0)
    setGlobalFilterValue('')
    setFilters({ global: { value: null, matchMode: FilterMatchMode.CONTAINS } })
  }, [status])

  const handleGlobalFilterChange = (event) => {
    const value = event.target.value
    setGlobalFilterValue(value)
    setPageFirst(0)
    if (globalSearchDebounceRef.current) clearTimeout(globalSearchDebounceRef.current)
    setIsGlobalSearchPending(true)
    globalSearchDebounceRef.current = setTimeout(() => {
      setFilters({ global: { value: value || null, matchMode: FilterMatchMode.CONTAINS } })
      setIsGlobalSearchPending(false)
    }, 350)
  }

  const handleStatusChange = (nextStatus) => {
    if (nextStatus === status) return
    setActiveStatus(nextStatus)
  }

  const clearProductHoverTimer = useCallback(() => {
    if (!productHoverHideTimerRef.current) return
    clearTimeout(productHoverHideTimerRef.current)
    productHoverHideTimerRef.current = null
  }, [])

  const hideProductHoverCard = useCallback(() => {
    clearProductHoverTimer()
    setProductHoverCard(null)
  }, [clearProductHoverTimer])

  const scheduleHideProductHoverCard = useCallback(() => {
    clearProductHoverTimer()
    productHoverHideTimerRef.current = setTimeout(() => {
      productHoverHideTimerRef.current = null
      setProductHoverCard(null)
    }, 120)
  }, [clearProductHoverTimer])

  const showProductHoverCard = useCallback((event, productos) => {
    const list = Array.isArray(productos) ? productos : []
    if (!list.length) { hideProductHoverCard(); return }
    clearProductHoverTimer()
    const rect = event?.currentTarget?.getBoundingClientRect?.()
    if (!rect) return
    let left = rect.right + 10
    if (left + IMP_HOVER_WIDTH > window.innerWidth - IMP_HOVER_MARGIN) {
      left = Math.max(IMP_HOVER_MARGIN, rect.left - IMP_HOVER_WIDTH - 10)
    }
    const top = Math.min(Math.max(rect.top - 8, IMP_HOVER_MARGIN), Math.max(window.innerHeight - 320, IMP_HOVER_MARGIN))
    setProductHoverCard({ left, top, productos: list })
  }, [clearProductHoverTimer, hideProductHoverCard])

  useEffect(() => () => clearProductHoverTimer(), [clearProductHoverTimer])
  useEffect(() => {
    const handler = () => hideProductHoverCard()
    window.addEventListener('scroll', handler, true)
    return () => window.removeEventListener('scroll', handler, true)
  }, [hideProductHoverCard])

  const importacionProductBodyTemplate = useCallback((rowData) => {
    const productos = Array.isArray(rowData?.productos) ? rowData.productos : []
    if (!productos.length) return <span style={{ color: '#9ca3af' }}>-</span>
    const visible = productos.slice(0, 3)
    const hasMore = productos.length > 3
    const codesText = visible.map((p) => p.oem || p.codigo).join(', ') + (hasMore ? '...' : '')
    return (
      <div className="movimientos-table__product-cell">
        <div className="movimientos-table__product-lines">
          <span className="movimientos-table__product-main" title={codesText}>{codesText}</span>
        </div>
        <button
          type="button"
          className="movimientos-table__product-eye"
          aria-label="Ver productos"
          onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={(e) => showProductHoverCard(e, productos)}
          onMouseLeave={scheduleHideProductHoverCard}
          onFocus={(e) => showProductHoverCard(e, productos)}
          onBlur={scheduleHideProductHoverCard}
        >
          <i className="pi pi-eye" />
        </button>
      </div>
    )
  }, [showProductHoverCard, scheduleHideProductHoverCard])

  const estadoBodyTemplate = useCallback((rowData) => {
    const badge = STATUS_BADGE[rowData?.estado] || { label: rowData?.estado || '-', color: '#64748b', bg: 'rgba(100,116,139,0.1)' }
    return (
      <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: badge.bg, color: badge.color, whiteSpace: 'nowrap' }}>
        {badge.label}
      </span>
    )
  }, [])

  const exportColumns = [
    { key: 'codigo', header: 'Importación' },
    { key: 'fecha', header: 'Fecha' },
    { key: 'casa_nombre', header: 'Casa comercial' },
    { key: 'estado_label', header: 'Estado' },
    { key: 'dias_entrega_estimados', header: 'Días estimados' },
    { key: 'prod_codigo', header: 'Código' },
    { key: 'prod_nombre', header: 'Nombre' },
    { key: 'prod_oem', header: 'OEM' },
    { key: 'prod_cantidad', header: 'Cantidad' },
  ]

  const buildExportRows = useCallback((rows) => {
    const result = []
    for (const row of rows) {
      const productos = row.productos || []
      const base = { ...row, estado_label: STATUS_BADGE[row.estado]?.label || row.estado || '' }
      if (!productos.length) {
        result.push(base)
      } else {
        for (const p of productos) {
          result.push({ ...base, prod_codigo: p.codigo, prod_nombre: p.nombre, prod_oem: p.oem, prod_cantidad: p.cantidad })
        }
      }
    }
    return result
  }, [])

  const getExportValue = useCallback((row, key) => row?.[key] ?? '', [])

  const handleExportExcel = useCallback(async () => {
    const rows = buildExportRows(items)
    await exportToExcel({ rows, columns: exportColumns, valueGetter: getExportValue, fileName: buildFileName('importaciones') })
  }, [buildExportRows, getExportValue, items])

  const handleExportPdf = useCallback(async () => {
    const rows = buildExportRows(items)
    await exportToPdf({ rows, columns: exportColumns, valueGetter: getExportValue, fileName: buildFileName('importaciones'), title: 'Reporte de importaciones' })
  }, [buildExportRows, getExportValue, items])

  const handleOpenBorrador = useCallback((borradorData) => {
    setShowCreate(false)
    setEditImp(borradorData)
    setShowEditImp(true)
  }, [])

  const handleRowDoubleClick = useCallback((event) => {
    const rowData = event?.data
    if (!rowData) return
    if (rowData.estado === 'borrador') {
      setEditImp(rowData)
      setShowEditImp(true)
    } else {
      setSelectedImp(rowData)
      setShowImpDetails(true)
    }
  }, [])

  const emptyMessage = loading ? ' ' : (error || statusConfig.empty)

  const header = (
    <div className="users-header">
      <div className="users-header__left">
        <div className="search-input-container">
          <input
            type="text"
            value={globalFilterValue}
            onChange={handleGlobalFilterChange}
            className="search-input"
            placeholder="Buscar en tabla"
          />
          <i className={`pi ${isGlobalSearchPending ? 'pi-spinner pi-spin' : 'pi-search'} search-input-icon`} />
        </div>
        <button
          className="rounded-icon-btn"
          type="button"
          onClick={fetchItems}
          disabled={loading}
          title="Recargar"
        >
          <i className="pi pi-refresh" />
        </button>
      </div>
      <div className="users-header__right">
        <span className="users-header__count">Reg. {items.length}</span>
        <button className="rounded-icon-btn" type="button" onClick={handleExportExcel} title="Exportar Excel" disabled={!items.length}>
          <i className="pi pi-file-excel" />
        </button>
        <button className="rounded-icon-btn" type="button" onClick={handleExportPdf} title="Exportar PDF" disabled={!items.length}>
          <i className="pi pi-file-pdf" />
        </button>
      </div>
    </div>
  )

  return (
    <div className="users-page">
      <Toast
        ref={toast}
        baseZIndex={12050}
        appendTo={typeof document !== 'undefined' ? document.body : undefined}
      />

      <div className="users-page__top">
        <div className="users-page__actions">
          {canCreate && (
            <Button
              label="Crear"
              icon="pi pi-plus"
              className="users-topbtn users-topbtn--create"
              onClick={() => setShowCreate(true)}
              type="button"
            />
          )}
          {!statusProp && (
            <div className="transfer-issues-page__type-filter" role="group" aria-label="Filtro de estado">
              {[
                { key: 'borrador', label: 'Borradores' },
                { key: 'en_camino', label: 'En camino' },
                { key: 'importada', label: 'Importadas' },
              ].map((option) => (
                <Button
                  key={option.key}
                  label={option.label}
                  type="button"
                  className={`users-topbtn transfer-issues-page__type-btn${status === option.key ? ' transfer-issues-page__type-btn--active' : ''}`}
                  onClick={() => handleStatusChange(option.key)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="users-table users-table--card users-table--compact" ref={tableWrapperRef}>
        {loading && (
          <div className="spinner-container spinner-container--table">
            <div className="spinner" />
          </div>
        )}
        {error && !loading && (
          <div className="stale-data-msg">
            <i className="pi pi-exclamation-circle" style={{ fontSize: '0.8rem', margin: 0, color: 'white' }} />
            <span><strong>Los datos pueden estar desactualizados</strong> | intenta recargar la tabla</span>
          </div>
        )}

        <DataTable
          value={items}
          dataKey="id"
          header={header}
          className={`users-datatable users-datatable--compact${loading ? ' users-datatable--loading-content' : ''}`}
          stateStorage="local"
          stateKey="importaciones-table-state"
          tableStyle={{ width: '100%' }}
          emptyMessage={emptyMessage}
          showGridlines
          size="small"
          scrollable
          scrollHeight="flex"
          paginator
          first={pageFirst}
          rows={pageSize}
          rowsPerPageOptions={[10, 25, 50]}
          onPage={(e) => setPageFirst(e.first)}
          filters={filters}
          globalFilterFields={['codigo', 'fecha', 'casa_nombre', 'productos_resumen']}
          removableSort
          reorderableColumns
          resizableColumns
          columnResizeMode="expand"
          onRowDoubleClick={handleRowDoubleClick}
          rowClassName={() => ({ 'p-selectable-row': true })}
        >
          <Column
            field="codigo"
            header="Código"
            sortable
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '120px' }}
          />
          <Column
            field="fecha"
            header="Fecha"
            sortable
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '100px' }}
          />
          <Column
            field="casa_nombre"
            header="Casa comercial"
            sortable
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '150px' }}
          />
          <Column
            field="estado"
            header="Estado"
            sortable
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '110px' }}
            body={estadoBodyTemplate}
          />
          <Column
            field="dias_entrega_estimados"
            header="Días est."
            sortable
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '90px' }}
            body={(row) => (row.dias_entrega_estimados != null ? `${row.dias_entrega_estimados} d` : '-')}
          />
          <Column
            field="productos_resumen"
            header="Productos"
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '180px' }}
            body={importacionProductBodyTemplate}
          />
        </DataTable>
      </div>

      <ImportacionDetailsModal
        imp={showImpDetails ? selectedImp : null}
        onClose={() => setShowImpDetails(false)}
      />

      {Array.isArray(productHoverCard?.productos) && productHoverCard.productos.length > 0 && createPortal(
        <div
          className="movimientos-table__product-hover-card movimientos-table__product-hover-card--wide"
          role="tooltip"
          style={{ top: productHoverCard.top, left: productHoverCard.left, width: IMP_HOVER_WIDTH }}
          onMouseEnter={clearProductHoverTimer}
          onMouseLeave={scheduleHideProductHoverCard}
        >
          <div className="movimientos-table__product-hover-title">Productos</div>
          <table className="movimientos-table__product-hover-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <colgroup>
              <col style={{ width: '100px' }} />
              <col />
              <col style={{ width: '120px' }} />
              <col style={{ width: '52px' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Código</th>
                <th>Nombre</th>
                <th>OEM</th>
                <th className="movimientos-table__product-hover-qty">Cant.</th>
              </tr>
            </thead>
            <tbody>
              {productHoverCard.productos.map((p, i) => (
                <tr key={i}>
                  <td title={p.codigo}>{p.codigo}</td>
                  <td title={p.nombre}>{p.nombre}</td>
                  <td title={p.oem}>{p.oem}</td>
                  <td className="movimientos-table__product-hover-qty">{p.cantidad}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
        document.body
      )}

      <EditImportacionModal
        open={showEditImp}
        imp={editImp}
        token={token}
        onClose={() => setShowEditImp(false)}
        onSaved={() => { setShowEditImp(false); fetchItems() }}
        onOpenBorrador={handleOpenBorrador}
      />

      <CreateImportacionModal
        open={showCreate}
        token={token}
        onClose={() => setShowCreate(false)}
        onError={onError}
        onCreated={() => {
          setShowCreate(false)
          if (status === 'borrador') {
            fetchItems()
          } else {
            setActiveStatus('borrador')
          }
        }}
        onOpenBorrador={handleOpenBorrador}
      />
    </div>
  )
}

export default ImportacionesTable
