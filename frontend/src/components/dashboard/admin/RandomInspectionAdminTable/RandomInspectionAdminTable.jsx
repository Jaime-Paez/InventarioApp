import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Loader2, Pencil, Send, Settings, Wrench, X } from 'lucide-react'
import { Paginator } from 'primereact/paginator'
import { Toast } from 'primereact/toast'
import { API_URL, authFetch } from '../../../../utils/api'
import { formatDateTime } from '../../../../utils/dateFormat'
import { getAppPortalRoot } from '../../../../utils/portalRoot'
import { useCloseDropdownsOnTabSwitch } from '../../../../hooks/useCloseDropdownsOnTabSwitch'
import '../CreateUsuario/CreateUsuario.css'
import '../../QuickActions/QuickActions.css'
import '../../movimientos/CreateSalida.css'
import './RandomInspectionAdminTable.css'

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeId = (value) => (value == null ? '' : String(value).trim())
const normalizeForSearch = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()

// Dropdown con búsqueda debounced sobre una lista ya cargada en memoria —
// mismo patrón (create-user__dropdown + create-user__result-option) que
// usan las demás búsquedas en cascada Sucursal/Bodega/Division del resto
// de la app (ver InventarioEditor.jsx). El panel se renderiza vía portal
// con create-user__dropdown-panel--floating (position:fixed) para que
// pueda salirse del modal en vez de quedar recortado por su overflow.
function CascadeDropdown({ placeholder, searchPlaceholder, options, valueId, onSelect, disabled, getOptionLabel }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [panelRect, setPanelRect] = useState(null)
  const wrapRef = useRef(null)
  const panelRef = useRef(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(normalizeForSearch(query)), 260)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!open) return undefined
    const handleOutsideClick = (event) => {
      const inTrigger = wrapRef.current?.contains(event.target)
      const inPanel = panelRef.current?.contains(event.target)
      if (!inTrigger && !inPanel) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  useCloseDropdownsOnTabSwitch(
    useCallback(() => {
      setOpen(false)
      setQuery('')
    }, [])
  )

  const filtered = useMemo(() => {
    if (!debouncedQuery) return options
    return options.filter((o) => normalizeForSearch(getOptionLabel(o)).includes(debouncedQuery))
  }, [options, debouncedQuery, getOptionLabel])

  const selected = options.find((o) => String(o.id) === String(valueId))

  return (
    <div className="create-user__dropdown" ref={wrapRef}>
      <button
        type="button"
        className="create-user__dropdown-trigger"
        onClick={(event) => {
          if (disabled) return
          if (open) {
            setOpen(false)
            setQuery('')
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          // El panel puede llegar a medir ~230px (buscador + resultados con
          // max-height:150px). Si no hay espacio debajo, se abre hacia
          // arriba anclando el borde inferior (bottom) en vez del superior,
          // para que nunca quede cortado por el borde de la pantalla.
          const estimatedPanelHeight = 230
          const spaceBelow = window.innerHeight - rect.bottom
          const spaceAbove = rect.top
          const openUpward = spaceBelow < estimatedPanelHeight && spaceAbove > spaceBelow
          const left = Math.min(Math.max(rect.left, 8), window.innerWidth - rect.width - 8)
          setPanelRect({
            left,
            width: rect.width,
            ...(openUpward
              ? { bottom: window.innerHeight - rect.top + 4 }
              : { top: rect.bottom + 4 }),
          })
          setOpen(true)
        }}
        disabled={disabled}
      >
        <span>{selected ? getOptionLabel(selected) : placeholder}</span>
        <i className={`pi pi-chevron-${open ? 'up' : 'down'}`} />
      </button>

      {open && panelRect && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          className="create-user__dropdown-panel create-user__dropdown-panel--floating"
          style={{ top: panelRect.top, bottom: panelRect.bottom, left: panelRect.left, width: panelRect.width, maxHeight: 'calc(100vh - 16px)' }}
        >
          <div className="create-user__dropdown-search">
            <i className="pi pi-search" />
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
              autoComplete="off"
            />
          </div>
          <div className="create-user__dropdown-results">
            {!filtered.length && <small className="muted">Sin resultados.</small>}
            {filtered.map((option) => (
              <button
                key={option.id}
                type="button"
                className="create-user__result-option"
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onSelect(option)
                  setOpen(false)
                  setQuery('')
                }}
              >
                <div className="create-user__result-info">
                  <strong>{getOptionLabel(option)}</strong>
                </div>
              </button>
            ))}
          </div>
        </div>,
        getAppPortalRoot()
      )}
    </div>
  )
}

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

const formatReviewState = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'coincide') return 'Coincide'
  if (normalized === 'no_coincide') return 'No coincide'
  if (normalized === 'pendiente') return 'Pendiente'
  return '-'
}

const formatVerificationState = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'sin_novedad') return 'Sin novedad'
  if (normalized === 'pendiente') return 'Pendiente'
  if (normalized === 'aprobada') return 'Aprobada'
  if (normalized === 'rechazada') return 'Rechazada'
  return '-'
}

const ASSIGNMENTS_MODAL_MIN_WIDTH = 720
const ASSIGNMENTS_MODAL_MIN_HEIGHT = 520
const ASSIGNMENTS_VIEWPORT_PADDING = 12
const detectDarkTheme = () => {
  if (typeof document === 'undefined') return false
  return Boolean(
    document.querySelector('.app-shell')?.classList.contains('theme-dark')
    || document.querySelector('.dashboard-shell')?.classList.contains('dark')
  )
}

function RandomInspectionAdminTable({ token, moduleActions, isTabActive }) {
  const toast = useRef(null)
  const canRead = moduleActions?.puede_leer ?? true
  const canUpdate = moduleActions?.puede_actualizar ?? true
  const [isDarkTheme, setIsDarkTheme] = useState(detectDarkTheme)

  const [summaryRows, setSummaryRows] = useState([])
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [selectedBranchId, setSelectedBranchId] = useState('')

  const [itemsRows, setItemsRows] = useState([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsFilter, setItemsFilter] = useState('pendiente')
  const [itemsPage, setItemsPage] = useState(1)
  const [itemsPageSize, setItemsPageSize] = useState(20)
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
  const [showAssignmentsDialog, setShowAssignmentsDialog] = useState(false)
  const [assignmentRows, setAssignmentRows] = useState([])
  const [assignmentBranches, setAssignmentBranches] = useState([])
  const [assignmentsLoading, setAssignmentsLoading] = useState(false)
  const [assignmentSearch, setAssignmentSearch] = useState('')
  const [localAssignmentMap, setLocalAssignmentMap] = useState({})
  const [assignmentsSaving, setAssignmentsSaving] = useState(false)
  const [isEditingAssignments, setIsEditingAssignments] = useState(false)
  const [configData, setConfigData] = useState({ hora_recordatorio: '', cantidad_productos: '' })
  const [configLoading, setConfigLoading] = useState(false)
  const [showSendNowDialog, setShowSendNowDialog] = useState(false)
  const [sendNowLoading, setSendNowLoading] = useState(false)
  const [sendNowDialogLoading, setSendNowDialogLoading] = useState(false)
  const [sendNowParams, setSendNowParams] = useState({ cantidad_productos: '', hora_recordatorio: '' })
  const [sendNowSelectedUserIds, setSendNowSelectedUserIds] = useState(new Set())
  const [sendNowMode, setSendNowMode] = useState('aleatorio')
  const [divisionSucursalId, setDivisionSucursalId] = useState('')
  const [divisionBodegaId, setDivisionBodegaId] = useState('')
  const [divisionId, setDivisionId] = useState('')
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
  const [assignmentsModalPosition, setAssignmentsModalPosition] = useState({ x: 0, y: 0 })
  const [assignmentsModalSize, setAssignmentsModalSize] = useState({
    width: ASSIGNMENTS_MODAL_MIN_WIDTH,
    height: ASSIGNMENTS_MODAL_MIN_HEIGHT,
  })
  const [assignmentsModalMaximized, setAssignmentsModalMaximized] = useState(false)

  const assignmentsModalRef = useRef(null)
  const assignmentsDragRef = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const assignmentsResizeRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
  })
  const assignmentsRestoreRef = useRef(null)
  const assignmentsSizeRef = useRef(assignmentsModalSize)
  const assignmentsPositionRef = useRef(assignmentsModalPosition)

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
  const getAssignmentsViewportMetrics = useCallback(() => {
    const availableWidth = Math.max(0, window.innerWidth - ASSIGNMENTS_VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - ASSIGNMENTS_VIEWPORT_PADDING * 2)
    return {
      availableWidth,
      availableHeight,
      minWidth: Math.min(ASSIGNMENTS_MODAL_MIN_WIDTH, availableWidth),
      minHeight: Math.min(ASSIGNMENTS_MODAL_MIN_HEIGHT, availableHeight),
    }
  }, [])

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

    const hora = String(sendNowParams?.hora_recordatorio || '').trim()
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
        { method: 'POST', body: JSON.stringify({ ...sendNowParams, usuario_ids: [...sendNowSelectedUserIds] }) },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo enviar el recordatorio.')
      notifySuccess('Recordatorio enviado correctamente.')
      setShowSendNowDialog(false)
    } catch (error) {
      notifyError(error?.message || 'No se pudo enviar el recordatorio.')
    } finally {
      setSendNowLoading(false)
    }
  }, [token, sendNowParams, notifyError, notifySuccess])

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

  const sendDivision = useCallback(async () => {
    if (!token) return
    if (!divisionId) { notifyError('Debes seleccionar una division.'); return }
    if (!divisionUsuarioId) { notifyError('Debes seleccionar un revisor.'); return }

    const hora = String(sendNowParams?.hora_recordatorio || '').trim()
    if (!hora) { notifyError('Debes seleccionar la hora del recordatorio.'); return }

    setDivisionSending(true)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/enviar-division/`,
        {
          method: 'POST',
          body: JSON.stringify({
            division_id: divisionId,
            usuario_id: divisionUsuarioId,
            hora_recordatorio: hora,
          }),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo enviar la division.')
      notifySuccess(`Division enviada: ${payload.productos} producto(s) para ${payload.nombre}.`)
      setShowSendNowDialog(false)
    } catch (error) {
      notifyError(error?.message || 'No se pudo enviar la division.')
    } finally {
      setDivisionSending(false)
    }
  }, [token, divisionId, divisionUsuarioId, sendNowParams, notifyError, notifySuccess])

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
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
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

    const hora = String(sendNowParams?.hora_recordatorio || '').trim()
    if (!hora) { notifyError('Debes seleccionar la hora del recordatorio.'); return }

    setListSending(true)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/enviar-lista/`,
        {
          method: 'POST',
          body: JSON.stringify({
            sucursal_id: listSucursalId,
            usuario_id: listUsuarioId,
            producto_ids: listProducts.map((item) => item.id),
            hora_recordatorio: hora,
          }),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo enviar la lista.')
      notifySuccess(`Lista enviada: ${payload.productos} producto(s) para ${payload.nombre}.`)
      setShowSendNowDialog(false)
    } catch (error) {
      notifyError(error?.message || 'No se pudo enviar la lista.')
    } finally {
      setListSending(false)
    }
  }, [token, listSucursalId, listUsuarioId, listProducts, sendNowParams, notifyError, notifySuccess])

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

  const loadSummary = useCallback(async () => {
    if (!token || !canRead) {
      setSummaryRows([])
      setSelectedBranchId('')
      return []
    }

    setSummaryLoading(true)
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
      setSummaryRows([])
      setSelectedBranchId('')
      notifyError(error?.message || 'No se pudo cargar el resumen por sucursal.')
      return []
    } finally {
      setSummaryLoading(false)
    }
  }, [canRead, notifyError, token])

  const loadItems = useCallback(async () => {
    const branchId = normalizeId(selectedBranchId)
    if (!token || !canRead || !branchId) {
      setItemsRows([])
      setItemsTotalCount(0)
      return []
    }

    setItemsLoading(true)
    try {
      const endpoint = new URL(`${API_URL}/recordatorios/inspeccion-aleatoria/admin/items/`)
      endpoint.searchParams.set('sucursal_id', branchId)
      endpoint.searchParams.set('estado', itemsFilter)
      endpoint.searchParams.set('page', String(itemsPage))
      endpoint.searchParams.set('page_size', String(itemsPageSize))

      const response = await authFetch(endpoint.toString(), {}, token)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudieron cargar las diferencias.')
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
      setItemsRows([])
      setItemsTotalCount(0)
      notifyError(error?.message || 'No se pudieron cargar las diferencias.')
      return []
    } finally {
      setItemsLoading(false)
    }
  }, [canRead, itemsFilter, itemsPage, itemsPageSize, notifyError, selectedBranchId, token])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  useEffect(() => {
    void loadItems()
  }, [loadItems])

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
      void loadSummary()
      void loadItems()
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

  useEffect(() => {
    assignmentsSizeRef.current = assignmentsModalSize
  }, [assignmentsModalSize])

  useEffect(() => {
    assignmentsPositionRef.current = assignmentsModalPosition
  }, [assignmentsModalPosition])

  useLayoutEffect(() => {
    if (!showAssignmentsDialog) return

    const { availableWidth, availableHeight } = getAssignmentsViewportMetrics()
    const width = Math.min(ASSIGNMENTS_MODAL_MIN_WIDTH, availableWidth)
    const height = Math.min(ASSIGNMENTS_MODAL_MIN_HEIGHT, availableHeight)
    const centeredX = Math.max((window.innerWidth - width) / 2, ASSIGNMENTS_VIEWPORT_PADDING)
    const centeredY = Math.max((window.innerHeight - height) / 2, ASSIGNMENTS_VIEWPORT_PADDING)

    setAssignmentsModalMaximized(false)
    assignmentsRestoreRef.current = null
    setAssignmentsModalSize({ width, height })
    setAssignmentsModalPosition({ x: centeredX, y: centeredY })
  }, [getAssignmentsViewportMetrics, showAssignmentsDialog])

  useEffect(() => {
    if (!showAssignmentsDialog) return undefined

    const handleMouseMove = (event) => {
      if (!assignmentsDragRef.current.active) return
      event.preventDefault()
      const newX = event.clientX - assignmentsDragRef.current.offsetX
      const newY = event.clientY - assignmentsDragRef.current.offsetY
      const maxX = window.innerWidth - assignmentsSizeRef.current.width - ASSIGNMENTS_VIEWPORT_PADDING
      const maxY = window.innerHeight - assignmentsSizeRef.current.height - ASSIGNMENTS_VIEWPORT_PADDING
      setAssignmentsModalPosition({
        x: Math.min(Math.max(newX, ASSIGNMENTS_VIEWPORT_PADDING), Math.max(maxX, ASSIGNMENTS_VIEWPORT_PADDING)),
        y: Math.min(Math.max(newY, ASSIGNMENTS_VIEWPORT_PADDING), Math.max(maxY, ASSIGNMENTS_VIEWPORT_PADDING)),
      })
    }

    const handleMouseUp = () => {
      assignmentsDragRef.current.active = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [showAssignmentsDialog])

  useEffect(() => {
    if (!showAssignmentsDialog) return undefined

    const handleWindowResize = () => {
      const { minWidth, minHeight, availableWidth, availableHeight } = getAssignmentsViewportMetrics()

      if (assignmentsModalMaximized) {
        setAssignmentsModalSize({ width: availableWidth, height: availableHeight })
        setAssignmentsModalPosition({ x: ASSIGNMENTS_VIEWPORT_PADDING, y: ASSIGNMENTS_VIEWPORT_PADDING })
        return
      }

      setAssignmentsModalSize((prev) => {
        const width = clamp(prev.width, minWidth, availableWidth)
        const height = clamp(prev.height, minHeight, availableHeight)

        setAssignmentsModalPosition((prevPosition) => ({
          x: Math.min(
            Math.max(prevPosition.x, ASSIGNMENTS_VIEWPORT_PADDING),
            Math.max(window.innerWidth - width - ASSIGNMENTS_VIEWPORT_PADDING, ASSIGNMENTS_VIEWPORT_PADDING)
          ),
          y: Math.min(
            Math.max(prevPosition.y, ASSIGNMENTS_VIEWPORT_PADDING),
            Math.max(window.innerHeight - height - ASSIGNMENTS_VIEWPORT_PADDING, ASSIGNMENTS_VIEWPORT_PADDING)
          ),
        }))

        return { width, height }
      })
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [assignmentsModalMaximized, getAssignmentsViewportMetrics, showAssignmentsDialog])

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
    setVerifyWizardSubmitting(false)
    setVerifyWizardLoading(false)
    void loadSummary()
    void loadItems()
  }, [loadItems, loadSummary])

  // Trae todas las diferencias pendientes de la sucursal (hasta 100 por vez)
  // y abre el wizard en la elegida (o en la primera).
  const openVerifyWizard = useCallback(async (startItemId = '') => {
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
        acc[id] = {
          cantidad: String(Math.max(0, Number.parseInt(String(fallback || 0), 10) || 0)),
          nota: '',
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
    setIsEditingAssignments(false)
  }, [])

  const openAssignmentsDialog = useCallback(() => {
    setShowAssignmentsDialog(true)
    void loadAssignments()
    void loadConfig()
  }, [loadAssignments, loadConfig])

  const handleAssignmentsHeaderMouseDown = useCallback((event) => {
    if (assignmentsModalMaximized) {
      const restore = assignmentsRestoreRef.current
      const fallbackSize = assignmentsSizeRef.current
      const restoredSize = restore?.size || fallbackSize
      const restoredPosition = restore?.position || {
        x: Math.max((window.innerWidth - restoredSize.width) / 2, ASSIGNMENTS_VIEWPORT_PADDING),
        y: Math.max((window.innerHeight - restoredSize.height) / 2, ASSIGNMENTS_VIEWPORT_PADDING),
      }

      assignmentsSizeRef.current = restoredSize
      assignmentsPositionRef.current = restoredPosition
      setAssignmentsModalSize(restoredSize)
      setAssignmentsModalPosition(restoredPosition)
      setAssignmentsModalMaximized(false)

      const offsetX = Math.min(
        Math.max(event.clientX - restoredPosition.x, 24),
        Math.max(restoredSize.width - 24, 24)
      )
      const offsetY = Math.min(
        Math.max(event.clientY - restoredPosition.y, 12),
        56
      )
      assignmentsDragRef.current = {
        active: true,
        offsetX,
        offsetY,
      }
      return
    }

    if (!assignmentsModalRef.current) return
    const rect = assignmentsModalRef.current.getBoundingClientRect()
    assignmentsDragRef.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }, [assignmentsModalMaximized])

  const handleAssignmentsResizeMouseDown = useCallback((event) => {
    if (assignmentsModalMaximized) return
    event.preventDefault()
    event.stopPropagation()
    const { minWidth, minHeight } = getAssignmentsViewportMetrics()
    assignmentsResizeRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: assignmentsSizeRef.current.width,
      startHeight: assignmentsSizeRef.current.height,
    }

    const handleResizeMove = (moveEvent) => {
      if (!assignmentsResizeRef.current.active) return
      const deltaX = moveEvent.clientX - assignmentsResizeRef.current.startX
      const deltaY = moveEvent.clientY - assignmentsResizeRef.current.startY
      const maxWidth = Math.max(
        minWidth,
        window.innerWidth - assignmentsPositionRef.current.x - ASSIGNMENTS_VIEWPORT_PADDING
      )
      const maxHeight = Math.max(
        minHeight,
        window.innerHeight - assignmentsPositionRef.current.y - ASSIGNMENTS_VIEWPORT_PADDING
      )
      const width = clamp(assignmentsResizeRef.current.startWidth + deltaX, minWidth, maxWidth)
      const height = clamp(assignmentsResizeRef.current.startHeight + deltaY, minHeight, maxHeight)
      setAssignmentsModalSize({ width, height })
    }

    const handleResizeUp = () => {
      assignmentsResizeRef.current.active = false
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }

    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }, [assignmentsModalMaximized, getAssignmentsViewportMetrics])

  const toggleAssignmentsMaximize = useCallback(() => {
    if (assignmentsModalMaximized) {
      const restore = assignmentsRestoreRef.current
      if (restore?.size && restore?.position) {
        setAssignmentsModalSize(restore.size)
        setAssignmentsModalPosition(restore.position)
      }
      setAssignmentsModalMaximized(false)
      return
    }

    assignmentsRestoreRef.current = {
      size: assignmentsSizeRef.current,
      position: assignmentsPositionRef.current,
    }

    const { availableWidth, availableHeight } = getAssignmentsViewportMetrics()
    setAssignmentsModalSize({
      width: availableWidth,
      height: availableHeight,
    })
    setAssignmentsModalPosition({
      x: ASSIGNMENTS_VIEWPORT_PADDING,
      y: ASSIGNMENTS_VIEWPORT_PADDING,
    })
    setAssignmentsModalMaximized(true)
  }, [assignmentsModalMaximized, getAssignmentsViewportMetrics])

  const handleToggleEdit = useCallback(() => {
    if (assignmentsLoading || assignmentsSaving) return
    if (isEditingAssignments) {
      const map = {}
      assignmentRows.forEach((row) => {
        const id = normalizeId(row?.id)
        if (id) {
          map[id] = Array.isArray(row?.inspeccion_aleatoria_sucursales)
            ? row.inspeccion_aleatoria_sucursales.map((v) => normalizeId(v))
            : []
        }
      })
      setLocalAssignmentMap(map)
      setIsEditingAssignments(false)
    } else {
      setIsEditingAssignments(true)
    }
  }, [assignmentsLoading, assignmentsSaving, isEditingAssignments, assignmentRows])

  const handleCheckboxChange = useCallback((rowId, branchId) => {
    setLocalAssignmentMap((prev) => {
      const current = prev[rowId] || []
      const has = current.includes(branchId)
      return {
        ...prev,
        [rowId]: has ? current.filter((id) => id !== branchId) : [...current, branchId],
      }
    })
  }, [])

  const saveAssignments = useCallback(async () => {
    if (!token || !canUpdate) return

    if (!String(configData.hora_recordatorio || '').trim()) {
      notifyError('La hora de envio del recordatorio es requerida.')
      return
    }

    const changes = []
    assignmentRows.forEach((row) => {
      const rowId = normalizeId(row?.id)
      if (!rowId) return
      const original = Array.isArray(row?.inspeccion_aleatoria_sucursales)
        ? row.inspeccion_aleatoria_sucursales.map((v) => normalizeId(v))
        : []
      const local = localAssignmentMap[rowId] || []
      assignmentBranches.forEach((branch) => {
        const branchId = normalizeId(branch?.id)
        if (!branchId) return
        const was = original.includes(branchId)
        const is = local.includes(branchId)
        if (was !== is) changes.push({ rowId, branchId, habilitado: is })
      })
    })

    setAssignmentsSaving(true)
    try {
      const configResponse = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/configuracion/`,
        { method: 'PATCH', body: JSON.stringify(configData) },
        token
      )
      if (!configResponse.ok) {
        const p = await configResponse.json().catch(() => ({}))
        throw new Error(String(p?.detail || '').trim() || 'No se pudo guardar la configuracion.')
      }

      if (changes.length) {
        const results = await Promise.allSettled(
          changes.map((change) =>
            authFetch(
              `${API_URL}/usuarios/listado/${encodeURIComponent(change.rowId)}/inspeccion-aleatoria-asignacion/`,
              {
                method: 'PATCH',
                body: JSON.stringify({ sucursal_id: change.branchId, habilitado: change.habilitado }),
              },
              token
            ).then(async (res) => {
              const payload = await res.json().catch(() => ({}))
              if (!res.ok) throw new Error(String(payload?.detail || '').trim() || 'Error al actualizar.')
              return payload
            })
          )
        )
        const failed = results.filter((r) => r.status === 'rejected')
        if (failed.length) {
          notifyError(`${failed.length} cambio(s) de revisores no se pudieron guardar.`)
        }
      }

      notifySuccess('Cambios guardados correctamente.')
      setIsEditingAssignments(false)
      await Promise.all([loadAssignments(), loadConfig()])
    } catch (error) {
      notifyError(error?.message || 'No se pudieron guardar los cambios.')
    } finally {
      setAssignmentsSaving(false)
    }
  }, [token, canUpdate, assignmentRows, assignmentBranches, localAssignmentMap, configData, loadAssignments, loadConfig, notifyError, notifySuccess])

  const submitVerifyDecision = useCallback(async (action) => {
    const item = verifyWizardItems[verifyWizardIndex]
    const itemId = normalizeId(item?.id)
    if (!token || !itemId || verifyWizardDecisions[itemId]) return

    const draft = verifyWizardDrafts[itemId] || {}
    const body = { accion: action, nota: String(draft?.nota || '').trim() }
    if (action === 'aprobar') {
      const nextQty = Number.parseInt(String(draft?.cantidad ?? '').trim(), 10)
      if (!Number.isFinite(nextQty) || nextQty < 0) {
        setVerifyWizardError('Debes ingresar una cantidad valida mayor o igual a cero.')
        return
      }
      body.cantidad_confirmada = nextQty
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
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar la verificacion.')
      }
      const nextDecisions = { ...verifyWizardDecisions, [itemId]: action === 'aprobar' ? 'aprobada' : 'rechazada' }
      setVerifyWizardDecisions(nextDecisions)
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
  }, [token, verifyWizardDecisions, verifyWizardDrafts, verifyWizardIndex, verifyWizardItems])

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

  const sendNowSummary = useMemo(() => {
    return assignmentBranches.map((branch) => {
      const branchId = normalizeId(branch?.id)
      const reviewers = assignmentRows.filter((row) => {
        const ids = Array.isArray(row?.inspeccion_aleatoria_sucursales)
          ? row.inspeccion_aleatoria_sucursales.map((v) => normalizeId(v))
          : []
        return ids.includes(branchId)
      })
      return { id: branchId, nombre: String(branch?.nombre || '').trim(), reviewers }
    }).filter((b) => b.reviewers.length > 0)
  }, [assignmentBranches, assignmentRows])

  const divisionReviewers = useMemo(() => {
    if (!divisionSucursalId) return []
    return sendNowSummary.find((b) => b.id === normalizeId(divisionSucursalId))?.reviewers || []
  }, [sendNowSummary, divisionSucursalId])

  const listReviewers = useMemo(() => {
    if (!listSucursalId) return []
    return sendNowSummary.find((b) => b.id === normalizeId(listSucursalId))?.reviewers || []
  }, [sendNowSummary, listSucursalId])

  if (!canRead) {
    return (
      <section className="inspection-admin">
        <p className="inspection-admin__empty">No tienes permisos para acceder a esta seccion.</p>
      </section>
    )
  }

  return (
    <section className="inspection-admin">
      <Toast ref={toast} />

      <header className="inspection-admin__head">
        <div>
          <p>Consulta cobertura de inspecciones y corrige cantidades reales reportadas.</p>
        </div>
        <div className="inspection-admin__head-actions">
          {canUpdate && (
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
                setDivisionSucursalId('')
                setDivisionBodegaId('')
                setDivisionId('')
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
          {canUpdate && (
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

      <div className="inspection-admin__block">
        <div className="inspection-admin__block-head">
          <h4>Sucursales</h4>
          <button
            type="button"
            className="rounded-icon-btn"
            onClick={() => {
              void loadSummary()
              void loadItems()
            }}
            disabled={summaryLoading || itemsLoading}
            title="Actualizar"
          >
            <i className={`pi ${summaryLoading || itemsLoading ? 'pi-spin pi-spinner' : 'pi-refresh'}`} />
          </button>
        </div>
        <div className="inspection-admin__table-wrap">
          <table className="inspection-admin__table inspection-admin__table--summary">
            <thead>
              <tr>
                <th>Sucursal</th>
                <th>Productos inventario</th>
                <th>Productos revisados</th>
                <th>Cobertura</th>
                <th>Diferencias</th>
                <th>Pendientes verificacion</th>
                <th>Ultima revision</th>
              </tr>
            </thead>
            <tbody>
              {!summaryRows.length ? (
                <tr className="inspection-admin__empty-row">
                  <td colSpan={7} />
                </tr>
              ) : summaryRows.map((row) => {
                const rowId = normalizeId(row?.sucursal_id)
                const selected = rowId && rowId === normalizeId(selectedBranchId)
                return (
                  <tr
                    key={`inspection-branch-${rowId}`}
                    className={`inspection-admin__summary-row${selected ? ' is-selected' : ''}`}
                    onClick={() => setSelectedBranchId(rowId)}
                  >
                    <td>{String(row?.sucursal_nombre || `Sucursal ${row?.sucursal_id || '-'}`).trim()}</td>
                    <td>{Number.parseInt(String(row?.total_productos_inventario || 0), 10) || 0}</td>
                    <td>{Number.parseInt(String(row?.productos_revisados || 0), 10) || 0}</td>
                    <td>{formatPercent(row?.cobertura_porcentaje)}</td>
                    <td>{Number.parseInt(String(row?.diferencias_reportadas || 0), 10) || 0}</td>
                    <td>{Number.parseInt(String(row?.pendientes_verificacion || 0), 10) || 0}</td>
                    <td>{formatDateTime(row?.ultima_revision)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {summaryLoading && (
            <p className="inspection-admin__loading">
              <Loader2 size={14} />
              Cargando resumen...
            </p>
          )}
        </div>
      </div>

      <div className="inspection-admin__block">
        <div className="inspection-admin__subhead">
          <h4>
            Diferencias reportadas
            {selectedBranch ? ` - ${String(selectedBranch?.sucursal_nombre || '').trim()}` : ''}
          </h4>
          <div className="inspection-admin__subhead-actions">
          {canUpdate && Number(selectedBranch?.pendientes_verificacion || 0) > 0 && (
            <button
              type="button"
              className="inspection-admin__manage"
              onClick={() => void openVerifyWizard()}
            >
              <Wrench size={14} />
              {`Revisar diferencias (${Number(selectedBranch?.pendientes_verificacion || 0)})`}
            </button>
          )}
          <select
            value={itemsFilter}
            onChange={(event) => setItemsFilter(String(event.target.value || 'pendiente'))}
            disabled={itemsLoading}
          >
            <option value="pendiente">Pendientes</option>
            <option value="diferencias">Con diferencia</option>
            <option value="verificado">Verificadas</option>
            <option value="todos">Todas</option>
          </select>
          </div>
        </div>

        <div className="inspection-admin__table-wrap">
          <table className="inspection-admin__table inspection-admin__table--items">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Producto</th>
                <th>Esperada</th>
                <th>Reportada</th>
                <th>Confirmada</th>
                <th>Revision</th>
                <th>Verificacion</th>
                <th>Inspeccion de</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {!itemsRows.length ? (
                <tr className="inspection-admin__empty-row">
                  <td colSpan={9} />
                </tr>
              ) : itemsRows.map((row) => {
                const canFix = (
                  canUpdate &&
                  String(row?.estado_revision || '').trim().toLowerCase() === 'no_coincide' &&
                  String(row?.verificacion_estado || '').trim().toLowerCase() === 'pendiente'
                )
                return (
                  <tr key={`inspection-item-${normalizeId(row?.id)}`}>
                    <td>{formatDateTime(row?.revisado_en || row?.fecha_programada)}</td>
                    <td>
                      <div className="inspection-admin__product-cell">
                        <strong>{String(row?.producto_codigo || '').trim() || `#${row?.producto_id || '-'}`}</strong>
                        <span>{String(row?.producto_nombre || 'Producto').trim()}</span>
                      </div>
                    </td>
                    <td>{Number.parseInt(String(row?.cantidad_esperada || 0), 10) || 0}</td>
                    <td>{row?.cantidad_reportada == null ? '-' : Number.parseInt(String(row?.cantidad_reportada || 0), 10) || 0}</td>
                    <td>{row?.cantidad_confirmada == null ? '-' : Number.parseInt(String(row?.cantidad_confirmada || 0), 10) || 0}</td>
                    <td>{formatReviewState(row?.estado_revision)}</td>
                    <td>{formatVerificationState(row?.verificacion_estado)}</td>
                    <td>{String(row?.inspeccion_usuario_nombre || '-').trim() || '-'}</td>
                    <td>
                      {canFix ? (
                        <button
                          type="button"
                          className="inspection-admin__action"
                          onClick={() => void openVerifyWizard(normalizeId(row?.id))}
                        >
                          <Wrench size={13} />
                          Revisar
                        </button>
                      ) : (
                        <span className="inspection-admin__action-placeholder">Sin accion</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {itemsLoading && (
            <p className="inspection-admin__loading">
              <Loader2 size={14} />
              Cargando diferencias...
            </p>
          )}
        </div>

        <Paginator
          first={Math.max(0, (Math.min(itemsPage, itemsTotalPages) - 1) * itemsPageSize)}
          rows={itemsPageSize}
          totalRecords={itemsTotalCount}
          rowsPerPageOptions={[10, 20, 50, 100]}
          className="inspection-admin__paginator"
          template="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown"
          onPageChange={(event) => {
            const nextRows = Number.parseInt(String(event.rows || itemsPageSize), 10)
            const nextPage = Number.parseInt(String((event.page ?? 0) + 1), 10)
            if (Number.isFinite(nextRows) && nextRows > 0 && nextRows !== itemsPageSize) {
              setItemsPageSize(nextRows)
            }
            setItemsPage(Number.isFinite(nextPage) && nextPage > 0 ? nextPage : 1)
          }}
        />
      </div>

      {verifyWizardOpen && (() => {
        const total = verifyWizardItems.length
        const item = verifyWizardItems[verifyWizardIndex] || null
        const itemId = normalizeId(item?.id)
        const draft = verifyWizardDrafts[itemId] || { cantidad: '', nota: '' }
        const decision = verifyWizardDecisions[itemId] || ''
        const decidedCount = Object.keys(verifyWizardDecisions).length
        const approvedCount = Object.values(verifyWizardDecisions).filter((value) => value === 'aprobada').length
        const expected = Number.parseInt(String(item?.cantidad_esperada ?? 0), 10) || 0
        const reported = item?.cantidad_reportada == null ? null : Number.parseInt(String(item.cantidad_reportada), 10) || 0
        const firstCount = item?.cantidad_primer_conteo == null ? null : Number.parseInt(String(item.cantidad_primer_conteo), 10) || 0
        const confirmed = Number.parseInt(String(draft?.cantidad ?? '').trim(), 10)
        const adjustment = Number.isFinite(confirmed) ? confirmed - expected : null
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
                      {`Listo: revisaste ${decidedCount} diferencia(s) (${approvedCount} ajustada(s), ${decidedCount - approvedCount} rechazada(s)).`}
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
                              {locations.map((location, index) => (
                                <div key={`verify-location-${itemId}-${index}`} className="quick-actions__inspection-location-row">
                                  <div>
                                    <small>Ubicación</small>
                                    <strong>{String(location?.label || '-').trim()}</strong>
                                  </div>
                                  <div>
                                    <small>Sistema</small>
                                    <strong>{location?.cantidad_sistema == null ? '-' : location.cantidad_sistema}</strong>
                                  </div>
                                  <div>
                                    <small>Contado</small>
                                    <strong>{location?.cantidad_contada == null ? '-' : location.cantidad_contada}</strong>
                                  </div>
                                </div>
                              ))}
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
                        <div>
                          <small>Contado</small>
                          <strong>{reported == null ? '-' : reported}</strong>
                        </div>
                        <div>
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

                      {decision ? (
                        <p className="quick-actions__inspection-verify-state">
                          {decision === 'aprobada' ? 'Ajuste aprobado.' : 'Ajuste rechazado.'}
                        </p>
                      ) : (
                        <>
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
                          <p className="quick-actions__inspection-stage-help">
                            {adjustment == null
                              ? 'Ingresa la cantidad real que hay en la sucursal.'
                              : adjustment === 0
                                ? 'Al aprobar, el inventario queda igual (coincide con lo esperado).'
                                : `Al aprobar se ${adjustment > 0 ? 'sumarán' : 'restarán'} ${Math.abs(adjustment)} unidad(es) al inventario. Al rechazar, el inventario no cambia.`}
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

              <footer className="quick-actions__inspection-actions inspection-admin__verify-actions">
                <button
                  type="button"
                  className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost"
                  onClick={closeVerifyWizard}
                  disabled={busy}
                >
                  {item ? 'Cancelar' : 'Cerrar'}
                </button>
                {item && (
                  <>
                    <button
                      type="button"
                      className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost"
                      onClick={() => { setVerifyWizardError(''); setVerifyWizardIndex((index) => Math.max(0, index - 1)) }}
                      disabled={busy || verifyWizardIndex <= 0}
                    >
                      Anterior
                    </button>
                    <button
                      type="button"
                      className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost"
                      onClick={() => { setVerifyWizardError(''); setVerifyWizardIndex((index) => Math.min(total - 1, index + 1)) }}
                      disabled={busy || verifyWizardIndex >= total - 1}
                    >
                      Siguiente
                    </button>
                    {!decision && (
                      <>
                        <button
                          type="button"
                          className="quick-actions__inspection-btn quick-actions__inspection-btn--ghost"
                          onClick={() => void submitVerifyDecision('rechazar')}
                          disabled={busy}
                        >
                          Rechazar
                        </button>
                        <button
                          type="button"
                          className="quick-actions__inspection-btn quick-actions__inspection-btn--primary"
                          onClick={() => void submitVerifyDecision('aprobar')}
                          disabled={busy}
                        >
                          {verifyWizardSubmitting ? 'Guardando...' : 'Aprobar ajuste'}
                        </button>
                      </>
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
            className={`inspection-admin__dialog${sendNowMode === 'lista' ? ' inspection-admin__dialog--wide' : ''}`}
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
              <div className="inspection-admin__config-fields" style={{ marginBottom: '12px' }}>
                {sendNowMode === 'aleatorio' && (
                  <label className="create-user__field">
                    <span>Productos por sucursal</span>
                    <input
                      type="number"
                      min="1"
                      max="200"
                      step="1"
                      value={sendNowParams.cantidad_productos}
                      onChange={(e) => setSendNowParams((prev) => ({ ...prev, cantidad_productos: e.target.value }))}
                      placeholder="Ej: 5"
                      disabled={sendNowLoading || sendNowDialogLoading}
                    />
                  </label>
                )}
                <label className="create-user__field">
                  <span>Hora del recordatorio</span>
                  <input
                    type="time"
                    value={sendNowParams.hora_recordatorio}
                    onChange={(e) => setSendNowParams((prev) => ({ ...prev, hora_recordatorio: e.target.value }))}
                    disabled={sendNowLoading || sendNowDialogLoading || divisionSending || listSending}
                  />
                </label>
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
                        placeholder="Selecciona un revisor"
                        searchPlaceholder="Buscar revisor"
                        options={listReviewers}
                        valueId={listUsuarioId}
                        getOptionLabel={(o) => String(o?.nombre_completo || o?.correo || `Usuario ${o?.id}`).trim()}
                        onSelect={(o) => setListUsuarioId(o.id)}
                        disabled={!listSucursalId || listSending}
                      />
                    </label>
                  </div>
                  {listSucursalId && listReviewers.length === 0 && (
                    <p className="inspection-admin__sendnow-empty">
                      Esta sucursal no tiene revisores asignados.
                    </p>
                  )}

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
                      onSelect={(o) => setDivisionId(o.id)}
                      disabled={!divisionBodegaId || divisionDivisionesLoading || divisionSending}
                    />
                  </label>
                  <label className="create-user__field">
                    <span>Revisor</span>
                    <CascadeDropdown
                      placeholder="Selecciona un revisor"
                      searchPlaceholder="Buscar revisor"
                      options={divisionReviewers}
                      valueId={divisionUsuarioId}
                      getOptionLabel={(o) => String(o?.nombre_completo || o?.correo || `Usuario ${o?.id}`).trim()}
                      onSelect={(o) => setDivisionUsuarioId(o.id)}
                      disabled={!divisionSucursalId || divisionSending}
                    />
                  </label>
                  {divisionSucursalId && divisionReviewers.length === 0 && (
                    <p className="inspection-admin__sendnow-empty">
                      Esta sucursal no tiene revisores asignados.
                    </p>
                  )}
                </div>
              ) : sendNowSummary.length === 0 ? (
                <p className="inspection-admin__sendnow-empty">
                  No hay revisores asignados. Configura los revisores antes de enviar.
                </p>
              ) : (() => {
                const allReviewerIds = sendNowSummary.flatMap((b) =>
                  b.reviewers.map((u) => normalizeId(u?.id)).filter(Boolean)
                )
                const allChecked = allReviewerIds.length > 0 && allReviewerIds.every((id) => sendNowSelectedUserIds.has(id))
                const someChecked = allReviewerIds.some((id) => sendNowSelectedUserIds.has(id))
                return (
                  <div className="inspection-admin__sendnow-table-wrap">
                    <table className="inspection-admin__sendnow-table">
                      <thead>
                        <tr>
                          <th>Sucursal</th>
                          <th>Revisor</th>
                          <th>
                            <input
                              type="checkbox"
                              checked={allChecked}
                              ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked }}
                              onChange={() => {
                                if (allChecked) {
                                  setSendNowSelectedUserIds(new Set())
                                } else {
                                  setSendNowSelectedUserIds(new Set(allReviewerIds))
                                }
                              }}
                              disabled={sendNowLoading || sendNowDialogLoading}
                              title={allChecked ? 'Deseleccionar todos' : 'Seleccionar todos'}
                            />
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {sendNowSummary.flatMap((branch) =>
                          branch.reviewers.map((u, i) => {
                            const uid = normalizeId(u?.id)
                            return (
                              <tr
                                key={`sendnow-user-${uid}`}
                                className={sendNowSelectedUserIds.has(uid) ? 'inspection-admin__sendnow-row--selected' : ''}
                                onClick={() => {
                                  if (sendNowLoading || sendNowDialogLoading) return
                                  setSendNowSelectedUserIds((prev) => {
                                    const next = new Set(prev)
                                    if (next.has(uid)) next.delete(uid)
                                    else next.add(uid)
                                    return next
                                  })
                                }}
                              >
                                {i === 0 && (
                                  <td rowSpan={branch.reviewers.length} className="inspection-admin__sendnow-td-branch">
                                    {branch.nombre}
                                  </td>
                                )}
                                <td>{String(u?.nombre_completo || u?.correo || `Usuario ${u?.id}`).trim()}</td>
                                <td className="inspection-admin__sendnow-td-check">
                                  <input
                                    type="checkbox"
                                    checked={sendNowSelectedUserIds.has(uid)}
                                    onChange={() => {
                                      setSendNowSelectedUserIds((prev) => {
                                        const next = new Set(prev)
                                        if (next.has(uid)) next.delete(uid)
                                        else next.add(uid)
                                        return next
                                      })
                                    }}
                                    disabled={sendNowLoading || sendNowDialogLoading}
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                </td>
                              </tr>
                            )
                          })
                        )}
                      </tbody>
                    </table>
                    <p className="inspection-admin__sendnow-count-footer">
                      {sendNowSelectedUserIds.size} de {allReviewerIds.length} revisores seleccionados
                    </p>
                  </div>
                )
              })()}
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
                  onClick={() => void sendList()}
                  disabled={listSending || listBulkLoading || !listSucursalId || !listUsuarioId || listProducts.length === 0}
                >
                  {listSending ? 'Enviando...' : `Enviar lista (${listProducts.length})`}
                </button>
              ) : sendNowMode === 'division' ? (
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={() => void sendDivision()}
                  disabled={divisionSending || !divisionId || !divisionUsuarioId}
                >
                  {divisionSending ? 'Enviando...' : 'Enviar division completa'}
                </button>
              ) : (
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={() => void sendNow()}
                  disabled={sendNowLoading || sendNowDialogLoading || sendNowSummary.length === 0 || sendNowSelectedUserIds.size === 0}
                >
                  {sendNowLoading ? 'Enviando...' : 'Enviar ahora'}
                </button>
              )}
            </footer>
          </div>
        </div>
      )}

      {showAssignmentsDialog && isTabActive !== false && typeof document !== 'undefined' && createPortal(
        <div
          className={`create-user__overlay inspection-admin__reviewers-overlay${isDarkTheme ? ' inspection-admin__reviewers-overlay--dark' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label="Configuracion de inspeccion aleatoria"
        >
          <div
            ref={assignmentsModalRef}
            className="create-user__modal"
            style={{
              top: assignmentsModalPosition.y,
              left: assignmentsModalPosition.x,
              width: assignmentsModalSize.width,
              height: assignmentsModalSize.height,
            }}
          >
            <header className="create-user__header" onMouseDown={handleAssignmentsHeaderMouseDown}>
              <div className="create-user__header-text">
                <h3>Configuracion</h3>
              </div>
              <div className="create-user__header-actions">
                <button
                  type="button"
                  className="create-user__icon-button create-user__icon-button--maximize"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={toggleAssignmentsMaximize}
                  aria-label={assignmentsModalMaximized ? 'Restaurar' : 'Maximizar'}
                >
                  <i className={assignmentsModalMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="create-user__icon-button"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={closeAssignmentsDialog}
                  aria-label="Cerrar"
                >
                  <i className="pi pi-times" aria-hidden="true" />
                </button>
              </div>
            </header>

            <div className="create-user__form" style={{ position: 'relative' }}>
              {(assignmentsLoading || configLoading) && (
                <div className="create-user__loading-overlay" role="status" aria-live="polite">
                  <i className="pi pi-spin pi-spinner" aria-hidden="true" />
                  <span>Cargando...</span>
                </div>
              )}
              <div className="create-user__body create-user__body--permissions inspection-admin__assignments-body">
                <section className="create-user__section create-user__section--permissions inspection-admin__assignments-section">
                  <div className="create-user__section-header">
                    <div>
                      <h4>Parametros generales</h4>
                    </div>
                  </div>

                  <div className="inspection-admin__config-fields">
                    <label className="create-user__field">
                      <span>Productos a revisar por inspeccion</span>
                      <input
                        type="number"
                        min="1"
                        max="200"
                        step="1"
                        value={configData.cantidad_productos}
                        onChange={(e) => setConfigData((prev) => ({ ...prev, cantidad_productos: e.target.value }))}
                        placeholder="Ej: 5"
                        disabled={!isEditingAssignments || configLoading || assignmentsSaving}
                      />
                    </label>
                    <label className="create-user__field">
                      <span>Hora de envio del recordatorio</span>
                      <input
                        type="time"
                        value={configData.hora_recordatorio}
                        onChange={(e) => setConfigData((prev) => ({ ...prev, hora_recordatorio: e.target.value }))}
                        disabled={!isEditingAssignments || configLoading || assignmentsSaving}
                      />
                    </label>
                  </div>

                  <div className="create-user__section-header" style={{ marginTop: '16px' }}>
                    <div>
                      <h4>Revisores por sucursal</h4>
                      <p className="create-user__hint">
                        Escoge por sucursal que usuarios deben hacer la revision diaria. Al asignar una sucursal, tambien se sincroniza Ver inventario.
                      </p>
                    </div>
                  </div>

                  <div className="inspection-admin__reviewers-toolbar">
                    <label className="create-user__field inspection-admin__reviewers-search">
                      <span>Buscar usuario</span>
                      <input
                        type="text"
                        value={assignmentSearch}
                        onChange={(event) => setAssignmentSearch(String(event.target.value || ''))}
                        placeholder="Buscar por nombre o correo"
                      />
                    </label>
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
                                          onChange={() => handleCheckboxChange(rowId, branchId)}
                                          disabled={!isEditingAssignments || assignmentsSaving || assignmentsLoading}
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

                      {assignmentsLoading && (
                        <p className="inspection-admin__loading">
                          <Loader2 size={14} />
                          Cargando usuarios...
                        </p>
                      )}
                    </div>
                  </div>
                </section>
              </div>

              <div className="create-user__footer">
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="create-user__action create-user__action--cancel"
                    onClick={closeAssignmentsDialog}
                  >
                    Cerrar
                  </button>
                  {canUpdate && (
                    <button
                      type="button"
                      className={`create-user__action inspection-admin__edit-toggle${isEditingAssignments ? ' inspection-admin__edit-toggle--active' : ''}`}
                      onClick={handleToggleEdit}
                      disabled={assignmentsLoading || assignmentsSaving}
                    >
                      {(assignmentsLoading || configLoading) ? (
                        <>
                          <span className="inspection-admin__toggle-icon" aria-hidden="true"><Loader2 size={15} className="inspection-admin__dialog-loading-spinner" /></span>
                          <span>Cargando...</span>
                        </>
                      ) : isEditingAssignments ? (
                        <>
                          <span className="inspection-admin__toggle-icon" aria-hidden="true"><Eye size={15} /></span>
                          <span>Solo lectura</span>
                        </>
                      ) : (
                        <>
                          <span className="inspection-admin__toggle-icon" aria-hidden="true"><Pencil size={15} /></span>
                          <span>Editar</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
                {isEditingAssignments && (
                  <button
                    type="button"
                    className="create-user__action create-user__action--primary"
                    onClick={() => void saveAssignments()}
                    disabled={assignmentsLoading || assignmentsSaving}
                  >
                    {assignmentsSaving ? 'Guardando...' : 'Actualizar'}
                  </button>
                )}
              </div>
            </div>

            <button
              type="button"
              aria-label="Cambiar tamaño de ventana"
              className="create-user__resize-handle"
              onMouseDown={handleAssignmentsResizeMouseDown}
            />
          </div>
        </div>,
        getAppPortalRoot()
      )}
    </section>
  )
}

export default RandomInspectionAdminTable
