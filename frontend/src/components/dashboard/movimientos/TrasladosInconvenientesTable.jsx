import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FilterMatchMode } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { OverlayPanel } from 'primereact/overlaypanel'
import { Checkbox } from 'primereact/checkbox'
import { Button } from 'primereact/button'
import { Loader2 } from 'lucide-react'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDateTime } from '../../../utils/dateFormat'
import { fetchRemindersFromBackend } from '../common/reminders/remindersStorage'
import { tableLayoutStore } from '../../../utils/tableLayoutStore'
import { autoFitTableColumns, makeWidthStateHandlers } from '../../../utils/autoFitColumns'
import { buildFileName, exportToExcel, exportToPdf } from '../../../utils/exportUtils'
import useModalAnimation from '../common/useModalAnimation'
import '../admin/CreateUsuario/CreateUsuario.css'
import '../admin/UsersTable/UsersTable.css'
import './CreateSalida.css'
import './TrasladosInconvenientesTable.css'
import StaticFieldDisplay from './StaticFieldDisplay'

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeId = (value) => (value == null ? '' : String(value).trim())
const normalizeValue = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
const formatSubdivisionLocationLabel = (subdivision) => {
  const bodega = String(subdivision?.division?.bodega?.nombre || '').trim()
  const division = String(subdivision?.division?.nombre || '').trim()
  const sub = String(subdivision?.nombre || '').trim()
  return [bodega, division, sub].filter(Boolean).join(' / ')
}
const formatDivisionLocationLabel = (division) => {
  const bodega = String(division?.bodega?.nombre || '').trim()
  const divisionName = String(division?.nombre || '').trim()
  return [bodega, divisionName].filter(Boolean).join(' / ')
}
const formatBodegaLocationLabel = (bodega) => String(bodega?.nombre || '').trim()
const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const STATUS_FILTERS = [
  { key: 'all', label: 'Todos' },
  { key: 'pendiente', label: 'Pendientes' },
  { key: 'resuelto', label: 'Resueltos' },
  { key: 'perdido', label: 'Perdidos' },
]

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

const formatEstado = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'pendiente') return 'Pendiente'
  if (normalized === 'resuelto') return 'Resuelto'
  if (normalized === 'perdido') return 'Perdido'
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : '-'
}

const formatResolucion = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'sumar_solicitante') return 'Sumado a sucursal destino'
  if (normalized === 'sumar_proveedora') return 'Sumado a sucursal proveedora'
  if (normalized === 'perdido') return 'Marcado como desaparecido'
  if (normalized === 'restar_proveedora') return 'Restado de sucursal proveedora'
  if (normalized === 'sin_cambios') return 'Sin cambios de inventario'
  if (normalized === 'reportado_proveedor') return 'Reportado al proveedor'
  if (normalized === 'aceptado') return 'Aceptado sin cambios'
  return '-'
}

const formatHistorialAccion = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'detectado') return 'Detectado'
  if (normalized === 'sumado_a_sucursal') return 'Sumado a sucursal'
  if (normalized === 'marcado_como_perdido') return 'Marcado como desaparecido'
  if (normalized === 'restado_de_proveedora') return 'Restado de proveedora'
  if (normalized === 'sin_cambios') return 'Sin cambios'
  if (normalized === 'reportado_a_proveedor') return 'Reportado a proveedor'
  if (normalized === 'aceptado_sin_cambios') return 'Aceptado sin cambios'
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : '-'
}

const createInitialFilters = () => ({
  global: { value: null, matchMode: FilterMatchMode.CONTAINS },
})

const selectionColStyle = {
  textAlign: 'center',
  padding: 0,
}

function TrasladosInconvenientesTable({ token, moduleActions, pendingOpenSolicitudId, onPendingOpenHandled }) {
  const toast = useRef(null)
  const opColumns = useRef(null)
  const tableWrapperRef = useRef(null)
  const widthHandlers = useMemo(() => makeWidthStateHandlers('traslados-inconvenientes-table-state-v2'), [])
  const [tableResetKey, setTableResetKey] = useState(0)
  const quickSearchInputRef = useRef(null)
  const clickTimerRef = useRef(null)
  const pendingClickRowRef = useRef(null)
  const pendingClickCountRef = useRef(0)

  const canRead = moduleActions?.puede_leer ?? true
  const canUpdate = moduleActions?.puede_actualizar ?? true

  const columnsData = useMemo(
    () => [
      { nombrevar: 'origen_label', header: 'Origen', filterPlaceholder: 'Buscar por origen' },
      { nombrevar: 'solicitud_no_documento', header: 'Documento', filterPlaceholder: 'Buscar por documento' },
      { nombrevar: 'producto_nombre', header: 'Descripción', filterPlaceholder: 'Buscar por producto' },
      { nombrevar: 'producto_codigo', header: 'Código', filterPlaceholder: 'Buscar por codigo' },
      { nombrevar: 'cantidad_faltante', header: 'Faltante', filterPlaceholder: 'Buscar por faltante' },
      { nombrevar: 'sucursal_proveedora', header: 'Sucursal proveedora', filterPlaceholder: 'Buscar por proveedora' },
      { nombrevar: 'sucursal_solicitante', header: 'Sucursal destino', filterPlaceholder: 'Buscar por destino' },
      { nombrevar: 'estado_label', header: 'Estado', filterPlaceholder: 'Buscar por estado' },
      { nombrevar: 'resolucion_label', header: 'Resolucion', filterPlaceholder: 'Buscar por resolucion' },
      { nombrevar: 'created_at_label', header: 'Creado', filterPlaceholder: 'Buscar por fecha' },
    ],
    []
  )

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('pendiente')
  const [filters, setFilters] = useState(() => createInitialFilters())
  const [globalFilterValue, setGlobalFilterValue] = useState('')
  const [selectedColumns, setSelectedColumns] = useState(columnsData)
  const selectedColumnsRef = useRef(selectedColumns)
  const [processedRows, setProcessedRows] = useState(null)
  const [selectedRows, setSelectedRows] = useState([])

  const [selectedIssue, setSelectedIssue] = useState(null)
  const [showDetailsModal, setShowDetailsModal] = useState(false)
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })
  const [isMaximized, setIsMaximized] = useState(false)
  const [isResizingModal, setIsResizingModal] = useState(false)
  const [resolverDecision, setResolverDecision] = useState('')
  const [resolverMotivo, setResolverMotivo] = useState('')
  const [resolverBodegaId, setResolverBodegaId] = useState('')
  const [resolverDivisionId, setResolverDivisionId] = useState('')
  const [resolverSubdivisionId, setResolverSubdivisionId] = useState('')
  const [resolverSubdivisions, setResolverSubdivisions] = useState([])
  const [resolverSubdivisionsLoading, setResolverSubdivisionsLoading] = useState(false)
  const [resolverNeedsManualLocation, setResolverNeedsManualLocation] = useState(false)
  const [resolverLocationDropdownField, setResolverLocationDropdownField] = useState('')
  const [resolverLocationDropdownDirection, setResolverLocationDropdownDirection] = useState('down')
  const [resolverLocationDropdownMaxHeight, setResolverLocationDropdownMaxHeight] = useState(null)
  const [resolverLocationQuery, setResolverLocationQuery] = useState('')
  const [resolverLocationDebouncedQuery, setResolverLocationDebouncedQuery] = useState('')
  const [resolverSubmitting, setResolverSubmitting] = useState(false)
  const [resolverError, setResolverError] = useState('')
  const [resolverProvBodegaId, setResolverProvBodegaId] = useState('')
  const [resolverProvDivisionId, setResolverProvDivisionId] = useState('')
  const [resolverProvSubdivisionId, setResolverProvSubdivisionId] = useState('')
  const [resolverProvSubdivisions, setResolverProvSubdivisions] = useState([])
  const [resolverProvSubdivisionsLoading, setResolverProvSubdivisionsLoading] = useState(false)
  const [resolverProvNeedsManualLocation, setResolverProvNeedsManualLocation] = useState(false)
  const [resolverProvLocationDropdownField, setResolverProvLocationDropdownField] = useState('')
  const [resolverProvLocationDropdownDirection, setResolverProvLocationDropdownDirection] = useState('down')
  const [resolverProvLocationDropdownMaxHeight, setResolverProvLocationDropdownMaxHeight] = useState(null)
  const [resolverProvLocationQuery, setResolverProvLocationQuery] = useState('')
  const [resolverProvLocationDebouncedQuery, setResolverProvLocationDebouncedQuery] = useState('')
  const modalRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalResize = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const modalSizeRef = useRef(modalSize)
  const modalPositionRef = useRef(modalPosition)
  const modalRestoreRef = useRef(null)
  const resolverLocationDropdownRef = useRef(null)
  const resolverProvLocationDropdownRef = useRef(null)

  const { shouldRender: shouldRenderDetailsModal, isClosing: isClosingDetailsModal } =
    useModalAnimation(showDetailsModal)

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
        life: 3000,
      }),
    []
  )

  const showWarningToast = useCallback(
    (detail, summary = 'Aviso') =>
      toast.current?.show({
        severity: 'warn',
        summary,
        detail,
        life: 2800,
      }),
    []
  )

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
  const getViewportMetrics = useCallback(() => {
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    return {
      availableWidth,
      availableHeight,
      minWidth: Math.min(MIN_WIDTH, availableWidth),
      minHeight: Math.min(MIN_HEIGHT, availableHeight),
    }
  }, [])

  const normalizeRows = useCallback(
    (list) =>
      list.map((row, index) => {
        const rowId = normalizeId(row?.id)
        const state = String(row?.estado || '').trim().toLowerCase()
        const productCode = String(row?.producto_codigo || '').trim()
        const productName = String(row?.producto_nombre || '').trim() || 'Producto sin descripción'
        const reason = String(row?.motivo || '').trim()
        const missingQty = Number.parseInt(String(row?.cantidad_faltante || 0), 10) || 0
        const keyFallback = `${normalizeId(row?.solicitud_id)}-${normalizeId(row?.producto_id)}-${index}`
        return {
          ...row,
          origen: 'traslado',
          origen_label: 'Traslado',
          row_key: rowId ? `traslado-${rowId}` : keyFallback,
          estado_key: state || 'pendiente',
          estado_label: formatEstado(row?.estado),
          resolucion_label: formatResolucion(row?.resolucion),
          created_at_label: formatDateTime(row?.created_at),
          producto_codigo: productCode || `Producto ${normalizeId(row?.producto_id) || '-'}`,
          producto_nombre: productName,
          producto_resumen: reason ? `${productCode || productName} | Novedad: ${reason}` : (productCode || productName),
          cantidad_faltante: missingQty,
          sucursal_proveedora: String(row?.sucursal_proveedora || '-').trim() || '-',
          sucursal_solicitante: String(row?.sucursal_solicitante || '-').trim() || '-',
          solicitud_no_documento: String(row?.solicitud_no_documento || row?.solicitud_id || '-').trim() || '-',
        }
      }),
    []
  )

  const normalizeImportacionRows = useCallback(
    (list) =>
      list.map((row, index) => {
        const rowId = normalizeId(row?.id)
        const state = String(row?.estado || '').trim().toLowerCase()
        const productCode = String(row?.producto_codigo || '').trim()
        const productName = String(row?.producto_nombre || '').trim() || 'Producto sin descripción'
        const reason = String(row?.motivo || '').trim()
        const diffQty = Number.parseInt(String(row?.cantidad_diferencia || 0), 10) || 0
        const keyFallback = `importacion-${normalizeId(row?.importacion_id)}-${normalizeId(row?.producto_id)}-${index}`
        return {
          ...row,
          origen: 'importacion',
          origen_label: 'Importación',
          row_key: rowId ? `importacion-${rowId}` : keyFallback,
          estado_key: state || 'pendiente',
          estado_label: formatEstado(row?.estado),
          resolucion_label: formatResolucion(row?.resolucion),
          created_at_label: formatDateTime(row?.created_at),
          producto_codigo: productCode || `Producto ${normalizeId(row?.producto_id) || '-'}`,
          producto_nombre: productName,
          producto_resumen: reason ? `${productCode || productName} | Novedad: ${reason}` : (productCode || productName),
          cantidad_faltante: diffQty,
          sucursal_proveedora: String(row?.casa_comercial_nombre || '-').trim() || '-',
          sucursal_solicitante: '-',
          solicitud_no_documento: String(row?.importacion_codigo || row?.importacion_id || '-').trim() || '-',
        }
      }),
    []
  )

  const fetchRows = useCallback(
    async (options = {}) => {
      const withOverlay = options?.withOverlay !== false
      if (!token || !canRead) {
        setRows([])
        setSelectedRows([])
        return []
      }

      if (withOverlay) {
        setLoading(true)
      } else {
        setIsRefreshing(true)
      }
      setError(null)

      try {
        const endpoint = new URL(`${API_URL}/movimientos/movimiento_inventario/traslados-inconvenientes/`)
        if (statusFilter && statusFilter !== 'all') {
          endpoint.searchParams.set('estado', statusFilter)
        }
        const importacionEndpoint = new URL(`${API_URL}/importaciones/importaciones/inconvenientes/`)
        if (statusFilter && statusFilter !== 'all') {
          importacionEndpoint.searchParams.set('estado', statusFilter)
        }

        const [response, importacionResponse] = await Promise.all([
          authFetch(endpoint.toString(), {}, token),
          authFetch(importacionEndpoint.toString(), {}, token),
        ])
        if (!response.ok) {
          throw new Error('No se pudieron cargar los inconvenientes de traslado.')
        }

        const payload = await response.json().catch(() => [])
        const traslados = normalizeRows(parseApiList(payload))

        let importaciones = []
        if (importacionResponse.ok) {
          const importacionPayload = await importacionResponse.json().catch(() => [])
          importaciones = normalizeImportacionRows(parseApiList(importacionPayload))
        }

        const parsed = [...traslados, ...importaciones].sort(
          (a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime()
        )
        setRows(parsed)
        return parsed
      } catch (requestError) {
        const message = requestError?.message || 'No se pudieron cargar los inconvenientes de traslado.'
        setRows([])
        setError(message)
        showErrorToast(message)
        return []
      } finally {
        setLoading(false)
        setIsRefreshing(false)
      }
    },
    [canRead, normalizeRows, normalizeImportacionRows, showErrorToast, statusFilter, token]
  )

  useEffect(() => {
    void fetchRows()
  }, [fetchRows])

  useEffect(() => {
    selectedColumnsRef.current = selectedColumns
  }, [selectedColumns])

  useEffect(() => {
    const stored = tableLayoutStore.getItem('traslados-inconvenientes-table-columns')
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length) {
          setSelectedColumns(parsed)
        }
      } catch {
        tableLayoutStore.removeItem('traslados-inconvenientes-table-columns')
      }
    }
    return () => {
      tableLayoutStore.setItem('traslados-inconvenientes-table-columns', JSON.stringify(selectedColumnsRef.current))
    }
  }, [])

  useEffect(() => {
    setSelectedColumns((prev) => {
      if (!prev?.length) return columnsData
      const currentKeys = new Set(prev.map((column) => column?.nombrevar))
      const merged = columnsData.filter((column) => currentKeys.has(column.nombrevar))
      columnsData.forEach((column) => {
        if (!merged.some((item) => item.nombrevar === column.nombrevar)) {
          merged.push(column)
        }
      })
      return merged
    })
  }, [columnsData])

  const selectedRowIds = useMemo(
    () => new Set((selectedRows || []).map((row) => row?.row_key).filter(Boolean)),
    [selectedRows]
  )

  const resolverTargetBranchId = useMemo(() => {
    if (!selectedIssue) return ''
    if (resolverDecision === 'sumar_solicitante' || resolverDecision === 'devolver_proveedora') return normalizeId(selectedIssue?.sucursal_solicitante_id)
    if (resolverDecision === 'sumar_proveedora' || resolverDecision === 'restar_proveedora') return normalizeId(selectedIssue?.sucursal_proveedora_id)
    return ''
  }, [resolverDecision, selectedIssue])

  const resolverTargetBranchLabel = useMemo(() => {
    if (!selectedIssue) return ''
    if (resolverDecision === 'sumar_solicitante' || resolverDecision === 'devolver_proveedora') {
      return String(selectedIssue?.sucursal_solicitante || '').trim() || 'Sucursal destino'
    }
    if (resolverDecision === 'sumar_proveedora' || resolverDecision === 'restar_proveedora') {
      return String(selectedIssue?.sucursal_proveedora || '').trim() || 'Sucursal proveedora'
    }
    return ''
  }, [resolverDecision, selectedIssue])

  const resolverSubdivisionPathById = useMemo(() => {
    const map = new Map()
    resolverSubdivisions.forEach((subdivision) => {
      const subdivisionId = normalizeId(subdivision?.id)
      const division = subdivision?.division
      const divisionId = normalizeId(division?.id)
      const bodega = division?.bodega
      const bodegaId = normalizeId(bodega?.id)
      if (!subdivisionId || !divisionId || !bodegaId) return
      map.set(subdivisionId, { subdivisionId, divisionId, bodegaId })
    })
    return map
  }, [resolverSubdivisions])

  const resolverBodegas = useMemo(() => {
    const map = new Map()
    resolverSubdivisions.forEach((subdivision) => {
      const bodega = subdivision?.division?.bodega
      const bodegaId = normalizeId(bodega?.id)
      if (!bodegaId || map.has(bodegaId)) return
      map.set(bodegaId, { ...bodega, id: bodegaId })
    })
    return Array.from(map.values()).sort((a, b) =>
      String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es', { sensitivity: 'base' })
    )
  }, [resolverSubdivisions])

  const resolverDivisionsByBodega = useMemo(() => {
    const map = new Map()
    resolverSubdivisions.forEach((subdivision) => {
      const division = subdivision?.division
      const divisionId = normalizeId(division?.id)
      const bodega = division?.bodega
      const bodegaId = normalizeId(bodega?.id)
      if (!divisionId || !bodegaId) return
      if (!map.has(bodegaId)) map.set(bodegaId, new Map())
      const divisionsMap = map.get(bodegaId)
      if (divisionsMap.has(divisionId)) return
      divisionsMap.set(divisionId, {
        ...division,
        id: divisionId,
        bodega: { ...bodega, id: bodegaId },
      })
    })

    const grouped = new Map()
    map.forEach((divisionsMap, bodegaId) => {
      grouped.set(
        bodegaId,
        Array.from(divisionsMap.values()).sort((a, b) =>
          String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es', { sensitivity: 'base' })
        )
      )
    })
    return grouped
  }, [resolverSubdivisions])

  const resolverSubdivisionsByDivision = useMemo(() => {
    const map = new Map()
    resolverSubdivisions.forEach((subdivision) => {
      const divisionId = normalizeId(subdivision?.division?.id)
      const subdivisionId = normalizeId(subdivision?.id)
      if (!divisionId || !subdivisionId) return
      if (!map.has(divisionId)) map.set(divisionId, new Map())
      const subdivisionsMap = map.get(divisionId)
      if (subdivisionsMap.has(subdivisionId)) return
      subdivisionsMap.set(subdivisionId, {
        ...subdivision,
        id: subdivisionId,
      })
    })

    const grouped = new Map()
    map.forEach((subdivisionsMap, divisionId) => {
      grouped.set(
        divisionId,
        Array.from(subdivisionsMap.values()).sort((a, b) =>
          String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es', { sensitivity: 'base' })
        )
      )
    })
    return grouped
  }, [resolverSubdivisions])

  const resolverDivisionOptions = useMemo(
    () => resolverDivisionsByBodega.get(resolverBodegaId) || [],
    [resolverBodegaId, resolverDivisionsByBodega]
  )
  const resolverSubdivisionOptions = useMemo(
    () => resolverSubdivisionsByDivision.get(resolverDivisionId) || [],
    [resolverDivisionId, resolverSubdivisionsByDivision]
  )
  const selectedResolverBodega = useMemo(
    () => resolverBodegas.find((item) => normalizeId(item?.id) === resolverBodegaId) || null,
    [resolverBodegaId, resolverBodegas]
  )
  const selectedResolverDivision = useMemo(
    () => resolverDivisionOptions.find((item) => normalizeId(item?.id) === resolverDivisionId) || null,
    [resolverDivisionId, resolverDivisionOptions]
  )
  const selectedResolverSubdivision = useMemo(
    () => resolverSubdivisionOptions.find((item) => normalizeId(item?.id) === resolverSubdivisionId) || null,
    [resolverSubdivisionId, resolverSubdivisionOptions]
  )

  const filterResolverLocationOptions = useCallback(
    (options, getSearchLabel) => {
      const term = String(resolverLocationDebouncedQuery || '').trim()
      if (!term) return options
      return (Array.isArray(options) ? options : []).filter((option) =>
        normalizeValue(String(getSearchLabel?.(option) || '')).includes(term)
      )
    },
    [resolverLocationDebouncedQuery]
  )

  const resolverProvSubdivisionPathById = useMemo(() => {
    const map = new Map()
    resolverProvSubdivisions.forEach((subdivision) => {
      const subdivisionId = normalizeId(subdivision?.id)
      const division = subdivision?.division
      const divisionId = normalizeId(division?.id)
      const bodega = division?.bodega
      const bodegaId = normalizeId(bodega?.id)
      if (!subdivisionId || !divisionId || !bodegaId) return
      map.set(subdivisionId, { subdivisionId, divisionId, bodegaId })
    })
    return map
  }, [resolverProvSubdivisions])

  const resolverProvBodegas = useMemo(() => {
    const map = new Map()
    resolverProvSubdivisions.forEach((subdivision) => {
      const bodega = subdivision?.division?.bodega
      const bodegaId = normalizeId(bodega?.id)
      if (!bodegaId || map.has(bodegaId)) return
      map.set(bodegaId, { ...bodega, id: bodegaId })
    })
    return Array.from(map.values()).sort((a, b) =>
      String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es', { sensitivity: 'base' })
    )
  }, [resolverProvSubdivisions])

  const resolverProvDivisionsByBodega = useMemo(() => {
    const map = new Map()
    resolverProvSubdivisions.forEach((subdivision) => {
      const division = subdivision?.division
      const divisionId = normalizeId(division?.id)
      const bodega = division?.bodega
      const bodegaId = normalizeId(bodega?.id)
      if (!divisionId || !bodegaId) return
      if (!map.has(bodegaId)) map.set(bodegaId, new Map())
      const divisionsMap = map.get(bodegaId)
      if (divisionsMap.has(divisionId)) return
      divisionsMap.set(divisionId, { ...division, id: divisionId, bodega: { ...bodega, id: bodegaId } })
    })
    const grouped = new Map()
    map.forEach((divisionsMap, bodegaId) => {
      grouped.set(
        bodegaId,
        Array.from(divisionsMap.values()).sort((a, b) =>
          String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es', { sensitivity: 'base' })
        )
      )
    })
    return grouped
  }, [resolverProvSubdivisions])

  const resolverProvSubdivisionsByDivision = useMemo(() => {
    const map = new Map()
    resolverProvSubdivisions.forEach((subdivision) => {
      const divisionId = normalizeId(subdivision?.division?.id)
      const subdivisionId = normalizeId(subdivision?.id)
      if (!divisionId || !subdivisionId) return
      if (!map.has(divisionId)) map.set(divisionId, new Map())
      const subdivisionsMap = map.get(divisionId)
      if (subdivisionsMap.has(subdivisionId)) return
      subdivisionsMap.set(subdivisionId, { ...subdivision, id: subdivisionId })
    })
    const grouped = new Map()
    map.forEach((subdivisionsMap, divisionId) => {
      grouped.set(
        divisionId,
        Array.from(subdivisionsMap.values()).sort((a, b) =>
          String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es', { sensitivity: 'base' })
        )
      )
    })
    return grouped
  }, [resolverProvSubdivisions])

  const resolverProvDivisionOptions = useMemo(
    () => resolverProvDivisionsByBodega.get(resolverProvBodegaId) || [],
    [resolverProvBodegaId, resolverProvDivisionsByBodega]
  )
  const resolverProvSubdivisionOptions = useMemo(
    () => resolverProvSubdivisionsByDivision.get(resolverProvDivisionId) || [],
    [resolverProvDivisionId, resolverProvSubdivisionsByDivision]
  )
  const selectedResolverProvBodega = useMemo(
    () => resolverProvBodegas.find((item) => normalizeId(item?.id) === resolverProvBodegaId) || null,
    [resolverProvBodegaId, resolverProvBodegas]
  )
  const selectedResolverProvDivision = useMemo(
    () => resolverProvDivisionOptions.find((item) => normalizeId(item?.id) === resolverProvDivisionId) || null,
    [resolverProvDivisionId, resolverProvDivisionOptions]
  )
  const selectedResolverProvSubdivision = useMemo(
    () => resolverProvSubdivisionOptions.find((item) => normalizeId(item?.id) === resolverProvSubdivisionId) || null,
    [resolverProvSubdivisionId, resolverProvSubdivisionOptions]
  )

  const filterResolverProvLocationOptions = useCallback(
    (options, getSearchLabel) => {
      const term = String(resolverProvLocationDebouncedQuery || '').trim()
      if (!term) return options
      return (Array.isArray(options) ? options : []).filter((option) =>
        normalizeValue(String(getSearchLabel?.(option) || '')).includes(term)
      )
    },
    [resolverProvLocationDebouncedQuery]
  )

  useEffect(() => {
    if (!showDetailsModal || !token || !resolverTargetBranchId) {
      setResolverSubdivisions([])
      setResolverBodegaId('')
      setResolverDivisionId('')
      setResolverSubdivisionId('')
      setResolverNeedsManualLocation(false)
      setResolverLocationDropdownField('')
      setResolverLocationDropdownDirection('down')
      setResolverLocationDropdownMaxHeight(null)
      setResolverLocationQuery('')
      setResolverLocationDebouncedQuery('')
      return
    }

    let cancelled = false
    const loadSubdivisions = async () => {
      setResolverSubdivisionsLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/inventario/subdivisiones/?page_size=500&sucursal_id=${encodeURIComponent(
            resolverTargetBranchId
          )}&modulo=movimientos_inconvenientes`,
          {},
          token
        )
        if (!response.ok) {
          throw new Error('No se pudieron cargar las subdivisiones de la sucursal seleccionada.')
        }
        const payload = await response.json().catch(() => ({}))
        if (cancelled) return
        const parsed = parseApiList(payload)
        const subdivisionPathById = new Map()
        parsed.forEach((subdivision) => {
          const subdivisionId = normalizeId(subdivision?.id)
          const divisionId = normalizeId(subdivision?.division?.id)
          const bodegaId = normalizeId(subdivision?.division?.bodega?.id)
          if (!subdivisionId || !divisionId || !bodegaId) return
          subdivisionPathById.set(subdivisionId, { bodegaId, divisionId, subdivisionId })
        })
        const availableSubdivisionIds = new Set(parsed.map((item) => normalizeId(item?.id)).filter(Boolean))

        let preferredSubdivisionId = ''
        const selectedProductId = Number.parseInt(String(selectedIssue?.producto_id || 0), 10)
        if (selectedProductId > 0) {
          try {
            const inventoryResponse = await authFetch(
              `${API_URL}/inventario/inventario/?page_size=400&producto_ids=${encodeURIComponent(
                String(selectedProductId)
              )}`,
              {},
              token
            )
            if (inventoryResponse.ok) {
              const inventoryPayload = await inventoryResponse.json().catch(() => ({}))
              const inventoryRows = parseApiList(inventoryPayload)
              const branchKey = normalizeId(resolverTargetBranchId)
              const preferred = inventoryRows
                .map((row) => {
                  const rowBranchId = normalizeId(
                    row?.subdivision?.division?.bodega?.sucursal?.id ??
                      row?.subdivision?.division?.bodega?.sucursal_id
                  )
                  if (rowBranchId !== branchKey) return null
                  const subdivisionId = normalizeId(row?.subdivision?.id ?? row?.subdivision_id)
                  if (!subdivisionId) return null
                  const qty = Number.parseFloat(String(row?.cantidad ?? 0))
                  return {
                    subdivisionId,
                    qty: Number.isFinite(qty) ? qty : 0,
                  }
                })
                .filter(Boolean)
                .sort((a, b) => b.qty - a.qty)
              preferredSubdivisionId = normalizeId(preferred?.[0]?.subdivisionId)
            }
          } catch {
            preferredSubdivisionId = ''
          }
        }

        const preferredValid = preferredSubdivisionId && availableSubdivisionIds.has(preferredSubdivisionId)
        const nextSubdivisionId = preferredValid ? preferredSubdivisionId : ''
        const nextPath = subdivisionPathById.get(nextSubdivisionId) || null
        setResolverSubdivisions(parsed)
        setResolverBodegaId(nextPath?.bodegaId || '')
        setResolverDivisionId(nextPath?.divisionId || '')
        setResolverNeedsManualLocation(!preferredValid)
        setResolverSubdivisionId(nextSubdivisionId)
      } catch (requestError) {
        if (cancelled) return
        const message = requestError?.message || 'No se pudieron cargar las subdivisiones.'
        setResolverSubdivisions([])
        setResolverBodegaId('')
        setResolverDivisionId('')
        setResolverSubdivisionId('')
        setResolverNeedsManualLocation(false)
        showErrorToast(message)
      } finally {
        if (!cancelled) setResolverSubdivisionsLoading(false)
      }
    }

    void loadSubdivisions()
    return () => {
      cancelled = true
    }
  }, [resolverTargetBranchId, selectedIssue?.producto_id, showDetailsModal, showErrorToast, token])

  const resolverProvTargetBranchId = useMemo(() => {
    if (!selectedIssue || resolverDecision !== 'devolver_proveedora') return ''
    return normalizeId(selectedIssue?.sucursal_proveedora_id)
  }, [resolverDecision, selectedIssue])

  useEffect(() => {
    if (!showDetailsModal || !token || !resolverProvTargetBranchId) {
      setResolverProvSubdivisions([])
      setResolverProvBodegaId('')
      setResolverProvDivisionId('')
      setResolverProvSubdivisionId('')
      setResolverProvNeedsManualLocation(false)
      setResolverProvLocationDropdownField('')
      setResolverProvLocationDropdownDirection('down')
      setResolverProvLocationDropdownMaxHeight(null)
      setResolverProvLocationQuery('')
      setResolverProvLocationDebouncedQuery('')
      return
    }

    let cancelled = false
    const loadProvSubdivisions = async () => {
      setResolverProvSubdivisionsLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/inventario/subdivisiones/?page_size=500&sucursal_id=${encodeURIComponent(
            resolverProvTargetBranchId
          )}&modulo=movimientos_inconvenientes`,
          {},
          token
        )
        if (!response.ok) {
          throw new Error('No se pudieron cargar las subdivisiones de la sucursal proveedora.')
        }
        const payload = await response.json().catch(() => ({}))
        if (cancelled) return
        const parsed = parseApiList(payload)
        const subdivisionPathById = new Map()
        parsed.forEach((subdivision) => {
          const subdivisionId = normalizeId(subdivision?.id)
          const divisionId = normalizeId(subdivision?.division?.id)
          const bodegaId = normalizeId(subdivision?.division?.bodega?.id)
          if (!subdivisionId || !divisionId || !bodegaId) return
          subdivisionPathById.set(subdivisionId, { bodegaId, divisionId, subdivisionId })
        })
        const availableSubdivisionIds = new Set(parsed.map((item) => normalizeId(item?.id)).filter(Boolean))

        let preferredSubdivisionId = ''
        const selectedProductId = Number.parseInt(String(selectedIssue?.producto_id || 0), 10)
        if (selectedProductId > 0) {
          try {
            const inventoryResponse = await authFetch(
              `${API_URL}/inventario/inventario/?page_size=400&producto_ids=${encodeURIComponent(
                String(selectedProductId)
              )}`,
              {},
              token
            )
            if (inventoryResponse.ok) {
              const inventoryPayload = await inventoryResponse.json().catch(() => ({}))
              const inventoryRows = parseApiList(inventoryPayload)
              const branchKey = normalizeId(resolverProvTargetBranchId)
              const preferred = inventoryRows
                .map((row) => {
                  const rowBranchId = normalizeId(
                    row?.subdivision?.division?.bodega?.sucursal?.id ??
                      row?.subdivision?.division?.bodega?.sucursal_id
                  )
                  if (rowBranchId !== branchKey) return null
                  const subdivisionId = normalizeId(row?.subdivision?.id ?? row?.subdivision_id)
                  if (!subdivisionId) return null
                  const qty = Number.parseFloat(String(row?.cantidad ?? 0))
                  return { subdivisionId, qty: Number.isFinite(qty) ? qty : 0 }
                })
                .filter(Boolean)
                .sort((a, b) => b.qty - a.qty)
              preferredSubdivisionId = normalizeId(preferred?.[0]?.subdivisionId)
            }
          } catch {
            preferredSubdivisionId = ''
          }
        }

        const preferredValid = preferredSubdivisionId && availableSubdivisionIds.has(preferredSubdivisionId)
        const nextSubdivisionId = preferredValid ? preferredSubdivisionId : ''
        const nextPath = subdivisionPathById.get(nextSubdivisionId) || null
        setResolverProvSubdivisions(parsed)
        setResolverProvBodegaId(nextPath?.bodegaId || '')
        setResolverProvDivisionId(nextPath?.divisionId || '')
        setResolverProvNeedsManualLocation(!preferredValid)
        setResolverProvSubdivisionId(nextSubdivisionId)
      } catch (requestError) {
        if (cancelled) return
        const message = requestError?.message || 'No se pudieron cargar las subdivisiones de la sucursal proveedora.'
        setResolverProvSubdivisions([])
        setResolverProvBodegaId('')
        setResolverProvDivisionId('')
        setResolverProvSubdivisionId('')
        setResolverProvNeedsManualLocation(false)
        showErrorToast(message)
      } finally {
        if (!cancelled) setResolverProvSubdivisionsLoading(false)
      }
    }

    void loadProvSubdivisions()
    return () => {
      cancelled = true
    }
  }, [resolverProvTargetBranchId, selectedIssue?.producto_id, showDetailsModal, showErrorToast, token])

  const resetResolverState = useCallback(() => {
    setResolverDecision('')
    setResolverMotivo('')
    setResolverBodegaId('')
    setResolverDivisionId('')
    setResolverSubdivisionId('')
    setResolverSubdivisions([])
    setResolverSubdivisionsLoading(false)
    setResolverNeedsManualLocation(false)
    setResolverLocationDropdownField('')
    setResolverLocationDropdownDirection('down')
    setResolverLocationDropdownMaxHeight(null)
    setResolverLocationQuery('')
    setResolverLocationDebouncedQuery('')
    setResolverSubmitting(false)
    setResolverError('')
    setResolverProvBodegaId('')
    setResolverProvDivisionId('')
    setResolverProvSubdivisionId('')
    setResolverProvSubdivisions([])
    setResolverProvSubdivisionsLoading(false)
    setResolverProvNeedsManualLocation(false)
    setResolverProvLocationDropdownField('')
    setResolverProvLocationDropdownDirection('down')
    setResolverProvLocationDropdownMaxHeight(null)
    setResolverProvLocationQuery('')
    setResolverProvLocationDebouncedQuery('')
  }, [])

  const openDetails = useCallback(
    (row) => {
      setSelectedIssue(row || null)
      setShowDetailsModal(true)
      setIsMaximized(false)
      setIsResizingModal(false)
      modalRestoreRef.current = null
      modalDrag.current.active = false
      modalResize.current.active = false
      resetResolverState()
    },
    [resetResolverState]
  )

  useEffect(() => {
    if (!pendingOpenSolicitudId || !rows.length) return
    const matches = rows.filter((r) => normalizeId(r.solicitud_id) === normalizeId(pendingOpenSolicitudId))
    if (!matches.length) return
    if (matches.length === 1) openDetails(matches[0])
    onPendingOpenHandled?.()
  }, [pendingOpenSolicitudId, rows, openDetails, onPendingOpenHandled])

  const ensureRowSelected = useCallback((rowData) => {
    if (!rowData) return
    const id = rowData?.row_key
    if (!id) return
    setSelectedRows((prev) => {
      const map = new Map((prev || []).map((row) => [row?.row_key, row]))
      map.set(id, rowData)
      return Array.from(map.values())
    })
  }, [])

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }
      pendingClickCountRef.current = 0
      pendingClickRowRef.current = null
    }
  }, [])

  const closeDetails = useCallback(() => {
    if (resolverSubmitting) return
    modalDrag.current.active = false
    modalResize.current.active = false
    setIsResizingModal(false)
    setResolverLocationDropdownField('')
    setResolverLocationDropdownDirection('down')
    setResolverLocationDropdownMaxHeight(null)
    setResolverLocationQuery('')
    setResolverLocationDebouncedQuery('')
    setResolverProvLocationDropdownField('')
    setResolverProvLocationDropdownDirection('down')
    setResolverProvLocationDropdownMaxHeight(null)
    setResolverProvLocationQuery('')
    setResolverProvLocationDebouncedQuery('')
    setShowDetailsModal(false)
  }, [resolverSubmitting])

  const closeResolverLocationDropdown = useCallback(() => {
    setResolverLocationDropdownField('')
    setResolverLocationDropdownDirection('down')
    setResolverLocationDropdownMaxHeight(null)
    setResolverLocationQuery('')
    setResolverLocationDebouncedQuery('')
  }, [])

  const updateResolverLocationDropdownPlacement = useCallback(() => {
    if (!showDetailsModal || !resolverLocationDropdownField || !resolverLocationDropdownRef.current) return
    const trigger = resolverLocationDropdownRef.current.querySelector('.create-user__dropdown-trigger')
    if (!trigger) return
    const triggerRect = trigger.getBoundingClientRect()
    const spacing = 10
    const availableBelow = Math.max(
      Math.floor(window.innerHeight - triggerRect.bottom - VIEWPORT_PADDING - spacing),
      0
    )
    const availableAbove = Math.max(
      Math.floor(triggerRect.top - VIEWPORT_PADDING - spacing),
      0
    )
    const nextDirection = availableBelow < 220 && availableAbove > availableBelow ? 'up' : 'down'
    const availableSpace = nextDirection === 'up' ? availableAbove : availableBelow
    const nextMaxHeight = Math.max(140, Math.min(320, availableSpace))
    setResolverLocationDropdownDirection((prev) => (prev === nextDirection ? prev : nextDirection))
    setResolverLocationDropdownMaxHeight((prev) => (prev === nextMaxHeight ? prev : nextMaxHeight))
  }, [resolverLocationDropdownField, showDetailsModal])

  const toggleResolverLocationDropdown = useCallback(
    (field) => {
      const nextField = String(field || '').trim().toLowerCase()
      if (!nextField) return
      setResolverLocationDropdownField((current) => (current === nextField ? '' : nextField))
      setResolverLocationDropdownDirection('down')
      setResolverLocationDropdownMaxHeight(null)
      setResolverLocationQuery('')
      setResolverLocationDebouncedQuery('')
      setTimeout(() => {
        updateResolverLocationDropdownPlacement()
      }, 0)
    },
    [updateResolverLocationDropdownPlacement]
  )

  useEffect(() => {
    if (!showDetailsModal || !resolverLocationDropdownField) {
      setResolverLocationDebouncedQuery('')
      return
    }
    const handle = setTimeout(() => {
      setResolverLocationDebouncedQuery(normalizeValue(resolverLocationQuery))
    }, 260)
    return () => clearTimeout(handle)
  }, [resolverLocationDropdownField, resolverLocationQuery, showDetailsModal])

  useEffect(() => {
    if (!showDetailsModal || !resolverLocationDropdownField) return undefined
    const handleClick = (event) => {
      if (resolverLocationDropdownRef.current && !resolverLocationDropdownRef.current.contains(event.target)) {
        closeResolverLocationDropdown()
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [closeResolverLocationDropdown, resolverLocationDropdownField, showDetailsModal])

  useEffect(() => {
    if (!showDetailsModal || !resolverLocationDropdownField) return undefined
    updateResolverLocationDropdownPlacement()
    const handleReposition = () => {
      updateResolverLocationDropdownPlacement()
    }
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [resolverLocationDropdownField, showDetailsModal, updateResolverLocationDropdownPlacement])

  const handleResolverLocationPick = useCallback(
    (field, optionId) => {
      const normalizedField = String(field || '').trim().toLowerCase()
      const normalizedOptionId = normalizeId(optionId)
      if (!normalizedField || !normalizedOptionId) return

      if (normalizedField === 'bodega') {
        setResolverBodegaId(normalizedOptionId)
        setResolverDivisionId('')
        setResolverSubdivisionId('')
        setResolverNeedsManualLocation(true)
        setResolverError('')
        closeResolverLocationDropdown()
        return
      }

      if (normalizedField === 'division') {
        if (!resolverBodegaId) return
        const isValidDivision = (resolverDivisionsByBodega.get(resolverBodegaId) || []).some(
          (division) => normalizeId(division?.id) === normalizedOptionId
        )
        if (!isValidDivision) return
        setResolverDivisionId(normalizedOptionId)
        setResolverSubdivisionId('')
        setResolverNeedsManualLocation(true)
        setResolverError('')
        closeResolverLocationDropdown()
        return
      }

      if (normalizedField === 'subdivision') {
        if (!resolverDivisionId) return
        const isValidSubdivision = (resolverSubdivisionsByDivision.get(resolverDivisionId) || []).some(
          (subdivision) => normalizeId(subdivision?.id) === normalizedOptionId
        )
        if (!isValidSubdivision) return
        const selectedPath = resolverSubdivisionPathById.get(normalizedOptionId) || null
        setResolverBodegaId(selectedPath?.bodegaId || resolverBodegaId)
        setResolverDivisionId(selectedPath?.divisionId || resolverDivisionId)
        setResolverSubdivisionId(normalizedOptionId)
        setResolverNeedsManualLocation(false)
        setResolverError('')
        closeResolverLocationDropdown()
      }
    },
    [
      closeResolverLocationDropdown,
      resolverBodegaId,
      resolverDivisionId,
      resolverDivisionsByBodega,
      resolverSubdivisionPathById,
      resolverSubdivisionsByDivision,
    ]
  )

  const closeResolverProvLocationDropdown = useCallback(() => {
    setResolverProvLocationDropdownField('')
    setResolverProvLocationDropdownDirection('down')
    setResolverProvLocationDropdownMaxHeight(null)
    setResolverProvLocationQuery('')
    setResolverProvLocationDebouncedQuery('')
  }, [])

  const updateResolverProvLocationDropdownPlacement = useCallback(() => {
    if (!showDetailsModal || !resolverProvLocationDropdownField || !resolverProvLocationDropdownRef.current) return
    const trigger = resolverProvLocationDropdownRef.current.querySelector('.create-user__dropdown-trigger')
    if (!trigger) return
    const triggerRect = trigger.getBoundingClientRect()
    const spacing = 10
    const availableBelow = Math.max(Math.floor(window.innerHeight - triggerRect.bottom - VIEWPORT_PADDING - spacing), 0)
    const availableAbove = Math.max(Math.floor(triggerRect.top - VIEWPORT_PADDING - spacing), 0)
    const nextDirection = availableBelow < 220 && availableAbove > availableBelow ? 'up' : 'down'
    const availableSpace = nextDirection === 'up' ? availableAbove : availableBelow
    const nextMaxHeight = Math.max(140, Math.min(320, availableSpace))
    setResolverProvLocationDropdownDirection((prev) => (prev === nextDirection ? prev : nextDirection))
    setResolverProvLocationDropdownMaxHeight((prev) => (prev === nextMaxHeight ? prev : nextMaxHeight))
  }, [resolverProvLocationDropdownField, showDetailsModal])

  const toggleResolverProvLocationDropdown = useCallback(
    (field) => {
      const nextField = String(field || '').trim().toLowerCase()
      if (!nextField) return
      setResolverProvLocationDropdownField((current) => (current === nextField ? '' : nextField))
      setResolverProvLocationDropdownDirection('down')
      setResolverProvLocationDropdownMaxHeight(null)
      setResolverProvLocationQuery('')
      setResolverProvLocationDebouncedQuery('')
      setTimeout(() => { updateResolverProvLocationDropdownPlacement() }, 0)
    },
    [updateResolverProvLocationDropdownPlacement]
  )

  useEffect(() => {
    if (!showDetailsModal || !resolverProvLocationDropdownField) {
      setResolverProvLocationDebouncedQuery('')
      return
    }
    const handle = setTimeout(() => {
      setResolverProvLocationDebouncedQuery(normalizeValue(resolverProvLocationQuery))
    }, 260)
    return () => clearTimeout(handle)
  }, [resolverProvLocationDropdownField, resolverProvLocationQuery, showDetailsModal])

  useEffect(() => {
    if (!showDetailsModal || !resolverProvLocationDropdownField) return undefined
    const handleClick = (event) => {
      if (resolverProvLocationDropdownRef.current && !resolverProvLocationDropdownRef.current.contains(event.target)) {
        closeResolverProvLocationDropdown()
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [closeResolverProvLocationDropdown, resolverProvLocationDropdownField, showDetailsModal])

  useEffect(() => {
    if (!showDetailsModal || !resolverProvLocationDropdownField) return undefined
    updateResolverProvLocationDropdownPlacement()
    const handleReposition = () => { updateResolverProvLocationDropdownPlacement() }
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [resolverProvLocationDropdownField, showDetailsModal, updateResolverProvLocationDropdownPlacement])

  const handleResolverProvLocationPick = useCallback(
    (field, optionId) => {
      const normalizedField = String(field || '').trim().toLowerCase()
      const normalizedOptionId = normalizeId(optionId)
      if (!normalizedField || !normalizedOptionId) return

      if (normalizedField === 'bodega') {
        setResolverProvBodegaId(normalizedOptionId)
        setResolverProvDivisionId('')
        setResolverProvSubdivisionId('')
        setResolverProvNeedsManualLocation(true)
        setResolverError('')
        closeResolverProvLocationDropdown()
        return
      }

      if (normalizedField === 'division') {
        if (!resolverProvBodegaId) return
        const isValidDivision = (resolverProvDivisionsByBodega.get(resolverProvBodegaId) || []).some(
          (division) => normalizeId(division?.id) === normalizedOptionId
        )
        if (!isValidDivision) return
        setResolverProvDivisionId(normalizedOptionId)
        setResolverProvSubdivisionId('')
        setResolverProvNeedsManualLocation(true)
        setResolverError('')
        closeResolverProvLocationDropdown()
        return
      }

      if (normalizedField === 'subdivision') {
        if (!resolverProvDivisionId) return
        const isValidSubdivision = (resolverProvSubdivisionsByDivision.get(resolverProvDivisionId) || []).some(
          (subdivision) => normalizeId(subdivision?.id) === normalizedOptionId
        )
        if (!isValidSubdivision) return
        const selectedPath = resolverProvSubdivisionPathById.get(normalizedOptionId) || null
        setResolverProvBodegaId(selectedPath?.bodegaId || resolverProvBodegaId)
        setResolverProvDivisionId(selectedPath?.divisionId || resolverProvDivisionId)
        setResolverProvSubdivisionId(normalizedOptionId)
        setResolverProvNeedsManualLocation(false)
        setResolverError('')
        closeResolverProvLocationDropdown()
      }
    },
    [
      closeResolverProvLocationDropdown,
      resolverProvBodegaId,
      resolverProvDivisionId,
      resolverProvDivisionsByBodega,
      resolverProvSubdivisionPathById,
      resolverProvSubdivisionsByDivision,
    ]
  )

  const clearFilter = useCallback(() => {
    setFilters(createInitialFilters())
    setGlobalFilterValue('')
  }, [])

  const autoFitColumns = useCallback(() => {
    autoFitTableColumns(tableWrapperRef.current, 'traslados-inconvenientes-table-state-v2')
  }, [])

  const handleResetTable = () => {
    tableLayoutStore.removeItem('traslados-inconvenientes-table-columns')
    tableLayoutStore.removeItem('traslados-inconvenientes-table-state-v2')
    setSelectedColumns(columnsData)
    clearFilter()
    setTableResetKey((k) => k + 1)
    opColumns.current?.hide()
  }

  const refreshData = useCallback(() => {
    void fetchRows({ withOverlay: false })
  }, [fetchRows])

  const handleGlobalFilterChange = useCallback((event) => {
    const value = String(event?.target?.value ?? '')
    setGlobalFilterValue(value)
    setFilters((prev) => ({
      ...(prev || {}),
      global: { value: value || null, matchMode: FilterMatchMode.CONTAINS },
    }))
  }, [])


  const handleStatusFilterChange = useCallback((nextFilter) => {
    setStatusFilter(String(nextFilter || 'all'))
    setSelectedRows([])
    setProcessedRows(null)
  }, [])

  const handleCheckboxChangeColumn = useCallback(
    (column) => {
      const key = column?.nombrevar
      if (!key) return
      setSelectedColumns((prev) => {
        const exists = prev.some((item) => item.nombrevar === key)
        let next
        if (exists) {
          next = prev.filter((item) => item.nombrevar !== key)
          if (!next.length) return prev
        } else {
          const map = new Map(prev.map((item) => [item.nombrevar, item]))
          map.set(key, column)
          next = columnsData.filter((item) => map.has(item.nombrevar))
        }
        tableLayoutStore.setItemNow('traslados-inconvenientes-table-columns', JSON.stringify(next))
        return next
      })
    },
    [columnsData]
  )

  const handleRowClick = useCallback(
    (event) => {
      const target = event?.originalEvent?.target
      if (
        target?.closest?.('.p-checkbox') ||
        target?.closest?.('.row-selection-column')
      ) {
        return
      }

    const rowData = event?.data
    if (!rowData) return
    const id = normalizeId(rowData?.id)
    if (!id) return
    const isSameRow = pendingClickRowRef.current === id
    pendingClickRowRef.current = id
    pendingClickCountRef.current = isSameRow ? pendingClickCountRef.current + 1 : 1
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
    }
    clickTimerRef.current = setTimeout(() => {
      const clickCount = pendingClickCountRef.current
      pendingClickCountRef.current = 0
      pendingClickRowRef.current = null
      clickTimerRef.current = null
      if (clickCount > 1) return
      setSelectedRows((prev) => {
        const prevMap = new Map((prev || []).map((row) => [normalizeId(row?.id), row]))
        if (prevMap.has(id)) {
          prevMap.delete(id)
        } else {
          prevMap.set(id, rowData)
        }
        return Array.from(prevMap.values())
      })
    }, 220)
    },
    []
  )

  const handleRowDoubleClick = useCallback(
    (event) => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }
      pendingClickCountRef.current = 0
      pendingClickRowRef.current = null
      const target = event?.originalEvent?.target
      if (
        target?.closest?.('.p-checkbox') ||
        target?.closest?.('.row-selection-column')
      ) {
        return
      }
      if (!event?.data) return
      openDetails(event.data)
    },
    [openDetails]
  )

  const getRowsToExport = useCallback(() => {
    if (selectedRows.length) return selectedRows
    if (Array.isArray(processedRows)) return processedRows
    return rows
  }, [processedRows, rows, selectedRows])

  const exportColumns = useMemo(
    () =>
      selectedColumns.map((column) => ({
        key: column.nombrevar,
        header: column.header,
      })),
    [selectedColumns]
  )

  const getExportValue = useCallback((row, key) => row?.[key], [])

  const handleExportExcel = useCallback(async () => {
    if (!exportColumns.length) {
      showWarningToast('Selecciona al menos una columna para exportar.')
      return
    }
    const rowsToExport = getRowsToExport()
    if (!rowsToExport.length) {
      showWarningToast('No hay registros para exportar.')
      return
    }
    await exportToExcel({
      rows: rowsToExport,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('inconvenientes-traslado'),
    })
  }, [exportColumns, getExportValue, getRowsToExport, showWarningToast])

  const handleExportPdf = useCallback(async () => {
    if (!exportColumns.length) {
      showWarningToast('Selecciona al menos una columna para exportar.')
      return
    }
    const rowsToExport = getRowsToExport()
    if (!rowsToExport.length) {
      showWarningToast('No hay registros para exportar.')
      return
    }
    await exportToPdf({
      rows: rowsToExport,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('inconvenientes-traslado'),
      title: 'Reporte de Inconvenientes de Traslado',
    })
  }, [exportColumns, getExportValue, getRowsToExport, showWarningToast])

  const submitResolver = useCallback(async (decisionOverride) => {
    if (!token || !selectedIssue) return
    const resolvedDecision = decisionOverride || resolverDecision
    if (!resolvedDecision) {
      setResolverError('Debes elegir una decisión para este producto.')
      return
    }

    const isImportacion = selectedIssue?.origen === 'importacion'

    if (!isImportacion) {
      if (
        (resolvedDecision === 'sumar_solicitante' || resolvedDecision === 'sumar_proveedora') &&
        !normalizeId(resolverSubdivisionId)
      ) {
        setResolverError('Debes seleccionar bodega, división y subdivisión para sumar inventario.')
        return
      }
      if (resolvedDecision === 'devolver_proveedora') {
        if (!normalizeId(resolverSubdivisionId)) {
          setResolverError('Debes seleccionar la ubicación en sucursal destino de donde restar el sobrante.')
          return
        }
        if (!normalizeId(resolverProvSubdivisionId)) {
          setResolverError('Debes seleccionar la ubicación en sucursal proveedora donde devolver el sobrante.')
          return
        }
      }
    }

    setResolverError('')
    setResolverSubmitting(true)
    try {
      const body = {
        decision: resolvedDecision,
        motivo: String(resolverMotivo || '').trim(),
      }
      if (!isImportacion) {
        if (resolvedDecision === 'sumar_solicitante' || resolvedDecision === 'sumar_proveedora') {
          body.subdivision_id = Number.parseInt(String(resolverSubdivisionId || ''), 10)
        }
        if (resolvedDecision === 'devolver_proveedora') {
          body.subdivision_id = Number.parseInt(String(resolverSubdivisionId || ''), 10)
          body.subdivision_proveedora_id = Number.parseInt(String(resolverProvSubdivisionId || ''), 10)
        }
      }

      const endpoint = isImportacion
        ? `${API_URL}/importaciones/importaciones/inconvenientes/${encodeURIComponent(normalizeId(selectedIssue?.id))}/resolver/`
        : `${API_URL}/movimientos/movimiento_inventario/traslados-inconvenientes/${encodeURIComponent(normalizeId(selectedIssue?.id))}/resolver/`

      const response = await authFetch(
        endpoint,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudo resolver el inconveniente.')
      }

      showSuccessToast('Inconveniente resuelto correctamente.')
      setShowDetailsModal(false)
      await fetchRows({ withOverlay: false })
      void fetchRemindersFromBackend(token).catch(() => {})
    } catch (requestError) {
      setResolverError(requestError?.message || 'No se pudo resolver el inconveniente.')
    } finally {
      setResolverSubmitting(false)
    }
  }, [
    fetchRows,
    resolverDecision,
    resolverMotivo,
    resolverProvSubdivisionId,
    resolverSubdivisionId,
    selectedIssue,
    showSuccessToast,
    token,
  ])

  const canResolveSelectedIssue = useMemo(() => {
    const selectedState = String(selectedIssue?.estado || '').trim().toLowerCase()
    return Boolean(canUpdate && selectedState === 'pendiente')
  }, [canUpdate, selectedIssue])

  const selectedHistoryRows = useMemo(() => {
    if (!Array.isArray(selectedIssue?.historial)) return []
    return selectedIssue.historial
  }, [selectedIssue])

  useEffect(() => {
    modalSizeRef.current = modalSize
  }, [modalSize])

  useEffect(() => {
    modalPositionRef.current = modalPosition
  }, [modalPosition])

  useLayoutEffect(() => {
    if (!showDetailsModal || isMaximized) return
    const { availableWidth, availableHeight, minWidth, minHeight } = getViewportMetrics()
    const width = Math.min(Math.max(MIN_WIDTH, minWidth), availableWidth)
    const height = Math.min(Math.max(MIN_HEIGHT, minHeight), availableHeight)
    setModalSize({ width, height })
    setModalPosition({
      x: Math.max((window.innerWidth - width) / 2, VIEWPORT_PADDING),
      y: Math.max((window.innerHeight - height) / 2, VIEWPORT_PADDING),
    })
  }, [getViewportMetrics, isMaximized, showDetailsModal])

  const handleModalMouseDown = (event) => {
    const target = event?.target
    if (target?.closest?.('.create-user__icon-button') || target?.closest?.('.create-user__resize-handle')) {
      return
    }

    if (isMaximized) {
      const restore = modalRestoreRef.current
      const fallbackSize = modalSizeRef.current
      const restoredSize = restore?.size || fallbackSize
      const restoredPosition = restore?.position || {
        x: Math.max((window.innerWidth - restoredSize.width) / 2, VIEWPORT_PADDING),
        y: Math.max((window.innerHeight - restoredSize.height) / 2, VIEWPORT_PADDING),
      }

      modalSizeRef.current = restoredSize
      modalPositionRef.current = restoredPosition
      setModalSize(restoredSize)
      setModalPosition(restoredPosition)
      setIsMaximized(false)

      const offsetX = Math.min(
        Math.max(event.clientX - restoredPosition.x, 24),
        Math.max(restoredSize.width - 24, 24)
      )
      const offsetY = Math.min(
        Math.max(event.clientY - restoredPosition.y, 12),
        56
      )
      modalDrag.current = {
        active: true,
        offsetX,
        offsetY,
      }
      return
    }

    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    modalDrag.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }

  const handleResizeMouseDown = (event) => {
    if (isMaximized) return
    event.preventDefault()
    event.stopPropagation()
    const { minWidth, minHeight } = getViewportMetrics()
    setIsResizingModal(true)
    modalResize.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: modalSizeRef.current.width,
      startHeight: modalSizeRef.current.height,
    }

    const handleResizeMove = (moveEvent) => {
      if (!modalResize.current.active) return
      const deltaX = moveEvent.clientX - modalResize.current.startX
      const deltaY = moveEvent.clientY - modalResize.current.startY
      const maxWidth = Math.max(minWidth, window.innerWidth - modalPositionRef.current.x - VIEWPORT_PADDING)
      const maxHeight = Math.max(minHeight, window.innerHeight - modalPositionRef.current.y - VIEWPORT_PADDING)
      const width = clamp(modalResize.current.startWidth + deltaX, minWidth, maxWidth)
      const height = clamp(modalResize.current.startHeight + deltaY, minHeight, maxHeight)
      setModalSize({ width, height })
    }

    const handleResizeUp = () => {
      modalResize.current.active = false
      setIsResizingModal(false)
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }

    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }

  useEffect(() => {
    if (!showDetailsModal) return undefined
    const handleMouseMove = (event) => {
      if (isMaximized || !modalDrag.current.active) return
      event.preventDefault()
      const maxX = Math.max(window.innerWidth - modalSizeRef.current.width - VIEWPORT_PADDING, VIEWPORT_PADDING)
      const maxY = Math.max(window.innerHeight - modalSizeRef.current.height - VIEWPORT_PADDING, VIEWPORT_PADDING)
      const x = event.clientX - modalDrag.current.offsetX
      const y = event.clientY - modalDrag.current.offsetY
      setModalPosition({
        x: Math.min(Math.max(x, VIEWPORT_PADDING), maxX),
        y: Math.min(Math.max(y, VIEWPORT_PADDING), maxY),
      })
    }

    const handleMouseUp = () => {
      modalDrag.current.active = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [showDetailsModal, isMaximized])

  useEffect(() => {
    if (!showDetailsModal) return undefined
    const handleWindowResize = () => {
      const { minWidth, minHeight, availableWidth, availableHeight } = getViewportMetrics()

      if (isMaximized) {
        setModalSize({ width: availableWidth, height: availableHeight })
        setModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }

      setModalSize((prev) => {
        const width = clamp(prev.width, minWidth, availableWidth)
        const height = clamp(prev.height, minHeight, availableHeight)

        setModalPosition((prevPosition) => ({
          x: Math.min(
            Math.max(prevPosition.x, VIEWPORT_PADDING),
            Math.max(window.innerWidth - width - VIEWPORT_PADDING, VIEWPORT_PADDING)
          ),
          y: Math.min(
            Math.max(prevPosition.y, VIEWPORT_PADDING),
            Math.max(window.innerHeight - height - VIEWPORT_PADDING, VIEWPORT_PADDING)
          ),
        }))

        return { width, height }
      })
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [getViewportMetrics, isMaximized, showDetailsModal])

  const toggleMaximize = () => {
    modalDrag.current.active = false
    modalResize.current.active = false
    setIsResizingModal(false)

    if (isMaximized) {
      const restore = modalRestoreRef.current
      if (restore) {
        setModalSize(restore.size)
        setModalPosition(restore.position)
      }
      setIsMaximized(false)
      return
    }

    modalRestoreRef.current = {
      size: { ...modalSizeRef.current },
      position: { ...modalPositionRef.current },
    }
    const { availableWidth, availableHeight } = getViewportMetrics()
    setModalSize({ width: availableWidth, height: availableHeight })
    setModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  const header = (
    <div className="users-header">
      <div className="users-header__left">
        <div className="search-input-container">
          <input
            ref={quickSearchInputRef}
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
          onClick={refreshData}
          disabled={loading || isRefreshing}
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
        <span className="users-header__count">Reg. {rows.length}</span>
        <button className="users-circle users-circle--excel" type="button" title="Excel" onClick={handleExportExcel}>
          <i className="pi pi-file-excel" />
        </button>
        <button className="users-circle users-circle--pdf" type="button" title="PDF" onClick={handleExportPdf}>
          <i className="pi pi-file-pdf" />
        </button>
      </div>
    </div>
  )

  const estadoBodyTemplate = useCallback(
    (row) => (
      <span className={`transfer-issues-state transfer-issues-state--${row?.estado_key || 'pendiente'}`}>
        {row?.estado_label || '-'}
      </span>
    ),
    []
  )

  const productoBodyTemplate = useCallback(
    (row) => {
      const reason = String(row?.motivo || '').trim()
      return (
        <div className="transfer-issues-product-cell">
          <strong>{String(row?.producto_codigo || '-').trim() || '-'}</strong>
          <span>{String(row?.producto_nombre || '-').trim() || '-'}</span>
          {reason ? (
            <small className="cell-tooltip" data-pr-tooltip={reason}>
              Novedad: {reason}
            </small>
          ) : null}
        </div>
      )
    },
    []
  )

  if (!canRead) {
    return (
      <div className="users-page transfer-issues-page">
        <Toast ref={toast} />
        <div className="users-table users-table--card transfer-issues-no-access">
          <p>No tienes permisos para ver inconvenientes de traslado.</p>
        </div>
      </div>
    )
  }

  const overlayStyle = { padding: `${VIEWPORT_PADDING}px` }
  const modalStyle = {
    top: modalPosition.y,
    left: modalPosition.x,
    width: modalSize.width,
    height: modalSize.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
  }
  const modalClassName = [
    'create-user__modal',
    'create-salida__modal',
    isClosingDetailsModal ? 'create-user__modal--closing' : '',
    isResizingModal ? 'create-salida__modal--resizing' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const modalTitle = `Inconveniente: ${String(selectedIssue?.solicitud_no_documento || '-').trim() || '-'}`

  return (
    <div className="users-page transfer-issues-page">
      <Tooltip position="top" showDelay={250} target=".cell-tooltip" style={{ maxWidth: '340px' }} />
      <Toast ref={toast} />

      <div className="users-page__top">
        <div className="users-page__actions">
          <Button
            label="Buscar"
            icon="pi pi-search"
            className="users-topbtn users-topbtn--search"
            onClick={() => {
              quickSearchInputRef.current?.focus()
              quickSearchInputRef.current?.select?.()
            }}
            type="button"
          />
          <div className="transfer-issues-page__type-filter" role="group" aria-label="Filtros de estado">
            {STATUS_FILTERS.map((option) => {
              const active = statusFilter === option.key
              return (
                <Button
                  key={option.key}
                  label={option.label}
                  type="button"
                  className={`users-topbtn transfer-issues-page__type-btn${
                    active ? ' transfer-issues-page__type-btn--active' : ''
                  }`}
                  onClick={() => handleStatusFilterChange(option.key)}
                />
              )
            })}
          </div>
        </div>
      </div>

      <div className="users-table users-table--card" ref={tableWrapperRef}>
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
          key={tableResetKey}
          value={rows}
          dataKey="row_key"
          header={header}
          className={`users-datatable${loading || isRefreshing ? ' users-datatable--loading-content' : ''}`}
          tableStyle={{ width: '100%' }}
          emptyMessage="No se encontraron inconvenientes"
          showGridlines
          size="small"
          scrollable
          scrollHeight="flex"
          paginator
          rows={25}
          rowsPerPageOptions={[5, 10, 25, 50]}
          removableSort
          filters={filters}
          onValueChange={(value) => setProcessedRows(Array.isArray(value) ? value : [])}
          globalFilterFields={[
            'solicitud_no_documento',
            'producto_nombre',
            'producto_codigo',
            'cantidad_faltante',
            'sucursal_proveedora',
            'sucursal_solicitante',
            'estado_label',
            'resolucion_label',
            'created_at_label',
          ]}
          onRowClick={handleRowClick}
          onRowDoubleClick={handleRowDoubleClick}
          rowClassName={(rowData) => {
            const classes = []
            if (selectedRowIds.has(rowData?.row_key)) {
              classes.push('selected-row-shadow')
            }
            const rowState = String(rowData?.estado_key || '').trim().toLowerCase()
            if (rowState) {
              classes.push(`transfer-issues-row--${rowState}`)
            }
            return classes.join(' ')
          }}
          selectionMode="multiple"
          selection={selectedRows}
          onSelectionChange={(event) => {
            if (!isCheckboxSelection(event)) return
            setSelectedRows(event.value || [])
          }}
          resizableColumns
          columnResizeMode="expand"
          stateStorage="custom"
          customSaveState={widthHandlers.save}
          customRestoreState={widthHandlers.restore}
        >
          <Column
            selectionMode="multiple"
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
            let bodyTemplate = null
            if (field === 'producto_nombre') {
              bodyTemplate = productoBodyTemplate
            } else if (field === 'estado_label') {
              bodyTemplate = estadoBodyTemplate
            } else {
              bodyTemplate = (rowData) => (
                <span className="cell-tooltip" data-pr-tooltip={String(rowData?.[field] ?? '').trim()}>
                  {String(rowData?.[field] ?? '').trim() || '-'}
                </span>
              )
            }
            const className =
              field === 'cantidad_faltante' ? 'column-max-min-width--small' : 'column-max-min-width'
            return (
              <Column
                key={field}
                field={field}
                header={column.header}
                body={bodyTemplate}
                sortable
                className={className}
                headerClassName={className}
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
          {columnsData.map((column) => (
            <div
              key={column.nombrevar}
              className="p-field-checkbox"
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}
            >
              <Checkbox
                inputId={`inconvenientes-col-${column.nombrevar}`}
                value={column}
                onChange={() => handleCheckboxChangeColumn(column)}
                checked={selectedColumns.some((item) => item.nombrevar === column.nombrevar)}
              />
              <label htmlFor={`inconvenientes-col-${column.nombrevar}`} style={{ cursor: 'pointer' }}>
                {column.header}
              </label>
            </div>
          ))}
        </OverlayPanel>
      </div>

      {shouldRenderDetailsModal && selectedIssue && (
        <div
          className={`create-user__overlay${isClosingDetailsModal ? ' create-user__overlay--closing' : ''}`}
          role="dialog"
          aria-modal="true"
          style={overlayStyle}
        >
          <div ref={modalRef} className={modalClassName} style={modalStyle}>
            <header className="create-user__header" onMouseDown={handleModalMouseDown}>
              <div className="create-user__header-text">
                <h3>{modalTitle}</h3>
              </div>
              <div className="create-user__header-actions">
                <button
                  type="button"
                  className="create-user__icon-button create-user__icon-button--maximize"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={toggleMaximize}
                  aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
                >
                  <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="create-user__icon-button"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={closeDetails}
                  aria-label="Cerrar"
                >
                  <i className="pi pi-times" />
                </button>
              </div>
            </header>

            <form
              className="create-user__form"
              noValidate
              onSubmitCapture={(event) => event.currentTarget.classList.add('create-user__form--submitted')}
              onSubmit={(event) => event.preventDefault()}
            >
              <div className="create-user__body">
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Resumen</p>
                      <h4>Detalle general</h4>
                    </div>
                  </div>
                  <div className="create-salida__field-group--defined">
                    <div className="create-user__grid create-user__grid--two">
                      <StaticFieldDisplay
                        label="Producto"
                        value={
                          selectedIssue?.tipo === 'otro'
                            ? 'Sin producto especifico'
                            : `${String(selectedIssue?.producto_codigo || '-').trim()} - ${String(selectedIssue?.producto_nombre || '-').trim()}`
                        }
                      />
                      {selectedIssue?.tipo === 'otro' ? (
                        <StaticFieldDisplay label="Tipo" value="Otro" />
                      ) : (
                        <div className="create-user__field create-salida__static-field">
                          <span>{selectedIssue?.tipo === 'sobrante' ? 'Sobrante' : 'Faltante'}</span>
                          <div className={`create-salida__static-value transfer-issues-cantidad--${selectedIssue?.tipo === 'sobrante' ? 'sobrante' : 'faltante'}`}>
                            {selectedIssue?.tipo === 'sobrante' ? '+' : '−'}{String(Number.parseInt(String(selectedIssue?.cantidad_faltante || 0), 10) || 0)}
                          </div>
                        </div>
                      )}
                      <StaticFieldDisplay
                        label={selectedIssue?.origen === 'importacion' ? 'Casa comercial' : 'Sucursal proveedora'}
                        value={String(selectedIssue?.sucursal_proveedora || '-').trim() || '-'}
                      />
                      <StaticFieldDisplay
                        label={selectedIssue?.origen === 'importacion' ? 'Importación' : 'Sucursal destino'}
                        value={
                          selectedIssue?.origen === 'importacion'
                            ? String(selectedIssue?.solicitud_no_documento || '-').trim() || '-'
                            : String(selectedIssue?.sucursal_solicitante || '-').trim() || '-'
                        }
                      />
                      <StaticFieldDisplay
                        label="Estado"
                        value={formatEstado(selectedIssue?.estado)}
                      />
                      <StaticFieldDisplay
                        label="Resolucion"
                        value={formatResolucion(selectedIssue?.resolucion)}
                      />
                    </div>
                    {String(selectedIssue?.motivo || '').trim() ? (
                      <StaticFieldDisplay
                        label="Novedad"
                        value={String(selectedIssue?.motivo || '').trim()}
                        fullWidth
                      />
                    ) : null}
                  </div>
                </section>
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Resolucion</p>
                      <h4>Accion por producto</h4>
                    </div>
                  </div>
                  {canResolveSelectedIssue ? (
                    selectedIssue?.tipo === 'otro' ? (
                      <>
                        <p className="muted transfer-issues-details__hint">
                          Marca este inconveniente como solucionado una vez que lo hayas atendido.
                        </p>
                        {resolverError ? <p className="transfer-issues-details__error">{resolverError}</p> : null}
                      </>
                    ) : (
                    <>
                      {selectedIssue?.origen === 'importacion' && (
                        <>
                          <p className="muted transfer-issues-details__hint">
                            {selectedIssue?.tipo === 'sobrante'
                              ? 'Decide si el excedente se reporta al proveedor o se acepta sin cambios en el inventario.'
                              : 'Decide si el faltante se reporta al proveedor o se marca como perdido.'}
                          </p>
                          <div className="transfer-issues-details__decisions transfer-issues-details__decisions--two">
                            <button
                              type="button"
                              className={`create-user__action create-user__action--secondary transfer-issues-details__decision-btn transfer-issues-details__decision-btn--neutral${
                                resolverDecision === 'reportado_proveedor' ? ' is-active' : ''
                              }`}
                              onClick={() => setResolverDecision('reportado_proveedor')}
                              disabled={resolverSubmitting}
                            >
                              Reportar a proveedor
                            </button>
                            {selectedIssue?.tipo === 'sobrante' ? (
                              <button
                                type="button"
                                className={`create-user__action create-user__action--secondary transfer-issues-details__decision-btn transfer-issues-details__decision-btn--success${
                                  resolverDecision === 'aceptado' ? ' is-active' : ''
                                }`}
                                onClick={() => setResolverDecision('aceptado')}
                                disabled={resolverSubmitting}
                              >
                                Aceptar excedente
                              </button>
                            ) : (
                              <button
                                type="button"
                                className={`create-user__action create-user__action--secondary transfer-issues-details__decision-btn transfer-issues-details__decision-btn--danger${
                                  resolverDecision === 'perdido' ? ' is-active' : ''
                                }`}
                                onClick={() => setResolverDecision('perdido')}
                                disabled={resolverSubmitting}
                              >
                                Marcar como perdido
                              </button>
                            )}
                          </div>
                          <label className="create-user__field create-user__field--full transfer-issues-details__field">
                            <span>Motivo o nota (opcional)</span>
                            <textarea
                              rows={3}
                              value={resolverMotivo}
                              onChange={(event) => setResolverMotivo(String(event.target.value || ''))}
                              disabled={resolverSubmitting}
                            />
                          </label>
                          {resolverError ? <p className="transfer-issues-details__error">{resolverError}</p> : null}
                        </>
                      )}
                      {selectedIssue?.origen !== 'importacion' && (
                      <>
                      {selectedIssue?.tipo === 'sobrante' ? (
                        <>
                          <p className="muted transfer-issues-details__hint">
                            Decide si los productos sobrantes deben devolverse a la sucursal proveedora (se restan del destino y se suman al origen) o mantenerse en la sucursal destino.
                          </p>
                          <div className="transfer-issues-details__decisions transfer-issues-details__decisions--two">
                            <button
                              type="button"
                              className={`create-user__action create-user__action--secondary transfer-issues-details__decision-btn transfer-issues-details__decision-btn--warning${
                                resolverDecision === 'devolver_proveedora' ? ' is-active' : ''
                              }`}
                              onClick={() => {
                                setResolverDecision('devolver_proveedora')
                                setResolverBodegaId('')
                                setResolverDivisionId('')
                                setResolverSubdivisionId('')
                                setResolverNeedsManualLocation(false)
                                closeResolverLocationDropdown()
                                setResolverProvBodegaId('')
                                setResolverProvDivisionId('')
                                setResolverProvSubdivisionId('')
                                setResolverProvNeedsManualLocation(false)
                                closeResolverProvLocationDropdown()
                              }}
                              disabled={resolverSubmitting}
                            >
                              Devolver
                            </button>
                            <button
                              type="button"
                              className={`create-user__action create-user__action--secondary transfer-issues-details__decision-btn transfer-issues-details__decision-btn--neutral${
                                resolverDecision === 'sin_cambios' ? ' is-active' : ''
                              }`}
                              onClick={() => {
                                setResolverDecision('sin_cambios')
                                setResolverBodegaId('')
                                setResolverDivisionId('')
                                setResolverSubdivisionId('')
                                setResolverNeedsManualLocation(false)
                                closeResolverLocationDropdown()
                                setResolverProvBodegaId('')
                                setResolverProvDivisionId('')
                                setResolverProvSubdivisionId('')
                                setResolverProvNeedsManualLocation(false)
                                closeResolverProvLocationDropdown()
                              }}
                              disabled={resolverSubmitting}
                            >
                              Mantener
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <p className="muted transfer-issues-details__hint">
                            Decide si este faltante debe sumarse en la sucursal proveedora, en la sucursal destino, o marcarse como desaparecido.
                          </p>
                          <div className="transfer-issues-details__decisions">
                            <button
                              type="button"
                              className={`create-user__action create-user__action--secondary transfer-issues-details__decision-btn transfer-issues-details__decision-btn--primary${
                                resolverDecision === 'sumar_proveedora' ? ' is-active' : ''
                              }`}
                              onClick={() => {
                                setResolverDecision('sumar_proveedora')
                                setResolverBodegaId('')
                                setResolverDivisionId('')
                                setResolverSubdivisionId('')
                                setResolverNeedsManualLocation(false)
                                closeResolverLocationDropdown()
                              }}
                              disabled={resolverSubmitting}
                            >
                              Sumar a sucursal proveedora
                            </button>
                            <button
                              type="button"
                              className={`create-user__action create-user__action--secondary transfer-issues-details__decision-btn transfer-issues-details__decision-btn--success${
                                resolverDecision === 'sumar_solicitante' ? ' is-active' : ''
                              }`}
                              onClick={() => {
                                setResolverDecision('sumar_solicitante')
                                setResolverBodegaId('')
                                setResolverDivisionId('')
                                setResolverSubdivisionId('')
                                setResolverNeedsManualLocation(false)
                                closeResolverLocationDropdown()
                              }}
                              disabled={resolverSubmitting}
                            >
                              Sumar a sucursal destino
                            </button>
                            <button
                              type="button"
                              className={`create-user__action create-user__action--secondary transfer-issues-details__decision-btn transfer-issues-details__decision-btn--danger${
                                resolverDecision === 'perdido' ? ' is-active' : ''
                              }`}
                              onClick={() => {
                                setResolverDecision('perdido')
                                setResolverBodegaId('')
                                setResolverDivisionId('')
                                setResolverSubdivisionId('')
                                setResolverNeedsManualLocation(false)
                                closeResolverLocationDropdown()
                              }}
                              disabled={resolverSubmitting}
                            >
                              Marcar como desaparecido
                            </button>
                          </div>
                        </>
                      )}

                      {(resolverDecision === 'sumar_solicitante' || resolverDecision === 'sumar_proveedora' || resolverDecision === 'restar_proveedora' || resolverDecision === 'devolver_proveedora') && (
                        <label className="create-user__field create-user__field--full transfer-issues-details__field">
                          <span>{resolverDecision === 'devolver_proveedora' ? `Donde restar en destino (${resolverTargetBranchLabel})` : `Ubicacion (${resolverTargetBranchLabel})`}</span>
                          <div className="create-entrada__location-picker-grid">
                            <div className="create-entrada__location-picker-item">
                              <small>Bodega</small>
                              <div
                                className="create-user__dropdown create-salida__product-dropdown"
                                ref={resolverLocationDropdownField === 'bodega' ? resolverLocationDropdownRef : null}
                              >
                                <button
                                  type="button"
                                  className="create-user__dropdown-trigger"
                                  onClick={() => toggleResolverLocationDropdown('bodega')}
                                  disabled={resolverSubmitting || resolverSubdivisionsLoading}
                                >
                                  <span>
                                    {selectedResolverBodega
                                      ? formatBodegaLocationLabel(selectedResolverBodega)
                                      : 'Selecciona una bodega'}
                                  </span>
                                  <i className={`pi pi-chevron-${resolverLocationDropdownField === 'bodega' ? 'up' : 'down'}`} />
                                </button>

                                {resolverLocationDropdownField === 'bodega' && (
                                  <div
                                    className={`create-user__dropdown-panel ${
                                      resolverLocationDropdownDirection === 'up' ? 'create-salida__product-panel--up' : ''
                                    }`}
                                    style={
                                      resolverLocationDropdownMaxHeight
                                        ? { maxHeight: `${resolverLocationDropdownMaxHeight}px` }
                                        : undefined
                                    }
                                  >
                                    <div className="create-user__dropdown-search">
                                      <i className="pi pi-search" />
                                      <input
                                        type="text"
                                        placeholder="Buscar bodega"
                                        value={resolverLocationQuery}
                                        onChange={(event) => setResolverLocationQuery(event.target.value)}
                                        disabled={resolverSubmitting}
                                      />
                                    </div>
                                    <div
                                      className="create-user__dropdown-results"
                                      style={
                                        resolverLocationDropdownMaxHeight
                                          ? {
                                              maxHeight: `${Math.max(resolverLocationDropdownMaxHeight - 72, 84)}px`,
                                            }
                                          : undefined
                                      }
                                    >
                                      {!filterResolverLocationOptions(
                                        resolverBodegas,
                                        (bodega) =>
                                          `${formatBodegaLocationLabel(bodega)} ${String(
                                            bodega?.sucursal?.nombre || ''
                                          ).trim()}`
                                      ).length && <small className="muted">Sin resultados.</small>}
                                      {filterResolverLocationOptions(
                                        resolverBodegas,
                                        (bodega) =>
                                          `${formatBodegaLocationLabel(bodega)} ${String(
                                            bodega?.sucursal?.nombre || ''
                                          ).trim()}`
                                      ).map((bodega) => (
                                        <button
                                          key={`resolver-bodega-option-${bodega.id}`}
                                          type="button"
                                          className="create-user__result-option"
                                          onMouseDown={(event) => event.preventDefault()}
                                          onClick={(event) => {
                                            event.preventDefault()
                                            event.stopPropagation()
                                            handleResolverLocationPick('bodega', bodega.id)
                                          }}
                                          disabled={resolverSubmitting}
                                        >
                                          <div className="create-user__result-info">
                                            <strong>{String(bodega?.nombre || `Bodega ${bodega.id}`).trim()}</strong>
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="create-entrada__location-picker-item">
                              <small>Division</small>
                              <div
                                className="create-user__dropdown create-salida__product-dropdown"
                                ref={resolverLocationDropdownField === 'division' ? resolverLocationDropdownRef : null}
                              >
                                <button
                                  type="button"
                                  className="create-user__dropdown-trigger"
                                  onClick={() => toggleResolverLocationDropdown('division')}
                                  disabled={resolverSubmitting || resolverSubdivisionsLoading || !resolverBodegaId}
                                >
                                  <span>
                                    {selectedResolverDivision
                                      ? String(selectedResolverDivision?.nombre || '').trim()
                                      : 'Selecciona una division'}
                                  </span>
                                  <i className={`pi pi-chevron-${resolverLocationDropdownField === 'division' ? 'up' : 'down'}`} />
                                </button>

                                {resolverLocationDropdownField === 'division' && (
                                  <div
                                    className={`create-user__dropdown-panel ${
                                      resolverLocationDropdownDirection === 'up' ? 'create-salida__product-panel--up' : ''
                                    }`}
                                    style={
                                      resolverLocationDropdownMaxHeight
                                        ? { maxHeight: `${resolverLocationDropdownMaxHeight}px` }
                                        : undefined
                                    }
                                  >
                                    <div className="create-user__dropdown-search">
                                      <i className="pi pi-search" />
                                      <input
                                        type="text"
                                        placeholder="Buscar division"
                                        value={resolverLocationQuery}
                                        onChange={(event) => setResolverLocationQuery(event.target.value)}
                                        disabled={resolverSubmitting}
                                      />
                                    </div>
                                    <div
                                      className="create-user__dropdown-results"
                                      style={
                                        resolverLocationDropdownMaxHeight
                                          ? {
                                              maxHeight: `${Math.max(resolverLocationDropdownMaxHeight - 72, 84)}px`,
                                            }
                                          : undefined
                                      }
                                    >
                                      {!filterResolverLocationOptions(
                                        resolverDivisionOptions,
                                        (division) =>
                                          `${formatDivisionLocationLabel(division)} ${String(
                                            division?.bodega?.sucursal?.nombre || ''
                                          ).trim()}`
                                      ).length && <small className="muted">Sin resultados.</small>}
                                      {filterResolverLocationOptions(
                                        resolverDivisionOptions,
                                        (division) =>
                                          `${formatDivisionLocationLabel(division)} ${String(
                                            division?.bodega?.sucursal?.nombre || ''
                                          ).trim()}`
                                      ).map((division) => (
                                        <button
                                          key={`resolver-division-option-${division.id}`}
                                          type="button"
                                          className="create-user__result-option"
                                          onMouseDown={(event) => event.preventDefault()}
                                          onClick={(event) => {
                                            event.preventDefault()
                                            event.stopPropagation()
                                            handleResolverLocationPick('division', division.id)
                                          }}
                                          disabled={resolverSubmitting}
                                        >
                                          <div className="create-user__result-info">
                                            <strong>{String(division?.nombre || `Division ${division.id}`).trim()}</strong>
                                            <small>{formatDivisionLocationLabel(division)}</small>
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="create-entrada__location-picker-item">
                              <small>Subdivision</small>
                              <div
                                className="create-user__dropdown create-salida__product-dropdown"
                                ref={resolverLocationDropdownField === 'subdivision' ? resolverLocationDropdownRef : null}
                              >
                                <button
                                  type="button"
                                  className="create-user__dropdown-trigger"
                                  onClick={() => toggleResolverLocationDropdown('subdivision')}
                                  disabled={resolverSubmitting || resolverSubdivisionsLoading || !resolverDivisionId}
                                >
                                  <span>
                                    {selectedResolverSubdivision
                                      ? String(selectedResolverSubdivision?.nombre || '').trim()
                                      : 'Selecciona una subdivision'}
                                  </span>
                                  <i className={`pi pi-chevron-${resolverLocationDropdownField === 'subdivision' ? 'up' : 'down'}`} />
                                </button>

                                {resolverLocationDropdownField === 'subdivision' && (
                                  <div
                                    className={`create-user__dropdown-panel ${
                                      resolverLocationDropdownDirection === 'up' ? 'create-salida__product-panel--up' : ''
                                    }`}
                                    style={
                                      resolverLocationDropdownMaxHeight
                                        ? { maxHeight: `${resolverLocationDropdownMaxHeight}px` }
                                        : undefined
                                    }
                                  >
                                    <div className="create-user__dropdown-search">
                                      <i className="pi pi-search" />
                                      <input
                                        type="text"
                                        placeholder="Buscar subdivision"
                                        value={resolverLocationQuery}
                                        onChange={(event) => setResolverLocationQuery(event.target.value)}
                                        disabled={resolverSubmitting}
                                      />
                                    </div>
                                    <div
                                      className="create-user__dropdown-results"
                                      style={
                                        resolverLocationDropdownMaxHeight
                                          ? {
                                              maxHeight: `${Math.max(resolverLocationDropdownMaxHeight - 72, 84)}px`,
                                            }
                                          : undefined
                                      }
                                    >
                                      {!filterResolverLocationOptions(
                                        resolverSubdivisionOptions,
                                        (subdivision) =>
                                          `${formatSubdivisionLocationLabel(subdivision)} ${String(
                                            subdivision?.division?.bodega?.sucursal?.nombre || ''
                                          ).trim()}`
                                      ).length && <small className="muted">Sin resultados.</small>}
                                      {filterResolverLocationOptions(
                                        resolverSubdivisionOptions,
                                        (subdivision) =>
                                          `${formatSubdivisionLocationLabel(subdivision)} ${String(
                                            subdivision?.division?.bodega?.sucursal?.nombre || ''
                                          ).trim()}`
                                      ).map((subdivision) => (
                                        <button
                                          key={`resolver-subdivision-option-${subdivision.id}`}
                                          type="button"
                                          className="create-user__result-option"
                                          onMouseDown={(event) => event.preventDefault()}
                                          onClick={(event) => {
                                            event.preventDefault()
                                            event.stopPropagation()
                                            handleResolverLocationPick('subdivision', subdivision.id)
                                          }}
                                          disabled={resolverSubmitting}
                                        >
                                          <div className="create-user__result-info">
                                            <strong>
                                              {String(subdivision?.nombre || `Subdivision ${subdivision.id}`).trim()}
                                            </strong>
                                            <small>{formatSubdivisionLocationLabel(subdivision)}</small>
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          {resolverSubdivisionsLoading ? (
                            <small className="transfer-issues-details__loading">
                              <Loader2 size={12} />
                              Cargando subdivisiones...
                            </small>
                          ) : null}
                          {!resolverSubdivisionsLoading && resolverNeedsManualLocation && !resolverSubdivisionId ? (
                            <small className="transfer-issues-details__manual-location-hint">
                              Este producto no tiene ubicación previa en esta sucursal. Selecciona bodega, división y subdivisión.
                            </small>
                          ) : null}
                        </label>
                      )}

                      {resolverDecision === 'devolver_proveedora' && (
                        <label className="create-user__field create-user__field--full transfer-issues-details__field">
                          <span>Donde sumar en proveedora ({String(selectedIssue?.sucursal_proveedora || '').trim() || 'Sucursal proveedora'})</span>
                          <div className="create-entrada__location-picker-grid">
                            <div className="create-entrada__location-picker-item">
                              <small>Bodega</small>
                              <div
                                className="create-user__dropdown create-salida__product-dropdown"
                                ref={resolverProvLocationDropdownField === 'bodega' ? resolverProvLocationDropdownRef : null}
                              >
                                <button
                                  type="button"
                                  className="create-user__dropdown-trigger"
                                  onClick={() => toggleResolverProvLocationDropdown('bodega')}
                                  disabled={resolverSubmitting || resolverProvSubdivisionsLoading}
                                >
                                  <span>
                                    {selectedResolverProvBodega
                                      ? formatBodegaLocationLabel(selectedResolverProvBodega)
                                      : 'Selecciona una bodega'}
                                  </span>
                                  <i className={`pi pi-chevron-${resolverProvLocationDropdownField === 'bodega' ? 'up' : 'down'}`} />
                                </button>
                                {resolverProvLocationDropdownField === 'bodega' && (
                                  <div
                                    className={`create-user__dropdown-panel ${
                                      resolverProvLocationDropdownDirection === 'up' ? 'create-salida__product-panel--up' : ''
                                    }`}
                                    style={resolverProvLocationDropdownMaxHeight ? { maxHeight: `${resolverProvLocationDropdownMaxHeight}px` } : undefined}
                                  >
                                    <div className="create-user__dropdown-search">
                                      <i className="pi pi-search" />
                                      <input
                                        type="text"
                                        placeholder="Buscar bodega"
                                        value={resolverProvLocationQuery}
                                        onChange={(event) => setResolverProvLocationQuery(event.target.value)}
                                        disabled={resolverSubmitting}
                                      />
                                    </div>
                                    <div
                                      className="create-user__dropdown-results"
                                      style={resolverProvLocationDropdownMaxHeight ? { maxHeight: `${Math.max(resolverProvLocationDropdownMaxHeight - 72, 84)}px` } : undefined}
                                    >
                                      {!filterResolverProvLocationOptions(resolverProvBodegas, (bodega) => `${formatBodegaLocationLabel(bodega)} ${String(bodega?.sucursal?.nombre || '').trim()}`).length && (
                                        <small className="muted">Sin resultados.</small>
                                      )}
                                      {filterResolverProvLocationOptions(resolverProvBodegas, (bodega) => `${formatBodegaLocationLabel(bodega)} ${String(bodega?.sucursal?.nombre || '').trim()}`).map((bodega) => (
                                        <button
                                          key={`resolver-prov-bodega-option-${bodega.id}`}
                                          type="button"
                                          className="create-user__result-option"
                                          onMouseDown={(event) => event.preventDefault()}
                                          onClick={(event) => { event.preventDefault(); event.stopPropagation(); handleResolverProvLocationPick('bodega', bodega.id) }}
                                          disabled={resolverSubmitting}
                                        >
                                          <div className="create-user__result-info">
                                            <strong>{String(bodega?.nombre || `Bodega ${bodega.id}`).trim()}</strong>
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="create-entrada__location-picker-item">
                              <small>Division</small>
                              <div
                                className="create-user__dropdown create-salida__product-dropdown"
                                ref={resolverProvLocationDropdownField === 'division' ? resolverProvLocationDropdownRef : null}
                              >
                                <button
                                  type="button"
                                  className="create-user__dropdown-trigger"
                                  onClick={() => toggleResolverProvLocationDropdown('division')}
                                  disabled={resolverSubmitting || resolverProvSubdivisionsLoading || !resolverProvBodegaId}
                                >
                                  <span>
                                    {selectedResolverProvDivision
                                      ? String(selectedResolverProvDivision?.nombre || '').trim()
                                      : 'Selecciona una division'}
                                  </span>
                                  <i className={`pi pi-chevron-${resolverProvLocationDropdownField === 'division' ? 'up' : 'down'}`} />
                                </button>
                                {resolverProvLocationDropdownField === 'division' && (
                                  <div
                                    className={`create-user__dropdown-panel ${
                                      resolverProvLocationDropdownDirection === 'up' ? 'create-salida__product-panel--up' : ''
                                    }`}
                                    style={resolverProvLocationDropdownMaxHeight ? { maxHeight: `${resolverProvLocationDropdownMaxHeight}px` } : undefined}
                                  >
                                    <div className="create-user__dropdown-search">
                                      <i className="pi pi-search" />
                                      <input
                                        type="text"
                                        placeholder="Buscar division"
                                        value={resolverProvLocationQuery}
                                        onChange={(event) => setResolverProvLocationQuery(event.target.value)}
                                        disabled={resolverSubmitting}
                                      />
                                    </div>
                                    <div
                                      className="create-user__dropdown-results"
                                      style={resolverProvLocationDropdownMaxHeight ? { maxHeight: `${Math.max(resolverProvLocationDropdownMaxHeight - 72, 84)}px` } : undefined}
                                    >
                                      {!filterResolverProvLocationOptions(resolverProvDivisionOptions, (division) => `${formatDivisionLocationLabel(division)} ${String(division?.bodega?.sucursal?.nombre || '').trim()}`).length && (
                                        <small className="muted">Sin resultados.</small>
                                      )}
                                      {filterResolverProvLocationOptions(resolverProvDivisionOptions, (division) => `${formatDivisionLocationLabel(division)} ${String(division?.bodega?.sucursal?.nombre || '').trim()}`).map((division) => (
                                        <button
                                          key={`resolver-prov-division-option-${division.id}`}
                                          type="button"
                                          className="create-user__result-option"
                                          onMouseDown={(event) => event.preventDefault()}
                                          onClick={(event) => { event.preventDefault(); event.stopPropagation(); handleResolverProvLocationPick('division', division.id) }}
                                          disabled={resolverSubmitting}
                                        >
                                          <div className="create-user__result-info">
                                            <strong>{String(division?.nombre || `Division ${division.id}`).trim()}</strong>
                                            <small>{formatDivisionLocationLabel(division)}</small>
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="create-entrada__location-picker-item">
                              <small>Subdivision</small>
                              <div
                                className="create-user__dropdown create-salida__product-dropdown"
                                ref={resolverProvLocationDropdownField === 'subdivision' ? resolverProvLocationDropdownRef : null}
                              >
                                <button
                                  type="button"
                                  className="create-user__dropdown-trigger"
                                  onClick={() => toggleResolverProvLocationDropdown('subdivision')}
                                  disabled={resolverSubmitting || resolverProvSubdivisionsLoading || !resolverProvDivisionId}
                                >
                                  <span>
                                    {selectedResolverProvSubdivision
                                      ? String(selectedResolverProvSubdivision?.nombre || '').trim()
                                      : 'Selecciona una subdivision'}
                                  </span>
                                  <i className={`pi pi-chevron-${resolverProvLocationDropdownField === 'subdivision' ? 'up' : 'down'}`} />
                                </button>
                                {resolverProvLocationDropdownField === 'subdivision' && (
                                  <div
                                    className={`create-user__dropdown-panel ${
                                      resolverProvLocationDropdownDirection === 'up' ? 'create-salida__product-panel--up' : ''
                                    }`}
                                    style={resolverProvLocationDropdownMaxHeight ? { maxHeight: `${resolverProvLocationDropdownMaxHeight}px` } : undefined}
                                  >
                                    <div className="create-user__dropdown-search">
                                      <i className="pi pi-search" />
                                      <input
                                        type="text"
                                        placeholder="Buscar subdivision"
                                        value={resolverProvLocationQuery}
                                        onChange={(event) => setResolverProvLocationQuery(event.target.value)}
                                        disabled={resolverSubmitting}
                                      />
                                    </div>
                                    <div
                                      className="create-user__dropdown-results"
                                      style={resolverProvLocationDropdownMaxHeight ? { maxHeight: `${Math.max(resolverProvLocationDropdownMaxHeight - 72, 84)}px` } : undefined}
                                    >
                                      {!filterResolverProvLocationOptions(resolverProvSubdivisionOptions, (subdivision) => `${formatSubdivisionLocationLabel(subdivision)} ${String(subdivision?.division?.bodega?.sucursal?.nombre || '').trim()}`).length && (
                                        <small className="muted">Sin resultados.</small>
                                      )}
                                      {filterResolverProvLocationOptions(resolverProvSubdivisionOptions, (subdivision) => `${formatSubdivisionLocationLabel(subdivision)} ${String(subdivision?.division?.bodega?.sucursal?.nombre || '').trim()}`).map((subdivision) => (
                                        <button
                                          key={`resolver-prov-subdivision-option-${subdivision.id}`}
                                          type="button"
                                          className="create-user__result-option"
                                          onMouseDown={(event) => event.preventDefault()}
                                          onClick={(event) => { event.preventDefault(); event.stopPropagation(); handleResolverProvLocationPick('subdivision', subdivision.id) }}
                                          disabled={resolverSubmitting}
                                        >
                                          <div className="create-user__result-info">
                                            <strong>{String(subdivision?.nombre || `Subdivision ${subdivision.id}`).trim()}</strong>
                                            <small>{formatSubdivisionLocationLabel(subdivision)}</small>
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          {resolverProvSubdivisionsLoading ? (
                            <small className="transfer-issues-details__loading">
                              <Loader2 size={12} />
                              Cargando subdivisiones...
                            </small>
                          ) : null}
                          {!resolverProvSubdivisionsLoading && resolverProvNeedsManualLocation && !resolverProvSubdivisionId ? (
                            <small className="transfer-issues-details__manual-location-hint">
                              Este producto no tiene ubicación previa en la sucursal proveedora. Selecciona bodega, división y subdivisión.
                            </small>
                          ) : null}
                        </label>
                      )}

                      <label className="create-user__field create-user__field--full transfer-issues-details__field">
                        <span>Motivo o nota (opcional)</span>
                        <textarea
                          rows={3}
                          value={resolverMotivo}
                          onChange={(event) => setResolverMotivo(String(event.target.value || ''))}
                          disabled={resolverSubmitting}
                        />
                      </label>
                      {resolverError ? <p className="transfer-issues-details__error">{resolverError}</p> : null}
                      </>
                      )}
                    </>
                    )
                  ) : (
                    <p className="muted transfer-issues-details__hint">
                      Este registro ya fue procesado o no tienes permisos para resolverlo.
                    </p>
                  )}
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Seguimiento</p>
                      <h4>Historial</h4>
                    </div>
                  </div>
                  {!selectedHistoryRows.length ? (
                    <p className="muted transfer-issues-details__hint">Sin historial.</p>
                  ) : (
                    <div className="transfer-issues-details__history">
                      {selectedHistoryRows.map((item) => (
                        <article key={`issue-history-${selectedIssue?.row_key}-${item?.id}`} className="transfer-issues-details__history-item">
                          <strong>{formatHistorialAccion(item?.accion)}</strong>
                          <p>{String(item?.detalle || '-').trim() || '-'}</p>
                          <small>
                            {String(item?.actor_nombre || 'Sistema').trim()} - {formatDateTime(item?.created_at)}
                          </small>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              <footer className="create-user__footer">
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary"
                  onClick={closeDetails}
                  disabled={resolverSubmitting}
                >
                  Cerrar
                </button>
                {canResolveSelectedIssue ? (
                  <button
                    type="button"
                    className="create-user__action create-user__action--primary"
                    onClick={() => void submitResolver(selectedIssue?.tipo === 'otro' ? 'solucionado' : undefined)}
                    disabled={resolverSubmitting}
                  >
                    {resolverSubmitting
                      ? 'Guardando...'
                      : selectedIssue?.tipo === 'otro'
                        ? 'Solucionado'
                        : 'Confirmar decisión'}
                  </button>
                ) : null}
              </footer>
            </form>
            <button
              type="button"
              className="create-user__resize-handle"
              onMouseDown={handleResizeMouseDown}
              aria-label="Redimensionar modal"
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default TrasladosInconvenientesTable
