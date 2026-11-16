import React, { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import { API_URL, authFetch } from '../../../../utils/api'
import { formatDateTime } from '../../../../utils/dateFormat'
import { getAppPortalRoot } from '../../../../utils/portalRoot'
import BlockerNotice from '../../common/BlockerNotice'
import './NotFoundZeroLocations.css'

// "No lo encontre" en una ubicacion que estaba en 0: no hay unidades que
// pasar a TEMPORAL, asi que administracion decide si esa ubicacion se mantiene
// asignada al producto o se quita. Aviso ambar arriba + lista para decidir.
function NotFoundZeroLocations({ token, branchId = '', canUpdate = true, isDarkTheme = false, notifySuccess, notifyError }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    if (!token || !canUpdate) return
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (branchId) params.set('sucursal_id', String(branchId))
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/ubicaciones-cero/?${params.toString()}`,
        {},
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo cargar la lista.')
      setRows(Array.isArray(payload?.results) ? payload.results : [])
    } catch (error) {
      setRows([])
      if (open) notifyError?.(error.message)
    } finally {
      setLoading(false)
    }
  }, [token, canUpdate, branchId, open, notifyError])

  useEffect(() => {
    void load()
    // Solo al entrar o cambiar de sucursal; al decidir se quita de la lista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, canUpdate, branchId])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => { if (event.key === 'Escape' && !busyId) setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busyId])

  const decide = async (row, accion) => {
    const itemId = String(row.item_id)
    setBusyId(itemId)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/items/${encodeURIComponent(itemId)}/ubicacion-cero/`,
        { method: 'POST', body: JSON.stringify({ accion }) },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar la decision.')
      const next = rows.filter((entry) => String(entry.item_id) !== itemId)
      setRows(next)
      if (!next.length) setOpen(false)
      notifySuccess?.(
        accion === 'quitar'
          ? `${row.producto_codigo}: se quitó la ubicación ${(payload?.quitadas || []).join(', ') || ''}.`.replace(/ \.$/, '.')
          : `${row.producto_codigo}: se mantiene la ubicación.`
      )
    } catch (error) {
      notifyError?.(error.message)
    } finally {
      setBusyId('')
    }
  }

  if (!canUpdate || !rows.length) return null

  return (
    <>
      <BlockerNotice
        className="inspection-admin__zero-notice"
        title={`${rows.length} producto(s) no encontrados en una ubicación que estaba en 0`}
        reason="No había unidades que pasar a TEMPORAL. Decide en cada uno si la ubicación se mantiene o se quita del producto antes de mandar otros conteos."
        actionLabel="Revisar ubicaciones"
        onAction={() => setOpen(true)}
      />
      {open && createPortal(
        <div
          className={`quick-actions__inspection-overlay${isDarkTheme ? ' dark' : ''}`}
          onMouseDown={() => { if (!busyId) setOpen(false) }}
        >
          <div
            className="quick-actions__inspection-dialog zero-locations__dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Ubicaciones en 0 no encontradas"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="quick-actions__inspection-head">
              <div>
                <h4>No encontrados en ubicación con 0</h4>
                <p>{`${rows.length} producto(s) por decidir · ¿se mantiene la ubicación?`}</p>
              </div>
              <button
                type="button"
                className="quick-actions__inspection-close"
                onClick={() => setOpen(false)}
                disabled={Boolean(busyId)}
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </header>
            <div className="quick-actions__inspection-body zero-locations__body">
              {loading && (
                <p className="quick-actions__inspection-loading">
                  <Loader2 size={14} />
                  Cargando...
                </p>
              )}
              {rows.map((row) => {
                const itemId = String(row.item_id)
                const isBusy = busyId === itemId
                const conStock = Array.isArray(row.con_stock) ? row.con_stock : []
                return (
                  <article key={itemId} className="zero-locations__row">
                    <div className="zero-locations__info">
                      <strong>{row.producto_codigo}</strong>
                      {row.producto_nombre && <span className="zero-locations__name">{row.producto_nombre}</span>}
                      <small>
                        {[row.sucursal_nombre, row.inspeccion_codigo, row.revisado_en ? formatDateTime(row.revisado_en) : '']
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                      <div className="zero-locations__places">
                        {(row.ubicaciones || []).map((location) => (
                          <span key={location.subdivision_id} className="zero-locations__chip zero-locations__chip--zero">
                            {`${location.ubicacion} · 0 u. · no lo encontraron`}
                          </span>
                        ))}
                      </div>
                      <small className="zero-locations__stock">
                        {conStock.length
                          ? `Tiene stock en: ${conStock.map((entry) => `${entry.ubicacion} (${entry.cantidad})`).join(', ')}`
                          : 'No tiene stock en ninguna otra ubicación de la sucursal.'}
                      </small>
                    </div>
                    <div className="zero-locations__actions">
                      <button
                        type="button"
                        className="zero-locations__btn zero-locations__btn--keep"
                        onClick={() => void decide(row, 'mantener')}
                        disabled={Boolean(busyId)}
                      >
                        {isBusy ? <Loader2 size={14} className="zero-locations__spin" /> : null}
                        Mantener ubicación
                      </button>
                      <button
                        type="button"
                        className="zero-locations__btn zero-locations__btn--remove"
                        onClick={() => void decide(row, 'quitar')}
                        disabled={Boolean(busyId)}
                      >
                        Quitar ubicación
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          </div>
        </div>,
        getAppPortalRoot()
      )}
    </>
  )
}

export default NotFoundZeroLocations
