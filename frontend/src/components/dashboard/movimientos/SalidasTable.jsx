import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FilterMatchMode } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { OverlayPanel } from 'primereact/overlaypanel'
import { Checkbox } from 'primereact/checkbox'
import { Button } from 'primereact/button'

import CreateSalida from './CreateSalida'
import SalidaDetails from './SalidaDetails'
import './SalidasTable.css'
import '../admin/UsersTable/UsersTable.css'
import useModalAnimation from '../common/useModalAnimation'
import { API_URL, authFetch } from '../../../utils/api'
import { clearTableLayouts } from '../../../utils/tableLayoutSync'
import { autoFitTableColumns, clearSavedColumnWidths } from '../../../utils/autoFitColumns'
import { buildFileName, exportToExcel, exportToPdf } from '../../../utils/exportUtils'
import {
  buildPrimeColumnFiltersPayload,
  buildPrimeOrdering,
  getPrimeGlobalFilterValue,
} from '../../../utils/primeTableQuery'
import { REMINDERS_TRANSFER_NOTIFICATION_EVENT } from '../common/reminders/remindersStorage'
import {
  buildMovementProductExportRows,
  buildMovementProductsExportText,
  buildMovementProductsSearchText,
  formatMovementProductLabel,
  formatMovementProductQuantity,
  normalizeMovementProducts,
} from './movementTableProducts'

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeValue = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
const formatEstadoForTable = (value) => {
  const rawValue = String(value ?? '').trim()
  if (!rawValue) return '-'
  const normalized = normalizeValue(rawValue)
  if (normalized.includes('solicitud') && normalized.includes('pend')) {
    return 'Pendiente'
  }
  return rawValue
}
const parseCurrency = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : '-'
}
const parseTotalValue = (row) => {
  const preferred = Number(row?.total ?? row?.total_monto)
  if (Number.isFinite(preferred)) return preferred
  const detalles = Array.isArray(row?.detalles) ? row.detalles : []
  return detalles.reduce((acc, detalle) => {
    const totalVal = Number(detalle?.valor_total)
    if (Number.isFinite(totalVal)) return acc + totalVal
    const qty = Number(detalle?.cantidad)
    const val = Number(detalle?.valor)
    if (Number.isFinite(qty) && Number.isFinite(val)) return acc + qty * val
    return acc
  }, 0)
}
const MOVEMENT_PRODUCTS_HOVER_CARD_WIDTH = 480
const MOVEMENT_PRODUCTS_HOVER_CARD_MARGIN = 12
const formatSalidaSubTipoLabel = (value) => {
  const nombre = String(value || '').trim()
  return normalizeValue(nombre) === 'devolucion' ? 'Garantia' : nombre
}

const SUBTYPE_FILTERS = [
  { key: 'all', label: 'Todos' },
  { key: 'venta', label: 'Ventas' },
  { key: 'devolucion', label: 'Garantias' },
  { key: 'traslado', label: 'Traslados' },
]

const SALIDAS_FILTER_FIELDS = [
  'no_documento',
  'fecha',
  'sucursal_nombre',
  'sub_tipo_nombre',
  'estado_nombre',
  'sucursal_objetivo_nombre',
  'total',
  'funcional_label',
]

const SALIDAS_FILTER_DEFAULT_MODES = {
  no_documento: FilterMatchMode.CONTAINS,
  fecha: FilterMatchMode.CONTAINS,
  sucursal_nombre: FilterMatchMode.CONTAINS,
  sub_tipo_nombre: FilterMatchMode.CONTAINS,
  estado_nombre: FilterMatchMode.CONTAINS,
  sucursal_objetivo_nombre: FilterMatchMode.CONTAINS,
  total: FilterMatchMode.EQUALS,
  funcional_label: FilterMatchMode.CONTAINS,
}

const SALIDAS_ORDERING_MAP = {
  no_documento: 'no_documento',
  fecha: 'fecha',
  sucursal_nombre: 'sucursal__nombre',
  sub_tipo_nombre: 'sub_tipo_movimiento__nombre',
  estado_nombre: 'estado_movimiento__nombre',
  sucursal_objetivo_nombre: 'sucursal_objetivo__nombre',
  total: 'total_monto',
  funcional_label: 'funcional',
}

const createInitialFilters = () => ({
  global: { value: null, matchMode: FilterMatchMode.CONTAINS },
})

const initialSearchCriteria = {
  no_documento: '',
  producto_codigo: '',
  fecha_desde: '',
  fecha_hasta: '',
  sucursal: '',
  sub_tipo: '',
  estado: '',
  sucursal_objetivo: '',
  total_min: '',
  total_max: '',
  funcional: '',
}

const normId = (value) => (value == null ? null : String(value))
const TRANSFER_SALIDA_MODAL_STATE_EVENT = 'inventario-transfer-salida-modal-state'
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

function SalidasTable({
  token,
  user,
  isTabActive = false,
  createBranchId = '',
  moduleActions,
  pendingTransferSalidaRequest = null,
  onPendingTransferSalidaRequestHandled,
}) {
  const toast = useRef(null)
  const opColumns = useRef(null)
  const tableWrapperRef = useRef(null)
  const _widthsClearedRef = useRef(null)
  if (_widthsClearedRef.current === null) { _widthsClearedRef.current = true; clearSavedColumnWidths('salidas-table-state') }
  const [tableResetKey, setTableResetKey] = useState(0)
  const preloadSalidaCatalogsPromiseRef = useRef(null)
  const globalSearchDebounceRef = useRef(null)
  const fetchSeqRef = useRef(0)
  const fetchMovimientosRef = useRef(null)
  const latestTableOptionsRef = useRef({})
  const refreshDataRef = useRef(() => Promise.resolve([]))
  const notificationRefreshInFlightRef = useRef(false)
  const pendingNotificationRefreshRef = useRef(false)
  const loadedTokenRef = useRef(null)
  const handledTransferRequestKeyRef = useRef('')
  const productHoverHideTimeoutRef = useRef(null)
  const clickTimerRef = useRef(null)
  const pendingClickRowRef = useRef(null)
  const pendingClickCountRef = useRef(0)
  const canCreate = moduleActions?.puede_crear ?? true
  const canEdit = moduleActions?.puede_actualizar ?? true
  const canDelete = moduleActions?.puede_eliminar ?? true

  const [movimientos, setMovimientos] = useState([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [pageFirst, setPageFirst] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [sortField, setSortField] = useState(null)
  const [sortOrder, setSortOrder] = useState(null)
  const [filters, setFilters] = useState(() => createInitialFilters())
  const [globalFilterValue, setGlobalFilterValue] = useState('')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [showDetailsModal, setShowDetailsModal] = useState(false)
  const [selectedRows, setSelectedRows] = useState([])
  const [prefetchedTipoMovimientos, setPrefetchedTipoMovimientos] = useState([])
  const [prefetchedSubTiposSalida, setPrefetchedSubTiposSalida] = useState([])
  const [salidaCatalogsPreloaded, setSalidaCatalogsPreloaded] = useState(false)
  const [createPrefillTransferRequest, setCreatePrefillTransferRequest] = useState(null)
  const [subtypeFilter, setSubtypeFilter] = useState('all')
  const [searchCriteria, setSearchCriteria] = useState(initialSearchCriteria)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const [processedRows, setProcessedRows] = useState(null)
  const [searchPosition, setSearchPosition] = useState({ x: 0, y: 0 })
  const [searchSize, setSearchSize] = useState({ width: 720, height: 520 })
  const lastSearchRef = useRef({ ...initialSearchCriteria })
  const SEARCH_PADDING = 12
  const normalizedCreateBranchIdRaw = String(createBranchId || '').trim()
  const normalizedCreateBranchId = (
    normalizedCreateBranchIdRaw.toLowerCase() === 'all' ? 'all' : normalizedCreateBranchIdRaw
  )
  const hasSpecificCreateBranch = Boolean(
    normalizedCreateBranchId && normalizedCreateBranchId !== 'all'
  )
  const columnsData = useMemo(
    () => [
      { nombrevar: 'no_documento', header: 'Documento', filterPlaceholder: 'Buscar por documento' },
      { nombrevar: 'productos_resumen', header: 'Productos', filterPlaceholder: 'Buscar por productos' },
      { nombrevar: 'fecha', header: 'Fecha', filterPlaceholder: 'Buscar por fecha' },
      { nombrevar: 'sucursal_nombre', header: 'Sucursal', filterPlaceholder: 'Buscar por sucursal' },
      { nombrevar: 'sub_tipo_nombre', header: 'Tipo', filterPlaceholder: 'Buscar por tipo' },
      { nombrevar: 'sucursal_objetivo_nombre', header: 'Destino', filterPlaceholder: 'Buscar por destino' },
      { nombrevar: 'estado_nombre', header: 'Estado', filterPlaceholder: 'Buscar por estado' },
      { nombrevar: 'total', header: 'Total', filterPlaceholder: 'Buscar por total' },
      { nombrevar: 'funcional_label', header: 'Funcional', filterPlaceholder: 'Buscar por funcional' },
    ],
    []
  )
  const [selectedColumns, setSelectedColumns] = useState(columnsData)
  const selectedColumnsRef = useRef(selectedColumns)
  const [productHoverCard, setProductHoverCard] = useState(null)
  const isTransferSendCreateOpen = Boolean(
    showCreateModal &&
    String(createPrefillTransferRequest?.solicitudId || '').trim()
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

  useEffect(() => {
    selectedColumnsRef.current = selectedColumns
  }, [selectedColumns])

  useEffect(() => {
    const stored = localStorage.getItem('salidas-table-columns')
    if (stored) setSelectedColumns(JSON.parse(stored))
    return () => {
      localStorage.setItem('salidas-table-columns', JSON.stringify(selectedColumnsRef.current))
    }
  }, [])

  useEffect(() => {
    setSelectedColumns((prev) => {
      if (!prev || !prev.length) return columnsData
      const prevKeys = new Set(prev.map((col) => col?.nombrevar))
      const next = columnsData.filter((col) => prevKeys.has(col.nombrevar))
      columnsData.forEach((col) => {
        if (!next.some((item) => item.nombrevar === col.nombrevar)) {
          next.push(col)
        }
      })
      return next
    })
  }, [columnsData])

  const normalizeList = useCallback(
    (list) =>
      list.map((row) => {
        const total = parseTotalValue(row)
        const productos = normalizeMovementProducts(row?.detalles)
        return {
          ...row,
          sucursal_nombre: row?.sucursal_nombre || row?.sucursal || '-',
          sub_tipo_nombre: formatSalidaSubTipoLabel(row?.sub_tipo_nombre || row?.sub_tipo_movimiento || '-'),
          estado_nombre: formatEstadoForTable(row?.estado_nombre || row?.estado_movimiento),
          sucursal_objetivo_nombre: row?.sucursal_objetivo_nombre || row?.sucursal_objetivo || '-',
          funcional_label: row?.funcional_label || (row?.funcional ? 'Si' : 'No'),
          productos,
          productos_resumen: buildMovementProductsSearchText(productos) || '-',
          productos_codigos:
            productos.map((product) => product?.producto_codigo).filter(Boolean).join(', ') || '-',
          total,
        }
      }),
    []
  )

  const buildMovimientosListUrl = useCallback((criteria = {}, options = {}) => {
    const params = new URLSearchParams()
    const page = Number(options?.page) || 1
    const rows = Number(options?.rows) || 25
    const tableFilters = options?.tableFilters || createInitialFilters()
    const tableSortField = options?.tableSortField ?? null
    const tableSortOrder = options?.tableSortOrder ?? null
    const subtype = String(options?.subtypeFilter || 'all').trim()
    const branchContextIdRaw = String(
      options?.branchContextId ?? normalizedCreateBranchId
    ).trim()
    const branchContextId = branchContextIdRaw.toLowerCase() === 'all' ? 'all' : branchContextIdRaw

    params.set('tipo', 'salida')
    params.set('page', String(page))
    params.set('page_size', String(rows))

    const addIfPresent = (key, value) => {
      const parsed = String(value ?? '').trim()
      if (parsed) params.set(key, parsed)
    }

    addIfPresent('no_documento', criteria?.no_documento)
    addIfPresent('producto_codigo', criteria?.producto_codigo)
    addIfPresent('fecha_desde', criteria?.fecha_desde)
    addIfPresent('fecha_hasta', criteria?.fecha_hasta)
    addIfPresent('sucursal', criteria?.sucursal)
    addIfPresent('sub_tipo', criteria?.sub_tipo)
    addIfPresent('estado', criteria?.estado)
    addIfPresent('sucursal_objetivo', criteria?.sucursal_objetivo)
    addIfPresent('total_min', criteria?.total_min)
    addIfPresent('total_max', criteria?.total_max)

    const funcionalValue = String(criteria?.funcional ?? '').trim().toLowerCase()
    if (funcionalValue === 'si' || funcionalValue === 'no') {
      params.set('funcional', funcionalValue)
    }

    if (subtype && subtype !== 'all') {
      params.set('subtipo', subtype)
    }

    if (branchContextId && branchContextId !== 'all') {
      params.set('sucursal_id', branchContextId)
    }

    const hasExplicitGlobalSearch = Object.prototype.hasOwnProperty.call(options, 'globalSearchValue')
    const globalSearch = hasExplicitGlobalSearch
      ? String(options?.globalSearchValue ?? '').trim()
      : getPrimeGlobalFilterValue(tableFilters)
    if (globalSearch) {
      params.set('search', globalSearch)
    }

    const columnFilters = buildPrimeColumnFiltersPayload(tableFilters, {
      allowedFields: SALIDAS_FILTER_FIELDS,
      defaultMatchModes: SALIDAS_FILTER_DEFAULT_MODES,
    })
    if (columnFilters) {
      params.set('column_filters', JSON.stringify(columnFilters))
    }

    const ordering = buildPrimeOrdering(tableSortField, tableSortOrder, SALIDAS_ORDERING_MAP)
    if (ordering) {
      params.set('ordering', ordering)
    }

    return `${API_URL}/movimientos/movimiento_inventario/tabla/?${params.toString()}`
  }, [normalizedCreateBranchId])

  const fetchMovimientos = useCallback(
    async (options = {}) => {
      if (!token) return []

      const page = Number(options?.page) || 1
      const rows = Number(options?.rows) || pageSize
      const tableFilters = options?.tableFilters || createInitialFilters()
      const tableSortField = options?.tableSortField ?? null
      const tableSortOrder = options?.tableSortOrder ?? null
      const subtype = String(options?.subtypeFilter || 'all').trim()
      const branchContextIdRaw = String(
        options?.branchContextId ?? normalizedCreateBranchId
      ).trim()
      const branchContextId = branchContextIdRaw.toLowerCase() === 'all' ? 'all' : branchContextIdRaw
      const criteria = options?.criteria ?? lastSearchRef.current
      const globalSearchValue = Object.prototype.hasOwnProperty.call(options, 'globalSearchValue')
        ? options?.globalSearchValue
        : getPrimeGlobalFilterValue(tableFilters)

      const requestId = fetchSeqRef.current + 1
      fetchSeqRef.current = requestId
      setLoading(true)
      setError(null)
      try {
        const url = buildMovimientosListUrl(criteria, {
          page,
          rows,
          tableFilters,
          tableSortField,
          tableSortOrder,
          globalSearchValue,
          subtypeFilter: subtype,
          branchContextId,
        })

        const response = await authFetch(url, {}, token)
        if (!response.ok) throw new Error('No se pudo obtener la lista de salidas.')
        const data = await response.json()
        if (requestId !== fetchSeqRef.current) return []

        const count = Array.isArray(data) ? data.length : Number(data?.count ?? 0)
        const list = normalizeList(parseApiList(data))

        setMovimientos(list)
        setTotalRecords(count)
        setPageFirst(Math.max(0, (page - 1) * rows))
        setPageSize(rows)
        return list
      } catch (err) {
        if (requestId !== fetchSeqRef.current) return []
        const msg = err?.message || 'Ocurrio un error al cargar las salidas.'
        setError(msg)
        setMovimientos([])
        setTotalRecords(0)
        toast.current?.show({ severity: 'warn', summary: 'Aviso', detail: msg, life: 3500 })
      } finally {
        if (requestId === fetchSeqRef.current) {
          setLoading(false)
        }
      }
      return []
    },
    [buildMovimientosListUrl, normalizedCreateBranchId, normalizeList, pageSize, token]
  )

  const preloadSalidaCatalogs = useCallback(async () => {
    if (!token) return
    if (salidaCatalogsPreloaded) return
    if (preloadSalidaCatalogsPromiseRef.current) {
      return preloadSalidaCatalogsPromiseRef.current
    }

    preloadSalidaCatalogsPromiseRef.current = (async () => {
      try {
        const [tiposRes, subTiposRes] = await Promise.all([
          authFetch(`${API_URL}/tipos/tipos-movimiento/`, {}, token),
          authFetch(`${API_URL}/tipos/subtipos-movimiento/`, {}, token),
        ])
        if (!tiposRes.ok || !subTiposRes.ok) return

        const [tiposData, subTiposData] = await Promise.all([tiposRes.json(), subTiposRes.json()])
        const tiposList = parseApiList(tiposData)
        const subTiposList = parseApiList(subTiposData)
        const salidaTipo = tiposList.find((tipo) => normalizeValue(tipo?.nombre).startsWith('sal'))
        const salidaTipoId = salidaTipo?.id

        setPrefetchedTipoMovimientos(tiposList)
        if (!salidaTipoId) {
          setPrefetchedSubTiposSalida([])
          return
        }
        setPrefetchedSubTiposSalida(
          subTiposList.filter(
            (subTipo) => String(subTipo?.tipo_movimiento?.id || '') === String(salidaTipoId)
          )
        )
        setSalidaCatalogsPreloaded(true)
      } finally {
        preloadSalidaCatalogsPromiseRef.current = null
      }
    })()

    return preloadSalidaCatalogsPromiseRef.current
  }, [salidaCatalogsPreloaded, token])

  useEffect(() => {
    fetchMovimientosRef.current = fetchMovimientos
  }, [fetchMovimientos])

  useEffect(() => {
    latestTableOptionsRef.current = {
      rows: pageSize,
      tableFilters: filters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
      globalSearchValue: globalFilterValue,
      subtypeFilter,
      branchContextId: normalizedCreateBranchId,
      criteria: lastSearchRef.current,
    }
  }, [filters, globalFilterValue, normalizedCreateBranchId, pageSize, sortField, sortOrder, subtypeFilter])

  useEffect(() => {
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
      globalSearchDebounceRef.current = null
    }
    if (!token) {
      loadedTokenRef.current = null
      setMovimientos([])
      setTotalRecords(0)
      setLoading(false)
      setError(null)
      return
    }

    if (loadedTokenRef.current === token) return
    loadedTokenRef.current = token

    fetchMovimientosRef.current?.({
      page: 1,
      ...latestTableOptionsRef.current,
    })
  }, [token])

  useEffect(() => {
    setSalidaCatalogsPreloaded(false)
    setPrefetchedTipoMovimientos([])
    setPrefetchedSubTiposSalida([])
  }, [token])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    window.dispatchEvent(
      new CustomEvent(TRANSFER_SALIDA_MODAL_STATE_EVENT, {
        detail: {
          open: isTransferSendCreateOpen,
        },
      })
    )

    return () => {
      window.dispatchEvent(
        new CustomEvent(TRANSFER_SALIDA_MODAL_STATE_EVENT, {
          detail: {
            open: false,
          },
        })
      )
    }
  }, [isTransferSendCreateOpen])

  useEffect(() => {
    preloadSalidaCatalogs()
  }, [preloadSalidaCatalogs])

  useEffect(
    () => () => {
      if (globalSearchDebounceRef.current) {
        clearTimeout(globalSearchDebounceRef.current)
      }
    },
    []
  )

  const selectedRowIds = useMemo(
    () => (selectedRows || []).map((row) => normId(row?.id)).filter(Boolean),
    [selectedRows]
  )

  const selectionColStyle = useMemo(
    () => ({
      width: '40px',
      minWidth: '40px',
      maxWidth: '40px',
      textAlign: 'center',
    }),
    []
  )

  const currentPage = useMemo(
    () => Math.floor(Math.max(0, Number(pageFirst) || 0) / Math.max(1, Number(pageSize) || 1)) + 1,
    [pageFirst, pageSize]
  )

  const activeColumnFilters = useMemo(
    () =>
      buildPrimeColumnFiltersPayload(filters, {
        allowedFields: SALIDAS_FILTER_FIELDS,
        defaultMatchModes: SALIDAS_FILTER_DEFAULT_MODES,
      }),
    [filters]
  )

  const hasSearchApplied = Boolean(String(globalFilterValue || '').trim()) || Boolean(activeColumnFilters)
  const emptyMessageByFilter = {
    all: hasSearchApplied ? 'No se encontraron salidas.' : 'No hay salidas registradas.',
    venta: hasSearchApplied ? 'No se encontraron ventas.' : 'No hay ventas registradas.',
    devolucion: hasSearchApplied ? 'No se encontraron garantias.' : 'No hay garantias registradas.',
    traslado: hasSearchApplied ? 'No se encontraron traslados.' : 'No hay traslados registrados.',
  }
  const emptyMessage = emptyMessageByFilter[subtypeFilter] || emptyMessageByFilter.all

  const refreshData = useCallback(
    (options = {}) =>
      fetchMovimientos({
        page: options?.page ?? currentPage,
        rows: options?.rows ?? pageSize,
        criteria: options?.criteria ?? lastSearchRef.current,
        tableFilters: options?.tableFilters ?? filters,
        tableSortField: options?.tableSortField ?? sortField,
        tableSortOrder: options?.tableSortOrder ?? sortOrder,
        globalSearchValue: Object.prototype.hasOwnProperty.call(options, 'globalSearchValue')
          ? options?.globalSearchValue
          : globalFilterValue,
        subtypeFilter: options?.subtypeFilter ?? subtypeFilter,
        branchContextId: Object.prototype.hasOwnProperty.call(options, 'branchContextId')
          ? options?.branchContextId
          : normalizedCreateBranchId,
      }),
    [currentPage, fetchMovimientos, filters, globalFilterValue, pageSize, sortField, sortOrder, subtypeFilter, normalizedCreateBranchId]
  )

  useEffect(() => {
    refreshDataRef.current = refreshData
  }, [refreshData])

  useEffect(() => {
    if (typeof window === 'undefined' || !token || !isTabActive) return undefined

    const runNotificationRefresh = () => {
      if (notificationRefreshInFlightRef.current) {
        pendingNotificationRefreshRef.current = true
        return
      }
      notificationRefreshInFlightRef.current = true
      void refreshDataRef.current({
        branchContextId: normalizedCreateBranchId,
      }).finally(() => {
        notificationRefreshInFlightRef.current = false
        if (!pendingNotificationRefreshRef.current) return
        pendingNotificationRefreshRef.current = false
        runNotificationRefresh()
      })
    }

    const handleTransferReminderNotification = () => {
      runNotificationRefresh()
    }

    window.addEventListener(REMINDERS_TRANSFER_NOTIFICATION_EVENT, handleTransferReminderNotification)

    return () => {
      notificationRefreshInFlightRef.current = false
      pendingNotificationRefreshRef.current = false
      window.removeEventListener(REMINDERS_TRANSFER_NOTIFICATION_EVENT, handleTransferReminderNotification)
    }
  }, [isTabActive, normalizedCreateBranchId, token])

  useEffect(() => {
    if (!token) return
    setSelectedRows([])
    refreshDataRef.current({
      page: 1,
      branchContextId: normalizedCreateBranchId,
    })
  }, [normalizedCreateBranchId, token])

  const clearFilter = () => {
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
      globalSearchDebounceRef.current = null
    }

    const nextFilters = createInitialFilters()
    setFilters(nextFilters)
    setGlobalFilterValue('')
    setSortField(null)
    setSortOrder(null)
    setSelectedRows([])

    refreshData({
      page: 1,
      tableFilters: nextFilters,
      tableSortField: null,
      tableSortOrder: null,
      globalSearchValue: '',
    })
  }

  const autoFitColumns = useCallback(() => {
    autoFitTableColumns(tableWrapperRef.current, 'salidas-table-state')
  }, [])

  const handleResetTable = () => {
    localStorage.removeItem('salidas-table-columns')
    localStorage.removeItem('salidas-table-state')
    setSelectedColumns(columnsData)
    clearFilter()
    setTableResetKey((k) => k + 1)
    clearTableLayouts(['salidas-table-columns', 'salidas-table-state'], token)
    opColumns.current?.hide()
  }

  const handleGlobalFilterChange = (event) => {
    const value = event.target.value
    const nextFilters = {
      ...(filters || createInitialFilters()),
      global: { value: value || null, matchMode: FilterMatchMode.CONTAINS },
    }
    setGlobalFilterValue(value)
    setFilters(nextFilters)

    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    globalSearchDebounceRef.current = setTimeout(() => {
      refreshData({
        page: 1,
        tableFilters: nextFilters,
        globalSearchValue: value || '',
      })
    }, 450)
  }


  const handlePageChange = (event) => {
    const nextRows = Number(event?.rows) || pageSize
    const nextFirst = Number(event?.first) || 0
    const nextPage = Math.floor(nextFirst / nextRows) + 1
    refreshData({ page: nextPage, rows: nextRows })
  }

  const handleSortChange = (event) => {
    const rawSortOrder = Number(event?.sortOrder)
    const normalizedSortOrder = rawSortOrder === 1 || rawSortOrder === -1 ? rawSortOrder : null
    const nextSortField = normalizedSortOrder ? event?.sortField || null : null
    setSortField(nextSortField)
    setSortOrder(normalizedSortOrder)
    refreshData({
      page: 1,
      tableSortField: nextSortField,
      tableSortOrder: normalizedSortOrder,
    })
  }

  const handleSubtypeFilterChange = (nextSubtypeFilter) => {
    const normalized = String(nextSubtypeFilter || '').trim() || 'all'
    if (normalized === subtypeFilter) return
    setSubtypeFilter(normalized)
    setSelectedRows([])
    refreshData({
      page: 1,
      subtypeFilter: normalized,
    })
  }

  const handleCheckboxChangeColumn = (column) => {
    if (selectedColumns.some((item) => item.nombrevar === column.nombrevar)) {
      setSelectedColumns(selectedColumns.filter((item) => item.nombrevar !== column.nombrevar))
    } else {
      setSelectedColumns([...selectedColumns, column])
    }
  }

  const handleOrderChange = (event) => {
    const columnOrder = (Array.isArray(event?.columns) ? event.columns : []).map((col) => col.props.field)
    const sorted = columnOrder.map((field) => selectedColumns.find((col) => col.nombrevar === field)).filter(Boolean)
    if (sorted.length) setSelectedColumns(sorted)
  }

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
      if (left + MOVEMENT_PRODUCTS_HOVER_CARD_WIDTH > window.innerWidth - MOVEMENT_PRODUCTS_HOVER_CARD_MARGIN) {
        left = Math.max(
          MOVEMENT_PRODUCTS_HOVER_CARD_MARGIN,
          rect.left - MOVEMENT_PRODUCTS_HOVER_CARD_WIDTH - 10
        )
      }

      const maxTop = Math.max(window.innerHeight - 280, MOVEMENT_PRODUCTS_HOVER_CARD_MARGIN)
      const top = Math.min(
        Math.max(rect.top - 8, MOVEMENT_PRODUCTS_HOVER_CARD_MARGIN),
        maxTop
      )

      setProductHoverCard({
        left,
        top,
        products: normalizedProducts,
      })
    },
    [clearProductHoverHideTimer, hideProductHoverCard]
  )

  useEffect(
    () => () => {
      clearProductHoverHideTimer()
    },
    [clearProductHoverHideTimer]
  )

  useEffect(() => {
    const handleScroll = () => {
      hideProductHoverCard()
    }

    window.addEventListener('scroll', handleScroll, true)
    return () => window.removeEventListener('scroll', handleScroll, true)
  }, [hideProductHoverCard])

  const cellWithTooltip = (rowData, field) => {
    const content = rowData?.[field] ?? '-'
    const textColor = content === '-' ? '#9ca3af' : undefined
    const normalizedEstado = normalizeValue(rowData?.estado_nombre)
    const normalizedSubTipo = normalizeValue(rowData?.sub_tipo_nombre || rowData?.sub_tipo_movimiento)
    const isTransferRow = normalizedSubTipo.includes('trasl')
    const isSentTransfer = isTransferRow && normalizedEstado.includes('envi')
    const isPartialSalida = isTransferRow && (
      (normalizedEstado.includes('llego') && normalizedEstado.includes('inconven')) ||
      normalizedEstado.includes('parcial')
    )
    const isGarantiaPendiente = field === 'estado_nombre' && Boolean(rowData?.garantia_pendiente)
    const className = [
      'cell-tooltip',
      field === 'estado_nombre' && isSentTransfer ? 'salidas-sent-state-chip' : '',
      field === 'estado_nombre' && isPartialSalida ? 'salidas-partial-state-chip' : '',
      isGarantiaPendiente ? 'salidas-garantia-pendiente-chip' : '',
    ]
      .filter(Boolean)
      .join(' ')
    const displayContent = isGarantiaPendiente ? 'Aprobación pendiente' : String(content)
    return (
      <span className={className} data-pr-tooltip={displayContent} style={{ color: textColor }}>
        {displayContent}
      </span>
    )
  }

  const totalBodyTemplate = (rowData) => {
    const value = parseCurrency(rowData?.total)
    return (
      <span className="cell-tooltip" data-pr-tooltip={value}>
        {value}
      </span>
    )
  }

  const productsBodyTemplate = (rowData) => {
    const products = Array.isArray(rowData?.productos) ? rowData.productos : []
    if (!products.length) {
      return (
        <span className="cell-tooltip" style={{ color: '#9ca3af' }}>
          -
        </span>
      )
    }

    const primaryProduct = products[0]
    const remainingProducts = products.slice(1)
    const primaryLabel = primaryProduct?.producto_codigo || primaryProduct?.producto_nombre || '-'
    const primaryTooltip = [
      primaryProduct?.producto_codigo,
      primaryProduct?.producto_nombre,
      `Cantidad: ${formatMovementProductQuantity(primaryProduct?.cantidad)}`,
    ]
      .filter(Boolean)
      .join(' | ')

    return (
      <div className="movimientos-table__product-cell">
        <div className="movimientos-table__product-lines">
          <span
            className="cell-tooltip movimientos-table__product-main"
            data-pr-tooltip={primaryTooltip || primaryLabel}
          >
            {primaryLabel}
          </span>
        </div>

        {remainingProducts.length > 0 ? (
          <button
            type="button"
            className="movimientos-table__product-eye"
            aria-label="Ver todos los productos"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onMouseEnter={(event) => showProductHoverCard(event, products)}
            onMouseLeave={scheduleHideProductHoverCard}
            onFocus={(event) => showProductHoverCard(event, products)}
            onBlur={scheduleHideProductHoverCard}
          >
            <i className="pi pi-eye" />
          </button>
        ) : null}
      </div>
    )
  }

  const columnClassName = (field) => {
    if (field === 'fecha' || field === 'total' || field === 'funcional_label' || field === 'estado_nombre') {
      return 'column-max-min-width--small'
    }
    return 'column-max-min-width'
  }

  const selectSalidaRow = useCallback((rowData) => {
    if (!rowData) return
    setSelectedId(rowData?.id ?? null)
  }, [])

  const handleRowClick = (event) => {
    const target = event?.originalEvent?.target
    if (target?.closest?.('.p-checkbox') || target?.closest?.('.row-selection-column')) return

    const rowData = event?.data
    if (!rowData) return
    const id = normId(rowData?.id)
    if (!id) return
    const isSameRow = pendingClickRowRef.current === id
    pendingClickRowRef.current = id
    pendingClickCountRef.current = isSameRow ? pendingClickCountRef.current + 1 : 1
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => {
      const clickCount = pendingClickCountRef.current
      pendingClickCountRef.current = 0
      pendingClickRowRef.current = null
      clickTimerRef.current = null
      if (clickCount > 1) return
      setSelectedRows((prev) => {
        const prevMap = new Map((prev || []).map((row) => [normId(row?.id), row]))
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
    pendingClickCountRef.current = 0
    pendingClickRowRef.current = null
    const target = event?.originalEvent?.target
    if (target?.closest?.('.p-checkbox') || target?.closest?.('.row-selection-column')) return
    const rowData = event?.data
    if (!rowData) return
    selectSalidaRow(rowData)
    setShowDetailsModal(true)
  }

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
      }
      pendingClickCountRef.current = 0
      pendingClickRowRef.current = null
    }
  }, [])

  const handleCreated = () => {
    setCreatePrefillTransferRequest(null)
    setShowCreateModal(false)
    setSelectedRows([])
    refreshData({ page: 1 })
    toast.current?.show({ severity: 'success', summary: 'Exito', detail: 'Salida creada correctamente', life: 2500 })
  }

  const handleTransferCancelled = () => {
    setCreatePrefillTransferRequest(null)
    setShowCreateModal(false)
    setSelectedRows([])
    refreshData({ page: 1 })
    toast.current?.show({
      severity: 'success',
      summary: 'Envio cancelado',
      detail: 'La solicitud de traslado fue cancelada correctamente.',
      life: 2800,
    })
  }

  const handleUpdated = () => {
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Actualizado', detail: 'Salida actualizada correctamente', life: 2500 })
  }

  const handleDeleted = () => {
    setShowDetailsModal(false)
    setSelectedId(null)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Eliminado', detail: 'Salida eliminada', life: 2500 })
  }

  const handleOpenCreateModal = async () => {
    if (!canCreate) return
    if (!hasSpecificCreateBranch) {
      toast.current?.show({
        severity: 'warn',
        summary: 'Selecciona sucursal',
        detail: 'Selecciona una sucursal especifica para crear una salida.',
        life: 3000,
      })
      return
    }
    try {
      await preloadSalidaCatalogs()
    } catch {
      // Si falla la precarga, el modal se abre y carga sus catalogos como respaldo.
    }
    setCreatePrefillTransferRequest(null)
    setShowCreateModal(true)
  }

  useEffect(() => {
    const request = pendingTransferSalidaRequest
    const requestKey = String(request?.requestKey || '').trim()
    if (!requestKey) return
    if (handledTransferRequestKeyRef.current === requestKey) return

    const markHandled = () => {
      handledTransferRequestKeyRef.current = requestKey
      onPendingTransferSalidaRequestHandled?.()
    }

    const targetBranchId = String(request?.sucursalProveedoraId || '').trim()
    if (
      targetBranchId &&
      normalizedCreateBranchId !== 'all' &&
      normalizedCreateBranchId !== targetBranchId
    ) {
      return
    }

    const requestMode = String(request?.mode || '').trim().toLowerCase()
    if (requestMode === 'view') {
      const movimientoSalidaIdRaw = request?.movimientoSalidaId ?? request?.solicitud?.movimiento_salida_id
      const movimientoSalidaId = String(movimientoSalidaIdRaw || '').trim()
      if (!movimientoSalidaId) {
        toast.current?.show({
          severity: 'warn',
          summary: 'Salida no disponible',
          detail: 'La solicitud no tiene una salida asociada para visualizar.',
          life: 3200,
        })
        markHandled()
        return
      }

      const parsedId = Number(movimientoSalidaId)
      setShowCreateModal(false)
      setCreatePrefillTransferRequest(null)
      setSelectedId(Number.isFinite(parsedId) ? parsedId : movimientoSalidaId)
      setShowDetailsModal(true)
      markHandled()
      return
    }

    if (!canCreate) {
      toast.current?.show({
        severity: 'warn',
        summary: 'Sin permiso',
        detail: 'No tienes permisos para crear salidas.',
        life: 3200,
      })
      markHandled()
      return
    }

    let cancelled = false
    const openPrefilledCreate = async () => {
      try {
        await preloadSalidaCatalogs()
      } catch {
        // Si falla la precarga, el modal puede cargar catalogos internamente.
      }
      if (cancelled) return

      setCreatePrefillTransferRequest({
        requestKey,
        solicitudId: String(request?.solicitudId || '').trim(),
        sucursalProveedoraId: targetBranchId,
        solicitud: request?.solicitud || null,
      })
      setShowCreateModal(true)
      markHandled()
    }

    openPrefilledCreate()
    return () => {
      cancelled = true
    }
  }, [
    canCreate,
    normalizedCreateBranchId,
    onPendingTransferSalidaRequestHandled,
    pendingTransferSalidaRequest,
    preloadSalidaCatalogs,
  ])

  const handleSearchInputChange = (event) => {
    const { name, value } = event.target
    setSearchCriteria((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleSearchSubmit = (event) => {
    event.preventDefault()
    const nextCriteria = { ...searchCriteria }
    lastSearchRef.current = nextCriteria
    setShowSearchModal(false)
    setSelectedRows([])
    refreshData({
      page: 1,
      criteria: nextCriteria,
    })
  }

  const focusSearch = () => {
    setSearchCriteria({ ...lastSearchRef.current })
    setShowSearchModal(true)
  }

  const exportColumns = useMemo(() => {
    const cols = selectedColumns.flatMap((col) => {
      if (col.nombrevar === 'productos_resumen') {
        return [
          { key: 'producto_codigo', header: 'Código' },
          { key: 'producto_nombre', header: 'Nombre producto' },
          { key: 'producto_cantidad', header: 'Cantidad' },
        ]
      }
      return [{ key: col.nombrevar, header: col.header }]
    })
    if (!cols.some((col) => col.key === 'estado_nombre')) {
      cols.push({ key: 'estado_nombre', header: 'Estado' })
    }
    return cols
  }, [selectedColumns])

  const getExportValue = useCallback((row, field) => {
    if (field === 'producto_codigo') {
      return row?.__export_product
        ? String(row.__export_product?.producto_codigo || '').trim() || '-'
        : '-'
    }
    if (field === 'producto_nombre') {
      return row?.__export_product
        ? String(row.__export_product?.producto_nombre || '').trim() || '-'
        : '-'
    }
    if (field === 'producto_cantidad') {
      return row?.__export_product
        ? formatMovementProductQuantity(row.__export_product?.cantidad)
        : '-'
    }
    if (field === 'total') {
      const total = Number(row?.total)
      return Number.isFinite(total) ? total.toFixed(2) : ''
    }
    if (field === 'estado_nombre') {
      return formatEstadoForTable(row?.estado_nombre || row?.estado_movimiento) || ''
    }
    return row?.[field] ?? ''
  }, [])

  const getRowsToExport = useCallback(() => {
    if (selectedRows?.length) return selectedRows
    return processedRows === null ? movimientos : processedRows
  }, [movimientos, processedRows, selectedRows])

  const getExpandedRowsToExport = useCallback(() => {
    const baseRows = getRowsToExport()
    return buildMovementProductExportRows(baseRows, exportColumns)
  }, [exportColumns, getRowsToExport])

  const notifyExportWarning = useCallback((detail) => {
    toast.current?.show({ severity: 'warn', summary: 'Sin datos', detail, life: 3000 })
  }, [])

  const handleExportExcel = useCallback(async () => {
    if (!exportColumns.length) {
      notifyExportWarning('Selecciona al menos una columna para exportar.')
      return
    }
    const rows = getExpandedRowsToExport()
    if (!rows.length) {
      notifyExportWarning('No hay registros para exportar.')
      return
    }
    await exportToExcel({
      rows,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('salidas'),
    })
  }, [exportColumns, getExpandedRowsToExport, getExportValue, notifyExportWarning])

  const handleExportPdf = useCallback(async () => {
    if (!exportColumns.length) {
      notifyExportWarning('Selecciona al menos una columna para exportar.')
      return
    }
    const rows = getExpandedRowsToExport()
    if (!rows.length) {
      notifyExportWarning('No hay registros para exportar.')
      return
    }
    await exportToPdf({
      rows,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('salidas'),
      title: 'Reporte de Salidas',
    })
  }, [exportColumns, getExpandedRowsToExport, getExportValue, notifyExportWarning])

  const { shouldRender: shouldRenderSearchModal, isClosing: isClosingSearchModal } = useModalAnimation(showSearchModal)

  useLayoutEffect(() => {
    if (!showSearchModal) return
    const width = Math.min(720, Math.max(0, window.innerWidth - SEARCH_PADDING * 2))
    const height = Math.min(520, Math.max(0, window.innerHeight - SEARCH_PADDING * 2))
    setSearchSize({ width, height })
    setSearchPosition({
      x: Math.max((window.innerWidth - width) / 2, SEARCH_PADDING),
      y: Math.max((window.innerHeight - height) / 2, SEARCH_PADDING),
    })
  }, [showSearchModal, SEARCH_PADDING])

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

        <button
          className="rounded-icon-btn"
          type="button"
          onClick={() => {
            if (globalSearchDebounceRef.current) {
              clearTimeout(globalSearchDebounceRef.current)
              globalSearchDebounceRef.current = null
            }
            refreshData()
          }}
          disabled={loading}
          title="Recargar"
        >
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

        <button className="rounded-icon-btn" type="button" onClick={(event) => opColumns.current?.toggle(event)} title="Campos">
          <i className="pi pi-sliders-h" />
        </button>
      </div>
      <div className="users-header__right">
        <span className="users-header__count">Reg. {totalRecords ?? 0}</span>
        <button className="users-circle users-circle--excel" type="button" title="Excel" onClick={handleExportExcel}>
          <i className="pi pi-file-excel" />
        </button>
        <button className="users-circle users-circle--pdf" type="button" title="PDF" onClick={handleExportPdf}>
          <i className="pi pi-file-pdf" />
        </button>
      </div>
    </div>
  )

  return (
    <div className="users-page">
      <Tooltip position="top" showDelay={1800} target=".cell-tooltip" style={{ maxWidth: '340px' }} />
      <Toast ref={toast} />

      <div className="users-page__top">
        <div className="users-page__actions">
          {canCreate && (
            <Button label="Crear" icon="pi pi-plus" className="users-topbtn users-topbtn--create" onClick={handleOpenCreateModal} type="button" />
          )}
          <Button label="Buscar" icon="pi pi-search" className="users-topbtn users-topbtn--search" onClick={focusSearch} type="button" />
          <div className="salidas-type-filter" role="group" aria-label="Filtros de tipo de salida">
            {SUBTYPE_FILTERS.map((option) => {
              const active = subtypeFilter === option.key
              return (
                <Button
                  key={option.key}
                  label={option.label}
                  type="button"
                  className={`users-topbtn salidas-type-filter__btn${active ? ' salidas-type-filter__btn--active' : ''}`}
                  onClick={() => handleSubtypeFilterChange(option.key)}
                />
              )
            })}
          </div>
        </div>
      </div>

      <div className="users-table users-table--card" ref={tableWrapperRef}>
        {loading && (
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
          value={movimientos}
          dataKey="id"
          header={header}
          className={`users-datatable${loading ? ' users-datatable--loading-content' : ''}`}
          tableStyle={{ width: '100%' }}
          emptyMessage={emptyMessage}
          showGridlines
          size="small"
          scrollable
          scrollHeight="flex"
          frozenWidth="40px"
          lazy
          paginator
          totalRecords={totalRecords}
          first={pageFirst}
          rows={pageSize}
          rowsPerPageOptions={[5, 10, 25, 50]}
          onPage={handlePageChange}
          removableSort
          sortField={sortField || undefined}
          sortOrder={sortOrder || 0}
          onSort={handleSortChange}
          reorderableColumns
          onColReorder={handleOrderChange}
          resizableColumns
          columnResizeMode="expand"
          key={tableResetKey}
          stateStorage="local"
          stateKey="salidas-table-state"
          filters={filters}
          onValueChange={(value) => setProcessedRows(value ?? [])}
          globalFilterFields={[
            'no_documento',
            'productos_resumen',
            'productos_codigos',
            'fecha',
            'sucursal_nombre',
            'sub_tipo_nombre',
            'sucursal_objetivo_nombre',
            'estado_nombre',
            'total',
            'funcional_label',
          ]}
          onRowClick={handleRowClick}
          onRowDoubleClick={handleRowDoubleClick}
          rowClassName={(rowData) => {
            const classes = []
            const normalizedEstado = normalizeValue(rowData?.estado_nombre)
            const normalizedSubTipo = normalizeValue(rowData?.sub_tipo_nombre || rowData?.sub_tipo_movimiento)
            const isTransferRow = normalizedSubTipo.includes('trasl')
            if (selectedRowIds.includes(normId(rowData?.id))) {
              classes.push('selected-row-shadow')
            }
            if (isTransferRow && normalizedEstado.includes('envi')) {
              classes.push('salidas-row--sent-traslado')
            }
            if (isTransferRow && (
              (normalizedEstado.includes('llego') && normalizedEstado.includes('inconven')) ||
              normalizedEstado.includes('parcial')
            )) {
              classes.push('salidas-row--partial-traslado')
            }
            return classes.join(' ')
          }}
          selectionMode="multiple"
          selection={selectedRows}
          onSelectionChange={(event) => {
            if (!isCheckboxSelection(event)) return
            setSelectedRows(event.value || [])
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

          {selectedColumns.map((column) => {
            const field = column.nombrevar
            const bodyTemplate =
              field === 'total'
                ? totalBodyTemplate
                : field === 'productos_resumen'
                  ? productsBodyTemplate
                  : (rowData) => cellWithTooltip(rowData, field)
            return (
              <Column
                key={field}
                field={field}
                header={column.header}
                body={bodyTemplate}
                sortable={field !== 'productos_resumen'}
                reorderable
                className={columnClassName(field)}
                style={{ minWidth: field === 'productos_resumen' ? '180px' : '32px' }}
              />
            )
          })}
        </DataTable>

        {Array.isArray(productHoverCard?.products) && productHoverCard.products.length > 0 && (
          <div
            className="movimientos-table__product-hover-card"
            role="tooltip"
            style={{
              top: productHoverCard.top,
              left: productHoverCard.left,
            }}
            onMouseEnter={clearProductHoverHideTimer}
            onMouseLeave={scheduleHideProductHoverCard}
          >
            <div className="movimientos-table__product-hover-title">Productos</div>
            <table className="movimientos-table__product-hover-table">
              <thead>
                <tr>
                  <th>Codigo</th>
                  <th>Producto</th>
                  <th className="movimientos-table__product-hover-qty">Cantidad</th>
                </tr>
              </thead>
              <tbody>
                {productHoverCard.products.map((product, index) => (
                  <tr key={`salida-product-hover-row-${index}`}>
                    <td title={String(product?.producto_codigo || '-').trim()}>
                      {String(product?.producto_codigo || '-').trim()}
                    </td>
                    <td title={String(product?.producto_nombre || '-').trim()}>
                      {String(product?.producto_nombre || '-').trim()}
                    </td>
                    <td
                      className="movimientos-table__product-hover-qty"
                      title={formatMovementProductQuantity(product?.cantidad)}
                    >
                      {formatMovementProductQuantity(product?.cantidad)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

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
                inputId={`salidas-col-${col.nombrevar}`}
                name="salidas-columns"
                value={col}
                onChange={() => handleCheckboxChangeColumn(col)}
                checked={selectedColumns.some((item) => item.nombrevar === col.nombrevar)}
              />
              <label htmlFor={`salidas-col-${col.nombrevar}`}>{col.header}</label>
            </div>
          ))}
        </OverlayPanel>
      </div>

      <CreateSalida
        open={showCreateModal}
        onClose={() => {
          setShowCreateModal(false)
          setCreatePrefillTransferRequest(null)
        }}
        onCreated={handleCreated}
        onTransferCancelled={handleTransferCancelled}
        currentUser={user}
        token={token}
        onError={showErrorToast}
        preloadedTipoMovimientos={prefetchedTipoMovimientos}
        preloadedSubTipos={prefetchedSubTiposSalida}
        prefilledSucursalId={hasSpecificCreateBranch ? normalizedCreateBranchId : ''}
        prefillTransferRequest={createPrefillTransferRequest}
      />

      <SalidaDetails
        open={showDetailsModal}
        salidaId={selectedId}
        onClose={() => setShowDetailsModal(false)}
        token={token}
        onUpdated={handleUpdated}
        onDeleted={handleDeleted}
        onError={showErrorToast}
        currentUser={user}
        allowEdit={canEdit}
        allowDelete={canDelete}
      />

      {shouldRenderSearchModal && (
        <div
          className={`create-user__overlay${isClosingSearchModal ? ' create-user__overlay--closing' : ''}`}
          role="dialog"
          aria-modal="true"
          style={{ padding: `${SEARCH_PADDING}px` }}
        >
          <div
            className={`create-user__modal${isClosingSearchModal ? ' create-user__modal--closing' : ''}`}
            style={{
              top: searchPosition.y,
              left: searchPosition.x,
              width: searchSize.width,
              height: searchSize.height,
              maxWidth: `calc(100vw - ${SEARCH_PADDING * 2}px)`,
              maxHeight: `calc(100vh - ${SEARCH_PADDING * 2}px)`,
            }}
          >
            <header className="create-user__header">
              <div className="create-user__header-text">
                <h3>Búsqueda avanzada de salidas</h3>
              </div>
              <div className="create-user__header-actions">
                <button
                  type="button"
                  className="create-user__icon-button"
                  onClick={() => setShowSearchModal(false)}
                  aria-label="Cerrar"
                >
                  <i className="pi pi-times" aria-hidden="true" />
                </button>
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
                      <span>Documento</span>
                      <input
                        name="no_documento"
                        type="text"
                        placeholder="Ej: FAC-001"
                        value={searchCriteria.no_documento}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Codigo producto</span>
                      <input
                        name="producto_codigo"
                        type="text"
                        placeholder="Ej: ABC-123"
                        value={searchCriteria.producto_codigo}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Sucursal</span>
                      <input
                        name="sucursal"
                        type="text"
                        placeholder="Ej: Matriz"
                        value={searchCriteria.sucursal}
                        onChange={handleSearchInputChange}
                      />
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
                      <span>Subtipo</span>
                      <input
                        name="sub_tipo"
                        type="text"
                        placeholder="Ej: Venta, Devolución"
                        value={searchCriteria.sub_tipo}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Estado</span>
                      <input
                        name="estado"
                        type="text"
                        placeholder="Ej: Facturado"
                        value={searchCriteria.estado}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Sucursal destino</span>
                      <input
                        name="sucursal_objetivo"
                        type="text"
                        placeholder="Ej: Norte"
                        value={searchCriteria.sucursal_objetivo}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Funcional</span>
                      <select
                        name="funcional"
                        value={searchCriteria.funcional}
                        onChange={handleSearchInputChange}
                      >
                        <option value="">Todos</option>
                        <option value="si">Si</option>
                        <option value="no">No</option>
                      </select>
                    </label>

                    <label className="create-user__field">
                      <span>Total mínimo</span>
                      <input
                        name="total_min"
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="Ej: 100"
                        value={searchCriteria.total_min}
                        onChange={handleSearchInputChange}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Total máximo</span>
                      <input
                        name="total_max"
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="Ej: 1000"
                        value={searchCriteria.total_max}
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
                    onClick={() => setSearchCriteria(initialSearchCriteria)}
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
          </div>
        </div>
      )}
    </div>
  )
}

export default SalidasTable
