import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FilterMatchMode, FilterOperator } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { OverlayPanel } from 'primereact/overlaypanel'
import { Checkbox } from 'primereact/checkbox'
import { Button } from 'primereact/button'

import CreateCliente from '../CreateCliente/CreateCliente'
import ClienteDetails from '../ClienteDetails/ClienteDetails'
import '../../admin/UsersTable/UsersTable.css'
import { API_URL, authFetch } from '../../../../utils/api'
import { buildFileName, exportToExcel, exportToPdf } from '../../../../utils/exportUtils'

const normId = (value) => (value == null ? null : String(value))
const isCheckboxSelection = (event) => {
  if (event?.type === 'checkbox') return true
  const target = event?.originalEvent?.target
  if (!target) return true
  if (target.type === 'checkbox') return true
  return Boolean(target.closest?.('.p-checkbox, .p-checkbox-box, .p-checkbox-icon, .p-checkbox-input'))
}

function ClientesTable({ token, onSelect }) {
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

  const [clients, setClients] = useState([])
  const [allClients, setAllClients] = useState([])
  const [loading, setLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const normalizeList = useCallback(
    (list) =>
      list.map((client) => ({
        ...client,
        autos_count: Array.isArray(client?.autos) ? client.autos.length : 0,
      })),
    []
  )

  const normalizeValue = (value) => String(value ?? '').trim().toLowerCase()
  const contains = (fieldValue, target) => {
    const needle = normalizeValue(target)
    if (!needle) return true
    return normalizeValue(fieldValue).includes(needle)
  }

  const applySearchFilters = useCallback(
    (list, criteria) =>
      list.filter((row) => (
        contains(row?.nombres, criteria.nombres) &&
        contains(row?.apellidos, criteria.apellidos) &&
        contains(row?.cedula_ruc, criteria.cedula_ruc) &&
        contains(row?.correo, criteria.correo) &&
        contains(row?.telefono, criteria.telefono) &&
        contains(row?.direccion, criteria.direccion)
      )),
    []
  )

  const fetchClients = useCallback(async (criteria) => {
    setLoading(true)
    setError(null)
    try {
      const list = []
      let url = `${API_URL}/solicitudes/clientes/`

      while (url) {
        const res = await authFetch(url, {}, token)
        if (!res.ok) throw new Error('No se pudo obtener la lista de clientes.')

        const data = await res.json()
        if (Array.isArray(data)) {
          list.push(...data)
          url = null
        } else {
          const pageList = Array.isArray(data?.results) ? data.results : []
          list.push(...pageList)
          url = data?.next || null
        }
      }

      const normalized = normalizeList(list)
      setClients(normalized)
      setAllClients(normalized)
      if (criteria) {
        const filtered = applySearchFilters(normalized, criteria)
        setClients(filtered)
        return filtered
      }
      return normalized
    } catch (err) {
      const msg = err?.message || 'Ocurrio un error al cargar los clientes.'
      setError(msg)
      toast.current?.show({ severity: 'warn', summary: 'Aviso', detail: msg, life: 3500 })
    } finally {
      setLoading(false)
      setIsRefreshing(false)
    }
  }, [token, normalizeList, applySearchFilters])

  const refreshData = () => {
    if (!lastSearchRef.current) {
      setShowSearchModal(true)
      return
    }
    setIsRefreshing(true)
    fetchClients(lastSearchRef.current)
  }

  // ---------------- Filters ----------------
  const [filters, setFilters] = useState(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')

  const initFilters = () => {
    setFilters({
      global: { value: null, matchMode: FilterMatchMode.CONTAINS },
      nombres: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      apellidos: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      cedula_ruc: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      autos_count: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      correo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
      telefono: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
      direccion: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
    })
    setGlobalFilterValue('')
  }

  useEffect(() => {
    const savedState = sessionStorage.getItem('clientes-table-state')
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

  const clearFilter = () => {
    initFilters()
    setSearchCriteria(initialSearchCriteria)
    lastSearchRef.current = null
    setClients([])
    setAllClients([])
  }

  const initialSearchCriteria = {
    nombres: '',
    apellidos: '',
    cedula_ruc: '',
    correo: '',
    telefono: '',
    direccion: '',
  }

  const [searchCriteria, setSearchCriteria] = useState(initialSearchCriteria)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const lastSearchRef = useRef(null)
  const [isSearchMaximized, setIsSearchMaximized] = useState(false)
  const [searchPosition, setSearchPosition] = useState({ x: 0, y: 0 })
  const [searchSize, setSearchSize] = useState({ width: 720, height: 520 })
  const searchModalRef = useRef(null)
  const searchDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const searchResize = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const searchSizeRef = useRef(searchSize)
  const searchPosRef = useRef(searchPosition)
  const searchRestoreRef = useRef(null)
  const SEARCH_MIN_WIDTH = 640
  const SEARCH_MIN_HEIGHT = 480
  const SEARCH_PADDING = 12

  const handleSearchInputChange = (event) => {
    const { name, value } = event.target
    setSearchCriteria((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleSearchSubmit = async (event) => {
    event.preventDefault()
    lastSearchRef.current = { ...searchCriteria }
    setShowSearchModal(false)
    setIsRefreshing(true)
    await fetchClients(lastSearchRef.current)
  }

  const onGlobalFilterChange = (e) => {
    const value = e.target.value
    const nextFilters = { ...filters }
    nextFilters.global = { ...nextFilters.global, value }
    setFilters(nextFilters)
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
    () => (selectedRows || []).map((row) => normId(row?.id)).filter(Boolean),
    [selectedRows]
  )

  const allRowIds = useMemo(() => clients.map((row) => normId(row?.id)).filter(Boolean), [clients])
  const allRowsSelected = allRowIds.length > 0 && selectedRowIds.length === allRowIds.length

  useEffect(() => {
    const saved = sessionStorage.getItem('clientes-table-selected-rows')
    if (!saved) return
    try {
      const parsed = JSON.parse(saved)
      const ids = (parsed.selectedRowIds || []).map(normId).filter(Boolean)
      sessionStorage.setItem('clientes-table-selected-rows-pending', JSON.stringify({ ids }))
    } catch {
      sessionStorage.removeItem('clientes-table-selected-rows')
      sessionStorage.removeItem('clientes-table-selected-rows-pending')
    }
  }, [])

  useEffect(() => {
    const pending = sessionStorage.getItem('clientes-table-selected-rows-pending')
    if (!pending) return
    try {
      const parsed = JSON.parse(pending)
      const ids = (parsed.ids || []).map(normId).filter(Boolean)
      if (!ids.length) {
        setSelectedRows([])
        sessionStorage.removeItem('clientes-table-selected-rows-pending')
        return
      }
      const map = new Map(clients.map((row) => [normId(row?.id), row]))
      const rows = ids.map((id) => map.get(id)).filter(Boolean)
      setSelectedRows(rows)
      sessionStorage.removeItem('clientes-table-selected-rows-pending')
    } catch {
      sessionStorage.removeItem('clientes-table-selected-rows-pending')
    }
  }, [clients])

  useEffect(() => {
    if (!clients?.length) {
      if (selectedRows?.length) setSelectedRows([])
      return
    }
    const idsSet = new Set(allRowIds)
    const filtered = (selectedRows || []).filter((row) => idsSet.has(normId(row?.id)))
    if (filtered.length !== (selectedRows || []).length) setSelectedRows(filtered)
  }, [clients])

  useEffect(() => {
    sessionStorage.setItem(
      'clientes-table-selected-rows',
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
      { nombrevar: 'nombres', header: 'Nombres', filterPlaceholder: 'Buscar por nombres' },
      { nombrevar: 'apellidos', header: 'Apellidos', filterPlaceholder: 'Buscar por apellidos' },
      { nombrevar: 'cedula_ruc', header: 'Cedula/RUC', filterPlaceholder: 'Buscar por cedula/RUC' },
      { nombrevar: 'autos_count', header: 'Autos', filterPlaceholder: 'Filtrar por autos' },
      { nombrevar: 'correo', header: 'Correo', filterPlaceholder: 'Buscar por correo' },
      { nombrevar: 'telefono', header: 'Telefono', filterPlaceholder: 'Buscar por telefono' },
      { nombrevar: 'direccion', header: 'Direccion', filterPlaceholder: 'Buscar por direccion' },
    ],
    []
  )

  const [selectedColumns, setSelectedColumns] = useState(columnsData)
  const selectedColumnsRef = useRef(selectedColumns)
  const [processedRows, setProcessedRows] = useState(null)

  useEffect(() => {
    selectedColumnsRef.current = selectedColumns
  }, [selectedColumns])

  useEffect(() => {
    const stored = localStorage.getItem('clientes-table-columns')
    if (stored) setSelectedColumns(JSON.parse(stored))
    return () => {
      localStorage.setItem('clientes-table-columns', JSON.stringify(selectedColumnsRef.current))
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
    const sorted = columnOrder.map((field) => selectedColumns.find((c) => c.nombrevar === field)).filter(Boolean)
    setSelectedColumns(sorted)
  }

  const exportColumns = useMemo(
    () => selectedColumns.map((col) => ({ key: col.nombrevar, header: col.header })),
    [selectedColumns]
  )

  const getExportValue = useCallback((row, field) => {
    if (field === 'autos_count') {
      const num = Number(row?.[field])
      return Number.isFinite(num) ? String(num) : ''
    }
    return row?.[field] ?? ''
  }, [])

  const getRowsToExport = useCallback(() => {
    if (selectedRows?.length) return selectedRows
    return processedRows === null ? clients : processedRows
  }, [processedRows, selectedRows, clients])

  const notifyExportWarning = useCallback((detail) => {
    toast.current?.show({ severity: 'warn', summary: 'Sin datos', detail, life: 3000 })
  }, [])

  const handleExportExcel = useCallback(async () => {
    if (!exportColumns.length) {
      notifyExportWarning('Selecciona al menos una columna para exportar.')
      return
    }
    const baseRows = processedRows === null ? clients : processedRows
    if (!selectedRows?.length) {
      notifyExportWarning(baseRows.length ? 'Debe seleccionar al menos una fila para generar el reporte.' : 'No hay registros para exportar.')
      return
    }
    const rows = selectedRows
    await exportToExcel({
      rows,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('clientes'),
    })
  }, [clients, exportColumns, getExportValue, notifyExportWarning, processedRows, selectedRows])

  const handleExportPdf = useCallback(async () => {
    if (!exportColumns.length) {
      notifyExportWarning('Selecciona al menos una columna para exportar.')
      return
    }
    const baseRows = processedRows === null ? clients : processedRows
    if (!selectedRows?.length) {
      notifyExportWarning(baseRows.length ? 'Debe seleccionar al menos una fila para generar el reporte.' : 'No hay registros para exportar.')
      return
    }
    const rows = selectedRows
    await exportToPdf({
      rows,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('clientes'),
      title: 'Reporte de clientes',
    })
  }, [clients, exportColumns, getExportValue, notifyExportWarning, processedRows, selectedRows])

  // ---------------- Body templates ----------------
  const cellWithTooltip = (rowData, field) => {
    const content = rowData?.[field] ?? '-'
    const textColor = content === '-' ? '#9ca3af' : undefined
    return (
      <span className="cell-tooltip" data-pr-tooltip={String(content)} style={{ color: textColor }}>
        {String(content)}
      </span>
    )
  }

  const nombresBodyTemplate = (rowData) => {
    const name = rowData?.nombres ?? '-'
    return (
      <span className="cell-tooltip" data-pr-tooltip={name}>
        {name}
      </span>
    )
  }

  const numericBodyTemplate = (rowData, field) => {
    const value = Number(rowData?.[field])
    if (!Number.isFinite(value)) return <span className="cell-tooltip">-</span>
    const text = String(value)
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
    const target = event?.originalEvent?.target
    if (target?.closest?.('.p-checkbox') || target?.closest?.('.row-selection-column')) return

    const id = event?.data?.id
    if (id == null) return

    setSelectedId(id)
    setShowDetailsModal(true)

    if (typeof onSelect === 'function') onSelect(id)
  }

  const handleUpdated = () => {
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Actualizado', detail: 'Cliente actualizado correctamente', life: 2500 })
  }

  const handleDeleted = () => {
    setShowDetailsModal(false)
    setSelectedId(null)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Eliminado', detail: 'Cliente eliminado', life: 2500 })
  }

  // ---------------- Header ----------------
  const dataLength = clients?.length ?? 0
  const emptyMessage = lastSearchRef.current
    ? 'No se encontraron clientes'
    : 'Realice una búsqueda para ver la información. Si quiere ver toda la información, haga la búsqueda sin aplicar ningún filtro.'

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

        <button className="rounded-icon-btn" type="button" onClick={(e) => opColumns.current?.toggle(e)} title="Campos">
          <i className="pi pi-sliders-h" />
        </button>
      </div>

      <div className="users-header__right">
        <span className="users-header__count">Reg. {dataLength}</span>

        <button className="users-circle users-circle--excel" type="button" title="Excel" onClick={handleExportExcel}>
          <i className="pi pi-file-excel" />
        </button>

        <button className="users-circle users-circle--pdf" type="button" title="PDF" onClick={handleExportPdf}>
          <i className="pi pi-file-pdf" />
        </button>
      </div>
    </div>
  )

  // ---------------- Create modal ----------------
  const [showCreateModal, setShowCreateModal] = useState(false)
  const handleCreated = () => {
    setShowCreateModal(false)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Exito', detail: 'Cliente creado correctamente', life: 2500 })
  }

  const focusSearch = () => setShowSearchModal(true)
  const hasSearched = Boolean(lastSearchRef.current)

  useEffect(() => {
    searchSizeRef.current = searchSize
  }, [searchSize])

  useEffect(() => {
    searchPosRef.current = searchPosition
  }, [searchPosition])

  useLayoutEffect(() => {
    if (!showSearchModal) return
    setIsSearchMaximized(false)
    searchRestoreRef.current = null
    const width = Math.min(720, window.innerWidth - SEARCH_PADDING * 2)
    const height = Math.min(520, window.innerHeight - SEARCH_PADDING * 2)
    setSearchSize({ width, height })
    setSearchPosition({
      x: Math.max((window.innerWidth - width) / 2, SEARCH_PADDING),
      y: Math.max((window.innerHeight - height) / 2, SEARCH_PADDING),
    })
  }, [showSearchModal])

  const handleSearchMouseDown = (event) => {
    if (isSearchMaximized) return
    if (!searchModalRef.current) return
    const rect = searchModalRef.current.getBoundingClientRect()
    searchDrag.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }

  const handleSearchResizeMouseDown = (event) => {
    if (isSearchMaximized) return
    event.preventDefault()
    event.stopPropagation()
    searchResize.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: searchSizeRef.current.width,
      startHeight: searchSizeRef.current.height,
    }

    const handleResizeMove = (moveEvent) => {
      if (!searchResize.current.active) return
      const deltaX = moveEvent.clientX - searchResize.current.startX
      const deltaY = moveEvent.clientY - searchResize.current.startY
      const maxWidth = Math.max(SEARCH_MIN_WIDTH, window.innerWidth - searchPosRef.current.x - SEARCH_PADDING)
      const maxHeight = Math.max(SEARCH_MIN_HEIGHT, window.innerHeight - searchPosRef.current.y - SEARCH_PADDING)
      const width = Math.min(Math.max(searchResize.current.startWidth + deltaX, SEARCH_MIN_WIDTH), maxWidth)
      const height = Math.min(Math.max(searchResize.current.startHeight + deltaY, SEARCH_MIN_HEIGHT), maxHeight)
      setSearchSize({ width, height })
    }

    const handleResizeUp = () => {
      searchResize.current.active = false
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }

    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!searchDrag.current.active) return
      event.preventDefault()
      const newX = event.clientX - searchDrag.current.offsetX
      const newY = event.clientY - searchDrag.current.offsetY
      const maxX = window.innerWidth - searchSizeRef.current.width - SEARCH_PADDING
      const maxY = window.innerHeight - searchSizeRef.current.height - SEARCH_PADDING
      setSearchPosition({
        x: Math.min(Math.max(newX, SEARCH_PADDING), Math.max(maxX, SEARCH_PADDING)),
        y: Math.min(Math.max(newY, SEARCH_PADDING), Math.max(maxY, SEARCH_PADDING)),
      })
    }

    const handleMouseUp = () => {
      searchDrag.current.active = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  useEffect(() => {
    const handleWindowResize = () => {
      if (!showSearchModal) return
      if (isSearchMaximized) {
        setSearchSize({
          width: Math.max(0, window.innerWidth - SEARCH_PADDING * 2),
          height: Math.max(0, window.innerHeight - SEARCH_PADDING * 2),
        })
        setSearchPosition({ x: SEARCH_PADDING, y: SEARCH_PADDING })
        return
      }
      setSearchSize((prev) => {
        const width = Math.min(Math.max(prev.width, SEARCH_MIN_WIDTH), window.innerWidth - SEARCH_PADDING * 2)
        const height = Math.min(Math.max(prev.height, SEARCH_MIN_HEIGHT), window.innerHeight - SEARCH_PADDING * 2)
        setSearchPosition((prevPos) => ({
          x: Math.min(Math.max(prevPos.x, SEARCH_PADDING), Math.max(window.innerWidth - width - SEARCH_PADDING, SEARCH_PADDING)),
          y: Math.min(Math.max(prevPos.y, SEARCH_PADDING), Math.max(window.innerHeight - height - SEARCH_PADDING, SEARCH_PADDING)),
        }))
        return { width, height }
      })
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [isSearchMaximized, showSearchModal])

  const toggleSearchMaximize = () => {
    if (isSearchMaximized) {
      const restore = searchRestoreRef.current
      if (restore) {
        setSearchSize(restore.size)
        setSearchPosition(restore.position)
      }
      setIsSearchMaximized(false)
      return
    }
    searchRestoreRef.current = {
      size: searchSizeRef.current,
      position: searchPosRef.current,
    }
    setSearchSize({
      width: Math.max(0, window.innerWidth - SEARCH_PADDING * 2),
      height: Math.max(0, window.innerHeight - SEARCH_PADDING * 2),
    })
    setSearchPosition({ x: SEARCH_PADDING, y: SEARCH_PADDING })
    setIsSearchMaximized(true)
  }

  return (
    <div className="users-page">
      <Tooltip position="top" showDelay={1800} target=".cell-tooltip" style={{ maxWidth: '340px' }} />
      <Toast ref={toast} />

      <div className="users-page__top">
        <div className="users-page__actions">
          <Button label="Crear" icon="pi pi-plus" className="users-topbtn users-topbtn--create" onClick={() => setShowCreateModal(true)} type="button" />
          <Button label="Buscar" icon="pi pi-search" className="users-topbtn users-topbtn--search" onClick={focusSearch} type="button" />
        </div>
      </div>

      <div className="users-table users-table--card users-table--compact">
        {!hasSearched ? (
          <div className="users-search-empty-state">
            <div className="users-search-empty-state__content">
              <h2 className="users-search-empty-state__title">Clientes</h2>
              <div className="users-search-empty-state__hint">
                <span className="users-search-empty-state__hint-text">Para iniciar, seleccione</span>
                <Button
                  label="Buscar"
                  icon="pi pi-search"
                  className="users-topbtn users-topbtn--search users-search-empty-state__btn"
                  onClick={focusSearch}
                  type="button"
                />
              </div>
            </div>
          </div>
        ) : (
          <>
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
          value={clients}
          dataKey="id"
          header={header}
          className="users-datatable users-datatable--compact"
          tableStyle={{ width: '100%' }}
          emptyMessage={emptyMessage}
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
          onValueChange={(value) => setProcessedRows(value ?? [])}
          globalFilterFields={['nombres', 'apellidos', 'cedula_ruc', 'autos_count', 'correo', 'telefono', 'direccion']}
          stateStorage="session"
          stateKey="clientes-table-state"
          reorderableColumns
          onColReorder={handleOrderChange}
          resizableColumns
          columnResizeMode="fit"
          onRowClick={handleRowClick}
          rowClassName={(rowData) => (selectedRowIds.includes(normId(rowData?.id)) ? 'selected-row-shadow' : '')}
          selectionMode="multiple"
          selection={selectedRows}
          onSelectionChange={(e) => {
            if (!isCheckboxSelection(e)) return
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
              case 'nombres':
                bodyTemplate = (rowData) => nombresBodyTemplate(rowData)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                break
              case 'apellidos':
                bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                break
              case 'autos_count':
                bodyTemplate = (rowData) => numericBodyTemplate(rowData, column.nombrevar)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                className = 'column-max-min-width--small'
                break
              case 'cedula_ruc':
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

        <OverlayPanel ref={opColumns} className="table-options-list">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <strong>Campos</strong>
          </div>

          {columnsData.map((col) => (
            <div key={col.nombrevar} className="p-field-checkbox" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
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
        </OverlayPanel>
          </>
        )}

      </div>

      <CreateCliente
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleCreated}
        token={token}
        onError={showErrorToast}
      />

      <ClienteDetails
        open={showDetailsModal}
        clienteId={selectedId}
        onClose={() => setShowDetailsModal(false)}
        token={token}
        onUpdated={handleUpdated}
        onDeleted={handleDeleted}
        onError={showErrorToast}
      />

      {showSearchModal && (
        <div className="create-user__overlay" role="dialog" aria-modal="true" style={{ padding: `${SEARCH_PADDING}px` }}>
          <div
            className="create-user__modal"
            ref={searchModalRef}
            style={{
              top: searchPosition.y,
              left: searchPosition.x,
              width: searchSize.width,
              height: searchSize.height,
              maxWidth: `calc(100vw - ${SEARCH_PADDING * 2}px)`,
              maxHeight: `calc(100vh - ${SEARCH_PADDING * 2}px)`,
            }}
          >
            <header className="create-user__header" onMouseDown={handleSearchMouseDown}>
              <div className="create-user__header-text">
                <h3>Buscar clientes</h3>
              </div>
              <div className="create-user__header-actions">
                <button
                  type="button"
                  className="create-user__icon-button create-user__icon-button--maximize"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={toggleSearchMaximize}
                  aria-label={isSearchMaximized ? 'Restaurar' : 'Maximizar'}
                >
                  {isSearchMaximized ? '🗕' : '🗖'}
                </button>
                <button
                  type="button"
                  className="create-user__icon-button"
                  onClick={() => setShowSearchModal(false)}
                  aria-label="Cerrar"
                >
                  ×
                </button>
              </div>
            </header>

            <form className="create-user__form" onSubmit={handleSearchSubmit}>
              <div className="create-user__body">
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Filtros</p>
                      <h4>Busqueda avanzada</h4>
                    </div>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field">
                      <span>Nombres</span>
                      <input name="nombres" type="text" placeholder="Ej: Juan" value={searchCriteria.nombres} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Apellidos</span>
                      <input name="apellidos" type="text" placeholder="Ej: Perez" value={searchCriteria.apellidos} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Cedula/RUC</span>
                      <input name="cedula_ruc" type="text" placeholder="Ej: 1712345678" value={searchCriteria.cedula_ruc} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Correo</span>
                      <input name="correo" type="text" placeholder="Ej: cliente@correo.com" value={searchCriteria.correo} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Telefono</span>
                      <input name="telefono" type="text" placeholder="Ej: 0991234567" value={searchCriteria.telefono} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field create-user__field--full">
                      <span>Direccion</span>
                      <input name="direccion" type="text" placeholder="Ej: Av. Principal 123" value={searchCriteria.direccion} onChange={handleSearchInputChange} />
                    </label>
                  </div>
                </section>
              </div>

              <div className="create-user__footer">
                <div className="user-details__footer-left">
                  <button
                    type="button"
                    className="create-user__action"
                    onClick={() => setSearchCriteria(initialSearchCriteria)}
                  >
                    Limpiar filtros
                  </button>
                  <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setShowSearchModal(false)}>
                    Cancelar
                  </button>
                </div>
                <div className="user-details__footer-right">
                  <button type="submit" className="create-user__action create-user__action--primary">
                    Buscar
                  </button>
                </div>
              </div>
            </form>
            <button
              type="button"
              aria-label="Cambiar tamano de ventana"
              className="create-user__resize-handle"
              onMouseDown={handleSearchResizeMouseDown}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default ClientesTable
