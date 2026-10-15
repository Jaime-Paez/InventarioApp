import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, PackagePlus, RefreshCw, Search, Settings, X } from 'lucide-react'
import { Paginator } from 'primereact/paginator'
import { Toast } from 'primereact/toast'
import { API_URL, authFetch } from '../../../utils/api'
import { buildFileName, exportToExcel, exportToPdf } from '../../../utils/exportUtils'
import '../admin/UsersTable/UsersTable.css'
import './ReposicionTable.css'
import ReposicionProductDialog from './ReposicionProductDialog'
import ReposicionImportDialog from './ReposicionImportDialog'
import CascadeDropdown from '../common/CascadeDropdown'
import ReposicionHint from './ReposicionHint'
import { ESTADO_LABEL, causaInfo, claseInfo, estadoInfo } from './reposicionConstants'

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
  { key: 'ciclo', label: 'Ciclo' },
  { key: 'seguridad', label: 'Seguridad' },
  { key: 'en_camino', label: 'En camino' },
  { key: 'exceso', label: 'Exceso' },
  { key: 'lento', label: 'Lento' },
  { key: 'obsoleto', label: 'Obsoleto' },
]

// Columnas de la tabla: todas se ordenan haciendo clic en el titulo.
const COLUMNS = [
  { field: 'codigo', label: 'Producto' },
  { field: 'sucursal_nombre', label: 'Sucursal', onlyAll: true },
  { field: 'clase', label: 'Clase' },
  { field: 'venta_dia', label: 'Venta/día', num: true, title: 'Venta promedio diaria (μ)' },
  { field: 'dias_entrega', label: 'Entrega', num: true, title: 'Tiempo de entrega (L)' },
  { field: 'stock_seguridad', label: 'Seguridad', num: true, title: 'Stock de seguridad' },
  { field: 'pedir_en', label: 'Pedir en', num: true, title: 'Punto de pedido R (continua) o nivel base B (periódica)' },
  { field: 'stock', label: 'Stock', num: true },
  { field: 'en_camino', label: 'En camino', num: true },
  { field: 'cobertura_dias', label: 'Cobertura', num: true, title: 'Días que alcanza el stock actual' },
  { field: 'sugerido', label: 'Sugerido', num: true },
  { field: 'estado', label: 'Estado' },
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

const CLASE_OPTIONS = [
  { id: '', nombre: 'Clase A, B y C' },
  { id: 'A', nombre: 'Clase A (más valor)' },
  { id: 'B', nombre: 'Clase B' },
  { id: 'C', nombre: 'Clase C (menos valor)' },
]
const optionName = (option) => option.nombre

// Columnas de los reportes. El PDF lleva menos para que entre en la hoja.
const EXPORT_COLUMNS = [
  { key: 'codigo', header: 'Código', pdf: true },
  { key: 'nombre', header: 'Producto', pdf: true },
  { key: 'sucursal_nombre', header: 'Sucursal', pdf: true },
  { key: 'clase', header: 'Clase', pdf: true },
  { key: 'politica', header: 'Política' },
  { key: 'venta_dia', header: 'Venta/día', pdf: true },
  { key: 'dias_entrega', header: 'Entrega (días)' },
  { key: 'stock_seguridad', header: 'Seguridad' },
  { key: 'pedir_en', header: 'Pedir en', pdf: true },
  { key: 'stock', header: 'Stock', pdf: true },
  { key: 'en_camino', header: 'En camino', pdf: true },
  { key: 'cobertura_dias', header: 'Cobertura (días)' },
  { key: 'sugerido', header: 'Sugerido', pdf: true },
  { key: 'costo', header: 'Costo unitario' },
  { key: 'valor_sugerido', header: 'Valor sugerido', pdf: true },
  { key: 'ultima_venta', header: 'Última venta' },
  { key: 'estado', header: 'Estado', pdf: true },
]

const exportValue = (row, key) => {
  if (key === 'clase') return row.clase === 'N' ? 'Sin clase' : row.clase
  if (key === 'politica') return POLITICA_LABEL[row.politica] || row.politica
  if (key === 'estado') return ESTADO_LABEL[row.estado] || row.estado
  if (key === 'pedir_en') return row.punto_pedido ?? row.nivel_base ?? ''
  if (key === 'venta_dia') return row.venta_dia == null ? '' : Number(Number(row.venta_dia).toFixed(2))
  return row[key] ?? ''
}

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
  const [hint, setHint] = useState(null)
  // Filtros con los que se cargaron los datos que se estan mostrando.
  const [loadedKey, setLoadedKey] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [config, setConfig] = useState(null)
  const [configDraft, setConfigDraft] = useState(null)
  const [configSaving, setConfigSaving] = useState(false)
  const [exporting, setExporting] = useState('')
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
    const key = JSON.stringify([sucursalId, estado, clase, debouncedSearch])
    try {
      const response = await authFetch(`${API_URL}/reposicion/?${params.toString()}`, {}, token)
      const payload = await response.json().catch(() => ({}))
      if (requestId !== requestRef.current) return
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo calcular la reposición.')
      setData(payload)
      setLoadedKey(key)
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

  // Descripcion de los filtros aplicados, para el nombre y titulo del reporte.
  const filtroTexto = () => {
    const parts = []
    parts.push(sucursalId ? ((config?.sucursales || []).find((s) => String(s.id) === String(sucursalId))?.nombre || 'Sucursal') : 'Todas las sucursales')
    parts.push(ESTADOS.find((e) => e.value === estado)?.label || 'Todos')
    parts.push(clase ? `Clase ${clase}` : 'Clases A, B y C')
    if (debouncedSearch) parts.push(`Búsqueda "${debouncedSearch}"`)
    return parts.join(' · ')
  }

  // Reporte con TODO lo que cumple los filtros (no solo la pagina visible).
  const exportar = async (formato) => {
    setExporting(formato)
    try {
      const params = new URLSearchParams({ todo: '1', orden })
      if (sucursalId) params.set('sucursal_id', sucursalId)
      if (estado) params.set('estado', estado)
      if (clase) params.set('clase', clase)
      if (debouncedSearch) params.set('search', debouncedSearch)
      const response = await authFetch(`${API_URL}/reposicion/?${params.toString()}`, {}, token)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || 'No se pudo generar el reporte.'))
      const all = Array.isArray(payload?.results) ? payload.results : []
      if (!all.length) throw new Error('No hay productos con estos filtros.')
      const slug = [
        'reposicion',
        estado || 'todos',
        clase ? `clase-${clase}` : '',
      ].filter(Boolean).join('-')
      const fileName = buildFileName(slug)
      if (formato === 'excel') {
        await exportToExcel({ rows: all, columns: EXPORT_COLUMNS, valueGetter: exportValue, fileName })
      } else {
        await exportToPdf({
          rows: all,
          columns: EXPORT_COLUMNS.filter((col) => col.pdf),
          valueGetter: exportValue,
          fileName,
          title: 'Reporte de reposición',
          subtitle: `${filtroTexto()} · ${all.length} productos · sugerido ${money(all.reduce((sum, r) => sum + Number(r.valor_sugerido || 0), 0))}`,
        })
      }
    } catch (err) {
      toast.current?.show({ severity: 'error', summary: 'Reporte', detail: err.message, life: 3500 })
    } finally {
      setExporting('')
    }
  }

  const resumen = data?.resumen
  const totalCausas = useMemo(() => (
    CAUSAS.reduce((sum, causa) => sum + Number(resumen?.valor_por_causa?.[causa.key] || 0), 0)
  ), [resumen])
  const sucursales = config?.sucursales || []
  const currentKey = JSON.stringify([sucursalId, estado, clase, debouncedSearch])
  // Al cambiar de filtro no se muestran los datos del filtro anterior.
  const stale = loadedKey !== currentKey
  const rows = !stale && Array.isArray(data?.results) ? data.results : []
  const counts = resumen?.conteo_por_estado || {}

  const sortBy = (field) => {
    setOrden((current) => (current === field ? `-${field}` : current === `-${field}` ? 'prioridad' : field))
  }
  const sortIcon = (field) => {
    if (orden === field) return <ArrowUp size={12} />
    if (orden === `-${field}`) return <ArrowDown size={12} />
    return <ArrowUpDown size={12} className="reposicion__sort-idle" />
  }
  const hintProps = (info) => (info ? {
    onMouseEnter: (event) => setHint({ ...info, rect: event.currentTarget.getBoundingClientRect() }),
    onMouseLeave: () => setHint(null),
    onFocus: (event) => setHint({ ...info, rect: event.currentTarget.getBoundingClientRect() }),
    onBlur: () => setHint(null),
  } : {})
  const cfg = config || {}

  return (
    <div className="users-page reposicion">
      <Toast ref={toast} />

      <div className="users-page__top">
        <div className="users-page__actions reposicion__actions">
          <div className="reposicion__dropdown">
            <CascadeDropdown
              placeholder="Todas las sucursales"
              searchPlaceholder="Buscar sucursal"
              options={[{ id: '', nombre: 'Todas las sucursales' }, ...sucursales]}
              valueId={sucursalId}
              getOptionLabel={optionName}
              onSelect={(option) => setSucursalId(String(option.id || ''))}
            />
          </div>
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
                  onClick={() => { setHint(null); setEstado(option.value) }}
                  {...hintProps(option.value ? estadoInfo(option.value, null, cfg) : null)}
                >
                  {option.label}
                  {count != null && <span className="reposicion__segment-count">{count}</span>}
                </button>
              )
            })}
          </div>
          <div className="reposicion__dropdown reposicion__dropdown--small">
            <CascadeDropdown
              placeholder="Clase A, B y C"
              searchPlaceholder="Buscar clase"
              options={CLASE_OPTIONS}
              valueId={clase}
              getOptionLabel={optionName}
              onSelect={(option) => setClase(String(option.id || ''))}
            />
          </div>
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
            <button type="button" className="reposicion__btn reposicion__btn--primary" onClick={() => setImportOpen(true)}>
              <PackagePlus size={14} />
              Sugerencia de importación
            </button>
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
                  <div key={causa.key} className="reposicion__cause" tabIndex={0} {...hintProps(causaInfo(causa.key, cfg))}>
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
          <div className="reposicion__table-toolbar">
            <span className="reposicion__filters-text">{filtroTexto()}</span>
            <div className="users-header__right">
              <span className="users-header__count">{`Reg. ${stale ? '…' : Number(data?.count || 0)}`}</span>
              <button
                className="users-circle users-circle--excel"
                type="button"
                onClick={() => void exportar('excel')}
                title="Exportar a Excel todo lo filtrado"
                disabled={Boolean(exporting) || stale || !data?.count}
              >
                <i className={`pi ${exporting === 'excel' ? 'pi-spin pi-spinner' : 'pi-file-excel'}`} />
              </button>
              <button
                className="users-circle users-circle--pdf"
                type="button"
                onClick={() => void exportar('pdf')}
                title="Exportar a PDF todo lo filtrado"
                disabled={Boolean(exporting) || stale || !data?.count}
              >
                <i className={`pi ${exporting === 'pdf' ? 'pi-spin pi-spinner' : 'pi-file-pdf'}`} />
              </button>
            </div>
          </div>
          {error && <p className="reposicion__error">{error}</p>}
          <div className="reposicion__table-wrap" onScroll={() => setHint(null)}>
            <table className="reposicion__table">
              <thead>
                <tr>
                  {COLUMNS.filter((col) => !col.onlyAll || !sucursalId).map((col) => (
                    <th
                      key={col.field}
                      className={`${col.num ? 'is-num' : ''}${orden.replace('-', '') === col.field ? ' is-sorted' : ''}`}
                      onClick={() => sortBy(col.field)}
                      title={col.title}
                      aria-sort={orden === col.field ? 'ascending' : orden === `-${col.field}` ? 'descending' : 'none'}
                    >
                      <span className="reposicion__th">
                        {col.label}
                        {sortIcon(col.field)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!rows.length && loading && (
                  <tr>
                    <td colSpan={sucursalId ? 11 : 12} className="reposicion__empty">
                      <span className="reposicion__loading-row"><Loader2 size={16} className="is-spinning" /> Cargando productos...</span>
                    </td>
                  </tr>
                )}
                {!rows.length && !loading && (
                  <tr><td colSpan={sucursalId ? 11 : 12} className="reposicion__empty">No hay productos con este filtro.</td></tr>
                )}
                {rows.map((row) => {
                  const key = `${row.sucursal_id}-${row.producto_id}`
                  return (
                    <React.Fragment key={key}>
                      <tr
                        className={`reposicion__row is-${row.estado}`}
                        onClick={() => { setHint(null); setOpenRow(row) }}
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
                        <td>
                          <span className={`reposicion__class is-${row.clase}`} {...hintProps(claseInfo(row.clase, cfg))}>
                            {row.clase === 'N' ? '—' : row.clase}
                          </span>
                        </td>
                        <td className="is-num">{num(row.venta_dia, 2)}</td>
                        <td className="is-num">{`${num(row.dias_entrega, 0)} d`}</td>
                        <td className="is-num">{num(row.stock_seguridad)}</td>
                        <td className="is-num">{row.punto_pedido != null ? num(row.punto_pedido) : row.nivel_base != null ? `${num(row.nivel_base)} (B)` : '—'}</td>
                        <td className="is-num">{num(row.stock)}</td>
                        <td className="is-num">{row.en_camino ? num(row.en_camino) : '—'}</td>
                        <td className="is-num">{row.cobertura_dias == null ? '—' : `${num(row.cobertura_dias, 0)} d`}</td>
                        <td className="is-num"><strong>{row.sugerido ? num(row.sugerido) : '—'}</strong></td>
                        <td>
                          <span className={`reposicion__status is-${row.estado}`} {...hintProps(estadoInfo(row.estado, row, cfg))}>
                            {ESTADO_LABEL[row.estado] || row.estado}
                          </span>
                        </td>
                      </tr>
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
            {loading && rows.length > 0 && (
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

      <ReposicionHint hint={hint} />

      <ReposicionProductDialog open={Boolean(openRow)} token={token} row={openRow} onClose={() => setOpenRow(null)} />

      <ReposicionImportDialog
        open={importOpen}
        token={token}
        onClose={() => { setImportOpen(false); void load({ recalcular: true }) }}
        onCreated={(created) => {
          toast.current?.show({
            severity: 'success',
            summary: 'Sugerencia creada',
            detail: `${created.codigo}: ${created.productos} productos. Está en Importaciones.`,
            life: 4000,
          })
        }}
      />

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
              <div className="reposicion__field reposicion__field--wide">
                <span>Sucursal central (compra a proveedores y abastece a las demás)</span>
                <CascadeDropdown
                  placeholder="Selecciona la sucursal central"
                  searchPlaceholder="Buscar sucursal"
                  options={configDraft.sucursales || []}
                  valueId={configDraft.sucursal_central_id || ''}
                  getOptionLabel={optionName}
                  onSelect={(option) => setConfigDraft((prev) => ({ ...prev, sucursal_central_id: option.id }))}
                  emptyMessage="No hay sucursales registradas. Créalas en Sucursales > Sucursales."
                />
              </div>
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
