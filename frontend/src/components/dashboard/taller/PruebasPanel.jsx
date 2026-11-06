import { useState } from 'react'
import { ArrowLeft, Trash2, Undo2 } from 'lucide-react'
import TallerProductDropdown from './TallerProductDropdown'

// Tabla secundaria de la orden: repuestos en el taller que NO son parte de la
// orden. Los "a prueba" pueden pasar a la orden; lo que no entra (y lo que el
// administrador quito de la orden) tiene que volver a bodega, verificado.
function PruebasPanel({ orden, token, isAdmin, canEdit, busy, onAdd, onCancel, onPasar, onDevolver }) {
  const [cantidad, setCantidad] = useState('1')
  const [producto, setProducto] = useState(null)
  const pruebas = orden?.pruebas || []
  const abierta = orden?.estado === 'orden'
  const visibles = pruebas.filter((p) => p.pendiente_entrega > 0 || p.en_taller > 0 || p.cantidad_usada > 0 || p.cantidad_devuelta > 0)
  const enTaller = pruebas.reduce((acc, p) => acc + p.en_taller, 0)
  const qty = parseInt(cantidad, 10)

  const add = async () => {
    if (!producto || !Number.isFinite(qty) || qty < 1) return
    try {
      await onAdd({ producto: producto.id, cantidad: qty })
      setCantidad('1')
      setProducto(null)
    } catch {
      // el error ya se mostro
    }
  }

  return (
    <section className="create-user__section taller-pruebas">
      <div className="create-user__section-header">
        <div>
          <p className="create-user__eyebrow">Fuera de la orden</p>
          <h4>Repuestos a prueba / por devolver</h4>
        </div>
        {enTaller > 0 && <span className="taller-chip taller-chip--pendiente">{`${enTaller} en taller`}</span>}
      </div>

      {abierta && canEdit && (
        <div className="create-user__locations-table taller-pruebas__form">
          <div className="create-user__locations-row create-user__locations-row--head">
            <span>Pedir a prueba</span>
            <span>Cant.</span>
            <span>Acción</span>
          </div>
          <div className="create-user__locations-row create-user__locations-row--form">
            <span>
              <TallerProductDropdown token={token} sucursalId={orden?.sucursal} value={producto} onSelect={setProducto} disabled={busy} placeholder="Repuesto para probar" />
            </span>
            <span>
              <input type="number" min={1} value={cantidad} onChange={(event) => setCantidad(event.target.value)} disabled={busy} />
            </span>
            <span className="create-user__locations-cell create-user__locations-cell--action">
              <button type="button" className="create-user__ghost create-salida__ghost--add" onClick={add} disabled={busy || !producto || !(qty >= 1)}>
                Pedir
              </button>
            </span>
          </div>
        </div>
      )}

      {!visibles.length ? (
        <p className="taller-muted taller-pruebas__empty">
          {abierta ? 'Nada a prueba. Lo que se pida para probar aparece aquí y, si no entra a la orden, debe volver a bodega.' : 'Sin repuestos a prueba.'}
        </p>
      ) : (
        <div className="taller-pruebas__list">
          {visibles.map((prueba) => (
            <div key={prueba.id} className={`taller-prueba${prueba.en_taller > 0 ? ' is-out' : ''}`}>
              <div className="taller-prueba__head">
                <strong>{prueba.producto_codigo}</strong>
                <span className={`taller-chip taller-chip--${prueba.origen === 'prueba' ? 'prueba' : 'rechazada'}`}>{prueba.origen_label}</span>
              </div>
              <div className="taller-prueba__name">{prueba.producto_nombre}</div>
              <div className="taller-prueba__nums">
                {prueba.origen === 'prueba' && <span>{`Pedido ${prueba.cantidad_solicitada}`}</span>}
                <span>{`Entregado ${prueba.cantidad_entregada}`}</span>
                {prueba.cantidad_usada > 0 && <span>{`A la orden ${prueba.cantidad_usada}`}</span>}
                {prueba.cantidad_devuelta > 0 && <span>{`Devuelto ${prueba.cantidad_devuelta}`}</span>}
                {prueba.en_taller > 0 && <strong className="taller-prueba__out">{`En taller ${prueba.en_taller}`}</strong>}
                {prueba.pendiente_entrega > 0 && <span className="taller-chip taller-chip--pendiente">{`Por entregar ${prueba.pendiente_entrega}`}</span>}
              </div>
              {abierta && (
                <div className="taller-prueba__actions">
                  {prueba.origen === 'prueba' && prueba.en_taller > 0 && canEdit && (
                    <button type="button" className="taller-mini-btn taller-mini-btn--ok" onClick={() => onPasar(prueba)} disabled={busy}>
                      <ArrowLeft size={13} /> Pasar a la orden
                    </button>
                  )}
                  {prueba.en_taller > 0 && isAdmin && (
                    <button type="button" className="taller-mini-btn" onClick={() => onDevolver(prueba)} disabled={busy}>
                      <Undo2 size={13} /> Recibir devolución
                    </button>
                  )}
                  {prueba.pendiente_entrega > 0 && canEdit && (
                    <button type="button" className="taller-mini-btn taller-mini-btn--no" onClick={() => onCancel(prueba)} disabled={busy}>
                      <Trash2 size={13} /> {prueba.cantidad_entregada ? 'Cancelar lo no entregado' : 'Cancelar'}
                    </button>
                  )}
                </div>
              )}
              {abierta && prueba.en_taller > 0 && !isAdmin && (
                <small className="taller-muted">Debe volver a bodega: el administrador verifica la devolución.</small>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export default PruebasPanel
