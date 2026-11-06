import { formatDateTime } from '../../../utils/dateFormat'

// Historial: entregas con firma, devoluciones y eventos de la orden.
function OrdenHistorial({ orden }) {
  const entregas = orden.entregas || []
  const devoluciones = orden.devoluciones || []
  const eventos = orden.eventos || []
  return (
    <>
      <section className="create-user__section">
        <div className="create-user__section-header">
          <div>
            <p className="create-user__eyebrow">Despachos</p>
            <h4>{`Entregas al taller (${entregas.length})`}</h4>
          </div>
        </div>
        {!entregas.length ? (
          <p className="taller-muted">Todavía no se entregó nada al taller.</p>
        ) : (
          <div className="taller-entregas">
            {entregas.map((entrega) => (
              <div key={entrega.id} className="taller-entrega">
                <div className="taller-entrega__info">
                  <div className="taller-entrega__head">
                    <strong>{formatDateTime(entrega.creado_en)}</strong>
                    <span className={`taller-chip taller-chip--${entrega.tipo === 'prueba' ? 'prueba' : 'orden'}`}>{entrega.tipo_label}</span>
                  </div>
                  <div className="taller-muted">
                    {`Despachó ${entrega.entregado_por_nombre || '-'} · Recibió ${entrega.recibido_por}${entrega.recibido_rol ? ` (${entrega.recibido_rol})` : ''}`}
                  </div>
                  <ul className="taller-entrega__items">
                    {entrega.items.map((item) => (
                      <li key={item.id}>
                        <strong>{item.producto_codigo}</strong>
                        {` x${item.cantidad}`}
                        {item.a_prueba && ' (a prueba)'}
                        {item.sucursal_nombre && item.sucursal !== orden.sucursal && <span className="taller-chip taller-chip--pendiente">{`desde ${item.sucursal_nombre}`}</span>}
                        {Array.isArray(item.ubicaciones) && item.ubicaciones.length > 0 && (
                          <span className="taller-muted">{` · de ${item.ubicaciones.map((u) => `${u.ubicacion} (${u.cantidad})`).join(', ')}`}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {entrega.nota && <p className="taller-muted">{entrega.nota}</p>}
                </div>
                <img className="taller-entrega__firma" src={entrega.firma} alt={`Firma de ${entrega.recibido_por}`} />
              </div>
            ))}
          </div>
        )}
      </section>

      {devoluciones.length > 0 && (
        <section className="create-user__section">
          <div className="create-user__section-header">
            <div>
              <p className="create-user__eyebrow">Retornos</p>
              <h4>{`Devoluciones a bodega (${devoluciones.length})`}</h4>
            </div>
          </div>
          <ol className="taller-history">
            {devoluciones.map((dev) => (
              <li key={dev.id}>
                <span className="taller-history__when">{formatDateTime(dev.creado_en)}</span>
                <span className="taller-history__who">{dev.recibido_por_nombre || '-'}</span>
                <span className="taller-history__what">
                  {`${dev.producto_codigo} x${dev.cantidad} guardado en ${dev.ubicacion}${dev.devuelto_por ? ` (lo trajo ${dev.devuelto_por})` : ''}`}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="create-user__section">
        <div className="create-user__section-header">
          <div>
            <p className="create-user__eyebrow">Todo</p>
            <h4>Historial de la orden</h4>
          </div>
        </div>
        {!eventos.length ? (
          <p className="taller-muted">Sin movimientos todavía.</p>
        ) : (
          <ol className="taller-history">
            {eventos.map((evento) => (
              <li key={evento.id}>
                <span className="taller-history__when">{formatDateTime(evento.creado_en)}</span>
                <span className="taller-history__who">{evento.usuario_nombre || 'Sistema'}</span>
                <span className="taller-history__what">{evento.descripcion}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  )
}

export default OrdenHistorial
