import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getAppPortalRoot } from '../../../utils/portalRoot'
import { useCloseDropdownsOnTabSwitch } from '../../../hooks/useCloseDropdownsOnTabSwitch'
import '../admin/CreateUsuario/CreateUsuario.css'

const normalizeForSearch = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()

// Dropdown con búsqueda debounced sobre una lista ya cargada en memoria —
// mismo patrón (create-user__dropdown + create-user__result-option) que
// usan las demás búsquedas en cascada Sucursal/Bodega/Division del resto
// de la app (ver InventarioEditor.jsx). El panel se renderiza vía portal
// con create-user__dropdown-panel--floating (position:fixed) para que
// pueda salirse del modal en vez de quedar recortado por su overflow.
// `emptyMessage`: que decir cuando la lista viene vacia (sin buscar nada),
// p. ej. "Esta bodega no tiene divisiones" en vez de "Sin resultados.".
export default function CascadeDropdown({ placeholder, searchPlaceholder, options, valueId, onSelect, disabled, getOptionLabel, emptyMessage }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [panelRect, setPanelRect] = useState(null)
  const wrapRef = useRef(null)
  const panelRef = useRef(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(normalizeForSearch(query)), 260)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!open) return undefined
    const handleOutsideClick = (event) => {
      const inTrigger = wrapRef.current?.contains(event.target)
      const inPanel = panelRef.current?.contains(event.target)
      if (!inTrigger && !inPanel) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  useCloseDropdownsOnTabSwitch(
    useCallback(() => {
      setOpen(false)
      setQuery('')
    }, [])
  )

  const filtered = useMemo(() => {
    if (!debouncedQuery) return options
    return options.filter((o) => normalizeForSearch(getOptionLabel(o)).includes(debouncedQuery))
  }, [options, debouncedQuery, getOptionLabel])

  const selected = options.find((o) => String(o.id) === String(valueId))

  return (
    <div className="create-user__dropdown" ref={wrapRef}>
      <button
        type="button"
        className="create-user__dropdown-trigger"
        onClick={(event) => {
          if (disabled) return
          if (open) {
            setOpen(false)
            setQuery('')
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          // El panel puede llegar a medir ~230px (buscador + resultados con
          // max-height:150px). Si no hay espacio debajo, se abre hacia
          // arriba anclando el borde inferior (bottom) en vez del superior,
          // para que nunca quede cortado por el borde de la pantalla.
          const estimatedPanelHeight = 230
          const spaceBelow = window.innerHeight - rect.bottom
          const spaceAbove = rect.top
          const openUpward = spaceBelow < estimatedPanelHeight && spaceAbove > spaceBelow
          const left = Math.min(Math.max(rect.left, 8), window.innerWidth - rect.width - 8)
          setPanelRect({
            left,
            width: rect.width,
            ...(openUpward
              ? { bottom: window.innerHeight - rect.top + 4 }
              : { top: rect.bottom + 4 }),
          })
          setOpen(true)
        }}
        disabled={disabled}
      >
        <span>{selected ? getOptionLabel(selected) : placeholder}</span>
        <i className={`pi pi-chevron-${open ? 'up' : 'down'}`} />
      </button>

      {open && panelRect && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          className="create-user__dropdown-panel create-user__dropdown-panel--floating"
          style={{ top: panelRect.top, bottom: panelRect.bottom, left: panelRect.left, width: panelRect.width, maxHeight: 'calc(100vh - 16px)' }}
        >
          <div className="create-user__dropdown-search">
            <i className="pi pi-search" />
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
              autoComplete="off"
            />
          </div>
          <div className="create-user__dropdown-results">
            {!filtered.length && (
              <small className="muted">{!options.length && emptyMessage ? emptyMessage : 'Sin resultados.'}</small>
            )}
            {filtered.map((option) => (
              <button
                key={option.id}
                type="button"
                className="create-user__result-option"
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onSelect(option)
                  setOpen(false)
                  setQuery('')
                }}
              >
                <div className="create-user__result-info">
                  <strong>{getOptionLabel(option)}</strong>
                </div>
              </button>
            ))}
          </div>
        </div>,
        getAppPortalRoot()
      )}
    </div>
  )
}

