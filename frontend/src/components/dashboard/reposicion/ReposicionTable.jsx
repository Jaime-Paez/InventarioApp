import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, RefreshCw, Search, Settings, X } from 'lucide-react'
import { Paginator } from 'primereact/paginator'
import { Toast } from 'primereact/toast'
import { API_URL, authFetch } from '../../../utils/api'
import '../admin/UsersTable/UsersTable.css'
import './ReposicionTable.css'
import ReposicionProductDialog from './ReposicionProductDialog'
import { ESTADO_LABEL } from './reposicionConstants'

// Reposicion de inventario por producto y sucursal (modelo de Willems):
// revision continua (R, Q) para A/B y stock base periodico (B) para C.

const ESTADOS = [
  { value: 'reponer', label: 'Reponer' },
  { value: 'agotado', label: 'Agotados' },
  { value: 'exceso', label: 'Exceso' },
  { value: 'esporadico', label: 'Esporádicos' },
  { value: 'obsoleto', label: 'Obsoletos' },
  { value: '', label: 'Todos' },
]

const CAUSAS = [
  { key: 'ciclo', label: 'Ciclo', hint: 'Lo que se consume entre un pedido y el siguiente.' },
  { key: 'seguridad', label: 'Seguridad', hint: 'Colchón para la variación de la demanda durante la entrega.' },
  { key: 'en_camino', label: 'En camino', hint: 'Traslados e importaciones que vienen en camino.' },
  { key: 'exceso', label: 'Exceso', hint: 'Más de lo que debería haber justo al llegar un pedido.' },
  { key: 'lento', label: 'Lento', hint: 'Poca o ninguna venta reciente, aún no obsoleto.' },
  { key: 'obsoleto', label: 'Obsoleto', hint: 'Sin ventas en el plazo configurado.' },
]

const POLITICA_LABEL = {
  continua: 'Continua (R, Q)',
  periodica: 'Periódica (B)',
  bajo_pedido: 'Bajo pedido',
  sin_demanda: '—',
}

const CONFIG_FIELDS = [
  { key: 'ventana_dias', label: 'Historia de ventas (días)', hint: 'Días usados para calcular la venta diaria μ y su variación σ.' },
  { key: 'nivel_servicio_a', label: 'Nivel de servicio A (%)', hint: 'Probabilidad de no quedarse sin stock. 97,7% → z = 2.' },
  { key: 'nivel_servicio_b', label: 'Nivel de servicio B (%)' },
  { key: 'nivel_servicio_c', label: 'Nivel de servicio C (%)' },
  { key: 'corte_a', label: 'Corte clase A (% del valor)', hint: 'Productos que suman este % del valor vendido son A.' },
  { key: 'corte_b', label: 'Corte clase B (% del valor)' },
  { key: 'revision_dias', label: 'Revisión periódica r (días)', hint: 'Cada cuánto se revisan los productos C.' },
  { key: 'traslado_dias', label: 'Entrega por traslado (días)', hint: 'Tiempo L de las sucursales que se abastecen de la central.' },
  { key: 'proveedor_local_dias', label: 'Entrega proveedor local (días)', hint: 'L por defecto si el proveedor no tiene historia.' },
  { key: 'proveedor_importacion_dias', label: 'Entrega importación (días)' },
  { key: 'costo_pedido', label: 'Costo por pedido ($)', hint: 'Para la cantidad económica de pedido (EOQ).' },
  { key: 'costo_mantener_pct', label: 'Costo de mantener (% anual)' },
  { key: 'max_dias_pedido', label: 'Pedido máximo (días de venta)', hint: 'Tope de la cantidad Q.' },
  { key: 'min_dias_venta', label: 'Mín. días con venta', hint: 'Con menos días con venta es esporádico (bajo pedido).' },
  { key: 'dias_obsoleto', label: 'Obsoleto sin venta (días)' },
]

const money = (value) => `$${Number(value || 0).toLocaleString('es-EC', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
const num = (value, digits = 0) => (
  value == null ? '—' : Number(value).toLocaleString('es-EC', { minimumFractionDigits: digits, maximumFractionDigits: digits })
)

function ReposicionTable({ token }) {
  const toast = useRef(null)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sucursalId, setSucursalId] = useState('')
  const [estado, setEstado] = useState('reponer')
  const [clase, setClase] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [orden, setOrden] = useState('prioridad')
  const [openRow, setOpenRow] = useState(null)
  const [config, setConfig] = useState(null)
  const [configDraft, setConfigDraft] = useState(null)
  const [configSaving, setConfigSaving] = useState(false)
  const requestRef = useRef(0)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => { setPage(1) }, [sucursalId, estado, clase, debouncedSearch, orden, pageSize])

  const load = useCallback(async ({ recalcular = false } = {}) => {
    if (!token) return
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize), orden })
    if (sucursalId) params.set('sucursal_id', sucursalId)
    if (estado) params.set('estado', estado)
    if (clase) params.set('clase', clase)
    if (debouncedSearch) params.set('search', debouncedSearch)
    if (recalcular) params.set('recalcular', '1')
    try {
      const response = await authFetch(`${API_URL}/reposicion/?${params.toString()}`, {}, token)
      const payload = await response.json().catch(() => ({}))
      if (requestId !== requestRef.current) return
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo calcular la reposición.')
      setData(payload)
    } catch (err) {
      if (requestId === requestRef.current) setError(err?.message || 'No se pudo calcular la reposición.')
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [token, page, pageSize, orden, sucursalId, estado, clase, debouncedSearch])

  useEffect(() => { void load() }, [load])

  const loadConfig = useCallback(async () => {
    if (!token) return null
    const response = await authFetch(`${API_URL}/reposicion/configuracion/`, {}, token)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(String(payload?.detail || 'No se pudo cargar la configuración.'))
    setConfig(payload)
    return payload
  }, [token])

  useEffect(() => { void loadConfig().catch(() => {}) }, [loadConfig])

  const openConfig = async () => {
    try {
      const current = config || await loadConfig()
      setConfigDraft({ ...current })
    } catch (err) {
      toast.current?.show({ severity: 'error', summary: 'Configuración', detail: err.message, life: 3500 })
    }
  }

  const saveConfig = async () => {
    if (!configDraft) return
    setConfigSaving(true)
    try {
      const body = {}
      CONFIG_FIELDS.forEach(({ key }) => { body[key] = configDraft[key] })
      body.sucursal_central_id = configDraft.sucursal_central_id || ''
      const response = await authFetch(
        `${API_URL}/reposicion/configuracion/`,
        { method: 'PATCH', body: JSON.stringify(body) },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || 'No se pudo guardar.'))
      setConfig(payload)
      setConfigDraft(null)
      toast.current?.show({ severity: 'success', summary: 'Configuración', detail: 'Guardada. Se recalculó la reposición.', life: 3000 })
      void load({ recalcular: true })
    } catch (err) {
      toast.current?.show({ severity: 'error', summary: 'Configuración', detail: err.message, life: 4000 })
    } finally {
      setConfigSaving(false)
    }
  }

  const resumen = data?.resumen
  const totalCausas = useMemo(() => (
    CAUSAS.reduce((sum, causa) => sum + Number(resumen?.valor_por_causa?.[causa.key] || 0), 0)
  ), [resumen])
  const sucursales = config?.sucursales || []
  const rows = Array.isArray(data?.results) ? data.results : []
  const counts = resumen?.conteo_por_estado || {}

  const sortBy = (field) => {
    setOrden((current) => (current === field ? `-${field}` : current === `-${field}` ? 'prioridad' : field))
  }
  const sortMark = (field) => (orden === field ? ' ▲' : orden === `-${field}` ? ' ▼' : '')

  return (
    <div className="users-page reposicion">
      <Toast ref={toast} />

      <div className="users-page__top">
        <div className="users-page__actions reposicion__actions">
          <select
            className="reposicion__select"
            value={sucursalId}
            onChange={(event) => setSucursalId(event.target.value)}
            aria-label="Sucursal"
          >
            <option value="">Todas las sucursales</option>
            {sucursales.map((sucursal) => (
              <option key={sucursal.id} value={sucursal.id}>{sucursal.nombre}</option>
            ))}
          </select>
          <div className="reposicion__segmented" role="tablist" aria-label="Estado">
            {ESTADOS.map((option) => {
              const count = option.value === 'reponer'
                ? Number(counts.agotado || 0) + Number(counts.pedir || 0)
                : option.value ? Number(counts[option.value] || 0) : null
              return (
                <button
                  key={option.value || 'todos'}
                  type="button"
                  className={`reposicion__segment${estado === option.value ? ' is-active' : ''}`}
                  onClick={() => setEstado(option.value)}
                >
                  {option.label}
                  {count != null && <span className="reposicion__segment-count">{count}</span>}
                </button>
              )
            })}
          </div>
          <select className="reposicion__select" value={clase} onChange={(event) => setClase(event.target.value)} aria-label="Clase">
            <option value="">Clase A, B y C</option>
            <option value="A">Clase A</option>
            <option value="B">Clase B</option>
            <option value="C">Clase C</option>
          </select>
          <label className="reposicion__search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Código o descripción"
              aria-label="Buscar producto"
            />
          </label>
          <div className="reposicion__actions-right">
            <button type="button" className="reposicion__btn" onClick={() => void load({ recalcular: true })} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'is-spinning' : undefined} />
              Recalcular
            </button>
            <button type="button" className="reposicion__btn" onClick={() => void openConfig()}>
              <Settings size={14} />
              Configuración
            </button>
          </div>
        </div>
      </div>

      <div className="reposicion__body">
        {resumen && (
          <section className="reposicion__summary" aria-label="Inventario por causa">
            <div className="reposicion__summary-head">
              <div>
                <h4>Inventario por causa</h4>
                <p>
                  {`Valor a costo${sucursalId ? '' : ' de todas las sucursales'} · ventas de los últimos ${data?.meta?.ventana_dias || '-'} días · central: ${data?.meta?.sucursal_central_nombre || '-'}`}
                </p>
              </div>
              <div className="reposicion__summary-order">
                <small>Sugerido a pedir</small>
                <strong>{money(resumen.valor_sugerido)}</strong>
              </div>
            </div>
            <div className="reposicion__bar" aria-hidden="true">
              {CAUSAS.map((causa) => {
                const value = Number(resumen.valor_por_causa?.[causa.key] || 0)
                if (!value || !totalCausas) return null
                return <span key={causa.key} className={`reposicion__bar-part is-${causa.key}`} style={{ width: `${(value / totalCausas) * 100}%` }} />
              })}
            </div>
            <div className="reposicion__causes">
              {CAUSAS.map((causa) => {
                const value = Number(resumen.valor_por_causa?.[causa.key] || 0)
                return (
                  <div key={causa.key} className="reposicion__cause" title={causa.hint}>
                    <span className={`reposicion__dot is-${causa.key}`} />
                    <div>
                      <small>{causa.label}</small>
                      <strong>{money(value)}</strong>
                      <em>{totalCausas ? `${((value / totalCausas) * 100).toFixed(1)}%` : '0%'}</em>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        <section className="reposicion__table-card">
          {error && <p className="reposicion__error">{error}</p>}
          <div className="reposicion__table-wrap">
            <table className="reposicion__table">
              <thead>
                <tr>
                  <th onClick={() => sortBy('codigo')}>{`Producto${sortMark('codigo')}`}</th>
                  {!sucursalId && <th onClick={() => sortBy('sucursal_nombre')}>{`Sucursal${sortMark('sucursal_nombre')}`}</th>}
                  <th onClick={() => sortBy('clase')}>{`Clase${sortMark('clase')}`}</th>
                  <th className="is-num" onClick={() => sortBy('venta_dia')} title="Venta promedio diaria (μ)">{`Venta/día${sortMark('venta_dia')}`}</th>
                  <th className="is-num" onClick={() => sortBy('dias_entrega')} title="Tiempo de entrega (L)">{`Entrega${sortMark('dias_entrega')}`}</th>
                  <th className="is-num" title="Stock de seguridad">Seguridad</th>
                  <th className="is-num" title="Punto de pedido R (continua) o nivel base B (periódica)">Pedir en</th>
                  <th className="is-num" onClick={() => sortBy('stock')}>{`Stock${sortMark('stock')}`}</th>
                  <th className="is-num">En camino</th>
                  <th className="is-num" onClick={() => sortBy('cobertura_dias')} title="Días que alcanza el stock actual">{`Cobertura${sortMark('cobertura_dias')}`}</th>
                  <th className="is-num" onClick={() => sortBy('sugerido')}>{`Sugerido${sortMark('sugerido')}`}</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {!rows.length && !loading && (
                  <tr><td colSpan={sucursalId ? 11 : 12} className="reposicion__empty">No hay productos con este filtro.</td></tr>
                )}
                {rows.map((row) => {
                  const key = `${row.sucursal_id}-${row.producto_id}`
                  return (
                    <React.Fragment key={key}>
                      <tr
                        className={`reposicion__row is-${row.estado}`}
                        onClick={() => setOpenRow(row)}
                        tabIndex={0}
                        onKeyDown={(event) => { if (event.key === 'Enter') setOpenRow(row) }}
                      >
                        <td>
                          <div className="reposicion__product">
                            <strong>{row.codigo}</strong>
                            <span>{row.nombre}</span>
                          </div>
                        </td>
                        {!sucursalId && <td>{row.sucursal_nombre}</td>}
                        <td><span className={`reposicion__class is-${row.clase}`}>{row.clase === 'N' ? '—' : row.clase}</span></td>
                        <td className="is-num">{num(row.venta_dia, 2)}</td>
                        <td className="is-num">{`${num(row.dias_entrega, 0)} d`}</td>
                        <td className="is-num">{num(row.stock_seguridad)}</td>
                        <td className="is-num">{row.punto_pedido != null ? num(row.punto_pedido) : row.nivel_base != null ? `${num(row.nivel_base)} (B)` : '—'}</td>
                        <td className="is-num">{num(row.stock)}</td>
                        <td className="is-num">{row.en_camino ? num(row.en_camino) : '—'}</td>
                        <td className="is-num">{row.cobertura_dias == null ? '—' : `${num(row.cobertura_dias, 0)} d`}</td>
                        <td className="is-num"><strong>{row.sugerido ? num(row.sugerido) : '—'}</strong></td>
                        <td><span className={`reposicion__status is-${row.estado}`}>{ESTADO_LABEL[row.estado] || row.estado}</span></td>
                      </tr>
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
            {loading && (
              <div className="reposicion__loading" aria-label="Calculando">
                <Loader2 size={22} className="is-spinning" />
              </div>
            )}
          </div>
          <Paginator
            first={(page - 1) * pageSize}
            rows={pageSize}
            totalRecords={Number(data?.count || 0)}
            rowsPerPageOptions={[25, 50, 100, 200]}
            template="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown"
            onPageChange={(event) => {
              if (event.rows !== pageSize) setPageSize(event.rows)
              setPage((event.page ?? 0) + 1)
            }}
          />
        </section>
      </div>

      <ReposicionProductDialog open={Boolean(openRow)} token={token} row={openRow} onClose={() => setOpenRow(null)} />

      {configDraft && createPortal(
        <div className="reposicion__dialog-overlay" onMouseDown={() => !configSaving && setConfigDraft(null)}>
          <div className="reposicion__dialog" role="dialog" aria-modal="true" aria-label="Configuración de reposición" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h4>Configuración de reposición</h4>
                <p>Parámetros del modelo. Al guardar se recalcula todo.</p>
              </div>
              <button type="button" className="reposicion__close" onClick={() => setConfigDraft(null)} disabled={configSaving} aria-label="Cerrar">
                <X size={16} />
              </button>
            </header>
            <div className="reposicion__dialog-body">
              <label className="reposicion__field reposicion__field--wide">
                <span>Sucursal central (compra a proveedores y abastece a las demás)</span>
                <select
                  value={configDraft.sucursal_central_id || ''}
                  onChange={(event) => setConfigDraft((prev) => ({ ...prev, sucursal_central_id: event.target.value }))}
                >
                  {(configDraft.sucursales || []).map((sucursal) => (
                    <option key={sucursal.id} value={sucursal.id}>{sucursal.nombre}</option>
                  ))}
                </select>
              </label>
              {CONFIG_FIELDS.map((field) => (
                <label key={field.key} className="reposicion__field" title={field.hint}>
                  <span>{field.label}</span>
                  <input
                    type="number"
                    step="any"
                    value={configDraft[field.key] ?? ''}
                    onChange={(event) => {
                      const value = event.target.value
                      setConfigDraft((prev) => ({ ...prev, [field.key]: value }))
                    }}
                  />
                  {field.hint && <small>{field.hint}</small>}
                </label>
              ))}
            </div>
            <footer>
              <button type="button" className="reposicion__btn" onClick={() => setConfigDraft(null)} disabled={configSaving}>Cancelar</button>
              <button type="button" className="reposicion__btn reposicion__btn--primary" onClick={() => void saveConfig()} disabled={configSaving}>
                {configSaving ? 'Guardando...' : 'Guardar y recalcular'}
              </button>
            </footer>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

export default ReposicionTable
