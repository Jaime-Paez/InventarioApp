import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import './BodegaLocationPreview.css'

const DEFAULT_COLOR = '#4f8df8'
const HIGHLIGHT_COLOR = '#dc2626'
const TYPE_COLORS = ['#4f8df8', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#14b8a6']
const VERTICAL_LABEL_RATIO = 1.6

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
  return document.querySelector('.dashboard-shell') || document.querySelector('.app-shell') || document.body
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
  const map = new Map()
  let index = 0
  locations.forEach((location) => {
    if (!location.tipo || map.has(location.tipo)) return
    map.set(location.tipo, TYPE_COLORS[index % TYPE_COLORS.length])
    index += 1
  })
  return map
}

function BodegaLocationPreview({ bodega, divisionName, subdivisionName }) {
  const [isOpen, setIsOpen] = useState(false)
  const [portalRoot, setPortalRoot] = useState(null)
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

  const popup = isOpen && portalRoot
    ? createPortal(
      <div
        className="inventario-map-popup"
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
                  className="inventario-map-preview__plan inventario-map-preview__plan--popup"
                  style={{ aspectRatio: `${planSize.width} / ${planSize.height}` }}
                >
                  {locations.map((location) => {
                    const left = planSize.width ? (location.x / planSize.width) * 100 : 0
                    const top = planSize.height ? (location.y / planSize.height) * 100 : 0
                    const width = planSize.width ? (location.ancho / planSize.width) * 100 : 0
                    const height = planSize.height ? (location.alto / planSize.height) * 100 : 0
                    const isActive = highlightedId != null && location.id === highlightedId
                    const isVertical = location.alto > location.ancho * VERTICAL_LABEL_RATIO
                    const baseColor = typeColors.get(location.tipo) || DEFAULT_COLOR
                    const borderColor = isActive ? HIGHLIGHT_COLOR : baseColor
                    const backgroundColor = isActive ? toRgba(HIGHLIGHT_COLOR, 0.2) : toRgba(baseColor, 0.15)

                    return (
                      <div
                        key={location.id}
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
        className="inventario-map-preview__trigger"
        aria-label={`Abrir mapa de ${bodega?.nombre || 'bodega'}`}
        onClick={() => setIsOpen(true)}
      >
        <i className="pi pi-map-marker" aria-hidden="true" />
      </button>
      {popup}
    </div>
  )
}

export default BodegaLocationPreview
