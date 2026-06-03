import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
const VIEWPORT_PADDING = 12

function CreateImportacionModal({ open, token, onClose, onCreated, onError }) {
  const [nextCode, setNextCode] = useState('IMP-')
  const [selectedCasa, setSelectedCasa] = useState(null)
  const [casaQuery, setCasaQuery] = useState('')
  const [casaOptions, setCasaOptions] = useState([])
  const [casaLoading, setCasaLoading] = useState(false)
  const [showCasaDropdown, setShowCasaDropdown] = useState(false)
  const [productQuery, setProductQuery] = useState('')
  const [productOptions, setProductOptions] = useState([])
  const [productLoading, setProductLoading] = useState(false)
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [details, setDetails] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState('')
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalSizeRef = useRef(modalSize)
  const modalPositionRef = useRef(modalPosition)
  const casaTimerRef = useRef(null)
  const productTimerRef = useRef(null)
  const casaDropdownRef = useRef(null)
  const productDropdownRef = useRef(null)

  useEffect(() => { modalSizeRef.current = modalSize }, [modalSize])
  useEffect(() => { modalPositionRef.current = modalPosition }, [modalPosition])

  useLayoutEffect(() => {
    if (!open) return
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    const nextWidth = Math.min(MIN_WIDTH, availableWidth)
    const nextHeight = Math.min(MIN_HEIGHT, availableHeight)
    setModalSize({ width: nextWidth, height: nextHeight })
    setModalPosition({
      x: Math.max((window.innerWidth - nextWidth) / 2, VIEWPORT_PADDING),
      y: Math.max((window.innerHeight - nextHeight) / 2, VIEWPORT_PADDING),
    })
  }, [open])

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!modalDrag.current.active) return
      event.preventDefault()
      const newX = event.clientX - modalDrag.current.offsetX
      const newY = event.clientY - modalDrag.current.offsetY
      const maxX = window.innerWidth - modalSizeRef.current.width - VIEWPORT_PADDING
      const maxY = window.innerHeight - modalSizeRef.current.height - VIEWPORT_PADDING
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
    setNextCode('IMP-')
    setSelectedCasa(null)
    setCasaQuery('')
    setCasaOptions([])
    setShowCasaDropdown(false)
    setProductQuery('')
    setProductOptions([])
    setShowProductDropdown(false)
    setDetails([])
    setSubmitting(false)
    setLocalError('')
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
      if (!casaDropdownRef.current?.contains(event.target)) setShowCasaDropdown(false)
      if (!productDropdownRef.current?.contains(event.target)) setShowProductDropdown(false)
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
    params.set('page_size', '8')
    params.set('modulo', 'solicitudes')
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
    if (!open || !showCasaDropdown) return undefined
    if (casaTimerRef.current) clearTimeout(casaTimerRef.current)
    casaTimerRef.current = setTimeout(() => searchCasas(casaQuery.trim()), 280)
    return () => clearTimeout(casaTimerRef.current)
  }, [casaQuery, open, searchCasas, showCasaDropdown])

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

  const handleSelectCasa = (casa) => {
    setSelectedCasa(casa)
    setCasaQuery(formatCasaLabel(casa))
    setShowCasaDropdown(false)
    setLocalError('')
  }

  const handleAddProduct = (product) => {
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
          <div className="create-user__body">

            <section className="create-user__section">
              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">General</p>
                  <h4>Información de la importación</h4>
                </div>
              </div>

              <div className="create-user__grid create-user__grid--two">
                <label className="create-user__field">
                  <span>Código</span>
                  <input type="text" value={nextCode} readOnly />
                </label>

                <label className="create-user__field">
                  <span>Fecha</span>
                  <input type="text" value={formatDate(todayISO())} readOnly />
                </label>

                <label className="create-user__field create-user__field--full">
                  <span>Casa comercial</span>
                  <div className="create-user__dropdown" ref={casaDropdownRef}>
                    <button
                      type="button"
                      className={`create-user__dropdown-trigger${!selectedCasa ? ' create-salida__cliente-trigger--placeholder' : ''}`}
                      onClick={() => {
                        setShowCasaDropdown((v) => !v)
                        if (!showCasaDropdown) searchCasas(casaQuery.trim())
                      }}
                    >
                      <span>{selectedCasa ? formatCasaLabel(selectedCasa) : 'Selecciona una casa comercial'}</span>
                      <i className={`pi pi-chevron-${showCasaDropdown ? 'up' : 'down'}`} />
                    </button>
                    {showCasaDropdown && (
                      <div className="create-user__dropdown-panel">
                        <div className="create-user__dropdown-search">
                          <i className="pi pi-search" />
                          <input
                            type="text"
                            placeholder="Buscar casas comerciales"
                            value={casaQuery}
                            onChange={(e) => { setCasaQuery(e.target.value); setSelectedCasa(null) }}
                            autoFocus
                            autoComplete="off"
                          />
                        </div>
                        <div className="create-user__dropdown-results">
                          {casaLoading && <small className="muted">Buscando...</small>}
                          {!casaLoading && !casaOptions.length && <small className="muted">Sin resultados.</small>}
                          {casaOptions.map((casa) => (
                            <button
                              key={casa.id}
                              type="button"
                              className="create-user__result-option"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => handleSelectCasa(casa)}
                            >
                              <div className="create-user__result-info">
                                <strong>{formatCasaLabel(casa)}</strong>
                                <small>
                                  {casa.tipo === 'importacion' ? 'Importación' : 'Local'}
                                  {casa.dias_entrega ? ` · ${casa.dias_entrega} días est.` : ''}
                                </small>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </label>

                <label className="create-user__field">
                  <span>Días aproximados de entrega</span>
                  <input
                    type="text"
                    value={selectedCasa?.dias_entrega != null ? `${selectedCasa.dias_entrega} días` : '-'}
                    readOnly
                  />
                </label>
              </div>
            </section>

            <section className="create-user__section">
              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Productos</p>
                  <h4>Agregar productos a importar</h4>
                </div>
              </div>

              <label className="create-user__field">
                <span>Buscar producto</span>
                <div className="create-user__dropdown" ref={productDropdownRef}>
                  <button
                    type="button"
                    className="create-user__dropdown-trigger create-salida__cliente-trigger--placeholder"
                    onClick={() => {
                      setShowProductDropdown((v) => !v)
                      if (!showProductDropdown) searchProducts(productQuery.trim())
                    }}
                  >
                    <span>Buscar y agregar productos</span>
                    <i className={`pi pi-chevron-${showProductDropdown ? 'up' : 'down'}`} />
                  </button>
                  {showProductDropdown && (
                    <div className="create-user__dropdown-panel">
                      <div className="create-user__dropdown-search">
                        <i className="pi pi-search" />
                        <input
                          type="text"
                          placeholder="Código, nombre o referencia"
                          value={productQuery}
                          onChange={(e) => setProductQuery(e.target.value)}
                          autoFocus
                          autoComplete="off"
                        />
                      </div>
                      <div className="create-user__dropdown-results">
                        {productLoading && <small className="muted">Buscando...</small>}
                        {!productLoading && !productOptions.length && <small className="muted">Sin resultados.</small>}
                        {productOptions.map((product) => (
                          <button
                            key={product.id}
                            type="button"
                            className="create-user__result-option"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleAddProduct(product)}
                          >
                            <div className="create-user__result-info">
                              <strong>{formatProductLabel(product)}</strong>
                              <small>
                                {(product.casas_comerciales || []).map((c) => c.nombre).filter(Boolean).join(', ') || 'Sin casa comercial'}
                              </small>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </label>

              {!details.length ? (
                <p className="muted" style={{ padding: '10px 0', fontSize: '0.875rem' }}>
                  Agrega los productos que deseas importar.
                </p>
              ) : (
                <div className="create-salida__details">
                  {details.map((item) => (
                    <div key={item.producto.id} className="create-salida__detail-row">
                      <div className="create-salida__detail-info">
                        <strong>{item.producto.codigo}</strong>
                        <span>{item.producto.nombre}</span>
                      </div>
                      <div className="create-salida__detail-qty">
                        <label>
                          <span>Cant.</span>
                          <input
                            type="number"
                            min="1"
                            value={item.cantidad}
                            onChange={(e) => handleQuantityChange(item.producto.id, e.target.value)}
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        className="create-salida__detail-remove"
                        onClick={() => setDetails((prev) => prev.filter((d) => String(d.producto.id) !== String(item.producto.id)))}
                        aria-label="Quitar producto"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {localError && (
              <p className="create-user__field-error" style={{ margin: '0 0 8px' }}>{localError}</p>
            )}
          </div>

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
              <button
                type="submit"
                className="create-user__action create-user__action--primary"
                disabled={submitting}
              >
                {submitting ? 'Creando...' : 'Crear importación'}
              </button>
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
    setFilters({ global: { value: value || null, matchMode: FilterMatchMode.CONTAINS } })
    setPageFirst(0)
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
          <i className="pi pi-search search-input-icon" />
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
