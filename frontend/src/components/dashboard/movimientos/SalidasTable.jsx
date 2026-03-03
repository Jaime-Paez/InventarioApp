import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FilterMatchMode, FilterOperator } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { Button } from 'primereact/button'

import CreateSalida from './CreateSalida'
import SalidaDetails from './SalidaDetails'
import './SalidasTable.css'
import '../admin/UsersTable/UsersTable.css'
import { API_URL, authFetch } from '../../../utils/api'
import {
  buildPrimeColumnFiltersPayload,
  buildPrimeOrdering,
  getPrimeGlobalFilterValue,
} from '../../../utils/primeTableQuery'

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeValue = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
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

const SUBTYPE_FILTERS = [
  { key: 'all', label: 'Todos' },
  { key: 'venta', label: 'Ventas' },
  { key: 'devolucion', label: 'Devoluciones' },
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
  no_documento: {
    operator: FilterOperator.AND,
    constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }],
  },
  fecha: {
    operator: FilterOperator.AND,
    constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }],
  },
  sucursal_nombre: {
    operator: FilterOperator.AND,
    constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }],
  },
  sub_tipo_nombre: {
    operator: FilterOperator.AND,
    constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }],
  },
  estado_nombre: {
    operator: FilterOperator.AND,
    constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }],
  },
  sucursal_objetivo_nombre: {
    operator: FilterOperator.AND,
    constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }],
  },
  total: {
    operator: FilterOperator.AND,
    constraints: [{ value: null, matchMode: FilterMatchMode.EQUALS }],
  },
  funcional_label: {
    operator: FilterOperator.AND,
    constraints: [{ value: null, matchMode: FilterMatchMode.CONTAINS }],
  },
})

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

function SalidasTable({ token }) {
  const toast = useRef(null)
  const preloadSalidaCatalogsPromiseRef = useRef(null)
  const globalSearchDebounceRef = useRef(null)
  const fetchSeqRef = useRef(0)
  const loadedTokenRef = useRef(null)

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
  const [subtypeFilter, setSubtypeFilter] = useState('all')

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

  const normalizeList = useCallback(
    (list) =>
      list.map((row) => {
        const total = parseTotalValue(row)
        return {
          ...row,
          sucursal_nombre: row?.sucursal_nombre || row?.sucursal || '-',
          sub_tipo_nombre: row?.sub_tipo_nombre || row?.sub_tipo_movimiento || '-',
          estado_nombre: row?.estado_nombre || row?.estado_movimiento || '-',
          sucursal_objetivo_nombre: row?.sucursal_objetivo_nombre || row?.sucursal_objetivo || '-',
          funcional_label: row?.funcional_label || (row?.funcional ? 'Si' : 'No'),
          total,
        }
      }),
    []
  )

  const buildMovimientosListUrl = useCallback((options = {}) => {
    const params = new URLSearchParams()
    const page = Number(options?.page) || 1
    const rows = Number(options?.rows) || 25
    const tableFilters = options?.tableFilters || createInitialFilters()
    const tableSortField = options?.tableSortField ?? null
    const tableSortOrder = options?.tableSortOrder ?? null
    const subtype = String(options?.subtypeFilter || 'all').trim()

    params.set('tipo', 'salida')
    params.set('page', String(page))
    params.set('page_size', String(rows))

    if (subtype && subtype !== 'all') {
      params.set('subtipo', subtype)
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
    params.set('ordering', ordering || '-fecha,-id')

    return `${API_URL}/movimientos/movimiento_inventario/tabla/?${params.toString()}`
  }, [])

  const fetchMovimientos = useCallback(
    async (options = {}) => {
      if (!token) return []

      const page = Number(options?.page) || 1
      const rows = Number(options?.rows) || pageSize
      const tableFilters = options?.tableFilters || createInitialFilters()
      const tableSortField = options?.tableSortField ?? null
      const tableSortOrder = options?.tableSortOrder ?? null
      const subtype = String(options?.subtypeFilter || 'all').trim()
      const globalSearchValue = Object.prototype.hasOwnProperty.call(options, 'globalSearchValue')
        ? options?.globalSearchValue
        : getPrimeGlobalFilterValue(tableFilters)

      const requestId = fetchSeqRef.current + 1
      fetchSeqRef.current = requestId
      setLoading(true)
      setError(null)
      try {
        const url = buildMovimientosListUrl({
          page,
          rows,
          tableFilters,
          tableSortField,
          tableSortOrder,
          globalSearchValue,
          subtypeFilter: subtype,
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
    [buildMovimientosListUrl, normalizeList, pageSize, token]
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

    fetchMovimientos({
      page: 1,
      rows: pageSize,
      tableFilters: filters,
      tableSortField: sortField,
      tableSortOrder: sortOrder,
      globalSearchValue: globalFilterValue,
      subtypeFilter,
    })
  }, [token, fetchMovimientos, filters, globalFilterValue, pageSize, sortField, sortOrder, subtypeFilter])

  useEffect(() => {
    setSalidaCatalogsPreloaded(false)
    setPrefetchedTipoMovimientos([])
    setPrefetchedSubTiposSalida([])
  }, [token])

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
    devolucion: hasSearchApplied ? 'No se encontraron devoluciones.' : 'No hay devoluciones registradas.',
    traslado: hasSearchApplied ? 'No se encontraron traslados.' : 'No hay traslados registrados.',
  }
  const emptyMessage = emptyMessageByFilter[subtypeFilter] || emptyMessageByFilter.all

  const refreshData = useCallback(
    (options = {}) =>
      fetchMovimientos({
        page: options?.page ?? currentPage,
        rows: options?.rows ?? pageSize,
        tableFilters: options?.tableFilters ?? filters,
        tableSortField: options?.tableSortField ?? sortField,
        tableSortOrder: options?.tableSortOrder ?? sortOrder,
        globalSearchValue: Object.prototype.hasOwnProperty.call(options, 'globalSearchValue')
          ? options?.globalSearchValue
          : globalFilterValue,
        subtypeFilter: options?.subtypeFilter ?? subtypeFilter,
      }),
    [currentPage, fetchMovimientos, filters, globalFilterValue, pageSize, sortField, sortOrder, subtypeFilter]
  )

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

  const handleTableFilterChange = (event) => {
    const nextFilters = event?.filters || createInitialFilters()
    const nextGlobalValue = nextFilters?.global?.value || ''
    setFilters(nextFilters)
    setGlobalFilterValue(nextGlobalValue)

    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
      globalSearchDebounceRef.current = null
    }

    refreshData({
      page: 1,
      tableFilters: nextFilters,
      globalSearchValue: nextGlobalValue,
    })
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

  const cellWithTooltip = (rowData, field) => {
    const content = rowData?.[field] ?? '-'
    const textColor = content === '-' ? '#9ca3af' : undefined
    return (
      <span className="cell-tooltip" data-pr-tooltip={String(content)} style={{ color: textColor }}>
        {String(content)}
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

  const columnClassName = (field) => {
    if (field === 'fecha' || field === 'total' || field === 'funcional_label') {
      return 'column-max-min-width--small'
    }
    return 'column-max-min-width'
  }

  const handleRowClick = (event) => {
    const target = event?.originalEvent?.target
    if (target?.closest?.('.p-checkbox') || target?.closest?.('.row-selection-column')) return

    const id = event?.data?.id
    if (id == null) return
    setSelectedId(id)
    setShowDetailsModal(true)
  }

  const handleCreated = () => {
    setShowCreateModal(false)
    setSelectedRows([])
    refreshData({ page: 1 })
    toast.current?.show({ severity: 'success', summary: 'Exito', detail: 'Salida creada correctamente', life: 2500 })
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
    try {
      await preloadSalidaCatalogs()
    } catch {
      // Si falla la precarga, el modal se abre y carga sus catalogos como respaldo.
    }
    setShowCreateModal(true)
  }

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
      </div>
    </div>
  )

  return (
    <div className="users-page">
      <Tooltip position="top" showDelay={1800} target=".cell-tooltip" style={{ maxWidth: '340px' }} />
      <Toast ref={toast} />

      <div className="users-page__top">
        <div className="users-page__actions">
          <Button label="Crear" icon="pi pi-plus" className="users-topbtn users-topbtn--create" onClick={handleOpenCreateModal} type="button" />
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

      <div className="users-table users-table--card">
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
          resizableColumns
          columnResizeMode="fit"
          filters={filters}
          onFilter={handleTableFilterChange}
          globalFilterFields={[
            'no_documento',
            'fecha',
            'sucursal_nombre',
            'sub_tipo_nombre',
            'sucursal_objetivo_nombre',
            'estado_nombre',
            'total',
            'funcional_label',
          ]}
          onRowClick={handleRowClick}
          rowClassName={(rowData) => (selectedRowIds.includes(normId(rowData?.id)) ? 'selected-row-shadow' : '')}
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
          />

          <Column
            field="no_documento"
            header="Documento"
            body={(rowData) => cellWithTooltip(rowData, 'no_documento')}
            sortable
            filter
            className={columnClassName('no_documento')}
          />
          <Column
            field="fecha"
            header="Fecha"
            body={(rowData) => cellWithTooltip(rowData, 'fecha')}
            sortable
            filter
            className={columnClassName('fecha')}
          />
          <Column
            field="sucursal_nombre"
            header="Sucursal"
            body={(rowData) => cellWithTooltip(rowData, 'sucursal_nombre')}
            sortable
            filter
            className={columnClassName('sucursal_nombre')}
          />
          <Column
            field="sub_tipo_nombre"
            header="Tipo"
            body={(rowData) => cellWithTooltip(rowData, 'sub_tipo_nombre')}
            sortable
            filter
            className={columnClassName('sub_tipo_nombre')}
          />
          <Column
            field="sucursal_objetivo_nombre"
            header="Destino"
            body={(rowData) => cellWithTooltip(rowData, 'sucursal_objetivo_nombre')}
            sortable
            filter
            className={columnClassName('sucursal_objetivo_nombre')}
          />
          <Column
            field="estado_nombre"
            header="Estado"
            body={(rowData) => cellWithTooltip(rowData, 'estado_nombre')}
            sortable
            filter
            className={columnClassName('estado_nombre')}
          />
          <Column field="total" header="Total" body={totalBodyTemplate} sortable filter className={columnClassName('total')} />
          <Column
            field="funcional_label"
            header="Funcional"
            body={(rowData) => cellWithTooltip(rowData, 'funcional_label')}
            sortable
            filter
            className={columnClassName('funcional_label')}
          />
        </DataTable>
      </div>

      <CreateSalida
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleCreated}
        token={token}
        onError={showErrorToast}
        preloadedTipoMovimientos={prefetchedTipoMovimientos}
        preloadedSubTipos={prefetchedSubTiposSalida}
      />

      <SalidaDetails
        open={showDetailsModal}
        salidaId={selectedId}
        onClose={() => setShowDetailsModal(false)}
        token={token}
        onUpdated={handleUpdated}
        onDeleted={handleDeleted}
        onError={showErrorToast}
      />
    </div>
  )
}

export default SalidasTable
