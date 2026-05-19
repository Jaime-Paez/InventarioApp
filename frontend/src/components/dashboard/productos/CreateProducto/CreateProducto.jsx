import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import { API_URL, authFetch } from '../../../../utils/api'
import useModalAnimation from '../../common/useModalAnimation'
import { formatMoneyInput, parseMoneyInput } from '../../../../utils/moneyInput'

const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const initialForm = {
  codigo: '',
  nombre: '',
  descripcion: '',
  referencia: '',
  pieza_original: false,
  costo_minimo: '',
  precio: '',
  casasIds: [],
}

const parseNumber = (value) => parseMoneyInput(value)
const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const parseQuantity = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.floor(parsed))
}
const toUpperProductCode = (value) => String(value ?? '').toLocaleUpperCase('es-EC')

const mergeByIdList = (current, incoming) => {
  const map = new Map(
    (Array.isArray(current) ? current : []).map((item) => [String(item?.id ?? ''), item]).filter(([key]) => key)
  )
  ;(Array.isArray(incoming) ? incoming : []).forEach((item) => {
    const key = String(item?.id ?? '')
    if (!key) return
    map.set(key, item)
  })
  return Array.from(map.values())
}

const getBodegaSucursalId = (bodega) => String(bodega?.sucursal?.id ?? bodega?.sucursal_id ?? '')
const getDivisionBodegaId = (division) => String(division?.bodega?.id ?? division?.bodega_id ?? '')
const getSubdivisionDivisionId = (subdivision) => String(subdivision?.division?.id ?? subdivision?.division_id ?? '')
const getSubdivisionBodegaId = (subdivision) =>
  String(subdivision?.division?.bodega?.id ?? subdivision?.division?.bodega_id ?? '')
const normalizeScopeModuleKey = (value) => String(value ?? '').trim().toLowerCase()
const normalizeScopeBranchId = (value) => String(value ?? '').trim()
const getModuleScopeBranchIdSet = (rawScopes, moduleKey) => {
  const normalizedModuleKey = normalizeScopeModuleKey(moduleKey)
  if (!normalizedModuleKey) return null
  const moduleScope = (Array.isArray(rawScopes) ? rawScopes : []).find(
    (scope) => normalizeScopeModuleKey(scope?.modulo) === normalizedModuleKey
  )
  if (!moduleScope) return null
  const ids = (Array.isArray(moduleScope?.sucursales_ids) ? moduleScope.sucursales_ids : [])
    .map((branchId) => normalizeScopeBranchId(branchId))
    .filter(Boolean)
  return new Set(ids)
}

function CreateProducto({
  open,
  onClose,
  onCreated,
  token,
  onError,
  currentUser = null,
  showCostField = true,
  initialData = null,
  lockModal = false,
}) {
  const [formData, setFormData] = useState(initialForm)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [alternoQuery, setAlternoQuery] = useState('')
  const [alternoOptions, setAlternoOptions] = useState([])
  const [alternoLoading, setAlternoLoading] = useState(false)
  const [alternosSelected, setAlternosSelected] = useState([])
  const [showAlternoDropdown, setShowAlternoDropdown] = useState(false)
  const [alternoDraft, setAlternoDraft] = useState(null)
  const [alternoError, setAlternoError] = useState('')
  const [oemItems, setOemItems] = useState([])
  const [oemDraft, setOemDraft] = useState({ codigo: '' })
  const [oemError, setOemError] = useState('')
  const [showCasaDropdown, setShowCasaDropdown] = useState(false)
  const [suppliers, setSuppliers] = useState([])
  const [branches, setBranches] = useState([])
  const [bodegas, setBodegas] = useState([])
  const [divisions, setDivisions] = useState([])
  const [subdivisions, setSubdivisions] = useState([])
  const [locationBranchOptions, setLocationBranchOptions] = useState([])
  const [locationBodegaOptions, setLocationBodegaOptions] = useState([])
  const [locationDivisionOptions, setLocationDivisionOptions] = useState([])
  const [locationSubdivisionOptions, setLocationSubdivisionOptions] = useState([])
  const [showLocationBranchDropdown, setShowLocationBranchDropdown] = useState(false)
  const [showLocationBodegaDropdown, setShowLocationBodegaDropdown] = useState(false)
  const [showLocationDivisionDropdown, setShowLocationDivisionDropdown] = useState(false)
  const [showLocationSubdivisionDropdown, setShowLocationSubdivisionDropdown] = useState(false)
  const [locationBranchQuery, setLocationBranchQuery] = useState('')
  const [locationBodegaQuery, setLocationBodegaQuery] = useState('')
  const [locationDivisionQuery, setLocationDivisionQuery] = useState('')
  const [locationSubdivisionQuery, setLocationSubdivisionQuery] = useState('')
  const [locationSearchLoading, setLocationSearchLoading] = useState({
    sucursal: false,
    bodega: false,
    division: false,
    subdivision: false,
  })
  const [locationDraft, setLocationDraft] = useState({
    sucursalId: '',
    bodegaId: '',
    divisionId: '',
    subdivisionId: '',
    cantidad: '',
  })
  const [locations, setLocations] = useState([])
  const [locationsLoading, setLocationsLoading] = useState(false)
  const [locationError, setLocationError] = useState('')
  const [showLocationForm, setShowLocationForm] = useState(false)
  const [editingLocationKey, setEditingLocationKey] = useState(null)
  const [editingField, setEditingField] = useState(null)
  const [editingValue, setEditingValue] = useState('')
  const [editError, setEditError] = useState('')
  const [selectedCasa, setSelectedCasa] = useState(null)
  const [casaSearch, setCasaSearch] = useState('')
  const [codigoChecking, setCodigoChecking] = useState(false)
  const [codigoError, setCodigoError] = useState('')
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const casaDropdownRef = useRef(null)
  const alternoDropdownRef = useRef(null)
  const locationBranchDropdownRef = useRef(null)
  const locationBodegaDropdownRef = useRef(null)
  const locationDivisionDropdownRef = useRef(null)
  const locationSubdivisionDropdownRef = useRef(null)
  const locationSearchSeqRef = useRef({
    sucursal: 0,
    bodega: 0,
    division: 0,
    subdivision: 0,
  })
  const codigoCheckTimerRef = useRef(null)
  const codigoCheckSeqRef = useRef(0)
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const sizeRef = useRef(size)
  const positionRef = useRef(position)
  const restoreRef = useRef(null)

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
  const getViewportMetrics = () => {
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    return {
      availableWidth,
      availableHeight,
      minWidth: Math.min(MIN_WIDTH, availableWidth),
      minHeight: Math.min(MIN_HEIGHT, availableHeight),
    }
  }

  const notifyError = useCallback(
    (message) => {
      if (!message) return
      if (onError) {
        onError(message)
        return
      }
      console.error(message)
    },
    [onError]
  )

  useEffect(() => {
    if (!oemError) return
    notifyError(oemError)
  }, [notifyError, oemError])

  useEffect(() => {
    if (!alternoError) return
    notifyError(alternoError)
  }, [alternoError, notifyError])

  useEffect(() => {
    if (!locationError) return
    notifyError(locationError)
  }, [locationError, notifyError])

  useEffect(() => {
    if (!editError) return
    notifyError(editError)
  }, [editError, notifyError])

  const normalizeValue = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()

  const filteredSuppliers = useMemo(() => {
    const needle = normalizeValue(casaSearch)
    if (!needle) return []
    return suppliers
  }, [suppliers, casaSearch])

  const branchById = useMemo(
    () => new Map(branches.map((branch) => [String(branch.id), branch])),
    [branches]
  )
  const bodegaById = useMemo(
    () => new Map(bodegas.map((bodega) => [String(bodega.id), bodega])),
    [bodegas]
  )
  const divisionById = useMemo(
    () => new Map(divisions.map((division) => [String(division.id), division])),
    [divisions]
  )
  const subdivisionById = useMemo(
    () => new Map(subdivisions.map((subdivision) => [String(subdivision.id), subdivision])),
    [subdivisions]
  )
  const subdivisionsByDivision = useMemo(() => {
    const map = new Map()
    subdivisions.forEach((subdivision) => {
      const divisionId = getSubdivisionDivisionId(subdivision)
      if (!divisionId) return
      const key = String(divisionId)
      const list = map.get(key) || []
      list.push(subdivision)
      map.set(key, list)
    })
    return map
  }, [subdivisions])
  const subdivisionsByBodega = useMemo(() => {
    const map = new Map()
    subdivisions.forEach((subdivision) => {
      const bodegaId = getSubdivisionBodegaId(subdivision)
      if (!bodegaId) return
      const key = String(bodegaId)
      const list = map.get(key) || []
      list.push(subdivision)
      map.set(key, list)
    })
    return map
  }, [subdivisions])
  const selectedLocationBranch = useMemo(
    () => (locationDraft.sucursalId ? branchById.get(String(locationDraft.sucursalId)) || null : null),
    [branchById, locationDraft.sucursalId]
  )
  const selectedLocationBodega = useMemo(
    () => (locationDraft.bodegaId ? bodegaById.get(String(locationDraft.bodegaId)) || null : null),
    [bodegaById, locationDraft.bodegaId]
  )
  const selectedLocationDivision = useMemo(
    () => (locationDraft.divisionId ? divisionById.get(String(locationDraft.divisionId)) || null : null),
    [divisionById, locationDraft.divisionId]
  )
  const selectedLocationSubdivision = useMemo(
    () =>
      locationDraft.subdivisionId ? subdivisionById.get(String(locationDraft.subdivisionId)) || null : null,
    [locationDraft.subdivisionId, subdivisionById]
  )
  const scopedProductBranchIds = useMemo(
    () => getModuleScopeBranchIdSet(currentUser?.sucursales_por_modulo, 'productos'),
    [currentUser]
  )
  const canManageLocationBranch = useCallback(
    (branchId) => {
      if (!(scopedProductBranchIds instanceof Set)) return true
      const normalizedBranchId = normalizeScopeBranchId(branchId)
      if (!normalizedBranchId) return false
      return scopedProductBranchIds.has(normalizedBranchId)
    },
    [scopedProductBranchIds]
  )
  const canManageLocationDraft = useMemo(
    () => (!locationDraft.sucursalId ? true : canManageLocationBranch(locationDraft.sucursalId)),
    [locationDraft.sucursalId, canManageLocationBranch]
  )

  const createLocationUid = () => `loc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const searchSuppliers = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token) {
        setSuppliers([])
        return
      }
      try {
        const response = await authFetch(
          `${API_URL}/casa-comercial/casas/?search=${encodeURIComponent(term)}&page_size=5`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las casas comerciales.')
        const data = await response.json()
        const list = Array.isArray(data) ? data : data?.results || []
        setSuppliers(list)
      } catch (err) {
        notifyError(err.message || 'Ocurrió un error al cargar las casas comerciales.')
      }
    },
    [notifyError, token]
  )

  const setLocationLevelLoading = useCallback((level, value) => {
    setLocationSearchLoading((prev) => ({
      ...prev,
      [level]: value,
    }))
  }, [])

  const searchLocationBranches = useCallback(
    async (query = '') => {
      if (!token) return
      const seq = ++locationSearchSeqRef.current.sucursal
      const term = String(query ?? '').trim()
      setLocationLevelLoading('sucursal', true)
      try {
        const response = await authFetch(
          `${API_URL}/inventario/sucursales/?modulo=productos&page_size=40${
            term ? `&search=${encodeURIComponent(term)}` : ''
          }`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las sucursales.')
        const payload = await response.json()
        const list = parseApiList(payload)
        if (seq !== locationSearchSeqRef.current.sucursal) return
        setLocationBranchOptions(list)
        setBranches((prev) => mergeByIdList(prev, list))
      } catch (err) {
        notifyError(err?.message || 'No se pudieron cargar las sucursales.')
      } finally {
        if (seq === locationSearchSeqRef.current.sucursal) {
          setLocationLevelLoading('sucursal', false)
        }
      }
    },
    [notifyError, setLocationLevelLoading, token]
  )

  const searchLocationBodegas = useCallback(
    async (query = '', sucursalId = '', sucursalNombre = '') => {
      if (!token || !sucursalId) {
        setLocationBodegaOptions([])
        return
      }
      const seq = ++locationSearchSeqRef.current.bodega
      const term = String(query ?? '').trim()

      setLocationLevelLoading('bodega', true)
      try {
        const response = await authFetch(
          `${API_URL}/inventario/bodegas/?page_size=200&sucursal_id=${encodeURIComponent(
            String(sucursalId)
          )}&modulo=productos${
            term ? `&search=${encodeURIComponent(term)}` : ''
          }`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las bodegas.')
        const payload = await response.json()
        const list = parseApiList(payload)
        if (seq !== locationSearchSeqRef.current.bodega) return
        setLocationBodegaOptions(list)
        setBodegas((prev) => mergeByIdList(prev, list))
      } catch (err) {
        notifyError(err?.message || 'No se pudieron cargar las bodegas.')
      } finally {
        if (seq === locationSearchSeqRef.current.bodega) {
          setLocationLevelLoading('bodega', false)
        }
      }
    },
    [notifyError, setLocationLevelLoading, token]
  )

  const searchLocationDivisions = useCallback(
    async (query = '', bodegaId = '', bodegaNombre = '') => {
      if (!token || !bodegaId) {
        setLocationDivisionOptions([])
        return
      }
      const seq = ++locationSearchSeqRef.current.division
      const term = String(query ?? '').trim()

      setLocationLevelLoading('division', true)
      try {
        const response = await authFetch(
          `${API_URL}/inventario/divisiones/?page_size=200&bodega_id=${encodeURIComponent(
            String(bodegaId)
          )}&modulo=productos${
            term ? `&search=${encodeURIComponent(term)}` : ''
          }`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las divisiones.')
        const payload = await response.json()
        const list = parseApiList(payload)
        if (seq !== locationSearchSeqRef.current.division) return
        setLocationDivisionOptions(list)
        setDivisions((prev) => mergeByIdList(prev, list))
      } catch (err) {
        notifyError(err?.message || 'No se pudieron cargar las divisiones.')
      } finally {
        if (seq === locationSearchSeqRef.current.division) {
          setLocationLevelLoading('division', false)
        }
      }
    },
    [notifyError, setLocationLevelLoading, token]
  )

  const searchLocationSubdivisions = useCallback(
    async (query = '', divisionId = '', divisionNombre = '') => {
      if (!token || !divisionId) {
        setLocationSubdivisionOptions([])
        return
      }
      const seq = ++locationSearchSeqRef.current.subdivision
      const term = String(query ?? '').trim()

      setLocationLevelLoading('subdivision', true)
      try {
        const response = await authFetch(
          `${API_URL}/inventario/subdivisiones/?page_size=200&division_id=${encodeURIComponent(
            String(divisionId)
          )}&modulo=productos${
            term ? `&search=${encodeURIComponent(term)}` : ''
          }`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las subdivisiones.')
        const payload = await response.json()
        const list = parseApiList(payload)
        if (seq !== locationSearchSeqRef.current.subdivision) return
        setLocationSubdivisionOptions(list)
        setSubdivisions((prev) => mergeByIdList(prev, list))
      } catch (err) {
        notifyError(err?.message || 'No se pudieron cargar las subdivisiones.')
      } finally {
        if (seq === locationSearchSeqRef.current.subdivision) {
          setLocationLevelLoading('subdivision', false)
        }
      }
    },
    [notifyError, setLocationLevelLoading, token]
  )

  const ensureSubdivisionsForBodega = useCallback(
    async (bodegaId, bodegaNombre = '') => {
      const key = String(bodegaId || '')
      if (!key || !token) return
      if ((subdivisionsByBodega.get(key) || []).length) return

      try {
        const response = await authFetch(
          `${API_URL}/inventario/subdivisiones/?page_size=200&bodega_id=${encodeURIComponent(key)}&modulo=productos`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las subdivisiones.')
        const payload = await response.json()
        const list = parseApiList(payload)
        if (!list.length) return
        setSubdivisions((prev) => mergeByIdList(prev, list))
      } catch (err) {
        notifyError(err?.message || 'No se pudieron cargar las subdivisiones.')
      }
    },
    [notifyError, subdivisionsByBodega, token]
  )
  const searchAlternos = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token) {
        setAlternoOptions([])
        return
      }
      setAlternoLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=5`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar los productos.')
        const data = await response.json()
        const list = Array.isArray(data) ? data : data?.results || []
        setAlternoOptions(list)
      } catch (err) {
        notifyError(err.message || 'Ocurrió un error al buscar productos.')
      } finally {
        setAlternoLoading(false)
      }
    },
    [notifyError, token]
  )

  useEffect(() => {
    if (!open) return
    const nextInitialData = initialData && typeof initialData === 'object' ? initialData : {}
    const nextCodigo = toUpperProductCode(nextInitialData.codigo).trim()
    const nextNombre = String(nextInitialData.nombre || '').trim()
    const nextDescripcion = String(nextInitialData.descripcion || '').trim()
    const nextOemItems = Array.isArray(nextInitialData.oemItems)
      ? nextInitialData.oemItems
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .map((codigo) => ({ codigo, descripcion: '' }))
      : []

    setFormData({
      ...initialForm,
      codigo: nextCodigo,
      nombre: nextNombre,
      descripcion: nextDescripcion,
      referencia: String(nextInitialData.referencia || '').trim(),
    })
    setCasaSearch('')
    setLoading(false)
    setActiveTab('general')
    setAlternoQuery('')
    setAlternoOptions([])
    setAlternosSelected([])
    setAlternoLoading(false)
    setShowAlternoDropdown(false)
    setAlternoDraft(null)
    setAlternoError('')
    setOemItems(nextOemItems)
    setOemDraft({ codigo: '' })
    setOemError('')
    setShowCasaDropdown(false)
    setIsMaximized(false)
    setSelectedCasa(null)
    setBranches([])
    setBodegas([])
    setDivisions([])
    setSubdivisions([])
    setLocationBranchOptions([])
    setLocationBodegaOptions([])
    setLocationDivisionOptions([])
    setLocationSubdivisionOptions([])
    setShowLocationBranchDropdown(false)
    setShowLocationBodegaDropdown(false)
    setShowLocationDivisionDropdown(false)
    setShowLocationSubdivisionDropdown(false)
    setLocationBranchQuery('')
    setLocationBodegaQuery('')
    setLocationDivisionQuery('')
    setLocationSubdivisionQuery('')
    setLocationSearchLoading({
      sucursal: false,
      bodega: false,
      division: false,
      subdivision: false,
    })
    setLocations([])
    setLocationDraft({
      sucursalId: '',
      bodegaId: '',
      divisionId: '',
      subdivisionId: '',
      cantidad: '',
    })
    setLocationError('')
    setLocationsLoading(false)
    setShowLocationForm(false)
    setEditingLocationKey(null)
    setEditingField(null)
    setEditingValue('')
    setEditError('')
    restoreRef.current = null
    if (codigoCheckTimerRef.current) {
      clearTimeout(codigoCheckTimerRef.current)
      codigoCheckTimerRef.current = null
    }
    codigoCheckSeqRef.current = 0
    locationSearchSeqRef.current = {
      sucursal: 0,
      bodega: 0,
      division: 0,
      subdivision: 0,
    }
    setCodigoChecking(false)
    setCodigoError('')
    setSubmitAttempted(false)
    setSuppliers([])
    setLocationsLoading(true)
    searchLocationBranches('').finally(() => {
      setLocationsLoading(false)
    })
  }, [initialData, open, searchLocationBranches])

  useEffect(
    () => () => {
      if (codigoCheckTimerRef.current) {
        clearTimeout(codigoCheckTimerRef.current)
      }
    },
    []
  )

  useEffect(() => {
    const term = casaSearch.trim()
    if (!term) {
      setSuppliers([])
      return
    }
    const handle = setTimeout(() => {
      searchSuppliers(term)
    }, 300)
    return () => clearTimeout(handle)
  }, [casaSearch, searchSuppliers])

  useEffect(() => {
    const term = alternoQuery.trim()
    if (!term) {
      setAlternoOptions([])
      return
    }
    const handle = setTimeout(() => {
      searchAlternos(term)
    }, 300)
    return () => clearTimeout(handle)
  }, [alternoQuery, searchAlternos])

  useEffect(() => {
    if (!open || !showLocationForm || !showLocationBranchDropdown) return
    const handle = setTimeout(() => {
      searchLocationBranches(locationBranchQuery)
    }, 300)
    return () => clearTimeout(handle)
  }, [locationBranchQuery, open, searchLocationBranches, showLocationBranchDropdown, showLocationForm])

  useEffect(() => {
    if (!open || !showLocationForm || !showLocationBodegaDropdown || !locationDraft.sucursalId) return
    const handle = setTimeout(() => {
      searchLocationBodegas(
        locationBodegaQuery,
        locationDraft.sucursalId,
        selectedLocationBranch?.nombre || ''
      )
    }, 300)
    return () => clearTimeout(handle)
  }, [
    locationBodegaQuery,
    locationDraft.sucursalId,
    open,
    searchLocationBodegas,
    selectedLocationBranch,
    showLocationBodegaDropdown,
    showLocationForm,
  ])

  useEffect(() => {
    if (!open || !showLocationForm || !showLocationDivisionDropdown || !locationDraft.bodegaId) return
    const handle = setTimeout(() => {
      searchLocationDivisions(
        locationDivisionQuery,
        locationDraft.bodegaId,
        selectedLocationBodega?.nombre || ''
      )
    }, 300)
    return () => clearTimeout(handle)
  }, [
    locationDivisionQuery,
    locationDraft.bodegaId,
    open,
    searchLocationDivisions,
    selectedLocationBodega,
    showLocationDivisionDropdown,
    showLocationForm,
  ])

  useEffect(() => {
    if (!open || !showLocationForm || !showLocationSubdivisionDropdown || !locationDraft.divisionId) return
    const handle = setTimeout(() => {
      searchLocationSubdivisions(
        locationSubdivisionQuery,
        locationDraft.divisionId,
        selectedLocationDivision?.nombre || ''
      )
    }, 300)
    return () => clearTimeout(handle)
  }, [
    locationDraft.divisionId,
    locationSubdivisionQuery,
    open,
    searchLocationSubdivisions,
    selectedLocationDivision,
    showLocationForm,
    showLocationSubdivisionDropdown,
  ])

  useEffect(() => {
    const handleClick = (event) => {
      if (showAlternoDropdown && alternoDropdownRef.current && !alternoDropdownRef.current.contains(event.target)) {
        setShowAlternoDropdown(false)
      }
      if (showCasaDropdown && casaDropdownRef.current && !casaDropdownRef.current.contains(event.target)) {
        setShowCasaDropdown(false)
      }
      if (
        showLocationBranchDropdown &&
        locationBranchDropdownRef.current &&
        !locationBranchDropdownRef.current.contains(event.target)
      ) {
        setShowLocationBranchDropdown(false)
      }
      if (
        showLocationBodegaDropdown &&
        locationBodegaDropdownRef.current &&
        !locationBodegaDropdownRef.current.contains(event.target)
      ) {
        setShowLocationBodegaDropdown(false)
      }
      if (
        showLocationDivisionDropdown &&
        locationDivisionDropdownRef.current &&
        !locationDivisionDropdownRef.current.contains(event.target)
      ) {
        setShowLocationDivisionDropdown(false)
      }
      if (
        showLocationSubdivisionDropdown &&
        locationSubdivisionDropdownRef.current &&
        !locationSubdivisionDropdownRef.current.contains(event.target)
      ) {
        setShowLocationSubdivisionDropdown(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [
    showAlternoDropdown,
    showCasaDropdown,
    showLocationBodegaDropdown,
    showLocationBranchDropdown,
    showLocationDivisionDropdown,
    showLocationSubdivisionDropdown,
  ])

  useLayoutEffect(() => {
    if (!open) return
    const { availableWidth, availableHeight } = getViewportMetrics()
    const nextWidth = Math.min(MIN_WIDTH, availableWidth)
    const nextHeight = Math.min(MIN_HEIGHT, availableHeight)
    setSize({ width: nextWidth, height: nextHeight })

    const centeredX = (window.innerWidth - nextWidth) / 2
    const centeredY = (window.innerHeight - nextHeight) / 2
    setPosition({ x: Math.max(centeredX, VIEWPORT_PADDING), y: Math.max(centeredY, VIEWPORT_PADDING) })
  }, [open])

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    positionRef.current = position
  }, [position])

  const handleChange = (event) => {
    const { name, value, type, checked } = event.target
    if (name === 'pieza_original') {
      setFormData((prev) => ({
        ...prev,
        pieza_original: type === 'checkbox' ? checked : value === 'true',
      }))
      return
    }
    if (name === 'codigo') {
      const normalizedCode = toUpperProductCode(value)
      setFormData((prev) => ({
        ...prev,
        codigo: normalizedCode,
      }))
      scheduleCodigoCheck(normalizedCode)
      return
    }
    if (name === 'precio' || name === 'costo_minimo') {
      setFormData((prev) => ({
        ...prev,
        [name]: formatMoneyInput(value),
      }))
      return
    }
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const scheduleCodigoCheck = useCallback(
    (value) => {
      if (codigoCheckTimerRef.current) {
        clearTimeout(codigoCheckTimerRef.current)
        codigoCheckTimerRef.current = null
      }

      const term = String(value ?? '').trim()
      if (!term || !token) {
        setCodigoChecking(false)
        setCodigoError('')
        return
      }

      setCodigoChecking(true)
      setCodigoError('')
      const seq = ++codigoCheckSeqRef.current

      codigoCheckTimerRef.current = setTimeout(async () => {
        try {
          const response = await authFetch(
            `${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=5`,
            {},
            token
          )
          if (!response.ok) throw new Error('No se pudo validar el codigo.')
          const data = await response.json()
          if (seq !== codigoCheckSeqRef.current) return
          const list = Array.isArray(data) ? data : data?.results || []
          const exists = list.some(
            (item) => String(item?.codigo ?? '').trim().toLowerCase() === term.toLowerCase()
          )
          setCodigoError(exists ? 'Este codigo ya existe.' : '')
        } catch {
          if (seq !== codigoCheckSeqRef.current) return
          setCodigoError('')
        } finally {
          if (seq === codigoCheckSeqRef.current) {
            setCodigoChecking(false)
          }
        }
      }, 350)
    },
    [token]
  )

  const handleCasaToggle = (supplier) => {
    if (!supplier) return
    const id = String(supplier.id)
    if (!id) return
    let didSelect = false
    setFormData((prev) => {
      const current = (prev.casasIds || []).map(String)
      if (current.includes(id)) {
        setSelectedCasa(null)
        return { ...prev, casasIds: [] }
      }
      didSelect = true
      setSelectedCasa({ id: supplier.id, nombre: supplier.nombre })
      return { ...prev, casasIds: [id] }
    })
    setCasaSearch('')
    setShowCasaDropdown(false)
  }

  const alternoIdSet = useMemo(
    () => new Set(alternosSelected.map((item) => String(item?.id)).filter(Boolean)),
    [alternosSelected]
  )

  const handleAlternoSelect = (product) => {
    if (!product) return
    setAlternoDraft({
      id: product.id,
      codigo: product.codigo,
      nombre: product.nombre,
      descripcion: product.descripcion,
    })
    setAlternoError('')
    setShowAlternoDropdown(false)
  }

  const handleAddAlterno = (product) => {
    if (!product) return false
    const id = String(product.id)
    if (!id) return false
    if (alternoIdSet.has(id)) {
      setAlternoError('Ese producto ya esta en la tabla.')
      return false
    }
    setAlternosSelected((prev) => [
      ...prev,
      {
        id: product.id,
        codigo: product.codigo,
        nombre: product.nombre,
        descripcion: product.descripcion,
      },
    ])
    setAlternoError('')
    return true
  }

  const handleAddAlternoDraft = () => {
    if (!alternoDraft?.id) {
      setAlternoError('Selecciona un producto alterno.')
      return
    }
    const added = handleAddAlterno(alternoDraft)
    if (!added) return
    setAlternoDraft(null)
    setAlternoQuery('')
    setAlternoOptions([])
    setShowAlternoDropdown(false)
  }

  const handleRemoveAlterno = (id) => {
    const key = String(id)
    if (!key) return
    setAlternosSelected((prev) => prev.filter((item) => String(item?.id) !== key))
    setAlternoError('')
  }

  const normalizeOemCode = (value) => String(value ?? '').trim().toLowerCase()
  const oemCodeSet = useMemo(
    () => new Set(oemItems.map((item) => normalizeOemCode(item?.codigo)).filter(Boolean)),
    [oemItems]
  )

  const handleOemDraftChange = (field, value) => {
    setOemDraft((prev) => ({
      ...prev,
      [field]: value,
    }))
    setOemError('')
  }

  const handleAddOem = () => {
    const codigo = String(oemDraft.codigo ?? '').trim()
    if (!codigo) {
      setOemError('Ingresa un codigo OEM.')
      return
    }
    const key = normalizeOemCode(codigo)
    if (oemCodeSet.has(key)) {
      setOemError('Ese codigo OEM ya esta en la tabla.')
      return
    }
    setOemItems((prev) => [...prev, { codigo }])
    setOemDraft({ codigo: '' })
    setOemError('')
  }

  const handleRemoveOem = (codigo) => {
    const key = normalizeOemCode(codigo)
    if (!key) return
    setOemItems((prev) => prev.filter((item) => normalizeOemCode(item?.codigo) !== key))
    setOemError('')
  }

  const handleLocationSelect = (field, value) => {
    setLocationError('')
    if (field === 'sucursalId') {
      setLocationBodegaOptions([])
      setLocationDivisionOptions([])
      setLocationSubdivisionOptions([])
      setLocationBodegaQuery('')
      setLocationDivisionQuery('')
      setLocationSubdivisionQuery('')
      setShowLocationBodegaDropdown(false)
      setShowLocationDivisionDropdown(false)
      setShowLocationSubdivisionDropdown(false)
    }
    if (field === 'bodegaId') {
      setLocationDivisionOptions([])
      setLocationSubdivisionOptions([])
      setLocationDivisionQuery('')
      setLocationSubdivisionQuery('')
      setShowLocationDivisionDropdown(false)
      setShowLocationSubdivisionDropdown(false)
    }
    if (field === 'divisionId') {
      setLocationSubdivisionOptions([])
      setLocationSubdivisionQuery('')
      setShowLocationSubdivisionDropdown(false)
    }
    setLocationDraft((prev) => {
      if (field === 'sucursalId') {
        return {
          ...prev,
          sucursalId: value,
          bodegaId: '',
          divisionId: '',
          subdivisionId: '',
        }
      }
      if (field === 'bodegaId') {
        return {
          ...prev,
          bodegaId: value,
          divisionId: '',
          subdivisionId: '',
        }
      }
      if (field === 'divisionId') {
        return {
          ...prev,
          divisionId: value,
          subdivisionId: '',
        }
      }
      return {
        ...prev,
        [field]: value,
      }
    })
  }

  const handleLocationBranchPick = (branch) => {
    if (!branch?.id) return
    if (!canManageLocationBranch(branch.id)) {
      setLocationError('No tienes permisos para crear ubicaciones en esta sucursal.')
      return
    }
    handleLocationSelect('sucursalId', String(branch.id))
    setShowLocationBranchDropdown(false)
    setLocationBranchQuery('')
  }

  const handleLocationBodegaPick = (bodega) => {
    if (!bodega?.id) return
    handleLocationSelect('bodegaId', String(bodega.id))
    setShowLocationBodegaDropdown(false)
    setLocationBodegaQuery('')
  }

  const handleLocationDivisionPick = (division) => {
    if (!division?.id) return
    handleLocationSelect('divisionId', String(division.id))
    setShowLocationDivisionDropdown(false)
    setLocationDivisionQuery('')
  }

  const handleLocationSubdivisionPick = (subdivision) => {
    if (!subdivision?.id) return
    handleLocationSelect('subdivisionId', String(subdivision.id))
    setShowLocationSubdivisionDropdown(false)
    setLocationSubdivisionQuery('')
  }

  const handleAddLocation = () => {
    const sucursalId = locationDraft.sucursalId
    const bodegaId = locationDraft.bodegaId
    const divisionId = locationDraft.divisionId
    const subdivisionId = locationDraft.subdivisionId
    const quantity = parseQuantity(locationDraft.cantidad)

    if (!sucursalId) {
      setLocationError('Selecciona una sucursal.')
      return
    }
    if (!canManageLocationBranch(sucursalId)) {
      setLocationError('No tienes permisos para crear ubicaciones en esta sucursal.')
      return
    }
    if (!bodegaId) {
      setLocationError('Selecciona una bodega.')
      return
    }
    if (!divisionId) {
      setLocationError('Selecciona una division.')
      return
    }
    if (!subdivisionId) {
      setLocationError('Selecciona una subdivisión.')
      return
    }
    const allowedSubs = subdivisionsByDivision.get(String(divisionId)) || []
    if (!allowedSubs.some((sub) => String(sub.id) === String(subdivisionId))) {
      setLocationError('La subdivision no pertenece a la division seleccionada.')
      return
    }
    const safeQuantity = quantity && quantity > 0 ? quantity : 1

    const subdivision = subdivisionById.get(String(subdivisionId))
    if (!subdivision) {
      setLocationError('Selecciona una subdivision valida.')
      return
    }
    const subdivisionDivisionId = getSubdivisionDivisionId(subdivision)
    if (subdivisionDivisionId && subdivisionDivisionId !== String(divisionId)) {
      setLocationError('La subdivision no pertenece a la division seleccionada.')
      return
    }

    const division = divisionById.get(String(divisionId))
    const bodega = bodegaById.get(String(bodegaId))
    const branch = branchById.get(String(sucursalId))
    const divisionName = division?.nombre || subdivision?.division?.nombre || '-'

    const nextEntry = {
      uid: createLocationUid(),
      sucursalId: String(sucursalId),
      sucursalNombre: branch?.nombre || '-',
      bodegaId: String(bodegaId),
      bodegaNombre: bodega?.nombre || '-',
      divisionId: String(divisionId),
      divisionNombre: divisionName || '-',
      subdivisionId: String(subdivisionId),
      subdivisionNombre: subdivision?.nombre || '-',
      cantidad: safeQuantity,
    }

    setLocations((prev) => {
      const index = prev.findIndex((item) => item.subdivisionId === nextEntry.subdivisionId)
      if (index === -1) return [...prev, nextEntry]
      const updated = [...prev]
      updated[index] = { ...nextEntry, uid: prev[index].uid }
      return updated
    })

    setLocationDraft((prev) => ({
      ...prev,
      divisionId: '',
      subdivisionId: '',
      cantidad: '1',
    }))
    setLocationError('')
  }

  const handleRemoveLocation = (uid) => {
    const key = String(uid)
    if (!key) return
    const targetLocation = locations.find((item) => String(item.uid) === key)
    if (targetLocation && !canManageLocationBranch(targetLocation.sucursalId)) {
      setEditError('No tienes permisos para editar ubicaciones en esta sucursal.')
      return
    }
    setLocations((prev) => prev.filter((item) => item.uid !== key))
    if (editingLocationKey === key) {
      setEditingLocationKey(null)
      setEditingField(null)
      setEditingValue('')
      setEditError('')
    }
  }

  const beginLocationEdit = (location, field) => {
    if (!canManageLocationBranch(location?.sucursalId)) {
      setEditError('No tienes permisos para editar ubicaciones en esta sucursal.')
      return
    }
    setEditError('')
    if (field === 'subdivision') {
      ensureSubdivisionsForBodega(location?.bodegaId, location?.bodegaNombre)
    }
    setEditingLocationKey(location.uid)
    setEditingField(field)
    if (field === 'cantidad') {
      setEditingValue(String(location.cantidad ?? ''))
      return
    }
    if (field === 'subdivision') {
      setEditingValue(String(location.subdivisionId ?? ''))
    }
  }

  const cancelLocationEdit = () => {
    setEditingLocationKey(null)
    setEditingField(null)
    setEditingValue('')
    setEditError('')
  }

  const commitLocationEdit = (overrideValue) => {
    if (!editingLocationKey || !editingField) return
    const value = overrideValue ?? editingValue

    setLocations((prev) => {
      const index = prev.findIndex((item) => item.uid === editingLocationKey)
      if (index === -1) return prev
      const current = prev[index]

      if (editingField === 'cantidad') {
        const quantity = parseQuantity(value)
        if (!quantity || quantity <= 0) {
          setEditError('Ingresa una cantidad valida.')
          return prev
        }
        const updated = [...prev]
        updated[index] = { ...current, cantidad: quantity }
        cancelLocationEdit()
        return updated
      }

      if (editingField === 'subdivision') {
        const newId = String(value || '')
        if (!newId) {
          setEditError('Selecciona una subdivision.')
          return prev
        }
        if (prev.some((item) => item.subdivisionId === newId && item.uid !== current.uid)) {
          setEditError('Esa subdivision ya esta en la tabla.')
          return prev
        }
        const subdivision = subdivisionById.get(newId)
        if (!subdivision) {
          setEditError('Subdivision no valida.')
          return prev
        }
        const divisionId = subdivision?.division?.id
        const updated = [...prev]
        updated[index] = {
          ...current,
          subdivisionId: newId,
          subdivisionNombre: subdivision.nombre || current.subdivisionNombre,
          divisionId: divisionId != null ? String(divisionId) : current.divisionId,
          divisionNombre: subdivision?.division?.nombre || current.divisionNombre,
        }
        cancelLocationEdit()
        return updated
      }

      return prev
    })
  }

  const saveInventoryLocations = async (productId) => {
    if (!productId || !locations.length) return []
    const errors = []
    for (const location of locations) {
      const quantity = parseQuantity(location.cantidad)
      if (!quantity || quantity <= 0) continue
      try {
        const response = await authFetch(
          `${API_URL}/inventario/inventario/`,
          {
            method: 'POST',
            body: JSON.stringify({
              producto_id: productId,
              subdivision_id: Number(location.subdivisionId),
              referencia: '',
              cantidad: quantity,
            }),
          },
          token
        )
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          const detail = data?.detail || 'No se pudo asignar una ubicación.'
          throw new Error(detail)
        }
      } catch (err) {
        errors.push(err?.message || 'No se pudo asignar una ubicación.')
      }
    }
    return errors
  }

  const ensureOemId = async (item) => {
    const codigo = String(item?.codigo ?? '').trim()
    if (!codigo) return null
    const payload = {
      codigo,
      descripcion: String(item?.descripcion ?? '').trim(),
    }

    const searchResponse = await authFetch(
      `${API_URL}/productos/oem/?search=${encodeURIComponent(codigo)}&page_size=5`,
      {},
      token
    )
    if (searchResponse.ok) {
      const searchData = await searchResponse.json().catch(() => ({}))
      const list = parseApiList(searchData)
      const match = list.find(
        (oem) => String(oem?.codigo ?? '').trim().toLowerCase() === codigo.toLowerCase()
      )
      if (match?.id) return match.id
    }

    const createResponse = await authFetch(
      `${API_URL}/productos/oem/`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token
    )

    if (createResponse.ok) {
      const created = await createResponse.json().catch(() => ({}))
      return created?.id ?? null
    }

    // Fallback por carrera: si otro proceso lo creó entre el search y este POST.
    const retrySearchResponse = await authFetch(
      `${API_URL}/productos/oem/?search=${encodeURIComponent(codigo)}&page_size=5`,
      {},
      token
    )
    if (!retrySearchResponse.ok) return null
    const retryData = await retrySearchResponse.json().catch(() => ({}))
    const retryList = parseApiList(retryData)
    const retryMatch = retryList.find(
      (oem) => String(oem?.codigo ?? '').trim().toLowerCase() === codigo.toLowerCase()
    )
    return retryMatch?.id ?? null
  }

  const saveOems = async (productId) => {
    if (!productId || !oemItems.length) return []
    const errors = []
    const seen = new Set()
    const unique = []
    oemItems.forEach((item) => {
      const key = normalizeOemCode(item?.codigo)
      if (!key || seen.has(key)) return
      seen.add(key)
      unique.push(item)
    })

    for (const item of unique) {
      try {
        const oemId = await ensureOemId(item)
        if (!oemId) {
          throw new Error('No se pudo registrar el OEM.')
        }
        const relationResponse = await authFetch(
          `${API_URL}/productos/oem-producto/`,
          {
            method: 'POST',
            body: JSON.stringify({
              producto_id: productId,
              oem_id: oemId,
            }),
          },
          token
        )
        if (!relationResponse.ok) {
          const data = await relationResponse.json().catch(() => ({}))
          const detail = data?.detail || 'No se pudo registrar el OEM.'
          throw new Error(detail)
        }
      } catch (err) {
        errors.push(err?.message || 'No se pudo registrar el OEM.')
      }
    }

    return errors
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setSubmitAttempted(true)
    if (codigoChecking) {
      setActiveTab('general')
      notifyError('Estamos validando el codigo, espera un momento.')
      return
    }
    if (codigoError) {
      setActiveTab('general')
      notifyError(codigoError)
      return
    }

    const payload = {
      codigo: toUpperProductCode(formData.codigo).trim(),
      nombre: formData.nombre.trim(),
      descripcion: formData.descripcion.trim(),
      referencia: formData.referencia.trim(),
      pieza_original: Boolean(formData.pieza_original),
      costo_minimo: parseNumber(formData.costo_minimo),
      precio: parseNumber(formData.precio),
      casas_comerciales_ids: (formData.casasIds || []).map((id) => Number(id)),
    }

    const hasMissingRequiredFields = Boolean(
      !payload.codigo ||
      !payload.nombre ||
      !payload.casas_comerciales_ids.length ||
      payload.precio === null
    )

    if (hasMissingRequiredFields) {
      setActiveTab('general')
      notifyError('Completa los campos requeridos resaltados.')
      return
    }

    setLoading(true)

    try {
      const response = await authFetch(
        `${API_URL}/productos/listado/`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail =
          data?.detail ||
          data?.codigo?.[0] ||
          data?.nombre?.[0] ||
          data?.descripcion?.[0] ||
          data?.precio?.[0] ||
          data?.casas_comerciales_ids?.[0] ||
          'No se pudo crear el producto.'
        throw new Error(detail)
      }

      if (data?.id && alternosSelected.length) {
        const uniqueIds = Array.from(
          new Set(alternosSelected.map((item) => item?.id).filter(Boolean))
        ).filter((id) => id !== data.id)
        const errors = []
        for (const alternoId of uniqueIds) {
          try {
            const alternoResponse = await authFetch(
              `${API_URL}/productos/alternos/`,
              {
                method: 'POST',
                body: JSON.stringify({
                  producto_id: data.id,
                  alterno_id: alternoId,
                }),
              },
              token
            )
            if (!alternoResponse.ok) {
              const alternoData = await alternoResponse.json().catch(() => ({}))
              const detail = alternoData?.detail || 'No se pudo registrar un producto alterno.'
              throw new Error(detail)
            }
          } catch (err) {
            errors.push(err?.message || 'No se pudo registrar un producto alterno.')
          }
        }
        if (errors.length) {
          notifyError(`Se creo el producto, pero fallaron ${errors.length} alternos.`)
        }
      }

      if (data?.id && oemItems.length) {
        const errors = await saveOems(data.id)
        if (errors.length) {
          notifyError(`Se creo el producto, pero fallaron ${errors.length} OEMs.`)
        }
      }

      if (data?.id && locations.length) {
        const errors = await saveInventoryLocations(data.id)
        if (errors.length) {
          notifyError(`Se creo el producto, pero fallaron ${errors.length} ubicaciones.`)
        }
      }

      setFormData(initialForm)
      setAlternosSelected([])
      setOemItems([])
      setOemDraft({ codigo: '' })
      setOemError('')
      setLocations([])
      setLocationDraft({
        sucursalId: '',
        bodegaId: '',
        divisionId: '',
        subdivisionId: '',
        cantidad: '1',
      })
      setSubmitAttempted(false)
      await onCreated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al crear el producto.')
    } finally {
      setLoading(false)
    }
  }

  const handleMouseDown = (event) => {
    if (lockModal) return
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
    if (lockModal || isMaximized) return
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
          x: Math.min(Math.max(prevPosition.x, VIEWPORT_PADDING), Math.max(window.innerWidth - width - VIEWPORT_PADDING, VIEWPORT_PADDING)),
          y: Math.min(Math.max(prevPosition.y, VIEWPORT_PADDING), Math.max(window.innerHeight - height - VIEWPORT_PADDING, VIEWPORT_PADDING)),
        }))

        return { width, height }
      })
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [isMaximized])

  const toggleMaximize = () => {
    if (lockModal) return
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
  const { shouldRender, isClosing } = useModalAnimation(open)

  if (!shouldRender) return null

  const overlayStyle = {
    padding: `${VIEWPORT_PADDING}px`,
    ...(lockModal
      ? {
          background: 'rgba(15, 23, 42, 0.28)',
          backdropFilter: 'blur(1px)',
          zIndex: 10030,
          pointerEvents: 'auto',
        }
      : {}),
  }
  const modalStyle = {
    top: position.y,
    left: position.x,
    width: size.width,
    height: size.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
  }
  const precioInvalid = submitAttempted && parseNumber(formData.precio) === null
  const casaInvalid =
    submitAttempted && !(Array.isArray(formData.casasIds) && formData.casasIds.length)
  const loadingMessage = lockModal ? 'Creando y vinculando producto...' : 'Creando producto...'

  return (
    <div
      className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`}
      role="dialog"
      aria-modal="true"
      style={overlayStyle}
      onMouseDown={lockModal ? (event) => event.stopPropagation() : undefined}
      onClick={lockModal ? (event) => event.stopPropagation() : undefined}
    >
      <div className={`create-user__modal${submitAttempted ? ' create-user__modal--submitted' : ''}${isClosing ? ' create-user__modal--closing' : ''}`} ref={modalRef} style={modalStyle}>
        {loading ? (
          <div className="create-user__loading-overlay" role="status" aria-live="polite">
            <i className="pi pi-spin pi-spinner" aria-hidden="true" />
            <span>{loadingMessage}</span>
          </div>
        ) : null}
        <header
          className="create-user__header"
          onMouseDown={lockModal ? undefined : handleMouseDown}
          style={lockModal ? { cursor: 'default' } : undefined}
        >
          <div
            className="create-user__header-text"
            style={lockModal ? { cursor: 'default' } : undefined}
          >
            <h3>Crear nuevo producto</h3>
          </div>
          <div className="create-user__header-actions">
            <button
              type="button"
              className="create-user__icon-button create-user__icon-button--maximize"
              style={lockModal ? { display: 'none' } : undefined}
              hidden={lockModal}
              tabIndex={lockModal ? -1 : undefined}
              aria-hidden={lockModal ? 'true' : undefined}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={toggleMaximize}
              aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
            >
              <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="create-user__icon-button"
              disabled={loading}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={onClose}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <form className={`create-user__form create-user__form--create${submitAttempted ? ' create-user__form--submitted' : ''}`} noValidate onSubmitCapture={(event) => event.currentTarget.classList.add('create-user__form--submitted')} onSubmit={handleSubmit}>
          <div className="create-user__tabs" role="tablist" aria-label="Secciones del producto">
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'general' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('general')}
              aria-selected={activeTab === 'general'}
            >
              General
            </button>
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'ubicaciones' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('ubicaciones')}
              aria-selected={activeTab === 'ubicaciones'}
            >
              Ubicaciones
            </button>
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'alternos' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('alternos')}
              aria-selected={activeTab === 'alternos'}
            >
              Alternos
            </button>
          </div>

          <div className="create-user__body">
            {activeTab === 'general' && (
              <>
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <h4>Datos del producto</h4>
                    </div>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field">
                      <span>Código JP</span>
                      <input
                        name="codigo"
                        type="text"
                        placeholder="Código del producto (ej: FRD-123)"
                        value={formData.codigo}
                        onChange={handleChange}
                        autoCapitalize="characters"
                        spellCheck={false}
                        disabled={loading}
                      />
                      {codigoChecking && <small className="muted">Validando codigo...</small>}
                      {!codigoChecking && codigoError && <small className="create-user__field-error">{codigoError}</small>}
                    </label>

                    <label className="create-user__field create-user__field--required">
                      <span>Descripción</span>
                      <input
                        name="nombre"
                        type="text"
                        placeholder="Descripción del producto"
                        value={formData.nombre}
                        onChange={handleChange}
                        required
                        disabled={loading}
                      />
                    </label>

                    <label className="create-user__field create-user__field--required">
                      <span>Casa comercial</span>
                      <div className={`create-user__dropdown${casaInvalid ? ' create-user__dropdown--invalid' : ''}`} ref={casaDropdownRef}>
                        <button
                          type="button"
                          className="create-user__dropdown-trigger"
                          onClick={() => {
                            setShowCasaDropdown((prev) => !prev)
                          }}
                          disabled={loading}
                        >
                          <span>{selectedCasa?.nombre || 'Selecciona una casa comercial'}</span>
                          <i className={`pi pi-chevron-${showCasaDropdown ? 'up' : 'down'}`} />
                        </button>

                        {showCasaDropdown && (
                          <div className="create-user__dropdown-panel">
                            <div className="create-user__dropdown-search">
                              <i className="pi pi-search" />
                              <input
                                type="text"
                                placeholder="Buscar casas comerciales"
                                value={casaSearch}
                                onChange={(event) => setCasaSearch(event.target.value)}
                              />
                            </div>

                            <div className="create-user__dropdown-results">
                              {!casaSearch.trim() && <small className="muted">Escribe para buscar.</small>}
                              {casaSearch.trim() && !filteredSuppliers.length && (
                                <small className="muted">Sin resultados.</small>
                              )}
                              {filteredSuppliers.map((supplier) => {
                                return (
                                  <button
                                    key={supplier.id}
                                    type="button"
                                    className="create-user__result-option"
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={(event) => {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      handleCasaToggle(supplier)
                                    }}
                                    disabled={loading}
                                  >
                                    <div className="create-user__result-info">
                                      <strong>{supplier.nombre}</strong>
                                      <small>{supplier.codigo ? `Código: ${supplier.codigo}` : `ID: ${supplier.id}`}</small>
                                    </div>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                      {casaInvalid && <small className="create-user__field-error">Selecciona una casa comercial.</small>}
                    </label>

                    <label className="create-user__field">
                      <span>Referencia</span>
                      <input
                        name="referencia"
                        type="text"
                        placeholder="Referencia del producto (ej: REF-001)"
                        value={formData.referencia}
                        onChange={handleChange}
                        disabled={loading}
                      />
                    </label>

                    <div className="create-user__pieza-original-wrapper create-user__field--full">
                      <span className="create-user__pieza-original-label">Original</span>
                      <label className="create-user__pieza-original">
                        <input
                          name="pieza_original"
                          type="checkbox"
                          checked={Boolean(formData.pieza_original)}
                          onChange={handleChange}
                          disabled={loading}
                        />
                        <span>Marcar cuando la pieza es original.</span>
                      </label>
                    </div>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <h4>OEMs</h4>
                  </div>

                  <div className="create-user__locations-table create-user__locations-table--oem">
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>Código</span>
                      <span>Acciones</span>
                    </div>

                    <div className="create-user__locations-row create-user__locations-row--form">
                      <span>
                        <input
                          type="text"
                          placeholder="Código OEM"
                          value={oemDraft.codigo}
                          onChange={(event) => handleOemDraftChange('codigo', event.target.value)}
                          disabled={loading}
                        />
                      </span>
                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={handleAddOem}
                          disabled={loading}
                        >
                          Agregar
                        </button>
                      </span>
                    </div>

                    {!oemItems.length && (
                      <div className="create-user__locations-row create-user__locations-row--empty">
                        <span>Sin OEMs registrados.</span>
                      </div>
                    )}

                    {oemItems.map((item, index) => (
                      <div key={`${item.codigo}-${index}`} className="create-user__locations-row">
                        <span>{item.codigo || '-'}</span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button
                            type="button"
                            className="create-user__locations-remove"
                            onClick={() => handleRemoveOem(item.codigo)}
                            disabled={loading}
                            aria-label="Eliminar OEM"
                          >
                            ×
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <h4>Datos comerciales del producto</h4>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    {showCostField && (
                      <label className="create-user__field">
                        <span>Costo</span>
                        <div className="create-user__money">
                          <span>$</span>
                          <input
                            name="costo_minimo"
                            type="text"
                            inputMode="decimal"
                            placeholder="Costo al comprar"
                            value={formData.costo_minimo}
                            onChange={handleChange}
                            disabled={loading}
                          />
                        </div>
                      </label>
                    )}

                    <label className="create-user__field">
                      <span>Precio</span>
                      <div className={`create-user__money${precioInvalid ? ' create-user__money--invalid' : ''}`}>
                        <span>$</span>
                        <input
                          name="precio"
                          type="text"
                          inputMode="decimal"
                          placeholder="Precio al que se pretende vender"
                          value={formData.precio}
                          onChange={handleChange}
                          required
                          disabled={loading}
                        />
                      </div>
                      {precioInvalid && <small className="create-user__field-error">Define un precio valido.</small>}
                    </label>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <h4>Detalle</h4>
                    </div>
                  </div>
                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field create-user__field--full">
                      <textarea
                        name="descripcion"
                        placeholder="Describe el producto, su uso, diferentes nombres o caracteristicas importantes."
                        value={formData.descripcion}
                        onChange={handleChange}
                        disabled={loading}
                      />
                    </label>
                  </div>
                </section>
              </>
            )}

            {activeTab === 'alternos' && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <h4>Alternos</h4>
                </div>

                <div className="create-user__locations-table create-user__locations-table--alternos">
                  <div className="create-user__locations-row create-user__locations-row--head">
                    <span>Código</span>
                    <span>Producto</span>
                    <span>Descripción</span>
                    <span>Acciones</span>
                  </div>

                  <div className="create-user__locations-row create-user__locations-row--form">
                      <span>{alternoDraft?.codigo || '—'}</span>
                      <span>
                        <div className="create-user__dropdown" ref={alternoDropdownRef}>
                          <button
                            type="button"
                            className="create-user__dropdown-trigger"
                            onClick={() => {
                              if (loading) return
                              setShowAlternoDropdown((prev) => !prev)
                              setShowCasaDropdown(false)
                            }}
                            disabled={loading}
                          >
                            <span>{alternoDraft?.nombre || 'Selecciona un producto alterno'}</span>
                            <i className={`pi pi-chevron-${showAlternoDropdown ? 'up' : 'down'}`} />
                          </button>

                          {showAlternoDropdown && (
                            <div className="create-user__dropdown-panel">
                              <div className="create-user__dropdown-search">
                                <i className="pi pi-search" />
                                <input
                                  type="text"
                                  placeholder="Buscar productos"
                                  value={alternoQuery}
                                  onChange={(event) => setAlternoQuery(event.target.value)}
                                />
                              </div>

                              <div className="create-user__dropdown-results">
                                {alternoLoading && <small className="muted">Buscando productos...</small>}
                                {!alternoLoading && !alternoQuery.trim() && (
                                  <small className="muted">Escribe para buscar productos.</small>
                                )}
                                {!alternoLoading && alternoQuery.trim() && !alternoOptions.length && (
                                  <small className="muted">Sin resultados.</small>
                                )}
                                {alternoOptions.map((product) => {
                                  const isSelected = alternoIdSet.has(String(product?.id))
                                  return (
                                    <button
                                      key={product.id}
                                      type="button"
                                      className="create-user__result-option"
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={(event) => {
                                        event.preventDefault()
                                        event.stopPropagation()
                                        handleAlternoSelect(product)
                                      }}
                                      disabled={isSelected}
                                    >
                                      <div className="create-user__result-info">
                                        <strong>{product.nombre || 'Sin nombre'}</strong>
                                        <small>{product.codigo ? `Código: ${product.codigo}` : `ID: ${product.id}`}</small>
                                      </div>
                                      <span className={`create-user__result-tag ${isSelected ? 'is-selected' : ''}`}>
                                        {isSelected ? 'Agregado' : 'Seleccionar'}
                                      </span>
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      </span>
                      <span>{alternoDraft?.descripcion || '—'}</span>
                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={handleAddAlternoDraft}
                          disabled={loading}
                        >
                          Agregar
                        </button>
                      </span>
                    </div>

                  {!alternosSelected.length && (
                    <div className="create-user__locations-row create-user__locations-row--empty">
                      <span>Sin alternos registrados.</span>
                    </div>
                  )}

                  {alternosSelected.map((alterno, index) => (
                    <div key={`${alterno.id}-${index}`} className="create-user__locations-row">
                      <span>{alterno.codigo || '-'}</span>
                      <span>{alterno.nombre || 'Sin nombre'}</span>
                      <span>{alterno.descripcion || '—'}</span>
                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button
                          type="button"
                          className="create-user__locations-remove"
                          onClick={() => handleRemoveAlterno(alterno.id)}
                          disabled={loading}
                          aria-label="Eliminar alterno"
                        >
                          ×
                        </button>
                      </span>
                    </div>
                  ))}
                </div>


              </section>
            )}


            {activeTab === 'ubicaciones' && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <h4>Ubicaciones del producto</h4>
                  <button
                    type="button"
                    className="create-user__ghost create-user__location-action"
                    onClick={() => {
                      setLocationError('')
                      setShowLocationForm((prev) => {
                        const next = !prev
                        if (next) {
                          setLocationDraft((current) => ({
                            ...current,
                            cantidad: current.cantidad || '1',
                          }))
                          setLocationBranchQuery('')
                          setLocationBodegaQuery('')
                          setLocationDivisionQuery('')
                          setLocationSubdivisionQuery('')
                        } else {
                          setShowLocationBranchDropdown(false)
                          setShowLocationBodegaDropdown(false)
                          setShowLocationDivisionDropdown(false)
                          setShowLocationSubdivisionDropdown(false)
                        }
                        return next
                      })
                    }}
                    disabled={loading || locationsLoading}
                  >
                    {showLocationForm ? 'Cancelar' : 'Agregar ubicacion'}
                  </button>
                </div>

                <div className="create-user__locations-table create-user__locations-table--locations-selectors create-user__locations-table--with-actions">
                  <div className="create-user__locations-row create-user__locations-row--head">
                    <span>Sucursal</span>
                    <span>Bodega</span>
                    <span>Division</span>
                    <span>Subdivision</span>
                    <span>Cantidad</span>
                    <span>Acciones</span>
                  </div>
                  {showLocationForm && (
                    <div className="create-user__locations-row create-user__locations-row--form">
                      <span>
                        <div className="create-user__dropdown" ref={locationBranchDropdownRef}>
                          <button
                            type="button"
                            className="create-user__dropdown-trigger"
                            onClick={() => {
                              if (loading || locationsLoading) return
                              setShowLocationBranchDropdown((prev) => !prev)
                              setShowLocationBodegaDropdown(false)
                              setShowLocationDivisionDropdown(false)
                              setShowLocationSubdivisionDropdown(false)
                            }}
                            disabled={loading || locationsLoading}
                          >
                            <span>{selectedLocationBranch?.nombre || 'Selecciona una sucursal'}</span>
                            <i className={`pi pi-chevron-${showLocationBranchDropdown ? 'up' : 'down'}`} />
                          </button>

                          {showLocationBranchDropdown && (
                            <div className="create-user__dropdown-panel">
                              <div className="create-user__dropdown-search">
                                <i className="pi pi-search" />
                                <input
                                  type="text"
                                  placeholder="Buscar sucursal"
                                  value={locationBranchQuery}
                                  onChange={(event) => setLocationBranchQuery(event.target.value)}
                                />
                              </div>
                              <div className="create-user__dropdown-results">
                                {locationSearchLoading.sucursal && <small className="muted">Buscando...</small>}
                                {!locationSearchLoading.sucursal && !locationBranchOptions.length && (
                                  <small className="muted">Sin resultados.</small>
                                )}
                                {locationBranchOptions.map((branch) => {
                                  const branchEditable = canManageLocationBranch(branch?.id)
                                  return (
                                    <button
                                      key={branch.id}
                                      type="button"
                                      className="create-user__result-option"
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={(event) => {
                                        event.preventDefault()
                                        event.stopPropagation()
                                        handleLocationBranchPick(branch)
                                      }}
                                      disabled={loading || !branchEditable}
                                      title={branchEditable ? undefined : 'Sin permiso para editar ubicaciones en esta sucursal'}
                                    >
                                      <div className="create-user__result-info">
                                        <strong>{branch.nombre || `Sucursal ${branch.id}`}</strong>
                                      </div>
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      </span>
                      <span>
                        <div className="create-user__dropdown" ref={locationBodegaDropdownRef}>
                          <button
                            type="button"
                            className="create-user__dropdown-trigger"
                            onClick={() => {
                              if (loading || locationsLoading || !locationDraft.sucursalId) return
                              setShowLocationBodegaDropdown((prev) => !prev)
                              setShowLocationBranchDropdown(false)
                              setShowLocationDivisionDropdown(false)
                              setShowLocationSubdivisionDropdown(false)
                            }}
                            disabled={loading || locationsLoading || !locationDraft.sucursalId || !canManageLocationDraft}
                          >
                            <span>{selectedLocationBodega?.nombre || 'Selecciona una bodega'}</span>
                            <i className={`pi pi-chevron-${showLocationBodegaDropdown ? 'up' : 'down'}`} />
                          </button>

                          {showLocationBodegaDropdown && (
                            <div className="create-user__dropdown-panel">
                              <div className="create-user__dropdown-search">
                                <i className="pi pi-search" />
                                <input
                                  type="text"
                                  placeholder="Buscar bodega"
                                  value={locationBodegaQuery}
                                  onChange={(event) => setLocationBodegaQuery(event.target.value)}
                                />
                              </div>
                              <div className="create-user__dropdown-results">
                                {locationSearchLoading.bodega && <small className="muted">Buscando...</small>}
                                {!locationSearchLoading.bodega && !locationBodegaOptions.length && (
                                  <small className="muted">Sin resultados.</small>
                                )}
                                {locationBodegaOptions.map((bodega) => (
                                  <button
                                    key={bodega.id}
                                    type="button"
                                    className="create-user__result-option"
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={(event) => {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      handleLocationBodegaPick(bodega)
                                    }}
                                    disabled={loading || !canManageLocationDraft}
                                  >
                                    <div className="create-user__result-info">
                                      <strong>{bodega.nombre || `Bodega ${bodega.id}`}</strong>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </span>
                      <span>
                        <div className="create-user__dropdown" ref={locationDivisionDropdownRef}>
                          <button
                            type="button"
                            className="create-user__dropdown-trigger"
                            onClick={() => {
                              if (loading || locationsLoading || !locationDraft.bodegaId) return
                              setShowLocationDivisionDropdown((prev) => !prev)
                              setShowLocationBranchDropdown(false)
                              setShowLocationBodegaDropdown(false)
                              setShowLocationSubdivisionDropdown(false)
                            }}
                            disabled={loading || locationsLoading || !locationDraft.bodegaId || !canManageLocationDraft}
                          >
                            <span>{selectedLocationDivision?.nombre || 'Selecciona una division'}</span>
                            <i className={`pi pi-chevron-${showLocationDivisionDropdown ? 'up' : 'down'}`} />
                          </button>

                          {showLocationDivisionDropdown && (
                            <div className="create-user__dropdown-panel">
                              <div className="create-user__dropdown-search">
                                <i className="pi pi-search" />
                                <input
                                  type="text"
                                  placeholder="Buscar division"
                                  value={locationDivisionQuery}
                                  onChange={(event) => setLocationDivisionQuery(event.target.value)}
                                />
                              </div>
                              <div className="create-user__dropdown-results">
                                {locationSearchLoading.division && <small className="muted">Buscando...</small>}
                                {!locationSearchLoading.division && !locationDivisionOptions.length && (
                                  <small className="muted">Sin resultados.</small>
                                )}
                                {locationDivisionOptions.map((division) => (
                                  <button
                                    key={division.id}
                                    type="button"
                                    className="create-user__result-option"
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={(event) => {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      handleLocationDivisionPick(division)
                                    }}
                                    disabled={loading || !canManageLocationDraft}
                                  >
                                    <div className="create-user__result-info">
                                      <strong>{division.nombre || `Division ${division.id}`}</strong>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </span>
                      <span>
                        <div className="create-user__dropdown" ref={locationSubdivisionDropdownRef}>
                          <button
                            type="button"
                            className="create-user__dropdown-trigger"
                            onClick={() => {
                              if (loading || locationsLoading || !locationDraft.divisionId) return
                              setShowLocationSubdivisionDropdown((prev) => !prev)
                              setShowLocationBranchDropdown(false)
                              setShowLocationBodegaDropdown(false)
                              setShowLocationDivisionDropdown(false)
                            }}
                            disabled={loading || locationsLoading || !locationDraft.divisionId || !canManageLocationDraft}
                          >
                            <span>{selectedLocationSubdivision?.nombre || 'Selecciona una subdivision'}</span>
                            <i className={`pi pi-chevron-${showLocationSubdivisionDropdown ? 'up' : 'down'}`} />
                          </button>

                          {showLocationSubdivisionDropdown && (
                            <div className="create-user__dropdown-panel">
                              <div className="create-user__dropdown-search">
                                <i className="pi pi-search" />
                                <input
                                  type="text"
                                  placeholder="Buscar subdivision"
                                  value={locationSubdivisionQuery}
                                  onChange={(event) => setLocationSubdivisionQuery(event.target.value)}
                                />
                              </div>
                              <div className="create-user__dropdown-results">
                                {locationSearchLoading.subdivision && <small className="muted">Buscando...</small>}
                                {!locationSearchLoading.subdivision && !locationSubdivisionOptions.length && (
                                  <small className="muted">Sin resultados.</small>
                                )}
                                {locationSubdivisionOptions.map((subdivision) => (
                                  <button
                                    key={subdivision.id}
                                    type="button"
                                    className="create-user__result-option"
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={(event) => {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      handleLocationSubdivisionPick(subdivision)
                                    }}
                                    disabled={loading || !canManageLocationDraft}
                                  >
                                    <div className="create-user__result-info">
                                      <strong>{subdivision.nombre || `Subdivision ${subdivision.id}`}</strong>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </span>
                      <span>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          placeholder="Cantidad"
                          value={locationDraft.cantidad}
                          onChange={(event) => handleLocationSelect('cantidad', event.target.value)}
                          disabled={loading || locationsLoading || !canManageLocationDraft}
                        />
                      </span>
                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={handleAddLocation}
                          disabled={loading || locationsLoading || !canManageLocationDraft}
                        >
                          Agregar
                        </button>
                      </span>
                    </div>
                  )}
                  {locationsLoading && (
                    <div className="create-user__locations-row create-user__locations-row--empty">
                      <span>Cargando ubicaciones...</span>
                    </div>
                  )}
                  {!locationsLoading && locations.length === 0 && (
                    <div className="create-user__locations-row create-user__locations-row--empty">
                      <span>Sin ubicaciones registradas.</span>
                    </div>
                  )}
                  {locations.map((location) => {
                    const rowSubdivisions = subdivisionsByBodega.get(location.bodegaId) || []
                    const canManageRow = canManageLocationBranch(location.sucursalId)
                    const isEditingRow = editingLocationKey === location.uid
                    const editingSubdivision = isEditingRow && editingField === 'subdivision'
                    const editingCantidad = isEditingRow && editingField === 'cantidad'

                    return (
                      <div key={location.uid} className="create-user__locations-row">
                        <span>{location.sucursalNombre}</span>
                        <span>{location.bodegaNombre}</span>
                        <span>{location.divisionNombre}</span>
                        <span
                          className={`create-user__locations-cell${canManageRow ? ' create-user__locations-cell--editable' : ''}`}
                          onDoubleClick={canManageRow ? () => beginLocationEdit(location, 'subdivision') : undefined}
                        >
                          {editingSubdivision ? (
                            <select
                              value={editingValue}
                              onChange={(event) => {
                                setEditingValue(event.target.value)
                                commitLocationEdit(event.target.value)
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') cancelLocationEdit()
                              }}
                              onBlur={() => cancelLocationEdit()}
                              autoFocus
                            >
                              <option value="">Selecciona una subdivision</option>
                              {rowSubdivisions.map((subdivision) => (
                                <option key={subdivision.id} value={subdivision.id}>
                                  {subdivision.nombre || `Subdivision ${subdivision.id}`}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span>{location.subdivisionNombre}</span>
                          )}
                        </span>
                        <span
                          className={`create-user__locations-cell${canManageRow ? ' create-user__locations-cell--editable' : ''}`}
                          onDoubleClick={canManageRow ? () => beginLocationEdit(location, 'cantidad') : undefined}
                        >
                          {editingCantidad ? (
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={editingValue}
                              onChange={(event) => setEditingValue(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  commitLocationEdit()
                                }
                                if (event.key === 'Escape') cancelLocationEdit()
                              }}
                              onBlur={() => commitLocationEdit()}
                              autoFocus
                            />
                          ) : (
                            <strong>{location.cantidad}</strong>
                          )}
                        </span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button
                            type="button"
                            className="create-user__locations-remove"
                            onClick={() => handleRemoveLocation(location.uid)}
                            disabled={loading || !canManageRow}
                            aria-label="Eliminar ubicacion"
                          >
                            ×
                          </button>
                        </span>
                      </div>
                    )
                  })}
                </div>

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
            <button
              type="submit"
              className="create-user__action create-user__action--primary"
              disabled={loading}
            >
              {loading ? 'Creando producto...' : 'Crear producto'}
            </button>
          </div>
        </form>

        {!lockModal && (
          <button
          type="button"
          aria-label="Cambiar tamaño de ventana"
          className="create-user__resize-handle"
          onMouseDown={handleResizeMouseDown}
          />
        )}
      </div>
    </div>
  )
}

export default CreateProducto
