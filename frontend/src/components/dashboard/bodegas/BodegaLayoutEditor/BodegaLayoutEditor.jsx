import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye } from 'lucide-react'
import { getAppPortalRoot } from '../../../../utils/portalRoot'
import { API_URL, authFetch } from '../../../../utils/api'
import { goToSection } from '../../../../utils/navigation'
import './BodegaLayoutEditor.css'
import { REFERENCE_TYPES, REFERENCE_TYPE_COLORS, isReferenceType, setCatalogReferenceTypes } from './referenceTypes'

const buildId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
const normalizeNumber = (value) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Number(numeric.toFixed(1)) : 0
}

const DEFAULT_COLOR = '#4f8df8'
const MIN_SIZE_METERS = 0.5
const VERTICAL_LABEL_RATIO = 1.6
const DEFAULT_TYPES = ['Estantería', 'Cajonera', 'Muebles', ...REFERENCE_TYPES]
const TYPE_COLORS = ['#4f8df8', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#14b8a6']
const OVERLAP_TOLERANCE = 0.05
// Pasos (en metros) del panel de ajuste fino: mover y cambiar tamaño sin arrastrar.
// Distancia minima (px) antes de empezar a arrastrar: con el dedo un toque
// siempre se mueve un poco, y eso no debe desplazar la ubicacion.
const DRAG_THRESHOLD_MOUSE = 2
const DRAG_THRESHOLD_TOUCH = 8

// Walk up the DOM to find the nearest scrollable ancestor
const findScrollParent = (el) => {
  let node = el?.parentElement
  while (node && node !== document.body) {
    const { overflow, overflowY } = window.getComputedStyle(node)
    if (/(auto|scroll)/.test(overflow + overflowY)) return node
    node = node.parentElement
  }
  return document.documentElement
}

// Scroll an element into view precisely within its actual scroll container.
// align 'start' puts the element near the top; 'center' centers it vertically.
const scrollToPrecise = (el, align = 'start', offset = 20) => {
  if (!el) return
  const container = findScrollParent(el)
  const isDoc = container === document.documentElement
  const containerTop = isDoc ? 0 : container.getBoundingClientRect().top
  const elRect = el.getBoundingClientRect()
  const relativeTop = elRect.top - containerTop + container.scrollTop

  let targetScrollTop
  if (align === 'center') {
    const containerH = isDoc ? window.innerHeight : container.clientHeight
    targetScrollTop = relativeTop - (containerH - elRect.height) / 2
  } else {
    targetScrollTop = relativeTop - offset
  }

  container.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' })
}

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
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [menuStyle, setMenuStyle] = useState(null)
  const containerRef = useRef(null)
  const menuRef = useRef(null)

  // El menu va en una capa encima de la pantalla (portal, posicion fija): asi
  // no queda cortado por la lista de tarjetas ni le sale una segunda barra de
  // desplazamiento. Se abre hacia arriba si abajo no hay espacio.
  const placeMenu = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const gap = 8
    const menuHeight = menuRef.current?.offsetHeight || 300
    const spaceBelow = window.innerHeight - rect.bottom - gap
    const openUp = spaceBelow < menuHeight && rect.top - gap > spaceBelow
    setMenuStyle({
      position: 'fixed',
      left: Math.max(8, rect.left),
      width: rect.width,
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + gap }
        : { top: rect.bottom + gap }),
    })
  }, [])

  useLayoutEffect(() => {
    if (!isOpen) return undefined
    placeMenu()
    window.addEventListener('scroll', placeMenu, true)
    window.addEventListener('resize', placeMenu)
    return () => {
      window.removeEventListener('scroll', placeMenu, true)
      window.removeEventListener('resize', placeMenu)
    }
  }, [isOpen, placeMenu])

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (event) => {
      if (containerRef.current?.contains(event.target)) return
      if (menuRef.current?.contains(event.target)) return
      setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside, true)
    return () => document.removeEventListener('mousedown', handleClickOutside, true)
  }, [isOpen])

  const filtered = options.filter((option) =>
    option.toLowerCase().includes(query.toLowerCase())
  )

  const handleSelect = (option) => {
    onSelect(option)
    setQuery('')
    setIsOpen(false)
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
        <span className="bodega-type-select__value">
          {isReferenceType(value) && (
            <Eye className="bodega-type-select__visual" size={14} aria-label="Solo visual" />
          )}
          <span>{value || placeholder}</span>
        </span>
        <div className="bodega-type-select__control-actions">
          <span className="bodega-type-select__color">
            <span
              className="bodega-type-select__color-dot"
              style={{ backgroundColor: colors?.[value] || DEFAULT_COLOR }}
            />
          </span>
          <i className={`pi pi-chevron-${isOpen ? 'up' : 'down'}`} />
        </div>
      </button>

      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          className="bodega-type-select__menu bodega-type-select__menu--floating"
          style={menuStyle || { position: 'fixed', visibility: 'hidden' }}
        >
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
                <span className="bodega-type-select__value">
                  {isReferenceType(option) && (
                    <Eye className="bodega-type-select__visual" size={14} aria-hidden="true" />
                  )}
                  <span>{option}</span>
                </span>
                <span className="bodega-type-select__color">
                  <span
                    className="bodega-type-select__color-dot"
                    style={{ backgroundColor: colors?.[option] || DEFAULT_COLOR }}
                  />
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="bodega-type-select__create"
            onClick={() => {
              setIsOpen(false)
              goToSection('Tipos de ubicación')
            }}
          >
            ¿Falta un tipo? Créalo en Sucursales → Tipos de ubicación
          </button>
          <p className="bodega-type-select__legend">
            <Eye size={12} aria-hidden="true" /> Solo visual: sirve para identificar en el mapa, no lleva subdivisiones.
          </p>
        </div>,
        getAppPortalRoot()
      )}
    </div>
  )
}

function BodegaLayoutEditor({ widthMeters, heightMeters, locations, onChange, disabled, renderLocationFooter, onBeforeRemoveLocation }) {
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
      acc[type] = REFERENCE_TYPE_COLORS[type] || TYPE_COLORS[index % TYPE_COLORS.length]
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

  // Tipos y colores del catalogo (Sucursales -> Tipos de ubicacion).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const response = await authFetch(`${API_URL}/tipos/tipos-division/?page_size=500&ordering=nombre`)
        if (!response.ok) return
        const data = await response.json()
        const list = (Array.isArray(data) ? data : data?.results || [])
          .filter((tipo) => String(tipo?.nombre || '').trim() && String(tipo.nombre).trim().toLowerCase() !== 'temporal')
        if (cancelled || !list.length) return
        setCatalogReferenceTypes(list.filter((tipo) => tipo.es_referencia).map((tipo) => tipo.nombre))
        const names = list.map((tipo) => String(tipo.nombre).trim())
        setTypes((prev) => Array.from(new Set([...names, ...prev.filter((type) => !DEFAULT_TYPES.includes(type))])))
        setTypeColors((prev) => {
          const next = { ...prev }
          list.forEach((tipo) => {
            if (tipo.color) next[String(tipo.nombre).trim()] = tipo.color
          })
          return next
        })
      } catch {
        // sin catalogo: quedan los tipos de siempre
      }
    })()
    return () => { cancelled = true }
  }, [])

  const resolveTypeColor = useCallback(
    (type) => typeColors[type] || DEFAULT_COLOR,
    [typeColors]
  )

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

  const handlePlanPointerDown = (event) => {
    if (disabled || !planRef.current || isAdding) return
    if (event.target !== planRef.current) return
    // Con el dedo, arrastrar sobre el fondo del plano hace scroll de la pagina;
    // la seleccion por recuadro queda solo para el mouse.
    if (event.pointerType !== 'mouse') return
    const rect = planRef.current.getBoundingClientRect()
    const xPct = clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100)
    const yPct = clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100)
    dragStateRef.current = {
      mode: 'select',
      pointerId: event.pointerId,
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

  const handleTypeChange = (locationId, value) => updateLocation(locationId, { tipo: value })
  const [removingId, setRemovingId] = useState(null)

  // onBeforeRemoveLocation (opcional) revisa antes si se puede quitar, p. ej.
  // que no queden productos con cantidad en esa ubicacion.
  const removeLocation = async (id) => {
    if (removingId) return
    const target = locations.find((location) => location.id === id)
    if (typeof onBeforeRemoveLocation === 'function' && target) {
      setRemovingId(id)
      let allowed = false
      try {
        allowed = await onBeforeRemoveLocation(target)
      } finally {
        setRemovingId(null)
      }
      if (!allowed) return
    }
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
    scrollToPrecise(cardRefs.current[id], 'start', 20)
    flashLocation(id)
  }

  const scrollToMapLocation = (id) => {
    scrollToPrecise(planRef.current, 'start', 20)
    setTimeout(() => flashLocation(id), 400)
  }

  const handleDragStart = (event, location, mode) => {
    if (disabled || !planRef.current) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.stopPropagation()
    const rect = planRef.current.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const isAlreadySelected = selectedIds.has(location.id)
    // Con el dedo: el primer toque solo selecciona (asi deslizar sobre una
    // ubicacion no seleccionada sigue haciendo scroll); ya seleccionada, se arrastra.
    if (event.pointerType !== 'mouse' && mode === 'move' && !isAlreadySelected) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const draggingIds = isAlreadySelected ? [...selectedIds] : [location.id]

    if (!isAlreadySelected) setSelectedIds(new Set([location.id]))

    const origins = {}
    let bboxX = Infinity, bboxY = Infinity, bboxRight = -Infinity, bboxBottom = -Infinity
    locations.forEach((loc) => {
      if (draggingIds.includes(loc.id)) {
        origins[loc.id] = { x: loc.x, y: loc.y, ancho: loc.ancho, alto: loc.alto }
        bboxX = Math.min(bboxX, loc.x)
        bboxY = Math.min(bboxY, loc.y)
        bboxRight  = Math.max(bboxRight,  loc.x + loc.ancho)
        bboxBottom = Math.max(bboxBottom, loc.y + loc.alto)
      }
    })

    // Full snapshot so we can re-compute cascade from original positions on every frame
    const allOriginsSnapshot = locations.map((loc) => ({ ...loc }))

    dragStateRef.current = {
      mode,
      ids: draggingIds,
      origins,
      allOriginsSnapshot,
      // Bounding box of the selection at drag start (used for proportional group resize)
      bbox: { x: bboxX, y: bboxY, w: bboxRight - bboxX, h: bboxBottom - bboxY },
      pointerId: event.pointerId,
      threshold: event.pointerType === 'mouse' ? DRAG_THRESHOLD_MOUSE : DRAG_THRESHOLD_TOUCH,
      active: false,
      startX: event.clientX,
      startY: event.clientY,
      rect,
    }
  }

  // Single stable effect — uses refs instead of closing over changing state
  useEffect(() => {
    const handlePointerMove = (event) => {
      const dragState = dragStateRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) return

      if (dragState.mode === 'select') {
        const xPct = clamp(((event.clientX - dragState.rect.left) / dragState.rect.width) * 100, 0, 100)
        const yPct = clamp(((event.clientY - dragState.rect.top) / dragState.rect.height) * 100, 0, 100)
        const box = { x1: dragState.startXPct, y1: dragState.startYPct, x2: xPct, y2: yPct }
        selectionBoxRef.current = box
        setSelectionBox(box)
        return
      }

      if (!dragState.active) {
        const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY)
        if (distance < dragState.threshold) return
        dragState.active = true
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
        // Scale the entire group proportionally around the bounding box captured at drag start.
        // This keeps relative positions and gaps intact — the group shrinks/grows as one unit.
        const { bbox } = dragState
        const newBboxW = clamp(bbox.w + rawDeltaX, MIN_SIZE_METERS, safeW - bbox.x)
        const newBboxH = clamp(bbox.h + rawDeltaY, MIN_SIZE_METERS, safeH - bbox.y)
        const scaleX = bbox.w > 0 ? newBboxW / bbox.w : 1
        const scaleY = bbox.h > 0 ? newBboxH / bbox.h : 1

        const newGeom = {}
        for (const id of dragState.ids) {
          const o = dragState.origins[id]
          newGeom[id] = {
            x:     Number((bbox.x + (o.x - bbox.x) * scaleX).toFixed(1)),
            y:     Number((bbox.y + (o.y - bbox.y) * scaleY).toFixed(1)),
            ancho: Number(Math.max(o.ancho * scaleX, MIN_SIZE_METERS).toFixed(1)),
            alto:  Number(Math.max(o.alto  * scaleY, MIN_SIZE_METERS).toFixed(1)),
          }
        }

        const locs = locationsRef.current
        const draggedSet = new Set(dragState.ids)
        const staticLocs = locs.filter((l) => !draggedSet.has(l.id))
        const hasOverlap = dragState.ids.some((id) =>
          staticLocs.some((s) => rectsOverlap(newGeom[id], s))
        )

        if (!hasOverlap) {
          onChangeRef.current(locs.map((loc) =>
            draggedSet.has(loc.id) ? { ...loc, ...newGeom[loc.id] } : loc
          ))
        }

        setResizeOverlay({ x: event.clientX, y: event.clientY, ancho: newBboxW, alto: newBboxH })
      }
    }

    const handlePointerUp = (event) => {
      const dragState = dragStateRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) return
      if (dragState.mode === 'select') {
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

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, []) // stable — reads all values through refs


  return (
    <div className="bodega-layout">
      <div className="bodega-layout__meta">
        <p>
          Plano interactivo para distribuir ubicaciones internas. Toca una ubicación para
          seleccionarla y luego arrástrala.
        </p>
        <button
          type="button"
          className="create-user__action create-user__action--cancel"
          onClick={() => setIsAdding((prev) => !prev)}
          disabled={disabled || !safeWidth || !safeHeight}
        >
          {isAdding ? 'Toca el plano donde va...' : 'Agregar ubicación'}
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
                  style={{
                    borderColor: resolveTypeColor(type),
                    backgroundColor: `color-mix(in srgb, ${resolveTypeColor(type)} 30%, transparent)`,
                  }}
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
            onPointerDown={handlePlanPointerDown}
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
                    // Como el mapa de conteo: borde del color y relleno al 30%.
                    borderColor: locationColor,
                    backgroundColor: `color-mix(in srgb, ${locationColor} 30%, transparent)`,
                  }}
                  onClick={(event) => {
                    event.stopPropagation()
                    // Fuera de "Editar" no se selecciona (no se puede mover).
                    if (disabled) return
                    setSelectedIds(new Set([location.id]))
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation()
                    scrollToCard(location.id)
                  }}
                  onPointerDown={(event) => handleDragStart(event, location, 'move')}
                >
                  <span className="bodega-layout__location-label" title={location.nombre}>
                    {location.nombre}
                  </span>
                  <button
                    type="button"
                    className="bodega-layout__resize-handle"
                    onPointerDown={(event) => handleDragStart(event, location, 'resize')}
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
              <h5 className="bodega-layout__card-title">
                {isReferenceType(location.tipo) && (
                  <Eye className="bodega-type-select__visual" size={16} aria-label="Solo visual" />
                )}
                {location.nombre || `Ubicación ${index + 1}`}
              </h5>
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
                  className="create-user__action user-details__delete"
                  onClick={() => { void removeLocation(location.id) }}
                  disabled={disabled || removingId === location.id}
                >
                  {removingId === location.id ? 'Revisando...' : 'Eliminar'}
                </button>
              </div>
            </div>
            <div className="bodega-layout__grid">
              <label className="create-user__field">
                <span>División</span>
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
                  placeholder="Buscar tipo"
                  onSelect={(value) => handleTypeChange(location.id, value)}
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
            {typeof renderLocationFooter === 'function' && !isReferenceType(location.tipo)
              ? renderLocationFooter(location, index)
              : null}
            {isReferenceType(location.tipo) && (
              <p className="bodega-layout__hint bodega-layout__hint--visual">
                <Eye size={14} aria-hidden="true" /> Solo visual: sirve para identificar en el mapa, no lleva subdivisiones ni productos.
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default BodegaLayoutEditor
