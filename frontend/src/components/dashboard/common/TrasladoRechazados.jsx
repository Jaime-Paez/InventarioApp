import React from 'react'
import { AlertTriangle } from 'lucide-react'
import './TrasladoRechazados.css'

// Envio parcial de un traslado: los productos que quien envia rechazo al
// aceptarlo, cada uno con su motivo. Se muestra en la salida, la entrada y la
// recepcion para que quien pidio sepa que no viene todo y por que.
// `items` = solicitud_traslado.detalles_no_enviados (codigo, nombre,
// cantidad, motivo).
function TrasladoRechazados({ items, className = '' }) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  if (!list.length) return null
  const unidades = list.reduce((sum, item) => sum + (Number(item?.cantidad) || 0), 0)
  return (
    <section className={`traslado-rechazados${className ? ` ${className}` : ''}`} aria-label="Productos rechazados del traslado">
      <header className="traslado-rechazados__head">
        <AlertTriangle size={17} aria-hidden="true" />
        <div>
          <strong>Envío parcial</strong>
          <p>
            Quien envía rechazó {list.length} producto{list.length !== 1 ? 's' : ''} ({unidades} unidad{unidades !== 1 ? 'es' : ''}): no vienen en este traslado.
          </p>
        </div>
      </header>
      <ul className="traslado-rechazados__list">
        {list.map((item, index) => (
          <li key={`${item?.producto_id || 'x'}-${index}`}>
            <span className="traslado-rechazados__producto">
              <strong>{item?.producto_codigo || '-'}</strong>
              {item?.producto_nombre && <span>{item.producto_nombre}</span>}
            </span>
            <span className="traslado-rechazados__cantidad">x{Number(item?.cantidad) || 0}</span>
            <span className="traslado-rechazados__motivo">{item?.motivo || 'Sin motivo'}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default TrasladoRechazados
