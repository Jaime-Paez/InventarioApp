import { useEffect, useMemo, useState } from 'react'
import { API_URL, authFetch } from '../../../utils/api'
import BlockerNotice from '../common/BlockerNotice'
import CascadeDropdown from '../common/CascadeDropdown'
import SignaturePad from './SignaturePad'
import TallerDialog from './TallerDialog'
import { parseApiError } from './tallerConstants'

// El administrador entrega al taller lo pendiente de la orden y lo pedido a
// prueba. Cada entrega queda con fecha, hora, quien despacho, quien recibio y
// su firma. Se descuenta del inventario en ese momento.
function DespachoDialog({ open, orden, token, onClose, onDone, notify }) {
  const pendientes = useMemo(() => {
    if (!orden) return []
    const lineas = (orden.lineas || [])
      .filter((linea) => linea.tipo === 'repuesto' && linea.producto && linea.pendiente_despacho > 0)
      .map((linea) => ({
        key: `l${linea.id}`,
        linea: linea.id,
        producto: linea.producto,
        codigo: linea.producto_codigo,
        descripcion: linea.descripcion,
        pendiente: linea.pendiente_despacho,
        bloqueo: linea.precio_estado === 'pendiente' ? 'Precio por aprobar' : '',
        aPrueba: false,
      }))
    const pruebas = (orden.pruebas || [])
      .filter((prueba) => prueba.pendiente_entrega > 0)
      .map((prueba) => ({
        key: `p${prueba.id}`,
        prueba: prueba.id,
        producto: prueba.producto,
        codigo: prueba.producto_codigo,
        descripcion: prueba.producto_nombre,
        pendiente: prueba.pendiente_entrega,
        bloqueo: '',
        aPrueba: true,
      }))
    return [...lineas, ...pruebas]
  }, [orden])

  const [seleccion, setSeleccion] = useState({})
  const [ubicaciones, setUbicaciones] = useState({})
  const [receptor, setReceptor] = useState('tecnico')
  const [otroNombre, setOtroNombre] = useState('')
  const [firma, setFirma] = useState(null)
  const [nota, setNota] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const next = {}
    pendientes.forEach((item) => {
      next[item.key] = { incluir: !item.bloqueo, cantidad: String(item.pendiente), subdivision: 'auto' }
    })
    setSeleccion(next)
    setReceptor(orden?.tecnico ? 'tecnico' : 'asesor')
    setOtroNombre('')
    setFirma(null)
    setNota('')
    setError('')
    // Solo al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open || !orden?.id) return undefined
    const ids = Array.from(new Set(pendientes.map((item) => item.producto)))
    if (!ids.length) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const response = await authFetch(`${API_URL}/taller/ordenes/${orden.id}/ubicaciones/?productos=${ids.join(',')}`, {}, token)
        if (!response.ok) throw new Error(await parseApiError(response, 'No se pudieron cargar las ubicaciones.'))
        const data = await response.json()
        if (!cancelled) setUbicaciones(data || {})
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [open, orden?.id, pendientes, token])

  const update = (key, patch) => setSeleccion((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))

  const receptorNombre = receptor === 'tecnico'
    ? String(orden?.tecnico || '').trim()
    : receptor === 'asesor'
      ? String(orden?.asesor_nombre || '').trim()
      : otroNombre.trim()
  const receptorRol = receptor === 'tecnico' ? 'Técnico' : receptor === 'asesor' ? 'Asesor de servicio' : ''

  const elegidos = pendientes.filter((item) => seleccion[item.key]?.incluir && Number(seleccion[item.key]?.cantidad) > 0)
  const sinStock = elegidos.filter((item) => {
    const total = (ubicaciones[String(item.producto)] || []).reduce((acc, u) => acc + Number(u.cantidad || 0), 0)
    return Object.keys(ubicaciones).length > 0 && total < Number(seleccion[item.key]?.cantidad || 0)
  })

  const motivoBloqueo = !elegidos.length
    ? 'Marca al menos un repuesto para entregar.'
    : !receptorNombre
      ? (receptor === 'tecnico' ? 'La orden no tiene técnico: escríbelo en la orden o elige "Otra persona".' : 'Escribe quién recibe.')
      : !firma
        ? 'Falta la firma de quien recibe.'
        : sinStock.length
          ? `No hay stock suficiente de ${sinStock.map((item) => item.codigo).join(', ')}.`
          : ''

  const submit = async () => {
    if (motivoBloqueo) return
    setBusy(true)
    setError('')
    try {
      const items = elegidos.map((item) => ({
        linea: item.linea,
        prueba: item.prueba,
        cantidad: Number(seleccion[item.key].cantidad),
        subdivision_id: seleccion[item.key].subdivision === 'auto' ? null : seleccion[item.key].subdivision,
      }))
      const response = await authFetch(
        `${API_URL}/taller/ordenes/${orden.id}/entregas/`,
        {
          method: 'POST',
          body: JSON.stringify({ items, recibido_por: receptorNombre, recibido_rol: receptorRol, firma, nota: nota.trim() }),
        },
        token
      )
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo registrar la entrega.'))
      const data = await response.json()
      notify?.({ severity: 'success', detail: 'Entrega registrada: los repuestos ya están en el taller.' })
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
      wide
      busy={busy}
      title="Despachar al taller"
      subtitle="Marca lo que entregas, de qué ubicación sale y que firme quien lo recibe."
      onClose={onClose}
      footer={
        <>
          {motivoBloqueo && <span className="taller-muted taller-dialog__why">{motivoBloqueo}</span>}
          <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="create-user__action create-user__action--primary" onClick={submit} disabled={busy || Boolean(motivoBloqueo)}>
            {busy ? 'Registrando...' : 'Entregar y registrar firma'}
          </button>
        </>
      }
    >
      {!pendientes.length ? (
        <BlockerNotice title="No hay nada por despachar" reason="Todo lo de la orden y lo pedido a prueba ya se entregó." />
      ) : (
        <div className="taller-lineas__wrap">
          <table className="taller-lineas">
            <thead>
              <tr>
                <th aria-label="Entregar" />
                <th>Repuesto</th>
                <th>Pendiente</th>
                <th>Entregar</th>
                <th>Sale de</th>
              </tr>
            </thead>
            <tbody>
              {pendientes.map((item) => {
                const sel = seleccion[item.key] || {}
                const opciones = (ubicaciones[String(item.producto)] || []).filter((u) => Number(u.cantidad) > 0)
                const total = opciones.reduce((acc, u) => acc + Number(u.cantidad || 0), 0)
                return (
                  <tr key={item.key} className={item.bloqueo ? 'is-pending' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={Boolean(sel.incluir)}
                        disabled={Boolean(item.bloqueo) || busy}
                        onChange={(event) => update(item.key, { incluir: event.target.checked })}
                        aria-label={`Entregar ${item.codigo}`}
                      />
                    </td>
                    <td>
                      <strong>{item.codigo}</strong> {item.descripcion}
                      {item.aPrueba && <span className="taller-chip taller-chip--prueba">A prueba</span>}
                      {item.bloqueo && <span className="taller-chip taller-chip--pendiente">{item.bloqueo}</span>}
                    </td>
                    <td>{item.pendiente}</td>
                    <td>
                      <input
                        className="taller-input taller-input--qty"
                        type="number"
                        min={1}
                        max={item.pendiente}
                        value={sel.cantidad ?? ''}
                        disabled={!sel.incluir || busy}
                        onChange={(event) => {
                          const value = Math.min(item.pendiente, Math.max(0, parseInt(event.target.value, 10) || 0))
                          update(item.key, { cantidad: String(value) })
                        }}
                      />
                    </td>
                    <td>
                      <CascadeDropdown
                        placeholder="Ubicación"
                        searchPlaceholder="Buscar ubicación"
                        options={[
                          { id: 'auto', etiqueta: `Automático: principal primero (stock ${total})` },
                          ...opciones.map((u) => ({ id: u.subdivision_id, etiqueta: `${u.ubicacion} · ${u.cantidad}${u.principal ? ' (principal)' : ''}` })),
                        ]}
                        valueId={sel.subdivision ?? 'auto'}
                        getOptionLabel={(o) => o.etiqueta}
                        onSelect={(o) => update(item.key, { subdivision: o.id })}
                        disabled={!sel.incluir || busy}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="taller-dialog__grid">
        <div className="create-user__field">
          <span>Recibe</span>
          <div className="taller-radio-group">
            <label>
              <input type="radio" name="receptor" checked={receptor === 'tecnico'} onChange={() => setReceptor('tecnico')} />
              {`Técnico${orden?.tecnico ? `: ${orden.tecnico}` : ' (sin asignar)'}`}
            </label>
            <label>
              <input type="radio" name="receptor" checked={receptor === 'asesor'} onChange={() => setReceptor('asesor')} />
              {`Asesor${orden?.asesor_nombre ? `: ${orden.asesor_nombre}` : ''}`}
            </label>
            <label>
              <input type="radio" name="receptor" checked={receptor === 'otro'} onChange={() => setReceptor('otro')} />
              Otra persona
            </label>
          </div>
          {receptor === 'otro' && (
            <input className="taller-input" placeholder="Nombre de quien recibe" value={otroNombre} onChange={(event) => setOtroNombre(event.target.value)} />
          )}
          <label className="create-user__field">
            <span>Nota (opcional)</span>
            <textarea rows={2} value={nota} onChange={(event) => setNota(event.target.value)} />
          </label>
        </div>
        <div className="create-user__field">
          <span>{`Firma de ${receptorNombre || 'quien recibe'}`}</span>
          <SignaturePad onChange={setFirma} disabled={busy} />
        </div>
      </div>
      {error && <BlockerNotice title="No se registró la entrega" reason={error} />}
    </TallerDialog>
  )
}

export default DespachoDialog
