import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Info } from 'lucide-react'
import { API_URL, authFetch } from '../../../../utils/api'
import { formatDate } from '../../../../utils/dateFormat'
import EntradaDetails from '../../movimientos/EntradaDetails'
import SalidaDetails from '../../movimientos/SalidaDetails'
import './ProductoMovimientosTab.css'

const PAGE_SIZE = 200

const pad = (n) => String(n).padStart(2, '0')
// Como el Kardex del sistema anterior: por defecto desde el 1 del mes pasado.
const defaultDesde = () => {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return `${first.getFullYear()}-${pad(first.getMonth() + 1)}-01`
}

const fmt2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmt4 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
// null = costo desconocido (unidades del saldo inicial, que vino sin costo).
const money = (value, decimals = 2) => {
  if (value === null || value === undefined || value === '') return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return (decimals === 4 ? fmt4 : fmt2).format(n)
}

const TIPO_FILTERS = [
  { value: '', label: 'Todos' },
  { value: 'entrada', label: 'Entradas' },
  { value: 'salida', label: 'Salidas' },
  { value: 'ajuste', label: 'Ajustes' },
]

// Historial de entradas y salidas del producto en formato Kardex: saldo
// anterior, cada movimiento del mas antiguo al mas reciente con entradas,
// salidas y acumulado (cantidad y costo promedio), y el saldo actual. Cada fila
// dice de donde vino o a donde fue y abre esa entrada o salida (solo ver).
function ProductoMovimientosTab({ productoId, token, currentUser, onError }) {
  const [tipo, setTipo] = useState('')
  // '' = la sucursal por defecto (la decide el backend: la matriz para el
  // administrador, la del usuario para los demas); 'todas' solo para admin.
  const [sucursalId, setSucursalId] = useState('')
  const [fechaDesde, setFechaDesde] = useState(defaultDesde)
  const [fechaHasta, setFechaHasta] = useState('')
  const [rows, setRows] = useState([])
  const [meta, setMeta] = useState({ count: 0, page: 1, total_pages: 1, totales: { entradas: 0, salidas: 0 }, sucursales: [] })
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [openMovement, setOpenMovement] = useState(null)
  const requestRef = useRef(0)

  const fetchPage = useCallback(async (page) => {
    const params = new URLSearchParams({ producto_id: String(productoId), page: String(page), page_size: String(PAGE_SIZE) })
    if (tipo) params.set('tipo', tipo)
    if (sucursalId) params.set('sucursal_id', sucursalId)
    if (fechaDesde) params.set('fecha_desde', fechaDesde)
    if (fechaHasta) params.set('fecha_hasta', fechaHasta)
    const response = await authFetch(`${API_URL}/movimientos/movimiento_inventario/historial-producto/?${params}`, {}, token)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo cargar el historial.')
    return payload
  }, [productoId, tipo, sucursalId, fechaDesde, fechaHasta, token])

  useEffect(() => {
    if (!productoId || !token) return
    const requestId = ++requestRef.current
    setLoading(true)
    setLoadError('')
    fetchPage(1)
      .then((payload) => {
        if (requestId !== requestRef.current) return
        setRows(payload.results || [])
        setMeta(payload)
      })
      .catch((error) => {
        if (requestId !== requestRef.current) return
        setRows([])
        setLoadError(error?.message || 'No se pudo cargar el historial.')
      })
      .finally(() => {
        if (requestId === requestRef.current) setLoading(false)
      })
  }, [fetchPage, productoId, token])

  const loadMore = async () => {
    if (loadingMore || meta.page >= meta.total_pages) return
    const requestId = requestRef.current
    setLoadingMore(true)
    try {
      const payload = await fetchPage(meta.page + 1)
      if (requestId !== requestRef.current) return
      setRows((prev) => [...prev, ...(payload.results || [])])
      setMeta(payload)
    } catch (error) {
      onError?.(error?.message || 'No se pudo cargar el historial.')
    } finally {
      setLoadingMore(false)
    }
  }

  const sucursales = Array.isArray(meta.sucursales) ? meta.sucursales : []
  const sucursalActiva = meta.sucursal_aplicada == null ? 'todas' : String(meta.sucursal_aplicada)
  const totales = meta.totales || { entradas: 0, salidas: 0 }
  const saldoAnterior = meta.saldo_anterior || { cantidad: 0, costo: 0 }
  const saldoInicial = Number(meta.saldo_inicial) || 0
  const costosIncompletos = Boolean(totales.costos_incompletos) || (saldoAnterior.costo == null && saldoAnterior.cantidad > 0)
  const saldoActual = meta.saldo_actual || { cantidad: 0, costo: 0 }
  const isLastPage = meta.page >= meta.total_pages
  const sucursalNombre = sucursales.find((branch) => String(branch.id) === sucursalActiva)?.nombre || 'la sucursal'
  // Solo tiene sentido comparar con el stock de hoy si el Kardex llega a hoy.
  const showStockWarning = !fechaHasta && meta.stock_actual != null && meta.saldo_actual != null
    && Number(meta.stock_actual) !== Number(saldoActual.cantidad)

  return (
    <section className="create-user__section producto-movs">
      <div className="producto-movs__toolbar">
        <div className="producto-movs__filters">
          <div className="producto-movs__segment" role="group" aria-label="Tipo de movimiento">
            {TIPO_FILTERS.map((item) => (
              <button
                key={item.value || 'todos'}
                type="button"
                className={`producto-movs__chip${tipo === item.value ? ' is-active' : ''}`}
                onClick={() => setTipo(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {(sucursales.length > 0 || meta.puede_ver_todas) && (
            <div className="producto-movs__segment" role="group" aria-label="Sucursal">
              {sucursales.map((branch) => (
                <button
                  key={branch.id}
                  type="button"
                  className={`producto-movs__chip${sucursalActiva === String(branch.id) ? ' is-active' : ''}`}
                  onClick={() => setSucursalId(String(branch.id))}
                >
                  {branch.nombre}
                </button>
              ))}
              {meta.puede_ver_todas && (
                <button
                  type="button"
                  className={`producto-movs__chip${sucursalActiva === 'todas' ? ' is-active' : ''}`}
                  onClick={() => setSucursalId('todas')}
                >
                  Todas
                </button>
              )}
            </div>
          )}
        </div>
        <div className="producto-movs__dates">
          <label className="producto-movs__date">
            <span>Desde</span>
            <input
              type="date"
              value={fechaDesde}
              max={fechaHasta || undefined}
              onChange={(event) => setFechaDesde(event.target.value)}
            />
          </label>
          <label className="producto-movs__date">
            <span>Hasta</span>
            <input
              type="date"
              value={fechaHasta}
              min={fechaDesde || undefined}
              onChange={(event) => setFechaHasta(event.target.value)}
            />
          </label>
          {(fechaDesde || fechaHasta) && (
            <button type="button" className="producto-movs__clear" onClick={() => { setFechaDesde(''); setFechaHasta('') }}>
              Todas las fechas
            </button>
          )}
        </div>
        <div className="producto-movs__totals">
          <span className="producto-movs__total producto-movs__total--in">Entraron {totales.entradas}</span>
          <span className="producto-movs__total producto-movs__total--out">Salieron {totales.salidas}</span>
          {Number(totales.ajustes) !== 0 && (
            <span className="producto-movs__total producto-movs__total--adj" data-title="Ajustes de inventario (ya incluidos en entradas y salidas)">
              Ajustes {Number(totales.ajustes) > 0 ? '+' : '−'}{Math.abs(Number(totales.ajustes))}
            </span>
          )}
        </div>
      </div>

      {loading && (
        <div className="inventario-details__empty">
          <Info size={18} />
          <span>Cargando movimientos...</span>
        </div>
      )}

      {!loading && loadError && (
        <div className="inventario-details__empty">
          <Info size={18} />
          <span>{loadError}</span>
        </div>
      )}

      {!loading && !loadError && showStockWarning && (
        <div className="producto-movs__warning" role="status">
          <AlertTriangle size={16} />
          <span>
            El saldo del Kardex ({saldoActual.cantidad}) no coincide con el stock actual en {sucursalNombre} ({meta.stock_actual}).
            Puede haber cambios de cantidad hechos a mano o por la revisión de inventario antes de que se registraran como ajuste.
          </span>
        </div>
      )}

      {!loading && !loadError && (
        <div className="producto-movs__kardex-wrap">
          <table className="producto-movs__kardex">
            <thead>
              <tr className="producto-movs__group">
                <th colSpan={3} />
                <th colSpan={3} className="sep producto-movs__group-in">Entradas</th>
                <th colSpan={3} className="sep producto-movs__group-out">Salidas</th>
                <th colSpan={2} className="sep">Totales</th>
                <th />
              </tr>
              <tr>
                <th>Fecha</th>
                <th>Documento</th>
                <th>De dónde / a dónde</th>
                <th className="num sep">Cantidad</th>
                <th className="num">P. Unitario</th>
                <th className="num">Total</th>
                <th className="num sep">Cantidad</th>
                <th className="num">C. Unitario</th>
                <th className="num">Total</th>
                <th className="num sep">Acum. Cant.</th>
                <th className="num">Acum. Costo</th>
                <th>Ver</th>
              </tr>
            </thead>
            <tbody>
              <tr className="producto-movs__saldo">
                {/* El texto va a la derecha, junto a los totales que describe. */}
                <td colSpan={9} className="producto-movs__saldo-label">
                  {fechaDesde ? `Saldo anterior al ${formatDate(fechaDesde)}` : 'Saldo inicial (sistema anterior)'}
                  {fechaDesde && saldoInicial > 0 && (
                    <span className="producto-movs__saldo-note"> · incluye {saldoInicial} del saldo inicial del sistema anterior</span>
                  )}
                </td>
                <td className="num sep">{saldoAnterior.cantidad}</td>
                <td className="num">{money(saldoAnterior.costo)}</td>
                <td />
              </tr>

              {!rows.length && (
                <tr className="producto-movs__empty">
                  <td colSpan={12}>Este producto no tiene entradas, salidas ni ajustes{tipo || fechaDesde || fechaHasta ? ' con este filtro' : ''}.</td>
                </tr>
              )}

              {rows.map((row) => {
                const isAjuste = row.tipo === 'ajuste'
                // Un ajuste que sumo va en Entradas y uno que resto en Salidas.
                const isEntrada = isAjuste ? Number(row.diferencia) > 0 : row.tipo === 'entrada'
                const origen = row.origen || row.subtipo_nombre || '-'
                const detalle = isAjuste
                  ? [
                    origen,
                    `${row.cantidad_anterior} → ${row.cantidad_nueva}`,
                    row.usuario ? `por ${row.usuario}` : '',
                    row.sucursal,
                  ].filter(Boolean).join(' · ')
                  : [origen, row.estado, row.sucursal].filter(Boolean).join(' · ')
                let tagClass = isEntrada ? 'producto-movs__tag--in' : 'producto-movs__tag--out'
                if (isAjuste) tagClass = 'producto-movs__tag--adj'
                return (
                  <tr key={isAjuste ? `ajuste-${row.ajuste_id}` : `${row.tipo}-${row.movimiento_id}`}>
                    <td className="nowrap">{formatDate(row.fecha)}</td>
                    <td className="producto-movs__doc nowrap">
                      <span className={`producto-movs__tag ${tagClass}`}>
                        {isAjuste ? 'A' : isEntrada ? 'E' : 'S'}
                      </span>
                      {isAjuste ? `Ajuste ${Number(row.diferencia) > 0 ? '+' : '−'}${row.cantidad}` : (row.no_documento || '-')}
                    </td>
                    <td className="producto-movs__origen" data-title={detalle}>{origen}</td>
                    {isEntrada ? (
                      <>
                        <td className="num sep producto-movs__qty--in">{row.cantidad}</td>
                        <td className="num">{money(row.costo_unitario, 4)}</td>
                        <td className="num">{money(row.costo_total)}</td>
                        <td colSpan={3} className="sep" />
                      </>
                    ) : (
                      <>
                        <td colSpan={3} className="sep" />
                        <td className="num sep producto-movs__qty--out">{row.cantidad}</td>
                        <td className="num">{money(row.costo_unitario, 4)}</td>
                        <td className="num">{money(row.costo_total)}</td>
                      </>
                    )}
                    <td className={`num sep strong${row.acum_cantidad < 0 ? ' producto-movs__neg' : ''}`}>{row.acum_cantidad}</td>
                    <td className="num strong">{money(row.acum_costo)}</td>
                    <td>
                      {!isAjuste && (
                        <button
                          type="button"
                          className="create-user__ghost producto-movs__open"
                          onClick={() => setOpenMovement({ id: row.movimiento_id, tipo: row.tipo })}
                        >
                          Ver
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            {isLastPage && (
              <tfoot>
                <tr className="producto-movs__saldo">
                  <td colSpan={3} className="producto-movs__saldo-label">Saldo actual{fechaHasta ? ` al ${formatDate(fechaHasta)}` : ''}</td>
                  <td className="num sep">{totales.entradas}</td>
                  <td className="num">{totales.entradas && !costosIncompletos ? money(Number(totales.entradas_total) / totales.entradas, 4) : '—'}</td>
                  <td className="num">{money(totales.entradas_total)}</td>
                  <td className="num sep">{totales.salidas}</td>
                  <td className="num">{totales.salidas && !costosIncompletos ? money(Number(totales.salidas_total) / totales.salidas, 4) : '—'}</td>
                  <td className="num">{money(totales.salidas_total)}</td>
                  <td className="num sep">{saldoActual.cantidad}</td>
                  <td className="num">{money(saldoActual.costo)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {!loading && !loadError && costosIncompletos && (
        <p className="producto-movs__note">
          — = costo desconocido: el saldo inicial vino del sistema anterior sin costo. Toma el costo de la primera compra local o importación que llegue después.
        </p>
      )}

      {!loading && !loadError && meta.page < meta.total_pages && (
        <div className="producto-movs__more">
          <button type="button" className="create-user__ghost" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Cargando...' : `Ver más (${rows.length} de ${meta.count})`}
          </button>
        </div>
      )}

      {/* Solo para ver: sin editar ni eliminar desde aqui. */}
      {openMovement && typeof document !== 'undefined' && createPortal(
        openMovement.tipo === 'entrada' ? (
          <EntradaDetails
            open
            entradaId={openMovement.id}
            token={token}
            onClose={() => setOpenMovement(null)}
            onError={onError}
            currentUser={currentUser}
            allowEdit={false}
            allowDelete={false}
          />
        ) : (
          <SalidaDetails
            open
            salidaId={openMovement.id}
            token={token}
            onClose={() => setOpenMovement(null)}
            onError={onError}
            currentUser={currentUser}
            allowEdit={false}
            allowDelete={false}
          />
        ),
        document.body
      )}
    </section>
  )
}

export default ProductoMovimientosTab
