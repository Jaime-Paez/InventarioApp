import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Loader2, Map as MapIcon, PackageCheck, Pencil, RefreshCw, Send, Settings, Wrench, X } from 'lucide-react'
import { Button } from 'primereact/button'
import { Column } from 'primereact/column'
import { DataTable } from 'primereact/datatable'
import Toast from '../../common/AppToast'
import { API_URL, authFetch } from '../../../../utils/api'
import { formatDateTime } from '../../../../utils/dateFormat'
import { getAppPortalRoot } from '../../../../utils/portalRoot'
import '../CreateUsuario/CreateUsuario.css'
import '../../QuickActions/QuickActions.css'
import '../../movimientos/CreateSalida.css'
import '../../movimientos/TrasladosInconvenientesTable.css'
import './RandomInspectionAdminTable.css'
import InspectionCoverageMap from './InspectionCoverageMap'
import RecountWarningDialog from './RecountWarningDialog'
import useResizableModal from '../../common/useResizableModal'
import CascadeDropdown from '../../common/CascadeDropdown'
import BlockerNotice from '../../common/BlockerNotice'
import StaticFieldDisplay from '../../movimientos/StaticFieldDisplay'

// Aviso de "no se puede enviar" (el componente compartido del sistema).
function SendBlocker({ title, reason, actionLabel, onAction, goTo }) {
  return (
    <BlockerNotice
      className="inspection-admin__blocker"
      title={title}
      reason={reason}
      actionLabel={actionLabel}
      onAction={onAction}
      goTo={goTo}
    />
  )
}

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeId = (value) => (value == null ? '' : String(value).trim())
// Ubicaciones de una diferencia que el admin puede confirmar por separado:
// las que tienen subdivision, cantidad del sistema y cantidad contada.
// El revisor lo paso todo a otra fila: primero se decide si se aprueba ese
// cambio. Solo despues, y solo si la cantidad no cuadra, se puede ajustar o
// reenviar a contar.
// Lo mismo cuando lo encontro en una ubicacion nueva ("Llevarlas" o "Pasar a
// esta ubicacion") y la cantidad no cuadra: se acepta o rechaza la ubicacion
// antes de reenviar el conteo, asi el reconteo busca donde quedo decidido.
const isNewLocationAwaitingDecision = (row) => (
  Boolean(row?.ubicacion_por_decidir) &&
  !String(row?.movimiento_decision || '').trim() &&
  String(row?.verificacion_estado || '').trim().toLowerCase() === 'pendiente'
)
const isMoveAwaitingDecision = (row) => (
  Boolean(row?.movido_por_revisor) &&
  !row?.agregado_por_revisor &&
  !String(row?.movimiento_decision || '').trim() &&
  String(row?.verificacion_estado || '').trim().toLowerCase() === 'pendiente'
)
const getVerifiableLocations =(item) => (Array.isArray(item?.ubicaciones_conteo) ? item.ubicaciones_conteo : [])
  .filter((location) => (
    Number.parseInt(String(location?.subdivision_id ?? ''), 10) > 0 &&
    location?.cantidad_sistema != null &&
    location?.cantidad_contada != null
  ))
// "No lo encontre" no es "hay 0": al aprobar, lo que el sistema tenia en esas
// ubicaciones pasa a TEMPORAL de la sucursal (el total no cambia), salvo que
// el admin escriba otra cantidad o desmarque la opcion. Mismo calculo que el
// backend (_plan_not_found_to_temporal).
const getNotFoundCandidates = (item) => {
  const verifiable = getVerifiableLocations(item)
  // "No lo encontre" en esa ubicacion, o en todo el producto (donde conto 0).
  const locations = verifiable.filter((location) => (
    (location?.no_encontrado || (item?.no_encontrado && (Number.parseInt(String(location.cantidad_contada ?? 0), 10) || 0) === 0)) &&
    Number(location.cantidad_sistema) > 0
  ))
  const expected = Number.parseInt(String(item?.cantidad_esperada ?? 0), 10) || 0
  const whole = Boolean(item?.no_encontrado) && !verifiable.length && expected > 0
  return { verifiable, locations, whole, expected }
}
const getNotFoundToTemporalQty = (item, { perLocation = null, confirmed = Number.NaN, enabled = true } = {}) => {
  if (!enabled) return 0
  const { verifiable, locations, whole, expected } = getNotFoundCandidates(item)
  if (perLocation) {
    return locations.reduce((total, location) => {
      const value = Number.parseInt(String(perLocation[String(location.subdivision_id)] ?? '').trim(), 10)
      return value === 0 ? total + Number(location.cantidad_sistema) : total
    }, 0)
  }
  if (!Number.isFinite(confirmed)) return 0
  if (verifiable.length) {
    const counted = verifiable.reduce((total, location) => total + (Number.parseInt(String(location.cantidad_contada ?? 0), 10) || 0), 0)
    if (confirmed !== counted) return 0
    return locations
      .filter((location) => (Number.parseInt(String(location.cantidad_contada ?? 0), 10) || 0) === 0)
      .reduce((total, location) => total + Number(location.cantidad_sistema), 0)
  }
  const reported = Number.parseInt(String(item?.cantidad_reportada ?? 0), 10) || 0
  return whole && confirmed === reported ? expected : 0
}

// Total correcto pero repartido distinto entre ubicaciones: solo se decide
// si se aprueba el reparto del revisor o se deja como estaba.
const isLocationChangeAwaitingDecision = (row) => (
  Boolean(row?.cambio_ubicacion) &&
  !row?.movido_por_revisor &&
  String(row?.verificacion_estado || '').trim().toLowerCase() === 'pendiente' &&
  row?.cantidad_reportada != null &&
  Number(row.cantidad_reportada) === Number(row?.cantidad_esperada) &&
  getVerifiableLocations(row).length >= 2
)

const formatSignedInteger = (value) => {
  const numeric = Number.parseInt(String(value ?? 0), 10) || 0
  if (numeric > 0) return `+${numeric}`
  return String(numeric)
}

const formatPercent = (value) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '0.0%'
  return `${numeric.toFixed(1)}%`
}

const detectDarkTheme = () => {
  if (typeof document === 'undefined') return false
  return Boolean(
    document.querySelector('.app-shell')?.classList.contains('theme-dark')
    || document.querySelector('.dashboard-shell')?.classList.contains('dark')
  )
}

// Historial de revisiones (como Inconvenientes): pendientes arriba y
// solucionadas abajo. `chip`/`row` usan los colores de Inconvenientes.
const REVISION_STATUS_FILTERS = [
  { key: 'todos', label: 'Todas' },
  { key: 'pendientes', label: 'Pendientes' },
  { key: 'solucionadas', label: 'Solucionadas' },
]

const REVISION_STATES = {
  en_curso: { label: 'En curso', chip: 'encurso', row: '' },
  // No se termino y administracion la dejo pasar ("Dejar pasar").
  dejada_pasar: { label: 'Dejada pasar', chip: 'dejada', row: '' },
  pendiente: { label: 'Pendiente', chip: 'pendiente', row: 'pendiente' },
  solucionada: { label: 'Solucionada', chip: 'resuelto', row: 'resuelto' },
  revisada: { label: 'Revisada', chip: 'revisada', row: '' },
}

const describeRevisionResolution = (revision) => {
  const differences = Number(revision?.diferencias || 0)
  const verified = Number(revision?.verificadas || 0)
  if (revision?.estado_revision === 'en_curso') return 'Aún contando'
  if (revision?.estado_revision === 'dejada_pasar') return 'No se terminó de contar'
  if (!differences) return 'Sin diferencias'
  if (verified >= differences) return `${differences} de ${differences} solucionadas`
  return `${verified} de ${differences} solucionadas`
}

// Estado de cada producto dentro de la revision.
const getItemStatus = (row) => {
  const review = String(row?.estado_revision || '').trim().toLowerCase()
  const verification = String(row?.verificacion_estado || '').trim().toLowerCase()
  if (review === 'no_coincide') {
    if (verification === 'aprobada') return { key: 'solucionado', label: 'Solucionado' }
    if (verification === 'rechazada') return { key: 'mantenido', label: 'Mantenido' }
    if (verification === 'reconteo') return { key: 'reconteo', label: 'Reenviado a reconteo' }
    return { key: 'pendiente', label: 'Pendiente' }
  }
  if (review === 'coincide') return { key: 'revisado', label: 'Revisado' }
  return { key: 'sin_contar', label: 'Sin contar' }
}

// Un producto se cuenta hasta 3 veces en total (el conteo original y 2
// reconteos). Numero del conteo de este item y del siguiente si se reenvia.
const getMaxCounts = (row) => Number(row?.max_conteos || 0) || Number(row?.max_reconteos || 2) + 1
const getCountNumber = (row) => Number(row?.reconteos || 0) + 1
const getNextCountLabel = (row) => `${getCountNumber(row) + 1} de ${getMaxCounts(row)}`

const describeCountQty = (entry) => {
  if (entry.cantidad == null) return 'Sin contar todavía'
  return `Contó ${entry.cantidad}${entry.no_encontrado ? ' (no lo encontró)' : ''}`
}

// Puntos de conteo: uno por cada vez que se cuenta el producto (de 3). Al
// pasar el mouse por un punto sale una tarjeta con todos los conteos (cuanto
// conto cada vez y contra cuanto esperado), marcando el del punto y el actual.
function RecountDots({ row }) {
  const [hover, setHover] = useState(null)
  const max = getMaxCounts(row)
  const history = Array.isArray(row?.conteos) && row.conteos.length
    ? row.conteos
    : [{
      numero: 1,
      cantidad: row?.cantidad_reportada ?? null,
      esperado: Number(row?.cantidad_esperada || 0),
      no_encontrado: Boolean(row?.no_encontrado),
      inspeccion_codigo: row?.inspeccion_codigo || '',
      es_este: true,
      actual: true,
    }]
  const current = history.find((entry) => entry.es_este) || history[history.length - 1]
  // Conteos que dieron la misma cantidad (dos o mas): esos puntos van en verde.
  const qtyTimes = history.reduce((acc, entry) => {
    if (entry?.cantidad != null) acc[Number(entry.cantidad)] = (acc[Number(entry.cantidad)] || 0) + 1
    return acc
  }, {})
  const isMatch = (entry) => entry?.cantidad != null && qtyTimes[Number(entry.cantidad)] >= 2

  const cardRef = useRef(null)
  const showCard = (event, index) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setHover({ index, anchorTop: rect.top, top: rect.bottom + 8, left: Math.max(8, rect.left - 12) })
  }

  // Si la tarjeta no cabe debajo del punto (filas al final de la pantalla), se
  // abre hacia arriba; y nunca se sale por la derecha.
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!hover || !card) return
    const { height, width } = card.getBoundingClientRect()
    const margin = 8
    let top = hover.top
    if (top + height > window.innerHeight - margin) {
      const above = hover.anchorTop - 8 - height
      top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - height)
    }
    const left = Math.max(margin, Math.min(hover.left, window.innerWidth - margin - width))
    card.style.top = `${top}px`
    card.style.left = `${left}px`
    card.style.visibility = 'visible'
  }, [hover])

  return (
    <>
      <span className="inspection-admin__recount-dots" onMouseLeave={() => setHover(null)}>
        {Array.from({ length: max }, (_, index) => {
          const entry = history[index]
          const classes = entry
            ? [entry.cantidad != null ? 'is-on' : 'is-waiting', entry.actual ? 'is-current' : '', isMatch(entry) ? 'is-match' : ''].filter(Boolean).join(' ')
            : ''
          return (
            <i
              key={index}
              className={classes}
              onMouseEnter={(event) => showCard(event, index)}
              aria-label={entry ? `Conteo ${entry.numero}: ${describeCountQty(entry)}` : `Conteo ${index + 1}: no se ha pedido`}
            />
          )
        })}
        <small>{`Conteo ${current?.numero || 1} de ${max}`}</small>
      </span>
      {hover && createPortal(
        <div ref={cardRef} className="table-cell-hover-card inspection-admin__count-card" style={{ top: hover.top, left: hover.left, visibility: 'hidden' }}>
          <div className="table-cell-hover-card__title">{`Conteos de ${String(row?.producto_codigo || 'este producto').trim()}`}</div>
          {Array.from({ length: max }, (_, index) => {
            const entry = history[index]
            const rowClasses = [
              'inspection-admin__count-row',
              index === hover.index ? 'is-hovered' : '',
              entry?.actual ? 'is-current' : '',
              !entry ? 'is-empty' : '',
            ].filter(Boolean).join(' ')
            return (
              <div key={index} className={rowClasses}>
                <span className="inspection-admin__count-num">{index + 1}</span>
                <span className="inspection-admin__count-text">
                  {entry ? (
                    <>
                      <strong>{describeCountQty(entry)}</strong>
                      <small>{`Esperado ${entry.esperado}${entry.inspeccion_codigo ? ` · ${entry.inspeccion_codigo}` : ''}`}</small>
                    </>
                  ) : (
                    <small>No se ha pedido</small>
                  )}
                </span>
                {entry?.actual ? <span className="inspection-admin__count-badge">Actual</span> : null}
              </div>
            )
          })}
        </div>,
        getAppPortalRoot()
      )}
    </>
  )
}

const ITEM_ORDER = { pendiente: 0, sin_contar: 1, reconteo: 2, solucionado: 3, mantenido: 4, revisado: 5 }

// Que se hizo con el producto (la "solucion", como en Inconvenientes).
const describeItemResolution = (row) => {
  const status = getItemStatus(row).key
  const expected = Number.parseInt(String(row?.cantidad_esperada || 0), 10) || 0
  const confirmed = row?.cantidad_confirmada == null ? null : Number.parseInt(String(row.cantidad_confirmada), 10) || 0
  if (status === 'revisado') return 'coincide con el sistema'
  if (status === 'mantenido') return 'se dejó como estaba (sin ajuste)'
  if (status === 'reconteo') return `se mandó a contar de nuevo${String(row?.reconteo_enviado_a || '').trim() ? ` (${String(row.reconteo_enviado_a).trim()})` : ''}`
  if (status !== 'solucionado') return ''
  if (String(row?.reubicado_a || '').trim()) return `reubicado a ${String(row.reubicado_a).trim()}`
  if (confirmed == null || confirmed === expected) return 'aprobado sin ajuste de stock'
  return `stock ajustado de ${expected} a ${confirmed}`
}

function RandomInspectionAdminTable({
  token,
  moduleActions,
  isTabActive,
  pendingReviewInspectionId,
  onPendingReviewInspectionHandled,
}) {
  const toast = useRef(null)
  const canRead = moduleActions?.puede_leer ?? true
  const canUpdate = moduleActions?.puede_actualizar ?? true
  const [isDarkTheme, setIsDarkTheme] = useState(detectDarkTheme)
  // Sucursal cuyo mapa de conteo esta abierto ({ id, nombre } o null).
  const [coverageMapBranch, setCoverageMapBranch] = useState(null)

  const [summaryRows, setSummaryRows] = useState([])
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [selectedBranchId, setSelectedBranchId] = useState('')

  // Pantalla: 'sucursales' (resumen + enviar/configurar) o 'diferencias'
  // (las revisiones de la sucursal con sus diferencias juntas).
  const [view, setView] = useState('sucursales')
  // `itemsRows` son las REVISIONES de la sucursal (no producto por producto);
  // los productos con diferencia se ven al abrir una (`expandedRevisionId`).
  const [itemsRows, setItemsRows] = useState([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsFilter, setItemsFilter] = useState('todos')
  const [summarySearch, setSummarySearch] = useState('')
  const [expandedRevisionId, setExpandedRevisionId] = useState('')
  // Detalle de una revision: resumen arriba y productos abajo (con scroll),
  // en una ventana que se mueve, maximiza y cambia de tamano como las demas.
  const revisionModal = useResizableModal(Boolean(expandedRevisionId))
  const [revisionItems, setRevisionItems] = useState([])
  const [revisionItemsLoading, setRevisionItemsLoading] = useState(false)
  // Revision a desplegar cuando llega su sucursal (abierta desde un recordatorio).
  const pendingExpandRevisionRef = useRef('')
  // Faltante abierto al que se le registra "Aparecio".
  const [itemsPage, setItemsPage] = useState(1)
  const [itemsPageSize, setItemsPageSize] = useState(25)
  const [itemsTotalCount, setItemsTotalCount] = useState(0)

  // Wizard de verificacion: administracion revisa las diferencias una por
  // una, con el mismo formato del wizard de conteo del revisor.
  const [verifyWizardOpen, setVerifyWizardOpen] = useState(false)
  const [verifyWizardLoading, setVerifyWizardLoading] = useState(false)
  const [verifyWizardItems, setVerifyWizardItems] = useState([])
  const [verifyWizardIndex, setVerifyWizardIndex] = useState(0)
  const [verifyWizardDrafts, setVerifyWizardDrafts] = useState({})
  const [verifyWizardDecisions, setVerifyWizardDecisions] = useState({})
  const [verifyWizardSubmitting, setVerifyWizardSubmitting] = useState(false)
  const [verifyWizardError, setVerifyWizardError] = useState('')
  // Advertencia al aprobar con una cantidad distinta de lo que conto el
  // revisor: pide una nota obligatoria explicando que paso.
  const [verifyWizardConfirming, setVerifyWizardConfirming] = useState(false)
  const [showAssignmentsDialog, setShowAssignmentsDialog] = useState(false)
  const [assignmentRows, setAssignmentRows] = useState([])
  const [assignmentBranches, setAssignmentBranches] = useState([])
  const [assignmentsLoading, setAssignmentsLoading] = useState(false)
  const [assignmentSearch, setAssignmentSearch] = useState('')
  const [localAssignmentMap, setLocalAssignmentMap] = useState({})
  const [configData, setConfigData] = useState({ hora_recordatorio: '', cantidad_productos: '', inspeccion_automatica: false })
  const [configLoading, setConfigLoading] = useState(false)
  const [showSendNowDialog, setShowSendNowDialog] = useState(false)
  const [sendNowLoading, setSendNowLoading] = useState(false)
  const [sendNowDialogLoading, setSendNowDialogLoading] = useState(false)
  const [sendNowParams, setSendNowParams] = useState({ cantidad_productos: '', hora_recordatorio: '' })
  const [sendNowSelectedUserIds, setSendNowSelectedUserIds] = useState(new Set())
  // Aleatorio: sucursal y revisor en desplegables ('' = todas / todos).
  const [aleatorioSucursalId, setAleatorioSucursalId] = useState('')
  const [aleatorioUsuarioId, setAleatorioUsuarioId] = useState('')
  const [sendNowMode, setSendNowMode] = useState('aleatorio')
  const [sendError, setSendError] = useState('')
  // "Enviar ahora mismo": ignora la hora elegida y usa la hora actual.
  const [sendNowImmediate, setSendNowImmediate] = useState(false)
  const resolveSendNowHour = useCallback(() => {
    if (sendNowImmediate) {
      const now = new Date()
      return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    }
    return String(sendNowParams?.hora_recordatorio || '').trim()
  }, [sendNowImmediate, sendNowParams?.hora_recordatorio])
  const [divisionSucursalId, setDivisionSucursalId] = useState('')
  const [divisionBodegaId, setDivisionBodegaId] = useState('')
  const [divisionId, setDivisionId] = useState('')
  // Opcional: '' = toda la division.
  const [divisionSubdivisionId, setDivisionSubdivisionId] = useState('')
  const [divisionSubdivisiones, setDivisionSubdivisiones] = useState([])
  const [divisionSubdivisionesLoading, setDivisionSubdivisionesLoading] = useState(false)
  const [divisionUsuarioId, setDivisionUsuarioId] = useState('')
  const [divisionBodegas, setDivisionBodegas] = useState([])
  const [divisionBodegasLoading, setDivisionBodegasLoading] = useState(false)
  const [divisionDivisiones, setDivisionDivisiones] = useState([])
  const [divisionDivisionesLoading, setDivisionDivisionesLoading] = useState(false)
  const [divisionSending, setDivisionSending] = useState(false)
  // Modo "Lista especifica": el admin elige a mano que repuestos revisar.
  const [listSucursalId, setListSucursalId] = useState('')
  const [listUsuarioId, setListUsuarioId] = useState('')
  const [listProducts, setListProducts] = useState([])
  const listProductsRef = useRef([])
  listProductsRef.current = listProducts
  // Fila de "agregar" igual a la de Entradas/Salidas: dropdown de producto
  // + boton Agregar. Pegar varios codigos en el buscador los agrega todos.
  const [listDraftProduct, setListDraftProduct] = useState(null)
  const [listProductQuery, setListProductQuery] = useState('')
  const [listProductOptions, setListProductOptions] = useState([])
  const [listProductLoading, setListProductLoading] = useState(false)
  const [showListProductDropdown, setShowListProductDropdown] = useState(false)
  const [listProductDropdownStyle, setListProductDropdownStyle] = useState({})
  const [listBulkLoading, setListBulkLoading] = useState(false)
  const listProductDropdownRef = useRef(null)
  const listProductTriggerRef = useRef(null)
  const listProductPanelRef = useRef(null)
  const [listSending, setListSending] = useState(false)
  const notifyError = useCallback((detail) => {
    if (!detail) return
    toast.current?.show({
      severity: 'error',
      summary: 'Error',
      detail,
      life: 3500,
    })
  }, [])

  const notifySuccess = useCallback((detail) => {
    if (!detail) return
    toast.current?.show({
      severity: 'success',
      summary: 'Listo',
      detail,
      life: 2600,
    })
  }, [])

  const loadConfig = useCallback(async () => {
    if (!token || !canUpdate) return
    setConfigLoading(true)
    try {
      const response = await authFetch(`${API_URL}/recordatorios/inspeccion-aleatoria/configuracion/`, {}, token)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo cargar la configuracion.')
      setConfigData({
        hora_recordatorio: payload?.hora_recordatorio ?? '',
        cantidad_productos: payload?.cantidad_productos != null ? String(payload.cantidad_productos) : '',
        inspeccion_automatica: Boolean(payload?.inspeccion_automatica),
      })
    } catch (error) {
      notifyError(error?.message || 'No se pudo cargar la configuracion.')
    } finally {
      setConfigLoading(false)
    }
  }, [token, canUpdate, notifyError])

  const sendNow = useCallback(async () => {
    if (!token) return

    if (sendNowSelectedUserIds.size === 0) {
      notifyError('Debes seleccionar al menos un revisor.')
      return
    }

    const hora = resolveSendNowHour()
    if (!hora) {
      notifyError('Debes seleccionar la hora del recordatorio.')
      return
    }

    const parts = hora.split(':')
    const parsedHour = Number.parseInt(parts[0], 10)
    const parsedMinute = Number.parseInt(parts[1] ?? '0', 10)

    if (
      !Number.isFinite(parsedHour) ||
      !Number.isFinite(parsedMinute) ||
      parsedHour < 0 ||
      parsedHour > 23 ||
      parsedMinute < 0 ||
      parsedMinute > 59
    ) {
      notifyError('Formato de hora invalido. Usa HH:MM.')
      return
    }
    // Una hora que ya paso no se rechaza: el servidor la envia con la hora
    // actual (antes fallaba si el reloj avanzaba un minuto antes de enviar).

    setSendNowLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/enviar-ahora/`,
        { method: 'POST', body: JSON.stringify({ ...sendNowParams, hora_recordatorio: hora, usuario_ids: [...sendNowSelectedUserIds] }) },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo enviar el recordatorio.')
      notifySuccess('Recordatorio enviado correctamente.')
      setShowSendNowDialog(false)
    } catch (error) {
      notifyError(error?.message || 'No se pudo enviar el recordatorio.')
      setSendError(error?.message || 'No se pudo enviar el recordatorio.')
    } finally {
      setSendNowLoading(false)
    }
  }, [token, sendNowParams, sendNowSelectedUserIds, notifyError, notifySuccess, resolveSendNowHour])

  useEffect(() => {
    if (!token || sendNowMode !== 'division' || !divisionSucursalId) {
      setDivisionBodegas([])
      return undefined
    }
    let cancelled = false
    setDivisionBodegasLoading(true)
    authFetch(`${API_URL}/inventario/bodegas/?sucursal_id=${encodeURIComponent(divisionSucursalId)}&page_size=200`, {}, token)
      .then(async (res) => {
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudieron cargar las bodegas.')
        if (!cancelled) setDivisionBodegas(parseApiList(payload))
      })
      .catch((error) => { if (!cancelled) { setDivisionBodegas([]); notifyError(error?.message || 'No se pudieron cargar las bodegas.') } })
      .finally(() => { if (!cancelled) setDivisionBodegasLoading(false) })
    return () => { cancelled = true }
  }, [token, sendNowMode, divisionSucursalId, notifyError])

  useEffect(() => {
    if (!token || sendNowMode !== 'division' || !divisionBodegaId) {
      setDivisionDivisiones([])
      return undefined
    }
    let cancelled = false
    setDivisionDivisionesLoading(true)
    authFetch(`${API_URL}/inventario/divisiones/?bodega_id=${encodeURIComponent(divisionBodegaId)}&page_size=200`, {}, token)
      .then(async (res) => {
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudieron cargar las divisiones.')
        if (!cancelled) setDivisionDivisiones(parseApiList(payload))
      })
      .catch((error) => { if (!cancelled) { setDivisionDivisiones([]); notifyError(error?.message || 'No se pudieron cargar las divisiones.') } })
      .finally(() => { if (!cancelled) setDivisionDivisionesLoading(false) })
    return () => { cancelled = true }
  }, [token, sendNowMode, divisionBodegaId, notifyError])

  useEffect(() => {
    if (!token || sendNowMode !== 'division' || !divisionId) {
      setDivisionSubdivisiones([])
      return undefined
    }
    let cancelled = false
    setDivisionSubdivisionesLoading(true)
    authFetch(`${API_URL}/inventario/subdivisiones/?division_id=${encodeURIComponent(divisionId)}&page_size=500`, {}, token)
      .then(async (res) => {
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudieron cargar las subdivisiones.')
        if (!cancelled) setDivisionSubdivisiones(parseApiList(payload))
      })
      .catch((error) => { if (!cancelled) { setDivisionSubdivisiones([]); notifyError(error?.message || 'No se pudieron cargar las subdivisiones.') } })
      .finally(() => { if (!cancelled) setDivisionSubdivisionesLoading(false) })
    return () => { cancelled = true }
  }, [token, sendNowMode, divisionId, notifyError])

  // "Toda la division" va primero: la subdivision es opcional.
  const divisionSubdivisionOptions = useMemo(
    () => [{ id: '', nombre: 'Toda la division' }, ...divisionSubdivisiones],
    [divisionSubdivisiones]
  )

  // "Este ya fue contado": antes de mandar una revision se consulta cuantos de
  // esos productos ya se contaron hace poco y, si hay, se pide confirmar.
  const [recountConfirm, setRecountConfirm] = useState(null)
  // Un solo envio a la vez: el boton recien se deshabilitaba despues de
  // consultar "ya contados", y un doble click alcanzaba a mandar la misma
  // lista 2 o 3 veces (inspecciones repetidas para el revisor).
  const sendInFlightRef = useRef(false)
  const runExclusiveSend = useCallback(async (send) => {
    if (sendInFlightRef.current) return false
    sendInFlightRef.current = true
    try {
      return await send()
    } finally {
      sendInFlightRef.current = false
    }
  }, [])
  // Devuelve {proceed, productIds}: productIds solo cambia si el admin elige
  // "Enviar solo los no contados" (allowOnlyNew, para listas de productos).
  const askIfRecentlyCounted = useCallback(async (body, { allowOnlyNew = false } = {}) => {
    const requested = Array.isArray(body?.producto_ids) ? body.producto_ids : null
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/admin/ya-contados/`,
        { method: 'POST', body: JSON.stringify(body) },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !Number(payload?.contados)) return { proceed: true, productIds: requested }
      const choice = await new Promise((resolve) => {
        setRecountConfirm({
          total: Number(payload.total) || 0,
          contados: Number(payload.contados) || 0,
          dias: payload.dias,
          productos: Array.isArray(payload.productos) ? payload.productos : [],
          allowOnlyNew: allowOnlyNew && Boolean(requested),
          resolve,
        })
      })
      if (choice === 'cancel') return { proceed: false, productIds: requested }
      if (choice === 'only_new' && requested) {
        const counted = new Set((payload.contados_ids || []).map((id) => normalizeId(id)))
        return { proceed: true, productIds: requested.filter((id) => !counted.has(normalizeId(id))) }
      }
      return { proceed: true, productIds: requested }
    } catch {
      return { proceed: true, productIds: requested }
    }
  }, [token])

  const sendDivision = useCallback(async () => {
    if (!token) return
    if (!divisionId) { notifyError('Debes seleccionar una division.'); return }
    if (!divisionUsuarioId) { notifyError('Debes seleccionar un revisor.'); return }

    const hora = resolveSendNowHour()
    if (!hora) { notifyError('Debes seleccionar la hora del recordatorio.'); return }

    const { proceed } = await askIfRecentlyCounted({
      division_id: divisionId,
      ...(divisionSubdivisionId ? { subdivision_id: divisionSubdivisionId } : {}),
    })
    if (!proceed) return

    setDivisionSending(true)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/enviar-division/`,
        {
          method: 'POST',
          body: JSON.stringify({
            division_id: divisionId,
            ...(divisionSubdivisionId ? { subdivision_id: divisionSubdivisionId } : {}),
            usuario_id: divisionUsuarioId,
            hora_recordatorio: hora,
          }),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo enviar la division.')
      const scopeLabel = payload.subdivision_id ? 'Subdivision' : 'Division'
      notifySuccess(payload?.ya_enviada
        ? `Esa ${scopeLabel.toLowerCase()} ya estaba enviada a ${payload.nombre} y sigue pendiente: no se duplico.`
        : `${scopeLabel} enviada: ${payload.productos} producto(s) para ${payload.nombre}.`)
      setShowSendNowDialog(false)
    } catch (error) {
      notifyError(error?.message || 'No se pudo enviar la division.')
      setSendError(error?.message || 'No se pudo enviar la division.')
    } finally {
      setDivisionSending(false)
    }
  }, [token, divisionId, divisionSubdivisionId, divisionUsuarioId, notifyError, notifySuccess, askIfRecentlyCounted, resolveSendNowHour])

  // Ubicaciones (Bodega / Division / Subdivision) del producto dentro de la
  // sucursal elegida, para la columna "Ubicacion" de la lista.
  const fetchListProductLocations = useCallback(async (productIds, branchId) => {
    const locationsById = {}
    if (!token || !branchId) return locationsById
    const ids = [...productIds]
    for (let start = 0; start < ids.length; start += 6) {
      const chunk = ids.slice(start, start + 6)
      await Promise.all(chunk.map(async (productId) => {
        try {
          const response = await authFetch(
            `${API_URL}/productos/listado/${encodeURIComponent(productId)}/?include_inventory_context=1`,
            {},
            token
          )
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error('error')
          const context = payload?.inventario_context ?? payload?.inventory_context ?? {}
          const entries = Array.isArray(context?.inventario_entries)
            ? context.inventario_entries
            : (Array.isArray(context?.inventarioEntries) ? context.inventarioEntries : [])
          const labels = []
          entries.forEach((entry) => {
            const subdivision = entry?.subdivision
            const division = subdivision?.division
            const bodega = division?.bodega
            const entryBranchId = normalizeId(bodega?.sucursal?.id ?? bodega?.sucursal_id)
            if (entryBranchId !== normalizeId(branchId)) return
            if ((Number.parseInt(String(entry?.cantidad ?? 0), 10) || 0) <= 0) return
            const label = [bodega?.nombre, division?.nombre, subdivision?.nombre]
              .map((part) => String(part || '').trim())
              .filter(Boolean)
              .join(' / ')
            if (label && !labels.includes(label)) labels.push(label)
          })
          locationsById[productId] = labels.length ? labels.join(' · ') : 'Sin stock en esta sucursal'
        } catch {
          locationsById[productId] = '-'
        }
      }))
    }
    return locationsById
  }, [token])

  const addListProducts = useCallback(async (products) => {
    const branchId = normalizeId(listSucursalId)
    const seen = new Set(listProductsRef.current.map((item) => normalizeId(item.id)))
    const newRows = []
    products.forEach((product) => {
      const id = normalizeId(product?.id)
      if (!id || seen.has(id)) return
      seen.add(id)
      newRows.push({
        id,
        codigo: String(product?.codigo || '').trim(),
        nombre: String(product?.nombre || '').trim(),
        ubicacion: null,
      })
    })
    if (!newRows.length) return
    const newIds = newRows.map((row) => row.id)
    setListProducts((prev) => {
      const existing = new Set(prev.map((item) => normalizeId(item.id)))
      return [...prev, ...newRows.filter((row) => !existing.has(row.id))]
    })
    const locationsById = await fetchListProductLocations(newIds, branchId)
    setListProducts((prev) => prev.map((item) => (
      Object.prototype.hasOwnProperty.call(locationsById, item.id)
        ? { ...item, ubicacion: locationsById[item.id] }
        : item
    )))
  }, [fetchListProductLocations, listSucursalId])

  // Si cambia la sucursal, la columna Ubicacion se recalcula para esa sucursal.
  const listProductIdsKey = listProducts.map((item) => item.id).join(',')
  useEffect(() => {
    const branchId = normalizeId(listSucursalId)
    const ids = listProductIdsKey ? listProductIdsKey.split(',') : []
    if (!branchId || !ids.length) return undefined
    let cancelled = false
    setListProducts((prev) => prev.map((item) => ({ ...item, ubicacion: null })))
    void fetchListProductLocations(ids, branchId).then((locationsById) => {
      if (cancelled) return
      setListProducts((prev) => prev.map((item) => ({ ...item, ubicacion: locationsById[item.id] ?? item.ubicacion ?? '-' })))
    })
    return () => { cancelled = true }
    // Solo cuando cambia la sucursal (al agregar productos ya se calcula).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listSucursalId])

  useEffect(() => {
    const term = String(listProductQuery || '').trim()
    if (!token || !showListProductDropdown || !term) {
      setListProductOptions([])
      setListProductLoading(false)
      return undefined
    }
    let cancelled = false
    setListProductLoading(true)
    const timer = window.setTimeout(() => {
      authFetch(`${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=25`, {}, token)
        .then(async (res) => {
          const payload = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudieron buscar productos.')
          if (!cancelled) setListProductOptions(parseApiList(payload))
        })
        .catch(() => { if (!cancelled) setListProductOptions([]) })
        .finally(() => { if (!cancelled) setListProductLoading(false) })
    }, 550)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [token, showListProductDropdown, listProductQuery])

  const updateListProductDropdownPlacement = useCallback(() => {
    const trigger = listProductTriggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const spacing = 8
    const spaceBelow = window.innerHeight - rect.bottom - 12
    const spaceAbove = rect.top - 12
    const openUpward = spaceBelow < 260 && spaceAbove > spaceBelow
    const maxHeight = Math.max(160, Math.min(340, openUpward ? spaceAbove : spaceBelow))
    const panelWidth = Math.min(550, window.innerWidth - 32)
    const left = Math.min(Math.max(rect.left, 16), window.innerWidth - panelWidth - 16)
    setListProductDropdownStyle({
      left,
      maxHeight,
      ...(openUpward
        ? { bottom: window.innerHeight - rect.top + spacing }
        : { top: rect.bottom + spacing }),
    })
  }, [])

  useEffect(() => {
    if (!showListProductDropdown) return undefined
    const handleOutside = (event) => {
      if (listProductDropdownRef.current?.contains(event.target)) return
      if (listProductPanelRef.current?.contains(event.target)) return
      setShowListProductDropdown(false)
    }
    document.addEventListener('mousedown', handleOutside, true)
    return () => document.removeEventListener('mousedown', handleOutside, true)
  }, [showListProductDropdown])

  const handleListAddDraft = useCallback(() => {
    if (!listDraftProduct) return
    void addListProducts([listDraftProduct])
    setListDraftProduct(null)
  }, [addListProducts, listDraftProduct])

  // Pegar varios codigos en el buscador (uno por linea, separados por coma, o
  // una columna copiada de Excel) los agrega todos de una vez.
  const handleListBulkPaste = useCallback(async (text) => {
    if (!token) return
    const raw = String(text || '')
    const tokens = raw.includes('\t')
      ? raw.split(/\r?\n/).map((line) => line.split('\t')[0])
      : raw.split(/[\r\n,;]+/)
    const codes = []
    const seen = new Set()
    tokens.map((code) => String(code || '').trim()).filter(Boolean).forEach((code) => {
      const key = code.toUpperCase()
      if (seen.has(key)) return
      seen.add(key)
      codes.push(code)
    })
    if (!codes.length) return
    if (codes.length > 200) { notifyError('Puedes pegar hasta 200 codigos a la vez.'); return }

    setListBulkLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/productos/listado/?codigos=${encodeURIComponent(codes.join(','))}&page_size=300`,
        {},
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudieron buscar los codigos.')
      const found = parseApiList(payload)
      const foundCodes = new Set(found.map((product) => String(product?.codigo || '').trim().toUpperCase()))
      const notFound = codes.filter((code) => !foundCodes.has(code.toUpperCase()))
      setShowListProductDropdown(false)
      setListProductQuery('')
      await addListProducts(found)
      if (notFound.length) {
        notifyError(`No se encontraron ${notFound.length} codigo(s): ${notFound.slice(0, 5).join(', ')}${notFound.length > 5 ? '...' : ''}`)
      } else {
        notifySuccess(`Se agregaron ${found.length} producto(s) a la lista.`)
      }
    } catch (error) {
      notifyError(error?.message || 'No se pudieron buscar los codigos.')
    } finally {
      setListBulkLoading(false)
    }
  }, [token, addListProducts, notifyError, notifySuccess])

  const sendList = useCallback(async () => {
    if (!token) return
    if (!listSucursalId) { notifyError('Debes seleccionar una sucursal.'); return }
    if (!listUsuarioId) { notifyError('Debes seleccionar un revisor.'); return }
    if (!listProducts.length) { notifyError('Agrega al menos un producto a la lista.'); return }

    const hora = resolveSendNowHour()
    if (!hora) { notifyError('Debes seleccionar la hora del recordatorio.'); return }

    const { proceed, productIds: idsToSend } = await askIfRecentlyCounted(
      {
        sucursal_id: listSucursalId,
        producto_ids: listProducts.map((item) => item.id),
      },
      { allowOnlyNew: true }
    )
    if (!proceed || !idsToSend?.length) return

    setListSending(true)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/enviar-lista/`,
        {
          method: 'POST',
          body: JSON.stringify({
            sucursal_id: listSucursalId,
            usuario_id: listUsuarioId,
            producto_ids: idsToSend,
            hora_recordatorio: hora,
          }),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo enviar la lista.')
      notifySuccess(payload?.ya_enviada
        ? `Esa lista ya estaba enviada a ${payload.nombre} y sigue pendiente: no se duplico.`
        : `Lista enviada: ${payload.productos} producto(s) para ${payload.nombre}.`)
      setShowSendNowDialog(false)
    } catch (error) {
      notifyError(error?.message || 'No se pudo enviar la lista.')
      setSendError(error?.message || 'No se pudo enviar la lista.')
    } finally {
      setListSending(false)
    }
  }, [token, listSucursalId, listUsuarioId, listProducts, notifyError, notifySuccess, askIfRecentlyCounted, resolveSendNowHour])

  // Desde el mapa: mandar a revisar los productos que faltan de una percha.
  const sendProductListToReviewer = useCallback(async ({ sucursalId, usuarioId, productIds: requestedIds, divisionId, divisionIds }) => {
    if (!token || !sucursalId || !usuarioId || !requestedIds?.length) return false
    // Desde el mapa se mandan una o varias perchas: el aviso usa el mismo
    // criterio que el mapa (lo contado en otra percha no cuenta para estas).
    const { proceed, productIds } = await askIfRecentlyCounted(
      {
        sucursal_id: sucursalId,
        producto_ids: requestedIds,
        ...(divisionId ? { division_id: divisionId } : {}),
        ...(divisionIds?.length ? { division_ids: divisionIds } : {}),
      },
      { allowOnlyNew: true }
    )
    if (!proceed || !productIds?.length) return false
    const now = new Date()
    const hora = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/enviar-lista/`,
        {
          method: 'POST',
          body: JSON.stringify({
            sucursal_id: sucursalId,
            usuario_id: usuarioId,
            producto_ids: productIds,
            hora_recordatorio: hora,
          }),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo enviar la revision.')
      notifySuccess(payload?.ya_enviada
        ? `Esa revision ya estaba enviada a ${payload.nombre} y sigue pendiente: no se duplico.`
        : `Revision enviada: ${payload.productos} producto(s) para ${payload.nombre}.`)
      return true
    } catch (error) {
      notifyError(error?.message || 'No se pudo enviar la revision.')
      return false
    }
  }, [token, askIfRecentlyCounted, notifyError, notifySuccess])

  const loadAssignments = useCallback(async () => {
    if (!token || !canUpdate) {
      setAssignmentRows([])
      setAssignmentBranches([])
      return []
    }

    setAssignmentsLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/inspeccion-aleatoria-asignaciones/`,
        {},
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudieron cargar los usuarios asignables.')
      }
      const rows = parseApiList(payload)
      const branches = Array.isArray(payload?.sucursales) ? payload.sucursales : []
      setAssignmentRows(rows)
      setAssignmentBranches(branches)
      const map = {}
      rows.forEach((row) => {
        const id = normalizeId(row?.id)
        if (id) {
          map[id] = Array.isArray(row?.inspeccion_aleatoria_sucursales)
            ? row.inspeccion_aleatoria_sucursales.map((v) => normalizeId(v))
            : []
        }
      })
      setLocalAssignmentMap(map)
      return rows
    } catch (error) {
      setAssignmentRows([])
      setAssignmentBranches([])
      notifyError(error?.message || 'No se pudieron cargar los usuarios asignables.')
      return []
    } finally {
      setAssignmentsLoading(false)
    }
  }, [canUpdate, notifyError, token])

  // "Ir a revision" desde un recordatorio: se selecciona la sucursal de los
  // productos con diferencias de esa inspeccion (si no, quedaba la primera
  // sucursal y la tabla de diferencias salia vacia).
  useEffect(() => {
    const inspectionId = normalizeId(pendingReviewInspectionId)
    if (!inspectionId || !token) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const response = await authFetch(
          `${API_URL}/recordatorios/inspeccion-aleatoria/${encodeURIComponent(inspectionId)}/`,
          {},
          token
        )
        const payload = await response.json().catch(() => ({}))
        if (cancelled) return
        if (!response.ok) {
          throw new Error(String(payload?.detail || '').trim() || 'No se pudo cargar la inspección.')
        }
        const items = Array.isArray(payload?.inspection?.items) ? payload.inspection.items : []
        const withDifference = items.find((item) => (
          String(item?.estado_revision || '').trim().toLowerCase() === 'no_coincide'
          || item?.no_encontrado
          || item?.cambio_ubicacion
        ))
        const branchId = normalizeId(
          (withDifference || items[0])?.sucursal_id || payload?.inspection?.sucursal_id
        )
        // Se abre Diferencias con esa revision desplegada.
        setView('diferencias')
        setItemsFilter('todos')
        pendingExpandRevisionRef.current = inspectionId
        setExpandedRevisionId(inspectionId)
        if (branchId) setSelectedBranchId(branchId)
      } catch (error) {
        if (!cancelled) notifyError(error?.message || 'No se pudo abrir la inspección.')
      } finally {
        if (!cancelled) onPendingReviewInspectionHandled?.()
      }
    })()
    return () => { cancelled = true }
  }, [notifyError, onPendingReviewInspectionHandled, pendingReviewInspectionId, token])

  // `silent`: refresco automatico de fondo. No muestra el loader (la tabla
  // saltaba cada 5 s) ni borra lo que ya se ve si una consulta falla.
  const loadSummary = useCallback(async ({ silent = false } = {}) => {
    if (!token || !canRead) {
      setSummaryRows([])
      setSelectedBranchId('')
      return []
    }

    if (!silent) setSummaryLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/admin/resumen/`,
        {},
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudo cargar el resumen por sucursal.')
      }
      const rows = parseApiList(payload)
      setSummaryRows(rows)
      setSelectedBranchId((current) => {
        const currentId = normalizeId(current)
        if (currentId && rows.some((row) => normalizeId(row?.sucursal_id) === currentId)) {
          return currentId
        }
        return normalizeId(rows?.[0]?.sucursal_id)
      })
      return rows
    } catch (error) {
      if (silent) return []
      setSummaryRows([])
      setSelectedBranchId('')
      notifyError(error?.message || 'No se pudo cargar el resumen por sucursal.')
      return []
    } finally {
      if (!silent) setSummaryLoading(false)
    }
  }, [canRead, notifyError, token])

  // Productos con diferencia de la revision abierta en "Diferencias".
  const loadRevisionItems = useCallback(async ({ silent = false } = {}) => {
    const branchId = normalizeId(selectedBranchId)
    const revisionId = normalizeId(expandedRevisionId)
    if (!token || !canRead || !branchId || !revisionId) {
      setRevisionItems([])
      return []
    }
    if (!silent) setRevisionItemsLoading(true)
    try {
      const endpoint = new URL(`${API_URL}/recordatorios/inspeccion-aleatoria/admin/items/`)
      endpoint.searchParams.set('sucursal_id', branchId)
      endpoint.searchParams.set('inspeccion_id', revisionId)
      endpoint.searchParams.set('estado', 'todos')
      endpoint.searchParams.set('page', '1')
      endpoint.searchParams.set('page_size', '500')
      const response = await authFetch(endpoint.toString(), {}, token)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudieron cargar los productos de la revisión.')
      }
      const rows = parseApiList(payload)
      setRevisionItems(rows)
      return rows
    } catch (error) {
      if (silent) return []
      setRevisionItems([])
      notifyError(error?.message || 'No se pudieron cargar los productos de la revisión.')
      return []
    } finally {
      if (!silent) setRevisionItemsLoading(false)
    }
  }, [canRead, expandedRevisionId, notifyError, selectedBranchId, token])

  // Revisiones de la sucursal con sus diferencias juntas.
  const loadRevisions = useCallback(async ({ silent = false } = {}) => {
    const branchId = normalizeId(selectedBranchId)
    if (!token || !canRead || !branchId) {
      setItemsRows([])
      setItemsTotalCount(0)
      return []
    }

    if (!silent) setItemsLoading(true)
    try {
      const endpoint = new URL(`${API_URL}/recordatorios/inspeccion-aleatoria/admin/revisiones/`)
      endpoint.searchParams.set('sucursal_id', branchId)
      endpoint.searchParams.set('estado', itemsFilter)
      endpoint.searchParams.set('page', String(itemsPage))
      endpoint.searchParams.set('page_size', String(itemsPageSize))

      const response = await authFetch(endpoint.toString(), {}, token)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudieron cargar las revisiones.')
      }
      const rows = parseApiList(payload)
      const nextPage = Number.parseInt(String(payload?.page || itemsPage), 10)
      const nextCount = Number.parseInt(String(payload?.count || rows.length || 0), 10)
      setItemsRows(rows)
      setItemsTotalCount(Number.isFinite(nextCount) ? nextCount : 0)
      if (Number.isFinite(nextPage) && nextPage > 0 && nextPage !== itemsPage) {
        setItemsPage(nextPage)
      }
      return rows
    } catch (error) {
      if (silent) return []
      setItemsRows([])
      setItemsTotalCount(0)
      notifyError(error?.message || 'No se pudieron cargar las revisiones.')
      return []
    } finally {
      if (!silent) setItemsLoading(false)
    }
  }, [canRead, itemsFilter, itemsPage, itemsPageSize, notifyError, selectedBranchId, token])

  // Refresca las revisiones y los productos de la que esta abierta.
  const loadItems = useCallback(async (options = {}) => {
    await Promise.all([loadRevisions(options), loadRevisionItems(options)])
  }, [loadRevisionItems, loadRevisions])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  useEffect(() => {
    void loadRevisions()
  }, [loadRevisions])

  useEffect(() => {
    void loadRevisionItems()
  }, [loadRevisionItems])

  // Si dos administradores tienen esta pantalla abierta a la vez, uno puede
  // verificar una diferencia mientras el otro sigue viendo la lista vieja.
  // Refrescamos solos cada pocos segundos para que ambos vean lo mismo casi
  // de inmediato, sin esperar a que alguien recargue a mano. Son lecturas
  // livianas y paginadas (no la fila global de ReminderState), asi que no
  // tiene el riesgo de bloqueo que tuvo el polling de recordatorios.
  useEffect(() => {
    if (!canRead) return undefined
    const intervalId = setInterval(() => {
      if (verifyWizardOpen) return
      void loadSummary({ silent: true })
      void loadItems({ silent: true })
    }, 5000)
    return () => clearInterval(intervalId)
  }, [canRead, verifyWizardOpen, loadItems, loadSummary])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined

    const syncTheme = () => setIsDarkTheme(detectDarkTheme())
    syncTheme()

    const observedNodes = [
      document.querySelector('.app-shell'),
      document.querySelector('.dashboard-shell'),
      document.body,
    ].filter(Boolean)

    if (!observedNodes.length) return undefined

    const observer = new MutationObserver(() => {
      syncTheme()
    })

    observedNodes.forEach((node) => {
      observer.observe(node, { attributes: true, attributeFilter: ['class'] })
    })

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setItemsPage(1)
  }, [selectedBranchId, itemsFilter])

  // Otra sucursal: la revision abierta era de la anterior (salvo la que se
  // pidio abrir desde un recordatorio).
  useEffect(() => {
    setExpandedRevisionId(pendingExpandRevisionRef.current || '')
    pendingExpandRevisionRef.current = ''
  }, [selectedBranchId])

  const selectedBranch = useMemo(() => (
    summaryRows.find((row) => normalizeId(row?.sucursal_id) === normalizeId(selectedBranchId)) || null
  ), [selectedBranchId, summaryRows])

  const itemsTotalPages = useMemo(() => {
    if (itemsTotalCount <= 0 || itemsPageSize <= 0) return 1
    return Math.max(1, Math.ceil(itemsTotalCount / itemsPageSize))
  }, [itemsPageSize, itemsTotalCount])

  const filteredAssignmentRows = useMemo(() => {
    const search = String(assignmentSearch || '').trim().toLowerCase()
    if (!search) return assignmentRows
    return assignmentRows.filter((row) => {
      const fullName = String(row?.nombre_completo || '').trim().toLowerCase()
      const email = String(row?.correo || '').trim().toLowerCase()
      return fullName.includes(search) || email.includes(search)
    })
  }, [assignmentRows, assignmentSearch])

  const closeVerifyWizard = useCallback(() => {
    setVerifyWizardOpen(false)
    setVerifyWizardItems([])
    setVerifyWizardIndex(0)
    setVerifyWizardDrafts({})
    setVerifyWizardDecisions({})
    setVerifyWizardError('')
    setVerifyWizardConfirming(false)
    setVerifyWizardSubmitting(false)
    setVerifyWizardLoading(false)
    void loadSummary()
    void loadItems()
  }, [loadItems, loadSummary])

  // Trae las diferencias pendientes de la sucursal, o solo las de una
  // revision (`inspeccionId`), hasta 100 por vez, y abre el wizard en la
  // elegida (o en la primera).
  const openVerifyWizard = useCallback(async (startItemId = '', inspeccionId = '') => {
    const branchId = normalizeId(selectedBranchId)
    if (!token || !branchId) return
    setVerifyWizardOpen(true)
    setVerifyWizardLoading(true)
    setVerifyWizardError('')
    setVerifyWizardDecisions({})
    try {
      const endpoint = new URL(`${API_URL}/recordatorios/inspeccion-aleatoria/admin/items/`)
      endpoint.searchParams.set('sucursal_id', branchId)
      endpoint.searchParams.set('estado', 'pendiente')
      endpoint.searchParams.set('page', '1')
      endpoint.searchParams.set('page_size', '100')
      if (normalizeId(inspeccionId)) endpoint.searchParams.set('inspeccion_id', normalizeId(inspeccionId))
      const response = await authFetch(endpoint.toString(), {}, token)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudieron cargar las diferencias.')
      }
      const rows = parseApiList(payload)
      setVerifyWizardItems(rows)
      setVerifyWizardDrafts(rows.reduce((acc, row) => {
        const id = normalizeId(row?.id)
        const fallback = row?.cantidad_reportada ?? row?.cantidad_esperada ?? 0
        const verifiableLocations = getVerifiableLocations(row)
        acc[id] = {
          cantidad: String(Math.max(0, Number.parseInt(String(fallback || 0), 10) || 0)),
          nota: '',
          porUbicacion: verifiableLocations.length >= 2
            ? verifiableLocations.reduce((byLocation, location) => {
              byLocation[String(location.subdivision_id)] = String(
                Math.max(0, Number.parseInt(String(location.cantidad_contada ?? 0), 10) || 0)
              )
              return byLocation
            }, {})
            : null,
        }
        return acc
      }, {}))
      const startIndex = rows.findIndex((row) => normalizeId(row?.id) === normalizeId(startItemId))
      setVerifyWizardIndex(startIndex >= 0 ? startIndex : 0)
    } catch (error) {
      setVerifyWizardItems([])
      setVerifyWizardError(error?.message || 'No se pudieron cargar las diferencias.')
    } finally {
      setVerifyWizardLoading(false)
    }
  }, [selectedBranchId, token])

    const closeAssignmentsDialog = useCallback(() => {
    setShowAssignmentsDialog(false)
    setAssignmentSearch('')
  }, [])

  const openAssignmentsDialog = useCallback(() => {
    setShowAssignmentsDialog(true)
    void loadAssignments()
    void loadConfig()
  }, [loadAssignments, loadConfig])

  // Configuracion: cada cambio se guarda solo (sin boton Actualizar).
  // configSaveState: '' | 'saving' | 'saved' | 'error' (aviso arriba).
  const [configSaveState, setConfigSaveState] = useState('')
  const [assignmentPending, setAssignmentPending] = useState(() => new Set())
  const [confirmAutoToggle, setConfirmAutoToggle] = useState(false)
  const configEditedRef = useRef(false)

  const saveConfig = useCallback(async (data) => {
    if (!token || !canUpdate) return false
    const hora = String(data?.hora_recordatorio || '').trim()
    const cantidad = Number.parseInt(String(data?.cantidad_productos ?? ''), 10)
    // A medio escribir no se guarda: se guarda cuando quede valido.
    if (!hora || !Number.isFinite(cantidad) || cantidad < 1 || cantidad > 200) return false
    setConfigSaveState('saving')
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/configuracion/`,
        { method: 'PATCH', body: JSON.stringify(data) },
        token
      )
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar la configuracion.')
      }
      setConfigSaveState('saved')
      return true
    } catch (error) {
      setConfigSaveState('error')
      notifyError(error?.message || 'No se pudo guardar la configuracion.')
      void loadConfig()
      return false
    }
  }, [token, canUpdate, notifyError, loadConfig])

  // Hora y cantidad: se guardan un momento despues de dejar de escribir.
  useEffect(() => {
    if (!configEditedRef.current || !showAssignmentsDialog) return undefined
    const timer = window.setTimeout(() => {
      configEditedRef.current = false
      void saveConfig(configData)
    }, 700)
    return () => window.clearTimeout(timer)
  }, [configData, saveConfig, showAssignmentsDialog])

  const editConfig = useCallback((patch) => {
    configEditedRef.current = true
    setConfigData((prev) => ({ ...prev, ...patch }))
  }, [])

  // Revision automatica: despues de confirmar, se guarda al momento.
  const applyAutoToggle = useCallback(async () => {
    setConfirmAutoToggle(false)
    const next = { ...configData, inspeccion_automatica: !configData.inspeccion_automatica }
    setConfigData(next)
    const ok = await saveConfig(next)
    if (ok) notifySuccess(next.inspeccion_automatica ? 'Revision automatica activada.' : 'Revision automatica desactivada.')
  }, [configData, saveConfig, notifySuccess])

  // Revisores: cada casilla se guarda al momento; si falla, vuelve atras.
  const handleCheckboxChange = useCallback(async (rowId, branchId) => {
    if (!token || !canUpdate) return
    const cellKey = `${rowId}:${branchId}`
    if (assignmentPending.has(cellKey)) return
    const habilitado = !(localAssignmentMap[rowId] || []).includes(branchId)
    const withBranch = (list, on) => (on
      ? [...list.filter((id) => id !== branchId), branchId]
      : list.filter((id) => id !== branchId))
    setLocalAssignmentMap((prev) => ({ ...prev, [rowId]: withBranch(prev[rowId] || [], habilitado) }))
    setAssignmentPending((prev) => new Set(prev).add(cellKey))
    setConfigSaveState('saving')
    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/${encodeURIComponent(rowId)}/inspeccion-aleatoria-asignacion/`,
        { method: 'PATCH', body: JSON.stringify({ sucursal_id: branchId, habilitado }) },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar el revisor.')
      // Lo guardado pasa a ser el estado de esa fila.
      setAssignmentRows((prev) => prev.map((row) => (normalizeId(row?.id) === rowId
        ? { ...row, inspeccion_aleatoria_sucursales: withBranch((row?.inspeccion_aleatoria_sucursales || []).map((v) => normalizeId(v)), habilitado) }
        : row)))
      setConfigSaveState('saved')
    } catch (error) {
      setLocalAssignmentMap((prev) => ({ ...prev, [rowId]: withBranch(prev[rowId] || [], !habilitado) }))
      setConfigSaveState('error')
      notifyError(error?.message || 'No se pudo guardar el revisor.')
    } finally {
      setAssignmentPending((prev) => {
        const next = new Set(prev)
        next.delete(cellKey)
        return next
      })
    }
  }, [token, canUpdate, assignmentPending, localAssignmentMap, notifyError])

  // "No lo encontre": ubicaciones de la sucursal para reubicar el producto.
  const [relocateOptionsByBranch, setRelocateOptionsByBranch] = useState({})
  const currentVerifyItem = verifyWizardOpen ? verifyWizardItems[verifyWizardIndex] || null : null
  const currentVerifyBranchId = currentVerifyItem?.no_encontrado ? normalizeId(currentVerifyItem?.sucursal_id) : ''
  const relocateRequestedRef = useRef(new Set())
  useEffect(() => {
    if (!token || !currentVerifyBranchId || relocateRequestedRef.current.has(currentVerifyBranchId)) return
    const branchId = currentVerifyBranchId
    relocateRequestedRef.current.add(branchId)
    setRelocateOptionsByBranch((prev) => ({ ...prev, [branchId]: { loading: true, options: [] } }))
    authFetch(`${API_URL}/inventario/subdivisiones/?page_size=2000&sucursal_id=${encodeURIComponent(branchId)}`, {}, token)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('error'))))
      .then((payload) => {
        const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.results) ? payload.results : [])
        const options = list
          .map((subdivision) => ({
            id: normalizeId(subdivision?.id),
            nombre: String(subdivision?.nombre || '').trim(),
            divisionId: normalizeId(subdivision?.division?.id),
            divisionNombre: String(subdivision?.division?.nombre || '').trim(),
            bodegaId: normalizeId(subdivision?.division?.bodega?.id),
            bodegaNombre: String(subdivision?.division?.bodega?.nombre || '').trim(),
            label: [subdivision?.division?.bodega?.nombre, subdivision?.division?.nombre, subdivision?.nombre]
              .map((part) => String(part || '').trim())
              .filter(Boolean)
              .join(' / '),
          }))
          .filter((option) => option.id && option.label)
          .sort((left, right) => left.label.localeCompare(right.label, 'es', { numeric: true }))
        setRelocateOptionsByBranch((prev) => ({ ...prev, [branchId]: { loading: false, options } }))
      })
      .catch(() => {
        // Se puede volver a intentar al volver a este producto.
        relocateRequestedRef.current.delete(branchId)
        setRelocateOptionsByBranch((prev) => ({ ...prev, [branchId]: { loading: false, options: [], error: true } }))
      })
  }, [token, currentVerifyBranchId])

  const submitVerifyDecision = useCallback(async (action, options = {}) => {
    const item = verifyWizardItems[verifyWizardIndex]
    const itemId = normalizeId(item?.id)
    if (!token || !itemId || verifyWizardDecisions[itemId]) return

    const draft = verifyWizardDrafts[itemId] || {}
    const body = { accion: action, nota: String(draft?.nota || '').trim() }
    let changedFromCount = false
    if (action === 'mover_aqui') {
      body.cantidad_confirmada = Number.parseInt(String(item?.cantidad_reportada ?? 0), 10) || 0
    } else if (action === 'reubicar') {
      if (!draft?.reubicar) {
        setVerifyWizardError('Elige la nueva ubicacion del producto.')
        return
      }
      body.subdivision_id = Number(draft.reubicar)
    } else if (action === 'aprobar' && draft?.porUbicacion) {
      const entries = Object.entries(draft.porUbicacion)
      const parsed = entries.map(([subdivisionId, value]) => ({
        subdivision_id: Number(subdivisionId),
        cantidad: Number.parseInt(String(value ?? '').trim(), 10),
      }))
      if (parsed.some((entry) => !Number.isFinite(entry.cantidad) || entry.cantidad < 0)) {
        setVerifyWizardError('Ingresa una cantidad valida en cada ubicacion.')
        return
      }
      body.cantidades_por_ubicacion = parsed
      body.cantidad_confirmada = parsed.reduce((total, entry) => total + entry.cantidad, 0)
      const countedBySubdivision = getVerifiableLocations(item).reduce((acc, location) => {
        acc[Number(location.subdivision_id)] = Number.parseInt(String(location.cantidad_contada ?? 0), 10) || 0
        return acc
      }, {})
      changedFromCount = parsed.some((entry) => entry.cantidad !== countedBySubdivision[entry.subdivision_id])
    } else if (action === 'aprobar') {
      const nextQty = Number.parseInt(String(draft?.cantidad ?? '').trim(), 10)
      if (!Number.isFinite(nextQty) || nextQty < 0) {
        setVerifyWizardError('Debes ingresar una cantidad valida mayor o igual a cero.')
        return
      }
      body.cantidad_confirmada = nextQty
      const reportedQty = Number.parseInt(String(item?.cantidad_reportada ?? ''), 10)
      changedFromCount = Number.isFinite(reportedQty) && nextQty !== reportedQty
    }

    if (action === 'aprobar') {
      body.no_encontrado_a_temporal = draft?.aTemporal !== false
    }

    if (action === 'aprobar' && changedFromCount) {
      // Se va a dejar una cantidad distinta de la contada: primero la
      // advertencia, y no se guarda sin una nota que explique que paso.
      if (!options.confirmed) {
        setVerifyWizardError('')
        setVerifyWizardConfirming(true)
        return
      }
      if (!body.nota) {
        setVerifyWizardError('Agrega una nota de verificacion explicando por que cambia la cantidad.')
        return
      }
    }

    setVerifyWizardError('')
    setVerifyWizardSubmitting(true)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/items/${encodeURIComponent(itemId)}/verificar/`,
        { method: 'POST', body: JSON.stringify(body) },
        token
      )
      const payload = await response.json().catch(() => ({}))
      // Otro admin ya lo verifico: se toma su decision y se sigue con el siguiente.
      const alreadyVerified = !response.ok && payload?.ya_verificado
      if (!response.ok && !alreadyVerified) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar la verificacion.')
      }
      if (alreadyVerified) {
        notifySuccess('Este producto ya lo verifico otro administrador; se pasa al siguiente.')
      }
      // Unidades de mas que cierran faltantes abiertos de revisiones anteriores.
      const recuperados = Array.isArray(payload?.recupera_faltantes) ? payload.recupera_faltantes : []
      if (recuperados.length) {
        notifySuccess(`Cierra faltante de ${recuperados.map((entry) => `la inspección #${entry.inspeccion_id} (${entry.cantidad})`).join(', ')}.`)
      }
      const nextDecisions = {
        ...verifyWizardDecisions,
        [itemId]: alreadyVerified
          ? (String(payload?.verificacion_estado || '').trim().toLowerCase() === 'rechazada' ? 'rechazada' : 'aprobada')
          : action === 'aprobar'
            ? 'aprobada'
            : action === 'reubicar' ? 'reubicada' : action === 'mover_aqui' ? 'movida' : action === 'recontar' ? 'reenviada' : 'rechazada',
      }
      if (action === 'recontar' && !alreadyVerified) {
        notifySuccess(`${String(item?.producto_codigo || 'El producto').trim()} se envió a contar de nuevo (conteo ${getNextCountLabel(item)}).`)
      }
      setVerifyWizardDecisions(nextDecisions)
      setVerifyWizardConfirming(false)
      // Siguiente diferencia sin decidir (hacia adelante y luego desde el inicio).
      const total = verifyWizardItems.length
      let nextIndex = -1
      for (let offset = 1; offset <= total; offset += 1) {
        const candidate = (verifyWizardIndex + offset) % total
        if (!nextDecisions[normalizeId(verifyWizardItems[candidate]?.id)]) {
          nextIndex = candidate
          break
        }
      }
      setVerifyWizardIndex(nextIndex >= 0 ? nextIndex : total)
    } catch (error) {
      setVerifyWizardError(error?.message || 'No se pudo guardar la verificacion.')
    } finally {
      setVerifyWizardSubmitting(false)
    }
  }, [token, verifyWizardDecisions, verifyWizardDrafts, verifyWizardIndex, verifyWizardItems, notifySuccess])

    // Todas las sucursales (con o sin revisores asignados) -- el modo
  // "Division" del envio manual necesita poder elegir cualquiera de ellas,
  // aunque todavia no tenga revisores (ahi se muestra el aviso de "sin
  // revisores asignados" en vez de esconder la sucursal del selector).
  const allBranchOptions = useMemo(() => {
    return assignmentBranches.map((branch) => ({
      id: normalizeId(branch?.id),
      nombre: String(branch?.nombre || '').trim(),
    }))
  }, [assignmentBranches])

  const reviewersByBranch = useMemo(() => {
    return assignmentBranches.map((branch) => {
      const branchId = normalizeId(branch?.id)
      const assigned = assignmentRows.filter((row) => {
        const ids = Array.isArray(row?.inspeccion_aleatoria_sucursales)
          ? row.inspeccion_aleatoria_sucursales.map((v) => normalizeId(v))
          : []
        return ids.includes(branchId)
      })
      return {
        id: branchId,
        nombre: String(branch?.nombre || '').trim(),
        reviewers: assigned.filter((row) => row?.activo !== false),
        inactive: assigned.filter((row) => row?.activo === false),
      }
    })
  }, [assignmentBranches, assignmentRows])

  const sendNowSummary = useMemo(
    () => reviewersByBranch.filter((b) => b.reviewers.length > 0),
    [reviewersByBranch]
  )

  // Cualquier cambio en el formulario borra el error del ultimo intento.
  useEffect(() => {
    setSendError('')
  }, [sendNowMode, listSucursalId, listUsuarioId, listProducts.length, divisionSucursalId, divisionId, divisionSubdivisionId, divisionUsuarioId])

  // Por que no se puede enviar a una sucursal (o null si si se puede).
  const branchBlocker = useCallback((branchId) => {
    if (!branchId || assignmentsLoading) return null
    const branch = reviewersByBranch.find((b) => b.id === normalizeId(branchId))
    if (!branch || branch.reviewers.length > 0) return null
    const nombre = branch.nombre || 'esta sucursal'
    const inactiveNames = branch.inactive
      .map((u) => String(u?.nombre_completo || u?.correo || '').trim())
      .filter(Boolean)
    const reason = inactiveNames.length
      ? `Los revisores asignados a ${nombre} (${inactiveNames.join(', ')}) tienen el usuario inactivo, y una revisión solo se puede enviar a un usuario activo. Activa el usuario en Administración › Usuarios o asigna a otro revisor a ${nombre} en Configuración.`
      : `Ningún usuario tiene asignada la revisión de inventario de ${nombre}, así que no hay a quién enviársela. Asigna al menos un revisor activo a ${nombre} en Configuración y vuelve a intentarlo.`
    return { title: `No se puede enviar a ${nombre}: no tiene revisores`, reason, goTo: inactiveNames.length ? 'Usuarios' : null }
  }, [reviewersByBranch, assignmentsLoading])

  const divisionReviewers = useMemo(() => {
    if (!divisionSucursalId) return []
    return sendNowSummary.find((b) => b.id === normalizeId(divisionSucursalId))?.reviewers || []
  }, [sendNowSummary, divisionSucursalId])

  const listReviewers = useMemo(() => {
    if (!listSucursalId) return []
    return sendNowSummary.find((b) => b.id === normalizeId(listSucursalId))?.reviewers || []
  }, [sendNowSummary, listSucursalId])

  const toCount = (value) => Number.parseInt(String(value || 0), 10) || 0

  // Historial: cada revision se abre como en Inconvenientes (resumen arriba;
  // productos pendientes arriba, solucionados y revisados abajo).
  // Reenviar conteo desde el detalle de la revision (uno o todos los pendientes).
  const [recountSendingId, setRecountSendingId] = useState('')
  // Productos que se van a reenviar (se pregunta antes, uno o todos).
  const [recountConfirmRows, setRecountConfirmRows] = useState(null)
  const resendToRecount = async (rows) => {
    const list = rows.filter((row) => Number(row?.reconteos || 0) < Number(row?.max_reconteos || 2))
    if (!token || !list.length || recountSendingId) return
    setRecountSendingId(list.length === 1 ? normalizeId(list[0]?.id) : 'all')
    let sent = 0
    const errors = []
    try {
      for (const row of list) {
        const response = await authFetch(
          `${API_URL}/recordatorios/inspeccion-aleatoria/items/${encodeURIComponent(normalizeId(row?.id))}/verificar/`,
          { method: 'POST', body: JSON.stringify({ accion: 'recontar' }) },
          token
        )
        const payload = await response.json().catch(() => ({}))
        if (response.ok) sent += 1
        else errors.push(`${String(row?.producto_codigo || '').trim()}: ${String(payload?.detail || 'no se pudo').trim()}`)
      }
      if (sent) notifySuccess(sent === 1 ? 'Se envió a contar de nuevo.' : `Se enviaron ${sent} productos a contar de nuevo.`)
      if (errors.length) notifyError(errors.join(' · '))
    } finally {
      setRecountSendingId('')
      setRecountConfirmRows(null)
      void loadSummary({ silent: true })
      void loadItems({ silent: true })
    }
  }

  // Producto que el revisor movio de fila: primero se decide el cambio.
  // Aprobar mueve el stock a la fila nueva (el total no cambia); mantener no
  // mueve nada. Si la cantidad cuadraba queda resuelto; si no, queda
  // pendiente para reenviar conteo o ajustar.
  const [movedDecidingId, setMovedDecidingId] = useState('')
  const postMoveDecision = useCallback(async (itemId, approve) => {
    const response = await authFetch(
      `${API_URL}/recordatorios/inspeccion-aleatoria/items/${encodeURIComponent(itemId)}/verificar/`,
      { method: 'POST', body: JSON.stringify({ accion: 'decidir_movimiento', aprobar_movimiento: Boolean(approve) }) },
      token
    )
    const payload = await response.json().catch(() => ({}))
    if (!response.ok && !payload?.ya_verificado) {
      throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar la decisión.')
    }
    return payload
  }, [token])
  const describeMoveDecision = (codigo, approve, payload, isNew = false) => {
    if (payload?.ya_verificado) return `${codigo} ya lo decidió otro administrador.`
    const base = isNew
      ? (approve ? `${codigo}: ubicación nueva aprobada.` : `${codigo}: se queda en su ubicación de antes.`)
      : (approve ? `${codigo}: cambio de fila aprobado.` : `${codigo}: se queda en su fila de antes.`)
    return payload?.pendiente_cantidad
      ? `${base} La cantidad no cuadra: ahora puedes reenviar el conteo o verificarla.`
      : base
  }
  // Lo mismo desde "Verificar": si la cantidad cuadraba pasa al siguiente;
  // si no, se queda en este producto ya con las opciones de cantidad.
  const decideMoveInWizard = async (approve) => {
    const item = verifyWizardItems[verifyWizardIndex]
    const itemId = normalizeId(item?.id)
    if (!token || !itemId || verifyWizardSubmitting || verifyWizardDecisions[itemId]) return
    setVerifyWizardError('')
    setVerifyWizardSubmitting(true)
    try {
      const payload = await postMoveDecision(itemId, approve)
      notifySuccess(describeMoveDecision(String(item?.producto_codigo || 'El producto').trim(), approve, payload, isNewLocationAwaitingDecision(item)))
      if (payload?.pendiente_cantidad) {
        setVerifyWizardItems((prev) => prev.map((row) => (
          normalizeId(row?.id) === itemId
            ? { ...row, movimiento_decision: payload?.movimiento_decision || (approve ? 'aprobado' : 'rechazado') }
            : row
        )))
        return
      }
      const nextDecisions = {
        ...verifyWizardDecisions,
        [itemId]: payload?.ya_verificado
          ? (String(payload?.verificacion_estado || '').trim().toLowerCase() === 'rechazada' ? 'rechazada' : 'aprobada')
          : approve ? 'aprobada' : 'rechazada',
      }
      setVerifyWizardDecisions(nextDecisions)
      const total = verifyWizardItems.length
      let nextIndex = -1
      for (let offset = 1; offset <= total; offset += 1) {
        const candidate = (verifyWizardIndex + offset) % total
        if (!nextDecisions[normalizeId(verifyWizardItems[candidate]?.id)]) {
          nextIndex = candidate
          break
        }
      }
      setVerifyWizardIndex(nextIndex >= 0 ? nextIndex : total)
    } catch (error) {
      setVerifyWizardError(error?.message || 'No se pudo guardar la decisión.')
    } finally {
      setVerifyWizardSubmitting(false)
    }
  }
  const decideMovedRow = async (row, approve) => {
    const itemId = normalizeId(row?.id)
    if (!token || !itemId || movedDecidingId) return
    setMovedDecidingId(itemId)
    try {
      const payload = await postMoveDecision(itemId, approve)
      notifySuccess(describeMoveDecision(String(row?.producto_codigo || 'El producto').trim(), approve, payload, isNewLocationAwaitingDecision(row)))
    } catch (error) {
      notifyError(error?.message || 'No se pudo guardar la decisión.')
    } finally {
      setMovedDecidingId('')
      void loadRevisionItems({ silent: true })
      void loadSummary({ silent: true })
      void loadItems({ silent: true })
    }
  }
  // Repartido distinto (total correcto): aprobar deja cada ubicacion como la
  // conto el revisor; mantener no mueve nada.
  const decideLocationChangeRow = async (row, approve) => {
    const itemId = normalizeId(row?.id)
    if (!token || !itemId || movedDecidingId) return
    const codigo = String(row?.producto_codigo || 'El producto').trim()
    const body = { accion: approve ? 'aprobar' : 'rechazar', nota: '' }
    if (approve) {
      const parsed = getVerifiableLocations(row).map((location) => ({
        subdivision_id: Number(location.subdivision_id),
        cantidad: Math.max(0, Number.parseInt(String(location.cantidad_contada ?? 0), 10) || 0),
      }))
      body.cantidades_por_ubicacion = parsed
      body.cantidad_confirmada = parsed.reduce((total, entry) => total + entry.cantidad, 0)
    }
    setMovedDecidingId(itemId)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/items/${encodeURIComponent(itemId)}/verificar/`,
        { method: 'POST', body: JSON.stringify(body) },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok && !payload?.ya_verificado) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar la decisión.')
      }
      notifySuccess(payload?.ya_verificado
        ? `${codigo} ya lo decidió otro administrador.`
        : approve ? `${codigo}: cambio de ubicación aprobado.` : `${codigo}: las ubicaciones quedan como estaban.`)
    } catch (error) {
      notifyError(error?.message || 'No se pudo guardar la decisión.')
    } finally {
      setMovedDecidingId('')
      void loadRevisionItems({ silent: true })
      void loadSummary({ silent: true })
      void loadItems({ silent: true })
    }
  }

  const renderRevisionDetail = () => {
    const revision = itemsRows.find((row) => normalizeId(row?.id) === normalizeId(expandedRevisionId)) || null
    const state = REVISION_STATES[revision?.estado_revision] || REVISION_STATES.revisada
    const sortedItems = [...revisionItems].sort((a, b) => ITEM_ORDER[getItemStatus(a).key] - ITEM_ORDER[getItemStatus(b).key])
    const pendingCount = revisionItems.filter((row) => getItemStatus(row).key === 'pendiente').length
    const isRecountable = (row) => (
      getItemStatus(row).key === 'pendiente' &&
      Number(row?.reconteos || 0) < Number(row?.max_reconteos || 2) &&
      !isMoveAwaitingDecision(row) &&
      !isNewLocationAwaitingDecision(row) &&
      !isLocationChangeAwaitingDecision(row)
    )
    const recountableCount = revisionItems.filter(isRecountable).length
    const solvedCount = revisionItems.filter((row) => ['solucionado', 'mantenido', 'reconteo'].includes(getItemStatus(row).key)).length
    const close = () => setExpandedRevisionId('')
    return (
      <div className="create-user__overlay" role="dialog" aria-modal="true">
        <div
          className="create-user__modal create-salida__modal inspection-admin__history-modal"
          style={revisionModal.style}
        >
          <header className="create-user__header" {...revisionModal.headerProps}>
            <div className="create-user__header-text">
              <h3>{`Revisión: ${String(revision?.codigo || `#${expandedRevisionId}`).trim()}`}</h3>
            </div>
            <div className="create-user__header-actions">
              <button
                type="button"
                className="create-user__icon-button create-user__icon-button--maximize"
                onClick={revisionModal.toggleMaximize}
                aria-label={revisionModal.maximized ? 'Restaurar' : 'Maximizar'}
              >
                <i className={revisionModal.maximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
              </button>
              <button type="button" className="create-user__icon-button" onClick={close} aria-label="Cerrar">
                <i className="pi pi-times" />
              </button>
            </div>
          </header>

          <div className="create-user__form">
            <div className="create-user__content create-salida__content">
            <div className="create-user__body transfer-issues-detail__body inspection-admin__history-body">
              <section className="create-user__section inspection-admin__history-head">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Resumen</p>
                    <h4>Detalle general</h4>
                  </div>
                  <span className={`transfer-issues-state transfer-issues-state--${state.chip}`}>{state.label}</span>
                </div>
                <div className="create-salida__field-group--defined">
                  <div className="create-user__grid inspection-admin__history-summary">
                    <StaticFieldDisplay label="Código" value={String(revision?.codigo || '-')} />
                    <StaticFieldDisplay label="Qué se revisó" value={String(revision?.descripcion || '-')} />
                    <StaticFieldDisplay label="Revisor" value={String(revision?.usuario_nombre || '-')} />
                    <StaticFieldDisplay
                      label="Fecha"
                      value={formatDateTime(revision?.completada_en || revision?.ultima_actividad || revision?.fecha_programada)}
                    />
                    <StaticFieldDisplay label="Solucionados" value={String(solvedCount)} />
                    <StaticFieldDisplay label="Pendientes" value={String(pendingCount)} />
                  </div>
                </div>
              </section>

              {revisionItemsLoading && !revisionItems.length ? (
                <p className="muted transfer-issues-details__hint">Cargando productos...</p>
              ) : null}

              <section className="transfer-issues-branch inspection-admin__history-products">
                <p className="inspection-admin__history-products-title">{`Productos (${revisionItems.length})`}</p>
                <div className="transfer-issues-branch__list">
                  {sortedItems.map((row) => {
                    const status = getItemStatus(row)
                    const expected = toCount(row?.cantidad_esperada)
                    const reported = row?.cantidad_reportada == null ? null : toCount(row.cantidad_reportada)
                    const diff = reported == null ? null : reported - expected
                    const awaitingNewLocation = canUpdate && status.key === 'pendiente' && isNewLocationAwaitingDecision(row)
                    const awaitingMove = (canUpdate && status.key === 'pendiente' && isMoveAwaitingDecision(row)) || awaitingNewLocation
                    const awaitingLocationChange = canUpdate && status.key === 'pendiente' && isLocationChangeAwaitingDecision(row)
                    // Hasta decidir el cambio de fila no se reenvia ni se verifica;
                    // si solo cambio el reparto (total correcto) basta con decidirlo.
                    const canFix = canUpdate && status.key === 'pendiente' && (!awaitingMove || awaitingNewLocation) && !awaitingLocationChange
                    const note = String(row?.nota_verificacion || row?.observacion || '').trim()
                    return (
                      <div
                        key={`history-item-${normalizeId(row?.id)}`}
                        className={`transfer-issues-item ${status.key === 'pendiente' ? 'transfer-issues-item--pending' : status.key === 'sin_contar' ? '' : 'transfer-issues-item--solved'}`}
                      >
                        <div className="transfer-issues-item__info">
                          <strong>{String(row?.producto_codigo || '').trim() || `#${row?.producto_id || '-'}`}</strong>
                          <span>{String(row?.producto_nombre || 'Producto').trim()}</span>
                          <small>
                            {reported == null
                              ? `Esperado ${expected} · sin contar`
                              : `Esperado ${expected} · contado ${reported}${row?.no_encontrado ? ' (no lo encontró)' : ''}`}
                          </small>
                          {row?.movido_por_revisor && !row?.agregado_por_revisor && row?.encontrado_en?.label ? (
                            <small className="inspection-admin__moved-note">
                              {`El revisor lo pasó a ${String(row.encontrado_en.label).trim()}`}
                              {row?.movimiento_decision === 'aprobado' ? ' · cambio aprobado' : row?.movimiento_decision === 'rechazado' ? ' · se quedó donde estaba' : ''}
                            </small>
                          ) : null}
                          {row?.cambio_ubicacion && !row?.movido_por_revisor && getVerifiableLocations(row).length >= 2 ? (
                            <small className="inspection-admin__moved-note">
                              {row?.agregado_por_revisor && row?.encontrado_en?.label ? `No estaba en la lista: lo encontró en ${String(row.encontrado_en.label).trim()}. ` : ''}
                              {`Repartido distinto: ${getVerifiableLocations(row)
                                .map((location) => `${String(location?.label || 'Ubicación').trim()} (había ${toCount(location.cantidad_sistema)}, contó ${toCount(location.cantidad_contada)})`)
                                .join(' · ')}`}
                              {status.key === 'solucionado' ? ' · cambio aprobado' : status.key === 'mantenido' ? ' · se quedó como estaba' : ''}
                            </small>
                          ) : null}
                          {awaitingNewLocation ? (
                            <small className="inspection-admin__moved-note">
                              {`Lo encontró en una ubicación nueva${row?.encontrado_en?.label ? ` (${String(row.encontrado_en.label).trim()})` : ''}. Acepta o rechaza la ubicación antes de reenviar el conteo: así el reconteo busca donde corresponde.`}
                            </small>
                          ) : null}
                          <RecountDots row={row} />
                        </div>
                        {diff ? (
                          <span className={`transfer-issues-item__qty transfer-issues-cantidad--${diff > 0 ? 'sobrante' : 'faltante'}`}>
                            {diff > 0 ? `+${diff}` : `−${Math.abs(diff)}`}
                          </span>
                        ) : <span />}
                        <div className="transfer-issues-item__actions">
                          {awaitingMove ? (
                            <>
                              <button
                                type="button"
                                className="inspection-admin__action"
                                onClick={() => void decideMovedRow(row, false)}
                                disabled={Boolean(movedDecidingId)}
                              >
                                Mantener como estaba
                              </button>
                              <button
                                type="button"
                                className="inspection-admin__action inspection-admin__action--approve"
                                onClick={() => void decideMovedRow(row, true)}
                                disabled={Boolean(movedDecidingId)}
                              >
                                {movedDecidingId === normalizeId(row?.id) ? <Loader2 size={13} /> : <PackageCheck size={13} />}
                                {isNewLocationAwaitingDecision(row) ? 'Aprobar ubicación nueva' : 'Aprobar cambio'}
                              </button>
                            </>
                          ) : null}
                          {awaitingLocationChange ? (
                            <>
                              <button
                                type="button"
                                className="inspection-admin__action"
                                onClick={() => void decideLocationChangeRow(row, false)}
                                disabled={Boolean(movedDecidingId)}
                              >
                                Mantener como estaba
                              </button>
                              <button
                                type="button"
                                className="inspection-admin__action inspection-admin__action--approve"
                                onClick={() => void decideLocationChangeRow(row, true)}
                                disabled={Boolean(movedDecidingId)}
                              >
                                {movedDecidingId === normalizeId(row?.id) ? <Loader2 size={13} /> : <PackageCheck size={13} />}
                                Aprobar cambio
                              </button>
                            </>
                          ) : null}
                          {canFix && !awaitingNewLocation && Number(row?.reconteos || 0) < Number(row?.max_reconteos || 2) ? (
                            <button
                              type="button"
                              className="inspection-admin__action inspection-admin__recount-btn"
                              onClick={() => setRecountConfirmRows([row])}
                              disabled={Boolean(recountSendingId)}
                              data-title={`Manda a contar de nuevo este producto al mismo revisor (conteo ${getNextCountLabel(row)}). No ajusta nada.`}
                            >
                              {recountSendingId === normalizeId(row?.id) ? <Loader2 size={13} /> : <RefreshCw size={13} />}
                              {`Reenviar conteo (${getCountNumber(row) + 1}/${getMaxCounts(row)})`}
                            </button>
                          ) : null}
                          {canFix ? (
                            <button
                              type="button"
                              className="inspection-admin__action"
                              onClick={() => void openVerifyWizard(normalizeId(row?.id), normalizeId(expandedRevisionId))}
                            >
                              <Wrench size={13} />
                              Verificar
                            </button>
                          ) : null}
                        </div>
                        {status.key !== 'pendiente' && status.key !== 'sin_contar' ? (
                          <div className="transfer-issues-item__solution">
                            <i className={`pi ${status.key === 'revisado' ? 'pi-check' : 'pi-check-circle'}`} aria-hidden="true" />
                            <span>
                              {`${status.label}: ${describeItemResolution(row)}`}
                              {note ? <em>{` · ${note}`}</em> : null}
                              {String(row?.verificado_por || '').trim() ? <em>{` · ${String(row.verificado_por).trim()}`}</em> : null}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                  {!revisionItemsLoading && !revisionItems.length ? (
                    <p className="muted transfer-issues-details__hint">Esta revisión no tiene productos.</p>
                  ) : null}
                </div>
              </section>
            </div>
            </div>

            <footer className="create-user__footer">
              <button type="button" className="create-user__action create-user__action--secondary" onClick={close}>
                Cerrar
              </button>
              {canUpdate && pendingCount > 0 ? (
                <div className="inspection-admin__dialog-actions-left">
                  {recountableCount > 0 && (
                    <button
                      type="button"
                      className="create-user__action create-user__action--secondary inspection-admin__footer-recount inspection-admin__recount-btn"
                      onClick={() => setRecountConfirmRows(revisionItems.filter(isRecountable))}
                      disabled={Boolean(recountSendingId)}
                    >
                      <RefreshCw size={14} />
                      {`Reenviar conteo de pendientes (${recountableCount})`}
                    </button>
                  )}
                  <button
                    type="button"
                    className="create-user__action create-user__action--primary"
                    onClick={() => void openVerifyWizard('', normalizeId(expandedRevisionId))}
                  >
                    {`Verificar pendientes (${pendingCount})`}
                  </button>
                </div>
              ) : null}
            </footer>
            {Array.isArray(recountConfirmRows) && recountConfirmRows.length > 0 && (
              <div className="quick-actions__inspection-move-overlay" onMouseDown={() => { if (!recountSendingId) setRecountConfirmRows(null) }}>
                <div className="quick-actions__inspection-move-card" role="alertdialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="quick-actions__inspection-move-warning">
                    <i className="pi pi-refresh" aria-hidden="true" />
                    <div>
                      <strong>
                        {recountConfirmRows.length === 1
                          ? `¿Reenviar ${String(recountConfirmRows[0]?.producto_codigo || 'este producto').trim()} a contar de nuevo? (conteo ${getNextCountLabel(recountConfirmRows[0])})`
                          : `¿Reenviar ${recountConfirmRows.length} productos a contar de nuevo?`}
                      </strong>
                      <p>{`Le llegan a ${String(revision?.usuario_nombre || 'el revisor').trim()} en una revisión "Reconteo de ${String(revision?.codigo || '').trim()}". No se ajusta nada del inventario.`}</p>
                      {recountConfirmRows.length > 1 && pendingCount > recountableCount && (
                        <p>{`${pendingCount - recountableCount} ya se recontaron 3 veces: esos hay que solucionarlos aquí.`}</p>
                      )}
                    </div>
                  </div>
                  <div className="quick-actions__inspection-move-actions">
                    <button type="button" className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost" onClick={() => setRecountConfirmRows(null)} disabled={Boolean(recountSendingId)}>
                      Cancelar
                    </button>
                    <button
                      type="button"
                      className="quick-actions__inspection-btn quick-actions__inspection-btn--primary"
                      onClick={() => void resendToRecount(recountConfirmRows)}
                      disabled={Boolean(recountSendingId)}
                    >
                      {recountSendingId ? 'Enviando...' : 'Sí, reenviar conteo'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          {!revisionModal.maximized && (
            <button
              type="button"
              aria-label="Cambiar tamaño de ventana"
              className="create-user__resize-handle"
              {...revisionModal.resizeHandleProps}
            />
          )}
        </div>
      </div>
    )
  }

  if (!canRead) {
    return (
      <section className="inspection-admin">
        <p className="inspection-admin__empty">No tienes permisos para acceder a esta seccion.</p>
      </section>
    )
  }

  return (
    <section className="users-page inspection-admin">
      <Toast ref={toast} />

      {/* Barra fija de acciones (como en el resto de pantallas); debajo, una
          tarjeta con Sucursales y Diferencias que se desplaza por dentro. */}
      <header className="users-page__actions inspection-admin__head">
        {/* Como en importaciones: arriba se elige la pantalla. */}
        <div className="transfer-issues-page__type-filter" role="group" aria-label="Pantalla">
          {[
            { key: 'sucursales', label: 'Sucursales' },
            {
              key: 'diferencias',
              label: summaryRows.reduce((total, row) => total + (Number(row?.pendientes_verificacion) || 0), 0) > 0
                ? `Diferencias (${summaryRows.reduce((total, row) => total + (Number(row?.pendientes_verificacion) || 0), 0)})`
                : 'Diferencias',
            },
          ].map((option) => (
            <Button
              key={option.key}
              type="button"
              label={option.label}
              className={`users-topbtn transfer-issues-page__type-btn${view === option.key ? ' transfer-issues-page__type-btn--active' : ''}`}
              onClick={() => setView(option.key)}
            />
          ))}
        </div>
        <div className="inspection-admin__head-actions">
          {view === 'sucursales' && canUpdate && (
            <button
              type="button"
              className="inspection-admin__manage"
              onClick={async () => {
                // Abre el diálogo de inmediato (con su propio spinner de
                // "Cargando datos...") en vez de esperar a que terminen las
                // peticiones antes de mostrar nada: antes el botón se sentía
                // trabado varios segundos sin ninguna señal de que algo
                // estaba pasando.
                setShowSendNowDialog(true)
                setSendNowDialogLoading(true)
                setSendNowMode('aleatorio')
                setSendNowImmediate(false)
                setDivisionSucursalId('')
                setDivisionBodegaId('')
                setDivisionId('')
                setDivisionSubdivisionId('')
                setDivisionUsuarioId('')
                setListSucursalId('')
                setListUsuarioId('')
                setListProducts([])
                setListDraftProduct(null)
                setListProductQuery('')
                setListProductOptions([])
                setShowListProductDropdown(false)
                try {
                  const now = new Date()
                  now.setMinutes(now.getMinutes() + 5)
                  const defaultTime = `${String(now.getHours()).padStart(2, '0')}:${String(
                    now.getMinutes()
                  ).padStart(2, '0')}`

                  setSendNowParams({
                    cantidad_productos: configData.cantidad_productos,
                    hora_recordatorio: defaultTime,
                  })

                  // Load data in parallel
                  const [rows] = await Promise.all([loadAssignments(), loadConfig()])
                  const allIds = new Set(
                    (rows || [])
                      .filter((r) => Array.isArray(r?.inspeccion_aleatoria_sucursales) && r.inspeccion_aleatoria_sucursales.length > 0)
                      .map((r) => normalizeId(r?.id))
                      .filter(Boolean)
                  )
                  setSendNowSelectedUserIds(allIds)
                  setAleatorioSucursalId('')
                  setAleatorioUsuarioId('')
                } catch {
                  notifyError('Error al cargar datos para enviar recordatorios.')
                  setShowSendNowDialog(false)
                } finally {
                  setSendNowDialogLoading(false)
                }
              }}
              disabled={sendNowLoading || sendNowDialogLoading}
            >
              <Send size={14} />
              Enviar revision ahora
            </button>
          )}
          {view === 'sucursales' && canUpdate && (
            <button
              type="button"
              className="inspection-admin__manage"
              onClick={openAssignmentsDialog}
              disabled={assignmentsLoading}
            >
              <Settings size={14} />
              Configuracion
            </button>
          )}
        </div>
      </header>

      {coverageMapBranch && (
        <InspectionCoverageMap
          sucursal={coverageMapBranch}
          token={token}
          darkMode={isDarkTheme}
          onClose={() => setCoverageMapBranch(null)}
          reviewers={sendNowSummary.find((branch) => branch.id === normalizeId(coverageMapBranch.id))?.reviewers || []}
          reviewersLoading={assignmentsLoading}
          onSendMissing={(payload) => runExclusiveSend(() => sendProductListToReviewer({ ...payload, sucursalId: coverageMapBranch.id }))}
          onOpenRevision={({ inspeccionId }) => {
            // Producto en revision en el mapa: se abre Diferencias con esa
            // revision desplegada (igual que desde un recordatorio).
            const revisionId = normalizeId(inspeccionId)
            const branchId = normalizeId(coverageMapBranch.id)
            setCoverageMapBranch(null)
            setView('diferencias')
            setItemsFilter('todos')
            pendingExpandRevisionRef.current = revisionId
            setExpandedRevisionId(revisionId)
            if (branchId) setSelectedBranchId(branchId)
          }}
        />
      )}

      <RecountWarningDialog
        warning={recountConfirm}
        onResolve={(choice) => { recountConfirm?.resolve(choice); setRecountConfirm(null) }}
      />

      {/* Una sola tarjeta con la tabla, igual que en el resto del sistema. */}
      {view === 'sucursales' && (
        <div className="users-table users-table--card users-table--compact">
          {summaryLoading && (
            <div className="spinner-container spinner-container--table">
              <div className="spinner" />
            </div>
          )}
          <DataTable
            value={summaryRows}
            dataKey="sucursal_id"
            header={(
              <div className="users-header">
                <div className="users-header__left">
                  <div className="search-input-container">
                    <input
                      type="text"
                      value={summarySearch}
                      onChange={(event) => setSummarySearch(event.target.value)}
                      className="search-input"
                      placeholder="Buscar en tabla"
                    />
                    <i className="pi pi-search search-input-icon" />
                  </div>
                  <button
                    className="rounded-icon-btn"
                    type="button"
                    onClick={() => {
                      void loadSummary()
                      void loadItems()
                    }}
                    disabled={summaryLoading}
                    aria-label="Recargar"
                  >
                    <i className="pi pi-refresh" />
                  </button>
                </div>
              </div>
            )}
            globalFilter={summarySearch}
            globalFilterFields={['sucursal_nombre']}
            className={`users-datatable users-datatable--compact${summaryLoading ? ' users-datatable--loading-content' : ''}`}
            tableStyle={{ width: '100%' }}
            emptyMessage={summaryLoading ? ' ' : 'No hay sucursales.'}
            showGridlines
            size="small"
            scrollable
            scrollHeight="flex"
            removableSort
            rowClassName={() => 'p-selectable-row'}
            onRowClick={(event) => {
              if (event.originalEvent?.target?.closest?.('button')) return
              // La sucursal se abre en Diferencias con sus revisiones.
              setSelectedBranchId(normalizeId(event.data?.sucursal_id))
              setView('diferencias')
            }}
          >
            <Column
              field="sucursal_nombre"
              header="Sucursal"
              sortable
              style={{ minWidth: '160px' }}
              body={(row) => String(row?.sucursal_nombre || `Sucursal ${row?.sucursal_id || '-'}`).trim()}
            />
            <Column field="total_productos_inventario" header="Productos inventario" sortable body={(row) => toCount(row?.total_productos_inventario)} />
            <Column field="productos_revisados" header="Productos revisados" sortable body={(row) => toCount(row?.productos_revisados)} />
            <Column field="cobertura_porcentaje" header="Cobertura" sortable body={(row) => formatPercent(row?.cobertura_porcentaje)} />
            <Column field="diferencias_reportadas" header="Diferencias" sortable body={(row) => toCount(row?.diferencias_reportadas)} />
            <Column field="pendientes_verificacion" header="Por verificar" sortable body={(row) => toCount(row?.pendientes_verificacion)} />
            <Column field="ultima_revision" header="Última revisión" sortable body={(row) => formatDateTime(row?.ultima_revision)} />
            <Column
              header="Mapa"
              style={{ width: '80px', textAlign: 'center' }}
              body={(row) => {
                const rowId = normalizeId(row?.sucursal_id)
                return (
                  <button
                    type="button"
                    className="inspection-admin__map-btn"
                    aria-label={`Ver mapa de conteo de ${String(row?.sucursal_nombre || '').trim() || 'la sucursal'}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (!assignmentRows.length) void loadAssignments()
                      setCoverageMapBranch({
                        id: rowId,
                        nombre: String(row?.sucursal_nombre || `Sucursal ${rowId}`).trim(),
                      })
                    }}
                  >
                    <MapIcon size={15} />
                  </button>
                )
              }}
            />
          </DataTable>
        </div>
      )}

      {view === 'diferencias' && (
        <div className="users-table users-table--card users-table--compact">
          {itemsLoading && (
            <div className="spinner-container spinner-container--table">
              <div className="spinner" />
            </div>
          )}
          <DataTable
            value={itemsRows}
            dataKey="id"
            header={(
              <div className="users-header">
                <div className="users-header__left">
                  <select
                    className="inspection-admin__head-select"
                    value={normalizeId(selectedBranchId)}
                    onChange={(event) => setSelectedBranchId(normalizeId(event.target.value))}
                    aria-label="Sucursal"
                  >
                    {summaryRows.map((row) => (
                      <option key={`diff-branch-${normalizeId(row?.sucursal_id)}`} value={normalizeId(row?.sucursal_id)}>
                        {`${String(row?.sucursal_nombre || `Sucursal ${row?.sucursal_id}`).trim()}${Number(row?.pendientes_verificacion) > 0 ? ` (${Number(row.pendientes_verificacion)})` : ''}`}
                      </option>
                    ))}
                  </select>
                  {/* Como en Inconvenientes: arriba lo pendiente, abajo lo cerrado. */}
                  <div className="transfer-issues-page__type-filter" role="group" aria-label="Filtro de estado">
                    {REVISION_STATUS_FILTERS.map((option) => (
                      <Button
                        key={option.key}
                        type="button"
                        label={option.label}
                        className={`users-topbtn transfer-issues-page__type-btn${itemsFilter === option.key ? ' transfer-issues-page__type-btn--active' : ''}`}
                        onClick={() => setItemsFilter(option.key)}
                        disabled={itemsLoading}
                      />
                    ))}
                  </div>
                  <button
                    className="rounded-icon-btn"
                    type="button"
                    onClick={() => {
                      void loadSummary()
                      void loadItems()
                    }}
                    disabled={itemsLoading}
                    aria-label="Recargar"
                  >
                    <i className="pi pi-refresh" />
                  </button>
                </div>
                <div className="users-header__right">
                  <span className="users-header__count">{`Reg. ${itemsTotalCount}`}</span>
                </div>
              </div>
            )}
            className={`users-datatable users-datatable--compact${itemsLoading ? ' users-datatable--loading-content' : ''}`}
            tableStyle={{ width: '100%' }}
            emptyMessage={itemsLoading
              ? ' '
              : itemsFilter === 'pendientes'
                ? 'No hay revisiones pendientes en esta sucursal.'
                : 'No hay revisiones con este filtro.'}
            showGridlines
            size="small"
            scrollable
            scrollHeight="flex"
            lazy
            paginator
            first={Math.max(0, (Math.min(itemsPage, itemsTotalPages) - 1) * itemsPageSize)}
            rows={itemsPageSize}
            totalRecords={itemsTotalCount}
            rowsPerPageOptions={[10, 25, 50]}
            onPage={(event) => {
              const nextRows = Number(event.rows) || itemsPageSize
              if (nextRows !== itemsPageSize) setItemsPageSize(nextRows)
              setItemsPage(Math.floor((Number(event.first) || 0) / nextRows) + 1)
            }}
            rowClassName={(revision) => {
              const state = REVISION_STATES[revision?.estado_revision] || REVISION_STATES.revisada
              return `p-selectable-row${state.row ? ` transfer-issues-row--${state.row}` : ''}`
            }}
            onRowClick={(event) => {
              if (event.originalEvent?.target?.closest?.('button')) return
              setExpandedRevisionId(normalizeId(event.data?.id))
            }}
          >
            <Column
              header="Código"
              style={{ minWidth: '220px' }}
              body={(revision) => (
                <div className="inspection-admin__product-cell">
                  <strong>{String(revision?.codigo || `#${revision?.id}`).trim()}</strong>
                  <span>{String(revision?.descripcion || '').trim()}</span>
                </div>
              )}
            />
            <Column header="Fecha" body={(revision) => formatDateTime(revision?.completada_en || revision?.ultima_actividad || revision?.fecha_programada)} />
            <Column header="Revisor" body={(revision) => String(revision?.usuario_nombre || '-').trim() || '-'} />
            <Column header="Productos" body={(revision) => toCount(revision?.productos)} />
            <Column header="Diferencias" body={(revision) => toCount(revision?.diferencias)} />
            <Column
              header="Estado"
              body={(revision) => {
                const state = REVISION_STATES[revision?.estado_revision] || REVISION_STATES.revisada
                return <span className={`transfer-issues-state transfer-issues-state--${state.chip}`}>{state.label}</span>
              }}
            />
            {/* Sin columna de acciones: la fila entera abre la revision. */}
            <Column header="Resolución" body={(revision) => describeRevisionResolution(revision)} />
          </DataTable>
        </div>
      )}

      {view === 'diferencias' && expandedRevisionId && renderRevisionDetail()}

      {verifyWizardOpen && (() => {
        const total = verifyWizardItems.length
        const item = verifyWizardItems[verifyWizardIndex] || null
        const itemId = normalizeId(item?.id)
        const draft = verifyWizardDrafts[itemId] || { cantidad: '', nota: '' }
        const decision = verifyWizardDecisions[itemId] || ''
        const decidedCount = Object.keys(verifyWizardDecisions).length
        const approvedCount = Object.values(verifyWizardDecisions).filter((value) => value === 'aprobada').length
        const relocatedCount = Object.values(verifyWizardDecisions).filter((value) => value === 'reubicada' || value === 'movida').length
        const resentCount = Object.values(verifyWizardDecisions).filter((value) => value === 'reenviada').length
        const recounts = Number(item?.reconteos || 0)
        const maxRecounts = Number(item?.max_reconteos || 2)
        const canResend = recounts < maxRecounts && !isMoveAwaitingDecision(item) && !isNewLocationAwaitingDecision(item)
        const relocateState = relocateOptionsByBranch[normalizeId(item?.sucursal_id)] || null
        const expected = Number.parseInt(String(item?.cantidad_esperada ?? 0), 10) || 0
        const reported = item?.cantidad_reportada == null ? null : Number.parseInt(String(item.cantidad_reportada), 10) || 0
        const firstCount = item?.cantidad_primer_conteo == null ? null : Number.parseInt(String(item.cantidad_primer_conteo), 10) || 0
        const perLocationDraft = draft?.porUbicacion || null
        const verifiableLocations = perLocationDraft ? getVerifiableLocations(item) : []
        const aTemporal = draft?.aTemporal !== false
        const notFoundCandidates = getNotFoundCandidates(item)
        // Ya paso a TEMPORAL al contar ("No lo encontre"): desmarcar = descontarlo.
        const enTemporal = Number(item?.en_temporal || 0)
        const hasNotFoundCandidates = notFoundCandidates.locations.length > 0 || notFoundCandidates.whole || enTemporal > 0
        const perLocationValues = verifiableLocations.map((location) => {
          const raw = String(perLocationDraft?.[String(location.subdivision_id)] ?? '').trim()
          const value = Number.parseInt(raw, 10)
          const toTemporal = aTemporal && notFoundCandidates.locations.some((candidate) => String(candidate.subdivision_id) === String(location.subdivision_id)) && value === 0
          return {
            ...location,
            raw,
            value: Number.isFinite(value) ? value : null,
            toTemporal,
            delta: toTemporal ? 0 : Number.isFinite(value) ? value - Number(location.cantidad_sistema) : null,
          }
        })
        const confirmed = perLocationDraft
          ? (perLocationValues.every((location) => location.value != null)
            ? perLocationValues.reduce((total, location) => total + location.value, 0)
            : Number.NaN)
          : Number.parseInt(String(draft?.cantidad ?? '').trim(), 10)
        const temporalQty = getNotFoundToTemporalQty(item, { perLocation: perLocationDraft, confirmed, enabled: aTemporal })
        const adjustment = Number.isFinite(confirmed) ? confirmed + temporalQty - expected - (aTemporal ? 0 : enTemporal) : null
        const locations = Array.isArray(item?.ubicaciones_conteo) ? item.ubicaciones_conteo : []
        const busy = verifyWizardSubmitting || verifyWizardLoading
        return (
          <div
            className={`quick-actions__inspection-overlay${isDarkTheme ? ' dark' : ''}`}
            onMouseDown={() => { if (!busy) closeVerifyWizard() }}
          >
            <div
              className="quick-actions__inspection-dialog inspection-admin__verify-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Verificacion de diferencias"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="quick-actions__inspection-head">
                <div>
                  <h4>Verificación de diferencias</h4>
                  <p>
                    {String(selectedBranch?.sucursal_nombre || 'Sucursal').trim()}
                    {String(item?.inspeccion_codigo || '').trim() ? ` · ${String(item.inspeccion_codigo).trim()}` : ''}
                    {total ? ` · ${decidedCount} de ${total} revisada(s)` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  className="quick-actions__inspection-close"
                  onClick={closeVerifyWizard}
                  disabled={busy}
                  aria-label="Cerrar verificacion"
                >
                  <X size={16} />
                </button>
              </header>

              <div className="quick-actions__inspection-body">
                {verifyWizardLoading ? (
                  <p className="quick-actions__inspection-loading">
                    <Loader2 size={14} />
                    Cargando diferencias...
                  </p>
                ) : !total ? (
                  <p className="quick-actions__inspection-empty">No hay diferencias pendientes por verificar.</p>
                ) : !item ? (
                  <div className="quick-actions__inspection-quiz">
                    <p className="quick-actions__inspection-empty">
                      {`Listo: revisaste ${decidedCount} diferencia(s) (${approvedCount} con ajuste de inventario${relocatedCount ? `, ${relocatedCount} reubicado(s)` : ''}${resentCount ? `, ${resentCount} enviado(s) a reconteo` : ''}, ${decidedCount - approvedCount - relocatedCount - resentCount} sin ajuste).`}
                    </p>
                  </div>
                ) : (
                  <div className="quick-actions__inspection-quiz">
                    <p className="quick-actions__inspection-stage-kicker">
                      {`Diferencia ${verifyWizardIndex + 1} de ${total}`}
                    </p>
                    <div className="quick-actions__inspection-progress" aria-hidden="true">
                      <div className="quick-actions__inspection-progress-bar">
                        <span style={{ width: `${((verifyWizardIndex + 1) / Math.max(total, 1)) * 100}%` }} />
                      </div>
                    </div>

                    <article className="quick-actions__inspection-stage">
                      <div className="quick-actions__inspection-stage-copy">
                        <p className="quick-actions__inspection-stage-kicker">Código a verificar</p>
                        <h5>{String(item?.producto_codigo || '').trim() || `Producto ${item?.producto_id || ''}`}</h5>
                        {!!String(item?.producto_nombre || '').trim() && (
                          <p className="quick-actions__inspection-stage-name">{String(item.producto_nombre).trim()}</p>
                        )}
                        <RecountDots row={item} />
                        {!canResend && !decision && (
                          <p className="inspection-admin__recount-last">
                            {`Ya se contó ${getMaxCounts(item)} veces: tienes que solucionarlo (aprobar, reubicar o mantener).`}
                          </p>
                        )}
                      </div>

                      <div className="quick-actions__inspection-stage-meta quick-actions__inspection-stage-meta--split">
                        <div className="quick-actions__inspection-stage-meta-block">
                          <strong>{String(item?.sucursal_nombre || 'Sucursal').trim()}</strong>
                          <small>
                            {`Contó ${String(item?.inspeccion_usuario_nombre || '-').trim() || '-'} · ${formatDateTime(item?.revisado_en || item?.fecha_programada)}`}
                          </small>
                        </div>
                        <div className="quick-actions__inspection-stage-meta-block">
                          {locations.length ? (
                            <div className="quick-actions__inspection-location-list">
                              {locations.map((location, index) => {
                                // En rojo las ubicaciones donde lo contado no coincide con el sistema.
                                const locationDiff = (
                                  location?.cantidad_sistema != null &&
                                  location?.cantidad_contada != null &&
                                  Number(location.cantidad_sistema) !== Number(location.cantidad_contada)
                                )
                                return (
                                  <div
                                    key={`verify-location-${itemId}-${index}`}
                                    className={`quick-actions__inspection-location-row${locationDiff ? ' inspection-admin__verify-diff-row' : ''}`}
                                  >
                                    <div>
                                      <small>Ubicación</small>
                                      <strong>{String(location?.label || '-').trim()}</strong>
                                      {location?.no_encontrado && !item?.no_encontrado && (
                                        <span className="inspection-admin__notfound-tag">No lo encontró aquí</span>
                                      )}
                                    </div>
                                    <div>
                                      <small>Sistema</small>
                                      <strong>{location?.cantidad_sistema == null ? '-' : location.cantidad_sistema}</strong>
                                    </div>
                                    <div className={locationDiff ? 'inspection-admin__verify-diff' : undefined}>
                                      <small>Contado</small>
                                      <strong>{location?.cantidad_contada == null ? '-' : location.cantidad_contada}</strong>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          ) : (
                            <strong>Sin conteo por ubicación</strong>
                          )}
                        </div>
                      </div>

                      <div className="quick-actions__inspection-summary-row">
                        <div>
                          <small>Esperado</small>
                          <strong>{expected}</strong>
                        </div>
                        <div className={reported != null && reported !== expected ? 'inspection-admin__verify-diff' : undefined}>
                          <small>Contado</small>
                          <strong>{reported == null ? '-' : reported}</strong>
                        </div>
                        <div className={reported != null && reported !== expected ? 'inspection-admin__verify-diff' : undefined}>
                          <small>Diferencia</small>
                          <strong>{reported == null ? '-' : formatSignedInteger(reported - expected)}</strong>
                        </div>
                        {firstCount != null && reported != null && firstCount !== reported ? (
                          <span className="quick-actions__inspection-summary-badge is-mismatch">
                            {`Primer conteo: ${firstCount}`}
                          </span>
                        ) : <span />}
                      </div>

                      {!!String(item?.observacion || '').trim() && (
                        <p className="quick-actions__inspection-stage-help">
                          {`Nota: ${String(item.observacion).trim()}`}
                        </p>
                      )}

                      {item?.movido_por_revisor && !item?.agregado_por_revisor && !decision && (
                        <div className="inspection-admin__relocate inspection-admin__relocate--found">
                          <strong>{`Cambio de fila: el revisor lo pasó todo a ${String(item?.encontrado_en?.label || 'otra fila')}`}</strong>
                          {isMoveAwaitingDecision(item) ? (
                            <p>
                              {'Primero decide el cambio: "Aprobar cambio de fila" pasa todo el stock a la fila nueva (el total no cambia); "Mantener como estaba" no mueve nada.'}
                              {reported != null && reported !== expected ? ` Después queda la diferencia de cantidad (contó ${reported}, había ${expected}) para reenviar el conteo o ajustar.` : ' La cantidad cuadra: con eso queda resuelto.'}
                            </p>
                          ) : (
                            <p>{item?.movimiento_decision === 'aprobado'
                              ? `Cambio aprobado: ya está en la fila nueva. Falta resolver la cantidad (contó ${reported ?? 0}, había ${expected}).`
                              : `Se quedó donde estaba. Falta resolver la cantidad (contó ${reported ?? 0}, había ${expected}).`}</p>
                          )}
                        </div>
                      )}

                      {item?.cambio_ubicacion && !item?.movido_por_revisor && !decision && (
                        <div className="inspection-admin__relocate inspection-admin__relocate--found">
                          <strong>{`Cambio de ubicación: el total coincide (${expected}) pero el revisor lo encontró repartido distinto`}</strong>
                          <p>"Aprobar cambio de ubicación" deja cada ubicación como la contó el revisor (el total no cambia). "Mantener como estaba" no mueve nada.</p>
                        </div>
                      )}

                      {item?.agregado_por_revisor && !decision && Array.isArray(item?.ubicaciones_conteo) && item.ubicaciones_conteo.length > 1 && (
                        <div className="inspection-admin__relocate inspection-admin__relocate--found">
                          <strong>{`No estaba en la lista: el revisor lo encontró en ${String(item?.encontrado_en?.label || 'esta fila')} y ya estaba en otras ubicaciones`}</strong>
                          {isNewLocationAwaitingDecision(item) ? (
                            <p>
                              {'Lo movió y lo volvió a contar en todas sus ubicaciones (ver la nota). Para reenviar el conteo primero acepta o rechaza la ubicación: "Aprobar ubicación nueva" reparte el stock como lo contó el revisor (el total no cambia); "Mantener como estaba" no mueve nada. Así el reconteo busca en la ubicación decidida.'}
                              {` Si ya sabes la cantidad (contó ${reported ?? 0}, había ${expected}), "Aprobar ajuste" deja cada ubicación como la contó.`}
                            </p>
                          ) : item?.movimiento_decision ? (
                            <p>{item.movimiento_decision === 'aprobado'
                              ? `Ubicación nueva aprobada. Falta resolver la cantidad (contó ${reported ?? 0}, había ${expected}).`
                              : `Se quedó en su ubicación de antes. Falta resolver la cantidad (contó ${reported ?? 0}, había ${expected}).`}</p>
                          ) : (
                            <p>Lo movió y lo volvió a contar en todas sus ubicaciones (ver la nota). "Aprobar ajuste" deja cada ubicación como la contó.</p>
                          )}
                        </div>
                      )}

                      {item?.agregado_por_revisor && !decision && !(Array.isArray(item?.ubicaciones_conteo) && item.ubicaciones_conteo.length > 1) && (
                        <div className="inspection-admin__relocate inspection-admin__relocate--found">
                          <strong>{`No estaba en la lista: el revisor lo encontró en ${String(item?.encontrado_en?.label || 'esta fila')}`}</strong>
                          {Array.isArray(item?.otras_ubicaciones) && item.otras_ubicaciones.length > 0 ? (
                            <p>
                              {'En el sistema está en: '}
                              {item.otras_ubicaciones.map((location) => `${location.label} (${location.cantidad})`).join(', ')}
                              {`. "Mover aquí" trae ${reported ?? 0} unidad(es) desde ahí; si no alcanzan, la diferencia se suma como ajuste.`}
                            </p>
                          ) : (
                            <p>{`En el sistema no está en otra ubicación de la sucursal: "Mover aquí" suma ${reported ?? 0} unidad(es) en esta ubicación.`}</p>
                          )}
                          <div className="inspection-admin__relocate-row">
                            <button
                              type="button"
                              className="quick-actions__inspection-btn inspection-admin__verify-adjust"
                              onClick={() => void submitVerifyDecision('mover_aqui')}
                              disabled={busy || !reported}
                            >
                              {verifyWizardSubmitting ? 'Guardando...' : `Mover aquí (${reported ?? 0})`}
                            </button>
                          </div>
                        </div>
                      )}

                      {item?.no_encontrado && !decision && (
                        <div className="inspection-admin__relocate">
                          <strong>El revisor no lo encontró</strong>
                          <p>Si sabes dónde está, elige su nueva ubicación: se mueve ahí todo su stock y el total no cambia. Si no, al aprobar sus unidades pasan a TEMPORAL (el total no cambia). Si de verdad no está, desmarca "Lo no encontrado pasa a TEMPORAL" abajo: lo que falte queda como faltante abierto hasta que aparezca.</p>
                          <div className="inspection-admin__relocate-row">
                            {(() => {
                              // Bodega -> Division -> Subdivision con buscador (como en el resto).
                              const allOptions = relocateState?.options || []
                              const uniqueBy = (list, idKey, nameKey) => {
                                const seen = new Map()
                                list.forEach((option) => {
                                  if (option[idKey] && !seen.has(option[idKey])) seen.set(option[idKey], { id: option[idKey], nombre: option[nameKey] || '-' })
                                })
                                return [...seen.values()].sort((left, right) => left.nombre.localeCompare(right.nombre, 'es', { numeric: true }))
                              }
                              const bodegaOptions = uniqueBy(allOptions, 'bodegaId', 'bodegaNombre')
                              const divisionOptions = uniqueBy(
                                allOptions.filter((option) => option.bodegaId === draft.reubicarBodega),
                                'divisionId',
                                'divisionNombre'
                              )
                              const subdivisionOptions = allOptions
                                .filter((option) => option.divisionId === draft.reubicarDivision)
                                .map((option) => ({ id: option.id, nombre: option.nombre || '-' }))
                                .sort((left, right) => left.nombre.localeCompare(right.nombre, 'es', { numeric: true }))
                              const loadingLabel = !relocateState || relocateState.loading
                                ? 'Cargando...'
                                : relocateState.error ? 'No se pudieron cargar' : null
                              const updateDraft = (patch) => setVerifyWizardDrafts((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), ...patch } }))
                              if (!loadingLabel && !bodegaOptions.length) {
                                return (
                                  <BlockerNotice
                                    compact
                                    className="inspection-admin__relocate-blocker"
                                    title="No hay otra ubicación en esta sucursal para reubicar."
                                    reason="Para reubicarlo, crea la subdivisión en Sucursales > Bodegas. Si de verdad no está, ajusta la cantidad abajo."
                                    goTo="Bodegas"
                                  />
                                )
                              }
                              return (
                                <div className="inspection-admin__relocate-cascade">
                                  <CascadeDropdown
                                    placeholder={loadingLabel || 'Bodega'}
                                    searchPlaceholder="Buscar bodega"
                                    options={bodegaOptions}
                                    valueId={draft.reubicarBodega || ''}
                                    getOptionLabel={(option) => option.nombre}
                                    onSelect={(option) => updateDraft({ reubicarBodega: option.id, reubicarDivision: '', reubicar: '' })}
                                    disabled={busy || Boolean(loadingLabel)}
                                    emptyMessage="No hay otras ubicaciones en esta sucursal."
                                  />
                                  <CascadeDropdown
                                    placeholder="División"
                                    searchPlaceholder="Buscar división"
                                    options={divisionOptions}
                                    valueId={draft.reubicarDivision || ''}
                                    getOptionLabel={(option) => option.nombre}
                                    onSelect={(option) => updateDraft({ reubicarDivision: option.id, reubicar: '' })}
                                    disabled={busy || !draft.reubicarBodega}
                                    emptyMessage="Esta bodega no tiene otras divisiones."
                                  />
                                  <CascadeDropdown
                                    placeholder="Subdivisión"
                                    searchPlaceholder="Buscar subdivisión"
                                    options={subdivisionOptions}
                                    valueId={draft.reubicar || ''}
                                    getOptionLabel={(option) => option.nombre}
                                    onSelect={(option) => updateDraft({ reubicar: option.id })}
                                    disabled={busy || !draft.reubicarDivision}
                                    emptyMessage="Esta división no tiene otras subdivisiones."
                                  />
                                </div>
                              )
                            })()}
                            <button
                              type="button"
                              className="quick-actions__inspection-btn inspection-admin__verify-adjust"
                              onClick={() => void submitVerifyDecision('reubicar')}
                              disabled={busy || !draft.reubicar}
                              title={draft.reubicar ? undefined : 'Elige primero la bodega, la división y la subdivisión de destino'}
                            >
                              {verifyWizardSubmitting ? 'Guardando...' : 'Reubicar'}
                            </button>
                          </div>
                        </div>
                      )}

                      {decision ? (
                        <p className="quick-actions__inspection-verify-state">
                          {decision === 'aprobada'
                            ? 'Inventario ajustado.'
                            : decision === 'reubicada'
                              ? 'Producto reubicado; el total no cambió.'
                              : decision === 'movida'
                                ? 'Producto movido a la ubicación donde se encontró.'
                                : decision === 'reenviada'
                                  ? 'Enviado a contar de nuevo: no se ajustó nada. Vuelve aquí si el reconteo sigue con diferencia.'
                                  : 'Inventario mantenido, sin ajuste.'}
                        </p>
                      ) : (
                        <>
                          {perLocationDraft ? (
                            <div className="inspection-admin__verify-locations">
                              <p className="quick-actions__inspection-stage-kicker">Cantidad real confirmada por ubicación</p>
                              {perLocationValues.map((location, index) => (
                                <label key={`verify-confirm-${itemId}-${location.subdivision_id}`} className="inspection-admin__verify-location-field">
                                  <span>
                                    <strong>{String(location?.label || '-').trim()}</strong>
                                    <small>
                                      {location.toTemporal
                                        ? `No lo encontraron: sus ${location.cantidad_sistema} pasan a TEMPORAL`
                                        : location.delta == null || location.delta === 0
                                          ? 'Sin cambios en esta ubicación'
                                          : `Se ${location.delta > 0 ? 'sumarán' : 'restarán'} ${Math.abs(location.delta)} (sistema: ${location.cantidad_sistema})`}
                                    </small>
                                  </span>
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    value={location.raw}
                                    onChange={(event) => {
                                      const value = String(event.target.value || '').replace(/\D+/g, '').slice(0, 5)
                                      setVerifyWizardDrafts((prev) => ({
                                        ...prev,
                                        [itemId]: {
                                          ...(prev[itemId] || {}),
                                          porUbicacion: { ...(prev[itemId]?.porUbicacion || {}), [String(location.subdivision_id)]: value },
                                        },
                                      }))
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key !== 'Enter') return
                                      event.preventDefault()
                                      void submitVerifyDecision('aprobar')
                                    }}
                                    disabled={busy}
                                    autoFocus={index === 0}
                                  />
                                </label>
                              ))}
                              <div className="inspection-admin__verify-locations-total">
                                <span>Total confirmado</span>
                                <strong>{Number.isFinite(confirmed) ? confirmed : '-'}</strong>
                              </div>
                            </div>
                          ) : (
                          <label className="quick-actions__inspection-count-field">
                            <span>Cantidad real confirmada</span>
                            <input
                              type="text"
                              inputMode="numeric"
                              value={draft.cantidad}
                              onChange={(event) => {
                                const value = String(event.target.value || '').replace(/\D+/g, '').slice(0, 5)
                                setVerifyWizardDrafts((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), cantidad: value } }))
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== 'Enter') return
                                event.preventDefault()
                                void submitVerifyDecision('aprobar')
                              }}
                              disabled={busy}
                              autoFocus
                            />
                          </label>
                          )}
                          {hasNotFoundCandidates && (
                            <div className="inspection-admin__temporal">
                              <label className="inspection-admin__temporal-check">
                                <input
                                  type="checkbox"
                                  checked={aTemporal}
                                  onChange={(event) => {
                                    const checked = event.target.checked
                                    setVerifyWizardDrafts((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), aTemporal: checked } }))
                                  }}
                                  disabled={busy}
                                />
                                <span>
                                  <strong>Lo no encontrado pasa a TEMPORAL</strong>
                                  <small>
                                    {enTemporal > 0
                                      ? (aTemporal
                                        ? `${enTemporal} u. ya están en TEMPORAL desde el conteo: el total no cambia. Reenvía el conteo para encontrarlo y devolverle su ubicación.`
                                        : `Desmarcado: las ${enTemporal} u. se descuentan de TEMPORAL (queda como faltante abierto).`)
                                      : aTemporal
                                      ? (temporalQty
                                        ? `${temporalQty} u. salen de donde no lo encontraron y quedan en TEMPORAL: el total no cambia. Cuando aparezca, se mueve de TEMPORAL a su ubicación.`
                                        : 'Solo pasa a TEMPORAL lo que quede en 0 donde no lo encontraron.')
                                      : 'Desmarcado: lo no encontrado se descuenta del inventario (queda como faltante abierto).'}
                                  </small>
                                </span>
                              </label>
                            </div>
                          )}
                          <p className="quick-actions__inspection-stage-help">
                            {adjustment == null
                              ? 'Ingresa la cantidad real que hay en la sucursal.'
                              : adjustment === 0
                                ? (temporalQty
                                  ? `El total queda igual: ${temporalQty} u. pasan a TEMPORAL.`
                                  : 'Con esta cantidad el inventario queda igual (coincide con lo esperado).')
                                : `Al aprobar se ${adjustment > 0 ? 'sumarán' : 'restarán'} ${Math.abs(adjustment)} unidad(es) al inventario${temporalQty ? ` y ${temporalQty} u. pasan a TEMPORAL` : ''}.`}
                          </p>
                          <label className="quick-actions__inspection-note">
                            <span>Nota de verificación (opcional)</span>
                            <textarea
                              rows={2}
                              value={draft.nota}
                              onChange={(event) => {
                                const value = event.target.value
                                setVerifyWizardDrafts((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), nota: value } }))
                              }}
                              disabled={busy}
                            />
                          </label>
                        </>
                      )}
                    </article>
                  </div>
                )}
                {verifyWizardError && <p className="quick-actions__inspection-error">{verifyWizardError}</p>}
              </div>

              {verifyWizardConfirming && item && !decision && (
                <div className="inspection-admin__verify-confirm-overlay">
                  <div className="inspection-admin__verify-confirm" role="alertdialog" aria-modal="true" aria-label="Vas a cambiar la cantidad contada">
                    <h5>Vas a cambiar la cantidad contada</h5>
                    <p>
                      {'El revisor contó '}
                      <strong>{reported == null ? '-' : reported}</strong>
                      {' y vas a confirmar '}
                      <strong>{Number.isFinite(confirmed) ? confirmed : '-'}</strong>
                      {'. Explica en la nota qué pasó antes de aprobar.'}
                    </p>
                    {perLocationDraft && (
                      <ul className="inspection-admin__verify-confirm-list">
                        {perLocationValues
                          .filter((location) => location.value !== Number(location.cantidad_contada))
                          .map((location) => (
                            <li key={`verify-confirm-change-${itemId}-${location.subdivision_id}`}>
                              <span>{String(location?.label || '-').trim()}</span>
                              <strong>{`${location.cantidad_contada} → ${location.value ?? '-'}`}</strong>
                            </li>
                          ))}
                      </ul>
                    )}
                    <label className="quick-actions__inspection-note">
                      <span>Nota de verificación (obligatoria)</span>
                      <textarea
                        rows={3}
                        value={draft.nota}
                        placeholder="Ej.: se volvió a contar y había 6; el revisor contó mal la bodega; estaba en otra ubicación; hubo una venta sin registrar..."
                        onChange={(event) => {
                          const value = event.target.value
                          setVerifyWizardDrafts((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), nota: value } }))
                        }}
                        disabled={busy}
                        autoFocus
                      />
                    </label>
                    {verifyWizardError && <p className="quick-actions__inspection-error">{verifyWizardError}</p>}
                    <div className="inspection-admin__verify-confirm-actions">
                      <button
                        type="button"
                        className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost"
                        onClick={() => { setVerifyWizardError(''); setVerifyWizardConfirming(false) }}
                        disabled={busy}
                      >
                        Volver
                      </button>
                      <button
                        type="button"
                        className="quick-actions__inspection-btn inspection-admin__verify-adjust"
                        onClick={() => void submitVerifyDecision('aprobar', { confirmed: true })}
                        disabled={busy || !String(draft.nota || '').trim()}
                      >
                        {verifyWizardSubmitting ? 'Guardando...' : 'Confirmar ajuste'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <footer className="quick-actions__inspection-actions inspection-admin__verify-actions">
                <button
                  type="button"
                  className={`quick-actions__inspection-btn quick-actions__inspection-btn--ghost${item ? ' inspection-admin__verify-cancel' : ''}`}
                  onClick={closeVerifyWizard}
                  disabled={busy}
                >
                  {item ? 'Cancelar' : 'Cerrar'}
                </button>
                {item && (
                  <>
                    <button
                      type="button"
                      className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost inspection-admin__verify-nav"
                      onClick={() => { setVerifyWizardError(''); setVerifyWizardConfirming(false); setVerifyWizardIndex((index) => Math.max(0, index - 1)) }}
                      disabled={busy || verifyWizardIndex <= 0}
                    >
                      <ChevronLeft size={15} />
                      Anterior
                    </button>
                    <button
                      type="button"
                      className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost inspection-admin__verify-nav"
                      onClick={() => { setVerifyWizardError(''); setVerifyWizardConfirming(false); setVerifyWizardIndex((index) => Math.min(total - 1, index + 1)) }}
                      disabled={busy || verifyWizardIndex >= total - 1}
                    >
                      Siguiente
                      <ChevronRight size={15} />
                    </button>
                    {!decision && (isMoveAwaitingDecision(item) || isNewLocationAwaitingDecision(item)) && (
                      <>
                        <button
                          type="button"
                          className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost"
                          onClick={() => void decideMoveInWizard(false)}
                          disabled={busy}
                        >
                          Mantener como estaba
                        </button>
                        <button
                          type="button"
                          className="quick-actions__inspection-btn inspection-admin__verify-adjust"
                          onClick={() => void decideMoveInWizard(true)}
                          disabled={busy}
                        >
                          {verifyWizardSubmitting ? 'Guardando...' : isNewLocationAwaitingDecision(item) ? 'Aprobar ubicación nueva' : 'Aprobar cambio de fila'}
                        </button>
                      </>
                    )}
                    {!decision && !isMoveAwaitingDecision(item) && item?.cambio_ubicacion && !item?.movido_por_revisor && (
                      <button
                        type="button"
                        className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost"
                        onClick={() => void submitVerifyDecision('rechazar')}
                        disabled={busy || verifyWizardConfirming}
                        title="No mueve nada: las ubicaciones quedan como estaban"
                      >
                        Mantener como estaba
                      </button>
                    )}
                    {!decision && canResend && (
                      <button
                        type="button"
                        className="quick-actions__inspection-btn inspection-admin__recount-btn"
                        onClick={() => void submitVerifyDecision('recontar')}
                        disabled={busy || verifyWizardConfirming}
                        data-title={`Manda a contar de nuevo este producto al mismo revisor (conteo ${getNextCountLabel(item)}). No ajusta nada.`}
                      >
                        <RefreshCw size={14} />
                        {`Reenviar conteo (${getCountNumber(item) + 1}/${getMaxCounts(item)})`}
                      </button>
                    )}
                    {!decision && !isMoveAwaitingDecision(item) && (
                      <button
                        type="button"
                        className="quick-actions__inspection-btn inspection-admin__verify-adjust"
                        onClick={() => void submitVerifyDecision('aprobar')}
                        disabled={busy || verifyWizardConfirming}
                        title="Deja el inventario en la cantidad real confirmada"
                      >
                        {verifyWizardSubmitting ? 'Guardando...' : item?.cambio_ubicacion && !item?.movido_por_revisor ? 'Aprobar cambio de ubicación' : 'Aprobar ajuste'}
                      </button>
                    )}
                  </>
                )}
              </footer>
            </div>
          </div>
        )
      })()}

      {showSendNowDialog && (
        <div className="inspection-admin__dialog-overlay" onMouseDown={() => !(sendNowLoading || sendNowDialogLoading || divisionSending || listSending) && setShowSendNowDialog(false)}>
          <div
            className="inspection-admin__dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Enviar revision ahora"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {(sendNowLoading || sendNowDialogLoading || divisionSending || listSending) && (
              <div className="inspection-admin__dialog-loading">
                <div className="inspection-admin__dialog-loading-content">
                  <Loader2 className="inspection-admin__dialog-loading-spinner" size={24} />
                  <span>{sendNowDialogLoading ? 'Cargando datos...' : 'Enviando recordatorios...'}</span>
                </div>
              </div>
            )}
            <header className="inspection-admin__dialog-head">
              <div>
                <h4>Enviar revision ahora</h4>
                <p>Resumen del recordatorio que se enviara de inmediato.</p>
              </div>
              <button
                type="button"
                className="inspection-admin__dialog-close"
                onClick={() => setShowSendNowDialog(false)}
                disabled={sendNowLoading || sendNowDialogLoading || divisionSending || listSending}
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </header>

            <div className="create-user__tabs" role="tablist">
              <button
                type="button"
                className={`create-user__tab${sendNowMode === 'aleatorio' ? ' create-user__tab--active' : ''}`}
                onClick={() => setSendNowMode('aleatorio')}
                disabled={sendNowLoading || sendNowDialogLoading || divisionSending || listSending}
              >
                Aleatorio
              </button>
              <button
                type="button"
                className={`create-user__tab${sendNowMode === 'division' ? ' create-user__tab--active' : ''}`}
                onClick={() => setSendNowMode('division')}
                disabled={sendNowLoading || sendNowDialogLoading || divisionSending || listSending}
              >
                Division especifica
              </button>
              <button
                type="button"
                className={`create-user__tab${sendNowMode === 'lista' ? ' create-user__tab--active' : ''}`}
                onClick={() => setSendNowMode('lista')}
                disabled={sendNowLoading || sendNowDialogLoading || divisionSending || listSending}
              >
                Lista especifica
              </button>
            </div>

            <div className="inspection-admin__dialog-body">
              {/* Izquierda: la hora y debajo "Enviar ahora mismo". Derecha
                  (solo aleatorio): la cantidad, del alto de las dos. */}
              <div className="inspection-admin__send-top">
                <div className="inspection-admin__send-clock-col">
                  <label htmlFor="inspection-send-hour" className="inspection-admin__send-label">Hora del recordatorio</label>
                  <div className="inspection-admin__send-clock">
                    <input
                      id="inspection-send-hour"
                      type="time"
                      value={sendNowParams.hora_recordatorio}
                      onChange={(e) => setSendNowParams((prev) => ({ ...prev, hora_recordatorio: e.target.value }))}
                      disabled={sendNowImmediate || sendNowLoading || sendNowDialogLoading || divisionSending || listSending}
                      aria-label="Hora del recordatorio"
                    />
                  </div>
                  <span className="inspection-admin__send-immediate">
                      <input
                        type="checkbox"
                        id="inspection-send-immediate"
                        checked={sendNowImmediate}
                        onChange={(e) => setSendNowImmediate(e.target.checked)}
                        disabled={sendNowLoading || sendNowDialogLoading || divisionSending || listSending}
                      />
                      <label htmlFor="inspection-send-immediate">Enviar ahora mismo</label>
                  </span>
                </div>
                {sendNowMode === 'aleatorio' && (
                  <div className="inspection-admin__send-qty-col">
                    <label htmlFor="inspection-send-qty" className="inspection-admin__send-label">Productos por sucursal</label>
                    <input
                      id="inspection-send-qty"
                      className="inspection-admin__send-qty"
                      type="number"
                      min="1"
                      max="200"
                      step="1"
                      inputMode="numeric"
                      value={sendNowParams.cantidad_productos}
                      onChange={(e) => setSendNowParams((prev) => ({ ...prev, cantidad_productos: e.target.value }))}
                      disabled={sendNowLoading || sendNowDialogLoading}
                    />
                  </div>
                )}
              </div>

              {sendNowMode === 'lista' ? (
                <div className="inspection-admin__list-builder">
                  <div className="inspection-admin__division-fields">
                    <label className="create-user__field">
                      <span>Sucursal</span>
                      <CascadeDropdown
                        placeholder="Selecciona una sucursal"
                        searchPlaceholder="Buscar sucursal"
                        options={allBranchOptions}
                        valueId={listSucursalId}
                        getOptionLabel={(o) => o.nombre}
                        onSelect={(o) => {
                          setListSucursalId(o.id)
                          setListUsuarioId('')
                        }}
                        disabled={listSending}
                      />
                    </label>
                    <label className="create-user__field">
                      <span>Revisor</span>
                      <CascadeDropdown
                        placeholder={listSucursalId && !listReviewers.length ? 'Sin revisores en esta sucursal' : 'Selecciona un revisor'}
                        searchPlaceholder="Buscar revisor"
                        options={listReviewers}
                        valueId={listUsuarioId}
                        getOptionLabel={(o) => String(o?.nombre_completo || o?.correo || `Usuario ${o?.id}`).trim()}
                        onSelect={(o) => setListUsuarioId(o.id)}
                        disabled={!listSucursalId || !listReviewers.length || listSending}
                      />
                    </label>
                  </div>
                  {(() => {
                    const block = branchBlocker(listSucursalId)
                    return block ? (
                      <SendBlocker
                        title={block.title}
                        reason={block.reason}
                        goTo={block.goTo}
                        actionLabel={canUpdate ? 'Asignar revisores' : null}
                        onAction={openAssignmentsDialog}
                      />
                    ) : null
                  })()}

                  <div className="create-user__locations-table create-salida__products-table inspection-admin__list-products-table">
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>Código</span>
                      <span>Nombre</span>
                      <span>Ubicación</span>
                      <span>Acciones</span>
                    </div>

                    <div className="create-user__locations-row create-user__locations-row--form">
                      <span className="create-salida__product-picker create-salida__product-code-cell">
                        <div className="create-user__dropdown create-salida__product-dropdown" ref={listProductDropdownRef}>
                          <button
                            type="button"
                            className="create-user__dropdown-trigger"
                            ref={listProductTriggerRef}
                            disabled={listSending || listBulkLoading || !listSucursalId}
                            title={!listSucursalId ? 'Selecciona una sucursal primero.' : undefined}
                            onClick={() => {
                              if (!listSucursalId) return
                              if (!showListProductDropdown) {
                                setListProductQuery('')
                                setListProductOptions([])
                                requestAnimationFrame(() => updateListProductDropdownPlacement())
                              }
                              setShowListProductDropdown((prev) => !prev)
                            }}
                          >
                            <span>
                              {listBulkLoading
                                ? 'Agregando códigos...'
                                : (listDraftProduct ? String(listDraftProduct?.codigo || '').trim() : 'Selecciona un producto')}
                            </span>
                            <i className={`pi pi-chevron-${showListProductDropdown ? 'up' : 'down'}`} />
                          </button>

                          {showListProductDropdown && createPortal(
                            <div
                              ref={listProductPanelRef}
                              className="create-user__dropdown-panel create-salida__product-panel"
                              style={listProductDropdownStyle}
                            >
                              <div className="create-user__dropdown-search">
                                <i className="pi pi-search" />
                                <input
                                  type="text"
                                  placeholder="Buscar productos (o pega varios códigos)"
                                  value={listProductQuery}
                                  onChange={(event) => setListProductQuery(event.target.value)}
                                  onPaste={(event) => {
                                    const text = event.clipboardData?.getData('text') || ''
                                    if (!/[\r\n,;\t]/.test(text.trim())) return
                                    event.preventDefault()
                                    void handleListBulkPaste(text)
                                  }}
                                  autoFocus
                                />
                              </div>

                              <div
                                className="create-user__dropdown-results"
                                style={listProductDropdownStyle?.maxHeight
                                  ? { maxHeight: `${Math.max(listProductDropdownStyle.maxHeight - 72, 84)}px` }
                                  : undefined}
                              >
                                {listProductLoading && <small className="muted">Buscando productos...</small>}
                                {!listProductLoading && listProductQuery.trim() && !listProductOptions.length && (
                                  <small className="muted">Sin resultados.</small>
                                )}
                                {listProductOptions.length > 0 && (
                                  <div className="create-salida__results-header">
                                    <span>Código</span>
                                    <span>Descripción</span>
                                    <span>Cantidad</span>
                                  </div>
                                )}
                                {listProductOptions.map((product) => {
                                  const productId = normalizeId(product?.id)
                                  const isSelected = productId === normalizeId(listDraftProduct?.id)
                                  const isAlreadyAdded = listProducts.some((item) => item.id === productId)
                                  return (
                                    <button
                                      key={`list-option-${productId}`}
                                      type="button"
                                      className={`create-salida__result-row${isSelected ? ' is-selected' : ''}${isAlreadyAdded ? ' is-added' : ''}`}
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={(event) => {
                                        event.preventDefault()
                                        event.stopPropagation()
                                        if (isAlreadyAdded) return
                                        setListDraftProduct({
                                          id: productId,
                                          codigo: String(product?.codigo || '').trim(),
                                          nombre: String(product?.nombre || '').trim(),
                                        })
                                        setShowListProductDropdown(false)
                                        setListProductQuery('')
                                      }}
                                      disabled={isAlreadyAdded}
                                      title={isAlreadyAdded ? 'Ya está en la lista' : undefined}
                                    >
                                      <span className="result-codigo">
                                        {String(product?.codigo || '').trim() || `ID ${productId}`}
                                        {isAlreadyAdded && (
                                          <span className="create-salida__result-added-badge">en la lista</span>
                                        )}
                                      </span>
                                      <span className="result-nombre">{String(product?.nombre || '').trim() || '-'}</span>
                                      <span className="result-stock">{String(Number(product?.total_stock ?? 0))}</span>
                                    </button>
                                  )
                                })}
                              </div>
                            </div>,
                            getAppPortalRoot()
                          )}
                        </div>
                      </span>
                      <span className="create-salida__product-name-cell">
                        <span
                          className="create-salida__table-static-value create-salida__table-static-value--name"
                          title={listDraftProduct?.nombre || undefined}
                        >
                          {listDraftProduct?.nombre || '-'}
                        </span>
                      </span>
                      <span>
                        <span className="create-salida__table-static-value">-</span>
                      </span>
                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button
                          type="button"
                          className="create-user__ghost create-salida__ghost--add"
                          onClick={handleListAddDraft}
                          disabled={!listDraftProduct || listSending || listBulkLoading}
                        >
                          Agregar
                        </button>
                      </span>
                    </div>

                    {!listProducts.length && (
                      <div className="create-user__locations-row create-user__locations-row--empty">
                        <span>{listSucursalId ? 'Sin productos agregados.' : 'Selecciona una sucursal para agregar productos.'}</span>
                      </div>
                    )}

                    {listProducts.map((item) => (
                      <div key={`list-item-${item.id}`} className="create-user__locations-row">
                        <span>{item.codigo || '-'}</span>
                        <span title={item.nombre || undefined}>
                          <span className="create-salida__product-name-text">{item.nombre || '-'}</span>
                        </span>
                        <span className="inspection-admin__list-location" title={item.ubicacion || undefined}>
                          {item.ubicacion == null ? 'Cargando...' : item.ubicacion}
                        </span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button
                            type="button"
                            className="create-user__locations-remove"
                            onClick={() => setListProducts((prev) => prev.filter((row) => row.id !== item.id))}
                            disabled={listSending}
                            aria-label={`Quitar ${item.codigo}`}
                          >
                            x
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                  {listProducts.length > 0 && (
                    <p className="inspection-admin__sendnow-count-footer">
                      {listProducts.length} repuesto(s) en la lista
                    </p>
                  )}
                </div>
              ) : sendNowMode === 'division' ? (
                <div className="inspection-admin__division-fields">
                  <label className="create-user__field">
                    <span>Sucursal</span>
                    <CascadeDropdown
                      placeholder="Selecciona una sucursal"
                      searchPlaceholder="Buscar sucursal"
                      options={allBranchOptions}
                      valueId={divisionSucursalId}
                      getOptionLabel={(o) => o.nombre}
                      onSelect={(o) => {
                        setDivisionSucursalId(o.id)
                        setDivisionBodegaId('')
                        setDivisionId('')
                        setDivisionSubdivisionId('')
                        setDivisionUsuarioId('')
                      }}
                      disabled={divisionSending}
                    />
                  </label>
                  <label className="create-user__field">
                    <span>Bodega</span>
                    <CascadeDropdown
                      placeholder={divisionBodegasLoading ? 'Cargando...' : 'Selecciona una bodega'}
                      searchPlaceholder="Buscar bodega"
                      options={divisionBodegas}
                      valueId={divisionBodegaId}
                      getOptionLabel={(o) => o.nombre}
                      onSelect={(o) => {
                        setDivisionBodegaId(o.id)
                        setDivisionId('')
                        setDivisionSubdivisionId('')
                      }}
                      disabled={!divisionSucursalId || divisionBodegasLoading || divisionSending}
                    />
                  </label>
                  <label className="create-user__field">
                    <span>Division</span>
                    <CascadeDropdown
                      placeholder={divisionDivisionesLoading ? 'Cargando...' : 'Selecciona una division'}
                      searchPlaceholder="Buscar division"
                      options={divisionDivisiones}
                      valueId={divisionId}
                      getOptionLabel={(o) => o.nombre}
                      onSelect={(o) => {
                        setDivisionId(o.id)
                        setDivisionSubdivisionId('')
                      }}
                      disabled={!divisionBodegaId || divisionDivisionesLoading || divisionSending}
                    />
                  </label>
                  <label className="create-user__field">
                    <span>Subdivision (opcional)</span>
                    <CascadeDropdown
                      placeholder={divisionSubdivisionesLoading ? 'Cargando...' : 'Toda la division'}
                      searchPlaceholder="Buscar subdivision"
                      options={divisionSubdivisionOptions}
                      valueId={divisionSubdivisionId}
                      getOptionLabel={(o) => o.nombre}
                      onSelect={(o) => setDivisionSubdivisionId(normalizeId(o.id))}
                      disabled={!divisionId || divisionSubdivisionesLoading || divisionSending}
                    />
                  </label>
                  <label className="create-user__field">
                    <span>Revisor</span>
                    <CascadeDropdown
                      placeholder={divisionSucursalId && !divisionReviewers.length ? 'Sin revisores en esta sucursal' : 'Selecciona un revisor'}
                      searchPlaceholder="Buscar revisor"
                      options={divisionReviewers}
                      valueId={divisionUsuarioId}
                      getOptionLabel={(o) => String(o?.nombre_completo || o?.correo || `Usuario ${o?.id}`).trim()}
                      onSelect={(o) => setDivisionUsuarioId(o.id)}
                      disabled={!divisionSucursalId || !divisionReviewers.length || divisionSending}
                    />
                  </label>
                  {divisionSucursalId && !divisionBodegasLoading && !divisionBodegas.length && (
                    <SendBlocker
                      title="No se puede enviar por división: la sucursal no tiene bodegas"
                      reason="Para revisar por división hacen falta bodegas con divisiones. Créalas en Bodegas y aparecerán aquí."
                      goTo="Bodegas"
                    />
                  )}
                  {divisionBodegaId && !divisionDivisionesLoading && !divisionDivisiones.length && (
                    <SendBlocker
                      title="No se puede enviar por división: la bodega no tiene divisiones"
                      reason="Crea sus divisiones en Bodegas (en el plano de la bodega) y aparecerán aquí."
                      goTo="Bodegas"
                    />
                  )}
                  {(() => {
                    const block = branchBlocker(divisionSucursalId)
                    return block ? (
                      <SendBlocker
                        title={block.title}
                        reason={block.reason}
                        goTo={block.goTo}
                        actionLabel={canUpdate ? 'Asignar revisores' : null}
                        onAction={openAssignmentsDialog}
                      />
                    ) : null
                  })()}
                </div>
              ) : sendNowSummary.length === 0 ? (
                <SendBlocker
                  title="No se puede enviar: no hay revisores"
                  reason="Ningún usuario activo tiene asignada la revisión de inventario de ninguna sucursal, así que no hay a quién enviársela. Asigna revisores a las sucursales en Configuración y vuelve a intentarlo."
                  actionLabel={canUpdate ? 'Asignar revisores' : null}
                  onAction={openAssignmentsDialog}
                />
              ) : (() => {
                // Como en Division / Lista: sucursal y revisor en desplegables,
                // con "Todas" / "Todos" (por defecto, a todos los revisores).
                const TODAS = '__todas__'
                const branchOptions = [{ id: TODAS, nombre: 'Todas las sucursales' }, ...sendNowSummary.map((b) => ({ id: b.id, nombre: b.nombre }))]
                const branchesInScope = aleatorioSucursalId
                  ? sendNowSummary.filter((b) => b.id === aleatorioSucursalId)
                  : sendNowSummary
                const seen = new Set()
                const reviewersInScope = branchesInScope.flatMap((b) => b.reviewers).filter((u) => {
                  const uid = normalizeId(u?.id)
                  if (!uid || seen.has(uid)) return false
                  seen.add(uid)
                  return true
                })
                const reviewerOptions = [{ id: TODAS, nombre: 'Todos los revisores' }, ...reviewersInScope.map((u) => ({
                  id: normalizeId(u?.id),
                  nombre: String(u?.nombre_completo || u?.correo || `Usuario ${u?.id}`).trim(),
                }))]
                const applySelection = (sucursalId, usuarioId) => {
                  const scope = sucursalId ? sendNowSummary.filter((b) => b.id === sucursalId) : sendNowSummary
                  const ids = scope.flatMap((b) => b.reviewers.map((u) => normalizeId(u?.id))).filter(Boolean)
                  setSendNowSelectedUserIds(new Set(usuarioId ? ids.filter((id) => id === usuarioId) : ids))
                }
                const disabled = sendNowLoading || sendNowDialogLoading
                return (
                  <div className="inspection-admin__division-fields">
                    <label className="create-user__field">
                      <span>Sucursal</span>
                      <CascadeDropdown
                        placeholder="Todas las sucursales"
                        searchPlaceholder="Buscar sucursal"
                        options={branchOptions}
                        valueId={aleatorioSucursalId || TODAS}
                        getOptionLabel={(o) => o.nombre}
                        onSelect={(o) => {
                          const sucursalId = o.id === TODAS ? '' : o.id
                          setAleatorioSucursalId(sucursalId)
                          setAleatorioUsuarioId('')
                          applySelection(sucursalId, '')
                        }}
                        disabled={disabled}
                      />
                    </label>
                    <label className="create-user__field">
                      <span>Revisor</span>
                      <CascadeDropdown
                        placeholder="Todos los revisores"
                        searchPlaceholder="Buscar revisor"
                        options={reviewerOptions}
                        valueId={aleatorioUsuarioId || TODAS}
                        getOptionLabel={(o) => o.nombre}
                        onSelect={(o) => {
                          const usuarioId = o.id === TODAS ? '' : o.id
                          setAleatorioUsuarioId(usuarioId)
                          applySelection(aleatorioSucursalId, usuarioId)
                        }}
                        disabled={disabled}
                      />
                    </label>
                  </div>
                )
              })()}
              {sendError && <SendBlocker title="No se pudo enviar" reason={sendError} />}
            </div>

            <footer className="inspection-admin__dialog-actions">
              <button
                type="button"
                className="create-user__action create-user__action--secondary"
                onClick={() => setShowSendNowDialog(false)}
                disabled={sendNowLoading || sendNowDialogLoading || divisionSending || listSending}
              >
                Cancelar
              </button>
              {sendNowMode === 'lista' ? (
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={() => void runExclusiveSend(sendList)}
                  disabled={listSending || listBulkLoading || !listSucursalId || !listUsuarioId || listProducts.length === 0}
                >
                  {listSending ? 'Enviando...' : `Enviar lista (${listProducts.length})`}
                </button>
              ) : sendNowMode === 'division' ? (
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={() => void runExclusiveSend(sendDivision)}
                  disabled={divisionSending || !divisionId || !divisionUsuarioId}
                >
                  {divisionSending ? 'Enviando...' : 'Enviar division completa'}
                </button>
              ) : (
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={() => void runExclusiveSend(sendNow)}
                  disabled={sendNowLoading || sendNowDialogLoading || sendNowSummary.length === 0 || sendNowSelectedUserIds.size === 0}
                >
                  {sendNowLoading ? 'Enviando...' : 'Enviar ahora'}
                </button>
              )}
            </footer>
          </div>
        </div>
      )}

      {showAssignmentsDialog && isTabActive !== false && (() => {
        // Mismo modal que "Enviar revision ahora" (hora y cantidad en una
        // fila) y un interruptor claro de la revision automatica.
        // Se edita directo (sin boton Editar) si tiene permiso.
        const locked = !canUpdate || configLoading
        const autoOn = Boolean(configData.inspeccion_automatica)
        const hora = String(configData.hora_recordatorio || '').slice(0, 5)
        const [hh, mm] = hora.split(':').map((part) => Number.parseInt(part, 10))
        const now = new Date()
        const startsToday = Number.isFinite(hh) && Number.isFinite(mm) && (hh * 60 + mm) > (now.getHours() * 60 + now.getMinutes())
        const horaLabel = Number.isFinite(hh) && Number.isFinite(mm)
          ? new Date(2000, 0, 1, hh, mm).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })
          : '--:--'
        return (
        <div className="inspection-admin__dialog-overlay" onMouseDown={() => closeAssignmentsDialog()}>
          <div
            className="inspection-admin__dialog inspection-admin__dialog--wide"
            role="dialog"
            aria-modal="true"
            aria-label="Configuracion de inspeccion aleatoria"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {(assignmentsLoading || configLoading) && (
              <div className="inspection-admin__dialog-loading">
                <div className="inspection-admin__dialog-loading-content">
                  <Loader2 className="inspection-admin__dialog-loading-spinner" size={24} />
                  <span>Cargando datos...</span>
                </div>
              </div>
            )}
            <header className="inspection-admin__dialog-head">
              <div>
                <h4>Configuracion</h4>
                <p>
                  Revision automatica diaria y revisores de cada sucursal.
                  {configSaveState === 'saving' && <span className="inspection-admin__save-state">{' · Guardando...'}</span>}
                  {configSaveState === 'saved' && <span className="inspection-admin__save-state is-saved">{' · Cambios guardados'}</span>}
                </p>
              </div>
              <button
                type="button"
                className="inspection-admin__dialog-close"
                onClick={closeAssignmentsDialog}
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </header>

            <div className="inspection-admin__dialog-body">
              {/* La revision automatica: estado claro y cuando empieza. */}
              <div className={`inspection-admin__auto-card${autoOn ? ' is-on' : ''}`}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoOn}
                  aria-label="Revision automatica diaria"
                  className={`inspection-admin__switch${autoOn ? ' is-on' : ''}`}
                  onClick={() => setConfirmAutoToggle(true)}
                  disabled={locked}
                >
                  <span className="inspection-admin__switch-knob" />
                </button>
                <div className="inspection-admin__auto-text">
                  <strong>
                    {'En este momento la revisión de inventario automática está '}
                    <span className={autoOn ? 'is-on' : 'is-off'}>{autoOn ? 'activada' : 'desactivada'}</span>
                  </strong>
                  <small>
                    {autoOn
                      ? `Las inspecciones aleatorias automáticas van a empezar ${startsToday ? 'hoy' : 'mañana'} a las ${horaLabel}. Cada día se le crea una a cada revisor.`
                      : 'Solo existen las revisiones que se envían con "Enviar revisión ahora".'}
                  </small>
                </div>
              </div>

              <div className="inspection-admin__send-top">
                <div className="inspection-admin__send-clock-col">
                  <label htmlFor="inspection-config-hour" className="inspection-admin__send-label">Hora de envío del recordatorio</label>
                  <div className="inspection-admin__send-clock">
                    <input
                      id="inspection-config-hour"
                      type="time"
                      value={configData.hora_recordatorio}
                      onChange={(e) => editConfig({ hora_recordatorio: e.target.value })}
                      disabled={locked}
                      aria-label="Hora de envío del recordatorio"
                    />
                  </div>
                </div>
                <div className="inspection-admin__send-qty-col">
                  <label htmlFor="inspection-config-qty" className="inspection-admin__send-label">Productos a revisar por inspección</label>
                  <input
                    id="inspection-config-qty"
                    className="inspection-admin__send-qty"
                    type="number"
                    min="1"
                    max="200"
                    step="1"
                    inputMode="numeric"
                    value={configData.cantidad_productos}
                    onChange={(e) => editConfig({ cantidad_productos: e.target.value })}
                    disabled={locked}
                  />
                </div>
              </div>

              <div className="inspection-admin__config-reviewers">
                <div>
                  <h5>Revisores por sucursal</h5>
                  <p className="create-user__hint">
                    Escoge por sucursal que usuarios deben hacer la revision diaria. Al asignar una sucursal, tambien se sincroniza Ver inventario.
                  </p>
                </div>
                <div className="search-input-container inspection-admin__config-search">
                  <input
                    type="text"
                    className="search-input"
                    value={assignmentSearch}
                    onChange={(event) => setAssignmentSearch(String(event.target.value || ''))}
                    placeholder="Buscar por nombre o correo"
                  />
                  <i className="pi pi-search search-input-icon" />
                </div>
              </div>

              <div className="inspection-admin__reviewers-table-card">
                <div className="inspection-admin__table-wrap inspection-admin__table-wrap--modal">
                  <table className="inspection-admin__table inspection-admin__table--assignments">
                    <thead>
                      <tr>
                        <th>Usuario</th>
                        {assignmentBranches.map((branch) => (
                          <th key={`inspection-assignment-branch-${normalizeId(branch?.id)}`}>
                            {String(branch?.nombre || `Sucursal ${branch?.id || '-'}`).trim()}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {!filteredAssignmentRows.length ? (
                        <tr className="inspection-admin__empty-row">
                          <td colSpan={Math.max(1 + assignmentBranches.length, 2)} />
                        </tr>
                      ) : filteredAssignmentRows.map((row) => {
                        const rowId = normalizeId(row?.id)
                        return (
                          <tr key={`inspection-assignment-${rowId}`}>
                            <td>
                              <div className="inspection-admin__product-cell">
                                <strong>{String(row?.nombre_completo || `Usuario ${row?.id || '-'}`).trim()}</strong>
                                <span className="inspection-admin__product-cell__email">{String(row?.correo || '-').trim()}</span>
                                <span className="inspection-admin__product-cell__type">{row?.es_administrador ? 'Administrador' : 'Usuario interno'}</span>
                              </div>
                            </td>
                            {assignmentBranches.map((branch) => {
                              const branchId = normalizeId(branch?.id)
                              return (
                                <td key={`inspection-assignment-${rowId}-branch-${branchId}`}>
                                  <label className="inspection-admin__assignment-toggle">
                                    <input
                                      type="checkbox"
                                      checked={(localAssignmentMap[rowId] || []).includes(branchId)}
                                      onChange={() => void handleCheckboxChange(rowId, branchId)}
                                      disabled={!canUpdate || assignmentsLoading || assignmentPending.has(`${rowId}:${branchId}`)}
                                    />
                                  </label>
                                </td>
                              )
                            })}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Sin botones: cada cambio se guarda solo y se cierra con la X. */}
          </div>
          {confirmAutoToggle && (
            <div
              className="unsaved-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Confirmar revision automatica"
              onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) setConfirmAutoToggle(false) }}
            >
              <div className="unsaved-dialog__card">
                <h4>{autoOn ? '¿Desactivar la revisión automática?' : '¿Activar la revisión automática?'}</h4>
                <p>
                  {autoOn
                    ? 'Ya no se va a crear una revisión aleatoria cada día. Solo quedarán las que envíes con "Enviar revisión ahora".'
                    : `Cada día se le va a crear una revisión aleatoria a cada revisor asignado, a las ${horaLabel}.`}
                </p>
                <div className="unsaved-dialog__actions">
                  <button type="button" className="unsaved-dialog__btn" onClick={() => setConfirmAutoToggle(false)}>
                    Cancelar
                  </button>
                  <button type="button" className="unsaved-dialog__btn unsaved-dialog__btn--save" onClick={() => void applyAutoToggle()}>
                    {autoOn ? 'Sí, desactivar' : 'Sí, activar'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        )
      })()}
    </section>
  )
}

export default RandomInspectionAdminTable
