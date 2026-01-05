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

import CreateUsuario from '../CreateUsuario/CreateUsuario'
import UsersDetails from '../UsersDetails/UsersDetails'
import './UsersTable.css'
import { authFetch } from '../../../../utils/api'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const formatFullName = (u) =>
  [u?.nombres, u?.apellidos].filter(Boolean).join(' ').trim() || u?.nombre || '—'

const normId = (v) => (v == null ? null : String(v))

function UsersTable({
  token,
  onSelect,

  onExportExcel,
  onExportPdf,
}) {
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

  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await authFetch(
        `${API_URL}/usuarios/listado/`,
        {},
        token
      )

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

  // ---------------- Filters ----------------
  const [filters, setFilters] = useState(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')

  const initFilters = () => {
    setFilters({
      global: { value: null, matchMode: FilterMatchMode.CONTAINS },

      codigo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      correo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      telefono: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      cargo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },

      activo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.EQUALS }] },
    })
    setGlobalFilterValue('')
  }

  useEffect(() => {
    const savedState = sessionStorage.getItem('usuarios-table-state')
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

  // =========================================================
  // ✅ Row selection (Prime nativo) + persistencia por IDs
  // =========================================================
  const [selectedUsers, setSelectedUsers] = useState([]) // rows completos

  const selectedRowIds = useMemo(
    () => (selectedUsers || []).map((u) => normId(u?.id)).filter(Boolean),
    [selectedUsers]
  )

  const allRowIds = useMemo(() => users.map((u) => normId(u?.id)).filter(Boolean), [users])
  const allRowsSelected = allRowIds.length > 0 && selectedRowIds.length === allRowIds.length

  // Restore selección (IDs) al iniciar
  useEffect(() => {
    const saved = sessionStorage.getItem('usuarios-table-selected-rows')
    if (!saved) return
    try {
      const parsed = JSON.parse(saved)
      const ids = (parsed.selectedRowIds || []).map(normId).filter(Boolean)
      // guardamos IDs pendientes; los convertimos a rows cuando exista `users`
      sessionStorage.setItem('usuarios-table-selected-rows-pending', JSON.stringify({ ids }))
    } catch {
      sessionStorage.removeItem('usuarios-table-selected-rows')
      sessionStorage.removeItem('usuarios-table-selected-rows-pending')
    }
  }, [])

  // Cuando cambia users, aplica la selección pendiente (ids -> rows)
  useEffect(() => {
    const pending = sessionStorage.getItem('usuarios-table-selected-rows-pending')
    if (!pending) return
    try {
      const parsed = JSON.parse(pending)
      const ids = (parsed.ids || []).map(normId).filter(Boolean)
      if (!ids.length) {
        setSelectedUsers([])
        sessionStorage.removeItem('usuarios-table-selected-rows-pending')
        return
      }
      const map = new Map(users.map((u) => [normId(u?.id), u]))
      const rows = ids.map((id) => map.get(id)).filter(Boolean)
      setSelectedUsers(rows)
      sessionStorage.removeItem('usuarios-table-selected-rows-pending')
    } catch {
      sessionStorage.removeItem('usuarios-table-selected-rows-pending')
    }
  }, [users])

  // Limpia selección si ya no existe en la data
  useEffect(() => {
    if (!users?.length) {
      if (selectedUsers?.length) setSelectedUsers([])
      return
    }
    const idsSet = new Set(allRowIds)
    const filtered = (selectedUsers || []).filter((u) => idsSet.has(normId(u?.id)))
    if (filtered.length !== (selectedUsers || []).length) setSelectedUsers(filtered)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users])

  // Persistir IDs
  useEffect(() => {
    sessionStorage.setItem(
      'usuarios-table-selected-rows',
      JSON.stringify({
        selectedRowIds,
        allRowsSelected,
      })
    )
  }, [selectedRowIds, allRowsSelected])

  // ✅ Estilos duros para clavar el ancho (header + body)
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
      { nombrevar: 'codigo', header: 'Código', filterPlaceholder: 'Buscar por código' },
      { nombrevar: 'nombre', header: 'Nombre', filterPlaceholder: 'Buscar por nombre' },
      { nombrevar: 'correo', header: 'Correo', filterPlaceholder: 'Buscar por correo' },
      { nombrevar: 'telefono', header: 'Teléfono', filterPlaceholder: 'Buscar por teléfono' },
      { nombrevar: 'cargo', header: 'Cargo', filterPlaceholder: 'Buscar por cargo' },
      { nombrevar: 'activo', header: 'Estado', filterPlaceholder: 'Filtrar estado' },
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

  const activoFilterElement = (options) => {
    const items = [
      { label: 'Todos', value: null },
      { label: 'Activo', value: true },
      { label: 'Inactivo', value: false },
    ]

    return (
      <Dropdown
        value={options.value}
        options={items}
        onChange={(e) => options.filterCallback(e.value, options.index)}
        placeholder="Selecciona"
        className="p-column-filter"
        style={{ width: '100%' }}
      />
    )
  }

  // ---------------- Row click -> detalles ----------------
  const [selectedUserId, setSelectedUserId] = useState(null)
  const [showDetailsModal, setShowDetailsModal] = useState(false)

  const handleRowClick = (event) => {
    const t = event?.originalEvent?.target
    // ✅ No abrir modal si hicieron click en el checkbox/columna de selección
    if (t?.closest?.('.p-checkbox') || t?.closest?.('.row-selection-column')) return

    const id = event?.data?.id
    if (id == null) return

    setSelectedUserId(id)
    setShowDetailsModal(true)

    if (typeof onSelect === 'function') onSelect(id)
  }

  const handleUserUpdated = () => {
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Actualizado', detail: 'Usuario actualizado correctamente', life: 2500 })
  }

  const handleUserDeleted = () => {
    setShowDetailsModal(false)
    setSelectedUserId(null)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Eliminado', detail: 'Usuario eliminado', life: 2500 })
  }

  // ---------------- Header (de la tabla) ----------------
  const dataLength = users?.length ?? 0

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

        <button className="users-circle users-circle--excel" type="button" title="Excel" onClick={onExportExcel} disabled={!onExportExcel}>
          <i className="pi pi-file-excel" />
        </button>

        <button className="users-circle users-circle--pdf" type="button" title="PDF" onClick={onExportPdf} disabled={!onExportPdf}>
          <i className="pi pi-file-pdf" />
        </button>
      </div>
    </div>
  )

  // ---------------- Create modal ----------------
  const [showCreateModal, setShowCreateModal] = useState(false)
  const handleUserCreated = () => {
    setShowCreateModal(false)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Éxito', detail: 'Usuario creado correctamente', life: 2500 })
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
          value={users}
          dataKey="id"
          header={header}
          className="users-datatable"
          tableStyle={{ width: '100%' }}
          emptyMessage="No se encontraron usuarios"
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
          globalFilterFields={['codigo', 'nombre', 'correo', 'telefono', 'cargo', 'activo']}
          stateStorage="session"
          stateKey="usuarios-table-state"
          reorderableColumns
          onColReorder={handleOrderChange}
          resizableColumns
          columnResizeMode="fit"
          onRowClick={handleRowClick}
          rowClassName={(rowData) => (selectedRowIds.includes(normId(rowData?.id)) ? 'selected-row-shadow' : '')}
          // ✅ selección nativa
          selectionMode="checkbox"
          selection={selectedUsers}
          onSelectionChange={(e) => {
            const value = e.value || []
            setSelectedUsers(value)
            const ids = value.map((user) => normId(user?.id)).filter(Boolean)
            console.log('Usuarios seleccionados:', ids)
          }}
        >
          {/* ✅ Columna de selección nativa (checkbox + header checkbox) */}
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

            let filterMatchMode = undefined
            let filterElement = undefined
            let showFilterMatchModes = true
            let showFilterOperator = true

            switch (column.nombrevar) {
              case 'codigo':
                bodyTemplate = (rowData) => codigoBodyTemplate(rowData)
                break
              case 'nombre':
                bodyTemplate = (rowData) => nombreBodyTemplate(rowData)
                break
              case 'activo':
                bodyTemplate = (rowData) => activoBodyTemplate(rowData)
                className = 'column-max-min-width--small'
                filterMatchMode = FilterMatchMode.EQUALS
                filterElement = (options) => activoFilterElement(options)
                showFilterMatchModes = false
                showFilterOperator = false
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
                filter
                filterField={column.nombrevar}
                filterPlaceholder={column.filterPlaceholder}
                filterClear={filterClearTemplate}
                filterApply={filterApplyTemplate}
                className={className}
                filterMatchMode={filterMatchMode}
                filterElement={filterElement}
                showFilterMatchModes={showFilterMatchModes}
                showFilterOperator={showFilterOperator}
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

        <CreateUsuario
          open={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onCreated={handleUserCreated}
          token={token}
          onError={showErrorToast}
        />

        <UsersDetails
          open={showDetailsModal}
          userId={selectedUserId}
          token={token}
          onClose={() => setShowDetailsModal(false)}
          onUpdated={handleUserUpdated}
          onDeleted={handleUserDeleted}
          onError={showErrorToast}
        />
      </div>
    </div>
  )
}

export default UsersTable
