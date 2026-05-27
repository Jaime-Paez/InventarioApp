import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FilterMatchMode } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { OverlayPanel } from 'primereact/overlaypanel'
import { Checkbox } from 'primereact/checkbox'
import { Button } from 'primereact/button'

import CreateSolicitud from '../CreateSolicitud/CreateSolicitud'
import SolicitudDetails from '../SolicitudDetails/SolicitudDetails'
import ProductoDetails from '../../productos/ProductoDetails/ProductoDetails'
import '../../admin/UsersTable/UsersTable.css'
import '../../movimientos/TrasladosInconvenientesTable.css'

import useModalAnimation from '../../common/useModalAnimation'
import { API_URL, authFetch } from '../../../../utils/api'
import { clearTableLayouts } from '../../../../utils/tableLayoutSync'
import { autoFitTableColumns, clearSavedColumnWidths } from '../../../../utils/autoFitColumns'
import { buildFileName, exportToExcel, exportToPdf } from '../../../../utils/exportUtils'
import {
  buildPrimeColumnFiltersPayload,
  buildPrimeOrdering,
  getPrimeGlobalFilterValue,
} from '../../../../utils/primeTableQuery'

const normId = (value) => (value == null ? null : String(value))
const BULK_SELECT_CONFIRM_THRESHOLD = 1000
const SOLICITUD_PRODUCT_HOVER_CARD_WIDTH = 600
const SOLICITUD_PRODUCT_HOVER_CARD_MARGIN = 12
const SOLICITUD_FILTER_FIELDS = [
  'codigo',
  'fecha',
  'cliente_nombre',
  'cedula_ruc',
  'marca',
  'modelo',
  'motor',
  'anio',
  'sucursal_nombre',
  'producto_solicitado_nombre',
]
const SOLICITUD_FILTER_DEFAULT_MODES = {
  codigo: FilterMatchMode.STARTS_WITH,
  fecha: FilterMatchMode.CONTAINS,
  cliente_nombre: FilterMatchMode.CONTAINS,
  cedula_ruc: FilterMatchMode.STARTS_WITH,
  marca: FilterMatchMode.CONTAINS,
  modelo: FilterMatchMode.CONTAINS,
  motor: FilterMatchMode.CONTAINS,
  anio: FilterMatchMode.CONTAINS,
  sucursal_nombre: FilterMatchMode.CONTAINS,
  producto_solicitado_nombre: FilterMatchMode.CONTAINS,
}
const SOLICITUD_ORDERING_MAP = {
  codigo: 'codigo',
  fecha: 'fecha',
  cliente_nombre: 'cliente_nombre_text',
  cedula_ruc: 'cliente__cedula_ruc',
  marca: 'marca',
  modelo: 'modelo',
  motor: 'motor',
  anio: 'anio',
  sucursal_nombre: 'sucursal__nombre',
  producto_solicitado_nombre: 'producto_referencia_text',
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

function SolicitudesTable({ token, onSelect, user, moduleActions, createBranchId = '', pendingOpenClienteSolicitudId, onPendingOpenClienteSolicitudHandled }) {
  const toast = useRef(null)
  const opColumns = useRef(null)
  const tableWrapperRef = useRef(null)
  const _widthsClearedRef = useRef(null)
  if (_widthsClearedRef.current === null) { _widthsClearedRef.current = true; clearSavedColumnWidths('solicitudes-table-state') }
  const [tableResetKey, setTableResetKey] = useState(0)
  const canCreate = moduleActions?.puede_crear ?? true
  const canEdit = moduleActions?.puede_actualizar ?? true
  const canDelete = moduleActions?.puede_eliminar ?? true
  const isAdminUser = Boolean(user?.es_administrador)
  const normalizedCreateBranchIdRaw = String(createBranchId || '').trim()
  const normalizedCreateBranchId = (
    normalizedCreateBranchIdRaw.toLowerCase() === 'all' ? 'all' : normalizedCreateBranchIdRaw
  )
  const hasSpecificCreateBranch = Boolean(
    normalizedCreateBranchId && normalizedCreateBranchId !== 'all'
  )

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

  const [statusFilter, setStatusFilter] = useState('solicitado')
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
  const [productHoverCard, setProductHoverCard] = useState(null)
  const productHoverHideTimeoutRef = useRef(null)

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
      list.map((item) => {
        const clienteNombre =
          item?.cliente_nombre ||
          item?.cliente_data?.nombre_completo ||
          `${item?.cliente_data?.nombres || ''} ${item?.cliente_data?.apellidos || ''}`.trim() ||
          item?.cliente_nombre_text ||
          item?.cliente ||
          '-'

        const cedulaRuc =
          item?.cedula_ruc ||
          item?.cliente_data?.cedula_ruc ||
          item?.cliente__cedula_ruc ||
          '-'

        const marca = String(item?.marca || '').trim() || '-'
        const modelo = String(item?.modelo || '').trim() || '-'
        const motor = String(item?.motor || '').trim() || '-'
        const anio = String(item?.anio || '').trim() || '-'

        const sucursalNombre =
          item?.sucursal_nombre ||
          item?.sucursal_data?.nombre ||
          item?.sucursal ||
          '-'

        const productoSolicitadoNombre =
          item?.producto_solicitado_nombre ||
          item?.producto_solicitado_data?.nombre ||
          item?.producto_referencia ||
          item?.producto_referencia_text ||
          item?.producto_data?.nombre ||
          item?.producto ||
          '-'

        const tabla = String(item?.tabla || '').trim()
        const productoCodigo = String(
          tabla === 'producto'
            ? item?.producto_data?.codigo || ''
            : item?.producto_solicitado_data?.codigo || ''
        ).trim()
        const productos =
          productoCodigo || productoSolicitadoNombre !== '-'
            ? [
                {
                  producto_codigo: productoCodigo,
                  producto_nombre: productoSolicitadoNombre !== '-' ? productoSolicitadoNombre : '',
                  cantidad: item?.cantidad,
                  comentario: item?.comentario || '',
                  oem: Array.isArray(item?.producto_solicitado_data?.oem_codigos)
                    ? item.producto_solicitado_data.oem_codigos.filter(Boolean).join(', ')
                    : '',
                },
              ]
            : []

        return {
          ...item,
          codigo: item?.codigo || '-',
          cliente_nombre: clienteNombre,
          cedula_ruc: cedulaRuc,
          marca,
          modelo,
          motor,
          anio,
          sucursal_nombre: sucursalNombre,
          producto_solicitado_nombre: productoSolicitadoNombre,
          producto_codigo: productoCodigo,
          productos,
          revisiones: Array.isArray(item?.revisiones) ? item.revisiones : [],
          estado_counts: item?.estado_counts || null,
        }
      }),
    []
  )

  const buildClientsListUrl = useCallback((criteria, options = {}) => {
    const params = new URLSearchParams()
    const page = Number(options?.page) || 1
    const rows = Number(options?.rows) || 25
    const tableFilters = options?.tableFilters
    const tableSortField = options?.tableSortField
    const tableSortOrder = options?.tableSortOrder
    const branchContextIdRaw = String(
      options?.branchContextId ?? normalizedCreateBranchId
    ).trim()
    const branchContextId = branchContextIdRaw.toLowerCase() === 'all' ? 'all' : branchContextIdRaw
    const estadoFilter = options?.estadoFilter ?? statusFilter

    params.set('page', String(page))
    params.set('page_size', String(rows))
    if (estadoFilter === 'solicitado') {
      params.set('estado', 'solicitado,revisado')
    } else if (estadoFilter === 'aceptado') {
      params.set('estado', 'revisado')
      params.set('flat', '1')
    } else if (estadoFilter === 'archivado') {
      params.set('estado', 'archivado')
      params.set('flat', '1')
    }

    const addIfPresent = (key, value) => {
      const parsed = String(value ?? '').trim()
      if (parsed) params.set(key, parsed)
    }

    addIfPresent('cedula_ruc', criteria?.cedula_ruc)
    addIfPresent('sucursal_id', criteria?.sucursal_id)
    addIfPresent('fecha_desde', criteria?.fecha_desde)
    addIfPresent('fecha_hasta', criteria?.fecha_hasta)
    if (branchContextId && branchContextId !== 'all') {
      params.set('sucursal_id', branchContextId)
    }

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
  }, [normalizedCreateBranchId, statusFilter])

  const fetchClients = useCallback(
    async (criteria, page = 1, rows = pageSize, options = {}) => {
      setLoading(true)
      setError(null)
      try {
        const estadoFilter = options?.estadoFilter ?? statusFilter
        const tableFilters = options?.tableFilters ?? filters
        const tableSortField = options?.tableSortField ?? sortField
        const tableSortOrder = options?.tableSortOrder ?? sortOrder
        const branchContextIdRaw = String(
          options?.branchContextId ?? normalizedCreateBranchId
        ).trim()
        const branchContextId = branchContextIdRaw.toLowerCase() === 'all' ? 'all' : branchContextIdRaw
        const url = buildClientsListUrl(criteria, {
          page,
          rows,
          estadoFilter,
          tableFilters,
          tableSortField,
          tableSortOrder,
          branchContextId,
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
    [token, normalizeList, pageSize, buildClientsListUrl, filters, sortField, sortOrder, normalizedCreateBranchId, statusFilter]
  )

  const fetchAllClients = useCallback(
    async (criteria, options = {}) => {
      const estadoFilter = options?.estadoFilter ?? statusFilter
      const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null
      const signal = options?.signal
      const isCancelled = typeof options?.isCancelled === 'function' ? options.isCancelled : () => false
      const tableFilters = options?.tableFilters ?? filters
      const tableSortField = options?.tableSortField ?? sortField
      const tableSortOrder = options?.tableSortOrder ?? sortOrder
      const branchContextIdRaw = String(
        options?.branchContextId ?? normalizedCreateBranchId
      ).trim()
      const branchContextId = branchContextIdRaw.toLowerCase() === 'all' ? 'all' : branchContextIdRaw
      const ensureNotCancelled = () => {
        if (signal?.aborted || isCancelled()) throw createBulkCancelError()
      }
      const all = []
      let url = buildClientsListUrl(criteria, {
        page: 1,
        rows: 200,
        estadoFilter,
        tableFilters,
        tableSortField,
        tableSortOrder,
        branchContextId,
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
    [token, normalizeList, buildClientsListUrl, filters, sortField, sortOrder, normalizedCreateBranchId, statusFilter]
  )

  useEffect(() => {
    fetchSucursales()
  }, [fetchSucursales])

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
    fetchClients(lastSearchRef.current, currentPage, pageSize)
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
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    const nextFilters = initFilters()
    if (!lastSearchRef.current) return
    setSortField(null)
    setSortOrder(null)
    setPageFirst(0)
    setIsRefreshing(true)
    await fetchClients(lastSearchRef.current, 1, pageSize, {
      tableFilters: nextFilters,
      tableSortField: null,
      tableSortOrder: null,
    })
  }

  const autoFitColumns = useCallback(() => {
    autoFitTableColumns(tableWrapperRef.current, 'solicitudes-table-state')
  }, [])

  const clearProductHoverHideTimer = useCallback(() => {
    if (!productHoverHideTimeoutRef.current) return
    clearTimeout(productHoverHideTimeoutRef.current)
    productHoverHideTimeoutRef.current = null
  }, [])

  const hideProductHoverCard = useCallback(() => {
    clearProductHoverHideTimer()
    setProductHoverCard(null)
  }, [clearProductHoverHideTimer])

  const scheduleHideProductHoverCard = useCallback(() => {
    clearProductHoverHideTimer()
    productHoverHideTimeoutRef.current = setTimeout(() => {
      productHoverHideTimeoutRef.current = null
      setProductHoverCard(null)
    }, 120)
  }, [clearProductHoverHideTimer])

  const showProductHoverCard = useCallback(
    (event, products) => {
      const normalizedProducts = Array.isArray(products) ? products : []
      if (!normalizedProducts.length) {
        hideProductHoverCard()
        return
      }
      clearProductHoverHideTimer()
      const rect = event?.currentTarget?.getBoundingClientRect?.()
      if (!rect) return

      let left = rect.right + 10
      if (left + SOLICITUD_PRODUCT_HOVER_CARD_WIDTH > window.innerWidth - SOLICITUD_PRODUCT_HOVER_CARD_MARGIN) {
        left = Math.max(
          SOLICITUD_PRODUCT_HOVER_CARD_MARGIN,
          rect.left - SOLICITUD_PRODUCT_HOVER_CARD_WIDTH - 10
        )
      }
      const maxTop = Math.max(window.innerHeight - 280, SOLICITUD_PRODUCT_HOVER_CARD_MARGIN)
      const top = Math.min(
        Math.max(rect.top - 8, SOLICITUD_PRODUCT_HOVER_CARD_MARGIN),
        maxTop
      )
      setProductHoverCard({ left, top, products: normalizedProducts })
    },
    [clearProductHoverHideTimer, hideProductHoverCard]
  )

  useEffect(() => () => { clearProductHoverHideTimer() }, [clearProductHoverHideTimer])

  useEffect(() => {
    const handleScroll = () => hideProductHoverCard()
    window.addEventListener('scroll', handleScroll, true)
    return () => window.removeEventListener('scroll', handleScroll, true)
  }, [hideProductHoverCard])

const handleResetTable = () => {
    localStorage.removeItem('solicitudes-table-columns')
    localStorage.removeItem('solicitudes-table-state')
    setSelectedColumns(columnsData)
    clearFilter()
    setTableResetKey((k) => k + 1)
    clearTableLayouts(['solicitudes-table-columns', 'solicitudes-table-state'], token)
    opColumns.current?.hide()
  }

  const initialSearchCriteria = {
    cliente_nombre: '',
    producto: '',
    cedula_ruc: '',
    sucursal_id: '',
    fecha_desde: '',
    fecha_hasta: '',
  }

  const [searchCriteria, setSearchCriteria] = useState(initialSearchCriteria)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const lastSearchRef = useRef({ ...initialSearchCriteria })
  const didInitialSearchRef = useRef(false)
  const globalSearchDebounceRef = useRef(null)
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

  const handleStatusFilterChange = (nextFilter) => {
    if (nextFilter === statusFilter) return
    setStatusFilter(nextFilter)
    setSelectedRows([])
    setClients([])
    setTotalRecords(0)
    setPageFirst(0)
    setIsRefreshing(true)
    fetchClients(lastSearchRef.current, 1, pageSize, {
      tableFilters: filters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
      branchContextId: normalizedCreateBranchId,
      estadoFilter: nextFilter,
    })
  }

  const handleSearchSubmit = async (event) => {
    event.preventDefault()
    const nextCriteria = {
      ...searchCriteria,
      sucursal_id: hasSpecificCreateBranch ? normalizedCreateBranchId : searchCriteria.sucursal_id,
    }
    lastSearchRef.current = nextCriteria
    setShowSearchModal(false)
    setIsRefreshing(true)
    await fetchClients(nextCriteria, 1, pageSize, {
      tableFilters: filters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
      branchContextId: normalizedCreateBranchId,
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
      branchContextId: normalizedCreateBranchId,
    })
  }, [fetchClients, filters, pageSize, sortField, sortOrder, normalizedCreateBranchId])

  useEffect(() => {
    if (!didInitialSearchRef.current) return
    if (!filters) return
    const forcedBranchId = hasSpecificCreateBranch ? normalizedCreateBranchId : ''
    const nextCriteria = {
      ...(lastSearchRef.current || {
        cliente_nombre: '',
        producto: '',
        cedula_ruc: '',
        sucursal_id: '',
        fecha_desde: '',
        fecha_hasta: '',
      }),
      sucursal_id: forcedBranchId,
    }
    lastSearchRef.current = nextCriteria
    setSearchCriteria((prev) => {
      if (String(prev?.sucursal_id || '') === forcedBranchId) return prev
      return { ...prev, sucursal_id: forcedBranchId }
    })
    setSelectedRows([])
    setPageFirst(0)
    setIsRefreshing(true)
    fetchClients(nextCriteria, 1, pageSize, {
      tableFilters: filters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
      branchContextId: normalizedCreateBranchId,
    })
  }, [
    fetchClients,
    filters,
    hasSpecificCreateBranch,
    normalizedCreateBranchId,
    pageSize,
    sortField,
    sortOrder,
  ])


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
      { nombrevar: 'codigo', header: 'Codigo', filterPlaceholder: 'Buscar por codigo' },
      { nombrevar: 'fecha', header: 'Fecha', filterPlaceholder: 'Buscar por fecha' },
      { nombrevar: 'cliente_nombre', header: 'Cliente', filterPlaceholder: 'Buscar por cliente' },
      { nombrevar: 'cedula_ruc', header: 'Cedula/RUC', filterPlaceholder: 'Buscar por cedula/RUC' },
      { nombrevar: 'marca', header: 'Marca', filterPlaceholder: 'Buscar por marca' },
      { nombrevar: 'modelo', header: 'Modelo', filterPlaceholder: 'Buscar por modelo' },
      { nombrevar: 'motor', header: 'Motor', filterPlaceholder: 'Buscar por motor' },
      { nombrevar: 'anio', header: 'Año', filterPlaceholder: 'Buscar por año' },
      { nombrevar: 'sucursal_nombre', header: 'Sucursal', filterPlaceholder: 'Buscar por sucursal' },
      {
        nombrevar: 'producto_solicitado_nombre',
        header: 'Productos',
        filterPlaceholder: 'Buscar por productos',
      },
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
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        const availableColumns = new Map(columnsData.map((column) => [column.nombrevar, column]))
        const nextColumns = Array.isArray(parsed)
          ? parsed
              .map((column) => availableColumns.get(column?.nombrevar))
              .filter(Boolean)
          : []
        setSelectedColumns(nextColumns.length ? nextColumns : columnsData)
      } catch {
        setSelectedColumns(columnsData)
      }
    }
    return () => {
      localStorage.setItem('solicitudes-table-columns', JSON.stringify(selectedColumnsRef.current))
    }
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

  const getExportValue = useCallback((row, field) => row?.[field] ?? '', [])

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
  const solicitudProductBodyTemplate = (rowData) => {
    const products = Array.isArray(rowData?.productos) ? rowData.productos : []
    const codigo = String(rowData?.producto_codigo || '').trim() || '-'
    if (!products.length) {
      return <span className="cell-tooltip" style={{ color: '#9ca3af' }}>-</span>
    }
    return (
      <div className="movimientos-table__product-cell">
        <div className="movimientos-table__product-lines">
          <span className="cell-tooltip movimientos-table__product-main" data-pr-tooltip={codigo}>
            {codigo}
          </span>
        </div>
        <button
          type="button"
          className="movimientos-table__product-eye"
          aria-label="Ver producto"
          onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={(e) => showProductHoverCard(e, products)}
          onMouseLeave={scheduleHideProductHoverCard}
          onFocus={(e) => showProductHoverCard(e, products)}
          onBlur={scheduleHideProductHoverCard}
        >
          <i className="pi pi-eye" />
        </button>
      </div>
    )
  }

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

  const getSolicitudPendingMeta = useCallback((rowData) => {
    const counts = rowData?.estado_counts || {}
    const revisado = Number(counts.revisado || 0)
    const archivado = Number(counts.archivado || 0)
    const solicitado = Number(counts.solicitado || 0)
    const total = revisado + archivado + solicitado
    return {
      revisado,
      archivado,
      solicitado,
      total,
      isPending: total > 0 && solicitado > 0,
    }
  }, [])

  const estadoBadgeBodyTemplate = (rowData) => {
    if (!isAdminUser) return null
    const { isPending, total, solicitado } = getSolicitudPendingMeta(rowData)
    if (isPending) return (
      <span className="transfer-issues-state transfer-issues-state--pendiente">
        Pendiente
      </span>
    )
    if (total > 0 && solicitado === 0) return (
      <span className="transfer-issues-state transfer-issues-state--revisada">
        Revisada
      </span>
    )
    return null
  }

  const revisionesBodyTemplate = (rowData) => {
    const revisiones = Array.isArray(rowData?.revisiones) ? rowData.revisiones : []
    if (!revisiones.length) return <span style={{ color: '#9ca3af' }}>-</span>
    const text = revisiones.map((r) => {
      const casa = r?.casa_comercial_nombre || r?.casa_comercial_codigo || ''
      const ref = r?.referencia || ''
      return [casa, ref].filter(Boolean).join(' · ')
    }).filter(Boolean).join(', ')
    return (
      <span className="cell-tooltip" data-pr-tooltip={text} style={{ fontSize: '0.85rem' }}>
        {text || '-'}
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

  const rowClassNameTemplate = (rowData) => {
    const classes = []
    if (isAdminUser && statusFilter === 'solicitado' && getSolicitudPendingMeta(rowData).isPending) {
      classes.push('transfer-issues-row--pendiente')
    }
    if (selectedRowIds.includes(normId(rowData?.id))) {
      classes.push('selected-row-shadow')
    }
    return classes.join(' ')
  }

  // ---------------- Row click -> detalles ----------------
  const [selectedId, setSelectedId] = useState(null)
  const [showDetailsModal, setShowDetailsModal] = useState(false)
  const clickTimerRef = useRef(null)
  const pendingRefreshAfterCloseRef = useRef(false)

  useEffect(() => {
    if (!pendingOpenClienteSolicitudId) return
    setSelectedId(pendingOpenClienteSolicitudId)
    setShowDetailsModal(true)
    onPendingOpenClienteSolicitudHandled?.()
  }, [pendingOpenClienteSolicitudId, onPendingOpenClienteSolicitudHandled])

  const [showProductoDetailsModal, setShowProductoDetailsModal] = useState(false)
  const [selectedProductoId, setSelectedProductoId] = useState(null)
  const [showBasicProductModal, setShowBasicProductModal] = useState(false)
  const [basicProductData, setBasicProductData] = useState(null)
  const [basicModalPosition, setBasicModalPosition] = useState({ x: 12, y: 12 })
  const basicModalRef = useRef(null)
  const basicModalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })

  useEffect(() => {
    if (!showBasicProductModal) return
    const w = 560
    const h = 420
    setBasicModalPosition({
      x: Math.max(12, (window.innerWidth - w) / 2),
      y: Math.max(12, (window.innerHeight - h) / 2),
    })
  }, [showBasicProductModal])

  const handleBasicModalHeaderMouseDown = useCallback((event) => {
    if (event.button !== 0) return
    const rect = basicModalRef.current?.getBoundingClientRect() || { left: 0, top: 0 }
    basicModalDrag.current = { active: true, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top }
    const handleMove = (ev) => {
      if (!basicModalDrag.current.active) return
      ev.preventDefault()
      const mw = basicModalRef.current?.offsetWidth || 0
      const mh = basicModalRef.current?.offsetHeight || 0
      setBasicModalPosition({
        x: Math.min(Math.max(ev.clientX - basicModalDrag.current.offsetX, 12), window.innerWidth - mw - 12),
        y: Math.min(Math.max(ev.clientY - basicModalDrag.current.offsetY, 12), window.innerHeight - mh - 12),
      })
    }
    const handleUp = () => {
      basicModalDrag.current.active = false
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [])

  const handleRowClick = (event) => {
    const target = event?.originalEvent?.target
    if (target?.closest?.('.p-checkbox') || target?.closest?.('.row-selection-column')) return

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
    const target = event?.originalEvent?.target
    if (target?.closest?.('.p-checkbox') || target?.closest?.('.row-selection-column')) return

    const rowData = event?.data
    if (!rowData) return

    if (statusFilter === 'aceptado' || statusFilter === 'archivado') {
      const tabla = String(rowData?.tabla || '').trim()
      if (tabla === 'producto') {
        const catalogProductId = rowData?.producto_id || rowData?.producto_data?.id
        if (catalogProductId) {
          setSelectedProductoId(catalogProductId)
          setShowProductoDetailsModal(true)
        }
      } else {
        const solData = rowData?.producto_solicitado_data || {}
        setBasicProductData({
          nombre: rowData?.producto_solicitado_nombre || solData?.nombre || '-',
          oem: Array.isArray(solData?.oem_codigos) ? solData.oem_codigos.filter(Boolean).join(', ') : '',
          comentario: String(rowData?.comentario || ''),
          cantidad: Number(rowData?.cantidad || 0),
          revisiones: Array.isArray(rowData?.revisiones) ? rowData.revisiones : [],
          estado: statusFilter,
        })
        setShowBasicProductModal(true)
      }
      return
    }

    const id = rowData?.id
    if (id == null) return

    setSelectedId(id)
    setShowDetailsModal(true)

    if (typeof onSelect === 'function') onSelect(id)
  }

  const handleUpdated = () => {
    if (showDetailsModal) {
      pendingRefreshAfterCloseRef.current = true
    } else {
      refreshData()
    }
    toast.current?.show({ severity: 'success', summary: 'Actualizado', detail: 'Solicitud actualizada correctamente', life: 2500 })
  }

  const handleCloseDetailsModal = () => {
    setShowDetailsModal(false)
    pendingRefreshAfterCloseRef.current = false
  }

  const handleDeleted = () => {
    setShowDetailsModal(false)
    setSelectedId(null)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Eliminado', detail: 'Solicitud eliminada correctamente', life: 2500 })
  }

  const handleOpenReviewedProduct = async (itemId, estado) => {
    const normalizedId = Number(itemId || 0)
    if (!normalizedId) return

    const nextFilter = String(estado || '').trim().toLowerCase() === 'archivado'
      ? 'archivado'
      : 'aceptado'

    setStatusFilter(nextFilter)
    setSelectedRows([])
    setClients([])
    setTotalRecords(0)
    setPageFirst(0)
    setSelectedId(normalizedId)
    setShowDetailsModal(true)
    setIsRefreshing(true)

    await fetchClients(lastSearchRef.current || initialSearchCriteria, 1, pageSize, {
      tableFilters: filters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
      branchContextId: normalizedCreateBranchId,
      estadoFilter: nextFilter,
    })
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

        <button
          className="rounded-icon-btn"
          type="button"
          onClick={autoFitColumns}
          title="Ajustar columnas"
        >
          <i className="pi pi-arrows-h" />
        </button>

        {statusFilter === 'solicitado' && (
          <button className="rounded-icon-btn" type="button" onClick={(e) => opColumns.current?.toggle(e)} title="Campos">
            <i className="pi pi-sliders-h" />
          </button>
        )}
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

  const handleOpenCreateModal = () => {
    if (!canCreate) return
    if (!hasSpecificCreateBranch) {
      toast.current?.show({
        severity: 'warn',
        summary: 'Selecciona sucursal',
        detail: 'Selecciona una sucursal especifica para crear una solicitud.',
        life: 3000,
      })
      return
    }
    setShowCreateModal(true)
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
    setIsRefreshing(true)
    globalSearchDebounceRef.current = setTimeout(() => {
      fetchClients(lastSearchRef.current, 1, pageSize, {
        tableFilters: nextFilters,
        tableSortField: sortField,
        tableSortOrder: sortOrder,
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
      <Toast
        ref={toast}
        baseZIndex={12050}
        appendTo={typeof document !== 'undefined' ? document.body : undefined}
      />

      <div className="users-page__top">
        <div className="users-page__actions">
          {canCreate && (
            <Button label="Crear" icon="pi pi-plus" className="users-topbtn users-topbtn--create" onClick={handleOpenCreateModal} type="button" />
          )}
          <Button label="Buscar" icon="pi pi-search" className="users-topbtn users-topbtn--search" onClick={focusSearch} type="button" />
          <div className="transfer-issues-page__type-filter" role="group" aria-label="Filtro de estado">
            {[
              { key: 'solicitado', label: 'Solicitudes' },
              { key: 'aceptado', label: 'Aceptados' },
              { key: 'archivado', label: 'Archivados' },
            ].map((option) => (
              <Button
                key={option.key}
                label={option.label}
                type="button"
                className={`users-topbtn transfer-issues-page__type-btn${statusFilter === option.key ? ' transfer-issues-page__type-btn--active' : ''}`}
                onClick={() => handleStatusFilterChange(option.key)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="users-table users-table--card users-table--compact" ref={tableWrapperRef}>
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
          onValueChange={(value) => setProcessedRows(value ?? [])}
          globalFilterFields={[
            'fecha',
            'cliente_nombre',
            'cedula_ruc',
            'marca',
            'modelo',
            'motor',
            'anio',
            'sucursal_nombre',
            'producto_solicitado_nombre',
          ]}
          reorderableColumns
          onColReorder={handleOrderChange}
          resizableColumns
          columnResizeMode="expand"
          key={`${tableResetKey}-${statusFilter}`}
          stateStorage="local"
          stateKey={statusFilter === 'solicitado' ? 'solicitudes-table-state' : undefined}
          onRowClick={handleRowClick}
          onRowDoubleClick={handleRowDoubleClick}
          rowClassName={rowClassNameTemplate}
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
            resizable={false}
          />

          {statusFilter === 'solicitado' && selectedColumns.map((column, index) => {
            let bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
            let className = 'column-max-min-width'

            switch (column.nombrevar) {
              case 'cliente_nombre':
                bodyTemplate = (rowData) => clienteBodyTemplate(rowData)
                break
              case 'producto_solicitado_nombre':
                bodyTemplate = (rowData) => solicitudProductBodyTemplate(rowData)
                break
              case 'cantidad':
                bodyTemplate = (rowData) => numericBodyTemplate(rowData, column.nombrevar)
                className = 'column-max-min-width--small'
                break
              case 'cedula_ruc':
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
                className={className}
                style={{ minWidth: '32px' }}
              />
            )
          })}

          {statusFilter === 'solicitado' && isAdminUser && (
            <Column
              key="estado_badge"
              header="Estado"
              body={estadoBadgeBodyTemplate}
              className="column-max-min-width--small"
              style={{ minWidth: '100px' }}
              reorderable={false}
              resizable={false}
            />
          )}

          {(statusFilter === 'aceptado' || statusFilter === 'archivado') && [
            <Column key="fecha" field="fecha" header="Fecha" body={(r) => cellWithTooltip(r, 'fecha')} sortable className="column-max-min-width--small" style={{ minWidth: '90px' }} />,
            <Column key="cliente_nombre" field="cliente_nombre" header="Cliente" body={clienteBodyTemplate} sortable className="column-max-min-width" style={{ minWidth: '120px' }} />,
            <Column key="sucursal_nombre" field="sucursal_nombre" header="Sucursal" body={(r) => cellWithTooltip(r, 'sucursal_nombre')} sortable className="column-max-min-width" style={{ minWidth: '100px' }} />,
            <Column key="producto_solicitado_nombre" field="producto_solicitado_nombre" header="Producto" body={(r) => cellWithTooltip(r, 'producto_solicitado_nombre')} sortable className="column-max-min-width" style={{ minWidth: '140px' }} />,
            <Column key="oem" header="OEM" body={(r) => {
              const oems = Array.isArray(r?.producto_solicitado_data?.oem_codigos) ? r.producto_solicitado_data.oem_codigos.filter(Boolean) : []
              const text = oems.join(', ')
              if (!text) return <span style={{ color: '#9ca3af' }}>-</span>
              return <span className="cell-tooltip" data-pr-tooltip={text}>{text}</span>
            }} className="column-max-min-width--small" style={{ minWidth: '100px' }} />,
            <Column key="revisiones" header="Casas Comerciales" body={revisionesBodyTemplate} className="column-max-min-width" style={{ minWidth: '160px' }} />,
            <Column key="cantidad" field="cantidad" header="Cantidad" body={(r) => <span>{r?.cantidad ?? '-'}</span>} sortable style={{ minWidth: '80px' }} />,
            <Column key="comentario" field="comentario" header="Comentario" body={(r) => cellWithTooltip(r, 'comentario')} sortable className="column-max-min-width" style={{ minWidth: '120px' }} />,
          ].filter(Boolean)}
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

      {Array.isArray(productHoverCard?.products) && productHoverCard.products.length > 0 && (
        <div
          className="movimientos-table__product-hover-card movimientos-table__product-hover-card--wide"
          role="tooltip"
          style={{ top: productHoverCard.top, left: productHoverCard.left }}
          onMouseEnter={clearProductHoverHideTimer}
          onMouseLeave={scheduleHideProductHoverCard}
        >
          <div className="movimientos-table__product-hover-title">Producto</div>
          <table className="movimientos-table__product-hover-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <colgroup>
              <col style={{ width: '120px' }} />
              <col style={{ width: '80px' }} />
              <col />
              <col style={{ width: '58px' }} />
              <col style={{ width: '100px' }} />
            </colgroup>
            <thead>
              <tr>
                <th>OEM</th>
                <th>Código JP</th>
                <th>Producto</th>
                <th className="movimientos-table__product-hover-qty">Cant.</th>
                <th>Comentario</th>
              </tr>
            </thead>
            <tbody>
              {productHoverCard.products.map((product, index) => (
                <tr key={`sol-product-hover-${index}`}>
                  <td title={String(product?.oem || '-').trim()}>
                    {String(product?.oem || '-').trim()}
                  </td>
                  <td title={String(product?.producto_codigo || '-').trim()}>
                    {String(product?.producto_codigo || '-').trim()}
                  </td>
                  <td title={String(product?.producto_nombre || '-').trim()}>
                    {String(product?.producto_nombre || '-').trim()}
                  </td>
                  <td className="movimientos-table__product-hover-qty">
                    {product?.cantidad != null ? String(product.cantidad) : '-'}
                  </td>
                  <td title={String(product?.comentario || '-').trim()}>
                    {String(product?.comentario || '-').trim()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateSolicitud
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleCreated}
        token={token}
        onError={showErrorToast}
        currentUser={user}
        prefilledSucursalId={hasSpecificCreateBranch ? normalizedCreateBranchId : ''}
      />

      <SolicitudDetails
        open={showDetailsModal}
        solicitudId={selectedId}
        onClose={handleCloseDetailsModal}
        token={token}
        onUpdated={handleUpdated}
        onDeleted={handleDeleted}
        onError={showErrorToast}
        onOpenReviewedProduct={handleOpenReviewedProduct}
        currentUser={user}
        allowEdit={canEdit}
        allowDelete={canDelete}
      />

      <ProductoDetails
        open={showProductoDetailsModal}
        productoId={selectedProductoId}
        onClose={() => { setShowProductoDetailsModal(false); setSelectedProductoId(null) }}
        token={token}
        currentUser={user}
        allowEdit={false}
        allowDelete={false}
      />

      {showBasicProductModal && basicProductData && (
        <div
          className="create-user__overlay"
          role="dialog"
          aria-modal="true"
          style={{ padding: '12px' }}
        >
          <div
            className="create-user__modal"
            ref={basicModalRef}
            style={{ top: basicModalPosition.y, left: basicModalPosition.x, width: 560, maxWidth: 'calc(100vw - 24px)' }}
          >
            <header
              className="create-user__header"
              onMouseDown={handleBasicModalHeaderMouseDown}
              style={{ cursor: 'default' }}
            >
              <div className="create-user__header-text">
                <h3>Producto {basicProductData.estado === 'archivado' ? 'archivado' : 'aceptado'}</h3>
              </div>
              <div className="create-user__header-actions">
                <button
                  type="button"
                  className="create-user__icon-button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setShowBasicProductModal(false)}
                  aria-label="Cerrar"
                >
                  <i className="pi pi-times" aria-hidden="true" />
                </button>
              </div>
            </header>
            <div className="create-user__content">
              <div className="create-user__body">
                <section className="create-user__section">
                  <div className="create-user__grid create-user__grid--two" style={{ gap: '12px' }}>
                    <label className="create-user__field create-user__field--full">
                      <span>Nombre</span>
                      <input type="text" readOnly value={basicProductData.nombre} />
                    </label>
                    {basicProductData.oem && (
                      <label className="create-user__field create-user__field--full">
                        <span>OEM</span>
                        <input type="text" readOnly value={basicProductData.oem} />
                      </label>
                    )}
                    {basicProductData.cantidad > 0 && (
                      <label className="create-user__field">
                        <span>Cantidad</span>
                        <input type="text" readOnly value={basicProductData.cantidad} />
                      </label>
                    )}
                    {basicProductData.comentario && (
                      <label className="create-user__field">
                        <span>Comentario</span>
                        <input type="text" readOnly value={basicProductData.comentario} />
                      </label>
                    )}
                  </div>
                </section>
                {basicProductData.revisiones.length > 0 && (
                  <section className="create-user__section">
                    <div className="create-user__section-header">
                      <div>
                        <h4>Casas comerciales / Referencias</h4>
                      </div>
                    </div>
                    <div className="create-user__locations-table">
                      <div className="create-user__locations-row create-user__locations-row--header" style={{ gridTemplateColumns: '1fr 1fr' }}>
                        <span>Casa comercial</span>
                        <span>Referencia</span>
                      </div>
                      {basicProductData.revisiones.map((r, i) => (
                        <div key={i} className="create-user__locations-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
                          <span>{r?.casa_comercial_nombre || r?.casa_comercial_codigo || '-'}</span>
                          <span>{r?.referencia || '-'}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </div>
            <div className="create-user__footer">
              <div className="user-details__footer-right">
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary"
                  onClick={() => setShowBasicProductModal(false)}
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
                      <span>Productos</span>
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
                        value={hasSpecificCreateBranch ? normalizedCreateBranchId : searchCriteria.sucursal_id}
                        onChange={handleSearchInputChange}
                        disabled={hasSpecificCreateBranch}
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

                  </div>
                </section>
              </div>

              <div className="create-user__footer">
                <div className="user-details__footer-left">
                  <button
                    type="button"
                    className="create-user__action"
                    onClick={() =>
                      setSearchCriteria({
                        ...initialSearchCriteria,
                        sucursal_id: hasSpecificCreateBranch ? normalizedCreateBranchId : '',
                      })
                    }
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



