import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { OrderList } from 'primereact/orderlist'
import '../../admin/CreateUsuario/CreateUsuario.css'
import { API_URL, authFetch } from '../../../../utils/api'

const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const initialForm = {
  codigo: '',
  nombre: '',
  descripcion: '',
  pieza_original: false,
  costo_minimo: '',
  costo_maximo: '',
  precio: '',
  marcaId: '',
  casasIds: [],
}

const parseNumber = (value) => {
  const cleaned = String(value ?? '').trim()
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

function CreateProducto({ open, onClose, onCreated, token, onError }) {
  const [formData, setFormData] = useState(initialForm)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [alternoQuery, setAlternoQuery] = useState('')
  const [alternoOptions, setAlternoOptions] = useState([])
  const [alternoLoading, setAlternoLoading] = useState(false)
  const [alternosSelected, setAlternosSelected] = useState([])
  const [showAlternoDropdown, setShowAlternoDropdown] = useState(false)
  const [showMarcaDropdown, setShowMarcaDropdown] = useState(false)
  const [showCasaDropdown, setShowCasaDropdown] = useState(false)
  const [brands, setBrands] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [selectedCasa, setSelectedCasa] = useState(null)
  const [marcaQuery, setMarcaQuery] = useState('')
  const [casaSearch, setCasaSearch] = useState('')
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const marcaDropdownRef = useRef(null)
  const casaDropdownRef = useRef(null)
  const alternoDropdownRef = useRef(null)
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const sizeRef = useRef(size)
  const positionRef = useRef(position)
  const restoreRef = useRef(null)

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
  const getViewportMetrics = () => {
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    return {
      availableWidth,
      availableHeight,
      minWidth: Math.min(MIN_WIDTH, availableWidth),
      minHeight: Math.min(MIN_HEIGHT, availableHeight),
    }
  }

  const notifyError = useCallback(
    (message) => {
      if (!message) return
      if (onError) {
        onError(message)
        return
      }
      console.error(message)
    },
    [onError]
  )

  const normalizeValue = (value) => String(value ?? '').trim().toLowerCase()

  const filteredSuppliers = useMemo(() => {
    const needle = normalizeValue(casaSearch)
    if (!needle) return []
    return suppliers
  }, [suppliers, casaSearch])

  const searchBrands = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token) {
        setBrands([])
        return
      }
      try {
        const response = await authFetch(
          `${API_URL}/marcas/listado/?search=${encodeURIComponent(term)}&page_size=20`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las marcas.')
        const data = await response.json()
        const list = Array.isArray(data) ? data : data?.results || []
        setBrands(list)
      } catch (err) {
        notifyError(err.message || 'Ocurrio un error al cargar las marcas.')
      }
    },
    [notifyError, token]
  )

  const searchSuppliers = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token) {
        setSuppliers([])
        return
      }
      try {
        const response = await authFetch(
          `${API_URL}/casa-comercial/casas/?search=${encodeURIComponent(term)}&page_size=20`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las casas comerciales.')
        const data = await response.json()
        const list = Array.isArray(data) ? data : data?.results || []
        setSuppliers(list)
      } catch (err) {
        notifyError(err.message || 'Ocurrio un error al cargar las casas comerciales.')
      }
    },
    [notifyError, token]
  )

  const searchAlternos = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token) {
        setAlternoOptions([])
        return
      }
      setAlternoLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=20`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar los productos.')
        const data = await response.json()
        const list = Array.isArray(data) ? data : data?.results || []
        setAlternoOptions(list)
      } catch (err) {
        notifyError(err.message || 'Ocurrio un error al buscar productos.')
      } finally {
        setAlternoLoading(false)
      }
    },
    [notifyError, token]
  )

  useEffect(() => {
    if (!open) return
    setFormData(initialForm)
    setMarcaQuery('')
    setCasaSearch('')
    setLoading(false)
    setActiveTab('general')
    setAlternoQuery('')
    setAlternoOptions([])
    setAlternosSelected([])
    setAlternoLoading(false)
    setShowAlternoDropdown(false)
    setShowMarcaDropdown(false)
    setShowCasaDropdown(false)
    setIsMaximized(false)
    setSelectedCasa(null)
    restoreRef.current = null
    setBrands([])
    setSuppliers([])
  }, [open])

  useEffect(() => {
    const term = marcaQuery.trim()
    if (!term) {
      setBrands([])
      return
    }
    const handle = setTimeout(() => {
      searchBrands(term)
    }, 300)
    return () => clearTimeout(handle)
  }, [marcaQuery, searchBrands])

  useEffect(() => {
    const term = casaSearch.trim()
    if (!term) {
      setSuppliers([])
      return
    }
    const handle = setTimeout(() => {
      searchSuppliers(term)
    }, 300)
    return () => clearTimeout(handle)
  }, [casaSearch, searchSuppliers])

  useEffect(() => {
    const term = alternoQuery.trim()
    if (!term) {
      setAlternoOptions([])
      return
    }
    const handle = setTimeout(() => {
      searchAlternos(term)
    }, 300)
    return () => clearTimeout(handle)
  }, [alternoQuery, searchAlternos])

  useEffect(() => {
    const handleClick = (event) => {
      if (showAlternoDropdown && alternoDropdownRef.current && !alternoDropdownRef.current.contains(event.target)) {
        setShowAlternoDropdown(false)
      }
      if (showMarcaDropdown && marcaDropdownRef.current && !marcaDropdownRef.current.contains(event.target)) {
        setShowMarcaDropdown(false)
      }
      if (showCasaDropdown && casaDropdownRef.current && !casaDropdownRef.current.contains(event.target)) {
        setShowCasaDropdown(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [showAlternoDropdown, showMarcaDropdown, showCasaDropdown])

  useLayoutEffect(() => {
    if (!open) return
    const { availableWidth, availableHeight } = getViewportMetrics()
    const nextWidth = Math.min(MIN_WIDTH, availableWidth)
    const nextHeight = Math.min(MIN_HEIGHT, availableHeight)
    setSize({ width: nextWidth, height: nextHeight })

    const centeredX = (window.innerWidth - nextWidth) / 2
    const centeredY = (window.innerHeight - nextHeight) / 2
    setPosition({ x: Math.max(centeredX, VIEWPORT_PADDING), y: Math.max(centeredY, VIEWPORT_PADDING) })
  }, [open])

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    positionRef.current = position
  }, [position])

  const handleChange = (event) => {
    const { name, value } = event.target
    if (name === 'pieza_original') {
      setFormData((prev) => ({
        ...prev,
        pieza_original: value === 'true',
      }))
      return
    }
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleMarcaInputChange = (event) => {
    const value = event.target.value
    setMarcaQuery(value)
    setFormData((prev) => ({
      ...prev,
      marcaId: '',
    }))
  }

  const handleMarcaSelect = (brand) => {
    if (!brand) return
    setMarcaQuery(brand.nombre || '')
    setFormData((prev) => ({
      ...prev,
      marcaId: String(brand.id),
    }))
    setShowMarcaDropdown(false)
  }

  const handleCasaToggle = (supplier) => {
    if (!supplier) return
    const id = String(supplier.id)
    if (!id) return
    setFormData((prev) => {
      const current = (prev.casasIds || []).map(String)
      if (current.includes(id)) {
        setSelectedCasa(null)
        return { ...prev, casasIds: [] }
      }
      setSelectedCasa({ id: supplier.id, nombre: supplier.nombre })
      return { ...prev, casasIds: [id] }
    })
    setCasaSearch('')
    setShowCasaDropdown(false)
  }

  const alternoIdSet = useMemo(
    () => new Set(alternosSelected.map((item) => String(item?.id)).filter(Boolean)),
    [alternosSelected]
  )

  const handleAddAlterno = (product) => {
    if (!product) return
    const id = String(product.id)
    if (!id) return
    setAlternosSelected((prev) => {
      if (prev.some((item) => String(item?.id) === id)) return prev
      return [
        ...prev,
        {
          id: product.id,
          codigo: product.codigo,
          nombre: product.nombre,
        },
      ]
    })
  }

  const handleRemoveAlterno = (id) => {
    const key = String(id)
    if (!key) return
    setAlternosSelected((prev) => prev.filter((item) => String(item?.id) !== key))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)

    const payload = {
      codigo: formData.codigo.trim(),
      nombre: formData.nombre.trim(),
      descripcion: formData.descripcion.trim(),
      pieza_original: Boolean(formData.pieza_original),
      costo_minimo: parseNumber(formData.costo_minimo),
      costo_maximo: parseNumber(formData.costo_maximo),
      precio: parseNumber(formData.precio),
      marca_id: formData.marcaId ? Number(formData.marcaId) : null,
      casas_comerciales_ids: (formData.casasIds || []).map((id) => Number(id)),
    }

    if (!payload.codigo) {
      setLoading(false)
      notifyError('Define un codigo para el producto.')
      return
    }

    if (!payload.nombre) {
      setLoading(false)
      notifyError('Define un nombre para el producto.')
      return
    }

    if (!payload.marca_id) {
      setLoading(false)
      notifyError('Selecciona una marca para el producto.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/productos/listado/`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail =
          data?.detail ||
          data?.codigo?.[0] ||
          data?.nombre?.[0] ||
          data?.marca_id?.[0] ||
          'No se pudo crear el producto.'
        throw new Error(detail)
      }

      if (data?.id && alternosSelected.length) {
        const uniqueIds = Array.from(
          new Set(alternosSelected.map((item) => item?.id).filter(Boolean))
        ).filter((id) => id !== data.id)
        const errors = []
        for (const alternoId of uniqueIds) {
          try {
            const alternoResponse = await authFetch(
              `${API_URL}/productos/alternos/`,
              {
                method: 'POST',
                body: JSON.stringify({
                  producto_id: data.id,
                  alterno_id: alternoId,
                }),
              },
              token
            )
            if (!alternoResponse.ok) {
              const alternoData = await alternoResponse.json().catch(() => ({}))
              const detail = alternoData?.detail || 'No se pudo registrar un producto alterno.'
              throw new Error(detail)
            }
          } catch (err) {
            errors.push(err?.message || 'No se pudo registrar un producto alterno.')
          }
        }
        if (errors.length) {
          notifyError(`Se creo el producto, pero fallaron ${errors.length} alternos.`)
        }
      }

      setFormData(initialForm)
      setAlternosSelected([])
      onCreated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrio un error al crear el producto.')
    } finally {
      setLoading(false)
    }
  }

  const handleMouseDown = (event) => {
    if (isMaximized) return
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
      startWidth: sizeRef.current.width,
      startHeight: sizeRef.current.height,
    }

    const handleResizeMove = (moveEvent) => {
      if (!resizeData.current.active) return
      const deltaX = moveEvent.clientX - resizeData.current.startX
      const deltaY = moveEvent.clientY - resizeData.current.startY
      const maxWidth = Math.max(minWidth, window.innerWidth - positionRef.current.x - VIEWPORT_PADDING)
      const maxHeight = Math.max(minHeight, window.innerHeight - positionRef.current.y - VIEWPORT_PADDING)
      const width = clamp(resizeData.current.startWidth + deltaX, minWidth, maxWidth)
      const height = clamp(resizeData.current.startHeight + deltaY, minHeight, maxHeight)
      setSize({ width, height })
    }

    const handleResizeUp = () => {
      resizeData.current.active = false
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }

    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!dragData.current.active) return
      event.preventDefault()
      const newX = event.clientX - dragData.current.offsetX
      const newY = event.clientY - dragData.current.offsetY
      const maxX = window.innerWidth - sizeRef.current.width - VIEWPORT_PADDING
      const maxY = window.innerHeight - sizeRef.current.height - VIEWPORT_PADDING
      setPosition({
        x: Math.min(Math.max(newX, VIEWPORT_PADDING), Math.max(maxX, VIEWPORT_PADDING)),
        y: Math.min(Math.max(newY, VIEWPORT_PADDING), Math.max(maxY, VIEWPORT_PADDING)),
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
    const handleWindowResize = () => {
      const { minWidth, minHeight, availableWidth, availableHeight } = getViewportMetrics()

      if (isMaximized) {
        setSize({ width: availableWidth, height: availableHeight })
        setPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }

      setSize((prev) => {
        const width = clamp(prev.width, minWidth, availableWidth)
        const height = clamp(prev.height, minHeight, availableHeight)

        setPosition((prevPosition) => ({
          x: Math.min(Math.max(prevPosition.x, VIEWPORT_PADDING), Math.max(window.innerWidth - width - VIEWPORT_PADDING, VIEWPORT_PADDING)),
          y: Math.min(Math.max(prevPosition.y, VIEWPORT_PADDING), Math.max(window.innerHeight - height - VIEWPORT_PADDING, VIEWPORT_PADDING)),
        }))

        return { width, height }
      })
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [isMaximized])

  const toggleMaximize = () => {
    if (isMaximized) {
      const restore = restoreRef.current
      if (restore) {
        setSize(restore.size)
        setPosition(restore.position)
      }
      setIsMaximized(false)
      return
    }

    restoreRef.current = {
      size: sizeRef.current,
      position: positionRef.current,
    }
    const { availableWidth, availableHeight } = getViewportMetrics()
    setSize({ width: availableWidth, height: availableHeight })
    setPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  if (!open) return null

  const overlayStyle = { padding: `${VIEWPORT_PADDING}px` }
  const modalStyle = {
    top: position.y,
    left: position.x,
    width: size.width,
    height: size.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
  }

  return (
    <div className="create-user__overlay" role="dialog" aria-modal="true" style={overlayStyle}>
      <div className="create-user__modal" ref={modalRef} style={modalStyle}>
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>Crear nuevo producto</h3>
          </div>
          <div className="create-user__header-actions">
            <button
              type="button"
              className="create-user__icon-button create-user__icon-button--maximize"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={toggleMaximize}
              aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
            >
              {isMaximized ? '🗕' : '🗖'}
            </button>
            <button
              type="button"
              className="create-user__icon-button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={onClose}
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>
        </header>

        <form className="create-user__form" onSubmit={handleSubmit}>
          <div className="create-user__tabs" role="tablist" aria-label="Secciones del producto">
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'general' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('general')}
              aria-selected={activeTab === 'general'}
            >
              General
            </button>
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'alternos' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('alternos')}
              aria-selected={activeTab === 'alternos'}
            >
              Alternos
            </button>
          </div>

          <div className="create-user__body">
            {activeTab === 'general' && (
              <>
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <h4>Datos del producto</h4>
                    </div>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field">
                      <span>Nombre</span>
                      <input
                        name="nombre"
                        type="text"
                        placeholder="Nombre"
                        value={formData.nombre}
                        onChange={handleChange}
                        required
                        disabled={loading}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Casa comercial</span>
                      <div className="create-user__dropdown" ref={casaDropdownRef}>
                        <button
                          type="button"
                          className="create-user__dropdown-trigger"
                          onClick={() => {
                            setShowCasaDropdown((prev) => !prev)
                            setShowMarcaDropdown(false)
                          }}
                          disabled={loading}
                        >
                          <span>{selectedCasa?.nombre || 'Selecciona una casa comercial'}</span>
                          <i className={`pi pi-chevron-${showCasaDropdown ? 'up' : 'down'}`} />
                        </button>

                        {showCasaDropdown && (
                          <div className="create-user__dropdown-panel">
                            <div className="create-user__dropdown-search">
                              <i className="pi pi-search" />
                              <input
                                type="text"
                                placeholder="Buscar casas comerciales"
                                value={casaSearch}
                                onChange={(event) => setCasaSearch(event.target.value)}
                              />
                            </div>

                            <div className="create-user__dropdown-results">
                              {!casaSearch.trim() && <small className="muted">Escribe para buscar.</small>}
                              {casaSearch.trim() && !filteredSuppliers.length && (
                                <small className="muted">Sin resultados.</small>
                              )}
                              {filteredSuppliers.map((supplier) => {
                                const id = String(supplier.id)
                                const isSelected = formData.casasIds.includes(id)
                                return (
                                  <button
                                    key={supplier.id}
                                    type="button"
                                    className="create-user__result-option"
                                    onClick={() => handleCasaToggle(supplier)}
                                    disabled={loading}
                                  >
                                    <div className="create-user__result-info">
                                      <strong>{supplier.nombre}</strong>
                                      <small>{supplier.codigo ? `Codigo: ${supplier.codigo}` : `ID: ${supplier.id}`}</small>
                                    </div>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </label>

                    <label className="create-user__field">
                      <span>Referencia</span>
                      <input
                        name="codigo"
                        type="text"
                        placeholder="Referencia del producto"
                        value={formData.codigo}
                        onChange={handleChange}
                        required
                        disabled={loading}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Marca</span>
                      <div className="create-user__dropdown" ref={marcaDropdownRef}>
                        <button
                          type="button"
                          className="create-user__dropdown-trigger"
                          onClick={() => {
                            setShowMarcaDropdown((prev) => !prev)
                            setShowCasaDropdown(false)
                          }}
                          disabled={loading}
                        >
                          <span>{marcaQuery.trim() ? marcaQuery : 'Selecciona una marca'}</span>
                          <i className={`pi pi-chevron-${showMarcaDropdown ? 'up' : 'down'}`} />
                        </button>

                        {showMarcaDropdown && (
                          <div className="create-user__dropdown-panel">
                            <div className="create-user__dropdown-search">
                              <i className="pi pi-search" />
                              <input
                                type="text"
                                placeholder="Buscar marcas"
                                value={marcaQuery}
                                onChange={handleMarcaInputChange}
                              />
                            </div>

                            <div className="create-user__dropdown-results">
                              {!marcaQuery.trim() && <small className="muted">Escribe para buscar.</small>}
                              {marcaQuery.trim() && !brands.length && <small className="muted">Sin resultados.</small>}
                              {brands.slice(0, 40).map((brand) => (
                                <button
                                  key={brand.id}
                                  type="button"
                                  className="create-user__result-option"
                                  onClick={() => {
                                    handleMarcaSelect(brand)
                                    setShowMarcaDropdown(false)
                                  }}
                                  disabled={loading}
                                >
                                  <div className="create-user__result-info">
                                    <strong>{brand.nombre}</strong>
                                    <small>{brand.codigo ? `Codigo: ${brand.codigo}` : `ID: ${brand.id}`}</small>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </label>

                    <label className="create-user__field create-user__field--full">
                      <span>Descripcion</span>
                      <textarea
                        name="descripcion"
                        placeholder="Describe el producto, su uso, diferentes nombres o caracteristicas importantes."
                        value={formData.descripcion}
                        onChange={handleChange}
                        disabled={loading}
                      />
                    </label>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <h4>Datos comerciales del producto</h4>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field">
                      <span>Costo</span>
                      <div className="create-user__money">
                        <span>$</span>
                        <input
                          name="costo_minimo"
                          type="number"
                          step="0.01"
                          placeholder="Costo al comprar"
                          value={formData.costo_minimo}
                          onChange={handleChange}
                          disabled={loading}
                        />
                      </div>
                    </label>

                    <label className="create-user__field">
                      <span>Precio</span>
                      <div className="create-user__money">
                        <span>$</span>
                        <input
                          name="precio"
                          type="number"
                          step="0.01"
                          placeholder="Precio al que se pretende vender"
                          value={formData.precio}
                          onChange={handleChange}
                          disabled={loading}
                        />
                      </div>
                    </label>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <h4>Ubicaciones del producto</h4>
                    <button type="button" className="create-user__ghost create-user__location-action" disabled>
                      Ingresar ubicacion
                    </button>
                  </div>

                  <div className="create-user__locations-table">
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>Sucursal</span>
                      <span>Bodega</span>
                      <span>Division</span>
                      <span>Subdivision</span>
                      <span>Cantidad</span>
                    </div>
                    <div className="create-user__locations-row create-user__locations-row--empty">
                      <span>Sin ubicaciones registradas.</span>
                    </div>
                  </div>
                </section>
              </>
            )}

            {activeTab === 'alternos' && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <h4>Alternos</h4>
                </div>

                <div className="create-user__grid create-user__grid--two">
                  <label className="create-user__field create-user__field--full">
                    <span>Productos alternos</span>
                    <div className="create-user__dropdown" ref={alternoDropdownRef}>
                      <button
                        type="button"
                        className="create-user__dropdown-trigger"
                        onClick={() => {
                          setShowAlternoDropdown((prev) => !prev)
                          setShowMarcaDropdown(false)
                          setShowCasaDropdown(false)
                        }}
                        disabled={loading}
                      >
                        <span>
                          {alternosSelected.length
                            ? `${alternosSelected.length} seleccionados`
                            : 'Selecciona productos alternos'}
                        </span>
                        <i className={`pi pi-chevron-${showAlternoDropdown ? 'up' : 'down'}`} />
                      </button>

                      {showAlternoDropdown && (
                        <div className="create-user__dropdown-panel">
                          <div className="create-user__dropdown-search">
                            <i className="pi pi-search" />
                            <input
                              type="text"
                              placeholder="Buscar productos"
                              value={alternoQuery}
                              onChange={(event) => setAlternoQuery(event.target.value)}
                            />
                          </div>

                          <div className="create-user__dropdown-results">
                            {alternoLoading && <small className="muted">Buscando productos...</small>}
                            {!alternoLoading && !alternoQuery.trim() && (
                              <small className="muted">Escribe para buscar productos.</small>
                            )}
                            {!alternoLoading && alternoQuery.trim() && !alternoOptions.length && (
                              <small className="muted">Sin resultados.</small>
                            )}
                            {alternoOptions.map((product) => {
                              const isSelected = alternoIdSet.has(String(product?.id))
                              return (
                                <button
                                  key={product.id}
                                  type="button"
                                  className="create-user__result-option"
                                  onClick={() => handleAddAlterno(product)}
                                  disabled={isSelected}
                                >
                                  <div className="create-user__result-info">
                                    <strong>{product.nombre || 'Sin nombre'}</strong>
                                    <small>{product.codigo ? `Codigo: ${product.codigo}` : `ID: ${product.id}`}</small>
                                  </div>
                                  <span className={`create-user__result-tag ${isSelected ? 'is-selected' : ''}`}>
                                    {isSelected ? 'Agregado' : 'Agregar'}
                                  </span>
                                </button>
                              )
                            })}
                          </div>

                          <div className="create-user__orderlist-wrapper">
                            <OrderList
                              value={alternosSelected}
                              onChange={(event) => setAlternosSelected(event.value || [])}
                              dataKey="id"
                              className="create-user__orderlist"
                              header="Seleccionados"
                              listStyle={{ maxHeight: '200px' }}
                              itemTemplate={(item) => (
                                <div className="create-user__orderlist-item">
                                  <div>
                                    <strong>{item?.nombre || 'Sin nombre'}</strong>
                                    <small>{item?.codigo ? `Codigo: ${item.codigo}` : `ID: ${item?.id}`}</small>
                                  </div>
                                  <button
                                    type="button"
                                    className="create-user__orderlist-remove"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      handleRemoveAlterno(item?.id)
                                    }}
                                  >
                                    Quitar
                                  </button>
                                </div>
                              )}
                            />
                            {!alternosSelected.length && (
                              <small className="muted">Aun no hay alternos seleccionados.</small>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </label>

                  <label className="create-user__field">
                    <span>Pieza original</span>
                    <select
                      name="pieza_original"
                      value={formData.pieza_original ? 'true' : 'false'}
                      onChange={handleChange}
                      disabled={loading}
                    >
                      <option value="true">Si</option>
                      <option value="false">No</option>
                    </select>
                  </label>

                  <label className="create-user__field">
                    <span>Costo maximo</span>
                    <div className="create-user__money">
                      <span>$</span>
                      <input
                        name="costo_maximo"
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        value={formData.costo_maximo}
                        onChange={handleChange}
                        disabled={loading}
                      />
                    </div>
                  </label>
                </div>
              </section>
            )}
          </div>

          <div className="create-user__footer">
            <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="create-user__action create-user__action--primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Crear producto'}
            </button>
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

export default CreateProducto
