import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import './CreateSolicitud.css'
import { API_URL, authFetch } from '../../../../utils/api'
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

const MIN_WIDTH = 860
const MIN_HEIGHT = 620
const VIEWPORT_PADDING = 12

const initialCliente = {
  nombres: '',
  apellidos: '',
  cedula_ruc: '',
  correo: '',
  telefono: '',
  direccion: '',
}

const initialProductoDraft = {
  productoId: '',
  codigo: '',
  nombre: '',
  oems: '',
  marcaId: '',
  marca: '',
  comentario: '',
  cantidad: '1',
}
const requiredClienteManualFields = ['cedula_ruc', 'nombres', 'apellidos', 'correo', 'telefono', 'direccion']

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

function CreateSolicitud({
  open,
  onClose,
  onCreated,
  token,
  onError,
  currentUser,
  prefilledSucursalId = '',
}) {
  const [cliente, setCliente] = useState(initialCliente)
  const [selectedCliente, setSelectedCliente] = useState(null)
  const [clienteResultados, setClienteResultados] = useState([])
  const [clienteLoading, setClienteLoading] = useState(false)
  const [showClienteDropdown, setShowClienteDropdown] = useState(false)
  const [clienteSearchTerm, setClienteSearchTerm] = useState('')

  const [sucursalId, setSucursalId] = useState('')
  const [fecha, setFecha] = useState(todayISO())
  const [placa, setPlaca] = useState('')
  const [descripcionGeneral, setDescripcionGeneral] = useState('')
  const [sucursales, setSucursales] = useState([])
  const [sucursalesLoading, setSucursalesLoading] = useState(false)

  const [productoDraft, setProductoDraft] = useState(initialProductoDraft)
  const [selectedDraftProducto, setSelectedDraftProducto] = useState(null)
  const [productos, setProductos] = useState([])
  const [showCodigoDropdown, setShowCodigoDropdown] = useState(false)
  const [codigoOptions, setCodigoOptions] = useState([])
  const [codigoLoading, setCodigoLoading] = useState(false)
  const [showOemDropdown, setShowOemDropdown] = useState(false)
  const [oemOptions, setOemOptions] = useState([])
  const [oemLoading, setOemLoading] = useState(false)
  const [showMarcaDropdown, setShowMarcaDropdown] = useState(false)
  const [marcaSearchTerm, setMarcaSearchTerm] = useState('')
  const [marcaOptions, setMarcaOptions] = useState([])
  const [marcaLoading, setMarcaLoading] = useState(false)

  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [productoAttempted, setProductoAttempted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [addingProducto, setAddingProducto] = useState(false)
  const [activeTab, setActiveTab] = useState('productos')
  const [reminderUsers, setReminderUsers] = useState([])
  const [reminderUsersLoading, setReminderUsersLoading] = useState(false)
  const [reminderUsersError, setReminderUsersError] = useState('')
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const clienteDropdownRef = useRef(null)
  const codigoDropdownRef = useRef(null)
  const oemDropdownRef = useRef(null)
  const marcaDropdownRef = useRef(null)
  const clienteSearchTimerRef = useRef(null)
  const codigoSearchTimerRef = useRef(null)
  const codigoSearchSeqRef = useRef(0)
  const oemSearchTimerRef = useRef(null)
  const oemSearchSeqRef = useRef(0)
  const marcaSearchTimerRef = useRef(null)
  const marcaSearchSeqRef = useRef(0)
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
    setCliente(initialCliente)
    setSelectedCliente(null)
    setClienteResultados([])
    setClienteLoading(false)
    setShowClienteDropdown(false)
    setClienteSearchTerm('')

    setSucursalId(normalizedPrefilledSucursalId)
    setFecha(todayISO())
    setPlaca('')
    setDescripcionGeneral('')
    setActiveTab('productos')

    setProductoDraft(initialProductoDraft)
    setSelectedDraftProducto(null)
    setProductos([])
    setShowCodigoDropdown(false)
    setCodigoOptions([])
    setCodigoLoading(false)
    setShowOemDropdown(false)
    setOemOptions([])
    setOemLoading(false)
    setShowMarcaDropdown(false)
    setMarcaSearchTerm('')
    setMarcaOptions([])
    setMarcaLoading(false)

    setSubmitAttempted(false)
    setProductoAttempted(false)
    setLoading(false)
    setAddingProducto(false)
    addingProductoRef.current = false
    setReminderUsers([])
    setReminderUsersLoading(false)
    setReminderUsersError('')
    setIsMaximized(false)
    restoreRef.current = null

    if (clienteSearchTimerRef.current) {
      clearTimeout(clienteSearchTimerRef.current)
      clienteSearchTimerRef.current = null
    }
    if (codigoSearchTimerRef.current) {
      clearTimeout(codigoSearchTimerRef.current)
      codigoSearchTimerRef.current = null
    }
    if (oemSearchTimerRef.current) {
      clearTimeout(oemSearchTimerRef.current)
      oemSearchTimerRef.current = null
    }
    if (marcaSearchTimerRef.current) {
      clearTimeout(marcaSearchTimerRef.current)
      marcaSearchTimerRef.current = null
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
      if (codigoSearchTimerRef.current) clearTimeout(codigoSearchTimerRef.current)
      if (oemSearchTimerRef.current) clearTimeout(oemSearchTimerRef.current)
      if (marcaSearchTimerRef.current) clearTimeout(marcaSearchTimerRef.current)
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
          `${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=20`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar productos.')
        const data = await response.json()
        if (requestId !== codigoSearchSeqRef.current) return
        setCodigoOptions(parseApiList(data))
      } catch {
        if (requestId !== codigoSearchSeqRef.current) return
        setCodigoOptions([])
      } finally {
        if (requestId === codigoSearchSeqRef.current) {
          setCodigoLoading(false)
        }
      }
    }, 320)

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
          `${API_URL}/productos/listado/?oem=${encodeURIComponent(oemSearchTerm)}&page_size=20`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar productos por OEM.')
        const data = await response.json()
        if (requestId !== oemSearchSeqRef.current) return
        setOemOptions(parseApiList(data))
      } catch {
        if (requestId !== oemSearchSeqRef.current) return
        setOemOptions([])
      } finally {
        if (requestId === oemSearchSeqRef.current) {
          setOemLoading(false)
        }
      }
    }, 320)

    return () => {
      if (oemSearchTimerRef.current) {
        clearTimeout(oemSearchTimerRef.current)
        oemSearchTimerRef.current = null
      }
    }
  }, [open, showOemDropdown, token, oemSearchTerm])

  useEffect(() => {
    if (!open || !showMarcaDropdown) return
    const term = String(marcaSearchTerm || '').trim()
    if (!term || term.length < 2 || !token) {
      setMarcaOptions([])
      setMarcaLoading(false)
      return
    }

    if (marcaSearchTimerRef.current) clearTimeout(marcaSearchTimerRef.current)

    setMarcaLoading(true)
    marcaSearchTimerRef.current = setTimeout(async () => {
      const requestId = marcaSearchSeqRef.current + 1
      marcaSearchSeqRef.current = requestId

      try {
        const response = await authFetch(
          `${API_URL}/marcas/listado/?search=${encodeURIComponent(term)}&page_size=20`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las marcas.')
        const data = await response.json()
        if (requestId !== marcaSearchSeqRef.current) return
        setMarcaOptions(parseApiList(data))
      } catch {
        if (requestId !== marcaSearchSeqRef.current) return
        setMarcaOptions([])
      } finally {
        if (requestId === marcaSearchSeqRef.current) {
          setMarcaLoading(false)
        }
      }
    }, 320)

    return () => {
      if (marcaSearchTimerRef.current) {
        clearTimeout(marcaSearchTimerRef.current)
        marcaSearchTimerRef.current = null
      }
    }
  }, [marcaSearchTerm, open, showMarcaDropdown, token])

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
      if (showCodigoDropdown) {
        if (!codigoDropdownRef.current || !codigoDropdownRef.current.contains(event.target)) {
          setShowCodigoDropdown(false)
        }
      }
      if (showOemDropdown) {
        if (!oemDropdownRef.current || !oemDropdownRef.current.contains(event.target)) {
          setShowOemDropdown(false)
        }
      }
      if (showMarcaDropdown) {
        if (!marcaDropdownRef.current || !marcaDropdownRef.current.contains(event.target)) {
          setShowMarcaDropdown(false)
        }
      }
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [showClienteDropdown, showCodigoDropdown, showMarcaDropdown, showOemDropdown])

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

  const handleClienteFieldChange = (event) => {
    const { name, value } = event.target

    setCliente((prev) => ({ ...prev, [name]: value }))
    if (selectedCliente && normalizeString(value) !== normalizeString(selectedCliente[name])) {
      setSelectedCliente(null)
    }
  }

  const handleClienteSearchChange = (event) => {
    const value = event.target.value
    setClienteSearchTerm(value)
    setShowClienteDropdown(Boolean(value))
    if (!value.trim()) {
      setClienteResultados([])
      setClienteLoading(false)
    }
    if (selectedCliente) {
      const selectedLabel = formatClienteLabel(selectedCliente)
      if (normalizeString(value) !== normalizeString(selectedLabel)) {
        setSelectedCliente(null)
      }
    }
  }

  const handleClienteSelect = (item) => {
    if (!item) return
    setSelectedCliente(item)
    setCliente({
      nombres: item.nombres || '',
      apellidos: item.apellidos || '',
      cedula_ruc: item.cedula_ruc || '',
      correo: item.correo || '',
      telefono: item.telefono || '',
      direccion: item.direccion || '',
    })
    setClienteSearchTerm(formatClienteLabel(item))
    setClienteResultados([])
    setClienteLoading(false)
    setShowClienteDropdown(false)
  }

  const handleProductoDraftChange = (event) => {
    const { name, value } = event.target
    const normalizedValue = name === 'codigo' ? String(value || '').toUpperCase() : value
    const shouldDetachSelectedProduct =
      selectedDraftProducto && ['codigo', 'nombre', 'oems'].includes(name)

    if (name === 'codigo') {
      const shouldShow = String(normalizedValue || '').trim().length >= 1
      setShowCodigoDropdown(shouldShow)
      if (!shouldShow) setCodigoOptions([])
    }

    if (name === 'oems') {
      const shouldShow = String(normalizedValue || '').trim().length >= 1
      setShowOemDropdown(shouldShow)
      if (!shouldShow) setOemOptions([])
    }

    if (shouldDetachSelectedProduct) {
      setSelectedDraftProducto(null)
    }

    setProductoDraft((prev) => ({
      ...prev,
      productoId: shouldDetachSelectedProduct ? '' : prev.productoId,
      [name]: normalizedValue,
    }))
  }

  const handleProductoSelect = useCallback((producto) => {
    if (!producto) return

    const codigo = String(producto?.codigo || '').trim().toUpperCase()
    const nombre = String(producto?.nombre || '').trim()
    const marca = String(producto?.marca?.nombre || producto?.marca || '').trim()
    const marcaId = String(producto?.marca?.id || '')
    const oems = extractProductoOems(producto)

    setSelectedDraftProducto(producto)
    setProductoDraft((prev) => ({
      ...prev,
      productoId: String(producto.id),
      codigo,
      nombre,
      oems: oems.join(', '),
      marcaId,
      marca,
      cantidad: prev.cantidad || '1',
    }))
    setShowCodigoDropdown(false)
    setShowOemDropdown(false)
    setShowMarcaDropdown(false)
    setMarcaSearchTerm('')
    setCodigoOptions([])
    setOemOptions([])
    setMarcaOptions([])
  }, [])

  const handleMarcaSelect = useCallback((marcaOption) => {
    if (!marcaOption?.id) return
    const nextMarcaId = String(marcaOption.id)
    const nextMarcaNombre = String(marcaOption.nombre || '').trim()
    const currentSelectedMarcaId = String(selectedDraftProducto?.marca?.id || '')
    const currentSelectedMarca = String(
      selectedDraftProducto?.marca?.nombre || selectedDraftProducto?.marca || ''
    ).trim()
    const keepSelectedProduct =
      Boolean(selectedDraftProducto?.id) &&
      (
        (currentSelectedMarcaId && currentSelectedMarcaId === nextMarcaId) ||
        (normalizeString(currentSelectedMarca) && normalizeString(currentSelectedMarca) === normalizeString(nextMarcaNombre))
      )

    if (!keepSelectedProduct) {
      setSelectedDraftProducto(null)
    }

    setProductoDraft((prev) => ({
      ...prev,
      productoId: keepSelectedProduct ? prev.productoId : '',
      marcaId: nextMarcaId,
      marca: nextMarcaNombre,
    }))
    setShowMarcaDropdown(false)
    setMarcaSearchTerm('')
    setMarcaOptions([])
    setMarcaLoading(false)
  }, [selectedDraftProducto])

  const handleMarcaSearchChange = (event) => {
    const value = event.target.value
    setMarcaSearchTerm(value)
    if (!showMarcaDropdown) {
      setShowMarcaDropdown(true)
    }
    if (!String(value || '').trim()) {
      setMarcaOptions([])
      setMarcaLoading(false)
    }
  }

  const handleMarcaDropdownToggle = () => {
    if (showMarcaDropdown) {
      setShowMarcaDropdown(false)
      return
    }
    setMarcaSearchTerm('')
    setMarcaOptions([])
    setMarcaLoading(false)
    setShowMarcaDropdown(true)
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
    if (parsedOems.length === 1) {
      const oemCode = parsedOems[0]
      const response = await authFetch(
        `${API_URL}/productos/listado/?oem=${encodeURIComponent(oemCode)}&page_size=3`,
        {},
        token
      )
      if (response.ok) {
        const data = await response.json()
        const exactMatches = parseApiList(data).filter((item) =>
          extractProductoOems(item).some((value) => normalizeString(value) === normalizeString(oemCode))
        )
        if (exactMatches.length === 1) return exactMatches[0]
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
    }, 320)

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
    let marcaIdRaw = Number(productoDraft.marcaId)
    let hasProductoId = Number.isFinite(productoIdRaw) && productoIdRaw > 0
    let hasMarcaId = Number.isFinite(marcaIdRaw) && marcaIdRaw > 0

    let codigo = String(productoDraft.codigo || '').trim().toUpperCase()
    let nombre = String(productoDraft.nombre || '').trim()
    let marca = String(productoDraft.marca || '').trim()
    let oemList = draftOemList
    const comentario = String(productoDraft.comentario || '').trim()

    if (!Number.isFinite(cantidadRaw) || cantidadRaw <= 0) {
      notifyError('La cantidad debe ser mayor a 0.')
      return
    }

    if (!hasProductoId && (codigo || oemList.length)) {
      try {
        const matchedProducto = await resolveSingleExistingProduct({
          codigoInput: codigo,
          oemInput: productoDraft.oems,
        })
        if (matchedProducto) {
          productoIdRaw = Number(matchedProducto.id)
          hasProductoId = Number.isFinite(productoIdRaw) && productoIdRaw > 0
          marcaIdRaw = Number(matchedProducto?.marca?.id || 0)
          hasMarcaId = Number.isFinite(marcaIdRaw) && marcaIdRaw > 0
          codigo = String(matchedProducto?.codigo || '').trim().toUpperCase()
          nombre = String(matchedProducto?.nombre || '').trim()
          marca = String(matchedProducto?.marca?.nombre || matchedProducto?.marca || '').trim()
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

    if (hasProductoId) {
      try {
        const { stockTotal: stockDisponible, sucursalesStock } = await fetchProductoStockInfo(productoIdRaw)
        if (stockDisponible > 0) {
          const detalleStock = formatStockByBranch(sucursalesStock)
          notifyError(
            detalleStock
              ? `No se puede solicitar este producto porque tiene stock disponible (${stockDisponible}) en: ${detalleStock}.`
              : `No se puede solicitar este producto porque tiene stock disponible (${stockDisponible}).`
          )
          return
        }
      } catch (err) {
        notifyError(err?.message || 'No se pudo validar el stock del producto.')
        return
      }
    }

    if (!codigo || !nombre) {
      notifyError('Codigo y nombre son obligatorios.')
      return
    }

    if (!hasMarcaId || !marca) {
      notifyError('Debes seleccionar una marca existente.')
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
      codigo,
      nombre,
      marcaId: marcaIdRaw,
      oems: oemList,
      marca,
      comentario,
      cantidad,
    }

    setProductos((prev) => [...prev, item])
    setProductoDraft(initialProductoDraft)
    setSelectedDraftProducto(null)
    setProductoAttempted(false)
    setShowCodigoDropdown(false)
    setShowOemDropdown(false)
    setShowMarcaDropdown(false)
    setCodigoOptions([])
    setOemOptions([])
    setMarcaOptions([])
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

  const hasAnyManualClienteData = useMemo(
    () => Object.values(cliente).some((value) => String(value || '').trim()),
    [cliente]
  )
  const mustCompleteManualClient = !selectedCliente?.id && hasAnyManualClienteData
  const hasManualClienteData = useMemo(
    () => requiredClienteManualFields.every((field) => String(cliente[field] || '').trim()),
    [cliente]
  )
  const isClientReady = !mustCompleteManualClient || hasManualClienteData
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
    if (!isClientReady) return 'Si ingresa datos del cliente, la cedula es obligatoria y debe completar todos los campos.'
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
      placa: String(placa || '').trim(),
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

        return {
          ...base,
          codigo: String(item.codigo || '').trim(),
          nombre: String(item.nombre || '').trim(),
          marca_id: Number(item.marcaId),
          marca: String(item.marca || '').trim(),
          oems: Array.isArray(item.oems) ? item.oems : parseOemInput(item.oems),
          descripcion: '',
        }
      }),
    }

    if (selectedCliente?.id) {
      payload.cliente_id = Number(selectedCliente.id)
    } else if (mustCompleteManualClient) {
      payload.cliente = {
        nombres: String(cliente.nombres || '').trim(),
        apellidos: String(cliente.apellidos || '').trim(),
        cedula_ruc: String(cliente.cedula_ruc || '').trim(),
        correo: String(cliente.correo || '').trim(),
        telefono: String(cliente.telefono || '').trim(),
        direccion: String(cliente.direccion || '').trim(),
      }
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

  const showClientHint = Boolean(selectedCliente?.id)
  const draftCantidadRaw = Number(productoDraft.cantidad)
  const productoCodigoInvalid = productoAttempted && !String(productoDraft.codigo || '').trim()
  const productoNombreInvalid = productoAttempted && !String(productoDraft.nombre || '').trim()
  const productoMarcaInvalid = productoAttempted && !String(productoDraft.marcaId || '').trim()
  const productoCantidadInvalid = productoAttempted && (!Number.isFinite(draftCantidadRaw) || draftCantidadRaw <= 0)
  const sucursalInvalid = submitAttempted && !sucursalId
  const productosInvalid = submitAttempted && !productos.length
  const isClientFieldInvalid = (fieldName) =>
    submitAttempted && mustCompleteManualClient && !String(cliente[fieldName] || '').trim()

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

        <form className="create-user__form create-user__form--create" noValidate onSubmitCapture={(event) => event.currentTarget.classList.add('create-user__form--submitted')} onSubmit={handleSubmit}>
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

                  <div className="create-user__grid create-user__grid--two">
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
                      <span>Placa</span>
                      <input
                        type="text"
                        placeholder="Placa (opcional)"
                        value={placa}
                        onChange={(event) => setPlaca(event.target.value)}
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
                      <span>Codigo</span>
                      <span>Nombre</span>
                      <span>OEM</span>
                      <span>Marca</span>
                      <span>Comentario</span>
                      <span>Cantidad</span>
                      <span>Acciones</span>
                    </div>

                    <div className="create-user__locations-row create-user__locations-row--form">
                      <span>
                        <div className="create-solicitud__inline-dropdown" ref={codigoDropdownRef}>
                          <input
                            className={productoCodigoInvalid ? 'create-solicitud__input--invalid' : ''}
                            name="codigo"
                            type="text"
                            placeholder="Codigo"
                            value={productoDraft.codigo}
                            onChange={handleProductoDraftChange}
                            onFocus={() => {
                              const hasTerm = String(productoDraft.codigo || '').trim().length >= 1
                              setShowCodigoDropdown(hasTerm)
                            }}
                            disabled={loading}
                            autoComplete="off"
                          />
                          {showCodigoDropdown && (
                            <div className="create-solicitud__inline-panel create-solicitud__inline-panel--wide">
                              <div className="create-solicitud__inline-results">
                                {codigoLoading && <small className="muted">Buscando por codigo...</small>}
                                {!codigoLoading && String(productoDraft.codigo || '').trim().length < 2 && (
                                  <small className="muted">Escribe al menos 2 caracteres.</small>
                                )}
                                {!codigoLoading &&
                                  String(productoDraft.codigo || '').trim().length >= 2 &&
                                  !codigoOptions.length && (
                                    <small className="muted">
                                      Sin coincidencias. Puedes usar este codigo nuevo.
                                    </small>
                                  )}
                                {codigoOptions.map((producto) => {
                                  const isSelected =
                                    String(selectedDraftProducto?.id || '') === String(producto.id)
                                  const codigo = String(producto?.codigo || '').trim() || `ID ${producto.id}`
                                  const nombre = String(producto?.nombre || '').trim()
                                  const marca = String(producto?.marca?.nombre || producto?.marca || '').trim()
                                  const oems = extractProductoOems(producto)

                                  return (
                                    <button
                                      key={`codigo-opt-${producto.id}`}
                                      type="button"
                                      className="create-user__result-option"
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={() => handleProductoSelect(producto)}
                                    >
                                      <div className="create-user__result-info">
                                        <strong>{codigo}</strong>
                                        <small>{nombre || '-'}</small>
                                        <small>
                                          {marca ? `Marca: ${marca}` : 'Sin marca'} |{' '}
                                          {oems.length
                                            ? `OEM: ${oems.slice(0, 4).join(', ')}${oems.length > 4 ? '...' : ''}`
                                            : 'Sin OEM'}
                                        </small>
                                      </div>
                                      {isSelected && (
                                        <span className="create-user__result-tag is-selected">Seleccionado</span>
                                      )}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      </span>

                      <span>
                        <input
                          className={productoNombreInvalid ? 'create-solicitud__input--invalid' : ''}
                          name="nombre"
                          type="text"
                          placeholder="Nombre del producto"
                          value={productoDraft.nombre}
                          onChange={handleProductoDraftChange}
                          disabled={loading}
                        />
                      </span>

                      <span>
                        <div className="create-solicitud__inline-dropdown" ref={oemDropdownRef}>
                          <input
                            name="oems"
                            type="text"
                            placeholder="OEM1, OEM2"
                            value={productoDraft.oems}
                            onChange={handleProductoDraftChange}
                            onFocus={() => {
                              const hasTerm = String(oemSearchTerm || '').trim().length >= 1
                              setShowOemDropdown(hasTerm)
                            }}
                            disabled={loading}
                            autoComplete="off"
                          />
                          {showOemDropdown && (
                            <div className="create-solicitud__inline-panel create-solicitud__inline-panel--wide create-solicitud__inline-panel--align-right">
                              <div className="create-solicitud__inline-results">
                                {oemLoading && <small className="muted">Buscando por OEM...</small>}
                                {!oemLoading && String(oemSearchTerm || '').trim().length < 2 && (
                                  <small className="muted">Escribe al menos 2 caracteres.</small>
                                )}
                                {!oemLoading &&
                                  String(oemSearchTerm || '').trim().length >= 2 &&
                                  !oemOptions.length && (
                                    <small className="muted">
                                      Sin coincidencias. Puedes escribir un OEM nuevo.
                                    </small>
                                  )}
                                {oemOptions.map((producto) => {
                                  const isSelected =
                                    String(selectedDraftProducto?.id || '') === String(producto.id)
                                  const oems = extractProductoOems(producto)
                                  const codigo = String(producto?.codigo || '').trim() || `ID ${producto.id}`
                                  const nombre = String(producto?.nombre || '').trim()
                                  const marca = String(producto?.marca?.nombre || producto?.marca || '').trim()
                                  return (
                                    <button
                                      key={`oem-opt-${producto.id}`}
                                      type="button"
                                      className="create-user__result-option"
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={() => handleProductoSelect(producto)}
                                    >
                                      <div className="create-user__result-info">
                                        <strong>{codigo}</strong>
                                        <small>{nombre || '-'}</small>
                                        <small>
                                          {marca ? `Marca: ${marca}` : 'Sin marca'} |{' '}
                                          {oems.length
                                            ? `OEM: ${oems.slice(0, 3).join(', ')}${oems.length > 3 ? '...' : ''}`
                                            : 'Sin OEM'}
                                        </small>
                                      </div>
                                      {isSelected && (
                                        <span className="create-user__result-tag is-selected">Seleccionado</span>
                                      )}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      </span>

                      <span>
                        <div className="create-solicitud__inline-dropdown" ref={marcaDropdownRef}>
                          <button
                            type="button"
                            className={`create-solicitud__inline-trigger${!productoDraft.marca ? ' create-solicitud__inline-trigger--placeholder' : ''}${productoMarcaInvalid ? ' create-solicitud__inline-trigger--invalid' : ''}`}
                            onClick={handleMarcaDropdownToggle}
                            disabled={loading}
                            aria-haspopup="listbox"
                            aria-expanded={showMarcaDropdown}
                          >
                            <span>{productoDraft.marca || 'Seleccionar marca'}</span>
                            <i
                              className={`pi pi-chevron-${showMarcaDropdown ? 'up' : 'down'}`}
                              aria-hidden="true"
                            />
                          </button>
                          {showMarcaDropdown && (
                            <div className="create-solicitud__inline-panel create-solicitud__inline-panel--wide">
                              <div className="create-user__dropdown-search">
                                <i className="pi pi-search" />
                                <input
                                  type="text"
                                  placeholder="Buscar marca"
                                  value={marcaSearchTerm}
                                  onChange={handleMarcaSearchChange}
                                  autoFocus
                                  autoComplete="off"
                                />
                              </div>
                              <div className="create-solicitud__inline-results">
                                {marcaLoading && <small className="muted">Buscando marcas...</small>}
                                {!marcaLoading && String(marcaSearchTerm || '').trim().length < 2 && (
                                  <small className="muted">Escribe al menos 2 caracteres.</small>
                                )}
                                {!marcaLoading &&
                                  String(marcaSearchTerm || '').trim().length >= 2 &&
                                  !marcaOptions.length && (
                                    <small className="muted">
                                      Sin coincidencias. Debes seleccionar una marca existente.
                                    </small>
                                  )}
                                {marcaOptions.map((marcaOption) => {
                                  const isSelected =
                                    String(productoDraft.marcaId || '') === String(marcaOption.id)
                                  return (
                                    <button
                                      key={`marca-opt-${marcaOption.id}`}
                                      type="button"
                                      className="create-user__result-option"
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={() => handleMarcaSelect(marcaOption)}
                                    >
                                      <div className="create-user__result-info">
                                        <strong>{marcaOption.nombre || `Marca ${marcaOption.id}`}</strong>
                                        <small>
                                          {marcaOption.codigo
                                            ? `Codigo: ${marcaOption.codigo}`
                                            : `ID: ${marcaOption.id}`}
                                        </small>
                                      </div>
                                      {isSelected && (
                                        <span className="create-user__result-tag is-selected">Seleccionada</span>
                                      )}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      </span>

                      <span>
                        <input
                          name="comentario"
                          type="text"
                          placeholder="Comentario por producto"
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
                        <span>
                          {item.codigo || '-'}
                          {item.tipo === 'existente' && <small className="create-solicitud__chip">Catalogo</small>}
                        </span>
                        <span>{item.nombre || '-'}</span>
                        <span>{item.oems?.length ? item.oems.join(', ') : '-'}</span>
                        <span>{item.marca || '-'}</span>
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

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Solicitud</p>
                      <h4>Descripción general</h4>
                    </div>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field create-user__field--full">
                      <span>Comentarios</span>
                      <textarea
                        value={descripcionGeneral}
                        onChange={(event) => setDescripcionGeneral(event.target.value)}
                        placeholder="Comentarios generales de la solicitud"
                        disabled={loading}
                      />
                    </label>
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
                  <label className="create-user__field">
                    <span>Cliente</span>
                    <div className="create-user__dropdown" ref={clienteDropdownRef}>
                      <input
                        type="text"
                        placeholder="Buscar por cedula o nombre"
                        value={clienteSearchTerm}
                        onChange={handleClienteSearchChange}
                        onFocus={() => setShowClienteDropdown(Boolean(clienteSearchTerm))}
                        disabled={loading}
                        autoComplete="off"
                      />
                      {showClienteDropdown && (
                        <div className="create-user__dropdown-panel">
                          <div className="create-user__dropdown-results">
                            {clienteLoading && <small className="muted">Buscando cliente...</small>}
                            {!clienteLoading && !clienteSearchTerm.trim() && (
                              <small className="muted">Escribe para buscar.</small>
                            )}
                            {!clienteLoading && clienteSearchTerm.trim() && clienteSearchTerm.trim().length < 2 && (
                              <small className="muted">Escribe al menos 2 caracteres.</small>
                            )}
                            {!clienteLoading && clienteSearchTerm.trim().length >= 2 && !clienteResultados.length && (
                              <small className="muted">Sin coincidencias.</small>
                            )}
                            {clienteResultados.map((item) => {
                              const isSelected = String(selectedCliente?.id || '') === String(item?.id || '')
                              return (
                                <button
                                  key={item.id}
                                  type="button"
                                  className="create-user__result-option"
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => handleClienteSelect(item)}
                                >
                                  <div className="create-user__result-info">
                                    <strong>{formatClienteLabel(item) || `Cliente ${item.id}`}</strong>
                                    <small>ID: {item.id}</small>
                                  </div>
                                  {isSelected && <span className="create-user__result-tag is-selected">Seleccionado</span>}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </label>

                  <label className="create-user__field">
                    <span>Cedula/RUC</span>
                    <input
                      className={isClientFieldInvalid('cedula_ruc') ? 'create-solicitud__input--invalid' : ''}
                      name="cedula_ruc"
                      type="text"
                      value={cliente.cedula_ruc}
                      onChange={handleClienteFieldChange}
                      required={mustCompleteManualClient}
                      disabled={loading}
                    />
                  </label>

                  <label className="create-user__field">
                    <span>Nombres</span>
                    <input
                      className={isClientFieldInvalid('nombres') ? 'create-solicitud__input--invalid' : ''}
                      name="nombres"
                      type="text"
                      value={cliente.nombres}
                      onChange={handleClienteFieldChange}
                      required={mustCompleteManualClient}
                      disabled={loading}
                    />
                  </label>

                  <label className="create-user__field">
                    <span>Apellidos</span>
                    <input
                      className={isClientFieldInvalid('apellidos') ? 'create-solicitud__input--invalid' : ''}
                      name="apellidos"
                      type="text"
                      value={cliente.apellidos}
                      onChange={handleClienteFieldChange}
                      required={mustCompleteManualClient}
                      disabled={loading}
                    />
                  </label>

                  <label className="create-user__field">
                    <span>Correo</span>
                    <input
                      className={isClientFieldInvalid('correo') ? 'create-solicitud__input--invalid' : ''}
                      name="correo"
                      type="email"
                      value={cliente.correo}
                      onChange={handleClienteFieldChange}
                      required={mustCompleteManualClient}
                      disabled={loading}
                    />
                  </label>

                  <label className="create-user__field">
                    <span>Teléfono</span>
                    <input
                      className={isClientFieldInvalid('telefono') ? 'create-solicitud__input--invalid' : ''}
                      name="telefono"
                      type="text"
                      value={cliente.telefono}
                      onChange={handleClienteFieldChange}
                      required={mustCompleteManualClient}
                      disabled={loading}
                    />
                  </label>

                  <label className="create-user__field create-user__field--full">
                    <span>Dirección</span>
                    <input
                      className={isClientFieldInvalid('direccion') ? 'create-solicitud__input--invalid' : ''}
                      name="direccion"
                      type="text"
                      value={cliente.direccion}
                      onChange={handleClienteFieldChange}
                      required={mustCompleteManualClient}
                      disabled={loading}
                    />
                  </label>
                </div>

                {showClientHint && (
                  <small className="muted">Cliente existente detectado. Se usara el registro actual al guardar.</small>
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





