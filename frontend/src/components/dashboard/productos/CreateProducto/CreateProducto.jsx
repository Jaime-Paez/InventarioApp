import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import { API_URL, authFetch } from '../../../../utils/api'

const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const initialForm = {
  codigo: '',
  nombre: '',
  descripcion: '',
  pieza_original: false,
  costo_minimo: '',
  costo_maximo: '',
  precio: '',
  marcaId: '',
  casasIds: [],
}

const parseNumber = (value) => {
  const cleaned = String(value ?? '').trim()
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}
const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const parseQuantity = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.floor(parsed))
}

function CreateProducto({ open, onClose, onCreated, token, onError }) {
  const [formData, setFormData] = useState(initialForm)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [alternoQuery, setAlternoQuery] = useState('')
  const [alternoOptions, setAlternoOptions] = useState([])
  const [alternoLoading, setAlternoLoading] = useState(false)
  const [alternosSelected, setAlternosSelected] = useState([])
  const [showAlternoDropdown, setShowAlternoDropdown] = useState(false)
  const [showAlternoForm, setShowAlternoForm] = useState(false)
  const [alternoDraft, setAlternoDraft] = useState(null)
  const [alternoError, setAlternoError] = useState('')
  const [oemItems, setOemItems] = useState([])
  const [showOemForm, setShowOemForm] = useState(false)
  const [oemDraft, setOemDraft] = useState({ codigo: '', descripcion: '' })
  const [oemError, setOemError] = useState('')
  const [showMarcaDropdown, setShowMarcaDropdown] = useState(false)
  const [showCasaDropdown, setShowCasaDropdown] = useState(false)
  const [brands, setBrands] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [branches, setBranches] = useState([])
  const [bodegas, setBodegas] = useState([])
  const [divisions, setDivisions] = useState([])
  const [subdivisions, setSubdivisions] = useState([])
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
  const [marcaQuery, setMarcaQuery] = useState('')
  const [casaSearch, setCasaSearch] = useState('')
  const [codigoChecking, setCodigoChecking] = useState(false)
  const [codigoError, setCodigoError] = useState('')
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const marcaDropdownRef = useRef(null)
  const casaDropdownRef = useRef(null)
  const alternoDropdownRef = useRef(null)
  const codigoPrefixRef = useRef('')
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

  const normalizeValue = (value) => String(value ?? '').trim().toLowerCase()

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
  const subdivisionById = useMemo(
    () => new Map(subdivisions.map((subdivision) => [String(subdivision.id), subdivision])),
    [subdivisions]
  )
  const bodegasBySucursal = useMemo(() => {
    const map = new Map()
    bodegas.forEach((bodega) => {
      const sucursalId = bodega?.sucursal?.id ?? bodega?.sucursal_id
      if (!sucursalId) return
      const key = String(sucursalId)
      const list = map.get(key) || []
      list.push(bodega)
      map.set(key, list)
    })
    return map
  }, [bodegas])
  const divisionsByBodega = useMemo(() => {
    const map = new Map()
    divisions.forEach((division) => {
      const bodegaId = division?.bodega?.id ?? division?.bodega_id
      if (!bodegaId) return
      const key = String(bodegaId)
      const list = map.get(key) || []
      list.push(division)
      map.set(key, list)
    })
    return map
  }, [divisions])
  const subdivisionsByDivision = useMemo(() => {
    const map = new Map()
    subdivisions.forEach((subdivision) => {
      const divisionId = subdivision?.division?.id
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
      const bodegaId = subdivision?.division?.bodega?.id
      if (!bodegaId) return
      const key = String(bodegaId)
      const list = map.get(key) || []
      list.push(subdivision)
      map.set(key, list)
    })
    return map
  }, [subdivisions])
  const availableBodegas = useMemo(
    () => (locationDraft.sucursalId ? bodegasBySucursal.get(locationDraft.sucursalId) || [] : []),
    [bodegasBySucursal, locationDraft.sucursalId]
  )
  const availableDivisions = useMemo(
    () => (locationDraft.bodegaId ? divisionsByBodega.get(locationDraft.bodegaId) || [] : []),
    [divisionsByBodega, locationDraft.bodegaId]
  )
  const availableSubdivisions = useMemo(
    () => (locationDraft.divisionId ? subdivisionsByDivision.get(locationDraft.divisionId) || [] : []),
    [subdivisionsByDivision, locationDraft.divisionId]
  )

  const createLocationUid = () => `loc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const searchBrands = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token) {
        setBrands([])
        return
      }
      try {
        const response = await authFetch(
          `${API_URL}/marcas/listado/?search=${encodeURIComponent(term)}&page_size=20`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las marcas.')
        const data = await response.json()
        const list = Array.isArray(data) ? data : data?.results || []
        setBrands(list)
      } catch (err) {
        notifyError(err.message || 'Ocurrio un error al cargar las marcas.')
      }
    },
    [notifyError, token]
  )

  const searchSuppliers = useCallback(
    async (query) => {
      const term = String(query ?? '').trim()
      if (!term || !token) {
        setSuppliers([])
        return
      }
      try {
        const response = await authFetch(
          `${API_URL}/casa-comercial/casas/?search=${encodeURIComponent(term)}&page_size=20`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las casas comerciales.')
        const data = await response.json()
        const list = Array.isArray(data) ? data : data?.results || []
        setSuppliers(list)
      } catch (err) {
        notifyError(err.message || 'Ocurrio un error al cargar las casas comerciales.')
      }
    },
    [notifyError, token]
  )

  const fetchLocations = useCallback(async () => {
    if (!token) return
    setLocationsLoading(true)
    try {
      const [branchesRes, bodegasRes, divisionsRes, subdivisionsRes] = await Promise.all([
        authFetch(`${API_URL}/inventario/sucursales/`, {}, token),
        authFetch(`${API_URL}/inventario/bodegas/`, {}, token),
        authFetch(`${API_URL}/inventario/divisiones/`, {}, token),
        authFetch(`${API_URL}/inventario/subdivisiones/`, {}, token),
      ])

      if (!branchesRes.ok) throw new Error('No se pudieron cargar las sucursales.')
      if (!bodegasRes.ok) throw new Error('No se pudieron cargar las bodegas.')
      if (!divisionsRes.ok) throw new Error('No se pudieron cargar las divisiones.')
      if (!subdivisionsRes.ok) throw new Error('No se pudieron cargar las subdivisiones.')

      const [branchesData, bodegasData, divisionsData, subdivisionsData] = await Promise.all([
        branchesRes.json(),
        bodegasRes.json(),
        divisionsRes.json(),
        subdivisionsRes.json(),
      ])

      setBranches(parseApiList(branchesData))
      setBodegas(parseApiList(bodegasData))
      setDivisions(parseApiList(divisionsData))
      setSubdivisions(parseApiList(subdivisionsData))
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al cargar las ubicaciones.')
    } finally {
      setLocationsLoading(false)
    }
  }, [notifyError, token])

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
          `${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=20`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar los productos.')
        const data = await response.json()
        const list = Array.isArray(data) ? data : data?.results || []
        setAlternoOptions(list)
      } catch (err) {
        notifyError(err.message || 'Ocurrio un error al buscar productos.')
      } finally {
        setAlternoLoading(false)
      }
    },
    [notifyError, token]
  )

  useEffect(() => {
    if (!open) return
    setFormData(initialForm)
    setMarcaQuery('')
    setCasaSearch('')
    setLoading(false)
    setActiveTab('general')
    setAlternoQuery('')
    setAlternoOptions([])
    setAlternosSelected([])
    setAlternoLoading(false)
    setShowAlternoDropdown(false)
    setShowAlternoForm(false)
    setAlternoDraft(null)
    setAlternoError('')
    setOemItems([])
    setShowOemForm(false)
    setOemDraft({ codigo: '', descripcion: '' })
    setOemError('')
    setShowMarcaDropdown(false)
    setShowCasaDropdown(false)
    setIsMaximized(false)
    setSelectedCasa(null)
    setBranches([])
    setBodegas([])
    setDivisions([])
    setSubdivisions([])
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
    codigoPrefixRef.current = ''
    if (codigoCheckTimerRef.current) {
      clearTimeout(codigoCheckTimerRef.current)
      codigoCheckTimerRef.current = null
    }
    codigoCheckSeqRef.current = 0
    setCodigoChecking(false)
    setCodigoError('')
    setBrands([])
    setSuppliers([])
    fetchLocations()
  }, [fetchLocations, open])

  useEffect(
    () => () => {
      if (codigoCheckTimerRef.current) {
        clearTimeout(codigoCheckTimerRef.current)
      }
    },
    []
  )

  useEffect(() => {
    const term = marcaQuery.trim()
    if (!term) {
      setBrands([])
      return
    }
    const handle = setTimeout(() => {
      searchBrands(term)
    }, 300)
    return () => clearTimeout(handle)
  }, [marcaQuery, searchBrands])

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
    const handleClick = (event) => {
      if (showAlternoDropdown && alternoDropdownRef.current && !alternoDropdownRef.current.contains(event.target)) {
        setShowAlternoDropdown(false)
      }
      if (showMarcaDropdown && marcaDropdownRef.current && !marcaDropdownRef.current.contains(event.target)) {
        setShowMarcaDropdown(false)
      }
      if (showCasaDropdown && casaDropdownRef.current && !casaDropdownRef.current.contains(event.target)) {
        setShowCasaDropdown(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [showAlternoDropdown, showMarcaDropdown, showCasaDropdown])

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
    const { name, value } = event.target
    if (name === 'pieza_original') {
      setFormData((prev) => ({
        ...prev,
        pieza_original: value === 'true',
      }))
      return
    }
    if (name === 'codigo') {
      setFormData((prev) => ({
        ...prev,
        codigo: value,
      }))
      scheduleCodigoCheck(value)
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
            `${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=20`,
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
        } catch (err) {
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

  const applyCodigoPrefix = useCallback((prefix) => {
    const cleanPrefix = String(prefix ?? '').trim()
    if (!cleanPrefix) return
    const prevPrefix = codigoPrefixRef.current
    codigoPrefixRef.current = cleanPrefix
    setFormData((prev) => {
      const current = String(prev.codigo ?? '')
      const currentTrim = current.trim()
      if (!currentTrim || currentTrim === prevPrefix) {
        scheduleCodigoCheck(cleanPrefix)
        return { ...prev, codigo: cleanPrefix }
      }
      if (prevPrefix && currentTrim.startsWith(prevPrefix)) {
        const nextCodigo = cleanPrefix + currentTrim.slice(prevPrefix.length)
        scheduleCodigoCheck(nextCodigo)
        return { ...prev, codigo: nextCodigo }
      }
      return prev
    })
  }, [scheduleCodigoCheck])

  const handleMarcaInputChange = (event) => {
    const value = event.target.value
    setMarcaQuery(value)
    setFormData((prev) => ({
      ...prev,
      marcaId: '',
    }))
  }

  const handleMarcaSelect = (brand) => {
    if (!brand) return
    setMarcaQuery(brand.nombre || '')
    setFormData((prev) => ({
      ...prev,
      marcaId: String(brand.id),
    }))
    setShowMarcaDropdown(false)
    applyCodigoPrefix(brand.codigo)
  }

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
    if (didSelect && !formData.marcaId) {
      applyCodigoPrefix(supplier.codigo)
    }
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
    const descripcion = String(oemDraft.descripcion ?? '').trim()
    if (!codigo) {
      setOemError('Ingresa un codigo OEM.')
      return
    }
    const key = normalizeOemCode(codigo)
    if (oemCodeSet.has(key)) {
      setOemError('Ese codigo OEM ya esta en la tabla.')
      return
    }
    setOemItems((prev) => [
      ...prev,
      {
        codigo,
        descripcion,
      },
    ])
    setOemDraft({ codigo: '', descripcion: '' })
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
    if (!bodegaId) {
      setLocationError('Selecciona una bodega.')
      return
    }
    if (!divisionId) {
      setLocationError('Selecciona una division.')
      return
    }
    if (!subdivisionId) {
      setLocationError('Selecciona una subdivisiÃ³n.')
      return
    }
    const allowedSubs = subdivisionsByDivision.get(String(divisionId)) || []
    if (!allowedSubs.some((sub) => String(sub.id) === String(subdivisionId))) {
      setLocationError('La subdivision no pertenece a la division seleccionada.')
      return
    }
    const safeQuantity = quantity && quantity > 0 ? quantity : 1

    const subdivision = subdivisionById.get(String(subdivisionId))
    const bodega = bodegaById.get(String(bodegaId))
    const branch = branchById.get(String(sucursalId))
    const divisionName = subdivision?.division?.nombre || divisions.find((d) => String(d.id) === String(divisionId))?.nombre

    const nextEntry = {
      uid: createLocationUid(),
      sucursalId: String(sucursalId),
      sucursalNombre: branch?.nombre || 'â€”',
      bodegaId: String(bodegaId),
      bodegaNombre: bodega?.nombre || 'â€”',
      divisionId: String(divisionId),
      divisionNombre: divisionName || 'â€”',
      subdivisionId: String(subdivisionId),
      subdivisionNombre: subdivision?.nombre || 'â€”',
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
    setLocations((prev) => prev.filter((item) => item.uid !== key))
    if (editingLocationKey === key) {
      setEditingLocationKey(null)
      setEditingField(null)
      setEditingValue('')
      setEditError('')
    }
  }

  const beginLocationEdit = (location, field) => {
    setEditError('')
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
          const detail = data?.detail || 'No se pudo asignar una ubicaciÃ³n.'
          throw new Error(detail)
        }
      } catch (err) {
        errors.push(err?.message || 'No se pudo asignar una ubicaciÃ³n.')
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

    const searchResponse = await authFetch(
      `${API_URL}/productos/oem/?search=${encodeURIComponent(codigo)}&page_size=20`,
      {},
      token
    )
    if (!searchResponse.ok) return null
    const searchData = await searchResponse.json().catch(() => ({}))
    const list = parseApiList(searchData)
    const match = list.find(
      (oem) => String(oem?.codigo ?? '').trim().toLowerCase() === codigo.toLowerCase()
    )
    return match?.id ?? null
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
    if (codigoChecking) {
      notifyError('Estamos validando el codigo, espera un momento.')
      return
    }
    if (codigoError) {
      notifyError(codigoError)
      return
    }
    if (!formData.codigo.trim()) {
      notifyError('Define un codigo para el producto.')
      return
    }

    setLoading(true)

    const payload = {
      codigo: formData.codigo.trim(),
      nombre: formData.nombre.trim(),
      descripcion: formData.descripcion.trim(),
      pieza_original: Boolean(formData.pieza_original),
      costo_minimo: parseNumber(formData.costo_minimo),
      costo_maximo: parseNumber(formData.costo_maximo),
      precio: parseNumber(formData.precio),
      marca_id: formData.marcaId ? Number(formData.marcaId) : null,
      casas_comerciales_ids: (formData.casasIds || []).map((id) => Number(id)),
    }

    if (!payload.nombre) {
      setLoading(false)
      notifyError('Define un nombre para el producto.')
      return
    }

    if (!payload.marca_id) {
      setLoading(false)
      notifyError('Selecciona una marca para el producto.')
      return
    }

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
          data?.marca_id?.[0] ||
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
      setShowOemForm(false)
      setOemDraft({ codigo: '', descripcion: '' })
      setOemError('')
      setLocations([])
      setLocationDraft({
        sucursalId: '',
        bodegaId: '',
        divisionId: '',
        subdivisionId: '',
        cantidad: '1',
      })
      onCreated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrio un error al crear el producto.')
    } finally {
      setLoading(false)
    }
  }

  const handleMouseDown = (event) => {
    if (isMaximized) return
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

  if (!open) return null

  const overlayStyle = { padding: `${VIEWPORT_PADDING}px` }
  const modalStyle = {
    top: position.y,
    left: position.x,
    width: size.width,
    height: size.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
  }

  return (
    <div className="create-user__overlay" role="dialog" aria-modal="true" style={overlayStyle}>
      <div className="create-user__modal" ref={modalRef} style={modalStyle}>
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>Crear nuevo producto</h3>
          </div>
          <div className="create-user__header-actions">
            <button
              type="button"
              className="create-user__icon-button create-user__icon-button--maximize"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={toggleMaximize}
              aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
            >
              {isMaximized ? '🗕' : '🗖'}
            </button>
            <button
              type="button"
              className="create-user__icon-button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={onClose}
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>
        </header>

        <form className="create-user__form" onSubmit={handleSubmit}>
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
                      <span>Nombre</span>
                      <input
                        name="nombre"
                        type="text"
                        placeholder="Nombre"
                        value={formData.nombre}
                        onChange={handleChange}
                        required
                        disabled={loading}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Marca</span>
                      <div className="create-user__dropdown" ref={marcaDropdownRef}>
                        <button
                          type="button"
                          className="create-user__dropdown-trigger"
                          onClick={() => {
                            setShowMarcaDropdown((prev) => !prev)
                            setShowCasaDropdown(false)
                          }}
                          disabled={loading}
                        >
                          <span>{marcaQuery.trim() ? marcaQuery : 'Selecciona una marca'}</span>
                          <i className={`pi pi-chevron-${showMarcaDropdown ? 'up' : 'down'}`} />
                        </button>

                        {showMarcaDropdown && (
                          <div className="create-user__dropdown-panel">
                            <div className="create-user__dropdown-search">
                              <i className="pi pi-search" />
                              <input
                                type="text"
                                placeholder="Buscar marcas"
                                value={marcaQuery}
                                onChange={handleMarcaInputChange}
                              />
                            </div>

                            <div className="create-user__dropdown-results">
                              {!marcaQuery.trim() && <small className="muted">Escribe para buscar.</small>}
                              {marcaQuery.trim() && !brands.length && <small className="muted">Sin resultados.</small>}
                              {brands.slice(0, 40).map((brand) => (
                                <button
                                  key={brand.id}
                                  type="button"
                                  className="create-user__result-option"
                                  onClick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    handleMarcaSelect(brand)
                                  }}
                                  disabled={loading}
                                >
                                  <div className="create-user__result-info">
                                    <strong>{brand.nombre}</strong>
                                    <small>{brand.codigo ? `Codigo: ${brand.codigo}` : `ID: ${brand.id}`}</small>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </label>

                    <label className="create-user__field">
                      <span>Codigo</span>
                      <input
                        name="codigo"
                        type="text"
                        placeholder="Codigo del producto (ej: FRD-123)"
                        value={formData.codigo}
                        onChange={handleChange}
                        required
                        disabled={loading}
                      />
                      {!codigoChecking && !codigoError && (
                        <small className="muted">Sugerencia: se autocompleta con el codigo de la marca o casa comercial.</small>
                      )}
                      {codigoChecking && <small className="muted">Validando codigo...</small>}
                      {!codigoChecking && codigoError && <small className="create-user__field-error">{codigoError}</small>}
                    </label>

                    <label className="create-user__field">
                      <span>Casa comercial</span>
                      <div className="create-user__dropdown" ref={casaDropdownRef}>
                        <button
                          type="button"
                          className="create-user__dropdown-trigger"
                          onClick={() => {
                            setShowCasaDropdown((prev) => !prev)
                            setShowMarcaDropdown(false)
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
                                const id = String(supplier.id)
                                const isSelected = formData.casasIds.includes(id)
                                return (
                                  <button
                                    key={supplier.id}
                                    type="button"
                                    className="create-user__result-option"
                                    onClick={(event) => {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      handleCasaToggle(supplier)
                                    }}
                                    disabled={loading}
                                  >
                                    <div className="create-user__result-info">
                                      <strong>{supplier.nombre}</strong>
                                      <small>{supplier.codigo ? `Codigo: ${supplier.codigo}` : `ID: ${supplier.id}`}</small>
                                    </div>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </label>

                    <label className="create-user__field create-user__field--full">
                      <span>Descripcion</span>
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

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <h4>Datos comerciales del producto</h4>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field">
                      <span>Costo</span>
                      <div className="create-user__money">
                        <span>$</span>
                        <input
                          name="costo_minimo"
                          type="number"
                          step="0.01"
                          placeholder="Costo al comprar"
                          value={formData.costo_minimo}
                          onChange={handleChange}
                          disabled={loading}
                        />
                      </div>
                    </label>

                    <label className="create-user__field">
                      <span>Precio</span>
                      <div className="create-user__money">
                        <span>$</span>
                        <input
                          name="precio"
                          type="number"
                          step="0.01"
                          placeholder="Precio al que se pretende vender"
                          value={formData.precio}
                          onChange={handleChange}
                          disabled={loading}
                        />
                      </div>
                    </label>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <h4>OEMs</h4>
                    <button
                      type="button"
                      className="create-user__ghost create-user__location-action"
                      onClick={() => {
                        setOemError('')
                        setShowOemForm((prev) => {
                          const next = !prev
                          if (!next) {
                            setOemDraft({ codigo: '', descripcion: '' })
                          }
                          return next
                        })
                      }}
                      disabled={loading}
                    >
                      {showOemForm ? 'Cancelar' : 'Agregar OEM'}
                    </button>
                  </div>

                  <div className="create-user__locations-table create-user__locations-table--oem">
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>Codigo</span>
                      <span>Descripcion</span>
                      <span>Acciones</span>
                    </div>

                    {showOemForm && (
                      <div className="create-user__locations-row create-user__locations-row--form">
                        <span>
                          <input
                            type="text"
                            placeholder="Codigo OEM"
                            value={oemDraft.codigo}
                            onChange={(event) => handleOemDraftChange('codigo', event.target.value)}
                            disabled={loading}
                          />
                        </span>
                        <span>
                          <input
                            type="text"
                            placeholder="Descripcion (opcional)"
                            value={oemDraft.descripcion}
                            onChange={(event) => handleOemDraftChange('descripcion', event.target.value)}
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
                    )}

                    {!oemItems.length && !showOemForm && (
                      <div className="create-user__locations-row create-user__locations-row--empty">
                        <span>Sin OEMs registrados.</span>
                      </div>
                    )}

                    {oemItems.map((item, index) => (
                      <div key={`${item.codigo}-${index}`} className="create-user__locations-row">
                        <span>{item.codigo || '-'}</span>
                        <span>{item.descripcion || '—'}</span>
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

                  {oemError && <div className="create-user__error">{oemError}</div>}
                </section>
              </>
            )}

            {activeTab === 'alternos' && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <h4>Alternos</h4>
                  <button
                    type="button"
                    className="create-user__ghost create-user__location-action"
                    onClick={() => {
                      setAlternoError('')
                      setShowAlternoForm((prev) => {
                        const next = !prev
                        if (!next) {
                          setShowAlternoDropdown(false)
                          setAlternoDraft(null)
                          setAlternoQuery('')
                          setAlternoOptions([])
                        }
                        return next
                      })
                    }}
                    disabled={loading}
                  >
                    {showAlternoForm ? 'Cancelar' : 'Agregar alterno'}
                  </button>
                </div>

                <div className="create-user__locations-table create-user__locations-table--alternos">
                  <div className="create-user__locations-row create-user__locations-row--head">
                    <span>Codigo</span>
                    <span>Producto</span>
                    <span>Descripcion</span>
                    <span>Acciones</span>
                  </div>

                  {showAlternoForm && (
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
                              setShowMarcaDropdown(false)
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
                                      onClick={() => handleAlternoSelect(product)}
                                      disabled={isSelected}
                                    >
                                      <div className="create-user__result-info">
                                        <strong>{product.nombre || 'Sin nombre'}</strong>
                                        <small>{product.codigo ? `Codigo: ${product.codigo}` : `ID: ${product.id}`}</small>
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
                  )}

                  {!alternosSelected.length && !showAlternoForm && (
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

                {alternoError && <div className="create-user__error">{alternoError}</div>}

                <div className="create-user__grid create-user__grid--two">
                  <label className="create-user__field">
                    <span>Pieza original</span>
                    <select
                      name="pieza_original"
                      value={formData.pieza_original ? 'true' : 'false'}
                      onChange={handleChange}
                      disabled={loading}
                    >
                      <option value="true">Si</option>
                      <option value="false">No</option>
                    </select>
                  </label>

                  <label className="create-user__field">
                    <span>Costo maximo</span>
                    <div className="create-user__money">
                      <span>$</span>
                      <input
                        name="costo_maximo"
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        value={formData.costo_maximo}
                        onChange={handleChange}
                        disabled={loading}
                      />
                    </div>
                  </label>
                </div>
              </section>
            )}

            {false && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <h4>OEMs</h4>
                  <button
                    type="button"
                    className="create-user__ghost create-user__location-action"
                    onClick={() => {
                      setOemError('')
                      setShowOemForm((prev) => {
                        const next = !prev
                        if (!next) {
                          setOemDraft({ codigo: '', descripcion: '' })
                        }
                        return next
                      })
                    }}
                    disabled={loading}
                  >
                    {showOemForm ? 'Cancelar' : 'Agregar OEM'}
                  </button>
                </div>

                <div className="create-user__locations-table create-user__locations-table--oem">
                  <div className="create-user__locations-row create-user__locations-row--head">
                    <span>Codigo</span>
                    <span>Descripcion</span>
                    <span>Acciones</span>
                  </div>

                  {showOemForm && (
                    <div className="create-user__locations-row create-user__locations-row--form">
                      <span>
                        <input
                          type="text"
                          placeholder="Codigo OEM"
                          value={oemDraft.codigo}
                          onChange={(event) => handleOemDraftChange('codigo', event.target.value)}
                          disabled={loading}
                        />
                      </span>
                      <span>
                        <input
                          type="text"
                          placeholder="Descripcion (opcional)"
                          value={oemDraft.descripcion}
                          onChange={(event) => handleOemDraftChange('descripcion', event.target.value)}
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
                  )}

                  {!oemItems.length && !showOemForm && (
                    <div className="create-user__locations-row create-user__locations-row--empty">
                      <span>Sin OEMs registrados.</span>
                    </div>
                  )}

                  {oemItems.map((item, index) => (
                    <div key={`${item.codigo}-${index}`} className="create-user__locations-row">
                      <span>{item.codigo || '-'}</span>
                      <span>{item.descripcion || '—'}</span>
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

                {oemError && <div className="create-user__error">{oemError}</div>}
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
                        }
                        return next
                      })
                    }}
                    disabled={loading || locationsLoading}
                  >
                    {showLocationForm ? 'Cancelar' : 'Agregar ubicacion'}
                  </button>
                </div>

                <div className="create-user__locations-table">
                  <div className="create-user__locations-row create-user__locations-row--head">
                    <span>Sucursal</span>
                    <span>Bodega</span>
                    <span>Division</span>
                    <span>Subdivision</span>
                    <span>Cantidad</span>
                  </div>
                  {showLocationForm && (
                    <div className="create-user__locations-row create-user__locations-row--form">
                      <span>
                        <select
                          value={locationDraft.sucursalId}
                          onChange={(event) => handleLocationSelect('sucursalId', event.target.value)}
                          disabled={loading || locationsLoading}
                        >
                          <option value="">Selecciona una sucursal</option>
                          {branches.map((branch) => (
                            <option key={branch.id} value={branch.id}>
                              {branch.nombre || `Sucursal ${branch.id}`}
                            </option>
                          ))}
                        </select>
                      </span>
                      <span>
                        <select
                          value={locationDraft.bodegaId}
                          onChange={(event) => handleLocationSelect('bodegaId', event.target.value)}
                          disabled={loading || locationsLoading || !locationDraft.sucursalId}
                        >
                          <option value="">Selecciona una bodega</option>
                          {availableBodegas.map((bodega) => (
                            <option key={bodega.id} value={bodega.id}>
                              {bodega.nombre || `Bodega ${bodega.id}`}
                            </option>
                          ))}
                        </select>
                      </span>
                      <span>
                        <select
                          value={locationDraft.divisionId}
                          onChange={(event) => handleLocationSelect('divisionId', event.target.value)}
                          disabled={loading || locationsLoading || !locationDraft.bodegaId}
                        >
                          <option value="">Selecciona una division</option>
                          {availableDivisions.map((division) => (
                            <option key={division.id} value={division.id}>
                              {division.nombre || `Division ${division.id}`}
                            </option>
                          ))}
                        </select>
                      </span>
                      <span>
                        <select
                          value={locationDraft.subdivisionId}
                          onChange={(event) => handleLocationSelect('subdivisionId', event.target.value)}
                          disabled={loading || locationsLoading || !locationDraft.divisionId}
                        >
                          <option value="">Selecciona una subdivision</option>
                          {availableSubdivisions.map((subdivision) => (
                            <option key={subdivision.id} value={subdivision.id}>
                              {subdivision.nombre || `Subdivision ${subdivision.id}`}
                            </option>
                          ))}
                        </select>
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          placeholder="Cantidad"
                          value={locationDraft.cantidad}
                          onChange={(event) => handleLocationSelect('cantidad', event.target.value)}
                          disabled={loading || locationsLoading}
                        />
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={handleAddLocation}
                          disabled={loading || locationsLoading}
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
                    const isEditingRow = editingLocationKey === location.uid
                    const editingSubdivision = isEditingRow && editingField === 'subdivision'
                    const editingCantidad = isEditingRow && editingField === 'cantidad'

                    return (
                      <div key={location.uid} className="create-user__locations-row">
                        <span>{location.sucursalNombre}</span>
                        <span>{location.bodegaNombre}</span>
                        <span>{location.divisionNombre}</span>
                        <span
                          className="create-user__locations-cell create-user__locations-cell--editable"
                          onDoubleClick={() => beginLocationEdit(location, 'subdivision')}
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
                          className="create-user__locations-cell create-user__locations-cell--editable"
                          onDoubleClick={() => beginLocationEdit(location, 'cantidad')}
                          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
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
                          <button
                            type="button"
                            className="create-user__ghost"
                            onClick={() => handleRemoveLocation(location.uid)}
                            onDoubleClick={(event) => event.stopPropagation()}
                            disabled={loading}
                          >
                            Quitar
                          </button>
                        </span>
                      </div>
                    )
                  })}
                </div>

                {locationError && <div className="create-user__error">{locationError}</div>}
                {editError && <div className="create-user__error">{editError}</div>}
              </section>
            )}
          </div>

          <div className="create-user__footer">
            <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose}>
              Cancelar
            </button>
            <button
              type="submit"
              className="create-user__action create-user__action--primary"
              disabled={loading || codigoChecking || Boolean(codigoError)}
            >
              {loading ? 'Guardando...' : 'Crear producto'}
            </button>
          </div>
        </form>

        <button
          type="button"
          aria-label="Cambiar tamano de ventana"
          className="create-user__resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      </div>
    </div>
  )
}

export default CreateProducto
