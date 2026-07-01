import { unzipSync, zipSync } from 'fflate'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import StaticFieldDisplay from '../movimientos/StaticFieldDisplay'
import { FilterMatchMode } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Button } from 'primereact/button'
import { Check, Info, PackagePlus, Plus, Search, Trash2, X } from 'lucide-react'
import { Checkbox } from 'primereact/checkbox'
import { API_URL, authFetch } from '../../../utils/api'
import { autoFitTableColumns, makeWidthStateHandlers } from '../../../utils/autoFitColumns'
import { buildFileName, exportToExcel, exportToPdf } from '../../../utils/exportUtils'
import '../admin/CreateUsuario/CreateUsuario.css'
import '../admin/UsersDetails/UsersDetails.css'
import '../admin/UsersTable/UsersTable.css'
import '../movimientos/CreateSalida.css'
import '../QuickActions/QuickActions.css'
import './ImportacionesTable.css'

const getPortalRoot = () => document.querySelector('.dashboard-shell') || getPortalRoot()

const STATUS_CONFIG = {
  borrador: { label: 'Sugerencia', empty: 'No hay importaciones en sugerencia.' },
  cotizacion: { label: 'Verificar', empty: 'No hay importaciones en verificación.' },
  confirmacion: { label: 'Confirmación', empty: 'No hay importaciones en confirmación.' },
  en_camino: { label: 'En camino', empty: 'No hay importaciones en camino.' },
  importada: { label: 'Importadas', empty: 'No hay importaciones importadas.' },
}

const IMP_HOVER_WIDTH = 560
const IMP_HOVER_MARGIN = 12

const STATUS_BADGE = {
  borrador: { label: 'Sugerencia', color: '#64748b', bg: 'rgba(100,116,139,0.1)' },
  cotizacion: { label: 'Verificar', color: '#92640c', bg: 'rgba(234,179,8,0.22)' },
  confirmacion: { label: 'Confirmación', color: '#6d28d9', bg: 'rgba(109,40,217,0.12)' },
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
  const [step, setStep] = useState(() => {
    const saved = JSON.parse(localStorage.getItem(`imp-receive-${imp.id}`) || 'null')
    return saved?.step || 1
  })
  const [sucursales, setSucursales] = useState([])
  const [loadingSucursales, setLoadingSucursales] = useState(false)
  const [distribution, setDistribution] = useState(() => {
    const saved = JSON.parse(localStorage.getItem(`imp-receive-${imp.id}`) || 'null')
    return saved?.distribution || {}
  })
  const [allUsers, setAllUsers] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [recipientsBySucursal, setRecipientsBySucursal] = useState({})

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

  // Auto-load sucursales if modal is restored at step 3 or 4
  useEffect(() => {
    if (step < 3 || loadingSucursales || sucursales.length > 0) return
    setLoadingSucursales(true)
    authFetch(`${API_URL}/inventario/sucursales/?modulo=movimientos_entradas`, {}, token)
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        const list = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : []
        setSucursales(list)
      })
      .catch(() => {})
      .finally(() => setLoadingSucursales(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-load users if modal is restored at step 4
  useEffect(() => {
    if (step !== 4 || allUsers.length > 0) return
    enterStep4()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const checkedIds = rows.filter(r => r.checked).map(r => r.id)
    localStorage.setItem(storageKey, JSON.stringify({ checkedIds, step, distribution }))
  }, [rows, step, distribution, storageKey])

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

  const sucursalesWithDistribution = useMemo(() =>
    sucursales
      .map(suc => ({
        ...suc,
        items: rows
          .filter(row => parseInt(distribution[row.id]?.[suc.id]) > 0)
          .map(row => ({ ...row, qty: parseInt(distribution[row.id][suc.id]) })),
      }))
      .filter(suc => suc.items.length > 0),
    [sucursales, rows, distribution]
  )

  const canConfirmStep4 = useMemo(() =>
    sucursalesWithDistribution.length > 0 &&
    sucursalesWithDistribution.every(suc => (recipientsBySucursal[suc.id] || []).length > 0),
    [sucursalesWithDistribution, recipientsBySucursal]
  )

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
    if (form.costo_minimo && !isNaN(parseFloat(form.costo_minimo)) && !isNaN(parseFloat(form.precio)) && parseFloat(form.precio) <= parseFloat(form.costo_minimo)) errs.precio = 'El precio debe ser mayor al costo'
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

  const enterStep4 = async () => {
    setStep(4)
    if (allUsers.length > 0) return
    setLoadingUsers(true)
    try {
      const collected = []
      let url = `${API_URL}/usuarios/listado/destinatarios/?page_size=200`
      while (url) {
        const resp = await authFetch(url, {}, token)
        if (!resp.ok) break
        const data = await resp.json().catch(() => ({}))
        const items = Array.isArray(data) ? data : (data.results || [])
        collected.push(...items)
        url = Array.isArray(data) ? null : (data.next || null)
      }
      setAllUsers(collected.map(u => ({
        id: u.id,
        name: [u.nombres || u.nombre, u.apellidos || u.apellido].filter(Boolean).join(' ').trim() || u.correo || 'Usuario',
        es_admin: Boolean(u.es_administrador),
        sucursales_ids: (u.sucursales || []).map(s => s.id),
        entradas_sucursales_ids: (u.sucursales_por_modulo || [])
          .filter(scope => scope.modulo === 'movimientos_entradas')
          .flatMap(scope => scope.sucursales_ids || []),
        puede_entradas: (u.permisos_resumen || []).some(p =>
          p.modulo === 'movimientos_entradas' && (p.puede_crear || p.puede_actualizar || p.puede_leer)
        ),
      })))
    } catch {}
    setLoadingUsers(false)
  }

  const toggleRecipient = useCallback((sucursalId, userId) => {
    setRecipientsBySucursal(prev => {
      const current = prev[sucursalId] || []
      const has = current.includes(userId)
      return { ...prev, [sucursalId]: has ? current.filter(id => id !== userId) : [...current, userId] }
    })
  }, [])

  const handleConfirm = async () => {
    if (!canFinish) { setShowErrors(true); return }
    setSubmitting(true)
    try {
      const distribuciones = rows.flatMap(row =>
        Object.entries(distribution[row.id] || {})
          .filter(([, v]) => parseInt(v) > 0)
          .map(([sucursalId, qty]) => ({ detalle_id: row.id, sucursal_id: parseInt(sucursalId), cantidad: parseInt(qty) }))
      )
      const destinatarios_por_sucursal = Object.entries(recipientsBySucursal)
        .filter(([, ids]) => ids.length > 0)
        .map(([sucursalId, ids]) => ({ sucursal_id: parseInt(sucursalId), user_ids: ids }))
      const resp = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/marcar-llegada/`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ distribuciones, destinatarios_por_sucursal }) },
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
          style={{ width: step === 3 ? 'min(860px, 95vw)' : step === 4 ? 'min(700px, 95vw)' : 'min(640px, 90vw)', gridTemplateRows: 'auto 1fr auto', transition: 'width .25s' }}
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
                {[1,2,3,4].map(n => (
                  <div key={n} style={{ flex: 1, height: 3, borderRadius: 2, background: step >= n ? 'var(--color-primary, #2563eb)' : 'var(--color-border, #e2e8f0)', transition: 'background .3s' }} />
                ))}
              </div>
              <span style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
                Paso {step} de 4 — {step === 1 ? 'Productos nuevos' : step === 2 ? 'Revisión de llegada' : step === 3 ? 'Distribución a sucursales' : 'Destinatarios del envío'}
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
            ) : step === 3 ? (
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
                  <div style={{ overflowX: 'auto', padding: '4px 16px 8px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid var(--color-border, #e2e8f0)' }}>
                          <th style={{ textAlign: 'left', padding: '6px 12px 8px 0', fontWeight: 600, color: 'var(--color-text-secondary)', minWidth: 140 }}>Producto</th>
                          <th style={{ textAlign: 'center', padding: '6px 8px 8px', fontWeight: 600, color: 'var(--color-text-secondary)', width: 60, whiteSpace: 'nowrap' }}>Total</th>
                          {sucursales.map(suc => (
                            <th key={suc.id} style={{ textAlign: 'center', padding: '6px 6px 8px', fontWeight: 600, color: 'var(--color-text-secondary)', width: 72 }}>
                              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 72 }} title={suc.nombre}>{suc.nombre}</span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, i) => {
                          const rowDist = distribution[row.id] || {}
                          const assigned = Object.values(rowDist).reduce((s, v) => s + (parseInt(v) || 0), 0)
                          const isComplete = assigned === row.cantidad
                          const isOver = assigned > row.cantidad
                          return (
                            <tr key={row.id} style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--color-border, #e2e8f0)' : 'none', background: isComplete ? 'rgba(22,163,74,0.05)' : 'transparent', transition: 'background .2s' }}>
                              <td style={{ padding: '10px 12px 10px 0', verticalAlign: 'middle' }}>
                                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{row.nombre || row.codigo || '-'}</div>
                                {row.nombre && row.codigo && <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>{row.codigo}</div>}
                              </td>
                              <td style={{ textAlign: 'center', padding: '10px 8px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                                <span style={{ fontWeight: 700, fontSize: '0.82rem', color: isOver ? '#dc2626' : isComplete ? '#16a34a' : 'var(--color-text-secondary)' }}>{assigned}/{row.cantidad}</span>
                              </td>
                              {sucursales.map(suc => (
                                <td key={suc.id} style={{ textAlign: 'center', padding: '8px 6px', verticalAlign: 'middle' }}>
                                  <input
                                    type="number" min="0" max={row.cantidad}
                                    value={rowDist[suc.id] ?? ''}
                                    disabled={(isComplete || isOver) && !(parseInt(rowDist[suc.id]) > 0)}
                                    onChange={(e) => setDistribution(prev => ({ ...prev, [row.id]: { ...(prev[row.id] || {}), [suc.id]: e.target.value } }))}
                                    style={{ width: 60, textAlign: 'center', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 6, padding: '4px 6px', fontSize: '0.85rem', background: (isComplete || isOver) && !(parseInt(rowDist[suc.id]) > 0) ? 'var(--color-surface, #f8fafc)' : 'var(--modal-color, #fff)', color: 'inherit', cursor: (isComplete || isOver) && !(parseInt(rowDist[suc.id]) > 0) ? 'not-allowed' : 'text', opacity: (isComplete || isOver) && !(parseInt(rowDist[suc.id]) > 0) ? 0.4 : 1 }}
                                  />
                                </td>
                              ))}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              /* ── PASO 4: destinatarios por sucursal ── */
              <div className="quick-actions__receive-step quick-actions__receive-step--list" style={{ '--receive-list-received-column': '0px' }}>
                <article className="quick-actions__receive-stage quick-actions__receive-stage--list">
                  <div className="quick-actions__receive-stage-copy">
                    <p className="quick-actions__receive-stage-kicker">Paso 4 — Destinatarios del envío</p>
                    <h5>¿Quién recibirá cada envío?</h5>
                    <p className="quick-actions__receive-stage-name">Selecciona los usuarios que recibirán la notificación del envío en camino para cada sucursal. Este paso es opcional.</p>
                  </div>
                </article>

                {loadingUsers ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0', gap: 12 }}>
                    <svg style={{ animation: 'spin 0.8s linear infinite', width: 20, height: 20, flexShrink: 0 }} viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Cargando usuarios...</span>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 16px 8px' }}>
                    {sucursalesWithDistribution.map(suc => {
                      const usersForSuc = allUsers.filter(u => {
                          if (u.es_admin) return false
                          if (!u.puede_entradas) return false
                          return u.entradas_sucursales_ids.includes(suc.id) || u.sucursales_ids.includes(suc.id)
                        })
                      const selectedIds = recipientsBySucursal[suc.id] || []
                      return (
                        <div key={suc.id} style={{ background: 'var(--color-surface, #f8fafc)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 10, padding: '12px 14px' }}>
                          <div style={{ fontWeight: 700, fontSize: '0.88rem', marginBottom: 8 }}>{suc.nombre}</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                            {suc.items.map(item => (
                              <span key={item.id} style={{ fontSize: '0.75rem', background: 'var(--color-primary-light, #dbeafe)', color: 'var(--color-primary, #2563eb)', borderRadius: 4, padding: '2px 8px', fontWeight: 500 }}>
                                {item.nombre || item.codigo} · {item.qty} u.
                              </span>
                            ))}
                          </div>
                          {usersForSuc.length === 0 ? (
                            <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', margin: 0 }}>No hay destinatarios disponibles para esta sucursal.</p>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                              {usersForSuc.map(u => (
                                <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.82rem' }}>
                                  <input type="checkbox" checked={selectedIds.includes(u.id)} onChange={() => toggleRecipient(suc.id, u.id)} style={{ width: 15, height: 15, cursor: 'pointer' }} />
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
            ) : step === 3 ? (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep(2)} disabled={submitting}>Atrás</button>
                <button type="button" className={`quick-actions__receive-btn${canFinish ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`} onClick={enterStep4} disabled={!canFinish}>Siguiente</button>
              </>
            ) : (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep(3)} disabled={submitting}>Atrás</button>
                <button type="button" className={`quick-actions__receive-btn${canConfirmStep4 ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`} onClick={handleConfirm} disabled={submitting || !canConfirmStep4}>
                  {submitting ? 'Confirmando...' : 'Confirmar llegada y enviar a sucursales'}
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
                    <span>Costo</span>
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

function ImportacionDetailsModal({ imp, token, onClose, onSaved, moduleActions }) {
  const canMarcarLlegada = moduleActions?.puede_marcar_llegada === true
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
                    <div className="create-user__locations-row create-user__locations-row--head imp-details__productos-row">
                      <span>Código</span><span>Nombre</span><span>OEM</span><span>Referencia</span><span>Precio</span><span>Cantidad</span>
                    </div>
                    {!detalles.length ? (
                      <div className="create-user__locations-row create-user__locations-row--empty imp-details__productos-row" style={{ gridTemplateColumns: '1fr' }}><span>Sin productos.</span></div>
                    ) : detalles.map((d, i) => {
                      const sinCat = !d.producto?.id
                      const codigo = d.producto?.codigo || d.codigo || '-'
                      const nombre = d.producto?.nombre || d.nombre || '-'
                      const oem = String(d.producto?.oem || d.oem || '').trim() || '-'
                      const referencia = String(d.producto?.referencia || d.referencia || '').trim() || '-'
                      const precio = d.precio_confirmado != null ? `$${Number(d.precio_confirmado).toFixed(2)}` : '-'
                      const cantidad = d.cantidad_confirmada ?? d.cantidad ?? '-'
                      return (
                        <div key={d.id ?? i} className={`create-user__locations-row imp-details__productos-row${sinCat ? ' importaciones-aceptados__row--no-catalogo' : ''}`}>
                          <span title={codigo}>
                            {sinCat ? <span className="importaciones-aceptados__no-catalogo-badge">Sin catálogo</span> : <span className="imp-cell-text">{codigo}</span>}
                          </span>
                          <span title={nombre}><span className="imp-cell-text">{nombre}</span></span>
                          <span>{oem}</span>
                          <span>{referencia}</span>
                          <span>{precio}</span>
                          <span style={{ justifyContent: 'center', fontWeight: 600 }}>{cantidad}</span>
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
            {imp.estado === 'en_camino' && canMarcarLlegada && (
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

function ImportacionExcelModal({ token, onClose, onCreated }) {
  const isDark = Boolean(document.querySelector('.dashboard-shell')?.classList.contains('dark'))
  const mode = isDark ? 'dark' : 'light'
  const toastRef = useRef(null)

  const [step, setStep] = useState('casa')
  const [downloading, setDownloading] = useState(false)

  // Casa step
  const [casaDraft, setCasaDraft] = useState(null)
  const [selectedCasa, setSelectedCasa] = useState(null)
  const [casaQuery, setCasaQuery] = useState('')
  const [casaOptions, setCasaOptions] = useState([])
  const [casaLoading, setCasaLoading] = useState(false)
  const [showCasaDropdown, setShowCasaDropdown] = useState(false)
  const casaTimerRef = useRef(null)
  const casaModalRef = useRef(null)
  const casaModalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const [casaModalPos, setCasaModalPos] = useState({ x: 0, y: 0 })
  const casaDropdownRef = useRef(null)
  const [casaPanelStyle, setCasaPanelStyle] = useState(null)

  // Step 2: file upload
  const fileInputRef = useRef(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState('')

  // Step 3
  const [parsedRows, setParsedRows] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  useLayoutEffect(() => {
    if (step !== 'casa') return
    const w = Math.min(SELECTOR_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2)
    const h = casaModalRef.current?.offsetHeight || (casaDraft ? 380 : 200)
    setCasaModalPos({
      x: Math.max((window.innerWidth - w) / 2, VIEWPORT_PADDING),
      y: Math.max((window.innerHeight - h) / 2, VIEWPORT_PADDING),
    })
  }, [step, casaDraft])

  useLayoutEffect(() => {
    if (!showCasaDropdown || !casaDropdownRef.current) { setCasaPanelStyle(null); return }
    const rect = casaDropdownRef.current.getBoundingClientRect()
    setCasaPanelStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.min(260, window.innerHeight - rect.bottom - 8),
      zIndex: 9999,
    })
  }, [showCasaDropdown, casaModalPos])

  useEffect(() => {
    const handleMove = (e) => {
      if (!casaModalDrag.current.active) return
      e.preventDefault()
      const w = casaModalRef.current?.offsetWidth || SELECTOR_WIDTH
      const h = casaModalRef.current?.offsetHeight || 200
      setCasaModalPos({
        x: Math.min(Math.max(e.clientX - casaModalDrag.current.offsetX, VIEWPORT_PADDING), window.innerWidth - w - VIEWPORT_PADDING),
        y: Math.min(Math.max(e.clientY - casaModalDrag.current.offsetY, VIEWPORT_PADDING), window.innerHeight - h - VIEWPORT_PADDING),
      })
    }
    const handleUp = () => { casaModalDrag.current.active = false }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => { window.removeEventListener('mousemove', handleMove); window.removeEventListener('mouseup', handleUp) }
  }, [])

  useEffect(() => {
    const handleMouseDown = (e) => {
      const inCasa = casaDropdownRef.current?.contains(e.target) || e.target.closest?.('[data-casa-portal]')
      if (!inCasa) setShowCasaDropdown(false)
    }
    const handleKeyDown = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  useEffect(() => {
    if (!showCasaDropdown && step !== 'casa') return
    clearTimeout(casaTimerRef.current)
    setCasaLoading(true)
    casaTimerRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ page_size: '10', tipo: 'importacion' })
        if (casaQuery.trim()) params.set('search', casaQuery.trim())
        const resp = await authFetch(`${API_URL}/casa-comercial/casas/?${params}`, {}, token)
        const data = resp.ok ? await resp.json().catch(() => ({})) : {}
        setCasaOptions(Array.isArray(data.results) ? data.results : [])
      } catch {}
      setCasaLoading(false)
    }, 280)
    return () => clearTimeout(casaTimerRef.current)
  }, [casaQuery, token, showCasaDropdown, step])

  const handleCasaHeaderMouseDown = (e) => {
    if (!casaModalRef.current) return
    const rect = casaModalRef.current.getBoundingClientRect()
    casaModalDrag.current = { active: true, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top }
  }

  const handleDownloadTemplate = async () => {
    setDownloading(true)
    try {
      const XLSXStyle = (await import('xlsx-js-style')).default
      // Sugerencia template: no sucursal columns
      const headers = ['CODIGO JP', 'REFERENCIA', 'OEM', 'DESCRIPCIÓN', 'CANTIDAD', 'PVP']
      const colCount = headers.length
      // 0-3 = text (@), 4 = integer (0), 5 = decimal (0.00)
      const colFormat = (ci) => ci === 4 ? '0' : ci === 5 ? '0.00' : '@'
      const headerStyle = {
        font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
        fill: { fgColor: { rgb: '1A1A2E' }, patternType: 'solid' },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: {
          top: { style: 'thin', color: { rgb: '2563EB' } },
          bottom: { style: 'medium', color: { rgb: '2563EB' } },
          left: { style: 'thin', color: { rgb: '2563EB' } },
          right: { style: 'thin', color: { rgb: '2563EB' } },
        },
      }
      const ROWS = 2000
      const borderStyle = { style: 'thin', color: { rgb: 'DBEAFE' } }
      const border = { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle }
      const baseEven = { fill: { fgColor: { rgb: 'EFF6FF' }, patternType: 'solid' }, alignment: { vertical: 'center' }, border }
      const baseOdd  = { fill: { fgColor: { rgb: 'FFFFFF' }, patternType: 'solid' }, alignment: { vertical: 'center' }, border }
      const aoa = [headers, ...Array.from({ length: ROWS }, () => Array(colCount).fill(''))]
      const worksheet = XLSXStyle.utils.aoa_to_sheet(aoa)
      headers.forEach((_, ci) => {
        const ref = XLSXStyle.utils.encode_cell({ r: 0, c: ci })
        if (worksheet[ref]) worksheet[ref].s = headerStyle
      })
      for (let ri = 1; ri <= ROWS; ri++) {
        const base = ri % 2 === 0 ? baseEven : baseOdd
        for (let ci = 0; ci < colCount; ci++) {
          const ref = XLSXStyle.utils.encode_cell({ r: ri, c: ci })
          if (!worksheet[ref]) worksheet[ref] = { t: 's', v: '' }
          worksheet[ref].s = { ...base, numFmt: colFormat(ci) }
        }
      }
      worksheet['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 32 }, { wch: 11 }, { wch: 10 }]
      worksheet['!rows'] = [{ hpt: 22 }]
      const workbook = XLSXStyle.utils.book_new()
      XLSXStyle.utils.book_append_sheet(workbook, worksheet, 'Importación')
      const out = XLSXStyle.write(workbook, { bookType: 'xlsx', type: 'array' })
      const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = 'plantilla-sugerencia.xlsx'
      document.body.appendChild(link); link.click(); document.body.removeChild(link)
      URL.revokeObjectURL(link.href)
    } catch (e) { console.error(e) }
    setDownloading(false)
  }

  const handleFileSelect = (file) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.xlsx')) { setParseError('El archivo debe ser formato .xlsx'); return }
    setSelectedFile(file)
    setParseError('')
  }

  const handleProcess = async () => {
    setParseError('')
    setParsing(true)
    try {
      const formData = new FormData()
      formData.append('file', selectedFile)
      formData.append('casa_comercial_id', selectedCasa.id)
      const resp = await fetch(`${API_URL}/importaciones/importaciones/parse-excel/`, {
        method: 'POST',
        headers: { Authorization: `Token ${token}` },
        body: formData,
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(data.detail || 'Error al procesar el archivo.')
      setParsedRows(data.rows || [])
      setSubmitError('')
      setStep(3)
    } catch (e) {
      setParseError(e.message)
    } finally {
      setParsing(false)
    }
  }

  const handleCreate = async () => {
    setSubmitError('')
    setSubmitting(true)
    try {
      const detalles = parsedRows
        .filter(row => !row.conflicto_casa)
        .map(row =>
          row.matched_producto_id
            ? { producto_id: row.matched_producto_id, cantidad: row.cantidad }
            : { codigo: row.codigo, nombre: row.descripcion, referencia: row.referencia, oem: row.oem, cantidad: row.cantidad }
        )
      const resp = await authFetch(
        `${API_URL}/importaciones/importaciones/`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ casa_comercial_id: selectedCasa.id, detalles }) },
        token
      )
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(data.detail || 'No se pudo crear la importación.')
      onCreated?.(data)
      onClose()
    } catch (e) {
      setSubmitError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const canProcess = Boolean(selectedFile && selectedCasa)
  const conflictoRows = parsedRows.filter(r => r.conflicto_casa)
  const validRows = parsedRows.filter(r => !r.conflicto_casa)
  const matchedCount = validRows.filter(r => r.matched_producto_id).length
  const unmatchedCount = validRows.filter(r => !r.matched_producto_id).length

  const stepLabel = step === 1 ? 'Descarga la plantilla' : step === 2 ? 'Sube el archivo' : 'Revisa los productos'
  const portalRoot = document.querySelector('.dashboard-shell') || document.body

  if (step === 'casa') {
    return createPortal(
      <>
        <Toast ref={toastRef} />
        <div className="create-user__overlay" role="dialog" aria-modal="true" style={{ zIndex: 2100 }}>
          <div
            ref={casaModalRef}
            className="create-user__modal importaciones-modal--selector"
            style={{ top: casaModalPos.y, left: casaModalPos.x, width: SELECTOR_WIDTH }}
          >
            <header className="create-user__header" onMouseDown={handleCasaHeaderMouseDown}>
              <div className="create-user__header-text">
                <h3>Sugerencia desde Excel</h3>
              </div>
              <div className="create-user__header-actions">
                <button
                  type="button"
                  className="create-user__icon-button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={onClose}
                  aria-label="Cerrar"
                >
                  <i className="pi pi-times" aria-hidden="true" />
                </button>
              </div>
            </header>

            <form className="create-user__form importaciones-modal__selector-form" noValidate onSubmit={(e) => e.preventDefault()}>
              <div className="create-salida__selector-shell" style={{ flex: 'none', overflow: 'visible' }}>
                <section className="create-user__section create-salida__selector-card">
                  <div className="create-user__section-header">
                    <div>
                      <h4>Selecciona la casa comercial</h4>
                    </div>
                  </div>
                  <div className="create-salida__selector-inner">
                    <div className="create-user__field create-salida__selector-field">
                      <div className="create-user__dropdown" ref={casaDropdownRef} style={{ width: '100%' }}>
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
                            onChange={(e) => { setCasaQuery(e.target.value); setCasaDraft(null); setShowCasaDropdown(true) }}
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
                              <small className="muted">{casaQuery.trim() ? 'Sin resultados.' : 'Escribe para buscar.'}</small>
                            )}
                            {casaOptions.map((casa) => (
                              <button
                                key={casa.id}
                                type="button"
                                className="create-user__result-option"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => { setCasaDraft(casa); setCasaQuery(''); setShowCasaDropdown(false); setCasaOptions([]) }}
                              >
                                <div className="create-user__result-info">
                                  <strong>{String(casa?.nombre || '').trim()}</strong>
                                  <small>
                                    {[String(casa?.codigo || '').trim(), String(casa?.pais?.nombre || '').trim()].filter(Boolean).join(' · ')}
                                  </small>
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>,
                        portalRoot
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

              <div className="create-user__footer">
                <div className="user-details__footer-left">
                  <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose}>Cancelar</button>
                </div>
                <div className="user-details__footer-right">
                  <button
                    type="button"
                    className="create-user__action create-user__action--primary"
                    disabled={!casaDraft}
                    onClick={() => { setSelectedCasa(casaDraft); setStep(1) }}
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </>,
      portalRoot
    )
  }

  return createPortal(
    <>
      <Toast ref={toastRef} />
      <div
        className={`quick-actions__receive-overlay ${mode}`}
        style={{ zIndex: 2100 }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      >
        <div
          className={`quick-actions__receive-dialog ${mode}`}
          style={{ width: step === 3 ? 'min(720px, 95vw)' : 'min(540px, 92vw)', height: 'auto', maxHeight: '90vh', gridTemplateRows: 'auto 1fr auto', transition: 'width .25s' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="quick-actions__receive-head">
            <div>
              <h4>Sugerencia desde Excel</h4>
              <p style={{ fontSize: '0.7rem', fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                Paso {step} de 3 — {stepLabel}
              </p>
            </div>
            <button type="button" className="quick-actions__receive-close" onClick={onClose}><X size={16} /></button>
          </header>

          <div className="quick-actions__receive-body" style={{ padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>

            {/* ── PASO 1: Descargar ── */}
            {step === 1 && (
              <>
                <p style={{ fontSize: '0.84rem', color: 'var(--color-text-secondary)', margin: 0 }}>
                  Descarga la plantilla y rellénala con los productos a sugerir. No incluye columnas de sucursales.
                </p>
                <div style={{ background: 'var(--color-surface, #f8fafc)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 10, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <strong style={{ fontSize: '0.85rem' }}>Columnas de la plantilla</strong>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {[
                      { label: 'CODIGO JP', type: 'texto' }, { label: 'REFERENCIA', type: 'texto' },
                      { label: 'DESCRIPCIÓN', type: 'texto' }, { label: 'CANTIDAD', type: 'número' }, { label: 'PVP', type: 'número' },
                    ].map(col => (
                      <span key={col.label} style={{ background: '#1A1A2E', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: '0.72rem', fontWeight: 600 }}>
                        {col.label} <span style={{ opacity: 0.55, fontWeight: 400 }}>({col.type})</span>
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={downloading}
                  onClick={handleDownloadTemplate}
                  style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 8, background: '#16a34a', border: '1px solid #16a34a', borderRadius: 6, padding: '7px 16px', color: '#fff', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  <i className="pi pi-download" />
                  {downloading ? 'Descargando...' : 'Descargar plantilla'}
                </button>
              </>
            )}

            {/* ── PASO 2: Subir archivo ── */}
            {step === 2 && (
              <>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFileSelect(e.dataTransfer.files[0]) }}
                  style={{
                    border: `2px dashed ${dragOver ? 'var(--color-primary, #2563eb)' : selectedFile ? '#16a34a' : 'var(--color-border, #e2e8f0)'}`,
                    borderRadius: 10, padding: '28px 20px', textAlign: 'center', cursor: 'pointer',
                    background: dragOver ? 'var(--color-primary-light, #eff6ff)' : selectedFile ? '#f0fdf4' : 'var(--color-surface, #f8fafc)',
                    transition: 'all .2s',
                  }}
                >
                  <input ref={fileInputRef} type="file" accept=".xlsx" hidden onChange={(e) => handleFileSelect(e.target.files[0])} />
                  {selectedFile ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                      <i className="pi pi-file-excel" style={{ fontSize: '1.8rem', color: '#16a34a' }} />
                      <strong style={{ fontSize: '0.9rem', color: '#15803d' }}>{selectedFile.name}</strong>
                      <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>Haz clic para cambiar el archivo</span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                      <i className="pi pi-upload" style={{ fontSize: '1.8rem', color: 'var(--color-text-secondary)' }} />
                      <strong style={{ fontSize: '0.9rem' }}>Arrastra el archivo aquí</strong>
                      <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>o haz clic para seleccionar · Solo .xlsx</span>
                    </div>
                  )}
                </div>
                {parseError && <p style={{ margin: 0, fontSize: '0.82rem', color: '#dc2626' }}>{parseError}</p>}
              </>
            )}

            {/* ── PASO 3: Revisar productos ── */}
            {step === 3 && (
              <>
                {conflictoRows.length > 0 && (
                  <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <i className="pi pi-exclamation-triangle" style={{ color: '#dc2626', fontSize: '0.95rem' }} />
                      <strong style={{ fontSize: '0.85rem', color: '#dc2626' }}>
                        {conflictoRows.length} producto{conflictoRows.length !== 1 ? 's' : ''} excluido{conflictoRows.length !== 1 ? 's' : ''} — pertenece{conflictoRows.length === 1 ? '' : 'n'} a otra casa comercial
                      </strong>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {conflictoRows.map((row, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.8rem' }}>
                          <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#dc2626', minWidth: 80 }}>{row.codigo || '—'}</span>
                          <span style={{ color: '#7f1d1d' }}>{row.descripcion || row.referencia || '—'}</span>
                          <span style={{ marginLeft: 'auto', color: '#b91c1c', fontStyle: 'italic', whiteSpace: 'nowrap' }}>→ {row.conflicto_casa_nombre}</span>
                        </div>
                      ))}
                    </div>
                    <p style={{ margin: 0, fontSize: '0.75rem', color: '#7f1d1d' }}>
                      Estos códigos no se incluirán en la sugerencia. Para agregarlos, primero asígnalos a <strong>{selectedCasa?.nombre}</strong> en el catálogo de productos.
                    </p>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {matchedCount > 0 && (
                    <span style={{ background: '#dcfce7', color: '#15803d', borderRadius: 20, padding: '3px 12px', fontSize: '0.78rem', fontWeight: 600 }}>
                      ✓ {matchedCount} vinculado{matchedCount !== 1 ? 's' : ''} al catálogo
                    </span>
                  )}
                  {unmatchedCount > 0 && (
                    <span style={{ background: '#f1f5f9', color: '#64748b', borderRadius: 20, padding: '3px 12px', fontSize: '0.78rem', fontWeight: 600 }}>
                      — {unmatchedCount} sin catálogo
                    </span>
                  )}
                </div>

                <div style={{ border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 8, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                    <thead>
                      <tr style={{ background: '#1A1A2E', color: '#fff' }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Código</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Descripción</th>
                        <th style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600 }}>Cant.</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validRows.map((row, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--color-border, #e2e8f0)', background: i % 2 === 0 ? 'var(--color-surface, #f8fafc)' : 'var(--color-bg)' }}>
                          <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: '0.8rem' }}>{row.codigo || '—'}</td>
                          <td style={{ padding: '7px 12px' }}>{row.descripcion || row.referencia || '—'}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'center', fontWeight: 600 }}>{row.cantidad}</td>
                          <td style={{ padding: '7px 12px' }}>
                            {row.matched_producto_id ? (
                              <span style={{ color: '#15803d', fontSize: '0.78rem', fontWeight: 500 }}>
                                <i className="pi pi-check" style={{ marginRight: 4 }} />
                                {row.matched_producto_nombre || row.matched_producto_codigo}
                              </span>
                            ) : (
                              <span style={{ color: '#94a3b8', fontSize: '0.78rem' }}>Sin catálogo</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {unmatchedCount > 0 && (
                  <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Info size={13} />
                    Los productos sin catálogo se crearán como pendientes. Podrás vincularlos al confirmar la llegada.
                  </p>
                )}

                {submitError && <p style={{ margin: 0, fontSize: '0.82rem', color: '#dc2626' }}>{submitError}</p>}
              </>
            )}
          </div>

          <footer className="quick-actions__receive-actions">
            {step === 1 && (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep('casa')}>Atrás</button>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--primary" onClick={() => setStep(2)}>Siguiente</button>
              </>
            )}
            {step === 2 && (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep(1)} disabled={parsing}>Atrás</button>
                <button
                  type="button"
                  className={`quick-actions__receive-btn${canProcess ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`}
                  onClick={handleProcess}
                  disabled={!canProcess || parsing}
                >
                  {parsing ? 'Procesando...' : 'Procesar archivo'}
                </button>
              </>
            )}
            {step === 3 && (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep(2)} disabled={submitting}>Atrás</button>
                <button
                  type="button"
                  className={`quick-actions__receive-btn${validRows.length > 0 ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`}
                  onClick={handleCreate}
                  disabled={submitting || validRows.length === 0}
                  title={validRows.length === 0 ? 'No hay productos válidos para crear la sugerencia' : undefined}
                >
                  {submitting ? 'Creando sugerencia...' : `Crear sugerencia${validRows.length > 0 && conflictoRows.length > 0 ? ` (${validRows.length} productos)` : ''}`}
                </button>
              </>
            )}
          </footer>
        </div>
      </div>
    </>,
    portalRoot
  )
}

function ImportacionExcelDirectaModal({ token, onClose, onCreated }) {
  const isDark = Boolean(document.querySelector('.dashboard-shell')?.classList.contains('dark'))
  const mode = isDark ? 'dark' : 'light'
  const toastRef = useRef(null)

  const [sucursales, setSucursales] = useState([])
  useEffect(() => {
    authFetch(`${API_URL}/inventario/sucursales/?modulo=movimientos_entradas`, {}, token)
      .then(r => r.ok ? r.json() : [])
      .then(data => setSucursales(Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : []))
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [step, setStep] = useState(1)
  const [downloading, setDownloading] = useState(false)

  // Step 2
  const fileInputRef = useRef(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [selectedCasa, setSelectedCasa] = useState(null)
  const [casaQuery, setCasaQuery] = useState('')
  const [casaOptions, setCasaOptions] = useState([])
  const [casaLoading, setCasaLoading] = useState(false)
  const [showCasaDropdown, setShowCasaDropdown] = useState(false)
  const casaTimerRef = useRef(null)
  const [diasTardo, setDiasTardo] = useState('')
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState('')

  // Step 3
  const [parsedRows, setParsedRows] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  useEffect(() => {
    if (!casaQuery.trim()) { setCasaOptions([]); return }
    clearTimeout(casaTimerRef.current)
    setCasaLoading(true)
    casaTimerRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ search: casaQuery, page_size: '10', tipo: 'importacion' })
        const resp = await authFetch(`${API_URL}/casa-comercial/casas/?${params}`, {}, token)
        const data = resp.ok ? await resp.json().catch(() => ({})) : {}
        setCasaOptions(Array.isArray(data.results) ? data.results : [])
      } catch {}
      setCasaLoading(false)
    }, 280)
    return () => clearTimeout(casaTimerRef.current)
  }, [casaQuery, token])

  const handleDownloadTemplate = async () => {
    setDownloading(true)
    try {
      const XLSXStyle = (await import('xlsx-js-style')).default
      const sucursalHeaders = sucursales.map(s => s.nombre.toUpperCase())
      const headers = ['CODIGO JP', 'REFERENCIA', 'OEM', 'DESCRIPCIÓN', 'CANTIDAD', 'PVP', ...sucursalHeaders]
      const colCount = headers.length
      // 0-3 = text (@), 4 = integer (0), 5 = decimal (0.00), 6+ = integer (0) — sucursales
      const colFormat = (ci) => ci === 4 ? '0' : ci === 5 ? '0.00' : ci >= 6 ? '0' : '@'
      const headerStyle = {
        font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
        fill: { fgColor: { rgb: '1A1A2E' }, patternType: 'solid' },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: {
          top: { style: 'thin', color: { rgb: '2563EB' } },
          bottom: { style: 'medium', color: { rgb: '2563EB' } },
          left: { style: 'thin', color: { rgb: '2563EB' } },
          right: { style: 'thin', color: { rgb: '2563EB' } },
        },
      }
      const ROWS = 2000
      const borderStyle = { style: 'thin', color: { rgb: 'DBEAFE' } }
      const border = { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle }
      const baseEven = { fill: { fgColor: { rgb: 'EFF6FF' }, patternType: 'solid' }, alignment: { vertical: 'center' }, border }
      const baseOdd  = { fill: { fgColor: { rgb: 'FFFFFF' }, patternType: 'solid' }, alignment: { vertical: 'center' }, border }
      const aoa = [headers, ...Array.from({ length: ROWS }, () => Array(colCount).fill(''))]
      const worksheet = XLSXStyle.utils.aoa_to_sheet(aoa)
      headers.forEach((_, ci) => {
        const ref = XLSXStyle.utils.encode_cell({ r: 0, c: ci })
        if (worksheet[ref]) worksheet[ref].s = headerStyle
      })
      for (let ri = 1; ri <= ROWS; ri++) {
        const base = ri % 2 === 0 ? baseEven : baseOdd
        for (let ci = 0; ci < colCount; ci++) {
          const ref = XLSXStyle.utils.encode_cell({ r: ri, c: ci })
          if (!worksheet[ref]) worksheet[ref] = { t: 's', v: '' }
          worksheet[ref].s = { ...base, numFmt: colFormat(ci) }
        }
      }
      worksheet['!cols'] = [
        { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 32 }, { wch: 11 }, { wch: 10 },
        ...sucursalHeaders.map(() => ({ wch: 13 })),
      ]
      worksheet['!rows'] = [{ hpt: 22 }]
      const workbook = XLSXStyle.utils.book_new()
      XLSXStyle.utils.book_append_sheet(workbook, worksheet, 'Importación')
      const out = XLSXStyle.write(workbook, { bookType: 'xlsx', type: 'array' })
      const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = 'plantilla-importacion-directa.xlsx'
      document.body.appendChild(link); link.click(); document.body.removeChild(link)
      URL.revokeObjectURL(link.href)
    } catch (e) { console.error(e) }
    setDownloading(false)
  }

  const handleFileSelect = (file) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.xlsx')) { setParseError('El archivo debe ser formato .xlsx'); return }
    setSelectedFile(file)
    setParseError('')
  }

  const handleProcess = async () => {
    setParseError('')
    setParsing(true)
    try {
      const formData = new FormData()
      formData.append('file', selectedFile)
      const resp = await fetch(`${API_URL}/importaciones/importaciones/parse-excel/`, {
        method: 'POST',
        headers: { Authorization: `Token ${token}` },
        body: formData,
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(data.detail || 'Error al procesar el archivo.')
      setParsedRows(data.rows || [])
      setSubmitError('')
      setStep(3)
    } catch (e) {
      setParseError(e.message)
    } finally {
      setParsing(false)
    }
  }

  const handleCreate = async () => {
    setSubmitError('')
    setSubmitting(true)
    try {
      const detalles = parsedRows.map(row => ({
        producto_id: row.matched_producto_id || null,
        codigo: row.codigo || '',
        nombre: row.descripcion || '',
        referencia: row.referencia || '',
        oem: row.oem || '',
        cantidad: row.cantidad,
        sucursal_quantities: row.sucursal_quantities || {},
      }))
      const payload = {
        casa_comercial_id: selectedCasa.id,
        detalles,
        ...(diasTardo !== '' && !isNaN(parseInt(diasTardo)) ? { dias_reales_entrega: parseInt(diasTardo) } : {}),
      }
      const resp = await authFetch(
        `${API_URL}/importaciones/importaciones/importar-directo/`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
        token
      )
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(data.detail || 'No se pudo crear la importación.')
      onCreated?.(data)
      onClose()
    } catch (e) {
      setSubmitError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const canProcess = Boolean(selectedFile && selectedCasa)
  const matchedCount = parsedRows.filter(r => r.matched_producto_id).length
  const unmatchedCount = parsedRows.length - matchedCount

  // Build sucursal distribution summary for step 3
  const sucursalSummary = useMemo(() => {
    const map = {}
    parsedRows.forEach(row => {
      if (!row.matched_producto_id) return
      Object.entries(row.sucursal_quantities || {}).forEach(([sucId, qty]) => {
        if (parseInt(qty) > 0) {
          map[sucId] = (map[sucId] || 0) + parseInt(qty)
        }
      })
    })
    return Object.entries(map).map(([sucId, total]) => {
      const suc = sucursales.find(s => String(s.id) === String(sucId))
      return { id: sucId, nombre: suc?.nombre || `Sucursal ${sucId}`, total }
    })
  }, [parsedRows, sucursales])

  const stepLabel = step === 1 ? 'Descarga la plantilla' : step === 2 ? 'Sube el archivo' : 'Revisa y confirma'

  return createPortal(
    <>
      <Toast ref={toastRef} />
      <div
        className={`quick-actions__receive-overlay ${mode}`}
        style={{ zIndex: 2100 }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      >
        <div
          className={`quick-actions__receive-dialog ${mode}`}
          style={{ width: step === 3 ? 'min(760px, 95vw)' : 'min(540px, 92vw)', height: 'auto', maxHeight: '90vh', gridTemplateRows: 'auto 1fr auto', transition: 'width .25s' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="quick-actions__receive-head">
            <div>
              <h4>Importación directa desde Excel</h4>
              <p style={{ fontSize: '0.7rem', fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                Paso {step} de 3 — {stepLabel}
              </p>
            </div>
            <button type="button" className="quick-actions__receive-close" onClick={onClose}><X size={16} /></button>
          </header>

          <div className="quick-actions__receive-body" style={{ padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>

            {/* ── PASO 1: Descargar ── */}
            {step === 1 && (
              <>
                <p style={{ fontSize: '0.84rem', color: 'var(--color-text-secondary)', margin: 0 }}>
                  Descarga la plantilla con una columna por cada sucursal. Completa las cantidades a distribuir por sucursal. La importación se registrará directamente como recibida.
                </p>
                <div style={{ background: 'var(--color-surface, #f8fafc)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 10, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <strong style={{ fontSize: '0.85rem' }}>Columnas de la plantilla</strong>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {[
                      { label: 'CODIGO JP', type: 'texto' }, { label: 'REFERENCIA', type: 'texto' },
                      { label: 'DESCRIPCIÓN', type: 'texto' }, { label: 'CANTIDAD', type: 'número' }, { label: 'PVP', type: 'número' },
                      ...sucursales.map(s => ({ label: s.nombre.toUpperCase(), type: 'número' })),
                    ].map(col => (
                      <span key={col.label} style={{ background: '#1A1A2E', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: '0.72rem', fontWeight: 600 }}>
                        {col.label} <span style={{ opacity: 0.55, fontWeight: 400 }}>({col.type})</span>
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={downloading || sucursales.length === 0}
                  onClick={handleDownloadTemplate}
                  style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 8, background: '#16a34a', border: '1px solid #16a34a', borderRadius: 6, padding: '7px 16px', color: '#fff', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  <i className="pi pi-download" />
                  {downloading ? 'Descargando...' : sucursales.length === 0 ? 'Cargando sucursales...' : 'Descargar plantilla'}
                </button>
              </>
            )}

            {/* ── PASO 2: Subir archivo ── */}
            {step === 2 && (
              <>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFileSelect(e.dataTransfer.files[0]) }}
                  style={{
                    border: `2px dashed ${dragOver ? 'var(--color-primary, #2563eb)' : selectedFile ? '#16a34a' : 'var(--color-border, #e2e8f0)'}`,
                    borderRadius: 10, padding: '28px 20px', textAlign: 'center', cursor: 'pointer',
                    background: dragOver ? 'var(--color-primary-light, #eff6ff)' : selectedFile ? '#f0fdf4' : 'var(--color-surface, #f8fafc)',
                    transition: 'all .2s',
                  }}
                >
                  <input ref={fileInputRef} type="file" accept=".xlsx" hidden onChange={(e) => handleFileSelect(e.target.files[0])} />
                  {selectedFile ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                      <i className="pi pi-file-excel" style={{ fontSize: '1.8rem', color: '#16a34a' }} />
                      <strong style={{ fontSize: '0.9rem', color: '#15803d' }}>{selectedFile.name}</strong>
                      <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>Haz clic para cambiar el archivo</span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                      <i className="pi pi-upload" style={{ fontSize: '1.8rem', color: 'var(--color-text-secondary)' }} />
                      <strong style={{ fontSize: '0.9rem' }}>Arrastra el archivo aquí</strong>
                      <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>o haz clic para seleccionar · Solo .xlsx</span>
                    </div>
                  )}
                </div>

                {/* Casa comercial */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: '0.82rem', fontWeight: 600 }}>Casa comercial</label>
                  <div style={{ position: 'relative' }}>
                    <input
                      type="text"
                      placeholder="Buscar casa comercial..."
                      value={selectedCasa ? selectedCasa.nombre : casaQuery}
                      onFocus={() => { if (selectedCasa) { setSelectedCasa(null); setCasaQuery('') }; setShowCasaDropdown(true) }}
                      onBlur={() => setTimeout(() => setShowCasaDropdown(false), 180)}
                      onChange={(e) => { setCasaQuery(e.target.value); setSelectedCasa(null); setShowCasaDropdown(true) }}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--color-border, #e2e8f0)', fontSize: '0.875rem', background: 'var(--color-bg)', color: 'var(--color-text)', fontFamily: 'inherit' }}
                    />
                    {showCasaDropdown && (casaLoading || casaOptions.length > 0 || casaQuery.trim()) && (
                      <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--color-bg)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,.12)', zIndex: 9999, maxHeight: 220, overflowY: 'auto', marginTop: 2 }}>
                        {casaLoading && <div style={{ padding: '10px 14px', fontSize: '0.82rem', color: 'var(--color-text-secondary)' }}>Buscando...</div>}
                        {!casaLoading && casaOptions.length === 0 && casaQuery.trim() && (
                          <div style={{ padding: '10px 14px', fontSize: '0.82rem', color: 'var(--color-text-secondary)' }}>Sin resultados</div>
                        )}
                        {casaOptions.map(casa => (
                          <div
                            key={casa.id}
                            onMouseDown={() => { setSelectedCasa(casa); setCasaQuery(''); setShowCasaDropdown(false) }}
                            style={{ padding: '9px 14px', cursor: 'pointer', fontSize: '0.875rem', borderBottom: '1px solid var(--color-border, #e2e8f0)' }}
                            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--color-surface, #f8fafc)'}
                            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                          >
                            <strong>{casa.nombre}</strong>
                            {casa.codigo && <span style={{ marginLeft: 8, fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>{casa.codigo}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {selectedCasa && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: '#15803d' }}>
                      <i className="pi pi-check-circle" />
                      <span>{selectedCasa.nombre} seleccionada</span>
                    </div>
                  )}
                </div>

                {/* Días que tardó */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: '0.82rem', fontWeight: 600 }}>¿Cuántos días tardó la importación? <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)' }}>(opcional)</span></label>
                  <input
                    type="number"
                    min="0"
                    placeholder="Ej: 45"
                    value={diasTardo}
                    onChange={(e) => setDiasTardo(e.target.value)}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--color-border, #e2e8f0)', fontSize: '0.875rem', background: 'var(--color-bg)', color: 'var(--color-text)', fontFamily: 'inherit' }}
                  />
                </div>

                {parseError && <p style={{ margin: 0, fontSize: '0.82rem', color: '#dc2626' }}>{parseError}</p>}
              </>
            )}

            {/* ── PASO 3: Revisar ── */}
            {step === 3 && (
              <>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ background: '#dcfce7', color: '#15803d', borderRadius: 20, padding: '3px 12px', fontSize: '0.78rem', fontWeight: 600 }}>
                    ✓ {matchedCount} vinculado{matchedCount !== 1 ? 's' : ''} al catálogo
                  </span>
                  {unmatchedCount > 0 && (
                    <span style={{ background: '#f1f5f9', color: '#64748b', borderRadius: 20, padding: '3px 12px', fontSize: '0.78rem', fontWeight: 600 }}>
                      — {unmatchedCount} sin catálogo (sin distribución)
                    </span>
                  )}
                </div>

                <div style={{ border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 8, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                    <thead>
                      <tr style={{ background: '#1A1A2E', color: '#fff' }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Código</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Descripción</th>
                        <th style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600 }}>Cant.</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Catálogo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsedRows.map((row, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--color-border, #e2e8f0)', background: i % 2 === 0 ? 'var(--color-surface, #f8fafc)' : 'var(--color-bg)' }}>
                          <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: '0.8rem' }}>{row.codigo || '—'}</td>
                          <td style={{ padding: '7px 12px' }}>{row.descripcion || row.referencia || '—'}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'center', fontWeight: 600 }}>{row.cantidad}</td>
                          <td style={{ padding: '7px 12px' }}>
                            {row.matched_producto_id ? (
                              <span style={{ color: '#15803d', fontSize: '0.78rem', fontWeight: 500 }}>
                                <i className="pi pi-check" style={{ marginRight: 4 }} />
                                {row.matched_producto_nombre || row.matched_producto_codigo}
                              </span>
                            ) : (
                              <span style={{ color: '#94a3b8', fontSize: '0.78rem' }}>Sin catálogo</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Sucursal distribution summary */}
                {sucursalSummary.length > 0 && (
                  <div style={{ background: 'var(--color-surface, #f8fafc)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 8, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <strong style={{ fontSize: '0.82rem' }}>Distribución a sucursales</strong>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {sucursalSummary.map(s => (
                        <span key={s.id} style={{ background: 'var(--color-primary-light, #dbeafe)', color: 'var(--color-primary, #2563eb)', borderRadius: 6, padding: '4px 10px', fontSize: '0.78rem', fontWeight: 600 }}>
                          {s.nombre}: {s.total} u.
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {unmatchedCount > 0 && (
                  <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Info size={13} />
                    Los productos sin catálogo se registran en la importación pero no generan distribución a sucursales.
                  </p>
                )}

                {submitError && <p style={{ margin: 0, fontSize: '0.82rem', color: '#dc2626' }}>{submitError}</p>}
              </>
            )}
          </div>

          <footer className="quick-actions__receive-actions">
            {step === 1 && (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={onClose}>Cerrar</button>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--primary" onClick={() => setStep(2)}>Siguiente</button>
              </>
            )}
            {step === 2 && (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep(1)} disabled={parsing}>Atrás</button>
                <button
                  type="button"
                  className={`quick-actions__receive-btn${canProcess ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`}
                  onClick={handleProcess}
                  disabled={!canProcess || parsing}
                >
                  {parsing ? 'Procesando...' : 'Procesar archivo'}
                </button>
              </>
            )}
            {step === 3 && (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep(2)} disabled={submitting}>Atrás</button>
                <button
                  type="button"
                  className="quick-actions__receive-btn quick-actions__receive-btn--success"
                  onClick={handleCreate}
                  disabled={submitting}
                >
                  {submitting ? 'Registrando...' : 'Registrar importación'}
                </button>
              </>
            )}
          </footer>
        </div>
      </div>
    </>,
    document.querySelector('.dashboard-shell') || document.body
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
  const [detailDraft, setDetailDraft] = useState({ producto: null, cantidad: '', comentario: '' })
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
  const [showNuevoProductoView, setShowNuevoProductoView] = useState(false)
  const [nuevoProductoDraft, setNuevoProductoDraft] = useState({ codigo: '', nombre: '', oem: '', referencia: '', precio: '', cantidad: '', comentario: '' })
  const [nuevoProductoErrors, setNuevoProductoErrors] = useState({})
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: SELECTOR_WIDTH, height: SELECTOR_HEIGHT_EMPTY })

  const [isMaximized, setIsMaximized] = useState(false)
  const [cellHover, setCellHover] = useState(null)
  const cellHoverTimerRef = useRef(null)

  const modalRef = useRef(null)
  const toastRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalSizeRef = useRef(modalSize)
  const modalPositionRef = useRef(modalPosition)
  const modalRestoreRef = useRef(null)
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const casaTimerRef = useRef(null)
  const productTimerRef = useRef(null)
  const productSearchIdRef = useRef(0)
  const casaDropdownRef = useRef(null)
  const productDropdownRef = useRef(null)
  const isFirstOpenRef = useRef(true)
  const detailsRef = useRef([])
  detailsRef.current = details
  const selectedCasaRef = useRef(null)
  selectedCasaRef.current = selectedCasa
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

  useEffect(() => {
    const handleWindowResize = () => {
      const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
      const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
      if (isMaximized) {
        setModalSize({ width: availableWidth, height: availableHeight })
        setModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }
      setModalSize((prev) => {
        const width = clamp(prev.width, MIN_WIDTH, availableWidth)
        const height = clamp(prev.height, MIN_HEIGHT, availableHeight)
        setModalPosition((prevPos) => ({
          x: clamp(prevPos.x, VIEWPORT_PADDING, Math.max(window.innerWidth - width - VIEWPORT_PADDING, VIEWPORT_PADDING)),
          y: clamp(prevPos.y, VIEWPORT_PADDING, Math.max(window.innerHeight - height - VIEWPORT_PADDING, VIEWPORT_PADDING)),
        }))
        return { width, height }
      })
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [isMaximized])

  const toggleMaximize = () => {
    modalDrag.current.active = false
    if (isMaximized) {
      const restore = modalRestoreRef.current
      if (restore) {
        setModalSize(restore.size)
        setModalPosition(restore.position)
      }
      setIsMaximized(false)
      return
    }
    modalRestoreRef.current = {
      size: { ...modalSizeRef.current },
      position: { ...modalPositionRef.current },
    }
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    setModalSize({ width: availableWidth, height: availableHeight })
    setModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  const handleModalMouseDown = (event) => {
    if (isMaximized) return
    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    modalDrag.current = { active: true, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top }
  }

  const handleResizeMouseDown = (event) => {
    if (isMaximized) return
    event.preventDefault()
    event.stopPropagation()
    resizeData.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: modalSizeRef.current.width,
      startHeight: modalSizeRef.current.height,
    }
    const handleResizeMove = (moveEvent) => {
      if (!resizeData.current.active) return
      const deltaX = moveEvent.clientX - resizeData.current.startX
      const deltaY = moveEvent.clientY - resizeData.current.startY
      const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - modalPositionRef.current.x - VIEWPORT_PADDING)
      const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - modalPositionRef.current.y - VIEWPORT_PADDING)
      setModalSize({
        width: clamp(resizeData.current.startWidth + deltaX, MIN_WIDTH, maxWidth),
        height: clamp(resizeData.current.startHeight + deltaY, MIN_HEIGHT, maxHeight),
      })
    }
    const handleResizeUp = () => {
      resizeData.current.active = false
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }
    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
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
    setShowNuevoProductoView(false)
    setNuevoProductoDraft({ codigo: '', nombre: '', oem: '', referencia: '', precio: '', cantidad: '', comentario: '' })
    setNuevoProductoErrors({})
    setIsMaximized(false)
    modalRestoreRef.current = null
    setCellHover(null)
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
    const requestId = ++productSearchIdRef.current
    const params = new URLSearchParams()
    params.set('page_size', '10')
    params.set('modulo', 'solicitudes')
    if (term) params.set('search', term)
    if (selectedCasaRef.current?.nombre) params.set('casa_comercial', selectedCasaRef.current.nombre)

    authFetch(`${API_URL}/productos/listado/?${params.toString()}`, {}, token)
      .then(async (response) => {
        if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudieron cargar los productos.'))
        return response.json()
      })
      .then((payload) => {
        if (requestId !== productSearchIdRef.current) return
        const selectedIds = new Set(detailsRef.current.filter((item) => item.producto?.id).map((item) => String(item.producto.id)))
        setProductOptions(parseApiList(payload).filter((product) => !selectedIds.has(String(product.id))))
      })
      .catch((error) => { if (requestId === productSearchIdRef.current) notifyError(error.message) })
      .finally(() => { if (requestId === productSearchIdRef.current) setProductLoading(false) })
  }, [notifyError, token])

  useEffect(() => {
    if (!open || !showProductDropdown) return undefined
    if (productTimerRef.current) clearTimeout(productTimerRef.current)
    productTimerRef.current = setTimeout(() => searchProducts(productQuery.trim()), 280)
    return () => clearTimeout(productTimerRef.current)
  }, [open, productQuery, searchProducts, showProductDropdown])

  const handleAddProduct = (product, cantidad = '', comentario = '') => {
    const normalizedQuantity = Number(cantidad)
    if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
      return
    }
    if (details.some((d) => d.producto?.id && String(d.producto.id) === String(product.id))) {
      toastRef.current?.show({ severity: 'warn', summary: 'Advertencia', detail: 'Este producto ya fue agregado.', life: 3000 })
      return
    }
    const incomingRef = String(product.referencia || '').trim().toLowerCase()
    if (incomingRef && details.some((d) => String(d.producto?.referencia || d.referencia || '').trim().toLowerCase() === incomingRef)) {
      toastRef.current?.show({ severity: 'warn', summary: 'Referencia duplicada', detail: `Ya existe un producto con la referencia "${product.referencia}" en el listado.`, life: 4000 })
      return
    }
    setDetails((prev) => [
      ...prev,
      {
        _key: String(product.id),
        producto: product,
        cantidad: String(cantidad).trim(),
        comentario: String(comentario || '').trim(),
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

  const handleComentarioChange = (_key, value) => {
    setDetails((prev) => prev.map((item) => item._key === _key ? { ...item, comentario: value } : item))
  }

  const handleSubmit = async () => {
    if (!selectedCasa?.id) {
      notifyError('Selecciona una casa comercial.')
      return
    }
    if (!details.length) {
      return
    }
    const normalizedDetails = details.map((item) => {
      const solId = item._solId ? { solicitud_id: Number(item._solId) } : {}
      if (item.producto?.id) {
        return { producto_id: item.producto.id, cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', ...solId }
      }
      const precioConfirmado = item.precio != null && item.precio !== '' ? Number(item.precio) : undefined
      return {
        codigo: item.codigo || '',
        nombre: item.nombre || '',
        oem: item.oem || '',
        cantidad: Number(item.cantidad || 0),
        comentario: item.comentario || '',
        ...(precioConfirmado != null ? { precio_confirmado: precioConfirmado } : {}),
        ...solId,
      }
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

  const showCellHover = useCallback((event, value, label) => {
    if (!value) return
    if (cellHoverTimerRef.current) clearTimeout(cellHoverTimerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    cellHoverTimerRef.current = setTimeout(() => {
      cellHoverTimerRef.current = null
      setCellHover({ top: rect.bottom + 4, left: rect.left, value, label })
    }, 400)
  }, [])

  const hideCellHover = useCallback(() => {
    if (cellHoverTimerRef.current) { clearTimeout(cellHoverTimerRef.current); cellHoverTimerRef.current = null }
    setCellHover(null)
  }, [])

  const handleAddNuevoProducto = () => {
    const errors = {}
    if (!nuevoProductoDraft.nombre.trim()) errors.nombre = 'El nombre es requerido'
    if (!nuevoProductoDraft.oem.trim()) errors.oem = 'El OEM es requerido'
    if (!nuevoProductoDraft.referencia.trim()) errors.referencia = 'La referencia es requerida'
    const qty = Number(nuevoProductoDraft.cantidad)
    if (!nuevoProductoDraft.cantidad || !Number.isFinite(qty) || qty <= 0) errors.cantidad = 'La cantidad debe ser mayor a 0'
    if (Object.keys(errors).length > 0) { setNuevoProductoErrors(errors); return }
    const incomingRef = nuevoProductoDraft.referencia.trim().toLowerCase()
    if (details.some((d) => String(d.producto?.referencia || d.referencia || '').trim().toLowerCase() === incomingRef)) {
      setNuevoProductoErrors((p) => ({ ...p, referencia: 'Ya existe un producto con esta referencia en el listado.' }))
      return
    }
    const key = 'manual_' + Date.now() + '_' + Math.floor(Math.random() * 10000)
    setDetails((prev) => [...prev, {
      _key: key,
      producto: null,
      codigo: nuevoProductoDraft.codigo.trim(),
      nombre: nuevoProductoDraft.nombre.trim(),
      oem: nuevoProductoDraft.oem.trim(),
      referencia: nuevoProductoDraft.referencia.trim(),
      precio: nuevoProductoDraft.precio !== '' ? Number(nuevoProductoDraft.precio) : null,
      cantidad: String(nuevoProductoDraft.cantidad),
      comentario: nuevoProductoDraft.comentario.trim(),
    }])
    setNuevoProductoDraft({ codigo: '', nombre: '', oem: '', referencia: '', precio: '', cantidad: '', comentario: '' })
    setNuevoProductoErrors({})
    setShowNuevoProductoView(false)
  }

  const handleAddFromAceptados = useCallback((aceptados) => {
    const skippedRefs = []
    setDetails((prev) => {
      const next = [...prev]
      for (const item of aceptados) {
        const itemRef = String(item.referencia || '').trim().toLowerCase()
        if (itemRef && next.some((d) => String(d.producto?.referencia || d.referencia || '').trim().toLowerCase() === itemRef)) {
          skippedRefs.push(item.referencia || item.nombre || item.codigo)
          continue
        }
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
              _solId: item.solicitud_id,
              producto: { id: item.producto_id, codigo: item.codigo, nombre: item.nombre, oem: (item.oem_codigos || []).join(', '), precio: item.precio ?? null, referencia: item.referencia || '' },
              cantidad: String(item.cantidad || ''),
              comentario: '',
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
              referencia: item.referencia || '',
              cantidad: String(item.cantidad || ''),
              comentario: '',
            })
          }
        }
      }
      return next
    })
    if (skippedRefs.length > 0) {
      toastRef.current?.show({
        severity: 'warn',
        summary: 'Referencia duplicada',
        detail: `${skippedRefs.length} producto(s) omitidos por referencia ya existente: ${skippedRefs.join(', ')}`,
        life: 5000,
      })
    }
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
          minWidth: step === 'casa' ? undefined : MIN_WIDTH,
          minHeight: step === 'casa' ? undefined : MIN_HEIGHT,
          maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
          maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
        }}
      >
        <header className="create-user__header" onMouseDown={handleModalMouseDown}>
          <div className="create-user__header-text">
            <h3>Crear sugerencia</h3>
          </div>
          <div className="create-user__header-actions">
            {step !== 'casa' && (
              <button
                type="button"
                className="create-user__icon-button create-user__icon-button--maximize"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={toggleMaximize}
                aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
              >
                <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
              </button>
            )}
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
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <button
                            type="button"
                            className="create-user__ghost"
                            onClick={() => { setNuevoProductoDraft({ codigo: '', nombre: '', oem: '', referencia: '', precio: '', cantidad: '', comentario: '' }); setNuevoProductoErrors({}); setShowNuevoProductoView(true) }}
                            style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}
                          >
                            + Agregar producto
                          </button>
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
                      </div>

                      <div className="create-user__locations-table create-salida__products-table create-salida__products-table--with-actions importaciones-modal__products-table">
                        <div className="create-user__locations-row create-user__locations-row--head">
                          <span>Código</span>
                          <span>Nombre</span>
                          <span>OEM</span>
                          <span>Referencia</span>
                          <span>Precio</span>
                          <span>Cantidad</span>
                          <span>Comentario</span>
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
                                  if (!showProductDropdown) { setProductQuery('') }
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
                          <span className="create-salida__table-static-value">
                            {detailDraft.producto ? String(detailDraft.producto.referencia || '').trim() || '-' : '-'}
                          </span>
                          <span className="create-salida__table-static-value">
                            {detailDraft.producto?.precio != null ? `$${Number(detailDraft.producto.precio).toFixed(2)}` : '-'}
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
                          <span>
                            <input
                              type="text"
                              value={detailDraft.comentario}
                              onChange={(e) => setDetailDraft((prev) => ({ ...prev, comentario: e.target.value }))}
                              disabled={!detailDraft.producto}
                              placeholder="Opcional"
                              autoComplete="off"
                            />
                          </span>
                          <span className="create-user__locations-cell create-user__locations-cell--action">
                            <button
                              type="button"
                              className="create-user__ghost"
                              disabled={!canAddDetailDraft}
                              onClick={() => {
                                if (!canAddDetailDraft) return
                                handleAddProduct(detailDraft.producto, detailDraft.cantidad, detailDraft.comentario)
                                setDetailDraft({ producto: null, cantidad: '', comentario: '' })
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
                          const codigo = item.producto?.codigo || item.codigo || ''
                          const nombre = item.producto?.nombre || item.nombre || ''
                          const oem = String(item.producto?.oem || item.oem || item.producto?.referencia || '').trim() || '-'
                          const referencia = String(item.producto?.referencia || item.referencia || '').trim() || '-'
                          const precioVal = item.producto?.precio ?? item.precio ?? null
                          const precio = precioVal != null ? `$${Number(precioVal).toFixed(2)}` : '-'
                          return (
                            <div key={item._key} className={`create-user__locations-row${sinCatalogo ? ' importaciones-aceptados__row--no-catalogo' : ''}`}>
                              <span
                                className="imp-table-cell-tip"
                                onMouseEnter={(e) => showCellHover(e, sinCatalogo ? null : codigo, 'Código')}
                                onMouseLeave={hideCellHover}
                              >
                                {sinCatalogo
                                  ? <span className="importaciones-aceptados__no-catalogo-badge">Sin catálogo</span>
                                  : <span className="imp-table-cell-text">{codigo}</span>}
                              </span>
                              <span
                                className="imp-table-cell-tip"
                                onMouseEnter={(e) => showCellHover(e, nombre, 'Nombre')}
                                onMouseLeave={hideCellHover}
                              >
                                <span className="imp-table-cell-text">{nombre || '-'}</span>
                              </span>
                              <span
                                className="imp-table-cell-tip"
                                onMouseEnter={(e) => showCellHover(e, oem !== '-' ? oem : null, 'OEM')}
                                onMouseLeave={hideCellHover}
                              >
                                <span className="imp-table-cell-text">{oem}</span>
                              </span>
                              <span
                                className="imp-table-cell-tip"
                                onMouseEnter={(e) => showCellHover(e, referencia !== '-' ? referencia : null, 'Referencia')}
                                onMouseLeave={hideCellHover}
                              >
                                <span className="imp-table-cell-text">{referencia}</span>
                              </span>
                              <span
                                className="imp-table-cell-tip"
                                onMouseEnter={(e) => showCellHover(e, precio !== '-' ? precio : null, 'Precio')}
                                onMouseLeave={hideCellHover}
                              >
                                <span className="imp-table-cell-text">{precio}</span>
                              </span>
                              <span>
                                <input
                                  type="number"
                                  value={item.cantidad}
                                  onChange={(e) => handleQuantityChange(item._key, e.target.value)}
                                  style={invalidQtyKeys.has(item._key) ? { borderColor: '#ef4444' } : undefined}
                                />
                              </span>
                              <span>
                                <input
                                  type="text"
                                  value={item.comentario || ''}
                                  onChange={(e) => handleComentarioChange(item._key, e.target.value)}
                                  placeholder="Comentario"
                                  autoComplete="off"
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
        {step !== 'casa' && (
          <button
            type="button"
            aria-label="Cambiar tamaño de ventana"
            className="create-user__resize-handle"
            onMouseDown={handleResizeMouseDown}
          />
        )}
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
                  <span>Referencia</span>
                  <span>Precio</span>
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
                  const precioText = item.precio != null ? `$${Number(item.precio).toFixed(2)}` : '-'
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
                          {noProducto
                            ? <span className="importaciones-aceptados__no-catalogo-badge" title="Sin producto en catálogo">Sin catálogo</span>
                            : (item.codigo || '-')}
                        </span>
                      </span>
                      <span title={item.nombre}><span className="imp-cell-text">{item.nombre || '-'}</span></span>
                      <span style={{ fontSize: '0.8rem' }}><span className="imp-cell-text">{item.referencia || '-'}</span></span>
                      <span style={{ fontSize: '0.8rem' }}><span className="imp-cell-text">{precioText}</span></span>
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

      {showNuevoProductoView && createPortal(
        <div className="imp-aceptados-popup__overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowNuevoProductoView(false) }}>
          <div className="imp-aceptados-popup__dialog imp-nuevo-producto-popup__dialog">
            <header className="imp-aceptados-popup__header">
              <div>
                <h3>Agregar producto</h3>
                <p>El producto se agregará directamente al listado.</p>
              </div>
              <button type="button" className="imp-aceptados-popup__close" onClick={() => setShowNuevoProductoView(false)} aria-label="Cerrar">
                <i className="pi pi-times" />
              </button>
            </header>

            <div className="imp-aceptados-popup__body">
              <div className="create-user__grid create-user__grid--two" style={{ padding: '4px 0' }}>
                <label className="create-user__field">
                  <span>Código JP</span>
                  <input
                    type="text"
                    value={nuevoProductoDraft.codigo}
                    onChange={(e) => setNuevoProductoDraft((p) => ({ ...p, codigo: e.target.value }))}
                    placeholder="Opcional"
                    autoComplete="off"
                  />
                </label>
                <label className={`create-user__field${nuevoProductoErrors.nombre ? ' create-user__field--invalid' : ''}`}>
                  <span>Nombre <span style={{ color: '#dc2626' }}>*</span></span>
                  <input
                    type="text"
                    value={nuevoProductoDraft.nombre}
                    onChange={(e) => { setNuevoProductoDraft((p) => ({ ...p, nombre: e.target.value })); setNuevoProductoErrors((p) => ({ ...p, nombre: undefined })) }}
                    placeholder="Nombre del producto"
                    autoComplete="off"
                    autoFocus
                  />
                  {nuevoProductoErrors.nombre && <small style={{ color: '#dc2626' }}>{nuevoProductoErrors.nombre}</small>}
                </label>
                <label className={`create-user__field${nuevoProductoErrors.oem ? ' create-user__field--invalid' : ''}`}>
                  <span>OEM <span style={{ color: '#dc2626' }}>*</span></span>
                  <input
                    type="text"
                    value={nuevoProductoDraft.oem}
                    onChange={(e) => { setNuevoProductoDraft((p) => ({ ...p, oem: e.target.value })); setNuevoProductoErrors((p) => ({ ...p, oem: undefined })) }}
                    placeholder="Código OEM"
                    autoComplete="off"
                  />
                  {nuevoProductoErrors.oem && <small style={{ color: '#dc2626' }}>{nuevoProductoErrors.oem}</small>}
                </label>
                <label className={`create-user__field${nuevoProductoErrors.referencia ? ' create-user__field--invalid' : ''}`}>
                  <span>Referencia <span style={{ color: '#dc2626' }}>*</span></span>
                  <input
                    type="text"
                    value={nuevoProductoDraft.referencia}
                    onChange={(e) => { setNuevoProductoDraft((p) => ({ ...p, referencia: e.target.value })); setNuevoProductoErrors((p) => ({ ...p, referencia: undefined })) }}
                    placeholder="Referencia del producto"
                    autoComplete="off"
                  />
                  {nuevoProductoErrors.referencia && <small style={{ color: '#dc2626' }}>{nuevoProductoErrors.referencia}</small>}
                </label>
                <label className="create-user__field">
                  <span>Precio</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={nuevoProductoDraft.precio}
                    onChange={(e) => setNuevoProductoDraft((p) => ({ ...p, precio: e.target.value }))}
                    placeholder="0.00"
                    autoComplete="off"
                  />
                </label>
                <label className={`create-user__field${nuevoProductoErrors.cantidad ? ' create-user__field--invalid' : ''}`}>
                  <span>Cantidad <span style={{ color: '#dc2626' }}>*</span></span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={nuevoProductoDraft.cantidad}
                    onChange={(e) => { setNuevoProductoDraft((p) => ({ ...p, cantidad: e.target.value })); setNuevoProductoErrors((p) => ({ ...p, cantidad: undefined })) }}
                    placeholder="0"
                    autoComplete="off"
                  />
                  {nuevoProductoErrors.cantidad && <small style={{ color: '#dc2626' }}>{nuevoProductoErrors.cantidad}</small>}
                </label>
                <label className="create-user__field" style={{ gridColumn: '1 / -1' }}>
                  <span>Comentario</span>
                  <input
                    type="text"
                    value={nuevoProductoDraft.comentario}
                    onChange={(e) => setNuevoProductoDraft((p) => ({ ...p, comentario: e.target.value }))}
                    placeholder="Opcional"
                    autoComplete="off"
                  />
                </label>
              </div>
            </div>

            <div className="imp-aceptados-popup__footer">
              <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setShowNuevoProductoView(false)}>Cancelar</button>
              <button type="button" className="create-user__action create-user__action--primary" onClick={handleAddNuevoProducto}>
                Agregar producto
              </button>
            </div>
          </div>
        </div>,
        getPortalRoot()
      )}

      {cellHover && createPortal(
        <div
          className="imp-cell-hover-card"
          style={{ top: cellHover.top, left: cellHover.left }}
        >
          <div className="imp-cell-hover-card__title">{cellHover.label}</div>
          <div className="imp-cell-hover-card__value">{cellHover.value}</div>
        </div>,
        getPortalRoot()
      )}
    </div>
    </>
  )
}

function EditImportacionModal({ open, imp, token, onClose, onSaved, onOpenBorrador, moduleActions }) {
  const canEdit = moduleActions?.puede_actualizar !== false
  const canDelete = moduleActions?.puede_eliminar !== false
  const canImportar = moduleActions?.puede_importar === true
  const [activeTab, setActiveTab] = useState('general')
  const [detailDraft, setDetailDraft] = useState({ producto: null, cantidad: '', comentario: '' })
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
  const [isMaximized, setIsMaximized] = useState(false)
  const [itemCheckStates, setItemCheckStates] = useState({})
  const handleCycleCheckState = (key) => {
    setItemCheckStates((prev) => {
      const cur = prev[key]
      if (!cur) return { ...prev, [key]: 'check' }
      if (cur === 'check') return { ...prev, [key]: 'x' }
      const next = { ...prev }; delete next[key]; return next
    })
  }
  const [showVerificarExcelDropdown, setShowVerificarExcelDropdown] = useState(false)
  const [showSaveOnCloseModal, setShowSaveOnCloseModal] = useState(false)

  const modalRef = useRef(null)
  const toastRef = useRef(null)
  const verificarExcelDropdownRef = useRef(null)
  const verificarFileInputRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalSizeRef = useRef(modalSize)
  const modalPositionRef = useRef(modalPosition)
  const modalRestoreRef = useRef(null)
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const productTimerRef = useRef(null)
  const productSearchIdRef = useRef(0)
  const productDropdownRef = useRef(null)
  const isFirstOpenRef = useRef(true)
  const detailsRef = useRef([])
  detailsRef.current = details
  const [productPanelStyle, setProductPanelStyle] = useState(null)

  const selectedCasa = imp?.casa_comercial || null
  const isVerificar = imp?.estado === 'cotizacion'
  const isConfirmacion = imp?.estado === 'confirmacion'
  const isVerificarOrConfirmacion = isVerificar || isConfirmacion
  const detailDraftQuantity = Number(detailDraft.cantidad)
  const canAddDetailDraft = Boolean(
    detailDraft.producto && Number.isFinite(detailDraftQuantity) && detailDraftQuantity > 0
  )

  useEffect(() => { modalSizeRef.current = modalSize }, [modalSize])
  useEffect(() => { modalPositionRef.current = modalPosition }, [modalPosition])

  useEffect(() => {
    if (!showVerificarExcelDropdown) return
    const handle = (e) => { if (!verificarExcelDropdownRef.current?.contains(e.target)) setShowVerificarExcelDropdown(false) }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [showVerificarExcelDropdown])

  useLayoutEffect(() => {
    if (!open) { isFirstOpenRef.current = true; return }
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    const targetWidth = (imp?.estado === 'cotizacion' || imp?.estado === 'confirmacion') ? 860 : MIN_WIDTH
    const nextWidth = Math.min(targetWidth, availableWidth)
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

  useEffect(() => {
    const handleWindowResize = () => {
      const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
      const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
      if (isMaximized) {
        setModalSize({ width: availableWidth, height: availableHeight })
        setModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }
      setModalSize((prev) => {
        const width = clamp(prev.width, MIN_WIDTH, availableWidth)
        const height = clamp(prev.height, MIN_HEIGHT, availableHeight)
        setModalPosition((prevPos) => ({
          x: clamp(prevPos.x, VIEWPORT_PADDING, Math.max(window.innerWidth - width - VIEWPORT_PADDING, VIEWPORT_PADDING)),
          y: clamp(prevPos.y, VIEWPORT_PADDING, Math.max(window.innerHeight - height - VIEWPORT_PADDING, VIEWPORT_PADDING)),
        }))
        return { width, height }
      })
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [isMaximized])

  const handleModalMouseDown = (event) => {
    if (isMaximized) return
    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    modalDrag.current = { active: true, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top }
  }

  const handleResizeMouseDown = (event) => {
    if (isMaximized) return
    event.preventDefault()
    event.stopPropagation()
    resizeData.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: modalSizeRef.current.width,
      startHeight: modalSizeRef.current.height,
    }
    const handleResizeMove = (moveEvent) => {
      if (!resizeData.current.active) return
      const deltaX = moveEvent.clientX - resizeData.current.startX
      const deltaY = moveEvent.clientY - resizeData.current.startY
      const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - modalPositionRef.current.x - VIEWPORT_PADDING)
      const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - modalPositionRef.current.y - VIEWPORT_PADDING)
      setModalSize({
        width: clamp(resizeData.current.startWidth + deltaX, MIN_WIDTH, maxWidth),
        height: clamp(resizeData.current.startHeight + deltaY, MIN_HEIGHT, maxHeight),
      })
    }
    const handleResizeUp = () => {
      resizeData.current.active = false
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }
    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }

  const toggleMaximize = () => {
    modalDrag.current.active = false
    if (isMaximized) {
      const restore = modalRestoreRef.current
      if (restore) {
        setModalSize(restore.size)
        setModalPosition(restore.position)
      }
      setIsMaximized(false)
      return
    }
    modalRestoreRef.current = {
      size: { ...modalSizeRef.current },
      position: { ...modalPositionRef.current },
    }
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    setModalSize({ width: availableWidth, height: availableHeight })
    setModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  useEffect(() => {
    if (!open || !imp) return
    const toCentavos = (val) => {
      if (val == null || val === '') return ''
      return String(Math.round(parseFloat(val) * 100))
    }
    const loaded = (imp.detalles || []).map((d, i) => {
      const solId = d.solicitud_id ? String(d.solicitud_id) : null
      const confirmed = {
        precio_estimado: toCentavos(d.precio_estimado), cantidad_aproximada: d.cantidad_aproximada != null ? String(d.cantidad_aproximada) : '',
        precio_confirmado: toCentavos(d.precio_confirmado), cantidad_confirmada: d.cantidad_confirmada != null ? String(d.cantidad_confirmada) : '',
      }
      if (d.producto?.id) {
        return { _key: String(d.producto.id), producto: d.producto, cantidad: String(d.cantidad || ''), comentario: d.comentario || '', _solId: solId, ...confirmed }
      }
      return {
        _key: 'sc_' + (d.id ?? i), producto: null,
        codigo: d.codigo || '', nombre: d.nombre || '', oem: d.oem || '',
        cantidad: String(d.cantidad || ''), comentario: d.comentario || '', _solId: solId, ...confirmed,
      }
    })
    setDetails(loaded)
    setDetailDraft({ producto: null, cantidad: '', comentario: '' })
    setActiveTab('general')
    setInvalidQtyKeys(new Set())
    setShowAceptadosView(false)
    setAceptadosItems([])
    setAceptadosSelected(new Set())
    setAceptadosSearch('')
    setItemCheckStates({})
    setIsMaximized(false)
    modalRestoreRef.current = null
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
    const requestId = ++productSearchIdRef.current
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
        if (requestId !== productSearchIdRef.current) return
        const selectedIds = new Set(detailsRef.current.filter((item) => item.producto?.id).map((item) => String(item.producto.id)))
        setProductOptions(parseApiList(payload).filter((product) => !selectedIds.has(String(product.id))))
      })
      .catch((error) => { if (requestId === productSearchIdRef.current) toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 }) })
      .finally(() => { if (requestId === productSearchIdRef.current) setProductLoading(false) })
  }, [selectedCasa, token])

  useEffect(() => {
    if (!open || !showProductDropdown) return undefined
    if (productTimerRef.current) clearTimeout(productTimerRef.current)
    productTimerRef.current = setTimeout(() => searchProducts(productQuery.trim()), 280)
    return () => clearTimeout(productTimerRef.current)
  }, [open, productQuery, searchProducts, showProductDropdown])

  const handleAddProduct = (product, cantidad = '', comentario = '') => {
    const n = Number(cantidad)
    if (!Number.isFinite(n) || n <= 0) return
    if (details.some((d) => d.producto?.id && String(d.producto.id) === String(product.id))) {
      toastRef.current?.show({ severity: 'warn', summary: 'Advertencia', detail: 'Este producto ya fue agregado.', life: 3000 })
      return
    }
    setDetails((prev) => [...prev, { _key: String(product.id), producto: product, cantidad: String(cantidad).trim(), comentario: String(comentario || '').trim() }])
    setProductQuery('')
    setProductOptions([])
    setShowProductDropdown(false)
    setDetailDraft({ producto: null, cantidad: '', comentario: '' })
  }

  const handleQuantityChange = (_key, value) => {
    const clean = String(value || '').replace(/[^\d]/g, '')
    setDetails((prev) => prev.map((item) => item._key === _key ? { ...item, cantidad: clean } : item))
    if (invalidQtyKeys.has(_key)) {
      setInvalidQtyKeys((prev) => { const next = new Set(prev); next.delete(_key); return next })
    }
  }

  const handleComentarioChange = (_key, value) => {
    setDetails((prev) => prev.map((item) => item._key === _key ? { ...item, comentario: value } : item))
  }

  const handleConfirmedChange = (_key, field, value) => {
    setDetails((prev) => prev.map((item) => item._key === _key ? { ...item, [field]: String(value || '') } : item))
  }

  const formatCentavos = (centsStr) => {
    const digits = String(centsStr || '').replace(/\D/g, '')
    if (!digits) return '0.00'
    const n = parseInt(digits, 10)
    const intPart = Math.floor(n / 100)
    const decPart = n % 100
    return `${intPart.toLocaleString('en-US')}.${String(decPart).padStart(2, '0')}`
  }

  const handleSubmit = async () => {
    const itemsToSubmit = details
    if (!itemsToSubmit.length) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'Agrega al menos un producto.', life: 4000 })
      return
    }
    const badKeys = new Set(
      itemsToSubmit.filter((item) => { const n = Number(item.cantidad || 0); return !Number.isFinite(n) || n <= 0 }).map((item) => item._key)
    )
    if (badKeys.size > 0) {
      setInvalidQtyKeys(badKeys)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'Todas las cantidades deben ser mayores a cero.', life: 4000 })
      return
    }
    const normalizedDetails = itemsToSubmit.map((item) => {
      const solId = item._solId ? { solicitud_id: Number(item._solId) } : {}
      const confirmedFields = isVerificarOrConfirmacion ? {
        precio_estimado: item.precio_estimado
          ? (parseInt(String(item.precio_estimado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2)
          : null,
        cantidad_aproximada: item.cantidad_aproximada ? Number(item.cantidad_aproximada) || null : null,
        precio_confirmado: item.precio_confirmado
          ? (parseInt(String(item.precio_confirmado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2)
          : null,
        cantidad_confirmada: item.cantidad_confirmada ? Number(item.cantidad_confirmada) || null : null,
      } : {}
      if (item.producto?.id) return { producto_id: item.producto.id, cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', ...confirmedFields, ...solId }
      return { codigo: item.codigo || '', nombre: item.nombre || '', oem: item.oem || '', cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', ...confirmedFields, ...solId }
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

  const handleDownloadVerificarExcel = async () => {
    try {
      const XLSXStyle = (await import('xlsx-js-style')).default
      const bt = { style: 'thin', color: { rgb: 'D1D5DB' } }
      const border = { top: bt, bottom: bt, left: bt, right: bt }
      const RO = 6; const ED = 3; const DIFF_CI = RO + ED
      const precioEditLabel = isVerificar ? 'Precio est.' : 'Precio conf.'
      const cantEditLabel = isVerificar ? 'Cant. aprox.' : 'Cant. conf.'
      const headers = ['Código', 'Nombre', 'OEM', 'Referencia', 'Precio', 'Cantidad', precioEditLabel, cantEditLabel, 'Comentario', 'Diferencia', '_key']
      const mkH = (fill, bot) => ({ font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 10 }, fill: { fgColor: { rgb: fill }, patternType: 'solid' }, alignment: { horizontal: 'center', vertical: 'center' }, border: { top: bt, bottom: { style: 'medium', color: { rgb: bot } }, left: bt, right: bt } })
      const hdrS = headers.map((_, ci) => ci < RO ? mkH('1e3a5f', '2563EB') : ci < RO + ED ? mkH('15803d', '166534') : ci === DIFF_CI ? mkH('374151', '374151') : null)

      const rows = details.map((item) => {
        const codigo = item.producto?.codigo || item.codigo || 'SIN CATÁLOGO'
        const nombre = item.producto?.nombre || item.nombre || ''
        const oem = item.producto?.oem || item.oem || ''
        const referencia = item.producto?.referencia || item.referencia || ''
        // Keep null to detect SIN CATÁLOGO for coloring; cell will receive 0 as numeric value
        const precioReal = item.producto?.precio != null ? +Number(item.producto.precio).toFixed(2) : null
        const cantidad = +Number(item.cantidad || 0)
        const precioConf = (() => {
          const raw = isVerificar ? item.precio_estimado : item.precio_confirmado
          if (raw == null || raw === '' || raw === 0) return null
          const c = parseInt(String(raw).replace(/\D/g, '') || '0', 10)
          return c > 0 ? +(c / 100).toFixed(2) : null
        })()
        const cantConf = (() => {
          const raw = isVerificar ? item.cantidad_aproximada : item.cantidad_confirmada
          if (raw == null || raw === '') return null
          const n = parseInt(String(raw), 10)
          return !isNaN(n) && n > 0 ? n : null
        })()
        // diff uses real price so static color is meaningful; null for SIN CATÁLOGO
        const diff = precioReal != null && precioConf != null ? +(precioReal - precioConf).toFixed(2) : null
        // precio in cell is always numeric: 0 for SIN CATÁLOGO so formula =E-G can always compute
        const precio = precioReal ?? 0
        return [codigo, nombre, oem, referencia, precio, cantidad, precioConf, cantConf, item.comentario || '', diff, item._key]
      })

      // Build worksheet manually for precise type control
      const NROWS = rows.length; const NCOLS = headers.length
      const worksheet = { '!ref': XLSXStyle.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: NROWS, c: NCOLS - 1 } }) }
      const setCell = (r, c, val, s, formula) => {
        const ref = XLSXStyle.utils.encode_cell({ r, c })
        if (formula) { worksheet[ref] = { t: 'n', v: val ?? 0, f: formula, s }; return }
        if (val == null) { worksheet[ref] = { t: 's', v: '', s }; return }
        if (typeof val === 'number') { worksheet[ref] = { t: 'n', v: val, s }; return }
        worksheet[ref] = { t: 's', v: String(val), s }
      }

      headers.forEach((h, ci) => setCell(0, ci, h, hdrS[ci] || { font: { sz: 8, color: { rgb: 'AAAAAA' } } }))

      rows.forEach((row, ri) => {
        const isEven = (ri + 1) % 2 === 0
        const excelRow = ri + 2
        row.forEach((val, ci) => {
          const isEdit = ci >= RO && ci < RO + ED
          const isDiff = ci === DIFF_CI
          const isEmpty = val == null
          // Static fills: CF overrides dynamically for E=0, G/H blank, and J colors
          let bg
          if (isEdit) bg = isEven ? 'dcfce7' : 'f0fdf4'
          else if (isDiff && !isEmpty) bg = val >= 0 ? 'dcfce7' : val >= -1 ? 'fef9c3' : 'fee2e2'
          else if (isDiff) bg = isEven ? 'f3f4f6' : 'f9fafb'
          else bg = isEven ? 'EFF6FF' : 'FFFFFF'
          const numFmt = ci === 4 || ci === RO ? '0.00' : ci === 5 || ci === RO + 1 ? '0' : isDiff ? '0.00' : null
          const s = { fill: { fgColor: { rgb: bg }, patternType: 'solid' }, alignment: { vertical: 'center' }, border, ...(numFmt ? { numFmt } : {}) }
          const formula = isDiff ? `IF(G${excelRow}="","",E${excelRow}-G${excelRow})` : undefined
          setCell(ri + 1, ci, val, s, formula)
        })
      })

      worksheet['!cols'] = [{ wch: 14 }, { wch: 28 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 10 }, { wch: 24 }, { wch: 12 }, { wch: 0, hidden: true }]
      worksheet['!rows'] = [{ hpt: 22 }]
      const workbook = XLSXStyle.utils.book_new()
      XLSXStyle.utils.book_append_sheet(workbook, worksheet, isVerificar ? 'Verificar' : 'Confirmacion')
      const rawOut = XLSXStyle.write(workbook, { bookType: 'xlsx', type: 'array' })

      // Inject conditional formatting via ZIP manipulation (fflate statically imported)
      const unzipped = unzipSync(new Uint8Array(rawOut))
      const dec = new TextDecoder(); const enc = new TextEncoder()

      // Add dxf color definitions to styles.xml
      let stylesXml = dec.decode(unzipped['xl/styles.xml'])
      stylesXml = stylesXml.replace(/<dxfs[^>]*\/>/,
        '<dxfs count="3">' +
        '<dxf><fill><patternFill><bgColor rgb="FFdcfce7"/></patternFill></fill></dxf>' +  // 0: verde
        '<dxf><fill><patternFill><bgColor rgb="FFfef9c3"/></patternFill></fill></dxf>' +  // 1: amarillo
        '<dxf><fill><patternFill><bgColor rgb="FFfee2e2"/></patternFill></fill></dxf>' +  // 2: rojo
        '</dxfs>')
      unzipped['xl/styles.xml'] = enc.encode(stylesXml)

      // Add conditional formatting rules to sheet1.xml
      const eCol = XLSXStyle.utils.encode_col(4)         // E - Precio
      const gCol = XLSXStyle.utils.encode_col(RO)        // G - Precio conf.
      const hCol = XLSXStyle.utils.encode_col(RO + 1)    // H - Cant. conf.
      const jCol = XLSXStyle.utils.encode_col(DIFF_CI)   // J - Diferencia
      const last = NROWS + 1
      const cfXml =
        // E: amarillo cuando Precio = 0 (SIN CATÁLOGO), limpio cuando el usuario cambia el valor
        `<conditionalFormatting sqref="${eCol}2:${eCol}${last}">` +
        `<cfRule type="cellIs" dxfId="1" priority="1" operator="equal"><formula>0</formula></cfRule>` +
        `</conditionalFormatting>` +
        // G: amarillo cuando Precio conf. está vacío
        `<conditionalFormatting sqref="${gCol}2:${gCol}${last}">` +
        `<cfRule type="cellIs" dxfId="1" priority="1" operator="equal"><formula>""</formula></cfRule>` +
        `</conditionalFormatting>` +
        // H: amarillo cuando Cant. conf. está vacía
        `<conditionalFormatting sqref="${hCol}2:${hCol}${last}">` +
        `<cfRule type="cellIs" dxfId="1" priority="1" operator="equal"><formula>""</formula></cfRule>` +
        `</conditionalFormatting>` +
        // J: verde ≥0, amarillo ≥-1, rojo <-1
        `<conditionalFormatting sqref="${jCol}2:${jCol}${last}">` +
        `<cfRule type="cellIs" dxfId="0" priority="1" stopIfTrue="1" operator="greaterThanOrEqual"><formula>0</formula></cfRule>` +
        `<cfRule type="cellIs" dxfId="1" priority="2" stopIfTrue="1" operator="greaterThanOrEqual"><formula>-1</formula></cfRule>` +
        `<cfRule type="cellIs" dxfId="2" priority="3" operator="lessThan"><formula>-1</formula></cfRule>` +
        `</conditionalFormatting>`

      let sheetXml = dec.decode(unzipped['xl/worksheets/sheet1.xml'])
      // <conditionalFormatting> must precede <ignoredErrors> in OOXML element order
      sheetXml = sheetXml.includes('<ignoredErrors')
        ? sheetXml.replace('<ignoredErrors', cfXml + '<ignoredErrors')
        : sheetXml.replace('</worksheet>', cfXml + '</worksheet>')
      unzipped['xl/worksheets/sheet1.xml'] = enc.encode(sheetXml)

      // Repack: skip directory entries, store uncompressed to avoid any compression mismatch
      const zippable = {}
      for (const [path, data] of Object.entries(unzipped)) {
        if (!path.endsWith('/')) zippable[path] = [data, { level: 0 }]
      }
      const finalOut = zipSync(zippable)
      const blob = new Blob([finalOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${isVerificar ? 'verificar' : 'confirmacion'}-${imp?.codigo || imp?.estado}.xlsx`
      document.body.appendChild(link); link.click(); document.body.removeChild(link)
      URL.revokeObjectURL(link.href)
    } catch (e) {
      console.error(e)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'No se pudo generar el Excel.', life: 3500 })
    }
  }

  const handleUploadVerificarExcel = async (file) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'El archivo debe ser .xlsx', life: 3500 })
      return
    }
    try {
      const xlsxMod = await import('xlsx')
      const xlsx = xlsxMod?.default ?? xlsxMod
      const buffer = await file.arrayBuffer()
      const workbook = xlsx.read(buffer, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' })
      if (rawRows.length < 2) {
        toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'El archivo no contiene datos.', life: 3500 })
        return
      }
      const fileHeaders = rawRows[0].map((h) => String(h || '').trim())
      const keyIdx = fileHeaders.indexOf('_key')
      const precioIdx = fileHeaders.indexOf(isVerificar ? 'Precio est.' : 'Precio conf.')
      const cantIdx = fileHeaders.indexOf(isVerificar ? 'Cant. aprox.' : 'Cant. conf.')
      const comentIdx = fileHeaders.indexOf('Comentario')
      if (keyIdx === -1 || precioIdx === -1 || cantIdx === -1) {
        toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'El archivo no corresponde a esta importación. Descarga el Excel desde este modal.', life: 4500 })
        return
      }
      const dataRows = rawRows.slice(1).filter((row) => row.some((c) => c !== ''))
      const keyToRow = {}
      dataRows.forEach((row) => {
        const k = String(row[keyIdx] || '').trim()
        if (k) keyToRow[k] = row
      })
      const missing = detailsRef.current.filter((item) => !keyToRow[item._key])
      if (missing.length > 0) {
        toastRef.current?.show({ severity: 'error', summary: 'Error', detail: `El Excel no corresponde: faltan ${missing.length} producto(s). Descarga de nuevo desde este modal.`, life: 4500 })
        return
      }
      setDetails((prev) => prev.map((item) => {
        const row = keyToRow[item._key]
        if (!row) return item
        const rawPrecio = row[precioIdx]
        const rawCant = row[cantIdx]
        const rawComent = comentIdx !== -1 ? row[comentIdx] : ''
        const precioField = isVerificar ? 'precio_estimado' : 'precio_confirmado'
        const cantField = isVerificar ? 'cantidad_aproximada' : 'cantidad_confirmada'
        let nuevoPrecio = item[precioField]
        if (rawPrecio !== '' && rawPrecio != null) {
          const num = parseFloat(String(rawPrecio).replace(',', '.'))
          if (!isNaN(num)) nuevoPrecio = Math.round(num * 100)
        }
        let nuevaCant = item[cantField]
        if (rawCant !== '' && rawCant != null) {
          const num = parseInt(String(rawCant), 10)
          if (!isNaN(num)) nuevaCant = num
        }
        return { ...item, [precioField]: nuevoPrecio, [cantField]: nuevaCant, comentario: rawComent !== '' ? String(rawComent) : item.comentario }
      }))
      toastRef.current?.show({ severity: 'success', summary: 'Datos cargados', detail: 'Tabla actualizada desde Excel. Recuerda guardar.', life: 4000 })
    } catch (e) {
      console.error(e)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'No se pudo leer el Excel.', life: 3500 })
    }
  }

  const handlePedirCotizacion = async () => {
    const badKeys = new Set(
      details.filter((item) => { const n = Number(item.cantidad || 0); return !Number.isFinite(n) || n <= 0 }).map((item) => item._key)
    )
    if (badKeys.size > 0) {
      setInvalidQtyKeys(badKeys)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'Todas las cantidades deben ser mayores a cero.', life: 4000 })
      return
    }
    setImportarSubmitting(true)
    try {
      const normalizedDetails = details.map((item) => {
        const solId = item._solId ? { solicitud_id: Number(item._solId) } : {}
        if (item.producto?.id) return { producto_id: item.producto.id, cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', ...solId }
        return { codigo: item.codigo || '', nombre: item.nombre || '', oem: item.oem || '', cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', ...solId }
      })
      const saveResponse = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/`,
        { method: 'PATCH', body: JSON.stringify({ detalles: normalizedDetails }) },
        token
      )
      if (!saveResponse.ok) throw new Error(await readErrorMessage(saveResponse, 'No se pudo guardar los cambios.'))
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/pedir-cotizacion/`,
        { method: 'POST' },
        token
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo solicitar la cotización.'))
      const payload = await response.json()
      onSaved?.(payload)
      onClose?.()
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 })
    } finally {
      setImportarSubmitting(false)
    }
  }

  const handleConfirmar = async () => {
    const missingData = details.filter((item) => {
      const precio = parseInt(String(item.precio_estimado || '').replace(/\D/g, '') || '0', 10)
      const cant = Number(item.cantidad_aproximada || 0)
      return precio <= 0 || cant <= 0
    })
    if (missingData.length > 0) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Datos incompletos',
        detail: `Completa el precio estimado y cantidad aprox. de todos los productos (${missingData.length} sin completar).`,
        life: 5000,
      })
      return
    }
    setImportarSubmitting(true)
    try {
      const normalizedDetails = details.map((item) => {
        const solId = item._solId ? { solicitud_id: Number(item._solId) } : {}
        const precioEstimadoVal = item.precio_estimado
          ? (parseInt(String(item.precio_estimado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2)
          : null
        const cantAproxVal = item.cantidad_aproximada ? Number(item.cantidad_aproximada) || null : null
        const estimadoFields = {
          precio_estimado: precioEstimadoVal,
          cantidad_aproximada: cantAproxVal,
          precio_confirmado: precioEstimadoVal,
          cantidad_confirmada: cantAproxVal,
        }
        if (item.producto?.id) return { producto_id: item.producto.id, cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', ...estimadoFields, ...solId }
        return { codigo: item.codigo || '', nombre: item.nombre || '', oem: item.oem || '', cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', ...estimadoFields, ...solId }
      })
      const saveResponse = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/`,
        { method: 'PATCH', body: JSON.stringify({ detalles: normalizedDetails }) },
        token
      )
      if (!saveResponse.ok) throw new Error(await readErrorMessage(saveResponse, 'No se pudo guardar los cambios.'))
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/confirmar/`,
        { method: 'POST' },
        token
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo confirmar la importación.'))
      const payload = await response.json()
      onSaved?.(payload)
      onClose?.()
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 })
    } finally {
      setImportarSubmitting(false)
    }
  }

  const handleImportar = async () => {
    const factura = facturaInput.trim()
    if (!factura) return
    setImportarSubmitting(true)
    try {
      const normalizedDetalles = details.map((item) => {
        const solId = item._solId ? { solicitud_id: Number(item._solId) } : {}
        const confirmedFields = {
          precio_estimado: item.precio_estimado
            ? (parseInt(String(item.precio_estimado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2)
            : null,
          cantidad_aproximada: item.cantidad_aproximada ? Number(item.cantidad_aproximada) || null : null,
          precio_confirmado: item.precio_confirmado
            ? (parseInt(String(item.precio_confirmado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2)
            : null,
          cantidad_confirmada: item.cantidad_confirmada ? Number(item.cantidad_confirmada) || null : null,
        }
        if (item.producto?.id) return { producto_id: item.producto.id, cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', ...confirmedFields, ...solId }
        return { codigo: item.codigo || '', nombre: item.nombre || '', oem: item.oem || '', cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', ...confirmedFields, ...solId }
      })
      const selectedKeys = Object.entries(itemCheckStates).filter(([, s]) => s === 'check').map(([k]) => k)
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/importar/`,
        {
          method: 'POST',
          body: JSON.stringify({
            numero_factura: factura,
            detalles: normalizedDetalles,
            detalles_seleccionados: selectedKeys,
          }),
        },
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

  const handleCloseWithSave = () => {
    const isEditable = imp?.estado === 'borrador' || imp?.estado === 'cotizacion' || imp?.estado === 'confirmacion'
    if (!isEditable || submitting || importarSubmitting) { onClose?.(); return }
    setShowSaveOnCloseModal(true)
  }

  const handleSaveAndClose = async () => {
    setShowSaveOnCloseModal(false)
    setSubmitting(true)
    try {
      const normalizedDetails = details.map((item) => {
        const solId = item._solId ? { solicitud_id: Number(item._solId) } : {}
        const confirmedFields = isVerificarOrConfirmacion ? {
          precio_estimado: item.precio_estimado ? (parseInt(String(item.precio_estimado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2) : null,
          cantidad_aproximada: item.cantidad_aproximada ? Number(item.cantidad_aproximada) || null : null,
          precio_confirmado: item.precio_confirmado ? (parseInt(String(item.precio_confirmado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2) : null,
          cantidad_confirmada: item.cantidad_confirmada ? Number(item.cantidad_confirmada) || null : null,
        } : {}
        if (item.producto?.id) return { producto_id: item.producto.id, cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', ...confirmedFields, ...solId }
        return { codigo: item.codigo || '', nombre: item.nombre || '', oem: item.oem || '', cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', ...confirmedFields, ...solId }
      })
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/`,
        { method: 'PATCH', body: JSON.stringify({ detalles: normalizedDetails }) },
        token
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo guardar.'))
      const payload = await response.json()
      onSaved?.(payload)
      onClose?.()
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Error al guardar', detail: error.message, life: 4000 })
    } finally {
      setSubmitting(false)
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
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo eliminar la sugerencia.'))
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
              _solId: item.solicitud_id,
              producto: { id: item.producto_id, codigo: item.codigo, nombre: item.nombre, oem: (item.oem_codigos || []).join(', '), precio: item.precio ?? null, referencia: item.referencia || '' },
              cantidad: String(item.cantidad || ''),
              comentario: '',
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
              oem: (item.oem_codigos || []).join(', '), referencia: item.referencia || '', cantidad: String(item.cantidad || ''),
              comentario: '',
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
            minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT,
            maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
            maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
          }}
        >
          <header className="create-user__header" onMouseDown={handleModalMouseDown}>
            <div className="create-user__header-text">
              <h3>{imp.estado === 'cotizacion' ? 'Verificar' : imp.estado === 'confirmacion' ? 'Confirmación' : 'Sugerencia'}: {imp.codigo}</h3>
            </div>
            <div className="create-user__header-actions">
              <button
                type="button"
                className="create-user__icon-button create-user__icon-button--maximize"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={toggleMaximize}
                aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
              >
                <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
              </button>
              <button type="button" className="create-user__icon-button" onMouseDown={(e) => e.stopPropagation()} onClick={handleCloseWithSave} disabled={submitting} aria-label="Cerrar">
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
                      {!isVerificarOrConfirmacion && (
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
                      )}
                    </div>

                    <div className={`create-user__locations-table create-salida__products-table create-salida__products-table--with-actions importaciones-modal__products-table${isVerificarOrConfirmacion ? ' importaciones-modal__products-table--verificar' : ''}${isConfirmacion ? ' importaciones-modal__products-table--confirmacion' : ''}`}>
                      <div className="create-user__locations-row create-user__locations-row--head">
                        <span>Código</span><span>Nombre</span><span>OEM</span><span>Referencia</span><span>Precio</span><span>Cantidad</span>
                        {isVerificar ? (
                          <>
                            <span onDoubleClick={() => setDetails((prev) => prev.map((d) => ({ ...d, precio_estimado: d.producto?.precio != null ? Math.round(Number(d.producto.precio) * 100) : d.precio_estimado })))} title="Doble click: llenar todas con precio original" style={{ cursor: 'pointer' }}>Precio est.</span>
                            <span onDoubleClick={() => setDetails((prev) => prev.map((d) => ({ ...d, cantidad_aproximada: d.cantidad })))} title="Doble click: llenar todas con cantidad original" style={{ cursor: 'pointer' }}>Cant. aprox.</span>
                            <span>Diferencia</span>
                            <span>Comentario</span>
                          </>
                        ) : isConfirmacion ? (
                          <>
                            <span onDoubleClick={() => setDetails((prev) => prev.map((d) => ({ ...d, precio_confirmado: d.producto?.precio != null ? Math.round(Number(d.producto.precio) * 100) : d.precio_confirmado })))} title="Doble click: llenar todas con precio original" style={{ cursor: 'pointer' }}>Precio conf.</span>
                            <span onDoubleClick={() => setDetails((prev) => prev.map((d) => ({ ...d, cantidad_confirmada: d.cantidad })))} title="Doble click: llenar todas con cantidad original" style={{ cursor: 'pointer' }}>Cant. conf.</span>
                            <span>Diferencia</span>
                            <span>Comentario</span>
                            <span>Acciones</span>
                          </>
                        ) : (
                          <><span>Comentario</span><span>Acciones</span></>
                        )}
                      </div>

                      {!isVerificarOrConfirmacion && <div className="create-user__locations-row create-user__locations-row--form">
                        <span className="create-salida__product-picker create-salida__product-code-cell">
                          <div className="create-user__dropdown create-salida__product-dropdown" ref={productDropdownRef}>
                            <button
                              type="button"
                              className="create-user__dropdown-trigger"
                              onClick={() => {
                                setShowProductDropdown((prev) => !prev)
                                if (!showProductDropdown) { setProductQuery('') }
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
                        <span className="create-salida__table-static-value">
                          {detailDraft.producto ? String(detailDraft.producto.referencia || '').trim() || '-' : '-'}
                        </span>
                        <span className="create-salida__table-static-value">
                          {detailDraft.producto?.precio != null ? `$${Number(detailDraft.producto.precio).toFixed(2)}` : '-'}
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
                        <span>
                          <input
                            type="text"
                            value={detailDraft.comentario}
                            onChange={(e) => setDetailDraft((prev) => ({ ...prev, comentario: e.target.value }))}
                            disabled={!detailDraft.producto}
                            placeholder="Opcional"
                            autoComplete="off"
                          />
                        </span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button
                            type="button"
                            className="create-user__ghost"
                            disabled={!canAddDetailDraft}
                            onClick={() => { if (!canAddDetailDraft) return; handleAddProduct(detailDraft.producto, detailDraft.cantidad, detailDraft.comentario); setDetailDraft({ producto: null, cantidad: '', comentario: '' }) }}
                          >
                            Agregar
                          </button>
                        </span>
                      </div>}

                      {!details.length ? (
                        <div className="create-user__locations-row create-user__locations-row--empty"><span>Sin productos agregados.</span></div>
                      ) : details.map((item) => {
                        const sinCatalogo = !item.producto?.id
                        const codigo = item.producto?.codigo || item.codigo || ''
                        const nombre = item.producto?.nombre || item.nombre || ''
                        const oem = String(item.producto?.oem || item.oem || item.producto?.referencia || '').trim() || '-'
                        const referencia = String(item.producto?.referencia || item.referencia || '').trim() || '-'
                        const precio = item.producto?.precio != null ? `$${Number(item.producto.precio).toFixed(2)}` : '-'
                        return (
                          <div key={item._key} className={`create-user__locations-row${sinCatalogo ? ' importaciones-aceptados__row--no-catalogo' : ''}`}>
                            <span>
                              {sinCatalogo
                                ? <span className="importaciones-aceptados__no-catalogo-badge">Sin catálogo</span>
                                : codigo}
                            </span>
                            <span title={nombre}><span className="create-salida__product-name-text">{nombre}</span></span>
                            <span>{oem}</span>
                            <span>{referencia}</span>
                            <span>{precio}</span>
                            {isVerificarOrConfirmacion ? (
                              <span className="create-salida__table-static-value">{item.cantidad}</span>
                            ) : (
                              <span>
                                <input
                                  type="number"
                                  value={item.cantidad}
                                  onChange={(e) => handleQuantityChange(item._key, e.target.value)}
                                  style={invalidQtyKeys.has(item._key) ? { borderColor: '#ef4444' } : undefined}
                                />
                              </span>
                            )}
                            {isVerificarOrConfirmacion ? (
                              <>
                                {(() => {
                                  const priceField = isVerificar ? 'precio_estimado' : 'precio_confirmado'
                                  const qtyField = isVerificar ? 'cantidad_aproximada' : 'cantidad_confirmada'
                                  const confirmedCentavos = item[priceField] ? parseInt(String(item[priceField]).replace(/\D/g, '') || '0', 10) : null
                                  const storedCentavos = item.producto?.precio != null ? Math.round(Number(item.producto.precio) * 100) : null
                                  const diff = storedCentavos != null && confirmedCentavos != null ? confirmedCentavos - storedCentavos : null
                                  const diffColor = diff === null ? undefined : diff <= 0 ? '#22c55e' : diff <= 100 ? '#eab308' : '#ef4444'
                                  return (
                                    <>
                                      <span className="importaciones-verificar__precio-cell">
                                        <span className="importaciones-verificar__currency-sign">$</span>
                                        <input
                                          type="text"
                                          inputMode="numeric"
                                          readOnly
                                          value={formatCentavos(item[priceField])}
                                          title="Doble click: usar precio original"
                                          onDoubleClick={() => {
                                            if (item.producto?.precio != null)
                                              handleConfirmedChange(item._key, priceField, Math.round(Number(item.producto.precio) * 100))
                                          }}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Backspace') {
                                              e.preventDefault()
                                              handleConfirmedChange(item._key, priceField, String(item[priceField] || '').replace(/\D/g, '').slice(0, -1))
                                            } else if (/^\d$/.test(e.key)) {
                                              e.preventDefault()
                                              handleConfirmedChange(item._key, priceField, String(item[priceField] || '').replace(/\D/g, '') + e.key)
                                            }
                                          }}
                                        />
                                      </span>
                                      <span>
                                        <input
                                          type="number"
                                          min="0"
                                          step="1"
                                          value={item[qtyField] ?? ''}
                                          onChange={(e) => handleConfirmedChange(item._key, qtyField, e.target.value)}
                                          onDoubleClick={() => handleConfirmedChange(item._key, qtyField, item.cantidad)}
                                          title="Doble click: usar cantidad original"
                                        />
                                      </span>
                                      <span style={{ color: diffColor }}>
                                        {diff !== null ? `${diff >= 0 ? '+' : '-'}$${(Math.abs(diff) / 100).toFixed(2)}` : ''}
                                      </span>
                                      <span>
                                        <input
                                          type="text"
                                          value={item.comentario || ''}
                                          onChange={(e) => handleComentarioChange(item._key, e.target.value)}
                                          placeholder="Comentario"
                                          autoComplete="off"
                                        />
                                      </span>
                                      {isConfirmacion && (
                                        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                          <button
                                            type="button"
                                            className={`imp-tri-check imp-tri-check--${itemCheckStates[item._key] || 'none'}`}
                                            onClick={() => handleCycleCheckState(item._key)}
                                          >
                                            {itemCheckStates[item._key] === 'check' && <Check size={13} />}
                                            {itemCheckStates[item._key] === 'x' && <X size={13} />}
                                          </button>
                                        </span>
                                      )}
                                    </>
                                  )
                                })()}
                              </>
                            ) : (
                              <>
                                <span>
                                  <input
                                    type="text"
                                    value={item.comentario || ''}
                                    onChange={(e) => handleComentarioChange(item._key, e.target.value)}
                                    placeholder="Comentario"
                                    autoComplete="off"
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
                              </>
                            )}
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
                {(imp?.estado === 'borrador' || imp?.estado === 'cotizacion' || imp?.estado === 'confirmacion') && canDelete && (
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
                {isVerificarOrConfirmacion && (
                  <div className="imp-verificar-excel-dropdown" ref={verificarExcelDropdownRef}>
                    <button
                      type="button"
                      className="users-circle users-circle--excel"
                      title="Excel"
                      onClick={() => setShowVerificarExcelDropdown((p) => !p)}
                    >
                      <i className="pi pi-file-excel" />
                    </button>
                    {showVerificarExcelDropdown && (
                      <div className="imp-verificar-excel-menu">
                        <button type="button" onClick={() => { handleDownloadVerificarExcel(); setShowVerificarExcelDropdown(false) }}>
                          <i className="pi pi-download" /> Descargar Excel
                        </button>
                        <button type="button" onClick={() => { verificarFileInputRef.current?.click(); setShowVerificarExcelDropdown(false) }}>
                          <i className="pi pi-upload" /> Subir Excel
                        </button>
                      </div>
                    )}
                    <input
                      ref={verificarFileInputRef}
                      type="file"
                      accept=".xlsx"
                      style={{ display: 'none' }}
                      onChange={(e) => { handleUploadVerificarExcel(e.target.files?.[0]); e.target.value = '' }}
                    />
                  </div>
                )}
                {canImportar && imp?.estado === 'borrador' && (
                  <button
                    type="button"
                    className="create-user__action imp-cotizacion-btn"
                    disabled={submitting || importarSubmitting || deleteSubmitting}
                    onClick={handlePedirCotizacion}
                  >
                    {importarSubmitting ? 'Enviando...' : 'Pedir cotización'}
                  </button>
                )}
                {canEdit && imp?.estado === 'cotizacion' && (
                  <button type="submit" className="create-user__action create-user__action--primary" disabled={submitting || importarSubmitting || deleteSubmitting}>
                    {submitting ? 'Guardando...' : 'Guardar'}
                  </button>
                )}
                {canImportar && imp?.estado === 'cotizacion' && (
                  <button
                    type="button"
                    className="create-user__action imp-confirmar-btn"
                    disabled={submitting || importarSubmitting || deleteSubmitting}
                    onClick={handleConfirmar}
                  >
                    {importarSubmitting ? 'Confirmando...' : 'Pedir confirmación'}
                  </button>
                )}
                {canEdit && imp?.estado === 'confirmacion' && (
                  <button type="submit" className="create-user__action create-user__action--primary" disabled={submitting || importarSubmitting || deleteSubmitting}>
                    {submitting ? 'Guardando...' : 'Guardar'}
                  </button>
                )}
                {canImportar && imp?.estado === 'confirmacion' && (
                  <button
                    type="button"
                    className="create-user__action imp-importar-btn"
                    disabled={submitting || importarSubmitting || deleteSubmitting}
                    onClick={() => {
                      if (!Object.values(itemCheckStates).some((s) => s === 'check')) {
                        toastRef.current?.show({ severity: 'warn', summary: 'Sin selección', detail: 'Selecciona al menos un producto para importar.', life: 4000 })
                        return
                      }
                      setFacturaInput('')
                      setShowImportarModal(true)
                    }}
                  >
                    Importar
                  </button>
                )}
                {canEdit && imp?.estado === 'borrador' && (
                  <button type="submit" className="create-user__action create-user__action--primary" disabled={submitting || importarSubmitting || deleteSubmitting}>
                    {submitting ? 'Guardando...' : 'Guardar cambios'}
                  </button>
                )}
              </div>
            </div>
          </form>
          <button
            type="button"
            aria-label="Cambiar tamaño de ventana"
            className="create-user__resize-handle"
            onMouseDown={handleResizeMouseDown}
          />
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
                <h4>Eliminar {imp?.estado === 'cotizacion' ? 'cotización' : imp?.estado === 'confirmacion' ? 'confirmación' : 'sugerencia'}</h4>
                <p>¿Estás seguro que quieres eliminar {imp?.estado === 'cotizacion' ? 'la cotización' : imp?.estado === 'confirmacion' ? 'la confirmación' : 'la sugerencia'} <strong>{imp?.codigo}</strong>? Esta acción no se puede deshacer.</p>
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

        {showSaveOnCloseModal && createPortal(
          <div className="user-details__confirm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowSaveOnCloseModal(false) }}>
            <div className="user-details__confirm-dialog">
              <div className="user-details__confirm-icon">
                <Info size={18} />
              </div>
              <div className="user-details__confirm-content">
                <h4>¿Guardar cambios?</h4>
                <p>¿Quieres guardar los cambios antes de cerrar?</p>
              </div>
              <div className="user-details__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--cancel"
                  onClick={() => { setShowSaveOnCloseModal(false); onClose?.() }}
                  disabled={submitting}
                >
                  No guardar
                </button>
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={handleSaveAndClose}
                  disabled={submitting}
                >
                  {submitting ? 'Guardando...' : 'Guardar y cerrar'}
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
                    <span>Solicitud</span><span>Código JP</span><span>Nombre</span><span>Referencia</span><span>Precio</span><span>OEMs</span><span>Cant.</span>
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
                    const precioText = item.precio != null ? `$${Number(item.precio).toFixed(2)}` : '-'
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
                            {noProducto
                              ? <span className="importaciones-aceptados__no-catalogo-badge" title="Sin producto en catálogo">Sin catálogo</span>
                              : (item.codigo || '-')}
                          </span>
                        </span>
                        <span title={item.nombre}><span className="imp-cell-text">{item.nombre || '-'}</span></span>
                        <span style={{ fontSize: '0.8rem' }}><span className="imp-cell-text">{item.referencia || '-'}</span></span>
                        <span style={{ fontSize: '0.8rem' }}><span className="imp-cell-text">{precioText}</span></span>
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
  const widthHandlers = useMemo(() => makeWidthStateHandlers('importaciones-table-state-v2'), [])

  const [activeStatus, setActiveStatus] = useState('borrador')
  const status = statusProp || activeStatus
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showExcelImport, setShowExcelImport] = useState(false)
  const [showExcelDirecta, setShowExcelDirecta] = useState(false)
  const [showCreateMenu, setShowCreateMenu] = useState(false)
  const createMenuRef = useRef(null)
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
    if (!showCreateMenu) return
    const handler = (e) => { if (!createMenuRef.current?.contains(e.target)) setShowCreateMenu(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showCreateMenu])

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
    if (rowData.estado === 'borrador' || rowData.estado === 'cotizacion' || rowData.estado === 'confirmacion') {
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
        <button className="users-circle users-circle--excel" type="button" onClick={handleExportExcel} title="Exportar Excel" disabled={!items.length}>
          <i className="pi pi-file-excel" />
        </button>
        <button className="users-circle users-circle--pdf" type="button" onClick={handleExportPdf} title="Exportar PDF" disabled={!items.length}>
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
            status === 'importada' ? (
              <button
                type="button"
                className="p-button users-topbtn users-topbtn--create"
                onClick={() => setShowExcelDirecta(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.875rem', fontWeight: 400 }}
              >
                <i className="pi pi-file-excel p-button-icon" />
                <span className="p-button-label">Importación directa desde Excel</span>
              </button>
            ) : (
              <div style={{ position: 'relative' }} ref={createMenuRef}>
                <button
                  type="button"
                  className="p-button users-topbtn users-topbtn--create"
                  onClick={() => setShowCreateMenu(p => !p)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.875rem', fontWeight: 400 }}
                >
                  <i className="pi pi-plus p-button-icon" />
                  <span className="p-button-label">Crear</span>
                  <i className="pi pi-chevron-down" style={{ fontSize: '0.65rem', opacity: 0.75 }} />
                </button>
                {showCreateMenu && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 500, background: 'var(--modal-color, #fff)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', minWidth: 230, overflow: 'hidden' }}>
                    <button
                      type="button"
                      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.875rem', textAlign: 'left', color: 'inherit' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface, #f8fafc)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      onClick={() => { setShowCreate(true); setShowCreateMenu(false) }}
                    >
                      <i className="pi pi-file-edit" style={{ color: 'var(--color-primary, #2563eb)' }} />
                      <span>Crear sugerencia</span>
                    </button>
                    <div style={{ height: 1, background: 'var(--color-border, #e2e8f0)', margin: '0 10px' }} />
                    <button
                      type="button"
                      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.875rem', textAlign: 'left', color: 'inherit' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface, #f8fafc)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      onClick={() => { setShowExcelImport(true); setShowCreateMenu(false) }}
                    >
                      <i className="pi pi-file-excel" style={{ color: '#16a34a' }} />
                      <span>Sugerencia desde Excel</span>
                    </button>
                  </div>
                )}
              </div>
            )
          )}
          {!statusProp && (
            <div className="transfer-issues-page__type-filter" role="group" aria-label="Filtro de estado">
              {[
                { key: 'borrador', label: 'Sugerencias' },
                { key: 'cotizacion', label: 'Verificar' },
                { key: 'confirmacion', label: 'Confirmación' },
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
          stateStorage="custom"
          customSaveState={widthHandlers.save}
          customRestoreState={widthHandlers.restore}
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
          rowClassName={(rowData) => ({ 'p-selectable-row': true, 'imp-row--borrador': rowData.estado === 'borrador', 'imp-row--cotizacion': rowData.estado === 'cotizacion', 'imp-row--confirmacion': rowData.estado === 'confirmacion' })}
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
        moduleActions={moduleActions}
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
        moduleActions={moduleActions}
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

      {showExcelImport && (
        <ImportacionExcelModal
          token={token}
          onClose={() => setShowExcelImport(false)}
          onCreated={() => { setShowExcelImport(false); fetchItems() }}
        />
      )}

      {showExcelDirecta && (
        <ImportacionExcelDirectaModal
          token={token}
          onClose={() => setShowExcelDirecta(false)}
          onCreated={() => {
            setShowExcelDirecta(false)
            if (status === 'importada') {
              fetchItems()
            } else {
              setActiveStatus('importada')
            }
          }}
        />
      )}
    </div>
  )
}

export default ImportacionesTable
