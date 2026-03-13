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

import useModalAnimation from '../../common/useModalAnimation'
import { API_URL, authFetch } from '../../../../utils/api'
import { onIvaUpdated } from '../../../../utils/configEvents'
import { buildFileName, exportToExcel, exportToPdf } from '../../../../utils/exportUtils'
import {
  buildPrimeColumnFiltersPayload,
  buildPrimeOrdering,
  getPrimeGlobalFilterValue,
} from '../../../../utils/primeTableQuery'
import { moduleHasAllActions, moduleHasAnyAction } from '../../menuConfig'

const normId = (value) => (value == null ? null : String(value))
const BULK_SELECT_CONFIRM_THRESHOLD = 1000
const DEFAULT_IVA_RATE = 0.15
const PRODUCT_FILTER_FIELDS = [
  'codigo',
  'nombre',
  'marca_nombre',
  'casa_comercial_nombre',
]
const PRODUCT_FILTER_DEFAULT_MODES = {
  codigo: FilterMatchMode.STARTS_WITH,
  nombre: FilterMatchMode.STARTS_WITH,
  marca_nombre: FilterMatchMode.STARTS_WITH,
  casa_comercial_nombre: FilterMatchMode.STARTS_WITH,
}
const PRODUCT_ORDERING_MAP = {
  codigo: 'codigo',
  nombre: 'nombre',
  marca_nombre: 'marca__nombre',
  pieza_original_label: 'pieza_original',
  costo_minimo: 'costo_minimo',
  precio: 'precio',
  precio_con_iva: 'precio_con_iva_backend',
  casa_comercial_nombre: 'casas_comerciales__nombre',
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

function ProductosTable({ token, onSelect, user, moduleActions, permissionIndex }) {
  const toast = useRef(null)
  const opColumns = useRef(null)
  const canCreate = moduleActions?.puede_crear ?? true
  const canEdit = moduleActions?.puede_actualizar ?? true
  const canDelete = moduleActions?.puede_eliminar ?? true
  const isAdminByRole = Boolean(
    user?.is_superuser ||
      user?.is_staff ||
      user?.es_administrador ||
      String(user?.rol || '').trim().toLowerCase() === 'administrador'
  )
  const isAdminByUsersPermissions = moduleHasAnyAction('usuarios', permissionIndex)
  const hasFullProductPermissions = moduleHasAllActions('productos', permissionIndex)
  const canSeeCost =
    isAdminByRole ||
    isAdminByUsersPermissions ||
    hasFullProductPermissions ||
    Boolean(canCreate) ||
    Boolean(canEdit)

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
  const [totalRecords, setTotalRecords] = useState(0)
  const [pageFirst, setPageFirst] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [loading, setLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(null)
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
  const [ivaRate, setIvaRate] = useState(DEFAULT_IVA_RATE)
  const [ivaLoading, setIvaLoading] = useState(false)
  const [sortField, setSortField] = useState(null)
  const [sortOrder, setSortOrder] = useState(null)
  const [filters, setFilters] = useState(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [showDetailsModal, setShowDetailsModal] = useState(false)

  const normalizeList = useCallback(
    (list) =>
      list.map((product) => {
        const houses = Array.isArray(product?.casas_comerciales) ? product.casas_comerciales : []
        const oems = Array.isArray(product?.oem_productos) ? product.oem_productos : []
        const oemCodes = oems
          .map((item) => item?.oem?.codigo ?? item?.oem_codigo ?? item?.codigo)
          .filter(Boolean)
        const firstHouseName = houses.map((house) => house?.nombre).find(Boolean) ?? '-'
        return {
          ...product,
          marca_nombre: product?.marca?.nombre ?? '-',
          casa_comercial_nombre: firstHouseName,
          casas_comerciales_nombres: houses.map((house) => house?.nombre).filter(Boolean).join(', '),
          pieza_original_label: product?.pieza_original ? 'Si' : 'No',
          precio_con_iva: Number.isFinite(Number(product?.precio))
            ? Number(product.precio) * (1 + ivaRate)
            : null,
          oem_codes: oemCodes.join(', '),
        }
      }),
    [ivaRate]
  )

  const buildProductsListUrl = useCallback((criteria, options = {}) => {
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

    addIfPresent('codigo', criteria?.codigo)
    addIfPresent('nombre', criteria?.nombre)
    addIfPresent('oem', criteria?.oem)
    addIfPresent('descripcion', criteria?.descripcion)
    addIfPresent('marca', criteria?.marca)
    addIfPresent('casa_comercial', criteria?.casa_comercial)
    addIfPresent('pieza_original', criteria?.pieza_original)
    if (canSeeCost) {
      addIfPresent('costo_minimo', criteria?.costo_minimo)
    }
    addIfPresent('precio', criteria?.precio)
    addIfPresent('fecha_creacion', criteria?.fecha_creacion)

    const hasExplicitGlobalSearch = Object.prototype.hasOwnProperty.call(options || {}, 'globalSearchValue')
    const globalSearch = hasExplicitGlobalSearch
      ? String(options?.globalSearchValue ?? '').trim()
      : getPrimeGlobalFilterValue(tableFilters)
    if (globalSearch) params.set('search', globalSearch)

    const columnFilters = buildPrimeColumnFiltersPayload(tableFilters, {
      allowedFields: PRODUCT_FILTER_FIELDS,
      defaultMatchModes: PRODUCT_FILTER_DEFAULT_MODES,
    })
    if (columnFilters) params.set('column_filters', JSON.stringify(columnFilters))

    const ordering = buildPrimeOrdering(tableSortField, tableSortOrder, PRODUCT_ORDERING_MAP)
    if (ordering) params.set('ordering', ordering)

    return `${API_URL}/productos/listado/?${params.toString()}`
  }, [canSeeCost])

  const fetchProducts = useCallback(
    async (criteria, page = 1, rows = pageSize, options = {}) => {
      const withOverlay = options?.withOverlay !== false
      if (withOverlay) {
        setLoading(true)
      }
      setError(null)
      try {
        const tableFilters = options?.tableFilters ?? filters
        const tableSortField = options?.tableSortField ?? sortField
        const tableSortOrder = options?.tableSortOrder ?? sortOrder
        const globalSearchValue = Object.prototype.hasOwnProperty.call(options || {}, 'globalSearchValue')
          ? options?.globalSearchValue
          : globalFilterValue
        const url = buildProductsListUrl(criteria, {
          page,
          rows,
          tableFilters,
          tableSortField,
          tableSortOrder,
          globalSearchValue,
        })
        const res = await authFetch(url, {}, token)
        if (!res.ok) throw new Error('No se pudo obtener la lista de productos.')

        const data = await res.json()
        const count = Array.isArray(data) ? data.length : Number(data?.count ?? 0)
        const list = Array.isArray(data) ? data : data?.results || []
        const normalized = normalizeList(list)
        setProducts(normalized)
        setTotalRecords(count)
        setPageFirst(Math.max(0, (page - 1) * rows))
        setPageSize(rows)
        return normalized
      } catch (err) {
        const msg = err?.message || 'Ocurrió un error al cargar los productos.'
        setError(msg)
        setProducts([])
        setTotalRecords(0)
        toast.current?.show({ severity: 'warn', summary: 'Aviso', detail: msg, life: 3500 })
      } finally {
        if (withOverlay) {
          setLoading(false)
        }
        setIsRefreshing(false)
      }
    },
    [token, normalizeList, pageSize, buildProductsListUrl, filters, sortField, sortOrder, globalFilterValue]
  )

  const fetchAllProducts = useCallback(
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
      let url = buildProductsListUrl(criteria, {
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
        if (!res.ok) throw new Error('No se pudo obtener la lista completa de productos.')
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
    [token, normalizeList, buildProductsListUrl, filters, sortField, sortOrder]
  )

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
    fetchProducts(lastSearchRef.current, currentPage, pageSize)
  }

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
    setProducts((prev) =>
      (Array.isArray(prev) ? prev : []).map((product) => {
        const precioConIva = Number.isFinite(Number(product?.precio))
          ? Number(product.precio) * (1 + ivaRate)
          : null
        if (product?.precio_con_iva === precioConIva) return product
        return { ...product, precio_con_iva: precioConIva }
      })
    )
  }, [ivaRate])

  // ---------------- Filters ----------------

  const initFilters = () => {
    const nextFilters = {
      global: { value: null, matchMode: FilterMatchMode.CONTAINS },
      codigo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      marca_nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      pieza_original_label: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      costo_minimo: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      precio: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      precio_con_iva: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
      casa_comercial_nombre: { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] },
    }
    setFilters(nextFilters)
    setGlobalFilterValue('')
    return nextFilters
  }

  useEffect(() => {
    try {
      const savedState = sessionStorage.getItem('productos-table-state')
      if (savedState) {
        const parsed = JSON.parse(savedState)
        if (parsed?.filters) {
          const nextFilters = { ...parsed.filters }
          if (nextFilters.casas_comerciales_count && !nextFilters.casa_comercial_nombre) {
            nextFilters.casa_comercial_nombre = nextFilters.casas_comerciales_count
          }
          delete nextFilters.casas_comerciales_count
          setFilters(nextFilters)
          const restoredGlobal = String(parsed?.globalFilterValue ?? getPrimeGlobalFilterValue(nextFilters) ?? '')
          setGlobalFilterValue(restoredGlobal)
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
        sessionStorage.removeItem('productos-table-state')
      } catch {
        // no-op
      }
    }
    initFilters()
  }, [])

  useEffect(() => {
    if (!filters) return
    const payload = JSON.stringify({ filters, sortField, sortOrder, globalFilterValue })
    try {
      sessionStorage.setItem('productos-table-state', payload)
    } catch {
      try {
        sessionStorage.removeItem('productos-table-state')
        sessionStorage.setItem('productos-table-state', payload)
      } catch {
        // no-op
      }
    }
  }, [filters, sortField, sortOrder, globalFilterValue])

  const clearFilter = async () => {
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    setIsGlobalSearchPending(false)
    const nextFilters = initFilters()
    if (!lastSearchRef.current) return
    setPageFirst(0)
    setIsRefreshing(true)
    await fetchProducts(lastSearchRef.current, 1, pageSize, {
      tableFilters: nextFilters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
      globalSearchValue: '',
    })
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
  const [isGlobalSearchPending, setIsGlobalSearchPending] = useState(false)
  const lastSearchRef = useRef({ ...initialSearchCriteria })
  const didInitialSearchRef = useRef(false)
  const globalSearchDebounceRef = useRef(null)
  const globalSearchSeqRef = useRef(0)
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

  useEffect(
    () => () => {
      if (globalSearchDebounceRef.current) {
        clearTimeout(globalSearchDebounceRef.current)
      }
    },
    []
  )
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
          `${API_URL}/marcas/listado/?search=${encodeURIComponent(term)}&page_size=5`,
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
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    setIsGlobalSearchPending(false)
    lastSearchRef.current = { ...searchCriteria }
    setShowSearchModal(false)
    setIsRefreshing(true)
    await fetchProducts(lastSearchRef.current, 1, pageSize, {
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
    fetchProducts(lastSearchRef.current, 1, pageSize, {
      tableFilters: filters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
      globalSearchValue: getPrimeGlobalFilterValue(filters),
    })
  }, [fetchProducts, filters, pageSize, sortField, sortOrder])

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
  const allRowsSelected = allRowIds.length > 0 && allRowIds.every((id) => selectedRowIds.includes(id))

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
    try {
      sessionStorage.setItem(
        'productos-table-selected-rows',
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
      { nombrevar: 'codigo', header: 'Código', filterPlaceholder: 'Buscar por código' },
      { nombrevar: 'nombre', header: 'Nombre', filterPlaceholder: 'Buscar por nombre' },
      { nombrevar: 'marca_nombre', header: 'Marca', filterPlaceholder: 'Buscar por marca' },
      { nombrevar: 'pieza_original_label', header: 'Original', filterPlaceholder: 'Si/No' },
      { nombrevar: 'precio', header: 'Precio', filterPlaceholder: 'Buscar por precio' },
      { nombrevar: 'precio_con_iva', header: 'Precio + IVA', filterPlaceholder: 'Buscar por precio + IVA' },
      { nombrevar: 'costo_minimo', header: 'Costo', filterPlaceholder: 'Buscar por costo' },
      { nombrevar: 'casa_comercial_nombre', header: 'Casa comercial', filterPlaceholder: 'Buscar por casa comercial' },
    ],
    []
  )
  const visibleColumnsData = useMemo(
    () => (canSeeCost ? columnsData : columnsData.filter((column) => column.nombrevar !== 'costo_minimo')),
    [canSeeCost, columnsData]
  )

  const [selectedColumns, setSelectedColumns] = useState(visibleColumnsData)
  const selectedColumnsRef = useRef(selectedColumns)
  const [processedRows, setProcessedRows] = useState(null)

  useEffect(() => {
    selectedColumnsRef.current = selectedColumns
  }, [selectedColumns])

  useEffect(() => {
    const stored = localStorage.getItem('productos-table-columns')
    if (stored) {
      const parsed = JSON.parse(stored)
      const migrated = (Array.isArray(parsed) ? parsed : []).map((col) => {
        if (col?.nombrevar !== 'casas_comerciales_count') return col
        return {
          ...col,
          nombrevar: 'casa_comercial_nombre',
          header: 'Casa comercial',
          filterPlaceholder: 'Buscar por casa comercial',
        }
      })
      const availableFields = new Set(visibleColumnsData.map((column) => column.nombrevar))
      const visibleColumns = migrated.filter((column) => availableFields.has(column?.nombrevar))
      setSelectedColumns(visibleColumns.length ? visibleColumns : visibleColumnsData)
    }
    return () => {
      localStorage.setItem('productos-table-columns', JSON.stringify(selectedColumnsRef.current))
    }
  }, [visibleColumnsData])

  useEffect(() => {
    const availableFields = new Set(visibleColumnsData.map((column) => column.nombrevar))
    setSelectedColumns((prev) => {
      const filtered = (Array.isArray(prev) ? prev : []).filter((column) => availableFields.has(column?.nombrevar))
      if (!filtered.length) return visibleColumnsData
      if (filtered.length === prev.length) return prev
      return filtered
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
        case 'casa_comercial_nombre':
          return row?.casa_comercial_nombre ?? row?.casas_comerciales_nombres ?? ''
        case 'precio':
        case 'precio_con_iva':
        case 'costo_minimo':
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
    const baseRows = processedRows === null ? products : processedRows
    if (!selectedRows?.length) {
      notifyExportWarning(baseRows.length ? 'Debe seleccionar al menos una fila para generar el reporte.' : 'No hay registros para exportar.')
      return
    }
    const rows = selectedRows
    await exportToExcel({
      rows,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('productos'),
    })
  }, [exportColumns, getExportValue, notifyExportWarning, processedRows, products, selectedRows])

  const handleExportPdf = useCallback(async () => {
    if (!exportColumns.length) {
      notifyExportWarning('Selecciona al menos una columna para exportar.')
      return
    }
    const baseRows = processedRows === null ? products : processedRows
    if (!selectedRows?.length) {
      notifyExportWarning(baseRows.length ? 'Debe seleccionar al menos una fila para generar el reporte.' : 'No hay registros para exportar.')
      return
    }
    const rows = selectedRows
    await exportToPdf({
      rows,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('productos'),
      title: 'Reporte de productos',
    })
  }, [exportColumns, getExportValue, notifyExportWarning, processedRows, products, selectedRows])

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

  // ---------------- Row click -> detalles ----------------
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
  const dataLength = totalRecords ?? 0
  const emptyMessage = lastSearchRef.current
    ? 'No se encontraron productos'
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
    toast.current?.show({ severity: 'success', summary: 'Éxito', detail: 'Producto creado correctamente', life: 2500 })
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
    setSelectedColumns((prev) => {
      if (!prev || !prev.length) return visibleColumnsData
      const prevKeys = new Set(prev.map((c) => c.nombrevar))
      const next = visibleColumnsData.filter((col) => prevKeys.has(col.nombrevar))
      visibleColumnsData.forEach((col) => {
        if (!prevKeys.has(col.nombrevar)) next.push(col)
      })
      return next
    })
  }, [visibleColumnsData])

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
    const rawFilters = event?.filters || {}
    const nextFilters = {
      ...rawFilters,
      global: { value: globalFilterValue || null, matchMode: FilterMatchMode.CONTAINS },
    }
    setFilters(nextFilters)
    setPageFirst(0)
    if (!lastSearchRef.current) return
    setIsRefreshing(true)
    await fetchProducts(lastSearchRef.current, 1, pageSize, {
      tableFilters: nextFilters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
      globalSearchValue: globalFilterValue,
    })
  }

  function handleGlobalFilterChange(event) {
    const value = event.target.value
    setGlobalFilterValue(value)
    setPageFirst(0)
    if (!lastSearchRef.current) return
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
      fetchProducts(lastSearchRef.current, 1, pageSize, {
        tableFilters: nextFilters,
        tableSortField: sortField,
        tableSortOrder: sortOrder,
        globalSearchValue: value,
        withOverlay: false,
      }).finally(() => {
        if (globalSearchSeqRef.current === seq) {
          setIsGlobalSearchPending(false)
        }
      })
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
    await fetchProducts(lastSearchRef.current, 1, pageSize, {
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
    await fetchProducts(lastSearchRef.current, nextPage, nextRows, {
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
      const all = await fetchAllProducts(lastSearchRef.current, {
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
        detail: `Se seleccionaron ${all.length} productos.`,
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
        detail: err?.message || 'No se pudo seleccionar todos los productos.',
        life: 3500,
      })
    } finally {
      if (bulkSelectAbortRef.current === controller) {
        bulkSelectAbortRef.current = null
      }
      setShowBulkSelectProgress(false)
      setIsRefreshing(false)
    }
  }, [fetchAllProducts, totalRecords])

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
  const hasSearched = Boolean(lastSearchRef.current)

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

  const {
    shouldRender: shouldRenderBulkSelectConfirmModal,
    isClosing: isClosingBulkSelectConfirmModal,
  } = useModalAnimation(showBulkSelectConfirm)
  const {
    shouldRender: shouldRenderBulkSelectProgressModal,
    isClosing: isClosingBulkSelectProgressModal,
  } = useModalAnimation(showBulkSelectProgress)
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

      <div className="users-table users-table--card">
        {!hasSearched ? (
          <div className="users-search-empty-state">
            <div className="users-search-empty-state__content">
              <h2 className="users-search-empty-state__title">Productos</h2>
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
          value={products}
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
          onFilter={handleFilterChange}
          onValueChange={(value) => setProcessedRows(value ?? [])}
          globalFilterFields={[
            'codigo',
            'nombre',
            'oem_codes',
            'descripcion',
            'marca_nombre',
            'pieza_original_label',
            'precio',
            'precio_con_iva',
            ...(canSeeCost ? ['costo_minimo'] : []),
            'casa_comercial_nombre',
            'casas_comerciales_nombres',
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
              if (!e?.originalEvent) return
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
            let enableFilter = true

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
              case 'casa_comercial_nombre':
                bodyTemplate = (rowData) => casaComercialBodyTemplate(rowData)
                filterMatchMode = FilterMatchMode.STARTS_WITH
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
                filter={enableFilter}
                filterPlaceholder={column.filterPlaceholder}
                filterMatchMode={filterMatchMode}
                showFilterMenuOptions={enableFilter}
                showFilterMatchModes={enableFilter && showFilterMatchModes}
                showFilterOperator={enableFilter && showFilterOperator}
                filterApply={enableFilter ? filterApplyTemplate : undefined}
                filterClear={enableFilter ? filterClearTemplate : undefined}
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

          {visibleColumnsData.map((col) => (
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

      {shouldRenderBulkSelectConfirmModal && (
        <div
          className={`create-user__overlay${isClosingBulkSelectConfirmModal ? ' create-user__overlay--closing' : ''}`}
          role="dialog"
          aria-modal="true"
          style={{ pointerEvents: 'auto' }}
        >
          <div
            ref={bulkModalRef}
            className={`create-user__modal${isClosingBulkSelectConfirmModal ? ' create-user__modal--closing' : ''}`}
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
                productos. El proceso tomara varios minutos.
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

      {shouldRenderBulkSelectProgressModal && (
        <div
          className={`create-user__overlay${isClosingBulkSelectProgressModal ? ' create-user__overlay--closing' : ''}`}
          role="dialog"
          aria-modal="true"
          style={{ pointerEvents: 'auto', background: 'rgba(2, 6, 23, 0.72)', backdropFilter: 'blur(1px)' }}
        >
          <div
            ref={bulkModalRef}
            className={`create-user__modal${isClosingBulkSelectProgressModal ? ' create-user__modal--closing' : ''}`}
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
                <h3>Seleccionando productos</h3>
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

      <CreateProducto
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleCreated}
        token={token}
        onError={showErrorToast}
        currentUser={user}
        showCostField={canSeeCost}
      />

      <ProductoDetails
        open={showDetailsModal}
        productoId={selectedId}
        onClose={() => {
          setShowDetailsModal(false)
        }}
        token={token}
        onUpdated={handleUpdated}
        onDeleted={handleDeleted}
        onError={showErrorToast}
        currentUser={user}
        allowEdit={canEdit}
        allowDelete={canDelete}
        allowComment={Boolean(canEdit)}
        showCostField={canSeeCost}
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
                      <input name="codigo" type="text" placeholder="Ej: PRD-001" value={searchCriteria.codigo} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>OEM</span>
                      <input name="oem" type="text" placeholder="Ej: 1234-ABC" value={searchCriteria.oem} onChange={handleSearchInputChange} />
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
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    setSearchMarcaQuery(marca.nombre)
                                    setSearchCriteria((prev) => ({ ...prev, marca: marca.nombre }))
                                    setShowSearchMarcaDropdown(false)
                                  }}
                                >
                                  <div className="create-user__result-info">
                                    <strong>{marca.nombre}</strong>
                                    <small>{marca.codigo ? `Código: ${marca.codigo}` : `ID: ${marca.id}`}</small>
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
                      <span>Original</span>
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

                    {canSeeCost && (
                      <label className="create-user__field">
                        <span>Costo minimo</span>
                        <input name="costo_minimo" type="text" placeholder="Ej: 10.50" value={searchCriteria.costo_minimo} onChange={handleSearchInputChange} />
                      </label>
                    )}

                    <label className="create-user__field">
                      <span>Precio sugerido</span>
                      <input name="precio" type="text" placeholder="Ej: 60.00" value={searchCriteria.precio} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field">
                      <span>Fecha de creación</span>
                      <input name="fecha_creacion" type="text" placeholder="Ej: 2025-12-31" value={searchCriteria.fecha_creacion} onChange={handleSearchInputChange} />
                    </label>

                    <label className="create-user__field create-user__field--full">
                      <span>Descripción</span>
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

export default ProductosTable





