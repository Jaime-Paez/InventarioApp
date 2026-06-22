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
const VERTICAL_LABEL_RATIO = 1.6
const DEFAULT_TYPES = ['Estantería', 'Cajonera', 'Muebles']
const TYPE_COLORS = ['#4f8df8', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#14b8a6']
const OVERLAP_TOLERANCE = 0.05

const rectsOverlap = (a, b) =>
  a.x + OVERLAP_TOLERANCE < b.x + b.ancho &&
  a.x + a.ancho - OVERLAP_TOLERANCE > b.x &&
  a.y + OVERLAP_TOLERANCE < b.y + b.alto &&
  a.y + a.alto - OVERLAP_TOLERANCE > b.y

// Push non-dragged locations out of the way. When a wall blocks the minimum-
// displacement direction, tries the next best direction. Falls back to shrinking
// (trimming the side facing the obstruction) when all pushes are wall-blocked.
const resolveOverlaps = (locations, draggedIds, safeW, safeH) => {
  const dragged = new Set(draggedIds)
  const result = locations.map((l) => ({ ...l }))

  // ── Phase 1: cascade push ────────────────────────────────────────────────
  // For each pair (A, B) where B is non-dragged and they overlap, try all 4
  // push directions sorted by minimum displacement. Pick the first direction
  // that, after wall-clamping, actually eliminates the overlap. Only fall back
  // to a partial (wall-blocked) push when every direction is blocked.
  for (let iter = 0; iter < 40; iter++) {
    let changed = false
    for (let i = 0; i < result.length; i++) {
      for (let j = 0; j < result.length; j++) {
        if (i === j || dragged.has(result[j].id)) continue
        const a = result[i]
        const b = result[j]
        if (!rectsOverlap(a, b)) continue
        changed = true

        const opts = [
          {
            d: (a.x + a.ancho) - b.x,
            apply: () => { b.x = Number(Math.min(a.x + a.ancho, safeW - b.ancho).toFixed(1)) },
            resolves: () => b.x + OVERLAP_TOLERANCE >= a.x + a.ancho,
          },
          {
            d: (b.x + b.ancho) - a.x,
            apply: () => { b.x = Number(Math.max(a.x - b.ancho, 0).toFixed(1)) },
            resolves: () => b.x + b.ancho - OVERLAP_TOLERANCE <= a.x,
          },
          {
            d: (a.y + a.alto) - b.y,
            apply: () => { b.y = Number(Math.min(a.y + a.alto, safeH - b.alto).toFixed(1)) },
            resolves: () => b.y + OVERLAP_TOLERANCE >= a.y + a.alto,
          },
          {
            d: (b.y + b.alto) - a.y,
            apply: () => { b.y = Number(Math.max(a.y - b.alto, 0).toFixed(1)) },
            resolves: () => b.y + b.alto - OVERLAP_TOLERANCE <= a.y,
          },
        ]
        opts.sort((x, y) => x.d - y.d)

        // Try each option; commit the first that fully clears the overlap.
        let resolved = false
        for (const opt of opts) {
          const sx = b.x, sy = b.y
          opt.apply()
          if (opt.resolves()) { resolved = true; break }
          b.x = sx; b.y = sy  // revert and try next direction
        }
        // If no direction clears it (boxed against walls), accept the smallest push.
        if (!resolved) opts[0].apply()
      }
    }
    if (!changed) break
  }

  // ── Phase 2: shrink to fit (last resort) ────────────────────────────────
  // When a non-dragged item is still overlapping after all pushes, trim the
  // side that faces the obstruction, down to MIN_SIZE_METERS.
  for (let iter = 0; iter < 20; iter++) {
    let changed = false
    for (let j = 0; j < result.length; j++) {
      if (dragged.has(result[j].id)) continue
      const b = result[j]
      for (let i = 0; i < result.length; i++) {
        if (i === j) continue
        const a = result[i]
        if (!rectsOverlap(a, b)) continue
        changed = true

        const overlapW = Math.min(a.x + a.ancho, b.x + b.ancho) - Math.max(a.x, b.x)
        const overlapH = Math.min(a.y + a.alto, b.y + b.alto) - Math.max(a.y, b.y)

        if (overlapW <= overlapH) {
          // Trim the X side of B that faces A's center
          if (a.x + a.ancho / 2 < b.x + b.ancho / 2) {
            // A is to the left — trim B's left edge
            const newBx = Number(Math.min(a.x + a.ancho, safeW - MIN_SIZE_METERS).toFixed(1))
            b.ancho = Number(Math.max(b.x + b.ancho - newBx, MIN_SIZE_METERS).toFixed(1))
            b.x = newBx
          } else {
            // A is to the right — trim B's right edge
            b.ancho = Number(Math.max(a.x - b.x, MIN_SIZE_METERS).toFixed(1))
          }
        } else {
          // Trim the Y side of B that faces A's center
          if (a.y + a.alto / 2 < b.y + b.alto / 2) {
            // A is above — trim B's top edge
            const newBy = Number(Math.min(a.y + a.alto, safeH - MIN_SIZE_METERS).toFixed(1))
            b.alto = Number(Math.max(b.y + b.alto - newBy, MIN_SIZE_METERS).toFixed(1))
            b.y = newBy
          } else {
            // A is below — trim B's bottom edge
            b.alto = Number(Math.max(a.y - b.y, MIN_SIZE_METERS).toFixed(1))
          }
        }
        break  // one overlap per location per outer iteration, then re-check
      }
    }
    if (!changed) break
  }

  return result
}

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
      if (!containerRef.current?.contains(event.target)) setIsOpen(false)
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
    return { aspectRatio: `${safeWidth} / ${safeHeight}`, width: '100%' }
  }, [safeWidth, safeHeight])

  const [selectedIds, setSelectedIds] = useState(new Set())
  const [selectionBox, setSelectionBox] = useState(null)
  const selectionBoxRef = useRef(null)
  const [flashId, setFlashId] = useState(null)
  const planRef = useRef(null)
  const dragStateRef = useRef(null)
  const didDragSelectRef = useRef(false)
  const flashTimeoutRef = useRef(null)
  const cardRefs = useRef({})
  const [resizeOverlay, setResizeOverlay] = useState(null)
  const [isAdding, setIsAdding] = useState(false)
  const [types, setTypes] = useState(DEFAULT_TYPES)
  const [typeColors, setTypeColors] = useState(() =>
    DEFAULT_TYPES.reduce((acc, type, index) => {
      acc[type] = TYPE_COLORS[index % TYPE_COLORS.length]
      return acc
    }, {})
  )

  // Stable refs so the event-listener effect never needs to re-register
  const locationsRef = useRef(locations)
  locationsRef.current = locations
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const safeWidthRef = useRef(safeWidth)
  safeWidthRef.current = safeWidth
  const safeHeightRef = useRef(safeHeight)
  safeHeightRef.current = safeHeight

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
          if (!next[type]) next[type] = TYPE_COLORS[index % TYPE_COLORS.length]
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
    setTypeColors((prev) => ({ ...prev, [type]: color }))
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
    if (disabled || !safeWidth || !safeHeight) return
    const defaultSize = Math.min(2, safeWidth, safeHeight)
    const newLoc = {
      id: buildId(),
      nombre: `Ubicación ${locations.length + 1}`,
      tipo: types[0] || DEFAULT_TYPES[0],
      x: coords?.x ?? 0,
      y: coords?.y ?? 0,
      ancho: defaultSize,
      alto: defaultSize,
    }
    const clamped = clampLocation(newLoc)
    if (locations.some((loc) => rectsOverlap(clamped, loc))) return
    onChange([...locations, clamped])
    setSelectedIds(new Set([newLoc.id]))
    setIsAdding(false)
  }

  const handlePlanClick = (event) => {
    if (!event.currentTarget || disabled) return
    if (didDragSelectRef.current) return
    if (!safeWidth || !safeHeight) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const xRatio = (event.clientX - rect.left) / rect.width
    const yRatio = (event.clientY - rect.top) / rect.height
    const x = clamp(xRatio * safeWidth, 0, safeWidth)
    const y = clamp(yRatio * safeHeight, 0, safeHeight)
    if (isAdding) {
      handleAddLocation({ x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) })
    } else {
      setSelectedIds(new Set())
    }
  }

  const handlePlanMouseDown = (event) => {
    if (disabled || !planRef.current || isAdding) return
    if (event.target !== planRef.current) return
    const rect = planRef.current.getBoundingClientRect()
    const xPct = clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100)
    const yPct = clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100)
    dragStateRef.current = {
      mode: 'select',
      startX: event.clientX,
      startY: event.clientY,
      startXPct: xPct,
      startYPct: yPct,
      rect,
    }
  }

  const updateLocation = (id, updates) => {
    onChange(
      locations.map((location) => {
        if (location.id !== id) return location
        const next = typeof updates === 'function' ? updates(location) : { ...location, ...updates }
        return clampLocation(next)
      })
    )
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

  const handleTypeChange = (locationId, value) => updateLocation(locationId, { tipo: value })
  const handleAddType = (value) => ensureType(value)

  const removeLocation = (id) => {
    onChange(locations.filter((location) => location.id !== id))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const flashLocation = (id) => {
    clearTimeout(flashTimeoutRef.current)
    setFlashId(id)
    flashTimeoutRef.current = setTimeout(() => setFlashId(null), 1400)
  }

  const scrollToCard = (id) => {
    cardRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    flashLocation(id)
  }

  const scrollToMapLocation = (id) => {
    planRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setTimeout(() => flashLocation(id), 350)
  }

  const handleDragStart = (event, location, mode) => {
    if (disabled || !planRef.current) return
    event.stopPropagation()
    const rect = planRef.current.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const isAlreadySelected = selectedIds.has(location.id)
    const draggingIds = mode === 'move' && isAlreadySelected
      ? [...selectedIds]
      : [location.id]

    if (!isAlreadySelected) setSelectedIds(new Set([location.id]))

    const origins = {}
    locations.forEach((loc) => {
      if (draggingIds.includes(loc.id)) {
        origins[loc.id] = { x: loc.x, y: loc.y, ancho: loc.ancho, alto: loc.alto }
      }
    })

    // Full snapshot so we can re-compute cascade from original positions on every frame
    const allOriginsSnapshot = locations.map((loc) => ({ ...loc }))

    dragStateRef.current = {
      mode,
      ids: draggingIds,
      origins,
      allOriginsSnapshot,
      startX: event.clientX,
      startY: event.clientY,
      rect,
    }
  }

  // Single stable effect — uses refs instead of closing over changing state
  useEffect(() => {
    const handleMouseMove = (event) => {
      const dragState = dragStateRef.current
      if (!dragState) return

      if (dragState.mode === 'select') {
        const xPct = clamp(((event.clientX - dragState.rect.left) / dragState.rect.width) * 100, 0, 100)
        const yPct = clamp(((event.clientY - dragState.rect.top) / dragState.rect.height) * 100, 0, 100)
        const box = { x1: dragState.startXPct, y1: dragState.startYPct, x2: xPct, y2: yPct }
        selectionBoxRef.current = box
        setSelectionBox(box)
        return
      }

      const safeW = safeWidthRef.current
      const safeH = safeHeightRef.current
      if (!safeW || !safeH) return

      const { rect } = dragState
      const metersPerPxX = safeW / rect.width
      const metersPerPxY = safeH / rect.height
      const rawDeltaX = (event.clientX - dragState.startX) * metersPerPxX
      const rawDeltaY = (event.clientY - dragState.startY) * metersPerPxY

      if (dragState.mode === 'move') {
        // Clamp delta so all dragged locations stay within bounds simultaneously
        let appliedDeltaX = rawDeltaX
        let appliedDeltaY = rawDeltaY
        for (const id of dragState.ids) {
          const o = dragState.origins[id]
          appliedDeltaX = clamp(appliedDeltaX, -o.x, safeW - o.ancho - o.x)
          appliedDeltaY = clamp(appliedDeltaY, -o.y, safeH - o.alto - o.y)
        }

        // Apply delta to dragged items on top of the original snapshot
        const working = dragState.allOriginsSnapshot.map((loc) => {
          if (!dragState.ids.includes(loc.id)) return { ...loc }
          const o = dragState.origins[loc.id]
          return {
            ...loc,
            x: Number((o.x + appliedDeltaX).toFixed(1)),
            y: Number((o.y + appliedDeltaY).toFixed(1)),
          }
        })

        // Push any overlapping static locations out of the way
        onChangeRef.current(resolveOverlaps(working, dragState.ids, safeW, safeH))
        return
      }

      if (dragState.mode === 'resize') {
        const id = dragState.ids[0]
        const o = dragState.origins[id]
        const nextWidth  = Number(clamp(o.ancho + rawDeltaX, MIN_SIZE_METERS, safeW - o.x).toFixed(1))
        const nextHeight = Number(clamp(o.alto  + rawDeltaY, MIN_SIZE_METERS, safeH - o.y).toFixed(1))
        const candidate = { x: o.x, y: o.y, ancho: nextWidth, alto: nextHeight }
        const locs = locationsRef.current
        const staticLocs = locs.filter((l) => l.id !== id)
        if (!staticLocs.some((s) => rectsOverlap(candidate, s))) {
          onChangeRef.current(locs.map((loc) => loc.id === id ? { ...loc, ancho: nextWidth, alto: nextHeight } : loc))
        }
        setResizeOverlay({ x: event.clientX, y: event.clientY, ancho: nextWidth, alto: nextHeight })
      }
    }

    const handleMouseUp = (event) => {
      const dragState = dragStateRef.current
      if (dragState?.mode === 'select') {
        const dx = Math.abs(event.clientX - dragState.startX)
        const dy = Math.abs(event.clientY - dragState.startY)
        if (dx > 5 || dy > 5) {
          const box = selectionBoxRef.current
          if (box) {
            const safeW = safeWidthRef.current
            const safeH = safeHeightRef.current
            const minX = (Math.min(box.x1, box.x2) / 100) * safeW
            const maxX = (Math.max(box.x1, box.x2) / 100) * safeW
            const minY = (Math.min(box.y1, box.y2) / 100) * safeH
            const maxY = (Math.max(box.y1, box.y2) / 100) * safeH
            const selected = new Set()
            locationsRef.current.forEach((loc) => {
              if (loc.x < maxX && loc.x + loc.ancho > minX && loc.y < maxY && loc.y + loc.alto > minY) {
                selected.add(loc.id)
              }
            })
            setSelectedIds(selected)
          }
          didDragSelectRef.current = true
          setTimeout(() => { didDragSelectRef.current = false }, 50)
        }
      }
      dragStateRef.current = null
      selectionBoxRef.current = null
      setResizeOverlay(null)
      setSelectionBox(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, []) // stable — reads all values through refs

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
            onMouseDown={handlePlanMouseDown}
            ref={planRef}
            style={planStyle}
          >
            {locations.map((location) => {
              const left = safeWidth ? (location.x / safeWidth) * 100 : 0
              const top = safeHeight ? (location.y / safeHeight) * 100 : 0
              const width = safeWidth ? (location.ancho / safeWidth) * 100 : 10
              const height = safeHeight ? (location.alto / safeHeight) * 100 : 10
              const isSelected = selectedIds.has(location.id)
              const isFlashing = flashId === location.id
              const isVertical = location.alto > location.ancho * VERTICAL_LABEL_RATIO
              const locationType = location.tipo || types[0] || DEFAULT_TYPES[0]
              const locationColor = resolveTypeColor(locationType)
              return (
                <div
                  key={location.id}
                  className={[
                    'bodega-layout__location',
                    isSelected ? 'bodega-layout__location--selected' : '',
                    isVertical ? 'bodega-layout__location--vertical' : '',
                    isFlashing ? 'bodega-layout__location--flash' : '',
                  ].filter(Boolean).join(' ')}
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
                    setSelectedIds(new Set([location.id]))
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation()
                    scrollToCard(location.id)
                  }}
                  onMouseDown={(event) => handleDragStart(event, location, 'move')}
                >
                  <span className="bodega-layout__location-label" title={location.nombre}>
                    {location.nombre}
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
            {selectionBox && (
              <div
                className="bodega-layout__selection-box"
                style={{
                  left: `${Math.min(selectionBox.x1, selectionBox.x2)}%`,
                  top: `${Math.min(selectionBox.y1, selectionBox.y2)}%`,
                  width: `${Math.abs(selectionBox.x2 - selectionBox.x1)}%`,
                  height: `${Math.abs(selectionBox.y2 - selectionBox.y1)}%`,
                }}
              />
            )}
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
          <div
            key={location.id}
            ref={(el) => { cardRefs.current[location.id] = el }}
            className={[
              'bodega-layout__card',
              flashId === location.id ? 'bodega-layout__card--flash' : '',
            ].filter(Boolean).join(' ')}
          >
            <div className="bodega-layout__card-header">
              <h5>{location.nombre || `Ubicación ${index + 1}`}</h5>
              <div className="bodega-layout__card-actions">
                <button
                  type="button"
                  className="bodega-layout__view-in-map"
                  onClick={() => scrollToMapLocation(location.id)}
                >
                  <i className="pi pi-map-marker" />
                  Ver en mapa
                </button>
                <button
                  type="button"
                  className="create-user__action create-user__action--cancel"
                  onClick={() => removeLocation(location.id)}
                  disabled={disabled}
                >
                  Eliminar
                </button>
              </div>
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
