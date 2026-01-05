import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FilterMatchMode, FilterOperator } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { OverlayPanel } from 'primereact/overlaypanel'
import { Checkbox } from 'primereact/checkbox'
import { Button } from 'primereact/button'
import { Dropdown } from 'primereact/dropdown'

import CreateSucursal from '../CreateSucursal/CreateSucursal'
import SucursalDetails from '../SucursalDetails/SucursalDetails'
import '../../admin/UsersTable/UsersTable.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const normId = (v) => (v == null ? null : String(v))

function SucursalesTable({ token, onSelect }) {
  const toast = useRef(null)
  const opColumns = useRef(null)
  const globalSearchRef = useRef(null)
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

  const [branches, setBranches] = useState([])
  const [loading, setLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const fetchBranches = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_URL}/inventario/sucursales/`, {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Token ${token}` } : {}),
        },
      })

      if (!res.ok) throw new Error('No se pudo obtener la lista de sucursales.')

      const data = await res.json()
      const list = Array.isArray(data) ? data : data?.results || []
      setBranches(list)
    } catch (e) {
      const msg = e?.message || 'Ocurrió un error al cargar las sucursales.'
      setError(msg)
      toast.current?.show({ severity: 'warn', summary: 'Aviso', detail: msg, life: 3500 })
    } finally {
      setLoading(false)
      setIsRefreshing(false)
    }
  }, [token])

  useEffect(() => {
    fetchBranches()
  }, [fetchBranches])

  const refreshData = () => {
    setIsRefreshing(true)
    fetchBranches()
  }

  // ---------------- Filters ----------------
  const [filters, setFilters] = useState(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')

  const initFilters = () => {
    setFilters({
      global: { value: null, matchMode: FilterMatchMode.CONTAINS },

      nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      direccion: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
    })
    setGlobalFilterValue('')
  }

  useEffect(() => {
    const savedState = sessionStorage.getItem('sucursales-table-state')
    if (savedState) {
      const parsed = JSON.parse(savedState)
      if (parsed?.filters) {
        setFilters(parsed.filters)
        if (parsed.filters?.global?.value) setGlobalFilterValue(parsed.filters.global.value)
        return
      }
    }
    initFilters()
  }, [])

  const clearFilter = () => initFilters()

  const onGlobalFilterChange = (e) => {
    const value = e.target.value
    const _filters = { ...filters }
    _filters.global = { ..._filters.global, value }
    setFilters(_filters)
    setGlobalFilterValue(value)
  }

  const filterClearTemplate = (options) => (
    <Button className="rounded-icon-btn" type="button" onClick={options.filterClearCallback}>
      <i className="pi pi-times" style={{ fontSize: '0.8rem', margin: 0 }} />
    </Button>
  )

  const filterApplyTemplate = (options) => (
    <Button className="rounded-icon-btn" type="button" onClick={options.filterApplyCallback}>
      <i className="pi pi-check" style={{ fontSize: '0.8rem', margin: 0 }} />
    </Button>
  )

  // ---------------- Row selection (Prime) ----------------
  const [selectedRows, setSelectedRows] = useState([])

  const selectedRowIds = useMemo(
    () => (selectedRows || []).map((u) => normId(u?.id)).filter(Boolean),
    [selectedRows]
  )

  const allRowIds = useMemo(() => branches.map((u) => normId(u?.id)).filter(Boolean), [branches])
  const allRowsSelected = allRowIds.length > 0 && selectedRowIds.length === allRowIds.length

  useEffect(() => {
    const saved = sessionStorage.getItem('sucursales-table-selected-rows')
    if (!saved) return
    try {
      const parsed = JSON.parse(saved)
      const ids = (parsed.selectedRowIds || []).map(normId).filter(Boolean)
      sessionStorage.setItem('sucursales-table-selected-rows-pending', JSON.stringify({ ids }))
    } catch {
      sessionStorage.removeItem('sucursales-table-selected-rows')
      sessionStorage.removeItem('sucursales-table-selected-rows-pending')
    }
  }, [])

  useEffect(() => {
    const pending = sessionStorage.getItem('sucursales-table-selected-rows-pending')
    if (!pending) return
    try {
      const parsed = JSON.parse(pending)
      const ids = (parsed.ids || []).map(normId).filter(Boolean)
      if (!ids.length) {
        setSelectedRows([])
        sessionStorage.removeItem('sucursales-table-selected-rows-pending')
        return
      }
      const map = new Map(branches.map((u) => [normId(u?.id), u]))
      const rows = ids.map((id) => map.get(id)).filter(Boolean)
      setSelectedRows(rows)
      sessionStorage.removeItem('sucursales-table-selected-rows-pending')
    } catch {
      sessionStorage.removeItem('sucursales-table-selected-rows-pending')
    }
  }, [branches])

  useEffect(() => {
    if (!branches?.length) {
      if (selectedRows?.length) setSelectedRows([])
      return
    }
    const idsSet = new Set(allRowIds)
    const filtered = (selectedRows || []).filter((u) => idsSet.has(normId(u?.id)))
    if (filtered.length !== (selectedRows || []).length) setSelectedRows(filtered)
  }, [branches])

  useEffect(() => {
    sessionStorage.setItem(
      'sucursales-table-selected-rows',
      JSON.stringify({
        selectedRowIds,
        allRowsSelected,
      })
    )
  }, [selectedRowIds, allRowsSelected])

  const selectionColStyle = useMemo(
    () => ({
      width: '40px',
      minWidth: '40px',
      maxWidth: '40px',
      textAlign: 'center',
    }),
    []
  )

  // ---------------- Columns ----------------
  const columnsData = useMemo(
    () => [
      { nombrevar: 'nombre', header: 'Nombre', filterPlaceholder: 'Buscar por nombre' },
      { nombrevar: 'direccion', header: 'Dirección', filterPlaceholder: 'Buscar por dirección' },
      { nombrevar: 'latitud', header: 'Latitud', filterPlaceholder: 'Filtrar por latitud' },
      { nombrevar: 'longitud', header: 'Longitud', filterPlaceholder: 'Filtrar por longitud' },
    ],
    []
  )

  const [selectedColumns, setSelectedColumns] = useState(columnsData)
  const selectedColumnsRef = useRef(selectedColumns)

  useEffect(() => {
    selectedColumnsRef.current = selectedColumns
  }, [selectedColumns])

  useEffect(() => {
    const stored = localStorage.getItem('sucursales-table-columns')
    if (stored) setSelectedColumns(JSON.parse(stored))
    return () => {
      localStorage.setItem('sucursales-table-columns', JSON.stringify(selectedColumnsRef.current))
    }
  }, [])

  const handleCheckboxChangeColumn = (column) => {
    if (selectedColumns.some((c) => c.nombrevar === column.nombrevar)) {
      setSelectedColumns(selectedColumns.filter((c) => c.nombrevar !== column.nombrevar))
    } else {
      setSelectedColumns([...selectedColumns, column])
    }
  }

  const handleOrderChange = (e) => {
    const columnOrder = e.columns.map((col) => col.props.field)
    const sorted = columnOrder.map((f) => selectedColumns.find((c) => c.nombrevar === f)).filter(Boolean)
    setSelectedColumns(sorted)
  }

  // ---------------- Body templates ----------------
  const cellWithTooltip = (rowData, field) => {
    const content = rowData?.[field] ?? '—'
    const textColor = content === '—' ? '#9ca3af' : undefined
    return (
      <span className="cell-tooltip" data-pr-tooltip={String(content)} style={{ color: textColor }}>
        {String(content)}
      </span>
    )
  }

  const nombreBodyTemplate = (rowData) => {
    const name = rowData?.nombre ?? '—'
    return (
      <span className="cell-tooltip" data-pr-tooltip={name}>
        {name}
      </span>
    )
  }

  const coordBodyTemplate = (rowData, field) => {
    const value = Number(rowData?.[field])
    if (!Number.isFinite(value)) return <span className="cell-tooltip">—</span>
    const text = value.toFixed(6)
    return (
      <span className="cell-tooltip" data-pr-tooltip={text}>
        {text}
      </span>
    )
  }

  // ---------------- Row click -> detalles ----------------
  const [selectedId, setSelectedId] = useState(null)
  const [showDetailsModal, setShowDetailsModal] = useState(false)

  const handleRowClick = (event) => {
    const t = event?.originalEvent?.target
    if (t?.closest?.('.p-checkbox') || t?.closest?.('.row-selection-column')) return

    const id = event?.data?.id
    if (id == null) return

    setSelectedId(id)
    setShowDetailsModal(true)

    if (typeof onSelect === 'function') onSelect(id)
  }

  const handleUpdated = () => {
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Actualizado', detail: 'Sucursal actualizada correctamente', life: 2500 })
  }

  const handleDeleted = () => {
    setShowDetailsModal(false)
    setSelectedId(null)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Eliminada', detail: 'Sucursal eliminada', life: 2500 })
  }

  // ---------------- Header ----------------
  const dataLength = branches?.length ?? 0

  const header = (
    <div className="users-header">
      <div className="users-header__left">
        <div className="search-input-container">
          <i className="pi pi-search search-input-icon" />
          <input
            ref={globalSearchRef}
            className="search-input"
            type="search"
            placeholder="Buscar"
            value={globalFilterValue}
            onChange={onGlobalFilterChange}
          />
        </div>

        <button className="rounded-icon-btn" type="button" onClick={refreshData} disabled={loading || isRefreshing} title="Recargar">
          <i className="pi pi-refresh" />
        </button>

        <button className="rounded-icon-btn" type="button" onClick={clearFilter} title="Limpiar filtros">
          <i className="pi pi-filter-slash" />
        </button>

        <button className="rounded-icon-btn" type="button" onClick={(e) => opColumns.current?.toggle(e)} title="Columnas">
          <i className="pi pi-sliders-h" />
        </button>
      </div>

      <div className="users-header__right">
        <span className="users-header__count">Reg. {dataLength}</span>
      </div>
    </div>
  )

  // ---------------- Create modal ----------------
  const [showCreateModal, setShowCreateModal] = useState(false)
  const handleCreated = () => {
    setShowCreateModal(false)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Éxito', detail: 'Sucursal creada correctamente', life: 2500 })
  }

  const focusSearch = () => globalSearchRef.current?.focus?.()

  return (
    <div className="users-page">
      <Tooltip position="top" showDelay={1800} target=".cell-tooltip" style={{ maxWidth: '340px' }} />
      <Toast ref={toast} />

      <div className="users-page__top">
        <div className="users-page__actions">
          <Button label="Buscar" icon="pi pi-search" className="users-topbtn users-topbtn--search" onClick={focusSearch} type="button" />
          <Button label="Crear" icon="pi pi-plus" className="users-topbtn users-topbtn--create" onClick={() => setShowCreateModal(true)} type="button" />
        </div>
      </div>

      <div className="users-table users-table--card">
        {(loading || isRefreshing) && (
          <div className="spinner-container">
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
          value={branches}
          dataKey="id"
          header={header}
          className="users-datatable"
          tableStyle={{ width: '100%' }}
          emptyMessage="No se encontraron sucursales"
          showGridlines
          size="small"
          scrollable
          scrollHeight="flex"
          frozenWidth="40px"
          paginator
          rows={25}
          rowsPerPageOptions={[5, 10, 25, 50]}
          removableSort
          filters={filters}
          onFilter={(e) => setFilters(e.filters)}
          globalFilterFields={['nombre', 'direccion', 'latitud', 'longitud']}
          stateStorage="session"
          stateKey="sucursales-table-state"
          reorderableColumns
          onColReorder={handleOrderChange}
          resizableColumns
          columnResizeMode="fit"
          onRowClick={handleRowClick}
          rowClassName={(rowData) => (selectedRowIds.includes(normId(rowData?.id)) ? 'selected-row-shadow' : '')}
          selectionMode="checkbox"
          selection={selectedRows}
          onSelectionChange={(e) => {
            const value = e.value || []
            setSelectedRows(value)
          }}
        >
          <Column
            selectionMode="multiple"
            frozen
            headerClassName="row-selection-column"
            bodyClassName="row-selection-column"
            style={selectionColStyle}
            headerStyle={selectionColStyle}
            bodyStyle={selectionColStyle}
            exportable={false}
            reorderable={false}
          />

          {selectedColumns.map((column, index) => {
            let bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
            let className = 'column-max-min-width'

            let filterMatchMode = FilterMatchMode.CONTAINS
            let showFilterMatchModes = true
            let showFilterOperator = true
            let filterElement = undefined

            switch (column.nombrevar) {
              case 'nombre':
                bodyTemplate = (rowData) => nombreBodyTemplate(rowData)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                break
              case 'latitud':
              case 'longitud':
                bodyTemplate = (rowData) => coordBodyTemplate(rowData, column.nombrevar)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                className = 'column-max-min-width--small'
                break
              default:
                bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
                break
            }

            return (
              <Column
                key={index}
                field={column.nombrevar}
                header={column.header}
                body={bodyTemplate}
                sortable
                reorderable
                filter
                filterPlaceholder={column.filterPlaceholder}
                filterMatchMode={filterMatchMode}
                showFilterMenuOptions
                showFilterMatchModes={showFilterMatchModes}
                showFilterOperator={showFilterOperator}
                filterApply={filterApplyTemplate}
                filterClear={filterClearTemplate}
                filterElement={filterElement}
                className={className}
              />
            )
          })}
        </DataTable>

        <OverlayPanel ref={opColumns} showCloseIcon id="overlayPanel" style={{ width: '220px' }}>
          <div className="op-column-title">Columnas</div>
          <div className="op-column-body">
            {columnsData.map((col) => (
              <div key={col.nombrevar} className="op-column-item">
                <Checkbox
                  inputId={col.nombrevar}
                  name="category"
                  value={col}
                  onChange={() => handleCheckboxChangeColumn(col)}
                  checked={selectedColumns.some((c) => c.nombrevar === col.nombrevar)}
                />
                <label htmlFor={col.nombrevar}>{col.header}</label>
              </div>
            ))}
          </div>
        </OverlayPanel>
      </div>

      <CreateSucursal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleCreated}
        token={token}
        onError={showErrorToast}
      />

      <SucursalDetails
        open={showDetailsModal}
        sucursalId={selectedId}
        onClose={() => setShowDetailsModal(false)}
        token={token}
        onUpdated={handleUpdated}
        onDeleted={handleDeleted}
        onError={showErrorToast}
      />
    </div>
  )
}

export default SucursalesTable
