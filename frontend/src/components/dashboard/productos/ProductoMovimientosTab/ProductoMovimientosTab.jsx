import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'
import { API_URL, authFetch } from '../../../../utils/api'
import { formatDate } from '../../../../utils/dateFormat'
import EntradaDetails from '../../movimientos/EntradaDetails'
import SalidaDetails from '../../movimientos/SalidaDetails'
import './ProductoMovimientosTab.css'

const PAGE_SIZE = 50

const TIPO_FILTERS = [
  { value: '', label: 'Todos' },
  { value: 'entrada', label: 'Entradas' },
  { value: 'salida', label: 'Salidas' },
]

// Historial de entradas y salidas del producto: cuando entro o salio, de
// donde vino o a donde fue (importacion, compra local, traslado, venta...) y
// un boton para abrir esa entrada o salida (solo para ver).
function ProductoMovimientosTab({ productoId, token, currentUser, onError }) {
  const [tipo, setTipo] = useState('')
  // '' = la sucursal por defecto (la decide el backend: la matriz para el
  // administrador, la del usuario para los demas); 'todas' solo para admin.
  const [sucursalId, setSucursalId] = useState('')
  const [fechaDesde, setFechaDesde] = useState('')
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

      {!loading && !loadError && (
        <div className="create-user__locations-table producto-movs__table">
          <div className="create-user__locations-row create-user__locations-row--head">
            <span>Fecha</span>
            <span>Tipo</span>
            <span>Documento</span>
            <span>Sucursal</span>
            <span>De dónde / a dónde</span>
            <span>Cantidad</span>
            <span>Ver</span>
          </div>

          {!rows.length && (
            <div className="create-user__locations-row create-user__locations-row--empty">
              <span>Este producto no tiene entradas ni salidas{tipo || fechaDesde || fechaHasta ? ' con este filtro' : ''}.</span>
            </div>
          )}

          {rows.map((row) => {
            const isEntrada = row.tipo === 'entrada'
            return (
              <div key={`${row.tipo}-${row.movimiento_id}`} className="create-user__locations-row">
                <span>{formatDate(row.fecha)}</span>
                <span>
                  <span className={`producto-movs__tag ${isEntrada ? 'producto-movs__tag--in' : 'producto-movs__tag--out'}`}>
                    {isEntrada ? 'Entrada' : 'Salida'}
                  </span>
                </span>
                <span className="producto-movs__doc producto-movs__text" data-title={row.no_documento}>{row.no_documento || '-'}</span>
                <span className="producto-movs__text" data-title={row.sucursal}>{row.sucursal || '-'}</span>
                <span className="producto-movs__origen producto-movs__text" data-title={row.estado ? `${row.origen} · ${row.estado}` : row.origen}>
                  {row.origen || row.subtipo_nombre || '-'}
                </span>
                <span className={`producto-movs__qty ${isEntrada ? 'producto-movs__qty--in' : 'producto-movs__qty--out'}`}>
                  {isEntrada ? '+' : '−'}{row.cantidad}
                </span>
                <span className="create-user__locations-cell create-user__locations-cell--action">
                  <button
                    type="button"
                    className="create-user__ghost producto-movs__open"
                    onClick={() => setOpenMovement({ id: row.movimiento_id, tipo: row.tipo })}
                  >
                    Ver
                  </button>
                </span>
              </div>
            )
          })}
        </div>
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
