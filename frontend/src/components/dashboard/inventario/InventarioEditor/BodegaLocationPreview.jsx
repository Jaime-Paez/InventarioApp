import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './BodegaLocationPreview.css'

const DEFAULT_COLOR = '#4f8df8'
const HIGHLIGHT_COLOR = '#dc2626'
const TYPE_COLORS = ['#4f8df8', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#14b8a6']
// Mismo orden de tipos que el editor de Bodegas, para que cada tipo tenga el
// mismo color en los dos mapas.
const DEFAULT_TYPES = ['Estantería', 'Cajonera', 'Muebles']
const VERTICAL_LABEL_RATIO = 1.6
const DEFAULT_ZOOM = 2

const normalizeKey = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()

const toNumber = (value) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

const toPositive = (value) => Math.max(0, toNumber(value))

const toRgba = (hex, alpha) => {
  const safeAlpha = Math.max(0, Math.min(1, Number(alpha) || 0))
  const value = String(hex || '').replace('#', '').trim()
  if (!value) return `rgba(79, 141, 248, ${safeAlpha})`

  const fullHex = value.length === 3 ? value.split('').map((char) => `${char}${char}`).join('') : value
  if (!/^[0-9a-fA-F]{6}$/.test(fullHex)) return `rgba(79, 141, 248, ${safeAlpha})`

  const int = Number.parseInt(fullHex, 16)
  const r = (int >> 16) & 255
  const g = (int >> 8) & 255
  const b = int & 255
  return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`
}

const normalizeLocation = (location, index) => ({
  id: String(location?.id ?? `layout-${index}`),
  nombre: String(location?.nombre ?? '').trim(),
  tipo: String(location?.tipo ?? '').trim(),
  x: toPositive(location?.x),
  y: toPositive(location?.y),
  ancho: toPositive(location?.ancho),
  alto: toPositive(location?.alto),
})

const getPortalHost = () => {
  if (typeof document === 'undefined') return null
  // Usar siempre document.body: ".dashboard-shell" tiene "transform" en su CSS
  // (incluso "translateX(0)" cuenta), lo que crea un nuevo contexto de
  // apilamiento y atrapa el z-index de este popup por debajo de cualquier
  // otro modal (ej. Recordatorios) que si se porte directo al body.
  return document.body
}

const resolvePlanSize = (bodega, locations) => {
  const width = toPositive(bodega?.ancho_metros)
  const height = toPositive(bodega?.alto_metros)
  if (width > 0 && height > 0) {
    return { width, height }
  }

  const fallbackWidth = locations.reduce((max, location) => Math.max(max, location.x + location.ancho), 0)
  const fallbackHeight = locations.reduce((max, location) => Math.max(max, location.y + location.alto), 0)

  return { width: fallbackWidth, height: fallbackHeight }
}

const buildTypeColors = (locations) => {
  // Igual que BodegaLayoutEditor: primero los tipos por defecto y luego los
  // que aparezcan, cada uno con el color de su posicion en esa lista.
  const types = [...DEFAULT_TYPES]
  locations.forEach((location) => {
    if (location.tipo && !types.includes(location.tipo)) types.push(location.tipo)
  })
  const map = new Map()
  types.forEach((type, index) => map.set(type, TYPE_COLORS[index % TYPE_COLORS.length]))
  return map
}

function BodegaLocationPreview({ bodega, divisionName, subdivisionName, darkMode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [isDarkMode, setIsDarkMode] = useState(false)
  const [portalRoot, setPortalRoot] = useState(null)
  // Espacio disponible para el plano: se ajusta completo a la pantalla
  // (sin scroll) manteniendo la proporcion real en metros.
  const fitAreaRef = useRef(null)
  const [fitArea, setFitArea] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (portalRoot) return
    setPortalRoot(getPortalHost())
  }, [portalRoot])
  const normalizedDivisionName = useMemo(() => normalizeKey(divisionName), [divisionName])
  const locations = useMemo(() => {
    const raw = Array.isArray(bodega?.ubicaciones) ? bodega.ubicaciones : []
    return raw
      .map((location, index) => normalizeLocation(location, index))
      .filter((location) => location.ancho > 0 && location.alto > 0)
  }, [bodega?.ubicaciones])

  const planSize = useMemo(() => resolvePlanSize(bodega, locations), [bodega, locations])
  const typeColors = useMemo(() => buildTypeColors(locations), [locations])
  const hasPlan = planSize.width > 0 && planSize.height > 0 && locations.length > 0

  const highlightedId = useMemo(() => {
    if (!normalizedDivisionName) return null
    const match = locations.find((location) => normalizeKey(location.nombre) === normalizedDivisionName)
    return match ? match.id : null
  }, [locations, normalizedDivisionName])

  useEffect(() => {
    if (!isOpen) return undefined

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsOpen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [isOpen])

  useLayoutEffect(() => {
    if (!isOpen) return undefined
    const node = fitAreaRef.current
    if (!node) return undefined
    const measure = () => {
      // Sin el espacio de la barra de scroll vertical (scrollbar-gutter fijo).
      const rect = { width: node.clientWidth, height: node.clientHeight }
      setFitArea((prev) => (
        Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
          ? prev
          : { width: rect.width, height: rect.height }
      ))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [isOpen, portalRoot, hasPlan])

  // Tamano base: el mas grande que entra completo en el area ("contain").
  const containSize = useMemo(() => {
    if (!hasPlan || !fitArea.width || !fitArea.height) return null
    const ratio = planSize.width / planSize.height
    let width = fitArea.width
    let height = width / ratio
    if (height > fitArea.height) {
      height = fitArea.height
      width = height * ratio
    }
    return { width, height }
  }, [fitArea, hasPlan, planSize])

  // Zoom sobre el tamano base. Se abre ampliado (sin pasarse del ancho
  // disponible) para que las perchas se lean; "Ver todo" vuelve a 1.
  const maxZoom = containSize ? Math.max(1, Math.min(6, (fitArea.width / containSize.width) * 2)) : 1
  const defaultZoom = containSize ? Math.max(1, Math.min(DEFAULT_ZOOM, fitArea.width / containSize.width)) : 1
  const [zoom, setZoom] = useState(null)
  const effectiveZoom = Math.min(maxZoom, zoom ?? defaultZoom)
  useEffect(() => {
    if (isOpen) setZoom(null)
  }, [isOpen])

  const fittedPlanStyle = useMemo(() => {
    if (!containSize) return { visibility: 'hidden' }
    return {
      width: `${Math.floor(containSize.width * effectiveZoom)}px`,
      height: `${Math.floor(containSize.height * effectiveZoom)}px`,
    }
  }, [containSize, effectiveZoom])

  // Al abrir o cambiar el zoom, la ubicacion marcada queda en el centro.
  const activeRef = useRef(null)
  useLayoutEffect(() => {
    const container = fitAreaRef.current
    const active = activeRef.current
    if (!isOpen || !container || !containSize) return
    if (!active) {
      container.scrollLeft = (container.scrollWidth - container.clientWidth) / 2
      container.scrollTop = (container.scrollHeight - container.clientHeight) / 2
      return
    }
    const cRect = container.getBoundingClientRect()
    const aRect = active.getBoundingClientRect()
    container.scrollLeft += aRect.left + aRect.width / 2 - (cRect.left + container.clientWidth / 2)
    container.scrollTop += aRect.top + aRect.height / 2 - (cRect.top + container.clientHeight / 2)
  }, [isOpen, containSize, effectiveZoom])

  const changeZoom = (factor) => {
    setZoom(Math.max(1, Math.min(maxZoom, Math.round(effectiveZoom * factor * 100) / 100)))
  }

  // Arrastrar con el mouse para moverse por el plano.
  const dragRef = useRef(null)
  const handlePointerDown = (event) => {
    if (event.button !== 0) return
    const container = fitAreaRef.current
    if (!container) return
    // Clic sobre la barra de scroll: que la maneje el navegador.
    const box = container.getBoundingClientRect()
    if (event.clientX - box.left > container.clientWidth || event.clientY - box.top > container.clientHeight) return
    dragRef.current ={ x: event.clientX, y: event.clientY, left: container.scrollLeft, top: container.scrollTop }
    container.setPointerCapture?.(event.pointerId)
  }
  const handlePointerMove = (event) => {
    const drag = dragRef.current
    const container = fitAreaRef.current
    if (!drag || !container) return
    container.scrollLeft = drag.left - (event.clientX - drag.x)
    container.scrollTop = drag.top - (event.clientY - drag.y)
  }
  const handlePointerUp = (event) => {
    dragRef.current = null
    fitAreaRef.current?.releasePointerCapture?.(event.pointerId)
  }

  const popup = isOpen && portalRoot
    ? createPortal(
      <div
        className={`inventario-map-popup${isDarkMode ? ' inventario-map-popup--dark' : ''}`}
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setIsOpen(false)
          }
        }}
      >
        <div className="inventario-map-popup__dialog">
          <header className="inventario-map-popup__header">
            <div className="inventario-map-popup__title">
              <h4>{bodega?.nombre || 'Bodega'}</h4>
              <p>
                <strong>Division:</strong> {divisionName || '-'}
              </p>
              <p>
                <strong>Subdivision:</strong> {subdivisionName || '-'}
              </p>
            </div>
            {hasPlan ? (
              <div className="inventario-map-popup__zoom">
                <button
                  type="button"
                  className="inventario-map-popup__zoom-btn"
                  onClick={() => changeZoom(1 / 1.25)}
                  disabled={effectiveZoom <= 1}
                  aria-label="Alejar"
                  data-title="Alejar"
                >
                  <i className="pi pi-search-minus" aria-hidden="true" />
                </button>
                <span className="inventario-map-popup__zoom-value">{Math.round(effectiveZoom * 100)}%</span>
                <button
                  type="button"
                  className="inventario-map-popup__zoom-btn"
                  onClick={() => changeZoom(1.25)}
                  disabled={effectiveZoom >= maxZoom}
                  aria-label="Acercar"
                  data-title="Acercar"
                >
                  <i className="pi pi-search-plus" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="inventario-map-popup__zoom-btn inventario-map-popup__zoom-btn--text"
                  onClick={() => setZoom(1)}
                  disabled={effectiveZoom <= 1}
                >
                  Ver todo
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="inventario-map-popup__close"
              onClick={() => setIsOpen(false)}
              aria-label="Cerrar mapa"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </header>

          <div className="inventario-map-popup__body">
            {hasPlan ? (
              <div className="inventario-map-preview__plan-wrapper inventario-map-preview__plan-wrapper--popup">
                <div
                  className={`inventario-map-preview__fit-area${effectiveZoom > 1 ? ' inventario-map-preview__fit-area--zoomed' : ''}`}
                  ref={fitAreaRef}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                >
                <div
                  className="inventario-map-preview__plan inventario-map-preview__plan--popup"
                  style={fittedPlanStyle}
                >
                  {locations.map((location) => {
                    const left = planSize.width ? (location.x / planSize.width) * 100 : 0
                    const top = planSize.height ? (location.y / planSize.height) * 100 : 0
                    const width = planSize.width ? (location.ancho / planSize.width) * 100 : 0
                    const height = planSize.height ? (location.alto / planSize.height) * 100 : 0
                    const isActive = highlightedId != null && location.id === highlightedId
                    const isVertical = location.alto > location.ancho * VERTICAL_LABEL_RATIO
                    const baseColor = typeColors.get(location.tipo || DEFAULT_TYPES[0]) || DEFAULT_COLOR
                    const borderColor = isActive ? HIGHLIGHT_COLOR : baseColor
                    // Mismo relleno que el editor de Sucursales (color del tipo al 30%).
                    const backgroundColor = isActive ? toRgba(HIGHLIGHT_COLOR, 0.3) : toRgba(baseColor, 0.3)

                    return (
                      <div
                        key={location.id}
                        ref={isActive ? activeRef : undefined}
                        className={`inventario-map-preview__location${isActive ? ' inventario-map-preview__location--active' : ''}${isVertical ? ' inventario-map-preview__location--vertical' : ''}`}
                        style={{
                          left: `${left}%`,
                          top: `${top}%`,
                          width: `${width}%`,
                          height: `${height}%`,
                          borderColor,
                          backgroundColor,
                        }}
                      >
                        <span title={location.nombre}>{location.nombre || 'Ubicacion'}</span>
                      </div>
                    )
                  })}
                </div>
                </div>
              </div>
            ) : (
              <p className="inventario-map-preview__hint">Mapa no disponible para esta bodega.</p>
            )}

            {hasPlan && !highlightedId ? (
              <p className="inventario-map-preview__hint">
                No se encontro la division <strong>{divisionName || '-'}</strong> dentro del plano.
              </p>
            ) : null}
          </div>
        </div>
      </div>,
      portalRoot
    )
    : null

  return (
    <div className="inventario-map-preview">
      <button
        type="button"
        className={`inventario-map-preview__trigger${darkMode ? ' inventario-map-preview__trigger--dark' : ''}`}
        aria-label={`Abrir mapa de ${bodega?.nombre || 'bodega'}`}
        onClick={() => {
          setIsDarkMode(darkMode !== undefined
            ? Boolean(darkMode)
            : Boolean(document.querySelector('.dashboard-shell')?.classList.contains('dark')))
          setIsOpen(true)
        }}
      >
        <i className="pi pi-map-marker" aria-hidden="true" />
      </button>
      {popup}
    </div>
  )
}

export default BodegaLocationPreview
