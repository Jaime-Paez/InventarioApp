import { useCallback, useEffect, useRef, useState } from 'react'
import { FilterMatchMode, FilterOperator } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { Button } from 'primereact/button'

import CreateSalida from './CreateSalida'
import SalidaDetails from './SalidaDetails'
import '../admin/UsersTable/UsersTable.css'
import { API_URL, authFetch } from '../../../utils/api'

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeValue = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
const parseCurrency = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : '-'
}

const isSalida = (label) => normalizeValue(label).startsWith('sal')

function SalidasTable({ token }) {
  const toast = useRef(null)

  const showErrorToast = useCallback(
    (detail, summary = 'Error') =>
      toast.current?.show({
        severity: 'error',
        summary,
        detail,
        life: 4000,
      }),
    []
  )

  const [movimientos, setMovimientos] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [showDetailsModal, setShowDetailsModal] = useState(false)

  const normalizeList = useCallback(
    (list) =>
      list
        .filter((row) => isSalida(row?.tipo_movimiento))
        .map((row) => {
          const detalles = Array.isArray(row?.detalles) ? row.detalles : []
          const total = detalles.reduce((acc, detalle) => {
            const totalVal = Number(detalle?.valor_total)
            if (Number.isFinite(totalVal)) return acc + totalVal
            const qty = Number(detalle?.cantidad)
            const val = Number(detalle?.valor)
            if (Number.isFinite(qty) && Number.isFinite(val)) return acc + qty * val
            return acc
          }, 0)
          return {
            ...row,
            sucursal_nombre: row?.sucursal ?? '-',
            sub_tipo_nombre: row?.sub_tipo_movimiento ?? '-',
            estado_nombre: row?.estado_movimiento ?? '-',
            sucursal_objetivo_nombre: row?.sucursal_objetivo ?? '-',
            funcional_label: row?.funcional ? 'Si' : 'No',
            total,
          }
        }),
    []
  )

  const fetchMovimientos = useCallback(async (searchTerm = '') => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const list = []
      const normalizedSearch = String(searchTerm ?? '').trim()
      const searchQuery = normalizedSearch ? `?search=${encodeURIComponent(normalizedSearch)}` : ''
      let url = `${API_URL}/movimientos/movimiento_inventario/${searchQuery}`

      while (url) {
        const res = await authFetch(url, {}, token)
        if (!res.ok) throw new Error('No se pudo obtener la lista de salidas.')
        const data = await res.json()
        if (Array.isArray(data)) {
          list.push(...data)
          url = null
        } else {
          list.push(...parseApiList(data))
          url = data?.next || null
        }
      }

      setMovimientos(normalizeList(list))
    } catch (err) {
      const msg = err?.message || 'Ocurrió un error al cargar las salidas.'
      setError(msg)
      toast.current?.show({ severity: 'warn', summary: 'Aviso', detail: msg, life: 3500 })
    } finally {
      setLoading(false)
    }
  }, [token, normalizeList])

  useEffect(() => {
    fetchMovimientos()
  }, [fetchMovimientos])

  // ---------------- Filters ----------------
  const [filters, setFilters] = useState(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')
  const globalSearchDebounceRef = useRef(null)

  const initFilters = () => {
    setFilters({
      global: { value: null, matchMode: FilterMatchMode.CONTAINS },
      no_documento: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
      fecha: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
      sucursal_nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
      sub_tipo_nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
      estado_nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
      sucursal_objetivo_nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
    })
    setGlobalFilterValue('')
  }

  useEffect(() => {
    initFilters()
  }, [])

  useEffect(
    () => () => {
      if (globalSearchDebounceRef.current) {
        clearTimeout(globalSearchDebounceRef.current)
      }
    },
    []
  )

  const clearFilter = () => {
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    initFilters()
    fetchMovimientos('')
  }
  const handleGlobalFilterChange = (event) => {
    const value = event.target.value
    setGlobalFilterValue(value)
    setFilters((prev) => ({
      ...(prev || {}),
      global: { value: value || null, matchMode: FilterMatchMode.CONTAINS },
    }))
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    globalSearchDebounceRef.current = setTimeout(() => {
      fetchMovimientos(value)
    }, 500)
  }
  const handleTableFilterChange = (event) => {
    const nextFilters = event?.filters || {}
    setFilters(nextFilters)
    setGlobalFilterValue(nextFilters?.global?.value || '')
  }

  const cellWithTooltip = (rowData, field) => {
    const content = rowData?.[field] ?? '-'
    const textColor = content === '-' ? '#9ca3af' : undefined
    return (
      <span className="cell-tooltip" data-pr-tooltip={String(content)} style={{ color: textColor }}>
        {String(content)}
      </span>
    )
  }

  const totalBodyTemplate = (rowData) => {
    const value = parseCurrency(rowData?.total)
    return (
      <span className="cell-tooltip" data-pr-tooltip={value}>
        {value}
      </span>
    )
  }

  const handleRowClick = (event) => {
    const target = event?.originalEvent?.target
    if (target?.closest?.('.p-checkbox') || target?.closest?.('.row-selection-column')) return

    const id = event?.data?.id
    if (id == null) return
    setSelectedId(id)
    setShowDetailsModal(true)
  }

  const handleCreated = () => {
    setShowCreateModal(false)
    fetchMovimientos()
    toast.current?.show({ severity: 'success', summary: 'Éxito', detail: 'Salida creada correctamente', life: 2500 })
  }

  const handleUpdated = () => {
    fetchMovimientos()
    toast.current?.show({ severity: 'success', summary: 'Actualizado', detail: 'Salida actualizada correctamente', life: 2500 })
  }

  const handleDeleted = () => {
    setShowDetailsModal(false)
    setSelectedId(null)
    fetchMovimientos()
    toast.current?.show({ severity: 'success', summary: 'Eliminado', detail: 'Salida eliminada', life: 2500 })
  }

  const header = (
    <div className="users-header">
      <div className="users-header__left">
        <div className="search-input-container">
          <input
            type="text"
            value={globalFilterValue}
            onChange={handleGlobalFilterChange}
            className="search-input"
            placeholder="Buscar en tabla"
          />
          <i className="pi pi-search search-input-icon" />
        </div>

        <button
          className="rounded-icon-btn"
          type="button"
          onClick={() => {
            if (globalSearchDebounceRef.current) {
              clearTimeout(globalSearchDebounceRef.current)
            }
            fetchMovimientos(globalFilterValue)
          }}
          disabled={loading}
          title="Recargar"
        >
          <i className="pi pi-refresh" />
        </button>

        <button className="rounded-icon-btn" type="button" onClick={clearFilter} title="Limpiar filtros">
          <i className="pi pi-filter-slash" />
        </button>
      </div>
    </div>
  )

  const dataLength = movimientos?.length ?? 0
  const emptyMessage = dataLength ? 'No se encontraron salidas' : 'No hay salidas registradas.'

  return (
    <div className="users-page">
      <Tooltip position="top" showDelay={1800} target=".cell-tooltip" style={{ maxWidth: '340px' }} />
      <Toast ref={toast} />

      <div className="users-page__top">
        <div className="users-page__actions">
          <Button label="Crear" icon="pi pi-plus" className="users-topbtn users-topbtn--create" onClick={() => setShowCreateModal(true)} type="button" />
        </div>
      </div>

      <div className="users-table users-table--card">
        {loading && (
          <div className="spinner-container spinner-container--table">
            <div className="spinner" />
          </div>
        )}

        {error && (
          <div className="stale-data-msg">
            <i className="pi pi-exclamation-circle" style={{ fontSize: '0.8rem', margin: 0, color: 'white' }} />
            <span>
              <strong>Los datos pueden estar desactualizados</strong> | intenta recargar la tabla
            </span>
          </div>
        )}

        <DataTable
          value={movimientos}
          dataKey="id"
          header={header}
          className={`users-datatable${loading ? ' users-datatable--loading-content' : ''}`}
          tableStyle={{ width: '100%' }}
          emptyMessage={emptyMessage}
          showGridlines
          size="small"
          scrollable
          scrollHeight="flex"
          paginator
          rows={25}
          rowsPerPageOptions={[5, 10, 25, 50]}
          removableSort
          filters={filters}
          onFilter={handleTableFilterChange}
          globalFilterFields={[
            'no_documento',
            'fecha',
            'sucursal_nombre',
            'sub_tipo_nombre',
            'sucursal_objetivo_nombre',
            'estado_nombre',
            'total',
            'funcional_label',
          ]}
          onRowClick={handleRowClick}
        >
          <Column field="no_documento" header="Documento" body={(rowData) => cellWithTooltip(rowData, 'no_documento')} sortable filter />
          <Column field="fecha" header="Fecha" body={(rowData) => cellWithTooltip(rowData, 'fecha')} sortable filter />
          <Column field="sucursal_nombre" header="Sucursal" body={(rowData) => cellWithTooltip(rowData, 'sucursal_nombre')} sortable filter />
          <Column field="sub_tipo_nombre" header="Subtipo" body={(rowData) => cellWithTooltip(rowData, 'sub_tipo_nombre')} sortable filter />
          <Column field="sucursal_objetivo_nombre" header="Destino" body={(rowData) => cellWithTooltip(rowData, 'sucursal_objetivo_nombre')} sortable filter />
          <Column field="estado_nombre" header="Estado" body={(rowData) => cellWithTooltip(rowData, 'estado_nombre')} sortable filter />
          <Column field="total" header="Total" body={totalBodyTemplate} sortable />
          <Column field="funcional_label" header="Funcional" body={(rowData) => cellWithTooltip(rowData, 'funcional_label')} />
        </DataTable>
      </div>

      <CreateSalida
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleCreated}
        token={token}
        onError={showErrorToast}
      />

      <SalidaDetails
        open={showDetailsModal}
        salidaId={selectedId}
        onClose={() => setShowDetailsModal(false)}
        token={token}
        onUpdated={handleUpdated}
        onDeleted={handleDeleted}
        onError={showErrorToast}
      />
    </div>
  )
}

export default SalidasTable


