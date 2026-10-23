import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Search, X } from 'lucide-react'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDateTime } from '../../../utils/dateFormat'
import BlockerNotice from '../common/BlockerNotice'
import { matchesFirst } from '../common/productDetailMatches'
import ConfirmDialog from '../common/unsavedChanges/ConfirmDialog'
import LocationPicker from './LocationPicker'
import { POR_GUARDAR_REFRESH_EVENT } from './porGuardarEvents'
import './PorGuardar.css'

// "Por ubicar": paso 2 de la recepcion de importaciones. Al confirmar la
// llegada todo entro al inventario en POR UBICAR (entre parentesis) y ya se
// puede vender; aqui se cuenta lo que queda de cada producto (lo vendido ya se
// desconto) y se guarda en su ubicacion. Al terminar, lo que no aparecio queda
// como faltante en Inconvenientes. Tambien lo demas que haya en POR UBICAR.
const POLL_MS = 15000

const normalize = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

const shipmentKey = (shipment) => `${shipment.tipo}-${shipment.id}`
const itemKey = (shipment, item) => `${shipmentKey(shipment)}-${item.producto_id}`
const porUbicarKey = (row) => `pu-${row.sucursal_id}-${row.producto_id}`

const shipmentBase = (shipment) => `${API_URL}/importaciones/importaciones/envios/${encodeURIComponent(shipment.id)}`

function PorGuardar({ token, darkMode, onSaved }) {
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [shipments, setShipments] = useState([])
  const [porUbicar, setPorUbicar] = useState([])
  const [locationsByBranch, setLocationsByBranch] = useState({})
  const [drafts, setDrafts] = useState({}) // key -> { subdivisionId, cantidad }
  const [query, setQuery] = useState('')
  const [finishTarget, setFinishTarget] = useState(null)
  // Filas recien marcadas: el check se ve puesto mientras se guardan.
  const [checkingKeys, setCheckingKeys] = useState(() => new Set())

  const fetchCount = useCallback(async () => {
    if (!token || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
    try {
      const response = await authFetch(`${API_URL}/inventario/inventario/por-guardar/?solo_conteo=1`, {}, token)
      if (!response.ok) return
      const payload = await response.json().catch(() => ({}))
      setCount(Number(payload?.count) || 0)
    } catch {
      // Silencioso: el contador se vuelve a pedir en el siguiente ciclo.
    }
  }, [token])

  const loadData = useCallback(async () => {
    if (!token) return null
    setLoading(true)
    setError('')
    try {
      const response = await authFetch(`${API_URL}/inventario/inventario/por-guardar/`, {}, token)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo cargar lo que falta ubicar.')
      const nextShipments = Array.isArray(payload?.envios) ? payload.envios : []
      const nextPorUbicar = Array.isArray(payload?.productos) ? payload.productos : []
      setShipments(nextShipments)
      setPorUbicar(nextPorUbicar)
      setLocationsByBranch(payload?.ubicaciones && typeof payload.ubicaciones === 'object' ? payload.ubicaciones : {})
      setCount(
        nextShipments.reduce((sum, s) => sum + s.items.filter((item) => item.pendiente > 0).length, 0) + nextPorUbicar.length
      )
      // Cada producto parte con lo que falta guardar y su ubicacion principal;
      // lo que ya se habia elegido se respeta.
      setDrafts((prev) => {
        const next = {}
        nextShipments.forEach((shipment) => {
          shipment.items.forEach((item) => {
            const key = itemKey(shipment, item)
            const previous = prev[key]
            next[key] = {
              subdivisionId: previous?.subdivisionId || (item.sugerida_subdivision_id ? String(item.sugerida_subdivision_id) : ''),
              cantidad: previous && Number(previous.cantidad) <= item.pendiente ? previous.cantidad : String(item.pendiente),
            }
          })
        })
        nextPorUbicar.forEach((row) => {
          const key = porUbicarKey(row)
          const previous = prev[key]
          next[key] = {
            subdivisionId: previous?.subdivisionId || (row.sugerida_subdivision_id ? String(row.sugerida_subdivision_id) : ''),
            cantidad: previous && Number(previous.cantidad) <= row.cantidad ? previous.cantidad : String(row.cantidad),
          }
        })
        return next
      })
      return { shipments: nextShipments, porUbicar: nextPorUbicar }
    } catch (requestError) {
      setError(requestError?.message || 'No se pudo cargar lo que falta ubicar.')
      return null
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void fetchCount()
    const intervalId = window.setInterval(() => void fetchCount(), POLL_MS)
    const refresh = () => {
      void fetchCount()
      if (open) void loadData()
    }
    window.addEventListener(POR_GUARDAR_REFRESH_EVENT, refresh)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener(POR_GUARDAR_REFRESH_EVENT, refresh)
    }
  }, [fetchCount, loadData, open])

  useEffect(() => {
    if (!open) return undefined
    void loadData()
    const onKey = (event) => { if (event.key === 'Escape' && !saving && !finishTarget) setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, loadData, saving, finishTarget])

  // Como al recibir un envio: marcar el check guarda de una vez lo contado
  // en la ubicacion elegida. Si falta algo (cantidad o ubicacion) no se marca
  // y se dice por que.
  const checkRows = async (keys, save) => {
    setCheckingKeys((prev) => new Set([...prev, ...keys]))
    try {
      await save()
    } finally {
      setCheckingKeys((prev) => {
        const next = new Set(prev)
        keys.forEach((key) => next.delete(key))
        return next
      })
    }
  }
  const checkShipmentItems = (shipment, items) =>
    checkRows(items.map((item) => itemKey(shipment, item)), () => saveShipmentItems(shipment, items))
  const checkPorUbicar = (rows) => checkRows(rows.map(porUbicarKey), () => savePorUbicar(rows))

  const updateDraft = (key, patch) => setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))

  const problemFor = (key, max) => {
    const draft = drafts[key] || {}
    const qty = Number.parseInt(String(draft.cantidad || ''), 10)
    if (!Number.isFinite(qty) || qty <= 0) return 'Indica cuantas contaste'
    if (qty > max) return `Maximo ${max}`
    if (!draft.subdivisionId) return 'Elige la ubicacion'
    return ''
  }

  // Cierra el conteo del envio: lo que falta contar (no se vendio ni se
  // encontro) sale del inventario y queda como faltante en Inconvenientes.
  const finishShipment = useCallback(async (shipment) => {
    const response = await authFetch(`${shipmentBase(shipment)}/terminar-conteo/`, { method: 'POST' }, token)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo terminar el envio.')
    return payload
  }, [token])

  const saveShipmentItems = async (shipment, items) => {
    const problems = items.map((item) => ({ item, problem: problemFor(itemKey(shipment, item), item.pendiente) }))
      .filter((entry) => entry.problem)
    if (problems.length) {
      setError(`${problems[0].item.producto_codigo}: ${problems[0].problem}.`)
      return
    }
    setSaving(true)
    setError('')
    try {
      // Mueve lo contado desde POR UBICAR a su ubicacion (ya estaba en el
      // stock: no se suma de nuevo).
      const response = await authFetch(
        `${shipmentBase(shipment)}/guardar-ubicaciones/`,
        {
          method: 'POST',
          body: JSON.stringify({
            items: items.map((item) => {
              const draft = drafts[itemKey(shipment, item)]
              return {
                producto_id: item.producto_id,
                cantidad: Number.parseInt(String(draft.cantidad), 10),
                subdivision_id: Number(draft.subdivisionId),
              }
            }),
          }),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar.')
      const fresh = await loadData()
      const updated = fresh?.shipments?.find((row) => shipmentKey(row) === shipmentKey(shipment))
      if (updated && updated.items.every((item) => item.pendiente === 0)) {
        // Ya no queda nada por contar: el envio se cierra solo.
        await finishShipment(updated)
        await loadData()
        onSaved?.(`${shipment.codigo}: todo contado, envío completo.`)
      } else {
        onSaved?.(`${items.length} producto(s) guardados en su ubicacion.`)
      }
    } catch (requestError) {
      setError(requestError?.message || 'No se pudo guardar.')
    } finally {
      setSaving(false)
    }
  }

  const savePorUbicar = async (rows) => {
    const problems = rows.map((row) => ({ row, problem: problemFor(porUbicarKey(row), row.cantidad) }))
      .filter((entry) => entry.problem)
    if (problems.length) {
      setError(`${problems[0].row.producto_codigo}: ${problems[0].problem}.`)
      return
    }
    setSaving(true)
    setError('')
    try {
      const response = await authFetch(
        `${API_URL}/inventario/inventario/guardar-por-ubicar/`,
        {
          method: 'POST',
          body: JSON.stringify({
            items: rows.map((row) => {
              const draft = drafts[porUbicarKey(row)]
              return {
                producto_id: row.producto_id,
                sucursal_id: row.sucursal_id,
                subdivision_id: Number(draft.subdivisionId),
                cantidad: Number.parseInt(String(draft.cantidad), 10),
              }
            }),
          }),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar.')
      onSaved?.(`${rows.length} producto(s) guardados en su ubicacion.`)
      await loadData()
    } catch (requestError) {
      setError(requestError?.message || 'No se pudo guardar.')
    } finally {
      setSaving(false)
    }
  }

  const term = normalize(query)
  const matches = (item) => !term || normalize(`${item.producto_codigo} ${item.producto_nombre}`).includes(term)
  // Al buscar no se oculta nada: lo que coincide va primero.
  const visibleShipments = useMemo(
    () => {
      const list = shipments.map((shipment) => ({
        ...shipment,
        visibleItems: term ? matchesFirst(shipment.items, matches) : shipment.items,
      }))
      if (!term) return list
      return matchesFirst(list, (shipment) => shipment.items.some(matches) || normalize(shipment.codigo).includes(term))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shipments, term]
  )
  const visiblePorUbicar = term ? matchesFirst(porUbicar, matches) : porUbicar
  const isEmpty = !shipments.length && !porUbicar.length

  const renderLocation = (key, branchId, suggestedId) => (
    <>
      <LocationPicker
        options={locationsByBranch[String(branchId)] || []}
        value={drafts[key]?.subdivisionId}
        onChange={(id) => updateDraft(key, { subdivisionId: String(id) })}
        disabled={saving}
      />
      {suggestedId && String(drafts[key]?.subdivisionId) === String(suggestedId) && (
        <small className="por-guardar__hint">Su ubicacion principal</small>
      )}
    </>
  )

  return (
    <>
      {/* Como "Envios en camino" y "Envios pendientes": solo aparece si hay
          algo por ubicar (el dialogo abierto se mantiene aunque llegue a 0). */}
      {count > 0 && (
        <div className="quick-actions__pending-shipments por-guardar__dock">
          <button
            type="button"
            className="quick-actions__pending-shipments-trigger por-guardar__trigger has-items"
            onClick={() => setOpen(true)}
            aria-label={`Por ubicar: ${count} producto(s)`}
            title="Envios que ya llegaron (importaciones y compras locales): cuenta lo que queda y guardalo en su ubicacion"
          >
            <span>Por ubicar</span>
            <span className="quick-actions__pending-shipments-count">{count}</span>
          </button>
        </div>
      )}

      {open && createPortal(
        <div
          className={`por-guardar${darkMode ? ' por-guardar--dark' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label="Por ubicar"
          onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setOpen(false) }}
        >
          <div className="por-guardar__dialog">
            <header className="por-guardar__header">
              <div>
                <h3>Por ubicar</h3>
                <p>
                  Envíos que ya llegaron (importaciones y compras locales): están en el inventario entre paréntesis y ya se pueden vender.
                  Cuenta <strong>lo que queda</strong> de cada producto (lo vendido ya se descontó) y guárdalo en su
                  ubicación. Al terminar, lo que no aparezca queda como faltante en Inconvenientes.
                </p>
              </div>
              <button type="button" className="por-guardar__close" onClick={() => setOpen(false)} disabled={saving} aria-label="Cerrar">
                <X size={18} />
              </button>
            </header>

            <div className="por-guardar__toolbar">
              <div className="por-guardar__search">
                <Search size={15} aria-hidden="true" />
                <input
                  type="text"
                  placeholder="Buscar por codigo, nombre o documento"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </div>

            {error && <BlockerNotice compact title={error} />}

            <div className="por-guardar__body">
              {loading && isEmpty ? (
                <p className="por-guardar__empty">Cargando...</p>
              ) : isEmpty ? (
                <p className="por-guardar__empty">No hay nada por ubicar. Cuando confirmes la llegada de un envío (importación o compra local), aparece aquí.</p>
              ) : (
                <>
                  {visibleShipments.map((shipment) => {
                    const pendientes = shipment.items.filter((item) => item.pendiente > 0)
                    return (
                      <section key={shipmentKey(shipment)} className="por-guardar__shipment">
                        <header className="por-guardar__shipment-head">
                          <div>
                            <strong>{`${shipment.origen === 'Compra local' ? 'Compra local' : 'Importación'} #${shipment.codigo}`}</strong>
                            <span>
                              {[
                                `Para ${shipment.sucursal_nombre}`,
                                shipment.llegada_confirmada_en && `llegó ${formatDateTime(shipment.llegada_confirmada_en)}`,
                              ].filter(Boolean).join(' · ')}
                            </span>
                          </div>
                          <div className="por-guardar__shipment-actions">
                            <label
                              className="por-guardar__check-all"
                              title="Marca todos: se guarda cada producto con la cantidad contada y la ubicacion indicada"
                            >
                              <input
                                type="checkbox"
                                checked={!pendientes.length}
                                onChange={(event) => { if (event.target.checked) void checkShipmentItems(shipment, pendientes) }}
                                disabled={saving || !pendientes.length}
                              />
                              Marcar todo
                            </label>
                            <button
                              type="button"
                              className="por-guardar__btn por-guardar__btn--warn"
                              onClick={() => setFinishTarget(shipment)}
                              disabled={saving}
                              title="Terminar el conteo: lo que falta contar queda como faltante en Inconvenientes"
                            >
                              Terminar conteo
                            </button>
                          </div>
                        </header>
                        <table className="por-guardar__table">
                          <thead>
                            <tr>
                              <th>Producto</th>
                              <th className="por-guardar__col-num">Enviado</th>
                              <th className="por-guardar__col-num" title="Vendido desde el paréntesis antes de contarlo">Vendido</th>
                              <th className="por-guardar__col-num">Guardado</th>
                              <th className="por-guardar__col-qty">Contados</th>
                              <th>Guardar en</th>
                              <th className="por-guardar__col-action">Contado</th>
                            </tr>
                          </thead>
                          <tbody>
                            {shipment.visibleItems.map((item) => {
                              const key = itemKey(shipment, item)
                              const done = item.pendiente === 0
                              const problem = done ? '' : problemFor(key, item.pendiente)
                              return (
                                <tr key={key} className={done ? 'is-done' : ''}>
                                  <td>
                                    <strong className="por-guardar__code">{item.producto_codigo}</strong>
                                    <span className="por-guardar__name">{item.producto_nombre}</span>
                                  </td>
                                  <td className="por-guardar__col-num">{item.enviado}</td>
                                  <td className="por-guardar__col-num">{item.vendido || 0}</td>
                                  <td className="por-guardar__col-num">{item.guardado}</td>
                                  {done ? (
                                    <>
                                      <td colSpan={2} className="por-guardar__done">
                                        <CheckCircle2 size={15} aria-hidden="true" /> Contado completo
                                      </td>
                                      <td className="por-guardar__col-action">
                                        <input type="checkbox" className="por-guardar__check" checked disabled aria-label={`${item.producto_codigo} contado`} />
                                      </td>
                                    </>
                                  ) : (
                                    <>
                                      <td className="por-guardar__col-qty">
                                        <input
                                          type="text"
                                          inputMode="numeric"
                                          value={drafts[key]?.cantidad ?? ''}
                                          onChange={(event) => updateDraft(key, { cantidad: event.target.value.replace(/[^\d]/g, '') })}
                                          aria-label={`Cuantas contaste de ${item.producto_codigo}`}
                                        />
                                        <small>{`quedan ${item.pendiente}`}</small>
                                      </td>
                                      <td>{renderLocation(key, shipment.sucursal_id, item.sugerida_subdivision_id)}</td>
                                      <td className="por-guardar__col-action">
                                        <input
                                          type="checkbox"
                                          className="por-guardar__check"
                                          checked={checkingKeys.has(key)}
                                          onChange={(event) => { if (event.target.checked) void checkShipmentItems(shipment, [item]) }}
                                          disabled={saving}
                                          title={problem || 'Marcar como contado: se guarda en esta ubicacion'}
                                          aria-label={`Marcar ${item.producto_codigo} como contado`}
                                        />
                                      </td>
                                    </>
                                  )}
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </section>
                    )
                  })}

                  {visiblePorUbicar.length > 0 && (
                    <section className="por-guardar__shipment">
                      <header className="por-guardar__shipment-head">
                        <div>
                          <strong>En POR UBICAR</strong>
                          <span>Ya están en el inventario (ej. de un inconveniente); falta guardarlos en su ubicación.</span>
                        </div>
                        <div className="por-guardar__shipment-actions">
                          <label className="por-guardar__check-all" title="Marca todos: cada producto se mueve a la ubicacion indicada">
                            <input
                              type="checkbox"
                              checked={false}
                              onChange={(event) => { if (event.target.checked) void checkPorUbicar(visiblePorUbicar) }}
                              disabled={saving}
                            />
                            Marcar todo
                          </label>
                        </div>
                      </header>
                      <table className="por-guardar__table">
                        <thead>
                          <tr>
                            <th>Producto</th>
                            <th>Sucursal</th>
                            <th className="por-guardar__col-qty">Cantidad</th>
                            <th>Guardar en</th>
                            <th className="por-guardar__col-action">Guardado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visiblePorUbicar.map((row) => {
                            const key = porUbicarKey(row)
                            const problem = problemFor(key, row.cantidad)
                            return (
                              <tr key={key}>
                                <td>
                                  <strong className="por-guardar__code">{row.producto_codigo}</strong>
                                  <span className="por-guardar__name">{row.producto_nombre}</span>
                                </td>
                                <td>{row.sucursal_nombre}</td>
                                <td className="por-guardar__col-qty">
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    value={drafts[key]?.cantidad ?? ''}
                                    onChange={(event) => updateDraft(key, { cantidad: event.target.value.replace(/[^\d]/g, '') })}
                                    aria-label={`Cantidad a guardar de ${row.producto_codigo}`}
                                  />
                                  <small>de {row.cantidad}</small>
                                </td>
                                <td>{renderLocation(key, row.sucursal_id, row.sugerida_subdivision_id)}</td>
                                <td className="por-guardar__col-action">
                                  <input
                                    type="checkbox"
                                    className="por-guardar__check"
                                    checked={checkingKeys.has(key)}
                                    onChange={(event) => { if (event.target.checked) void checkPorUbicar([row]) }}
                                    disabled={saving}
                                    title={problem || 'Marcar: se mueve de POR UBICAR a esta ubicacion'}
                                    aria-label={`Guardar ${row.producto_codigo} en su ubicacion`}
                                  />
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </section>
                  )}
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      <ConfirmDialog
        open={Boolean(finishTarget)}
        title="Terminar conteo"
        message={(() => {
          if (!finishTarget) return ''
          const faltan = finishTarget.items.filter((item) => item.pendiente > 0)
          return faltan.length
            ? `Se cierra ${finishTarget.codigo}. Lo que falta contar (no se vendió ni se encontró) sale del inventario y queda como faltante en Inconvenientes.`
            : `Se cierra ${finishTarget.codigo}: todo está contado.`
        })()}
        details={finishTarget && finishTarget.items.some((item) => item.pendiente > 0) ? (
          <ul className="por-guardar__finish-list">
            {finishTarget.items.filter((item) => item.pendiente > 0).map((item) => (
              <li key={item.producto_id}>
                <strong>{item.producto_codigo}</strong>
                {` · faltan ${item.pendiente} (enviados ${item.enviado}, vendidos ${item.vendido || 0}, guardados ${item.guardado})`}
              </li>
            ))}
          </ul>
        ) : null}
        confirmLabel="Terminar conteo"
        busy={saving}
        onCancel={() => setFinishTarget(null)}
        onConfirm={async () => {
          const target = finishTarget
          setSaving(true)
          setError('')
          try {
            const result = await finishShipment(target)
            setFinishTarget(null)
            onSaved?.(String(result?.detail || '').trim() || `${target.codigo} terminado.`)
            await loadData()
          } catch (requestError) {
            setFinishTarget(null)
            setError(requestError?.message || 'No se pudo terminar el envio.')
          } finally {
            setSaving(false)
          }
        }}
      />
    </>
  )
}

export default PorGuardar
