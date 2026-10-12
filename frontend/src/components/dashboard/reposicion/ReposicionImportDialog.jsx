import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { API_URL, authFetch } from '../../../utils/api'
import { getAppPortalRoot } from '../../../utils/portalRoot'
import '../admin/CreateUsuario/CreateUsuario.css'
import { ESTADO_LABEL } from './reposicionConstants'

// Sugerencia de importacion a partir de Reposicion: lo que la sucursal
// central debe pedir, agrupado por proveedor. Por cada proveedor se crea un
// borrador en Importaciones con los productos y cantidades elegidos.

const num = (value, digits = 0) => Number(value || 0).toLocaleString('es-EC', {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
})
const money = (value) => `$${num(value)}`
const IMPORT_STATE_LABEL = {
  borrador: 'sugerencia',
  cotizacion: 'cotización',
  confirmacion: 'confirmación',
  en_camino: 'en camino',
}

export default function ReposicionImportDialog({ open, token, onClose, onCreated }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // { [producto_id]: { selected, cantidad } }
  const [draft, setDraft] = useState({})
  const [creating, setCreating] = useState('')
  const [created, setCreated] = useState({})
  const [groupErrors, setGroupErrors] = useState({})

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const response = await authFetch(`${API_URL}/reposicion/sugerencia-importacion/`, {}, token)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || 'No se pudo armar la sugerencia.'))
      setData(payload)
      const next = {}
      ;(payload.proveedores || []).forEach((group) => {
        group.items.forEach((item) => {
          // Lo que ya esta en una importacion abierta empieza sin marcar.
          next[item.producto_id] = {
            selected: !(item.importaciones_abiertas || []).length,
            cantidad: String(item.sugerido),
          }
        })
      })
      setDraft(next)
      setCreated({})
      setGroupErrors({})
    } catch (err) {
      setError(err?.message || 'No se pudo armar la sugerencia.')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { if (open) void load() }, [open, load])

  const groups = useMemo(() => (Array.isArray(data?.proveedores) ? data.proveedores : []), [data])

  const groupSummary = (group) => {
    const chosen = group.items.filter((item) => draft[item.producto_id]?.selected)
    const units = chosen.reduce((sum, item) => sum + (Number.parseInt(draft[item.producto_id]?.cantidad, 10) || 0), 0)
    const value = chosen.reduce((sum, item) => sum + (Number.parseInt(draft[item.producto_id]?.cantidad, 10) || 0) * Number(item.costo || 0), 0)
    return { chosen, units, value }
  }

  const setItem = (productId, patch) => setDraft((prev) => ({ ...prev, [productId]: { ...prev[productId], ...patch } }))

  const createSuggestion = async (group) => {
    const { chosen } = groupSummary(group)
    const items = chosen.map((item) => ({
      producto_id: item.producto_id,
      cantidad: Number.parseInt(draft[item.producto_id]?.cantidad, 10) || 0,
    }))
    if (!items.length) {
      setGroupErrors((prev) => ({ ...prev, [group.casa_comercial_id]: 'Marca al menos un producto.' }))
      return
    }
    if (items.some((item) => item.cantidad <= 0)) {
      setGroupErrors((prev) => ({ ...prev, [group.casa_comercial_id]: 'Cada cantidad debe ser mayor a cero.' }))
      return
    }
    setCreating(String(group.casa_comercial_id))
    setGroupErrors((prev) => ({ ...prev, [group.casa_comercial_id]: '' }))
    try {
      const response = await authFetch(
        `${API_URL}/reposicion/sugerencia-importacion/`,
        { method: 'POST', body: JSON.stringify({ casa_comercial_id: group.casa_comercial_id, items }) },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = payload?.detail || payload?.detalles || Object.values(payload || {})[0]
        throw new Error(Array.isArray(detail) ? detail.join(' ') : String(detail || 'No se pudo crear la sugerencia.'))
      }
      setCreated((prev) => ({ ...prev, [group.casa_comercial_id]: payload }))
      onCreated?.(payload, group)
    } catch (err) {
      setGroupErrors((prev) => ({ ...prev, [group.casa_comercial_id]: err?.message || 'No se pudo crear la sugerencia.' }))
    } finally {
      setCreating('')
    }
  }

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className="create-user__overlay reposicion-dialog__overlay" role="dialog" aria-modal="true">
      <div className="create-user__modal reposicion-dialog reposicion-import">
        <header className="create-user__header">
          <div className="create-user__header-text">
            <h3>Sugerencia de importación</h3>
          </div>
          <div className="create-user__header-actions">
            <button type="button" className="create-user__icon-button" onClick={onClose} aria-label="Cerrar" disabled={Boolean(creating)}>
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="create-user__content">
          <div className="create-user__body reposicion-import__body">
            <p className="reposicion-import__intro">
              {`Lo que ${data?.meta?.sucursal_central_nombre || 'la sucursal central'} necesita pedir según Reposición, agrupado por proveedor. Revisa las cantidades, desmarca lo que no quieras y crea la sugerencia: queda como borrador en Importaciones.`}
            </p>
            {loading && !data && (
              <div className="reposicion-panel__state"><i className="pi pi-spin pi-spinner" aria-hidden="true" /></div>
            )}
            {error && <p className="reposicion__error">{error}</p>}
            {data && !groups.length && (
              <p className="reposicion-panel__state">La sucursal central no tiene nada que pedir en este momento.</p>
            )}

            {groups.map((group) => {
              const key = String(group.casa_comercial_id)
              const summary = groupSummary(group)
              const done = created[group.casa_comercial_id]
              const canCreate = group.es_importacion && group.casa_comercial_id
              return (
                <section key={key} className={`reposicion-import__group${done ? ' is-done' : ''}`}>
                  <header className="reposicion-import__group-head">
                    <div>
                      <strong>{group.casa_nombre}</strong>
                      <span className={`reposicion-import__type${group.es_importacion ? ' is-import' : ''}`}>
                        {group.es_importacion ? 'Importación' : group.casa_comercial_id ? 'Proveedor local · compra local' : 'Sin proveedor'}
                      </span>
                    </div>
                    <div className="reposicion-import__group-total">
                      <small>{`${summary.chosen.length} de ${group.items.length} productos · ${num(summary.units)} unidades`}</small>
                      <strong>{money(summary.value)}</strong>
                    </div>
                  </header>

                  <div className="reposicion-import__table-wrap">
                    <table className="reposicion-import__table">
                      <thead>
                        <tr>
                          <th aria-label="Incluir" />
                          <th>Producto</th>
                          <th>Estado</th>
                          <th className="is-num">Stock</th>
                          <th className="is-num">En camino</th>
                          <th className="is-num">Venta/día</th>
                          <th className="is-num">Pedir</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.items.map((item) => {
                          const itemDraft = draft[item.producto_id] || {}
                          const openImports = item.importaciones_abiertas || []
                          return (
                            <tr key={item.producto_id} className={itemDraft.selected ? '' : 'is-off'}>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={Boolean(itemDraft.selected)}
                                  onChange={(event) => setItem(item.producto_id, { selected: event.target.checked })}
                                  disabled={Boolean(done) || !canCreate}
                                  aria-label={`Incluir ${item.codigo}`}
                                />
                              </td>
                              <td>
                                <div className="reposicion__product">
                                  <strong>{item.codigo}</strong>
                                  <span>{item.nombre}</span>
                                  {openImports.length > 0 && (
                                    <em className="reposicion-import__warn">
                                      {`Ya está en ${openImports.map((imp) => `${imp.codigo} (${IMPORT_STATE_LABEL[imp.estado] || imp.estado}, ${imp.cantidad})`).join(', ')}`}
                                    </em>
                                  )}
                                </div>
                              </td>
                              <td><span className={`reposicion__status is-${item.estado}`}>{ESTADO_LABEL[item.estado] || item.estado}</span></td>
                              <td className="is-num">{num(item.stock)}</td>
                              <td className="is-num">{item.en_camino ? num(item.en_camino) : '—'}</td>
                              <td className="is-num">{num(item.venta_dia, 2)}</td>
                              <td className="is-num">
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  className="reposicion-import__qty"
                                  value={itemDraft.cantidad ?? ''}
                                  onChange={(event) => setItem(item.producto_id, { cantidad: event.target.value.replace(/\D+/g, '').slice(0, 6) })}
                                  disabled={Boolean(done) || !canCreate || !itemDraft.selected}
                                  aria-label={`Cantidad de ${item.codigo}`}
                                />
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  <footer className="reposicion-import__group-foot">
                    {groupErrors[group.casa_comercial_id] && (
                      <span className="reposicion-import__error">{groupErrors[group.casa_comercial_id]}</span>
                    )}
                    {done ? (
                      <span className="reposicion-import__done">
                        {`Creada ${done.codigo} con ${done.productos} productos (${num(done.unidades)} unidades). Está en Importaciones como sugerencia.`}
                      </span>
                    ) : canCreate ? (
                      <button
                        type="button"
                        className="reposicion__btn reposicion__btn--primary"
                        onClick={() => void createSuggestion(group)}
                        disabled={Boolean(creating) || !summary.chosen.length}
                      >
                        {creating === key ? 'Creando...' : `Crear sugerencia de importación (${summary.chosen.length})`}
                      </button>
                    ) : (
                      <span className="reposicion-import__note">
                        {group.casa_comercial_id
                          ? 'Proveedor local: se compra con una entrada de compra local, no con una importación.'
                          : 'Estos productos no tienen proveedor asignado: asígnalo en Productos para poder importarlos.'}
                      </span>
                    )}
                  </footer>
                </section>
              )
            })}
          </div>
        </div>
      </div>
    </div>,
    getAppPortalRoot()
  )
}
