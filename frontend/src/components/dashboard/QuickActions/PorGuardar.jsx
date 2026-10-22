import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Search, X } from 'lucide-react'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDateTime } from '../../../utils/dateFormat'
import BlockerNotice from '../common/BlockerNotice'
import ConfirmDialog from '../common/unsavedChanges/ConfirmDialog'
import LocationPicker from './LocationPicker'
import { POR_GUARDAR_REFRESH_EVENT } from './porGuardarEvents'
import './PorGuardar.css'

// Paso 2 de la recepcion (traslados e importaciones). Los envios que ya
// llegaron (paso 1) se verifican aqui: cuanto llego de cada producto y donde
// se guarda; recien al guardar se suma al inventario (mientras tanto se ve
// entre parentesis). Tambien lo que haya quedado en POR UBICAR.
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

const shipmentBase = (shipment) => (shipment.tipo === 'importacion'
  ? `${API_URL}/importaciones/importaciones/envios/${encodeURIComponent(shipment.id)}`
  : `${API_URL}/movimientos/movimiento_inventario/solicitudes-traslado/${encodeURIComponent(shipment.id)}`)

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
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo cargar lo que falta guardar.')
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
      setError(requestError?.message || 'No se pudo cargar lo que falta guardar.')
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

  const updateDraft = (key, patch) => setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))

  const problemFor = (key, max) => {
    const draft = drafts[key] || {}
    const qty = Number.parseInt(String(draft.cantidad || ''), 10)
    if (!Number.isFinite(qty) || qty <= 0) return 'Indica cuantas llegaron'
    if (qty > max) return `Maximo ${max}`
    if (!draft.subdivisionId) return 'Elige la ubicacion'
    return ''
  }

  // Cierra el envio con lo guardado: lo que no se guardo queda como faltante.
  const finishShipment = useCallback(async (shipment) => {
    const faltan = shipment.items.filter((item) => item.pendiente > 0)
    const response = await authFetch(
      `${shipmentBase(shipment)}/confirmar-recepcion/`,
      {
        method: 'POST',
        body: JSON.stringify({
          resultado: faltan.length ? 'incompleto' : 'completo',
          items: shipment.items.map((item) => ({
            producto_id: item.producto_id,
            cantidad_recibida: item.guardado,
            ubicaciones: [],
            ...(item.pendiente > 0 ? { novedad: 'No llego al verificar y guardar el envio.' } : {}),
          })),
        }),
      },
      token
    )
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo terminar el envio.')
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
      const response = await authFetch(
        `${shipmentBase(shipment)}/recibir-parcial/`,
        {
          method: 'POST',
          body: JSON.stringify({
            items: items.map((item) => {
              const draft = drafts[itemKey(shipment, item)]
              return {
                producto_id: item.producto_id,
                cantidad: Number.parseInt(String(draft.cantidad), 10),
                subdivision_id: Number(draft.subdivisionId),
                // Lo que esta pantalla cree que ya se guardo: evita sumar dos veces.
                ya_recibido: item.guardado,
              }
            }),
          }),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok && !(response.status === 409 && payload?.desactualizada)) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar.')
      }
      const fresh = await loadData()
      const updated = fresh?.shipments?.find((row) => shipmentKey(row) === shipmentKey(shipment))
      if (updated && updated.items.every((item) => item.pendiente === 0)) {
        // Todo lo enviado ya esta guardado: el envio se cierra solo.
        await finishShipment(updated)
        await loadData()
        onSaved?.(`${shipment.codigo}: todo guardado, envio recibido completo.`)
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
  const visibleShipments = useMemo(
    () => shipments
      .map((shipment) => ({ ...shipment, visibleItems: shipment.items.filter(matches) }))
      .filter((shipment) => !term || shipment.visibleItems.length || normalize(shipment.codigo).includes(term)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shipments, term]
  )
  const visiblePorUbicar = porUbicar.filter(matches)
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
      <button
        type="button"
        className={`quick-actions__pending-shipments-trigger por-guardar__trigger${count > 0 ? ' has-items' : ''}`}
        onClick={() => setOpen(true)}
        aria-label={`Por guardar: ${count} producto(s)`}
        title="Envios que ya llegaron: verifica cuanto llego y guardalo en su ubicacion"
      >
        <span>Por guardar</span>
        <span className="quick-actions__pending-shipments-count">{count}</span>
      </button>

      {open && createPortal(
        <div
          className={`por-guardar${darkMode ? ' por-guardar--dark' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label="Por guardar"
          onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setOpen(false) }}
        >
          <div className="por-guardar__dialog">
            <header className="por-guardar__header">
              <div>
                <h3>Por guardar</h3>
                <p>
                  Envíos que ya llegaron. Verifica <strong>cuánto llegó</strong> de cada producto y guárdalo en su
                  ubicación: recién ahí se suma al inventario (mientras tanto se ve entre paréntesis).
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
                <p className="por-guardar__empty">No hay nada por guardar. Cuando confirmes la llegada de un envío, aparece aquí.</p>
              ) : (
                <>
                  {visibleShipments.map((shipment) => {
                    const pendientes = shipment.items.filter((item) => item.pendiente > 0)
                    return (
                      <section key={shipmentKey(shipment)} className="por-guardar__shipment">
                        <header className="por-guardar__shipment-head">
                          <div>
                            <strong>{`${shipment.tipo === 'importacion' ? 'Importación' : 'Traslado'} #${shipment.codigo}`}</strong>
                            <span>
                              {[
                                shipment.origen && `Desde ${shipment.origen}`,
                                `a ${shipment.sucursal_nombre}`,
                                shipment.llegada_confirmada_en && `llegó ${formatDateTime(shipment.llegada_confirmada_en)}`,
                              ].filter(Boolean).join(' · ')}
                            </span>
                          </div>
                          <div className="por-guardar__shipment-actions">
                            <button
                              type="button"
                              className="por-guardar__btn"
                              onClick={() => void saveShipmentItems(shipment, pendientes)}
                              disabled={saving || !pendientes.length || pendientes.some((item) => problemFor(itemKey(shipment, item), item.pendiente))}
                              title="Guardar todos los productos con la cantidad y ubicacion indicadas"
                            >
                              Guardar todo
                            </button>
                            <button
                              type="button"
                              className="por-guardar__btn por-guardar__btn--warn"
                              onClick={() => setFinishTarget(shipment)}
                              disabled={saving}
                              title="Cerrar el envio: lo que no se guardo queda como faltante en Inconvenientes"
                            >
                              Terminar envío
                            </button>
                          </div>
                        </header>
                        <table className="por-guardar__table">
                          <thead>
                            <tr>
                              <th>Producto</th>
                              <th className="por-guardar__col-num">Debía llegar</th>
                              <th className="por-guardar__col-num">Guardado</th>
                              <th className="por-guardar__col-qty">Llegó</th>
                              <th>Guardar en</th>
                              <th className="por-guardar__col-action" />
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
                                  <td className="por-guardar__col-num">{item.guardado}</td>
                                  {done ? (
                                    <td colSpan={3} className="por-guardar__done">
                                      <CheckCircle2 size={15} aria-hidden="true" /> Guardado completo
                                    </td>
                                  ) : (
                                    <>
                                      <td className="por-guardar__col-qty">
                                        <input
                                          type="text"
                                          inputMode="numeric"
                                          value={drafts[key]?.cantidad ?? ''}
                                          onChange={(event) => updateDraft(key, { cantidad: event.target.value.replace(/[^\d]/g, '') })}
                                          aria-label={`Cuantas llegaron de ${item.producto_codigo}`}
                                        />
                                        <small>de {item.pendiente}</small>
                                      </td>
                                      <td>{renderLocation(key, shipment.sucursal_id, item.sugerida_subdivision_id)}</td>
                                      <td className="por-guardar__col-action">
                                        <button
                                          type="button"
                                          className="por-guardar__btn por-guardar__btn--primary"
                                          onClick={() => void saveShipmentItems(shipment, [item])}
                                          disabled={saving || Boolean(problem)}
                                          title={problem || 'Guardar y sumar al inventario en esta ubicacion'}
                                        >
                                          Guardar
                                        </button>
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
                      </header>
                      <table className="por-guardar__table">
                        <thead>
                          <tr>
                            <th>Producto</th>
                            <th>Sucursal</th>
                            <th className="por-guardar__col-qty">Cantidad</th>
                            <th>Guardar en</th>
                            <th className="por-guardar__col-action" />
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
                                  <button
                                    type="button"
                                    className="por-guardar__btn por-guardar__btn--primary"
                                    onClick={() => void savePorUbicar([row])}
                                    disabled={saving || Boolean(problem)}
                                    title={problem || 'Mover de POR UBICAR a esta ubicacion'}
                                  >
                                    Guardar
                                  </button>
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
        title="Terminar envío"
        message={(() => {
          if (!finishTarget) return ''
          const faltan = finishTarget.items.filter((item) => item.pendiente > 0)
          return faltan.length
            ? `Se cierra ${finishTarget.codigo} con lo guardado. Lo que no se guardó queda como faltante en Inconvenientes.`
            : `Se cierra ${finishTarget.codigo}: todo está guardado.`
        })()}
        details={finishTarget && finishTarget.items.some((item) => item.pendiente > 0) ? (
          <ul className="por-guardar__finish-list">
            {finishTarget.items.filter((item) => item.pendiente > 0).map((item) => (
              <li key={item.producto_id}><strong>{item.producto_codigo}</strong>{` · faltan ${item.pendiente} de ${item.enviado}`}</li>
            ))}
          </ul>
        ) : null}
        confirmLabel="Terminar envío"
        busy={saving}
        onCancel={() => setFinishTarget(null)}
        onConfirm={async () => {
          const target = finishTarget
          setSaving(true)
          setError('')
          try {
            await finishShipment(target)
            setFinishTarget(null)
            onSaved?.(`${target.codigo} terminado.`)
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
