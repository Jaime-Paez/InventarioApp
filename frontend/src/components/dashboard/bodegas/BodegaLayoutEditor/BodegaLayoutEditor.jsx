import { useMemo, useState } from 'react'
import './BodegaLayoutEditor.css'

const buildId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const normalizeNumber = (value) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function BodegaLayoutEditor({ widthMeters, heightMeters, locations, onChange, disabled }) {
  const safeWidth = useMemo(() => Math.max(widthMeters || 0, 0), [widthMeters])
  const safeHeight = useMemo(() => Math.max(heightMeters || 0, 0), [heightMeters])
  const [selectedId, setSelectedId] = useState(null)

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

  const updateLocation = (id, field, value) => {
    const updated = locations.map((location) => {
      if (location.id !== id) return location
      const nextValue = field === 'nombre' ? value : normalizeNumber(value)
      return { ...location, [field]: nextValue }
    })
    onChange(updated)
  }

  const removeLocation = (id) => {
    onChange(locations.filter((location) => location.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

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
        >
          {locations.map((location) => {
            const left = safeWidth ? (location.x / safeWidth) * 100 : 0
            const top = safeHeight ? (location.y / safeHeight) * 100 : 0
            const width = safeWidth ? (location.ancho / safeWidth) * 100 : 10
            const height = safeHeight ? (location.alto / safeHeight) * 100 : 10
            const isSelected = selectedId === location.id
            return (
              <div
                key={location.id}
                className={`bodega-layout__location${isSelected ? ' bodega-layout__location--selected' : ''}`}
                style={{
                  left: `${left}%`,
                  top: `${top}%`,
                  width: `${width}%`,
                  height: `${height}%`,
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  setSelectedId(location.id)
                }}
              >
                <span>{location.nombre || 'Ubicación'}</span>
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
                  onChange={(event) => updateLocation(location.id, 'nombre', event.target.value)}
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
                  onChange={(event) => updateLocation(location.id, 'x', event.target.value)}
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
                  onChange={(event) => updateLocation(location.id, 'y', event.target.value)}
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
                  onChange={(event) => updateLocation(location.id, 'ancho', event.target.value)}
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
                  onChange={(event) => updateLocation(location.id, 'alto', event.target.value)}
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
