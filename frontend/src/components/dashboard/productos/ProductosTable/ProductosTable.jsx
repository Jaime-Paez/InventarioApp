import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FilterMatchMode, FilterOperator } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { OverlayPanel } from 'primereact/overlaypanel'
import { Checkbox } from 'primereact/checkbox'
import { Button } from 'primereact/button'

import CreateProducto from '../CreateProducto/CreateProducto'
import ProductoDetails from '../ProductoDetails/ProductoDetails'
import '../../admin/UsersTable/UsersTable.css'
import { API_URL, authFetch } from '../../../../utils/api'
import { buildFileName, exportToExcel, exportToPdf } from '../../../../utils/exportUtils'

const normId = (value) => (value == null ? null : String(value))

function ProductosTable({ token, onSelect }) {
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

  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const normalizeList = useCallback(
    (list) =>
      list.map((product) => {
        const houses = Array.isArray(product?.casas_comerciales) ? product.casas_comerciales : []
        return {
          ...product,
          marca_nombre: product?.marca?.nombre ?? '-',
          casas_comerciales_count: houses.length,
          casas_comerciales_nombres: houses.map((house) => house?.nombre).filter(Boolean).join(', '),
          pieza_original_label: product?.pieza_original ? 'Si' : 'No',
        }
      }),
    []
  )

  const normalizeValue = (value) => String(value ?? '').trim().toLowerCase()
  const contains = (fieldValue, target) => {
    const needle = normalizeValue(target)
    if (!needle) return true
    return normalizeValue(fieldValue).includes(needle)
  }
  const exact = (fieldValue, target) => {
    const needle = normalizeValue(target)
    if (!needle) return true
    return normalizeValue(fieldValue) === needle
  }
  const pickValue = (row, keys) => {
    for (const key of keys) {
      const value = key.split('.').reduce((acc, part) => acc?.[part], row)
      if (value != null && value !== '') return value
    }
    return ''
  }
  const matchCasa = (row, target) => {
    const needle = normalizeValue(target)
    if (!needle) return true
    const houses = Array.isArray(row?.casas_comerciales) ? row.casas_comerciales : []
    return houses.some((house) =>
      normalizeValue(house?.nombre).includes(needle) || normalizeValue(house?.codigo).includes(needle)
    )
  }

  const applySearchFilters = useCallback(
    (list, criteria) =>
      list.filter((row) => {
        const piezaCriteria = normalizeValue(criteria.pieza_original)
        const piezaValue = row?.pieza_original ? 'true' : 'false'
        const dateValue = pickValue(row, ['creado_en', 'created_at', 'fecha_creacion', 'actualizado_en'])
        return (
          contains(row?.codigo, criteria.codigo) &&
          contains(row?.nombre, criteria.nombre) &&
          contains(row?.descripcion, criteria.descripcion) &&
          contains(row?.marca?.nombre ?? row?.marca_nombre, criteria.marca) &&
          matchCasa(row, criteria.casa_comercial) &&
          (piezaCriteria ? piezaValue === piezaCriteria : true) &&
          contains(row?.costo_minimo, criteria.costo_minimo) &&
          contains(row?.costo_maximo, criteria.costo_maximo) &&
          contains(row?.precio, criteria.precio) &&
          contains(dateValue, criteria.fecha_creacion)
        )
      }),
    []
  )

  const fetchProducts = useCallback(
    async (criteria) => {
      setLoading(true)
      setError(null)
      try {
        const res = await authFetch(`${API_URL}/productos/listado/`, {}, token)

        if (!res.ok) throw new Error('No se pudo obtener la lista de productos.')

        const data = await res.json()
        const list = Array.isArray(data) ? data : data?.results || []
        const normalized = normalizeList(list)
        const filtered = criteria ? applySearchFilters(normalized, criteria) : normalized
        setProducts(filtered)
        return filtered
      } catch (err) {
        const msg = err?.message || 'Ocurrio un error al cargar los productos.'
        setError(msg)
        toast.current?.show({ severity: 'warn', summary: 'Aviso', detail: msg, life: 3500 })
      } finally {
        setLoading(false)
        setIsRefreshing(false)
      }
    },
    [token, normalizeList, applySearchFilters]
  )

  const refreshData = () => {
    if (!lastSearchRef.current) {
      setShowSearchModal(true)
      return
    }
    setIsRefreshing(true)
    fetchProducts(lastSearchRef.current)
  }

  // ---------------- Filters ----------------
  const [filters, setFilters] = useState(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')

  const initFilters = () => {
    setFilters({
      global: { value: null, matchMode: FilterMatchMode.CONTAINS },
      codigo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      marca_nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      pieza_original_label: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      costo_minimo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      costo_maximo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      precio: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      casas_comerciales_count: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
    })
    setGlobalFilterValue('')
  }

  useEffect(() => {
    const savedState = sessionStorage.getItem('productos-table-state')
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
    setSearchMarcaQuery('')
    setSearchCasaQuery('')
    setSearchMarcaOptions([])
    setSearchCasaOptions([])
    setShowSearchMarcaDropdown(false)
    setShowSearchCasaDropdown(false)
    lastSearchRef.current = null
    setProducts([])
  }

  const initialSearchCriteria = {
    codigo: '',
    nombre: '',
    descripcion: '',
    marca: '',
    casa_comercial: '',
    pieza_original: '',
    costo_minimo: '',
    costo_maximo: '',
    precio: '',
    fecha_creacion: '',
  }

  const [searchCriteria, setSearchCriteria] = useState(initialSearchCriteria)
  const [searchMarcaQuery, setSearchMarcaQuery] = useState('')
  const [searchCasaQuery, setSearchCasaQuery] = useState('')
  const [searchMarcaOptions, setSearchMarcaOptions] = useState([])
  const [searchCasaOptions, setSearchCasaOptions] = useState([])
  const [searchMarcaLoading, setSearchMarcaLoading] = useState(false)
  const [searchCasaLoading, setSearchCasaLoading] = useState(false)
  const [showSearchMarcaDropdown, setShowSearchMarcaDropdown] = useState(false)
  const [showSearchCasaDropdown, setShowSearchCasaDropdown] = useState(false)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const lastSearchRef = useRef(null)
  const [isSearchMaximized, setIsSearchMaximized] = useState(false)
  const [searchPosition, setSearchPosition] = useState({ x: 0, y: 0 })
  const [searchSize, setSearchSize] = useState({ width: 720, height: 520 })
  const searchModalRef = useRef(null)
  const searchMarcaDropdownRef = useRef(null)
  const searchCasaDropdownRef = useRef(null)
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

  const searchMarcas = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token) {
        setSearchMarcaOptions([])
        return
      }
      setSearchMarcaLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/marcas/listado/?search=${encodeURIComponent(term)}&page_size=20`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las marcas.')
        const data = await response.json()
        const list = Array.isArray(data) ? data : data?.results || []
        setSearchMarcaOptions(list)
      } catch {
        setSearchMarcaOptions([])
      } finally {
        setSearchMarcaLoading(false)
      }
    },
    [token]
  )

  const searchCasas = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token) {
        setSearchCasaOptions([])
        return
      }
      setSearchCasaLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/casa-comercial/casas/?search=${encodeURIComponent(term)}&page_size=20`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las casas comerciales.')
        const data = await response.json()
        const list = Array.isArray(data) ? data : data?.results || []
        setSearchCasaOptions(list)
      } catch {
        setSearchCasaOptions([])
      } finally {
        setSearchCasaLoading(false)
      }
    },
    [token]
  )

  useEffect(() => {
    if (!showSearchModal) return
    const term = searchMarcaQuery.trim()
    if (!term) {
      setSearchMarcaOptions([])
      return
    }
    const handle = setTimeout(() => {
      searchMarcas(term)
    }, 300)
    return () => clearTimeout(handle)
  }, [searchMarcaQuery, searchMarcas, showSearchModal])

  useEffect(() => {
    if (!showSearchModal) return
    const term = searchCasaQuery.trim()
    if (!term) {
      setSearchCasaOptions([])
      return
    }
    const handle = setTimeout(() => {
      searchCasas(term)
    }, 300)
    return () => clearTimeout(handle)
  }, [searchCasaQuery, searchCasas, showSearchModal])

  useEffect(() => {
    if (!showSearchModal) return
    setSearchMarcaQuery(searchCriteria.marca || '')
    setSearchCasaQuery(searchCriteria.casa_comercial || '')
  }, [showSearchModal, searchCriteria.marca, searchCriteria.casa_comercial])

  useEffect(() => {
    if (!showSearchModal) return
    const handleClick = (event) => {
      if (
        showSearchMarcaDropdown &&
        searchMarcaDropdownRef.current &&
        !searchMarcaDropdownRef.current.contains(event.target)
      ) {
        setShowSearchMarcaDropdown(false)
      }
      if (
        showSearchCasaDropdown &&
        searchCasaDropdownRef.current &&
        !searchCasaDropdownRef.current.contains(event.target)
      ) {
        setShowSearchCasaDropdown(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [showSearchModal, showSearchMarcaDropdown, showSearchCasaDropdown])

  const handleSearchSubmit = async (event) => {
    event.preventDefault()
    lastSearchRef.current = { ...searchCriteria }
    setShowSearchModal(false)
    setIsRefreshing(true)
    await fetchProducts(lastSearchRef.current)
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

  const allRowIds = useMemo(() => products.map((row) => normId(row?.id)).filter(Boolean), [products])
  const allRowsSelected = allRowIds.length > 0 && selectedRowIds.length === allRowIds.length

  useEffect(() => {
    const saved = sessionStorage.getItem('productos-table-selected-rows')
    if (!saved) return
    try {
      const parsed = JSON.parse(saved)
      const ids = (parsed.selectedRowIds || []).map(normId).filter(Boolean)
      sessionStorage.setItem('productos-table-selected-rows-pending', JSON.stringify({ ids }))
    } catch {
      sessionStorage.removeItem('productos-table-selected-rows')
      sessionStorage.removeItem('productos-table-selected-rows-pending')
    }
  }, [])

  useEffect(() => {
    const pending = sessionStorage.getItem('productos-table-selected-rows-pending')
    if (!pending) return
    try {
      const parsed = JSON.parse(pending)
      const ids = (parsed.ids || []).map(normId).filter(Boolean)
      if (!ids.length) {
        setSelectedRows([])
        sessionStorage.removeItem('productos-table-selected-rows-pending')
        return
      }
      const map = new Map(products.map((row) => [normId(row?.id), row]))
      const rows = ids.map((id) => map.get(id)).filter(Boolean)
      setSelectedRows(rows)
      sessionStorage.removeItem('productos-table-selected-rows-pending')
    } catch {
      sessionStorage.removeItem('productos-table-selected-rows-pending')
    }
  }, [products])

  useEffect(() => {
    if (!products?.length) {
      if (selectedRows?.length) setSelectedRows([])
      return
    }
    const idsSet = new Set(allRowIds)
    const filtered = (selectedRows || []).filter((row) => idsSet.has(normId(row?.id)))
    if (filtered.length !== (selectedRows || []).length) setSelectedRows(filtered)
  }, [products])

  useEffect(() => {
    sessionStorage.setItem(
      'productos-table-selected-rows',
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
      { nombrevar: 'codigo', header: 'Codigo', filterPlaceholder: 'Buscar por codigo' },
      { nombrevar: 'nombre', header: 'Nombre', filterPlaceholder: 'Buscar por nombre' },
      { nombrevar: 'marca_nombre', header: 'Marca', filterPlaceholder: 'Buscar por marca' },
      { nombrevar: 'pieza_original_label', header: 'Original', filterPlaceholder: 'Si/No' },
      { nombrevar: 'precio', header: 'Precio', filterPlaceholder: 'Buscar por precio' },
      { nombrevar: 'costo_minimo', header: 'Costo min', filterPlaceholder: 'Buscar por costo minimo' },
      { nombrevar: 'costo_maximo', header: 'Costo max', filterPlaceholder: 'Buscar por costo maximo' },
      { nombrevar: 'casas_comerciales_count', header: 'Casas', filterPlaceholder: 'Filtrar por casas' },
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
    const stored = localStorage.getItem('productos-table-columns')
    if (stored) setSelectedColumns(JSON.parse(stored))
    return () => {
      localStorage.setItem('productos-table-columns', JSON.stringify(selectedColumnsRef.current))
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

  const formatDecimal = (value) => {
    const num = Number(value)
    return Number.isFinite(num) ? num.toFixed(2) : ''
  }

  const getExportValue = useCallback(
    (row, field) => {
      switch (field) {
        case 'marca_nombre':
          return row?.marca?.nombre ?? row?.marca_nombre ?? ''
        case 'pieza_original_label':
          return row?.pieza_original ? 'Si' : 'No'
        case 'casas_comerciales_count':
          return Number(row?.casas_comerciales_count ?? 0).toString()
        case 'precio':
        case 'costo_minimo':
        case 'costo_maximo':
          return formatDecimal(row?.[field])
        default:
          return row?.[field] ?? ''
      }
    },
    []
  )

  const getRowsToExport = useCallback(() => {
    if (selectedRows?.length) return selectedRows
    return processedRows === null ? products : processedRows
  }, [processedRows, selectedRows, products])

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
      fileName: buildFileName('productos'),
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
      fileName: buildFileName('productos'),
      title: 'Reporte de productos',
    })
  }, [exportColumns, getExportValue, getRowsToExport, notifyExportWarning])

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

  const codigoBodyTemplate = (rowData) => {
    const code = rowData?.codigo ?? '-'
    return (
      <span className="cell-tooltip" data-pr-tooltip={code}>
        {code}
      </span>
    )
  }

  const piezaOriginalBodyTemplate = (rowData) => {
    const isOriginal = Boolean(rowData?.pieza_original)
    return (
      <span style={{ display: 'flex', justifyContent: 'center' }}>
        <i className={`pi pi-${isOriginal ? 'check-circle' : 'times-circle'}`} style={{ color: isOriginal ? '#22c55e' : '#9ca3af' }} />
      </span>
    )
  }

  const numericBodyTemplate = (rowData, field) => {
    const value = Number(rowData?.[field])
    if (!Number.isFinite(value)) return <span className="cell-tooltip">-</span>
    const text = field === 'casas_comerciales_count' ? String(value) : value.toFixed(2)
    return (
      <span className="cell-tooltip" data-pr-tooltip={text}>
        {text}
      </span>
    )
  }

  const casasBodyTemplate = (rowData) => {
    const count = Number(rowData?.casas_comerciales_count ?? 0)
    const text = Number.isFinite(count) ? String(count) : '0'
    const tooltip = rowData?.casas_comerciales_nombres || 'Sin casas asociadas'
    return (
      <span className="cell-tooltip" data-pr-tooltip={tooltip}>
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
    toast.current?.show({ severity: 'success', summary: 'Actualizado', detail: 'Producto actualizado correctamente', life: 2500 })
  }

  const handleDeleted = () => {
    setShowDetailsModal(false)
    setSelectedId(null)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Eliminado', detail: 'Producto eliminado', life: 2500 })
  }

  // ---------------- Header ----------------
  const dataLength = products?.length ?? 0
  const emptyMessage = lastSearchRef.current
    ? 'No se encontraron productos'
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
    toast.current?.show({ severity: 'success', summary: 'Exito', detail: 'Producto creado correctamente', life: 2500 })
  }

  const focusSearch = () => setShowSearchModal(true)

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
          value={products}
          dataKey="id"
          header={header}
          className="users-datatable"
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
          globalFilterFields={[
            'codigo',
            'nombre',
            'descripcion',
            'marca_nombre',
            'pieza_original_label',
            'precio',
            'costo_minimo',
            'costo_maximo',
            'casas_comerciales_nombres',
          ]}
          stateStorage="session"
          stateKey="productos-table-state"
          reorderableColumns
          onColReorder={handleOrderChange}
          resizableColumns
          columnResizeMode="fit"
          onRowClick={handleRowClick}
          rowClassName={(rowData) => (selectedRowIds.includes(normId(rowData?.id)) ? 'selected-row-shadow' : '')}
          selectionMode="multiple"
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
              case 'codigo':
                bodyTemplate = (rowData) => codigoBodyTemplate(rowData)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                break
              case 'nombre':
              case 'marca_nombre':
                bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                break
              case 'pieza_original_label':
                bodyTemplate = (rowData) => piezaOriginalBodyTemplate(rowData)
                className = 'column-max-min-width--small'
                filterMatchMode = FilterMatchMode.STARTS_WITH
                break
              case 'precio':
              case 'costo_minimo':
              case 'costo_maximo':
                bodyTemplate = (rowData) => numericBodyTemplate(rowData, column.nombrevar)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                className = 'column-max-min-width--small'
                break
              case 'casas_comerciales_count':
                bodyTemplate = (rowData) => casasBodyTemplate(rowData)
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
      </div>

      <CreateProducto
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleCreated}
        token={token}
        onError={showErrorToast}
      />

      <ProductoDetails
        open={showDetailsModal}
        productoId={selectedId}
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
                <h3>Buscar productos</h3>
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
                      <span>Codigo</span>
                      <input name="codigo" type="text" placeholder="Ej: PRD-001" value={searchCriteria.codigo} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Nombre</span>
                      <input name="nombre" type="text" placeholder="Ej: Filtro de aire" value={searchCriteria.nombre} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Marca</span>
                      <div className="create-user__dropdown" ref={searchMarcaDropdownRef}>
                        <button
                          type="button"
                          className="create-user__dropdown-trigger"
                          onClick={() => {
                            setShowSearchMarcaDropdown((prev) => !prev)
                            setShowSearchCasaDropdown(false)
                          }}
                        >
                          <span>{searchMarcaQuery.trim() ? searchMarcaQuery : 'Selecciona una marca'}</span>
                          <i className={`pi pi-chevron-${showSearchMarcaDropdown ? 'up' : 'down'}`} />
                        </button>

                        {showSearchMarcaDropdown && (
                          <div className="create-user__dropdown-panel">
                            <div className="create-user__dropdown-search">
                              <i className="pi pi-search" />
                              <input
                                type="text"
                                placeholder="Buscar marcas"
                                value={searchMarcaQuery}
                                onChange={(event) => {
                                  const value = event.target.value
                                  setSearchMarcaQuery(value)
                                  setSearchCriteria((prev) => ({ ...prev, marca: value }))
                                }}
                              />
                            </div>

                            <div className="create-user__dropdown-results">
                              {searchMarcaLoading && <small className="muted">Buscando marcas...</small>}
                              {!searchMarcaLoading && !searchMarcaQuery.trim() && (
                                <small className="muted">Escribe para buscar.</small>
                              )}
                              {!searchMarcaLoading && searchMarcaQuery.trim() && !searchMarcaOptions.length && (
                                <small className="muted">Sin resultados.</small>
                              )}
                              {searchMarcaOptions.map((marca) => (
                                <button
                                  key={marca.id}
                                  type="button"
                                  className="create-user__result-option"
                                  onClick={() => {
                                    setSearchMarcaQuery(marca.nombre)
                                    setSearchCriteria((prev) => ({ ...prev, marca: marca.nombre }))
                                    setShowSearchMarcaDropdown(false)
                                  }}
                                >
                                  <div className="create-user__result-info">
                                    <strong>{marca.nombre}</strong>
                                    <small>{marca.codigo ? `Codigo: ${marca.codigo}` : `ID: ${marca.id}`}</small>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </label>

                    <label className="create-user__field">
                      <span>Casa comercial</span>
                      <div className="create-user__dropdown" ref={searchCasaDropdownRef}>
                        <button
                          type="button"
                          className="create-user__dropdown-trigger"
                          onClick={() => {
                            setShowSearchCasaDropdown((prev) => !prev)
                            setShowSearchMarcaDropdown(false)
                          }}
                        >
                          <span>{searchCasaQuery.trim() ? searchCasaQuery : 'Selecciona una casa comercial'}</span>
                          <i className={`pi pi-chevron-${showSearchCasaDropdown ? 'up' : 'down'}`} />
                        </button>

                        {showSearchCasaDropdown && (
                          <div className="create-user__dropdown-panel">
                            <div className="create-user__dropdown-search">
                              <i className="pi pi-search" />
                              <input
                                type="text"
                                placeholder="Buscar casas comerciales"
                                value={searchCasaQuery}
                                onChange={(event) => {
                                  const value = event.target.value
                                  setSearchCasaQuery(value)
                                  setSearchCriteria((prev) => ({ ...prev, casa_comercial: value }))
                                }}
                              />
                            </div>

                            <div className="create-user__dropdown-results">
                              {searchCasaLoading && <small className="muted">Buscando casas...</small>}
                              {!searchCasaLoading && !searchCasaQuery.trim() && (
                                <small className="muted">Escribe para buscar.</small>
                              )}
                              {!searchCasaLoading && searchCasaQuery.trim() && !searchCasaOptions.length && (
                                <small className="muted">Sin resultados.</small>
                              )}
                              {searchCasaOptions.map((casa) => (
                                <button
                                  key={casa.id}
                                  type="button"
                                  className="create-user__result-option"
                                  onClick={() => {
                                    setSearchCasaQuery(casa.nombre)
                                    setSearchCriteria((prev) => ({ ...prev, casa_comercial: casa.nombre }))
                                    setShowSearchCasaDropdown(false)
                                  }}
                                >
                                  <div className="create-user__result-info">
                                    <strong>{casa.nombre}</strong>
                                    <small>{casa.codigo ? `Codigo: ${casa.codigo}` : `ID: ${casa.id}`}</small>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </label>

                    <label className="create-user__field">
                      <span>Pieza original</span>
                      <select
                        name="pieza_original"
                        value={searchCriteria.pieza_original}
                        onChange={handleSearchInputChange}
                        className={!searchCriteria.pieza_original ? 'is-placeholder' : undefined}
                      >
                        <option value="">Todos</option>
                        <option value="true">Si</option>
                        <option value="false">No</option>
                      </select>
                    </label>

                    <label className="create-user__field">
                      <span>Costo minimo</span>
                      <input name="costo_minimo" type="text" placeholder="Ej: 10.50" value={searchCriteria.costo_minimo} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Costo maximo</span>
                      <input name="costo_maximo" type="text" placeholder="Ej: 45.00" value={searchCriteria.costo_maximo} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Precio sugerido</span>
                      <input name="precio" type="text" placeholder="Ej: 60.00" value={searchCriteria.precio} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Fecha de creacion</span>
                      <input name="fecha_creacion" type="text" placeholder="Ej: 2025-12-31" value={searchCriteria.fecha_creacion} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field create-user__field--full">
                      <span>Descripcion</span>
                      <input name="descripcion" type="text" placeholder="Ej: Repuesto original" value={searchCriteria.descripcion} onChange={handleSearchInputChange} />
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

export default ProductosTable
