import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react'
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

const InventarioEditor = forwardRef(function InventarioEditor(
  {
    productId,
    token,
    branches = [],
    bodegas = [],
    subdivisions = [],
    inventarioEntries = [],
    disabled = false,
    onSaved,
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
    setLocationError('')
  }

  const beginLocationEdit = (location, field) => {
    if (editorDisabled) return
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

        <div className="create-user__locations-table create-user__locations-table--with-actions">
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
                <select
                  value={locationDraft.sucursalId}
                  onChange={(event) => handleLocationSelect('sucursalId', event.target.value)}
                  disabled={editorDisabled}
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
                  disabled={editorDisabled || !locationDraft.sucursalId}
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
                  disabled={editorDisabled || !locationDraft.bodegaId}
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
                  disabled={editorDisabled || !locationDraft.divisionId}
                >
                  <option value="">Selecciona una subdivision</option>
                  {availableSubdivisions.map((subdivision) => (
                    <option key={subdivision.id} value={subdivision.id}>
                      {subdivision.nombre || `Subdivision ${subdivision.id}`}
                    </option>
                  ))}
                </select>
              </span>
              <span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  placeholder="Cantidad"
                  value={locationDraft.cantidad}
                  onChange={(event) => handleLocationSelect('cantidad', event.target.value)}
                  disabled={editorDisabled}
                />
              </span>
              <span className="create-user__locations-cell create-user__locations-cell--action">
                <button
                  type="button"
                  className="create-user__ghost"
                  onClick={handleAddLocation}
                  disabled={editorDisabled}
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
                    disabled={editorDisabled}
                    aria-label="Eliminar ubicacion"
                  >
                    ×
                  </button>
                </span>
              </div>
            )
          })}
        </div>

        {locationError && <div className="create-user__error">{locationError}</div>}
        {editError && <div className="create-user__error">{editError}</div>}
      </section>

      {error && <div className="create-user__error inventario-details__error">{error}</div>}

    </div>
  )
  }
)

export default InventarioEditor

