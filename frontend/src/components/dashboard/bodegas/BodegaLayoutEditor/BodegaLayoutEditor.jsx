import { useEffect, useMemo, useRef, useState } from 'react'
import './BodegaLayoutEditor.css'

const buildId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const normalizeNumber = (value) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

const DEFAULT_COLOR = '#4f8df8'
const MIN_SIZE_METERS = 0.5

function BodegaLayoutEditor({ widthMeters, heightMeters, locations, onChange, disabled }) {
  const safeWidth = useMemo(() => Math.max(widthMeters || 0, 0), [widthMeters])
  const safeHeight = useMemo(() => Math.max(heightMeters || 0, 0), [heightMeters])
  const [selectedId, setSelectedId] = useState(null)
  const planRef = useRef(null)
  const dragStateRef = useRef(null)

  const handleAddLocation = (coords) => {
    if (disabled) return
    if (!safeWidth || !safeHeight) return

    const defaultSize = Math.min(2, safeWidth || 1, safeHeight || 1)
    const next = {
      id: buildId(),
      nombre: `Ubicación ${locations.length + 1}`,
      x: coords?.x ?? 0,
      y: coords?.y ?? 0,
      ancho: defaultSize,
      alto: defaultSize,
      color: DEFAULT_COLOR,
    }
    onChange([...locations, next])
    setSelectedId(next.id)
  }

  const handlePlanClick = (event) => {
    if (!event.currentTarget || disabled) return
    if (!safeWidth || !safeHeight) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const xRatio = (event.clientX - rect.left) / rect.width
    const yRatio = (event.clientY - rect.top) / rect.height
    const x = clamp(xRatio * safeWidth, 0, safeWidth)
    const y = clamp(yRatio * safeHeight, 0, safeHeight)

    handleAddLocation({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) })
  }

  const updateLocation = (id, updates) => {
    const updated = locations.map((location) => {
      if (location.id !== id) return location
      return { ...location, ...updates }
    })
    onChange(updated)
  }

  const updateNumericField = (id, field, value) => {
    const nextValue = normalizeNumber(value)
    updateLocation(id, { [field]: nextValue })
  }

  const removeLocation = (id) => {
    onChange(locations.filter((location) => location.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  const handleDragStart = (event, location, mode) => {
    if (disabled || !planRef.current) return
    event.stopPropagation()
    const rect = planRef.current.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    dragStateRef.current = {
      id: location.id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      originX: location.x,
      originY: location.y,
      originWidth: location.ancho,
      originHeight: location.alto,
      rect,
    }
    setSelectedId(location.id)
  }

  useEffect(() => {
    const handleMouseMove = (event) => {
      const dragState = dragStateRef.current
      if (!dragState || disabled || !safeWidth || !safeHeight) return

      const { rect } = dragState
      const metersPerPxX = safeWidth / rect.width
      const metersPerPxY = safeHeight / rect.height
      const deltaX = (event.clientX - dragState.startX) * metersPerPxX
      const deltaY = (event.clientY - dragState.startY) * metersPerPxY

      if (dragState.mode === 'move') {
        const nextX = clamp(dragState.originX + deltaX, 0, Math.max(0, safeWidth - dragState.originWidth))
        const nextY = clamp(dragState.originY + deltaY, 0, Math.max(0, safeHeight - dragState.originHeight))
        updateLocation(dragState.id, {
          x: Number(nextX.toFixed(2)),
          y: Number(nextY.toFixed(2)),
        })
        return
      }

      if (dragState.mode === 'resize') {
        const nextWidth = clamp(
          dragState.originWidth + deltaX,
          MIN_SIZE_METERS,
          Math.max(MIN_SIZE_METERS, safeWidth - dragState.originX)
        )
        const nextHeight = clamp(
          dragState.originHeight + deltaY,
          MIN_SIZE_METERS,
          Math.max(MIN_SIZE_METERS, safeHeight - dragState.originY)
        )
        updateLocation(dragState.id, {
          ancho: Number(nextWidth.toFixed(2)),
          alto: Number(nextHeight.toFixed(2)),
        })
      }
    }

    const handleMouseUp = () => {
      dragStateRef.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [disabled, safeWidth, safeHeight, locations])

  return (
    <div className="bodega-layout">
      <div className="bodega-layout__meta">
        <p>
          Plano interactivo para distribuir ubicaciones internas. Define las medidas de la bodega
          y haz clic dentro del plano para agregar nuevas ubicaciones.
        </p>
        <button
          type="button"
          className="create-user__action create-user__action--cancel"
          onClick={() => handleAddLocation({ x: 0, y: 0 })}
          disabled={disabled || !safeWidth || !safeHeight}
        >
          Agregar ubicación
        </button>
      </div>

      <div className="bodega-layout__plan-wrapper">
        <div
          className={`bodega-layout__plan${disabled || !safeWidth || !safeHeight ? ' bodega-layout__plan--disabled' : ''}`}
          role="presentation"
          onClick={handlePlanClick}
          ref={planRef}
          style={safeWidth && safeHeight ? { aspectRatio: `${safeWidth} / ${safeHeight}` } : undefined}
        >
          {locations.map((location) => {
            const left = safeWidth ? (location.x / safeWidth) * 100 : 0
            const top = safeHeight ? (location.y / safeHeight) * 100 : 0
            const width = safeWidth ? (location.ancho / safeWidth) * 100 : 10
            const height = safeHeight ? (location.alto / safeHeight) * 100 : 10
            const isSelected = selectedId === location.id
            const locationColor = location.color || DEFAULT_COLOR
            return (
              <div
                key={location.id}
                className={`bodega-layout__location${isSelected ? ' bodega-layout__location--selected' : ''}`}
                style={{
                  left: `${left}%`,
                  top: `${top}%`,
                  width: `${width}%`,
                  height: `${height}%`,
                  borderColor: locationColor,
                  backgroundColor: `${locationColor}22`,
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  setSelectedId(location.id)
                }}
                onMouseDown={(event) => handleDragStart(event, location, 'move')}
              >
                <input
                  className="bodega-layout__location-input"
                  type="text"
                  value={location.nombre}
                  onChange={(event) => updateLocation(location.id, { nombre: event.target.value })}
                  onClick={(event) => event.stopPropagation()}
                  disabled={disabled}
                />
                <span className="bodega-layout__location-size">
                  {location.ancho?.toFixed?.(1) ?? 0}m x {location.alto?.toFixed?.(1) ?? 0}m
                </span>
                <button
                  type="button"
                  className="bodega-layout__resize-handle"
                  onMouseDown={(event) => handleDragStart(event, location, 'resize')}
                  aria-label="Cambiar tamaño de ubicación"
                  disabled={disabled}
                />
              </div>
            )
          })}
        </div>
        <p className="bodega-layout__hint">
          {safeWidth && safeHeight
            ? `Plano: ${safeWidth}m x ${safeHeight}m`
            : 'Define las medidas de la bodega para habilitar el plano.'}
        </p>
      </div>

      <div className="bodega-layout__list">
        {locations.length === 0 && (
          <div className="bodega-layout__card">
            <p className="bodega-layout__hint">Aún no hay ubicaciones creadas.</p>
          </div>
        )}
        {locations.map((location, index) => (
          <div key={location.id} className="bodega-layout__card">
            <div className="bodega-layout__card-header">
              <h5>{location.nombre || `Ubicación ${index + 1}`}</h5>
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={() => removeLocation(location.id)}
                disabled={disabled}
              >
                Eliminar
              </button>
            </div>
            <div className="bodega-layout__grid">
              <label className="create-user__field">
                <span>Nombre</span>
                <input
                  type="text"
                  value={location.nombre}
                  onChange={(event) => updateLocation(location.id, { nombre: event.target.value })}
                  disabled={disabled}
                />
              </label>
              <label className="create-user__field">
                <span>X (m)</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={location.x}
                  onChange={(event) => updateNumericField(location.id, 'x', event.target.value)}
                  disabled={disabled}
                />
              </label>
              <label className="create-user__field">
                <span>Y (m)</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={location.y}
                  onChange={(event) => updateNumericField(location.id, 'y', event.target.value)}
                  disabled={disabled}
                />
              </label>
              <label className="create-user__field">
                <span>Ancho (m)</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={location.ancho}
                  onChange={(event) => updateNumericField(location.id, 'ancho', event.target.value)}
                  disabled={disabled}
                />
              </label>
              <label className="create-user__field">
                <span>Alto (m)</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={location.alto}
                  onChange={(event) => updateNumericField(location.id, 'alto', event.target.value)}
                  disabled={disabled}
                />
              </label>
              <label className="create-user__field">
                <span>Color</span>
                <input
                  type="color"
                  value={location.color || DEFAULT_COLOR}
                  onChange={(event) => updateLocation(location.id, { color: event.target.value })}
                  disabled={disabled}
                />
              </label>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default BodegaLayoutEditor
