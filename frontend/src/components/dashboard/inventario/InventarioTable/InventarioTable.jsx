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

import useModalAnimation from '../../common/useModalAnimation'
import { API_URL, authFetch } from '../../../../utils/api'
import { onIvaUpdated } from '../../../../utils/configEvents'
import ProductoDetails from '../../productos/ProductoDetails/ProductoDetails'
import { getModuleActions, moduleHasAnyAction } from '../../menuConfig'
import { buildFileName, exportToExcel, exportToPdf } from '../../../../utils/exportUtils'
import {
  buildPrimeColumnFiltersPayload,
  buildPrimeOrdering,
  getPrimeGlobalFilterValue,
} from '../../../../utils/primeTableQuery'
import { clearTableLayouts } from '../../../../utils/tableLayoutSync'

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const parseBranchMetadata = (payload) => {
  if (!Array.isArray(payload)) return []
  return payload
    .map((item) => ({
      id: Number(item?.id) || 0,
      nombre: String(item?.nombre || '').trim(),
      direccion: String(item?.direccion || '').trim(),
    }))
    .filter((branch) => branch.id > 0)
}
const DEFAULT_IVA_RATE = 0.15
const normId = (value) => (value == null ? null : String(value))

const normalizeNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const formatCurrency = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : '-'
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
  casa_comercial: '',
  pieza_original: '',
  costo_minimo: '',
  precio: '',
  fecha_creacion: '',
  cantidad_min: '',
  cantidad_max: '',
}
const buildDefaultAppliedCriteria = () => ({ ...initialSearchCriteria, __onlyWithInventory: false })
const INVENTARIO_FILTER_FIELDS = [
  'codigo',
  'nombre',
  'pieza_original_label',
  'referencia',
  'oem_codes',
  'costo_minimo',
  'precio',
  'precio_con_iva',
  'casa_comercial_nombre',
  'total_general',
]
const INVENTARIO_FILTER_DEFAULT_MODES = {
  codigo: FilterMatchMode.STARTS_WITH,
  nombre: FilterMatchMode.STARTS_WITH,
  pieza_original_label: FilterMatchMode.STARTS_WITH,
  referencia: FilterMatchMode.STARTS_WITH,
  oem_codes: FilterMatchMode.STARTS_WITH,
  costo_minimo: FilterMatchMode.EQUALS,
  precio: FilterMatchMode.EQUALS,
  precio_con_iva: FilterMatchMode.EQUALS,
  casa_comercial_nombre: FilterMatchMode.STARTS_WITH,
  total_general: FilterMatchMode.EQUALS,
}
const INVENTARIO_ORDERING_MAP = {
  codigo: 'codigo',
  nombre: 'nombre',
  pieza_original_label: 'pieza_original_label',
  costo_minimo: 'costo_minimo',
  precio: 'precio',
  precio_con_iva: 'precio_con_iva',
  casa_comercial_nombre: 'casa_comercial_nombre',
  total_general: 'total_general',
}

function InventarioTable({ token, user, permissionIndex }) {
  const toast = useRef(null)
  const [loading, setLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isGlobalSearchPending, setIsGlobalSearchPending] = useState(false)
  const [error, setError] = useState(null)
  const [inventories, setInventories] = useState([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [pageFirst, setPageFirst] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [sortField, setSortField] = useState(null)
  const [sortOrder, setSortOrder] = useState(null)
  const [branches, setBranches] = useState([])
  const [bodegas, setBodegas] = useState([])
  const [subdivisions, setSubdivisions] = useState([])
  const [searchCriteria, setSearchCriteria] = useState(initialSearchCriteria)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const [isSearchMaximized, setIsSearchMaximized] = useState(false)
  const [searchPosition, setSearchPosition] = useState({ x: 0, y: 0 })
  const [searchSize, setSearchSize] = useState({ width: 720, height: 520 })
  const [isCodigoColumnFrozen, setIsCodigoColumnFrozen] = useState(false)
  const searchModalRef = useRef(null)
  const searchDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const searchResize = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const searchSizeRef = useRef(searchSize)
  const searchPosRef = useRef(searchPosition)
  const searchRestoreRef = useRef(null)
  const SEARCH_MIN_WIDTH = 640
  const SEARCH_MIN_HEIGHT = 480
  const SEARCH_PADDING = 12
  const lastSearchRef = useRef(buildDefaultAppliedCriteria())
  const [searchCasaQuery, setSearchCasaQuery] = useState('')
  const [searchCasaOptions, setSearchCasaOptions] = useState([])
  const [searchCasaLoading, setSearchCasaLoading] = useState(false)
  const [showSearchCasaDropdown, setShowSearchCasaDropdown] = useState(false)
  const searchCasaDropdownRef = useRef(null)
  const [activeProduct, setActiveProduct] = useState(null)
  const [activeProductInventoryEntries, setActiveProductInventoryEntries] = useState([])
  const [showDetails, setShowDetails] = useState(false)
  const [ivaRate, setIvaRate] = useState(DEFAULT_IVA_RATE)
  const [ivaLoading, setIvaLoading] = useState(false)
  const opColumns = useRef(null)
  const [tableResetKey, setTableResetKey] = useState(0)
  const didInitialSearchRef = useRef(false)
  const productModuleActions = useMemo(
    () => getModuleActions('productos', permissionIndex),
    [permissionIndex]
  )
  const canEditProductDetails = Boolean(productModuleActions?.puede_actualizar)
  const canDeleteProductDetails = Boolean(productModuleActions?.puede_eliminar)
  const isAdminByRole = Boolean(
    user?.is_superuser ||
      user?.is_staff ||
      user?.es_administrador ||
      String(user?.rol || '').trim().toLowerCase() === 'administrador'
  )
  const isAdminByUsersPermissions = moduleHasAnyAction('usuarios', permissionIndex)
  const canSeeCost = isAdminByRole || isAdminByUsersPermissions

  const [filters, setFilters] = useState(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')
  const globalSearchDebounceRef = useRef(null)
  const globalSearchSeqRef = useRef(0)

  useEffect(
    () => () => {
      if (globalSearchDebounceRef.current) {
        clearTimeout(globalSearchDebounceRef.current)
      }
      setIsGlobalSearchPending(false)
    },
    []
  )

  const showToast = useCallback((detail, summary = 'Aviso', severity = 'warn') => {
    toast.current?.show({ severity, summary, detail, life: 3500 })
  }, [])

  const buildInventarioListUrl = useCallback((criteria, options = {}) => {
    const params = new URLSearchParams()
    const page = Number(options?.page) || 1
    const rows = Number(options?.rows) || 25
    const tableFilters = options?.tableFilters
    const tableSortField = options?.tableSortField
    const tableSortOrder = options?.tableSortOrder
    const branchFields = branches.map((branch) => `sucursal_${branch.id}`)

    params.set('page', String(page))
    params.set('page_size', String(rows))

    const addIfPresent = (key, value) => {
      const parsed = String(value ?? '').trim()
      if (parsed) params.set(key, parsed)
    }

    addIfPresent('codigo', criteria?.codigo)
    addIfPresent('nombre', criteria?.nombre)
    addIfPresent('oem', criteria?.oem)
    addIfPresent('descripcion', criteria?.descripcion)
    addIfPresent('casa_comercial', criteria?.casa_comercial)
    addIfPresent('pieza_original', criteria?.pieza_original)
    addIfPresent('costo_minimo', criteria?.costo_minimo)
    addIfPresent('precio', criteria?.precio)
    addIfPresent('fecha_creacion', criteria?.fecha_creacion)
    addIfPresent('cantidad_min', criteria?.cantidad_min)
    addIfPresent('cantidad_max', criteria?.cantidad_max)
    if (criteria?.__onlyWithInventory) {
      addIfPresent('cantidad_min', criteria?.cantidad_min || '1')
    }

    const hasExplicitGlobalSearch = Object.prototype.hasOwnProperty.call(options || {}, 'globalSearchValue')
    const globalSearch = hasExplicitGlobalSearch
      ? String(options?.globalSearchValue ?? '').trim()
      : getPrimeGlobalFilterValue(tableFilters)
    if (globalSearch) params.set('search', globalSearch)

    const allowedFilterFields = [...INVENTARIO_FILTER_FIELDS, ...branchFields]
    const filterDefaultModes = { ...INVENTARIO_FILTER_DEFAULT_MODES }
    branchFields.forEach((field) => {
      filterDefaultModes[field] = FilterMatchMode.EQUALS
    })
    const columnFilters = buildPrimeColumnFiltersPayload(tableFilters, {
      allowedFields: allowedFilterFields,
      defaultMatchModes: filterDefaultModes,
    })
    if (columnFilters) params.set('column_filters', JSON.stringify(columnFilters))

    const orderingMap = { ...INVENTARIO_ORDERING_MAP }
    branchFields.forEach((field) => {
      orderingMap[field] = field
    })
    const ordering = buildPrimeOrdering(tableSortField, tableSortOrder, orderingMap)
    if (ordering) params.set('ordering', ordering)

    return `${API_URL}/inventario/inventario/tabla/?${params.toString()}`
  }, [branches])

  const fetchLookupData = useCallback(async () => {
    if (!token) return
    try {
      const [bodegasRes, subdivisionsRes] = await Promise.all([
        authFetch(`${API_URL}/inventario/bodegas/?page_size=500&modulo=inventario`, {}, token),
        authFetch(`${API_URL}/inventario/subdivisiones/?page_size=500&modulo=inventario`, {}, token),
      ])
      if (!bodegasRes.ok) throw new Error('No se pudieron cargar las bodegas.')
      if (!subdivisionsRes.ok) throw new Error('No se pudieron cargar las subdivisiones.')
      const [bodegasData, subdivisionsData] = await Promise.all([bodegasRes.json(), subdivisionsRes.json()])
      setBodegas(parseApiList(bodegasData))
      setSubdivisions(parseApiList(subdivisionsData))
    } catch (err) {
      showToast(err?.message || 'No se pudo cargar la configuración de ubicaciones.', 'Error', 'error')
    }
  }, [showToast, token])

  const fetchData = useCallback(
    async (criteria, page = 1, rows = pageSize, options = {}) => {
      if (!token) {
        setIsRefreshing(false)
        return []
      }
      const withOverlay = options?.withOverlay !== false
      if (withOverlay) {
        setLoading(true)
      }
      setError(null)
      try {
        const hasExplicitSort = Object.prototype.hasOwnProperty.call(options || {}, 'tableSortField')
        const tableFilters = options?.tableFilters ?? filters
        const tableSortField = hasExplicitSort ? options.tableSortField : sortField
        const tableSortOrder = hasExplicitSort ? options.tableSortOrder : sortOrder
        const globalSearchValue = Object.prototype.hasOwnProperty.call(options || {}, 'globalSearchValue')
          ? options?.globalSearchValue
          : globalFilterValue
        const url = buildInventarioListUrl(criteria, {
          page,
          rows,
          tableFilters,
          tableSortField,
          tableSortOrder,
          globalSearchValue,
        })
        const response = await authFetch(url, {}, token)
        if (!response.ok) throw new Error('No se pudo cargar el inventario.')
        const data = await response.json()
        if (
          data &&
          typeof data === 'object' &&
          !Array.isArray(data) &&
          Object.prototype.hasOwnProperty.call(data, 'branches')
        ) {
          setBranches(parseBranchMetadata(data.branches))
        }
        const count = Array.isArray(data) ? data.length : Number(data?.count ?? 0)
        const list = parseApiList(data)

        setInventories(list)
        setTotalRecords(count)
        setPageFirst(Math.max(0, (page - 1) * rows))
        setPageSize(rows)
        return list
      } catch (err) {
        const message = err?.message || 'Ocurrió un error al cargar el inventario.'
        setError(message)
        setInventories([])
        setTotalRecords(0)
        showToast(message, 'Error', 'error')
      } finally {
        if (withOverlay) {
          setLoading(false)
        }
        setIsRefreshing(false)
      }
      return []
    },
    [token, pageSize, filters, sortField, sortOrder, globalFilterValue, buildInventarioListUrl, showToast]
  )

  const fetchInventoryByProductId = useCallback(
    async (productId) => {
      const normalizedId = Number(productId)
      if (!token || !Number.isFinite(normalizedId) || normalizedId <= 0) {
        setActiveProductInventoryEntries([])
        return []
      }
      try {
        let nextUrl = `${API_URL}/inventario/inventario/?producto_ids=${normalizedId}&page_size=500`
        const list = []
        while (nextUrl) {
          const response = await authFetch(nextUrl, {}, token)
          if (!response.ok) throw new Error('No se pudo cargar el detalle de inventario del producto.')
          const data = await response.json()
          if (Array.isArray(data)) {
            list.push(...data)
            break
          }
          list.push(...parseApiList(data))
          nextUrl = data?.next || null
        }
        setActiveProductInventoryEntries(list)
        return list
      } catch (err) {
        setActiveProductInventoryEntries([])
        showToast(err?.message || 'No se pudo cargar el detalle de inventario del producto.', 'Error', 'error')
        return []
      }
    },
    [showToast, token]
  )

  const refreshCurrentProductInventory = useCallback(() => {
    const productId = Number(activeProduct?.producto_id)
    if (!Number.isFinite(productId) || productId <= 0) {
      setActiveProductInventoryEntries([])
      return
    }
    fetchInventoryByProductId(productId)
  }, [activeProduct, fetchInventoryByProductId])

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
    fetchLookupData()
  }, [fetchLookupData])

  useEffect(() => {
    if (token) return
    didInitialSearchRef.current = false
    setInventories([])
    setTotalRecords(0)
    setLoading(false)
    setIsRefreshing(false)
  }, [token])

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

  useEffect(() => {
    if (!token) return
    if (didInitialSearchRef.current) return
    if (!filters) return
    didInitialSearchRef.current = true
    setIsRefreshing(true)
    fetchData(lastSearchRef.current, 1, pageSize, {
      tableFilters: filters,
      globalSearchValue: globalFilterValue,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
    })
  }, [fetchData, filters, globalFilterValue, pageSize, sortField, sortOrder, token])

  useEffect(() => {
    if (!showDetails) {
      setActiveProductInventoryEntries([])
      return
    }
    refreshCurrentProductInventory()
  }, [showDetails, refreshCurrentProductInventory])

  const handleSearchInputChange = (event) => {
    const { name, value } = event.target
    setSearchCriteria((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

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
          `${API_URL}/casa-comercial/casas/?search=${encodeURIComponent(term)}&page_size=5`,
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
    setSearchCasaQuery(searchCriteria.casa_comercial || '')
  }, [showSearchModal, searchCriteria.casa_comercial])

  useEffect(() => {
    if (!showSearchModal) return
    const handleClick = (event) => {
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
  }, [showSearchModal, showSearchCasaDropdown])

  const handleSearchSubmit = async (event) => {
    event.preventDefault()
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    setIsGlobalSearchPending(false)
    const nextCriteria = { ...searchCriteria }
    const isEmptyValue = (value) => {
      if (value === null || value === undefined) return true
      if (typeof value === 'string') return value.trim() === ''
      return String(value).trim() === ''
    }
    const isCriteriaEmpty = Object.values(nextCriteria).every(isEmptyValue)
    const applied = isCriteriaEmpty ? buildDefaultAppliedCriteria() : nextCriteria
    lastSearchRef.current = applied
    setShowSearchModal(false)
    setPageFirst(0)
    setIsRefreshing(true)
    await fetchData(applied, 1, pageSize, {
      tableFilters: filters,
      globalSearchValue: globalFilterValue,
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
    setIsGlobalSearchPending(false)
    setIsRefreshing(true)
    const currentPage = Math.floor(pageFirst / pageSize) + 1
    fetchData(lastSearchRef.current, currentPage, pageSize, {
      tableFilters: filters,
      globalSearchValue: globalFilterValue,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
    })
  }

  const resetSearch = () => {
    setSearchCriteria(initialSearchCriteria)
    setSearchCasaQuery('')
    setSearchCasaOptions([])
    setShowSearchCasaDropdown(false)
  }

  const rows = useMemo(
    () =>
      (Array.isArray(inventories) ? inventories : []).map((row) => {
        const precioBase = Number(row?.precio)
        const productIdRaw = Number(row?.producto_id ?? row?.id)
        const productId = Number.isFinite(productIdRaw) && productIdRaw > 0 ? productIdRaw : null
        const normalizedRow = {
          ...row,
          id: productId ?? row?.id,
          producto_id: productId ?? row?.producto_id ?? null,
          pieza_original: Boolean(row?.pieza_original),
          pieza_original_label: row?.pieza_original ? 'Activo' : 'Inactivo',
          total_general: normalizeNumber(row?.total_general),
          precio_con_iva: Number.isFinite(precioBase) ? precioBase * (1 + ivaRate) : null,
        }
        branches.forEach((branch) => {
          const fieldName = `sucursal_${branch.id}`
          normalizedRow[fieldName] = normalizeNumber(row?.[fieldName])
        })
        return normalizedRow
      }),
    [inventories, ivaRate, branches]
  )

  const initFilters = useCallback(() => {
    const nextFilters = {
      global: { value: null, matchMode: FilterMatchMode.CONTAINS },
      codigo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      pieza_original_label: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      casa_comercial_nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      referencia: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      oem_codes: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      costo_minimo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.EQUALS }] },
      precio: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.EQUALS }] },
      precio_con_iva: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.EQUALS }] },
      total_general: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.EQUALS }] },
    }
    branches.forEach((branch) => {
      nextFilters[`sucursal_${branch.id}`] = {
        operator: FilterOperator.AND,
        constraints: [{ value: null, matchMode: FilterMatchMode.EQUALS }],
      }
    })
    setFilters(nextFilters)
    return nextFilters
  }, [branches])

  useEffect(() => {
    initFilters()
  }, [initFilters])

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

  const clearFilter = async () => {
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    setIsGlobalSearchPending(false)
    const nextFilters = {
      ...initFilters(),
      global: { value: globalFilterValue || null, matchMode: FilterMatchMode.CONTAINS },
    }
    setFilters(nextFilters)
    resetSearch()
    const defaultApplied = buildDefaultAppliedCriteria()
    lastSearchRef.current = defaultApplied
    setSortField(null)
    setSortOrder(null)
    setPageFirst(0)
    setIsRefreshing(true)
    await fetchData(defaultApplied, 1, pageSize, {
      globalSearchValue: globalFilterValue,
      tableSortField: null,
      tableSortOrder: null,
      tableFilters: nextFilters,
    })
  }

  const handleResetTable = () => {
    localStorage.removeItem('inventario-table-columns')
    localStorage.removeItem('inventario-table-state')
    setSelectedColumns(visibleColumnsData.filter((c) => c.nombrevar !== 'pieza_original_label'))
    clearFilter()
    setTableResetKey((k) => k + 1)
    clearTableLayouts(['inventario-table-columns', 'inventario-table-state'], token)
    opColumns.current?.hide()
  }

  function handleGlobalFilterChange(event) {
    const value = event.target.value
    setGlobalFilterValue(value)
    setPageFirst(0)
    const nextFilters = {
      ...(filters || {}),
      global: { value: value || null, matchMode: FilterMatchMode.CONTAINS },
    }
    setFilters(nextFilters)
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    const seq = globalSearchSeqRef.current + 1
    globalSearchSeqRef.current = seq
    setIsGlobalSearchPending(true)
    globalSearchDebounceRef.current = setTimeout(() => {
      fetchData(lastSearchRef.current, 1, pageSize, {
        tableFilters: nextFilters,
        globalSearchValue: value,
        tableSortField: sortField,
        tableSortOrder: sortOrder,
        withOverlay: false,
      }).finally(() => {
        if (globalSearchSeqRef.current === seq) {
          setIsGlobalSearchPending(false)
        }
      })
    }, 500)
  }

  const handleTableFilterChange = async (event) => {
    const rawFilters = event?.filters || {}
    const nextFilters = {
      ...rawFilters,
      global: { value: globalFilterValue || null, matchMode: FilterMatchMode.CONTAINS },
    }
    setFilters(nextFilters)
    setPageFirst(0)
    await fetchData(lastSearchRef.current, 1, pageSize, {
      tableFilters: nextFilters,
      globalSearchValue: globalFilterValue,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
      withOverlay: false,
    })
  }

  const handleSortChange = async (event) => {
    const rawSortOrder = Number(event?.sortOrder)
    const normalizedSortOrder = rawSortOrder === 1 || rawSortOrder === -1 ? rawSortOrder : null
    const nextSortField = normalizedSortOrder ? event?.sortField || null : null
    setSortField(nextSortField)
    setSortOrder(normalizedSortOrder)
    setPageFirst(0)
    setIsRefreshing(true)
    await fetchData(lastSearchRef.current, 1, pageSize, {
      tableFilters: filters,
      globalSearchValue: globalFilterValue,
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
    setIsRefreshing(true)
    await fetchData(lastSearchRef.current, nextPage, nextRows, {
      tableFilters: filters,
      globalSearchValue: globalFilterValue,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
    })
  }

  const filteredRows = rows

  // ---------------- Columns ----------------
  const columnsData = useMemo(
    () => [
      { nombrevar: 'codigo', header: 'Código', filterPlaceholder: 'Buscar por código' },
      { nombrevar: 'nombre', header: 'Nombre', filterPlaceholder: 'Buscar por nombre' },
      { nombrevar: 'pieza_original_label', header: 'Original', filterPlaceholder: 'Si/No' },
      { nombrevar: 'precio', header: 'Precio', filterPlaceholder: 'Buscar por precio' },
      { nombrevar: 'precio_con_iva', header: 'Precio + IVA', filterPlaceholder: 'Buscar por precio + IVA' },
      { nombrevar: 'costo_minimo', header: 'Costo', filterPlaceholder: 'Buscar por costo' },
      { nombrevar: 'referencia', header: 'Referencia', filterPlaceholder: 'Buscar por referencia' },
      { nombrevar: 'oem_codes', header: 'OEM', filterPlaceholder: 'Buscar por OEM' },
      { nombrevar: 'casa_comercial_nombre', header: 'Casa comercial', filterPlaceholder: 'Buscar por casa comercial' },
      { nombrevar: 'total_general', header: 'Total', filterPlaceholder: 'Filtrar por total' },
      ...branches.map((branch) => ({
        nombrevar: `sucursal_${branch.id}`,
        header: branch.nombre,
        filterPlaceholder: `Filtrar por ${branch.nombre}`,
      })),
    ],
    [branches]
  )

  const globalFilterFields = useMemo(() => {
    const baseFields = columnsData.map((col) => col.nombrevar)
    const extraFields = ['descripcion', 'oem_codes', 'casas_comerciales_nombres', 'pieza_original_label']
    return Array.from(new Set([...baseFields, ...extraFields]))
  }, [columnsData])

  const visibleColumnsData = useMemo(
    () => (canSeeCost ? columnsData : columnsData.filter((column) => column.nombrevar !== 'costo_minimo')),
    [canSeeCost, columnsData]
  )

  const [selectedColumns, setSelectedColumns] = useState(() =>
    visibleColumnsData.filter((c) => c.nombrevar !== 'pieza_original_label')
  )
  const selectedColumnsRef = useRef(selectedColumns)
  const [processedRows, setProcessedRows] = useState(null)
  useEffect(() => {
    setProcessedRows(null)
  }, [rows])

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
        setSelectedColumns(visibleColumnsData.filter((c) => c.nombrevar !== 'pieza_original_label'))
      }
    }
    return () => {
      localStorage.setItem('inventario-table-columns', JSON.stringify(selectedColumnsRef.current))
    }
  }, [])

  useEffect(() => {
    setSelectedColumns((prev) => {
      if (!prev || !prev.length)
        return visibleColumnsData.filter((c) => c.nombrevar !== 'pieza_original_label')
      const prevKeys = new Set(prev.map((c) => c.nombrevar))
      const next = visibleColumnsData.filter((col) => prevKeys.has(col.nombrevar))
      visibleColumnsData.forEach((col) => {
        // Never auto-add pieza_original_label — it defaults to hidden
        if (!prevKeys.has(col.nombrevar) && col.nombrevar !== 'pieza_original_label') next.push(col)
      })
      return next
    })
  }, [visibleColumnsData])

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
    if (field === 'precio' || field === 'precio_con_iva' || field === 'costo_minimo') {
      const num = Number(row?.[field])
      return Number.isFinite(num) ? num.toFixed(2) : ''
    }
    if (field === 'pieza_original_label') {
      return row?.pieza_original ? 'Activo' : 'Inactivo'
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
        <i
          className={`pi pi-${isOriginal ? 'check-circle' : 'times-circle'}`}
          style={{ color: isOriginal ? '#22c55e' : '#9ca3af' }}
        />
      </span>
    )
  }

  const numericBodyTemplate = (rowData, field) => {
    const value = Number(rowData?.[field])
    if (!Number.isFinite(value)) return <span className="cell-tooltip">-</span>
    const text = value.toFixed(2)
    return (
      <span className="cell-tooltip" data-pr-tooltip={text}>
        {text}
      </span>
    )
  }

  const casaComercialBodyTemplate = (rowData) => {
    const text = rowData?.casa_comercial_nombre ?? rowData?.casas_comerciales_nombres ?? '-'
    const tooltip = text === '-' ? 'Sin casa comercial asociada' : text
    return (
      <span className="cell-tooltip" data-pr-tooltip={tooltip}>
        {text}
      </span>
    )
  }

  const openDetails = useCallback(
    (row) => {
      const productId = Number(row?.producto_id)
      if (!Number.isFinite(productId) || productId <= 0) return
      setActiveProduct(row)
      setShowDetails(true)
    },
    []
  )

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
    const row = event?.data
    if (!row) return
    openDetails(row)
  }

  const dataLength = totalRecords ?? 0
  const emptyMessage = 'No se encontraron registros'

  const toggleCodigoColumnFrozen = useCallback(() => {
    setIsCodigoColumnFrozen((prev) => !prev)
  }, [])

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

  const { shouldRender: shouldRenderSearchModal, isClosing: isClosingSearchModal } = useModalAnimation(showSearchModal)

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
          key={tableResetKey}
          value={filteredRows}
          dataKey="id"
          header={header}
          className={`users-datatable inventario-datatable${(loading || isRefreshing) && !isGlobalSearchPending ? ' users-datatable--loading-content' : ''}${isGlobalSearchPending ? ' inventario-datatable--pending' : ''}`}
          stateStorage="local"
          stateKey="inventario-table-state"
          tableStyle={{ width: '100%' }}
          showGridlines
          size="small"
          scrollable
          scrollHeight="flex"
          frozenWidth={isCodigoColumnFrozen ? 240 : undefined}
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
          onFilter={handleTableFilterChange}
          onValueChange={(value) => setProcessedRows(Array.isArray(value) ? value : null)}
          globalFilterFields={globalFilterFields}
          reorderableColumns
          onColReorder={handleOrderChange}
          resizableColumns
          columnResizeMode="fit"
          onRowClick={handleRowClick}
          onRowDoubleClick={handleRowDoubleClick}
          rowClassName={(rowData) =>
            selectedRowIds.includes(normId(rowData?.id)) ? 'selected-row-shadow inventario__row' : 'inventario__row'
          }
          emptyMessage={loading || isRefreshing ? 'Cargando inventario...' : emptyMessage}
          selectionMode="multiple"
          selection={selectedRows}
          onSelectionChange={(e) => {
            if (!isCheckboxSelection(e)) return
            setSelectedRows(e.value || [])
          }}
        >
          <Column
            selectionMode="multiple"
            frozen={isCodigoColumnFrozen}
            headerClassName="row-selection-column row-selection-column--header"
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
            let enableFilter = true
            let filterMatchMode = FilterMatchMode.CONTAINS
            let showFilterMatchModes = true
            let showFilterOperator = true
            let filterElement = undefined
            const isCodigoColumn = column.nombrevar === 'codigo'
            let columnHeader = column.header

            switch (column.nombrevar) {
              case 'codigo':
                bodyTemplate = (rowData) => codigoBodyTemplate(rowData)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                columnHeader = (
                  <div className="codigo-column-header">
                    <span className="codigo-column-header__label">{column.header}</span>
                    <button
                      type="button"
                      className={`codigo-column-header-btn${
                        isCodigoColumnFrozen ? ' codigo-column-header-btn--active' : ''
                      }`}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleCodigoColumnFrozen()
                      }}
                      title={isCodigoColumnFrozen ? 'Desanclar columna de código' : 'Anclar columna de código'}
                    >
                      <i className="pi pi-thumbtack" />
                    </button>
                  </div>
                )
                break
              case 'nombre':
                bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                break
              case 'pieza_original_label':
                bodyTemplate = (rowData) => piezaOriginalBodyTemplate(rowData)
                className = 'column-max-min-width--small'
                enableFilter = false
                break
              case 'precio':
              case 'precio_con_iva':
              case 'costo_minimo':
                bodyTemplate = (rowData) => {
                  if (column.nombrevar === 'precio_con_iva' && ivaLoading) {
                    return (
                      <span className="cell-tooltip" data-pr-tooltip="...">
                        ...
                      </span>
                    )
                  }
                  return numericBodyTemplate(rowData, column.nombrevar)
                }
                className = 'column-max-min-width--small'
                enableFilter = false
                break
              case 'referencia':
              case 'oem_codes':
                bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                break
              case 'casa_comercial_nombre':
                bodyTemplate = (rowData) => casaComercialBodyTemplate(rowData)
                filterMatchMode = FilterMatchMode.STARTS_WITH
                break
              case 'total_general':
                bodyTemplate = quantityBody(column.nombrevar)
                filterMatchMode = FilterMatchMode.EQUALS
                showFilterMatchModes = false
                className = 'column-max-min-width--small'
                break
              default:
                if (column.nombrevar.startsWith('sucursal_')) {
                  bodyTemplate = quantityBody(column.nombrevar)
                  filterMatchMode = FilterMatchMode.EQUALS
                  showFilterMatchModes = false
                  className = 'column-max-min-width--small'
                }
                break
            }

            const columnClassNames = [className]
            if (isCodigoColumn) columnClassNames.push('column-codigo-column')

            return (
              <Column
                key={column.nombrevar}
                field={column.nombrevar}
                header={columnHeader}
                body={bodyTemplate}
                sortable
                reorderable
                filter={enableFilter}
                filterField={column.nombrevar}
                filterPlaceholder={column.filterPlaceholder}
                filterMatchMode={filterMatchMode}
                showFilterMenuOptions={enableFilter}
                showFilterMatchModes={enableFilter && showFilterMatchModes}
                showFilterOperator={enableFilter && showFilterOperator}
                filterApply={enableFilter ? filterApplyTemplate : undefined}
                filterClear={enableFilter ? filterClearTemplate : undefined}
                filterElement={filterElement}
                className={columnClassNames.join(' ')}
                headerClassName={isCodigoColumn ? 'column-codigo-header' : undefined}
                style={isCodigoColumn ? { width: '200px', minWidth: '200px', maxWidth: '200px' } : undefined}
                frozen={isCodigoColumn && isCodigoColumnFrozen}
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

          {visibleColumnsData.map((col) => (
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
        productoId={activeProduct?.producto_id ?? null}
        token={token}
        onClose={() => {
          setShowDetails(false)
          setActiveProduct(null)
        }}
        onUpdated={() => {
          refreshData()
          refreshCurrentProductInventory()
        }}
        onDeleted={() => {
          setShowDetails(false)
          setActiveProduct(null)
          refreshData()
        }}
        onError={(message) => showToast(message, 'Error', 'error')}
        currentUser={user}
        allowEdit={canEditProductDetails}
        allowDelete={canDeleteProductDetails}
        allowComment={Boolean(canEditProductDetails)}
        showCostField={canSeeCost}
        inventoryContext={{
          branches,
          bodegas,
          subdivisions,
          inventarioEntries: activeProductInventoryEntries,
          onSaved: () => {
            refreshData()
            refreshCurrentProductInventory()
          },
        }}
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
                      <span>Código</span>
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
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    setSearchCasaQuery(casa.nombre)
                                    setSearchCriteria((prev) => ({ ...prev, casa_comercial: casa.nombre }))
                                    setShowSearchCasaDropdown(false)
                                  }}
                                >
                                  <div className="create-user__result-info">
                                    <strong>{casa.nombre}</strong>
                                    <small>{casa.codigo ? `Código: ${casa.codigo}` : `ID: ${casa.id}`}</small>
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
                      <span>Original</span>
                      <select
                        name="pieza_original"
                        value={searchCriteria.pieza_original}
                        onChange={handleSearchInputChange}
                        className={!searchCriteria.pieza_original ? 'is-placeholder' : undefined}
                      >
                        <option value="">Todos</option>
                        <option value="true">Activo</option>
                        <option value="false">Inactivo</option>
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
                      <span>Fecha de creación</span>
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
                      <span>Descripción</span>
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

export default InventarioTable







