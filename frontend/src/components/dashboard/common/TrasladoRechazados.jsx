import React from 'react'
import { AlertTriangle, PackageCheck } from 'lucide-react'
import './TrasladoRechazados.css'

const MOTIVO_TIPO_LABELS = {
  no_tengo: 'No tengo',
  vendido: 'Ya lo vendí',
  otro: 'Otro',
}

// Una nota sin letras ni numeros (".", "-", "...") no dice nada: se omite.
const notaUtil = (value) => {
  const text = String(value || '').trim()
  return /[\p{L}\p{N}]/u.test(text) ? text : ''
}

const plural = (n, singular, pluralText) => `${n} ${n === 1 ? singular : pluralText}`

// Envio parcial de un traslado: los productos que quien envia rechazo al
// aceptarlo, cada uno con su motivo, y (si se pasan) los que si vienen.
// Se muestra en la salida, la entrada, la recepcion y los recordatorios para
// que quien pidio sepa que no viene todo y por que.
// `items` = solicitud_traslado.detalles_no_enviados (codigo, nombre,
// cantidad, motivo, motivo_tipo). `enviados` = solicitud.detalles (opcional).
function TrasladoRechazados({ items, enviados, className = '' }) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  if (!list.length) return null
  const unidades = list.reduce((sum, item) => sum + (Number(item?.cantidad) || 0), 0)
  const aceptados = (Array.isArray(enviados) ? enviados : [])
    .filter((item) => item && !item.no_enviar && Number(item?.cantidad) > 0)
  const unidadesAceptadas = aceptados.reduce((sum, item) => sum + (Number(item?.cantidad) || 0), 0)

  return (
    <section className={`traslado-rechazados${className ? ` ${className}` : ''}`} aria-label="Envío parcial del traslado">
      <header className="traslado-rechazados__head">
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>Envío parcial</strong>
          <p>
            {`Quien envía rechazó ${plural(list.length, 'producto', 'productos')} (${plural(unidades, 'unidad', 'unidades')}): no ${list.length === 1 ? 'viene' : 'vienen'} en este traslado.`}
          </p>
        </div>
      </header>

      <div className="traslado-rechazados__grupo">
        <span className="traslado-rechazados__titulo traslado-rechazados__titulo--no">
          {`No vienen (${list.length})`}
        </span>
        <ul className="traslado-rechazados__list">
          {list.map((item, index) => {
            const tipo = MOTIVO_TIPO_LABELS[item?.motivo_tipo] || ''
            const nota = notaUtil(item?.motivo)
            return (
              <li key={`${item?.producto_id || 'x'}-${index}`} className="traslado-rechazados__item traslado-rechazados__item--no">
                <span className="traslado-rechazados__producto">
                  <strong>{item?.producto_codigo || '-'}</strong>
                  {item?.producto_nombre && <span>{item.producto_nombre}</span>}
                </span>
                <span className="traslado-rechazados__cantidad">{`x${Number(item?.cantidad) || 0}`}</span>
                <span className="traslado-rechazados__motivo">
                  <em>Motivo:</em>
                  {tipo && <b className="traslado-rechazados__motivo-tipo">{tipo}</b>}
                  {nota ? <span>{nota}</span> : (!tipo && <span>Sin motivo</span>)}
                </span>
              </li>
            )
          })}
        </ul>
      </div>

      {aceptados.length > 0 && (
        <div className="traslado-rechazados__grupo">
          <span className="traslado-rechazados__titulo traslado-rechazados__titulo--si">
            <PackageCheck size={15} aria-hidden="true" />
            {`Sí vienen (${aceptados.length} · ${plural(unidadesAceptadas, 'unidad', 'unidades')})`}
          </span>
          <ul className="traslado-rechazados__list">
            {aceptados.map((item, index) => (
              <li key={`${item?.id || item?.producto_id || 'y'}-${index}`} className="traslado-rechazados__item traslado-rechazados__item--si">
                <span className="traslado-rechazados__producto">
                  <strong>{item?.producto_codigo || '-'}</strong>
                  {item?.producto_nombre && <span>{item.producto_nombre}</span>}
                </span>
                <span className="traslado-rechazados__cantidad">{`x${Number(item?.cantidad) || 0}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

export default TrasladoRechazados
