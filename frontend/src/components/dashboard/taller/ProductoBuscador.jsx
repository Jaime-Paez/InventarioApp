import { useEffect, useRef, useState } from 'react'
import { API_URL, authFetch } from '../../../utils/api'
import { formatMoney, parseApiError } from './tallerConstants'

// Buscador de repuestos del inventario (codigo, nombre, referencia u OEM) con
// stock de la sucursal de la orden y PVP. onPick(producto) al elegir uno.
function ProductoBuscador({ token, sucursalId, onPick, disabled, inputRef, placeholder, emptyAction }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const seq = useRef(0)

  useEffect(() => {
    const term = query.trim()
    if (!term) {
      setResults([])
      setSearching(false)
      setError('')
      return undefined
    }
    const current = ++seq.current
    setSearching(true)
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
        if (current !== seq.current) return
        setResults([])
        setError(err.message || 'No se pudo buscar.')
      } finally {
        if (current === seq.current) setSearching(false)
      }
    }, 280)
    return () => clearTimeout(timer)
  }, [query, sucursalId, token])

  const pick = async (producto) => {
    const ok = await onPick(producto)
    if (ok !== false) {
      setQuery('')
      setResults([])
      inputRef?.current?.focus()
    }
  }

  return (
    <div className="taller-add__search">
      <input
        ref={inputRef}
        className="taller-input"
        placeholder={placeholder || 'Buscar repuesto por código, nombre, referencia u OEM'}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && results.length) {
            event.preventDefault()
            pick(results[0])
          }
          if (event.key === 'Escape') setQuery('')
        }}
        disabled={disabled}
      />
      {query.trim() && (
        <div className="taller-add__results" role="listbox">
          {searching && <div className="taller-add__result taller-add__result--info"><i className="pi pi-spin pi-spinner" /> Buscando...</div>}
          {!searching && error && <div className="taller-add__result taller-add__result--error">{error}</div>}
          {!searching && !error && !results.length && (
            <div className="taller-add__result taller-add__result--info">
              {`No hay repuestos con "${query.trim()}".`}
              {emptyAction && (
                <button type="button" className="taller-link" onClick={() => { emptyAction.run(query.trim()); setQuery('') }}>
                  {emptyAction.label}
                </button>
              )}
            </div>
          )}
          {!searching && results.map((producto) => (
            <button key={producto.id} type="button" className="taller-add__result" onClick={() => pick(producto)} disabled={disabled}>
              <strong>{producto.codigo}</strong>
              <span className="taller-add__result-name">{producto.nombre}</span>
              <span className={`taller-add__stock${producto.stock > 0 ? '' : ' is-empty'}`}>{`Stock ${producto.stock}`}</span>
              <span className="taller-add__pvp">{producto.precio != null ? formatMoney(producto.precio) : 'Sin PVP'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default ProductoBuscador
