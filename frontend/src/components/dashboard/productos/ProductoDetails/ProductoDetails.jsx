import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Eye, Info, Pencil } from 'lucide-react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../../admin/UsersDetails/UsersDetails.css'
import { API_URL, authFetch } from '../../../../utils/api'
import { onIvaUpdated } from '../../../../utils/configEvents'
import InventarioEditor from '../../inventario/InventarioEditor/InventarioEditor'
import useModalAnimation from '../../common/useModalAnimation'
import EntityRemindersTab from '../../common/reminders/EntityRemindersTab'
import ProductoRatingTab from '../ProductoRatingTab/ProductoRatingTab'
import { formatMoneyFromValue, formatMoneyInput, parseMoneyInput } from '../../../../utils/moneyInput'

const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const emptyForm = {
  codigo: '',
  nombre: '',
  descripcion: '',
  pieza_original: false,
  costo_minimo: '',
  precio: '',
  marcaId: '',
  casasIds: [],
}

const parseNumber = (value) => parseMoneyInput(value)
const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const parseProductCode = (label) => {
  if (!label) return null
  const match = /\(([^)]+)\)\s*$/.exec(String(label))
  return match ? match[1].trim() : null
}

const DEFAULT_IVA_RATE = 0.15

const formatCurrency = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return '-'
  return `$${number.toFixed(2)}`
}

function ProductoDetails({
  open,
  productoId,
  token,
  onClose,
  onUpdated,
  onDeleted,
  onError,
  inventoryContext,
  currentUser,
  allowEdit = true,
  allowDelete = true,
  allowComment = false,
  showCostField = true,
}) {
  const [formData, setFormData] = useState(emptyForm)
  const [originalData, setOriginalData] = useState(emptyForm)
  const [brands, setBrands] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [selectedCasa, setSelectedCasa] = useState(null)
  const [originalCasa, setOriginalCasa] = useState(null)
  const [originalMarcaNombre, setOriginalMarcaNombre] = useState('')
  const [marcaQuery, setMarcaQuery] = useState('')
  const [casaSearch, setCasaSearch] = useState('')
  const [activeTab, setActiveTab] = useState('general')
  const [showMarcaDropdown, setShowMarcaDropdown] = useState(false)
  const [showCasaDropdown, setShowCasaDropdown] = useState(false)
  const [alternativas, setAlternativas] = useState([])
  const [originalAlternativas, setOriginalAlternativas] = useState([])
  const [oemItems, setOemItems] = useState([])
  const [originalOemItems, setOriginalOemItems] = useState([])
  const [showOemForm, setShowOemForm] = useState(false)
  const [oemDraft, setOemDraft] = useState({ codigo: '', descripcion: '' })
  const [oemError, setOemError] = useState('')
  const [alternoQuery, setAlternoQuery] = useState('')
  const [alternoOptions, setAlternoOptions] = useState([])
  const [alternoLoading, setAlternoLoading] = useState(false)
  const [showAlternoDropdown, setShowAlternoDropdown] = useState(false)
  const [showAlternoForm, setShowAlternoForm] = useState(false)
  const [alternoDraft, setAlternoDraft] = useState(null)
  const [alternoError, setAlternoError] = useState('')
  const [ivaRate, setIvaRate] = useState(DEFAULT_IVA_RATE)
  const [ivaLoading, setIvaLoading] = useState(false)
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [localInventoryContext, setLocalInventoryContext] = useState(null)
  const [inventoryLoading, setInventoryLoading] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const resolvedInventoryContext = inventoryContext ?? localInventoryContext
  const hasExternalInventoryContext = Boolean(inventoryContext)

  const modalRef = useRef(null)
  const marcaDropdownRef = useRef(null)
  const casaDropdownRef = useRef(null)
  const alternoDropdownRef = useRef(null)
  const inventarioEditorRef = useRef(null)
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

  const normalizeProducto = (data) => ({
    codigo: data?.codigo ?? '',
    nombre: data?.nombre ?? '',
    descripcion: data?.descripcion ?? '',
    pieza_original: Boolean(data?.pieza_original),
    costo_minimo: formatMoneyFromValue(data?.costo_minimo),
    precio: formatMoneyFromValue(data?.precio),
    marcaId: data?.marca?.id ?? '',
    casasIds: Array.isArray(data?.casas_comerciales) ? data.casas_comerciales.map((casa) => String(casa.id)) : [],
  })

  const buildInventoryContextFromProducto = useCallback((data) => {
    const payload = data?.inventario_context ?? data?.inventory_context
    if (!payload || typeof payload !== 'object') return null

    const branches = Array.isArray(payload?.branches) ? payload.branches : []
    const bodegas = Array.isArray(payload?.bodegas) ? payload.bodegas : []
    const subdivisions = Array.isArray(payload?.subdivisions) ? payload.subdivisions : []
    const rawEntries = Array.isArray(payload?.inventario_entries)
      ? payload.inventario_entries
      : Array.isArray(payload?.inventarioEntries)
        ? payload.inventarioEntries
        : []

    const inventarioEntries = rawEntries
      .map((entry) => ({
        ...entry,
        producto_id: entry?.producto_id ?? entry?.productoId ?? data?.id ?? null,
        subdivisionId: entry?.subdivisionId ?? entry?.subdivision_id ?? entry?.subdivision?.id ?? null,
      }))
      .filter((entry) => Boolean(entry?.subdivisionId))

    return {
      branches,
      bodegas,
      subdivisions,
      inventarioEntries,
    }
  }, [])

  const enrichAlternativas = useCallback(
    async (alternos) => {
      if (!token || !Array.isArray(alternos) || alternos.length === 0) return
      const idsToFetch = alternos
        .filter((item) => item?.id && (item.descripcion == null || item.descripcion === ''))
        .map((item) => item.id)
      if (!idsToFetch.length) return

      try {
        const responses = await Promise.all(
          idsToFetch.map((id) =>
            authFetch(`${API_URL}/productos/listado/${id}/?include_inventory_context=0`, {}, token)
          )
        )
        const details = await Promise.all(
          responses.map((res) => (res.ok ? res.json().catch(() => null) : null))
        )
        const descById = new Map()
        details.forEach((detail) => {
          if (!detail?.id) return
          descById.set(String(detail.id), detail.descripcion ?? '')
        })
        if (!descById.size) return
        setAlternativas((prev) =>
          prev.map((item) => {
            const desc = descById.get(String(item?.id))
            if (desc === undefined) return item
            return { ...item, descripcion: desc }
          })
        )
      } catch {
        // Descripción es opcional: evita bloquear la edición si falla.
      }
    },
    [token]
  )

  const fetchProducto = useCallback(async () => {
    if (!productoId) return
    if (!hasExternalInventoryContext) {
      setInventoryLoading(true)
      setLocalInventoryContext(null)
    }
    setLoadingData(true)
    try {
      const includeInventoryContext = hasExternalInventoryContext ? '0' : '1'
      const response = await authFetch(
        `${API_URL}/productos/listado/${productoId}/?include_inventory_context=${includeInventoryContext}`,
        {},
        token
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || 'No se pudo cargar la información del producto.'
        throw new Error(detail)
      }
      const normalized = normalizeProducto(data)
      setFormData(normalized)
      setOriginalData(normalized)
      const marcaNombre = data?.marca?.nombre ?? ''
      setOriginalMarcaNombre(marcaNombre)
      setMarcaQuery(marcaNombre)
      const casas = Array.isArray(data?.casas_comerciales) ? data.casas_comerciales : []
      const casaPrincipal = casas[0] || null
      setSelectedCasa(casaPrincipal)
      setOriginalCasa(casaPrincipal)
      const alternos = Array.isArray(data?.alternativas) ? data.alternativas : []
      setAlternativas(alternos)
      setOriginalAlternativas(alternos)
      enrichAlternativas(alternos)
      const oemsRaw = Array.isArray(data?.oem_productos) ? data.oem_productos : []
      const normalizedOems = oemsRaw
        .map((relation) => {
          const oem = relation?.oem
          return {
            relationId: relation?.id ?? null,
            oemId: oem?.id ?? relation?.oem_id ?? null,
            codigo: oem?.codigo ?? relation?.codigo ?? '',
            descripcion: oem?.descripcion ?? relation?.descripcion ?? '',
          }
        })
        .filter((item) => item.codigo)
      setOemItems(normalizedOems)
      setOriginalOemItems(normalizedOems)
      setShowOemForm(false)
      setOemDraft({ codigo: '', descripcion: '' })
      setOemError('')
      setAlternoQuery('')
      setAlternoOptions([])
      setAlternoLoading(false)
      setShowAlternoDropdown(false)
      setShowAlternoForm(false)
      setAlternoDraft(null)
      setAlternoError('')
      setIsEditing(false)
      if (!hasExternalInventoryContext) {
        setLocalInventoryContext(buildInventoryContextFromProducto(data))
      }
    } catch (err) {
      if (!hasExternalInventoryContext) {
        setLocalInventoryContext(null)
      }
      notifyError(err.message || 'Ocurrió un error al obtener la información del producto.')
    } finally {
      if (!hasExternalInventoryContext) {
        setInventoryLoading(false)
      }
      setLoadingData(false)
    }
  }, [buildInventoryContextFromProducto, enrichAlternativas, hasExternalInventoryContext, notifyError, token, productoId])

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
        notifyError(err.message || 'Ocurrió un error al cargar las marcas.')
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
        notifyError(err.message || 'Ocurrió un error al cargar las casas comerciales.')
      }
    },
    [notifyError, token]
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
          `${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=20`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar los productos.')
        const data = await response.json()
        let list = parseApiList(data)
        if (productoId) {
          list = list.filter((item) => String(item?.id) !== String(productoId))
        }
        setAlternoOptions(list)
      } catch (err) {
        notifyError(err.message || 'Ocurrió un error al buscar productos.')
      } finally {
        setAlternoLoading(false)
      }
    },
    [notifyError, productoId, token]
  )

  const fetchIvaConfig = useCallback(async () => {
    if (!token) return
    setIvaLoading(true)
    try {
      const response = await authFetch(`${API_URL}/configuracion/sistema/`, {}, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error('No se pudo cargar la configuración del IVA.')
      const parsed = Number(data?.iva_rate)
      setIvaRate(Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IVA_RATE)
    } catch {
      setIvaRate(DEFAULT_IVA_RATE)
    } finally {
      setIvaLoading(false)
    }
  }, [token])


  useEffect(() => {
    const unsubscribe = onIvaUpdated((rate) => {
      const parsed = Number(rate)
      if (Number.isFinite(parsed)) {
        setIvaRate(parsed)
        setIvaLoading(false)
        return
      }
      fetchIvaConfig()
    })

    return unsubscribe
  }, [fetchIvaConfig])

  useEffect(() => {
    if (!open) return
    setIsEditing(false)
    setSubmitAttempted(false)
    setActiveTab('general')
    setFormData(emptyForm)
    setOriginalData(emptyForm)
    setOriginalMarcaNombre('')
    setMarcaQuery('')
    setCasaSearch('')
    setSelectedCasa(null)
    setOriginalCasa(null)
    setAlternativas([])
    setOriginalAlternativas([])
    setOemItems([])
    setOriginalOemItems([])
    setShowOemForm(false)
    setOemDraft({ codigo: '', descripcion: '' })
    setOemError('')
    setAlternoQuery('')
    setAlternoOptions([])
    setAlternoLoading(false)
    setShowAlternoDropdown(false)
    setShowAlternoForm(false)
    setAlternoDraft(null)
    setAlternoError('')
    setShowMarcaDropdown(false)
    setShowCasaDropdown(false)
    setIsMaximized(false)
    restoreRef.current = null
    fetchProducto()
    fetchIvaConfig()
  }, [open, fetchProducto, fetchIvaConfig])

  useEffect(() => {
    if (!open) {
      setLocalInventoryContext(null)
      setInventoryLoading(false)
      return
    }
    if (inventoryContext) {
      setLocalInventoryContext(null)
      setInventoryLoading(false)
    }
  }, [inventoryContext, open])

  useEffect(() => {
    if (allowEdit || !isEditing) return
    setIsEditing(false)
  }, [allowEdit, isEditing])

  useEffect(() => {
    if (allowDelete || !showDeleteDialog) return
    setShowDeleteDialog(false)
  }, [allowDelete, showDeleteDialog])

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
      if (showMarcaDropdown && marcaDropdownRef.current && !marcaDropdownRef.current.contains(event.target)) {
        setShowMarcaDropdown(false)
      }
      if (showCasaDropdown && casaDropdownRef.current && !casaDropdownRef.current.contains(event.target)) {
        setShowCasaDropdown(false)
      }
      if (showAlternoDropdown && alternoDropdownRef.current && !alternoDropdownRef.current.contains(event.target)) {
        setShowAlternoDropdown(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [showMarcaDropdown, showCasaDropdown, showAlternoDropdown])

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
    if (!isEditing) return
    const { name, value, type, checked } = event.target
    if (name === 'pieza_original') {
      setFormData((prev) => ({
        ...prev,
        pieza_original: type === 'checkbox' ? checked : value === 'true',
      }))
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

  const handleMarcaInputChange = (event) => {
    if (!isEditing) return
    const value = event.target.value
    setMarcaQuery(value)
    const match = brands.find((brand) => normalizeValue(brand?.nombre) === normalizeValue(value))
    setFormData((prev) => ({
      ...prev,
      marcaId: match ? String(match.id) : '',
    }))
  }

  const handleMarcaSelect = (brand) => {
    if (!isEditing || !brand) return
    setMarcaQuery(brand.nombre || '')
    setFormData((prev) => ({
      ...prev,
      marcaId: String(brand.id),
    }))
    setShowMarcaDropdown(false)
  }

  const handleCasaSelect = (supplier) => {
    if (!isEditing || !supplier) return
    const id = String(supplier.id)
    if (!id) return
    setSelectedCasa({ id: supplier.id, nombre: supplier.nombre })
    setFormData((prev) => ({
      ...prev,
      casasIds: [id],
    }))
    setCasaSearch('')
    setShowCasaDropdown(false)
  }

  const alternoIdSet = useMemo(
    () => new Set(alternativas.map((item) => String(item?.id)).filter(Boolean)),
    [alternativas]
  )

  const handleAlternoSelect = (product) => {
    if (!isEditing || !product) return
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
    if (!isEditing || !product) return false
    const id = String(product.id)
    if (!id) return false
    if (alternoIdSet.has(id)) {
      setAlternoError('Ese producto ya está en la tabla.')
      return false
    }
    setAlternativas((prev) => [
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
    if (!isEditing) return
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
    if (!isEditing) return
    const key = String(id)
    if (!key) return
    setAlternativas((prev) => prev.filter((item) => String(item?.id) !== key))
    setAlternoError('')
  }

  const normalizeOemCode = (value) => String(value ?? '').trim().toLowerCase()
  const oemCodeSet = useMemo(
    () => new Set(oemItems.map((item) => normalizeOemCode(item?.codigo)).filter(Boolean)),
    [oemItems]
  )

  const handleOemDraftChange = (field, value) => {
    if (!isEditing) return
    setOemDraft((prev) => ({
      ...prev,
      [field]: value,
    }))
    setOemError('')
  }

  const handleAddOem = () => {
    if (!isEditing) return
    const codigo = String(oemDraft.codigo ?? '').trim()
    const descripcion = String(oemDraft.descripcion ?? '').trim()
    if (!codigo) {
      setOemError('Ingresa un código OEM.')
      return
    }
    const key = normalizeOemCode(codigo)
    if (oemCodeSet.has(key)) {
      setOemError('Ese código OEM ya está en la tabla.')
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
    if (!isEditing) return
    const key = normalizeOemCode(codigo)
    if (!key) return
    setOemItems((prev) => prev.filter((item) => normalizeOemCode(item?.codigo) !== key))
    setOemError('')
  }

  const ensureOemId = useCallback(
    async (item) => {
      const codigo = String(item?.codigo ?? '').trim()
      if (!codigo) return null
      const payload = {
        codigo,
        descripcion: String(item?.descripcion ?? '').trim(),
      }

      const searchResponse = await authFetch(
        `${API_URL}/productos/oem/?search=${encodeURIComponent(codigo)}&page_size=20`,
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
        `${API_URL}/productos/oem/?search=${encodeURIComponent(codigo)}&page_size=20`,
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
    },
    [token]
  )

  const syncAlternos = useCallback(
    async (productoIdValue, codigoProducto) => {
      if (!productoIdValue || !token) return
      const codigo = String(codigoProducto || '').trim()
      if (!codigo) return

      const desiredCodes = new Set(
        alternativas.map((item) => String(item?.codigo)).filter((value) => value)
      )
      const desiredByCode = new Map(
        alternativas
          .map((item) => [String(item?.codigo || ''), item])
          .filter(([key]) => key)
      )

      const response = await authFetch(
        `${API_URL}/productos/alternos/?search=${encodeURIComponent(codigo)}&page_size=200`,
        {},
        token
      )
      if (!response.ok) {
        throw new Error('No se pudieron cargar los alternos actuales.')
      }
      const data = await response.json()
      const relations = parseApiList(data)
      const current = relations
        .map((relation) => ({
          ...relation,
          productoCodigo: parseProductCode(relation?.producto),
          alternoCodigo: parseProductCode(relation?.alterno),
        }))
        .filter((relation) => relation.productoCodigo === codigo && relation.alternoCodigo)

      const currentCodes = new Set(current.map((relation) => relation.alternoCodigo))
      const toRemove = current.filter((relation) => !desiredCodes.has(relation.alternoCodigo))
      const toAdd = Array.from(desiredByCode.values()).filter(
        (alterno) => alterno?.id && alterno?.codigo && !currentCodes.has(String(alterno.codigo))
      )

      if (!toRemove.length && !toAdd.length) return

      const requests = [
        ...toRemove.map((relation) =>
          authFetch(`${API_URL}/productos/alternos/${relation.id}/`, { method: 'DELETE' }, token)
        ),
        ...toAdd.map((alterno) =>
          authFetch(
            `${API_URL}/productos/alternos/`,
            {
              method: 'POST',
              body: JSON.stringify({
                producto_id: productoIdValue,
                alterno_id: alterno.id,
              }),
            },
            token
          )
        ),
      ]

      const responses = await Promise.all(requests)
      const failed = responses.find((res) => !res.ok && res.status !== 204)
      if (failed) {
        const detail = await failed.json().catch(() => ({}))
        throw new Error(detail?.detail || 'No se pudieron actualizar los alternos.')
      }
    },
    [alternativas, token]
  )

  const syncOems = useCallback(
    async (productoIdValue, codigoProducto) => {
      if (!productoIdValue || !token) return
      const codigo = String(codigoProducto || '').trim()
      if (!codigo) return

      const desiredCodes = new Set(
        oemItems.map((item) => normalizeOemCode(item?.codigo)).filter(Boolean)
      )
      const desiredItems = oemItems.filter((item) => normalizeOemCode(item?.codigo))

      const response = await authFetch(
        `${API_URL}/productos/oem-producto/?search=${encodeURIComponent(codigo)}&page_size=200`,
        {},
        token
      )
      if (!response.ok) {
        throw new Error('No se pudieron cargar los OEMs actuales.')
      }
      const data = await response.json()
      const relations = parseApiList(data)
      const current = relations
        .map((relation) => ({
          ...relation,
          productoCodigo: parseProductCode(relation?.producto),
          oemCodigo: relation?.oem?.codigo ?? relation?.oem_codigo ?? '',
        }))
        .filter((relation) => relation.productoCodigo === codigo && relation.oemCodigo)

      const currentCodes = new Set(current.map((relation) => normalizeOemCode(relation.oemCodigo)))
      const toRemove = current.filter((relation) => !desiredCodes.has(normalizeOemCode(relation.oemCodigo)))
      const toAdd = desiredItems.filter((item) => !currentCodes.has(normalizeOemCode(item?.codigo)))

      const removeRequests = toRemove.map((relation) =>
        authFetch(`${API_URL}/productos/oem-producto/${relation.id}/`, { method: 'DELETE' }, token)
      )

      const addRequests = []
      for (const item of toAdd) {
        const oemId = await ensureOemId(item)
        if (!oemId) {
          throw new Error('No se pudo registrar un OEM.')
        }
        addRequests.push(
          authFetch(
            `${API_URL}/productos/oem-producto/`,
            {
              method: 'POST',
              body: JSON.stringify({
                producto_id: productoIdValue,
                oem_id: oemId,
              }),
            },
            token
          )
        )
      }

      if (!removeRequests.length && !addRequests.length) return

      const responses = await Promise.all([...removeRequests, ...addRequests])
      const failed = responses.find((res) => !res.ok && res.status !== 204)
      if (failed) {
        const detail = await failed.json().catch(() => ({}))
        throw new Error(detail?.detail || 'No se pudieron actualizar los OEMs.')
      }
    },
    [ensureOemId, oemItems, token]
  )

  const handleSave = async () => {
    if (!allowEdit) return
    if (!isEditing || saving || !productoId) return
    setSubmitAttempted(true)
    setSaving(true)

    const payload = {
      codigo: formData.codigo.trim(),
      nombre: formData.nombre.trim(),
      descripcion: formData.descripcion.trim(),
      pieza_original: Boolean(formData.pieza_original),
      costo_minimo: parseNumber(formData.costo_minimo),
      precio: parseNumber(formData.precio),
      marca_id: formData.marcaId ? Number(formData.marcaId) : null,
      casas_comerciales_ids: (formData.casasIds || []).map((id) => Number(id)),
    }

    if (!payload.codigo) {
      setSaving(false)
      notifyError('Define un código para el producto.')
      return
    }

    if (!payload.nombre) {
      setSaving(false)
      notifyError('Define un nombre para el producto.')
      return
    }

    if (!payload.descripcion) {
      setSaving(false)
      notifyError('Define una descripcion para el producto.')
      return
    }

    if (!payload.marca_id) {
      setSaving(false)
      notifyError('Selecciona una marca para el producto.')
      return
    }

    if (!payload.casas_comerciales_ids.length) {
      setSaving(false)
      notifyError('Selecciona una casa comercial para el producto.')
      return
    }

    if (payload.precio === null) {
      setSaving(false)
      notifyError('Define un precio para el producto.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/productos/listado/${productoId}/`,
        {
          method: 'PUT',
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
          data?.marca_id?.[0] ||
          data?.casas_comerciales_ids?.[0] ||
          'No se pudo actualizar el producto.'
        throw new Error(detail)
      }

      const normalized = normalizeProducto(data)
      setFormData(normalized)
      setOriginalData(normalized)
      const marcaNombre = data?.marca?.nombre ?? ''
      setMarcaQuery(marcaNombre)
      setOriginalMarcaNombre(marcaNombre)
      const casas = Array.isArray(data?.casas_comerciales) ? data.casas_comerciales : []
      const casaPrincipal = casas[0] || null
      setSelectedCasa(casaPrincipal)
      setOriginalCasa(casaPrincipal)
      const nextAlternativas = Array.isArray(alternativas) ? alternativas : []
      setAlternativas(nextAlternativas)
      setOriginalAlternativas(nextAlternativas)
      const nextOems = Array.isArray(oemItems) ? oemItems : []
      setOemItems(nextOems)
      setOriginalOemItems(nextOems)
      setShowOemForm(false)
      setOemDraft({ codigo: '', descripcion: '' })
      setOemError('')
      setShowMarcaDropdown(false)
      setShowCasaDropdown(false)
      setAlternoQuery('')
      setAlternoOptions([])
      setAlternoLoading(false)
      setShowAlternoDropdown(false)
      setShowAlternoForm(false)
      setAlternoDraft(null)
      setAlternoError('')
      if (inventarioEditorRef.current?.save) {
        await inventarioEditorRef.current.save()
      }
      try {
        await syncAlternos(productoId, data?.codigo || payload.codigo)
      } catch (alternosError) {
        notifyError(alternosError?.message || 'No se pudieron actualizar los alternos.')
      }
      try {
        await syncOems(productoId, data?.codigo || payload.codigo)
      } catch (oemsError) {
        notifyError(oemsError?.message || 'No se pudieron actualizar los OEMs.')
      }
      setSubmitAttempted(false)
      setIsEditing(false)
      onUpdated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al actualizar el producto.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!allowDelete) return
    if (!isEditing || deleteLoading || !productoId) return
    setDeleteLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/productos/listado/${productoId}/`,
        { method: 'DELETE' },
        token
      )

      if (!response.ok && response.status !== 204) {
        const data = await response.json().catch(() => ({}))
        const detail = data?.detail || 'No se pudo eliminar el producto.'
        throw new Error(detail)
      }

      onDeleted?.(productoId)
      setShowDeleteDialog(false)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al eliminar el producto.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleCancelEdit = () => {
    setFormData(originalData)
    setMarcaQuery(originalMarcaNombre)
    setSelectedCasa(originalCasa)
    setAlternativas(originalAlternativas)
    setOemItems(originalOemItems)
    setShowOemForm(false)
    setOemDraft({ codigo: '', descripcion: '' })
    setOemError('')
    setAlternoQuery('')
    setAlternoOptions([])
    setShowAlternoDropdown(false)
    setShowAlternoForm(false)
    setAlternoDraft(null)
    setAlternoError('')
    setShowMarcaDropdown(false)
    setShowCasaDropdown(false)
    setSubmitAttempted(false)
    setIsEditing(false)
  }

  const handleToggleEdit = () => {
    if (!allowEdit) return
    if (loadingData || saving || deleteLoading) return
    if (isEditing) {
      handleCancelEdit()
      return
    }
    setSubmitAttempted(false)
    setIsEditing(true)
  }

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

  const precioBase = parseNumber(formData.precio)
  const precioConIva = precioBase != null ? precioBase * (1 + ivaRate) : null
  const precioPromedio = null

  const editorDisabled = saving || loadingData || !isEditing
  const precioInvalid = submitAttempted && isEditing && parseNumber(formData.precio) === null
  const marcaInvalid = submitAttempted && isEditing && !Number(formData.marcaId)
  const casaInvalid = submitAttempted && isEditing && !(Array.isArray(formData.casasIds) && formData.casasIds.length)

  return (
    <div
      className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`}
      role="dialog"
      aria-modal="true"
      style={overlayStyle}
    >
      <div
        className={`create-user__modal${submitAttempted && isEditing ? ' create-user__modal--submitted' : ''}${isClosing ? ' create-user__modal--closing' : ''}`}
        ref={modalRef}
        style={modalStyle}
      >
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>
              {formData.codigo && formData.nombre
                ? `${formData.codigo}: ${formData.nombre}`
                : (formData.codigo || formData.nombre || (productoId ? `Producto #${productoId}` : 'Producto'))}
            </h3>
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

        <div className="create-user__content">
          {loadingData && (
            <div className="create-user__loading-overlay" role="status" aria-live="polite">
              <i className="pi pi-spin pi-spinner" aria-hidden="true" />
              <span>Cargando datos...</span>
            </div>
          )}
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
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'recordatorios' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('recordatorios')}
              aria-selected={activeTab === 'recordatorios'}
            >
              Recordatorios
            </button>
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'calificaciones' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('calificaciones')}
              aria-selected={activeTab === 'calificaciones'}
            >
              Calificaciones
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
                        value={formData.nombre}
                        onChange={handleChange}
                        required
                        disabled={editorDisabled}
                      />
                    </label>

                    <label className="create-user__field create-user__field--required">
                      <span>Marca</span>
                      <div
                        className={`create-user__dropdown${marcaInvalid ? ' create-user__dropdown--invalid' : ''}`}
                        ref={marcaDropdownRef}
                      >
                        <button
                          type="button"
                          className="create-user__dropdown-trigger"
                          onClick={() => {
                            if (editorDisabled) return
                            setShowMarcaDropdown((prev) => !prev)
                            setShowCasaDropdown(false)
                          }}
                          disabled={editorDisabled}
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
                                disabled={editorDisabled}
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
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    handleMarcaSelect(brand)
                                  }}
                                  disabled={editorDisabled}
                                >
                                  <div className="create-user__result-info">
                                    <strong>{brand.nombre}</strong>
                                    <small>{brand.codigo ? `Código: ${brand.codigo}` : `ID: ${brand.id}`}</small>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </label>

                    <label className="create-user__field">
                      <span>Código</span>
                      <input
                        name="codigo"
                        type="text"
                        value={formData.codigo}
                        onChange={handleChange}
                        required
                        disabled={editorDisabled}
                      />
                    </label>

                    <label className="create-user__field create-user__field--required">
                      <span>Casa comercial</span>
                      <div
                        className={`create-user__dropdown${casaInvalid ? ' create-user__dropdown--invalid' : ''}`}
                        ref={casaDropdownRef}
                      >
                        <button
                          type="button"
                          className="create-user__dropdown-trigger"
                          onClick={() => {
                            if (editorDisabled) return
                            setShowCasaDropdown((prev) => !prev)
                            setShowMarcaDropdown(false)
                          }}
                          disabled={editorDisabled}
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
                                disabled={editorDisabled}
                              />
                            </div>

                            <div className="create-user__dropdown-results">
                              {!casaSearch.trim() && <small className="muted">Escribe para buscar.</small>}
                              {casaSearch.trim() && !filteredSuppliers.length && (
                                <small className="muted">Sin resultados.</small>
                              )}
                              {filteredSuppliers.map((supplier) => (
                                <button
                                  key={supplier.id}
                                  type="button"
                                  className="create-user__result-option"
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    handleCasaSelect(supplier)
                                  }}
                                  disabled={editorDisabled}
                                >
                                  <div className="create-user__result-info">
                                    <strong>{supplier.nombre}</strong>
                                    <small>{supplier.codigo ? `Código: ${supplier.codigo}` : `ID: ${supplier.id}`}</small>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </label>

                    <label className="create-user__checkbox">
                      <input
                        name="pieza_original"
                        type="checkbox"
                        checked={Boolean(formData.pieza_original)}
                        onChange={handleChange}
                        disabled={editorDisabled}
                      />
                      <div>
                        <span>Original</span>
                        <p>Marcar cuando la pieza es original.</p>
                      </div>
                    </label>

                    <label className="create-user__field create-user__field--full">
                      <span>Descripción</span>
                      <textarea
                        name="descripcion"
                        value={formData.descripcion}
                        onChange={handleChange}
                        required
                        disabled={editorDisabled}
                      />
                    </label>
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
                            value={formData.costo_minimo}
                            onChange={handleChange}
                            disabled={editorDisabled}
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
                          value={formData.precio}
                          onChange={handleChange}
                          required
                          disabled={editorDisabled}
                        />
                      </div>
                    </label>
                  </div>

                  <div className="producto-details__price-metrics">
                    <div className="producto-details__metric-card">
                      <span className="producto-details__metric-label">Precio promedio</span>
                      <strong className="producto-details__metric-value">{formatCurrency(precioPromedio)}</strong>
                    </div>
                    <div className="producto-details__metric-card">
                      <span className="producto-details__metric-label">Precio con IVA</span>
                      <strong className="producto-details__metric-value">{formatCurrency(precioConIva)}</strong>
                    </div>
                    <div className="producto-details__metric-note">
                      <p>*Precio promedio: se calcula automáticamente con la información de salidas por ventas.</p>
                      <p>
                        IVA configurado: {ivaLoading ? '...' : `${Math.round(ivaRate * 100)}%`} (ajustable en Configuración).
                      </p>
                    </div>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <h4>OEMs</h4>
                    <button
                      type="button"
                      className="create-user__ghost create-user__location-action"
                      onClick={() => {
                        if (editorDisabled) return
                        setOemError('')
                        setShowOemForm((prev) => {
                          const next = !prev
                          if (!next) {
                            setOemDraft({ codigo: '', descripcion: '' })
                          }
                          return next
                        })
                      }}
                      disabled={editorDisabled}
                    >
                      {showOemForm ? 'Cancelar' : 'Agregar OEM'}
                    </button>
                  </div>

                  <div className="create-user__locations-table create-user__locations-table--oem">
                    <div className="create-user__locations-row create-user__locations-row--head">
                      <span>Código</span>
                      <span>Descripción</span>
                      <span>Acciones</span>
                    </div>

                    {showOemForm && (
                      <div className="create-user__locations-row create-user__locations-row--form">
                        <span>
                          <input
                            type="text"
                            placeholder="Código OEM"
                            value={oemDraft.codigo}
                            onChange={(event) => handleOemDraftChange('codigo', event.target.value)}
                            disabled={editorDisabled}
                          />
                        </span>
                        <span>
                          <input
                            type="text"
                            placeholder="Descripción (opcional)"
                            value={oemDraft.descripcion}
                            onChange={(event) => handleOemDraftChange('descripcion', event.target.value)}
                            disabled={editorDisabled}
                          />
                        </span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button
                            type="button"
                            className="create-user__ghost"
                            onClick={handleAddOem}
                            disabled={editorDisabled}
                          >
                            Agregar
                          </button>
                        </span>
                      </div>
                    )}

                    {!oemItems.length && !showOemForm && (
                      <div className="create-user__locations-row create-user__locations-row--empty">
                        <span>No hay OEMs registrados.</span>
                      </div>
                    )}

                    {oemItems.map((item, index) => (
                      <div key={`${item.codigo}-${index}`} className="create-user__locations-row">
                        <span>{item.codigo || '-'}</span>
                        <span>{item.descripcion || '-'}</span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button
                            type="button"
                            className="create-user__locations-remove"
                            onClick={() => handleRemoveOem(item.codigo)}
                            disabled={editorDisabled}
                            aria-label="Eliminar OEM"
                          >
                            x
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>

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
                      if (editorDisabled) return
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
                    disabled={editorDisabled}
                  >
                    {showAlternoForm ? 'Cancelar' : 'Agregar alterno'}
                  </button>
                </div>

                <div className="create-user__locations-table create-user__locations-table--alternos">
                  <div className="create-user__locations-row create-user__locations-row--head">
                    <span>Código</span>
                    <span>Producto</span>
                    <span>Descripción</span>
                    <span>Acciones</span>
                  </div>

                  {showAlternoForm && (
                    <div className="create-user__locations-row create-user__locations-row--form">
                      <span>{alternoDraft?.codigo || '-'}</span>
                      <span>
                        <div className="create-user__dropdown" ref={alternoDropdownRef}>
                          <button
                            type="button"
                            className="create-user__dropdown-trigger"
                            onClick={() => {
                              if (editorDisabled) return
                              setShowAlternoDropdown((prev) => !prev)
                              setShowMarcaDropdown(false)
                              setShowCasaDropdown(false)
                            }}
                            disabled={editorDisabled}
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
                                  disabled={editorDisabled}
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
                                      disabled={isSelected || editorDisabled}
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
                      <span>{alternoDraft?.descripcion || '-'}</span>
                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={handleAddAlternoDraft}
                          disabled={editorDisabled}
                        >
                          Agregar
                        </button>
                      </span>
                    </div>
                  )}

                  {!alternativas.length && !showAlternoForm && (
                    <div className="create-user__locations-row create-user__locations-row--empty">
                      <span>No hay alternos registrados.</span>
                    </div>
                  )}

                  {alternativas.map((alterno, index) => (
                    <div key={`${alterno.id}-${index}`} className="create-user__locations-row">
                      <span>{alterno.codigo || '-'}</span>
                      <span>{alterno.nombre || 'Sin nombre'}</span>
                      <span>{alterno.descripcion || '-'}</span>
                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button
                          type="button"
                          className="create-user__locations-remove"
                          onClick={() => handleRemoveAlterno(alterno.id)}
                          disabled={editorDisabled}
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
              <>
                {inventoryLoading && (
                  <div className="inventario-details__empty">
                    <Info size={18} />
                    <span>Cargando ubicaciones...</span>
                  </div>
                )}
                {!inventoryLoading && resolvedInventoryContext && (
                  <InventarioEditor
                    ref={inventarioEditorRef}
                    productId={productoId}
                    token={token}
                    branches={resolvedInventoryContext?.branches || []}
                    bodegas={resolvedInventoryContext?.bodegas || []}
                    subdivisions={resolvedInventoryContext?.subdivisions || []}
                    inventarioEntries={resolvedInventoryContext?.inventarioEntries || []}
                    disabled={editorDisabled}
                    onSaved={resolvedInventoryContext?.onSaved}
                    onError={notifyError}
                  />
                )}
                {!inventoryLoading && !resolvedInventoryContext && (
                  <div className="inventario-details__empty">
                    <Info size={18} />
                    <span>No se pudieron cargar las ubicaciones.</span>
                  </div>
                )}
              </>
            )}

            {activeTab === 'recordatorios' && (
              <EntityRemindersTab
                token={token}
                currentUser={currentUser}
                entityType="producto"
                entityId={productoId}
                entityLabel={formData.nombre || (productoId ? `Producto #${productoId}` : 'Producto')}
                canCreateReminder={allowComment}
                onError={notifyError}
              />
            )}

            {activeTab === 'calificaciones' && (
              <ProductoRatingTab
                productoId={productoId}
                token={token}
                onError={notifyError}
                canComment={allowComment}
              />
            )}

          </div>
        </div>

        <div className="create-user__footer">
          <div className="user-details__footer-left">
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={isEditing ? handleCancelEdit : onClose}
              disabled={saving}
            >
              Cancelar
            </button>
            {allowEdit && (
              <button
                type="button"
                className={`create-user__action create-user__action--edit user-details__edit-toggle${isEditing ? ' user-details__edit-toggle--active' : ''}`}
                onClick={handleToggleEdit}
                disabled={loadingData || saving || deleteLoading}
              >
                <span className="user-details__toggle-icon" aria-hidden="true">
                  {isEditing ? <Eye size={14} /> : <Pencil size={14} />}
                </span>
                <span>{isEditing ? 'Solo lectura' : 'Editar'}</span>
              </button>
            )}
          </div>

          <div className="user-details__footer-right">
            {isEditing && (
              <>
                {allowDelete && (
                  <button
                    type="button"
                    className="create-user__action user-details__delete"
                    onClick={() => setShowDeleteDialog(true)}
                    disabled={saving}
                  >
                    Eliminar
                  </button>
                )}
                {allowEdit && (
                  <button
                    type="button"
                    className="create-user__action create-user__action--primary"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    {saving ? 'Guardando...' : 'Guardar cambios'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        <button
          type="button"
          aria-label="Cambiar tamano de ventana"
          className="create-user__resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      </div>

      {allowDelete && showDeleteDialog && (
        <div className="user-details__confirm-overlay">
          <div className="user-details__confirm-dialog">
            <div className="user-details__confirm-icon">
              <Info size={18} />
            </div>
            <div className="user-details__confirm-content">
              <h4>Eliminar producto</h4>
              <p>Deseas eliminar este producto? Esta accion no se puede deshacer.</p>
            </div>
            <div className="user-details__confirm-actions">
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={() => setShowDeleteDialog(false)}
                disabled={deleteLoading}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="create-user__action user-details__confirm-danger"
                onClick={handleDelete}
                disabled={deleteLoading}
              >
                {deleteLoading ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ProductoDetails
