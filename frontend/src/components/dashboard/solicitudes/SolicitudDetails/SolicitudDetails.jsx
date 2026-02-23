import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import { API_URL, authFetch } from '../../../../utils/api'
import CreateProducto from '../../productos/CreateProducto/CreateProducto'

const MIN_WIDTH = 760
const MIN_HEIGHT = 560
const VIEWPORT_PADDING = 12

const formatDate = (value) => {
  if (!value) return '-'
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString('es-EC')
}

function SolicitudDetails({ open, solicitudId, token, onClose, onUpdated, onError }) {
  const [solicitud, setSolicitud] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [linkingProduct, setLinkingProduct] = useState(false)
  const [showCreateProducto, setShowCreateProducto] = useState(false)
  const [activeTab, setActiveTab] = useState('productos')
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
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

  const fetchSolicitud = useCallback(async () => {
    if (!solicitudId || !token) return
    setLoading(true)
    setError('')
    try {
      const response = await authFetch(`${API_URL}/solicitudes/solicitudes/${solicitudId}/`, {}, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || 'No se pudo cargar la solicitud.'
        throw new Error(detail)
      }
      setSolicitud(data)
    } catch (err) {
      setSolicitud(null)
      setError(err?.message || 'Ocurrio un error al cargar la solicitud.')
    } finally {
      setLoading(false)
    }
  }, [solicitudId, token])

  useEffect(() => {
    if (!open) return
    setSolicitud(null)
    setError('')
    setShowCreateProducto(false)
    setLinkingProduct(false)
    setActiveTab('productos')
    setIsMaximized(false)
    restoreRef.current = null
    fetchSolicitud()
  }, [open, fetchSolicitud])

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

  const handleProductoCreated = async (productoCreado) => {
    const productoSolicitado = solicitud?.producto_solicitado_data
    if (!productoCreado?.id || !productoSolicitado?.id) {
      notifyError('No se pudo vincular el producto creado.')
      return
    }

    setLinkingProduct(true)
    try {
      const response = await authFetch(
        `${API_URL}/solicitudes/productos-solicitados/${productoSolicitado.id}/`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            producto_id: Number(productoCreado.id),
            conseguido: true,
          }),
        },
        token
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || 'No se pudo enlazar el producto a la solicitud.'
        throw new Error(detail)
      }

      setShowCreateProducto(false)
      await fetchSolicitud()
      onUpdated?.(data)
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al enlazar el producto.')
    } finally {
      setLinkingProduct(false)
    }
  }

  if (!open) return null

  const productoSolicitado = solicitud?.producto_solicitado_data || null
  const productoResuelto = solicitud?.producto_resuelto_data || null
  const puedeCrearProducto =
    solicitud?.tabla === 'producto_solicitado' && productoSolicitado && !productoSolicitado.conseguido

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
            <h3>{solicitudId ? `Solicitud #${solicitudId}` : 'Detalle de solicitud'}</h3>
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
              <>
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Solicitud</p>
                      <h4>Detalle</h4>
                    </div>
                  </div>
                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field">
                      <span>Fecha</span>
                      <input value={formatDate(solicitud.fecha)} disabled />
                    </label>
                    <label className="create-user__field">
                      <span>Sucursal</span>
                      <input value={solicitud.sucursal_data?.nombre || '-'} disabled />
                    </label>
                    <label className="create-user__field">
                      <span>Cantidad</span>
                      <input value={String(solicitud.cantidad ?? '-')} disabled />
                    </label>
                    <label className="create-user__field">
                      <span>Estado</span>
                      <input value={solicitud.conseguido ? 'Conseguido' : 'Pendiente'} disabled />
                    </label>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Productos</p>
                      <h4>Productos solicitados</h4>
                    </div>
                  </div>

                  <div className="create-user__locations-table create-user__locations-table--oem">
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>Nombre</span>
                      <span>Descripcion</span>
                      <span>Cantidad</span>
                      <span>Estado</span>
                    </div>
                    <div className="create-user__locations-row">
                      <span>{productoSolicitado?.nombre || solicitud.producto_referencia || '-'}</span>
                      <span>{productoSolicitado?.descripcion || '-'}</span>
                      <span>{String(solicitud.cantidad ?? '-')}</span>
                      <span>{solicitud.conseguido ? 'Conseguido' : 'Pendiente'}</span>
                    </div>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Solicitud</p>
                      <h4>Descripcion general</h4>
                    </div>
                  </div>
                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field create-user__field--full">
                      <span>Comentarios</span>
                      <textarea value={solicitud.descripcion_general || '-'} disabled />
                    </label>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Resolucion</p>
                      <h4>Producto vinculado</h4>
                    </div>
                  </div>
                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field">
                      <span>Codigo</span>
                      <input value={productoResuelto?.codigo || '-'} disabled />
                    </label>
                    <label className="create-user__field">
                      <span>Producto</span>
                      <input value={productoResuelto?.nombre || '-'} disabled />
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
                    <h4>Informacion del cliente</h4>
                  </div>
                </div>
                <div className="create-user__grid create-user__grid--two">
                  <label className="create-user__field">
                    <span>Cliente</span>
                    <input value={solicitud.cliente_nombre || '-'} disabled />
                  </label>
                  <label className="create-user__field">
                    <span>Cedula/RUC</span>
                    <input value={solicitud.cliente_data?.cedula_ruc || '-'} disabled />
                  </label>
                  <label className="create-user__field">
                    <span>Telefono</span>
                    <input value={solicitud.cliente_data?.telefono || '-'} disabled />
                  </label>
                  <label className="create-user__field create-user__field--full">
                    <span>Direccion</span>
                    <input value={solicitud.cliente_data?.direccion || '-'} disabled />
                  </label>
                </div>
              </section>
            )}

            {!loading && !solicitud && !error && (
              <p className="workspace__subtitle" style={{ margin: 0 }}>
                No se encontro la solicitud seleccionada.
              </p>
            )}
          </div>
        </div>

        {error && <div className="create-user__error">{error}</div>}

        <div className="create-user__footer">
          <div className="user-details__footer-left">
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={onClose}
              disabled={linkingProduct}
            >
              Cerrar
            </button>
          </div>
          <div className="user-details__footer-right">
            {puedeCrearProducto && (
              <button
                type="button"
                className="create-user__action create-user__action--primary"
                onClick={() => setShowCreateProducto(true)}
                disabled={linkingProduct}
              >
                {linkingProduct ? 'Enlazando...' : 'Crear producto'}
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

      <CreateProducto
        open={showCreateProducto}
        onClose={() => setShowCreateProducto(false)}
        onCreated={handleProductoCreated}
        token={token}
        onError={notifyError}
      />
    </div>
  )
}

export default SolicitudDetails
