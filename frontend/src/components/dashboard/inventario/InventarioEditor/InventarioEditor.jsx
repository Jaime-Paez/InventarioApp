import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeftRight, Check, X } from 'lucide-react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../InventarioDetails/InventarioDetails.css'
import { API_URL, authFetch } from '../../../../utils/api'
import { emitRemindersSync } from '../../common/reminders/remindersStorage'
import BodegaLocationPreview from './BodegaLocationPreview'
import { getAppPortalRoot as getPortalHost } from '../../../../utils/portalRoot'
import { useCloseDropdownsOnTabSwitch } from '../../../../hooks/useCloseDropdownsOnTabSwitch'

const parseNumber = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor(parsed))
}
const parseQuantity = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.floor(parsed))
}
const normalizeScopeBranchId = (value) => String(value ?? '').trim()
const normalizeForSearch = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
const SCOPE_EDIT_LOCATION_ERROR =
  'No puedes modificar esta ubicacion porque pertenece a una sucursal sin permiso. Solo puedes editar o eliminar ubicaciones en las sucursales que tienes autorizadas en Productos.'
const SCOPE_DELETE_LOCATION_ERROR =
  'No puedes eliminar esta ubicacion porque pertenece a una sucursal sin permiso. Solo puedes eliminar ubicaciones en las sucursales que tienes autorizadas en Productos.'
const normalizeErrorText = (value) => String(value ?? '').trim().toLowerCase()

const InventarioEditor = forwardRef(function InventarioEditor(
  {
    productId,
    token,
    branches = [],
    bodegas = [],
    subdivisions = [],
    inventarioEntries = [],
    editableBranchIds = null,
    fullyEditableBranchIds = null,
    disabled = false,
    onSaved,
    onError,
  },
  ref
) {
  const [saving, setSaving] = useState(false)
  const [transferSaving, setTransferSaving] = useState(false)
  const [error, setError] = useState(null)
  const [locations, setLocations] = useState([])
  const [locationDraft, setLocationDraft] = useState({
    sucursalId: '',
    bodegaId: '',
    divisionId: '',
    subdivisionId: '',
    cantidad: '1',
  })
  const [showLocationForm, setShowLocationForm] = useState(false)
  const [locationError, setLocationError] = useState('')
  const [showLocationBranchDropdown, setShowLocationBranchDropdown] = useState(false)
  const [showLocationBodegaDropdown, setShowLocationBodegaDropdown] = useState(false)
  const [showLocationDivisionDropdown, setShowLocationDivisionDropdown] = useState(false)
  const [showLocationSubdivisionDropdown, setShowLocationSubdivisionDropdown] = useState(false)
  const [locationBranchQuery, setLocationBranchQuery] = useState('')
  const [locationBodegaQuery, setLocationBodegaQuery] = useState('')
  const [locationDivisionQuery, setLocationDivisionQuery] = useState('')
  const [locationSubdivisionQuery, setLocationSubdivisionQuery] = useState('')
  const [locationBranchDebouncedQuery, setLocationBranchDebouncedQuery] = useState('')
  const [locationBodegaDebouncedQuery, setLocationBodegaDebouncedQuery] = useState('')
  const [locationDivisionDebouncedQuery, setLocationDivisionDebouncedQuery] = useState('')
  const [locationSubdivisionDebouncedQuery, setLocationSubdivisionDebouncedQuery] = useState('')
  const [openRowDropdown, setOpenRowDropdown] = useState(null) // { uid, field }
  const [rowDropdownQuery, setRowDropdownQuery] = useState('')
  const [rowDropdownDebouncedQuery, setRowDropdownDebouncedQuery] = useState('')

  const [transferUid, setTransferUid] = useState(null)
  const [transferDraft, setTransferDraft] = useState({ bodegaId: '', divisionId: '', subdivisionId: '', cantidad: '1' })
  const [openTransferDropdown, setOpenTransferDropdown] = useState(null) // 'bodega' | 'division' | 'subdivision'
  const [transferDropdownRect, setTransferDropdownRect] = useState(null)
  const [transferDropdownQuery, setTransferDropdownQuery] = useState('')
  const [transferDropdownDebouncedQuery, setTransferDropdownDebouncedQuery] = useState('')

  const locationBranchDropdownRef = useRef(null)
  const locationBodegaDropdownRef = useRef(null)
  const locationDivisionDropdownRef = useRef(null)
  const locationSubdivisionDropdownRef = useRef(null)
  const rowDropdownRef = useRef(null)
  const transferDropdownRef = useRef(null)
  const transferPanelRef = useRef(null)
  const lastNotifiedErrorRef = useRef({ message: '', at: 0 })

  const notifyErrorOnce = useCallback(
    (message) => {
      const normalizedMessage = String(message || '').trim()
      if (!normalizedMessage) return
      const now = Date.now()
      const last = lastNotifiedErrorRef.current
      if (last.message === normalizedMessage && now - last.at < 700) return
      lastNotifiedErrorRef.current = { message: normalizedMessage, at: now }
      onError?.(normalizedMessage)
    },
    [onError]
  )

  useEffect(() => {
    if (!locationError) return
    notifyErrorOnce(locationError)
  }, [locationError, notifyErrorOnce])

  useEffect(() => {
    if (!error) return
    notifyErrorOnce(error)
  }, [error, notifyErrorOnce])

  const entryBySubdivision = useMemo(() => {
    const map = new Map()
    inventarioEntries.forEach((entry) => {
      const subdivisionId = entry?.subdivisionId ?? entry?.subdivision?.id
      if (!subdivisionId) return
      const key = String(subdivisionId)
      if (!map.has(key)) {
        map.set(key, entry)
      }
    })
    return map
  }, [inventarioEntries])

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
  const divisions = useMemo(() => {
    const map = new Map()
    subdivisions.forEach((subdivision) => {
      const division = subdivision?.division
      if (!division?.id) return
      if (!map.has(division.id)) map.set(division.id, division)
    })
    return Array.from(map.values())
  }, [subdivisions])
  const divisionById = useMemo(
    () => new Map(divisions.map((division) => [String(division.id), division])),
    [divisions]
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

  useEffect(() => {
    const timer = window.setTimeout(
      () => setLocationBranchDebouncedQuery(normalizeForSearch(locationBranchQuery)),
      260
    )
    return () => window.clearTimeout(timer)
  }, [locationBranchQuery])

  useEffect(() => {
    const timer = window.setTimeout(
      () => setLocationBodegaDebouncedQuery(normalizeForSearch(locationBodegaQuery)),
      260
    )
    return () => window.clearTimeout(timer)
  }, [locationBodegaQuery])

  useEffect(() => {
    const timer = window.setTimeout(
      () => setLocationDivisionDebouncedQuery(normalizeForSearch(locationDivisionQuery)),
      260
    )
    return () => window.clearTimeout(timer)
  }, [locationDivisionQuery])

  useEffect(() => {
    const timer = window.setTimeout(
      () => setLocationSubdivisionDebouncedQuery(normalizeForSearch(locationSubdivisionQuery)),
      260
    )
    return () => window.clearTimeout(timer)
  }, [locationSubdivisionQuery])

  useEffect(() => {
    if (
      !showLocationBranchDropdown &&
      !showLocationBodegaDropdown &&
      !showLocationDivisionDropdown &&
      !showLocationSubdivisionDropdown
    ) {
      return undefined
    }

    const handleOutsideClick = (event) => {
      const target = event.target
      if (
        showLocationBranchDropdown &&
        locationBranchDropdownRef.current &&
        !locationBranchDropdownRef.current.contains(target)
      ) {
        setShowLocationBranchDropdown(false)
      }
      if (
        showLocationBodegaDropdown &&
        locationBodegaDropdownRef.current &&
        !locationBodegaDropdownRef.current.contains(target)
      ) {
        setShowLocationBodegaDropdown(false)
      }
      if (
        showLocationDivisionDropdown &&
        locationDivisionDropdownRef.current &&
        !locationDivisionDropdownRef.current.contains(target)
      ) {
        setShowLocationDivisionDropdown(false)
      }
      if (
        showLocationSubdivisionDropdown &&
        locationSubdivisionDropdownRef.current &&
        !locationSubdivisionDropdownRef.current.contains(target)
      ) {
        setShowLocationSubdivisionDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [
    showLocationBranchDropdown,
    showLocationBodegaDropdown,
    showLocationDivisionDropdown,
    showLocationSubdivisionDropdown,
  ])

  useEffect(() => {
    const timer = window.setTimeout(
      () => setRowDropdownDebouncedQuery(normalizeForSearch(rowDropdownQuery)),
      260
    )
    return () => window.clearTimeout(timer)
  }, [rowDropdownQuery])

  useEffect(() => {
    if (!openRowDropdown) return undefined
    const handleOutsideClick = (event) => {
      if (rowDropdownRef.current && !rowDropdownRef.current.contains(event.target)) {
        setOpenRowDropdown(null)
        setRowDropdownQuery('')
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [openRowDropdown])

  useEffect(() => {
    if (!openTransferDropdown) return undefined
    const handleOutsideClick = (event) => {
      const inTrigger = transferDropdownRef.current?.contains(event.target)
      const inPanel = transferPanelRef.current?.contains(event.target)
      if (!inTrigger && !inPanel) {
        setOpenTransferDropdown(null)
        setTransferDropdownQuery('')
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [openTransferDropdown])

  useCloseDropdownsOnTabSwitch(
    useCallback(() => {
      setOpenTransferDropdown(null)
      setTransferDropdownRect(null)
      setTransferDropdownQuery('')
    }, [])
  )

  useEffect(() => {
    const timer = window.setTimeout(
      () => setTransferDropdownDebouncedQuery(normalizeForSearch(transferDropdownQuery)),
      260
    )
    return () => window.clearTimeout(timer)
  }, [transferDropdownQuery])

  const filteredLocationBranches = useMemo(() => {
    if (!locationBranchDebouncedQuery) return branches
    return branches.filter((branch) => {
      const branchName = normalizeForSearch(branch?.nombre)
      const branchAddress = normalizeForSearch(branch?.direccion)
      return (
        branchName.includes(locationBranchDebouncedQuery) ||
        branchAddress.includes(locationBranchDebouncedQuery)
      )
    })
  }, [branches, locationBranchDebouncedQuery])

  const filteredLocationBodegas = useMemo(() => {
    if (!locationBodegaDebouncedQuery) return availableBodegas
    return availableBodegas.filter((bodega) =>
      normalizeForSearch(bodega?.nombre).includes(locationBodegaDebouncedQuery)
    )
  }, [availableBodegas, locationBodegaDebouncedQuery])

  const filteredLocationDivisions = useMemo(() => {
    if (!locationDivisionDebouncedQuery) return availableDivisions
    return availableDivisions.filter((division) =>
      normalizeForSearch(division?.nombre).includes(locationDivisionDebouncedQuery)
    )
  }, [availableDivisions, locationDivisionDebouncedQuery])

  const filteredLocationSubdivisions = useMemo(() => {
    if (!locationSubdivisionDebouncedQuery) return availableSubdivisions
    return availableSubdivisions.filter((subdivision) =>
      normalizeForSearch(subdivision?.nombre).includes(locationSubdivisionDebouncedQuery)
    )
  }, [availableSubdivisions, locationSubdivisionDebouncedQuery])

  const usedSubdivisionIds = useMemo(
    () => new Set(locations.map((loc) => String(loc.subdivisionId)).filter(Boolean)),
    [locations]
  )

  const selectedLocationBranch = useMemo(
    () => branchById.get(String(locationDraft.sucursalId || '')) || null,
    [branchById, locationDraft.sucursalId]
  )
  const selectedLocationBodega = useMemo(
    () => bodegaById.get(String(locationDraft.bodegaId || '')) || null,
    [bodegaById, locationDraft.bodegaId]
  )
  const selectedLocationDivision = useMemo(
    () => divisionById.get(String(locationDraft.divisionId || '')) || null,
    [divisionById, locationDraft.divisionId]
  )
  const selectedLocationSubdivision = useMemo(
    () => subdivisionById.get(String(locationDraft.subdivisionId || '')) || null,
    [subdivisionById, locationDraft.subdivisionId]
  )
  const editableBranchIdSet = useMemo(() => {
    if (editableBranchIds == null) return null
    const branchIds = editableBranchIds instanceof Set
      ? Array.from(editableBranchIds)
      : (Array.isArray(editableBranchIds) ? editableBranchIds : [])
    return new Set(branchIds.map((branchId) => normalizeScopeBranchId(branchId)).filter(Boolean))
  }, [editableBranchIds])
  const canManageBranchLocation = useCallback(
    (branchId) => {
      if (!(editableBranchIdSet instanceof Set)) return true
      const normalizedBranchId = normalizeScopeBranchId(branchId)
      if (!normalizedBranchId) return false
      return editableBranchIdSet.has(normalizedBranchId)
    },
    [editableBranchIdSet]
  )
  const canManageLocationDraft = useMemo(
    () => (!locationDraft.sucursalId ? true : canManageBranchLocation(locationDraft.sucursalId)),
    [locationDraft.sucursalId, canManageBranchLocation]
  )

  const editorDisabled = disabled || saving
  const transferBusy = saving || transferSaving
  const createLocationUid = useCallback(
    () => `loc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    []
  )

  const resetEditorState = useCallback(() => {
    const nextLocations = inventarioEntries
      .map((entry) => {
        const subdivisionId = entry?.subdivisionId ?? entry?.subdivision?.id
        if (!subdivisionId) return null
        const subdivision = subdivisionById.get(String(subdivisionId)) || entry?.subdivision
        const division = subdivision?.division || divisionById.get(String(subdivision?.division?.id))
        const bodega = division?.bodega || bodegaById.get(String(division?.bodega?.id))
        const sucursal = bodega?.sucursal || branchById.get(String(bodega?.sucursal?.id ?? bodega?.sucursal_id))

        return {
          uid: entry?.id ? `entry-${entry.id}` : createLocationUid(),
          sucursalId: sucursal?.id ? String(sucursal.id) : '',
          sucursalNombre: sucursal?.nombre || '-',
          bodegaId: bodega?.id ? String(bodega.id) : '',
          bodegaNombre: bodega?.nombre || '-',
          divisionId: division?.id ? String(division.id) : '',
          divisionNombre: division?.nombre || '-',
          subdivisionId: String(subdivisionId),
          subdivisionNombre: subdivision?.nombre || '-',
          cantidad: entry?.cantidad ?? 0,
        }
      })
      .filter(Boolean)

    setLocations(nextLocations)
    setShowLocationForm(false)
    setLocationDraft({
      sucursalId: '',
      bodegaId: '',
      divisionId: '',
      subdivisionId: '',
      cantidad: '1',
    })
    setLocationError('')
    setShowLocationBranchDropdown(false)
    setShowLocationBodegaDropdown(false)
    setShowLocationDivisionDropdown(false)
    setShowLocationSubdivisionDropdown(false)
    setLocationBranchQuery('')
    setLocationBodegaQuery('')
    setLocationDivisionQuery('')
    setLocationSubdivisionQuery('')
    setLocationBranchDebouncedQuery('')
    setLocationBodegaDebouncedQuery('')
    setLocationDivisionDebouncedQuery('')
    setLocationSubdivisionDebouncedQuery('')
  }, [
    inventarioEntries,
    subdivisionById,
    bodegaById,
    branchById,
    divisionById,
    createLocationUid,
    productId,
  ])

  useEffect(() => {
    resetEditorState()
  }, [resetEditorState])

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

  const closeAllLocationDropdowns = () => {
    setShowLocationBranchDropdown(false)
    setShowLocationBodegaDropdown(false)
    setShowLocationDivisionDropdown(false)
    setShowLocationSubdivisionDropdown(false)
  }

  const handleLocationBranchPick = (branch) => {
    if (!canManageBranchLocation(branch?.id)) {
      setLocationError(SCOPE_EDIT_LOCATION_ERROR)
      return
    }
    handleLocationSelect('sucursalId', String(branch?.id || ''))
    closeAllLocationDropdowns()
    setLocationBodegaQuery('')
    setLocationDivisionQuery('')
    setLocationSubdivisionQuery('')
  }

  const handleLocationBodegaPick = (bodega) => {
    handleLocationSelect('bodegaId', String(bodega?.id || ''))
    closeAllLocationDropdowns()
    setLocationDivisionQuery('')
    setLocationSubdivisionQuery('')
  }

  const handleLocationDivisionPick = (division) => {
    handleLocationSelect('divisionId', String(division?.id || ''))
    closeAllLocationDropdowns()
    setLocationSubdivisionQuery('')
  }

  const handleLocationSubdivisionPick = (subdivision) => {
    handleLocationSelect('subdivisionId', String(subdivision?.id || ''))
    closeAllLocationDropdowns()
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
    if (!canManageBranchLocation(sucursalId)) {
      setLocationError(SCOPE_EDIT_LOCATION_ERROR)
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
      setLocationError('Selecciona una subdivision.')
      return
    }
    if (!quantity || quantity <= 0) {
      setLocationError('Ingresa una cantidad valida.')
      return
    }
    const allowedSubs = subdivisionsByDivision.get(String(divisionId)) || []
    if (!allowedSubs.some((sub) => String(sub.id) === String(subdivisionId))) {
      setLocationError('La subdivision no pertenece a la division seleccionada.')
      return
    }
    if (locations.some((item) => item.subdivisionId === String(subdivisionId))) {
      setLocationError('Esa subdivision ya esta en la tabla.')
      return
    }

    const subdivision = subdivisionById.get(String(subdivisionId))
    const division = divisionById.get(String(divisionId))
    const bodega = bodegaById.get(String(bodegaId))
    const sucursal = branchById.get(String(sucursalId))

    const nextEntry = {
      uid: createLocationUid(),
      sucursalId: String(sucursalId),
      sucursalNombre: sucursal?.nombre || '-',
      bodegaId: String(bodegaId),
      bodegaNombre: bodega?.nombre || '-',
      divisionId: String(divisionId),
      divisionNombre: division?.nombre || subdivision?.division?.nombre || '-',
      subdivisionId: String(subdivisionId),
      subdivisionNombre: subdivision?.nombre || '-',
      cantidad: quantity,
    }

    setLocations((prev) => [...prev, nextEntry])
    setLocationDraft((prev) => ({
      ...prev,
      divisionId: '',
      subdivisionId: '',
      cantidad: '1',
    }))
    setLocationDivisionQuery('')
    setLocationSubdivisionQuery('')
    closeAllLocationDropdowns()
    setLocationError('')
  }

  const fullyEditableBranchIdSet = useMemo(() => {
    if (fullyEditableBranchIds == null) return null
    const branchIds = Array.isArray(fullyEditableBranchIds) ? fullyEditableBranchIds : []
    return new Set(branchIds.map((id) => normalizeScopeBranchId(id)).filter(Boolean))
  }, [fullyEditableBranchIds])

  const canInlineEditBranchLocation = useCallback(
    (branchId) => {
      if (!(fullyEditableBranchIdSet instanceof Set)) return true
      const normalizedBranchId = normalizeScopeBranchId(branchId)
      if (!normalizedBranchId) return false
      return fullyEditableBranchIdSet.has(normalizedBranchId)
    },
    [fullyEditableBranchIdSet]
  )

  const handleRowFieldChange = (uid, field, id, nombre) => {
    setLocations((prev) => prev.map((loc) => {
      if (loc.uid !== uid) return loc
      switch (field) {
        case 'sucursal':
          return { ...loc, sucursalId: String(id), sucursalNombre: nombre, bodegaId: '', bodegaNombre: '-', divisionId: '', divisionNombre: '-', subdivisionId: '', subdivisionNombre: '-' }
        case 'bodega':
          return { ...loc, bodegaId: String(id), bodegaNombre: nombre, divisionId: '', divisionNombre: '-', subdivisionId: '', subdivisionNombre: '-' }
        case 'division':
          return { ...loc, divisionId: String(id), divisionNombre: nombre, subdivisionId: '', subdivisionNombre: '-' }
        case 'subdivision':
          return { ...loc, subdivisionId: String(id), subdivisionNombre: nombre }
        default:
          return loc
      }
    }))
    setOpenRowDropdown(null)
    setRowDropdownQuery('')
  }

  const handleRowCantidadChange = (uid, value) => {
    setLocations((prev) => prev.map((loc) =>
      loc.uid !== uid ? loc : { ...loc, cantidad: value }
    ))
  }

  const handleRemoveLocation = (location) => {
    if (editorDisabled) return
    if (!canManageBranchLocation(location?.sucursalId)) {
      setLocationError(SCOPE_DELETE_LOCATION_ERROR)
      return
    }
    setLocations((prev) => prev.filter((item) => item.uid !== location.uid))
    setLocationError('')
  }

  const handleStartTransfer = (location) => {
    if (transferBusy) return
    // Mover cantidad entre ubicaciones de la MISMA sucursal no exige el
    // alcance de sucursal de canManageBranchLocation -- eso solo aplica a
    // agregar/eliminar ubicaciones (que si cambian el total), no a mover.
    setTransferUid(location.uid)
    setTransferDraft({
      bodegaId: location.bodegaId,
      divisionId: location.divisionId,
      subdivisionId: '',
      cantidad: String(location.cantidad || 1),
    })
    setLocationError('')
    setOpenTransferDropdown(null)
  }

  const handleCancelTransfer = () => {
    setTransferUid(null)
    setTransferDraft({ bodegaId: '', divisionId: '', subdivisionId: '', cantidad: '1' })
    setLocationError('')
    setOpenTransferDropdown(null)
  }

  const handleTransferSelect = (field, id) => {
    setTransferDraft((prev) => {
      if (field === 'bodega') return { ...prev, bodegaId: String(id), divisionId: '', subdivisionId: '' }
      if (field === 'division') return { ...prev, divisionId: String(id), subdivisionId: '' }
      return { ...prev, subdivisionId: String(id) }
    })
    setOpenTransferDropdown(null)
  }

  const handleConfirmTransfer = async (sourceLocation) => {
    if (transferSaving) return
    const destBodegaId = transferDraft.bodegaId
    const destDivisionId = transferDraft.divisionId
    const destSubdivisionId = transferDraft.subdivisionId
    const moveQty = parseQuantity(transferDraft.cantidad)
    const sourceQty = Number(sourceLocation.cantidad) || 0

    if (!destBodegaId || !destDivisionId || !destSubdivisionId) {
      setLocationError('Selecciona bodega, division y subdivision de destino.')
      return
    }
    if (String(destSubdivisionId) === String(sourceLocation.subdivisionId)) {
      setLocationError('Elige una ubicacion distinta a la actual.')
      return
    }
    if (!moveQty || moveQty <= 0) {
      setLocationError('Ingresa una cantidad valida.')
      return
    }
    if (moveQty > sourceQty) {
      setLocationError(`No puedes mover mas de ${sourceQty} unidades.`)
      return
    }
    if (!productId) return

    const subdivision = subdivisionById.get(String(destSubdivisionId))
    const division = divisionById.get(String(destDivisionId))
    const bodega = bodegaById.get(String(destBodegaId))
    const remaining = sourceQty - moveQty

    const sourceEntry = entryBySubdivision.get(String(sourceLocation.subdivisionId))

    setTransferSaving(true)
    setLocationError('')
    try {
      // Un solo endpoint dedicado (en vez de PUT/POST/DELETE crudos contra
      // /inventario/inventario/) porque reposicionar cantidad ya existente
      // entre ubicaciones de la MISMA sucursal no requiere permiso de
      // escritura completo -- solo mover cantidades (nunca crearlas ni
      // destruirlas), asi que el backend lo permite a cualquier usuario con
      // algun modulo asignado en esa sucursal, no solo a quien puede editar
      // productos/inventario directamente.
      const response = await authFetch(
        `${API_URL}/inventario/inventario/mover/`,
        {
          method: 'POST',
          body: JSON.stringify({
            producto_id: productId,
            origen_subdivision_id: Number(sourceLocation.subdivisionId),
            destino_subdivision_id: Number(destSubdivisionId),
            referencia: sourceEntry?.referencia ?? '',
            cantidad: moveQty,
          }),
        },
        token
      )

      if (!response.ok) {
        const detailPayload = await response.json().catch(() => ({}))
        const detailText = String(detailPayload?.detail || '').trim()
        if (response.status === 403 || normalizeErrorText(detailText).includes('no tienes acceso a la sucursal seleccionada')) {
          throw new Error(SCOPE_EDIT_LOCATION_ERROR)
        }
        throw new Error(detailText || 'No se pudo completar el traslado.')
      }

      const movePayload = await response.json().catch(() => ({}))
      if (movePayload?.reminders_sync_required) {
        emitRemindersSync()
      }

      setLocations((prev) => {
        const next = remaining > 0
          ? prev.map((loc) => (loc.uid === sourceLocation.uid ? { ...loc, cantidad: remaining } : loc))
          : prev.filter((loc) => loc.uid !== sourceLocation.uid)

        const existingDestIndex = next.findIndex((loc) => String(loc.subdivisionId) === String(destSubdivisionId))
        if (existingDestIndex !== -1) {
          return next.map((loc, i) =>
            i === existingDestIndex ? { ...loc, cantidad: (Number(loc.cantidad) || 0) + moveQty } : loc
          )
        }
        return [
          ...next,
          {
            uid: createLocationUid(),
            sucursalId: sourceLocation.sucursalId,
            sucursalNombre: sourceLocation.sucursalNombre,
            bodegaId: String(destBodegaId),
            bodegaNombre: bodega?.nombre || '-',
            divisionId: String(destDivisionId),
            divisionNombre: division?.nombre || '-',
            subdivisionId: String(destSubdivisionId),
            subdivisionNombre: subdivision?.nombre || '-',
            cantidad: moveQty,
          },
        ]
      })

      handleCancelTransfer()
      onSaved?.()
    } catch (err) {
      setLocationError(err?.message || 'No se pudo completar el traslado.')
    } finally {
      setTransferSaving(false)
    }
  }

  const saveChanges = async () => {
    if (!productId || saving) return
    setSaving(true)
    setError(null)

    try {
      const updates = []
      locations.forEach((location) => {
        const quantity = parseNumber(location.cantidad)
        const subdivisionId = Number(location.subdivisionId)
        if (!subdivisionId || quantity < 0) return
        const existing = entryBySubdivision.get(String(location.subdivisionId))
        if (existing) {
          if (Number(existing.cantidad) === quantity) return
          updates.push({
            method: 'PUT',
            id: existing.id,
            payload: {
              producto_id: productId,
              subdivision_id: subdivisionId,
              referencia: existing.referencia ?? '',
              cantidad: quantity,
            },
          })
          return
        }
        if (quantity > 0) {
          updates.push({
            method: 'POST',
            payload: {
              producto_id: productId,
              subdivision_id: subdivisionId,
              referencia: '',
              cantidad: quantity,
            },
          })
        }
      })
      const locationSubIds = new Set(locations.map((location) => String(location.subdivisionId)))
      entryBySubdivision.forEach((entry, subdivisionId) => {
        if (!locationSubIds.has(String(subdivisionId)) && entry?.id) {
          updates.push({
            method: 'DELETE',
            id: entry.id,
          })
        }
      })

      if (!updates.length) {
        setSaving(false)
        return true
      }

      const responses = await Promise.all(
        updates.map((update) => {
          if (update.method === 'PUT') {
            return authFetch(
              `${API_URL}/inventario/inventario/${update.id}/`,
              {
                method: 'PUT',
                body: JSON.stringify(update.payload),
              },
              token
            )
          }
          if (update.method === 'DELETE') {
            return authFetch(
              `${API_URL}/inventario/inventario/${update.id}/`,
              { method: 'DELETE' },
              token
            )
          }
          return authFetch(
            `${API_URL}/inventario/inventario/`,
            {
              method: 'POST',
              body: JSON.stringify(update.payload),
            },
            token
          )
        })
      )

      const failedIndex = responses.findIndex((response) => !response.ok)
      if (failedIndex !== -1) {
        const failed = responses[failedIndex]
        const failedUpdate = updates[failedIndex]
        const detailPayload = await failed.json().catch(() => ({}))
        const detailText = String(detailPayload?.detail || '').trim()
        const normalizedDetail = normalizeErrorText(detailText)
        const failedMethod = String(failedUpdate?.method || '').trim().toUpperCase()
        const looksLikeBranchScopeRestriction =
          failed.status === 403 ||
          normalizedDetail.includes('no tienes acceso a la sucursal seleccionada') ||
          (failed.status === 404 &&
            (
              normalizedDetail.includes('no inventario matches the given query') ||
              normalizedDetail.includes('no se encontro') ||
              normalizedDetail.includes('not found')
            ) &&
            (failedMethod === 'DELETE' || failedMethod === 'PUT'))

        if (looksLikeBranchScopeRestriction) {
          if (failedMethod === 'DELETE') {
            throw new Error(SCOPE_DELETE_LOCATION_ERROR)
          }
          throw new Error(SCOPE_EDIT_LOCATION_ERROR)
        }

        throw new Error(detailText || 'No se pudieron guardar los cambios.')
      }

      const payloads = await Promise.all(
        responses.map((response) =>
          response.ok ? response.clone().json().catch(() => ({})) : Promise.resolve(null)
        )
      )
      if (payloads.some((payload) => Boolean(payload?.reminders_sync_required))) {
        emitRemindersSync()
      }

      onSaved?.()
      return true
    } catch (err) {
      const message = err?.message || 'No se pudieron guardar los cambios.'
      setError(message)
      throw err
    } finally {
      setSaving(false)
    }
  }

  useImperativeHandle(ref, () => ({
    save: saveChanges,
    reset: resetEditorState,
  }))

  const sortedLocations = useMemo(() => {
    return [...locations].sort((a, b) => {
      const sucursalCompare = (a.sucursalNombre || '').localeCompare(b.sucursalNombre || '', 'es', { sensitivity: 'base' })
      if (sucursalCompare !== 0) return sucursalCompare
      const bodegaCompare = (a.bodegaNombre || '').localeCompare(b.bodegaNombre || '', 'es', { sensitivity: 'base' })
      if (bodegaCompare !== 0) return bodegaCompare
      const divisionCompare = (a.divisionNombre || '').localeCompare(b.divisionNombre || '', 'es', { sensitivity: 'base' })
      if (divisionCompare !== 0) return divisionCompare
      return (a.subdivisionNombre || '').localeCompare(b.subdivisionNombre || '', 'es', { sensitivity: 'base' })
    })
  }, [locations])

  if (!branches.length) {
    return (
      <div className="inventario-details__empty">
        No hay sucursales configuradas.
      </div>
    )
  }

  return (
    <div className="inventario-details__body">
      <section className="create-user__section inventario-details__section">
        <div className="create-user__section-header">
          <h4>Ubicaciones del producto</h4>
          <button
            type="button"
            className="create-user__ghost create-user__location-action"
            onClick={() => {
              setLocationError('')
              closeAllLocationDropdowns()
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
            disabled={editorDisabled}
          >
            {showLocationForm ? 'Cancelar' : 'Agregar ubicacion'}
          </button>
        </div>

        <div className="create-user__locations-table create-user__locations-table--with-actions create-user__locations-table--locations-selectors">
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
                      if (editorDisabled) return
                      setShowLocationBranchDropdown((prev) => !prev)
                      setShowLocationBodegaDropdown(false)
                      setShowLocationDivisionDropdown(false)
                      setShowLocationSubdivisionDropdown(false)
                    }}
                    disabled={editorDisabled}
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
                        {!filteredLocationBranches.length && (
                          <small className="muted">Sin resultados.</small>
                        )}
                        {filteredLocationBranches.map((branch) => {
                          const branchEditable = canManageBranchLocation(branch?.id)
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
                              disabled={editorDisabled || !branchEditable}
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
                      if (editorDisabled || !locationDraft.sucursalId) return
                      setShowLocationBodegaDropdown((prev) => !prev)
                      setShowLocationBranchDropdown(false)
                      setShowLocationDivisionDropdown(false)
                      setShowLocationSubdivisionDropdown(false)
                    }}
                    disabled={editorDisabled || !locationDraft.sucursalId || !canManageLocationDraft}
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
                        {!filteredLocationBodegas.length && (
                          <small className="muted">Sin resultados.</small>
                        )}
                        {filteredLocationBodegas.map((bodega) => (
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
                            disabled={editorDisabled || !canManageLocationDraft}
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
                      if (editorDisabled || !locationDraft.bodegaId) return
                      setShowLocationDivisionDropdown((prev) => !prev)
                      setShowLocationBranchDropdown(false)
                      setShowLocationBodegaDropdown(false)
                      setShowLocationSubdivisionDropdown(false)
                    }}
                    disabled={editorDisabled || !locationDraft.bodegaId || !canManageLocationDraft}
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
                        {!filteredLocationDivisions.length && (
                          <small className="muted">Sin resultados.</small>
                        )}
                        {filteredLocationDivisions.map((division) => (
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
                            disabled={editorDisabled || !canManageLocationDraft}
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
                      if (editorDisabled || !locationDraft.divisionId) return
                      setShowLocationSubdivisionDropdown((prev) => !prev)
                      setShowLocationBranchDropdown(false)
                      setShowLocationBodegaDropdown(false)
                      setShowLocationDivisionDropdown(false)
                    }}
                    disabled={editorDisabled || !locationDraft.divisionId || !canManageLocationDraft}
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
                        {!filteredLocationSubdivisions.length && (
                          <small className="muted">Sin resultados.</small>
                        )}
                        {filteredLocationSubdivisions.map((subdivision) => {
                          const alreadyUsed = usedSubdivisionIds.has(String(subdivision.id))
                          return (
                            <button
                              key={subdivision.id}
                              type="button"
                              className="create-user__result-option"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                if (!alreadyUsed) handleLocationSubdivisionPick(subdivision)
                              }}
                              disabled={editorDisabled || !canManageLocationDraft || alreadyUsed}
                              title={alreadyUsed ? 'Esta subdivision ya está en la tabla' : undefined}
                            >
                              <div className="create-user__result-info">
                                <strong>{subdivision.nombre || `Subdivision ${subdivision.id}`}</strong>
                                {alreadyUsed && <small style={{ opacity: 0.6 }}>Ya agregada</small>}
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
                <input
                  type="number"
                  min="1"
                  step="1"
                  placeholder="Cantidad"
                  value={locationDraft.cantidad}
                  onChange={(event) => handleLocationSelect('cantidad', event.target.value)}
                  disabled={editorDisabled || !canManageLocationDraft}
                />
              </span>
              <span className="create-user__locations-cell create-user__locations-cell--action">
                <button
                  type="button"
                  className="create-user__ghost"
                  onClick={handleAddLocation}
                  disabled={editorDisabled || !canManageLocationDraft}
                >
                  Agregar
                </button>
              </span>
            </div>
          )}

          {locations.length === 0 && !showLocationForm && (
            <div className="create-user__locations-row create-user__locations-row--empty">
              <span>Sin ubicaciones registradas.</span>
            </div>
          )}

          {sortedLocations.map((location) => {
            const canManageRow = canManageBranchLocation(location.sucursalId)
            const canInlineEdit = !editorDisabled && canInlineEditBranchLocation(location.sucursalId)
            const currentBodega = bodegaById.get(String(location.bodegaId))

            const rowBodegas = bodegasBySucursal.get(location.sucursalId) || []
            const rowDivisions = divisionsByBodega.get(location.bodegaId) || []
            const rowSubdivisions = subdivisionsByDivision.get(location.divisionId) || []

            const isOpen = (field) => openRowDropdown?.uid === location.uid && openRowDropdown?.field === field

            const toggleDropdown = (field) => {
              if (isOpen(field)) {
                setOpenRowDropdown(null)
                setRowDropdownQuery('')
              } else {
                setOpenRowDropdown({ uid: location.uid, field })
                setRowDropdownQuery('')
              }
            }

            const filterByQuery = (items, getName) => {
              if (!rowDropdownDebouncedQuery) return items
              return items.filter((item) => normalizeForSearch(getName(item)).includes(rowDropdownDebouncedQuery))
            }

            const makeDropdown = (field, label, items, getName, getId, triggerDisabled, isItemDisabled) => {
              const open = isOpen(field)
              const filtered = filterByQuery(items, getName)
              return (
                <div
                  className="create-user__dropdown"
                  ref={open ? rowDropdownRef : null}
                >
                  <button
                    type="button"
                    className="create-user__dropdown-trigger"
                    onClick={() => { if (!triggerDisabled) toggleDropdown(field) }}
                    disabled={triggerDisabled}
                  >
                    <span>{label}</span>
                    <i className={`pi pi-chevron-${open ? 'up' : 'down'}`} />
                  </button>
                  {open && (
                    <div className="create-user__dropdown-panel">
                      <div className="create-user__dropdown-search">
                        <i className="pi pi-search" />
                        <input
                          type="text"
                          placeholder={`Buscar ${field}`}
                          value={rowDropdownQuery}
                          onChange={(e) => setRowDropdownQuery(e.target.value)}
                        />
                      </div>
                      <div className="create-user__dropdown-results">
                        {!filtered.length && <small className="muted">Sin resultados.</small>}
                        {filtered.map((item) => {
                          const itemDisabled = isItemDisabled ? isItemDisabled(item) : false
                          return (
                            <button
                              key={getId(item)}
                              type="button"
                              className="create-user__result-option"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => { if (!itemDisabled) handleRowFieldChange(location.uid, field, getId(item), getName(item)) }}
                              disabled={itemDisabled}
                              title={itemDisabled ? 'Ya está en uso' : undefined}
                            >
                              <div className="create-user__result-info">
                                <strong>{getName(item)}</strong>
                                {itemDisabled && <small style={{ opacity: 0.6 }}>Ya agregada</small>}
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )
            }

            // subdivisionIds used by other rows (not this one)
            const otherUsedSubIds = new Set(
              locations
                .filter((loc) => loc.uid !== location.uid)
                .map((loc) => String(loc.subdivisionId))
                .filter(Boolean)
            )
            const isDivisionFullyUsed = (d) => {
              const subs = subdivisionsByDivision.get(String(d.id)) || []
              return subs.length > 0 && subs.every((s) => otherUsedSubIds.has(String(s.id)))
            }
            const isBodegaFullyUsed = (b) => {
              const divs = divisionsByBodega.get(String(b.id)) || []
              return divs.length > 0 && divs.every(isDivisionFullyUsed)
            }

            const isTransferring = transferUid === location.uid
            // A diferencia de canManageRow (agregar/eliminar, que cambia el
            // total), mover cantidad entre ubicaciones de la misma sucursal
            // no exige el alcance de sucursal -- lo puede hacer cualquiera.
            const canTransferRow = true
            const transferBodegas = bodegasBySucursal.get(location.sucursalId) || []
            const transferDivisions = divisionsByBodega.get(transferDraft.bodegaId) || []
            const transferSubdivisions = (subdivisionsByDivision.get(transferDraft.divisionId) || [])
              .filter((s) => String(s.id) !== String(location.subdivisionId))
            const transferBodega = bodegaById.get(String(transferDraft.bodegaId))
            const transferDivision = divisionById.get(String(transferDraft.divisionId))
            const transferSubdivision = subdivisionById.get(String(transferDraft.subdivisionId))

            const makeTransferDropdown = (field, label, items, getName, getId, triggerDisabled) => {
              const open = isTransferring && openTransferDropdown === field
              const filteredItems = transferDropdownDebouncedQuery
                ? items.filter((item) => normalizeForSearch(getName(item)).includes(transferDropdownDebouncedQuery))
                : items
              return (
                <div className="create-user__dropdown">
                  <button
                    type="button"
                    ref={open ? transferDropdownRef : null}
                    className="create-user__dropdown-trigger"
                    onClick={(event) => {
                      if (triggerDisabled) return
                      if (open) {
                        setOpenTransferDropdown(null)
                        setTransferDropdownQuery('')
                        return
                      }
                      const rect = event.currentTarget.getBoundingClientRect()
                      setTransferDropdownRect({ top: rect.bottom + 4, left: rect.left, width: rect.width })
                      setTransferDropdownQuery('')
                      setOpenTransferDropdown(field)
                    }}
                    disabled={triggerDisabled}
                  >
                    <span>{label}</span>
                    <i className={`pi pi-chevron-${open ? 'up' : 'down'}`} />
                  </button>
                  {open && transferDropdownRect && createPortal(
                    <div
                      ref={transferPanelRef}
                      className="create-user__dropdown-panel create-user__dropdown-panel--floating"
                      style={{ top: transferDropdownRect.top, left: transferDropdownRect.left, width: transferDropdownRect.width }}
                    >
                      <div className="create-user__dropdown-search">
                        <i className="pi pi-search" />
                        <input
                          type="text"
                          placeholder={`Buscar ${field}`}
                          value={transferDropdownQuery}
                          onChange={(event) => setTransferDropdownQuery(event.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="create-user__dropdown-results">
                        {!filteredItems.length && <small className="muted">Sin resultados.</small>}
                        {filteredItems.map((item) => (
                          <button
                            key={getId(item)}
                            type="button"
                            className="create-user__result-option"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              handleTransferSelect(field, getId(item), getName(item))
                              setTransferDropdownQuery('')
                            }}
                          >
                            <div className="create-user__result-info">
                              <strong>{getName(item)}</strong>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>,
                    getPortalHost()
                  )}
                </div>
              )
            }

            return (
              <Fragment key={location.uid}>
                <div className="create-user__locations-row">
                  <span>
                    {canInlineEdit
                      ? makeDropdown('sucursal', location.sucursalNombre || 'Sucursal', branches, (b) => b.nombre || `Sucursal ${b.id}`, (b) => b.id, false)
                      : location.sucursalNombre}
                  </span>
                  <span>
                    {canInlineEdit
                      ? makeDropdown('bodega', location.bodegaNombre || 'Bodega', rowBodegas, (b) => b.nombre || `Bodega ${b.id}`, (b) => b.id, !location.sucursalId, isBodegaFullyUsed)
                      : location.bodegaNombre}
                  </span>
                  <span>
                    {canInlineEdit
                      ? makeDropdown('division', location.divisionNombre || 'Division', rowDivisions, (d) => d.nombre || `Division ${d.id}`, (d) => d.id, !location.bodegaId, isDivisionFullyUsed)
                      : location.divisionNombre}
                  </span>
                  <span>
                    {canInlineEdit
                      ? makeDropdown('subdivision', location.subdivisionNombre || 'Subdivision', rowSubdivisions, (s) => s.nombre || `Subdivision ${s.id}`, (s) => s.id, !location.divisionId, (s) => otherUsedSubIds.has(String(s.id)))
                      : location.subdivisionNombre}
                  </span>
                  <span>
                    {canInlineEdit ? (
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={String(location.cantidad ?? '')}
                        onChange={(event) => handleRowCantidadChange(location.uid, event.target.value)}
                      />
                    ) : (
                      <strong className="create-user__locations-total">{location.cantidad}</strong>
                    )}
                  </span>
                  <span className="create-user__locations-cell create-user__locations-cell--action">
                    <BodegaLocationPreview
                      bodega={currentBodega}
                      divisionName={location.divisionNombre}
                      subdivisionName={location.subdivisionNombre}
                    />
                    <button
                      type="button"
                      className={`create-user__locations-transfer${isTransferring ? ' create-user__locations-transfer--active' : ''}`}
                      onClick={() => (isTransferring ? handleCancelTransfer() : handleStartTransfer(location))}
                      disabled={transferBusy || !canTransferRow}
                      aria-label="Trasladar ubicacion"
                      title="Trasladar a otra ubicacion de la misma sucursal"
                    >
                      <ArrowLeftRight size={14} />
                    </button>
                    <button
                      type="button"
                      className="create-user__locations-remove"
                      onClick={() => handleRemoveLocation(location)}
                      disabled={editorDisabled || !canManageRow}
                      aria-label="Eliminar ubicacion"
                    >
                      ×
                    </button>
                  </span>
                </div>

                {isTransferring && (
                  <div className="create-user__locations-row create-user__locations-row--form create-user__locations-row--transfer">
                    <span>
                      <em>{location.sucursalNombre}</em>
                    </span>
                    <span>
                      {makeTransferDropdown('bodega', transferBodega?.nombre || 'Bodega', transferBodegas, (b) => b.nombre || `Bodega ${b.id}`, (b) => b.id, transferBusy)}
                    </span>
                    <span>
                      {makeTransferDropdown('division', transferDivision?.nombre || 'Division', transferDivisions, (d) => d.nombre || `Division ${d.id}`, (d) => d.id, transferBusy || !transferDraft.bodegaId)}
                    </span>
                    <span>
                      {makeTransferDropdown('subdivision', transferSubdivision?.nombre || 'Subdivision', transferSubdivisions, (s) => s.nombre || `Subdivision ${s.id}`, (s) => s.id, transferBusy || !transferDraft.divisionId)}
                    </span>
                    <span>
                      <input
                        type="number"
                        min="1"
                        max={location.cantidad}
                        step="1"
                        placeholder={`Max ${location.cantidad}`}
                        value={transferDraft.cantidad}
                        onChange={(event) => setTransferDraft((prev) => ({ ...prev, cantidad: event.target.value }))}
                        disabled={transferBusy}
                      />
                    </span>
                    <span className="create-user__locations-cell create-user__locations-cell--action">
                      <button
                        type="button"
                        className="create-user__locations-transfer create-user__locations-transfer--confirm"
                        onClick={() => handleConfirmTransfer(location)}
                        disabled={transferBusy}
                        aria-label="Confirmar traslado"
                        title="Mover cantidad"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        className="create-user__locations-remove"
                        onClick={handleCancelTransfer}
                        disabled={transferSaving}
                        aria-label="Cancelar traslado"
                        title="Cancelar"
                      >
                        <X size={14} />
                      </button>
                    </span>
                  </div>
                )}
              </Fragment>
            )
          })}
        </div>

      </section>

    </div>
  )
  }
)

export default InventarioEditor

