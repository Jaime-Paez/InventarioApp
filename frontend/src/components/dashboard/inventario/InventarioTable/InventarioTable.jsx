import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FilterMatchMode, FilterOperator } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { OverlayPanel } from 'primereact/overlaypanel'
import { Checkbox } from 'primereact/checkbox'
import { Button } from 'primereact/button'
import '../../admin/UsersTable/UsersTable.css'
import './InventarioTable.css'
import { API_URL, authFetch } from '../../../../utils/api'
import { onIvaUpdated } from '../../../../utils/configEvents'
import ProductoDetails from '../../productos/ProductoDetails/ProductoDetails'
import { buildFileName, exportToExcel, exportToPdf } from '../../../../utils/exportUtils'

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const DEFAULT_IVA_RATE = 0.15
const normId = (value) => (value == null ? null : String(value))

const parseProductCode = (label) => {
  if (!label) return null
  const match = /\(([^)]+)\)\s*$/.exec(String(label))
  return match ? match[1].trim() : null
}

const normalizeNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const formatCurrency = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : '-'
}

const normalizeValue = (value) => String(value ?? '').trim().toLowerCase()
const contains = (fieldValue, target) => {
  const needle = normalizeValue(target)
  if (!needle) return true
  return normalizeValue(fieldValue).includes(needle)
}
const parseCriteriaNumber = (value) => {
  if (value == null) return null
  const cleaned = String(value).trim()
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
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
  const names = houses
    .map((house) => `${house?.nombre ?? ''} ${house?.codigo ?? ''}`.trim())
    .filter(Boolean)
    .join(' ')
  const fallback = row?.casas_comerciales_nombres || ''
  return normalizeValue(names).includes(needle) || normalizeValue(fallback).includes(needle)
}
const isCheckboxSelection = (event) => {
  const type = event?.type
  if (type === 'checkbox' || type === 'all') return true
  const target = event?.originalEvent?.target
  if (!target) return true
  if (target.type === 'checkbox') return true
  return Boolean(
    target.closest?.('.p-checkbox, .p-checkbox-box, .p-checkbox-icon, .p-checkbox-input, .row-selection-column')
  )
}

const initialSearchCriteria = {
  codigo: '',
  nombre: '',
  oem: '',
  descripcion: '',
  marca: '',
  casa_comercial: '',
  pieza_original: '',
  costo_minimo: '',
  costo_maximo: '',
  precio: '',
  fecha_creacion: '',
  cantidad_min: '',
  cantidad_max: '',
}

function InventarioTable({ token }) {
  const toast = useRef(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [products, setProducts] = useState([])
  const [inventories, setInventories] = useState([])
  const [branches, setBranches] = useState([])
  const [bodegas, setBodegas] = useState([])
  const [subdivisions, setSubdivisions] = useState([])
  const [searchCriteria, setSearchCriteria] = useState(initialSearchCriteria)
  const [appliedCriteria, setAppliedCriteria] = useState(null)
  const [showSearchModal, setShowSearchModal] = useState(false)
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
  const lastSearchRef = useRef(null)
  const [searchMarcaQuery, setSearchMarcaQuery] = useState('')
  const [searchCasaQuery, setSearchCasaQuery] = useState('')
  const [searchMarcaOptions, setSearchMarcaOptions] = useState([])
  const [searchCasaOptions, setSearchCasaOptions] = useState([])
  const [searchMarcaLoading, setSearchMarcaLoading] = useState(false)
  const [searchCasaLoading, setSearchCasaLoading] = useState(false)
  const [showSearchMarcaDropdown, setShowSearchMarcaDropdown] = useState(false)
  const [showSearchCasaDropdown, setShowSearchCasaDropdown] = useState(false)
  const searchMarcaDropdownRef = useRef(null)
  const searchCasaDropdownRef = useRef(null)
  const [activeProduct, setActiveProduct] = useState(null)
  const [showDetails, setShowDetails] = useState(false)
  const [ivaRate, setIvaRate] = useState(DEFAULT_IVA_RATE)
  const [ivaLoading, setIvaLoading] = useState(false)
  const opColumns = useRef(null)
  const globalSearchRef = useRef(null)
  const [filters, setFilters] = useState(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')

  const showToast = useCallback((detail, summary = 'Aviso', severity = 'warn') => {
    toast.current?.show({ severity, summary, detail, life: 3500 })
  }, [])

  const fetchData = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const [productsRes, inventoriesRes, branchesRes, bodegasRes, subdivisionsRes] = await Promise.all([
        authFetch(`${API_URL}/productos/listado/`, {}, token),
        authFetch(`${API_URL}/inventario/inventario/`, {}, token),
        authFetch(`${API_URL}/inventario/sucursales/`, {}, token),
        authFetch(`${API_URL}/inventario/bodegas/`, {}, token),
        authFetch(`${API_URL}/inventario/subdivisiones/`, {}, token),
      ])

      if (!productsRes.ok) throw new Error('No se pudieron cargar los productos.')
      if (!inventoriesRes.ok) throw new Error('No se pudo cargar el inventario.')
      if (!branchesRes.ok) throw new Error('No se pudieron cargar las sucursales.')
      if (!bodegasRes.ok) throw new Error('No se pudieron cargar las bodegas.')
      if (!subdivisionsRes.ok) throw new Error('No se pudieron cargar las subdivisiones.')

      const [productsData, inventoriesData, branchesData, bodegasData, subdivisionsData] = await Promise.all([
        productsRes.json(),
        inventoriesRes.json(),
        branchesRes.json(),
        bodegasRes.json(),
        subdivisionsRes.json(),
      ])

      setProducts(parseApiList(productsData))
      setInventories(parseApiList(inventoriesData))
      setBranches(parseApiList(branchesData))
      setBodegas(parseApiList(bodegasData))
      setSubdivisions(parseApiList(subdivisionsData))
    } catch (err) {
      const message = err?.message || 'Ocurrió un error al cargar el inventario.'
      setError(message)
      showToast(message, 'Error', 'error')
    } finally {
      setLoading(false)
    }
  }, [token, showToast])

  const fetchIvaConfig = useCallback(async () => {
    if (!token) return
    setIvaLoading(true)
    try {
      const response = await authFetch(`${API_URL}/configuracion/sistema/`, {}, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error('No se pudo cargar el IVA.')
      const parsed = Number(data?.iva_rate)
      setIvaRate(Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IVA_RATE)
    } catch {
      setIvaRate(DEFAULT_IVA_RATE)
    } finally {
      setIvaLoading(false)
    }
  }, [token])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    fetchIvaConfig()
  }, [fetchIvaConfig])

  useEffect(() => {
    const unsubscribe = onIvaUpdated((rate) => {
      const parsed = Number(rate)
      if (Number.isFinite(parsed)) {
        setIvaRate(parsed)
        setIvaLoading(false)
        return
      }
      fetchIvaConfig()
    })

    return unsubscribe
  }, [fetchIvaConfig])

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
    const nextCriteria = { ...searchCriteria }
    const isEmptyValue = (value) => {
      if (value === null || value === undefined) return true
      if (typeof value === 'string') return value.trim() === ''
      return String(value).trim() === ''
    }
    const isCriteriaEmpty = Object.values(nextCriteria).every(isEmptyValue)
    const applied = isCriteriaEmpty ? { ...initialSearchCriteria, __onlyWithInventory: true } : nextCriteria
    lastSearchRef.current = applied
    setAppliedCriteria(applied)
    setShowSearchModal(false)
  }

  const refreshData = () => {
    if (!lastSearchRef.current) {
      setShowSearchModal(true)
      return
    }
    fetchData()
  }

  const resetSearch = () => {
    setSearchCriteria(initialSearchCriteria)
    setSearchMarcaQuery('')
    setSearchCasaQuery('')
    setSearchMarcaOptions([])
    setSearchCasaOptions([])
    setShowSearchMarcaDropdown(false)
    setShowSearchCasaDropdown(false)
  }

  const productByCode = useMemo(() => {
    const map = new Map()
    products.forEach((product) => {
      const code = String(product?.codigo ?? '').trim()
      if (code) map.set(code, product)
    })
    return map
  }, [products])

  const inventoryEntries = useMemo(() => {
    return inventories
      .map((entry) => {
        const code = parseProductCode(entry?.producto)
        const product = code ? productByCode.get(code) : null
        if (!product) return null
        const subdivision = entry?.subdivision
        const division = subdivision?.division
        const bodega = division?.bodega
        const sucursal = bodega?.sucursal
        return {
          ...entry,
          productoId: product.id,
          productoCodigo: product.codigo,
          subdivisionId: subdivision?.id ?? null,
          bodegaId: bodega?.id ?? null,
          sucursalId: sucursal?.id ?? null,
        }
      })
      .filter(Boolean)
  }, [inventories, productByCode])

  const inventoryByProductId = useMemo(() => {
    const map = new Map()
    inventoryEntries.forEach((entry) => {
      const list = map.get(entry.productoId) || []
      list.push(entry)
      map.set(entry.productoId, list)
    })
    return map
  }, [inventoryEntries])

  const totalsByProduct = useMemo(() => {
    const map = new Map()
    inventoryEntries.forEach((entry) => {
      if (!entry.productoId || !entry.sucursalId) return
      const bySucursal = map.get(entry.productoId) || {}
      const current = bySucursal[entry.sucursalId] || 0
      bySucursal[entry.sucursalId] = current + normalizeNumber(entry.cantidad)
      map.set(entry.productoId, bySucursal)
    })
    return map
  }, [inventoryEntries])

  const applySearchFilters = useCallback((list, criteria) => {
    const piezaCriteria = normalizeValue(criteria?.pieza_original)
    const qtyMinRaw = parseCriteriaNumber(criteria?.cantidad_min)
    const qtyMax = parseCriteriaNumber(criteria?.cantidad_max)
    const onlyWithInventory = Boolean(criteria?.__onlyWithInventory)
    const qtyMin =
      qtyMinRaw != null
        ? qtyMinRaw
        : qtyMax != null
          ? 1
          : onlyWithInventory
            ? 1
            : null
    return list.filter((row) => {
      const piezaValue = row?.pieza_original ? 'true' : 'false'
      const dateValue = pickValue(row, ['creado_en', 'created_at', 'fecha_creacion'])
      const qtyValue = normalizeNumber(row?.total_general)
      const hasInventory = onlyWithInventory ? qtyValue > 0 : true
      return (
        hasInventory &&
        contains(row?.codigo, criteria?.codigo) &&
        contains(row?.nombre, criteria?.nombre) &&
        contains(row?.descripcion, criteria?.descripcion) &&
        contains(row?.oem_codes, criteria?.oem) &&
        contains(row?.marca?.nombre ?? row?.marca_nombre, criteria?.marca) &&
        matchCasa(row, criteria?.casa_comercial) &&
        (piezaCriteria ? piezaValue === piezaCriteria : true) &&
        contains(row?.costo_minimo, criteria?.costo_minimo) &&
        contains(row?.costo_maximo, criteria?.costo_maximo) &&
        contains(row?.precio, criteria?.precio) &&
        contains(dateValue, criteria?.fecha_creacion) &&
        (qtyMin === null || qtyValue >= qtyMin) &&
        (qtyMax === null || qtyValue <= qtyMax)
      )
    })
  }, [])

  const initFilters = useCallback(() => {
    const nextFilters = {
      global: { value: null, matchMode: FilterMatchMode.CONTAINS },
    }
    const columnKeys = [
      'codigo',
      'nombre',
      'marca_nombre',
      'precio',
      'precio_con_iva',
      'total_general',
      ...branches.map((branch) => `sucursal_${branch.id}`),
    ]
    columnKeys.forEach((key) => {
      nextFilters[key] = {
        operator: FilterOperator.AND,
        constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }],
      }
    })
    setFilters(nextFilters)
    setGlobalFilterValue('')
  }, [branches])

  useEffect(() => {
    initFilters()
  }, [initFilters])

  const onGlobalFilterChange = (e) => {
    const value = e.target.value
    const nextFilters = { ...(filters || {}) }
    nextFilters.global = { ...(nextFilters.global || {}), value }
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

  const clearFilter = () => {
    initFilters()
    resetSearch()
    lastSearchRef.current = null
    setAppliedCriteria(null)
  }

  const rows = useMemo(() => {
    return products.map((product) => {
      const totals = totalsByProduct.get(product.id) || {}
      const houses = Array.isArray(product?.casas_comerciales) ? product.casas_comerciales : []
      const casasNombres = houses.map((house) => house?.nombre).filter(Boolean).join(', ')
      const oems = Array.isArray(product?.oem_productos) ? product.oem_productos : []
      const oemCodes = oems
        .map((item) => item?.oem?.codigo ?? item?.oem_codigo ?? item?.codigo)
        .filter(Boolean)
        .join(', ')
      const row = {
        ...product,
        marca_nombre: product?.marca?.nombre ?? '-',
        casas_comerciales_nombres: casasNombres,
        pieza_original_label: product?.pieza_original ? 'Si' : 'No',
        oem_codes: oemCodes,
        __totals: totals,
      }
      return row
    })
  }, [products, totalsByProduct])

  const displayRows = useMemo(() => {
    if (!appliedCriteria) return []
    return rows.map((row) => {
      const totals = row.__totals || {}
      const totalAll = Object.values(totals).reduce((acc, value) => acc + normalizeNumber(value), 0)
      const totalGeneral = totalAll
      const precioBase = Number(row?.precio)
      const precioConIvaValue = Number.isFinite(precioBase) ? precioBase * (1 + ivaRate) : null
      const next = {
        ...row,
        total_general: totalGeneral,
        precio_con_iva: precioConIvaValue,
      }
      branches.forEach((branch) => {
        next[`sucursal_${branch.id}`] = totals[branch.id] ?? 0
      })
      return next
    })
  }, [rows, branches, appliedCriteria, ivaRate])

  const filteredRows = useMemo(() => {
    if (!appliedCriteria) return []
    return applySearchFilters(displayRows, appliedCriteria)
  }, [displayRows, applySearchFilters, appliedCriteria])

  // ---------------- Columns ----------------
  const columnsData = useMemo(
    () => [
      { nombrevar: 'codigo', header: 'Código', filterPlaceholder: 'Buscar por Código' },
      { nombrevar: 'nombre', header: 'Producto', filterPlaceholder: 'Buscar por producto' },
      { nombrevar: 'marca_nombre', header: 'Marca', filterPlaceholder: 'Buscar por marca' },
      { nombrevar: 'precio', header: 'Precio', filterPlaceholder: 'Buscar por precio' },
      { nombrevar: 'precio_con_iva', header: 'Precio con IVA', filterPlaceholder: 'Buscar por precio con IVA' },
      { nombrevar: 'total_general', header: 'Total', filterPlaceholder: 'Filtrar por total' },
      ...branches.map((branch) => ({
        nombrevar: `sucursal_${branch.id}`,
        header: branch.nombre,
        filterPlaceholder: `Filtrar por ${branch.nombre}`,
      })),
    ],
    [branches]
  )

  const globalFilterFields = useMemo(() => columnsData.map((col) => col.nombrevar), [columnsData])

  const [selectedColumns, setSelectedColumns] = useState(columnsData)
  const selectedColumnsRef = useRef(selectedColumns)
  const [processedRows, setProcessedRows] = useState(null)
  useEffect(() => {
    setProcessedRows(null)
  }, [appliedCriteria])

  const selectionBaseRows = useMemo(() => {
    if (Array.isArray(processedRows)) {
      if (processedRows.length === 0 && filteredRows.length > 0) return filteredRows
      return processedRows
    }
    return filteredRows
  }, [processedRows, filteredRows])

  const allRowIds = useMemo(
    () => selectionBaseRows.map((row) => normId(row?.id)).filter(Boolean),
    [selectionBaseRows]
  )

  useEffect(() => {
    selectedColumnsRef.current = selectedColumns
  }, [selectedColumns])

  useEffect(() => {
    const stored = localStorage.getItem('inventario-table-columns')
    if (stored) {
      try {
        setSelectedColumns(JSON.parse(stored))
      } catch {
        setSelectedColumns(columnsData)
      }
    }
    return () => {
      localStorage.setItem('inventario-table-columns', JSON.stringify(selectedColumnsRef.current))
    }
  }, [])

  useEffect(() => {
    setSelectedColumns((prev) => {
      if (!prev || !prev.length) return columnsData
      const prevKeys = new Set(prev.map((c) => c.nombrevar))
      const next = columnsData.filter((col) => prevKeys.has(col.nombrevar))
      columnsData.forEach((col) => {
        if (!prevKeys.has(col.nombrevar)) next.push(col)
      })
      return next
    })
  }, [columnsData])

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
    if (field === 'precio' || field === 'precio_con_iva') {
      const num = Number(row?.[field])
      return Number.isFinite(num) ? num.toFixed(2) : ''
    }
    if (field === 'total_general' || field.startsWith('sucursal_')) {
      const num = Number(row?.[field])
      return Number.isFinite(num) ? String(num) : ''
    }
    return row?.[field] ?? ''
  }, [])

  const [selectedRows, setSelectedRows] = useState([])

  const selectedRowIds = useMemo(
    () => (selectedRows || []).map((row) => normId(row?.id)).filter(Boolean),
    [selectedRows]
  )
  const allRowsSelected = allRowIds.length > 0 && selectedRowIds.length === allRowIds.length

  useEffect(() => {
    const saved = sessionStorage.getItem('inventario-table-selected-rows')
    if (!saved) return
    try {
      const parsed = JSON.parse(saved)
      const ids = (parsed.selectedRowIds || []).map(normId).filter(Boolean)
      sessionStorage.setItem('inventario-table-selected-rows-pending', JSON.stringify({ ids }))
    } catch {
      sessionStorage.removeItem('inventario-table-selected-rows')
      sessionStorage.removeItem('inventario-table-selected-rows-pending')
    }
  }, [])

  useEffect(() => {
    const pending = sessionStorage.getItem('inventario-table-selected-rows-pending')
    if (!pending) return
    try {
      const parsed = JSON.parse(pending)
      const ids = (parsed.ids || []).map(normId).filter(Boolean)
      if (!ids.length) {
        setSelectedRows([])
        sessionStorage.removeItem('inventario-table-selected-rows-pending')
        return
      }
      const map = new Map(selectionBaseRows.map((row) => [normId(row?.id), row]))
      const rows = ids.map((id) => map.get(id)).filter(Boolean)
      setSelectedRows(rows)
      sessionStorage.removeItem('inventario-table-selected-rows-pending')
    } catch {
      sessionStorage.removeItem('inventario-table-selected-rows-pending')
    }
  }, [selectionBaseRows])

  useEffect(() => {
    if (!selectionBaseRows?.length) {
      if (selectedRows?.length) setSelectedRows([])
      return
    }
    const idsSet = new Set(allRowIds)
    const filtered = (selectedRows || []).filter((row) => idsSet.has(normId(row?.id)))
    if (filtered.length !== (selectedRows || []).length) setSelectedRows(filtered)
  }, [selectionBaseRows, allRowIds, selectedRows])

  useEffect(() => {
    sessionStorage.setItem(
      'inventario-table-selected-rows',
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

  const getRowsToExport = useCallback(() => {
    if (selectedRows?.length) return selectedRows
    return processedRows === null ? filteredRows : processedRows
  }, [processedRows, selectedRows, filteredRows])

  const notifyExportWarning = useCallback((detail) => {
    toast.current?.show({ severity: 'warn', summary: 'Sin datos', detail, life: 3000 })
  }, [])

  const handleExportExcel = useCallback(async () => {
    if (!exportColumns.length) {
      notifyExportWarning('Selecciona al menos una columna para exportar.')
      return
    }
    const baseRows = processedRows === null ? filteredRows : processedRows
    if (!selectedRows?.length) {
      notifyExportWarning(baseRows.length ? 'Debe seleccionar al menos una fila para generar el reporte.' : 'No hay registros para exportar.')
      return
    }
    const rows = selectedRows
    await exportToExcel({
      rows,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('inventario'),
    })
  }, [exportColumns, filteredRows, getExportValue, notifyExportWarning, processedRows, selectedRows])

  const handleExportPdf = useCallback(async () => {
    if (!exportColumns.length) {
      notifyExportWarning('Selecciona al menos una columna para exportar.')
      return
    }
    const baseRows = processedRows === null ? filteredRows : processedRows
    if (!selectedRows?.length) {
      notifyExportWarning(baseRows.length ? 'Debe seleccionar al menos una fila para generar el reporte.' : 'No hay registros para exportar.')
      return
    }
    const rows = selectedRows
    await exportToPdf({
      rows,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('inventario'),
      title: 'Reporte de inventario',
    })
  }, [exportColumns, filteredRows, getExportValue, notifyExportWarning, processedRows, selectedRows])
  const quantityBody = (field) => (rowData) => {
    const value = normalizeNumber(rowData?.[field])
    return (
      <span className={`inventario__quantity${value === 0 ? ' inventario__quantity--empty' : ''}`}>
        {value}
      </span>
    )
  }

  const cellWithTooltip = (rowData, field) => {
    const content = rowData?.[field] ?? '-'
    const text = String(content)
    const textColor = content === '-' ? '#9ca3af' : undefined
    return (
      <span className="cell-tooltip" data-pr-tooltip={text} style={{ color: textColor }}>
        {text}
      </span>
    )
  }

  const priceBodyTemplate = (rowData, field) => {
    if (field === 'precio_con_iva' && ivaLoading) {
      return (
        <span className="cell-tooltip" data-pr-tooltip="...">
          ...
        </span>
      )
    }
    const value = field === 'precio_con_iva' ? rowData?.precio_con_iva : rowData?.precio
    const text = formatCurrency(value)
    return (
      <span className="cell-tooltip" data-pr-tooltip={text}>
        {text}
      </span>
    )
  }

  const hasSearch = Boolean(appliedCriteria)

  const openDetails = (row) => {
    setActiveProduct(row)
    setShowDetails(true)
  }

  const handleRowClick = (event) => {
    const t = event?.originalEvent?.target
    if (t?.closest?.('.p-checkbox') || t?.closest?.('.row-selection-column')) return
    const row = event?.data
    if (!row) return
    openDetails(row)
  }

  const dataLength = hasSearch ? filteredRows.length : 0
  const emptyMessage = hasSearch
    ? 'No se encontraron registros'
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

        <button className="rounded-icon-btn" type="button" onClick={refreshData} disabled={loading} title="Recargar">
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
          x: Math.min(
            Math.max(prevPos.x, SEARCH_PADDING),
            Math.max(window.innerWidth - width - SEARCH_PADDING, SEARCH_PADDING)
          ),
          y: Math.min(
            Math.max(prevPos.y, SEARCH_PADDING),
            Math.max(window.innerHeight - height - SEARCH_PADDING, SEARCH_PADDING)
          ),
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
    <div className="users-page inventario-page">
      <Tooltip position="top" showDelay={1800} target=".cell-tooltip" style={{ maxWidth: '340px' }} />
      <Toast ref={toast} />

      <div className="users-page__top">
        <div className="users-page__actions inventario__actions">
          <Button
            label="Buscar"
            icon="pi pi-search"
            className="users-topbtn users-topbtn--search"
            onClick={focusSearch}
            type="button"
          />
        </div>
      </div>

      <div className="users-table users-table--card">
        {loading && (
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
          value={hasSearch ? filteredRows : []}
          dataKey="id"
          header={header}
          className="users-datatable inventario-datatable"
          tableStyle={{ width: '100%' }}
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
          onValueChange={(value) => setProcessedRows(Array.isArray(value) ? value : null)}
          globalFilterFields={globalFilterFields}
          stateStorage="session"
          stateKey="inventario-table-state"
          reorderableColumns
          onColReorder={handleOrderChange}
          resizableColumns
          columnResizeMode="fit"
          onRowClick={handleRowClick}
          rowClassName={(rowData) =>
            selectedRowIds.includes(normId(rowData?.id)) ? 'selected-row-shadow inventario__row' : 'inventario__row'
          }
          emptyMessage={loading ? 'Cargando inventario...' : emptyMessage}
          selectionMode="multiple"
          selection={selectedRows}
          onSelectionChange={(e) => {
            if (!isCheckboxSelection(e)) return
            setSelectedRows(e.value || [])
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
            resizable={false}
            exportable={false}
            reorderable={false}
          />

          {selectedColumns.map((column) => {
            let bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
            let className = 'column-max-min-width'
            let filterMatchMode = FilterMatchMode.CONTAINS
            let showFilterMatchModes = true
            let showFilterOperator = true
            let filterElement = undefined

            switch (column.nombrevar) {
              case 'codigo':
                bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                break
              case 'nombre':
              case 'marca_nombre':
                bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                break
              case 'precio':
              case 'precio_con_iva':
                bodyTemplate = (rowData) => priceBodyTemplate(rowData, column.nombrevar)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                className = 'column-max-min-width--small'
                break
              case 'total_general':
                bodyTemplate = quantityBody(column.nombrevar)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                className = 'column-max-min-width--small'
                break
              default:
                if (column.nombrevar.startsWith('sucursal_')) {
                  bodyTemplate = quantityBody(column.nombrevar)
                  filterMatchMode = FilterMatchMode.STARTS_WITH
                  className = 'column-max-min-width--small'
                }
                break
            }

            return (
              <Column
                key={column.nombrevar}
                field={column.nombrevar}
                header={column.header}
                body={bodyTemplate}
                sortable
                reorderable
                filter
                filterField={column.nombrevar}
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
            <div
              key={col.nombrevar}
              className="p-field-checkbox"
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}
            >
              <Checkbox
                inputId={col.nombrevar}
                name="category"
                value={col}
                onChange={() => handleCheckboxChangeColumn(col)}
                checked={selectedColumns.some((item) => item.nombrevar === col.nombrevar)}
              />
              <label htmlFor={col.nombrevar}>{col.header}</label>
            </div>
          ))}
        </OverlayPanel>
      </div>

      <ProductoDetails
        open={showDetails}
        productoId={activeProduct?.id ?? null}
        token={token}
        onClose={() => setShowDetails(false)}
        onUpdated={fetchData}
        onDeleted={fetchData}
        onError={(message) => showToast(message, 'Error', 'error')}
        inventoryContext={{
          branches,
          bodegas,
          subdivisions,
          inventarioEntries: activeProduct ? inventoryByProductId.get(activeProduct.id) || [] : [],
          onSaved: fetchData,
        }}
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
                <h3>Buscar inventario</h3>
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
                      <span>Nombre</span>
                      <input
                        name="nombre"
                        type="text"
                        placeholder="Ej: Filtro de aire"
                        value={searchCriteria.nombre}
                        onChange={handleSearchInputChange}
                      />
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
                      <span>Codigo</span>
                      <input
                        name="codigo"
                        type="text"
                        placeholder="Ej: PRD-001"
                        value={searchCriteria.codigo}
                        onChange={handleSearchInputChange}
                      />
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
                      <span>OEM</span>
                      <input
                        name="oem"
                        type="text"
                        placeholder="Ej: 1234-ABC"
                        value={searchCriteria.oem}
                        onChange={handleSearchInputChange}
                      />
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
                      <input
                        name="costo_minimo"
                        type="text"
                        placeholder="Ej: 10.50"
                        value={searchCriteria.costo_minimo}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Costo maximo</span>
                      <input
                        name="costo_maximo"
                        type="text"
                        placeholder="Ej: 45.00"
                        value={searchCriteria.costo_maximo}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Precio sugerido</span>
                      <input
                        name="precio"
                        type="text"
                        placeholder="Ej: 60.00"
                        value={searchCriteria.precio}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Fecha de creacion</span>
                      <input
                        name="fecha_creacion"
                        type="text"
                        placeholder="Ej: 2025-12-31"
                        value={searchCriteria.fecha_creacion}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Cantidad minima</span>
                      <input
                        name="cantidad_min"
                        type="number"
                        min="0"
                        step="1"
                        value={searchCriteria.cantidad_min}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Cantidad maxima</span>
                      <input
                        name="cantidad_max"
                        type="number"
                        min="0"
                        step="1"
                        value={searchCriteria.cantidad_max}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field create-user__field--full">
                      <span>Descripcion</span>
                      <input
                        name="descripcion"
                        type="text"
                        placeholder="Ej: Repuesto original"
                        value={searchCriteria.descripcion}
                        onChange={handleSearchInputChange}
                      />
                    </label>
                  </div>
                </section>
              </div>

              <div className="create-user__footer">
                <div className="user-details__footer-left">
                  <button
                    type="button"
                    className="create-user__action"
                    onClick={resetSearch}
                  >
                    Limpiar filtros
                  </button>
                  <button
                    type="button"
                    className="create-user__action create-user__action--cancel"
                    onClick={() => setShowSearchModal(false)}
                  >
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

export default InventarioTable
