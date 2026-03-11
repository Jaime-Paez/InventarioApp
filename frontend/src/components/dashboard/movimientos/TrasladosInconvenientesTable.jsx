import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw, Wrench, X } from 'lucide-react'
import { Toast } from 'primereact/toast'
import { API_URL, authFetch } from '../../../utils/api'
import './TrasladosInconvenientesTable.css'

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeId = (value) => (value == null ? '' : String(value).trim())

const formatDateTime = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return '-'
  const timestamp = Date.parse(raw)
  if (!Number.isFinite(timestamp)) return raw
  try {
    return new Intl.DateTimeFormat('es-EC', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp))
  } catch {
    return raw
  }
}

const formatEstado = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'pendiente') return 'Pendiente'
  if (normalized === 'resuelto') return 'Resuelto'
  if (normalized === 'perdido') return 'Perdido'
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : '-'
}

const formatResolucion = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'sumar_solicitante') return 'Sumado a sucursal solicitante'
  if (normalized === 'sumar_proveedora') return 'Sumado a sucursal proveedora'
  if (normalized === 'perdido') return 'Perdido / robado'
  return '-'
}

const formatHistorialAccion = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'detectado') return 'Detectado'
  if (normalized === 'sumado_a_sucursal') return 'Sumado a sucursal'
  if (normalized === 'marcado_como_perdido') return 'Marcado como perdido'
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : '-'
}

function TrasladosInconvenientesTable({ token, moduleActions }) {
  const toast = useRef(null)
  const canRead = moduleActions?.puede_leer ?? true
  const canUpdate = moduleActions?.puede_actualizar ?? true

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [expandedId, setExpandedId] = useState('')
  const [statusFilter, setStatusFilter] = useState('pendiente')

  const [resolverTarget, setResolverTarget] = useState(null)
  const [resolverDecision, setResolverDecision] = useState('')
  const [resolverMotivo, setResolverMotivo] = useState('')
  const [resolverSubdivisionId, setResolverSubdivisionId] = useState('')
  const [resolverSubdivisions, setResolverSubdivisions] = useState([])
  const [resolverSubdivisionsLoading, setResolverSubdivisionsLoading] = useState(false)
  const [resolverSubmitting, setResolverSubmitting] = useState(false)
  const [resolverError, setResolverError] = useState('')

  const showError = useCallback((detail) => {
    if (!detail) return
    toast.current?.show({
      severity: 'error',
      summary: 'Error',
      detail,
      life: 3600,
    })
  }, [])

  const showSuccess = useCallback((detail) => {
    if (!detail) return
    toast.current?.show({
      severity: 'success',
      summary: 'Listo',
      detail,
      life: 2800,
    })
  }, [])

  const fetchRows = useCallback(async () => {
    if (!token || !canRead) {
      setRows([])
      return []
    }

    setLoading(true)
    try {
      const endpoint = new URL(`${API_URL}/movimientos/movimiento_inventario/traslados-inconvenientes/`)
      if (statusFilter && statusFilter !== 'all') {
        endpoint.searchParams.set('estado', statusFilter)
      }

      const response = await authFetch(endpoint.toString(), {}, token)
      if (!response.ok) {
        throw new Error('No se pudieron cargar los inconvenientes de traslado.')
      }

      const payload = await response.json().catch(() => ([]))
      const parsed = parseApiList(payload)
      setRows(parsed)
      return parsed
    } catch (error) {
      setRows([])
      showError(error?.message || 'No se pudieron cargar los inconvenientes de traslado.')
      return []
    } finally {
      setLoading(false)
    }
  }, [canRead, showError, statusFilter, token])

  useEffect(() => {
    void fetchRows()
  }, [fetchRows])

  const resolverTargetBranchId = useMemo(() => {
    if (!resolverTarget) return ''
    if (resolverDecision === 'sumar_solicitante') return normalizeId(resolverTarget?.sucursal_solicitante_id)
    if (resolverDecision === 'sumar_proveedora') return normalizeId(resolverTarget?.sucursal_proveedora_id)
    return ''
  }, [resolverDecision, resolverTarget])

  const resolverTargetBranchLabel = useMemo(() => {
    if (!resolverTarget) return ''
    if (resolverDecision === 'sumar_solicitante') {
      return String(resolverTarget?.sucursal_solicitante || '').trim() || 'Sucursal solicitante'
    }
    if (resolverDecision === 'sumar_proveedora') {
      return String(resolverTarget?.sucursal_proveedora || '').trim() || 'Sucursal proveedora'
    }
    return ''
  }, [resolverDecision, resolverTarget])

  useEffect(() => {
    if (!token || !resolverTargetBranchId) {
      setResolverSubdivisions([])
      setResolverSubdivisionId('')
      return
    }

    let cancelled = false

    const loadSubdivisions = async () => {
      setResolverSubdivisionsLoading(true)
      try {
        const response = await authFetch(
          `${API_URL}/inventario/subdivisiones/?page_size=500&sucursal_id=${encodeURIComponent(resolverTargetBranchId)}&modulo=movimientos_entradas`,
          {},
          token
        )
        if (!response.ok) {
          throw new Error('No se pudieron cargar las subdivisiones de la sucursal.')
        }
        const payload = await response.json().catch(() => ({}))
        if (cancelled) return
        const parsed = parseApiList(payload)
        setResolverSubdivisions(parsed)
        setResolverSubdivisionId((current) => current || normalizeId(parsed?.[0]?.id))
      } catch (error) {
        if (cancelled) return
        setResolverSubdivisions([])
        setResolverSubdivisionId('')
        showError(error?.message || 'No se pudieron cargar las subdivisiones.')
      } finally {
        if (!cancelled) {
          setResolverSubdivisionsLoading(false)
        }
      }
    }

    void loadSubdivisions()
    return () => {
      cancelled = true
    }
  }, [resolverTargetBranchId, showError, token])

  const openResolver = useCallback((row) => {
    setResolverTarget(row || null)
    setResolverDecision('')
    setResolverMotivo('')
    setResolverSubdivisionId('')
    setResolverSubdivisions([])
    setResolverSubdivisionsLoading(false)
    setResolverSubmitting(false)
    setResolverError('')
  }, [])

  const closeResolver = useCallback(() => {
    setResolverTarget(null)
    setResolverDecision('')
    setResolverMotivo('')
    setResolverSubdivisionId('')
    setResolverSubdivisions([])
    setResolverSubdivisionsLoading(false)
    setResolverSubmitting(false)
    setResolverError('')
  }, [])

  const submitResolver = useCallback(async () => {
    if (!token || !resolverTarget) return
    if (!resolverDecision) {
      setResolverError('Debes seleccionar una decision.')
      return
    }
    if (
      (resolverDecision === 'sumar_solicitante' || resolverDecision === 'sumar_proveedora') &&
      !normalizeId(resolverSubdivisionId)
    ) {
      setResolverError('Debes seleccionar una subdivision para sumar inventario.')
      return
    }

    setResolverError('')
    setResolverSubmitting(true)
    try {
      const body = {
        decision: resolverDecision,
        motivo: String(resolverMotivo || '').trim(),
      }
      if (resolverDecision === 'sumar_solicitante' || resolverDecision === 'sumar_proveedora') {
        body.subdivision_id = Number.parseInt(String(resolverSubdivisionId || ''), 10)
      }

      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/traslados-inconvenientes/${encodeURIComponent(
          normalizeId(resolverTarget?.id)
        )}/resolver/`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudo resolver el inconveniente.')
      }

      showSuccess('Inconveniente resuelto.')
      closeResolver()
      await fetchRows()
    } catch (error) {
      setResolverError(error?.message || 'No se pudo resolver el inconveniente.')
    } finally {
      setResolverSubmitting(false)
    }
  }, [
    closeResolver,
    fetchRows,
    resolverDecision,
    resolverMotivo,
    resolverSubdivisionId,
    resolverTarget,
    showSuccess,
    token,
  ])

  if (!canRead) {
    return (
      <section className="transfer-issues">
        <p className="transfer-issues__empty">
          No tienes permisos para ver inconvenientes de traslado.
        </p>
      </section>
    )
  }

  return (
    <section className="transfer-issues">
      <Toast ref={toast} />

      <header className="transfer-issues__head">
        <div>
          <h3>Inconvenientes</h3>
          <p>Gestiona faltantes y deja historial de resoluciones.</p>
        </div>
        <div className="transfer-issues__controls">
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(String(event.target.value || 'all'))}
            disabled={loading}
          >
            <option value="all">Todos</option>
            <option value="pendiente">Pendientes</option>
            <option value="resuelto">Resueltos</option>
            <option value="perdido">Perdidos</option>
          </select>
          <button
            type="button"
            className="transfer-issues__refresh"
            onClick={() => void fetchRows()}
            disabled={loading}
            aria-label="Actualizar inconvenientes de traslado"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      <div className="transfer-issues__table-wrap">
        {loading && (
          <div className="transfer-issues__table-loading">
            <p className="transfer-issues__loading">
              <Loader2 size={14} />
              Cargando inconvenientes...
            </p>
          </div>
        )}

        <table className="transfer-issues__table">
          <thead>
            <tr>
              <th>Documento</th>
              <th>Producto</th>
              <th>Faltante</th>
              <th>Sucursal envía</th>
              <th>Sucursal recibe</th>
              <th>Estado</th>
              <th>Resolución</th>
              <th>Creado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr className="transfer-issues__empty-row">
                <td colSpan={9} />
              </tr>
            ) : rows.map((row) => {
              const rowId = normalizeId(row?.id)
              const isExpanded = expandedId === rowId
              const rowState = normalizeId(row?.estado).toLowerCase()
              const canResolveRow = canUpdate && rowState === 'pendiente'
              const historyRows = Array.isArray(row?.historial) ? row.historial : []
              const rowKey = rowId || `${normalizeId(row?.solicitud_id)}-${normalizeId(row?.producto_id)}`
              const productCode = String(row?.producto_codigo || '').trim()
              const productName = String(row?.producto_nombre || '').trim() || 'Producto sin nombre'
              const missingQty = Number.parseInt(String(row?.cantidad_faltante || 0), 10) || 0
              const stateClass = rowState || 'pendiente'

              return (
                <React.Fragment key={`transfer-issue-${rowKey}`}>
                  <tr className="transfer-issues__row">
                    <td>{String(row?.solicitud_no_documento || row?.solicitud_id || '-').trim()}</td>
                    <td>
                      <div className="transfer-issues__product-cell">
                        <strong>{productCode || `Producto ${row?.producto_id || '-'}`}</strong>
                        <span>{productName}</span>
                        {row?.motivo ? (
                          <small title={String(row.motivo || '').trim()}>
                            Novedad: {String(row.motivo || '').trim()}
                          </small>
                        ) : null}
                      </div>
                    </td>
                    <td>{missingQty}</td>
                    <td>{String(row?.sucursal_proveedora || '-').trim()}</td>
                    <td>{String(row?.sucursal_solicitante || '-').trim()}</td>
                    <td>
                      <span className={`transfer-issues__state transfer-issues__state--${stateClass}`}>
                        {formatEstado(row?.estado)}
                      </span>
                    </td>
                    <td>{formatResolucion(row?.resolucion)}</td>
                    <td>{formatDateTime(row?.created_at)}</td>
                    <td>
                      <div className="transfer-issues__item-actions">
                        <button
                          type="button"
                          className="transfer-issues__action"
                          onClick={() => setExpandedId(isExpanded ? '' : rowId)}
                        >
                          {isExpanded ? 'Ocultar historial' : 'Ver historial'}
                        </button>
                        {canResolveRow && (
                          <button
                            type="button"
                            className="transfer-issues__action transfer-issues__action--resolve"
                            onClick={() => openResolver(row)}
                          >
                            <Wrench size={13} />
                            Resolver
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>

                  {isExpanded && (
                    <tr className="transfer-issues__history-row-wrap">
                      <td colSpan={9}>
                        <div className="transfer-issues__history">
                          {!historyRows.length ? (
                            <p>Sin historial.</p>
                          ) : (
                            historyRows.map((item) => (
                              <div key={`transfer-issue-history-${rowId}-${item.id}`} className="transfer-issues__history-row">
                                <strong>{formatHistorialAccion(item?.accion)}</strong>
                                <span>{String(item?.detalle || '-').trim()}</span>
                                <small>
                                  {String(item?.actor_nombre || 'Sistema').trim()} - {formatDateTime(item?.created_at)}
                                </small>
                              </div>
                            ))
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {resolverTarget && (
        <div className="transfer-issues__resolver-overlay" onMouseDown={closeResolver}>
          <div
            className="transfer-issues__resolver-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Resolver inconveniente"
          >
            <header className="transfer-issues__resolver-head">
              <div>
                <h4>Resolver inconveniente</h4>
                <p>
                  #{String(resolverTarget?.solicitud_no_documento || resolverTarget?.solicitud_id || '-').trim()} |{' '}
                  {String(resolverTarget?.producto_nombre || resolverTarget?.producto_codigo || '-').trim()}
                </p>
              </div>
              <button
                type="button"
                className="transfer-issues__resolver-close"
                onClick={closeResolver}
                disabled={resolverSubmitting}
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </header>

            <div className="transfer-issues__resolver-body">
              <div className="transfer-issues__resolver-decision">
                <span>Decision</span>
                <div className="transfer-issues__resolver-decision-grid">
                  <button
                    type="button"
                    className={`transfer-issues__resolver-decision-btn${
                      resolverDecision === 'sumar_solicitante' ? ' is-active' : ''
                    }`}
                    onClick={() => {
                      setResolverDecision('sumar_solicitante')
                      setResolverSubdivisionId('')
                    }}
                    disabled={resolverSubmitting}
                  >
                    Sumar a sucursal que recibe
                  </button>
                  <button
                    type="button"
                    className={`transfer-issues__resolver-decision-btn${
                      resolverDecision === 'sumar_proveedora' ? ' is-active' : ''
                    }`}
                    onClick={() => {
                      setResolverDecision('sumar_proveedora')
                      setResolverSubdivisionId('')
                    }}
                    disabled={resolverSubmitting}
                  >
                    Devolver a sucursal que envía
                  </button>
                  <button
                    type="button"
                    className={`transfer-issues__resolver-decision-btn transfer-issues__resolver-decision-btn--danger${
                      resolverDecision === 'perdido' ? ' is-active' : ''
                    }`}
                    onClick={() => {
                      setResolverDecision('perdido')
                      setResolverSubdivisionId('')
                    }}
                    disabled={resolverSubmitting}
                  >
                    Marcar perdido / robado
                  </button>
                </div>
              </div>

              {(resolverDecision === 'sumar_solicitante' || resolverDecision === 'sumar_proveedora') && (
                <label>
                  <span>Subdivision destino ({resolverTargetBranchLabel})</span>
                  <select
                    value={resolverSubdivisionId}
                    onChange={(event) => setResolverSubdivisionId(String(event.target.value || ''))}
                    disabled={resolverSubmitting || resolverSubdivisionsLoading}
                  >
                    <option value="">Selecciona subdivision</option>
                    {resolverSubdivisions.map((subdivision) => (
                      <option key={`resolver-subdivision-${subdivision.id}`} value={subdivision.id}>
                        {String(subdivision?.nombre || `Subdivision ${subdivision.id}`).trim()}
                      </option>
                    ))}
                  </select>
                  {resolverSubdivisionsLoading && (
                    <small className="transfer-issues__resolver-loading">
                      <Loader2 size={12} />
                      Cargando subdivisiones...
                    </small>
                  )}
                </label>
              )}

              <label>
                <span>Motivo / nota (opcional)</span>
                <textarea
                  rows={3}
                  value={resolverMotivo}
                  onChange={(event) => setResolverMotivo(String(event.target.value || ''))}
                  disabled={resolverSubmitting}
                />
              </label>

              {resolverError && (
                <p className="transfer-issues__resolver-error">{resolverError}</p>
              )}
            </div>

            <footer className="transfer-issues__resolver-actions">
              <button
                type="button"
                className="transfer-issues__resolver-btn transfer-issues__resolver-btn--ghost"
                onClick={closeResolver}
                disabled={resolverSubmitting}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="transfer-issues__resolver-btn transfer-issues__resolver-btn--primary"
                onClick={() => void submitResolver()}
                disabled={resolverSubmitting}
              >
                {resolverSubmitting ? 'Guardando...' : 'Confirmar resolucion'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  )
}

export default TrasladosInconvenientesTable
