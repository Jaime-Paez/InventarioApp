import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../SucursalMap.css'
import 'leaflet/dist/leaflet.css'
import { authFetch } from '../../../../utils/api'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const MAP_ZOOM = 16
const MIN_WIDTH = 620
const MIN_HEIGHT = 420
const VIEWPORT_PADDING = 12

const initialForm = {
  nombre: '',
  direccion: '',
}

const DEFAULT_CENTER = { latitud: -0.204404, longitud: -78.496283 }

function CreateSucursal({ open, onClose, onCreated, token, onError }) {
  const [formData, setFormData] = useState(initialForm)
  const [loading, setLoading] = useState(false)
  const [location, setLocation] = useState(DEFAULT_CENTER)

  const modalRef = useRef(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const sizeRef = useRef(size)
  const positionRef = useRef(position)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const mapContainerRef = useRef(null)
  const isMountedRef = useRef(false)

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

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
    isMountedRef.current = true
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2)
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_PADDING * 2)
    const nextWidth = clamp(MIN_WIDTH, MIN_WIDTH, maxWidth)
    const nextHeight = clamp(MIN_HEIGHT, MIN_HEIGHT, maxHeight)
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

  const reverseGeocode = useCallback(async (lat, lng) => {
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`)
      if (!response.ok) return null
      const data = await response.json()
      return {
        displayName: data?.display_name,
      }
    } catch (error) {
      console.error('Error al obtener la dirección:', error)
      return null
    }
  }, [])

  const initializeMap = useCallback(async () => {
    if (!mapContainerRef.current || mapRef.current) return
    const L = await import('leaflet')

    const map = L.map(mapContainerRef.current).setView(
      [location.latitud, location.longitud],
      MAP_ZOOM
    )
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)

    const setMarker = (lat, lng) => {
      setLocation({ latitud: lat, longitud: lng })
      if (markerRef.current) {
        markerRef.current.setLatLng([lat, lng])
      } else {
        markerRef.current = L.marker([lat, lng]).addTo(map)
      }
      reverseGeocode(lat, lng).then((result) => {
        if (!result || !isMountedRef.current) return
        setFormData((prev) => ({
          ...prev,
          direccion: result.displayName || prev.direccion,
        }))
      })
    }

    map.on('click', (event) => {
      const { lat, lng } = event.latlng
      setMarker(lat, lng)
    })

    setMarker(location.latitud, location.longitud)

    mapRef.current = map
  }, [location.latitud, location.longitud])

  useEffect(() => {
    if (open) {
      initializeMap()
    }

    return () => {
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        markerRef.current = null
      }
      isMountedRef.current = false
    }
  }, [open, initializeMap])

  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return
    markerRef.current.setLatLng([location.latitud, location.longitud])
    mapRef.current.setView([location.latitud, location.longitud])
  }, [location])

  const handleChange = (event) => {
    const { name, value } = event.target
    if (name === 'direccion') return
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)

    const payload = {
      nombre: formData.nombre.trim(),
      direccion: formData.direccion.trim(),
      latitud: Number(location.latitud),
      longitud: Number(location.longitud),
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
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al crear la sucursal.')
    } finally {
      setLoading(false)
    }
  }

  const handleMouseDown = (event) => {
    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    dragData.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }

  const handleResizeMouseDown = (event) => {
    event.preventDefault()
    event.stopPropagation()
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
      const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - positionRef.current.x - VIEWPORT_PADDING)
      const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - positionRef.current.y - VIEWPORT_PADDING)
      const width = clamp(resizeData.current.startWidth + deltaX, MIN_WIDTH, maxWidth)
      const height = clamp(resizeData.current.startHeight + deltaY, MIN_HEIGHT, maxHeight)
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
      const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2)
      const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_PADDING * 2)

      setSize((prev) => {
        const width = clamp(prev.width, MIN_WIDTH, maxWidth)
        const height = clamp(prev.height, MIN_HEIGHT, maxHeight)

        setPosition((prevPosition) => ({
          x: Math.min(Math.max(prevPosition.x, VIEWPORT_PADDING), Math.max(window.innerWidth - width - VIEWPORT_PADDING, VIEWPORT_PADDING)),
          y: Math.min(Math.max(prevPosition.y, VIEWPORT_PADDING), Math.max(window.innerHeight - height - VIEWPORT_PADDING, VIEWPORT_PADDING)),
        }))

        return { width, height }
      })
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [])

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
      <div
        className="create-user__modal"
        ref={modalRef}
        style={modalStyle}
      >
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>Crear sucursal</h3>
          </div>
          <button
            type="button"
            className="create-user__icon-button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClose}
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>

        <form className="create-user__form" onSubmit={handleSubmit}>
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
                  <span>Nombre</span>
                  <input
                    name="nombre"
                    type="text"
                    placeholder="Nombre de la sucursal"
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
                    readOnly
                  />
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
            <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose}>
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
