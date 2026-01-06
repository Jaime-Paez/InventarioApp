import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Eye, Info, Pencil } from 'lucide-react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../../admin/UsersDetails/UsersDetails.css'
import '../SucursalMap.css'
import 'leaflet/dist/leaflet.css'
import { authFetch } from '../../../../utils/api'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
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

function SucursalDetails({ open, sucursalId, token, onClose, onUpdated, onDeleted, onError }) {
  const [formData, setFormData] = useState(emptyForm)
  const [originalData, setOriginalData] = useState(emptyForm)
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const sizeRef = useRef(size)
  const positionRef = useRef(position)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const mapContainerRef = useRef(null)
  const isEditingRef = useRef(false)
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

  const normalizeSucursal = (data) => ({
    nombre: data?.nombre ?? '',
    direccion: data?.direccion ?? '',
    latitud: Number(data?.latitud ?? 0),
    longitud: Number(data?.longitud ?? 0),
  })

  const handleChange = (event) => {
    if (!isEditing) return
    const { name, value } = event.target
    if (name === 'direccion') return
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

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
    isMountedRef.current = true
    setIsEditing(false)
    setFormData(emptyForm)
    setOriginalData(emptyForm)
    setActiveTab('general')
    fetchSucursal()
    return () => {
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        markerRef.current = null
      }
      isMountedRef.current = false
    }
  }, [open, fetchSucursal])

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

    const startLat = formData.latitud || 0
    const startLng = formData.longitud || 0

    const map = L.map(mapContainerRef.current, { zoomControl: false }).setView([startLat, startLng], MAP_ZOOM)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)

    const setMarker = (lat, lng) => {
      if (!isEditingRef.current) return
      setFormData((prev) => ({ ...prev, latitud: lat, longitud: lng }))
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
          latitud: lat,
          longitud: lng,
        }))
      })
    }

    map.on('click', (event) => {
      if (!isEditingRef.current) return
      const { lat, lng } = event.latlng
      setMarker(lat, lng)
    })

    markerRef.current = L.marker([startLat, startLng]).addTo(map)
    toggleMapInteractions(isEditingRef.current)
    mapRef.current = map
  }, [formData.latitud, formData.longitud, isEditing, reverseGeocode, toggleMapInteractions])

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
      latitud: Number(formData.latitud),
      longitud: Number(formData.longitud),
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

  return (
    <div className="create-user__overlay" role="dialog" aria-modal="true">
      <div
        className="create-user__modal"
        ref={modalRef}
        style={{ top: position.y, left: position.x, width: size.width, height: size.height }}
      >
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>{sucursalId ? `Sucursal #${sucursalId}` : 'Sucursal'}</h3>
          </div>
          <button
            type="button"
            className="create-user__icon-button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={handleClose}
            aria-label="Cerrar"
          >
            ×
          </button>
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
                    readOnly
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
