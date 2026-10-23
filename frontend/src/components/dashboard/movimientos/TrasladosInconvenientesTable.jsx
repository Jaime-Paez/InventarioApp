import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
import { attachAutoExpandColumns, autoFitTableColumns, makeWidthStateHandlers } from '../../../utils/autoFitColumns'
import { buildFileName, exportToExcel, exportToPdf } from '../../../utils/exportUtils'
import { getAppPortalRoot } from '../../../utils/portalRoot'
import { useCloseDropdownsOnTabSwitch } from '../../../hooks/useCloseDropdownsOnTabSwitch'
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
const PRODUCTS_HOVER_CARD_WIDTH = 560
const PRODUCTS_HOVER_CARD_MARGIN = 12
const PRODUCTS_HOVER_CARD_MAX_HEIGHT = 520
const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const STATUS_FILTERS = [
  { key: 'all', label: 'Todos' },
  { key: 'pendiente', label: 'Pendientes' },
  { key: 'reclamado', label: 'Reclamados' },
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
  if (normalized === 'reclamado') return 'Reclamado'
  if (normalized === 'resuelto') return 'Resuelto'
  if (normalized === 'perdido') return 'Perdido'
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : '-'
}

const formatResolucion = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'sumar_solicitante') return 'Sumado a sucursal destino'
  if (normalized === 'sumado_sucursal') return 'Sumado a sucursal destino'
  if (normalized === 'sumado_origen') return 'Sumado a la sucursal de origen'
  if (normalized === 'sumar_proveedora') return 'Sumado a sucursal proveedora'
  if (normalized === 'perdido') return 'Marcado como desaparecido'
  if (normalized === 'restar_proveedora') return 'Restado de sucursal proveedora'
  if (normalized === 'sin_cambios') return 'Sin cambios de inventario'
  if (normalized === 'reportado_proveedor') return 'Reportado al proveedor'
  if (normalized === 'aceptado') return 'Aceptado sin cambios'
  if (normalized === 'devolver_proveedor') return 'Devuelto al proveedor'
  if (normalized === 'reposicion_acordada') return 'Reposición acordada'
  return '-'
}

const ACTIVE_ISSUE_STATES = new Set(['pendiente', 'reclamado'])
const isActiveIssue = (issue) => ACTIVE_ISSUE_STATES.has(String(issue?.estado_key || issue?.estado || '').trim().toLowerCase())

// Un inconveniente por documento (traslado, envio o importacion): la tabla
// muestra el documento y dentro se resuelve cada producto.
const getIssueGroupKey = (row) => {
  if (row?.origen === 'importacion') {
    return `importacion-${normalizeId(row?.importacion_id) || normalizeId(row?.solicitud_no_documento)}`
  }
  return `traslado-${normalizeId(row?.solicitud_id) || normalizeId(row?.solicitud_no_documento)}`
}

const getIssueGroupState = (items) => {
  const states = items.map((item) => String(item?.estado_key || '').trim().toLowerCase())
  if (states.includes('pendiente')) return 'pendiente'
  if (states.includes('reclamado')) return 'reclamado'
  if (states.length && states.every((state) => state === 'perdido')) return 'perdido'
  return 'resuelto'
}

const getIssueProductLabel = (item) =>
  item?.tipo === 'otro'
    ? 'Otro inconveniente'
    : `${String(item?.producto_codigo || '-').trim()} - ${String(item?.producto_nombre || '-').trim()}`

const DECISION_LABELS = {
  sumar_solicitante: 'Sumar a sucursal destino',
  sumar_proveedora: 'Sumar a sucursal proveedora',
  sumar_origen: 'Sumar a Matriz (origen)',
  perdido: 'Marcar como desaparecido',
  devolver_proveedora: 'Devolver a la sucursal proveedora',
  sin_cambios: 'Mantener en la sucursal destino',
  aceptado: 'No hacer nada',
  reportado_proveedor: 'Generar un reclamo al proveedor',
  devolver_proveedor: 'Devolver a proveedor',
  olvidar: 'Olvidar proceso',
  solucion: 'Solución acordada con el proveedor',
  solucionado: 'Solucionado',
}

const DECISION_HINTS = {
  sumar_solicitante: 'Las unidades sí llegaron: se suman al inventario de la sucursal destino en esta ubicación.',
  sumar_proveedora: 'Las unidades nunca salieron: se suman de vuelta en la sucursal proveedora en esta ubicación.',
  sumar_origen: 'Las unidades nunca salieron de la sucursal desde la que se envió la importación: se suman ahí en esta ubicación.',
  perdido: 'Las unidades se dan de baja como pérdida. No se ajusta inventario en ninguna sucursal.',
  devolver_proveedora: 'Se restan las unidades sobrantes de la sucursal destino y se suman de vuelta en la sucursal proveedora.',
  sin_cambios: 'Las unidades sobrantes se quedan en la sucursal destino. No se mueve inventario.',
  aceptado: 'Se acepta tal cual. No se ajusta inventario ni se reclama al proveedor.',
  reportado_proveedor: "El inconveniente pasa a 'Reclamado' y sigue activo hasta acordar una solución con el proveedor.",
  devolver_proveedor: 'El excedente queda marcado como devuelto al proveedor. No se ajusta inventario.',
  olvidar: 'El reclamo se cierra como perdido / no recuperable.',
  solucion: 'Registra la cantidad que enviará el proveedor y la fecha de entrega acordada.',
  solucionado: 'Escribe cómo se solucionó este inconveniente.',
}

// Sin nota no se acepta: queda constancia de que paso.
const NOTE_REQUIRED_DECISIONS = new Set(['perdido', 'solucionado'])

const LOCATION_DECISIONS = new Set(['sumar_solicitante', 'sumar_proveedora', 'sumar_origen', 'devolver_proveedora'])

const option = (key, label, variant) => ({ key, label, variant, tooltip: DECISION_HINTS[key] })

// Opciones de cada producto segun de donde viene el inconveniente.
const getDecisionOptions = (issue) => {
  if (!issue || !isActiveIssue(issue)) return []
  if (issue.tipo === 'otro') return [option('solucionado', 'Solucionar', 'success')]
  if (issue.origen === 'importacion' && !issue.envio_id) {
    if (String(issue.estado || '').toLowerCase() === 'reclamado') {
      return [option('olvidar', 'Olvidar proceso', 'neutral'), option('solucion', 'Solución acordada', 'warning')]
    }
    return issue.tipo === 'sobrante'
      ? [option('devolver_proveedor', 'Devolver a proveedor', 'warning'), option('aceptado', 'No hacer nada', 'neutral')]
      : [option('aceptado', 'No hacer nada', 'neutral'), option('reportado_proveedor', 'Reclamar al proveedor', 'warning')]
  }
  if (issue.tipo === 'sobrante') {
    return [option('devolver_proveedora', 'Devolver', 'warning'), option('sin_cambios', 'Mantener', 'neutral')]
  }
  const options = []
  if (issue.envio_id) {
    if (issue.sucursal_origen_id) options.push(option('sumar_origen', 'Sumar a Matriz', 'primary'))
  } else {
    options.push(option('sumar_proveedora', 'Sumar a proveedora', 'primary'))
  }
  options.push(option('sumar_solicitante', 'Sumar a destino', 'success'))
  options.push(option('perdido', 'Desaparecido', 'danger'))
  return options
}

const hasDraftDecision = (draft) => Boolean(draft?.decision)

const describeDraft = (draft) => {
  if (!draft?.decision) return ''
  const parts = [DECISION_LABELS[draft.decision] || draft.decision]
  if (draft.decision === 'devolver_proveedora') {
    if (draft.subdivision_label) parts.push(`restar de ${draft.subdivision_label}`)
    if (draft.subdivision_proveedora_label) parts.push(`devolver a ${draft.subdivision_proveedora_label}`)
  } else if (draft.subdivision_label) {
    parts.push(draft.subdivision_label)
  }
  if (draft.decision === 'solucion' && draft.cantidad_prometida) {
    parts.push(`${draft.cantidad_prometida} u. para el ${draft.fecha_entrega_prometida || '-'}`)
  }
  return parts.join(' · ')
}

const getIssueBranchLabel = (issue) => {
  if (issue?.origen === 'importacion' && !issue?.envio_id) return 'Llegada desde la casa comercial'
  return String(issue?.sucursal_solicitante || '').trim() || 'Sin sucursal'
}

const formatIssueQty = (issue) =>
  `${issue?.tipo === 'sobrante' ? '+' : '−'}${Number.parseInt(String(issue?.cantidad_faltante || 0), 10) || 0}`

const buildIssueGroups = (list) => {
  const groups = new Map()
  ;(Array.isArray(list) ? list : []).forEach((row) => {
    const key = getIssueGroupKey(row)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  })
  return Array.from(groups.entries()).map(([key, items]) => {
    const first = items[0]
    const state = getIssueGroupState(items)
    const activos = items.filter(isActiveIssue).length
    const cerrados = items.length - activos
    const latest = items.reduce(
      (acc, item) => (new Date(item?.created_at || 0).getTime() > new Date(acc?.created_at || 0).getTime() ? item : acc),
      first
    )
    return {
      id: key,
      row_key: key,
      items,
      origen: first?.origen,
      origen_label: first?.origen_label,
      solicitud_id: first?.solicitud_id,
      solicitud_no_documento: first?.solicitud_no_documento,
      movimiento_entrada_id: first?.movimiento_entrada_id,
      sucursal_solicitante_id: first?.sucursal_solicitante_id,
      sucursal_proveedora: first?.sucursal_proveedora,
      // Una importacion puede haber ido a varias sucursales.
      sucursal_solicitante:
        [...new Set(items.map((item) => String(item?.sucursal_solicitante || '').trim()).filter((name) => name && name !== '-'))].join(', ') || '-',
      productos_count: items.length,
      productos_resumen: items.map(getIssueProductLabel).join(' | '),
      productos_busqueda: items
        .map((item) => [item?.producto_codigo, item?.producto_nombre, item?.producto_busqueda, item?.motivo].filter(Boolean).join(' '))
        .join(' '),
      cantidad_faltante: items.reduce((acc, item) => acc + Math.abs(Number(item?.cantidad_faltante) || 0), 0),
      estado_key: state,
      estado_label: formatEstado(state),
      resolucion_label:
        items.length === 1
          ? first?.resolucion_label
          : cerrados
            ? `${cerrados} de ${items.length} resueltos`
            : '-',
      created_at: latest?.created_at,
      created_at_label: latest?.created_at_label,
    }
  }).sort((a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime())
}

const createInitialFilters = () => ({
  global: { value: null, matchMode: FilterMatchMode.CONTAINS },
})

const selectionColStyle = {
  textAlign: 'center',
  padding: 0,
}

function DecisionButton({ variant, label, tooltip, active, onClick, disabled }) {
  return (
    <button
      type="button"
      className={`create-user__action create-user__action--secondary transfer-issues-details__decision-btn transfer-issues-details__decision-btn--${variant}${
        active ? ' is-active' : ''
      } cell-tooltip`}
      data-pr-tooltip={tooltip}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  )
}

function TrasladosInconvenientesTable({
  token,
  moduleActions,
  pendingOpenSolicitudId,
  onPendingOpenHandled,
  onOpenTransferRequestInEntradas,
}) {
  const toast = useRef(null)
  const opColumns = useRef(null)
  const tableWrapperRef = useRef(null)
  const productHoverCardRef = useRef(null)
  const productHoverHideTimeoutRef = useRef(null)
  const [productHoverCard, setProductHoverCard] = useState(null)

  // Ajusta automaticamente el ancho de las columnas para llenar el espacio
  // disponible en pantallas grandes, sin comprimir en pantallas chicas.
  useEffect(() => attachAutoExpandColumns(tableWrapperRef.current), [])
  const widthHandlers = useMemo(() => makeWidthStateHandlers('traslados-inconvenientes-table-state-v3'), [])
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
      { nombrevar: 'productos_resumen', header: 'Productos', filterPlaceholder: 'Buscar por producto' },
      { nombrevar: 'cantidad_faltante', header: 'Unidades', filterPlaceholder: 'Buscar por unidades' },
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
  const [processedRows, setProcessedRows] = useState(null)
  const [selectedRows, setSelectedRows] = useState([])

  // `selectedIssue` = el producto cuya solucion se esta eligiendo.
  const [selectedIssue, setSelectedIssue] = useState(null)
  const [openedGroup, setOpenedGroup] = useState(null)
  const [groupIssues, setGroupIssues] = useState([])
  const [groupLoading, setGroupLoading] = useState(false)
  const [drafts, setDrafts] = useState({})
  const [collapsedBranches, setCollapsedBranches] = useState({})
  const [decisionDialogOpen, setDecisionDialogOpen] = useState(false)
  const [applyConfirm, setApplyConfirm] = useState(null)
  const [savingDrafts, setSavingDrafts] = useState(false)
  const draftsRef = useRef({})
  const dirtyDraftKeysRef = useRef(new Set())
  const groupIssuesRef = useRef([])
  // Ubicacion ya elegida en el borrador: se precarga al volver a abrirlo.
  const resolverPresetRef = useRef({ main: '', prov: '' })
  const [showDetailsModal, setShowDetailsModal] = useState(false)
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })
  const [isMaximized, setIsMaximized] = useState(false)
  const [isResizingModal, setIsResizingModal] = useState(false)
  const [resolverDecision, setResolverDecision] = useState('')
  const [resolverMotivo, setResolverMotivo] = useState('')
  const [resolverCantidadPrometida, setResolverCantidadPrometida] = useState('')
  const [resolverFechaPrometida, setResolverFechaPrometida] = useState('')
  const [resolverBodegaId, setResolverBodegaId] = useState('')
  const [resolverDivisionId, setResolverDivisionId] = useState('')
  const [resolverSubdivisionId, setResolverSubdivisionId] = useState('')
  const [resolverSubdivisions, setResolverSubdivisions] = useState([])
  const [resolverSubdivisionsLoading, setResolverSubdivisionsLoading] = useState(false)
  const [resolverNeedsManualLocation, setResolverNeedsManualLocation] = useState(false)
  const [resolverLocationDropdownField, setResolverLocationDropdownField] = useState('')
  const [resolverLocationDropdownDirection, setResolverLocationDropdownDirection] = useState('down')
  const [resolverLocationDropdownMaxHeight, setResolverLocationDropdownMaxHeight] = useState(null)
  const [resolverLocationDropdownStyle, setResolverLocationDropdownStyle] = useState({})
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
  const [resolverProvLocationDropdownStyle, setResolverProvLocationDropdownStyle] = useState({})
  const [resolverProvLocationQuery, setResolverProvLocationQuery] = useState('')
  const [resolverProvLocationDebouncedQuery, setResolverProvLocationDebouncedQuery] = useState('')
  const modalRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalResize = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const modalSizeRef = useRef(modalSize)
  const modalPositionRef = useRef(modalPosition)
  const modalRestoreRef = useRef(null)
  const resolverLocationDropdownRef = useRef(null)
  const resolverLocationDropdownPanelRef = useRef(null)
  const resolverProvLocationDropdownRef = useRef(null)
  const resolverProvLocationDropdownPanelRef = useRef(null)

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
          // Faltante del envio a una sucursal: esa es la sucursal destino.
          sucursal_solicitante: String(row?.sucursal_solicitante_nombre || '').trim() || '-',
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
    const stored = tableLayoutStore.getItem('traslados-inconvenientes-table-columns-v2')
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        const columnsByField = new Map(columnsData.map((column) => [column.nombrevar, column]))
        const restored = (Array.isArray(parsed) ? parsed : [])
          .map((column) => columnsByField.get(column?.nombrevar))
          .filter(Boolean)
        setSelectedColumns(restored.length ? restored : columnsData)
      } catch {
        tableLayoutStore.removeItem('traslados-inconvenientes-table-columns-v2')
      }
    }
    // No cleanup-based flush here: handleCheckboxChangeColumn already
    // persists synchronously on every real change.
  }, [columnsData])

  const groupedRows = useMemo(() => buildIssueGroups(rows), [rows])
  const selectedGroup = openedGroup

  const selectedRowIds = useMemo(
    () => new Set((selectedRows || []).map((row) => row?.row_key).filter(Boolean)),
    [selectedRows]
  )

  const resolverTargetBranchId = useMemo(() => {
    if (!selectedIssue) return ''
    if (resolverDecision === 'sumar_solicitante' || resolverDecision === 'devolver_proveedora') return normalizeId(selectedIssue?.sucursal_solicitante_id)
    if (resolverDecision === 'sumar_proveedora' || resolverDecision === 'restar_proveedora') return normalizeId(selectedIssue?.sucursal_proveedora_id)
    if (resolverDecision === 'sumar_origen') return normalizeId(selectedIssue?.sucursal_origen_id)
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
    if (resolverDecision === 'sumar_origen') {
      return String(selectedIssue?.sucursal_origen_nombre || '').trim() || 'Matriz'
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

        const presetSubdivisionId = normalizeId(resolverPresetRef.current.main)
        if (presetSubdivisionId && availableSubdivisionIds.has(presetSubdivisionId)) {
          preferredSubdivisionId = presetSubdivisionId
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

        const presetProvSubdivisionId = normalizeId(resolverPresetRef.current.prov)
        if (presetProvSubdivisionId && availableSubdivisionIds.has(presetProvSubdivisionId)) {
          preferredSubdivisionId = presetProvSubdivisionId
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
    setResolverCantidadPrometida('')
    setResolverFechaPrometida('')
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

  const replaceDrafts = useCallback((next) => {
    draftsRef.current = next
    setDrafts(next)
  }, [])

  const setDraftValue = useCallback((key, value) => {
    const next = { ...draftsRef.current }
    if (value && Object.keys(value).length) next[key] = value
    else delete next[key]
    dirtyDraftKeysRef.current.add(key)
    replaceDrafts(next)
  }, [replaceDrafts])

  const applyGroupIssues = useCallback((list) => {
    const sorted = [...list].sort((a, b) => {
      const branch = getIssueBranchLabel(a).localeCompare(getIssueBranchLabel(b), 'es', { sensitivity: 'base' })
      if (branch) return branch
      return String(a?.producto_codigo || '').localeCompare(String(b?.producto_codigo || ''), 'es', { sensitivity: 'base' })
    })
    groupIssuesRef.current = sorted
    setGroupIssues(sorted)
    const next = {}
    sorted.forEach((issue) => {
      if (!isActiveIssue(issue)) return
      const saved = issue?.borrador && typeof issue.borrador === 'object' ? issue.borrador : {}
      if (Object.keys(saved).length) next[issue.row_key] = saved
    })
    dirtyDraftKeysRef.current = new Set()
    replaceDrafts(next)
    return sorted
  }, [replaceDrafts])

  // Todos los productos del documento (tambien los ya resueltos).
  const loadGroupIssues = useCallback(
    async (group) => {
      const first = group?.items?.[0]
      if (!token || !first) return []
      setGroupLoading(true)
      try {
        const url =
          group.origen === 'importacion'
            ? `${API_URL}/importaciones/importaciones/inconvenientes/?importacion_id=${encodeURIComponent(normalizeId(first?.importacion_id))}`
            : `${API_URL}/movimientos/movimiento_inventario/traslados-inconvenientes/?solicitud_id=${encodeURIComponent(normalizeId(first?.solicitud_id))}`
        const response = await authFetch(url, {}, token)
        if (!response.ok) throw new Error('No se pudieron cargar los productos de este inconveniente.')
        const list = parseApiList(await response.json().catch(() => []))
        return applyGroupIssues(group.origen === 'importacion' ? normalizeImportacionRows(list) : normalizeRows(list))
      } catch (requestError) {
        showErrorToast(requestError?.message || 'No se pudieron cargar los productos de este inconveniente.')
        return groupIssuesRef.current
      } finally {
        setGroupLoading(false)
      }
    },
    [applyGroupIssues, normalizeImportacionRows, normalizeRows, showErrorToast, token]
  )

  const openDetails = useCallback(
    (group) => {
      setOpenedGroup(group || null)
      setSelectedIssue(null)
      setDecisionDialogOpen(false)
      setApplyConfirm(null)
      setCollapsedBranches({})
      applyGroupIssues(Array.isArray(group?.items) ? group.items : [])
      setShowDetailsModal(true)
      setIsMaximized(false)
      setIsResizingModal(false)
      modalRestoreRef.current = null
      modalDrag.current.active = false
      modalResize.current.active = false
      resetResolverState()
      void loadGroupIssues(group)
    },
    [applyGroupIssues, loadGroupIssues, resetResolverState]
  )

  useEffect(() => {
    if (!pendingOpenSolicitudId || !groupedRows.length) return
    const match = groupedRows.find(
      (group) => group.origen === 'traslado' && normalizeId(group.solicitud_id) === normalizeId(pendingOpenSolicitudId)
    )
    if (!match) return
    openDetails(match)
    onPendingOpenHandled?.()
  }, [pendingOpenSolicitudId, groupedRows, openDetails, onPendingOpenHandled])

  // Guarda en la base los borradores cambiados (o los de `keys`). Nada se
  // queda solo en el navegador.
  const saveDrafts = useCallback(
    async (keys) => {
      const targetKeys = Array.isArray(keys) ? keys : Array.from(dirtyDraftKeysRef.current)
      const issuesByKey = new Map(groupIssuesRef.current.map((issue) => [issue.row_key, issue]))
      const items = targetKeys
        .map((key) => {
          const issue = issuesByKey.get(key)
          if (!issue || !isActiveIssue(issue)) return null
          return { id: Number(issue.id), borrador: draftsRef.current[key] || {} }
        })
        .filter(Boolean)
      targetKeys.forEach((key) => dirtyDraftKeysRef.current.delete(key))
      if (!token || !items.length) return true
      const origen = issuesByKey.get(targetKeys.find((key) => issuesByKey.has(key)))?.origen
      const url =
        origen === 'importacion'
          ? `${API_URL}/importaciones/importaciones/inconvenientes/borradores/`
          : `${API_URL}/movimientos/movimiento_inventario/traslados-inconvenientes/borradores/`
      try {
        const response = await authFetch(url, { method: 'POST', body: JSON.stringify({ items }) }, token)
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw new Error(String(payload?.detail || '').trim() || 'No se pudieron guardar los cambios.')
        }
        return true
      } catch (requestError) {
        targetKeys.forEach((key) => dirtyDraftKeysRef.current.add(key))
        showErrorToast(requestError?.message || 'No se pudieron guardar los cambios.')
        return false
      }
    },
    [showErrorToast, token]
  )

  const openDecision = useCallback(
    (issue, decision) => {
      if (!issue || !decision) return
      const draft = draftsRef.current[issue.row_key]
      const same = draft?.decision === decision
      resetResolverState()
      resolverPresetRef.current = {
        main: same ? normalizeId(draft?.subdivision_id) : '',
        prov: same ? normalizeId(draft?.subdivision_proveedora_id) : '',
      }
      setSelectedIssue(issue)
      setResolverDecision(decision)
      setResolverMotivo(String(draft?.motivo || ''))
      if (same && decision === 'solucion') {
        setResolverCantidadPrometida(String(draft?.cantidad_prometida || ''))
        setResolverFechaPrometida(String(draft?.fecha_entrega_prometida || ''))
      }
      setDecisionDialogOpen(true)
    },
    [resetResolverState]
  )

  const closeDecisionDialog = useCallback(() => {
    setDecisionDialogOpen(false)
    resolverPresetRef.current = { main: '', prov: '' }
    resetResolverState()
    setSelectedIssue(null)
  }, [resetResolverState])

  const removeDraft = useCallback(
    (issue) => {
      if (!issue) return
      setDraftValue(issue.row_key, null)
      void saveDrafts([issue.row_key])
    },
    [saveDrafts, setDraftValue]
  )

  const toggleBranch = useCallback((key) => {
    setCollapsedBranches((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

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
    if (dirtyDraftKeysRef.current.size) void saveDrafts()
    setDecisionDialogOpen(false)
    setApplyConfirm(null)
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
  }, [resolverSubmitting, saveDrafts])

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
    // Se renderiza con un portal a getAppPortalRoot() para que no quede
    // detras de los campos de Bodega/Division/Subdivision que le siguen
    // dentro del mismo contenedor.
    setResolverLocationDropdownStyle(
      nextDirection === 'up'
        ? {
            position: 'fixed',
            top: 'auto',
            bottom: Math.max(window.innerHeight - triggerRect.top + spacing, VIEWPORT_PADDING),
            left: triggerRect.left,
            width: triggerRect.width,
            maxHeight: `${nextMaxHeight}px`,
            zIndex: 12000,
          }
        : {
            position: 'fixed',
            top: triggerRect.bottom + spacing,
            bottom: 'auto',
            left: triggerRect.left,
            width: triggerRect.width,
            maxHeight: `${nextMaxHeight}px`,
            zIndex: 12000,
          }
    )
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
      const touched =
        (resolverLocationDropdownRef.current && resolverLocationDropdownRef.current.contains(event.target)) ||
        (resolverLocationDropdownPanelRef.current && resolverLocationDropdownPanelRef.current.contains(event.target))
      if (!touched) {
        closeResolverLocationDropdown()
      }
    }
    window.addEventListener('mousedown', handleClick, true)
    return () => window.removeEventListener('mousedown', handleClick, true)
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
    setResolverProvLocationDropdownStyle(
      nextDirection === 'up'
        ? {
            position: 'fixed',
            top: 'auto',
            bottom: Math.max(window.innerHeight - triggerRect.top + spacing, VIEWPORT_PADDING),
            left: triggerRect.left,
            width: triggerRect.width,
            maxHeight: `${nextMaxHeight}px`,
            zIndex: 12000,
          }
        : {
            position: 'fixed',
            top: triggerRect.bottom + spacing,
            bottom: 'auto',
            left: triggerRect.left,
            width: triggerRect.width,
            maxHeight: `${nextMaxHeight}px`,
            zIndex: 12000,
          }
    )
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
      const touched =
        (resolverProvLocationDropdownRef.current && resolverProvLocationDropdownRef.current.contains(event.target)) ||
        (resolverProvLocationDropdownPanelRef.current && resolverProvLocationDropdownPanelRef.current.contains(event.target))
      if (!touched) {
        closeResolverProvLocationDropdown()
      }
    }
    window.addEventListener('mousedown', handleClick, true)
    return () => window.removeEventListener('mousedown', handleClick, true)
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

  useCloseDropdownsOnTabSwitch(
    useCallback(() => {
      closeResolverLocationDropdown()
      closeResolverProvLocationDropdown()
    }, [closeResolverLocationDropdown, closeResolverProvLocationDropdown])
  )

  const clearFilter = useCallback(() => {
    setFilters(createInitialFilters())
    setGlobalFilterValue('')
  }, [])

  const autoFitColumns = useCallback(() => {
    autoFitTableColumns(tableWrapperRef.current, 'traslados-inconvenientes-table-state-v3')
  }, [])

  const handleResetTable = () => {
    tableLayoutStore.removeItem('traslados-inconvenientes-table-columns-v2')
    tableLayoutStore.removeItem('traslados-inconvenientes-table-state-v3')
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
        tableLayoutStore.setItemNow('traslados-inconvenientes-table-columns-v2', JSON.stringify(next))
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
    return groupedRows
  }, [groupedRows, processedRows, selectedRows])

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

  const acceptDecision = useCallback(() => {
    const issue = selectedIssue
    const decision = resolverDecision
    if (!issue || !decision) return
    const motivo = String(resolverMotivo || '').trim()
    const draft = { decision }
    if (motivo) draft.motivo = motivo
    if (LOCATION_DECISIONS.has(decision)) {
      if (!normalizeId(resolverSubdivisionId)) {
        setResolverError(
          decision === 'devolver_proveedora'
            ? 'Selecciona la ubicación de la sucursal destino de donde restar el sobrante.'
            : 'Selecciona bodega, división y subdivisión.'
        )
        return
      }
      draft.subdivision_id = Number.parseInt(String(resolverSubdivisionId), 10)
      draft.subdivision_label = formatSubdivisionLocationLabel(selectedResolverSubdivision)
      if (decision === 'devolver_proveedora') {
        if (!normalizeId(resolverProvSubdivisionId)) {
          setResolverError('Selecciona la ubicación de la sucursal proveedora donde devolver el sobrante.')
          return
        }
        draft.subdivision_proveedora_id = Number.parseInt(String(resolverProvSubdivisionId), 10)
        draft.subdivision_proveedora_label = formatSubdivisionLocationLabel(selectedResolverProvSubdivision)
      }
    }
    if (decision === 'solucion') {
      const cantidad = Number.parseInt(String(resolverCantidadPrometida || ''), 10)
      if (!Number.isFinite(cantidad) || cantidad <= 0) {
        setResolverError('Indica la cantidad que enviará el proveedor.')
        return
      }
      if (!resolverFechaPrometida) {
        setResolverError('Indica la fecha de entrega acordada.')
        return
      }
      draft.cantidad_prometida = cantidad
      draft.fecha_entrega_prometida = resolverFechaPrometida
    }
    if (NOTE_REQUIRED_DECISIONS.has(decision) && !motivo) {
      setResolverError(
        decision === 'perdido'
          ? 'Escribe qué pasó con las unidades desaparecidas.'
          : 'Escribe cómo se solucionó este inconveniente.'
      )
      return
    }
    setDraftValue(issue.row_key, draft)
    void saveDrafts([issue.row_key])
    closeDecisionDialog()
  }, [
    closeDecisionDialog,
    resolverCantidadPrometida,
    resolverDecision,
    resolverFechaPrometida,
    resolverMotivo,
    resolverProvSubdivisionId,
    resolverSubdivisionId,
    saveDrafts,
    selectedIssue,
    selectedResolverProvSubdivision,
    selectedResolverSubdivision,
    setDraftValue,
  ])

  const resolveIssueWithDraft = useCallback(
    async (issue, draft) => {
      const isImportacion = issue?.origen === 'importacion'
      const body = { decision: draft.decision, motivo: String(draft.motivo || '').trim() }
      if (draft.subdivision_id) body.subdivision_id = draft.subdivision_id
      if (draft.subdivision_proveedora_id) body.subdivision_proveedora_id = draft.subdivision_proveedora_id
      if (draft.decision === 'solucion') {
        body.cantidad_prometida = draft.cantidad_prometida
        body.fecha_entrega_prometida = draft.fecha_entrega_prometida
      }
      const endpoint = isImportacion
        ? `${API_URL}/importaciones/importaciones/inconvenientes/${encodeURIComponent(normalizeId(issue?.id))}/resolver/`
        : `${API_URL}/movimientos/movimiento_inventario/traslados-inconvenientes/${encodeURIComponent(normalizeId(issue?.id))}/resolver/`
      const response = await authFetch(endpoint, { method: 'POST', body: JSON.stringify(body) }, token)
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(String(payload?.detail || '').trim() || 'No se pudo resolver.')
      }
    },
    [token]
  )

  const runApply = useCallback(
    async (toApply) => {
      setApplyConfirm(null)
      if (!toApply.length) return
      setResolverSubmitting(true)
      await saveDrafts()
      const failures = []
      let applied = 0
      for (const issue of toApply) {
        try {
          await resolveIssueWithDraft(issue, draftsRef.current[issue.row_key] || {})
          applied += 1
        } catch (requestError) {
          failures.push(`${String(issue?.producto_codigo || 'Producto').trim()}: ${requestError?.message || 'No se pudo resolver.'}`)
        }
      }
      setResolverSubmitting(false)
      if (applied) showSuccessToast(applied === 1 ? 'Se aplicó 1 solución.' : `Se aplicaron ${applied} soluciones.`)
      if (failures.length) showErrorToast(failures.join(' | '), 'No se pudieron aplicar')
      void fetchRows({ withOverlay: false })
      void fetchRemindersFromBackend(token).catch(() => {})
      const refreshed = await loadGroupIssues(openedGroup)
      if (!failures.length && !refreshed.some(isActiveIssue)) setShowDetailsModal(false)
    },
    [fetchRows, loadGroupIssues, openedGroup, resolveIssueWithDraft, saveDrafts, showErrorToast, showSuccessToast, token]
  )

  // Aplica solo los productos con solucion; si quedan otros sin solucion,
  // primero se muestra cuales se aplican y cuales quedan para despues.
  const requestApply = useCallback(() => {
    const active = groupIssuesRef.current.filter(isActiveIssue)
    const toApply = active.filter((issue) => hasDraftDecision(draftsRef.current[issue.row_key]))
    const sinSolucion = active.filter((issue) => !hasDraftDecision(draftsRef.current[issue.row_key]))
    if (!toApply.length) {
      showWarningToast('Todavía no elegiste la solución de ningún producto.')
      return
    }
    if (sinSolucion.length) {
      setApplyConfirm({ toApply, sinSolucion })
      return
    }
    void runApply(toApply)
  }, [runApply, showWarningToast])

  const handleSaveDrafts = useCallback(async () => {
    setSavingDrafts(true)
    const ok = await saveDrafts(groupIssuesRef.current.filter(isActiveIssue).map((issue) => issue.row_key))
    setSavingDrafts(false)
    if (!ok) return
    showSuccessToast('Cambios guardados. Puedes aplicarlos más tarde.')
    setShowDetailsModal(false)
  }, [saveDrafts, showSuccessToast])

  useEffect(() => {
    modalSizeRef.current = modalSize
  }, [modalSize])

  useEffect(() => {
    modalPositionRef.current = modalPosition
  }, [modalPosition])

  useLayoutEffect(() => {
    if (!showDetailsModal || isMaximized) return
    const { availableWidth, availableHeight, minWidth, minHeight } = getViewportMetrics()
    const width = Math.min(Math.max(940, minWidth), availableWidth)
    const height = Math.min(Math.max(640, minHeight), availableHeight)
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
        <span className="users-header__count">Reg. {groupedRows.length}</span>
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
    (event, items) => {
      const list = Array.isArray(items) ? items : []
      if (!list.length) {
        hideProductHoverCard()
        return
      }
      clearProductHoverHideTimer()
      const rect = event?.currentTarget?.getBoundingClientRect?.()
      if (!rect) return
      let left = rect.right + 10
      if (left + PRODUCTS_HOVER_CARD_WIDTH > window.innerWidth - PRODUCTS_HOVER_CARD_MARGIN) {
        left = Math.max(PRODUCTS_HOVER_CARD_MARGIN, rect.left - PRODUCTS_HOVER_CARD_WIDTH - 10)
      }
      const estimatedCardHeight = 32 + 24 + list.length * 27 + 12
      const cardHeight = Math.min(estimatedCardHeight, PRODUCTS_HOVER_CARD_MAX_HEIGHT, window.innerHeight * 0.7)
      const maxTop = Math.max(window.innerHeight - cardHeight - PRODUCTS_HOVER_CARD_MARGIN, PRODUCTS_HOVER_CARD_MARGIN)
      const top = Math.min(Math.max(rect.top - 8, PRODUCTS_HOVER_CARD_MARGIN), maxTop)
      setProductHoverCard({ left, top, items: list })
    },
    [clearProductHoverHideTimer, hideProductHoverCard]
  )

  useEffect(() => () => clearProductHoverHideTimer(), [clearProductHoverHideTimer])

  useEffect(() => {
    const handleScroll = (event) => {
      if (productHoverCardRef.current && event.target && productHoverCardRef.current.contains(event.target)) return
      hideProductHoverCard()
    }
    window.addEventListener('scroll', handleScroll, true)
    return () => window.removeEventListener('scroll', handleScroll, true)
  }, [hideProductHoverCard])

  const productosBodyTemplate = useCallback((group) => {
    const items = Array.isArray(group?.items) ? group.items : []
    if (!items.length) return <span style={{ color: '#9ca3af' }}>-</span>
    const codes = items.map((item) => (item?.tipo === 'otro' ? 'Otro' : String(item?.producto_codigo || '').trim())).filter(Boolean)
    const label = codes.length > 2 ? `${codes.slice(0, 2).join(', ')}...` : codes.join(', ')
    const tooltip =
      items.length === 1
        ? [getIssueProductLabel(items[0]), String(items[0]?.motivo || '').trim()].filter(Boolean).join(' | ')
        : `${items.length} productos`
    return (
      <div className="movimientos-table__product-cell">
        <div className="movimientos-table__product-lines">
          <span className="cell-tooltip movimientos-table__product-main" data-pr-tooltip={tooltip}>
            {label || '-'}
          </span>
        </div>
        {items.length > 1 ? (
          <button
            type="button"
            className="movimientos-table__product-eye"
            aria-label="Ver todos los productos"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onMouseEnter={(event) => showProductHoverCard(event, items)}
            onMouseLeave={scheduleHideProductHoverCard}
            onFocus={(event) => showProductHoverCard(event, items)}
            onBlur={scheduleHideProductHoverCard}
          >
            <i className="pi pi-eye" />
          </button>
        ) : null}
      </div>
    )
  }, [scheduleHideProductHoverCard, showProductHoverCard])

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
  const modalTitle = `Inconveniente: ${String(selectedGroup?.solicitud_no_documento || selectedIssue?.solicitud_no_documento || '-').trim() || '-'}`
  const groupItems = groupIssues.length ? groupIssues : Array.isArray(selectedGroup?.items) ? selectedGroup.items : []
  const groupActiveCount = groupItems.filter(isActiveIssue).length
  const groupDraftCount = groupItems.filter((item) => isActiveIssue(item) && hasDraftDecision(drafts[item.row_key])).length
  const groupFirst = groupItems[0] || null
  const isImportacionGroup = selectedGroup?.origen === 'importacion'
  const branchSections = []
  groupItems.forEach((item) => {
    const label = getIssueBranchLabel(item)
    let section = branchSections.find((entry) => entry.key === label)
    if (!section) {
      section = { key: label, label, items: [], done: 0, pending: 0 }
      branchSections.push(section)
    }
    section.items.push(item)
    if (!isActiveIssue(item) || hasDraftDecision(drafts[item.row_key])) section.done += 1
    else section.pending += 1
  })

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
          value={groupedRows}
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
            'origen_label',
            'solicitud_no_documento',
            'productos_resumen',
            'productos_busqueda',
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
            if (field === 'productos_resumen') {
              bodyTemplate = productosBodyTemplate
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

        {Array.isArray(productHoverCard?.items) && productHoverCard.items.length > 0 && (
          <div
            ref={productHoverCardRef}
            className="movimientos-table__product-hover-card transfer-issues-hover-card"
            role="tooltip"
            style={{ top: productHoverCard.top, left: productHoverCard.left }}
            onMouseEnter={clearProductHoverHideTimer}
            onMouseLeave={scheduleHideProductHoverCard}
          >
            <div className="movimientos-table__product-hover-title">{`Productos con inconveniente (${productHoverCard.items.length})`}</div>
            <table className="movimientos-table__product-hover-table">
              <thead>
                <tr>
                  <th>Codigo</th>
                  <th>Producto</th>
                  <th>Sucursal</th>
                  <th className="movimientos-table__product-hover-qty">Cant.</th>
                </tr>
              </thead>
              <tbody>
                {productHoverCard.items.map((item) => (
                  <tr key={`issue-hover-${item.row_key}`}>
                    <td title={String(item?.producto_codigo || '-').trim()}>
                      {item?.tipo === 'otro' ? 'Otro' : String(item?.producto_codigo || '-').trim()}
                    </td>
                    <td title={String(item?.motivo || item?.producto_nombre || '-').trim()}>
                      {item?.tipo === 'otro' ? String(item?.motivo || '-').trim() : String(item?.producto_nombre || '-').trim()}
                    </td>
                    <td title={getIssueBranchLabel(item)}>{getIssueBranchLabel(item)}</td>
                    <td className="movimientos-table__product-hover-qty">{item?.tipo === 'otro' ? '-' : formatIssueQty(item)}</td>
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

      {shouldRenderDetailsModal && selectedGroup && (
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
              <div className="create-user__body transfer-issues-detail__body">
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Resumen</p>
                      <h4>Detalle general</h4>
                    </div>
                    {groupFirst?.movimiento_entrada_id && typeof onOpenTransferRequestInEntradas === 'function' ? (
                      <button
                        type="button"
                        className="create-user__ghost"
                        onClick={() => {
                          onOpenTransferRequestInEntradas({
                            solicitudId: groupFirst.solicitud_id,
                            movimientoEntradaId: groupFirst.movimiento_entrada_id,
                            sucursalSolicitanteId: groupFirst.sucursal_solicitante_id,
                            mode: 'view',
                          })
                          closeDetails()
                        }}
                      >
                        Ver entrada
                      </button>
                    ) : null}
                  </div>
                  <div className="create-salida__field-group--defined">
                    <div className="create-user__grid create-user__grid--three">
                      <StaticFieldDisplay
                        label={isImportacionGroup ? 'Casa comercial' : 'Sucursal proveedora'}
                        value={String(groupFirst?.sucursal_proveedora || '-').trim() || '-'}
                      />
                      <StaticFieldDisplay
                        label={isImportacionGroup ? 'Importación' : 'Traslado'}
                        value={String(selectedGroup?.solicitud_no_documento || '-').trim() || '-'}
                      />
                      <StaticFieldDisplay
                        label="Productos"
                        value={`${groupItems.length} · ${groupItems.length - groupActiveCount + groupDraftCount} con solución · ${groupActiveCount - groupDraftCount} pendientes`}
                      />
                    </div>
                  </div>
                </section>

                {groupLoading && !groupIssues.length ? (
                  <p className="muted transfer-issues-details__hint">Cargando productos...</p>
                ) : null}

                {branchSections.map((section) => {
                  const collapsed = Boolean(collapsedBranches[section.key])
                  return (
                    <section key={section.key} className="transfer-issues-branch">
                      <button
                        type="button"
                        className="transfer-issues-branch__header"
                        onClick={() => toggleBranch(section.key)}
                        aria-expanded={!collapsed}
                      >
                        <i className={`pi pi-chevron-${collapsed ? 'right' : 'down'}`} aria-hidden="true" />
                        <strong>{section.label}</strong>
                        <small>{section.items.length === 1 ? '1 producto' : `${section.items.length} productos`}</small>
                        <span className="transfer-issues-branch__counts">
                          {section.done ? <span className="transfer-issues-branch__count transfer-issues-branch__count--done">{`${section.done} con solución`}</span> : null}
                          {section.pending ? <span className="transfer-issues-branch__count transfer-issues-branch__count--pending">{`${section.pending} pendientes`}</span> : null}
                        </span>
                      </button>
                      {!collapsed && (
                        <div className="transfer-issues-branch__list">
                          {section.items.map((issue) => {
                            const draft = drafts[issue.row_key]
                            const active = isActiveIssue(issue)
                            const solved = !active || hasDraftDecision(draft)
                            const novedad = String(issue?.motivo || '').trim()
                            return (
                              <div
                                key={issue.row_key}
                                className={`transfer-issues-item ${solved ? 'transfer-issues-item--solved' : 'transfer-issues-item--pending'}`}
                              >
                                <div className="transfer-issues-item__info">
                                  <strong>{issue?.tipo === 'otro' ? 'Otro inconveniente' : String(issue?.producto_codigo || '-').trim()}</strong>
                                  {issue?.tipo !== 'otro' ? <span>{String(issue?.producto_nombre || '-').trim()}</span> : null}
                                  {novedad ? <small className="cell-tooltip" data-pr-tooltip={novedad}>{novedad}</small> : null}
                                </div>
                                {issue?.tipo !== 'otro' ? (
                                  <span className={`transfer-issues-item__qty transfer-issues-cantidad--${issue?.tipo === 'sobrante' ? 'sobrante' : 'faltante'}`}>
                                    {formatIssueQty(issue)}
                                  </span>
                                ) : <span />}
                                <div className="transfer-issues-item__actions">
                                  {active && canUpdate
                                    ? getDecisionOptions(issue).map((opt) => (
                                        <DecisionButton
                                          key={opt.key}
                                          variant={opt.variant}
                                          label={opt.label}
                                          tooltip={opt.tooltip}
                                          active={draft?.decision === opt.key}
                                          onClick={() => openDecision(issue, opt.key)}
                                          disabled={resolverSubmitting}
                                        />
                                      ))
                                    : null}
                                </div>
                                {solved ? (
                                  <div className="transfer-issues-item__solution">
                                    <i className="pi pi-check-circle" aria-hidden="true" />
                                    <span>
                                      {active
                                        ? `Solución: ${describeDraft(draft)}`
                                        : `${formatEstado(issue?.estado)}: ${formatResolucion(issue?.resolucion)}`}
                                      {active && draft?.motivo ? <em>{` · ${draft.motivo}`}</em> : null}
                                    </span>
                                    {active && canUpdate ? (
                                      <button
                                        type="button"
                                        className="transfer-issues-item__remove"
                                        onClick={() => removeDraft(issue)}
                                        disabled={resolverSubmitting}
                                      >
                                        Quitar
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </section>
                  )
                })}
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
                {canUpdate && groupActiveCount ? (
                  <div className="transfer-issues-footer__actions">
                    <button
                      type="button"
                      className="create-user__action create-user__action--secondary"
                      onClick={() => void handleSaveDrafts()}
                      disabled={resolverSubmitting || savingDrafts}
                    >
                      {savingDrafts ? 'Guardando...' : 'Guardar cambios'}
                    </button>
                    <button
                      type="button"
                      className="create-user__action create-user__action--primary"
                      onClick={requestApply}
                      disabled={resolverSubmitting || !groupDraftCount}
                    >
                      {resolverSubmitting ? 'Aplicando...' : `Aplicar cambios${groupDraftCount ? ` (${groupDraftCount})` : ''}`}
                    </button>
                  </div>
                ) : null}
              </footer>
                            {decisionDialogOpen && selectedIssue ? createPortal(
                <div className="transfer-issues-dialog-backdrop" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="transfer-issues-dialog" role="dialog" aria-modal="true" aria-label={DECISION_LABELS[resolverDecision] || 'Solución'}>
                    <header className="transfer-issues-dialog__header">
                      <p className="create-user__eyebrow">{getIssueBranchLabel(selectedIssue)}</p>
                      <h4>{DECISION_LABELS[resolverDecision] || 'Solución'}</h4>
                      <small>
                        {getIssueProductLabel(selectedIssue)}
                        {selectedIssue?.tipo !== 'otro' ? ` · ${formatIssueQty(selectedIssue)}` : ''}
                      </small>
                    </header>
                    <div className="transfer-issues-dialog__body">
                      <p className="muted transfer-issues-details__hint">{DECISION_HINTS[resolverDecision] || ''}</p>
  {(resolverDecision === 'sumar_solicitante' || resolverDecision === 'sumar_proveedora' || resolverDecision === 'sumar_origen' || resolverDecision === 'restar_proveedora' || resolverDecision === 'devolver_proveedora') && (
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

                                  {resolverLocationDropdownField === 'bodega' && createPortal(
                                    <div
                                      ref={resolverLocationDropdownPanelRef}
                                      className="create-user__dropdown-panel"
                                      style={resolverLocationDropdownStyle}
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
                                    </div>,
                                    getAppPortalRoot()
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

                                  {resolverLocationDropdownField === 'division' && createPortal(
                                    <div
                                      ref={resolverLocationDropdownPanelRef}
                                      className="create-user__dropdown-panel"
                                      style={resolverLocationDropdownStyle}
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
                                    </div>,
                                    getAppPortalRoot()
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

                                  {resolverLocationDropdownField === 'subdivision' && createPortal(
                                    <div
                                      ref={resolverLocationDropdownPanelRef}
                                      className="create-user__dropdown-panel"
                                      style={resolverLocationDropdownStyle}
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
                                    </div>,
                                    getAppPortalRoot()
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
                                  {resolverProvLocationDropdownField === 'bodega' && createPortal(
                                    <div
                                      ref={resolverProvLocationDropdownPanelRef}
                                      className="create-user__dropdown-panel"
                                      style={resolverProvLocationDropdownStyle}
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
                                    </div>,
                                    getAppPortalRoot()
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
                                  {resolverProvLocationDropdownField === 'division' && createPortal(
                                    <div
                                      ref={resolverProvLocationDropdownPanelRef}
                                      className="create-user__dropdown-panel"
                                      style={resolverProvLocationDropdownStyle}
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
                                    </div>,
                                    getAppPortalRoot()
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
                                  {resolverProvLocationDropdownField === 'subdivision' && createPortal(
                                    <div
                                      ref={resolverProvLocationDropdownPanelRef}
                                      className="create-user__dropdown-panel"
                                      style={resolverProvLocationDropdownStyle}
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
                                    </div>,
                                    getAppPortalRoot()
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

                      {resolverDecision === 'solucion' ? (
                        <div className="transfer-issues-details__decisions transfer-issues-details__decisions--two">
                          <label className="create-user__field transfer-issues-details__field">
                            <span>Cantidad que enviará el proveedor</span>
                            <input
                              type="number"
                              min="1"
                              value={resolverCantidadPrometida}
                              onChange={(event) => setResolverCantidadPrometida(event.target.value)}
                            />
                          </label>
                          <label className="create-user__field transfer-issues-details__field">
                            <span>Fecha de entrega</span>
                            <input
                              type="date"
                              value={resolverFechaPrometida}
                              onChange={(event) => setResolverFechaPrometida(event.target.value)}
                            />
                          </label>
                        </div>
                      ) : null}
                      <label className="create-user__field create-user__field--full transfer-issues-details__field">
                        <span>
                          {resolverDecision === 'solucionado'
                            ? '¿Cómo se solucionó? (obligatorio)'
                            : resolverDecision === 'perdido'
                              ? '¿Qué pasó? (obligatorio)'
                              : 'Nota (opcional)'}
                        </span>
                        <textarea
                          rows={2}
                          value={resolverMotivo}
                          onChange={(event) => setResolverMotivo(String(event.target.value || ''))}
                        />
                      </label>
                      {resolverError ? <p className="transfer-issues-details__error">{resolverError}</p> : null}
                    </div>
                    <footer className="transfer-issues-dialog__footer">
                      <button type="button" className="create-user__action create-user__action--secondary" onClick={closeDecisionDialog}>
                        Cancelar
                      </button>
                      <button
                        type="button"
                        className="create-user__action create-user__action--primary"
                        onClick={acceptDecision}
                        disabled={resolverSubdivisionsLoading || resolverProvSubdivisionsLoading}
                      >
                        Aceptar
                      </button>
                    </footer>
                  </div>
                </div>,
                getAppPortalRoot()
              ) : null}

              {applyConfirm ? createPortal(
                <div className="transfer-issues-dialog-backdrop" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="transfer-issues-dialog" role="dialog" aria-modal="true" aria-label="Aplicar cambios">
                    <header className="transfer-issues-dialog__header">
                      <h4>Aplicar cambios</h4>
                    </header>
                    <div className="transfer-issues-dialog__body">
                      <p className="transfer-issues-apply__title transfer-issues-apply__title--done">
                        {`Se van a marcar como solucionados (${applyConfirm.toApply.length}):`}
                      </p>
                      <ul className="transfer-issues-apply__list">
                        {applyConfirm.toApply.map((issue) => (
                          <li key={issue.row_key}>
                            <strong>{String(issue?.producto_codigo || 'Otro').trim()}</strong>
                            {` (${getIssueBranchLabel(issue)}) · ${describeDraft(drafts[issue.row_key])}`}
                          </li>
                        ))}
                      </ul>
                      <p className="transfer-issues-apply__title transfer-issues-apply__title--pending">
                        {`Quedan pendientes, sin solución todavía (${applyConfirm.sinSolucion.length}):`}
                      </p>
                      <ul className="transfer-issues-apply__list">
                        {applyConfirm.sinSolucion.map((issue) => (
                          <li key={issue.row_key}>
                            <strong>{String(issue?.producto_codigo || 'Otro').trim()}</strong>
                            {` (${getIssueBranchLabel(issue)})`}
                          </li>
                        ))}
                      </ul>
                      <p className="muted transfer-issues-details__hint">Los pendientes los puedes resolver y aplicar más tarde.</p>
                    </div>
                    <footer className="transfer-issues-dialog__footer">
                      <button type="button" className="create-user__action create-user__action--secondary" onClick={() => setApplyConfirm(null)}>
                        Cancelar
                      </button>
                      <button
                        type="button"
                        className="create-user__action create-user__action--primary"
                        onClick={() => void runApply(applyConfirm.toApply)}
                      >
                        {`Aplicar ${applyConfirm.toApply.length}`}
                      </button>
                    </footer>
                  </div>
                </div>,
                getAppPortalRoot()
              ) : null}
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
