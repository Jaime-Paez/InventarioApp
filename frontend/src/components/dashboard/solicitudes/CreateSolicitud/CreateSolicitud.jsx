import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import { API_URL, authFetch } from '../../../../utils/api'

const MIN_WIDTH = 760
const MIN_HEIGHT = 560
const VIEWPORT_PADDING = 12

const initialCliente = {
  nombres: '',
  apellidos: '',
  cedula_ruc: '',
  correo: '',
  telefono: '',
  direccion: '',
}

const initialProductoDraft = {
  nombre: '',
  descripcion: '',
  cantidad: '1',
}

const todayISO = () => new Date().toISOString().slice(0, 10)
const normalizeString = (value) => String(value ?? '').trim().toLowerCase()

function CreateSolicitud({ open, onClose, onCreated, token, onError }) {
  const [cliente, setCliente] = useState(initialCliente)
  const [selectedCliente, setSelectedCliente] = useState(null)
  const [clienteResultados, setClienteResultados] = useState([])
  const [clienteLoading, setClienteLoading] = useState(false)
  const [showClienteDropdown, setShowClienteDropdown] = useState(false)

  const [sucursalId, setSucursalId] = useState('')
  const [fecha, setFecha] = useState(todayISO())
  const [descripcionGeneral, setDescripcionGeneral] = useState('')
  const [sucursales, setSucursales] = useState([])
  const [sucursalesLoading, setSucursalesLoading] = useState(false)

  const [showProductoForm, setShowProductoForm] = useState(false)
  const [productoDraft, setProductoDraft] = useState(initialProductoDraft)
  const [productoError, setProductoError] = useState('')
  const [productos, setProductos] = useState([])

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('productos')
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const clienteDropdownRef = useRef(null)
  const searchTimerRef = useRef(null)
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const sizeRef = useRef(size)
  const positionRef = useRef(position)
  const restoreRef = useRef(null)

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

  const clearAll = useCallback(() => {
    setCliente(initialCliente)
    setSelectedCliente(null)
    setClienteResultados([])
    setClienteLoading(false)
    setShowClienteDropdown(false)

    setSucursalId('')
    setFecha(todayISO())
    setDescripcionGeneral('')
    setActiveTab('productos')

    setShowProductoForm(false)
    setProductoDraft(initialProductoDraft)
    setProductoError('')
    setProductos([])

    setError('')
    setLoading(false)
    setIsMaximized(false)
    restoreRef.current = null

    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
  }, [])

  const fetchSucursales = useCallback(async () => {
    if (!token) return
    setSucursalesLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/inventario/sucursales/?modulo=solicitudes&page_size=200`,
        {},
        token
      )
      if (!response.ok) throw new Error('No se pudieron cargar las sucursales.')
      const data = await response.json()
      const list = Array.isArray(data) ? data : data?.results || []
      setSucursales(list)
    } catch (err) {
      notifyError(err?.message || 'Ocurrió un error al cargar las sucursales.')
    } finally {
      setSucursalesLoading(false)
    }
  }, [notifyError, token])

  useEffect(() => {
    if (!open) return
    clearAll()
    fetchSucursales()
  }, [open, clearAll, fetchSucursales])

  useEffect(
    () => () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    },
    []
  )

  useEffect(() => {
    if (!open) return
    const cedulaTerm = String(cliente.cedula_ruc || '').trim()
    if (!cedulaTerm || cedulaTerm.length < 4 || !token) {
      setClienteResultados([])
      setClienteLoading(false)
      return
    }

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)

    setClienteLoading(true)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const response = await authFetch(
          `${API_URL}/solicitudes/solicitudes/buscar-cliente/?cedula_ruc=${encodeURIComponent(cedulaTerm)}&page_size=10`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudo buscar el cliente.')
        const data = await response.json()
        const list = Array.isArray(data) ? data : data?.results || []
        setClienteResultados(list)
      } catch {
        setClienteResultados([])
      } finally {
        setClienteLoading(false)
      }
    }, 320)

    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }
    }
  }, [open, token, cliente.cedula_ruc])

  useLayoutEffect(() => {
    if (!open) return
    const { availableWidth, availableHeight } = getViewportMetrics()
    const nextWidth = Math.min(MIN_WIDTH, availableWidth)
    const nextHeight = Math.min(MIN_HEIGHT, availableHeight)
    setSize({ width: nextWidth, height: nextHeight })
    setPosition({
      x: Math.max((window.innerWidth - nextWidth) / 2, VIEWPORT_PADDING),
      y: Math.max((window.innerHeight - nextHeight) / 2, VIEWPORT_PADDING),
    })
  }, [open, getViewportMetrics])

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    positionRef.current = position
  }, [position])

  useEffect(() => {
    if (!showClienteDropdown) return
    const handleClickOutside = (event) => {
      if (!clienteDropdownRef.current || clienteDropdownRef.current.contains(event.target)) return
      setShowClienteDropdown(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [showClienteDropdown])

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

  const handleMouseDown = (event) => {
    if (isMaximized || !modalRef.current) return
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

  const handleClienteFieldChange = (event) => {
    const { name, value } = event.target
    setError('')

    setCliente((prev) => ({ ...prev, [name]: value }))
    if (selectedCliente && normalizeString(value) !== normalizeString(selectedCliente[name])) {
      setSelectedCliente(null)
    }
    if (name === 'cedula_ruc') {
      setShowClienteDropdown(Boolean(value))
    }
  }

  const handleClienteSelect = (item) => {
    if (!item) return
    setSelectedCliente(item)
    setCliente({
      nombres: item.nombres || '',
      apellidos: item.apellidos || '',
      cedula_ruc: item.cedula_ruc || '',
      correo: item.correo || '',
      telefono: item.telefono || '',
      direccion: item.direccion || '',
    })
    setShowClienteDropdown(false)
  }

  const handleProductoDraftChange = (event) => {
    const { name, value } = event.target
    setProductoDraft((prev) => ({ ...prev, [name]: value }))
    setProductoError('')
  }

  const normalizeProductoKey = (item) =>
    `${String(item?.nombre ?? '').trim().toLowerCase()}|${String(item?.descripcion ?? '')
      .trim()
      .toLowerCase()}|${String(item?.cantidad ?? '')}`

  const productoKeySet = new Set(productos.map((item) => normalizeProductoKey(item)).filter(Boolean))

  const handleAgregarProducto = () => {
    const nombre = String(productoDraft.nombre || '').trim()
    const descripcion = String(productoDraft.descripcion || '').trim()
    const cantidad = Number(productoDraft.cantidad)

    if (!nombre) {
      setProductoError('Ingresa el nombre del producto solicitado.')
      return
    }

    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      setProductoError('La cantidad debe ser mayor a 0.')
      return
    }

    const item = {
      uid: `ps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      nombre,
      descripcion,
      cantidad: Math.max(1, Math.floor(cantidad)),
    }

    if (productoKeySet.has(normalizeProductoKey(item))) {
      setProductoError('Ese producto ya esta en la tabla.')
      return
    }

    setProductos((prev) => [...prev, item])
    setProductoDraft(initialProductoDraft)
    setProductoError('')
  }

  const handleQuitarProducto = (uid) => {
    setProductos((prev) => prev.filter((item) => item.uid !== uid))
    setProductoError('')
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')

    if (!sucursalId) {
      setError('Debe seleccionar una sucursal.')
      return
    }

    if (!productos.length) {
      setError('Debe agregar al menos un producto solicitado.')
      return
    }

    if (!selectedCliente) {
      const requiredFields = ['nombres', 'apellidos', 'cedula_ruc', 'telefono', 'direccion']
      const missing = requiredFields.find((field) => !String(cliente[field] || '').trim())
      if (missing) {
        setError('Complete todos los datos del cliente para continuar.')
        return
      }
    }

    const payload = {
      sucursal_id: Number(sucursalId),
      descripcion_general: String(descripcionGeneral || '').trim(),
      productos: productos.map((item) => ({
        nombre: item.nombre,
        descripcion: item.descripcion,
        cantidad: item.cantidad,
      })),
    }

    if (selectedCliente?.id) {
      payload.cliente_id = Number(selectedCliente.id)
    } else {
      payload.cliente = {
        nombres: String(cliente.nombres || '').trim(),
        apellidos: String(cliente.apellidos || '').trim(),
        cedula_ruc: String(cliente.cedula_ruc || '').trim(),
        correo: String(cliente.correo || '').trim(),
        telefono: String(cliente.telefono || '').trim(),
        direccion: String(cliente.direccion || '').trim(),
      }
    }

    setLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/solicitudes/solicitudes/crear-lote/`,
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
          data?.productos ||
          data?.cliente ||
          data?.sucursal_id ||
          'No se pudo crear la solicitud.'
        throw new Error(Array.isArray(detail) ? detail.join(', ') : String(detail))
      }

      onCreated?.(data)
    } catch (err) {
      setError(err?.message || 'Ocurrió un error al crear la solicitud.')
    } finally {
      setLoading(false)
    }
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

  const showClientHint = Boolean(selectedCliente?.id)

  return (
    <div className="create-user__overlay" role="dialog" aria-modal="true" style={overlayStyle}>
      <div className="create-user__modal" ref={modalRef} style={modalStyle}>
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>Crear solicitud</h3>
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
            {activeTab === 'productos' && (
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
                      <span>Sucursal</span>
                      <select
                        value={sucursalId}
                        onChange={(event) => setSucursalId(event.target.value)}
                        disabled={loading || sucursalesLoading}
                      >
                        <option value="">Selecciona una sucursal</option>
                        {sucursales.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.nombre || `Sucursal ${item.id}`}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="create-user__field">
                      <span>Fecha</span>
                      <input type="date" value={fecha} disabled />
                    </label>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Productos</p>
                      <h4>Productos solicitados</h4>
                    </div>
                    <button
                      type="button"
                      className="create-user__ghost create-user__location-action"
                      onClick={() => {
                        setProductoError('')
                        setShowProductoForm((prev) => {
                          const next = !prev
                          if (!next) setProductoDraft(initialProductoDraft)
                          return next
                        })
                      }}
                      disabled={loading}
                    >
                      {showProductoForm ? 'Cancelar' : 'Agregar producto'}
                    </button>
                  </div>

                  <div className="create-user__locations-table create-user__locations-table--oem">
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>Nombre</span>
                      <span>Descripción</span>
                      <span>Cantidad</span>
                      <span>Acciones</span>
                    </div>

                    {showProductoForm && (
                      <div className="create-user__locations-row create-user__locations-row--form">
                        <span>
                          <input
                            name="nombre"
                            type="text"
                            placeholder="Nombre del producto"
                            value={productoDraft.nombre}
                            onChange={handleProductoDraftChange}
                            disabled={loading}
                          />
                        </span>
                        <span>
                          <input
                            name="descripcion"
                            type="text"
                            placeholder="Descripción"
                            value={productoDraft.descripcion}
                            onChange={handleProductoDraftChange}
                            disabled={loading}
                          />
                        </span>
                        <span>
                          <input
                            name="cantidad"
                            type="number"
                            min="1"
                            step="1"
                            value={productoDraft.cantidad}
                            onChange={handleProductoDraftChange}
                            disabled={loading}
                          />
                        </span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button
                            type="button"
                            className="create-user__ghost"
                            onClick={handleAgregarProducto}
                            disabled={loading}
                          >
                            Agregar
                          </button>
                        </span>
                      </div>
                    )}

                    {!productos.length && !showProductoForm && (
                      <div className="create-user__locations-row create-user__locations-row--empty">
                        <span>Sin productos agregados.</span>
                      </div>
                    )}

                    {productos.map((item) => (
                      <div key={item.uid} className="create-user__locations-row">
                        <span>{item.nombre}</span>
                        <span>{item.descripcion || '-'}</span>
                        <span>{item.cantidad}</span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button
                            type="button"
                            className="create-user__locations-remove"
                            onClick={() => handleQuitarProducto(item.uid)}
                            disabled={loading}
                            aria-label="Eliminar producto"
                          >
                            X
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>

                  {productoError && <div className="create-user__error">{productoError}</div>}
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Solicitud</p>
                      <h4>Descripción general</h4>
                    </div>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field create-user__field--full">
                      <span>Comentarios</span>
                      <textarea
                        value={descripcionGeneral}
                        onChange={(event) => setDescripcionGeneral(event.target.value)}
                        placeholder="Comentarios generales de la solicitud"
                        disabled={loading}
                      />
                    </label>
                  </div>
                </section>
              </>
            )}

            {activeTab === 'cliente' && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Cliente</p>
                    <h4>Datos del cliente</h4>
                  </div>
                </div>

                <div className="create-user__grid create-user__grid--two">
                  <label className="create-user__field">
                    <span>Cedula/RUC</span>
                    <div className="create-user__dropdown" ref={clienteDropdownRef}>
                      <input
                        name="cedula_ruc"
                        type="text"
                        placeholder="Buscar por cedula"
                        value={cliente.cedula_ruc}
                        onChange={handleClienteFieldChange}
                        onFocus={() => setShowClienteDropdown(Boolean(cliente.cedula_ruc))}
                        disabled={loading}
                        autoComplete="off"
                      />
                      {showClienteDropdown && (
                        <div className="create-user__dropdown-panel">
                          <div className="create-user__dropdown-results">
                            {clienteLoading && <small className="muted">Buscando cliente...</small>}
                            {!clienteLoading && !clienteResultados.length && (
                              <small className="muted">Sin coincidencias para la cedula ingresada.</small>
                            )}
                            {clienteResultados.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                className="create-user__result-option"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => handleClienteSelect(item)}
                              >
                                <div className="create-user__result-info">
                                  <strong>{item.nombre_completo || `${item.nombres || ''} ${item.apellidos || ''}`.trim()}</strong>
                                  <small>{item.cedula_ruc || 'Sin cedula'}</small>
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </label>

                  <label className="create-user__field">
                    <span>Nombres</span>
                    <input
                      name="nombres"
                      type="text"
                      value={cliente.nombres}
                      onChange={handleClienteFieldChange}
                      disabled={loading}
                    />
                  </label>

                  <label className="create-user__field">
                    <span>Apellidos</span>
                    <input
                      name="apellidos"
                      type="text"
                      value={cliente.apellidos}
                      onChange={handleClienteFieldChange}
                      disabled={loading}
                    />
                  </label>

                  <label className="create-user__field">
                    <span>Correo</span>
                    <input
                      name="correo"
                      type="email"
                      value={cliente.correo}
                      onChange={handleClienteFieldChange}
                      disabled={loading}
                    />
                  </label>

                  <label className="create-user__field">
                    <span>Teléfono</span>
                    <input
                      name="telefono"
                      type="text"
                      value={cliente.telefono}
                      onChange={handleClienteFieldChange}
                      disabled={loading}
                    />
                  </label>

                  <label className="create-user__field create-user__field--full">
                    <span>Dirección</span>
                    <input
                      name="direccion"
                      type="text"
                      value={cliente.direccion}
                      onChange={handleClienteFieldChange}
                      disabled={loading}
                    />
                  </label>
                </div>

                {showClientHint && (
                  <small className="muted">Cliente existente detectado. Se usara el registro actual al guardar.</small>
                )}
              </section>
            )}
          </div>

          {error && <div className="create-user__error">{error}</div>}

          <div className="create-user__footer">
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={onClose}
              disabled={loading}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="create-user__action create-user__action--primary"
              disabled={loading}
            >
              {loading ? 'Guardando...' : 'Crear solicitud'}
            </button>
          </div>
        </form>

        <button
          type="button"
          aria-label="Cambiar tamaño de ventana"
          className="create-user__resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      </div>
    </div>
  )
}

export default CreateSolicitud
