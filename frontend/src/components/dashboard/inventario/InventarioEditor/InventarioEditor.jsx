import { useEffect, useMemo, useState } from 'react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../InventarioDetails/InventarioDetails.css'
import { API_URL, authFetch } from '../../../../utils/api'

const parseNumber = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor(parsed))
}

function InventarioEditor({
  productId,
  token,
  branches = [],
  bodegas = [],
  subdivisions = [],
  inventarioEntries = [],
  disabled = false,
  onSaved,
  onError,
}) {
  const [draftQuantities, setDraftQuantities] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const entryBySubdivision = useMemo(() => {
    const map = new Map()
    inventarioEntries.forEach((entry) => {
      const subdivisionId = entry?.subdivisionId ?? entry?.subdivision?.id
      if (!subdivisionId) return
      if (!map.has(subdivisionId)) {
        map.set(subdivisionId, entry)
      }
    })
    return map
  }, [inventarioEntries])

  const subdivisionsByBodega = useMemo(() => {
    const map = new Map()
    subdivisions.forEach((subdivision) => {
      const bodegaId = subdivision?.division?.bodega?.id
      if (!bodegaId) return
      const list = map.get(bodegaId) || []
      list.push(subdivision)
      map.set(bodegaId, list)
    })
    return map
  }, [subdivisions])

  const bodegasBySucursal = useMemo(() => {
    const map = new Map()
    bodegas.forEach((bodega) => {
      const sucursalId = bodega?.sucursal?.id ?? bodega?.sucursal_id
      if (!sucursalId) return
      const list = map.get(sucursalId) || []
      list.push(bodega)
      map.set(sucursalId, list)
    })
    return map
  }, [bodegas])

  useEffect(() => {
    const initial = {}
    subdivisions.forEach((subdivision) => {
      const existing = entryBySubdivision.get(subdivision.id)
      initial[subdivision.id] = existing?.cantidad ?? 0
    })
    setDraftQuantities(initial)
    setError(null)
  }, [subdivisions, entryBySubdivision, productId])

  const handleQuantityChange = (subdivisionId, value) => {
    setDraftQuantities((prev) => ({
      ...prev,
      [subdivisionId]: value,
    }))
  }

  const handleSave = async () => {
    if (!productId || saving) return
    setSaving(true)
    setError(null)

    try {
      const updates = []
      subdivisions.forEach((subdivision) => {
        const raw = draftQuantities[subdivision.id]
        const quantity = parseNumber(raw)
        const existing = entryBySubdivision.get(subdivision.id)
        if (existing) {
          if (Number(existing.cantidad) === quantity) return
          updates.push({
            method: 'PUT',
            id: existing.id,
            payload: {
              producto_id: productId,
              subdivision_id: subdivision.id,
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
              subdivision_id: subdivision.id,
              referencia: '',
              cantidad: quantity,
            },
          })
        }
      })

      if (!updates.length) {
        setSaving(false)
        return
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
    } catch (err) {
      const message = err?.message || 'No se pudieron guardar los cambios.'
      setError(message)
      onError?.(message)
    } finally {
      setSaving(false)
    }
  }

  if (!branches.length) {
    return (
      <div className="inventario-details__empty">
        No hay sucursales configuradas.
      </div>
    )
  }

  return (
    <div className="inventario-details__body">
      {branches.map((branch) => {
        const branchBodegas = bodegasBySucursal.get(branch.id) || []
        if (!branchBodegas.length) return null
        return (
          <section key={branch.id} className="create-user__section inventario-details__section">
            <div className="create-user__section-header">
              <div>
                <h4>{branch.nombre}</h4>
                <p className="create-user__hint">
                  {branchBodegas.length} bodega{branchBodegas.length === 1 ? '' : 's'} asociada
                </p>
              </div>
            </div>

            <div className="inventario-details__bodegas">
              {branchBodegas.map((bodega) => {
                const subs = subdivisionsByBodega.get(bodega.id) || []
                const bodegaTotal = subs.reduce(
                  (acc, sub) => acc + parseNumber(draftQuantities[sub.id] ?? 0),
                  0
                )
                return (
                  <div key={bodega.id} className="inventario-details__bodega-card">
                    <div className="inventario-details__bodega-header">
                      <strong>{bodega.nombre}</strong>
                      <span>Total: {bodegaTotal}</span>
                    </div>

                    {subs.length === 0 && (
                      <p className="inventario-details__empty">Esta bodega no tiene subdivisiones.</p>
                    )}

                    {subs.length > 0 && (
                      <div className="inventario-details__bodega-grid">
                        {subs.map((subdivision) => (
                          <label key={subdivision.id} className="create-user__field">
                            <span>
                              {subdivision.nombre}
                              {subdivision?.division?.nombre ? (
                                <small>División: {subdivision.division.nombre}</small>
                              ) : null}
                            </span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={draftQuantities[subdivision.id] ?? 0}
                              onChange={(event) => handleQuantityChange(subdivision.id, event.target.value)}
                              disabled={disabled}
                            />
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}

      {error && <div className="create-user__error inventario-details__error">{error}</div>}

      <div className="inventario-details__actions">
        <button
          type="button"
          className="create-user__action create-user__action--primary"
          onClick={handleSave}
          disabled={disabled || saving}
        >
          {saving ? 'Guardando...' : 'Guardar inventario'}
        </button>
      </div>
    </div>
  )
}

export default InventarioEditor
