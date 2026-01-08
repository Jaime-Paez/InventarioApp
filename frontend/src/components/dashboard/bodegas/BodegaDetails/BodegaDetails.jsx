import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Eye, Info, Pencil } from 'lucide-react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../../admin/UsersDetails/UsersDetails.css'
import { API_URL, authFetch } from '../../../../utils/api'
import BodegaLayoutEditor from '../BodegaLayoutEditor/BodegaLayoutEditor'

const MIN_WIDTH = 720
const MIN_HEIGHT = 540
const VIEWPORT_PADDING = 12

const emptyForm = {
  nombre: '',
  sucursalId: '',
  ancho_metros: 0,
  alto_metros: 0,
  ubicaciones: [],
}

function BodegaDetails({ open, bodegaId, token, onClose, onUpdated, onDeleted, onError }) {
  const [formData, setFormData] = useState(emptyForm)
  const [originalData, setOriginalData] = useState(emptyForm)
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [branches, setBranches] = useState([])
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

  const normalizeBodega = (data) => ({
    nombre: data?.nombre ?? '',
    sucursalId: data?.sucursal?.id ?? '',
    ancho_metros: Number(data?.ancho_metros ?? 0),
    alto_metros: Number(data?.alto_metros ?? 0),
    ubicaciones: Array.isArray(data?.ubicaciones) ? data.ubicaciones : [],
  })

  const handleChange = (event) => {
    if (!isEditing) return
    const { name, value } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleLayoutChange = (locations) => {
    if (!isEditing) return
    setFormData((prev) => ({
      ...prev,
      ubicaciones: locations,
    }))
  }

  const fetchBranches = useCallback(async () => {
    try {
      const response = await authFetch(`${API_URL}/inventario/sucursales/`, {}, token)
      if (!response.ok) throw new Error('No se pudieron cargar las sucursales.')
      const data = await response.json()
      const list = Array.isArray(data) ? data : data?.results || []
      setBranches(list)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al cargar las sucursales.')
    }
  }, [notifyError, token])

  const fetchBodega = useCallback(async () => {
    if (!bodegaId) return
    setLoadingData(true)
    try {
      const response = await authFetch(`${API_URL}/inventario/bodegas/${bodegaId}/`, {}, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || 'No se pudo cargar la información de la bodega.'
        throw new Error(detail)
      }
      const normalized = normalizeBodega(data)
      setFormData(normalized)
      setOriginalData(normalized)
      setIsEditing(false)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al obtener la información de la bodega.')
    } finally {
      setLoadingData(false)
    }
  }, [notifyError, token, bodegaId])

  useEffect(() => {
    if (!open) return
    setIsEditing(false)
    setFormData(emptyForm)
    setOriginalData(emptyForm)
    setActiveTab('general')
    setIsMaximized(false)
    restoreRef.current = null
    fetchBranches()
    fetchBodega()
  }, [open, fetchBranches, fetchBodega])

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

  const parseMeasure = (value) => {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : 0
  }

  const handleSave = async () => {
    if (!isEditing || saving || !bodegaId) return
    setSaving(true)

    const payload = {
      nombre: formData.nombre.trim(),
      sucursal_id: formData.sucursalId ? Number(formData.sucursalId) : null,
      ancho_metros: parseMeasure(formData.ancho_metros),
      alto_metros: parseMeasure(formData.alto_metros),
      ubicaciones: formData.ubicaciones,
    }

    if (!payload.nombre) {
      setSaving(false)
      notifyError('Define un nombre para la bodega.')
      return
    }

    if (!payload.sucursal_id) {
      setSaving(false)
      notifyError('Selecciona una sucursal para la bodega.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/inventario/bodegas/${bodegaId}/`,
        {
          method: 'PUT',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || data?.nombre?.[0] || 'No se pudo actualizar la bodega.'
        throw new Error(detail)
      }

      const normalized = normalizeBodega(data)
      setFormData(normalized)
      setOriginalData(normalized)
      setIsEditing(false)
      onUpdated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al actualizar la bodega.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!isEditing || deleteLoading || !bodegaId) return
    setDeleteLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/inventario/bodegas/${bodegaId}/`,
        { method: 'DELETE' },
        token
      )

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        const detail = data?.detail || 'No se pudo eliminar la bodega.'
        throw new Error(detail)
      }

      onDeleted?.(bodegaId)
      setShowDeleteDialog(false)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al eliminar la bodega.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleCancelEdit = () => {
    setFormData(originalData)
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
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)` ,
    maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)` ,
  }

  const isViewMode = !isEditing
  const editorDisabled = saving || loadingData || !isEditing

  return (
    <div className="create-user__overlay" role="dialog" aria-modal="true" style={overlayStyle}>
      <div className="create-user__modal" ref={modalRef} style={modalStyle}>
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>{bodegaId ? `Bodega #${bodegaId}` : 'Bodega'}</h3>
          </div>
          <div className="create-user__header-actions">
            <button
              type="button"
              className="create-user__icon-button create-user__icon-button--maximize"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={toggleMaximize}
              aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
            >
              {isMaximized ? '🗗' : '🗖'}
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
          <div className="create-user__tabs" role="tablist" aria-label="Secciones de la bodega">
            <button
              type="button"
              className={`create-user__tab${activeTab === 'general' ? ' create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('general')}
              aria-selected={activeTab === 'general'}
            >
              General
            </button>
            <button
              type="button"
              className={`create-user__tab${activeTab === 'plano' ? ' create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('plano')}
              aria-selected={activeTab === 'plano'}
            >
              Plano
            </button>
          </div>

          <div className="create-user__body">
            {activeTab === 'general' && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Datos de la bodega</p>
                    <h4>Información básica</h4>
                  </div>
                </div>

                <div className="create-user__grid create-user__grid--two">
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
                    <span>Sucursal</span>
                    <select
                      name="sucursalId"
                      value={formData.sucursalId}
                      onChange={handleChange}
                      disabled={editorDisabled}
                    >
                      <option value="">Selecciona una sucursal</option>
                      {branches.map((branch) => (
                        <option key={branch.id} value={branch.id}>
                          {branch.nombre}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="create-user__field">
                    <span>Ancho (m)</span>
                    <input
                      name="ancho_metros"
                      type="number"
                      min="0"
                      step="0.1"
                      value={formData.ancho_metros}
                      onChange={handleChange}
                      disabled={editorDisabled}
                    />
                  </label>

                  <label className="create-user__field">
                    <span>Alto (m)</span>
                    <input
                      name="alto_metros"
                      type="number"
                      min="0"
                      step="0.1"
                      value={formData.alto_metros}
                      onChange={handleChange}
                      disabled={editorDisabled}
                    />
                  </label>
                </div>
              </section>
            )}

            {activeTab === 'plano' && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Plano interno</p>
                    <h4>Ubicaciones de la bodega</h4>
                  </div>
                </div>

                <BodegaLayoutEditor
                  widthMeters={Number(formData.ancho_metros) || 0}
                  heightMeters={Number(formData.alto_metros) || 0}
                  locations={formData.ubicaciones}
                  onChange={handleLayoutChange}
                  disabled={editorDisabled}
                />
              </section>
            )}
          </div>
        </div>

        <div className="create-user__footer">
          <div className="user-details__footer-left">
            <button
              type="button"
              className={`create-user__action create-user__action--edit user-details__edit-toggle${isEditing ? ' user-details__edit-toggle--active' : ''}`}
              onClick={() => setIsEditing((prev) => !prev)}
              disabled={loadingData || saving}
            >
              <span className="user-details__toggle-icon">{isEditing ? <Eye size={14} /> : <Pencil size={14} />}</span>
              {isEditing ? 'Ver' : 'Editar'}
            </button>

            {isEditing && (
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={handleCancelEdit}
                disabled={saving}
              >
                Cancelar
              </button>
            )}
          </div>

          <div className="user-details__footer-right">
            <button
              type="button"
              className="create-user__action user-details__delete"
              onClick={() => setShowDeleteDialog(true)}
              disabled={!isEditing || saving}
            >
              Eliminar
            </button>
            <button
              type="button"
              className="create-user__action create-user__action--primary"
              onClick={handleSave}
              disabled={isViewMode || saving}
            >
              {saving ? 'Guardando...' : 'Guardar cambios'}
            </button>
          </div>
        </div>

        <button
          type="button"
          aria-label="Cambiar tamaño de ventana"
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
              <h4>Eliminar bodega</h4>
              <p>¿Deseas eliminar esta bodega? Esta acción no se puede deshacer.</p>
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

export default BodegaDetails
