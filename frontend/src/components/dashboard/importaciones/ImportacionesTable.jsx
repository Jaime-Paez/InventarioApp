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
import '../admin/CreateUsuario/CreateUsuario.css'
import '../admin/UsersTable/UsersTable.css'
import '../movimientos/CreateSalida.css'
import './ImportacionesTable.css'

const STATUS_CONFIG = {
  en_proceso: { label: 'En proceso', empty: 'No hay importaciones en proceso.' },
  en_camino: { label: 'En camino', empty: 'No hay importaciones en camino.' },
  importada: { label: 'Importadas', empty: 'No hay importaciones importadas.' },
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
const VIEWPORT_PADDING = 12

function CreateImportacionModal({ open, token, onClose, onCreated, onError }) {
  const [step, setStep] = useState('casa')
  const [nextCode, setNextCode] = useState('IMP-')
  const [selectedCasa, setSelectedCasa] = useState(null)
  const [casaDraft, setCasaDraft] = useState(null)
  const [casaQuery, setCasaQuery] = useState('')
  const [casaOptions, setCasaOptions] = useState([])
  const [casaLoading, setCasaLoading] = useState(false)
  const [showCasaDropdown, setShowCasaDropdown] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [detailDraft, setDetailDraft] = useState({ producto: null, cantidad: '1' })
  const [productQuery, setProductQuery] = useState('')
  const [productOptions, setProductOptions] = useState([])
  const [productLoading, setProductLoading] = useState(false)
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [details, setDetails] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState('')
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: SELECTOR_WIDTH, height: 'auto' })

  const modalRef = useRef(null)
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
    setProductPanelStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
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
      setModalSize({ width: nextWidth, height: 'auto' })
      const measuredHeight = modalRef.current ? modalRef.current.offsetHeight : 300
      const centerX = Math.max((window.innerWidth - nextWidth) / 2, VIEWPORT_PADDING)
      const centerY = Math.max((window.innerHeight - measuredHeight) / 2, VIEWPORT_PADDING)
      if (isFirstOpenRef.current) {
        isFirstOpenRef.current = false
        setModalPosition({ x: centerX, y: centerY })
      } else {
        setModalPosition({ x: centerX, y: Math.min(Math.max(centerY, VIEWPORT_PADDING), availableHeight - measuredHeight + VIEWPORT_PADDING) })
      }
    } else {
      const nextWidth = Math.min(MIN_WIDTH, availableWidth)
      const nextHeight = Math.min(MIN_HEIGHT, availableHeight)
      const centerX = Math.max((window.innerWidth - nextWidth) / 2, VIEWPORT_PADDING)
      setModalSize({ width: nextWidth, height: nextHeight })
      if (isFirstOpenRef.current) {
        isFirstOpenRef.current = false
        setModalPosition({ x: centerX, y: Math.max((window.innerHeight - nextHeight) / 2, VIEWPORT_PADDING) })
      } else {
        setModalPosition((prev) => ({
          x: centerX,
          y: Math.min(Math.max(prev.y, VIEWPORT_PADDING), Math.max(availableHeight - nextHeight + VIEWPORT_PADDING, VIEWPORT_PADDING)),
        }))
      }
    }
  }, [open, step, casaDraft])

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!modalDrag.current.active) return
      event.preventDefault()
      const newX = event.clientX - modalDrag.current.offsetX
      const newY = event.clientY - modalDrag.current.offsetY
      const modalHeight = modalRef.current
        ? modalRef.current.offsetHeight
        : (typeof modalSizeRef.current.height === 'number' ? modalSizeRef.current.height : 0)
      const maxX = window.innerWidth - modalSizeRef.current.width - VIEWPORT_PADDING
      const maxY = window.innerHeight - modalHeight - VIEWPORT_PADDING
      setModalPosition({
        x: Math.min(Math.max(newX, VIEWPORT_PADDING), Math.max(maxX, VIEWPORT_PADDING)),
        y: Math.min(Math.max(newY, VIEWPORT_PADDING), Math.max(maxY, VIEWPORT_PADDING)),
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
    setLocalError(clean)
    onError?.(clean)
  }, [onError])

  const reset = useCallback(() => {
    setStep('casa')
    setActiveTab('general')
    setDetailDraft({ producto: null, cantidad: '1' })
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
    setLocalError('')
    setModalSize({ width: SELECTOR_WIDTH, height: 'auto' })
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
        const selectedIds = new Set(details.map((item) => String(item.producto.id)))
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

  const handleAddProduct = (product) => {
    if (details.some((d) => String(d.producto.id) === String(product.id))) {
      setLocalError('Este producto ya fue agregado.')
      return
    }
    setDetails((prev) => [
      ...prev,
      {
        producto: product,
        cantidad: '1',
      },
    ])
    setProductQuery('')
    setProductOptions([])
    setShowProductDropdown(false)
    setLocalError('')
  }

  const handleQuantityChange = (productId, value) => {
    const clean = String(value || '').replace(/[^\d]/g, '')
    setDetails((prev) =>
      prev.map((item) =>
        String(item.producto.id) === String(productId)
          ? { ...item, cantidad: clean }
          : item
      )
    )
  }

  const handleSubmit = async () => {
    if (!selectedCasa?.id) {
      notifyError('Selecciona una casa comercial.')
      return
    }
    if (!details.length) {
      notifyError('Agrega al menos un producto a la importacion.')
      return
    }
    const normalizedDetails = details.map((item) => ({
      producto_id: item.producto.id,
      cantidad: Number(item.cantidad || 0),
    }))
    if (normalizedDetails.some((item) => !Number.isFinite(item.cantidad) || item.cantidad <= 0)) {
      notifyError('Todas las cantidades deben ser mayores a cero.')
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

  if (!open) return null

  return (
    <div
      className="create-user__overlay"
      role="dialog"
      aria-modal="true"
      style={{ padding: `${VIEWPORT_PADDING}px` }}
    >
      <div
        ref={modalRef}
        className="create-user__modal"
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
            <h3>Nueva importación</h3>
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
          className="create-user__form"
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
                          autoFocus
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

                  {activeTab === 'productos' && (
                    <section className="create-user__section">
                      <div className="create-user__section-header">
                        <div>
                          <p className="create-user__eyebrow">Productos</p>
                          <h4>Listado de productos</h4>
                        </div>
                      </div>

                      <div className="create-user__locations-table create-salida__products-table create-salida__products-table--with-actions">
                        <div className="create-user__locations-row create-user__locations-row--head">
                          <span>Código</span>
                          <span>Nombre</span>
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
                                      const isAlreadyAdded = details.some((d) => String(d.producto.id) === String(product.id))
                                      const isSelected = String(detailDraft.producto?.id) === String(product.id)
                                      return (
                                        <button
                                          key={product.id}
                                          type="button"
                                          className={`create-salida__result-row${isSelected ? ' is-selected' : ''}${isAlreadyAdded ? ' is-added' : ''}`}
                                          onMouseDown={(e) => e.preventDefault()}
                                          onClick={() => {
                                            setDetailDraft({ producto: product, cantidad: '1' })
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
                              disabled={!detailDraft.producto}
                              onClick={() => {
                                if (!detailDraft.producto) return
                                handleAddProduct(detailDraft.producto)
                                setDetailDraft({ producto: null, cantidad: '1' })
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
                        ) : details.map((item) => (
                          <div key={item.producto.id} className="create-user__locations-row">
                            <span>{item.producto.codigo || '—'}</span>
                            <span title={item.producto.nombre}>
                              <span className="create-salida__product-name-text">{item.producto.nombre}</span>
                            </span>
                            <span>
                              <input
                                type="number"
                                min="1"
                                value={item.cantidad}
                                onChange={(e) => handleQuantityChange(item.producto.id, e.target.value)}
                              />
                            </span>
                            <span className="create-user__locations-cell create-user__locations-cell--action">
                              <button
                                type="button"
                                className="create-user__locations-remove"
                                onClick={() => setDetails((prev) => prev.filter((d) => String(d.producto.id) !== String(item.producto.id)))}
                              >
                                x
                              </button>
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {localError && (
                    <p className="create-user__field-error" style={{ margin: '0 0 8px' }}>{localError}</p>
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
                  {submitting ? 'Creando...' : 'Crear importación'}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

function ImportacionesTable({ token, moduleActions, status: statusProp, onError }) {
  const toast = useRef(null)
  const tableWrapperRef = useRef(null)
  const _widthsClearedRef = useRef(null)
  if (_widthsClearedRef.current === null) {
    _widthsClearedRef.current = true
    clearSavedColumnWidths('importaciones-table-state')
  }

  const [activeStatus, setActiveStatus] = useState('en_proceso')
  const status = statusProp || activeStatus
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
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
    list.map((item) => ({
      ...item,
      casa_nombre: item?.casa_comercial?.nombre ?? '-',
      productos_resumen: (item?.detalles || [])
        .slice(0, 3)
        .map((d) => `${d.producto?.codigo || 'Prod'} x${d.cantidad}`)
        .join(', ') + ((item?.detalles || []).length > 3 ? ` +${item.detalles.length - 3}` : ''),
    }))
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
                { key: 'en_proceso', label: 'En proceso' },
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
            body={(row) => formatDate(row.fecha)}
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
            field="dias_entrega_estimados"
            header="Días estimados"
            sortable
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '120px' }}
            body={(row) => (row.dias_entrega_estimados != null ? `${row.dias_entrega_estimados} d` : '-')}
          />
          <Column
            field="total_productos"
            header="Productos"
            sortable
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '80px' }}
            body={(row) => row.total_productos ?? (row.detalles?.length ?? 0)}
          />
          <Column
            field="productos_resumen"
            header="Detalle"
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '200px' }}
          />
        </DataTable>
      </div>

      <CreateImportacionModal
        open={showCreate}
        token={token}
        onClose={() => setShowCreate(false)}
        onError={onError}
        onCreated={() => {
          setShowCreate(false)
          setActiveStatus('en_proceso')
        }}
      />
    </div>
  )
}

export default ImportacionesTable
