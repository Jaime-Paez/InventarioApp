import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FilterMatchMode, FilterOperator } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { OverlayPanel } from 'primereact/overlaypanel'
import { Checkbox } from 'primereact/checkbox'
import { Button } from 'primereact/button'

import CreateUserModal from './CreateUserModal'
import './UsersTable.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const formatFullName = (u) =>
  [u?.nombres, u?.apellidos].filter(Boolean).join(' ').trim() || u?.nombre || '—'

function UsersTable({
  token,
  onSelect,

  // opcional: para que luego conectes export/email/carpeta
  onExportExcel,
  onExportPdf,
  onEmail,
  onOpenFolder,
}) {
  const toast = useRef(null)
  const opColumns = useRef(null)

  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_URL}/usuarios/listado/`, {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Token ${token}` } : {}),
        },
      })

      if (!res.ok) throw new Error('No se pudo obtener la lista de usuarios.')

      const data = await res.json()
      const list = Array.isArray(data) ? data : data?.results || []
      setUsers(list)
    } catch (e) {
      const msg = e?.message || 'Ocurrió un error al cargar los usuarios.'
      setError(msg)
      toast.current?.show({ severity: 'warn', summary: 'Aviso', detail: msg, life: 3500 })
    } finally {
      setLoading(false)
      setIsRefreshing(false)
    }
  }, [token])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  const refreshData = () => {
    setIsRefreshing(true)
    fetchUsers()
  }

  // ---------------- Filters (MarcasTable-style) ----------------
  const buildDefaultFilters = () => ({
    global: { value: null, matchMode: FilterMatchMode.CONTAINS },

    codigo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
    nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
    correo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
    telefono: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
    cargo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
    activo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.EQUALS }] },
  })

  const [filters, setFilters] = useState(buildDefaultFilters)
  const [globalFilterValue, setGlobalFilterValue] = useState('')

  useEffect(() => {
    // mantiene comportamiento tipo MarcasTable (si no hay state guardado)
    const saved = sessionStorage.getItem('usuarios-table-state')
    if (saved) {
      const parsed = JSON.parse(saved)
      if (parsed?.filters) {
        setFilters(parsed.filters)
        if (parsed.filters?.global?.value) setGlobalFilterValue(parsed.filters.global.value)
        return
      }
    }
    setFilters(buildDefaultFilters())
  }, [])

  const clearFilter = () => {
    setFilters(buildDefaultFilters())
    setGlobalFilterValue('')
  }

  const onGlobalFilterChange = (e) => {
    const value = e.target.value
    const _filters = { ...filters, global: { ...filters?.global, value } }
    setFilters(_filters)
    setGlobalFilterValue(value)
  }

  // ---------------- Row selection checkboxes (export-style) ----------------
  const [selectedRowIds, setSelectedRowIds] = useState([])
  const [allRowsSelected, setAllRowsSelected] = useState(false)

  useEffect(() => {
    const saved = sessionStorage.getItem('usuarios-table-selected-rows')
    if (saved) {
      const parsed = JSON.parse(saved)
      setSelectedRowIds(parsed.selectedRowIds || [])
      setAllRowsSelected(parsed.allRowsSelected || false)
    }
  }, [])

  useEffect(() => {
    const saveState = () => {
      sessionStorage.setItem(
        'usuarios-table-selected-rows',
        JSON.stringify({ selectedRowIds, allRowsSelected })
      )
    }
    return saveState
  }, [selectedRowIds, allRowsSelected])

  const rowSelectionTemplate = (rowData) => {
    const id = rowData?.id
    const onCheckboxChange = (e) => {
      e.originalEvent?.stopPropagation?.()
      if (e.checked) setSelectedRowIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
      else {
        setSelectedRowIds((prev) => prev.filter((x) => x !== id))
        setAllRowsSelected(false)
      }
    }

    return (
      <span style={{ display: 'flex', justifyContent: 'center' }}>
        <Checkbox onChange={onCheckboxChange} checked={allRowsSelected ? true : selectedRowIds.includes(id)} />
      </span>
    )
  }

  const rowSelectionHeaderTemplate = () => {
    const onCheckboxChange = (e) => {
      e.originalEvent?.stopPropagation?.()
      const next = e.checked
      setAllRowsSelected(next)
      if (!next) setSelectedRowIds([])
    }

    return (
      <span style={{ display: 'flex', justifyContent: 'center' }}>
        <Checkbox onChange={onCheckboxChange} checked={allRowsSelected} />
      </span>
    )
  }

  // ---------------- Columns (persist like MarcasTable) ----------------
  const columnsData = useMemo(
    () => [
      { nombrevar: 'codigo', header: 'Código', filterPlaceholder: 'Buscar por código' },
      { nombrevar: 'nombre', header: 'Nombre', filterPlaceholder: 'Buscar por nombre' },
      { nombrevar: 'correo', header: 'Correo', filterPlaceholder: 'Buscar por correo' },
      { nombrevar: 'telefono', header: 'Teléfono', filterPlaceholder: 'Buscar por teléfono' },
      { nombrevar: 'cargo', header: 'Cargo', filterPlaceholder: 'Buscar por cargo' },
      { nombrevar: 'activo', header: 'Estado', filterPlaceholder: 'Buscar por estado' },
    ],
    []
  )

  const [selectedColumns, setSelectedColumns] = useState(columnsData)
  const selectedColumnsRef = useRef(selectedColumns)

  useEffect(() => {
    selectedColumnsRef.current = selectedColumns
  }, [selectedColumns])

  useEffect(() => {
    const stored = localStorage.getItem('usuarios-table-columns')
    if (stored) setSelectedColumns(JSON.parse(stored))
    return () => {
      localStorage.setItem('usuarios-table-columns', JSON.stringify(selectedColumnsRef.current))
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
    const sortedSelectedColumns = columnOrder
      .map((orderName) => selectedColumns.find((col) => col.nombrevar === orderName))
      .filter(Boolean)
    setSelectedColumns(sortedSelectedColumns)
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

  const codigoBodyTemplate = (rowData) => {
    const code = rowData?.codigo ?? rowData?.id ?? '—'
    const textColor = code === '—' ? '#9ca3af' : undefined
    return (
      <span className="cell-tooltip" data-pr-tooltip={String(code)} style={{ color: textColor }}>
        {String(code)}
      </span>
    )
  }

  const nombreBodyTemplate = (rowData) => {
    const name = formatFullName(rowData)
    return (
      <span className="cell-tooltip" data-pr-tooltip={name}>
        {name}
      </span>
    )
  }

  const activoBodyTemplate = (rowData) => {
    const v = rowData?.activo
    const isTrue = v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true'
    return (
      <span style={{ display: 'flex', justifyContent: 'center' }}>
        <i className={`pi pi-${isTrue ? 'check-circle' : 'times-circle'}`} style={{ color: isTrue ? '#22c55e' : '#9ca3af' }} />
      </span>
    )
  }

  // ---------------- Single selection (row click) ----------------
  const [selectedObject, setSelectedObject] = useState(null)

  const onRowSelect = (event) => {
    const id = event?.data?.id
    if (typeof onSelect === 'function' && id != null) onSelect(id)
  }

  // ---------------- Header (igual look MarcasTable / imagen) ----------------
  const dataLength = users?.length ?? 0

  const header = (
    <div className="users-header">
      <div className="users-header__left">
        <div className="search-input-container">
          <i className="pi pi-search search-input-icon" />
          <input
            className="search-input"
            type="search"
            placeholder="Buscar"
            value={globalFilterValue}
            onChange={onGlobalFilterChange}
          />
        </div>

        <button
          className="rounded-icon-btn"
          type="button"
          onClick={refreshData}
          disabled={loading || isRefreshing}
          title="Recargar"
        >
          <i className="pi pi-refresh" />
        </button>

        <button
          className="rounded-icon-btn"
          type="button"
          onClick={clearFilter}
          title="Limpiar filtros"
        >
          <i className="pi pi-filter-slash" />
        </button>

        <button
          className="rounded-icon-btn"
          type="button"
          onClick={(e) => opColumns.current?.toggle(e)}
          title="Columnas"
        >
          <i className="pi pi-sliders-h" />
        </button>
      </div>

      <div className="users-header__right">
        <span className="users-header__count">Reg. {dataLength}</span>

        <button className="users-circle users-circle--excel" type="button" title="Excel" onClick={onExportExcel} disabled={!onExportExcel}>
          <i className="pi pi-file-excel" />
        </button>

        <button className="users-circle users-circle--pdf" type="button" title="PDF" onClick={onExportPdf} disabled={!onExportPdf}>
          <i className="pi pi-file-pdf" />
        </button>

        <button className="users-circle users-circle--mail" type="button" title="Email" onClick={onEmail} disabled={!onEmail}>
          <i className="pi pi-envelope" />
        </button>

        <button className="users-circle users-circle--folder" type="button" title="Carpeta" onClick={onOpenFolder} disabled={!onOpenFolder}>
          <i className="pi pi-folder" />
        </button>
      </div>
    </div>
  )

  // ---------------- Create modal (opcional) ----------------
  const [showCreateModal, setShowCreateModal] = useState(false)
  const handleUserCreated = () => {
    setShowCreateModal(false)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Éxito', detail: 'Usuario creado correctamente', life: 2500 })
  }

  return (
    <div className="users-table">
      <Tooltip position="top" showDelay={1800} target=".cell-tooltip" style={{ maxWidth: '340px' }} />
      <Toast ref={toast} />

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
        value={users}
        dataKey="id"
        header={header}
        className="users-datatable"
        emptyMessage="No se encontraron usuarios"
        showGridlines
        size="small"
        scrollable
        scrollHeight={error ? 'calc(100svh - 310px)' : 'calc(103svh - 310px)'}
        paginator
        rows={25}
        rowsPerPageOptions={[5, 10, 25, 50]}
        removableSort
        filters={filters}
        onFilter={(e) => setFilters(e.filters)}
        globalFilterFields={['codigo', 'nombre', 'correo', 'telefono', 'cargo', 'activo']}
        filterDisplay="row"
        stateStorage="session"
        stateKey="usuarios-table-state"
        reorderableColumns
        onColReorder={handleOrderChange}
        resizableColumns
        columnResizeMode="expand"
        selectionMode="single"
        selection={selectedObject}
        onSelectionChange={(e) => setSelectedObject(e.value)}
        onRowSelect={onRowSelect}
        metaKeySelection={false}
        rowClassName={(rowData) => (selectedRowIds.includes(rowData?.id) ? 'selected-row-shadow' : '')}
      >
        <Column className="row-selection-column" frozen header={rowSelectionHeaderTemplate} body={rowSelectionTemplate} />

        {selectedColumns.map((column, index) => {
          let bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
          let isFilterable = true
          let isSortable = true
          let className = 'column-max-min-width'

          switch (column.nombrevar) {
            case 'codigo':
              bodyTemplate = (rowData) => codigoBodyTemplate(rowData)
              break
            case 'nombre':
              bodyTemplate = (rowData) => nombreBodyTemplate(rowData)
              break
            case 'activo':
              bodyTemplate = (rowData) => activoBodyTemplate(rowData)
              isFilterable = false
              isSortable = false
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
              sortable={isSortable}
              filter={isFilterable}
              filterField={column.nombrevar}
              filterPlaceholder={column.filterPlaceholder}
              showFilterMenu={false}
              className={className}
            />
          )
        })}
      </DataTable>

      <OverlayPanel ref={opColumns} className="table-options-list">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <strong>Columnas</strong>

          <Button
            type="button"
            icon="pi pi-plus"
            className="p-button-text"
            onClick={() => setShowCreateModal(true)}
            tooltip="Crear usuario"
            tooltipOptions={{ position: 'top' }}
          />
        </div>

        {columnsData.map((column, idx) => (
          <div key={idx} className="p-field-checkbox" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
            <Checkbox
              inputId={`usuarios-col-${idx}`}
              value={column}
              onChange={() => handleCheckboxChangeColumn(column)}
              checked={selectedColumns.some((item) => item.nombrevar === column.nombrevar)}
            />
            <label htmlFor={`usuarios-col-${idx}`} style={{ cursor: 'pointer' }}>
              {column.header}
            </label>
          </div>
        ))}
      </OverlayPanel>

      <CreateUserModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleUserCreated}
        token={token}
      />
    </div>
  )
}

export default UsersTable
