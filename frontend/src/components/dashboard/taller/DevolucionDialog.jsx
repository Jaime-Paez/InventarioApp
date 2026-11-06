import { useEffect, useState } from 'react'
import { API_URL, authFetch } from '../../../utils/api'
import BlockerNotice from '../common/BlockerNotice'
import TallerDialog from './TallerDialog'
import { parseApiError } from './tallerConstants'

// El administrador verifica que el repuesto volvio del taller y lo guarda.
// La ubicacion la ELIGE el: se recomienda la principal (donde ya esta ese
// producto), pero no se marca sola.
function DevolucionDialog({ open, orden, prueba, token, onClose, onDone, notify }) {
  const [ubicaciones, setUbicaciones] = useState([])
  const [subdivision, setSubdivision] = useState('')
  const [cantidad, setCantidad] = useState('1')
  const [devueltoPor, setDevueltoPor] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !prueba || !orden) return undefined
    setSubdivision('')
    setCantidad(String(prueba.en_taller))
    setDevueltoPor(orden.tecnico || '')
    setError('')
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const response = await authFetch(`${API_URL}/taller/ordenes/${orden.id}/ubicaciones/?productos=${prueba.producto}`, {}, token)
        if (!response.ok) throw new Error(await parseApiError(response, 'No se pudieron cargar las ubicaciones.'))
        const data = await response.json()
        if (!cancelled) setUbicaciones(data?.[String(prueba.producto)] || [])
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, orden, prueba, token])

  const recomendada = ubicaciones.find((u) => u.principal)
  const max = Number(prueba?.en_taller || 0)
  const qty = parseInt(cantidad, 10)
  const motivo = !subdivision
    ? 'Elige dónde se guardó.'
    : !Number.isFinite(qty) || qty < 1 || qty > max
      ? `La cantidad debe estar entre 1 y ${max}.`
      : ''

  const submit = async () => {
    if (motivo) return
    setBusy(true)
    setError('')
    try {
      const response = await authFetch(
        `${API_URL}/taller/ordenes/${orden.id}/devoluciones/`,
        {
          method: 'POST',
          body: JSON.stringify({ prueba: prueba.id, cantidad: qty, subdivision_id: subdivision, devuelto_por: devueltoPor.trim() }),
        },
        token
      )
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo registrar la devolución.'))
      const data = await response.json()
      notify?.({ severity: 'success', detail: `${prueba.producto_codigo} x${qty} volvió a bodega.` })
      onDone?.(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <TallerDialog
      open={open}
      busy={busy}
      title="Recibir devolución del taller"
      subtitle={prueba ? `${prueba.producto_codigo} · ${prueba.producto_nombre} · en taller: ${prueba.en_taller}` : ''}
      onClose={onClose}
      footer={
        <>
          {motivo && <span className="taller-muted taller-dialog__why">{motivo}</span>}
          <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="create-user__action create-user__action--primary" onClick={submit} disabled={busy || Boolean(motivo)}>
            {busy ? 'Guardando...' : 'Verificado: se guardó'}
          </button>
        </>
      }
    >
      <div className="taller-dialog__grid">
        <label className="create-user__field">
          <span>Cantidad que volvió</span>
          <input className="taller-input taller-input--qty" type="number" min={1} max={max} value={cantidad} onChange={(event) => setCantidad(event.target.value)} />
        </label>
        <label className="create-user__field">
          <span>Quién la devolvió (opcional)</span>
          <input className="taller-input" value={devueltoPor} onChange={(event) => setDevueltoPor(event.target.value)} />
        </label>
      </div>
      <div className="create-user__field">
        <span>¿Dónde se guardó?</span>
        {loading && <span className="taller-muted"><i className="pi pi-spin pi-spinner" /> Cargando ubicaciones...</span>}
        {!loading && (
          <div className="taller-ubicaciones">
            {ubicaciones.map((u) => (
              <label key={u.subdivision_id} className={`taller-ubicacion${String(subdivision) === String(u.subdivision_id) ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name="ubicacion-devolucion"
                  checked={String(subdivision) === String(u.subdivision_id)}
                  onChange={() => setSubdivision(String(u.subdivision_id))}
                />
                <span className="taller-ubicacion__name">{u.ubicacion}</span>
                {u.principal && <span className="taller-chip taller-chip--orden">Recomendada: principal</span>}
                {!u.por_ubicar && <span className="taller-muted">{`Hay ${u.cantidad}`}</span>}
              </label>
            ))}
          </div>
        )}
        {!loading && recomendada && !subdivision && (
          <button type="button" className="taller-link" onClick={() => setSubdivision(String(recomendada.subdivision_id))}>
            {`Usar la recomendada (${recomendada.ubicacion})`}
          </button>
        )}
      </div>
      {error && <BlockerNotice title="No se registró la devolución" reason={error} />}
    </TallerDialog>
  )
}

export default DevolucionDialog
