import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../InventarioDetails/InventarioDetails.css'
import { API_URL, authFetch } from '../../../../utils/api'
import BodegaLocationPreview from './BodegaLocationPreview'

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

const InventarioEditor = forwardRef(function InventarioEditor(
  {
    productId,
    token,
    branches = [],
    bodegas = [],
    subdivisions = [],
    inventarioEntries = [],
    editableBranchIds = null,
    disabled = false,
    onSaved,
    onError,
  },
  ref
) {
  const [saving, setSaving] = useState(false)
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
  const [editingLocationKey, setEditingLocationKey] = useState(null)
  const [editingField, setEditingField] = useState(null)
  const [editingValue, setEditingValue] = useState('')
  const [editError, setEditError] = useState('')
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

  const locationBranchDropdownRef = useRef(null)
  const locationBodegaDropdownRef = useRef(null)
  const locationDivisionDropdownRef = useRef(null)
  const locationSubdivisionDropdownRef = useRef(null)

  useEffect(() => {
    if (!locationError) return
    onError?.(locationError)
  }, [locationError, onError])

  useEffect(() => {
    if (!editError) return
    onError?.(editError)
  }, [editError, onError])

  useEffect(() => {
    if (!error) return
    onError?.(error)
  }, [error, onError])

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
  const createLocationUid = () => `loc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  useEffect(() => {
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
    setEditError('')
    setEditingLocationKey(null)
    setEditingField(null)
    setEditingValue('')
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
  }, [inventarioEntries, subdivisionById, bodegaById, branchById, divisionById, productId])

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
      setLocationError('No tienes permisos para editar ubicaciones en esta sucursal.')
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
      setLocationError('No tienes permisos para editar ubicaciones en esta sucursal.')
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

  const beginLocationEdit = (location, field) => {
    if (editorDisabled) return
    if (!canManageBranchLocation(location?.sucursalId)) {
      setEditError('No tienes permisos para editar ubicaciones en esta sucursal.')
      return
    }
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
        if (divisionId != null && String(divisionId) !== String(current.divisionId)) {
          setEditError('La subdivision no pertenece a la division seleccionada.')
          return prev
        }
        const updated = [...prev]
        updated[index] = {
          ...current,
          subdivisionId: newId,
          subdivisionNombre: subdivision.nombre || current.subdivisionNombre,
        }
        cancelLocationEdit()
        return updated
      }

      return prev
    })
  }

  const handleRemoveLocation = (location) => {
    if (editorDisabled) return
    if (!canManageBranchLocation(location?.sucursalId)) {
      setEditError('No tienes permisos para editar ubicaciones en esta sucursal.')
      return
    }
    setLocations((prev) => prev.filter((item) => item.uid !== location.uid))
    if (editingLocationKey === location.uid) {
      cancelLocationEdit()
    }
    setLocationError('')
    setEditError('')
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

      const failed = responses.find((response) => !response.ok)
      if (failed) {
        const detail = await failed.json().catch(() => ({}))
        throw new Error(detail?.detail || 'No se pudieron guardar los cambios.')
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
  }))

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
                        {filteredLocationSubdivisions.map((subdivision) => (
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
                            disabled={editorDisabled || !canManageLocationDraft}
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

          {locations.map((location) => {
            const rowSubdivisions = subdivisionsByDivision.get(location.divisionId) || []
            const canManageRow = canManageBranchLocation(location.sucursalId)
            const isEditingRow = editingLocationKey === location.uid
            const editingSubdivision = isEditingRow && editingField === 'subdivision'
            const editingCantidad = isEditingRow && editingField === 'cantidad'
            const currentBodega = bodegaById.get(String(location.bodegaId))

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
                  <BodegaLocationPreview
                    bodega={currentBodega}
                    divisionName={location.divisionNombre}
                    subdivisionName={location.subdivisionNombre}
                  />
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
            )
          })}
        </div>

      </section>

    </div>
  )
  }
)

export default InventarioEditor

