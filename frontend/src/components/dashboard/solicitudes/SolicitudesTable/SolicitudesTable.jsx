import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FilterMatchMode, FilterOperator } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { OverlayPanel } from 'primereact/overlaypanel'
import { Checkbox } from 'primereact/checkbox'
import { Button } from 'primereact/button'

import CreateSolicitud from '../CreateSolicitud/CreateSolicitud'
import SolicitudDetails from '../SolicitudDetails/SolicitudDetails'
import '../../admin/UsersTable/UsersTable.css'
import { API_URL, authFetch } from '../../../../utils/api'
import { buildFileName, exportToExcel, exportToPdf } from '../../../../utils/exportUtils'
import {
  buildPrimeColumnFiltersPayload,
  buildPrimeOrdering,
  getPrimeGlobalFilterValue,
} from '../../../../utils/primeTableQuery'

const normId = (value) => (value == null ? null : String(value))
const BULK_SELECT_CONFIRM_THRESHOLD = 1000
const SOLICITUD_FILTER_FIELDS = [
  'fecha',
  'cliente_nombre',
  'cedula_ruc',
  'sucursal_nombre',
  'producto_solicitado_nombre',
  'producto_solicitado_descripcion',
  'descripcion_general',
  'producto_conseguido',
  'cantidad',
  'conseguido_label',
]
const SOLICITUD_FILTER_DEFAULT_MODES = {
  fecha: FilterMatchMode.CONTAINS,
  cliente_nombre: FilterMatchMode.CONTAINS,
  cedula_ruc: FilterMatchMode.STARTS_WITH,
  sucursal_nombre: FilterMatchMode.CONTAINS,
  producto_solicitado_nombre: FilterMatchMode.CONTAINS,
  producto_solicitado_descripcion: FilterMatchMode.CONTAINS,
  descripcion_general: FilterMatchMode.CONTAINS,
  producto_conseguido: FilterMatchMode.CONTAINS,
  cantidad: FilterMatchMode.EQUALS,
  conseguido_label: FilterMatchMode.CONTAINS,
}
const SOLICITUD_ORDERING_MAP = {
  fecha: 'fecha',
  cliente_nombre: 'cliente_nombre_text',
  cedula_ruc: 'cliente__cedula_ruc',
  sucursal_nombre: 'sucursal__nombre',
  producto_solicitado_nombre: 'producto_referencia_text',
  producto_solicitado_descripcion: 'producto_solicitado_descripcion_text',
  descripcion_general: 'descripcion_general',
  producto_conseguido: 'producto_conseguido_text',
  cantidad: 'cantidad',
  conseguido_label: 'conseguido_label_text',
}
const createBulkCancelError = () => {
  const err = new Error('Seleccion global cancelada.')
  err.name = 'AbortError'
  return err
}
const isCheckboxSelection = (event) => {
  if (event?.type === 'checkbox') return true
  const target = event?.originalEvent?.target
  if (!target) return true
  if (target.type === 'checkbox') return true
  return Boolean(target.closest?.('.p-checkbox, .p-checkbox-box, .p-checkbox-icon, .p-checkbox-input'))
}

function SolicitudesTable({ token, onSelect }) {
  const toast = useRef(null)
  const opColumns = useRef(null)

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
  const [totalRecords, setTotalRecords] = useState(0)
  const [pageFirst, setPageFirst] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [loading, setLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [sucursales, setSucursales] = useState([])
  const [showBulkSelectConfirm, setShowBulkSelectConfirm] = useState(false)
  const [showBulkSelectProgress, setShowBulkSelectProgress] = useState(false)
  const [bulkSelectProgress, setBulkSelectProgress] = useState({
    loaded: 0,
    total: 0,
    percent: 0,
  })
  const [bulkModalPosition, setBulkModalPosition] = useState({ x: 0, y: 0 })
  const bulkModalRef = useRef(null)
  const bulkModalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const bulkSelectAbortRef = useRef(null)
  const bulkSelectCancelledRef = useRef(false)
  const [sortField, setSortField] = useState(null)
  const [sortOrder, setSortOrder] = useState(null)
  const [filters, setFilters] = useState(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')

  const fetchSucursales = useCallback(async () => {
    if (!token) return
    try {
      const response = await authFetch(
        `${API_URL}/inventario/sucursales/?modulo=solicitudes&page_size=200`,
        {},
        token
      )
      if (!response.ok) throw new Error('No se pudieron cargar las sucursales.')
      const data = await response.json()
      const list = Array.isArray(data) ? data : data?.results || []
      setSucursales(list)
    } catch {
      setSucursales([])
    }
  }, [token])

  const normalizeList = useCallback(
    (list) =>
      list.map((item) => ({
        ...item,
        cliente_nombre:
          item?.cliente_nombre ||
          item?.cliente_data?.nombre_completo ||
          `${item?.cliente_data?.nombres || ''} ${item?.cliente_data?.apellidos || ''}`.trim() ||
          item?.cliente ||
          '-',
        cedula_ruc: item?.cliente_data?.cedula_ruc || '-',
        sucursal_nombre: item?.sucursal_data?.nombre || item?.sucursal || '-',
        producto_solicitado_nombre:
          item?.producto_solicitado_data?.nombre || item?.producto_referencia || '-',
        producto_solicitado_descripcion:
          item?.producto_solicitado_data?.descripcion || '-',
        descripcion_general: item?.descripcion_general || '-',
        producto_conseguido:
          item?.producto_resuelto_data
            ? `${item.producto_resuelto_data.codigo || ''} ${item.producto_resuelto_data.nombre || ''}`.trim()
            : '-',
        conseguido_label: item?.conseguido ? 'Si' : 'No',
      })),
    []
  )

  const buildClientsListUrl = useCallback((criteria, options = {}) => {
    const params = new URLSearchParams()
    const page = Number(options?.page) || 1
    const rows = Number(options?.rows) || 25
    const tableFilters = options?.tableFilters
    const tableSortField = options?.tableSortField
    const tableSortOrder = options?.tableSortOrder

    params.set('page', String(page))
    params.set('page_size', String(rows))

    const addIfPresent = (key, value) => {
      const parsed = String(value ?? '').trim()
      if (parsed) params.set(key, parsed)
    }

    addIfPresent('cedula_ruc', criteria?.cedula_ruc)
    addIfPresent('sucursal_id', criteria?.sucursal_id)
    addIfPresent('fecha_desde', criteria?.fecha_desde)
    addIfPresent('fecha_hasta', criteria?.fecha_hasta)
    addIfPresent('conseguido', criteria?.conseguido)

    const criteriaSearch = [criteria?.cliente_nombre, criteria?.producto]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
      .join(' ')
    const globalSearch = getPrimeGlobalFilterValue(tableFilters)
    const mergedSearch = [criteriaSearch, globalSearch].filter(Boolean).join(' ').trim()
    if (mergedSearch) params.set('search', mergedSearch)

    const columnFilters = buildPrimeColumnFiltersPayload(tableFilters, {
      allowedFields: SOLICITUD_FILTER_FIELDS,
      defaultMatchModes: SOLICITUD_FILTER_DEFAULT_MODES,
    })
    if (columnFilters) params.set('column_filters', JSON.stringify(columnFilters))

    const ordering = buildPrimeOrdering(tableSortField, tableSortOrder, SOLICITUD_ORDERING_MAP)
    if (ordering) params.set('ordering', ordering)

    return `${API_URL}/solicitudes/solicitudes/?${params.toString()}`
  }, [])

  const fetchClients = useCallback(
    async (criteria, page = 1, rows = pageSize, options = {}) => {
      setLoading(true)
      setError(null)
      try {
        const tableFilters = options?.tableFilters ?? filters
        const tableSortField = options?.tableSortField ?? sortField
        const tableSortOrder = options?.tableSortOrder ?? sortOrder
        const url = buildClientsListUrl(criteria, {
          page,
          rows,
          tableFilters,
          tableSortField,
          tableSortOrder,
        })
        const res = await authFetch(url, {}, token)
        if (!res.ok) throw new Error('No se pudo obtener la lista de solicitudes.')

        const data = await res.json()
        const count = Array.isArray(data) ? data.length : Number(data?.count ?? 0)
        const list = Array.isArray(data) ? data : data?.results || []
        const normalized = normalizeList(list)
        setClients(normalized)
        setTotalRecords(count)
        setPageFirst(Math.max(0, (page - 1) * rows))
        setPageSize(rows)
        return normalized
      } catch (err) {
        const msg = err?.message || 'Ocurrió un error al cargar las solicitudes.'
        setError(msg)
        setClients([])
        setTotalRecords(0)
        toast.current?.show({ severity: 'warn', summary: 'Aviso', detail: msg, life: 3500 })
      } finally {
        setLoading(false)
        setIsRefreshing(false)
      }
    },
    [token, normalizeList, pageSize, buildClientsListUrl, filters, sortField, sortOrder]
  )

  const fetchAllClients = useCallback(
    async (criteria, options = {}) => {
      const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null
      const signal = options?.signal
      const isCancelled = typeof options?.isCancelled === 'function' ? options.isCancelled : () => false
      const tableFilters = options?.tableFilters ?? filters
      const tableSortField = options?.tableSortField ?? sortField
      const tableSortOrder = options?.tableSortOrder ?? sortOrder
      const ensureNotCancelled = () => {
        if (signal?.aborted || isCancelled()) throw createBulkCancelError()
      }
      const all = []
      let url = buildClientsListUrl(criteria, {
        page: 1,
        rows: 200,
        tableFilters,
        tableSortField,
        tableSortOrder,
      })
      let total = 0

      while (url) {
        ensureNotCancelled()
        const res = await authFetch(url, { signal }, token)
        if (!res.ok) throw new Error('No se pudo obtener la lista completa de solicitudes.')
        ensureNotCancelled()
        const data = await res.json()

        if (Array.isArray(data)) {
          all.push(...data)
          ensureNotCancelled()
          total = total || all.length
          onProgress?.({
            loaded: all.length,
            total,
            percent: total ? Math.min(100, Math.round((all.length / total) * 100)) : 100,
          })
          url = null
        } else {
          const count = Number(data?.count ?? 0)
          if (count > 0) total = count
          const list = Array.isArray(data?.results) ? data.results : []
          all.push(...list)
          ensureNotCancelled()
          const safeTotal = total || all.length
          onProgress?.({
            loaded: all.length,
            total: safeTotal,
            percent: safeTotal ? Math.min(100, Math.round((all.length / safeTotal) * 100)) : 0,
          })
          url = data?.next || null
        }
      }

      ensureNotCancelled()
      const finalTotal = Math.max(total, all.length)
      onProgress?.({
        loaded: all.length,
        total: finalTotal,
        percent: 100,
      })

      return normalizeList(all)
    },
    [token, normalizeList, buildClientsListUrl, filters, sortField, sortOrder]
  )

  useEffect(() => {
    fetchSucursales()
  }, [fetchSucursales])

  const refreshData = () => {
    if (!lastSearchRef.current) {
      setShowSearchModal(true)
      return
    }
    setIsRefreshing(true)
    const currentPage = Math.floor(pageFirst / pageSize) + 1
    fetchClients(lastSearchRef.current, currentPage, pageSize)
  }

  // ---------------- Filters ----------------

  const initFilters = () => {
    const nextFilters = {
      global: { value: null, matchMode: FilterMatchMode.CONTAINS },
      fecha: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
      cliente_nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
      cedula_ruc: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      sucursal_nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
      producto_solicitado_nombre: {
        operator: FilterOperator.AND,
        constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }],
      },
      producto_solicitado_descripcion: {
        operator: FilterOperator.AND,
        constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }],
      },
      descripcion_general: {
        operator: FilterOperator.AND,
        constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }],
      },
      producto_conseguido: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
      conseguido_label: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }] },
      cantidad: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.EQUALS }] },
    }
    setFilters(nextFilters)
    setGlobalFilterValue('')
    return nextFilters
  }

  useEffect(() => {
    try {
      const savedState = sessionStorage.getItem('solicitudes-table-state')
      if (savedState) {
        const parsed = JSON.parse(savedState)
        if (parsed?.filters) {
          setFilters(parsed.filters)
          setGlobalFilterValue(getPrimeGlobalFilterValue(parsed.filters))
          const nextSortField = parsed?.sortField || null
          const parsedSortOrder = Number(parsed?.sortOrder)
          const nextSortOrder = parsedSortOrder === 1 || parsedSortOrder === -1 ? parsedSortOrder : null
          setSortField(nextSortField)
          setSortOrder(nextSortOrder)
          return
        }
      }
    } catch {
      try {
        sessionStorage.removeItem('solicitudes-table-state')
      } catch {
        // no-op
      }
    }
    initFilters()
  }, [])

  useEffect(() => {
    if (!filters) return
    const payload = JSON.stringify({ filters, sortField, sortOrder })
    try {
      sessionStorage.setItem('solicitudes-table-state', payload)
    } catch {
      try {
        sessionStorage.removeItem('solicitudes-table-state')
        sessionStorage.setItem('solicitudes-table-state', payload)
      } catch {
        // no-op
      }
    }
  }, [filters, sortField, sortOrder])

  const clearFilter = async () => {
    const nextFilters = initFilters()
    if (!lastSearchRef.current) return
    setPageFirst(0)
    setIsRefreshing(true)
    await fetchClients(lastSearchRef.current, 1, pageSize, {
      tableFilters: nextFilters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
    })
  }

  const initialSearchCriteria = {
    cliente_nombre: '',
    producto: '',
    cedula_ruc: '',
    sucursal_id: '',
    fecha_desde: '',
    fecha_hasta: '',
    conseguido: '',
  }

  const [searchCriteria, setSearchCriteria] = useState(initialSearchCriteria)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const lastSearchRef = useRef({ ...initialSearchCriteria })
  const didInitialSearchRef = useRef(false)
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
  const BULK_MODAL_PADDING = 12
  const BULK_MODAL_WIDTH = 440
  const BULK_MODAL_HEIGHT = 200

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
    await fetchClients(lastSearchRef.current, 1, pageSize, {
      tableFilters: filters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
    })
  }

  useEffect(() => {
    if (didInitialSearchRef.current) return
    if (!filters) return
    didInitialSearchRef.current = true
    setIsRefreshing(true)
    fetchClients(lastSearchRef.current, 1, pageSize, {
      tableFilters: filters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
    })
  }, [fetchClients, filters, pageSize, sortField, sortOrder])

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
  const allRowsSelected = allRowIds.length > 0 && allRowIds.every((id) => selectedRowIds.includes(id))

  useEffect(() => {
    const saved = sessionStorage.getItem('solicitudes-table-selected-rows')
    if (!saved) return
    try {
      const parsed = JSON.parse(saved)
      const ids = (parsed.selectedRowIds || []).map(normId).filter(Boolean)
      sessionStorage.setItem('solicitudes-table-selected-rows-pending', JSON.stringify({ ids }))
    } catch {
      sessionStorage.removeItem('solicitudes-table-selected-rows')
      sessionStorage.removeItem('solicitudes-table-selected-rows-pending')
    }
  }, [])

  useEffect(() => {
    const pending = sessionStorage.getItem('solicitudes-table-selected-rows-pending')
    if (!pending) return
    try {
      const parsed = JSON.parse(pending)
      const ids = (parsed.ids || []).map(normId).filter(Boolean)
      if (!ids.length) {
        setSelectedRows([])
        sessionStorage.removeItem('solicitudes-table-selected-rows-pending')
        return
      }
      const map = new Map(clients.map((row) => [normId(row?.id), row]))
      const rows = ids.map((id) => map.get(id)).filter(Boolean)
      setSelectedRows(rows)
      sessionStorage.removeItem('solicitudes-table-selected-rows-pending')
    } catch {
      sessionStorage.removeItem('solicitudes-table-selected-rows-pending')
    }
  }, [clients])

  useEffect(() => {
    try {
      sessionStorage.setItem(
        'solicitudes-table-selected-rows',
        JSON.stringify({
          selectedRowIds,
          allRowsSelected,
        })
      )
    } catch {
      // no-op
    }
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
      { nombrevar: 'fecha', header: 'Fecha', filterPlaceholder: 'Buscar por fecha' },
      { nombrevar: 'cliente_nombre', header: 'Cliente', filterPlaceholder: 'Buscar por cliente' },
      { nombrevar: 'cedula_ruc', header: 'Cedula/RUC', filterPlaceholder: 'Buscar por cedula/RUC' },
      { nombrevar: 'sucursal_nombre', header: 'Sucursal', filterPlaceholder: 'Buscar por sucursal' },
      {
        nombrevar: 'producto_solicitado_nombre',
        header: 'Producto solicitado',
        filterPlaceholder: 'Buscar por producto solicitado',
      },
      {
        nombrevar: 'producto_solicitado_descripcion',
        header: 'Descripción',
        filterPlaceholder: 'Buscar por descripción',
      },
      {
        nombrevar: 'descripcion_general',
        header: 'Comentario general',
        filterPlaceholder: 'Buscar por comentario general',
      },
      {
        nombrevar: 'producto_conseguido',
        header: 'Producto conseguido',
        filterPlaceholder: 'Buscar por producto conseguido',
      },
      { nombrevar: 'cantidad', header: 'Cantidad', filterPlaceholder: 'Buscar por cantidad' },
      { nombrevar: 'conseguido_label', header: 'Conseguido', filterPlaceholder: 'Buscar por estado' },
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
    const stored = localStorage.getItem('solicitudes-table-columns')
    if (stored) setSelectedColumns(JSON.parse(stored))
    return () => {
      localStorage.setItem('solicitudes-table-columns', JSON.stringify(selectedColumnsRef.current))
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

  const getExportValue = useCallback((row, field) => row?.[field] ?? '', [])

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
      fileName: buildFileName('solicitudes'),
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
      fileName: buildFileName('solicitudes'),
      title: 'Reporte de solicitudes',
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

  const clienteBodyTemplate = (rowData) => {
    const name = rowData?.cliente_nombre ?? '-'
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
    toast.current?.show({ severity: 'success', summary: 'Actualizado', detail: 'Solicitud actualizada correctamente', life: 2500 })
  }

  // ---------------- Header ----------------
  const dataLength = totalRecords ?? 0
  const emptyMessage = lastSearchRef.current
    ? 'No se encontraron solicitudes'
    : 'Realice una búsqueda para ver la información. Si quiere ver toda la información, haga la búsqueda sin aplicar ningún filtro.'

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
    toast.current?.show({ severity: 'success', summary: 'Éxito', detail: 'Solicitud creada correctamente', life: 2500 })
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

  const handleFilterChange = async (event) => {
    const nextFilters = event?.filters || {}
    setFilters(nextFilters)
    setGlobalFilterValue(getPrimeGlobalFilterValue(nextFilters))
    setPageFirst(0)
    if (!lastSearchRef.current) return
    setIsRefreshing(true)
    await fetchClients(lastSearchRef.current, 1, pageSize, {
      tableFilters: nextFilters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
    })
  }

  async function handleGlobalFilterChange(event) {
    const value = event.target.value
    const nextFilters = {
      ...(filters || {}),
      global: { value: value || null, matchMode: FilterMatchMode.CONTAINS },
    }
    setFilters(nextFilters)
    setGlobalFilterValue(value)
    setPageFirst(0)
    if (!lastSearchRef.current) return
    setIsRefreshing(true)
    await fetchClients(lastSearchRef.current, 1, pageSize, {
      tableFilters: nextFilters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
    })
  }

  const handleSortChange = async (event) => {
    const rawSortOrder = Number(event?.sortOrder)
    const normalizedSortOrder = rawSortOrder === 1 || rawSortOrder === -1 ? rawSortOrder : null
    const nextSortField = normalizedSortOrder ? event?.sortField || null : null
    setSortField(nextSortField)
    setSortOrder(normalizedSortOrder)
    setPageFirst(0)
    if (!lastSearchRef.current) return
    setIsRefreshing(true)
    await fetchClients(lastSearchRef.current, 1, pageSize, {
      tableFilters: filters,
      tableSortField: nextSortField,
      tableSortOrder: normalizedSortOrder,
    })
  }

  const handlePageChange = async (event) => {
    const nextRows = Number(event?.rows) || pageSize
    const nextFirst = Number(event?.first) || 0
    const nextPage = Math.floor(nextFirst / nextRows) + 1

    setPageFirst(nextFirst)
    setPageSize(nextRows)

    if (!lastSearchRef.current) return
    setIsRefreshing(true)
    await fetchClients(lastSearchRef.current, nextPage, nextRows, {
      tableFilters: filters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
    })
  }

  const handleSelectAllRows = useCallback(async () => {
    if (!lastSearchRef.current) {
      setShowSearchModal(true)
      return
    }
    const controller = new AbortController()
    bulkSelectAbortRef.current = controller
    bulkSelectCancelledRef.current = false
    setShowBulkSelectConfirm(false)
    setShowBulkSelectProgress(true)
    setBulkSelectProgress({
      loaded: 0,
      total: Math.max(Number(totalRecords) || 0, 0),
      percent: 0,
    })
    setIsRefreshing(true)
    try {
      const all = await fetchAllClients(lastSearchRef.current, {
        signal: controller.signal,
        isCancelled: () => bulkSelectCancelledRef.current,
        onProgress: ({ loaded, total, percent }) => {
          setBulkSelectProgress({
            loaded: Math.max(0, Number(loaded) || 0),
            total: Math.max(0, Number(total) || 0),
            percent: Math.max(0, Math.min(100, Number(percent) || 0)),
          })
        },
      })
      if (bulkSelectCancelledRef.current || controller.signal.aborted) return
      setSelectedRows(all)
      toast.current?.show({
        severity: 'info',
        summary: 'Seleccion global',
        detail: `Se seleccionaron ${all.length} solicitudes.`,
        life: 2500,
      })
    } catch (err) {
      const cancelled = bulkSelectCancelledRef.current || err?.name === 'AbortError'
      if (cancelled) {
        toast.current?.show({
          severity: 'info',
          summary: 'Cancelado',
          detail: 'Se canceló la selección global.',
          life: 2500,
        })
        return
      }
      toast.current?.show({
        severity: 'warn',
        summary: 'Aviso',
        detail: err?.message || 'No se pudo seleccionar todas las solicitudes.',
        life: 3500,
      })
    } finally {
      if (bulkSelectAbortRef.current === controller) {
        bulkSelectAbortRef.current = null
      }
      setShowBulkSelectProgress(false)
      setIsRefreshing(false)
    }
  }, [fetchAllClients, totalRecords])

  const handleCancelBulkSelection = useCallback(() => {
    bulkSelectCancelledRef.current = true
    if (bulkSelectAbortRef.current) {
      try {
        bulkSelectAbortRef.current.abort()
      } catch {
        // no-op
      }
    }
    setShowBulkSelectConfirm(false)
    setShowBulkSelectProgress(false)
    setSelectedRows([])
    setIsRefreshing(false)
    setBulkSelectProgress({ loaded: 0, total: 0, percent: 0 })
  }, [])

  const handleUnselectAllRows = useCallback(() => {
    setShowBulkSelectConfirm(false)
    setShowBulkSelectProgress(false)
    setSelectedRows([])
  }, [])

  const handleSelectAllIntent = useCallback(() => {
    if (!lastSearchRef.current) {
      setShowSearchModal(true)
      return
    }
    if ((Number(totalRecords) || 0) > BULK_SELECT_CONFIRM_THRESHOLD) {
      setShowBulkSelectConfirm(true)
      return
    }
    handleSelectAllRows()
  }, [handleSelectAllRows, totalRecords])

  useLayoutEffect(() => {
    if (!showBulkSelectConfirm) return
    const width = Math.min(BULK_MODAL_WIDTH, Math.max(0, window.innerWidth - BULK_MODAL_PADDING * 2))
    const height = Math.min(BULK_MODAL_HEIGHT, Math.max(0, window.innerHeight - BULK_MODAL_PADDING * 2))
    setBulkModalPosition({
      x: Math.max((window.innerWidth - width) / 2, BULK_MODAL_PADDING),
      y: Math.max((window.innerHeight - height) / 2, BULK_MODAL_PADDING),
    })
  }, [showBulkSelectConfirm])

  const handleBulkModalMouseDown = (event) => {
    if (!bulkModalRef.current) return
    const rect = bulkModalRef.current.getBoundingClientRect()
    bulkModalDrag.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }

  useEffect(() => {
    if (!showBulkSelectConfirm) return undefined

    const handleMouseMove = (event) => {
      if (!bulkModalDrag.current.active) return
      event.preventDefault()
      const width = bulkModalRef.current?.offsetWidth || BULK_MODAL_WIDTH
      const height = bulkModalRef.current?.offsetHeight || BULK_MODAL_HEIGHT
      const maxX = Math.max(window.innerWidth - width - BULK_MODAL_PADDING, BULK_MODAL_PADDING)
      const maxY = Math.max(window.innerHeight - height - BULK_MODAL_PADDING, BULK_MODAL_PADDING)
      const x = event.clientX - bulkModalDrag.current.offsetX
      const y = event.clientY - bulkModalDrag.current.offsetY
      setBulkModalPosition({
        x: Math.min(Math.max(x, BULK_MODAL_PADDING), maxX),
        y: Math.min(Math.max(y, BULK_MODAL_PADDING), maxY),
      })
    }

    const handleMouseUp = () => {
      bulkModalDrag.current.active = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [showBulkSelectConfirm])

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
              <h2 className="users-search-empty-state__title">Solicitudes</h2>
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
          value={clients}
          dataKey="id"
          header={header}
          className={`users-datatable users-datatable--compact${loading || isRefreshing ? ' users-datatable--loading-content' : ''}`}
          tableStyle={{ width: '100%' }}
          emptyMessage={emptyMessage}
          showGridlines
          size="small"
          scrollable
          scrollHeight="flex"
          frozenWidth="40px"
          lazy
          paginator
          first={pageFirst}
          rows={pageSize}
          totalRecords={totalRecords}
          rowsPerPageOptions={[5, 10, 25, 50]}
          onPage={handlePageChange}
          removableSort
          sortField={sortField || undefined}
          sortOrder={sortOrder || 0}
          onSort={handleSortChange}
          filters={filters}
          onFilter={handleFilterChange}
          onValueChange={(value) => setProcessedRows(value ?? [])}
          globalFilterFields={[
            'fecha',
            'cliente_nombre',
            'cedula_ruc',
            'sucursal_nombre',
            'producto_solicitado_nombre',
            'producto_solicitado_descripcion',
            'descripcion_general',
            'producto_conseguido',
            'cantidad',
            'conseguido_label',
          ]}
          reorderableColumns
          onColReorder={handleOrderChange}
          resizableColumns
          columnResizeMode="fit"
          onRowClick={handleRowClick}
          rowClassName={(rowData) => (selectedRowIds.includes(normId(rowData?.id)) ? 'selected-row-shadow' : '')}
          selectionMode="multiple"
          selection={selectedRows}
          onAllRowsUnselect={handleUnselectAllRows}
          onSelectionChange={(e) => {
            if (!isCheckboxSelection(e)) return
            if (e?.type === 'all') {
              const value = Array.isArray(e.value) ? e.value : []
              if (!value.length) {
                handleUnselectAllRows()
              } else {
                handleSelectAllIntent()
              }
              return
            }
            const value = e.value || []
            const currentPageIds = new Set(allRowIds)
            setSelectedRows((prev) => {
              const preserved = (prev || []).filter((row) => !currentPageIds.has(normId(row?.id)))
              const nextMap = new Map()
              preserved.forEach((row) => {
                const id = normId(row?.id)
                if (id) nextMap.set(id, row)
              })
              value.forEach((row) => {
                const id = normId(row?.id)
                if (id) nextMap.set(id, row)
              })
              return Array.from(nextMap.values())
            })
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
              case 'cliente_nombre':
                bodyTemplate = (rowData) => clienteBodyTemplate(rowData)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                break
              case 'cantidad':
                bodyTemplate = (rowData) => numericBodyTemplate(rowData, column.nombrevar)
                filterMatchMode = FilterMatchMode.EQUALS
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

      {showBulkSelectConfirm && (
        <div className="create-user__overlay" role="dialog" aria-modal="true" style={{ pointerEvents: 'auto' }}>
          <div
            ref={bulkModalRef}
            className="create-user__modal"
            style={{
              top: bulkModalPosition.y,
              left: bulkModalPosition.x,
              width: 'min(440px, calc(100vw - 32px))',
              height: 'auto',
              maxHeight: 'none',
              minWidth: 0,
              minHeight: 0,
            }}
          >
            <header className="create-user__header" onMouseDown={handleBulkModalMouseDown}>
              <div className="create-user__header-text">
                <h3>Confirmar selección global</h3>
              </div>
            </header>

            <div className="create-user__body">
              <p style={{ margin: 0, lineHeight: 1.5, textAlign: 'center' }}>
                Va a seleccionar{' '}
                <strong>{Number(totalRecords || 0).toLocaleString('es-EC')}</strong>{' '}
                solicitudes. El proceso tomara varios minutos.
              </p>
            </div>

            <div className="create-user__footer">
              <div className="user-details__footer-left">
                <button
                  type="button"
                  className="create-user__action create-user__action--cancel"
                  onClick={() => setShowBulkSelectConfirm(false)}
                >
                  Cancelar
                </button>
              </div>
              <div className="user-details__footer-right">
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={handleSelectAllRows}
                >
                  Continuar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showBulkSelectProgress && (
        <div
          className="create-user__overlay"
          role="dialog"
          aria-modal="true"
          style={{ pointerEvents: 'auto', background: 'rgba(2, 6, 23, 0.72)', backdropFilter: 'blur(1px)' }}
        >
          <div
            ref={bulkModalRef}
            className="create-user__modal"
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'min(440px, calc(100vw - 32px))',
              height: 'auto',
              maxHeight: 'none',
              pointerEvents: 'auto',
              minWidth: 0,
              minHeight: 0,
            }}
          >
            <header className="create-user__header" style={{ cursor: 'default' }}>
              <div className="create-user__header-text" style={{ cursor: 'default' }}>
                <h3>Seleccionando solicitudes</h3>
              </div>
            </header>

            <div className="create-user__body">
              <p style={{ margin: '0 0 12px', lineHeight: 1.5 }}>
                Procesando selección global. Por favor espera.
              </p>
              <div
                style={{
                  width: '100%',
                  height: 12,
                  borderRadius: 999,
                  background: 'rgba(15, 23, 42, 0.12)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${Math.max(0, Math.min(100, bulkSelectProgress.percent || 0))}%`,
                    height: '100%',
                    background: '#0b4f7d',
                    transition: 'width 180ms ease',
                  }}
                />
              </div>
              <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: '0.9rem' }}>
                <span>
                  {Number(bulkSelectProgress.loaded || 0).toLocaleString('es-EC')} / {Number(bulkSelectProgress.total || 0).toLocaleString('es-EC')}
                </span>
                <span>
                  Faltan {Math.max(0, (Number(bulkSelectProgress.total) || 0) - (Number(bulkSelectProgress.loaded) || 0)).toLocaleString('es-EC')}
                </span>
                <strong>{Math.max(0, Math.min(100, Number(bulkSelectProgress.percent) || 0))}%</strong>
              </div>
            </div>
            <div className="create-user__footer">
              <div className="user-details__footer-left" />
              <div className="user-details__footer-right">
                <button
                  type="button"
                  className="create-user__action create-user__action--cancel"
                  onClick={handleCancelBulkSelection}
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <CreateSolicitud
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleCreated}
        token={token}
        onError={showErrorToast}
      />

      <SolicitudDetails
        open={showDetailsModal}
        solicitudId={selectedId}
        onClose={() => setShowDetailsModal(false)}
        token={token}
        onUpdated={handleUpdated}
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
                <h3>Buscar solicitudes</h3>
              </div>
              <div className="create-user__header-actions">
                <button
                  type="button"
                  className="create-user__icon-button create-user__icon-button--maximize"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={toggleSearchMaximize}
                  aria-label={isSearchMaximized ? 'Restaurar' : 'Maximizar'}
                >
                  {isSearchMaximized ? '▣' : '▢'}
                </button>
                <button
                  type="button"
                  className="create-user__icon-button"
                  onClick={() => setShowSearchModal(false)}
                  aria-label="Cerrar"
                >×</button>
              </div>
            </header>

            <form className="create-user__form" onSubmit={handleSearchSubmit}>
              <div className="create-user__body">
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Filtros</p>
                      <h4>Búsqueda avanzada</h4>
                    </div>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field">
                      <span>Cliente</span>
                      <input
                        name="cliente_nombre"
                        type="text"
                        placeholder="Ej: Juan Perez"
                        value={searchCriteria.cliente_nombre}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Cedula/RUC</span>
                      <input name="cedula_ruc" type="text" placeholder="Ej: 1712345678" value={searchCriteria.cedula_ruc} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Producto solicitado</span>
                      <input
                        name="producto"
                        type="text"
                        placeholder="Ej: Aceite 20W50"
                        value={searchCriteria.producto}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Sucursal</span>
                      <select
                        name="sucursal_id"
                        value={searchCriteria.sucursal_id}
                        onChange={handleSearchInputChange}
                      >
                        <option value="">Todas las sucursales</option>
                        {sucursales.map((sucursal) => (
                          <option key={sucursal.id} value={sucursal.id}>
                            {sucursal.nombre || `Sucursal ${sucursal.id}`}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="create-user__field">
                      <span>Fecha desde</span>
                      <input
                        name="fecha_desde"
                        type="date"
                        value={searchCriteria.fecha_desde}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Fecha hasta</span>
                      <input
                        name="fecha_hasta"
                        type="date"
                        value={searchCriteria.fecha_hasta}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Conseguido</span>
                      <select
                        name="conseguido"
                        value={searchCriteria.conseguido}
                        onChange={handleSearchInputChange}
                      >
                        <option value="">Todos</option>
                        <option value="true">Si</option>
                        <option value="false">No</option>
                      </select>
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
              aria-label="Cambiar tamaño de ventana"
              className="create-user__resize-handle"
              onMouseDown={handleSearchResizeMouseDown}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default SolicitudesTable




