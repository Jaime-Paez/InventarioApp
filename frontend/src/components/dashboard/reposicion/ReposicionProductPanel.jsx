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

export function ReposicionCalculation({ row }) {
  const L = Number(row.dias_entrega || 0)
  const mu = Number(row.venta_dia || 0)
  const sigma = Number(row.desviacion_dia || 0)
  const z = Number(row.z || 0)
  return (
    <div className="reposicion__detail">
      <div className="reposicion__detail-grid">
        <div><small>Venta diaria μ</small><strong>{num(mu, 3)}</strong></div>
        <div><small>Variación diaria σ</small><strong>{num(sigma, 3)}</strong></div>
        <div><small>Días con venta</small><strong>{num(row.dias_con_venta)}</strong></div>
        <div><small>Entrega L</small><strong>{`${num(L, 1)} d`}</strong><em>{row.fuente_entrega}</em></div>
        <div><small>Nivel de servicio</small><strong>{row.nivel_servicio ? `${num(row.nivel_servicio, 1)}%` : '—'}</strong><em>{row.z ? `z = ${num(z, 2)}` : ''}</em></div>
        <div><small>Costo unitario</small><strong>{`$${num(row.costo, 2)}`}</strong></div>
        <div><small>Última venta</small><strong>{row.ultima_venta || '—'}</strong><em>{row.dias_sin_venta != null ? `hace ${row.dias_sin_venta} d` : ''}</em></div>
        <div><small>Posición (stock + en camino)</small><strong>{num(row.posicion)}</strong></div>
      </div>
      <div className="reposicion__formula">
        {row.politica === 'continua' && (
          <>
            <p><strong>Revisión continua (clase {row.clase}):</strong> cuando la posición baja de R se pide Q.</p>
            <p>{`Stock de seguridad = z·σ·√L = ${num(z, 2)} × ${num(sigma, 3)} × √${num(L, 1)} = ${num(row.stock_seguridad)}`}</p>
            <p>{`Punto de pedido R = L·μ + seguridad = ${num(L, 1)} × ${num(mu, 3)} + ${num(row.stock_seguridad)} ≈ ${num(row.punto_pedido)}`}</p>
            <p>{`Cantidad a pedir Q (lote económico, con tope) = ${num(row.cantidad_pedido)} · stock esperado promedio Q/2 + seguridad ≈ ${num(row.inventario_esperado, 1)}`}</p>
          </>
        )}
        {row.politica === 'periodica' && (
          <>
            <p><strong>Revisión periódica (clase C):</strong> cada {row.revision_dias} días se pide hasta el nivel base B.</p>
            <p>{`Stock de seguridad = z·σ·√(r+L) = ${num(z, 2)} × ${num(sigma, 3)} × √(${row.revision_dias}+${num(L, 1)}) = ${num(row.stock_seguridad)}`}</p>
            <p>{`Nivel base B = (r+L)·μ + seguridad = (${row.revision_dias}+${num(L, 1)}) × ${num(mu, 3)} + ${num(row.stock_seguridad)} ≈ ${num(row.nivel_base)}`}</p>
            <p>{`Pedir = B − posición = ${num(row.nivel_base)} − ${num(row.posicion)} → ${num(row.sugerido)} · stock esperado promedio r·μ/2 + seguridad ≈ ${num(row.inventario_esperado, 1)}`}</p>
          </>
        )}
        {row.politica === 'bajo_pedido' && (
          <p><strong>Demanda esporádica:</strong> {`solo ${row.dias_con_venta} día(s) con venta en la ventana; el modelo supone demanda estable, así que este producto se maneja bajo pedido (no se repone solo).`}</p>
        )}
        {row.politica === 'sin_demanda' && (
          <p><strong>Sin venta en la ventana:</strong> no se calcula reposición.</p>
        )}
        {row.estado === 'obsoleto' && (
          <p className="reposicion__formula-warn">{`Obsoleto: sin ventas ${row.dias_sin_venta != null ? `desde hace ${row.dias_sin_venta} días` : 'registradas en esta sucursal'}. Considera trasladarlo a donde sí se vende o liquidarlo.`}</p>
        )}
        {row.estado === 'exceso' && (
          <p className="reposicion__formula-warn">{`Exceso: hay ${num(row.stock)} y lo máximo esperado es ${num(row.nivel_maximo)} (justo al llegar un pedido).`}</p>
        )}
      </div>
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
        {tab === 'calculo' && <ReposicionCalculation row={row} />}
        {tab === 'ventas' && <WeeklySalesChart weeks={data?.ventas_semanales?.[String(row.sucursal_id)]} row={row} />}
      </div>
    </div>
  )
}
