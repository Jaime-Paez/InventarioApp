import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FilterMatchMode } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { OverlayPanel } from 'primereact/overlaypanel'
import { Checkbox } from 'primereact/checkbox'
import { Button } from 'primereact/button'

import CreateCasaComercial from '../CreateCasaComercial/CreateCasaComercial'
import CasaComercialDetails from '../CasaComercialDetails/CasaComercialDetails'
import '../../admin/UsersTable/UsersTable.css'

import useModalAnimation from '../../common/useModalAnimation'
import { API_URL, authFetch } from '../../../../utils/api'
import { tableLayoutStore } from '../../../../utils/tableLayoutStore'
import { attachAutoExpandColumns, autoFitTableColumns, makeWidthStateHandlers } from '../../../../utils/autoFitColumns'
import { buildFileName, exportToExcel, exportToPdf } from '../../../../utils/exportUtils'
import { getModuleActions } from '../../menuConfig'
import {
  buildPrimeColumnFiltersPayload,
  buildPrimeOrdering,
  getPrimeGlobalFilterValue,
} from '../../../../utils/primeTableQuery'
import { memoryStore } from '../../../../utils/memoryStore'

const normId = (v) => (v == null ? null : String(v))
const COMPANY_FILTER_FIELDS = ['nombre', 'codigo', 'tipo', 'pais_nombre', 'telefono', 'correo', 'descripcion']
const COMPANY_FILTER_DEFAULT_MODES = {
  nombre: FilterMatchMode.STARTS_WITH,
  codigo: FilterMatchMode.STARTS_WITH,
  tipo: FilterMatchMode.STARTS_WITH,
  pais_nombre: FilterMatchMode.STARTS_WITH,
  telefono: FilterMatchMode.CONTAINS,
  correo: FilterMatchMode.CONTAINS,
  descripcion: FilterMatchMode.CONTAINS,
}
const COMPANY_ORDERING_MAP = {
  nombre: 'nombre',
  codigo: 'codigo',
  tipo_label: 'tipo',
  pais_nombre: 'pais__nombre',
  telefono: 'telefono',
  correo: 'correo',
  descripcion: 'descripcion',
  dias_entrega: 'dias_entrega',
  es_original: 'es_original',
}
const isCheckboxSelection = (event) => {
  if (event?.type === 'checkbox') return true
  const target = event?.originalEvent?.target
  if (!target) return true
  if (target.type === 'checkbox') return true
  return Boolean(target.closest?.('.p-checkbox, .p-checkbox-box, .p-checkbox-icon, .p-checkbox-input'))
}

function CasasComercialesTable({ token, onSelect, moduleActions, permissionIndex }) {
  const toast = useRef(null)
  const opColumns = useRef(null)
  const tableWrapperRef = useRef(null)

  // Ajusta automaticamente el ancho de las columnas para llenar el espacio
  // disponible en pantallas grandes, sin comprimir en pantallas chicas.
  useEffect(() => attachAutoExpandColumns(tableWrapperRef.current), [])
  const widthHandlers = useMemo(() => makeWidthStateHandlers('casas-comerciales-table-state-v2'), [])
  const [tableResetKey, setTableResetKey] = useState(0)
  const canCreate = moduleActions?.puede_crear ?? true
  const canEdit = moduleActions?.puede_actualizar ?? true
  const canDelete = moduleActions?.puede_eliminar ?? true

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

  const [companies, setCompanies] = useState([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [pageFirst, setPageFirst] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [loading, setLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isGlobalSearchPending, setIsGlobalSearchPending] = useState(false)
  const [error, setError] = useState(null)
  const [sortField, setSortField] = useState(null)
  const [sortOrder, setSortOrder] = useState(null)
  const [filters, setFilters] = useState(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')

  const normalizeList = useCallback((list) => {
    return list.map((item) => ({
      ...item,
      pais_nombre: item?.pais?.nombre ?? '-',
      tipo_label: item?.tipo === 'importacion' ? 'Importación' : 'Local',
    }))
  }, [])

  const initialSearchCriteria = {
    nombre: '',
    codigo: '',
    pais: '',
    telefono: '',
    correo: '',
    descripcion: '',
  }

  const [searchCriteria, setSearchCriteria] = useState(initialSearchCriteria)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const lastSearchRef = useRef({ ...initialSearchCriteria })
  const didInitialSearchRef = useRef(false)
  const globalSearchDebounceRef = useRef(null)
  const [searchPaisQuery, setSearchPaisQuery] = useState('')
  const [searchPaisOptions, setSearchPaisOptions] = useState([])
  const [searchPaisLoading, setSearchPaisLoading] = useState(false)
  const [showSearchPaisDropdown, setShowSearchPaisDropdown] = useState(false)
  const searchPaisDropdownRef = useRef(null)
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

  useEffect(
    () => () => {
      if (globalSearchDebounceRef.current) {
        clearTimeout(globalSearchDebounceRef.current)
      }
    },
    []
  )

  const handleSearchInputChange = (event) => {
    const { name, value } = event.target
    setSearchCriteria((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const searchCountries = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token) {
        setSearchPaisOptions([])
        return
      }

      setSearchPaisLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/tipos/paises/?search=${encodeURIComponent(term)}&page_size=5`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar los países.')
        const data = await response.json()
        const list = Array.isArray(data) ? data : data?.results || []
        setSearchPaisOptions(list)
      } catch {
        setSearchPaisOptions([])
      } finally {
        setSearchPaisLoading(false)
      }
    },
    [token]
  )

  const buildCompaniesListUrl = useCallback((criteria, options = {}) => {
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

    addIfPresent('nombre', criteria?.nombre)
    addIfPresent('codigo', criteria?.codigo)
    addIfPresent('pais', criteria?.pais)
    addIfPresent('telefono', criteria?.telefono)
    addIfPresent('correo', criteria?.correo)
    addIfPresent('descripcion', criteria?.descripcion)

    const globalSearch = getPrimeGlobalFilterValue(tableFilters)
    if (globalSearch) params.set('search', globalSearch)

    const columnFilters = buildPrimeColumnFiltersPayload(tableFilters, {
      allowedFields: COMPANY_FILTER_FIELDS,
      defaultMatchModes: COMPANY_FILTER_DEFAULT_MODES,
    })
    if (columnFilters) params.set('column_filters', JSON.stringify(columnFilters))

    const ordering = buildPrimeOrdering(tableSortField, tableSortOrder, COMPANY_ORDERING_MAP)
    if (ordering) params.set('ordering', ordering)

    return `${API_URL}/casa-comercial/casas/?${params.toString()}`
  }, [])

  const fetchCompanies = useCallback(
    async (criteria, page = 1, rows = pageSize, options = {}) => {
      setLoading(true)
      setError(null)
      try {
        const tableFilters = options?.tableFilters ?? filters
        const tableSortField = options?.tableSortField ?? sortField
        const tableSortOrder = options?.tableSortOrder ?? sortOrder
        const url = buildCompaniesListUrl(criteria, {
          page,
          rows,
          tableFilters,
          tableSortField,
          tableSortOrder,
        })
        const res = await authFetch(url, {}, token)
        if (!res.ok) throw new Error('No se pudo obtener la lista de casas comerciales.')

        const data = await res.json()
        const count = Array.isArray(data) ? data.length : Number(data?.count ?? 0)
        const list = Array.isArray(data) ? data : data?.results || []
        const normalized = normalizeList(list)
        setCompanies(normalized)
        setTotalRecords(count)
        setPageFirst(Math.max(0, (page - 1) * rows))
        setPageSize(rows)
        return normalized
      } catch (e) {
        const msg = e?.message || 'Ocurrió un error al cargar las casas comerciales.'
        setError(msg)
        setCompanies([])
        setTotalRecords(0)
        toast.current?.show({ severity: 'warn', summary: 'Aviso', detail: msg, life: 3500 })
      } finally {
        setLoading(false)
        setIsRefreshing(false)
      }
    },
    [token, normalizeList, pageSize, buildCompaniesListUrl, filters, sortField, sortOrder]
  )

  const handleSearchSubmit = async (event) => {
    event.preventDefault()
    lastSearchRef.current = { ...searchCriteria }
    setShowSearchModal(false)
    setIsRefreshing(true)
    await fetchCompanies(lastSearchRef.current, 1, pageSize, {
      tableFilters: filters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
    })
  }

  const refreshData = () => {
    if (!lastSearchRef.current) {
      setShowSearchModal(true)
      return
    }
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    setIsRefreshing(true)
    const currentPage = Math.floor(pageFirst / pageSize) + 1
    fetchCompanies(lastSearchRef.current, currentPage, pageSize)
  }

  // ---------------- Filters ----------------
  const initFilters = () => {
    const nextFilters = {
      global: { value: null, matchMode: FilterMatchMode.CONTAINS },
    }
    setFilters(nextFilters)
    setGlobalFilterValue('')
    return nextFilters
  }

  useEffect(() => {
    initFilters()
  }, [])

  const clearFilter = async () => {
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    const nextFilters = initFilters()
    if (!lastSearchRef.current) return
    setSortField(null)
    setSortOrder(null)
    setPageFirst(0)
    setIsRefreshing(true)
    await fetchCompanies(lastSearchRef.current, 1, pageSize, {
      tableFilters: nextFilters,
      tableSortField: null,
      tableSortOrder: null,
    })
  }

  const autoFitColumns = useCallback(() => {
    autoFitTableColumns(tableWrapperRef.current, 'casas-comerciales-table-state-v2')
  }, [])

  const handleResetTable = () => {
    tableLayoutStore.removeItem('casas-comerciales-table-columns')
    tableLayoutStore.removeItem('casas-comerciales-table-state-v2')
    setSelectedColumns(columnsData)
    clearFilter()
    setTableResetKey((k) => k + 1)
    opColumns.current?.hide()
  }

  useEffect(() => {
    if (didInitialSearchRef.current) return
    if (!filters) return
    didInitialSearchRef.current = true
    setIsRefreshing(true)
    fetchCompanies(lastSearchRef.current, 1, pageSize, {
      tableFilters: filters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
    })
  }, [fetchCompanies, filters, pageSize, sortField, sortOrder])


  // ---------------- Row selection (Prime) ----------------
  const [selectedRows, setSelectedRows] = useState([])

  const selectedRowIds = useMemo(
    () => (selectedRows || []).map((u) => normId(u?.id)).filter(Boolean),
    [selectedRows]
  )

  const allRowIds = useMemo(() => companies.map((u) => normId(u?.id)).filter(Boolean), [companies])
  const allRowsSelected = allRowIds.length > 0 && allRowIds.every((id) => selectedRowIds.includes(id))

  useEffect(() => {
    const saved = memoryStore.getItem('casas-comerciales-table-selected-rows')
    if (!saved) return
    try {
      const parsed = JSON.parse(saved)
      const ids = (parsed.selectedRowIds || []).map(normId).filter(Boolean)
      memoryStore.setItem('casas-comerciales-table-selected-rows-pending', JSON.stringify({ ids }))
    } catch {
      memoryStore.removeItem('casas-comerciales-table-selected-rows')
      memoryStore.removeItem('casas-comerciales-table-selected-rows-pending')
    }
  }, [])

  useEffect(() => {
    const pending = memoryStore.getItem('casas-comerciales-table-selected-rows-pending')
    if (!pending) return
    try {
      const parsed = JSON.parse(pending)
      const ids = (parsed.ids || []).map(normId).filter(Boolean)
      if (!ids.length) {
        setSelectedRows([])
        memoryStore.removeItem('casas-comerciales-table-selected-rows-pending')
        return
      }
      const map = new Map(companies.map((u) => [normId(u?.id), u]))
      const rows = ids.map((id) => map.get(id)).filter(Boolean)
      setSelectedRows(rows)
      memoryStore.removeItem('casas-comerciales-table-selected-rows-pending')
    } catch {
      memoryStore.removeItem('casas-comerciales-table-selected-rows-pending')
    }
  }, [companies])

  useEffect(() => {
    memoryStore.setItem(
      'casas-comerciales-table-selected-rows',
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
      { nombrevar: 'nombre', header: 'Descripción', filterPlaceholder: 'Buscar por descripción' },
      { nombrevar: 'codigo', header: 'Código', filterPlaceholder: 'Buscar por código' },
      { nombrevar: 'tipo_label', header: 'Tipo', filterPlaceholder: 'Buscar por tipo' },
      { nombrevar: 'pais_nombre', header: 'País', filterPlaceholder: 'Buscar por país' },
      { nombrevar: 'telefono', header: 'Teléfono', filterPlaceholder: 'Buscar por teléfono' },
      { nombrevar: 'correo', header: 'Correo', filterPlaceholder: 'Buscar por correo' },
      { nombrevar: 'dias_entrega', header: 'Días aproximados de entrega', filterPlaceholder: 'Buscar por días' },
      { nombrevar: 'es_original', header: 'Original', filterPlaceholder: 'Buscar por original' },
      { nombrevar: 'descripcion', header: 'Nota', filterPlaceholder: 'Buscar por nota' },
    ],
    []
  )

  const [selectedColumns, setSelectedColumns] = useState(columnsData)
  const [processedRows, setProcessedRows] = useState(null)

  useEffect(() => {
    const stored = tableLayoutStore.getItem('casas-comerciales-table-columns')
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        const columnsByField = new Map(columnsData.map((col) => [col.nombrevar, col]))
        const restored = (Array.isArray(parsed) ? parsed : [])
          .map((col) => columnsByField.get(col?.nombrevar))
          .filter(Boolean)
        setSelectedColumns(restored.length ? restored : columnsData)
      } catch {
        tableLayoutStore.removeItem('casas-comerciales-table-columns')
      }
    }
    // No cleanup-based flush here: handleCheckboxChangeColumn and
    // handleOrderChange already persist synchronously on every real change.
  }, [columnsData])

  const handleCheckboxChangeColumn = (column) => {
    const next = selectedColumns.some((c) => c.nombrevar === column.nombrevar)
      ? selectedColumns.filter((c) => c.nombrevar !== column.nombrevar)
      : [...selectedColumns, column]
    setSelectedColumns(next)
    tableLayoutStore.setItemNow('casas-comerciales-table-columns', JSON.stringify(next))
  }

  const handleOrderChange = (e) => {
    const columnOrder = e.columns.map((col) => col.props.field)
    const sorted = columnOrder.map((f) => selectedColumns.find((c) => c.nombrevar === f)).filter(Boolean)
    setSelectedColumns(sorted)
    tableLayoutStore.setItemNow('casas-comerciales-table-columns', JSON.stringify(sorted))
  }

  const exportColumns = useMemo(
    () => selectedColumns.map((col) => ({ key: col.nombrevar, header: col.header })),
    [selectedColumns]
  )

  const getExportValue = useCallback((row, field) => {
    switch (field) {
      case 'pais_nombre':
        return row?.pais_nombre ?? row?.pais?.nombre ?? ''
      default:
        return row?.[field] ?? ''
    }
  }, [])

  const getRowsToExport = useCallback(() => {
    if (selectedRows?.length) return selectedRows
    return processedRows === null ? companies : processedRows
  }, [processedRows, selectedRows, companies])

  const notifyExportWarning = useCallback((detail) => {
    toast.current?.show({ severity: 'warn', summary: 'Sin datos', detail, life: 3000 })
  }, [])

  const handleExportExcel = useCallback(async () => {
    if (!exportColumns.length) {
      notifyExportWarning('Selecciona al menos una columna para exportar.')
      return
    }
    const rows = getRowsToExport()
    if (!rows.length) {
      notifyExportWarning('No hay registros para exportar.')
      return
    }
    await exportToExcel({
      rows,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('casas-comerciales'),
    })
  }, [exportColumns, getExportValue, getRowsToExport, notifyExportWarning])

  const handleExportPdf = useCallback(async () => {
    if (!exportColumns.length) {
      notifyExportWarning('Selecciona al menos una columna para exportar.')
      return
    }
    const rows = getRowsToExport()
    if (!rows.length) {
      notifyExportWarning('No hay registros para exportar.')
      return
    }
    await exportToPdf({
      rows,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('casas-comerciales'),
      title: 'Reporte de Proveedores',
    })
  }, [exportColumns, getExportValue, getRowsToExport, notifyExportWarning])

  // Sin selección se exporta lo filtrado (solo la página cargada); el botón solo se apaga si no hay filas
  const exportSelectedCount = selectedRows?.length || 0
  const exportFilteredCount = (processedRows === null ? companies : processedRows)?.length || 0
  const exportCount = exportSelectedCount || exportFilteredCount
  const exportHint = exportSelectedCount
    ? (exportSelectedCount === 1 ? 'Exportar la fila seleccionada' : `Exportar las ${exportSelectedCount} filas seleccionadas`)
    : exportFilteredCount
      ? `Exportar las ${exportFilteredCount} filas cargadas en esta página (de ${Number(totalRecords) || 0} en total); para incluir otras, selecciónalas primero`
      : 'No hay registros para exportar'

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

  const nombreBodyTemplate = (rowData) => {
    const name = rowData?.nombre ?? '-'
    return (
      <span className="cell-tooltip" data-pr-tooltip={name}>
        {name}
      </span>
    )
  }

  // ---------------- Row click -> detalles ----------------
  const [selectedId, setSelectedId] = useState(null)
  const [showDetailsModal, setShowDetailsModal] = useState(false)
  const clickTimerRef = useRef(null)

  const handleRowClick = (event) => {
    const t = event?.originalEvent?.target
    if (t?.closest?.('.p-checkbox') || t?.closest?.('.row-selection-column')) return

    const rowData = event?.data
    if (!rowData) return
    const id = normId(rowData?.id)
    if (!id) return

    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      setSelectedRows((prev) => {
        const prevMap = new Map((prev || []).map((r) => [normId(r?.id), r]))
        if (prevMap.has(id)) {
          prevMap.delete(id)
        } else {
          prevMap.set(id, rowData)
        }
        return Array.from(prevMap.values())
      })
    }, 220)
  }

  const handleRowDoubleClick = (event) => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
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
    toast.current?.show({ severity: 'success', summary: 'Actualizado', detail: 'Casa comercial actualizada correctamente', life: 2500 })
  }

  const handleDeleted = () => {
    setShowDetailsModal(false)
    setSelectedId(null)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Eliminada', detail: 'Casa comercial eliminada', life: 2500 })
  }

  const handleDuplicated = (message) => {
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Duplicado', detail: message || 'Duplicación completada.', life: 2500 })
  }

  // ---------------- Header ----------------
  const dataLength = totalRecords ?? 0
  const emptyMessage = lastSearchRef.current
    ? 'No se encontraron proveedores'
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
          <i className={`pi ${isGlobalSearchPending ? 'pi-spinner pi-spin' : 'pi-search'} search-input-icon`} />
        </div>

        <button className="rounded-icon-btn" type="button" onClick={refreshData} disabled={loading || isRefreshing} title="Recargar">
          <i className="pi pi-refresh" />
        </button>

        <button className="rounded-icon-btn" type="button" onClick={clearFilter} title="Limpiar filtros">
          <i className="pi pi-filter-slash" />
        </button>

        <button
          className="rounded-icon-btn"
          type="button"
          onClick={autoFitColumns}
          title="Ajustar columnas"
        >
          <i className="pi pi-arrows-h" />
        </button>

        <button className="rounded-icon-btn" type="button" onClick={(e) => opColumns.current?.toggle(e)} title="Campos">
          <i className="pi pi-sliders-h" />
        </button>
      </div>

      <div className="users-header__right">
        <span className="users-header__count">Reg. {dataLength}</span>

        <button className="users-circle users-circle--excel" type="button" title={exportCount ? `Excel: ${exportHint}` : exportHint} disabled={!exportCount} onClick={handleExportExcel}>
          <i className="pi pi-file-excel" />
        </button>

        <button className="users-circle users-circle--pdf" type="button" title={exportCount ? `PDF: ${exportHint}` : exportHint} disabled={!exportCount} onClick={handleExportPdf}>
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
    toast.current?.show({ severity: 'success', summary: 'Éxito', detail: 'Casa comercial creada correctamente', life: 2500 })
  }

  const focusSearch = () => setShowSearchModal(true)
  const hasSearched = Boolean(lastSearchRef.current)

  useEffect(() => {
    if (!showSearchModal) return
    setSearchPaisQuery(searchCriteria.pais || '')
  }, [showSearchModal, searchCriteria.pais])

  useEffect(() => {
    if (!showSearchModal || !showSearchPaisDropdown) return
    const term = searchPaisQuery.trim()
    if (!term) {
      setSearchPaisOptions([])
      return
    }
    const handle = setTimeout(() => {
      searchCountries(term)
    }, 300)
    return () => clearTimeout(handle)
  }, [showSearchModal, showSearchPaisDropdown, searchPaisQuery, searchCountries])

  useEffect(() => {
    if (!showSearchModal) return
    const handleClick = (event) => {
      if (
        showSearchPaisDropdown &&
        searchPaisDropdownRef.current &&
        !searchPaisDropdownRef.current.contains(event.target)
      ) {
        setShowSearchPaisDropdown(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [showSearchModal, showSearchPaisDropdown])

  useEffect(() => {
    searchSizeRef.current = searchSize
  }, [searchSize])

  useEffect(() => {
    searchPosRef.current = searchPosition
  }, [searchPosition])

  useLayoutEffect(() => {
    if (!showSearchModal) return
    setShowSearchPaisDropdown(false)
    setSearchPaisOptions([])
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
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    setIsGlobalSearchPending(true)
    globalSearchDebounceRef.current = setTimeout(() => {
      fetchCompanies(lastSearchRef.current, 1, pageSize, {
        tableFilters: nextFilters,
        tableSortField: sortField,
        tableSortOrder: sortOrder,
      }).finally(() => setIsGlobalSearchPending(false))
    }, 500)
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
    await fetchCompanies(lastSearchRef.current, 1, pageSize, {
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
    await fetchCompanies(lastSearchRef.current, nextPage, nextRows, {
      tableFilters: filters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
    })
  }

  const { shouldRender: shouldRenderSearchModal, isClosing: isClosingSearchModal } = useModalAnimation(showSearchModal)

  return (
    <div className="users-page">
      <Tooltip position="top" showDelay={1800} target=".cell-tooltip" style={{ maxWidth: '340px' }} />
      <Toast ref={toast} />

      <div className="users-page__top">
        <div className="users-page__actions">
          {canCreate && (
            <Button label="Crear" icon="pi pi-plus" className="users-topbtn users-topbtn--create" onClick={() => setShowCreateModal(true)} type="button" />
          )}
          <Button label="Buscar" icon="pi pi-search" className="users-topbtn users-topbtn--search" onClick={focusSearch} type="button" />
        </div>
      </div>

      <div className="users-table users-table--card" ref={tableWrapperRef}>
        {!hasSearched ? (
          <div className="users-search-empty-state">
            <div className="users-search-empty-state__content">
              <h2 className="users-search-empty-state__title">Proveedores</h2>
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
        {(loading || isRefreshing) && !isGlobalSearchPending && (
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
          value={companies}
          dataKey="id"
          header={header}
          className={`users-datatable${(loading || isRefreshing) && !isGlobalSearchPending ? ' users-datatable--loading-content' : ''}`}
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
          onValueChange={(value) => setProcessedRows(value ?? [])}
          globalFilterFields={['nombre', 'codigo', 'pais_nombre', 'telefono', 'correo', 'descripcion']}
          reorderableColumns
          onColReorder={handleOrderChange}
          resizableColumns
          columnResizeMode="expand"
          key={tableResetKey}
          stateStorage="custom"
          customSaveState={widthHandlers.save}
          customRestoreState={widthHandlers.restore}
          onRowClick={handleRowClick}
          onRowDoubleClick={handleRowDoubleClick}
          rowClassName={(rowData) => (selectedRowIds.includes(normId(rowData?.id)) ? 'selected-row-shadow' : '')}
          selectionMode="multiple"
          selection={selectedRows}
          onSelectionChange={(e) => {
            if (!isCheckboxSelection(e)) return
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
            resizable={false}
          />

          {selectedColumns.map((column, index) => {
            let bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
            const className = 'column-max-min-width'

            switch (column.nombrevar) {
              case 'nombre':
                bodyTemplate = (rowData) => nombreBodyTemplate(rowData)
                break
              case 'dias_entrega':
                bodyTemplate = (rowData) => {
                  const val = rowData?.dias_entrega
                  return val != null ? `${val} d` : '-'
                }
                break
              case 'es_original':
                bodyTemplate = (rowData) => (
                  <span style={{ display: 'flex', justifyContent: 'center' }}>
                    <i
                      className={`pi pi-${rowData?.es_original ? 'check-circle' : 'times-circle'}`}
                      style={{ color: rowData?.es_original ? '#22c55e' : '#9ca3af' }}
                    />
                  </span>
                )
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
                className={className}
                style={{ minWidth: '32px' }}
              />
            )
          })}
        </DataTable>

        <OverlayPanel ref={opColumns} className="table-options-list">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <strong>Campos</strong>
            <button className="rounded-icon-btn" type="button" onClick={handleResetTable} title="Restablecer tabla" style={{ width: 28, height: 28 }}>
              <i className="pi pi-refresh" />
            </button>
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

      <CreateCasaComercial
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleCreated}
        token={token}
        onError={showErrorToast}
      />

      <CasaComercialDetails
        open={showDetailsModal}
        casaComercialId={selectedId}
        onClose={() => setShowDetailsModal(false)}
        token={token}
        onUpdated={handleUpdated}
        onDeleted={handleDeleted}
        onDuplicated={handleDuplicated}
        onError={showErrorToast}
        allowEdit={canEdit}
        allowDelete={canDelete}
      />

      {shouldRenderSearchModal && (
        <div className={`create-user__overlay${isClosingSearchModal ? ' create-user__overlay--closing' : ''}`} role="dialog" aria-modal="true" style={{ padding: `${SEARCH_PADDING}px` }}>
          <div
            className={`create-user__modal${isClosingSearchModal ? ' create-user__modal--closing' : ''}`}
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
                <h3>Buscar proveedores</h3>
              </div>
              <div className="create-user__header-actions">
                <button
                  type="button"
                  className="create-user__icon-button create-user__icon-button--maximize"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={toggleSearchMaximize}
                  aria-label={isSearchMaximized ? 'Restaurar' : 'Maximizar'}
                >
                  <i className={isSearchMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="create-user__icon-button"
                  onClick={() => setShowSearchModal(false)}
                  aria-label="Cerrar"
                ><i className="pi pi-times" aria-hidden="true" /></button>
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
                      <span>Código</span>
                      <input name="codigo" type="text" placeholder="Ej: C001" value={searchCriteria.codigo} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Descripción</span>
                      <input name="nombre" type="text" placeholder="Ej: Casa Comercial XYZ" value={searchCriteria.nombre} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>País</span>
                      <div className="create-user__dropdown" ref={searchPaisDropdownRef}>
                        <button
                          type="button"
                          className="create-user__dropdown-trigger"
                          onClick={() => setShowSearchPaisDropdown((prev) => !prev)}
                        >
                          <span>{searchPaisQuery.trim() ? searchPaisQuery : 'Selecciona un país'}</span>
                          <i className={`pi pi-chevron-${showSearchPaisDropdown ? 'up' : 'down'}`} />
                        </button>

                        {showSearchPaisDropdown && (
                          <div className="create-user__dropdown-panel">
                            <div className="create-user__dropdown-search">
                              <i className="pi pi-search" />
                              <input
                                type="text"
                                placeholder="Buscar países"
                                value={searchPaisQuery}
                                onChange={(event) => {
                                  const value = event.target.value
                                  setSearchPaisQuery(value)
                                  setSearchCriteria((prev) => ({ ...prev, pais: value }))
                                }}
                              />
                            </div>

                            <div className="create-user__dropdown-results">
                              {searchPaisLoading && <small className="muted">Buscando países...</small>}
                              {!searchPaisLoading && !searchPaisQuery.trim() && (
                                <small className="muted">Escribe para buscar.</small>
                              )}
                              {!searchPaisLoading && searchPaisQuery.trim() && !searchPaisOptions.length && (
                                <small className="muted">Sin resultados.</small>
                              )}
                              {searchPaisOptions.map((country) => (
                                <button
                                  key={country.id}
                                  type="button"
                                  className="create-user__result-option"
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    setSearchPaisQuery(country.nombre)
                                    setSearchCriteria((prev) => ({ ...prev, pais: country.nombre }))
                                    setShowSearchPaisDropdown(false)
                                  }}
                                >
                                  <div className="create-user__result-info">
                                    <strong>{country.nombre}</strong>
                                    <small>{country.codigo_pais || `ID: ${country.id}`}</small>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </label>

                    <label className="create-user__field">
                      <span>Teléfono</span>
                      <input name="telefono" type="text" placeholder="Ej: 0991234567" value={searchCriteria.telefono} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Correo</span>
                      <input name="correo" type="text" placeholder="Ej: compras@empresa.com" value={searchCriteria.correo} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Nota</span>
                      <input name="descripcion" type="text" placeholder="Ej: Proveedor principal" value={searchCriteria.descripcion} onChange={handleSearchInputChange} />
                    </label>
                  </div>
                </section>
              </div>

              <div className="create-user__footer">
                <div className="user-details__footer-left">
                  <button
                    type="button"
                    className="create-user__action"
                    onClick={() => {
                      setSearchCriteria(initialSearchCriteria)
                      setSearchPaisQuery('')
                      setSearchPaisOptions([])
                    }}
                  >
                    Limpiar filtros
                  </button>
                  <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setShowSearchModal(false)}>
                    Cancelar
                  </button>
                </div>
                <div className="user-details__footer-right">
                  <button type="submit" className="create-user__action create-user__action--primary" disabled={loading || isRefreshing}>
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

export default CasasComercialesTable





