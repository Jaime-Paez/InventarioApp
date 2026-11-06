import { useEffect, useRef, useState } from 'react'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDate } from '../../../utils/dateFormat'
import BlockerNotice from '../common/BlockerNotice'
import TallerDialog from './TallerDialog'
import { formatOrdenNumero, parseApiError } from './tallerConstants'

// Nueva orden por garantia: se busca la orden anterior (cerrada) por placa,
// factura, cliente o encargado, y la nueva queda vinculada a ella.
function GarantiaDialog({ open, token, onClose, onCreated }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const seq = useRef(0)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
    setError('')
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const term = query.trim()
    if (!term) {
      setResults([])
      return undefined
    }
    const current = ++seq.current
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const response = await authFetch(`${API_URL}/taller/ordenes/buscar-garantia/?q=${encodeURIComponent(term)}`, {}, token)
        if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo buscar.'))
        const data = await response.json()
        if (current === seq.current) {
          setResults(Array.isArray(data) ? data : [])
          setError('')
        }
      } catch (err) {
        if (current === seq.current) setError(err.message)
      } finally {
        if (current === seq.current) setLoading(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [open, query, token])

  const crear = async (orden) => {
    setBusy(true)
    setError('')
    try {
      const response = await authFetch(`${API_URL}/taller/ordenes/`, { method: 'POST', body: JSON.stringify({ garantia_de: orden.id }) }, token)
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo crear la orden por garantía.'))
      const data = await response.json()
      onCreated?.(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <TallerDialog
      open={open}
      wide
      busy={busy}
      title="Nueva orden por garantía"
      subtitle="Busca la orden anterior por placa, número de factura, cliente o encargado."
      onClose={onClose}
    >
      <div className="search-input-container taller-dialog__search">
        <input
          autoFocus
          type="text"
          className="search-input"
          placeholder="Placa, factura, cliente, técnico, asesor o N° de orden"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <i className={`pi ${loading ? 'pi-spinner pi-spin' : 'pi-search'} search-input-icon`} />
      </div>
      {query.trim() && !loading && !results.length && !error && (
        <BlockerNotice
          title="No hay órdenes cerradas que coincidan"
          reason="La garantía se hace sobre una orden ya cerrada. Revisa la placa o la factura."
        />
      )}
      <div className="taller-garantia-results">
        {results.map((orden) => (
          <div key={orden.id} className="taller-garantia-card">
            <div className="taller-garantia-card__head">
              <strong>{`Orden ${formatOrdenNumero(orden.numero)}`}</strong>
              <span>{orden.placa || 'Sin placa'}</span>
              <span>{orden.modelo}</span>
              <span className="taller-muted">{`Cerrada ${formatDate(orden.cerrada_en)}`}</span>
              {orden.numero_factura && <span className="taller-muted">{`Factura ${orden.numero_factura}`}</span>}
            </div>
            <div className="taller-muted">
              {[orden.cliente_nombre, orden.tecnico && `Técnico: ${orden.tecnico}`, orden.asesor_nombre && `Asesor: ${orden.asesor_nombre}`]
                .filter(Boolean)
                .join(' · ')}
            </div>
            <div className="taller-garantia-card__parts">
              {orden.repuestos.length
                ? orden.repuestos.map((r) => <span key={r.linea}>{`${r.producto_codigo} x${r.cantidad}`}</span>)
                : <span className="taller-muted">Sin repuestos</span>}
            </div>
            <button type="button" className="create-user__action create-user__action--primary" onClick={() => crear(orden)} disabled={busy}>
              Crear garantía de esta orden
            </button>
          </div>
        ))}
      </div>
      {error && <BlockerNotice title="Algo falló" reason={error} />}
    </TallerDialog>
  )
}

export default GarantiaDialog
