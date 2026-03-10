import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw, Wrench, X } from 'lucide-react'
import { Toast } from 'primereact/toast'
import { API_URL, authFetch } from '../../../../utils/api'
import './RandomInspectionAdminTable.css'

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

const formatPercent = (value) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '0.0%'
  return `${numeric.toFixed(1)}%`
}

const formatReviewState = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'coincide') return 'Coincide'
  if (normalized === 'no_coincide') return 'No coincide'
  if (normalized === 'pendiente') return 'Pendiente'
  return '-'
}

const formatVerificationState = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'sin_novedad') return 'Sin novedad'
  if (normalized === 'pendiente') return 'Pendiente'
  if (normalized === 'aprobada') return 'Aprobada'
  if (normalized === 'rechazada') return 'Rechazada'
  return '-'
}

function RandomInspectionAdminTable({ token, moduleActions }) {
  const toast = useRef(null)
  const canRead = moduleActions?.puede_leer ?? true
  const canUpdate = moduleActions?.puede_actualizar ?? true

  const [summaryRows, setSummaryRows] = useState([])
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [selectedBranchId, setSelectedBranchId] = useState('')

  const [itemsRows, setItemsRows] = useState([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsFilter, setItemsFilter] = useState('pendiente')

  const [editingItem, setEditingItem] = useState(null)
  const [confirmedQty, setConfirmedQty] = useState('')
  const [verificationNote, setVerificationNote] = useState('')
  const [submitLoading, setSubmitLoading] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const notifyError = useCallback((detail) => {
    if (!detail) return
    toast.current?.show({
      severity: 'error',
      summary: 'Error',
      detail,
      life: 3500,
    })
  }, [])

  const notifySuccess = useCallback((detail) => {
    if (!detail) return
    toast.current?.show({
      severity: 'success',
      summary: 'Listo',
      detail,
      life: 2600,
    })
  }, [])

  const loadSummary = useCallback(async () => {
    if (!token || !canRead) {
      setSummaryRows([])
      setSelectedBranchId('')
      return []
    }

    setSummaryLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/admin/resumen/`,
        {},
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudo cargar el resumen por sucursal.')
      }
      const rows = parseApiList(payload)
      setSummaryRows(rows)
      setSelectedBranchId((current) => {
        const currentId = normalizeId(current)
        if (currentId && rows.some((row) => normalizeId(row?.sucursal_id) === currentId)) {
          return currentId
        }
        return normalizeId(rows?.[0]?.sucursal_id)
      })
      return rows
    } catch (error) {
      setSummaryRows([])
      setSelectedBranchId('')
      notifyError(error?.message || 'No se pudo cargar el resumen por sucursal.')
      return []
    } finally {
      setSummaryLoading(false)
    }
  }, [canRead, notifyError, token])

  const loadItems = useCallback(async () => {
    const branchId = normalizeId(selectedBranchId)
    if (!token || !canRead || !branchId) {
      setItemsRows([])
      return []
    }

    setItemsLoading(true)
    try {
      const endpoint = new URL(`${API_URL}/recordatorios/inspeccion-aleatoria/admin/items/`)
      endpoint.searchParams.set('sucursal_id', branchId)
      endpoint.searchParams.set('estado', itemsFilter)
      endpoint.searchParams.set('limit', '300')

      const response = await authFetch(endpoint.toString(), {}, token)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudieron cargar las diferencias.')
      }
      const rows = parseApiList(payload)
      setItemsRows(rows)
      return rows
    } catch (error) {
      setItemsRows([])
      notifyError(error?.message || 'No se pudieron cargar las diferencias.')
      return []
    } finally {
      setItemsLoading(false)
    }
  }, [canRead, itemsFilter, notifyError, selectedBranchId, token])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  useEffect(() => {
    void loadItems()
  }, [loadItems])

  const selectedBranch = useMemo(() => (
    summaryRows.find((row) => normalizeId(row?.sucursal_id) === normalizeId(selectedBranchId)) || null
  ), [selectedBranchId, summaryRows])

  const closeEditDialog = useCallback(() => {
    setEditingItem(null)
    setConfirmedQty('')
    setVerificationNote('')
    setSubmitError('')
    setSubmitLoading(false)
  }, [])

  const openEditDialog = useCallback((row) => {
    setEditingItem(row || null)
    const fallback = row?.cantidad_reportada ?? row?.cantidad_esperada ?? 0
    setConfirmedQty(String(Math.max(0, Number.parseInt(String(fallback || 0), 10) || 0)))
    setVerificationNote('')
    setSubmitError('')
    setSubmitLoading(false)
  }, [])

  const submitVerification = useCallback(async () => {
    if (!token || !editingItem) return

    const nextQty = Number.parseInt(String(confirmedQty || '').trim(), 10)
    if (!Number.isFinite(nextQty) || nextQty < 0) {
      setSubmitError('Debes ingresar una cantidad valida mayor o igual a cero.')
      return
    }

    setSubmitError('')
    setSubmitLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/items/${encodeURIComponent(
          normalizeId(editingItem?.id)
        )}/verificar/`,
        {
          method: 'POST',
          body: JSON.stringify({
            accion: 'aprobar',
            cantidad_confirmada: nextQty,
            nota: String(verificationNote || '').trim(),
          }),
        },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar la verificacion.')
      }

      notifySuccess('Cantidad confirmada y ajuste aplicado.')
      closeEditDialog()
      await Promise.all([loadSummary(), loadItems()])
    } catch (error) {
      setSubmitError(error?.message || 'No se pudo guardar la verificacion.')
    } finally {
      setSubmitLoading(false)
    }
  }, [closeEditDialog, confirmedQty, editingItem, loadItems, loadSummary, notifySuccess, token, verificationNote])

  if (!canRead) {
    return (
      <section className="inspection-admin">
        <p className="inspection-admin__empty">No tienes permisos para acceder a esta seccion.</p>
      </section>
    )
  }

  return (
    <section className="inspection-admin">
      <Toast ref={toast} />

      <header className="inspection-admin__head">
        <div>
          <h3>Revision de inventario por sucursal</h3>
          <p>Consulta cobertura de inspecciones y corrige cantidades reales reportadas.</p>
        </div>
        <button
          type="button"
          className="inspection-admin__refresh"
          onClick={() => {
            void loadSummary()
            void loadItems()
          }}
          disabled={summaryLoading || itemsLoading}
          aria-label="Actualizar resumen de inspecciones"
        >
          <RefreshCw size={14} />
          Actualizar
        </button>
      </header>

      <div className="inspection-admin__block">
        <h4>Sucursales</h4>
        <div className="inspection-admin__table-wrap">
          <table className="inspection-admin__table">
            <thead>
              <tr>
                <th>Sucursal</th>
                <th>Productos inventario</th>
                <th>Productos revisados</th>
                <th>Cobertura</th>
                <th>Diferencias</th>
                <th>Pendientes verificacion</th>
                <th>Ultima revision</th>
              </tr>
            </thead>
            <tbody>
              {!summaryRows.length ? (
                <tr className="inspection-admin__empty-row">
                  <td colSpan={7} />
                </tr>
              ) : summaryRows.map((row) => {
                const rowId = normalizeId(row?.sucursal_id)
                const selected = rowId && rowId === normalizeId(selectedBranchId)
                return (
                  <tr
                    key={`inspection-branch-${rowId}`}
                    className={`inspection-admin__summary-row${selected ? ' is-selected' : ''}`}
                    onClick={() => setSelectedBranchId(rowId)}
                  >
                    <td>{String(row?.sucursal_nombre || `Sucursal ${row?.sucursal_id || '-'}`).trim()}</td>
                    <td>{Number.parseInt(String(row?.total_productos_inventario || 0), 10) || 0}</td>
                    <td>{Number.parseInt(String(row?.productos_revisados || 0), 10) || 0}</td>
                    <td>{formatPercent(row?.cobertura_porcentaje)}</td>
                    <td>{Number.parseInt(String(row?.diferencias_reportadas || 0), 10) || 0}</td>
                    <td>{Number.parseInt(String(row?.pendientes_verificacion || 0), 10) || 0}</td>
                    <td>{formatDateTime(row?.ultima_revision)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {summaryLoading && (
            <p className="inspection-admin__loading">
              <Loader2 size={14} />
              Cargando resumen...
            </p>
          )}
        </div>
      </div>

      <div className="inspection-admin__block">
        <div className="inspection-admin__subhead">
          <h4>
            Diferencias reportadas
            {selectedBranch ? ` - ${String(selectedBranch?.sucursal_nombre || '').trim()}` : ''}
          </h4>
          <select
            value={itemsFilter}
            onChange={(event) => setItemsFilter(String(event.target.value || 'pendiente'))}
            disabled={itemsLoading}
          >
            <option value="pendiente">Pendientes</option>
            <option value="diferencias">Con diferencia</option>
            <option value="verificado">Verificadas</option>
            <option value="todos">Todas</option>
          </select>
        </div>

        <div className="inspection-admin__table-wrap">
          <table className="inspection-admin__table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Producto</th>
                <th>Esperada</th>
                <th>Reportada</th>
                <th>Confirmada</th>
                <th>Revision</th>
                <th>Verificacion</th>
                <th>Inspeccion de</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {!itemsRows.length ? (
                <tr className="inspection-admin__empty-row">
                  <td colSpan={9} />
                </tr>
              ) : itemsRows.map((row) => {
                const canFix = (
                  canUpdate &&
                  String(row?.estado_revision || '').trim().toLowerCase() === 'no_coincide' &&
                  String(row?.verificacion_estado || '').trim().toLowerCase() === 'pendiente'
                )
                return (
                  <tr key={`inspection-item-${normalizeId(row?.id)}`}>
                    <td>{formatDateTime(row?.revisado_en || row?.fecha_programada)}</td>
                    <td>
                      <div className="inspection-admin__product-cell">
                        <strong>{String(row?.producto_codigo || '').trim() || `#${row?.producto_id || '-'}`}</strong>
                        <span>{String(row?.producto_nombre || 'Producto').trim()}</span>
                      </div>
                    </td>
                    <td>{Number.parseInt(String(row?.cantidad_esperada || 0), 10) || 0}</td>
                    <td>{row?.cantidad_reportada == null ? '-' : Number.parseInt(String(row?.cantidad_reportada || 0), 10) || 0}</td>
                    <td>{row?.cantidad_confirmada == null ? '-' : Number.parseInt(String(row?.cantidad_confirmada || 0), 10) || 0}</td>
                    <td>{formatReviewState(row?.estado_revision)}</td>
                    <td>{formatVerificationState(row?.verificacion_estado)}</td>
                    <td>{String(row?.inspeccion_usuario_nombre || '-').trim() || '-'}</td>
                    <td>
                      {canFix ? (
                        <button
                          type="button"
                          className="inspection-admin__action"
                          onClick={() => openEditDialog(row)}
                        >
                          <Wrench size={13} />
                          Ajustar cantidad
                        </button>
                      ) : (
                        <span className="inspection-admin__action-placeholder">Sin accion</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {itemsLoading && (
            <p className="inspection-admin__loading">
              <Loader2 size={14} />
              Cargando diferencias...
            </p>
          )}
        </div>
      </div>

      {editingItem && (
        <div className="inspection-admin__dialog-overlay" onMouseDown={closeEditDialog}>
          <div
            className="inspection-admin__dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Ajustar cantidad real"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="inspection-admin__dialog-head">
              <div>
                <h4>Ajustar cantidad real</h4>
                <p>
                  {String(editingItem?.producto_codigo || '').trim() || '#'} - {String(editingItem?.producto_nombre || '').trim()}
                </p>
              </div>
              <button
                type="button"
                className="inspection-admin__dialog-close"
                onClick={closeEditDialog}
                disabled={submitLoading}
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </header>

            <div className="inspection-admin__dialog-body">
              <div className="inspection-admin__dialog-grid">
                <label>
                  <span>Cantidad esperada</span>
                  <input type="number" value={Number.parseInt(String(editingItem?.cantidad_esperada || 0), 10) || 0} disabled />
                </label>
                <label>
                  <span>Cantidad reportada</span>
                  <input
                    type="number"
                    value={editingItem?.cantidad_reportada == null ? 0 : Number.parseInt(String(editingItem?.cantidad_reportada || 0), 10) || 0}
                    disabled
                  />
                </label>
              </div>

              <label>
                <span>Cantidad real confirmada</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={confirmedQty}
                  onChange={(event) => setConfirmedQty(String(event.target.value || '0'))}
                  disabled={submitLoading}
                />
              </label>

              <label>
                <span>Nota (opcional)</span>
                <textarea
                  rows={3}
                  value={verificationNote}
                  onChange={(event) => setVerificationNote(String(event.target.value || ''))}
                  placeholder="Observacion de verificacion"
                  disabled={submitLoading}
                />
              </label>

              {submitError && <p className="inspection-admin__dialog-error">{submitError}</p>}
            </div>

            <footer className="inspection-admin__dialog-actions">
              <button
                type="button"
                className="inspection-admin__btn inspection-admin__btn--ghost"
                onClick={closeEditDialog}
                disabled={submitLoading}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="inspection-admin__btn inspection-admin__btn--primary"
                onClick={() => void submitVerification()}
                disabled={submitLoading}
              >
                {submitLoading ? 'Guardando...' : 'Guardar cantidad'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  )
}

export default RandomInspectionAdminTable
