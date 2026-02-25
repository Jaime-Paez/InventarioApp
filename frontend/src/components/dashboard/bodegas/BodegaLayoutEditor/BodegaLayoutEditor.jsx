import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './BodegaLayoutEditor.css'

const buildId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const normalizeNumber = (value) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Number(numeric.toFixed(1)) : 0
}

const DEFAULT_COLOR = '#4f8df8'
const MIN_SIZE_METERS = 0.5
const PLAN_MAX_HEIGHT = 'min(78vh, 860px)'
const VERTICAL_LABEL_RATIO = 1.6
const DEFAULT_TYPES = ['Estantería', 'Cajonera', 'Muebles']
const TYPE_COLORS = ['#4f8df8', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#14b8a6']

const TypeSelect = ({
  value,
  options,
  colors,
  disabled,
  placeholder,
  onSelect,
  onCreate,
  onColorChange,
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (event) => {
      if (!containerRef.current?.contains(event.target)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const filtered = options.filter((option) =>
    option.toLowerCase().includes(query.toLowerCase())
  )

  const handleSelect = (option) => {
    onSelect(option)
    setQuery('')
    setIsOpen(false)
  }

  const handleCreate = () => {
    const created = onCreate(query)
    if (created) {
      setQuery('')
      setIsOpen(false)
    }
  }

  return (
    <div
      ref={containerRef}
      className={`bodega-type-select${isOpen ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}
    >
      <button
        type="button"
        className="bodega-type-select__control"
        onClick={() => setIsOpen((prev) => !prev)}
        disabled={disabled}
      >
        <span>{value || placeholder}</span>
        <div className="bodega-type-select__control-actions">
          <label
            className="bodega-type-select__color"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              type="color"
              value={colors?.[value] || DEFAULT_COLOR}
              onChange={(event) => onColorChange?.(value, event.target.value)}
              aria-label={`Color para ${value}`}
              disabled={!value}
            />
            <span
              className="bodega-type-select__color-dot"
              style={{ backgroundColor: colors?.[value] || DEFAULT_COLOR }}
            />
          </label>
          <i className={`pi pi-chevron-${isOpen ? 'up' : 'down'}`} />
        </div>
      </button>

      {isOpen && (
        <div className="bodega-type-select__menu">
          <div className="bodega-type-select__search">
            <i className="pi pi-search" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={placeholder}
              autoFocus
            />
          </div>
          <div className="bodega-type-select__options">
            {filtered.length === 0 && (
              <div className="bodega-type-select__empty">Sin resultados</div>
            )}
            {filtered.map((option) => (
              <button
                key={option}
                type="button"
                className={`bodega-type-select__option${option === value ? ' is-active' : ''}`}
                onClick={() => handleSelect(option)}
              >
                <span>{option}</span>
                <label
                  className="bodega-type-select__color"
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    type="color"
                    value={colors?.[option] || DEFAULT_COLOR}
                    onChange={(event) => onColorChange?.(option, event.target.value)}
                    aria-label={`Color para ${option}`}
                  />
                  <span
                    className="bodega-type-select__color-dot"
                    style={{ backgroundColor: colors?.[option] || DEFAULT_COLOR }}
                  />
                </label>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="bodega-type-select__create"
            onClick={handleCreate}
            disabled={!query.trim()}
          >
            Escribe para crear un tipo
          </button>
        </div>
      )}
    </div>
  )
}

function BodegaLayoutEditor({ widthMeters, heightMeters, locations, onChange, disabled, renderLocationFooter }) {
  const safeWidth = useMemo(() => Math.max(widthMeters || 0, 0), [widthMeters])
  const safeHeight = useMemo(() => Math.max(heightMeters || 0, 0), [heightMeters])
  const planStyle = useMemo(() => {
    if (!safeWidth || !safeHeight) return undefined
    const ratio = safeWidth / safeHeight
    return {
      aspectRatio: `${safeWidth} / ${safeHeight}`,
      width: '100%',
      maxWidth: `min(100%, calc(${PLAN_MAX_HEIGHT} * ${ratio}))`,
      maxHeight: PLAN_MAX_HEIGHT,
      minHeight: 0,
    }
  }, [safeWidth, safeHeight])
  const [selectedId, setSelectedId] = useState(null)
  const planRef = useRef(null)
  const dragStateRef = useRef(null)
  const [resizeOverlay, setResizeOverlay] = useState(null)
  const [isAdding, setIsAdding] = useState(false)
  const [types, setTypes] = useState(DEFAULT_TYPES)
  const [typeColors, setTypeColors] = useState(() =>
    DEFAULT_TYPES.reduce((acc, type, index) => {
      acc[type] = TYPE_COLORS[index % TYPE_COLORS.length]
      return acc
    }, {})
  )

  useEffect(() => {
    const incomingTypes = new Set(types)
    let updated = false
    locations.forEach((location) => {
      if (location?.tipo && !incomingTypes.has(location.tipo)) {
        incomingTypes.add(location.tipo)
        updated = true
      }
    })
    if (updated) {
      const merged = Array.from(incomingTypes)
      setTypes(merged)
      setTypeColors((prev) => {
        const next = { ...prev }
        merged.forEach((type, index) => {
          if (!next[type]) {
            next[type] = TYPE_COLORS[index % TYPE_COLORS.length]
          }
        })
        return next
      })
    }
  }, [locations, types])

  const resolveTypeColor = useCallback(
    (type) => typeColors[type] || DEFAULT_COLOR,
    [typeColors]
  )

  const handleTypeColorChange = (type, color) => {
    if (!type) return
    setTypeColors((prev) => ({
      ...prev,
      [type]: color,
    }))
  }

  const clampLocation = (location) => {
    const clampedX = clamp(location.x, 0, Math.max(0, safeWidth - location.ancho))
    const clampedY = clamp(location.y, 0, Math.max(0, safeHeight - location.alto))
    const clampedWidth = clamp(location.ancho, MIN_SIZE_METERS, Math.max(MIN_SIZE_METERS, safeWidth - clampedX))
    const clampedHeight = clamp(location.alto, MIN_SIZE_METERS, Math.max(MIN_SIZE_METERS, safeHeight - clampedY))
    return {
      ...location,
      x: Number(clampedX.toFixed(1)),
      y: Number(clampedY.toFixed(1)),
      ancho: Number(clampedWidth.toFixed(1)),
      alto: Number(clampedHeight.toFixed(1)),
    }
  }

  const handleAddLocation = (coords) => {
    if (disabled) return
    if (!safeWidth || !safeHeight) return
    if (!isAdding) return

    const defaultSize = Math.min(2, safeWidth || 1, safeHeight || 1)
    const next = {
      id: buildId(),
      nombre: `Ubicación ${locations.length + 1}`,
      tipo: types[0] || DEFAULT_TYPES[0],
      x: coords?.x ?? 0,
      y: coords?.y ?? 0,
      ancho: defaultSize,
      alto: defaultSize,
    }
    onChange([...locations, clampLocation(next)])
    setSelectedId(next.id)
    setIsAdding(false)
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

    handleAddLocation({ x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) })
  }

  const updateLocation = (id, updates) => {
    const updated = locations.map((location) => {
      if (location.id !== id) return location
      const next = typeof updates === 'function' ? updates(location) : { ...location, ...updates }
      return clampLocation(next)
    })
    onChange(updated)
  }

  const updateNumericField = (id, field, value) => {
    const nextValue = normalizeNumber(value)
    updateLocation(id, (prev) => ({ ...prev, [field]: nextValue }))
  }

  const ensureType = (rawType) => {
    const trimmed = rawType.trim()
    if (!trimmed) return null
    if (types.includes(trimmed)) return trimmed
    const nextTypes = [...types, trimmed]
    setTypes(nextTypes)
    setTypeColors((prev) => ({
      ...prev,
      [trimmed]: TYPE_COLORS[(nextTypes.length - 1) % TYPE_COLORS.length],
    }))
    return trimmed
  }

  const handleTypeChange = (locationId, value) => {
    updateLocation(locationId, { tipo: value })
  }

  const handleAddType = (value) => ensureType(value)

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
          x: Number(nextX.toFixed(1)),
          y: Number(nextY.toFixed(1)),
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
          ancho: Number(nextWidth.toFixed(1)),
          alto: Number(nextHeight.toFixed(1)),
        })
        setResizeOverlay({
          x: event.clientX,
          y: event.clientY,
          ancho: Number(nextWidth.toFixed(1)),
          alto: Number(nextHeight.toFixed(1)),
        })
      }
    }

    const handleMouseUp = () => {
      dragStateRef.current = null
      setResizeOverlay(null)
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
          onClick={() => setIsAdding((prev) => !prev)}
          disabled={disabled || !safeWidth || !safeHeight}
        >
          {isAdding ? 'Haz clic en el plano...' : 'Agregar ubicación'}
        </button>
      </div>

      <div className="bodega-layout__plan-row">
        <div className="bodega-layout__legend">
          <h5>Leyenda</h5>
          {locations.length === 0 && (
            <p className="bodega-layout__hint">Sin ubicaciones registradas.</p>
          )}
          <ul>
            {Array.from(
              new Set(
                locations
                  .map((loc) => loc.tipo || types[0] || DEFAULT_TYPES[0])
                  .filter(Boolean)
              )
            ).map((type) => (
              <li key={type}>
                <span
                  className="bodega-layout__legend-dot"
                  style={{ backgroundColor: resolveTypeColor(type) }}
                />
                <span>{type}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="bodega-layout__plan-wrapper">
          <div
            className={`bodega-layout__plan${disabled || !safeWidth || !safeHeight ? ' bodega-layout__plan--disabled' : ''}`}
            role="presentation"
            onClick={handlePlanClick}
            ref={planRef}
            style={planStyle}
          >
            {locations.map((location) => {
              const left = safeWidth ? (location.x / safeWidth) * 100 : 0
              const top = safeHeight ? (location.y / safeHeight) * 100 : 0
              const width = safeWidth ? (location.ancho / safeWidth) * 100 : 10
              const height = safeHeight ? (location.alto / safeHeight) * 100 : 10
              const isSelected = selectedId === location.id
              const isVertical = location.alto > location.ancho * VERTICAL_LABEL_RATIO
              const locationType = location.tipo || types[0] || DEFAULT_TYPES[0]
              const locationColor = resolveTypeColor(locationType)
              return (
                <div
                  key={location.id}
                  className={`bodega-layout__location${isSelected ? ' bodega-layout__location--selected' : ''}${isVertical ? ' bodega-layout__location--vertical' : ''}`}
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
                    title={location.nombre}
                    disabled={disabled}
                  />
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
          {resizeOverlay && (
            <div
              className="bodega-layout__resize-tooltip"
              style={{
                left: `${resizeOverlay.x + 12}px`,
                top: `${resizeOverlay.y + 12}px`,
              }}
            >
              {resizeOverlay.ancho}m x {resizeOverlay.alto}m
            </div>
          )}
        </div>
      </div>
      <p className="bodega-layout__hint">
        {safeWidth && safeHeight
          ? `Plano: ${safeWidth}m x ${safeHeight}m`
          : 'Define las medidas de la bodega para habilitar el plano.'}
      </p>

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
                <span>Tipo</span>
                <TypeSelect
                  value={location.tipo || types[0] || DEFAULT_TYPES[0]}
                  options={types}
                  colors={typeColors}
                  placeholder="Selecciona o escribe para crear un tipo"
                  onSelect={(value) => handleTypeChange(location.id, value)}
                  onCreate={handleAddType}
                  onColorChange={handleTypeColorChange}
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
            </div>
            {typeof renderLocationFooter === 'function' ? renderLocationFooter(location, index) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

export default BodegaLayoutEditor
