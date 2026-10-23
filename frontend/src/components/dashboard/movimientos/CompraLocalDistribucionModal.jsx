import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { API_URL, authFetch } from '../../../utils/api'
import { getAppPortalRoot } from '../../../utils/portalRoot'
import BlockerNotice from '../common/BlockerNotice'
import '../admin/CreateUsuario/CreateUsuario.css'
import '../QuickActions/QuickActions.css'
import '../importaciones/ImportacionesTable.css'

// Reparto de una compra local a otras sucursales, igual que el paso de
// distribucion de una importacion: la columna de la sucursal de la compra se
// calcula sola (lo que no se envia se queda ahi) y cada sucursal con productos
// recibe un envio que se confirma desde "Envios pendientes". El avance se
// guarda en la compra (borrador_distribucion) con cada cambio.

const readErrorMessage = async (response, fallback) => {
  const data = await response.json().catch(() => ({}))
  const detail = data?.detail || data?.detalles || data?.non_field_errors
  if (Array.isArray(detail)) return String(detail[0] || fallback)
  return String(detail || fallback)
}

const parseList = (data) => (Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [])

function CompraLocalDistribucionModal({ open, entradaId, token, onClose, onSent }) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [compra, setCompra] = useState(null)
  const [sucursales, setSucursales] = useState([])
  const [users, setUsers] = useState([])
  const [usersError, setUsersError] = useState(false)
  const [step, setStep] = useState(1)
  const [distribution, setDistribution] = useState({})
  const [recipientsBySucursal, setRecipientsBySucursal] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const isDark = Boolean(document.querySelector('.dashboard-shell')?.classList.contains('dark'))
  const mode = isDark ? 'dark' : 'light'

  const load = useCallback(async () => {
    if (!entradaId || !token) return
    setLoading(true)
    setLoadError('')
    try {
      const base = `${API_URL}/movimientos/movimiento_inventario/${entradaId}/distribucion-compra/`
      const [compraRes, sucRes] = await Promise.all([
        authFetch(base, {}, token),
        authFetch(`${API_URL}/inventario/sucursales/?modulo=movimientos_entradas&page_size=500`, {}, token),
      ])
      if (!compraRes.ok) throw new Error(await readErrorMessage(compraRes, 'No se pudo cargar la compra.'))
      if (!sucRes.ok) throw new Error('No se pudieron cargar las sucursales.')
      const compraData = await compraRes.json()
      setCompra(compraData)
      setSucursales(parseList(await sucRes.json()))
      const borrador = compraData?.borrador || {}
      setDistribution(borrador.distribution && typeof borrador.distribution === 'object' ? borrador.distribution : {})
      setRecipientsBySucursal(
        borrador.recipientsBySucursal && typeof borrador.recipientsBySucursal === 'object' ? borrador.recipientsBySucursal : {}
      )
      setStep(borrador.step === 2 ? 2 : 1)
    } catch (error) {
      setLoadError(error?.message || 'No se pudo cargar la compra.')
    } finally {
      setLoading(false)
    }
  }, [entradaId, token])

  const loadUsers = useCallback(async () => {
    setUsersError(false)
    try {
      const collected = []
      let url = `${API_URL}/usuarios/listado/destinatarios/?page_size=200`
      while (url) {
        const resp = await authFetch(url, {}, token)
        if (!resp.ok) {
          if (!collected.length) setUsersError(true)
          break
        }
        const data = await resp.json().catch(() => ({}))
        collected.push(...(Array.isArray(data) ? data : (data.results || [])))
        url = Array.isArray(data) ? null : (data.next || null)
      }
      setUsers(collected.map((u) => ({
        id: u.id,
        name: [u.nombres || u.nombre, u.apellidos || u.apellido].filter(Boolean).join(' ').trim() || u.correo || 'Usuario',
        es_admin: Boolean(u.es_administrador),
        sucursales_ids: (u.sucursales || []).map((s) => s.id),
        entradas_sucursales_ids: (u.sucursales_por_modulo || [])
          .filter((scope) => scope.modulo === 'movimientos_entradas')
          .flatMap((scope) => scope.sucursales_ids || []),
        puede_entradas: (u.permisos_resumen || []).some((p) =>
          p.modulo === 'movimientos_entradas' && (p.puede_crear || p.puede_actualizar || p.puede_leer)
        ),
      })))
    } catch {
      setUsersError(true)
    }
  }, [token])

  useEffect(() => {
    if (!open) return
    setSubmitError('')
    void load()
    void loadUsers()
  }, [open, load, loadUsers])

  const origenId = compra?.sucursal_id ?? null
  const rows = useMemo(
    () => (compra?.productos || [])
      .map((p) => ({ ...p, disponible: Math.max(0, Number(p.cantidad || 0) - Number(p.enviado || 0)) }))
      .filter((p) => p.disponible > 0),
    [compra]
  )
  const origen = useMemo(
    () => sucursales.find((s) => s.id === origenId) || (origenId ? { id: origenId, nombre: compra?.sucursal_nombre || 'Origen' } : null),
    [sucursales, origenId, compra]
  )
  const destinos = useMemo(() => sucursales.filter((s) => s.id !== origenId), [sucursales, origenId])

  const sentFor = (row) => destinos.reduce((sum, suc) => sum + (parseInt(distribution[row.producto_id]?.[suc.id]) || 0), 0)

  const updateDistribution = (row, sucursalId, value) => {
    setSubmitError('')
    setDistribution((prev) => ({ ...prev, [row.producto_id]: { ...(prev[row.producto_id] || {}), [sucursalId]: value } }))
  }

  const overRows = rows.filter((row) => sentFor(row) > row.disponible)
  const sucursalesWithItems = useMemo(
    () => destinos
      .map((suc) => ({
        ...suc,
        items: rows
          .filter((row) => parseInt(distribution[row.producto_id]?.[suc.id]) > 0)
          .map((row) => ({ ...row, qty: parseInt(distribution[row.producto_id][suc.id]) })),
      }))
      .filter((suc) => suc.items.length > 0),
    [destinos, rows, distribution]
  )
  const canNext = sucursalesWithItems.length > 0 && overRows.length === 0

  const getUsersForSucursal = (sucId) => users.filter((u) => {
    if (u.es_admin || !u.puede_entradas) return false
    return u.entradas_sucursales_ids.includes(sucId) || u.sucursales_ids.includes(sucId)
  })
  const canConfirm = canNext && sucursalesWithItems.every((suc) => (recipientsBySucursal[suc.id] || []).length > 0)
  const confirmBlockReason = (() => {
    if (step !== 2 || canConfirm) return ''
    if (usersError) return 'No se puede enviar: no se cargaron los usuarios destinatarios.'
    const sinUsuarios = sucursalesWithItems.filter((suc) => getUsersForSucursal(suc.id).length === 0)
    if (sinUsuarios.length) {
      return `No se puede enviar: ${sinUsuarios.map((s) => s.nombre).join(', ')} ${sinUsuarios.length === 1 ? 'no tiene' : 'no tienen'} destinatarios (ver el aviso de arriba).`
    }
    const sinSeleccion = sucursalesWithItems.filter((suc) => !(recipientsBySucursal[suc.id] || []).length)
    return `Para enviar, escoge al menos un destinatario para: ${sinSeleccion.map((s) => s.nombre).join(', ')}.`
  })()

  const toggleRecipient = (sucursalId, userId) => {
    setRecipientsBySucursal((prev) => {
      const current = prev[sucursalId] || []
      return { ...prev, [sucursalId]: current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId] }
    })
  }

  // Guardado automatico del reparto en la compra con cada cambio.
  const saveDraft = useCallback(async ({ keepalive = false } = {}) => {
    if (!entradaId || !token) return
    try {
      await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/${entradaId}/distribucion-compra/`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ borrador: { step, distribution, recipientsBySucursal } }),
          keepalive,
        },
        token
      )
    } catch {
      // Sin conexion: se reintenta con el siguiente cambio o al cerrar.
    }
  }, [entradaId, token, step, distribution, recipientsBySucursal])

  const autosaveTimerRef = useRef(null)
  const autosavePendingRef = useRef(null)
  useEffect(() => {
    if (!open || loading || submitting || !compra) return undefined
    const run = (options) => {
      autosavePendingRef.current = null
      void saveDraft(options)
    }
    autosavePendingRef.current = run
    autosaveTimerRef.current = setTimeout(run, 800)
    return () => clearTimeout(autosaveTimerRef.current)
  }, [open, loading, submitting, compra, saveDraft])

  useEffect(() => {
    const flush = () => {
      const pending = autosavePendingRef.current
      if (!pending) return
      clearTimeout(autosaveTimerRef.current)
      pending({ keepalive: true })
    }
    const handleVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  const handleClose = () => {
    if (submitting) return
    const pending = autosavePendingRef.current
    if (pending) {
      clearTimeout(autosaveTimerRef.current)
      pending()
    }
    onClose?.()
  }

  const handleConfirm = async () => {
    if (!canConfirm) return
    setSubmitting(true)
    setSubmitError('')
    try {
      const distribuciones = rows.flatMap((row) =>
        destinos
          .filter((suc) => parseInt(distribution[row.producto_id]?.[suc.id]) > 0)
          .map((suc) => ({ producto_id: row.producto_id, sucursal_id: suc.id, cantidad: parseInt(distribution[row.producto_id][suc.id]) }))
      )
      const destinatarios_por_sucursal = sucursalesWithItems.map((suc) => ({
        sucursal_id: suc.id,
        user_ids: recipientsBySucursal[suc.id] || [],
      }))
      const resp = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/${entradaId}/distribucion-compra/`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ distribuciones, destinatarios_por_sucursal }) },
        token
      )
      if (!resp.ok) throw new Error(await readErrorMessage(resp, 'No se pudo enviar a las sucursales.'))
      autosavePendingRef.current = null
      clearTimeout(autosaveTimerRef.current)
      onSent?.(await resp.json(), sucursalesWithItems.map((suc) => suc.nombre))
    } catch (error) {
      setSubmitError(error?.message || 'No se pudo enviar a las sucursales.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  const gridCols = `minmax(72px, 0.5fr) minmax(140px, 1.6fr) 56px 70px repeat(${destinos.length}, 62px)`

  return createPortal(
    <div
      className={`quick-actions__receive-overlay ${mode}`}
      style={{ zIndex: 2100 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose() }}
    >
      <div
        className={`quick-actions__receive-dialog ${mode}`}
        style={{ width: step === 1 ? 'min(900px, 95vw)' : 'min(700px, 95vw)', gridTemplateRows: 'auto auto 1fr auto' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="quick-actions__receive-head">
          <div>
            <h4>{compra?.no_documento || 'Compra local'}</h4>
            <p>{compra?.sucursal_nombre || '-'} · Enviar a sucursales</p>
          </div>
          <button type="button" className="quick-actions__receive-close" onClick={handleClose} disabled={submitting}>
            <X size={16} />
          </button>
        </header>

        <div style={{ padding: '12px 20px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 5 }}>
            {[1, 2].map((n) => (
              <div key={n} style={{ flex: 1, height: 3, borderRadius: 2, background: step >= n ? 'var(--color-primary, #2563eb)' : 'var(--color-border, #e2e8f0)', transition: 'background .3s' }} />
            ))}
          </div>
          <span style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
            Paso {step} de 2 — {step === 1 ? 'Distribución a sucursales' : 'Destinatarios del envío'}
          </span>
        </div>

        <div className="quick-actions__receive-body">
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0', gap: 12 }}>
              <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Cargando compra...</span>
            </div>
          ) : loadError ? (
            <div style={{ padding: 16 }}>
              <BlockerNotice
                title="No se pudo cargar la compra"
                reason={`${loadError} Tu avance está guardado; vuelve a intentarlo.`}
                actionLabel="Reintentar"
                onAction={load}
              />
            </div>
          ) : !rows.length ? (
            <div style={{ padding: 16 }}>
              <BlockerNotice
                title="No hay nada por enviar"
                reason="Todos los productos de esta compra ya se enviaron a otras sucursales."
              />
            </div>
          ) : !destinos.length ? (
            <div style={{ padding: 16 }}>
              <BlockerNotice
                title="No se puede enviar: no tienes otras sucursales con permiso de Entradas"
                reason="Para repartir la compra necesitas permiso de Entradas en las sucursales destino. Pide a un administrador que lo asigne en Administrar › Usuarios › editar tu usuario › Permisos (Entradas)."
                goTo="Administrar"
              />
            </div>
          ) : step === 1 ? (
            <div className="quick-actions__receive-step quick-actions__receive-step--list" style={{ '--receive-list-received-column': '0px' }}>
              <article className="quick-actions__receive-stage quick-actions__receive-stage--list">
                <div className="quick-actions__receive-stage-copy">
                  <p className="quick-actions__receive-stage-kicker">Paso 1 — Distribución</p>
                  <h5>Envía los productos a las sucursales</h5>
                  <p className="quick-actions__receive-stage-name">
                    Indica cuántas unidades de cada producto van a cada sucursal. Lo que no envíes se queda en {origen?.nombre || 'la sucursal de la compra'}.
                  </p>
                </div>
              </article>
              <div className="create-user__locations-table importaciones-modal__products-table imp-distribucion__table">
                <div className="create-user__locations-row create-user__locations-row--head imp-distribucion__productos-row" style={{ gridTemplateColumns: gridCols }}>
                  <span style={{ justifyContent: 'flex-start' }}>Código</span>
                  <span style={{ justifyContent: 'flex-start' }}>Descripción</span>
                  <span style={{ justifyContent: 'center' }}>Total</span>
                  <span title={origen?.nombre}>{origen?.nombre || 'Origen'}</span>
                  {destinos.map((suc) => <span key={suc.id} title={suc.nombre}>{suc.nombre}</span>)}
                </div>
                {rows.map((row) => {
                  const sent = sentFor(row)
                  const isOver = sent > row.disponible
                  return (
                    <div key={row.producto_id} className="create-user__locations-row imp-distribucion__productos-row" style={{ gridTemplateColumns: gridCols }}>
                      <span className="imp-table-cell-text" style={{ justifyContent: 'flex-start' }} title={row.codigo}>{row.codigo || '-'}</span>
                      <span className="imp-table-cell-text" style={{ justifyContent: 'flex-start' }} title={row.nombre}>{row.nombre || '-'}</span>
                      <span
                        className="imp-table-cell-text"
                        style={{ justifyContent: 'center', fontWeight: 700, color: isOver ? '#dc2626' : 'var(--color-text-secondary)' }}
                        title={row.enviado ? `Compradas ${row.cantidad}, ya enviadas ${row.enviado}` : undefined}
                      >
                        {row.disponible}
                      </span>
                      <span>
                        <input
                          type="number"
                          value={Math.max(0, row.disponible - sent)}
                          readOnly
                          disabled
                          title="Calculado automáticamente: total menos lo enviado a otras sucursales"
                          className="imp-distribucion__cantidad-input imp-distribucion__cantidad-input--matriz"
                        />
                      </span>
                      {destinos.map((suc) => (
                        <span key={suc.id}>
                          <input
                            type="number"
                            min="0"
                            max={row.disponible}
                            value={distribution[row.producto_id]?.[suc.id] ?? ''}
                            disabled={submitting}
                            onChange={(e) => updateDistribution(row, suc.id, e.target.value)}
                            className="imp-distribucion__cantidad-input"
                          />
                        </span>
                      ))}
                    </div>
                  )
                })}
              </div>
              {overRows.length > 0 && (
                <p className="quick-actions__receive-item-hint quick-actions__receive-item-hint--warning" style={{ padding: '0 16px' }}>
                  Estás enviando más de lo que hay en: {overRows.map((row) => row.codigo).join(', ')}.
                </p>
              )}
            </div>
          ) : (
            <div className="quick-actions__receive-step quick-actions__receive-step--list" style={{ '--receive-list-received-column': '0px' }}>
              <article className="quick-actions__receive-stage quick-actions__receive-stage--list">
                <div className="quick-actions__receive-stage-copy">
                  <p className="quick-actions__receive-stage-kicker">Paso 2 — Destinatarios del envío</p>
                  <h5>Vas a enviar productos a {sucursalesWithItems.length === 1 ? 'una sucursal' : 'varias sucursales'}</h5>
                  <p className="quick-actions__receive-stage-name">Escoge a quién debe llegarle el recordatorio de cada envío. Cada sucursal que recibe productos necesita al menos un destinatario.</p>
                </div>
              </article>
              {usersError ? (
                <div style={{ padding: '4px 16px 8px' }}>
                  <BlockerNotice
                    title="No se pudieron cargar los usuarios destinatarios"
                    reason="Hubo un problema de conexión o del servidor, así que no se puede saber a quién enviar cada envío. Tu avance está guardado; vuelve a intentarlo."
                    actionLabel="Reintentar"
                    onAction={loadUsers}
                  />
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 16px 8px' }}>
                  {sucursalesWithItems.map((suc) => {
                    const usersForSuc = getUsersForSucursal(suc.id)
                    const selectedIds = recipientsBySucursal[suc.id] || []
                    return (
                      <div key={suc.id} style={{ background: 'var(--color-surface, #f8fafc)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 10, padding: '12px 14px' }}>
                        <span style={{ fontWeight: 700, fontSize: '1rem' }}>{suc.nombre}</span>
                        <p style={{ fontSize: '0.88rem', color: 'var(--color-text-secondary)', margin: '3px 0 10px' }}>
                          {suc.items.map((item) => `${item.codigo} × ${item.qty}`).join(' · ')}
                        </p>
                        {usersForSuc.length === 0 ? (
                          <BlockerNotice
                            compact
                            title={`No se puede enviar a ${suc.nombre}: no tiene destinatarios`}
                            reason="Ningún usuario (que no sea administrador) tiene permiso de Entradas en esta sucursal. Para resolverlo: Administrar › Usuarios › editar el usuario › Permisos de Entradas en esta sucursal."
                            goTo="Administrar"
                          />
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                            {usersForSuc.map((u) => (
                              <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.92rem' }}>
                                <input type="checkbox" checked={selectedIds.includes(u.id)} onChange={() => toggleRecipient(suc.id, u.id)} style={{ width: 17, height: 17, cursor: 'pointer' }} />
                                <span>{u.name}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {submitError && (
            <div style={{ padding: '0 16px 12px' }}>
              <BlockerNotice compact title="No se pudo enviar a las sucursales" reason={submitError} />
            </div>
          )}
        </div>

        <footer className="quick-actions__receive-actions">
          {step === 1 ? (
            <>
              {!loading && !loadError && rows.length > 0 && destinos.length > 0 && !canNext && (
                <span className="imp-receive-footer-hint">
                  {overRows.length ? 'Corrige las cantidades marcadas en rojo.' : 'Para continuar, indica cuánto va a al menos una sucursal.'}
                </span>
              )}
              <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={handleClose}>Ahora no</button>
              <button
                type="button"
                className={`quick-actions__receive-btn${canNext ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`}
                onClick={() => setStep(2)}
                disabled={!canNext}
              >
                Siguiente
              </button>
            </>
          ) : (
            <>
              {confirmBlockReason && <span className="imp-receive-footer-hint">{confirmBlockReason}</span>}
              <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep(1)} disabled={submitting}>Atrás</button>
              <button
                type="button"
                title={confirmBlockReason || undefined}
                className={`quick-actions__receive-btn${canConfirm ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`}
                onClick={handleConfirm}
                disabled={submitting || !canConfirm}
              >
                {submitting ? 'Enviando...' : 'Enviar a sucursales'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    getAppPortalRoot()
  )
}

export default CompraLocalDistribucionModal
