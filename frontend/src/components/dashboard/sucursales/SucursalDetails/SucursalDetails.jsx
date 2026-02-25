import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Eye, Info, Pencil } from 'lucide-react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../../admin/UsersDetails/UsersDetails.css'
import '../SucursalMap.css'
import 'leaflet/dist/leaflet.css'
import { API_URL, authFetch } from '../../../../utils/api'
const MAP_ZOOM = 16
const MIN_WIDTH = 650
const MIN_HEIGHT = 500
const VIEWPORT_PADDING = 12

const emptyForm = {
  nombre: '',
  direccion: '',
  latitud: 0,
  longitud: 0,
}

const DEFAULT_CENTER = { latitud: -0.204404, longitud: -78.496283 }
const ECUADOR_BOUNDS = {
  minLat: -5.015,
  maxLat: 1.5,
  minLng: -92.2,
  maxLng: -75.2,
}

function SucursalDetails({ open, sucursalId, token, onClose, onUpdated, onDeleted, onError }) {
  const [formData, setFormData] = useState(emptyForm)
  const [originalData, setOriginalData] = useState(emptyForm)
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const sizeRef = useRef(size)
  const positionRef = useRef(position)
  const restoreRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const mapContainerRef = useRef(null)
  const isEditingRef = useRef(false)

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

  const ensureEcuadorLocation = (lat, lng) => {
    if (isWithinEcuador(lat, lng)) {
      return { latitud: formatCoordinate(lat), longitud: formatCoordinate(lng) }
    }
    return DEFAULT_CENTER
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

  const normalizeSucursal = (data) => {
    const safeLocation = ensureEcuadorLocation(
      Number(data?.latitud ?? 0),
      Number(data?.longitud ?? 0)
    )
    return {
      nombre: data?.nombre ?? '',
      direccion: data?.direccion ?? '',
      latitud: safeLocation.latitud,
      longitud: safeLocation.longitud,
    }
  }

  const handleChange = (event) => {
    if (!isEditing) return
    const { name, value } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const geocodeAddress = useCallback(async (address) => {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ec&q=${encodeURIComponent(address)}`
      const response = await fetch(url, {
        headers: {
          'Accept-Language': 'es',
        },
      })
      if (!response.ok) return null
      const data = await response.json()
      const match = Array.isArray(data) ? data[0] : null
      if (!match) return null
      const lat = Number(match.lat)
      const lng = Number(match.lon)
      return { lat, lng }
    } catch (error) {
      console.error('Error al buscar la ubicación:', error)
      return null
    }
  }, [])

  const handleAddressCommit = useCallback(async () => {
    if (!isEditing) return
    const address = formData.direccion.trim()
    if (!address) return
    const result = await geocodeAddress(address)
    if (!result || !isWithinEcuador(result.lat, result.lng)) {
      notifyError('La dirección debe estar dentro de Ecuador.')
      return
    }
    const nextLocation = {
      latitud: formatCoordinate(result.lat),
      longitud: formatCoordinate(result.lng),
    }
    setFormData((prev) => ({
      ...prev,
      latitud: nextLocation.latitud,
      longitud: nextLocation.longitud,
    }))
    if (mapRef.current) {
      mapRef.current.setView([nextLocation.latitud, nextLocation.longitud], MAP_ZOOM)
    }
  }, [formData.direccion, geocodeAddress, isEditing, isWithinEcuador, notifyError])

  const fetchSucursal = useCallback(async () => {
    if (!sucursalId) return
    setLoadingData(true)
    try {
      const response = await authFetch(
        `${API_URL}/inventario/sucursales/${sucursalId}/`,
        {},
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || 'No se pudo cargar la información de la sucursal.'
        throw new Error(detail)
      }

      const normalized = normalizeSucursal(data)
      setFormData(normalized)
      setOriginalData(normalized)
      setIsEditing(false)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al obtener la información de la sucursal.')
    } finally {
      setLoadingData(false)
    }
  }, [notifyError, token, sucursalId])

  useEffect(() => {
    if (!open) return
    setIsEditing(false)
    setFormData(emptyForm)
    setOriginalData(emptyForm)
    setActiveTab('general')
    setIsMaximized(false)
    restoreRef.current = null
    fetchSucursal()
    return () => {
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        markerRef.current = null
      }
    }
  }, [open, fetchSucursal])

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
    isEditingRef.current = isEditing
  }, [isEditing])

  const toggleMapInteractions = useCallback((enabled) => {
    if (!mapRef.current) return
    const map = mapRef.current
    if (enabled) {
      map.dragging.enable()
      map.scrollWheelZoom.enable()
      map.doubleClickZoom.enable()
      map.touchZoom.enable()
      map.boxZoom.enable()
      map.keyboard.enable()
      map.tap?.enable?.()
    } else {
      map.dragging.disable()
      map.scrollWheelZoom.disable()
      map.doubleClickZoom.disable()
      map.touchZoom.disable()
      map.boxZoom.disable()
      map.keyboard.disable()
      map.tap?.disable?.()
    }
  }, [])

  const initializeMap = useCallback(async () => {
    if (!mapContainerRef.current || mapRef.current) return
    const L = await import('leaflet')

    const startLat = formData.latitud || 0
    const startLng = formData.longitud || 0

    const map = L.map(mapContainerRef.current, {
      zoomControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
    }).setView([startLat, startLng], MAP_ZOOM)
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

      if (!isEditingRef.current) return
      setFormData((prev) => ({ ...prev, latitud: formattedLat, longitud: formattedLng }))
      if (markerRef.current) {
        markerRef.current.setLatLng([formattedLat, formattedLng])
      } else {
        markerRef.current = L.marker([formattedLat, formattedLng]).addTo(map)
      }
    }

    map.on('click', (event) => {
      if (!isEditingRef.current) return
      const { lat, lng } = event.latlng
      setMarker(lat, lng)
    })

    markerRef.current = L.marker([startLat, startLng]).addTo(map)
    toggleMapInteractions(isEditingRef.current)
    mapRef.current = map
  }, [formData.latitud, formData.longitud, isEditing, isWithinEcuador, notifyError, toggleMapInteractions])

  useEffect(() => {
    if (open) {
      initializeMap()
    }
  }, [open, initializeMap])

  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return
    markerRef.current.setLatLng([formData.latitud, formData.longitud])
    mapRef.current.setView([formData.latitud, formData.longitud], MAP_ZOOM)
  }, [formData.latitud, formData.longitud])

  useEffect(() => {
    toggleMapInteractions(isEditing)
  }, [isEditing, toggleMapInteractions])

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

  const handleToggleEdit = () => {
    if (loadingData || saving || deleteLoading) return
    setIsEditing((prev) => {
      const next = !prev
      if (!next) {
        setFormData(originalData)
      }
      return next
    })
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!isEditing || loadingData) return
    setSaving(true)

    const payload = {
      ...formData,
      nombre: formData.nombre.trim(),
      direccion: formData.direccion.trim(),
      latitud: formatCoordinate(Number(formData.latitud)),
      longitud: formatCoordinate(Number(formData.longitud)),
    }

    if (!payload.nombre) {
      setSaving(false)
      notifyError('Define un nombre para la sucursal.')
      return
    }
    if (!Number.isFinite(payload.latitud) || !Number.isFinite(payload.longitud)) {
      setSaving(false)
      notifyError('Selecciona un punto en el mapa para guardar la sucursal.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/inventario/sucursales/${sucursalId}/`,
        {
          method: 'PUT',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || data?.nombre?.[0] || 'No se pudo actualizar la sucursal.'
        throw new Error(detail)
      }

      const normalized = normalizeSucursal(data)
      setFormData(normalized)
      setOriginalData(normalized)
      setIsEditing(false)
      onUpdated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al actualizar la sucursal.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!isEditing || deleteLoading || !sucursalId) return
    setShowDeleteDialog(false)
    setDeleteLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/inventario/sucursales/${sucursalId}/`,
        {
          method: 'DELETE',
        },
        token
      )

      if (!response.ok && response.status !== 204) {
        const data = await response.json().catch(() => ({}))
        const detail = data?.detail || 'No se pudo eliminar la sucursal.'
        throw new Error(detail)
      }

      onDeleted?.(sucursalId)
      onClose?.()
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al eliminar la sucursal.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleClose = () => {
    onClose?.()
    setIsEditing(false)
    setShowDeleteDialog(false)
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
      <div
        className="create-user__modal"
        ref={modalRef}
        style={modalStyle}
      >
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>{sucursalId ? `Sucursal #${sucursalId}` : 'Sucursal'}</h3>
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
              onClick={handleClose}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <form className="create-user__form" onSubmit={handleSubmit}>
          <div className="create-user__tabs" role="tablist" aria-label="Secciones de la sucursal">
            <button
              type="button"
              className={`create-user__tab${activeTab === 'general' ? ' create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('general')}
              role="tab"
              aria-selected={activeTab === 'general'}
            >
              General
            </button>
          </div>

          <div className="create-user__body">
            {activeTab === 'general' && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Datos de la sucursal</p>
                    <h4>Información básica</h4>
                  </div>
                  {loadingData && <small className="muted">Cargando datos...</small>}
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
                      disabled={!isEditing || loadingData || saving}
                      required
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
                      disabled={!isEditing || loadingData || saving}
                      onBlur={handleAddressCommit}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          handleAddressCommit()
                        }
                      }}
                    />
                  </label>
                </div>

                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Ubicación</p>
                    <h4>Mapa</h4>
                  </div>
                  {loadingData && <small className="muted">Cargando ubicación...</small>}
                </div>

                <div className="sucursal-map__container">
                  <div ref={mapContainerRef} className="sucursal-map__canvas" role="presentation" />
                </div>
              </section>
            )}
          </div>

          <div className="create-user__footer">
            <div className="user-details__footer-left">
              <button type="button" className="create-user__action create-user__action--cancel" onClick={handleClose}>
                Cancelar
              </button>
              <button
                type="button"
                className={`create-user__action create-user__action--edit user-details__edit-toggle${isEditing ? ' user-details__edit-toggle--active' : ''}`}
                onClick={handleToggleEdit}
                disabled={loadingData || saving || deleteLoading}
              >
                {isEditing ? (
                  <>
                    <span className="user-details__toggle-icon" aria-hidden="true">
                      <Eye size={16} />
                    </span>
                    <span>Solo lectura</span>
                  </>
                ) : (
                  <>
                    <span className="user-details__toggle-icon" aria-hidden="true">
                      <Pencil size={16} />
                    </span>
                    <span>Editar</span>
                  </>
                )}
              </button>
            </div>

            <div className="user-details__footer-right">
              {isEditing && (
                <>
                  <button
                    type="button"
                    className="create-user__action user-details__delete"
                    onClick={() => setShowDeleteDialog(true)}
                    disabled={deleteLoading || saving || loadingData}
                  >
                    {deleteLoading ? 'Eliminando...' : 'Eliminar'}
                  </button>

                    <button
                      type="submit"
                      className="create-user__action create-user__action--primary"
                      disabled={saving || loadingData}
                    >
                      {saving ? 'Guardando...' : 'Guardar'}
                    </button>
                </>
              )}
            </div>
          </div>
        </form>

        {showDeleteDialog && (
          <div className="user-details__confirm-overlay" role="alertdialog" aria-modal="true" aria-label="Confirmar eliminación">
            <div className="user-details__confirm-dialog">
              <div className="user-details__confirm-icon" aria-hidden="true">
                <Info size={22} />
              </div>
              <div className="user-details__confirm-content">
                <h4>¿Estás seguro?</h4>
                <p>Esta acción es irreversible</p>
              </div>
              <div className="user-details__confirm-actions">
                <button
                  type="button"
                  className="create-user__ghost create-user__cancel"
                  onClick={() => setShowDeleteDialog(false)}
                >
                  No
                </button>
                <button
                  type="button"
                  className="user-details__confirm-danger"
                  onClick={handleDelete}
                  disabled={deleteLoading}
                >
                  Sí
                </button>
              </div>
            </div>
          </div>
        )}

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

export default SucursalDetails
