import { useEffect, useMemo, useState } from 'react'
import { API_URL, authFetch } from '../../../utils/api'
import { InventoryProjectionChart, WeeklySalesChart } from './ReposicionCharts'
import './ReposicionTable.css'
import { ESTADO_LABEL } from './reposicionConstants'

// Reposicion de un producto: sucursales + pestanas Grafica / Calculo / Ventas.
// Se usa en la ventana de Reposicion y en la pestana del detalle de Productos.


const num = (value, digits = 0) => (
  value == null ? '—' : Number(value).toLocaleString('es-EC', { minimumFractionDigits: digits, maximumFractionDigits: digits })
)

// Explicacion en palabras simples, paso a paso, de por que se sugiere pedir
// (o no) este producto. La formula tecnica queda escondida en "Ver formula".
function ReposicionCalculation({ row, ventanaDias }) {
  const L = Number(row.dias_entrega || 0)
  const mu = Number(row.venta_dia || 0)
  const sigma = Number(row.desviacion_dia || 0)
  const z = Number(row.z || 0)
  const days = Number(ventanaDias || 0)
  const dayWord = (value) => (Math.round(value) === 1 ? 'día' : 'días')
  const unitWord = (value) => (Math.round(value) === 1 ? 'unidad' : 'unidades')
  // De donde sale el tiempo de entrega, en palabras simples.
  const provider = String(row.proveedor_nombre || '').trim()
  const imports = Array.isArray(row.importaciones_entrega) ? row.importaciones_entrega : []
  const leadSource = {
    traslado: 'Llega por traslado desde la sucursal central.',
    producto: `Es lo que tardaron en llegar sus importaciones (${imports.map((item) => `${item.codigo}: ${item.dias} días`).join(', ')}).`,
    proveedor: `Es lo que suelen tardar las importaciones de ${provider || 'su proveedor'}.`,
    estimado: `Es el tiempo estimado de ${provider || 'su proveedor'}: todavía no hay importaciones suyas recibidas.`,
    defecto: `No hay importaciones${provider ? ` de ${provider}` : ''}: se usa el valor por defecto de la configuración.`,
  }[row.fuente_entrega] || ''
  const position = Number(row.posicion || 0)
  const q = Number(row.cantidad_pedido || 0)

  let steps = []
  let conclusion = null

  if (row.politica === 'continua' || row.politica === 'periodica') {
    const periodic = row.politica === 'periodica'
    const r = Number(row.revision_dias || 0)
    const window = periodic ? r + L : L
    const sold = window * mu
    steps = [
      {
        value: num(mu, mu < 10 ? 1 : 0),
        title: `Se vende en promedio ${num(mu, mu < 10 ? 1 : 0)} por día`,
        text: `En los últimos ${days || '—'} días salieron ${num(row.venta_total)} ${unitWord(row.venta_total)}, en ${num(row.dias_con_venta)} días distintos.`,
      },
      {
        value: `${num(L)} ${dayWord(L)}`,
        title: `Un pedido tarda ${num(L)} ${dayWord(L)} en llegar`,
        text: leadSource,
      },
      ...(periodic ? [{
        value: `${num(r)} ${dayWord(r)}`,
        title: `Este producto se revisa cada ${num(r)} ${dayWord(r)}`,
        text: 'Es de los que menos valor mueven (clase C): conviene revisarlo junto con otros, no a cada rato.',
      }] : []),
      {
        value: num(sold, sold < 10 ? 1 : 0),
        title: periodic
          ? `Hasta que llegue el siguiente pedido se venden unas ${num(sold, sold < 10 ? 1 : 0)}`
          : `Mientras llega el pedido se venden unas ${num(sold, sold < 10 ? 1 : 0)}`,
        text: periodic
          ? `${num(r)} ${dayWord(r)} de revisión + ${num(L)} de entrega = ${num(window)} días × ${num(mu, 2)} por día.`
          : `${num(L)} ${dayWord(L)} × ${num(mu, 2)} por día.`,
      },
      {
        value: num(row.stock_seguridad),
        title: `Colchón por si se vende más de lo normal: ${num(row.stock_seguridad)}`,
        text: `Las ventas cambian de un día a otro. Con este colchón, ${num(row.nivel_servicio, Number.isInteger(Number(row.nivel_servicio)) ? 0 : 1)} de cada 100 veces no te quedas sin stock mientras llega el pedido.`,
      },
      periodic
        ? {
          value: num(row.nivel_base),
          title: `En cada revisión hay que completar hasta ${num(row.nivel_base)}`,
          text: `Lo que se vende hasta que llegue el siguiente pedido (${num(sold, sold < 10 ? 1 : 0)}) más el colchón (${num(row.stock_seguridad)}).`,
        }
        : {
          value: num(row.punto_pedido),
          title: `Hay que pedir cuando queden ${num(row.punto_pedido)}`,
          text: `Lo que se vende mientras llega (${num(sold, sold < 10 ? 1 : 0)}) más el colchón (${num(row.stock_seguridad)}). Si se pide antes, sobra; si se pide después, falta.`,
        },
      ...(!periodic ? [{
        value: num(q),
        title: `Cada pedido es de ${num(q)}`,
        text: `Alcanza para unos ${num(mu > 0 ? q / mu : 0)} días. Es el punto medio entre hacer muchos pedidos pequeños y tener demasiado guardado.`,
      }] : []),
    ]
    const threshold = periodic ? Number(row.nivel_base || 0) : Number(row.punto_pedido || 0)
    const have = `Hoy hay ${num(row.stock)} en stock${Number(row.en_camino || 0) ? ` y ${num(row.en_camino)} en camino` : ''}`
    if (Number(row.sugerido || 0) > 0) {
      conclusion = {
        tone: 'order',
        title: `Por eso hay que pedir ${num(row.sugerido)}`,
        text: periodic
          ? `${have}: faltan ${num(row.sugerido)} para llegar a ${num(threshold)}.`
          : `${have}${Number(row.en_camino || 0) ? ` (${num(position)} en total)` : ''} y se pide cuando quedan ${num(threshold)} o menos.${Number(row.sugerido) > q ? ` Se piden ${num(Number(row.sugerido) / q)} pedidos de ${num(q)} para volver a quedar por encima.` : ''}`,
      }
    } else if (row.estado === 'exceso') {
      conclusion = {
        tone: 'warn',
        title: 'No hay que pedir: sobra stock',
        text: `${have}. Lo máximo que debería haber es ${num(row.nivel_maximo)} (justo cuando llega un pedido). Hay ${num(Number(row.stock) - Number(row.nivel_maximo))} de más.`,
      }
    } else {
      conclusion = {
        tone: 'ok',
        title: 'Por ahora no hay que pedir',
        text: `${have}, más que ${num(threshold)}. Se pedirá cuando baje de ahí.`,
      }
    }
  } else if (row.politica === 'bajo_pedido') {
    steps = [{
      value: num(row.dias_con_venta),
      title: `Se vendió solo en ${num(row.dias_con_venta)} ${dayWord(row.dias_con_venta)} en los últimos ${days || '—'} días`,
      text: `En total salieron ${num(row.venta_total)} ${unitWord(row.venta_total)}. Con tan pocas ventas no se puede calcular un ritmo confiable.`,
    }]
    conclusion = {
      tone: 'neutral',
      title: 'Se maneja bajo pedido',
      text: 'No se sugiere tenerlo en stock de forma automática: pídelo cuando un cliente lo necesite.',
    }
  } else {
    steps = [{
      value: '0',
      title: `No se vendió en los últimos ${days || '—'} días`,
      text: 'Sin ventas no hay nada que reponer.',
    }]
    conclusion = { tone: 'neutral', title: 'No hay que pedir', text: '' }
  }

  if (row.estado === 'obsoleto') {
    conclusion = {
      tone: 'warn',
      title: 'Producto obsoleto',
      text: `Tiene ${num(row.stock)} en stock y no se vende ${row.dias_sin_venta != null ? `hace ${num(row.dias_sin_venta)} días` : 'en esta sucursal'}. Conviene trasladarlo a donde sí se vende o liquidarlo.`,
    }
  }

  return (
    <div className="repo-steps">
      <ol className="repo-steps__list">
        {steps.map((step, index) => (
          <li key={step.title} className="repo-steps__item">
            <span className="repo-steps__number" aria-hidden="true">{index + 1}</span>
            <div className="repo-steps__text">
              <strong>{step.title}</strong>
              {step.text && <span>{step.text}</span>}
            </div>
            <span className="repo-steps__value">{step.value}</span>
          </li>
        ))}
      </ol>

      {conclusion && (
        <div className={`repo-steps__conclusion is-${conclusion.tone}`}>
          <strong>{conclusion.title}</strong>
          {conclusion.text && <span>{conclusion.text}</span>}
        </div>
      )}

      {(row.politica === 'continua' || row.politica === 'periodica') && (
        <details className="repo-steps__formula">
          <summary>Ver fórmula</summary>
          {row.politica === 'continua' ? (
            <>
              <p>{`Seguridad = z × σ × √L = ${num(z, 2)} × ${num(sigma, 2)} × √${num(L, 1)} ≈ ${num(row.stock_seguridad)}`}</p>
              <p>{`Punto de pedido R = L × μ + seguridad = ${num(L, 1)} × ${num(mu, 2)} + ${num(row.stock_seguridad)} ≈ ${num(row.punto_pedido)}`}</p>
              <p>{`Q = lote económico (con tope de días) = ${num(q)}`}</p>
            </>
          ) : (
            <>
              <p>{`Seguridad = z × σ × √(r + L) = ${num(z, 2)} × ${num(sigma, 2)} × √(${row.revision_dias} + ${num(L, 1)}) ≈ ${num(row.stock_seguridad)}`}</p>
              <p>{`Nivel base B = (r + L) × μ + seguridad = (${row.revision_dias} + ${num(L, 1)}) × ${num(mu, 2)} + ${num(row.stock_seguridad)} ≈ ${num(row.nivel_base)}`}</p>
            </>
          )}
          <p>{`μ = venta diaria promedio, σ = cuánto varía de un día a otro, L = días de entrega, z = ${num(z, 2)} por el nivel de servicio de ${num(row.nivel_servicio, 1)}%.`}</p>
        </details>
      )}
    </div>
  )
}

export default function ReposicionProductPanel({ token, productoId, initialSucursalId = '', onLoaded }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sucursalId, setSucursalId] = useState(String(initialSucursalId || ''))
  const [tab, setTab] = useState('grafica')

  useEffect(() => {
    if (!token || !productoId) return undefined
    let cancelled = false
    setLoading(true)
    setError('')
    authFetch(`${API_URL}/reposicion/producto/${encodeURIComponent(productoId)}/`, {}, token)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(String(payload?.detail || 'No se pudo cargar la reposición.'))
        return payload
      })
      .then((payload) => {
        if (cancelled) return
        setData(payload)
        onLoaded?.(payload)
      })
      .catch((err) => { if (!cancelled) setError(err?.message || 'No se pudo cargar la reposición.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token, productoId, onLoaded])

  const rows = useMemo(() => (Array.isArray(data?.filas) ? data.filas : []), [data])
  const row = rows.find((item) => String(item.sucursal_id) === sucursalId) || rows[0] || null

  useEffect(() => {
    if (row && String(row.sucursal_id) !== sucursalId) setSucursalId(String(row.sucursal_id))
  }, [row, sucursalId])

  if (loading && !data) {
    return <div className="reposicion-panel__state"><i className="pi pi-spin pi-spinner" aria-hidden="true" /></div>
  }
  if (error) return <p className="reposicion__error">{error}</p>
  if (!row) {
    return (
      <p className="reposicion-panel__state">
        Este producto no tiene stock ni ventas en ninguna sucursal: no hay reposición que calcular.
      </p>
    )
  }

  return (
    <div className="reposicion-panel">
      <div className="reposicion-panel__branches" role="tablist" aria-label="Sucursal">
        {rows.map((item) => (
          <button
            key={item.sucursal_id}
            type="button"
            className={`reposicion-panel__branch${String(item.sucursal_id) === String(row.sucursal_id) ? ' is-active' : ''}`}
            onClick={() => setSucursalId(String(item.sucursal_id))}
          >
            <span>{item.sucursal_nombre}{item.es_central ? ' (central)' : ''}</span>
            <span className={`reposicion__status is-${item.estado}`}>{ESTADO_LABEL[item.estado] || item.estado}</span>
          </button>
        ))}
      </div>

      <div className="reposicion-panel__stats">
        <div><small>Clase</small><strong>{row.clase === 'N' ? '—' : row.clase}</strong></div>
        <div><small>Stock</small><strong>{num(row.stock)}</strong></div>
        <div><small>En camino</small><strong>{num(row.en_camino)}</strong></div>
        <div>
          <small>{row.politica === 'periodica' ? 'Nivel base B' : 'Punto de pedido R'}</small>
          <strong>{num(row.politica === 'periodica' ? row.nivel_base : row.punto_pedido)}</strong>
        </div>
        <div><small>Seguridad</small><strong>{num(row.stock_seguridad)}</strong></div>
        <div><small>Cobertura</small><strong>{row.cobertura_dias == null ? '—' : `${num(row.cobertura_dias)} d`}</strong></div>
        <div className="is-accent"><small>Sugerido a pedir</small><strong>{row.sugerido ? num(row.sugerido) : '—'}</strong></div>
      </div>

      <div className="create-user__tabs reposicion-panel__tabs" role="tablist" aria-label="Detalle de reposición">
        {[
          { key: 'grafica', label: 'Gráfica' },
          { key: 'calculo', label: 'Cálculo' },
          { key: 'ventas', label: 'Ventas' },
        ].map((item) => (
          <button
            key={item.key}
            type="button"
            className={`create-user__tab${tab === item.key ? ' create-user__tab--active' : ''}`}
            onClick={() => setTab(item.key)}
            aria-selected={tab === item.key}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="reposicion-panel__body">
        {tab === 'grafica' && <InventoryProjectionChart row={row} today={data?.meta?.fecha} />}
        {tab === 'calculo' && <ReposicionCalculation row={row} ventanaDias={data?.meta?.ventana_dias} />}
        {tab === 'ventas' && <WeeklySalesChart weeks={data?.ventas_semanales?.[String(row.sucursal_id)]} row={row} />}
      </div>
    </div>
  )
}
