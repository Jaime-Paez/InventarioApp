import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../SucursalMap.css'
import 'leaflet/dist/leaflet.css'
import { API_URL, authFetch } from '../../../../utils/api'
import useModalAnimation from '../../common/useModalAnimation'
import useUnsavedChangesGuard from '../../common/unsavedChanges/useUnsavedChangesGuard'
const MAP_ZOOM = 16
const MIN_WIDTH = 650
const MIN_HEIGHT = 720
const VIEWPORT_PADDING = 12

const initialForm = {
  nombre: '',
  direccion: '',
  puede_compra_local: false,
}

const DEFAULT_CENTER = { latitud: -0.204404, longitud: -78.496283 }
const ECUADOR_BOUNDS = {
  minLat: -5.015,
  maxLat: 1.5,
  minLng: -92.2,
  maxLng: -75.2,
}

function CreateSucursal({ open, onClose, onCreated, token, onError }) {
  const [formData, setFormData] = useState(initialForm)
  const [loading, setLoading] = useState(false)
  const [location, setLocation] = useState(DEFAULT_CENTER)
  const [isMaximized, setIsMaximized] = useState(false)

  const modalRef = useRef(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const sizeRef = useRef(size)
  const positionRef = useRef(position)
  const restoreRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const mapContainerRef = useRef(null)

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
  const formatCoordinate = (value) => (Number.isFinite(value) ? Number(value.toFixed(6)) : value)
  const isWithinEcuador = (lat, lng) =>
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= ECUADOR_BOUNDS.minLat &&
    lat <= ECUADOR_BOUNDS.maxLat &&
    lng >= ECUADOR_BOUNDS.minLng &&
    lng <= ECUADOR_BOUNDS.maxLng


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

  useEffect(() => {
    if (!open) return
    setFormData(initialForm)
    setLoading(false)
    setLocation(DEFAULT_CENTER)
    setIsMaximized(false)
    restoreRef.current = null
  }, [open])

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

  useEffect(() => {
    if (!open || !mapContainerRef.current || mapRef.current) return
    let isActive = true

    const setupMap = async () => {
      const L = await import('leaflet')
      if (!isActive || mapRef.current || !mapContainerRef.current) return

      const map = L.map(mapContainerRef.current).setView(
        [DEFAULT_CENTER.latitud, DEFAULT_CENTER.longitud],
        MAP_ZOOM
      )
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map)

      const setMarker = (lat, lng) => {
        if (!isWithinEcuador(lat, lng)) {
          notifyError('Selecciona una ubicación dentro de Ecuador.')
          return
        }
        const formattedLat = formatCoordinate(lat)
        const formattedLng = formatCoordinate(lng)

        setLocation({ latitud: formattedLat, longitud: formattedLng })
        if (markerRef.current) {
          markerRef.current.setLatLng([formattedLat, formattedLng])
        } else {
          markerRef.current = L.marker([formattedLat, formattedLng]).addTo(map)
        }
      }

      map.on('click', (event) => {
        const { lat, lng } = event.latlng
        setMarker(lat, lng)
      })

      setMarker(DEFAULT_CENTER.latitud, DEFAULT_CENTER.longitud)

      mapRef.current = map
    }

    setupMap()

    return () => {
      isActive = false
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        markerRef.current = null
      }
    }
  }, [open])

  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return
    markerRef.current.setLatLng([location.latitud, location.longitud])
    mapRef.current.setView([location.latitud, location.longitud])
  }, [location])

  const handleChange = (event) => {
    const { name, value, type, checked } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)

    const payload = {
      nombre: formData.nombre.trim(),
      direccion: formData.direccion.trim(),
      puede_compra_local: Boolean(formData.puede_compra_local),
      latitud: formatCoordinate(Number(location.latitud)),
      longitud: formatCoordinate(Number(location.longitud)),
    }

    if (!payload.nombre) {
      setLoading(false)
      notifyError('Define un nombre para la sucursal.')
      return
    }

    if (!Number.isFinite(payload.latitud) || !Number.isFinite(payload.longitud)) {
      setLoading(false)
      notifyError('Selecciona un punto en el mapa para guardar la sucursal.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/inventario/sucursales/`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || data?.nombre?.[0] || 'No se pudo crear la sucursal.'
        throw new Error(detail)
      }

      setFormData(initialForm)
      onCreated?.(data)
      submitSucceededRef.current = true
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al crear la sucursal.')
    } finally {
      setLoading(false)
    }
  }

  const handleMouseDown = (event) => {
    if (isMaximized) {
      const restore = restoreRef.current
      const fallbackSize = sizeRef.current
      const restoredSize = restore?.size || fallbackSize
      const restoredPosition = restore?.position || {
        x: Math.max((window.innerWidth - restoredSize.width) / 2, VIEWPORT_PADDING),
        y: Math.max((window.innerHeight - restoredSize.height) / 2, VIEWPORT_PADDING),
      }

      sizeRef.current = restoredSize
      positionRef.current = restoredPosition
      setSize(restoredSize)
      setPosition(restoredPosition)
      setIsMaximized(false)

      const offsetX = Math.min(
        Math.max(event.clientX - restoredPosition.x, 24),
        Math.max(restoredSize.width - 24, 24)
      )
      const offsetY = Math.min(
        Math.max(event.clientY - restoredPosition.y, 12),
        56
      )
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
  const { shouldRender, isClosing } = useModalAnimation(open)

  // "¿Guardar cambios?" al cerrar con datos ingresados (tambien al cerrar la
  // pestana). Guardar = el mismo boton de crear.
  const submitSucceededRef = useRef(false)
  const unsavedGuard = useUnsavedChangesGuard({
    watch: { formData, location },
    enabled: Boolean(open),
    onSave: async () => {
      submitSucceededRef.current = false
      await handleSubmit({ preventDefault() {} })
      return submitSucceededRef.current
    },
    onClose,
    label: 'Nueva sucursal',
  })

  if (!shouldRender) return null

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
    <div className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`} role="dialog" aria-modal="true" style={overlayStyle}>
      {unsavedGuard.dialog}
      <div
        className={`create-user__modal${isClosing ? ' create-user__modal--closing' : ''}`}
        ref={modalRef} {...unsavedGuard.interactionProps}
        style={modalStyle}
      >
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>Crear sucursal</h3>
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
              onClick={unsavedGuard.requestClose}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <form className="create-user__form create-user__form--create" noValidate onSubmitCapture={(event) => event.currentTarget.classList.add('create-user__form--submitted')} onSubmit={handleSubmit}>
          <div className="create-user__tabs" role="tablist" aria-label="Secciones de la sucursal">
            <button
              type="button"
              className="create-user__tab create-user__tab--active"
              disabled
            >
              General
            </button>
          </div>

          <div className="create-user__body">
            <section className="create-user__section">
              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Datos de la sucursal</p>
                  <h4>Información básica</h4>
                </div>
              </div>

              <div className="create-user__grid create-user__grid--two">
                <label className="create-user__field create-user__field--full">
                  <span>Descripción</span>
                  <input
                    name="nombre"
                    type="text"
                    placeholder="Descripción de la sucursal"
                    value={formData.nombre}
                    onChange={handleChange}
                    required
                    disabled={loading}
                  />
                </label>

                <label className="create-user__field create-user__field--full">
                  <span>Dirección</span>
                  <input
                    name="direccion"
                    type="text"
                    placeholder="Dirección"
                    value={formData.direccion}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </label>

                <label className="create-user__checkbox create-user__field--full">
                  <input
                    type="checkbox"
                    name="puede_compra_local"
                    checked={Boolean(formData.puede_compra_local)}
                    onChange={handleChange}
                    disabled={loading}
                  />
                  <div>
                    <span>Puede hacer compras locales</span>
                    <p>Solo las sucursales con este permiso pueden registrar entradas de compra local.</p>
                  </div>
                </label>
              </div>

              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Ubicación</p>
                  <h4>Selecciona la ubicación en el mapa</h4>
                </div>
              </div>

              <div className="sucursal-map__container">
                <div ref={mapContainerRef} className="sucursal-map__canvas" role="presentation" />
              </div>
            </section>
          </div>

          <div className="create-user__footer">
            <button type="button" className="create-user__action create-user__action--cancel" onClick={unsavedGuard.requestClose}>
              Cancelar
            </button>
            <button type="submit" className="create-user__action create-user__action--primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Crear sucursal'}
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

export default CreateSucursal




