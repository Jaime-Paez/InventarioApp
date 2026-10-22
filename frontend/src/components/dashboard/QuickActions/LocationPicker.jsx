import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from 'lucide-react'

const normalize = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

// Selector de ubicacion con buscador ("Bodega / Division / Subdivision").
function LocationPicker({ options, value, onChange, disabled }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [rect, setRect] = useState(null)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const selected = options.find((option) => String(option.id) === String(value)) || null

  useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (triggerRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const reposition = () => {
      const box = triggerRef.current?.getBoundingClientRect()
      if (box) setRect(box)
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  const filtered = useMemo(() => {
    const term = normalize(query)
    return term ? options.filter((option) => normalize(option.label).includes(term)) : options
  }, [options, query])

  const panelStyle = useMemo(() => {
    if (!rect) return undefined
    const below = window.innerHeight - rect.bottom
    const openUp = below < 260 && rect.top > below
    return {
      left: rect.left,
      width: Math.max(rect.width, 280),
      ...(openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      maxHeight: Math.max(160, Math.min(320, (openUp ? rect.top : below) - 16)),
    }
  }, [rect])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`por-guardar__picker${selected ? '' : ' is-empty'}`}
        onClick={() => {
          if (disabled) return
          setRect(triggerRef.current?.getBoundingClientRect() || null)
          setQuery('')
          setOpen((prev) => !prev)
        }}
        disabled={disabled}
        title={selected?.label || 'Elige la ubicacion'}
      >
        <span>{selected?.label || 'Elige la ubicacion'}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && rect && createPortal(
        <div ref={panelRef} className="por-guardar__picker-panel" style={panelStyle}>
          <div className="por-guardar__picker-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="text"
              placeholder="Buscar bodega, division o subdivision"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
          </div>
          <div className="por-guardar__picker-results">
            {!filtered.length && <p className="por-guardar__picker-empty">Sin resultados.</p>}
            {filtered.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`por-guardar__picker-option${String(option.id) === String(value) ? ' is-selected' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(option.id)
                  setOpen(false)
                }}
              >
                <span>{option.label}</span>
                {String(option.id) === String(value) && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

export default LocationPicker
