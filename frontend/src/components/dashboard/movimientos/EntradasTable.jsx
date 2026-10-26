import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FilterMatchMode } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { OverlayPanel } from 'primereact/overlaypanel'
import { Checkbox } from 'primereact/checkbox'
import { Button } from 'primereact/button'

import CreateEntrada from './CreateEntrada'
import EntradaDetails from './EntradaDetails'
import CompraLocalDistribucionModal from './CompraLocalDistribucionModal'
import './EntradasTable.css'
import '../admin/UsersTable/UsersTable.css'
import useModalAnimation from '../common/useModalAnimation'
import {
  REMINDERS_TRANSFER_NOTIFICATION_EVENT,
  fetchRemindersFromBackend,
} from '../common/reminders/remindersStorage'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDate } from '../../../utils/dateFormat'
import { tableLayoutStore } from '../../../utils/tableLayoutStore'
import { attachAutoExpandColumns, autoFitTableColumns, makeWidthStateHandlers } from '../../../utils/autoFitColumns'
import { buildFileName, exportToExcel, exportToPdf } from '../../../utils/exportUtils'
import {
  buildPrimeColumnFiltersPayload,
  buildPrimeOrdering,
  getPrimeGlobalFilterValue,
} from '../../../utils/primeTableQuery'
import {
  buildMovementProductExportRows,
  buildMovementProductsExportText,
  buildMovementProductsSearchText,
  formatMovementProductLabel,
  formatMovementProductQuantity,
  normalizeMovementProducts,
} from './movementTableProducts'
import { isPhoneViewport } from '../../../utils/viewport'

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
  if (normalized.includes('solicitud') && normalized.includes('acept')) {
    return 'Aceptada'
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
const MOVEMENT_PRODUCTS_HOVER_CARD_MAX_HEIGHT = 520

const SUBTYPE_FILTERS = [
  { key: 'all', label: 'Todos' },
  { key: 'compra_local', label: 'Compra local' },
  { key: 'devolucion', label: 'Devoluciones' },
  { key: 'traslado', label: 'Traslados' },
]

const ENTRADAS_FILTER_FIELDS = [
  'no_documento',
  'factura_referencia',
  'fecha',
  'sucursal_nombre',
  'sub_tipo_nombre',
  'estado_nombre',
  'sucursal_objetivo_nombre',
  'proveedor_nombre',
  'total',
  'funcional_label',
]

const ENTRADAS_FILTER_DEFAULT_MODES = {
  no_documento: FilterMatchMode.CONTAINS,
  factura_referencia: FilterMatchMode.CONTAINS,
  fecha: FilterMatchMode.CONTAINS,
  sucursal_nombre: FilterMatchMode.CONTAINS,
  sub_tipo_nombre: FilterMatchMode.CONTAINS,
  estado_nombre: FilterMatchMode.CONTAINS,
  sucursal_objetivo_nombre: FilterMatchMode.CONTAINS,
  proveedor_nombre: FilterMatchMode.CONTAINS,
  total: FilterMatchMode.EQUALS,
  funcional_label: FilterMatchMode.CONTAINS,
}

const ENTRADAS_ORDERING_MAP = {
  no_documento: 'no_documento',
  factura_referencia: 'factura_referencia',
  fecha: 'fecha',
  sucursal_nombre: 'sucursal__nombre',
  sub_tipo_nombre: 'sub_tipo_movimiento__nombre',
  estado_nombre: 'estado_movimiento__nombre',
  sucursal_objetivo_nombre: 'sucursal_objetivo__nombre',
  proveedor_nombre: 'casa_comercial__nombre',
  total: 'total_monto',
  funcional_label: 'funcional',
}

const COMPRA_LOCAL_COLUMN_ORDER = [
  'proveedor_nombre',
  'factura_referencia',
  'productos_resumen',
  'fecha',
  'no_documento',
  'sucursal_nombre',
  'estado_nombre',
  'total',
  'funcional_label',
]

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


function EntradasTable({
  token,
  user,
  isTabActive = false,
  createBranchId = '',
  moduleActions,
  pendingTransferEntradaRequest = null,
  onPendingTransferEntradaRequestHandled,
}) {
  const toast = useRef(null)
  const opColumns = useRef(null)
  const tableWrapperRef = useRef(null)

  // Ajusta automaticamente el ancho de las columnas para llenar el espacio
  // disponible en pantallas grandes, sin comprimir en pantallas chicas.
  useEffect(() => attachAutoExpandColumns(tableWrapperRef.current), [])
  const widthHandlers = useMemo(() => makeWidthStateHandlers('entradas-table-state-v2'), [])
  const [tableResetKey, setTableResetKey] = useState(0)
  const preloadEntradaCatalogsPromiseRef = useRef(null)
  const globalSearchDebounceRef = useRef(null)
  const fetchSeqRef = useRef(0)
  const fetchMovimientosRef = useRef(null)
  const latestTableOptionsRef = useRef({})
  const loadedTokenRef = useRef(null)
  const handledTransferRequestKeyRef = useRef('')
  const notificationRefreshInFlightRef = useRef(false)
  const pendingNotificationRefreshRef = useRef(false)
  const refreshDataRef = useRef(() => Promise.resolve([]))
  const productHoverHideTimeoutRef = useRef(null)
  const productHoverCardRef = useRef(null)
  const canCreate = moduleActions?.puede_crear ?? true
  const canEdit = moduleActions?.puede_actualizar ?? true
  const canDelete = moduleActions?.puede_eliminar ?? true
  const clickTimerRef = useRef(null)
  const pendingClickRowRef = useRef(null)
  const pendingClickCountRef = useRef(0)

  const [movimientos, setMovimientos] = useState([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [pageFirst, setPageFirst] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [sortField, setSortField] = useState(null)
  const [sortOrder, setSortOrder] = useState(null)
  const [filters, setFilters] = useState(() => createInitialFilters())
  const [globalFilterValue, setGlobalFilterValue] = useState('')
  const [isGlobalSearchPending, setIsGlobalSearchPending] = useState(false)
  const globalSearchSeqRef = useRef(0)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createPrefillTransferRequest, setCreatePrefillTransferRequest] = useState(null)
  const [cancellingTransfer, setCancellingTransfer] = useState(false)
  const [resubmittingTransfer, setResubmittingTransfer] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [showDetailsModal, setShowDetailsModal] = useState(false)
  const [distribucionCompraId, setDistribucionCompraId] = useState(null)
  const [selectedSolicitudPreview, setSelectedSolicitudPreview] = useState(null)
  const [selectedRows, setSelectedRows] = useState([])
  const [prefetchedTipoMovimientos, setPrefetchedTipoMovimientos] = useState([])
  const [prefetchedSubTiposEntrada, setPrefetchedSubTiposEntrada] = useState([])
  const [entradaCatalogsPreloaded, setEntradaCatalogsPreloaded] = useState(false)
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
      { nombrevar: 'no_documento', header: 'Código', filterPlaceholder: 'Buscar por código' },
      { nombrevar: 'factura_referencia', header: 'No. de Factura', filterPlaceholder: 'Buscar por factura' },
      { nombrevar: 'productos_resumen', header: 'Productos', filterPlaceholder: 'Buscar por productos' },
      { nombrevar: 'fecha', header: 'Fecha', filterPlaceholder: 'Buscar por fecha' },
      { nombrevar: 'sucursal_nombre', header: 'Sucursal', filterPlaceholder: 'Buscar por sucursal' },
      { nombrevar: 'sub_tipo_nombre', header: 'Tipo', filterPlaceholder: 'Buscar por tipo' },
      { nombrevar: 'sucursal_objetivo_nombre', header: 'Sucursal proveedora', filterPlaceholder: 'Buscar por sucursal proveedora' },
      { nombrevar: 'proveedor_nombre', header: 'Proveedor', filterPlaceholder: 'Buscar por proveedor' },
      { nombrevar: 'estado_nombre', header: 'Estado', filterPlaceholder: 'Buscar por estado' },
      { nombrevar: 'total', header: 'Total', filterPlaceholder: 'Buscar por total' },
      { nombrevar: 'funcional_label', header: 'Funcional', filterPlaceholder: 'Buscar por funcional' },
    ],
    []
  )

  const [selectedColumns, setSelectedColumns] = useState(columnsData)

  const compraLocalColumns = useMemo(
    () =>
      COMPRA_LOCAL_COLUMN_ORDER
        .map((key) => columnsData.find((col) => col.nombrevar === key))
        .filter(Boolean),
    [columnsData]
  )

  const activeColumns = subtypeFilter === 'compra_local' ? compraLocalColumns : selectedColumns
  const [productHoverCard, setProductHoverCard] = useState(null)

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

  const showSuccessToast = useCallback(
    (detail, summary = 'Listo') =>
      toast.current?.show({
        severity: 'success',
        summary,
        detail,
        life: 3500,
      }),
    []
  )

  useEffect(() => {
    const stored = tableLayoutStore.getItem('entradas-table-columns')
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        const columnsByField = new Map(columnsData.map((col) => [col.nombrevar, col]))
        const restored = (Array.isArray(parsed) ? parsed : [])
          .map((col) => columnsByField.get(col?.nombrevar))
          .filter(Boolean)
        setSelectedColumns(restored.length ? restored : columnsData)
      } catch {
        tableLayoutStore.removeItem('entradas-table-columns')
      }
    }
    // No cleanup-based flush here: handleCheckboxChangeColumn and
    // handleOrderChange already persist synchronously on every real change.
  }, [columnsData])

  const normalizeList = useCallback(
    (list) =>
      list.map((row) => {
        const total = parseTotalValue(row)
        const productos = normalizeMovementProducts(row?.detalles)
        return {
          ...row,
          sucursal_nombre: row?.sucursal_nombre || row?.sucursal || '-',
          sub_tipo_nombre: row?.sub_tipo_nombre || row?.sub_tipo_movimiento || '-',
          estado_nombre: formatEstadoForTable(row?.estado_nombre || row?.estado_movimiento),
          sucursal_objetivo_nombre: row?.sucursal_objetivo_nombre || row?.sucursal_objetivo || '-',
          proveedor_nombre: (row?.casa_comercial_nombre && row.casa_comercial_nombre !== '-') ? row.casa_comercial_nombre : '-',
          factura_referencia: row?.factura_referencia || '-',
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

    params.set('tipo', 'entrada')
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
      allowedFields: ENTRADAS_FILTER_FIELDS,
      defaultMatchModes: ENTRADAS_FILTER_DEFAULT_MODES,
    })
    if (columnFilters) {
      params.set('column_filters', JSON.stringify(columnFilters))
    }

    const ordering = buildPrimeOrdering(tableSortField, tableSortOrder, ENTRADAS_ORDERING_MAP)
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
        if (!response.ok) throw new Error('No se pudo obtener la lista de entradas.')
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
        const msg = err?.message || 'Ocurrio un error al cargar las entradas.'
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

  const preloadEntradaCatalogs = useCallback(async () => {
    if (!token) return
    if (entradaCatalogsPreloaded) return
    if (preloadEntradaCatalogsPromiseRef.current) {
      return preloadEntradaCatalogsPromiseRef.current
    }

    preloadEntradaCatalogsPromiseRef.current = (async () => {
      try {
        const [tiposRes, subTiposRes] = await Promise.all([
          authFetch(`${API_URL}/tipos/tipos-movimiento/`, {}, token),
          authFetch(`${API_URL}/tipos/subtipos-movimiento/`, {}, token),
        ])
        if (!tiposRes.ok || !subTiposRes.ok) return

        const [tiposData, subTiposData] = await Promise.all([tiposRes.json(), subTiposRes.json()])
        const tiposList = parseApiList(tiposData)
        const subTiposList = parseApiList(subTiposData)
        const entradaTipo = tiposList.find((tipo) => normalizeValue(tipo?.nombre).startsWith('ent'))
        const entradaTipoId = entradaTipo?.id

        setPrefetchedTipoMovimientos(tiposList)
        if (!entradaTipoId) {
          setPrefetchedSubTiposEntrada([])
          return
        }
        setPrefetchedSubTiposEntrada(
          subTiposList.filter(
            (subTipo) => String(subTipo?.tipo_movimiento?.id || '') === String(entradaTipoId)
          )
        )
        setEntradaCatalogsPreloaded(true)
      } finally {
        preloadEntradaCatalogsPromiseRef.current = null
      }
    })()

    return preloadEntradaCatalogsPromiseRef.current
  }, [entradaCatalogsPreloaded, token])

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
    setEntradaCatalogsPreloaded(false)
    setPrefetchedTipoMovimientos([])
    setPrefetchedSubTiposEntrada([])
  }, [token])

  useEffect(() => {
    preloadEntradaCatalogs()
  }, [preloadEntradaCatalogs])

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
        allowedFields: ENTRADAS_FILTER_FIELDS,
        defaultMatchModes: ENTRADAS_FILTER_DEFAULT_MODES,
      }),
    [filters]
  )

  const hasSearchApplied = Boolean(String(globalFilterValue || '').trim()) || Boolean(activeColumnFilters)
  const emptyMessageByFilter = {
    all: hasSearchApplied ? 'No se encontraron entradas.' : 'No hay entradas registradas.',
    compra_local: hasSearchApplied ? 'No se encontraron compras locales.' : 'No hay compras locales registradas.',
    devolucion: hasSearchApplied ? 'No se encontraron devoluciones.' : 'No hay devoluciones registradas.',
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

    const handleReminderNotification = () => {
      runNotificationRefresh()
    }

    window.addEventListener(REMINDERS_TRANSFER_NOTIFICATION_EVENT, handleReminderNotification)

    return () => {
      notificationRefreshInFlightRef.current = false
      pendingNotificationRefreshRef.current = false
      window.removeEventListener(REMINDERS_TRANSFER_NOTIFICATION_EVENT, handleReminderNotification)
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
    autoFitTableColumns(tableWrapperRef.current, 'entradas-table-state-v2')
  }, [])

  const handleResetTable = () => {
    tableLayoutStore.removeItem('entradas-table-columns')
    tableLayoutStore.removeItem('entradas-table-state-v2')
    setSelectedColumns(columnsData)
    clearFilter()
    setTableResetKey((k) => k + 1)
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
    const seq = globalSearchSeqRef.current + 1
    globalSearchSeqRef.current = seq
    setIsGlobalSearchPending(true)
    globalSearchDebounceRef.current = setTimeout(() => {
      refreshData({
        page: 1,
        tableFilters: nextFilters,
        globalSearchValue: value || '',
      }).finally(() => {
        if (globalSearchSeqRef.current === seq) setIsGlobalSearchPending(false)
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
    const next = selectedColumns.some((item) => item.nombrevar === column.nombrevar)
      ? selectedColumns.filter((item) => item.nombrevar !== column.nombrevar)
      : [...selectedColumns, column]
    setSelectedColumns(next)
    tableLayoutStore.setItemNow('entradas-table-columns', JSON.stringify(next))
  }

  const handleOrderChange = (event) => {
    const columnOrder = (Array.isArray(event?.columns) ? event.columns : []).map((col) => col.props.field)
    const sorted = columnOrder.map((field) => selectedColumns.find((col) => col.nombrevar === field)).filter(Boolean)
    if (sorted.length) {
      setSelectedColumns(sorted)
      tableLayoutStore.setItemNow('entradas-table-columns', JSON.stringify(sorted))
    }
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

      // Estima el alto real del card según su contenido (título + encabezado +
      // filas) en vez de asumir siempre el máximo — así una lista corta se
      // sigue posicionando pegada al ojo, y solo listas largas (que superan
      // min(70vh, 520px), el max-height real del CSS) se recorren hacia
      // arriba lo justo para no quedar cortadas por el borde inferior.
      const estimatedCardHeight = 32 + 24 + normalizedProducts.length * 27 + 12
      const cardHeight = Math.min(
        estimatedCardHeight,
        MOVEMENT_PRODUCTS_HOVER_CARD_MAX_HEIGHT,
        window.innerHeight * 0.7
      )
      const maxTop = Math.max(
        window.innerHeight - cardHeight - MOVEMENT_PRODUCTS_HOVER_CARD_MARGIN,
        MOVEMENT_PRODUCTS_HOVER_CARD_MARGIN
      )
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
    const handleScroll = (event) => {
      // Ignora el scroll que ocurre dentro del propio card (para poder
      // recorrer la lista de productos con la rueda del mouse); solo lo
      // oculta cuando el scroll viene de la tabla/página de atrás.
      if (productHoverCardRef.current && event.target && productHoverCardRef.current.contains(event.target)) {
        return
      }
      hideProductHoverCard()
    }

    window.addEventListener('scroll', handleScroll, true)
    return () => window.removeEventListener('scroll', handleScroll, true)
  }, [hideProductHoverCard])

  const cellWithTooltip = (rowData, field, displayValue) => {
    const content = displayValue !== undefined ? displayValue : (rowData?.[field] ?? '-')
    const textColor = content === '-' ? '#9ca3af' : undefined
    const normalizedEstado = normalizeValue(rowData?.estado_nombre)
    const isSolicitudTraslado = Boolean(rowData?.es_solicitud_traslado)
    const normalizedSubTipo = normalizeValue(rowData?.sub_tipo_nombre || rowData?.sub_tipo_movimiento)
    const isTransferRow = isSolicitudTraslado || normalizedSubTipo.includes('trasl')
    const isPendingSolicitud = isSolicitudTraslado && normalizedEstado.includes('pend')
    const isGuardadoSolicitud = isSolicitudTraslado && normalizedEstado.includes('guardad')
    const isRejectedSolicitud =
      isSolicitudTraslado &&
      (normalizedEstado.includes('rechaz') || normalizedEstado.includes('cancel'))
    const isAcceptedSolicitud =
      isSolicitudTraslado &&
      (normalizedEstado.includes('acept') || normalizedEstado.includes('aprob'))
    const isSentSolicitud =
      isTransferRow &&
      normalizedEstado.includes('envi')
    const isPartialSolicitud =
      isTransferRow &&
      normalizedEstado.includes('parcial')
    const isLegado = Boolean(rowData?.es_legado)
    const className = [
      'cell-tooltip',
      field === 'estado_nombre' && isPendingSolicitud ? 'entradas-pending-state-chip' : '',
      field === 'estado_nombre' && isGuardadoSolicitud ? 'entradas-guardado-state-chip' : '',
      field === 'estado_nombre' && isRejectedSolicitud ? 'entradas-rejected-state-chip' : '',
      field === 'estado_nombre' && isPartialSolicitud ? 'entradas-partial-state-chip' : '',
      field === 'estado_nombre' && isAcceptedSolicitud ? 'entradas-accepted-state-chip' : '',
      field === 'estado_nombre' && isSentSolicitud ? 'entradas-sent-state-chip' : '',
    ]
      .filter(Boolean)
      .join(' ')
    return (
      <span className={className} data-pr-tooltip={String(content)} style={{ color: textColor }}>
        {String(content)}
        {field === 'estado_nombre' && isLegado && (
          <span className="movimientos-legado-badge" title="Registro previo a Kava: no se puede editar">
            Registro previo a Kava
          </span>
        )}
        {field === 'estado_nombre' && rowData?.compra_por_repartir > 0 && (
          <span
            className="entradas-por-repartir-badge"
            title={`Quedan ${rowData.compra_por_repartir} u. de esta compra que se pueden enviar a otras sucursales`}
          >
            <i className="pi pi-send" />
            Por enviar a sucursales
          </span>
        )}
      </span>
    )
  }

  const totalBodyTemplate = (rowData) => {
    const normalizedSubTipo = normalizeValue(rowData?.sub_tipo_nombre || rowData?.sub_tipo_movimiento)
    const isTransferRow = Boolean(rowData?.es_solicitud_traslado) || normalizedSubTipo.includes('trasl')
    const value = isTransferRow ? '$0.00' : parseCurrency(rowData?.total)
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
    const codes = products.map((p) => p?.producto_codigo).filter(Boolean)
    const allCodes = codes.join(', ')
    const displayCodes = codes.length > 2 ? codes.slice(0, 2).join(', ') + '...' : allCodes
    const primaryLabel = displayCodes || primaryProduct?.producto_nombre || '-'
    const primaryTooltip = [
      allCodes || primaryProduct?.producto_codigo,
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

  const selectRowFromData = useCallback((rowData) => {
    if (!rowData) return
    if (rowData?.es_solicitud_traslado) {
      setSelectedSolicitudPreview(rowData)
      setSelectedId(null)
      return
    }
    setSelectedSolicitudPreview(null)
    setSelectedId(rowData?.id ?? null)
  }, [])

  const handleRowClick = (event) => {
    const target = event?.originalEvent?.target
    if (target?.closest?.('.p-checkbox') || target?.closest?.('.row-selection-column')) return
    // En el telefono un toque abre el registro (el doble toque no es confiable)
    if (isPhoneViewport()) {
      handleRowDoubleClick(event)
      return
    }

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
    selectRowFromData(rowData)
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

  const handleCreated = (createdPayload, { isCompraLocal = false } = {}) => {
    setCreatePrefillTransferRequest(null)
    setShowCreateModal(false)
    setSelectedRows([])
    refreshData({ page: 1 })
    // Compra local recien creada en la matriz: como en una importacion, se
    // reparte de una vez a las demas sucursales (o se deja todo en la matriz).
    // En otra sucursal la compra entra directo a su stock, sin reparto.
    if (isCompraLocal && createdPayload?.id && createdPayload?.es_sucursal_matriz) setDistribucionCompraId(createdPayload.id)
    const isSolicitudTraslado = Boolean(createdPayload?.sucursal_solicitante_id && createdPayload?.sucursal_proveedora_id)
    const isGuardado = String(createdPayload?.estado || '').trim().toLowerCase() === 'guardado'
    toast.current?.show({
      severity: 'success',
      summary: 'Exito',
      detail: isGuardado
        ? 'Pedido a sucursal guardado'
        : (isSolicitudTraslado ? 'Solicitud creada correctamente' : 'Entrada creada correctamente'),
      life: 2500,
    })
  }

  const handleUpdated = () => {
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Actualizado', detail: 'Entrada actualizada correctamente', life: 2500 })
  }

  const handleDeleted = () => {
    setShowDetailsModal(false)
    setSelectedId(null)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Eliminado', detail: 'Entrada eliminada', life: 2500 })
  }

  const handleOpenCreateModal = async () => {
    if (!canCreate) return
    if (!hasSpecificCreateBranch) {
      toast.current?.show({
        severity: 'warn',
        summary: 'Selecciona sucursal',
        detail: 'Selecciona una sucursal especifica para crear una entrada.',
        life: 3000,
      })
      return
    }
    try {
      await preloadEntradaCatalogs()
    } catch {
      // Si falla la precarga, el modal se abre y carga sus catalogos como respaldo.
    }
    setCreatePrefillTransferRequest(null)
    setShowCreateModal(true)
  }

  const handleCancelTransfer = useCallback(async (previewPayload) => {
    const preview = previewPayload && typeof previewPayload === 'object'
      ? previewPayload
      : selectedSolicitudPreview
    if (!preview) return

    const solicitudId = String(preview?.solicitud_traslado_id || preview?.id || '').trim()
    if (!solicitudId) return

    if (cancellingTransfer) return
    setCancellingTransfer(true)

    try {
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(solicitudId)}/cancelar-pedido/`,
        { method: 'POST', body: JSON.stringify({ motivo: 'Pedido cancelado por el solicitante.' }) },
        token
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = String(data?.detail || 'No se pudo cancelar el pedido.')
        throw new Error(detail)
      }

      setShowDetailsModal(false)
      setSelectedSolicitudPreview(null)
      setSelectedId(null)
      void fetchRemindersFromBackend(token)
      void refreshData()
    } catch (error) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: error?.message || 'No se pudo cancelar el pedido.',
        life: 3200,
      })
    } finally {
      setCancellingTransfer(false)
    }
  }, [cancellingTransfer, refreshData, selectedSolicitudPreview, token])

  const handleResubmitTransfer = useCallback(async (previewPayload) => {
    const preview = previewPayload && typeof previewPayload === 'object'
      ? previewPayload
      : selectedSolicitudPreview
    if (!preview) return

    const solicitudId = String(preview?.solicitud_traslado_id || preview?.id || '').trim()
    if (!solicitudId) return

    if (resubmittingTransfer) return
    setResubmittingTransfer(true)

    try {
      const reactivationDraft = (
        preview && typeof preview.reactivationDraft === 'object' && preview.reactivationDraft
      ) ? preview.reactivationDraft : {}
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(solicitudId)}/reabrir/`,
        {
          method: 'POST',
          body: JSON.stringify(reactivationDraft),
        },
        token
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = typeof data?.detail === 'string'
          ? data.detail
          : typeof data?.detalles === 'string'
            ? data.detalles
            : typeof data?.sucursal_proveedora_id === 'string'
              ? data.sucursal_proveedora_id
              : 'No se pudo reabrir la solicitud.'
        throw new Error(detail)
      }

      setShowDetailsModal(false)
      setSelectedSolicitudPreview(null)
      setSelectedId(null)
      void fetchRemindersFromBackend(token)
      void refreshData()
    } catch (error) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: error?.message || 'No se pudo reabrir la solicitud.',
        life: 3500,
      })
    } finally {
      setResubmittingTransfer(false)
    }
  }, [resubmittingTransfer, selectedSolicitudPreview, token, refreshData])

  useEffect(() => {
    const request = pendingTransferEntradaRequest
    const requestKey = String(request?.requestKey || '').trim()
    if (!requestKey) return
    if (handledTransferRequestKeyRef.current === requestKey) return

    const markHandled = () => {
      handledTransferRequestKeyRef.current = requestKey
      onPendingTransferEntradaRequestHandled?.()
    }

    const requestMode = String(request?.mode || '').trim().toLowerCase()
    const previewData = request?.previewData
    const solicitudId = String(request?.solicitudId || previewData?.solicitud_traslado_id || '').trim()
    const movimientoEntradaId = String(
      request?.movimientoEntradaId ||
      previewData?.movimiento_entrada_id ||
      ''
    ).trim()
    if (!solicitudId) {
      markHandled()
      return
    }

    const targetBranchId = String(
      request?.sucursalSolicitanteId || previewData?.sucursal_solicitante_id || ''
    ).trim()
    if (targetBranchId && normalizedCreateBranchId !== 'all' && normalizedCreateBranchId !== targetBranchId) {
      return
    }

    if (requestMode === 'view' && movimientoEntradaId) {
      const parsedId = Number(movimientoEntradaId)
      setSelectedSolicitudPreview(null)
      setSelectedId(Number.isFinite(parsedId) ? parsedId : movimientoEntradaId)
      setShowDetailsModal(true)
      markHandled()
      return
    }

    if (!previewData) {
      markHandled()
      return
    }

    setSelectedId(null)
    setSelectedSolicitudPreview(previewData)
    setShowDetailsModal(true)
    markHandled()
  }, [
    normalizedCreateBranchId,
    onPendingTransferEntradaRequestHandled,
    pendingTransferEntradaRequest,
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
    const cols = activeColumns.flatMap((col) => {
      if (col.nombrevar === 'productos_resumen') {
        return [
          { key: 'producto_codigo', header: 'Código' },
          { key: 'producto_nombre', header: 'Descripción producto' },
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
      fileName: buildFileName('entradas'),
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
      fileName: buildFileName('entradas'),
      title: 'Reporte de Entradas',
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
          <i className={`pi ${isGlobalSearchPending ? 'pi-spinner pi-spin' : 'pi-search'} search-input-icon`} />
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
          <div className="entradas-type-filter" role="group" aria-label="Filtros de tipo de entrada">
            {SUBTYPE_FILTERS.map((option) => {
              const active = subtypeFilter === option.key
              return (
                <Button
                  key={option.key}
                  label={option.label}
                  type="button"
                  className={`users-topbtn entradas-type-filter__btn${active ? ' entradas-type-filter__btn--active' : ''}`}
                  onClick={() => handleSubtypeFilterChange(option.key)}
                />
              )
            })}
          </div>
        </div>
      </div>

      <div className="users-table users-table--card" ref={tableWrapperRef}>
        {loading && !isGlobalSearchPending && (
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
          className={`users-datatable${loading && !isGlobalSearchPending ? ' users-datatable--loading-content' : ''}`}
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
          stateStorage="custom"
          customSaveState={widthHandlers.save}
          customRestoreState={widthHandlers.restore}
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
            const isSolicitudTraslado = Boolean(rowData?.es_solicitud_traslado)
            const normalizedSubTipo = normalizeValue(rowData?.sub_tipo_nombre || rowData?.sub_tipo_movimiento)
            const isTransferRow = isSolicitudTraslado || normalizedSubTipo.includes('trasl')
            if (selectedRowIds.includes(normId(rowData?.id))) {
              classes.push('selected-row-shadow')
            }
            if (isSolicitudTraslado && normalizedEstado.includes('pend')) {
              classes.push('entradas-row--pending-solicitud')
            }
            if (isSolicitudTraslado && normalizedEstado.includes('guardad')) {
              classes.push('entradas-row--guardado-solicitud')
            }
            if (isSolicitudTraslado && (normalizedEstado.includes('rechaz') || normalizedEstado.includes('cancel'))) {
              classes.push('entradas-row--rejected-solicitud')
            }
            if (isTransferRow && normalizedEstado.includes('parcial')) {
              classes.push('entradas-row--partial-solicitud')
            }
            if (isSolicitudTraslado && (normalizedEstado.includes('acept') || normalizedEstado.includes('aprob'))) {
              classes.push('entradas-row--accepted-solicitud')
            }
            if (isTransferRow && normalizedEstado.includes('envi')) {
              classes.push('entradas-row--sent-solicitud')
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

          {activeColumns.map((column) => {
            const field = column.nombrevar
            const bodyTemplate =
              field === 'total'
                ? totalBodyTemplate
                : field === 'productos_resumen'
                  ? productsBodyTemplate
                  : field === 'fecha'
                    ? (rowData) => cellWithTooltip(rowData, field, formatDate(rowData?.fecha))
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
            ref={productHoverCardRef}
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
                  <tr key={`entrada-product-hover-row-${index}`}>
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
                inputId={`entradas-col-${col.nombrevar}`}
                name="entradas-columns"
                value={col}
                onChange={() => handleCheckboxChangeColumn(col)}
                checked={selectedColumns.some((item) => item.nombrevar === col.nombrevar)}
              />
              <label htmlFor={`entradas-col-${col.nombrevar}`}>{col.header}</label>
            </div>
          ))}
        </OverlayPanel>
      </div>

      <CreateEntrada
        open={showCreateModal}
        onClose={() => {
          setShowCreateModal(false)
          setCreatePrefillTransferRequest(null)
        }}
        onCreated={handleCreated}
        token={token}
        onError={showErrorToast}
        onSuccess={showSuccessToast}
        preloadedTipoMovimientos={prefetchedTipoMovimientos}
        preloadedSubTipos={prefetchedSubTiposEntrada}
        prefilledSucursalId={hasSpecificCreateBranch ? normalizedCreateBranchId : ''}
        prefilledTransferRequest={createPrefillTransferRequest}
        currentUser={user}
      />

      <EntradaDetails
        open={showDetailsModal}
        entradaId={selectedId}
        previewData={selectedSolicitudPreview}
        readOnly={
          Boolean(selectedSolicitudPreview) &&
          !(
            String((selectedSolicitudPreview?.estado_nombre || selectedSolicitudPreview?.estado || ''))
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase()
              .match(/pend|rechaz|cancel|guardad/)
          )
        }
        onClose={() => {
          setShowDetailsModal(false)
          setSelectedSolicitudPreview(null)
        }}
        token={token}
        onUpdated={handleUpdated}
        onDeleted={handleDeleted}
        onError={showErrorToast}
        currentUser={user}
        allowEdit={canEdit}
        allowDelete={canDelete}
        onCancelTransfer={handleCancelTransfer}
        cancellingTransfer={cancellingTransfer}
        onResubmitTransfer={handleResubmitTransfer}
        resubmittingTransfer={resubmittingTransfer}
        onDistribuirCompra={(id) => setDistribucionCompraId(id)}
      />

      <CompraLocalDistribucionModal
        open={Boolean(distribucionCompraId)}
        entradaId={distribucionCompraId}
        token={token}
        onClose={() => setDistribucionCompraId(null)}
        onSent={(_, nombres) => {
          setDistribucionCompraId(null)
          refreshData()
          toast.current?.show({
            severity: 'success',
            summary: 'Enviado',
            detail: `Envio en camino a ${nombres.join(', ')}. Lo reciben desde Envios pendientes.`,
            life: 3500,
          })
        }}
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
              maxHeight: `calc(100dvh - ${SEARCH_PADDING * 2}px)`,
            }}
          >
            <header className="create-user__header">
              <div className="create-user__header-text">
                <h3>Búsqueda avanzada de entradas</h3>
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
                      <span>Código</span>
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
                      <span>Sucursal proveedora</span>
                      <input
                        name="sucursal_objetivo"
                        type="text"
                        placeholder="Ej: Tumbaco"
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

export default EntradasTable
