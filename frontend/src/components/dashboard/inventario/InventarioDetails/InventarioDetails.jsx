import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../../admin/UsersDetails/UsersDetails.css'
import './InventarioDetails.css'
import { API_URL, authFetch } from '../../../../utils/api'

const parseNumber = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor(parsed))
}

function InventarioDetails({
  open,
  product,
  token,
  branches = [],
  bodegas = [],
  subdivisions = [],
  inventarioEntries = [],
  onClose,
  onSaved,
}) {
  const [draftQuantities, setDraftQuantities] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const modalRef = useRef(null)
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: 900, height: 640 })
  const sizeRef = useRef(size)
  const positionRef = useRef(position)
  const restoreRef = useRef(null)
  const [isMaximized, setIsMaximized] = useState(false)
  const VIEWPORT_PADDING = 12

  const entryBySubdivision = useMemo(() => {
    const map = new Map()
    inventarioEntries.forEach((entry) => {
      if (!entry?.subdivisionId) return
      if (!map.has(entry.subdivisionId)) {
        map.set(entry.subdivisionId, entry)
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
    if (!open) return
    const initial = {}
    subdivisions.forEach((subdivision) => {
      const existing = entryBySubdivision.get(subdivision.id)
      initial[subdivision.id] = existing?.cantidad ?? 0
    })
    setDraftQuantities(initial)
    setError(null)
  }, [open, subdivisions, entryBySubdivision])

  useEffect(() => {
    if (!open) return
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    const nextWidth = Math.min(900, availableWidth)
    const nextHeight = Math.min(640, availableHeight)
    setSize({ width: nextWidth, height: nextHeight })
    setPosition({
      x: Math.max((window.innerWidth - nextWidth) / 2, VIEWPORT_PADDING),
      y: Math.max((window.innerHeight - nextHeight) / 2, VIEWPORT_PADDING),
    })
  }, [open])

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    positionRef.current = position
  }, [position])

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

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!dragData.current.active) return
      event.preventDefault()
      const maxX = window.innerWidth - sizeRef.current.width - VIEWPORT_PADDING
      const maxY = window.innerHeight - sizeRef.current.height - VIEWPORT_PADDING
      setPosition({
        x: Math.min(Math.max(event.clientX - dragData.current.offsetX, VIEWPORT_PADDING), Math.max(maxX, VIEWPORT_PADDING)),
        y: Math.min(Math.max(event.clientY - dragData.current.offsetY, VIEWPORT_PADDING), Math.max(maxY, VIEWPORT_PADDING)),
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
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    setSize({ width: availableWidth, height: availableHeight })
    setPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  const handleQuantityChange = (subdivisionId, value) => {
    setDraftQuantities((prev) => ({
      ...prev,
      [subdivisionId]: value,
    }))
  }

  const handleSave = useCallback(async () => {
    if (!product?.id || saving) return
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
              producto_id: product.id,
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
              producto_id: product.id,
              subdivision_id: subdivision.id,
              referencia: '',
              cantidad: quantity,
            },
          })
        }
      })

      if (!updates.length) {
        setSaving(false)
        onClose?.()
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
      onClose?.()
    } catch (err) {
      setError(err?.message || 'No se pudieron guardar los cambios.')
    } finally {
      setSaving(false)
    }
  }, [product, saving, subdivisions, draftQuantities, entryBySubdivision, token, onClose, onSaved])

  if (!open || !product) return null

  const modalStyle = {
    top: position.y,
    left: position.x,
    width: size.width,
    height: size.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
  }

  return (
    <div className="create-user__overlay" role="dialog" aria-modal="true" style={{ padding: `${VIEWPORT_PADDING}px` }}>
      <div className="create-user__modal inventario-details__modal" ref={modalRef} style={modalStyle}>
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>
              Inventario - {product.codigo ? `${product.codigo} · ${product.nombre}` : product.nombre || 'Producto'}
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

        <div className="create-user__content">
          <div className="create-user__body inventario-details__body">
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

            {branches.length === 0 && (
              <div className="inventario-details__empty">
                <Info size={18} />
                <span>No hay sucursales configuradas.</span>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="create-user__error inventario-details__error">
            {error}
          </div>
        )}

        <div className="create-user__footer">
          <div className="user-details__footer-left">
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={onClose}
              disabled={saving}
            >
              Cancelar
            </button>
          </div>

          <div className="user-details__footer-right">
            <button
              type="button"
              className="create-user__action create-user__action--primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Guardando...' : 'Guardar cambios'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default InventarioDetails
