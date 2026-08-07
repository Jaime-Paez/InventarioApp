import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import '../../admin/CreateUsuario/CreateUsuario.css'
import './CreateSolicitud.css'
import '../../clientes/CreateCliente/CreateCliente.css'
import { API_URL, authFetch } from '../../../../utils/api'
import { getAppPortalRoot } from '../../../../utils/portalRoot'
import { useCloseDropdownsOnTabSwitch } from '../../../../hooks/useCloseDropdownsOnTabSwitch'
import useModalAnimation from '../../common/useModalAnimation'
import {
  createReminderId,
  emitRemindersSync,
  extractUserId,
  formatCurrentUserName,
  normalizeId,
  readRemindersFromStorage,
  sanitizeRecipient,
  writeRemindersToStorage,
} from '../../common/reminders/remindersStorage'

const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const initialCliente = {
  nombres: '',
  apellidos: '',
  cedula_ruc: '',
  correo: '',
  telefono: '',
  direccion: '',
}

const emptyAuto = { vin: '', modelo: '', motor: '', anio: '' }

const initialProductoDraft = {
  productoId: '',
  referencia: '',
  codigo: '',
  nombre: '',
  oems: '',
  casaComercialId: '',
  casaComercialNombre: '',
  comentario: '',
  cantidad: '1',
}
const requiredClienteManualFields = ['cedula_ruc', 'nombres', 'apellidos']

const todayISO = () => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
const getNowDateParts = () => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  }
}
const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeString = (value) => String(value ?? '').trim().toLowerCase()
const hasUsersModuleAccess = (permissions) =>
  (Array.isArray(permissions) ? permissions : []).some((permission) => {
    if (normalizeString(permission?.modulo) !== 'usuarios') return false
    return Boolean(
      permission?.puede_crear ||
        permission?.puede_actualizar ||
        permission?.puede_eliminar
    )
  })

const parseApiErrorValue = (value) => {
  if (!value) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = parseApiErrorValue(entry)
      if (parsed) return parsed
    }
    return ''
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value)) {
      const parsed = parseApiErrorValue(entry)
      if (parsed) return parsed
    }
  }
  return ''
}

const resolveApiErrorMessage = (payload, fallback) => {
  const detail = parseApiErrorValue(payload?.detail)
  if (detail) return detail
  const fallbackFromBody = parseApiErrorValue(payload)
  if (fallbackFromBody) return fallbackFromBody
  return fallback
}

const parseOemInput = (rawValue) => {
  const source = String(rawValue || '').replace(/;/g, ',').replace(/\n/g, ',')
  const parts = source.split(',')
  const seen = new Set()
  const list = []
  for (const part of parts) {
    const value = String(part || '').trim()
    if (!value) continue
    const key = normalizeString(value)
    if (seen.has(key)) continue
    seen.add(key)
    list.push(value)
  }
  return list
}


const extractProductoOems = (producto) => {
  const relaciones = Array.isArray(producto?.oem_productos) ? producto.oem_productos : []
  const seen = new Set()
  const result = []
  for (const relacion of relaciones) {
    const code = String(relacion?.oem?.codigo || relacion?.codigo || '').trim()
    if (!code) continue
    const key = normalizeString(code)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(code)
  }
  return result
}

const formatStockByBranch = (rows) => {
  const list = Array.isArray(rows) ? rows : []
  const parts = []
  for (const row of list) {
    const nombre = String(row?.sucursal_nombre || 'Sucursal').trim() || 'Sucursal'
    const cantidad = Number(row?.cantidad)
    if (!Number.isFinite(cantidad) || cantidad <= 0) continue
    parts.push(`${nombre}: ${Math.trunc(cantidad)}`)
  }
  return parts.join(', ')
}

const CLIENT_MODE_EXISTING = 'existing'
const CLIENT_MODE_NEW = 'new'

const resolveClienteNombre = (cliente) =>
  String(cliente?.nombre_completo || `${cliente?.nombres || ''} ${cliente?.apellidos || ''}`).trim()

const formatClienteLabel = (cliente) => {
  if (!cliente) return ''
  const cedula = String(cliente?.cedula_ruc || '').trim()
  const nombre = resolveClienteNombre(cliente)
  if (cedula && nombre) return `${cedula}: ${nombre}`
  if (cedula) return cedula
  if (nombre) return nombre
  return ''
}

const normalizeClientePayload = (c) => ({
  nombres: String(c?.nombres || '').trim(),
  apellidos: String(c?.apellidos || '').trim(),
  cedula_ruc: String(c?.cedula_ruc || '').trim(),
  correo: String(c?.correo || '').trim(),
  telefono: String(c?.telefono || '').trim(),
  direccion: String(c?.direccion || '').trim(),
})

function InlinePanel({ anchorRef, panelRef, open, className, children }) {
  const [style, setStyle] = useState({})

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (!rect) return
      setStyle({ position: 'fixed', top: rect.bottom + 4, left: rect.left, zIndex: 9999 })
    }
    update()
    const scrollBody = document.querySelector('.create-user__body')
    scrollBody?.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update, { passive: true })
    return () => {
      scrollBody?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [open, anchorRef])

  if (!open) return null
  return createPortal(
    <div className={className} style={style} ref={panelRef}>{children}</div>,
    getAppPortalRoot()
  )
}

function CreateSolicitud({
  open,
  onClose,
  onCreated,
  token,
  onError,
  currentUser,
  prefilledSucursalId = '',
}) {
  const [clienteMode, setClienteMode] = useState(CLIENT_MODE_EXISTING)
  const [cliente, setCliente] = useState(initialCliente)
  const [autos, setAutos] = useState([])
  const [autoDraft, setAutoDraft] = useState({ ...emptyAuto })
  const [selectedCliente, setSelectedCliente] = useState(null)
  const [clienteResultados, setClienteResultados] = useState([])
  const [clienteLoading, setClienteLoading] = useState(false)
  const [showClienteDropdown, setShowClienteDropdown] = useState(false)
  const [clienteSearchTerm, setClienteSearchTerm] = useState('')

  const [sucursalId, setSucursalId] = useState('')
  const [fecha, setFecha] = useState(todayISO())
  const [marca, setMarca] = useState('')
  const [modelo, setModelo] = useState('')
  const [motor, setMotor] = useState('')
  const [anio, setAnio] = useState('')
  const [descripcionGeneral, setDescripcionGeneral] = useState('')
  const [sucursales, setSucursales] = useState([])
  const [sucursalesLoading, setSucursalesLoading] = useState(false)

  const [productoDraft, setProductoDraft] = useState(initialProductoDraft)
  const [selectedDraftProducto, setSelectedDraftProducto] = useState(null)
  const [productos, setProductos] = useState([])
  const [showReferenciaDropdown, setShowReferenciaDropdown] = useState(false)
  const [referenciaOptions, setReferenciaOptions] = useState([])
  const [referenciaLoading, setReferenciaLoading] = useState(false)
  const [showCodigoDropdown, setShowCodigoDropdown] = useState(false)
  const [codigoOptions, setCodigoOptions] = useState([])
  const [codigoLoading, setCodigoLoading] = useState(false)
  const [showOemDropdown, setShowOemDropdown] = useState(false)
  const [oemOptions, setOemOptions] = useState([])
  const [oemLoading, setOemLoading] = useState(false)
  const [showCasaComercialDropdown, setShowCasaComercialDropdown] = useState(false)
  const [casaComercialSearchTerm, setCasaComercialSearchTerm] = useState('')
  const [casaComercialOptions, setCasaComercialOptions] = useState([])
  const [casaComercialLoading, setCasaComercialLoading] = useState(false)

  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [productoAttempted, setProductoAttempted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [addingProducto, setAddingProducto] = useState(false)
  const [activeTab, setActiveTab] = useState('productos')
  const [reminderUsers, setReminderUsers] = useState([])
  const [reminderUsersLoading, setReminderUsersLoading] = useState(false)
  const [reminderUsersError, setReminderUsersError] = useState('')
  const [selectedClienteAutos, setSelectedClienteAutos] = useState([])
  const [autoConfirmData, setAutoConfirmData] = useState(null)
  const [stockWarningData, setStockWarningData] = useState(null)
  const [savingAuto, setSavingAuto] = useState(false)
  const [pendingAutoDraft, setPendingAutoDraft] = useState({ placa: '', modelo: '', anio: '', marca: '' })
  const [fetchingClienteAutos, setFetchingClienteAutos] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const clienteDropdownRef = useRef(null)
  const referenciaDropdownRef = useRef(null)
  const codigoDropdownRef = useRef(null)
  const oemDropdownRef = useRef(null)
  const oemPanelRef = useRef(null)
  const codigoPanelRef = useRef(null)
  const casaComercialDropdownRef = useRef(null)
  const clienteSearchTimerRef = useRef(null)
  const referenciaSearchTimerRef = useRef(null)
  const referenciaSearchSeqRef = useRef(0)
  const codigoSearchTimerRef = useRef(null)
  const codigoSearchSeqRef = useRef(0)
  const oemSearchTimerRef = useRef(null)
  const oemSearchSeqRef = useRef(0)
  const casaComercialSearchTimerRef = useRef(null)
  const casaComercialSearchSeqRef = useRef(0)
  const addingProductoRef = useRef(false)
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const sizeRef = useRef(size)
  const positionRef = useRef(position)
  const restoreRef = useRef(null)

  const currentCreatorId = useMemo(() => normalizeId(extractUserId(currentUser)), [currentUser])
  const currentCreatorName = useMemo(() => formatCurrentUserName(currentUser), [currentUser])
  const currentCreatorEmail = String(currentUser?.correo || currentUser?.email || '').trim()
  const isCurrentUserAdmin = useMemo(
    () => hasUsersModuleAccess(currentUser?.permisos),
    [currentUser]
  )
  const normalizedPrefilledSucursalId = String(prefilledSucursalId || '').trim()
  const isSucursalLocked = Boolean(normalizedPrefilledSucursalId)

  const notifyError = useCallback(
    (message) => {
      if (!message) return
      if (onError) {
        onError(message)
      }
    },
    [onError]
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

  const clearAll = useCallback(() => {
    setClienteMode(CLIENT_MODE_EXISTING)
    setCliente(initialCliente)
    setAutos([])
    setAutoDraft({ ...emptyAuto })
    setSelectedCliente(null)
    setClienteResultados([])
    setClienteLoading(false)
    setShowClienteDropdown(false)
    setClienteSearchTerm('')

    setSucursalId(normalizedPrefilledSucursalId)
    setFecha(todayISO())
    setMarca('')
    setModelo('')
    setMotor('')
    setAnio('')
    setDescripcionGeneral('')
    setActiveTab('productos')

    setProductoDraft(initialProductoDraft)
    setSelectedDraftProducto(null)
    setProductos([])
    setShowReferenciaDropdown(false)
    setReferenciaOptions([])
    setReferenciaLoading(false)
    setShowCodigoDropdown(false)
    setCodigoOptions([])
    setCodigoLoading(false)
    setShowOemDropdown(false)
    setOemOptions([])
    setOemLoading(false)
    setShowCasaComercialDropdown(false)
    setCasaComercialSearchTerm('')
    setCasaComercialOptions([])
    setCasaComercialLoading(false)

    setSubmitAttempted(false)
    setProductoAttempted(false)
    setLoading(false)
    setAddingProducto(false)
    addingProductoRef.current = false
    setReminderUsers([])
    setReminderUsersLoading(false)
    setReminderUsersError('')
    setSelectedClienteAutos([])
    setAutoConfirmData(null)
    setSavingAuto(false)
    setPendingAutoDraft({ placa: '', modelo: '', anio: '', marca: '' })
    setFetchingClienteAutos(false)
    setIsMaximized(false)
    restoreRef.current = null

    if (clienteSearchTimerRef.current) {
      clearTimeout(clienteSearchTimerRef.current)
      clienteSearchTimerRef.current = null
    }
    if (referenciaSearchTimerRef.current) {
      clearTimeout(referenciaSearchTimerRef.current)
      referenciaSearchTimerRef.current = null
    }
    if (codigoSearchTimerRef.current) {
      clearTimeout(codigoSearchTimerRef.current)
      codigoSearchTimerRef.current = null
    }
    if (oemSearchTimerRef.current) {
      clearTimeout(oemSearchTimerRef.current)
      oemSearchTimerRef.current = null
    }
    if (casaComercialSearchTimerRef.current) {
      clearTimeout(casaComercialSearchTimerRef.current)
      casaComercialSearchTimerRef.current = null
    }
  }, [normalizedPrefilledSucursalId])

  const fetchSucursales = useCallback(async () => {
    if (!token) return
    setSucursalesLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/inventario/sucursales/?modulo=solicitudes&page_size=200`,
        {},
        token
      )
      if (!response.ok) throw new Error('No se pudieron cargar las sucursales.')
      const data = await response.json()
      setSucursales(parseApiList(data))
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al cargar las sucursales.')
    } finally {
      setSucursalesLoading(false)
    }
  }, [notifyError, token])

  const fetchReminderUsers = useCallback(async () => {
    if (!token) {
      setReminderUsers([])
      setReminderUsersLoading(false)
      setReminderUsersError('')
      return
    }

    setReminderUsersLoading(true)
    setReminderUsersError('')

    const ensureCurrentCreator = (list) => {
      if (!currentCreatorId) return list
      if (list.some((userItem) => userItem.id === currentCreatorId)) return list

      return [
        {
          id: currentCreatorId,
          name: currentCreatorName || 'Usuario',
          email: currentCreatorEmail,
          isAdmin: isCurrentUserAdmin,
        },
        ...list,
      ]
    }

    try {
      const list = []
      let url = `${API_URL}/usuarios/listado/destinatarios/?page_size=200`

      while (url) {
        const response = await authFetch(url, {}, token)
        if (!response.ok) throw new Error('No se pudo cargar la lista de usuarios para recordatorios.')

        const data = await response.json()
        if (Array.isArray(data)) {
          list.push(...data)
          url = null
        } else {
          const pageResults = Array.isArray(data?.results) ? data.results : []
          list.push(...pageResults)
          url = data?.next || null
        }
      }

      const normalized = []
      const seenIds = new Set()

      list.forEach((item) => {
        const id = normalizeId(extractUserId(item))
        if (!id || seenIds.has(id)) return
        seenIds.add(id)
        normalized.push({
          id,
          name: formatCurrentUserName(item),
          email: String(item?.correo || item?.email || '').trim(),
          isAdmin: hasUsersModuleAccess(item?.permisos_resumen),
        })
      })

      const withCurrentCreator = ensureCurrentCreator(normalized).sort((a, b) =>
        String(a?.name || '').localeCompare(String(b?.name || ''), 'es', { sensitivity: 'base' })
      )

      setReminderUsers(withCurrentCreator)
    } catch (err) {
      setReminderUsersError(err?.message || 'No se pudieron cargar los usuarios para recordatorios.')
      setReminderUsers(ensureCurrentCreator([]))
    } finally {
      setReminderUsersLoading(false)
    }
  }, [currentCreatorEmail, currentCreatorId, currentCreatorName, isCurrentUserAdmin, token])

  const fetchClienteAutos = useCallback(async (clienteId) => {
    if (!token || !clienteId) return
    setFetchingClienteAutos(true)
    try {
      const response = await authFetch(`${API_URL}/solicitudes/clientes/${clienteId}/`, {}, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return
      setSelectedClienteAutos(Array.isArray(data?.autos) ? data.autos : [])
    } catch {
      setSelectedClienteAutos([])
    } finally {
      setFetchingClienteAutos(false)
    }
  }, [token])

  useEffect(() => {
    if (!open) return
    clearAll()
    fetchSucursales()
    fetchReminderUsers()
  }, [open, clearAll, fetchReminderUsers, fetchSucursales])

  useEffect(() => {
    if (!open) return
    if (!normalizedPrefilledSucursalId) return
    setSucursalId((prev) => (String(prev || '').trim() ? prev : normalizedPrefilledSucursalId))
  }, [normalizedPrefilledSucursalId, open])

  useEffect(() => {
    if (!reminderUsersError) return
    notifyError(reminderUsersError)
  }, [notifyError, reminderUsersError])

  useEffect(
    () => () => {
      if (clienteSearchTimerRef.current) clearTimeout(clienteSearchTimerRef.current)
      if (referenciaSearchTimerRef.current) clearTimeout(referenciaSearchTimerRef.current)
      if (codigoSearchTimerRef.current) clearTimeout(codigoSearchTimerRef.current)
      if (oemSearchTimerRef.current) clearTimeout(oemSearchTimerRef.current)
      if (casaComercialSearchTimerRef.current) clearTimeout(casaComercialSearchTimerRef.current)
    },
    []
  )

  useEffect(() => {
    if (!open || !showClienteDropdown) return
    const searchTerm = String(clienteSearchTerm || '').trim()
    if (!searchTerm || searchTerm.length < 2 || !token) {
      setClienteResultados([])
      setClienteLoading(false)
      return
    }

    if (clienteSearchTimerRef.current) clearTimeout(clienteSearchTimerRef.current)

    setClienteLoading(true)
    clienteSearchTimerRef.current = setTimeout(async () => {
      try {
        const response = await authFetch(
          `${API_URL}/solicitudes/solicitudes/buscar-cliente/?q=${encodeURIComponent(searchTerm)}&page_size=10`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudo buscar el cliente.')
        const data = await response.json()
        setClienteResultados(parseApiList(data))
      } catch {
        setClienteResultados([])
      } finally {
        setClienteLoading(false)
      }
    }, 320)

    return () => {
      if (clienteSearchTimerRef.current) {
        clearTimeout(clienteSearchTimerRef.current)
        clienteSearchTimerRef.current = null
      }
    }
  }, [open, showClienteDropdown, token, clienteSearchTerm])

  const oemSearchTerm = useMemo(() => {
    const raw = String(productoDraft.oems || '').replace(/;/g, ',')
    const parts = raw.split(',')
    return String(parts[parts.length - 1] || '').trim()
  }, [productoDraft.oems])

  useEffect(() => {
    if (!open || !showReferenciaDropdown) return
    const term = String(productoDraft.referencia || '').trim()
    if (!term || term.length < 2 || !token) {
      setReferenciaOptions([])
      setReferenciaLoading(false)
      return
    }

    if (referenciaSearchTimerRef.current) clearTimeout(referenciaSearchTimerRef.current)

    setReferenciaLoading(true)
    referenciaSearchTimerRef.current = setTimeout(async () => {
      const requestId = referenciaSearchSeqRef.current + 1
      referenciaSearchSeqRef.current = requestId

      try {
        const response = await authFetch(
          `${API_URL}/productos/listado/?referencia=${encodeURIComponent(term)}&page_size=5`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar productos.')
        const data = await response.json()
        if (requestId !== referenciaSearchSeqRef.current) return
        const referenciaList = parseApiList(data)
        referenciaList.sort((a, b) => (Number(b?.total_stock ?? 0) > 0 ? 1 : 0) - (Number(a?.total_stock ?? 0) > 0 ? 1 : 0))
        setReferenciaOptions(referenciaList)
      } catch {
        if (requestId !== referenciaSearchSeqRef.current) return
        setReferenciaOptions([])
      } finally {
        if (requestId === referenciaSearchSeqRef.current) {
          setReferenciaLoading(false)
        }
      }
    }, 550)

    return () => {
      if (referenciaSearchTimerRef.current) {
        clearTimeout(referenciaSearchTimerRef.current)
        referenciaSearchTimerRef.current = null
      }
    }
  }, [open, showReferenciaDropdown, token, productoDraft.referencia])

  useEffect(() => {
    if (!open || !showCodigoDropdown) return
    const term = String(productoDraft.codigo || '').trim()
    if (!term || term.length < 2 || !token) {
      setCodigoOptions([])
      setCodigoLoading(false)
      return
    }

    if (codigoSearchTimerRef.current) clearTimeout(codigoSearchTimerRef.current)

    setCodigoLoading(true)
    codigoSearchTimerRef.current = setTimeout(async () => {
      const requestId = codigoSearchSeqRef.current + 1
      codigoSearchSeqRef.current = requestId

      try {
        const response = await authFetch(
          `${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=25`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar productos.')
        const data = await response.json()
        if (requestId !== codigoSearchSeqRef.current) return
        const codigoList = parseApiList(data)
        codigoList.sort((a, b) => (Number(b?.total_stock ?? 0) > 0 ? 1 : 0) - (Number(a?.total_stock ?? 0) > 0 ? 1 : 0))
        setCodigoOptions(codigoList)
      } catch {
        if (requestId !== codigoSearchSeqRef.current) return
        setCodigoOptions([])
      } finally {
        if (requestId === codigoSearchSeqRef.current) {
          setCodigoLoading(false)
        }
      }
    }, 550)

    return () => {
      if (codigoSearchTimerRef.current) {
        clearTimeout(codigoSearchTimerRef.current)
        codigoSearchTimerRef.current = null
      }
    }
  }, [open, showCodigoDropdown, token, productoDraft.codigo])

  useEffect(() => {
    if (!open || !showOemDropdown) return
    if (!oemSearchTerm || oemSearchTerm.length < 2 || !token) {
      setOemOptions([])
      setOemLoading(false)
      return
    }

    if (oemSearchTimerRef.current) clearTimeout(oemSearchTimerRef.current)

    setOemLoading(true)
    oemSearchTimerRef.current = setTimeout(async () => {
      const requestId = oemSearchSeqRef.current + 1
      oemSearchSeqRef.current = requestId

      try {
        const response = await authFetch(
          `${API_URL}/productos/listado/?oem=${encodeURIComponent(oemSearchTerm)}&page_size=5`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar productos por OEM.')
        const data = await response.json()
        if (requestId !== oemSearchSeqRef.current) return
        const oemList = parseApiList(data)
        oemList.sort((a, b) => (Number(b?.total_stock ?? 0) > 0 ? 1 : 0) - (Number(a?.total_stock ?? 0) > 0 ? 1 : 0))
        setOemOptions(oemList)
      } catch {
        if (requestId !== oemSearchSeqRef.current) return
        setOemOptions([])
      } finally {
        if (requestId === oemSearchSeqRef.current) {
          setOemLoading(false)
        }
      }
    }, 550)

    return () => {
      if (oemSearchTimerRef.current) {
        clearTimeout(oemSearchTimerRef.current)
        oemSearchTimerRef.current = null
      }
    }
  }, [open, showOemDropdown, token, oemSearchTerm])

  useEffect(() => {
    if (!open || !showCasaComercialDropdown) return
    const term = String(casaComercialSearchTerm || '').trim()
    if (!term || term.length < 2 || !token) {
      setCasaComercialOptions([])
      setCasaComercialLoading(false)
      return
    }

    if (casaComercialSearchTimerRef.current) clearTimeout(casaComercialSearchTimerRef.current)

    setCasaComercialLoading(true)
    casaComercialSearchTimerRef.current = setTimeout(async () => {
      const requestId = casaComercialSearchSeqRef.current + 1
      casaComercialSearchSeqRef.current = requestId

      try {
        const response = await authFetch(
          `${API_URL}/casa-comercial/casas/?search=${encodeURIComponent(term)}&page_size=5`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las casas comerciales.')
        const data = await response.json()
        if (requestId !== casaComercialSearchSeqRef.current) return
        setCasaComercialOptions(parseApiList(data))
      } catch {
        if (requestId !== casaComercialSearchSeqRef.current) return
        setCasaComercialOptions([])
      } finally {
        if (requestId === casaComercialSearchSeqRef.current) {
          setCasaComercialLoading(false)
        }
      }
    }, 320)

    return () => {
      if (casaComercialSearchTimerRef.current) {
        clearTimeout(casaComercialSearchTimerRef.current)
        casaComercialSearchTimerRef.current = null
      }
    }
  }, [casaComercialSearchTerm, open, showCasaComercialDropdown, token])

  useLayoutEffect(() => {
    if (!open) return
    const { availableWidth, availableHeight } = getViewportMetrics()
    const nextWidth = Math.min(MIN_WIDTH, availableWidth)
    const nextHeight = Math.min(MIN_HEIGHT, availableHeight)
    setSize({ width: nextWidth, height: nextHeight })
    setPosition({
      x: Math.max((window.innerWidth - nextWidth) / 2, VIEWPORT_PADDING),
      y: Math.max((window.innerHeight - nextHeight) / 2, VIEWPORT_PADDING),
    })
  }, [open, getViewportMetrics])

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    positionRef.current = position
  }, [position])

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (showClienteDropdown) {
        if (!clienteDropdownRef.current || !clienteDropdownRef.current.contains(event.target)) {
          setShowClienteDropdown(false)
        }
      }
      if (showReferenciaDropdown) {
        if (!referenciaDropdownRef.current || !referenciaDropdownRef.current.contains(event.target)) {
          setShowReferenciaDropdown(false)
        }
      }
      if (showCodigoDropdown) {
        if (!codigoDropdownRef.current?.contains(event.target) && !codigoPanelRef.current?.contains(event.target)) {
          setShowCodigoDropdown(false)
        }
      }
      if (showCasaComercialDropdown) {
        if (!casaComercialDropdownRef.current || !casaComercialDropdownRef.current.contains(event.target)) {
          setShowCasaComercialDropdown(false)
        }
      }
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [showCasaComercialDropdown, showClienteDropdown, showCodigoDropdown, showOemDropdown, showReferenciaDropdown])

  useCloseDropdownsOnTabSwitch(
    useCallback(() => {
      setShowClienteDropdown(false)
      setShowReferenciaDropdown(false)
      setShowCodigoDropdown(false)
      setShowOemDropdown(false)
      setShowCasaComercialDropdown(false)
    }, [])
  )

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!dragData.current.active) return
      event.preventDefault()
      const newX = event.clientX - dragData.current.offsetX
      const newY = event.clientY - dragData.current.offsetY
      const maxX = window.innerWidth - sizeRef.current.width - VIEWPORT_PADDING
      const maxY = window.innerHeight - sizeRef.current.height - VIEWPORT_PADDING
      setPosition({
        x: Math.min(Math.max(newX, VIEWPORT_PADDING), Math.max(maxX, VIEWPORT_PADDING)),
        y: Math.min(Math.max(newY, VIEWPORT_PADDING), Math.max(maxY, VIEWPORT_PADDING)),
      })
    }

    const handleMouseUp = () => {
      dragData.current.active = false
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
      const { minWidth, minHeight, availableWidth, availableHeight } = getViewportMetrics()

      if (isMaximized) {
        setSize({ width: availableWidth, height: availableHeight })
        setPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }

      setSize((prev) => {
        const width = clamp(prev.width, minWidth, availableWidth)
        const height = clamp(prev.height, minHeight, availableHeight)
        setPosition((prevPosition) => ({
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
  }, [getViewportMetrics, isMaximized])

  const handleMouseDown = (event) => {
    if (isMaximized) {
      const restore = restoreRef.current
      const fallbackSize = sizeRef.current
      const restoredSize = restore?.size || fallbackSize
      const restoredPosition = restore?.position || {
        x: Math.max((window.innerWidth - restoredSize.width) / 2, VIEWPORT_PADDING),
        y: Math.max((window.innerHeight - restoredSize.height) / 2, VIEWPORT_PADDING),
      }

      sizeRef.current = restoredSize
      positionRef.current = restoredPosition
      setSize(restoredSize)
      setPosition(restoredPosition)
      setIsMaximized(false)

      const offsetX = Math.min(
        Math.max(event.clientX - restoredPosition.x, 24),
        Math.max(restoredSize.width - 24, 24)
      )
      const offsetY = Math.min(
        Math.max(event.clientY - restoredPosition.y, 12),
        56
      )
      dragData.current = {
        active: true,
        offsetX,
        offsetY,
      }
      return
    }

    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    dragData.current = {
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
    resizeData.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: sizeRef.current.width,
      startHeight: sizeRef.current.height,
    }

    const handleResizeMove = (moveEvent) => {
      if (!resizeData.current.active) return
      const deltaX = moveEvent.clientX - resizeData.current.startX
      const deltaY = moveEvent.clientY - resizeData.current.startY
      const maxWidth = Math.max(minWidth, window.innerWidth - positionRef.current.x - VIEWPORT_PADDING)
      const maxHeight = Math.max(minHeight, window.innerHeight - positionRef.current.y - VIEWPORT_PADDING)
      const width = clamp(resizeData.current.startWidth + deltaX, minWidth, maxWidth)
      const height = clamp(resizeData.current.startHeight + deltaY, minHeight, maxHeight)
      setSize({ width, height })
    }

    const handleResizeUp = () => {
      resizeData.current.active = false
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }

    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }

  const toggleMaximize = () => {
    if (isMaximized) {
      const restore = restoreRef.current
      if (restore) {
        setSize(restore.size)
        setPosition(restore.position)
      }
      setIsMaximized(false)
      return
    }

    restoreRef.current = {
      size: sizeRef.current,
      position: positionRef.current,
    }
    const { availableWidth, availableHeight } = getViewportMetrics()
    setSize({ width: availableWidth, height: availableHeight })
    setPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  const handleUseExistingCliente = () => {
    setClienteMode(CLIENT_MODE_EXISTING)
  }

  const handleCreateNewCliente = () => {
    setClienteMode(CLIENT_MODE_NEW)
    setSelectedCliente(null)
    setClienteSearchTerm('')
    setClienteResultados([])
    setClienteLoading(false)
    setShowClienteDropdown(false)
    setCliente(initialCliente)
    setAutos([])
    setAutoDraft({ ...emptyAuto })
    setSelectedClienteAutos([])
    setAutoConfirmData(null)
    setStockWarningData(null)
    setSavingAuto(false)
    setPendingAutoDraft({ placa: '', modelo: '', anio: '', marca: '' })
  }

  const handleAddAuto = () => {
    const { vin, modelo, motor, anio } = autoDraft
    if (!vin.trim() && !modelo.trim() && !motor.trim() && !anio.trim()) return
    setAutos((prev) => [...prev, { vin: vin.trim(), modelo: modelo.trim(), motor: motor.trim(), anio: anio.trim() }])
    setAutoDraft({ ...emptyAuto })
  }

  const handleRemoveAuto = (index) => {
    setAutos((prev) => prev.filter((_, i) => i !== index))
  }

  const handleClienteDropdownToggle = () => {
    if (loading) return
    setShowClienteDropdown((prev) => {
      const next = !prev
      if (next) {
        setClienteSearchTerm('')
        setClienteResultados([])
        setClienteLoading(false)
      }
      return next
    })
  }

  const handleClienteFieldChange = (event) => {
    const { name, value } = event.target
    setCliente((prev) => ({ ...prev, [name]: value }))
    if (selectedCliente) setSelectedCliente(null)
  }

  const handleClienteSearchChange = (event) => {
    const value = event.target.value
    setClienteSearchTerm(value)
    if (!value.trim()) {
      setClienteResultados([])
      setClienteLoading(false)
    }
  }

  const handleClienteSelect = (item) => {
    if (!item) return
    setClienteMode(CLIENT_MODE_EXISTING)
    setSelectedCliente(item)
    setCliente(normalizeClientePayload(item))
    setClienteSearchTerm('')
    setClienteResultados([])
    setClienteLoading(false)
    setShowClienteDropdown(false)
    setSelectedClienteAutos([])
    setAutoConfirmData(null)
    setPendingAutoDraft({ placa: '', modelo: '', anio: '', marca: '' })
    if (item.id) fetchClienteAutos(item.id)
  }

  const handleAutoAgregarClick = () => {
    const { placa, modelo, anio, marca } = pendingAutoDraft
    if (!placa.trim() && !modelo.trim()) return
    setAutoConfirmData({ placa: placa.trim(), modelo: modelo.trim(), anio: anio.trim(), marca: marca.trim() })
  }

  const handleConfirmAddAuto = async () => {
    if (!autoConfirmData || !selectedCliente?.id) return
    setSavingAuto(true)
    try {
      const allAutos = [
        ...selectedClienteAutos.map((a) => ({
          placa: String(a.placa || '').trim(),
          modelo: String(a.modelo || '').trim(),
          anio: a.anio ? Number(a.anio) : null,
          marca: String(a.marca || '').trim(),
          color: String(a.color || '').trim(),
        })),
        {
          placa: autoConfirmData.placa,
          modelo: autoConfirmData.modelo,
          anio: autoConfirmData.anio ? Number(autoConfirmData.anio) : null,
          marca: autoConfirmData.marca,
          color: '',
        },
      ]
      const res = await authFetch(
        `${API_URL}/solicitudes/clientes/${selectedCliente.id}/`,
        { method: 'PATCH', body: JSON.stringify({ autos: allAutos }) },
        token
      )
      const resData = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(resolveApiErrorMessage(resData, 'No se pudo agregar el vehículo.'))
      }
      setSelectedClienteAutos(Array.isArray(resData?.autos) ? resData.autos : allAutos)
      setAutoConfirmData(null)
      setPendingAutoDraft({ placa: '', modelo: '', anio: '', marca: '' })
    } catch (err) {
      notifyError(err?.message || 'No se pudo agregar el vehículo.')
    } finally {
      setSavingAuto(false)
    }
  }

  const handleConfirmStockWarning = () => {
    if (!stockWarningData) return
    const { item } = stockWarningData
    setProductos((prev) => [...prev, item])
    setProductoDraft(initialProductoDraft)
    setSelectedDraftProducto(null)
    setProductoAttempted(false)
    setShowReferenciaDropdown(false)
    setShowCodigoDropdown(false)
    setShowOemDropdown(false)
    setShowCasaComercialDropdown(false)
    setReferenciaOptions([])
    setCodigoOptions([])
    setOemOptions([])
    setCasaComercialOptions([])
    setStockWarningData(null)
  }

  const handleCedulaBlur = async () => {
    const cedula = String(cliente.cedula_ruc || '').trim()
    if (cedula.length < 5 || loading) return
    try {
      const response = await authFetch(
        `${API_URL}/solicitudes/solicitudes/buscar-cliente/?q=${encodeURIComponent(cedula)}&page_size=10`,
        {},
        token
      )
      if (!response.ok) return
      const data = await response.json()
      const results = parseApiList(data)
      const exactMatch = results.find(
        (c) => normalizeString(c.cedula_ruc) === normalizeString(cedula)
      )
      if (exactMatch) {
        handleClienteSelect(exactMatch)
        notifyError('Ya existe un cliente con esa cédula/RUC. Se seleccionó automáticamente.')
      }
    } catch {
      // ignore silently
    }
  }

  const handleProductoDraftChange = (event) => {
    const { name, value } = event.target
    const normalizedValue = name === 'codigo' ? String(value || '').toUpperCase() : value
    const shouldDetachSelectedProduct =
      selectedDraftProducto && ['referencia', 'codigo', 'nombre', 'oems'].includes(name)

    if (name === 'referencia') {
      const shouldShow = String(normalizedValue || '').trim().length >= 1
      setShowReferenciaDropdown(shouldShow)
      if (!shouldShow) setReferenciaOptions([])
    }

    if (name === 'codigo') {
      const shouldShow = String(normalizedValue || '').trim().length >= 1
      setShowCodigoDropdown(shouldShow)
      if (!shouldShow) setCodigoOptions([])
    }

    if (name === 'oems') {
      setShowOemDropdown(false)
      setOemOptions([])
    }

    if (shouldDetachSelectedProduct) {
      setSelectedDraftProducto(null)
    }

    setProductoDraft((prev) => ({
      ...prev,
      productoId: shouldDetachSelectedProduct ? '' : prev.productoId,
      referencia: shouldDetachSelectedProduct && name !== 'referencia' ? '' : prev.referencia,
      codigo: shouldDetachSelectedProduct && name !== 'codigo' ? '' : prev.codigo,
      nombre: shouldDetachSelectedProduct && name !== 'nombre' ? '' : prev.nombre,
      oems: shouldDetachSelectedProduct && name !== 'oems' ? '' : prev.oems,
      casaComercialId: shouldDetachSelectedProduct ? '' : prev.casaComercialId,
      casaComercialNombre: shouldDetachSelectedProduct ? '' : prev.casaComercialNombre,
      [name]: normalizedValue,
    }))
  }

  const handleProductoSelect = useCallback((producto) => {
    if (!producto) return

    const referencia = String(producto?.referencia || '').trim()
    const codigo = String(producto?.codigo || '').trim().toUpperCase()
    const nombre = String(producto?.nombre || '').trim()
    const oems = extractProductoOems(producto)
    const casas = Array.isArray(producto?.casas_comerciales) ? producto.casas_comerciales : []
    const firstCasa = casas[0] || null

    setSelectedDraftProducto(producto)
    setProductoDraft((prev) => ({
      ...prev,
      productoId: String(producto.id),
      referencia,
      codigo,
      nombre,
      oems: prev.oems ? prev.oems : oems.join(', '),
      casaComercialId: firstCasa ? String(firstCasa.id) : '',
      casaComercialNombre: firstCasa ? String(firstCasa.nombre || '').trim() : '',
      cantidad: prev.cantidad || '1',
    }))
    setShowReferenciaDropdown(false)
    setShowCodigoDropdown(false)
    setShowOemDropdown(false)
    setShowCasaComercialDropdown(false)
    setCasaComercialSearchTerm('')
    setReferenciaOptions([])
    setCodigoOptions([])
    setOemOptions([])
    setCasaComercialOptions([])
  }, [])

  const handleCasaComercialSelect = useCallback((casaOption) => {
    if (!casaOption?.id) return
    const nextId = String(casaOption.id)
    const nextNombre = String(casaOption.nombre || '').trim()

    setProductoDraft((prev) => ({
      ...prev,
      casaComercialId: nextId,
      casaComercialNombre: nextNombre,
    }))
    setShowCasaComercialDropdown(false)
    setCasaComercialSearchTerm('')
    setCasaComercialOptions([])
    setCasaComercialLoading(false)
  }, [])

  const handleCasaComercialSearchChange = (event) => {
    const value = event.target.value
    setCasaComercialSearchTerm(value)
    if (!showCasaComercialDropdown) {
      setShowCasaComercialDropdown(true)
    }
    if (!String(value || '').trim()) {
      setCasaComercialOptions([])
      setCasaComercialLoading(false)
    }
  }

  const handleCasaComercialDropdownToggle = () => {
    if (showCasaComercialDropdown) {
      setShowCasaComercialDropdown(false)
      return
    }
    setCasaComercialSearchTerm('')
    setCasaComercialOptions([])
    setCasaComercialLoading(false)
    setShowCasaComercialDropdown(true)
  }

  const draftOemList = useMemo(() => parseOemInput(productoDraft.oems), [productoDraft.oems])

  const buildCurrentIdentitySets = useCallback(() => {
    const productoIds = new Set()
    const codes = new Set()
    const oems = new Set()

    for (const item of productos) {
      const itemProductId = Number(item?.productoId)
      if (Number.isFinite(itemProductId) && itemProductId > 0) {
        productoIds.add(itemProductId)
      }

      const codeKey = normalizeString(item?.codigo)
      if (codeKey) codes.add(codeKey)

      const itemOems = Array.isArray(item?.oems) ? item.oems : []
      for (const oem of itemOems) {
        const oemKey = normalizeString(oem)
        if (!oemKey) continue
        oems.add(oemKey)
      }
    }

    return { productoIds, codes, oems }
  }, [productos])

  const resolveSingleExistingProduct = useCallback(async ({ codigoInput = '', oemInput = '' } = {}) => {
    if (!token) return null

    const codigo = String(codigoInput || '').trim()
    if (codigo) {
      const response = await authFetch(
        `${API_URL}/productos/listado/?codigo=${encodeURIComponent(codigo)}&page_size=3`,
        {},
        token
      )
      if (response.ok) {
        const data = await response.json()
        const exactMatches = parseApiList(data).filter(
          (item) => normalizeString(item?.codigo) === normalizeString(codigo)
        )
        if (exactMatches.length === 1) return exactMatches[0]
      }
    }

    const parsedOems = parseOemInput(oemInput)
    if (parsedOems.length >= 1) {
      const oemCode = parsedOems[0]
      const response = await authFetch(
        `${API_URL}/productos/listado/?oem=${encodeURIComponent(oemCode)}&page_size=10`,
        {},
        token
      )
      if (response.ok) {
        const data = await response.json()
        const matches = parseApiList(data).filter((item) =>
          extractProductoOems(item).some((value) => normalizeString(value) === normalizeString(oemCode))
        )
        if (matches.length >= 1) {
          const sorted = [...matches].sort((a, b) =>
            (Number(b?.total_stock ?? 0) > 0 ? 1 : 0) - (Number(a?.total_stock ?? 0) > 0 ? 1 : 0)
          )
          return sorted[0]
        }
      }
    }

    return null
  }, [token])

  useEffect(() => {
    if (!open || !token) return
    if (selectedDraftProducto?.id) return

    const codigo = String(productoDraft.codigo || '').trim()
    const oemsRaw = String(productoDraft.oems || '').trim()
    const oemsList = parseOemInput(oemsRaw)
    const hasSearchableCode = codigo.length >= 2
    const hasSearchableOem = oemsList.length === 1 && String(oemsList[0] || '').trim().length >= 2
    if (!hasSearchableCode && !hasSearchableOem) return

    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const matchedProducto = await resolveSingleExistingProduct({
          codigoInput: codigo,
          oemInput: oemsRaw,
        })
        if (!matchedProducto || cancelled) return
        handleProductoSelect(matchedProducto)
      } catch {
        // Ignora errores silenciosamente para no interrumpir la escritura.
      }
    }, 80)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    handleProductoSelect,
    open,
    productoDraft.codigo,
    productoDraft.oems,
    resolveSingleExistingProduct,
    selectedDraftProducto?.id,
    token,
  ])

  const fetchProductoStockInfo = useCallback(
    async (productoId) => {
      const normalizedId = Number(productoId)
      if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
        return { stockTotal: 0, sucursalesStock: [] }
      }
      if (!token) throw new Error('No se pudo validar el stock del producto.')

      const response = await authFetch(
        `${API_URL}/solicitudes/solicitudes/stock-producto/?producto_id=${encodeURIComponent(normalizedId)}`,
        {},
        token
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(resolveApiErrorMessage(data, 'No se pudo validar el stock del producto.'))
      }

      const stockTotal = Number(data?.stock_total)
      const sucursalesStock = Array.isArray(data?.sucursales_stock) ? data.sucursales_stock : []
      return {
        stockTotal: Number.isFinite(stockTotal) ? stockTotal : 0,
        sucursalesStock,
      }
    },
    [token]
  )

  const handleAgregarProducto = async () => {
    if (addingProductoRef.current || loading) return
    addingProductoRef.current = true
    setAddingProducto(true)

    try {
    setProductoAttempted(true)
    const cantidadRaw = Number(productoDraft.cantidad)
    const cantidad = Number.isFinite(cantidadRaw) ? Math.max(1, Math.floor(cantidadRaw)) : 0
    let productoIdRaw = Number(productoDraft.productoId)
    let casaComercialIdRaw = Number(productoDraft.casaComercialId)
    let hasCasaComercialId = Number.isFinite(casaComercialIdRaw) && casaComercialIdRaw > 0
    let hasProductoId = Number.isFinite(productoIdRaw) && productoIdRaw > 0

    const referencia = String(productoDraft.referencia || '').trim()
    let codigo = String(productoDraft.codigo || '').trim().toUpperCase() || referencia.toUpperCase()
    let nombre = String(productoDraft.nombre || '').trim()
    let oemList = draftOemList
    const comentario = String(productoDraft.comentario || '').trim()

    if (!Number.isFinite(cantidadRaw) || cantidadRaw <= 0) {
      notifyError('La cantidad debe ser mayor a 0.')
      return
    }

    if (!hasProductoId && (referencia || codigo || oemList.length)) {
      try {
        const matchedProducto = await resolveSingleExistingProduct({
          codigoInput: referencia || codigo,
          oemInput: productoDraft.oems,
        })
        if (matchedProducto) {
          productoIdRaw = Number(matchedProducto.id)
          hasProductoId = Number.isFinite(productoIdRaw) && productoIdRaw > 0
          codigo = String(matchedProducto?.codigo || '').trim().toUpperCase()
          nombre = String(matchedProducto?.nombre || '').trim()
          oemList = extractProductoOems(matchedProducto)
          setSelectedDraftProducto(matchedProducto)
        }
      } catch {
        // Si falla la resolución automática, se mantiene el flujo manual.
      }
    }

    const { productoIds, codes, oems } = buildCurrentIdentitySets()

    if (hasProductoId && productoIds.has(productoIdRaw)) {
      notifyError('Ese producto ya esta en la tabla.')
      return
    }

    const missingFields = []
    if (!nombre) missingFields.push('nombre')

    if (missingFields.length) {
      if (missingFields.length === 1) {
        const fieldLabel = missingFields[0]
        notifyError(`${fieldLabel.charAt(0).toUpperCase()}${fieldLabel.slice(1)} es obligatorio.`)
        return
      }

      const missingLabel = `${missingFields.slice(0, -1).join(', ')} y ${missingFields.at(-1)}`
      notifyError(`${missingLabel.charAt(0).toUpperCase()}${missingLabel.slice(1)} son obligatorios.`)
      return
    }

    const codeKey = normalizeString(codigo)
    if (codeKey && codes.has(codeKey)) {
      notifyError('No se puede agregar: ya existe un producto con ese codigo en la tabla.')
      return
    }

    for (const oemCode of oemList) {
      const oemKey = normalizeString(oemCode)
      if (!oemKey) continue
      if (oems.has(oemKey)) {
        notifyError('ya existe este producto')
        return
      }
    }

    const item = {
      uid: `sol-row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tipo: hasProductoId ? 'existente' : 'nuevo',
      productoId: hasProductoId ? productoIdRaw : null,
      referencia,
      codigo,
      nombre,
      casaComercialId: hasCasaComercialId ? casaComercialIdRaw : null,
      casaComercialNombre: String(productoDraft.casaComercialNombre || '').trim(),
      oems: oemList,
      comentario,
      cantidad,
    }

    if (hasProductoId) {
      try {
        const { stockTotal: stockDisponible, sucursalesStock } = await fetchProductoStockInfo(productoIdRaw)
        if (stockDisponible > 0) {
          const detalleStock = formatStockByBranch(sucursalesStock)
          const warningMsg = detalleStock
            ? `Este producto tiene stock disponible (${stockDisponible}) en: ${detalleStock}.`
            : `Este producto tiene stock disponible (${stockDisponible}).`
          setStockWarningData({ item, message: warningMsg })
          return
        }
      } catch (err) {
        notifyError(err?.message || 'No se pudo validar el stock del producto.')
        return
      }
    }

    setProductos((prev) => [...prev, item])
    setProductoDraft(initialProductoDraft)
    setSelectedDraftProducto(null)
    setProductoAttempted(false)
    setShowReferenciaDropdown(false)
    setShowCodigoDropdown(false)
    setShowOemDropdown(false)
    setShowCasaComercialDropdown(false)
    setReferenciaOptions([])
    setCodigoOptions([])
    setOemOptions([])
    setCasaComercialOptions([])
    } finally {
      addingProductoRef.current = false
      setAddingProducto(false)
    }
  }

  const handleQuitarProducto = (uid) => {
    setProductos((prev) => prev.filter((item) => item.uid !== uid))
  }

  const adminReminderRecipients = useMemo(() => {
    const recipients = reminderUsers
      .filter((userItem) => userItem.isAdmin)
      .map((userItem) => sanitizeRecipient({ id: userItem.id, name: userItem.name }))
      .filter(Boolean)

    if (!recipients.length && currentCreatorId) {
      const fallbackRecipient = sanitizeRecipient({
        id: currentCreatorId,
        name: currentCreatorName || 'Administrador',
      })
      if (fallbackRecipient) recipients.push(fallbackRecipient)
    }

    return recipients.filter(
      (recipient, index, list) =>
        list.findIndex((item) => normalizeId(item?.id) === normalizeId(recipient?.id)) === index
    )
  }, [currentCreatorId, currentCreatorName, reminderUsers])

  const useExistingCliente = clienteMode === CLIENT_MODE_EXISTING
  const useNewCliente = clienteMode === CLIENT_MODE_NEW
  const selectedClienteLabel = useMemo(() => formatClienteLabel(selectedCliente), [selectedCliente])

  const isClientReady = useExistingCliente || requiredClienteManualFields.every(
    (field) => String(cliente[field] || '').trim()
  )
  const hasAdminRecipients = adminReminderRecipients.length > 0
  const canSubmit =
    Boolean(sucursalId) &&
    productos.length > 0 &&
    isClientReady &&
    hasAdminRecipients &&
    !reminderUsersLoading

  const getSubmitValidationMessage = useCallback(() => {
    if (!sucursalId) return 'Debe seleccionar una sucursal.'
    if (!productos.length) return 'Debe agregar al menos un producto solicitado.'
    if (reminderUsersLoading) return 'Espera a que se carguen los usuarios para recordatorios.'
    if (!hasAdminRecipients) return 'No se pudo resolver un administrador para el recordatorio obligatorio.'
    if (!isClientReady) return 'Si crea un nuevo cliente, debe completar cedula/RUC, nombres y apellidos.'
    return ''
  }, [hasAdminRecipients, isClientReady, productos.length, reminderUsersLoading, sucursalId])

  const registerInvalidSubmitAttempt = useCallback(() => {
    setSubmitAttempted(true)

    if (!sucursalId || !productos.length) {
      setActiveTab('productos')
    } else if (!isClientReady) {
      setActiveTab('cliente')
    }

    const validationMessage = getSubmitValidationMessage()
    if (validationMessage) notifyError(validationMessage)
  }, [
    getSubmitValidationMessage,
    isClientReady,
    notifyError,
    sucursalId,
    productos.length,
  ])

  const handleCreateButtonClick = (event) => {
    if (loading || canSubmit) return
    event.preventDefault()
    registerInvalidSubmitAttempt()
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!canSubmit) {
      registerInvalidSubmitAttempt()
      return
    }

    const payload = {
      sucursal_id: Number(sucursalId),
      descripcion_general: String(descripcionGeneral || '').trim(),
      marca: marca.trim(),
      modelo: modelo.trim(),
      motor: motor.trim(),
      anio: anio.trim(),
      productos: productos.map((item) => {
        const base = {
          cantidad: Number(item.cantidad),
          comentario: String(item.comentario || '').trim(),
        }

        if (item.productoId) {
          return {
            ...base,
            producto_id: Number(item.productoId),
          }
        }

        const newProductPayload = {
          ...base,
          codigo: String(item.codigo || item.referencia || '').trim(),
          referencia: String(item.referencia || '').trim(),
          nombre: String(item.nombre || '').trim(),
          oems: Array.isArray(item.oems) ? item.oems : parseOemInput(item.oems),
          descripcion: '',
        }
        if (item.casaComercialId) {
          newProductPayload.producto_casa_comercial_id = Number(item.casaComercialId)
        }
        return newProductPayload
      }),
    }

    if (useExistingCliente && selectedCliente?.id) {
      payload.cliente_id = Number(selectedCliente.id)
    } else if (useNewCliente) {
      const clientePayload = normalizeClientePayload(cliente)
      const autosPayload = autos
        .map((a) => ({
          vin: String(a.vin || '').trim(),
          modelo: String(a.modelo || '').trim(),
          motor: String(a.motor || '').trim(),
          anio: a.anio ? Number(a.anio) : null,
        }))
        .filter((a) => a.vin || a.modelo || a.motor || a.anio)
      if (autosPayload.length) clientePayload.autos = autosPayload
      payload.cliente = clientePayload
    }

    setLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/solicitudes/solicitudes/crear-lote/`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(resolveApiErrorMessage(data, 'No se pudo crear la solicitud.'))
      }

      const reminderRecipients = [...adminReminderRecipients]
        .map((recipient) => sanitizeRecipient(recipient))
        .filter(Boolean)
        .filter(
          (recipient, index, list) =>
            list.findIndex((item) => normalizeId(item?.id) === normalizeId(recipient?.id)) === index
        )

      if (reminderRecipients.length) {
        const createdSolicitudes = parseApiList(data)
        const creatorId = normalizeId(currentCreatorId)
        const creatorName = String(currentCreatorName || 'Usuario').trim() || 'Usuario'
        const now = getNowDateParts()
        const groupedSolicitudes = Array.from(
          createdSolicitudes.reduce((acc, solicitudItem) => {
            const groupKey = String(solicitudItem?.grupo_codigo || solicitudItem?.id || '').trim()
            const solicitudId = normalizeId(solicitudItem?.id)
            if (!groupKey || !solicitudId) return acc

            const current = acc.get(groupKey)
            if (!current || Number(solicitudId) < Number(normalizeId(current?.id) || Number.MAX_SAFE_INTEGER)) {
              acc.set(groupKey, solicitudItem)
            }
            return acc
          }, new Map()).values()
        )

        const newReminders = groupedSolicitudes
          .map((solicitudItem) => {
            const solicitudId = normalizeId(solicitudItem?.id)
            if (!solicitudId) return null
            const solicitudLabel = String(solicitudItem?.codigo || `Solicitud #${solicitudId}`).trim()
            return {
              id: createReminderId(),
              date: now.date,
              time: now.time,
              description: `Nueva solicitud ${solicitudLabel}. Revisar gestion pendiente.`,
              creator: {
                id: creatorId,
                name: creatorName,
              },
              recipients: reminderRecipients,
              context: {
                type: 'solicitud',
                id: solicitudId,
                label: solicitudLabel,
              },
              createdAt: new Date().toISOString(),
              completedBy: [],
            }
          })
          .filter(Boolean)

        if (newReminders.length) {
          const existingReminders = readRemindersFromStorage()
          writeRemindersToStorage([...newReminders, ...existingReminders])
          emitRemindersSync()
        } else {
          notifyError('La solicitud se creo, pero no se pudo generar el recordatorio obligatorio.')
        }
      } else {
        notifyError('La solicitud se creo, pero no se pudo generar el recordatorio obligatorio.')
      }

      onCreated?.(data)
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al crear la solicitud.')
    } finally {
      setLoading(false)
    }
  }
  const { shouldRender, isClosing } = useModalAnimation(open)

  if (!shouldRender) return null

  const overlayStyle = { padding: `${VIEWPORT_PADDING}px` }
  const modalStyle = {
    top: position.y,
    left: position.x,
    width: size.width,
    height: size.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
  }

  const draftCantidadRaw = Number(productoDraft.cantidad)
  const productoCodigoInvalid = false
  const productoNombreInvalid = productoAttempted && !String(productoDraft.nombre || '').trim()
  const productoCantidadInvalid = productoAttempted && (!Number.isFinite(draftCantidadRaw) || draftCantidadRaw <= 0)
  const sucursalInvalid = submitAttempted && !sucursalId
  const productosInvalid = submitAttempted && !productos.length

  return (
    <div className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`} role="dialog" aria-modal="true" style={overlayStyle}>
      <div className={`create-user__modal${isClosing ? ' create-user__modal--closing' : ''}`} ref={modalRef} style={modalStyle}>
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>Crear solicitud</h3>
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
              onClick={onClose}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <form className="create-user__form create-user__form--create create-solicitud__form" noValidate onSubmitCapture={(event) => event.currentTarget.classList.add('create-user__form--submitted')} onSubmit={handleSubmit}>
          <div className="create-user__tabs" role="tablist" aria-label="Secciones de solicitud">
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'productos' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('productos')}
            >
              Productos
            </button>
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'cliente' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('cliente')}
            >
              Datos del cliente
            </button>
          </div>

          <div className="create-user__body">
            {activeTab === 'productos' && (
              <>
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Solicitud</p>
                      <h4>Datos generales</h4>
                    </div>
                  </div>

                  <div className="create-user__grid create-user__grid--three">
                    <label className="create-user__field">
                      <span>Sucursal</span>
                      <select
                        className={sucursalInvalid ? 'create-solicitud__input--invalid' : ''}
                        value={sucursalId}
                        onChange={(event) => setSucursalId(event.target.value)}
                        disabled={loading || sucursalesLoading || isSucursalLocked}
                        required
                      >
                        <option value="">Selecciona una sucursal</option>
                        {sucursales.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.nombre || `Sucursal ${item.id}`}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="create-user__field">
                      <span>Fecha</span>
                      <input type="date" value={fecha} disabled />
                    </label>

                    <label className="create-user__field">
                      <span>Marca</span>
                      <input
                        type="text"
                        placeholder="Marca (opcional)"
                        value={marca}
                        onChange={(event) => setMarca(event.target.value)}
                        disabled={loading}
                      />
                    </label>
                    <label className="create-user__field">
                      <span>Modelo</span>
                      <input
                        type="text"
                        placeholder="Modelo (opcional)"
                        value={modelo}
                        onChange={(event) => setModelo(event.target.value)}
                        disabled={loading}
                      />
                    </label>
                    <label className="create-user__field">
                      <span>Motor</span>
                      <input
                        type="text"
                        placeholder="Motor (opcional)"
                        value={motor}
                        onChange={(event) => setMotor(event.target.value)}
                        disabled={loading}
                      />
                    </label>
                    <label className="create-user__field">
                      <span>Año</span>
                      <input
                        type="text"
                        placeholder="Año (opcional)"
                        value={anio}
                        onChange={(event) => setAnio(event.target.value)}
                        disabled={loading}
                      />
                    </label>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Productos</p>
                      <h4>Productos solicitados</h4>
                    </div>
                  </div>

                  <div
                    className={`create-user__locations-table create-solicitud__products-table${productosInvalid ? ' create-solicitud__products-table--invalid' : ''}`}
                  >
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>OEM</span>
                      <span>Descripción</span>
                      <span>Comentario</span>
                      <span>Cantidad</span>
                      <span>Acciones</span>
                    </div>

                    <div className="create-user__locations-row create-user__locations-row--form">
                      <span>
                        <input
                          name="oems"
                          type="text"
                          placeholder="OEM"
                          value={productoDraft.oems}
                          onChange={handleProductoDraftChange}
                          disabled={loading}
                          autoComplete="off"
                        />
                      </span>

                      <span>
                        <input
                          className={productoNombreInvalid ? 'create-solicitud__input--invalid' : ''}
                          name="nombre"
                          type="text"
                          placeholder="Descripción"
                          value={productoDraft.nombre}
                          onChange={handleProductoDraftChange}
                          disabled={loading}
                        />
                      </span>

                      <span>
                        <input
                          name="comentario"
                          type="text"
                          placeholder="Comentario"
                          value={productoDraft.comentario}
                          onChange={handleProductoDraftChange}
                          disabled={loading}
                        />
                      </span>

                      <span>
                        <input
                          className={productoCantidadInvalid ? 'create-solicitud__input--invalid' : ''}
                          name="cantidad"
                          type="number"
                          min="1"
                          step="1"
                          value={productoDraft.cantidad}
                          onChange={handleProductoDraftChange}
                          disabled={loading}
                          autoComplete="off"
                        />
                      </span>

                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={handleAgregarProducto}
                          disabled={loading || addingProducto}
                        >
                          Agregar
                        </button>
                      </span>
                    </div>

                    {!productos.length && (
                      <div className="create-user__locations-row create-user__locations-row--empty">
                        <span>Sin productos agregados.</span>
                      </div>
                    )}

                    {productos.map((item) => (
                      <div key={item.uid} className="create-user__locations-row">
                        <span>{item.oems?.length ? item.oems.join(', ') : '-'}</span>
                        <span>{item.nombre || '-'}</span>
                        <span>{item.comentario || '-'}</span>
                        <span className="create-solicitud__quantity-cell">{item.cantidad}</span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button
                            type="button"
                            className="create-user__locations-remove"
                            onClick={() => handleQuitarProducto(item.uid)}
                            disabled={loading}
                            aria-label="Eliminar producto"
                          >
                            X
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>

                </section>

              </>
            )}

            {activeTab === 'cliente' && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Cliente</p>
                    <h4>Datos del cliente</h4>
                  </div>
                </div>

                <div className="create-user__grid create-user__grid--two">
                  <div className="create-user__field create-user__field--full">
                    <span>Modo de cliente</span>
                    <div className="create-solicitud__cliente-mode">
                      <button
                        type="button"
                        className={`create-user__ghost create-solicitud__cliente-mode-btn ${useExistingCliente ? 'is-active' : ''}`}
                        onClick={handleUseExistingCliente}
                        disabled={loading}
                      >
                        Seleccionar existente
                      </button>
                      <button
                        type="button"
                        className={`create-user__ghost create-solicitud__cliente-mode-btn ${useNewCliente ? 'is-active' : ''}`}
                        onClick={handleCreateNewCliente}
                        disabled={loading}
                      >
                        Crear nuevo cliente
                      </button>
                    </div>
                  </div>

                  {useExistingCliente && (
                    <label className="create-user__field create-user__field--full">
                      <span>Cliente <small className="muted">(opcional)</small></span>
                      <div className="create-user__dropdown create-solicitud__cliente-dropdown" ref={clienteDropdownRef}>
                        <button
                          type="button"
                          className={`create-user__dropdown-trigger${!selectedClienteLabel ? ' create-solicitud__cliente-trigger--placeholder' : ''}`}
                          onClick={handleClienteDropdownToggle}
                          disabled={loading}
                          aria-haspopup="listbox"
                          aria-expanded={showClienteDropdown}
                        >
                          <span>{selectedClienteLabel || 'Selecciona un cliente'}</span>
                          <i className={`pi pi-chevron-${showClienteDropdown ? 'up' : 'down'}`} />
                        </button>
                        {showClienteDropdown && (
                          <div className="create-user__dropdown-panel create-solicitud__cliente-panel">
                            <div className="create-user__dropdown-search">
                              <i className="pi pi-search" />
                              <input
                                type="text"
                                placeholder="Buscar por cedula o nombre"
                                value={clienteSearchTerm}
                                onChange={handleClienteSearchChange}
                                disabled={loading}
                                autoComplete="off"
                                autoFocus
                              />
                            </div>
                            <div className="create-user__dropdown-results">
                              {clienteLoading && <small className="muted">Buscando cliente...</small>}
                              {!clienteLoading && !clienteSearchTerm.trim() && (
                                <small className="muted">Escribe para buscar.</small>
                              )}
                              {!clienteLoading && clienteSearchTerm.trim() && clienteSearchTerm.trim().length < 2 && (
                                <small className="muted">Escribe al menos 2 caracteres.</small>
                              )}
                              {!clienteLoading && clienteSearchTerm.trim().length >= 2 && !clienteResultados.length && (
                                <small className="muted">Sin resultados.</small>
                              )}
                              {clienteResultados.map((item) => {
                                const optionLabel = resolveClienteNombre(item)
                                const selected = String(selectedCliente?.id || '') === String(item?.id || '')
                                return (
                                  <button
                                    key={item.id}
                                    type="button"
                                    className="create-user__result-option"
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => handleClienteSelect(item)}
                                  >
                                    <div className="create-user__result-info">
                                      <strong>{optionLabel || `Cliente ${item.id}`}</strong>
                                      <small>Cédula: {item.cedula_ruc || '-'}</small>
                                    </div>
                                    {selected && <span className="create-user__result-tag is-selected">Seleccionado</span>}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </label>
                  )}

                  {useNewCliente && (
                    <>
                      <label className="create-user__field">
                        <span>Cedula/RUC</span>
                        <input
                          name="cedula_ruc"
                          type="text"
                          value={cliente.cedula_ruc}
                          onChange={handleClienteFieldChange}
                          onBlur={handleCedulaBlur}
                          disabled={loading}
                          required
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Nombres</span>
                        <input
                          name="nombres"
                          type="text"
                          value={cliente.nombres}
                          onChange={handleClienteFieldChange}
                          disabled={loading}
                          required
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Apellidos</span>
                        <input
                          name="apellidos"
                          type="text"
                          value={cliente.apellidos}
                          onChange={handleClienteFieldChange}
                          disabled={loading}
                          required
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Correo</span>
                        <input
                          name="correo"
                          type="email"
                          value={cliente.correo}
                          onChange={handleClienteFieldChange}
                          disabled={loading}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Telefono</span>
                        <input
                          name="telefono"
                          type="text"
                          value={cliente.telefono}
                          onChange={handleClienteFieldChange}
                          disabled={loading}
                        />
                      </label>

                      <label className="create-user__field create-user__field--full">
                        <span>Direccion</span>
                        <input
                          name="direccion"
                          type="text"
                          value={cliente.direccion}
                          onChange={handleClienteFieldChange}
                          disabled={loading}
                        />
                      </label>
                    </>
                  )}
                </div>

                {useNewCliente && (
                  <>
                    <div className="create-user__section-header" style={{ marginTop: 18 }}>
                      <div>
                        <p className="create-user__eyebrow">Autos</p>
                        <h4>Vehículos asociados <small className="muted">(opcional)</small></h4>
                      </div>
                    </div>

                    <div className="create-user__locations-table create-clientes__autos-table">
                      <div className="create-user__locations-row create-user__locations-row--head">
                        <span>VIN</span>
                        <span>Modelo</span>
                        <span>Motor</span>
                        <span>Año</span>
                        <span>Acciones</span>
                      </div>

                      <div className="create-user__locations-row create-user__locations-row--form">
                        <span>
                          <input type="text" placeholder="VIN" value={autoDraft.vin}
                            onChange={(e) => setAutoDraft((p) => ({ ...p, vin: e.target.value }))} disabled={loading} />
                        </span>
                        <span>
                          <input type="text" placeholder="Modelo" value={autoDraft.modelo}
                            onChange={(e) => setAutoDraft((p) => ({ ...p, modelo: e.target.value }))} disabled={loading} />
                        </span>
                        <span>
                          <input type="text" placeholder="Motor" value={autoDraft.motor}
                            onChange={(e) => setAutoDraft((p) => ({ ...p, motor: e.target.value }))} disabled={loading} />
                        </span>
                        <span>
                          <input type="text" placeholder="Año" value={autoDraft.anio}
                            onChange={(e) => setAutoDraft((p) => ({ ...p, anio: e.target.value }))} disabled={loading} />
                        </span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button type="button" className="create-user__ghost" onClick={handleAddAuto} disabled={loading}>
                            Agregar
                          </button>
                        </span>
                      </div>

                      {!autos.length && (
                        <div className="create-user__locations-row create-user__locations-row--empty">
                          <span>Sin vehículos agregados.</span>
                        </div>
                      )}

                      {autos.map((auto, index) => (
                        <div key={`auto-sol-${index}`} className="create-user__locations-row">
                          <span>{auto.vin || '-'}</span>
                          <span>{auto.modelo || '-'}</span>
                          <span>{auto.motor || '-'}</span>
                          <span>{auto.anio || '-'}</span>
                          <span className="create-user__locations-cell create-user__locations-cell--action">
                            <button type="button" className="create-user__locations-remove"
                              onClick={() => handleRemoveAuto(index)} disabled={loading} aria-label="Eliminar vehículo">
                              X
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {useExistingCliente && selectedCliente?.id && (
                  <>
                    <div className="create-user__section-header" style={{ marginTop: 18 }}>
                      <div>
                        <p className="create-user__eyebrow">Autos</p>
                        <h4>Vehículos del cliente <small className="muted">(opcional)</small></h4>
                      </div>
                    </div>

                    <div className="create-user__locations-table create-clientes__autos-table">
                      <div className="create-user__locations-row create-user__locations-row--head">
                        <span>Placa</span>
                        <span>Modelo</span>
                        <span>Año</span>
                        <span>Marca</span>
                        <span>Acciones</span>
                      </div>

                      <div className="create-user__locations-row create-user__locations-row--form">
                        <span>
                          <input type="text" placeholder="Placa" value={pendingAutoDraft.placa}
                            onChange={(e) => setPendingAutoDraft((p) => ({ ...p, placa: e.target.value }))} disabled={loading} />
                        </span>
                        <span>
                          <input type="text" placeholder="Modelo" value={pendingAutoDraft.modelo}
                            onChange={(e) => setPendingAutoDraft((p) => ({ ...p, modelo: e.target.value }))} disabled={loading} />
                        </span>
                        <span>
                          <input type="text" placeholder="Año" value={pendingAutoDraft.anio}
                            onChange={(e) => setPendingAutoDraft((p) => ({ ...p, anio: e.target.value }))} disabled={loading} />
                        </span>
                        <span>
                          <input type="text" placeholder="Marca (opcional)" value={pendingAutoDraft.marca}
                            onChange={(e) => setPendingAutoDraft((p) => ({ ...p, marca: e.target.value }))} disabled={loading} />
                        </span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button type="button" className="create-user__ghost" onClick={handleAutoAgregarClick} disabled={loading || savingAuto}>
                            Agregar
                          </button>
                        </span>
                      </div>

                      {!selectedClienteAutos.length && (
                        <div className="create-user__locations-row create-user__locations-row--empty">
                          <span>{fetchingClienteAutos ? 'Cargando vehículos...' : 'Sin vehículos registrados.'}</span>
                        </div>
                      )}

                      {selectedClienteAutos.map((auto, index) => (
                        <div key={`sel-auto-sol-${index}`} className="create-user__locations-row">
                          <span>{auto.placa || '-'}</span>
                          <span>{auto.modelo || '-'}</span>
                          <span>{auto.anio || '-'}</span>
                          <span>{auto.marca || '-'}</span>
                          <span />
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </section>
            )}

          </div>

          <div className="create-user__footer">
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={onClose}
              disabled={loading}
            >
              Cancelar
            </button>
            <div className="create-solicitud__submit-wrap" onClick={handleCreateButtonClick}>
              <button
                type="submit"
                className="create-user__action create-user__action--primary"
                disabled={loading || !canSubmit}
                style={!loading && !canSubmit ? { pointerEvents: 'none' } : undefined}
              >
                {loading ? 'Guardando...' : 'Crear solicitud'}
              </button>
            </div>
          </div>
        </form>

        {stockWarningData && (
          <div
            className="create-solicitud__confirm-overlay"
            onMouseDown={() => setStockWarningData(null)}
          >
            <div className="create-solicitud__confirm-card" onMouseDown={(e) => e.stopPropagation()}>
              <h4>Producto con stock disponible</h4>
              <p>{stockWarningData.message}</p>
              <p>¿Estás seguro de hacer esta solicitud?</p>
              <div className="create-solicitud__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary"
                  onClick={() => setStockWarningData(null)}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={handleConfirmStockWarning}
                >
                  Sí, agregar
                </button>
              </div>
            </div>
          </div>
        )}

        {autoConfirmData && (
          <div
            className="create-solicitud__confirm-overlay"
            onMouseDown={() => { if (!savingAuto) setAutoConfirmData(null) }}
          >
            <div className="create-solicitud__confirm-card" onMouseDown={(e) => e.stopPropagation()}>
              <h4>Agregar vehículo</h4>
              <p>
                ¿Agregar este vehículo al cliente{' '}
                <strong>{resolveClienteNombre(selectedCliente)}</strong>?
              </p>
              <p>
                <strong>
                  {[autoConfirmData.placa, autoConfirmData.modelo, autoConfirmData.anio, autoConfirmData.marca]
                    .filter(Boolean)
                    .join(' · ')}
                </strong>
              </p>
              <div className="create-solicitud__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary"
                  onClick={() => setAutoConfirmData(null)}
                  disabled={savingAuto}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={handleConfirmAddAuto}
                  disabled={savingAuto}
                >
                  {savingAuto ? 'Guardando...' : 'Sí, agregar'}
                </button>
              </div>
            </div>
          </div>
        )}

        <button
          type="button"
          aria-label="Cambiar tamaño de ventana"
          className="create-user__resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      </div>
    </div>
  )
}

export default CreateSolicitud


