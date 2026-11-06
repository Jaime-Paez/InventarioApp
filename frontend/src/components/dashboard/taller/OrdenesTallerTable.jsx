import { useCallback, useEffect, useRef, useState } from 'react'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import Toast from '../common/AppToast'
import '../admin/UsersTable/UsersTable.css'
import '../movimientos/EntradasTable.css'
import './Taller.css'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDateTime } from '../../../utils/dateFormat'
import OrdenTallerModal from './OrdenTallerModal'
import { ESTADO_FILTROS, estadoInfo, formatMoney, formatOrdenNumero, parseApiError } from './tallerConstants'

const SEARCH_DELAY_MS = 350

function OrdenesTallerTable({ token, user, moduleActions, isTabActive }) {
  const toast = useRef(null)
  const canCreate = moduleActions?.puede_crear ?? true
  const canEdit = moduleActions?.puede_actualizar ?? true
  const isAdmin = Boolean(
    user?.is_superuser ||
      user?.is_staff ||
      user?.es_administrador ||
      String(user?.rol || '').trim().toLowerCase() === 'administrador'
  )

  const [rows, setRows] = useState([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [first, setFirst] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [sortField, setSortField] = useState(null)
  const [sortOrder, setSortOrder] = useState(null)
  const [estadoFilter, setEstadoFilter] = useState('')
  const [soloPendientes, setSoloPendientes] = useState(false)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState(null)
  const requestSeq = useRef(0)

  const notify = useCallback(({ severity = 'info', summary = 'Taller', detail }) => {
    toast.current?.show({ severity, summary, detail, life: severity === 'error' ? 5000 : 2500 })
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => { setFirst(0) }, [debouncedSearch, estadoFilter, soloPendientes])

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    const params = new URLSearchParams()
    params.set('page', String(Math.floor(first / pageSize) + 1))
    params.set('page_size', String(pageSize))
    if (estadoFilter) params.set('estado', estadoFilter)
    if (soloPendientes) params.set('precios_pendientes', '1')
    if (debouncedSearch) params.set('search', debouncedSearch)
    if (sortField && sortOrder) params.set('ordering', `${sortOrder < 0 ? '-' : ''}${sortField}`)
    setLoading(true)
    try {
      const response = await authFetch(`${API_URL}/taller/ordenes/?${params.toString()}`, {}, token)
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudieron cargar las órdenes.'))
      const data = await response.json()
      if (seq !== requestSeq.current) return
      setRows(Array.isArray(data) ? data : data?.results || [])
      setTotalRecords(Number(data?.count ?? (Array.isArray(data) ? data.length : 0)))
      setError('')
    } catch (err) {
      if (seq !== requestSeq.current) return
      setError(err.message || 'No se pudieron cargar las órdenes.')
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [debouncedSearch, estadoFilter, first, pageSize, soloPendientes, sortField, sortOrder, token])

  useEffect(() => { load() }, [load])

  // Al volver a la pestana se refresca (otro usuario pudo cambiar algo).
  useEffect(() => {
    if (isTabActive) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTabActive])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const response = await authFetch(`${API_URL}/taller/ordenes/`, { method: 'POST', body: JSON.stringify({}) }, token)
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo crear la cotización.'))
      const data = await response.json()
      setOpenId(data.id)
    } catch (err) {
      notify({ severity: 'error', detail: err.message })
    } finally {
      setCreating(false)
    }
  }

  // La ventana avisa cada cambio: la fila se actualiza sin recargar todo.
  const handleOrdenChanged = useCallback((orden, removedId) => {
    if (!orden) {
      setRows((prev) => prev.filter((row) => row.id !== removedId))
      return
    }
    const total = (orden.lineas || []).reduce((acc, linea) => acc + Number(linea.precio || 0) * Number(linea.cantidad || 0), 0)
    const summary = {
      ...orden,
      total: total.toFixed(2),
      lineas_count: (orden.lineas || []).length,
      precios_pendientes: (orden.lineas || []).filter((linea) => linea.precio_estado === 'pendiente').length,
    }
    setRows((prev) => {
      const exists = prev.some((row) => row.id === orden.id)
      if (!exists) return [summary, ...prev]
      return prev.map((row) => (row.id === orden.id ? { ...row, ...summary } : row))
    })
  }, [])

  const handleCloseModal = () => {
    setOpenId(null)
    load()
  }

  const estadoBody = (row) => {
    const info = estadoInfo(row.estado)
    return (
      <span className="taller-cell-estado">
        <span className={`taller-chip taller-chip--${info.chip}`}>{info.label}</span>
        {Number(row.precios_pendientes) > 0 && (
          <span className="taller-chip taller-chip--pendiente" title="Precios distintos al del inventario esperando aprobación">
            {`${row.precios_pendientes} por aprobar`}
          </span>
        )}
      </span>
    )
  }

  const header = (
    <div className="users-header">
      <div className="users-header__left">
        <div className="search-input-container">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="search-input"
            placeholder="Buscar por N°, pedido, placa, cliente, técnico, VIN"
          />
          <i className={`pi ${loading && search ? 'pi-spinner pi-spin' : 'pi-search'} search-input-icon`} />
        </div>
        <button className="rounded-icon-btn" type="button" onClick={load} disabled={loading} title="Recargar">
          <i className="pi pi-refresh" />
        </button>
        <button
          className={`taller-toggle${soloPendientes ? ' is-active' : ''}`}
          type="button"
          onClick={() => setSoloPendientes((prev) => !prev)}
          title="Solo órdenes con precios esperando aprobación"
        >
          Precios por aprobar
        </button>
      </div>
      <div className="users-header__right">
        <span className="users-header__count">Reg. {totalRecords}</span>
      </div>
    </div>
  )

  return (
    <div className="users-page taller-page">
      <Toast ref={toast} />
      <div className="users-page__top">
        <div className="users-page__actions">
          {canCreate && (
            <Button
              label={creating ? 'Creando...' : 'Nueva cotización'}
              icon="pi pi-plus"
              className="users-topbtn users-topbtn--create"
              onClick={handleCreate}
              disabled={creating}
              type="button"
            />
          )}
          <div className="entradas-type-filter" role="group" aria-label="Filtrar por estado">
            {ESTADO_FILTROS.map((option) => (
              <Button
                key={option.key || 'todas'}
                label={option.label}
                type="button"
                className={`users-topbtn entradas-type-filter__btn${estadoFilter === option.key ? ' entradas-type-filter__btn--active' : ''}`}
                onClick={() => setEstadoFilter(option.key)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="users-table users-table--card users-table--compact">
        {loading && (
          <div className="spinner-container spinner-container--table">
            <div className="spinner" />
          </div>
        )}
        {error && (
          <div className="stale-data-msg">
            <i className="pi pi-exclamation-circle" style={{ fontSize: '0.8rem', margin: 0, color: 'white' }} />
            <span>
              <strong>{error}</strong> | intenta recargar la tabla
            </span>
          </div>
        )}
        <DataTable
          value={rows}
          dataKey="id"
          header={header}
          className={`users-datatable users-datatable--compact${loading ? ' users-datatable--loading-content' : ''}`}
          tableStyle={{ width: '100%' }}
          emptyMessage={debouncedSearch || estadoFilter || soloPendientes ? 'Ninguna orden coincide.' : 'Todavía no hay cotizaciones. Crea la primera con "Nueva cotización".'}
          showGridlines
          size="small"
          scrollable
          scrollHeight="flex"
          lazy
          paginator
          first={first}
          rows={pageSize}
          totalRecords={totalRecords}
          rowsPerPageOptions={[10, 25, 50, 100]}
          onPage={(event) => { setFirst(event.first); setPageSize(event.rows) }}
          removableSort
          sortField={sortField || undefined}
          sortOrder={sortOrder || 0}
          onSort={(event) => { setSortField(event.sortField || null); setSortOrder(event.sortOrder || null) }}
          onRowDoubleClick={(event) => event?.data?.id && setOpenId(event.data.id)}
          rowClassName={() => 'taller-row'}
        >
          <Column field="numero" header="N° orden" sortable body={(row) => formatOrdenNumero(row.numero)} style={{ minWidth: 90 }} />
          <Column field="numero_pedido" header="Pedido" sortable body={(row) => row.numero_pedido || '-'} style={{ minWidth: 80 }} />
          <Column field="estado" header="Estado" sortable body={estadoBody} style={{ minWidth: 170 }} />
          <Column field="placa" header="Placa" sortable body={(row) => row.placa || '-'} style={{ minWidth: 90 }} />
          <Column field="modelo" header="Modelo" sortable body={(row) => row.modelo || '-'} style={{ minWidth: 160 }} />
          <Column field="cliente_nombre" header="Cliente" sortable body={(row) => row.cliente_nombre || '-'} style={{ minWidth: 160 }} />
          <Column field="tecnico" header="Técnico" sortable body={(row) => row.tecnico || '-'} style={{ minWidth: 120 }} />
          <Column field="asesor_nombre" header="Asesor" body={(row) => row.asesor_nombre || '-'} style={{ minWidth: 120 }} />
          <Column field="total" header="Total" sortable body={(row) => formatMoney(row.total)} style={{ minWidth: 90, textAlign: 'right' }} />
          <Column field="actualizado_en" header="Actualizado" sortable body={(row) => formatDateTime(row.actualizado_en)} style={{ minWidth: 140 }} />
          <Column
            header=""
            body={(row) => (
              <button type="button" className="taller-open-btn" onClick={() => setOpenId(row.id)}>
                Abrir
              </button>
            )}
            style={{ width: 70 }}
          />
        </DataTable>
      </div>

      <OrdenTallerModal
        open={Boolean(openId)}
        ordenId={openId}
        token={token}
        isAdmin={isAdmin}
        canEdit={canEdit}
        onClose={handleCloseModal}
        onChanged={handleOrdenChanged}
        notify={notify}
      />
    </div>
  )
}

export default OrdenesTallerTable
