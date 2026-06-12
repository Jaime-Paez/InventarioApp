import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import StaticFieldDisplay from '../movimientos/StaticFieldDisplay'
import { FilterMatchMode } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Button } from 'primereact/button'
import { Info, PackagePlus, Plus, Search, Trash2, X } from 'lucide-react'
import { Checkbox } from 'primereact/checkbox'
import { API_URL, authFetch } from '../../../utils/api'
import { autoFitTableColumns, clearSavedColumnWidths } from '../../../utils/autoFitColumns'
import { buildFileName, exportToExcel, exportToPdf } from '../../../utils/exportUtils'
import '../admin/CreateUsuario/CreateUsuario.css'
import '../admin/UsersDetails/UsersDetails.css'
import '../admin/UsersTable/UsersTable.css'
import '../movimientos/CreateSalida.css'
import '../QuickActions/QuickActions.css'
import './ImportacionesTable.css'

const getPortalRoot = () => document.querySelector('.dashboard-shell') || getPortalRoot()

const STATUS_CONFIG = {
  borrador: { label: 'Borrador', empty: 'No hay importaciones en borrador.' },
  en_camino: { label: 'En camino', empty: 'No hay importaciones en camino.' },
  importada: { label: 'Importadas', empty: 'No hay importaciones importadas.' },
}

const IMP_HOVER_WIDTH = 560
const IMP_HOVER_MARGIN = 12

const STATUS_BADGE = {
  borrador: { label: 'Borrador', color: '#64748b', bg: 'rgba(100,116,139,0.1)' },
  en_camino: { label: 'En camino', color: '#d97706', bg: 'rgba(217,119,6,0.1)' },
  importada: { label: 'Importada', color: '#16a34a', bg: 'rgba(22,163,74,0.1)' },
}

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])

const todayISO = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const formatDate = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return '-'
  const [year, month, day] = raw.split('-').map(Number)
  if (!year || !month || !day) return raw
  return new Intl.DateTimeFormat('es-EC', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(year, month - 1, day))
}

const readErrorMessage = async (response, fallback) => {
  const payload = await response.json().catch(() => null)
  const visit = (value) => {
    if (!value) return ''
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(visit).find(Boolean) || ''
    if (typeof value === 'object') return Object.values(value).map(visit).find(Boolean) || ''
    return ''
  }
  return visit(payload?.detail) || visit(payload) || fallback
}

const getFlagUrl = (code) => {
  if (!code) return ''
  const clean = String(code).trim().toLowerCase()
  if (clean.length !== 2) return ''
  return `https://flagsapi.com/${clean.toUpperCase()}/flat/64.png`
}

const formatCasaLabel = (casa) => {
  if (!casa) return ''
  const codigo = String(casa?.codigo || '').trim()
  const nombre = String(casa?.nombre || '').trim()
  return [codigo, nombre].filter(Boolean).join(' - ')
}

const formatProductLabel = (product) => {
  if (!product) return ''
  const codigo = String(product?.codigo || '').trim()
  const nombre = String(product?.nombre || '').trim()
  const referencia = String(product?.referencia || '').trim()
  return [codigo, nombre, referencia ? `Ref. ${referencia}` : ''].filter(Boolean).join(' - ')
}

const MIN_WIDTH = 700
const MIN_HEIGHT = 520
const SELECTOR_WIDTH = 520
const SELECTOR_HEIGHT_EMPTY = 'auto'
const SELECTOR_HEIGHT_FULL = 'auto'
const VIEWPORT_PADDING = 12
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

function ImportacionReceiveModal({ imp, token, onClose, onConfirmed }) {
  const isDark = Boolean(document.querySelector('.dashboard-shell')?.classList.contains('dark'))
  const mode = isDark ? 'dark' : 'light'
  const toastRef = useRef(null)

  const storageKey = `imp-receive-${imp.id}`
  // IDs de ítems que eran sinCat al abrir el modal (fijo, no cambia con el fetch fresco)
  const [originalSinCatIds] = useState(() =>
    new Set((imp.detalles || []).filter(d => !d.producto?.id).map(d => d.id))
  )

  const [rows, setRows] = useState(() => {
    const saved = JSON.parse(localStorage.getItem(`imp-receive-${imp.id}`) || 'null')
    const checkedIds = new Set(saved?.checkedIds || [])
    return (imp.detalles || []).map(d => ({
      id: d.id,
      codigo: d.producto?.codigo || d.codigo || '',
      nombre: d.producto?.nombre || d.nombre || '',
      oem: d.producto?.oem || d.oem || '',
      cantidad: d.cantidad,
      sinCat: !d.producto?.id,
      checked: checkedIds.has(d.id),
      newProducto: null,
    }))
  })
  const [filter, setFilter] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showErrors, setShowErrors] = useState(false)

  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({ codigo: '', nombre: '', precio: '', costo_minimo: '', descripcion: '' })
  const [formErrors, setFormErrors] = useState({})
  const [formSaving, setFormSaving] = useState(false)
  const [loadingData, setLoadingData] = useState(true)
  const [step, setStep] = useState(1)
  const [sucursales, setSucursales] = useState([])
  const [loadingSucursales, setLoadingSucursales] = useState(false)
  const [distribution, setDistribution] = useState({})

  // Fetch fresh importacion data on mount so already-linked products are reflected
  useEffect(() => {
    authFetch(`${API_URL}/importaciones/importaciones/${imp.id}/`, {}, token)
      .then(r => r.ok ? r.json() : null)
      .then(fresh => {
        if (!fresh?.detalles) return
        const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
        const checkedIds = new Set(saved?.checkedIds || [])
        setRows(fresh.detalles.map(d => ({
          id: d.id,
          codigo: d.producto?.codigo || d.codigo || '',
          nombre: d.producto?.nombre || d.nombre || '',
          oem: d.producto?.oem || d.oem || '',
          cantidad: d.cantidad,
          sinCat: !d.producto?.id,
          checked: checkedIds.has(d.id),
          newProducto: null,
        })))
      })
      .catch(() => {})
      .finally(() => setLoadingData(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const checkedIds = rows.filter(r => r.checked).map(r => r.id)
    localStorage.setItem(storageKey, JSON.stringify({ checkedIds }))
  }, [rows, storageKey])

  const toggleRow = useCallback((id) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, checked: !r.checked } : r))
  }, [])
  const toggleAll = useCallback((checked) => {
    setRows(prev => prev.map(r => ({ ...r, checked })))
  }, [])

  const filteredRows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => [r.codigo, r.nombre, r.oem].some(v => String(v || '').toLowerCase().includes(q)))
  }, [rows, filter])

  const checkedCount = rows.filter(r => r.checked).length
  const allChecked = checkedCount === rows.length && rows.length > 0
  const someChecked = checkedCount > 0 && checkedCount < rows.length
  const sinCatRows = rows.filter(r => r.sinCat)
  const sinCatFilled = sinCatRows.filter(r => r.newProducto !== null).length
  const canConfirm = allChecked && sinCatFilled === sinCatRows.length
  // Todos los ítems que originalmente no tenían producto (incluye los ya vinculados en sesiones anteriores)
  const step1Rows = rows.filter(r => originalSinCatIds.has(r.id))
  const step1Pending = step1Rows.filter(r => r.sinCat && !r.newProducto)
  const canGoNext = step1Pending.length === 0
  const canFinish = !loadingSucursales && sucursales.length > 0 && rows.every(row => {
    const assigned = Object.values(distribution[row.id] || {}).reduce((s, v) => s + (parseInt(v) || 0), 0)
    return assigned === row.cantidad
  })

  const openProductForm = (row) => {
    setEditingId(row.id)
    setForm({ codigo: row.codigo || '', nombre: row.nombre || '', precio: '', costo_minimo: '', descripcion: '' })
    setFormErrors({})
  }

  const saveProductForm = async () => {
    const errs = {}
    if (!form.codigo.trim()) errs.codigo = 'Requerido'
    if (!form.nombre.trim()) errs.nombre = 'Requerido'
    if (!form.precio || isNaN(parseFloat(form.precio))) errs.precio = 'Requerido'
    if (Object.keys(errs).length) { setFormErrors(errs); return }
    const casaId = imp.casa_comercial?.id
    if (!casaId) { setFormErrors({ _general: 'La importación no tiene casa comercial asignada.' }); return }

    setFormSaving(true)
    try {
      const payload = {
        codigo: form.codigo.trim(),
        nombre: form.nombre.trim(),
        precio: parseFloat(form.precio),
        casas_comerciales_ids: [casaId],
      }
      if (form.costo_minimo) payload.costo_minimo = parseFloat(form.costo_minimo)
      if (form.descripcion.trim()) payload.descripcion = form.descripcion.trim()

      const resp = await authFetch(`${API_URL}/productos/listado/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, token)
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}))
        // Si el código ya existe, buscar el producto y linkarlo en vez de fallar
        const codigoErr = Array.isArray(data?.codigo) ? data.codigo.join(' ') : String(data?.codigo || '')
        if (codigoErr.toLowerCase().includes('ya existe')) {
          try {
            const searchResp = await authFetch(`${API_URL}/productos/listado/?search=${encodeURIComponent(form.codigo.trim())}`, {}, token)
            if (searchResp.ok) {
              const searchData = await searchResp.json()
              const results = searchData?.results ?? searchData ?? []
              const existing = Array.isArray(results) && results.find(p => p.codigo?.toLowerCase() === form.codigo.trim().toLowerCase())
              if (existing) {
                await authFetch(
                  `${API_URL}/importaciones/importaciones/${imp.id}/detalles/${editingId}/`,
                  { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ producto_id: existing.id }) },
                  token
                )
                setRows(prev => prev.map(r => r.id === editingId ? { ...r, newProducto: existing } : r))
                setEditingId(null)
                return
              }
            }
          } catch {}
        }
        const fe = {}
        Object.entries(typeof data === 'object' && data !== null ? data : {}).forEach(([k, v]) => {
          fe[k] = Array.isArray(v) ? v.join(' ') : String(v)
        })
        setFormErrors(Object.keys(fe).length ? fe : { _general: 'Error al crear el producto.' })
        return
      }
      const created = await resp.json()
      // Persist the product link on the detalle so progress survives modal close/reopen
      authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/detalles/${editingId}/`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ producto_id: created.id }) },
        token
      ).catch(() => {})
      setRows(prev => prev.map(r => r.id === editingId ? { ...r, newProducto: created } : r))
      setEditingId(null)
    } catch (e) {
      setFormErrors({ _general: e.message || 'Error al crear el producto.' })
    } finally {
      setFormSaving(false)
    }
  }

  const enterStep3 = async () => {
    setStep(3)
    setLoadingSucursales(true)
    try {
      const resp = await authFetch(`${API_URL}/inventario/sucursales/?modulo=movimientos_entradas`, {}, token)
      const data = resp.ok ? await resp.json() : []
      const list = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : []
      setSucursales(list)
      setDistribution(prev => {
        const next = {}
        rows.forEach(row => {
          next[row.id] = {}
          list.forEach(suc => { next[row.id][suc.id] = prev[row.id]?.[suc.id] ?? '' })
        })
        return next
      })
    } catch {
      setSucursales([])
    } finally {
      setLoadingSucursales(false)
    }
  }

  const handleConfirm = async () => {
    if (!canFinish) { setShowErrors(true); return }
    setSubmitting(true)
    try {
      const distribuciones = rows.flatMap(row =>
        Object.entries(distribution[row.id] || {})
          .filter(([, v]) => parseInt(v) > 0)
          .map(([sucursalId, qty]) => ({ detalle_id: row.id, sucursal_id: parseInt(sucursalId), cantidad: parseInt(qty) }))
      )
      const resp = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/marcar-llegada/`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ distribuciones }) },
        token
      )
      if (!resp.ok) throw new Error(await readErrorMessage(resp, 'No se pudo marcar la llegada.'))
      localStorage.removeItem(storageKey)
      onConfirmed?.(await resp.json())
    } catch (e) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: e.message, life: 4000 })
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <>
      <Toast ref={toastRef} />
      <div
        className={`quick-actions__receive-overlay ${mode}`}
        style={{ zIndex: 2100 }}
        onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) onClose() }}
      >
        <div
          className={`quick-actions__receive-dialog ${mode}`}
          style={{ width: 'min(640px, 90vw)', gridTemplateRows: 'auto 1fr auto' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="quick-actions__receive-head">
            <div>
              <h4>{imp.codigo}</h4>
              <p>{imp.casa_comercial?.nombre || '-'} · Recepción de productos</p>
            </div>
            <button type="button" className="quick-actions__receive-close" onClick={onClose} disabled={submitting}>
              <X size={16} />
            </button>
          </header>

          {/* Step indicator */}
          {!loadingData && (
            <div style={{ padding: '12px 20px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 5 }}>
                {[1,2,3].map(n => (
                  <div key={n} style={{ flex: 1, height: 3, borderRadius: 2, background: step >= n ? 'var(--color-primary, #2563eb)' : 'var(--color-border, #e2e8f0)', transition: 'background .3s' }} />
                ))}
              </div>
              <span style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
                Paso {step} de 3 — {step === 1 ? 'Productos nuevos' : step === 2 ? 'Revisión de llegada' : 'Distribución a sucursales'}
              </span>
            </div>
          )}

          <div className="quick-actions__receive-body">
            {loadingData ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 12 }}>
                <svg style={{ animation: 'spin 0.8s linear infinite', width: 22, height: 22, flexShrink: 0 }} viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                </svg>
                <span style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>Cargando productos...</span>
              </div>
            ) : step === 1 ? (
              /* ── PASO 1: registrar productos sin catálogo ── */
              <div className="quick-actions__receive-step quick-actions__receive-step--list" style={{ '--receive-list-received-column': '0px' }}>
                <article className="quick-actions__receive-stage quick-actions__receive-stage--list">
                  <div className="quick-actions__receive-stage-copy">
                    <p className="quick-actions__receive-stage-kicker">Paso 1 — Productos nuevos</p>
                    <h5>Registra los productos que no están en el catálogo</h5>
                    <p className="quick-actions__receive-stage-name">
                      Estos ítems llegaron en esta importación pero aún no tienen un producto asignado. Completa sus datos antes de continuar.
                    </p>
                  </div>
                  {step1Rows.length > 0 && (
                    <div className="quick-actions__receive-stage-stats" style={{ marginTop: 10 }}>
                      <span className="quick-actions__receive-stage-stat">Pendientes <strong>{step1Pending.length}</strong></span>
                      <span className="quick-actions__receive-stage-stat">Completados <strong>{step1Rows.length - step1Pending.length}</strong></span>
                    </div>
                  )}
                </article>

                {step1Rows.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '40px 20px', textAlign: 'center' }}>
                    <svg viewBox="0 0 24 24" fill="none" style={{ width: 40, height: 40, color: 'var(--color-success, #16a34a)' }}>
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M7.5 12l3 3 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <p style={{ fontWeight: 600, fontSize: '0.95rem' }}>Todos los productos ya están en el catálogo</p>
                    <p style={{ fontSize: '0.82rem', color: 'var(--color-text-secondary)' }}>Puedes continuar al siguiente paso.</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 16px 8px' }}>
                    {step1Rows.map(row => {
                      const isDone = !row.sinCat || row.newProducto
                      const productCode = row.newProducto?.codigo || (!row.sinCat ? row.codigo : null)
                      return (
                        <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: isDone ? 'var(--color-success-bg, #f0fdf4)' : 'var(--color-surface, #f8fafc)', border: `1px solid ${isDone ? 'var(--color-success-border, #bbf7d0)' : 'var(--color-border, #e2e8f0)'}`, borderRadius: 10, padding: '10px 14px', transition: 'background .2s, border-color .2s' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.nombre || row.codigo || '-'}</div>
                            {row.nombre && row.codigo && <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>{row.codigo}</div>}
                          </div>
                          {isDone ? (
                            <span style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--color-success, #16a34a)', whiteSpace: 'nowrap' }}>
                              {productCode}
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="quick-actions__receive-btn quick-actions__receive-btn--primary"
                              style={{ fontSize: '0.8rem', minHeight: 30, padding: '0 12px', whiteSpace: 'nowrap', flexShrink: 0 }}
                              onClick={() => openProductForm(row)}
                            >
                              Completar datos
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ) : step === 2 ? (
              /* ── PASO 2: verificar cantidades recibidas ── */
              <div
                className="quick-actions__receive-step quick-actions__receive-step--list"
                style={{ '--receive-list-locations-column': 'minmax(120px, 1.1fr)', '--receive-list-received-column': '0px' }}
              >
                <article className="quick-actions__receive-stage quick-actions__receive-stage--list">
                  <div className="quick-actions__receive-stage-head">
                    <div className="quick-actions__receive-stage-copy">
                      <p className="quick-actions__receive-stage-kicker">Paso 2 — Revisión de llegada</p>
                      <h5>Confirma los productos recibidos</h5>
                      <p className="quick-actions__receive-stage-name">Marca cada producto cuando confirmes físicamente haberlo recibido.</p>
                    </div>
                    <div className="quick-actions__receive-stage-toolbar">
                      <label className="quick-actions__receive-check quick-actions__receive-check--bulk">
                        <input type="checkbox" checked={allChecked} ref={(el) => { if (el) el.indeterminate = someChecked }} onChange={(e) => toggleAll(e.target.checked)} />
                        <span>Marcar todo</span>
                      </label>
                    </div>
                  </div>
                  <div className="quick-actions__receive-stage-meta quick-actions__receive-stage-meta--split">
                    {imp.casa_comercial?.nombre && (
                      <div className="quick-actions__receive-stage-meta-block">
                        <small className="quick-actions__receive-destination-label">Casa comercial</small>
                        <strong>{imp.casa_comercial.nombre}</strong>
                      </div>
                    )}
                    <div className="quick-actions__receive-stage-stats">
                      <span className="quick-actions__receive-stage-stat">Productos <strong>{rows.length}</strong></span>
                      <span className="quick-actions__receive-stage-stat">Revisados <strong>{checkedCount}</strong></span>
                    </div>
                  </div>
                </article>

                <div className="quick-actions__receive-search-bar">
                  <div className="quick-actions__receive-search">
                    <input type="text" placeholder="Buscar por código o nombre..." value={filter} onChange={(e) => setFilter(e.target.value)} />
                    {filter && <button type="button" className="quick-actions__receive-search-clear" onClick={() => setFilter('')}>×</button>}
                  </div>
                </div>

                <div className="quick-actions__receive-list">
                  {filteredRows.map((row) => {
                    const hasError = showErrors && !row.checked
                    return (
                      <article key={row.id} className={`quick-actions__receive-item${row.checked ? ' is-reviewed is-ready' : ' is-pending'}${hasError ? ' has-validation-error' : ''}`}>
                        <div className="quick-actions__receive-item-head quick-actions__receive-item-head--check">
                          <label className="quick-actions__receive-check quick-actions__receive-check--row">
                            <Checkbox binary checked={row.checked} onChange={() => toggleRow(row.id)} disabled={submitting} />
                          </label>
                          <div className="quick-actions__receive-item-title">
                            <small className="quick-actions__receive-col-label">Producto</small>
                            <strong>{row.codigo || '-'}</strong>
                            {row.nombre && <p className="quick-actions__receive-item-name">{row.nombre}</p>}
                          </div>
                        </div>
                        <div className="quick-actions__receive-location-row quick-actions__receive-location-row--review" style={{ gridTemplateColumns: '1fr', alignSelf: 'start', paddingTop: 2 }}>
                          <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', display: 'block', paddingTop: 6 }}>
                            {row.newProducto?.codigo || row.oem || '—'}
                          </span>
                        </div>
                        <div className="quick-actions__receive-item-meta">
                          <span>Cantidad<strong>{row.cantidad}</strong></span>
                        </div>
                        {hasError && (
                          <p className="quick-actions__receive-item-hint quick-actions__receive-item-hint--warning">Confirma haber revisado este producto.</p>
                        )}
                      </article>
                    )
                  })}
                </div>
              </div>
            ) : (
              /* ── PASO 3: distribución a sucursales ── */
              <div className="quick-actions__receive-step quick-actions__receive-step--list" style={{ '--receive-list-received-column': '0px' }}>
                <article className="quick-actions__receive-stage quick-actions__receive-stage--list">
                  <div className="quick-actions__receive-stage-copy">
                    <p className="quick-actions__receive-stage-kicker">Paso 3 — Distribución</p>
                    <h5>Envía los productos a las sucursales</h5>
                    <p className="quick-actions__receive-stage-name">Indica cuántas unidades de cada producto van a cada sucursal. El total debe coincidir con la cantidad recibida.</p>
                  </div>
                  {!loadingSucursales && sucursales.length > 0 && (
                    <div className="quick-actions__receive-stage-stats" style={{ marginTop: 10 }}>
                      <span className="quick-actions__receive-stage-stat">Productos <strong>{rows.length}</strong></span>
                      <span className="quick-actions__receive-stage-stat">Listos <strong>{rows.filter(row => Object.values(distribution[row.id] || {}).reduce((s, v) => s + (parseInt(v) || 0), 0) === row.cantidad).length}</strong></span>
                    </div>
                  )}
                </article>

                {loadingSucursales ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0', gap: 12 }}>
                    <svg style={{ animation: 'spin 0.8s linear infinite', width: 20, height: 20, flexShrink: 0 }} viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Cargando sucursales...</span>
                  </div>
                ) : sucursales.length === 0 ? (
                  <div style={{ padding: '32px 20px', textAlign: 'center' }}>
                    <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>No hay sucursales disponibles.</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 16px 8px' }}>
                    {rows.map(row => {
                      const rowDist = distribution[row.id] || {}
                      const assigned = Object.values(rowDist).reduce((s, v) => s + (parseInt(v) || 0), 0)
                      const isComplete = assigned === row.cantidad
                      const isOver = assigned > row.cantidad
                      return (
                        <div key={row.id} style={{ background: isComplete ? 'var(--color-success-bg, #f0fdf4)' : 'var(--color-surface, #f8fafc)', border: `1px solid ${isOver ? '#fca5a5' : isComplete ? 'var(--color-success-border, #bbf7d0)' : 'var(--color-border, #e2e8f0)'}`, borderRadius: 10, padding: '12px 14px', transition: 'background .2s, border-color .2s' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontWeight: 600, fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.nombre || row.codigo || '-'}</div>
                              {row.nombre && row.codigo && <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>{row.codigo}</div>}
                            </div>
                            <span style={{ fontSize: '0.82rem', fontWeight: 700, marginLeft: 12, flexShrink: 0, color: isOver ? '#dc2626' : isComplete ? 'var(--color-success, #16a34a)' : 'var(--color-text-secondary)' }}>
                              {assigned}/{row.cantidad}
                            </span>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {sucursales.map(suc => (
                              <label key={suc.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ flex: 1, fontSize: '0.8rem', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{suc.nombre}</span>
                                <input
                                  type="number" min="0" max={row.cantidad}
                                  value={rowDist[suc.id] ?? ''}
                                  onChange={(e) => setDistribution(prev => ({ ...prev, [row.id]: { ...(prev[row.id] || {}), [suc.id]: e.target.value } }))}
                                  style={{ width: 70, textAlign: 'center', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 6, padding: '4px 8px', fontSize: '0.85rem', background: 'var(--modal-color, #fff)', color: 'inherit' }}
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          <footer className="quick-actions__receive-actions">
            {step === 1 ? (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={onClose}>Cancelar</button>
                <button type="button" className={`quick-actions__receive-btn${canGoNext ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`} onClick={() => setStep(2)} disabled={loadingData || !canGoNext}>Siguiente</button>
              </>
            ) : step === 2 ? (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep(1)}>Atrás</button>
                <button type="button" className={`quick-actions__receive-btn${allChecked ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`} onClick={enterStep3} disabled={!allChecked}>Siguiente</button>
              </>
            ) : (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep(2)} disabled={submitting}>Atrás</button>
                <button type="button" className={`quick-actions__receive-btn${canFinish ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`} onClick={handleConfirm} disabled={submitting || !canFinish}>
                  {submitting ? 'Confirmando...' : 'Confirmar llegada'}
                </button>
              </>
            )}
          </footer>
        </div>
      </div>

      {editingId !== null && (() => {
        const row = rows.find(r => r.id === editingId)
        return createPortal(
          <div
            className={`quick-actions__receive-overlay ${mode}`}
            style={{ zIndex: 2200 }}
            onMouseDown={(e) => { if (e.target === e.currentTarget && !formSaving) setEditingId(null) }}
          >
            <div
              className={`quick-actions__receive-dialog ${mode}`}
              style={{ width: 'min(520px, 90vw)', height: 'auto', maxHeight: '90vh', gridTemplateRows: 'auto 1fr auto' }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <header className="quick-actions__receive-head">
                <div>
                  <h4>Completar datos del producto</h4>
                  <p>{row?.nombre || row?.codigo || 'Sin catálogo'}</p>
                </div>
                <button type="button" className="quick-actions__receive-close" onClick={() => setEditingId(null)} disabled={formSaving}>
                  <X size={16} />
                </button>
              </header>

              <div className="quick-actions__receive-body" style={{ padding: '16px 20px' }}>
                {formErrors._general && (
                  <p style={{ color: '#dc2626', fontSize: '0.875rem', marginBottom: 12 }}>{formErrors._general}</p>
                )}
                <div className="create-user__grid create-user__grid--two">
                  <label className={`create-user__field create-user__field--required${formErrors.nombre ? ' create-user__field--invalid' : ''}`}>
                    <span>Nombre</span>
                    <input type="text" value={form.nombre} onChange={(e) => setForm(f => ({ ...f, nombre: e.target.value }))} />
                    {formErrors.nombre && <small style={{ color: '#dc2626' }}>{formErrors.nombre}</small>}
                  </label>
                  <label className={`create-user__field create-user__field--required${formErrors.codigo ? ' create-user__field--invalid' : ''}`}>
                    <span>Código JP</span>
                    <input type="text" value={form.codigo} onChange={(e) => setForm(f => ({ ...f, codigo: e.target.value }))} />
                    {formErrors.codigo && <small style={{ color: '#dc2626' }}>{formErrors.codigo}</small>}
                  </label>
                  <label className={`create-user__field create-user__field--required${formErrors.precio ? ' create-user__field--invalid' : ''}`}>
                    <span>Precio</span>
                    <input type="number" min="0" step="0.01" placeholder="0.00" value={form.precio} onChange={(e) => setForm(f => ({ ...f, precio: e.target.value }))} />
                    {formErrors.precio && <small style={{ color: '#dc2626' }}>{formErrors.precio}</small>}
                  </label>
                  <label className="create-user__field">
                    <span>Costo mínimo</span>
                    <input type="number" min="0" step="0.01" placeholder="0.00" value={form.costo_minimo} onChange={(e) => setForm(f => ({ ...f, costo_minimo: e.target.value }))} />
                  </label>
                  <label className="create-user__field create-user__field--full">
                    <span>Descripción</span>
                    <input type="text" placeholder="Opcional" value={form.descripcion} onChange={(e) => setForm(f => ({ ...f, descripcion: e.target.value }))} />
                  </label>
                </div>
                {imp.casa_comercial && (
                  <p style={{ fontSize: '0.8rem', color: 'var(--color-muted,#64748b)', marginTop: 14 }}>
                    Casa comercial: <strong>{imp.casa_comercial.nombre}</strong> (asignada automáticamente)
                  </p>
                )}
              </div>

              <div className="quick-actions__receive-actions">
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setEditingId(null)} disabled={formSaving}>
                  Cancelar
                </button>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--primary" onClick={saveProductForm} disabled={formSaving}>
                  {formSaving ? 'Guardando...' : 'Crear producto'}
                </button>
              </div>
            </div>
          </div>,
          getPortalRoot()
        )
      })()}
    </>,
    getPortalRoot()
  )
}

const DETAILS_VIEWPORT_PADDING = 12

function ImportacionDetailsModal({ imp, token, onClose, onSaved }) {
  const [showReceive, setShowReceive] = useState(false)
  const [activeTab, setActiveTab] = useState('productos')
  const toastRef = useRef(null)
  const modalRef = useRef(null)
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const [position, setPosition] = useState(() => {
    const w = Math.min(680, window.innerWidth - 56)
    const h = Math.min(700, window.innerHeight * 0.88)
    return {
      x: Math.max((window.innerWidth - w) / 2, DETAILS_VIEWPORT_PADDING + 28),
      y: Math.max((window.innerHeight - h) / 2, DETAILS_VIEWPORT_PADDING),
    }
  })

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!dragData.current.active) return
      e.preventDefault()
      const modalW = modalRef.current?.offsetWidth || 680
      const modalH = modalRef.current?.offsetHeight || 600
      setPosition({
        x: Math.min(Math.max(e.clientX - dragData.current.offsetX, DETAILS_VIEWPORT_PADDING + 28), window.innerWidth - modalW - DETAILS_VIEWPORT_PADDING),
        y: Math.min(Math.max(e.clientY - dragData.current.offsetY, DETAILS_VIEWPORT_PADDING), window.innerHeight - modalH - DETAILS_VIEWPORT_PADDING),
      })
    }
    const handleMouseUp = () => { dragData.current.active = false }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const handleHeaderMouseDown = (e) => {
    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    dragData.current = { active: true, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top }
  }

  if (!imp) return null
  const detalles = imp.detalles || []
  const badge = STATUS_BADGE[imp.estado] || { label: imp.estado, color: '#64748b', bg: 'rgba(100,116,139,0.1)' }

  const progressInfo = (() => {
    const startDate = imp.fecha_importacion || imp.fecha
    if (imp.estado !== 'en_camino' || !startDate || !imp.dias_entrega_estimados) return null
    const start = new Date(startDate)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const elapsedMs = today - start
    const elapsedDays = Math.max(0, Math.floor(elapsedMs / 86400000))
    const totalDays = imp.dias_entrega_estimados
    const pct = Math.min(100, Math.round((elapsedDays / totalDays) * 100))
    const remaining = Math.max(0, totalDays - elapsedDays)
    return { pct, elapsedDays, totalDays, remaining }
  })()

  const ribbonClass = imp.estado === 'importada'
    ? 'entrada-details__pending-ribbon--accepted'
    : imp.estado === 'en_camino'
      ? 'entrada-details__pending-ribbon--pending'
      : ''
  const ribbonLabel = imp.estado === 'importada' ? 'Importada' : imp.estado === 'en_camino' ? 'En\ncamino' : badge.label

  const modal = createPortal(
    <div className="create-user__overlay" role="dialog" aria-modal="true" style={{ padding: '16px' }}>
      <Toast ref={toastRef} />
      <div
        ref={modalRef}
        className="create-user__modal create-salida__modal entrada-details__modal--pending"
        style={{
          top: position.y,
          left: position.x,
          width: 'min(720px, calc(100vw - 32px))',
          height: 'auto',
          maxHeight: 'min(88vh, 720px)',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className={`entrada-details__pending-ribbon${ribbonClass ? ` ${ribbonClass}` : ''}`}>
          <span className="entrada-details__pending-ribbon-label">{ribbonLabel}</span>
        </div>
          <header className="create-user__header" onMouseDown={handleHeaderMouseDown}>
            <div className="create-user__header-text">
              <h3>{imp.codigo}</h3>
            </div>
            <div className="create-user__header-actions">
              <button type="button" className="create-user__icon-button" onMouseDown={(e) => e.stopPropagation()} onClick={onClose} aria-label="Cerrar">
                <i className="pi pi-times" />
              </button>
            </div>
          </header>

          <div className="create-user__tabs create-salida__tabs" role="tablist">
            <button type="button" className={`create-user__tab${activeTab === 'general' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('general')}>
              General
            </button>
            <button type="button" className={`create-user__tab${activeTab === 'productos' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('productos')}>
              Productos {detalles.length > 0 && `(${detalles.length})`}
            </button>
          </div>

          <div className="create-user__content create-salida__content">
            <div className="create-user__body">

              {activeTab === 'general' && (
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">General</p>
                      <h4>Información de la importación</h4>
                    </div>
                  </div>
                  <div className="create-salida__field-groups">
                    <div className="create-salida__field-group create-salida__field-group--defined">
                      <div className="create-user__grid create-user__grid--two">
                        <StaticFieldDisplay label="Código" value={imp.codigo} />
                        <StaticFieldDisplay label="Fecha importación" value={imp.fecha_importacion || imp.fecha || '-'} />
                        <StaticFieldDisplay label="Casa comercial" value={formatCasaLabel(imp.casa_comercial)} fullWidth />
                        <StaticFieldDisplay label="Días estimados" value={imp.dias_entrega_estimados != null ? `${imp.dias_entrega_estimados} días` : '-'} />
                        {imp.numero_factura && <StaticFieldDisplay label="Factura" value={imp.numero_factura} />}
                        {imp.casa_comercial?.pais?.nombre && (
                          <div className="create-user__field create-salida__static-field">
                            <span>País</span>
                            <div className="create-salida__static-value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              {(() => {
                                const flagUrl = getFlagUrl(imp.casa_comercial.pais?.codigo_pais)
                                return (
                                  <span className={`create-user__flag${flagUrl ? '' : ' is-empty'}`} aria-hidden="true" style={{ flexShrink: 0 }}>
                                    {flagUrl ? <img src={flagUrl} alt="" /> : '□'}
                                  </span>
                                )
                              })()}
                              {String(imp.casa_comercial.pais.nombre).trim()}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {activeTab === 'productos' && (
                <section className="create-user__section">
                  {progressInfo && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                        <p className="create-user__eyebrow" style={{ margin: 0 }}>Progreso de entrega</p>
                        <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                          {progressInfo.pct < 100
                            ? `${progressInfo.elapsedDays} / ${progressInfo.totalDays} días — faltan ${progressInfo.remaining} día${progressInfo.remaining === 1 ? '' : 's'}`
                            : `${progressInfo.elapsedDays} días transcurridos`}
                        </span>
                      </div>
                      <div className="imp-details__progress-track">
                        <div
                          className={`imp-details__progress-fill${progressInfo.pct >= 100 ? ' imp-details__progress-fill--late' : ''}`}
                          style={{ width: `${progressInfo.pct}%` }}
                        />
                      </div>
                      <div style={{ textAlign: 'right', fontSize: '0.75rem', marginTop: 4, fontWeight: 600, color: progressInfo.pct >= 100 ? '#ef4444' : 'var(--color-muted,#64748b)' }}>
                        {progressInfo.pct}%
                      </div>
                    </div>
                  )}
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Productos</p>
                      <h4>Listado de productos</h4>
                    </div>
                  </div>
                  <div className="create-user__locations-table" style={{ borderRadius: 8, overflow: 'hidden' }}>
                    <div className="create-user__locations-row create-user__locations-row--head" style={{ gridTemplateColumns: 'minmax(90px,0.7fr) minmax(160px,1.6fr) minmax(110px,1fr) 60px' }}>
                      <span>Código</span><span>Nombre</span><span>OEM</span><span style={{ justifyContent: 'center' }}>Cant.</span>
                    </div>
                    {!detalles.length ? (
                      <div className="create-user__locations-row create-user__locations-row--empty" style={{ gridTemplateColumns: '1fr' }}><span>Sin productos.</span></div>
                    ) : detalles.map((d, i) => {
                      const sinCat = !d.producto?.id
                      const codigo = d.producto?.codigo || d.codigo || '-'
                      const nombre = d.producto?.nombre || d.nombre || '-'
                      const oem = d.producto?.oem || d.oem || '-'
                      return (
                        <div key={d.id ?? i} className={`create-user__locations-row${sinCat ? ' importaciones-aceptados__row--no-catalogo' : ''}`} style={{ gridTemplateColumns: 'minmax(90px,0.7fr) minmax(160px,1.6fr) minmax(110px,1fr) 60px' }}>
                          <span title={codigo} style={{ overflow: 'hidden' }}>
                            <span className="imp-cell-text">{codigo}</span>
                            {sinCat && <span className="importaciones-aceptados__no-catalogo-badge" style={{ marginLeft: 4 }}>Sin catálogo</span>}
                          </span>
                          <span title={nombre} style={{ overflow: 'hidden' }}><span className="imp-cell-text">{nombre}</span></span>
                          <span title={oem} style={{ overflow: 'hidden' }}><span className="imp-cell-text">{oem}</span></span>
                          <span style={{ justifyContent: 'center', fontWeight: 600 }}>{d.cantidad}</span>
                        </div>
                      )
                    })}
                  </div>
                </section>
              )}

            </div>
          </div>

          <div className="create-user__footer">
            <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose}>Cerrar</button>
            {imp.estado === 'en_camino' && (
              <button
                type="button"
                className="create-user__action create-user__action--primary"
                onClick={() => setShowReceive(true)}
              >
                Llegó importación
              </button>
            )}
          </div>
        </div>
    </div>,
    getPortalRoot()
  )


  return (
    <>
      {modal}
      {showReceive && (
        <ImportacionReceiveModal
          imp={imp}
          token={token}
          onClose={() => setShowReceive(false)}
          onConfirmed={(payload) => { onSaved?.(payload); onClose?.() }}
        />
      )}
    </>
  )
}

function CreateImportacionModal({ open, token, onClose, onCreated, onError, onOpenBorrador }) {
  const [step, setStep] = useState('casa')
  const [nextCode, setNextCode] = useState('IMP-')
  const [selectedCasa, setSelectedCasa] = useState(null)
  const [casaDraft, setCasaDraft] = useState(null)
  const [casaQuery, setCasaQuery] = useState('')
  const [casaOptions, setCasaOptions] = useState([])
  const [casaLoading, setCasaLoading] = useState(false)
  const [showCasaDropdown, setShowCasaDropdown] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [detailDraft, setDetailDraft] = useState({ producto: null, cantidad: '' })
  const [productQuery, setProductQuery] = useState('')
  const [productOptions, setProductOptions] = useState([])
  const [productLoading, setProductLoading] = useState(false)
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [details, setDetails] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [invalidQtyKeys, setInvalidQtyKeys] = useState(new Set())
  const [showAceptadosView, setShowAceptadosView] = useState(false)
  const [aceptadosItems, setAceptadosItems] = useState([])
  const [aceptadosLoading, setAceptadosLoading] = useState(false)
  const [aceptadosSelected, setAceptadosSelected] = useState(new Set())
  const [aceptadosSearch, setAceptadosSearch] = useState('')
  const [aceptadosCount, setAceptadosCount] = useState(null)
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: SELECTOR_WIDTH, height: SELECTOR_HEIGHT_EMPTY })

  const modalRef = useRef(null)
  const toastRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalSizeRef = useRef(modalSize)
  const modalPositionRef = useRef(modalPosition)
  const casaTimerRef = useRef(null)
  const productTimerRef = useRef(null)
  const casaDropdownRef = useRef(null)
  const productDropdownRef = useRef(null)
  const isFirstOpenRef = useRef(true)
  const [casaPanelStyle, setCasaPanelStyle] = useState(null)
  const [productPanelStyle, setProductPanelStyle] = useState(null)
  const detailDraftQuantity = Number(detailDraft.cantidad)
  const canAddDetailDraft = Boolean(
    detailDraft.producto &&
    Number.isFinite(detailDraftQuantity) &&
    detailDraftQuantity > 0
  )

  useEffect(() => { modalSizeRef.current = modalSize }, [modalSize])
  useEffect(() => { modalPositionRef.current = modalPosition }, [modalPosition])

  useLayoutEffect(() => {
    if (!showCasaDropdown || !casaDropdownRef.current) {
      setCasaPanelStyle(null)
      return
    }
    const rect = casaDropdownRef.current.getBoundingClientRect()
    const panelMaxHeight = Math.min(260, window.innerHeight - rect.bottom - 8)
    setCasaPanelStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(panelMaxHeight, 120),
      zIndex: 9999,
    })
  }, [showCasaDropdown, modalPosition])

  useLayoutEffect(() => {
    if (!showProductDropdown || !productDropdownRef.current) {
      setProductPanelStyle(null)
      return
    }
    const rect = productDropdownRef.current.getBoundingClientRect()
    const panelMaxHeight = Math.min(280, window.innerHeight - rect.bottom - 8)
    const panelWidth = Math.min(Math.max(rect.width, 520), window.innerWidth - VIEWPORT_PADDING * 2)
    const panelLeft = clamp(rect.left, VIEWPORT_PADDING, Math.max(window.innerWidth - panelWidth - VIEWPORT_PADDING, VIEWPORT_PADDING))
    setProductPanelStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: panelLeft,
      width: panelWidth,
      maxHeight: Math.max(panelMaxHeight, 120),
      zIndex: 9999,
    })
  }, [showProductDropdown, modalPosition])

  useLayoutEffect(() => {
    if (!open) {
      isFirstOpenRef.current = true
      return
    }
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    const isSelectorStep = step === 'casa'

    if (isSelectorStep) {
      const nextWidth = Math.min(SELECTOR_WIDTH, availableWidth)
      const preferredHeight = casaDraft ? SELECTOR_HEIGHT_FULL : SELECTOR_HEIGHT_EMPTY
      const measuredHeight = modalRef.current?.offsetHeight || (casaDraft ? 420 : 190)
      const nextHeight = typeof preferredHeight === 'number'
        ? Math.min(preferredHeight, availableHeight)
        : preferredHeight
      const boundsHeight = typeof nextHeight === 'number' ? nextHeight : Math.min(measuredHeight, availableHeight)
      setModalSize({ width: nextWidth, height: nextHeight })
      const centerX = Math.max((window.innerWidth - nextWidth) / 2, VIEWPORT_PADDING)
      const centerY = Math.max((window.innerHeight - boundsHeight) / 2, VIEWPORT_PADDING)
      if (isFirstOpenRef.current) {
        isFirstOpenRef.current = false
      }
      setModalPosition({ x: centerX, y: centerY })
    } else {
      const nextWidth = Math.min(MIN_WIDTH, availableWidth)
      const nextHeight = Math.min(MIN_HEIGHT, availableHeight)
      const centerX = Math.max((window.innerWidth - nextWidth) / 2, VIEWPORT_PADDING)
      const centerY = Math.max((window.innerHeight - nextHeight) / 2, VIEWPORT_PADDING)
      setModalSize({ width: nextWidth, height: nextHeight })
      if (isFirstOpenRef.current) {
        isFirstOpenRef.current = false
      }
      setModalPosition({ x: centerX, y: centerY })
    }
  }, [open, step, casaDraft])

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!modalDrag.current.active) return
      event.preventDefault()
      const newX = event.clientX - modalDrag.current.offsetX
      const newY = event.clientY - modalDrag.current.offsetY
      const maxX = Math.max(window.innerWidth - modalSizeRef.current.width - VIEWPORT_PADDING, VIEWPORT_PADDING)
      const modalHeight = typeof modalSizeRef.current.height === 'number'
        ? modalSizeRef.current.height
        : (modalRef.current?.offsetHeight || 0)
      const maxY = Math.max(window.innerHeight - modalHeight - VIEWPORT_PADDING, VIEWPORT_PADDING)
      setModalPosition({
        x: clamp(newX, VIEWPORT_PADDING, maxX),
        y: clamp(newY, VIEWPORT_PADDING, maxY),
      })
    }
    const handleMouseUp = () => { modalDrag.current.active = false }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const handleModalMouseDown = (event) => {
    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    modalDrag.current = { active: true, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top }
  }

  const notifyError = useCallback((message) => {
    const clean = String(message || '').trim()
    if (!clean) return
    toastRef.current?.show({ severity: 'error', summary: 'Error', detail: clean, life: 4000 })
  }, [])

  const reset = useCallback(() => {
    setStep('casa')
    setActiveTab('general')
    setDetailDraft({ producto: null, cantidad: '' })
    setNextCode('IMP-')
    setSelectedCasa(null)
    setCasaDraft(null)
    setCasaQuery('')
    setCasaOptions([])
    setShowCasaDropdown(false)
    setProductQuery('')
    setProductOptions([])
    setShowProductDropdown(false)
    setDetails([])
    setSubmitting(false)
    setInvalidQtyKeys(new Set())
    setShowAceptadosView(false)
    setAceptadosItems([])
    setAceptadosLoading(false)
    setAceptadosSelected(new Set())
    setAceptadosSearch('')
    setAceptadosCount(null)
    setModalSize({ width: SELECTOR_WIDTH, height: SELECTOR_HEIGHT_EMPTY })
  }, [])

  useEffect(() => {
    if (!open) return
    reset()
  }, [open, reset])

  useEffect(() => {
    if (!open || !token) return
    let cancelled = false
    authFetch(`${API_URL}/importaciones/importaciones/next-code/`, {}, token)
      .then((response) => response.ok ? response.json() : Promise.reject(response))
      .then((payload) => {
        if (!cancelled) setNextCode(String(payload?.codigo || 'IMP-').trim() || 'IMP-')
      })
      .catch(() => {
        if (!cancelled) setNextCode('IMP-')
      })
    return () => { cancelled = true }
  }, [open, token])

  useEffect(() => {
    if (!selectedCasa?.id || !token) {
      setAceptadosCount(null)
      return undefined
    }
    let cancelled = false
    authFetch(`${API_URL}/solicitudes/solicitudes/aceptados-por-casa/?casa_comercial_id=${selectedCasa.id}`, {}, token)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((payload) => { if (!cancelled) setAceptadosCount(parseApiList(payload).length) })
      .catch(() => { if (!cancelled) setAceptadosCount(null) })
    return () => { cancelled = true }
  }, [selectedCasa?.id, token])

  useEffect(() => {
    if (!showAceptadosView || !selectedCasa?.id || !token) return undefined
    setAceptadosSelected(new Set())
    setAceptadosSearch('')
    setAceptadosLoading(true)
    let cancelled = false
    authFetch(`${API_URL}/solicitudes/solicitudes/aceptados-por-casa/?casa_comercial_id=${selectedCasa.id}`, {}, token)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((payload) => {
        if (!cancelled) {
          const loaded = parseApiList(payload)
          setAceptadosItems(loaded)
          setAceptadosSelected(new Set(
            loaded
              .filter((item) => item.producto_id
                ? alreadyAddedIds.has(String(item.producto_id))
                : alreadyAddedSolIds.has(String(item.solicitud_id)))
              .map((item) => item.solicitud_id)
          ))
        }
      })
      .catch(() => { if (!cancelled) setAceptadosItems([]) })
      .finally(() => { if (!cancelled) setAceptadosLoading(false) })
    return () => { cancelled = true }
  }, [showAceptadosView, selectedCasa?.id, token])

  useEffect(() => {
    if (!open) return undefined
    const handleMouseDown = (event) => {
      const inCasa = casaDropdownRef.current?.contains(event.target) || event.target.closest?.('[data-casa-portal]')
      if (!inCasa) setShowCasaDropdown(false)
      const inProduct = productDropdownRef.current?.contains(event.target) || event.target.closest?.('[data-product-portal]')
      if (!inProduct) setShowProductDropdown(false)
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    document.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  const searchCasas = useCallback((term) => {
    if (!token) return
    setCasaLoading(true)
    const params = new URLSearchParams()
    params.set('page_size', '10')
    params.set('tipo', 'importacion')
    if (term) params.set('search', term)

    authFetch(`${API_URL}/casa-comercial/casas/?${params.toString()}`, {}, token)
      .then(async (response) => {
        if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudieron cargar las casas comerciales.'))
        return response.json()
      })
      .then((payload) => setCasaOptions(parseApiList(payload)))
      .catch((error) => notifyError(error.message))
      .finally(() => setCasaLoading(false))
  }, [notifyError, token])

  useEffect(() => {
    if (!open || (!showCasaDropdown && step !== 'casa')) return undefined
    if (casaTimerRef.current) clearTimeout(casaTimerRef.current)
    casaTimerRef.current = setTimeout(() => searchCasas(casaQuery.trim()), 280)
    return () => clearTimeout(casaTimerRef.current)
  }, [casaQuery, open, searchCasas, showCasaDropdown, step])

  const searchProducts = useCallback((term) => {
    if (!token) return
    setProductLoading(true)
    const params = new URLSearchParams()
    params.set('page_size', '10')
    params.set('modulo', 'solicitudes')
    if (term) params.set('search', term)
    if (selectedCasa?.nombre) params.set('casa_comercial', selectedCasa.nombre)

    authFetch(`${API_URL}/productos/listado/?${params.toString()}`, {}, token)
      .then(async (response) => {
        if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudieron cargar los productos.'))
        return response.json()
      })
      .then((payload) => {
        const selectedIds = new Set(details.filter((item) => item.producto?.id).map((item) => String(item.producto.id)))
        setProductOptions(parseApiList(payload).filter((product) => !selectedIds.has(String(product.id))))
      })
      .catch((error) => notifyError(error.message))
      .finally(() => setProductLoading(false))
  }, [details, notifyError, selectedCasa, token])

  useEffect(() => {
    if (!open || !showProductDropdown) return undefined
    if (productTimerRef.current) clearTimeout(productTimerRef.current)
    productTimerRef.current = setTimeout(() => searchProducts(productQuery.trim()), 280)
    return () => clearTimeout(productTimerRef.current)
  }, [open, productQuery, searchProducts, showProductDropdown])

  const handleAddProduct = (product, cantidad = '') => {
    const normalizedQuantity = Number(cantidad)
    if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
      return
    }
    if (details.some((d) => d.producto?.id && String(d.producto.id) === String(product.id))) {
      toastRef.current?.show({ severity: 'warn', summary: 'Advertencia', detail: 'Este producto ya fue agregado.', life: 3000 })
      return
    }
    setDetails((prev) => [
      ...prev,
      {
        _key: String(product.id),
        producto: product,
        cantidad: String(cantidad).trim(),
      },
    ])
    setProductQuery('')
    setProductOptions([])
    setShowProductDropdown(false)
  }

  const handleQuantityChange = (_key, value) => {
    const clean = String(value || '').replace(/[^\d]/g, '')
    setDetails((prev) =>
      prev.map((item) =>
        item._key === _key
          ? { ...item, cantidad: clean }
          : item
      )
    )
    if (invalidQtyKeys.has(_key)) {
      setInvalidQtyKeys((prev) => { const next = new Set(prev); next.delete(_key); return next })
    }
  }

  const handleSubmit = async () => {
    if (!selectedCasa?.id) {
      notifyError('Selecciona una casa comercial.')
      return
    }
    if (!details.length) {
      setLocalError('')
      return
    }
    const normalizedDetails = details.map((item) => {
      const solId = item._solId ? { solicitud_id: Number(item._solId) } : {}
      if (item.producto?.id) {
        return { producto_id: item.producto.id, cantidad: Number(item.cantidad || 0), ...solId }
      }
      return { codigo: item.codigo || '', nombre: item.nombre || '', oem: item.oem || '', cantidad: Number(item.cantidad || 0), ...solId }
    })
    const badKeys = new Set(
      details
        .filter((item) => { const n = Number(item.cantidad || 0); return !Number.isFinite(n) || n <= 0 })
        .map((item) => item._key)
    )
    if (badKeys.size > 0) {
      setInvalidQtyKeys(badKeys)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'Todas las cantidades deben ser mayores a cero.', life: 4000 })
      return
    }

    setSubmitting(true)
    try {
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/`,
        {
          method: 'POST',
          body: JSON.stringify({
            casa_comercial_id: selectedCasa.id,
            detalles: normalizedDetails,
          }),
        },
        token
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo crear la importacion.'))
      const payload = await response.json()
      onCreated?.(payload)
      onClose?.()
    } catch (error) {
      notifyError(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  const alreadyAddedIds = useMemo(
    () => new Set(details.filter((d) => d.producto?.id).map((d) => String(d.producto.id))),
    [details]
  )

  const alreadyAddedSolIds = useMemo(
    () => new Set(details.filter((d) => !d.producto?.id && d._solId).map((d) => String(d._solId))),
    [details]
  )

  const filteredAceptados = useMemo(() => {
    const q = aceptadosSearch.trim().toLowerCase()
    if (!q) return aceptadosItems
    return aceptadosItems.filter((item) =>
      String(item.codigo || '').toLowerCase().includes(q) ||
      String(item.nombre || '').toLowerCase().includes(q) ||
      String(item.solicitud_codigo || '').toLowerCase().includes(q) ||
      (item.oem_codigos || []).some((oem) => String(oem).toLowerCase().includes(q))
    )
  }, [aceptadosItems, aceptadosSearch])

  const allSelectableSelected = filteredAceptados.length > 0 && filteredAceptados.every((item) => aceptadosSelected.has(item.solicitud_id))

  const handleToggleAceptado = (solId) => {
    setAceptadosSelected((prev) => {
      const next = new Set(prev)
      if (next.has(solId)) next.delete(solId)
      else next.add(solId)
      return next
    })
  }

  const handleToggleAllAceptados = () => {
    if (allSelectableSelected) {
      setAceptadosSelected(new Set())
    } else {
      setAceptadosSelected(new Set(filteredAceptados.map((i) => i.solicitud_id)))
    }
  }

  const handleConfirmAceptados = () => {
    const toRemove = aceptadosItems.filter((item) => {
      const wasAdded = item.producto_id
        ? alreadyAddedIds.has(String(item.producto_id))
        : alreadyAddedSolIds.has(String(item.solicitud_id))
      return wasAdded && !aceptadosSelected.has(item.solicitud_id)
    })
    const toAdd = aceptadosItems.filter((item) => {
      const wasAdded = item.producto_id
        ? alreadyAddedIds.has(String(item.producto_id))
        : alreadyAddedSolIds.has(String(item.solicitud_id))
      return !wasAdded && aceptadosSelected.has(item.solicitud_id)
    })
    if (toRemove.length > 0) {
      setDetails((prev) => prev.filter((d) => {
        if (d.producto?.id) return !toRemove.some((r) => r.producto_id && String(r.producto_id) === String(d.producto.id))
        return !toRemove.some((r) => !r.producto_id && String(r.solicitud_id) === String(d._solId))
      }))
    }
    if (toAdd.length > 0) handleAddFromAceptados(toAdd)
    setShowAceptadosView(false)
  }

  const handleAddFromAceptados = useCallback((aceptados) => {
    setDetails((prev) => {
      const next = [...prev]
      for (const item of aceptados) {
        if (item.producto_id) {
          const pid = String(item.producto_id)
          const existingIdx = next.findIndex((d) => d._key === pid)
          if (existingIdx >= 0) {
            const merged = { ...next[existingIdx] }
            merged.cantidad = String(Number(merged.cantidad || 0) + Number(item.cantidad || 0))
            next[existingIdx] = merged
          } else {
            next.push({
              _key: pid,
              producto: { id: item.producto_id, codigo: item.codigo, nombre: item.nombre, oem: (item.oem_codigos || []).join(', ') },
              cantidad: String(item.cantidad || ''),
            })
          }
        } else {
          const solKey = 'sol_' + item.solicitud_id
          const existingIdx = next.findIndex((d) => d._key === solKey)
          if (existingIdx >= 0) {
            const merged = { ...next[existingIdx] }
            merged.cantidad = String(Number(merged.cantidad || 0) + Number(item.cantidad || 0))
            next[existingIdx] = merged
          } else {
            next.push({
              _key: solKey,
              _solId: item.solicitud_id,
              producto: null,
              codigo: item.codigo || '',
              nombre: item.nombre || '',
              oem: (item.oem_codigos || []).join(', '),
              cantidad: String(item.cantidad || ''),
            })
          }
        }
      }
      return next
    })
  }, [])

  if (!open) return null

  return (
    <>
    <Toast ref={toastRef} baseZIndex={12100} />
    <div
      className="create-user__overlay"
      role="dialog"
      aria-modal="true"
      style={{ padding: `${VIEWPORT_PADDING}px` }}
    >
      <div
        ref={modalRef}
        className={`create-user__modal${step === 'casa' ? ' importaciones-modal--selector' : ''}`}
        style={{
          top: modalPosition.y,
          left: modalPosition.x,
          width: modalSize.width,
          height: modalSize.height,
          minWidth: 0,
          minHeight: 0,
          maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
          maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
        }}
      >
        <header className="create-user__header" onMouseDown={handleModalMouseDown}>
          <div className="create-user__header-text">
            <h3>Crear borrador</h3>
          </div>
          <div className="create-user__header-actions">
            <button
              type="button"
              className="create-user__icon-button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onClose}
              disabled={submitting}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <form
          className={`create-user__form${step === 'casa' ? ' importaciones-modal__selector-form' : ''}`}
          noValidate
          onSubmit={(e) => { e.preventDefault(); handleSubmit() }}
        >
          {step === 'casa' ? (
            <div className="create-salida__selector-shell" style={{ flex: 'none', overflow: 'visible' }}>
              <section className="create-user__section create-salida__selector-card">
                <div className="create-user__section-header">
                  <div>
                    <h4>Selecciona la casa comercial</h4>
                  </div>
                </div>
                <div className="create-salida__selector-inner">
                  <div className="create-user__field create-salida__selector-field">
                    <div
                      className="create-user__dropdown"
                      ref={casaDropdownRef}
                      style={{ width: '100%' }}
                    >
                      <div
                        className="create-user__dropdown-trigger"
                        style={{ cursor: 'text', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px' }}
                        onClick={() => setShowCasaDropdown(true)}
                      >
                        <i className="pi pi-search" style={{ color: 'var(--color-muted, #888)', flexShrink: 0 }} />
                        <input
                          type="text"
                          placeholder="Busca por nombre, código o país..."
                          value={casaQuery}
                          onChange={(e) => {
                            setCasaQuery(e.target.value)
                            setCasaDraft(null)
                            setShowCasaDropdown(true)
                          }}
                          onFocus={() => setShowCasaDropdown(true)}
                          style={{ border: 'none', outline: 'none', flex: 1, background: 'transparent', fontSize: 'inherit', color: 'inherit' }}
                          autoComplete="off"
                        />
                        {casaLoading && <i className="pi pi-spin pi-spinner" style={{ flexShrink: 0 }} />}
                      </div>
                    </div>

                    {showCasaDropdown && casaPanelStyle && createPortal(
                      <div data-casa-portal className="create-user__dropdown-panel" style={casaPanelStyle}>
                        <div className="create-user__dropdown-results">
                          {casaLoading && <small className="muted">Buscando...</small>}
                          {!casaLoading && !casaOptions.length && (
                            <small className="muted">
                              {casaQuery.trim() ? 'Sin resultados.' : 'Escribe para buscar.'}
                            </small>
                          )}
                          {casaOptions.map((casa) => (
                            <button
                              key={casa.id}
                              type="button"
                              className="create-user__result-option"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                setCasaDraft(casa)
                                setCasaQuery('')
                                setShowCasaDropdown(false)
                                setCasaOptions([])
                              }}
                            >
                              <div className="create-user__result-info">
                                <strong>{String(casa?.nombre || '').trim()}</strong>
                                <small>
                                  {[
                                    String(casa?.codigo || '').trim(),
                                    String(casa?.pais?.nombre || '').trim(),
                                  ].filter(Boolean).join(' · ')}
                                </small>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>,
                      getPortalRoot()
                    )}
                  </div>

                  {casaDraft && (
                    <div className="create-salida__field-group create-salida__field-group--defined" style={{ marginTop: '14px' }}>
                      <div className="create-user__grid create-user__grid--two">
                        <StaticFieldDisplay label="Código" value={casaDraft.codigo} />
                        <StaticFieldDisplay label="Nombre" value={casaDraft.nombre} />
                        <div className="create-user__field create-salida__static-field">
                          <span>País</span>
                          <div className="create-salida__static-value" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {(() => {
                              const flagUrl = getFlagUrl(casaDraft.pais?.codigo_pais)
                              return (
                                <span className={`create-user__flag${flagUrl ? '' : ' is-empty'}`} aria-hidden="true" style={{ flexShrink: 0 }}>
                                  {flagUrl ? <img src={flagUrl} alt="" /> : '□'}
                                </span>
                              )
                            })()}
                            {String(casaDraft.pais?.nombre || '—').trim()}
                          </div>
                        </div>
                        <StaticFieldDisplay
                          label="Días de entrega"
                          value={casaDraft.dias_entrega != null ? `${casaDraft.dias_entrega} días` : ''}
                        />
                        {casaDraft.descripcion && (
                          <StaticFieldDisplay label="Descripción" value={casaDraft.descripcion} fullWidth />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>
          ) : (
            <>
              <div className="create-user__tabs create-salida__tabs" role="tablist">
                <button
                  type="button"
                  className={`create-user__tab${activeTab === 'productos' ? ' create-user__tab--active' : ''}`}
                  onClick={() => setActiveTab('productos')}
                >
                  Productos {details.length > 0 && `(${details.length})`}
                </button>
                <button
                  type="button"
                  className={`create-user__tab${activeTab === 'general' ? ' create-user__tab--active' : ''}`}
                  onClick={() => setActiveTab('general')}
                >
                  General
                </button>
              </div>

              <div className="create-user__content create-salida__content">
                <div className="create-user__body">
                  {activeTab === 'general' && (
                    <section className="create-user__section">
                      <div className="create-user__section-header">
                        <div>
                          <p className="create-user__eyebrow">General</p>
                          <h4>Información de la importación</h4>
                        </div>
                      </div>
                      <div className="create-salida__field-groups">
                        <div className="create-salida__field-group create-salida__field-group--defined">
                          <div className="create-user__grid create-user__grid--two">
                            <StaticFieldDisplay label="Código" value={nextCode} />
                            <StaticFieldDisplay label="Fecha" value={formatDate(todayISO())} />
                            <StaticFieldDisplay label="Casa comercial" value={formatCasaLabel(selectedCasa)} fullWidth />
                            <StaticFieldDisplay
                              label="Días de entrega"
                              value={selectedCasa?.dias_entrega != null ? `${selectedCasa.dias_entrega} días` : ''}
                            />
                            {selectedCasa?.pais?.nombre && (
                              <div className="create-user__field create-salida__static-field">
                                <span>País</span>
                                <div className="create-salida__static-value" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  {(() => {
                                    const flagUrl = getFlagUrl(selectedCasa.pais?.codigo_pais)
                                    return (
                                      <span className={`create-user__flag${flagUrl ? '' : ' is-empty'}`} aria-hidden="true" style={{ flexShrink: 0 }}>
                                        {flagUrl ? <img src={flagUrl} alt="" /> : '□'}
                                      </span>
                                    )
                                  })()}
                                  {String(selectedCasa.pais.nombre).trim()}
                                </div>
                              </div>
                            )}
                            {selectedCasa?.descripcion && (
                              <StaticFieldDisplay label="Descripción" value={selectedCasa.descripcion} fullWidth />
                            )}
                          </div>
                        </div>
                      </div>
                    </section>
                  )}

                  {activeTab === 'productos' && !showAceptadosView && (
                    <section className="create-user__section">
                      <div className="create-user__section-header">
                        <div>
                          <p className="create-user__eyebrow">Productos</p>
                          <h4>Listado de productos</h4>
                        </div>
                        <span title={aceptadosCount === 0 ? 'No hay productos aceptados para esta casa comercial' : undefined}>
                          <button
                            type="button"
                            className="create-user__ghost"
                            onClick={() => setShowAceptadosView(true)}
                            style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}
                            disabled={aceptadosCount === 0}
                          >
                            + Aceptados de solicitudes
                          </button>
                        </span>
                      </div>

                      <div className="create-user__locations-table create-salida__products-table create-salida__products-table--with-actions importaciones-modal__products-table">
                        <div className="create-user__locations-row create-user__locations-row--head">
                          <span>Código</span>
                          <span>Nombre</span>
                          <span>OEM</span>
                          <span>Cantidad</span>
                          <span>Acciones</span>
                        </div>

                        <div className="create-user__locations-row create-user__locations-row--form">
                          <span className="create-salida__product-picker create-salida__product-code-cell">
                            <div className="create-user__dropdown create-salida__product-dropdown" ref={productDropdownRef}>
                              <button
                                type="button"
                                className="create-user__dropdown-trigger"
                                onClick={() => {
                                  setShowProductDropdown((prev) => !prev)
                                  if (!showProductDropdown) { setProductQuery(''); searchProducts('') }
                                }}
                              >
                                <span>{detailDraft.producto ? String(detailDraft.producto.codigo || '').trim() : 'Selecciona un código'}</span>
                                <i className={`pi pi-chevron-${showProductDropdown ? 'up' : 'down'}`} />
                              </button>

                              {showProductDropdown && productPanelStyle && createPortal(
                                <div data-product-portal className="create-user__dropdown-panel" style={productPanelStyle}>
                                  <div className="create-user__dropdown-search">
                                    <i className="pi pi-search" />
                                    <input
                                      type="text"
                                      placeholder="Buscar código o nombre"
                                      value={productQuery}
                                      onChange={(e) => setProductQuery(e.target.value)}
                                      autoFocus
                                      autoComplete="off"
                                    />
                                  </div>
                                  <div className="create-user__dropdown-results">
                                    {productLoading && <small className="muted">Buscando productos...</small>}
                                    {!productLoading && !productQuery.trim() && !productOptions.length && (
                                      <small className="muted">Escribe para buscar.</small>
                                    )}
                                    {!productLoading && productQuery.trim() && !productOptions.length && (
                                      <small className="muted">Sin resultados.</small>
                                    )}
                                    {productOptions.length > 0 && (
                                      <div className="create-salida__results-header">
                                        <span>Código</span>
                                        <span>Nombre</span>
                                        <span>Stock</span>
                                      </div>
                                    )}
                                    {productOptions.map((product) => {
                                      const isAlreadyAdded = details.some((d) => d.producto?.id && String(d.producto.id) === String(product.id))
                                      const isSelected = String(detailDraft.producto?.id) === String(product.id)
                                      return (
                                        <button
                                          key={product.id}
                                          type="button"
                                          className={`create-salida__result-row${isSelected ? ' is-selected' : ''}${isAlreadyAdded ? ' is-added' : ''}`}
                                          onMouseDown={(e) => e.preventDefault()}
                                          onClick={() => {
                                            setDetailDraft({ producto: product, cantidad: '' })
                                            setProductQuery('')
                                            setShowProductDropdown(false)
                                            setProductOptions([])
                                          }}
                                          disabled={isAlreadyAdded}
                                          title={isAlreadyAdded ? 'Ya agregado' : undefined}
                                        >
                                          <span className="result-codigo">{String(product.codigo || '').trim()}</span>
                                          <span className="result-nombre">{String(product.nombre || '').trim()}</span>
                                          <span className="result-stock">{Number(product.total_stock ?? 0)}</span>
                                        </button>
                                      )
                                    })}
                                  </div>
                                </div>,
                                getPortalRoot()
                              )}
                            </div>
                          </span>
                          <span className="create-salida__product-name-cell">
                            <span className="create-salida__table-static-value create-salida__table-static-value--name">
                              {detailDraft.producto ? String(detailDraft.producto.nombre || '').trim() : '-'}
                            </span>
                          </span>
                          <span className="create-salida__table-static-value">
                            {detailDraft.producto ? String(detailDraft.producto.oem || detailDraft.producto.referencia || '').trim() || '-' : '-'}
                          </span>
                          <span>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={detailDraft.cantidad}
                              onChange={(e) => setDetailDraft((prev) => ({ ...prev, cantidad: e.target.value }))}
                              disabled={!detailDraft.producto}
                            />
                          </span>
                          <span className="create-user__locations-cell create-user__locations-cell--action">
                            <button
                              type="button"
                              className="create-user__ghost"
                              disabled={!canAddDetailDraft}
                              onClick={() => {
                                if (!canAddDetailDraft) return
                                handleAddProduct(detailDraft.producto, detailDraft.cantidad)
                                setDetailDraft({ producto: null, cantidad: '' })
                              }}
                            >
                              Agregar
                            </button>
                          </span>
                        </div>

                        {!details.length ? (
                          <div className="create-user__locations-row create-user__locations-row--empty">
                            <span>Sin productos agregados.</span>
                          </div>
                        ) : details.map((item) => {
                          const sinCatalogo = !item.producto?.id
                          const codigo = item.producto?.codigo || item.codigo || '—'
                          const nombre = item.producto?.nombre || item.nombre || ''
                          const oem = String(item.producto?.oem || item.oem || item.producto?.referencia || '').trim() || '-'
                          return (
                            <div key={item._key} className={`create-user__locations-row${sinCatalogo ? ' importaciones-aceptados__row--no-catalogo' : ''}`}>
                              <span>
                                {codigo}
                                {sinCatalogo && <span className="importaciones-aceptados__no-catalogo-badge" style={{ marginLeft: 6 }}>Sin catálogo</span>}
                              </span>
                              <span title={nombre}>
                                <span className="create-salida__product-name-text">{nombre}</span>
                              </span>
                              <span>{oem}</span>
                              <span>
                                <input
                                  type="number"
                                  value={item.cantidad}
                                  onChange={(e) => handleQuantityChange(item._key, e.target.value)}
                                  style={invalidQtyKeys.has(item._key) ? { borderColor: '#ef4444' } : undefined}
                                />
                              </span>
                              <span className="create-user__locations-cell create-user__locations-cell--action">
                                <button
                                  type="button"
                                  className="create-user__locations-remove"
                                  onClick={() => setDetails((prev) => prev.filter((d) => d._key !== item._key))}
                                >
                                  x
                                </button>
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  )}

                </div>
              </div>
            </>
          )}

          <div className="create-user__footer">
            <div className="user-details__footer-left">
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={onClose}
                disabled={submitting}
              >
                Cancelar
              </button>
            </div>
            <div className="user-details__footer-right">
              {step === 'casa' ? (
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  disabled={!casaDraft}
                  onClick={() => {
                    setSelectedCasa(casaDraft)
                    setActiveTab('productos')
                    setStep('form')
                  }}
                >
                  Siguiente
                </button>
              ) : (
                <button
                  type="submit"
                  className="create-user__action create-user__action--primary"
                  disabled={submitting}
                >
                  {submitting ? 'Guardando...' : 'Guardar proceso'}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>

      {showAceptadosView && createPortal(
        <div className="imp-aceptados-popup__overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAceptadosView(false) }}>
          <div className="imp-aceptados-popup__dialog">
            <header className="imp-aceptados-popup__header">
              <div>
                <h3>Aceptados de solicitudes</h3>
                {selectedCasa?.nombre && (
                  <p>{formatCasaLabel(selectedCasa)}</p>
                )}
              </div>
              <button type="button" className="imp-aceptados-popup__close" onClick={() => setShowAceptadosView(false)} aria-label="Cerrar">
                <i className="pi pi-times" />
              </button>
            </header>

            <div className="imp-aceptados-popup__search">
              <i className="pi pi-search" />
              <input
                type="text"
                placeholder="Buscar por código, nombre, OEM o solicitud..."
                value={aceptadosSearch}
                onChange={(e) => setAceptadosSearch(e.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="imp-aceptados-popup__body">
              <div className="create-user__locations-table importaciones-aceptados__table">
                <div className="create-user__locations-row create-user__locations-row--head">
                  <span>
                    <input type="checkbox" checked={allSelectableSelected} disabled={filteredAceptados.length === 0} onChange={handleToggleAllAceptados} title="Seleccionar todos" />
                  </span>
                  <span>Solicitud</span>
                  <span>Código JP</span>
                  <span>Nombre</span>
                  <span>OEMs</span>
                  <span>Cant.</span>
                </div>

                {aceptadosLoading && (
                  <div className="create-user__locations-row create-user__locations-row--empty"><span>Cargando...</span></div>
                )}
                {!aceptadosLoading && filteredAceptados.length === 0 && (
                  <div className="create-user__locations-row create-user__locations-row--empty">
                    <span>{aceptadosItems.length === 0 ? 'No hay productos aceptados.' : 'Sin resultados.'}</span>
                  </div>
                )}
                {!aceptadosLoading && filteredAceptados.map((item) => {
                  const noProducto = !item.producto_id
                  const isSelected = aceptadosSelected.has(item.solicitud_id)
                  const oemText = (item.oem_codigos || []).join(', ') || '-'
                  return (
                    <div
                      key={item.solicitud_id}
                      className={`create-user__locations-row importaciones-aceptados__row${isSelected ? ' importaciones-aceptados__row--selected' : ''}${noProducto ? ' importaciones-aceptados__row--no-catalogo' : ''}`}
                      style={{ cursor: 'pointer' }}
                      onClick={() => handleToggleAceptado(item.solicitud_id)}
                    >
                      <span>
                        <input type="checkbox" checked={isSelected} onChange={() => handleToggleAceptado(item.solicitud_id)} onClick={(e) => e.stopPropagation()} style={{ cursor: 'pointer' }} />
                      </span>
                      <span style={{ fontSize: '0.79rem', color: 'var(--color-muted, #888)' }}>
                        <span className="imp-cell-text">{item.solicitud_codigo || '-'}</span>
                      </span>
                      <span>
                        <span className="imp-cell-text">
                          {item.codigo || '-'}
                          {noProducto && <span className="importaciones-aceptados__no-catalogo-badge" title="Sin producto en catálogo">Sin catálogo</span>}
                        </span>
                      </span>
                      <span title={item.nombre}><span className="imp-cell-text">{item.nombre || '-'}</span></span>
                      <span style={{ fontSize: '0.8rem' }}><span className="imp-cell-text">{oemText}</span></span>
                      <span>{item.cantidad ?? '-'}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="imp-aceptados-popup__footer">
              <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setShowAceptadosView(false)}>Regresar</button>
              <button type="button" className="create-user__action create-user__action--primary" disabled={aceptadosSelected.size === 0} onClick={handleConfirmAceptados}>
                {aceptadosSelected.size > 0 ? `Agregar (${aceptadosSelected.size})` : 'Agregar'}
              </button>
            </div>
          </div>
        </div>,
        getPortalRoot()
      )}
    </div>
    </>
  )
}

function EditImportacionModal({ open, imp, token, onClose, onSaved, onOpenBorrador }) {
  const [activeTab, setActiveTab] = useState('general')
  const [detailDraft, setDetailDraft] = useState({ producto: null, cantidad: '' })
  const [productQuery, setProductQuery] = useState('')
  const [productOptions, setProductOptions] = useState([])
  const [productLoading, setProductLoading] = useState(false)
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [details, setDetails] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [invalidQtyKeys, setInvalidQtyKeys] = useState(new Set())
  const [showAceptadosView, setShowAceptadosView] = useState(false)
  const [aceptadosItems, setAceptadosItems] = useState([])
  const [aceptadosLoading, setAceptadosLoading] = useState(false)
  const [aceptadosSelected, setAceptadosSelected] = useState(new Set())
  const [aceptadosSearch, setAceptadosSearch] = useState('')
  const [aceptadosCount, setAceptadosCount] = useState(null)
  const [showImportarModal, setShowImportarModal] = useState(false)
  const [facturaInput, setFacturaInput] = useState('')
  const [importarSubmitting, setImportarSubmitting] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteSubmitting, setDeleteSubmitting] = useState(false)
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const toastRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalSizeRef = useRef(modalSize)
  const productTimerRef = useRef(null)
  const productDropdownRef = useRef(null)
  const isFirstOpenRef = useRef(true)
  const [productPanelStyle, setProductPanelStyle] = useState(null)

  const selectedCasa = imp?.casa_comercial || null
  const detailDraftQuantity = Number(detailDraft.cantidad)
  const canAddDetailDraft = Boolean(
    detailDraft.producto && Number.isFinite(detailDraftQuantity) && detailDraftQuantity > 0
  )

  useEffect(() => { modalSizeRef.current = modalSize }, [modalSize])

  useLayoutEffect(() => {
    if (!open) { isFirstOpenRef.current = true; return }
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    const nextWidth = Math.min(MIN_WIDTH, availableWidth)
    const nextHeight = Math.min(MIN_HEIGHT, availableHeight)
    const centerX = Math.max((window.innerWidth - nextWidth) / 2, VIEWPORT_PADDING)
    const centerY = Math.max((window.innerHeight - nextHeight) / 2, VIEWPORT_PADDING)
    setModalSize({ width: nextWidth, height: nextHeight })
    if (isFirstOpenRef.current) isFirstOpenRef.current = false
    setModalPosition({ x: centerX, y: centerY })
  }, [open])

  useLayoutEffect(() => {
    if (!showProductDropdown || !productDropdownRef.current) { setProductPanelStyle(null); return }
    const rect = productDropdownRef.current.getBoundingClientRect()
    const panelMaxHeight = Math.min(280, window.innerHeight - rect.bottom - 8)
    const panelWidth = Math.min(Math.max(rect.width, 520), window.innerWidth - VIEWPORT_PADDING * 2)
    const panelLeft = clamp(rect.left, VIEWPORT_PADDING, Math.max(window.innerWidth - panelWidth - VIEWPORT_PADDING, VIEWPORT_PADDING))
    setProductPanelStyle({
      position: 'fixed', top: rect.bottom + 4, left: panelLeft, width: panelWidth,
      maxHeight: Math.max(panelMaxHeight, 120), zIndex: 9999,
    })
  }, [showProductDropdown, modalPosition])

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!modalDrag.current.active) return
      event.preventDefault()
      const newX = event.clientX - modalDrag.current.offsetX
      const newY = event.clientY - modalDrag.current.offsetY
      const maxX = Math.max(window.innerWidth - modalSizeRef.current.width - VIEWPORT_PADDING, VIEWPORT_PADDING)
      const modalHeight = typeof modalSizeRef.current.height === 'number'
        ? modalSizeRef.current.height : (modalRef.current?.offsetHeight || 0)
      const maxY = Math.max(window.innerHeight - modalHeight - VIEWPORT_PADDING, VIEWPORT_PADDING)
      setModalPosition({ x: clamp(newX, VIEWPORT_PADDING, maxX), y: clamp(newY, VIEWPORT_PADDING, maxY) })
    }
    const handleMouseUp = () => { modalDrag.current.active = false }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp) }
  }, [])

  const handleModalMouseDown = (event) => {
    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    modalDrag.current = { active: true, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top }
  }

  useEffect(() => {
    if (!open || !imp) return
    const loaded = (imp.detalles || []).map((d, i) => {
      const solId = d.solicitud_id ? String(d.solicitud_id) : null
      if (d.producto?.id) {
        return { _key: String(d.producto.id), producto: d.producto, cantidad: String(d.cantidad || ''), _solId: solId }
      }
      return {
        _key: 'sc_' + (d.id ?? i), producto: null,
        codigo: d.codigo || '', nombre: d.nombre || '', oem: d.oem || '',
        cantidad: String(d.cantidad || ''), _solId: solId,
      }
    })
    setDetails(loaded)
    setDetailDraft({ producto: null, cantidad: '' })
    setActiveTab('general')
    setInvalidQtyKeys(new Set())
    setShowAceptadosView(false)
    setAceptadosItems([])
    setAceptadosSelected(new Set())
    setAceptadosSearch('')
  }, [open, imp])

  useEffect(() => {
    if (!open) return undefined
    const handleMouseDown = (event) => {
      const inProduct = productDropdownRef.current?.contains(event.target) || event.target.closest?.('[data-product-portal-edit]')
      if (!inProduct) setShowProductDropdown(false)
    }
    const handleKeyDown = (event) => { if (event.key === 'Escape') onClose?.() }
    document.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => { document.removeEventListener('mousedown', handleMouseDown); window.removeEventListener('keydown', handleKeyDown) }
  }, [open, onClose])

  useEffect(() => {
    if (!selectedCasa?.id || !token || !open) { setAceptadosCount(null); return undefined }
    let cancelled = false
    authFetch(`${API_URL}/solicitudes/solicitudes/aceptados-por-casa/?casa_comercial_id=${selectedCasa.id}`, {}, token)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((payload) => { if (!cancelled) setAceptadosCount(parseApiList(payload).length) })
      .catch(() => { if (!cancelled) setAceptadosCount(null) })
    return () => { cancelled = true }
  }, [open, selectedCasa?.id, token])

  useEffect(() => {
    if (!showAceptadosView || !selectedCasa?.id || !token) return undefined
    setAceptadosSelected(new Set())
    setAceptadosSearch('')
    setAceptadosLoading(true)
    let cancelled = false
    authFetch(`${API_URL}/solicitudes/solicitudes/aceptados-por-casa/?casa_comercial_id=${selectedCasa.id}`, {}, token)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((payload) => {
        if (!cancelled) {
          const loaded = parseApiList(payload)
          setAceptadosItems(loaded)
          setAceptadosSelected(new Set(
            loaded
              .filter((item) => item.producto_id
                ? alreadyAddedIds.has(String(item.producto_id))
                : alreadyAddedSolIds.has(String(item.solicitud_id)))
              .map((item) => item.solicitud_id)
          ))
        }
      })
      .catch(() => { if (!cancelled) setAceptadosItems([]) })
      .finally(() => { if (!cancelled) setAceptadosLoading(false) })
    return () => { cancelled = true }
  }, [showAceptadosView, selectedCasa?.id, token])

  const searchProducts = useCallback((term) => {
    if (!token) return
    setProductLoading(true)
    const params = new URLSearchParams()
    params.set('page_size', '10')
    params.set('modulo', 'solicitudes')
    if (term) params.set('search', term)
    if (selectedCasa?.nombre) params.set('casa_comercial', selectedCasa.nombre)
    authFetch(`${API_URL}/productos/listado/?${params.toString()}`, {}, token)
      .then(async (response) => {
        if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudieron cargar los productos.'))
        return response.json()
      })
      .then((payload) => {
        const selectedIds = new Set(details.filter((item) => item.producto?.id).map((item) => String(item.producto.id)))
        setProductOptions(parseApiList(payload).filter((product) => !selectedIds.has(String(product.id))))
      })
      .catch((error) => toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 }))
      .finally(() => setProductLoading(false))
  }, [details, selectedCasa, token])

  useEffect(() => {
    if (!open || !showProductDropdown) return undefined
    if (productTimerRef.current) clearTimeout(productTimerRef.current)
    productTimerRef.current = setTimeout(() => searchProducts(productQuery.trim()), 280)
    return () => clearTimeout(productTimerRef.current)
  }, [open, productQuery, searchProducts, showProductDropdown])

  const handleAddProduct = (product, cantidad = '') => {
    const n = Number(cantidad)
    if (!Number.isFinite(n) || n <= 0) return
    if (details.some((d) => d.producto?.id && String(d.producto.id) === String(product.id))) {
      toastRef.current?.show({ severity: 'warn', summary: 'Advertencia', detail: 'Este producto ya fue agregado.', life: 3000 })
      return
    }
    setDetails((prev) => [...prev, { _key: String(product.id), producto: product, cantidad: String(cantidad).trim() }])
    setProductQuery('')
    setProductOptions([])
    setShowProductDropdown(false)
    setDetailDraft({ producto: null, cantidad: '' })
  }

  const handleQuantityChange = (_key, value) => {
    const clean = String(value || '').replace(/[^\d]/g, '')
    setDetails((prev) => prev.map((item) => item._key === _key ? { ...item, cantidad: clean } : item))
    if (invalidQtyKeys.has(_key)) {
      setInvalidQtyKeys((prev) => { const next = new Set(prev); next.delete(_key); return next })
    }
  }

  const handleSubmit = async () => {
    if (!details.length) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'Agrega al menos un producto.', life: 4000 })
      return
    }
    const badKeys = new Set(
      details.filter((item) => { const n = Number(item.cantidad || 0); return !Number.isFinite(n) || n <= 0 }).map((item) => item._key)
    )
    if (badKeys.size > 0) {
      setInvalidQtyKeys(badKeys)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'Todas las cantidades deben ser mayores a cero.', life: 4000 })
      return
    }
    const normalizedDetails = details.map((item) => {
      const solId = item._solId ? { solicitud_id: Number(item._solId) } : {}
      if (item.producto?.id) return { producto_id: item.producto.id, cantidad: Number(item.cantidad || 0), ...solId }
      return { codigo: item.codigo || '', nombre: item.nombre || '', oem: item.oem || '', cantidad: Number(item.cantidad || 0), ...solId }
    })
    setSubmitting(true)
    try {
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/`,
        { method: 'PATCH', body: JSON.stringify({ detalles: normalizedDetails }) },
        token
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo guardar la importación.'))
      const payload = await response.json()
      onSaved?.(payload)
      onClose?.()
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 })
    } finally {
      setSubmitting(false)
    }
  }

  const handleImportar = async () => {
    const factura = facturaInput.trim()
    if (!factura) return
    setImportarSubmitting(true)
    try {
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/importar/`,
        { method: 'POST', body: JSON.stringify({ numero_factura: factura }) },
        token
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo generar la importación.'))
      const payload = await response.json()
      setShowImportarModal(false)
      onSaved?.(payload)
      onClose?.()
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 })
    } finally {
      setImportarSubmitting(false)
    }
  }

  const handleDeleteBorrador = async () => {
    setDeleteSubmitting(true)
    try {
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/`,
        { method: 'DELETE' },
        token
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo eliminar el borrador.'))
      setShowDeleteModal(false)
      onSaved?.()
      onClose?.()
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 })
    } finally {
      setDeleteSubmitting(false)
    }
  }

  const alreadyAddedIds = useMemo(
    () => new Set(details.filter((d) => d.producto?.id).map((d) => String(d.producto.id))),
    [details]
  )
  const alreadyAddedSolIds = useMemo(
    () => new Set(details.filter((d) => !d.producto?.id && d._solId).map((d) => String(d._solId))),
    [details]
  )

  const filteredAceptados = useMemo(() => {
    const q = aceptadosSearch.trim().toLowerCase()
    if (!q) return aceptadosItems
    return aceptadosItems.filter((item) =>
      String(item.codigo || '').toLowerCase().includes(q) ||
      String(item.nombre || '').toLowerCase().includes(q) ||
      String(item.solicitud_codigo || '').toLowerCase().includes(q) ||
      (item.oem_codigos || []).some((oem) => String(oem).toLowerCase().includes(q))
    )
  }, [aceptadosItems, aceptadosSearch])

  const allSelectableSelected = filteredAceptados.length > 0 && filteredAceptados.every((item) => aceptadosSelected.has(item.solicitud_id))

  const handleToggleAceptado = (solId) => {
    setAceptadosSelected((prev) => { const next = new Set(prev); if (next.has(solId)) next.delete(solId); else next.add(solId); return next })
  }
  const handleToggleAllAceptados = () => {
    if (allSelectableSelected) setAceptadosSelected(new Set())
    else setAceptadosSelected(new Set(filteredAceptados.map((i) => i.solicitud_id)))
  }
  const handleConfirmAceptados = () => {
    const toRemove = aceptadosItems.filter((item) => {
      const wasAdded = item.producto_id
        ? alreadyAddedIds.has(String(item.producto_id))
        : alreadyAddedSolIds.has(String(item.solicitud_id))
      return wasAdded && !aceptadosSelected.has(item.solicitud_id)
    })
    const toAdd = aceptadosItems.filter((item) => {
      const wasAdded = item.producto_id
        ? alreadyAddedIds.has(String(item.producto_id))
        : alreadyAddedSolIds.has(String(item.solicitud_id))
      return !wasAdded && aceptadosSelected.has(item.solicitud_id)
    })
    if (toRemove.length > 0) {
      setDetails((prev) => prev.filter((d) => {
        if (d.producto?.id) return !toRemove.some((r) => r.producto_id && String(r.producto_id) === String(d.producto.id))
        return !toRemove.some((r) => !r.producto_id && String(r.solicitud_id) === String(d._solId))
      }))
    }
    if (toAdd.length > 0) handleAddFromAceptados(toAdd)
    setShowAceptadosView(false)
  }
  const handleAddFromAceptados = useCallback((aceptados) => {
    setDetails((prev) => {
      const next = [...prev]
      for (const item of aceptados) {
        if (item.producto_id) {
          const pid = String(item.producto_id)
          const idx = next.findIndex((d) => d._key === pid)
          if (idx >= 0) {
            const merged = { ...next[idx] }
            merged.cantidad = String(Number(merged.cantidad || 0) + Number(item.cantidad || 0))
            next[idx] = merged
          } else {
            next.push({
              _key: pid,
              producto: { id: item.producto_id, codigo: item.codigo, nombre: item.nombre, oem: (item.oem_codigos || []).join(', ') },
              cantidad: String(item.cantidad || ''),
            })
          }
        } else {
          const solKey = 'sol_' + item.solicitud_id
          const idx = next.findIndex((d) => d._key === solKey)
          if (idx >= 0) {
            const merged = { ...next[idx] }
            merged.cantidad = String(Number(merged.cantidad || 0) + Number(item.cantidad || 0))
            next[idx] = merged
          } else {
            next.push({
              _key: solKey, _solId: item.solicitud_id, producto: null,
              codigo: item.codigo || '', nombre: item.nombre || '',
              oem: (item.oem_codigos || []).join(', '), cantidad: String(item.cantidad || ''),
            })
          }
        }
      }
      return next
    })
  }, [])

  if (!open || !imp) return null

  return (
    <>
      <Toast ref={toastRef} baseZIndex={12100} />
      <div className="create-user__overlay" role="dialog" aria-modal="true" style={{ padding: `${VIEWPORT_PADDING}px` }}>
        <div
          ref={modalRef}
          className="create-user__modal"
          style={{
            top: modalPosition.y, left: modalPosition.x,
            width: modalSize.width, height: modalSize.height,
            minWidth: 0, minHeight: 0,
            maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
            maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
          }}
        >
          <header className="create-user__header" onMouseDown={handleModalMouseDown}>
            <div className="create-user__header-text">
              <h3>Borrador: {imp.codigo}</h3>
            </div>
            <div className="create-user__header-actions">
              <button type="button" className="create-user__icon-button" onMouseDown={(e) => e.stopPropagation()} onClick={onClose} disabled={submitting} aria-label="Cerrar">
                <i className="pi pi-times" aria-hidden="true" />
              </button>
            </div>
          </header>

          <form className="create-user__form" noValidate onSubmit={(e) => { e.preventDefault(); handleSubmit() }}>
            <div className="create-user__tabs create-salida__tabs" role="tablist">
              <button type="button" className={`create-user__tab${activeTab === 'general' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('general')}>
                General
              </button>
              <button type="button" className={`create-user__tab${activeTab === 'productos' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('productos')}>
                Productos {details.length > 0 && `(${details.length})`}
              </button>
            </div>

            <div className="create-user__content create-salida__content">
              <div className="create-user__body">
                {activeTab === 'general' && (
                  <section className="create-user__section">
                    <div className="create-user__section-header">
                      <div>
                        <p className="create-user__eyebrow">General</p>
                        <h4>Información de la importación</h4>
                      </div>
                    </div>
                    <div className="create-salida__field-groups">
                      <div className="create-salida__field-group create-salida__field-group--defined">
                        <div className="create-user__grid create-user__grid--two">
                          <StaticFieldDisplay label="Código" value={imp.codigo} />
                          <StaticFieldDisplay label="Fecha" value={imp.fecha || '-'} />
                          <StaticFieldDisplay label="Casa comercial" value={formatCasaLabel(selectedCasa)} fullWidth />
                          <StaticFieldDisplay
                            label="Días de entrega"
                            value={imp.dias_entrega_estimados != null ? `${imp.dias_entrega_estimados} días` : ''}
                          />
                          {selectedCasa?.pais?.nombre && (
                            <div className="create-user__field create-salida__static-field">
                              <span>País</span>
                              <div className="create-salida__static-value" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                {(() => {
                                  const flagUrl = getFlagUrl(selectedCasa.pais?.codigo_pais)
                                  return (
                                    <span className={`create-user__flag${flagUrl ? '' : ' is-empty'}`} aria-hidden="true" style={{ flexShrink: 0 }}>
                                      {flagUrl ? <img src={flagUrl} alt="" /> : '□'}
                                    </span>
                                  )
                                })()}
                                {String(selectedCasa.pais.nombre).trim()}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </section>
                )}

                {activeTab === 'productos' && !showAceptadosView && (
                  <section className="create-user__section">
                    <div className="create-user__section-header">
                      <div>
                        <p className="create-user__eyebrow">Productos</p>
                        <h4>Listado de productos</h4>
                      </div>
                      <span title={aceptadosCount === 0 ? 'No hay productos aceptados para esta casa comercial' : undefined}>
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={() => setShowAceptadosView(true)}
                          style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}
                          disabled={aceptadosCount === 0}
                        >
                          + Aceptados de solicitudes
                        </button>
                      </span>
                    </div>

                    <div className="create-user__locations-table create-salida__products-table create-salida__products-table--with-actions importaciones-modal__products-table">
                      <div className="create-user__locations-row create-user__locations-row--head">
                        <span>Código</span><span>Nombre</span><span>OEM</span><span>Cantidad</span><span>Acciones</span>
                      </div>

                      <div className="create-user__locations-row create-user__locations-row--form">
                        <span className="create-salida__product-picker create-salida__product-code-cell">
                          <div className="create-user__dropdown create-salida__product-dropdown" ref={productDropdownRef}>
                            <button
                              type="button"
                              className="create-user__dropdown-trigger"
                              onClick={() => {
                                setShowProductDropdown((prev) => !prev)
                                if (!showProductDropdown) { setProductQuery(''); searchProducts('') }
                              }}
                            >
                              <span>{detailDraft.producto ? String(detailDraft.producto.codigo || '').trim() : 'Selecciona un código'}</span>
                              <i className={`pi pi-chevron-${showProductDropdown ? 'up' : 'down'}`} />
                            </button>
                            {showProductDropdown && productPanelStyle && createPortal(
                              <div data-product-portal-edit className="create-user__dropdown-panel" style={productPanelStyle}>
                                <div className="create-user__dropdown-search">
                                  <i className="pi pi-search" />
                                  <input
                                    type="text"
                                    placeholder="Buscar código o nombre"
                                    value={productQuery}
                                    onChange={(e) => setProductQuery(e.target.value)}
                                    autoFocus
                                    autoComplete="off"
                                  />
                                </div>
                                <div className="create-user__dropdown-results">
                                  {productLoading && <small className="muted">Buscando productos...</small>}
                                  {!productLoading && !productQuery.trim() && !productOptions.length && <small className="muted">Escribe para buscar.</small>}
                                  {!productLoading && productQuery.trim() && !productOptions.length && <small className="muted">Sin resultados.</small>}
                                  {productOptions.length > 0 && (
                                    <div className="create-salida__results-header">
                                      <span>Código</span><span>Nombre</span><span>Stock</span>
                                    </div>
                                  )}
                                  {productOptions.map((product) => {
                                    const isAlreadyAdded = details.some((d) => d.producto?.id && String(d.producto.id) === String(product.id))
                                    const isSelected = String(detailDraft.producto?.id) === String(product.id)
                                    return (
                                      <button
                                        key={product.id}
                                        type="button"
                                        className={`create-salida__result-row${isSelected ? ' is-selected' : ''}${isAlreadyAdded ? ' is-added' : ''}`}
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => { setDetailDraft({ producto: product, cantidad: '' }); setProductQuery(''); setShowProductDropdown(false); setProductOptions([]) }}
                                        disabled={isAlreadyAdded}
                                        title={isAlreadyAdded ? 'Ya agregado' : undefined}
                                      >
                                        <span className="result-codigo">{String(product.codigo || '').trim()}</span>
                                        <span className="result-nombre">{String(product.nombre || '').trim()}</span>
                                        <span className="result-stock">{Number(product.total_stock ?? 0)}</span>
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>,
                              getPortalRoot()
                            )}
                          </div>
                        </span>
                        <span className="create-salida__product-name-cell">
                          <span className="create-salida__table-static-value create-salida__table-static-value--name">
                            {detailDraft.producto ? String(detailDraft.producto.nombre || '').trim() : '-'}
                          </span>
                        </span>
                        <span className="create-salida__table-static-value">
                          {detailDraft.producto ? String(detailDraft.producto.oem || detailDraft.producto.referencia || '').trim() || '-' : '-'}
                        </span>
                        <span>
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={detailDraft.cantidad}
                            onChange={(e) => setDetailDraft((prev) => ({ ...prev, cantidad: e.target.value }))}
                            disabled={!detailDraft.producto}
                          />
                        </span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button
                            type="button"
                            className="create-user__ghost"
                            disabled={!canAddDetailDraft}
                            onClick={() => { if (!canAddDetailDraft) return; handleAddProduct(detailDraft.producto, detailDraft.cantidad); setDetailDraft({ producto: null, cantidad: '' }) }}
                          >
                            Agregar
                          </button>
                        </span>
                      </div>

                      {!details.length ? (
                        <div className="create-user__locations-row create-user__locations-row--empty"><span>Sin productos agregados.</span></div>
                      ) : details.map((item) => {
                        const sinCatalogo = !item.producto?.id
                        const codigo = item.producto?.codigo || item.codigo || '—'
                        const nombre = item.producto?.nombre || item.nombre || ''
                        const oem = String(item.producto?.oem || item.oem || item.producto?.referencia || '').trim() || '-'
                        return (
                          <div key={item._key} className={`create-user__locations-row${sinCatalogo ? ' importaciones-aceptados__row--no-catalogo' : ''}`}>
                            <span>
                              {codigo}
                              {sinCatalogo && <span className="importaciones-aceptados__no-catalogo-badge" style={{ marginLeft: 6 }}>Sin catálogo</span>}
                            </span>
                            <span title={nombre}><span className="create-salida__product-name-text">{nombre}</span></span>
                            <span>{oem}</span>
                            <span>
                              <input
                                type="number"
                                value={item.cantidad}
                                onChange={(e) => handleQuantityChange(item._key, e.target.value)}
                                style={invalidQtyKeys.has(item._key) ? { borderColor: '#ef4444' } : undefined}
                              />
                            </span>
                            <span className="create-user__locations-cell create-user__locations-cell--action">
                              <button
                                type="button"
                                className="create-user__locations-remove"
                                onClick={() => setDetails((prev) => prev.filter((d) => d._key !== item._key))}
                              >
                                x
                              </button>
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                )}
              </div>
            </div>

            <div className="create-user__footer">
              <div className="user-details__footer-left">
                <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose} disabled={submitting || importarSubmitting || deleteSubmitting}>
                  Cancelar
                </button>
                {imp?.estado === 'borrador' && (
                  <button
                    type="button"
                    className="create-user__action user-details__delete"
                    disabled={submitting || importarSubmitting || deleteSubmitting}
                    onClick={() => setShowDeleteModal(true)}
                  >
                    Eliminar
                  </button>
                )}
              </div>
              <div className="user-details__footer-right">
                <button
                  type="button"
                  className="create-user__action imp-importar-btn"
                  disabled={submitting || importarSubmitting || deleteSubmitting}
                  onClick={() => { setFacturaInput(''); setShowImportarModal(true) }}
                >
                  Importar
                </button>
                <button type="submit" className="create-user__action create-user__action--primary" disabled={submitting || importarSubmitting || deleteSubmitting}>
                  {submitting ? 'Guardando...' : 'Guardar cambios'}
                </button>
              </div>
            </div>
          </form>
        </div>

        {showImportarModal && createPortal(
          <div className="imp-importar-modal__overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !importarSubmitting) setShowImportarModal(false) }}>
            <div className="imp-importar-modal__dialog">
              <header className="imp-importar-modal__header">
                <i className="pi pi-send" />
                <h3>Estás por generar una importación</h3>
              </header>
              <div className="imp-importar-modal__body">
                <div className="imp-importar-modal__info">
                  <div className="imp-importar-modal__info-row">
                    <span>Casa comercial</span>
                    <strong>{imp.casa_comercial?.nombre || '-'}</strong>
                  </div>
                  <div className="imp-importar-modal__info-row">
                    <span>Tiempo estimado de entrega</span>
                    <strong>
                      {imp.casa_comercial?.dias_entrega
                        ? `${imp.casa_comercial.dias_entrega} día${imp.casa_comercial.dias_entrega === 1 ? '' : 's'}`
                        : 'No especificado'}
                    </strong>
                  </div>
                </div>
                <div className="imp-importar-modal__field">
                  <label htmlFor="imp-factura-input">Número de factura</label>
                  <input
                    id="imp-factura-input"
                    type="text"
                    className="imp-importar-modal__input"
                    placeholder="Ej: FAC-2024-001"
                    value={facturaInput}
                    onChange={(e) => setFacturaInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && facturaInput.trim()) handleImportar() }}
                    autoFocus
                    disabled={importarSubmitting}
                  />
                </div>
              </div>
              <div className="imp-importar-modal__footer">
                <button
                  type="button"
                  className="create-user__action create-user__action--cancel"
                  onClick={() => setShowImportarModal(false)}
                  disabled={importarSubmitting}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="create-user__action imp-importar-btn"
                  onClick={handleImportar}
                  disabled={!facturaInput.trim() || importarSubmitting}
                >
                  {importarSubmitting ? 'Importando...' : 'Importar'}
                </button>
              </div>
            </div>
          </div>,
          getPortalRoot()
        )}

        {showDeleteModal && createPortal(
          <div className="user-details__confirm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !deleteSubmitting) setShowDeleteModal(false) }}>
            <div className="user-details__confirm-dialog">
              <div className="user-details__confirm-icon">
                <Info size={18} />
              </div>
              <div className="user-details__confirm-content">
                <h4>Eliminar borrador</h4>
                <p>¿Estás seguro que quieres eliminar el borrador <strong>{imp?.codigo}</strong>? Esta acción no se puede deshacer.</p>
              </div>
              <div className="user-details__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--cancel"
                  onClick={() => setShowDeleteModal(false)}
                  disabled={deleteSubmitting}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="create-user__action user-details__confirm-danger"
                  onClick={handleDeleteBorrador}
                  disabled={deleteSubmitting}
                >
                  {deleteSubmitting ? 'Eliminando...' : 'Eliminar'}
                </button>
              </div>
            </div>
          </div>,
          getPortalRoot()
        )}

        {showAceptadosView && createPortal(
          <div className="imp-aceptados-popup__overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAceptadosView(false) }}>
            <div className="imp-aceptados-popup__dialog">
              <header className="imp-aceptados-popup__header">
                <div>
                  <h3>Aceptados de solicitudes</h3>
                  {selectedCasa?.nombre && <p>{formatCasaLabel(selectedCasa)}</p>}
                </div>
                <button type="button" className="imp-aceptados-popup__close" onClick={() => setShowAceptadosView(false)} aria-label="Cerrar">
                  <i className="pi pi-times" />
                </button>
              </header>
              <div className="imp-aceptados-popup__search">
                <i className="pi pi-search" />
                <input
                  type="text"
                  placeholder="Buscar por código, nombre, OEM o solicitud..."
                  value={aceptadosSearch}
                  onChange={(e) => setAceptadosSearch(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="imp-aceptados-popup__body">
                <div className="create-user__locations-table importaciones-aceptados__table">
                  <div className="create-user__locations-row create-user__locations-row--head">
                    <span>
                      <input type="checkbox" checked={allSelectableSelected} disabled={filteredAceptados.length === 0} onChange={handleToggleAllAceptados} title="Seleccionar todos" />
                    </span>
                    <span>Solicitud</span><span>Código JP</span><span>Nombre</span><span>OEMs</span><span>Cant.</span>
                  </div>
                  {aceptadosLoading && (
                    <div className="create-user__locations-row create-user__locations-row--empty"><span>Cargando...</span></div>
                  )}
                  {!aceptadosLoading && filteredAceptados.length === 0 && (
                    <div className="create-user__locations-row create-user__locations-row--empty">
                      <span>{aceptadosItems.length === 0 ? 'No hay productos aceptados.' : 'Sin resultados.'}</span>
                    </div>
                  )}
                  {!aceptadosLoading && filteredAceptados.map((item) => {
                    const noProducto = !item.producto_id
                    const isSelected = aceptadosSelected.has(item.solicitud_id)
                    const oemText = (item.oem_codigos || []).join(', ') || '-'
                    return (
                      <div
                        key={item.solicitud_id}
                        className={`create-user__locations-row importaciones-aceptados__row${isSelected ? ' importaciones-aceptados__row--selected' : ''}${noProducto ? ' importaciones-aceptados__row--no-catalogo' : ''}`}
                        style={{ cursor: 'pointer' }}
                        onClick={() => handleToggleAceptado(item.solicitud_id)}
                      >
                        <span>
                          <input type="checkbox" checked={isSelected} onChange={() => handleToggleAceptado(item.solicitud_id)} onClick={(e) => e.stopPropagation()} style={{ cursor: 'pointer' }} />
                        </span>
                        <span style={{ fontSize: '0.79rem', color: 'var(--color-muted, #888)' }}>
                          <span className="imp-cell-text">{item.solicitud_codigo || '-'}</span>
                        </span>
                        <span>
                          <span className="imp-cell-text">
                            {item.codigo || '-'}
                            {noProducto && <span className="importaciones-aceptados__no-catalogo-badge" title="Sin producto en catálogo">Sin catálogo</span>}
                          </span>
                        </span>
                        <span title={item.nombre}><span className="imp-cell-text">{item.nombre || '-'}</span></span>
                        <span style={{ fontSize: '0.8rem' }}><span className="imp-cell-text">{oemText}</span></span>
                        <span>{item.cantidad ?? '-'}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
              <div className="imp-aceptados-popup__footer">
                <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setShowAceptadosView(false)}>Regresar</button>
                <button type="button" className="create-user__action create-user__action--primary" disabled={aceptadosSelected.size === 0} onClick={handleConfirmAceptados}>
                  {aceptadosSelected.size > 0 ? `Agregar (${aceptadosSelected.size})` : 'Agregar'}
                </button>
              </div>
            </div>
          </div>,
          getPortalRoot()
        )}
      </div>
    </>
  )
}

function ImportacionesTable({ token, moduleActions, status: statusProp, isTabActive, onError, pendingOpenBorradorData, onPendingOpenBorradorHandled, pendingOpenDetailsId, pendingOpenDetailsStatus, onPendingOpenDetailsHandled }) {
  const toast = useRef(null)
  const tableWrapperRef = useRef(null)
  const _widthsClearedRef = useRef(null)
  if (_widthsClearedRef.current === null) {
    _widthsClearedRef.current = true
    clearSavedColumnWidths('importaciones-table-state')
  }

  const [activeStatus, setActiveStatus] = useState('borrador')
  const status = statusProp || activeStatus
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [selectedImp, setSelectedImp] = useState(null)
  const [showImpDetails, setShowImpDetails] = useState(false)
  const [editImp, setEditImp] = useState(null)
  const [showEditImp, setShowEditImp] = useState(false)

  useEffect(() => {
    if (!pendingOpenBorradorData) return
    setEditImp(pendingOpenBorradorData)
    setShowEditImp(true)
    onPendingOpenBorradorHandled?.()
  }, [pendingOpenBorradorData]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pendingOpenDetailsId || !token) return
    if (pendingOpenDetailsStatus && !statusProp) setActiveStatus(pendingOpenDetailsStatus)
    authFetch(`${API_URL}/importaciones/importaciones/${pendingOpenDetailsId}/`, {}, token)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data) => { setSelectedImp(data); setShowImpDetails(true); onPendingOpenDetailsHandled?.() })
      .catch(() => { onPendingOpenDetailsHandled?.() })
  }, [pendingOpenDetailsId]) // eslint-disable-line react-hooks/exhaustive-deps

  const [productHoverCard, setProductHoverCard] = useState(null)
  const productHoverHideTimerRef = useRef(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')
  const [isGlobalSearchPending, setIsGlobalSearchPending] = useState(false)
  const globalSearchDebounceRef = useRef(null)
  const [filters, setFilters] = useState({
    global: { value: null, matchMode: FilterMatchMode.CONTAINS },
  })
  const [pageFirst, setPageFirst] = useState(0)
  const pageSize = 25

  const statusConfig = STATUS_CONFIG[status] || STATUS_CONFIG.en_proceso
  const canCreate = moduleActions?.puede_crear !== false

  const normalizeList = useCallback((list) =>
    list.map((item) => {
      const detalles = item?.detalles || []
      const productos = detalles.map((d) => ({
        codigo: d.producto?.codigo || d.codigo || '-',
        nombre: d.producto?.nombre || d.nombre || '-',
        oem: d.producto?.oem || d.oem || '-',
        cantidad: d.cantidad ?? 0,
        sinCatalogo: !d.producto?.id,
      }))
      return {
        ...item,
        casa_nombre: item?.casa_comercial?.nombre ?? '-',
        productos_resumen: detalles.slice(0, 3).map((d) => `${d.producto?.codigo || d.codigo || 'Prod'} x${d.cantidad}`).join(', ') + (detalles.length > 3 ? ` +${detalles.length - 3}` : ''),
        productos,
      }
    })
  , [])

  const fetchItems = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    params.set('estado', status)
    params.set('page_size', '200')
    try {
      const response = await authFetch(`${API_URL}/importaciones/importaciones/?${params.toString()}`, {}, token)
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudieron cargar las importaciones.'))
      const payload = await response.json()
      setItems(normalizeList(parseApiList(payload)))
    } catch (err) {
      const message = err.message || 'No se pudieron cargar las importaciones.'
      setError(message)
      toast.current?.show({ severity: 'error', summary: 'Error', detail: message, life: 4000 })
    } finally {
      setLoading(false)
    }
  }, [normalizeList, status, token])

  useEffect(() => { fetchItems() }, [fetchItems])

  useEffect(() => {
    setPageFirst(0)
    setGlobalFilterValue('')
    setFilters({ global: { value: null, matchMode: FilterMatchMode.CONTAINS } })
  }, [status])

  const handleGlobalFilterChange = (event) => {
    const value = event.target.value
    setGlobalFilterValue(value)
    setPageFirst(0)
    if (globalSearchDebounceRef.current) clearTimeout(globalSearchDebounceRef.current)
    setIsGlobalSearchPending(true)
    globalSearchDebounceRef.current = setTimeout(() => {
      setFilters({ global: { value: value || null, matchMode: FilterMatchMode.CONTAINS } })
      setIsGlobalSearchPending(false)
    }, 350)
  }

  const handleStatusChange = (nextStatus) => {
    if (nextStatus === status) return
    setActiveStatus(nextStatus)
    setShowImpDetails(false)
  }

  const clearProductHoverTimer = useCallback(() => {
    if (!productHoverHideTimerRef.current) return
    clearTimeout(productHoverHideTimerRef.current)
    productHoverHideTimerRef.current = null
  }, [])

  const hideProductHoverCard = useCallback(() => {
    clearProductHoverTimer()
    setProductHoverCard(null)
  }, [clearProductHoverTimer])

  const scheduleHideProductHoverCard = useCallback(() => {
    clearProductHoverTimer()
    productHoverHideTimerRef.current = setTimeout(() => {
      productHoverHideTimerRef.current = null
      setProductHoverCard(null)
    }, 120)
  }, [clearProductHoverTimer])

  const showProductHoverCard = useCallback((event, productos) => {
    const list = Array.isArray(productos) ? productos : []
    if (!list.length) { hideProductHoverCard(); return }
    clearProductHoverTimer()
    const rect = event?.currentTarget?.getBoundingClientRect?.()
    if (!rect) return
    let left = rect.right + 10
    if (left + IMP_HOVER_WIDTH > window.innerWidth - IMP_HOVER_MARGIN) {
      left = Math.max(IMP_HOVER_MARGIN, rect.left - IMP_HOVER_WIDTH - 10)
    }
    const top = Math.min(Math.max(rect.top - 8, IMP_HOVER_MARGIN), Math.max(window.innerHeight - 320, IMP_HOVER_MARGIN))
    setProductHoverCard({ left, top, productos: list })
  }, [clearProductHoverTimer, hideProductHoverCard])

  useEffect(() => () => clearProductHoverTimer(), [clearProductHoverTimer])
  useEffect(() => {
    const handler = () => hideProductHoverCard()
    window.addEventListener('scroll', handler, true)
    return () => window.removeEventListener('scroll', handler, true)
  }, [hideProductHoverCard])

  const importacionProductBodyTemplate = useCallback((rowData) => {
    const productos = Array.isArray(rowData?.productos) ? rowData.productos : []
    if (!productos.length) return <span style={{ color: '#9ca3af' }}>-</span>
    const visible = productos.slice(0, 3)
    const hasMore = productos.length > 3
    const codesText = visible.map((p) => p.oem || p.codigo).join(', ') + (hasMore ? '...' : '')
    return (
      <div className="movimientos-table__product-cell">
        <div className="movimientos-table__product-lines">
          <span className="movimientos-table__product-main" title={codesText}>{codesText}</span>
        </div>
        <button
          type="button"
          className="movimientos-table__product-eye"
          aria-label="Ver productos"
          onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={(e) => showProductHoverCard(e, productos)}
          onMouseLeave={scheduleHideProductHoverCard}
          onFocus={(e) => showProductHoverCard(e, productos)}
          onBlur={scheduleHideProductHoverCard}
        >
          <i className="pi pi-eye" />
        </button>
      </div>
    )
  }, [showProductHoverCard, scheduleHideProductHoverCard])

  const estadoBodyTemplate = useCallback((rowData) => {
    const badge = STATUS_BADGE[rowData?.estado] || { label: rowData?.estado || '-', color: '#64748b', bg: 'rgba(100,116,139,0.1)' }
    return (
      <span style={{ fontWeight: 600, padding: '2px 9px', borderRadius: 999, background: badge.bg, color: badge.color, whiteSpace: 'nowrap' }}>
        {badge.label}
      </span>
    )
  }, [])

  const exportColumns = [
    { key: 'codigo', header: 'Importación' },
    { key: 'fecha', header: 'Fecha' },
    { key: 'casa_nombre', header: 'Casa comercial' },
    { key: 'estado_label', header: 'Estado' },
    { key: 'dias_entrega_estimados', header: 'Días estimados' },
    { key: 'prod_codigo', header: 'Código' },
    { key: 'prod_nombre', header: 'Nombre' },
    { key: 'prod_oem', header: 'OEM' },
    { key: 'prod_cantidad', header: 'Cantidad' },
  ]

  const buildExportRows = useCallback((rows) => {
    const result = []
    for (const row of rows) {
      const productos = row.productos || []
      const base = { ...row, estado_label: STATUS_BADGE[row.estado]?.label || row.estado || '' }
      if (!productos.length) {
        result.push(base)
      } else {
        for (const p of productos) {
          result.push({ ...base, prod_codigo: p.codigo, prod_nombre: p.nombre, prod_oem: p.oem, prod_cantidad: p.cantidad })
        }
      }
    }
    return result
  }, [])

  const getExportValue = useCallback((row, key) => row?.[key] ?? '', [])

  const handleExportExcel = useCallback(async () => {
    const rows = buildExportRows(items)
    await exportToExcel({ rows, columns: exportColumns, valueGetter: getExportValue, fileName: buildFileName('importaciones') })
  }, [buildExportRows, getExportValue, items])

  const handleExportPdf = useCallback(async () => {
    const rows = buildExportRows(items)
    await exportToPdf({ rows, columns: exportColumns, valueGetter: getExportValue, fileName: buildFileName('importaciones'), title: 'Reporte de importaciones' })
  }, [buildExportRows, getExportValue, items])

  const handleOpenBorrador = useCallback((borradorData) => {
    setShowCreate(false)
    setEditImp(borradorData)
    setShowEditImp(true)
  }, [])

  const handleRowDoubleClick = useCallback((event) => {
    const rowData = event?.data
    if (!rowData) return
    if (rowData.estado === 'borrador') {
      setEditImp(rowData)
      setShowEditImp(true)
    } else {
      setSelectedImp(rowData)
      setShowImpDetails(true)
    }
  }, [])

  const emptyMessage = loading ? ' ' : (error || statusConfig.empty)

  const header = (
    <div className="users-header">
      <div className="users-header__left">
        <div className="search-input-container">
          <input
            type="text"
            value={globalFilterValue}
            onChange={handleGlobalFilterChange}
            className="search-input"
            placeholder="Buscar en tabla"
          />
          <i className={`pi ${isGlobalSearchPending ? 'pi-spinner pi-spin' : 'pi-search'} search-input-icon`} />
        </div>
        <button
          className="rounded-icon-btn"
          type="button"
          onClick={fetchItems}
          disabled={loading}
          title="Recargar"
        >
          <i className="pi pi-refresh" />
        </button>
      </div>
      <div className="users-header__right">
        <span className="users-header__count">Reg. {items.length}</span>
        <button className="rounded-icon-btn" type="button" onClick={handleExportExcel} title="Exportar Excel" disabled={!items.length}>
          <i className="pi pi-file-excel" />
        </button>
        <button className="rounded-icon-btn" type="button" onClick={handleExportPdf} title="Exportar PDF" disabled={!items.length}>
          <i className="pi pi-file-pdf" />
        </button>
      </div>
    </div>
  )

  return (
    <div className="users-page">
      <Toast
        ref={toast}
        baseZIndex={12050}
        appendTo={typeof document !== 'undefined' ? document.body : undefined}
      />

      <div className="users-page__top">
        <div className="users-page__actions">
          {canCreate && (
            <Button
              label="Crear"
              icon="pi pi-plus"
              className="users-topbtn users-topbtn--create"
              onClick={() => setShowCreate(true)}
              type="button"
            />
          )}
          {!statusProp && (
            <div className="transfer-issues-page__type-filter" role="group" aria-label="Filtro de estado">
              {[
                { key: 'borrador', label: 'Borradores' },
                { key: 'en_camino', label: 'En camino' },
                { key: 'importada', label: 'Importadas' },
              ].map((option) => (
                <Button
                  key={option.key}
                  label={option.label}
                  type="button"
                  className={`users-topbtn transfer-issues-page__type-btn${status === option.key ? ' transfer-issues-page__type-btn--active' : ''}`}
                  onClick={() => handleStatusChange(option.key)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="users-table users-table--card users-table--compact" ref={tableWrapperRef}>
        {loading && (
          <div className="spinner-container spinner-container--table">
            <div className="spinner" />
          </div>
        )}
        {error && !loading && (
          <div className="stale-data-msg">
            <i className="pi pi-exclamation-circle" style={{ fontSize: '0.8rem', margin: 0, color: 'white' }} />
            <span><strong>Los datos pueden estar desactualizados</strong> | intenta recargar la tabla</span>
          </div>
        )}

        <DataTable
          value={items}
          dataKey="id"
          header={header}
          className={`users-datatable users-datatable--compact${loading ? ' users-datatable--loading-content' : ''}`}
          stateStorage="local"
          stateKey="importaciones-table-state"
          tableStyle={{ width: '100%' }}
          emptyMessage={emptyMessage}
          showGridlines
          size="small"
          scrollable
          scrollHeight="flex"
          paginator
          first={pageFirst}
          rows={pageSize}
          rowsPerPageOptions={[10, 25, 50]}
          onPage={(e) => setPageFirst(e.first)}
          filters={filters}
          globalFilterFields={['codigo', 'fecha', 'casa_nombre', 'productos_resumen']}
          removableSort
          reorderableColumns
          resizableColumns
          columnResizeMode="expand"
          onRowDoubleClick={handleRowDoubleClick}
          rowClassName={(rowData) => ({ 'p-selectable-row': true, 'imp-row--borrador': rowData.estado === 'borrador' })}
        >
          <Column
            field="codigo"
            header="Código"
            sortable
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '120px' }}
          />
          <Column
            field="fecha"
            header="Fecha"
            sortable
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '100px' }}
          />
          <Column
            field="casa_nombre"
            header="Casa comercial"
            sortable
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '150px' }}
          />
          <Column
            field="estado"
            header="Estado"
            sortable
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '110px' }}
            body={estadoBodyTemplate}
          />
          <Column
            field="dias_entrega_estimados"
            header="Días est."
            sortable
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '90px' }}
            body={(row) => (row.dias_entrega_estimados != null ? `${row.dias_entrega_estimados} d` : '-')}
          />
          <Column
            field="productos_resumen"
            header="Productos"
            reorderable
            className="column-max-min-width"
            style={{ minWidth: '180px' }}
            body={importacionProductBodyTemplate}
          />
        </DataTable>
      </div>

      <ImportacionDetailsModal
        imp={showImpDetails && isTabActive !== false ? selectedImp : null}
        token={token}
        onClose={() => setShowImpDetails(false)}
        onSaved={() => { setShowImpDetails(false); fetchItems() }}
      />

      {Array.isArray(productHoverCard?.productos) && productHoverCard.productos.length > 0 && createPortal(
        <div
          className="movimientos-table__product-hover-card movimientos-table__product-hover-card--wide"
          role="tooltip"
          style={{ top: productHoverCard.top, left: productHoverCard.left, width: IMP_HOVER_WIDTH }}
          onMouseEnter={clearProductHoverTimer}
          onMouseLeave={scheduleHideProductHoverCard}
        >
          <div className="movimientos-table__product-hover-title">Productos</div>
          <table className="movimientos-table__product-hover-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <colgroup>
              <col style={{ width: '100px' }} />
              <col />
              <col style={{ width: '120px' }} />
              <col style={{ width: '52px' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Código</th>
                <th>Nombre</th>
                <th>OEM</th>
                <th className="movimientos-table__product-hover-qty">Cant.</th>
              </tr>
            </thead>
            <tbody>
              {productHoverCard.productos.map((p, i) => (
                <tr key={i}>
                  <td title={p.codigo}>{p.codigo}</td>
                  <td title={p.nombre}>{p.nombre}</td>
                  <td title={p.oem}>{p.oem}</td>
                  <td className="movimientos-table__product-hover-qty">{p.cantidad}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
        getPortalRoot()
      )}

      <EditImportacionModal
        open={showEditImp}
        imp={editImp}
        token={token}
        onClose={() => setShowEditImp(false)}
        onSaved={() => { setShowEditImp(false); fetchItems() }}
        onOpenBorrador={handleOpenBorrador}
      />

      <CreateImportacionModal
        open={showCreate}
        token={token}
        onClose={() => setShowCreate(false)}
        onError={onError}
        onCreated={() => {
          setShowCreate(false)
          if (status === 'borrador') {
            fetchItems()
          } else {
            setActiveStatus('borrador')
          }
        }}
        onOpenBorrador={handleOpenBorrador}
      />
    </div>
  )
}

export default ImportacionesTable
