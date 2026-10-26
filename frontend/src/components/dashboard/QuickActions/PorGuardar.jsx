import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Checkbox } from 'primereact/checkbox'
import { Inbox, Search, X } from 'lucide-react'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDateTime } from '../../../utils/dateFormat'
import BlockerNotice from '../common/BlockerNotice'
import { matchesFirst } from '../common/productDetailMatches'
import ConfirmDialog from '../common/unsavedChanges/ConfirmDialog'
import { POR_GUARDAR_REFRESH_EVENT } from './porGuardarEvents'
import './PorGuardar.css'

// "Por ubicar": paso 2 de la recepcion de importaciones. Al confirmar la
// llegada todo entro al inventario en POR UBICAR (entre parentesis) y ya se
// puede vender; aqui se cuenta lo que queda de cada producto (lo vendido ya se
// desconto) y se guarda en su ubicacion. Al terminar, lo que no aparecio queda
// como faltante en Inconvenientes. Tambien lo demas que haya en POR UBICAR.
// Se ve igual que la recepcion de traslados: check por check y la barra suma.
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

const uniqueNames = (list) => [...new Set(list.filter(Boolean))]

// Desplegable de la recepcion de traslados (Bodega / Division / Subdivision).
function ReceiveDropdown({ label, value, placeholder, options, onSelect, disabled, darkMode, emptyMessage, searchPlaceholder }) {
  const [rect, setRect] = useState(null)
  const [query, setQuery] = useState('')
  const triggerRef = useRef(null)
  const panelRef = useRef(null)

  useEffect(() => {
    if (!rect) return undefined
    const close = (event) => {
      if (triggerRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) return
      setRect(null)
    }
    const closeOnScroll = (event) => {
      if (panelRef.current?.contains(event.target)) return
      setRect(null)
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('resize', closeOnScroll)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', closeOnScroll, true)
      window.removeEventListener('resize', closeOnScroll)
    }
  }, [rect])

  const term = normalize(query)
  const filtered = term ? options.filter((option) => normalize(option.label).includes(term)) : options
  const selected = options.find((option) => option.value === value) || null

  return (
    <div className="quick-actions__receive-location-field">
      <small>{label}</small>
      <div className="quick-actions__receive-dropdown">
        <button
          ref={triggerRef}
          type="button"
          className="quick-actions__receive-dropdown-trigger quick-actions__receive-dropdown-trigger--review"
          title={selected?.label || placeholder}
          aria-label={selected ? `${label}: ${selected.label}` : `Seleccionar ${label.toLowerCase()}`}
          onClick={() => {
            if (rect) {
              setRect(null)
              return
            }
            const box = triggerRef.current?.getBoundingClientRect()
            setQuery('')
            if (box) setRect({ top: box.bottom + 6, left: box.left, width: box.width })
          }}
          disabled={disabled}
        >
          <span>{selected?.label || placeholder}</span>
          <i className={`pi pi-chevron-${rect ? 'up' : 'down'}`} />
        </button>
      </div>
      {rect && createPortal(
        <div
          ref={panelRef}
          className={`quick-actions__receive-dropdown-panel quick-actions__receive-dropdown-panel--portal ${darkMode ? 'dark' : 'light'}`}
          style={{ position: 'fixed', top: rect.top, left: rect.left, width: Math.max(rect.width, 200), zIndex: 9999 }}
        >
          <div className="quick-actions__receive-dropdown-search">
            <Search size={13} />
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
          </div>
          <div className="quick-actions__receive-dropdown-results">
            {!filtered.length && <small className="muted">{term ? 'Sin resultados.' : emptyMessage}</small>}
            {filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                className="quick-actions__receive-dropdown-option"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onSelect(option.value)
                  setRect(null)
                }}
              >
                <strong>{option.label}</strong>
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

function PorGuardar({ token, darkMode, onSaved }) {
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [shipments, setShipments] = useState([])
  const [porUbicar, setPorUbicar] = useState([])
  const [locationsByBranch, setLocationsByBranch] = useState({})
  // key -> { bodega, division, subdivisionId, cantidad }
  const [drafts, setDrafts] = useState({})
  const [query, setQuery] = useState('')
  const [finishTarget, setFinishTarget] = useState(null)
  // Filas recien marcadas: el check se ve puesto mientras se guardan.
  const [checkingKeys, setCheckingKeys] = useState(() => new Set())
  // Filas que no se pudieron marcar: muestran por que (como en traslados).
  const [rowErrors, setRowErrors] = useState({})
  // Lo guardado de POR UBICAR en esta sesion: sale de la lista del servidor,
  // pero se sigue viendo con su check para que la barra vaya sumando.
  const [savedPorUbicar, setSavedPorUbicar] = useState({})

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
        const seed = (key, max, suggestedId) => {
          const previous = prev[key]
          next[key] = previous
            ? { ...previous, cantidad: Number(previous.cantidad) <= max ? previous.cantidad : String(max) }
            : { bodega: '', division: '', subdivisionId: suggestedId ? String(suggestedId) : '', cantidad: String(max) }
        }
        nextShipments.forEach((shipment) => {
          shipment.items.forEach((item) => seed(itemKey(shipment, item), item.pendiente, item.sugerida_subdivision_id))
        })
        nextPorUbicar.forEach((row) => seed(porUbicarKey(row), row.cantidad, row.sugerida_subdivision_id))
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
    setSavedPorUbicar({})
    setRowErrors({})
    void loadData()
    return undefined
  }, [open, loadData])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => { if (event.key === 'Escape' && !saving && !finishTarget) setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, saving, finishTarget])

  // Como al recibir un traslado: marcar el check guarda de una vez lo contado
  // en la ubicacion elegida. Si falta algo (cantidad o ubicacion) no se marca
  // y la fila dice por que.
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

  const updateDraft = (key, patch) => {
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))
    setRowErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const problemFor = (key, max) => {
    const draft = drafts[key] || {}
    const qty = Number.parseInt(String(draft.cantidad || ''), 10)
    if (!Number.isFinite(qty) || qty <= 0) return 'Indica cuantas contaste.'
    if (qty > max) return `Maximo ${max}.`
    if (!draft.subdivisionId) return 'Elige la bodega, division y subdivision donde lo guardas.'
    return ''
  }

  // Valida las filas antes de guardar; las que fallan muestran su motivo.
  const rejectProblems = (entries) => {
    const problems = entries.filter((entry) => entry.problem)
    if (!problems.length) return false
    setRowErrors((prev) => {
      const next = { ...prev }
      problems.forEach((entry) => { next[entry.key] = entry.problem })
      return next
    })
    setError(
      problems.length === 1
        ? '1 producto requiere atención antes de guardarlo.'
        : `${problems.length} productos requieren atención antes de guardarlos.`
    )
    return true
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
    const entries = items.map((item) => {
      const key = itemKey(shipment, item)
      return { key, problem: problemFor(key, item.pendiente) }
    })
    if (rejectProblems(entries)) return
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
    const entries = rows.map((row) => {
      const key = porUbicarKey(row)
      return { key, problem: problemFor(key, row.cantidad) }
    })
    if (rejectProblems(entries)) return
    setSaving(true)
    setError('')
    try {
      const items = rows.map((row) => {
        const draft = drafts[porUbicarKey(row)]
        return {
          producto_id: row.producto_id,
          sucursal_id: row.sucursal_id,
          subdivision_id: Number(draft.subdivisionId),
          cantidad: Number.parseInt(String(draft.cantidad), 10),
        }
      })
      const response = await authFetch(
        `${API_URL}/inventario/inventario/guardar-por-ubicar/`,
        { method: 'POST', body: JSON.stringify({ items }) },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar.')
      setSavedPorUbicar((prev) => {
        const next = { ...prev }
        rows.forEach((row, index) => {
          const key = porUbicarKey(row)
          next[key] = { row, guardado: (prev[key]?.guardado || 0) + items[index].cantidad }
        })
        return next
      })
      onSaved?.(`${rows.length} producto(s) guardados en su ubicacion.`)
      await loadData()
    } catch (requestError) {
      setError(requestError?.message || 'No se pudo guardar.')
    } finally {
      setSaving(false)
    }
  }

  // POR UBICAR: lo que queda en el servidor mas lo ya guardado en esta sesion.
  const porUbicarRows = useMemo(() => {
    const current = new Set(porUbicar.map(porUbicarKey))
    const list = porUbicar.map((row) => ({
      ...row,
      key: porUbicarKey(row),
      guardado: savedPorUbicar[porUbicarKey(row)]?.guardado || 0,
      done: false,
    }))
    Object.entries(savedPorUbicar).forEach(([key, saved]) => {
      if (!current.has(key)) list.push({ ...saved.row, key, cantidad: 0, guardado: saved.guardado, done: true })
    })
    return list
  }, [porUbicar, savedPorUbicar])

  const term = normalize(query)
  const matches = (item) => !term || normalize(`${item.producto_codigo} ${item.producto_nombre}`).includes(term)
  // Al buscar no se oculta nada: lo que coincide va primero.
  const visibleShipments = useMemo(
    () => {
      // Los grupos no se reordenan al buscar: el buscador vive dentro del
      // primero y moverlo le quitaria el foco mientras se escribe.
      return shipments.map((shipment) => ({
        ...shipment,
        visibleItems: term ? matchesFirst(shipment.items, matches) : shipment.items,
      }))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shipments, term]
  )
  const visiblePorUbicar = term ? matchesFirst(porUbicarRows, matches) : porUbicarRows
  const isEmpty = !shipments.length && !porUbicarRows.length
  const matchCount = term
    ? shipments.reduce((sum, s) => sum + s.items.filter(matches).length, 0) + porUbicarRows.filter(matches).length
    : 0
  const totalCount = shipments.reduce((sum, s) => sum + s.items.length, 0) + porUbicarRows.length

  const renderLocation = (key, branchId) => {
    const options = locationsByBranch[String(branchId)] || []
    const draft = drafts[key] || {}
    const selected = options.find((option) => String(option.id) === String(draft.subdivisionId)) || null
    const bodega = selected?.bodega || draft.bodega || ''
    const division = selected?.division || (bodega ? draft.division : '') || ''
    const bodegas = uniqueNames(options.map((option) => option.bodega))
    const divisions = bodega ? uniqueNames(options.filter((option) => option.bodega === bodega).map((option) => option.division)) : []
    const subdivisions = division
      ? options.filter((option) => option.bodega === bodega && option.division === division)
      : []
    return (
      <div className="quick-actions__receive-location-row quick-actions__receive-location-row--review">
        <ReceiveDropdown
          label="Bodega"
          value={bodega}
          placeholder="Selecciona"
          options={bodegas.map((name) => ({ value: name, label: name }))}
          onSelect={(name) => {
            const onlyDivisions = uniqueNames(options.filter((option) => option.bodega === name).map((option) => option.division))
            updateDraft(key, { bodega: name, division: onlyDivisions.length === 1 ? onlyDivisions[0] : '', subdivisionId: '' })
          }}
          disabled={saving}
          darkMode={darkMode}
          emptyMessage="Esta sucursal no tiene bodegas."
          searchPlaceholder="Buscar bodega"
        />
        <ReceiveDropdown
          label="Division"
          value={division}
          placeholder="Selecciona"
          options={divisions.map((name) => ({ value: name, label: name }))}
          onSelect={(name) => updateDraft(key, { bodega, division: name, subdivisionId: '' })}
          disabled={saving || !divisions.length}
          darkMode={darkMode}
          emptyMessage="Esta bodega no tiene divisiones."
          searchPlaceholder="Buscar division"
        />
        <ReceiveDropdown
          label="Subdivision"
          value={selected ? String(selected.id) : ''}
          placeholder="Selecciona"
          options={subdivisions.map((option) => ({ value: String(option.id), label: option.subdivision }))}
          onSelect={(id) => updateDraft(key, { bodega, division, subdivisionId: id })}
          disabled={saving || !subdivisions.length}
          darkMode={darkMode}
          emptyMessage="Esta división no tiene subdivisiones."
          searchPlaceholder="Buscar subdivision"
        />
      </div>
    )
  }

  // Barra de avance de cada grupo (igual a "Recibidos X de Y productos").
  const renderProgress = ({ done, total, unitsDone, unitsTotal, toStore }) => {
    const percent = total ? Math.round((done / total) * 100) : 0
    return (
      <div className="quick-actions__receive-progressbar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <div className="quick-actions__receive-progressbar-head">
          <strong>{`Guardados ${done} de ${total} productos`}</strong>
          <span>
            {`${unitsDone} de ${unitsTotal} unidades · ${percent}%`}
            {toStore > 0 ? ` · ${toStore} por guardar` : ''}
          </span>
        </div>
        <div className="quick-actions__receive-progressbar-track">
          <div className="quick-actions__receive-progressbar-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>
    )
  }

  // Una fila con el mismo formato que la recepcion de traslados.
  const renderRow = ({ key, row, done, pending, quantityLabel, stateText, branchId, onCheck, checkLabel }) => {
    const rowError = done ? '' : rowErrors[key] || ''
    const checked = done || checkingKeys.has(key)
    return (
      <article
        key={key}
        className={`quick-actions__receive-item${checked ? ' is-reviewed' : ''}${done ? ' is-ready is-registered' : ' is-pending'}${rowError ? ' has-validation-error' : ''}`}
      >
        <div className="quick-actions__receive-item-head quick-actions__receive-item-head--check">
          <label className="quick-actions__receive-check quick-actions__receive-check--row">
            <Checkbox
              binary
              inputId={`por-ubicar-${key}`}
              checked={checked}
              onChange={(event) => { if (event.checked) void onCheck() }}
              disabled={saving || done || checkingKeys.has(key)}
              aria-label={checkLabel}
            />
          </label>

          <div
            className="quick-actions__receive-item-title"
            title={[row.producto_codigo, String(row.producto_nombre || '').trim()].filter(Boolean).join(' – ')}
          >
            <small className="quick-actions__receive-col-label">Producto</small>
            <strong>{row.producto_codigo}</strong>
            {!!String(row.producto_nombre || '').trim() && (
              <p className="quick-actions__receive-item-name">{String(row.producto_nombre).trim()}</p>
            )}
          </div>

          <div className={`quick-actions__receive-item-badge${done ? ' is-received' : ' is-pending'}`}>
            {done ? 'Guardado' : 'Por ubicar'}
          </div>
        </div>

        <div className="quick-actions__receive-item-meta">
          <span>
            {quantityLabel}
            <strong>{pending}</strong>
          </span>
        </div>

        <div className="quick-actions__receive-grid quick-actions__receive-grid--receive">
          <label className="quick-actions__receive-count-field quick-actions__receive-count-field--inline">
            <span>Contados</span>
            <small className="quick-actions__receive-col-label">Contados</small>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="0"
              value={done ? String(row.guardado ?? '') : drafts[key]?.cantidad ?? ''}
              onChange={(event) => updateDraft(key, { cantidad: event.target.value.replace(/[^\d]/g, '') })}
              disabled={saving || done}
              aria-label={`Cuantas contaste de ${row.producto_codigo}`}
            />
          </label>
        </div>

        {!done && renderLocation(key, branchId)}

        {stateText && (
          <div className={`quick-actions__receive-item-state${done ? ' is-received' : ' is-to-store'}`}>
            <span>{stateText}</span>
          </div>
        )}

        {rowError && (
          <p className="quick-actions__receive-item-hint quick-actions__receive-item-hint--warning">{rowError}</p>
        )}
      </article>
    )
  }

  const renderListHeader = (quantityLabel) => (
    <div className="quick-actions__receive-list-header" aria-hidden="true">
      <span className="quick-actions__receive-list-header-cell quick-actions__receive-list-header-cell--product">Producto</span>
      <div className="quick-actions__receive-list-header-locations">
        <span className="quick-actions__receive-list-header-cell">Bodega</span>
        <span className="quick-actions__receive-list-header-cell">Division</span>
        <span className="quick-actions__receive-list-header-cell">Subdivision</span>
      </div>
      <span className="quick-actions__receive-list-header-cell quick-actions__receive-list-header-cell--stat quick-actions__receive-list-header-cell--expected">
        {quantityLabel}
      </span>
      <span className="quick-actions__receive-list-header-cell quick-actions__receive-list-header-cell--stat quick-actions__receive-list-header-cell--received">
        Contados
      </span>
      <span className="quick-actions__receive-list-header-cell quick-actions__receive-list-header-cell--check" />
    </div>
  )

  // Justo encima de la lista de productos del primer grupo.
  const searchBar = (
    <div className="quick-actions__receive-search-bar">
      <div className="quick-actions__receive-search">
        <input
          type="text"
          placeholder="Buscar por código, descripción o documento..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            className="quick-actions__receive-search-clear"
            onClick={() => setQuery('')}
            aria-label="Limpiar búsqueda"
          >
            ×
          </button>
        )}
      </div>
      {term && (
        <span className="quick-actions__receive-search-count">{matchCount} de {totalCount}</span>
      )}
    </div>
  )

  // Sin "Marcar todo": cada producto se cuenta y se marca uno por uno.
  const renderGroupHead = ({ title, subtitle, extra }) => (
    <div className="por-guardar__group-head">
      <div className="por-guardar__group-copy">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      {extra && <div className="por-guardar__group-actions">{extra}</div>}
    </div>
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
            <Inbox className="quick-actions__pending-shipments-icon" aria-hidden="true" />
            <span className="quick-actions__pending-shipments-label">Por ubicar</span>
            <span className="quick-actions__pending-shipments-count">{count}</span>
          </button>
        </div>
      )}

      {open && createPortal(
        <div
          className={`quick-actions__receive-overlay por-guardar__overlay ${darkMode ? 'dark' : 'light'}`}
          onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setOpen(false) }}
        >
          <div
            className={`quick-actions__receive-dialog por-guardar__dialog ${darkMode ? 'dark' : 'light'}`}
            role="dialog"
            aria-modal="true"
            aria-label="Por ubicar"
          >
            <header className="quick-actions__receive-head">
              <div className="quick-actions__receive-head-columns">
                <div className="quick-actions__receive-head-col por-guardar__head-copy">
                  <h4>Por ubicar</h4>
                  <p>
                    Envíos que ya llegaron (importaciones y compras locales): ya se pueden vender. Cuenta{' '}
                    <strong>lo que queda</strong> de cada producto, elige su ubicación y marca el check.
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="quick-actions__receive-close"
                onClick={() => setOpen(false)}
                disabled={saving}
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </header>

            <div className="quick-actions__receive-body">
              {error && <BlockerNotice compact title={error} />}

              {loading && isEmpty ? (
                <p className="quick-actions__receive-loading">Cargando...</p>
              ) : isEmpty ? (
                <p className="quick-actions__receive-empty">
                  No hay nada por ubicar. Cuando confirmes la llegada de un envío (importación o compra local), aparece aquí.
                </p>
              ) : (
                <div className="quick-actions__receive-step quick-actions__receive-step--list">
                  {visibleShipments.map((shipment, index) => {
                    const pendientes = shipment.items.filter((item) => item.pendiente > 0)
                    const doneCount = shipment.items.length - pendientes.length
                    return (
                      <section key={shipmentKey(shipment)} className="por-guardar__group">
                        {renderGroupHead({
                          title: `${shipment.origen === 'Compra local' ? 'Compra local' : 'Importación'} #${shipment.codigo}`,
                          subtitle: [
                            `Para ${shipment.sucursal_nombre}`,
                            shipment.llegada_confirmada_en && `llegó ${formatDateTime(shipment.llegada_confirmada_en)}`,
                          ].filter(Boolean).join(' · '),
                          extra: (
                            <button
                              type="button"
                              className="quick-actions__receive-btn quick-actions__receive-btn--danger"
                              onClick={() => setFinishTarget(shipment)}
                              disabled={saving}
                              title="Terminar el conteo: lo que falta contar queda como faltante en Inconvenientes"
                            >
                              Terminar conteo
                            </button>
                          ),
                        })}
                        {renderProgress({
                          done: doneCount,
                          total: shipment.items.length,
                          unitsDone: shipment.items.reduce((sum, item) => sum + item.guardado + (item.vendido || 0), 0),
                          unitsTotal: shipment.items.reduce((sum, item) => sum + item.enviado, 0),
                          toStore: pendientes.length,
                        })}
                        {index === 0 && searchBar}
                        <div className="quick-actions__receive-list">
                          {renderListHeader('Quedan')}
                          {shipment.visibleItems.map((item) => {
                            const done = item.pendiente === 0
                            const facts = [
                              `Enviados ${item.enviado}`,
                              item.vendido ? `vendidos ${item.vendido}` : '',
                              item.guardado ? `guardados ${item.guardado}` : '',
                            ].filter(Boolean).join(' · ')
                            return renderRow({
                              key: itemKey(shipment, item),
                              row: item,
                              done,
                              pending: item.pendiente,
                              quantityLabel: 'Quedan',
                              stateText: done
                                ? `Contado completo · ${facts}`
                                : (item.vendido || item.guardado) ? `${facts} · quedan ${item.pendiente} por contar` : '',
                              branchId: shipment.sucursal_id,
                              onCheck: () => checkShipmentItems(shipment, [item]),
                              checkLabel: `Marcar ${item.producto_codigo} como contado`,
                            })
                          })}
                        </div>
                      </section>
                    )
                  })}

                  {visiblePorUbicar.length > 0 && (() => {
                    const pendientes = porUbicarRows.filter((row) => !row.done)
                    const doneCount = porUbicarRows.length - pendientes.length
                    return (
                      <section className="por-guardar__group">
                        {renderGroupHead({
                          title: 'En POR UBICAR',
                          subtitle: 'Ya están en el inventario (ej. de un inconveniente); falta guardarlos en su ubicación.',
                        })}
                        {renderProgress({
                          done: doneCount,
                          total: porUbicarRows.length,
                          unitsDone: porUbicarRows.reduce((sum, row) => sum + row.guardado, 0),
                          unitsTotal: porUbicarRows.reduce((sum, row) => sum + row.guardado + row.cantidad, 0),
                          toStore: pendientes.length,
                        })}
                        {!visibleShipments.length && searchBar}
                        <div className="quick-actions__receive-list">
                          {renderListHeader('Por ubicar')}
                          {visiblePorUbicar.map((row) => renderRow({
                            key: row.key,
                            row,
                            done: row.done,
                            pending: row.cantidad,
                            quantityLabel: 'Por ubicar',
                            stateText: row.done
                              ? `Guardado · ${row.guardado} en su ubicación · ${row.sucursal_nombre}`
                              : row.guardado ? `Guardados ${row.guardado} · quedan ${row.cantidad} en POR UBICAR · ${row.sucursal_nombre}` : '',
                            branchId: row.sucursal_id,
                            onCheck: () => checkPorUbicar([row]),
                            checkLabel: `Guardar ${row.producto_codigo} en su ubicacion`,
                          }))}
                        </div>
                      </section>
                    )
                  })()}
                </div>
              )}
            </div>

            <footer className="quick-actions__receive-actions">
              <button
                type="button"
                className="quick-actions__receive-btn quick-actions__receive-btn--cancel"
                onClick={() => setOpen(false)}
                disabled={saving}
              >
                Cerrar
              </button>
            </footer>
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
