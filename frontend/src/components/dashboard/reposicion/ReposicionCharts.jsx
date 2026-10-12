import { useMemo, useRef, useState } from 'react'

// Graficas de reposicion en SVG (sin librerias), al estilo del documento:
// la proyeccion "dientes de sierra" del stock con el punto de pedido / nivel
// base, el stock de seguridad y los pedidos con su tiempo de entrega L.

const num = (value, digits = 0) => Number(value || 0).toLocaleString('es-EC', {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
})

const addDays = (isoDate, days) => {
  const base = isoDate ? new Date(`${isoDate}T12:00:00`) : new Date()
  base.setDate(base.getDate() + days)
  return base
}

const shortDate = (date) => date.toLocaleDateString('es-EC', { day: '2-digit', month: 'short' })

// Tope "redondo" del eje sin desperdiciar media grafica (50 -> 60, no 100).
const niceMax = (value) => {
  if (value <= 4) return 4
  const exponent = 10 ** Math.floor(Math.log10(value))
  const fraction = value / exponent
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((candidate) => fraction <= candidate) || 10
  return Math.round(step * exponent * 100) / 100
}

// Proyeccion con la demanda esperada (mu por dia), aplicando la politica.
function simulateInventory(row) {
  const mu = Number(row?.venta_dia || 0)
  const politica = row?.politica
  if (!(mu > 0) || (politica !== 'continua' && politica !== 'periodica')) return null
  const L = Math.max(0, Math.round(Number(row.dias_entrega || 0)))
  const Q = Math.max(1, Number(row.cantidad_pedido || 1))
  const R = Number(row.punto_pedido || 0)
  const B = Number(row.nivel_base || 0)
  const r = Math.max(1, Number(row.revision_dias || 7))
  const cycle = politica === 'continua' ? Q / mu : r
  const horizon = Math.min(240, Math.max(21, Math.ceil(L + cycle * 3 + 4)))

  let onHand = Number(row.stock || 0)
  let position = onHand + Number(row.en_camino || 0)
  const arrivals = new Map()
  if (Number(row.en_camino || 0) > 0) arrivals.set(Math.max(1, L), Number(row.en_camino))
  const points = []
  const orders = []

  for (let day = 0; day <= horizon; day += 1) {
    if (arrivals.has(day)) {
      points.push({ day, value: Math.max(0, onHand) })
      onHand += arrivals.get(day)
    }
    let ordered = 0
    if (politica === 'continua' && position <= R) {
      ordered = Q * Math.ceil((R - position + 1) / Q)
    } else if (politica === 'periodica' && day % r === 0) {
      ordered = Math.max(0, Math.ceil(B - position))
    }
    if (ordered > 0) {
      orders.push({ day, qty: ordered, arrival: day + L })
      arrivals.set(day + L, (arrivals.get(day + L) || 0) + ordered)
      position += ordered
    }
    points.push({ day, value: Math.max(0, onHand) })
    onHand -= mu
    position -= mu
  }
  return { points, orders, horizon }
}

export function InventoryProjectionChart({ row, today }) {
  const wrapRef = useRef(null)
  const [hover, setHover] = useState(null)
  const sim = useMemo(() => simulateInventory(row), [row])
  if (!sim) {
    return (
      <p className="repo-chart__empty">
        {row?.politica === 'bajo_pedido'
          ? 'Demanda esporádica: no se proyecta reposición (bajo pedido).'
          : 'Sin venta en la ventana: no hay reposición que proyectar.'}
      </p>
    )
  }

  const width = 760
  const height = 300
  const pad = { top: 16, right: 132, bottom: 54, left: 44 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const isContinuous = row.politica === 'continua'
  const reference = isContinuous ? Number(row.punto_pedido || 0) : Number(row.nivel_maximo || 0)
  const safety = Number(row.stock_seguridad || 0)
  const yMax = niceMax(Math.max(...sim.points.map((point) => point.value), reference, safety, 1) * 1.05)
  const x = (day) => pad.left + (day / sim.horizon) * plotW
  const y = (value) => pad.top + plotH - (value / yMax) * plotH
  const path = sim.points.map((point, index) => `${index ? 'L' : 'M'}${x(point.day).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')
  const area = `${path} L${x(sim.horizon).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`
  const yTicks = [0, yMax / 2, yMax]
  // Etiquetas de R y seguridad: si quedan muy juntas, se separan.
  let refLabelY = y(reference) + 4
  let safetyLabelY = y(safety) + 4
  if (reference > 0 && safety > 0 && Math.abs(safetyLabelY - refLabelY) < 14) {
    const middle = (refLabelY + safetyLabelY) / 2
    refLabelY = middle - 7
    safetyLabelY = middle + 7
  }
  const xTicks = Array.from({ length: 5 }, (_, index) => Math.round((sim.horizon * index) / 4))

  const handleMove = (event) => {
    const box = wrapRef.current?.getBoundingClientRect()
    if (!box) return
    const ratio = (event.clientX - box.left) / box.width
    const svgX = ratio * width
    const day = Math.round(((svgX - pad.left) / plotW) * sim.horizon)
    if (day < 0 || day > sim.horizon) { setHover(null); return }
    const atDay = sim.points.filter((point) => point.day === day)
    const value = atDay.length ? atDay[atDay.length - 1].value : 0
    setHover({ day, value, order: sim.orders.find((order) => order.day === day), arrival: sim.orders.find((order) => order.arrival === day), left: ratio * 100 })
  }

  return (
    <div className="repo-chart">
      <div className="repo-chart__legend">
        <span><i className="repo-chart__key is-stock" />Stock esperado</span>
        <span><i className="repo-chart__key is-order" />Pedido (llega después de L días)</span>
      </div>
      <div className="repo-chart__frame" ref={wrapRef} onMouseMove={handleMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Proyección del stock de ${row.codigo}`}>
          {yTicks.map((tick) => (
            <g key={`y-${tick}`}>
              <line className="repo-chart__grid" x1={pad.left} x2={pad.left + plotW} y1={y(tick)} y2={y(tick)} />
              <text className="repo-chart__tick" x={pad.left - 8} y={y(tick) + 4} textAnchor="end">{num(tick)}</text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <text key={`x-${tick}`} className="repo-chart__tick" x={x(tick)} y={pad.top + plotH + 16} textAnchor="middle">
              {tick === 0 ? 'Hoy' : shortDate(addDays(today, tick))}
            </text>
          ))}

          <path className="repo-chart__area" d={area} />

          {/* Referencias: punto de pedido (o maximo esperado) y seguridad */}
          {reference > 0 && (
            <g>
              <line className="repo-chart__ref" x1={pad.left} x2={pad.left + plotW} y1={y(reference)} y2={y(reference)} />
              <text className="repo-chart__ref-label" x={pad.left + plotW + 8} y={refLabelY}>
                {isContinuous ? `R = ${num(reference)}` : `Máximo = ${num(reference)}`}
              </text>
            </g>
          )}
          {safety > 0 && (
            <g>
              <line className="repo-chart__ref is-safety" x1={pad.left} x2={pad.left + plotW} y1={y(safety)} y2={y(safety)} />
              <text className="repo-chart__ref-label" x={pad.left + plotW + 8} y={safetyLabelY}>{`Seguridad = ${num(safety)}`}</text>
            </g>
          )}

          <path className="repo-chart__line" d={path} />

          {/* Pedidos: punto donde se pide y su tiempo de entrega L abajo */}
          {sim.orders.slice(0, 6).map((order, index) => {
            const orderValue = (sim.points.find((point) => point.day === order.day) || {}).value || 0
            const bracketY = pad.top + plotH + 30
            return (
              <g key={`order-${order.day}-${index}`}>
                <circle className="repo-chart__order" cx={x(order.day)} cy={y(orderValue)} r={5} />
                {order.arrival <= sim.horizon && order.arrival > order.day && (
                  <g className="repo-chart__bracket">
                    <line x1={x(order.day)} x2={x(order.arrival)} y1={bracketY} y2={bracketY} />
                    <line x1={x(order.day)} x2={x(order.day)} y1={bracketY - 4} y2={bracketY + 4} />
                    <line x1={x(order.arrival)} x2={x(order.arrival)} y1={bracketY - 4} y2={bracketY + 4} />
                    {x(order.arrival) - x(order.day) > 10 && (
                      <text x={(x(order.day) + x(order.arrival)) / 2} y={bracketY - 6} textAnchor="middle">L</text>
                    )}
                  </g>
                )}
              </g>
            )
          })}

          {hover && (
            <line className="repo-chart__crosshair" x1={x(hover.day)} x2={x(hover.day)} y1={pad.top} y2={pad.top + plotH} />
          )}
        </svg>
        {hover && (
          <div className="repo-chart__tooltip" style={{ left: `${hover.left}%` }}>
            <strong>{`${num(hover.value)} en stock`}</strong>
            <span>{hover.day === 0 ? 'Hoy' : `${shortDate(addDays(today, hover.day))} · en ${hover.day} d`}</span>
            {hover.order && <span className="repo-chart__tooltip-row"><i className="repo-chart__key is-order" />{`Pedir ${num(hover.order.qty)}`}</span>}
            {hover.arrival && <span className="repo-chart__tooltip-row"><i className="repo-chart__key is-stock" />{`Llegan ${num(hover.arrival.qty)}`}</span>}
          </div>
        )}
      </div>
      <p className="repo-chart__caption">
        {isContinuous
          ? `Revisión continua: cuando el stock más lo que viene en camino baja de R (${num(row.punto_pedido)}) se piden ${num(row.cantidad_pedido)}; mientras llega (L = ${num(row.dias_entrega, 0)} d) se consume el stock de seguridad. Proyección con la venta promedio de ${num(row.venta_dia, 2)}/día.`
          : `Revisión periódica: cada ${row.revision_dias} días se pide hasta el nivel base B (${num(row.nivel_base)}); llega después de L = ${num(row.dias_entrega, 0)} d. Proyección con la venta promedio de ${num(row.venta_dia, 2)}/día.`}
      </p>
    </div>
  )
}

export function WeeklySalesChart({ weeks, row }) {
  const [hover, setHover] = useState(null)
  const data = Array.isArray(weeks) ? weeks : []
  if (!data.length || !data.some((week) => week.cantidad > 0)) {
    return <p className="repo-chart__empty">Sin ventas en la ventana para esta sucursal.</p>
  }
  const width = 760
  const height = 240
  const pad = { top: 14, right: 130, bottom: 34, left: 44 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const weekly = Number(row?.venta_dia || 0) * 7
  const yMax = niceMax(Math.max(...data.map((week) => week.cantidad), weekly, 1) * 1.05)
  const slot = plotW / data.length
  const barW = Math.max(3, Math.min(24, slot - 2))
  const y = (value) => pad.top + plotH - (value / yMax) * plotH
  const formatWeek = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-EC', { day: '2-digit', month: 'short' })
  const labelEvery = Math.ceil(data.length / 6)

  return (
    <div className="repo-chart">
      <div className="repo-chart__frame" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Ventas por semana">
          {[0, yMax / 2, yMax].map((tick) => (
            <g key={`wy-${tick}`}>
              <line className="repo-chart__grid" x1={pad.left} x2={pad.left + plotW} y1={y(tick)} y2={y(tick)} />
              <text className="repo-chart__tick" x={pad.left - 8} y={y(tick) + 4} textAnchor="end">{num(tick)}</text>
            </g>
          ))}
          {data.map((week, index) => {
            const cx = pad.left + slot * index + slot / 2
            const top = y(week.cantidad)
            const h = y(0) - top
            const radius = Math.min(4, h / 2, barW / 2)
            const left = cx - barW / 2
            const d = h <= 0 ? '' : `M${left},${y(0)} L${left},${top + radius} Q${left},${top} ${left + radius},${top} L${left + barW - radius},${top} Q${left + barW},${top} ${left + barW},${top + radius} L${left + barW},${y(0)} Z`
            return (
              <g key={week.desde}>
                {d && <path className={`repo-chart__bar${hover?.desde === week.desde ? ' is-hover' : ''}`} d={d} />}
                <rect
                  className="repo-chart__hit"
                  x={pad.left + slot * index}
                  y={pad.top}
                  width={slot}
                  height={plotH}
                  onMouseEnter={() => setHover({ ...week, left: ((cx) / width) * 100 })}
                />
                {index % labelEvery === 0 && (
                  <text className="repo-chart__tick" x={cx} y={pad.top + plotH + 16} textAnchor="middle">{formatWeek(week.desde)}</text>
                )}
              </g>
            )
          })}
          {weekly > 0 && (
            <g>
              <line className="repo-chart__ref" x1={pad.left} x2={pad.left + plotW} y1={y(weekly)} y2={y(weekly)} />
              <text className="repo-chart__ref-label" x={pad.left + plotW + 8} y={y(weekly) + 4}>{`Promedio ${num(weekly, 1)}/sem`}</text>
            </g>
          )}
        </svg>
        {hover && (
          <div className="repo-chart__tooltip" style={{ left: `${hover.left}%` }}>
            <strong>{`${num(hover.cantidad)} unidades`}</strong>
            <span>{`${formatWeek(hover.desde)} – ${formatWeek(hover.hasta)}`}</span>
          </div>
        )}
      </div>
      <p className="repo-chart__caption">
        {`Ventas y traslados que salieron de la sucursal, por semana. La venta diaria μ = ${num(row?.venta_dia, 3)} y su variación σ = ${num(row?.desviacion_dia, 3)} salen de estos datos.`}
      </p>
    </div>
  )
}
