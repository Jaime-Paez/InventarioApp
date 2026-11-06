import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { API_URL, authFetch } from '../../../utils/api'
import { getAppPortalRoot } from '../../../utils/portalRoot'
import { useCloseDropdownsOnTabSwitch } from '../../../hooks/useCloseDropdownsOnTabSwitch'
import '../admin/CreateUsuario/CreateUsuario.css'
import '../movimientos/CreateSalida.css'
import { formatMoney, parseApiError } from './tallerConstants'

const SEARCH_DELAY_MS = 260
const VIEWPORT_PADDING = 12

// Selector de repuesto igual al de Salidas: boton con el producto elegido y
// panel flotante con busqueda (debounce) en el servidor. Muestra el stock de
// la sucursal de la orden y el PVP.
function TallerProductDropdown({ token, sucursalId, value, onSelect, disabled, placeholder = 'Selecciona un repuesto', addedIds }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [style, setStyle] = useState(null)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const seq = useRef(0)

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  useCloseDropdownsOnTabSwitch(close)

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING
    const spaceAbove = rect.top - VIEWPORT_PADDING
    const upward = spaceBelow < 260 && spaceAbove > spaceBelow
    const maxHeight = Math.max(160, Math.min(360, upward ? spaceAbove : spaceBelow))
    const width = Math.min(620, window.innerWidth - 32)
    setStyle({
      left: Math.min(Math.max(rect.left, 16), window.innerWidth - width - 16),
      width,
      maxWidth: width,
      maxHeight,
      ...(upward ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) return undefined
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, place])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (triggerRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) return
      close()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open, close])

  useEffect(() => {
    if (!open) return undefined
    const term = query.trim()
    if (!term) {
      setResults([])
      setLoading(false)
      setError('')
      return undefined
    }
    const current = ++seq.current
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: term })
        if (sucursalId) params.set('sucursal', String(sucursalId))
        const response = await authFetch(`${API_URL}/taller/ordenes/buscar-productos/?${params}`, {}, token)
        if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo buscar.'))
        const data = await response.json()
        if (current !== seq.current) return
        setResults(Array.isArray(data) ? data : [])
        setError('')
      } catch (err) {
        if (current === seq.current) {
          setResults([])
          setError(err.message)
        }
      } finally {
        if (current === seq.current) setLoading(false)
      }
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [open, query, sucursalId, token])

  const label = value ? `${value.codigo} · ${value.nombre}` : placeholder

  return (
    <div className="create-user__dropdown create-salida__product-dropdown taller-product-dropdown">
      <button
        type="button"
        ref={triggerRef}
        className="create-user__dropdown-trigger"
        disabled={disabled}
        title={value ? label : undefined}
        onClick={() => {
          if (disabled) return
          if (open) {
            close()
            return
          }
          setResults([])
          setOpen(true)
        }}
      >
        <span>{label}</span>
        <i className={`pi pi-chevron-${open ? 'up' : 'down'}`} />
      </button>

      {open && style && createPortal(
        <div ref={panelRef} className="create-user__dropdown-panel create-salida__product-panel taller-product-panel" style={style}>
          <div className="create-user__dropdown-search">
            <i className="pi pi-search" />
            <input
              type="text"
              placeholder="Buscar por código, descripción, referencia u OEM"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') close()
                if (event.key === 'Enter' && results.length) {
                  event.preventDefault()
                  onSelect(results[0])
                  close()
                }
              }}
              autoFocus
              autoComplete="off"
            />
          </div>
          <div className="create-user__dropdown-results" style={{ maxHeight: Math.max(Number(style.maxHeight || 260) - 64, 96) }}>
            {!query.trim() && <small className="muted">Escribe para buscar repuestos.</small>}
            {loading && <small className="muted">Buscando productos...</small>}
            {!loading && error && <small className="muted">{error}</small>}
            {!loading && !error && query.trim() && !results.length && <small className="muted">Sin resultados.</small>}
            {results.length > 0 && (
              <div className="create-salida__results-header">
                <span>Código</span>
                <span>Descripción</span>
                <span>Stock taller</span>
                <span>Otras suc.</span>
                <span>PVP</span>
              </div>
            )}
            {results.map((producto) => {
              const added = addedIds?.has?.(String(producto.id))
              return (
                <button
                  key={producto.id}
                  type="button"
                  className={`create-salida__result-row${added ? ' is-added' : ''}${producto.stock > 0 ? '' : ' taller-result--sin-stock'}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onSelect(producto)
                    close()
                  }}
                  title={
                    producto.stock > 0
                      ? undefined
                      : producto.stock_otras > 0
                        ? `No hay en la sucursal del taller; hay en ${(producto.otras_sucursales || []).map((o) => `${o.sucursal} (${o.cantidad})`).join(', ')}: se despacha desde allá`
                        : 'Sin stock en ninguna sucursal: se puede cotizar, pero no despachar hasta que llegue'
                  }
                >
                  <span className="result-codigo">
                    {producto.codigo}
                    {added && <span className="create-salida__result-added-badge">ya en la orden</span>}
                  </span>
                  <span className="result-nombre">{producto.nombre || '-'}</span>
                  <span className="result-stock">{producto.stock}</span>
                  <span className={`result-otras${producto.stock_otras > 0 ? ' has-stock' : ''}`}>{producto.stock_otras || 0}</span>
                  <span className="result-stock">{producto.precio != null ? formatMoney(producto.precio) : 'Sin PVP'}</span>
                </button>
              )
            })}
          </div>
        </div>,
        getAppPortalRoot()
      )}
    </div>
  )
}

export default TallerProductDropdown
