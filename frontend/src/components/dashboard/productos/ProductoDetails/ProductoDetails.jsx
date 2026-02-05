import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Eye, Info, Pencil } from 'lucide-react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../../admin/UsersDetails/UsersDetails.css'
import { API_URL, authFetch } from '../../../../utils/api'

const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const emptyForm = {
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

function ProductoDetails({ open, productoId, token, onClose, onUpdated, onDeleted, onError }) {
  const [formData, setFormData] = useState(emptyForm)
  const [originalData, setOriginalData] = useState(emptyForm)
  const [brands, setBrands] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [selectedSuppliers, setSelectedSuppliers] = useState([])
  const [originalSuppliers, setOriginalSuppliers] = useState([])
  const [originalMarcaNombre, setOriginalMarcaNombre] = useState('')
  const [marcaQuery, setMarcaQuery] = useState('')
  const [casaSearch, setCasaSearch] = useState('')
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
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
    if (!needle) return selectedSuppliers
    return suppliers
  }, [suppliers, casaSearch, selectedSuppliers])

  const normalizeProducto = (data) => ({
    codigo: data?.codigo ?? '',
    nombre: data?.nombre ?? '',
    descripcion: data?.descripcion ?? '',
    pieza_original: Boolean(data?.pieza_original),
    costo_minimo: data?.costo_minimo != null ? String(data.costo_minimo) : '',
    costo_maximo: data?.costo_maximo != null ? String(data.costo_maximo) : '',
    precio: data?.precio != null ? String(data.precio) : '',
    marcaId: data?.marca?.id ?? '',
    casasIds: Array.isArray(data?.casas_comerciales) ? data.casas_comerciales.map((casa) => String(casa.id)) : [],
  })

  const fetchProducto = useCallback(async () => {
    if (!productoId) return
    setLoadingData(true)
    try {
      const response = await authFetch(`${API_URL}/productos/listado/${productoId}/`, {}, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || 'No se pudo cargar la informacion del producto.'
        throw new Error(detail)
      }
      const normalized = normalizeProducto(data)
      setFormData(normalized)
      setOriginalData(normalized)
      const marcaNombre = data?.marca?.nombre ?? ''
      setOriginalMarcaNombre(marcaNombre)
      setMarcaQuery(marcaNombre)
      const casas = Array.isArray(data?.casas_comerciales) ? data.casas_comerciales : []
      setSelectedSuppliers(casas)
      setOriginalSuppliers(casas)
      setIsEditing(false)
    } catch (err) {
      notifyError(err.message || 'Ocurrio un error al obtener la informacion del producto.')
    } finally {
      setLoadingData(false)
    }
  }, [notifyError, token, productoId])

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

  useEffect(() => {
    if (!open) return
    setIsEditing(false)
    setFormData(emptyForm)
    setOriginalData(emptyForm)
    setOriginalMarcaNombre('')
    setMarcaQuery('')
    setCasaSearch('')
    setSelectedSuppliers([])
    setOriginalSuppliers([])
    setIsMaximized(false)
    restoreRef.current = null
    fetchProducto()
  }, [open, fetchProducto])

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
    if (!isEditing) return
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
    if (!isEditing) return
    const value = event.target.value
    setMarcaQuery(value)
    const match = brands.find((brand) => normalizeValue(brand?.nombre) === normalizeValue(value))
    setFormData((prev) => ({
      ...prev,
      marcaId: match ? String(match.id) : '',
    }))
  }

  const handleMarcaSelect = (brand) => {
    if (!isEditing || !brand) return
    setMarcaQuery(brand.nombre || '')
    setFormData((prev) => ({
      ...prev,
      marcaId: String(brand.id),
    }))
  }

  const handleCasaToggle = (id) => {
    if (!isEditing) return
    setFormData((prev) => {
      const next = new Set((prev.casasIds || []).map(String))
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return { ...prev, casasIds: Array.from(next) }
    })
    setSelectedSuppliers((prev) => {
      const exists = prev.some((supplier) => String(supplier.id) === id)
      if (exists) {
        return prev.filter((supplier) => String(supplier.id) !== id)
      }
      const source = suppliers.find((supplier) => String(supplier.id) === id) || originalSuppliers.find((supplier) => String(supplier.id) === id)
      return source ? [...prev, source] : prev
    })
  }

  const handleSave = async () => {
    if (!isEditing || saving || !productoId) return
    setSaving(true)

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
      setSaving(false)
      notifyError('Define un codigo para el producto.')
      return
    }

    if (!payload.nombre) {
      setSaving(false)
      notifyError('Define un nombre para el producto.')
      return
    }

    if (!payload.marca_id) {
      setSaving(false)
      notifyError('Selecciona una marca para el producto.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/productos/listado/${productoId}/`,
        {
          method: 'PUT',
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
          'No se pudo actualizar el producto.'
        throw new Error(detail)
      }

      const normalized = normalizeProducto(data)
      setFormData(normalized)
      setOriginalData(normalized)
      setIsEditing(false)
      onUpdated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrio un error al actualizar el producto.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!isEditing || deleteLoading || !productoId) return
    setDeleteLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/productos/listado/${productoId}/`,
        { method: 'DELETE' },
        token
      )

      if (!response.ok && response.status !== 204) {
        const data = await response.json().catch(() => ({}))
        const detail = data?.detail || 'No se pudo eliminar el producto.'
        throw new Error(detail)
      }

      onDeleted?.(productoId)
      setShowDeleteDialog(false)
    } catch (err) {
      notifyError(err.message || 'Ocurrio un error al eliminar el producto.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleCancelEdit = () => {
    setFormData(originalData)
    setMarcaQuery(originalMarcaNombre)
    setSelectedSuppliers(originalSuppliers)
    setIsEditing(false)
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

  const editorDisabled = saving || loadingData || !isEditing

  return (
    <div className="create-user__overlay" role="dialog" aria-modal="true" style={overlayStyle}>
      <div className="create-user__modal" ref={modalRef} style={modalStyle}>
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>
              {formData.codigo && formData.nombre
                ? `${formData.codigo}: ${formData.nombre}`
                : (formData.codigo || formData.nombre || (productoId ? `Producto #${productoId}` : 'Producto'))}
            </h3>
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

        <div className="create-user__content">
          <div className="create-user__tabs" role="tablist" aria-label="Secciones del producto">
            <button type="button" className="create-user__tab create-user__tab--active" disabled>
              General
            </button>
          </div>

          <div className="create-user__body">
            <section className="create-user__section">
              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Datos del producto</p>
                  <h4>Informacion basica</h4>
                </div>
              </div>

              <div className="create-user__grid create-user__grid--two">
                <label className="create-user__field">
                  <span>Codigo</span>
                  <input
                    name="codigo"
                    type="text"
                    value={formData.codigo}
                    onChange={handleChange}
                    disabled={editorDisabled}
                  />
                </label>

                <label className="create-user__field">
                  <span>Nombre</span>
                  <input
                    name="nombre"
                    type="text"
                    value={formData.nombre}
                    onChange={handleChange}
                    disabled={editorDisabled}
                  />
                </label>

                <label className="create-user__field">
                  <span>Marca</span>
                  <input
                    name="marca"
                    type="text"
                    placeholder="Escribe para buscar"
                    value={marcaQuery}
                    onChange={handleMarcaInputChange}
                    disabled={editorDisabled}
                  />
                  <div className="create-user__branches" style={{ maxHeight: 180, overflow: 'auto', paddingRight: 4 }}>
                    {brands.slice(0, 40).map((brand) => (
                      <button
                        key={brand.id}
                        type="button"
                        className="create-user__branch-option"
                        style={{ cursor: 'pointer', textAlign: 'left' }}
                        onClick={() => handleMarcaSelect(brand)}
                        disabled={editorDisabled}
                      >
                        <div className="create-user__branch-info">
                          <span>{brand.nombre}</span>
                          <small>{brand.codigo ? `Codigo: ${brand.codigo}` : `ID: ${brand.id}`}</small>
                        </div>
                      </button>
                    ))}
                    {!brands.length && (
                      <small className="muted">{marcaQuery.trim() ? 'Sin resultados.' : 'Escribe para buscar.'}</small>
                    )}
                  </div>
                </label>

                <label className="create-user__field">
                  <span>Pieza original</span>
                  <select name="pieza_original" value={formData.pieza_original ? 'true' : 'false'} onChange={handleChange} disabled={editorDisabled}>
                    <option value="true">Si</option>
                    <option value="false">No</option>
                  </select>
                </label>

                <label className="create-user__field">
                  <span>Costo minimo</span>
                  <input
                    name="costo_minimo"
                    type="number"
                    step="0.01"
                    value={formData.costo_minimo}
                    onChange={handleChange}
                    disabled={editorDisabled}
                  />
                </label>

                <label className="create-user__field">
                  <span>Costo maximo</span>
                  <input
                    name="costo_maximo"
                    type="number"
                    step="0.01"
                    value={formData.costo_maximo}
                    onChange={handleChange}
                    disabled={editorDisabled}
                  />
                </label>

                <label className="create-user__field">
                  <span>Precio sugerido</span>
                  <input
                    name="precio"
                    type="number"
                    step="0.01"
                    value={formData.precio}
                    onChange={handleChange}
                    disabled={editorDisabled}
                  />
                </label>

                <label className="create-user__field create-user__field--full">
                  <span>Casas comerciales</span>
                  <input
                    name="casa_search"
                    type="text"
                    placeholder="Buscar casa comercial"
                    value={casaSearch}
                    onChange={(event) => setCasaSearch(event.target.value)}
                    disabled={editorDisabled}
                  />
                  <div className="create-user__branches" style={{ maxHeight: 220, overflow: 'auto', paddingRight: 4 }}>
                    {filteredSuppliers.slice(0, 60).map((supplier) => {
                      const id = String(supplier.id)
                      const checked = formData.casasIds.includes(id)
                      return (
                        <label key={supplier.id} className="create-user__branch-option">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => handleCasaToggle(id)}
                            disabled={editorDisabled}
                          />
                          <div className="create-user__branch-info">
                            <span>{supplier.nombre}</span>
                            <small>{supplier.codigo ? `Codigo: ${supplier.codigo}` : `ID: ${supplier.id}`}</small>
                          </div>
                        </label>
                      )
                    })}
                    {!filteredSuppliers.length && (
                      <small className="muted">{casaSearch.trim() ? 'Sin resultados.' : 'Escribe para buscar.'}</small>
                    )}
                  </div>
                  {filteredSuppliers.length > 60 && (
                    <small className="muted">Mostrando 60 de {filteredSuppliers.length} resultados.</small>
                  )}
                  <small className="muted">Seleccionadas: {formData.casasIds.length}</small>
                </label>

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
          </div>
        </div>

        <div className="create-user__footer">
          <div className="user-details__footer-left">
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={isEditing ? handleCancelEdit : onClose}
              disabled={saving}
            >
              Cancelar
            </button>
            <button
              type="button"
              className={`create-user__action create-user__action--edit user-details__edit-toggle${isEditing ? ' user-details__edit-toggle--active' : ''}`}
              onClick={() => setIsEditing((prev) => !prev)}
              disabled={loadingData || saving}
            >
              <span className="user-details__toggle-icon">{isEditing ? <Eye size={14} /> : <Pencil size={14} />}</span>
              {isEditing ? 'Solo lectura' : 'Editar'}
            </button>
          </div>

          <div className="user-details__footer-right">
            {isEditing && (
              <>
                <button
                  type="button"
                  className="create-user__action user-details__delete"
                  onClick={() => setShowDeleteDialog(true)}
                  disabled={saving}
                >
                  Eliminar
                </button>
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? 'Guardando...' : 'Guardar cambios'}
                </button>
              </>
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

      {showDeleteDialog && (
        <div className="user-details__confirm-overlay">
          <div className="user-details__confirm-dialog">
            <div className="user-details__confirm-icon">
              <Info size={18} />
            </div>
            <div className="user-details__confirm-content">
              <h4>Eliminar producto</h4>
              <p>Deseas eliminar este producto? Esta accion no se puede deshacer.</p>
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
                className="create-user__action user-details__confirm-danger"
                onClick={handleDelete}
                disabled={deleteLoading}
              >
                {deleteLoading ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ProductoDetails
