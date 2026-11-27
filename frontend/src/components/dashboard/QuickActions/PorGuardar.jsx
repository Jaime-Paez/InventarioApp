import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Checkbox } from 'primereact/checkbox'
import { Check, ChevronDown, Inbox, Info, Search, X } from 'lucide-react'
import { API_URL, authFetch } from '../../../utils/api'
import { exportToExcel } from '../../../utils/exportUtils'
import { formatDateTime } from '../../../utils/dateFormat'
import BlockerNotice from '../common/BlockerNotice'
import { matchesFirst } from '../common/productDetailMatches'
import ConfirmDialog from '../common/unsavedChanges/ConfirmDialog'
import { POR_GUARDAR_REFRESH_EVENT } from './porGuardarEvents'
import usePillExit from './usePillExit'
import '../admin/UsersTable/UsersTable.css'
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

// Cada producto puede guardarse en varias ubicaciones: una linea por ubicacion
// con su cantidad.
const emptyLine = () => ({ bodega: '', division: '', subdivisionId: '', cantidad: '' })
const linesOf = (draft) => (Array.isArray(draft?.lines) && draft.lines.length ? draft.lines : [emptyLine()])
const lineQty = (line) => {
  const qty = Number.parseInt(String(line?.cantidad || ''), 10)
  return Number.isFinite(qty) ? qty : 0
}
const linesTotal = (lines) => lines.reduce((sum, line) => sum + lineQty(line), 0)

// Icono "i" (como en importaciones): tabla con las ubicaciones del producto y
// de sus alternos en la sucursal; clic en una fila la usa. Se abre al pasar el
// mouse o al tocarlo (celular).
function UbicacionesInfo({ options, usadas, onPick, darkMode, disabled }) {
  const [anchor, setAnchor] = useState(null)
  const [pinned, setPinned] = useState(false)
  const iconRef = useRef(null)
  const cardRef = useRef(null)
  const timerRef = useRef(null)
  const cancel = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }
  const open = () => {
    cancel()
    const rect = iconRef.current?.getBoundingClientRect()
    if (rect) setAnchor(rect)
  }
  const close = () => {
    cancel()
    setAnchor(null)
    setPinned(false)
  }
  const closeSoon = () => {
    if (pinned) return
    cancel()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setAnchor(null)
    }, 250)
  }
  useEffect(() => cancel, [])
  useEffect(() => {
    if (!anchor) return undefined
    const onDown = (event) => {
      if (iconRef.current?.contains(event.target) || cardRef.current?.contains(event.target)) return
      close()
    }
    const onScroll = (event) => {
      if (cardRef.current?.contains(event.target)) return
      // Abierta con un toque: sigue al icono; con el mouse, se cierra.
      if (pinned) {
        const rect = iconRef.current?.getBoundingClientRect()
        if (rect) setAnchor(rect)
        return
      }
      close()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('touchstart', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('touchstart', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(anchor), pinned])

  const width = Math.min(560, window.innerWidth - 24)
  const left = anchor ? Math.max(12, Math.min(anchor.left - 12, window.innerWidth - width - 12)) : 0
  const below = anchor ? anchor.bottom + 6 : 0
  const placeAbove = anchor && below + 260 > window.innerHeight && anchor.top > 280
  const style = anchor
    ? {
        position: 'fixed',
        left,
        width,
        zIndex: 10000,
        ...(placeAbove ? { bottom: window.innerHeight - anchor.top + 6 } : { top: below }),
      }
    : null
  return (
    <>
      <button
        ref={iconRef}
        type="button"
        className={`por-guardar__info${options.length ? '' : ' is-empty'}`}
        onMouseEnter={open}
        onMouseLeave={closeSoon}
        onClick={() => {
          if (anchor && pinned) {
            close()
            return
          }
          open()
          setPinned(true)
        }}
        aria-label="Ubicaciones del producto y de sus alternos"
      >
        <Info size={14} />
      </button>
      {anchor && createPortal(
        <div
          ref={cardRef}
          className={`por-guardar__info-card ${darkMode ? 'dark' : 'light'}`}
          style={style}
          onMouseEnter={cancel}
          onMouseLeave={closeSoon}
        >
          {options.length ? (
            <table>
              <thead>
                <tr><th>Producto</th><th>Ubicación</th><th>Stock</th></tr>
              </thead>
              <tbody>
                {options.map((option, index) => {
                  const usada = usadas.has(String(option.subdivision_id))
                  return (
                    <tr
                      key={`${option.subdivision_id}-${option.producto_id}-${index}`}
                      className={`${disabled ? '' : 'is-pickable'}${usada ? ' is-usada' : ''}`}
                      onClick={disabled ? undefined : () => { onPick(option.subdivision_id); close() }}
                      data-title={disabled ? undefined : 'Clic para usar esta ubicación'}
                    >
                      <td>
                        {usada && <Check size={13} className="por-guardar__info-check" aria-label="En uso" />}
                        {option.propia ? 'Este producto' : option.producto_codigo}
                        {!option.propia && option.posible && <em> (posible)</em>}
                      </td>
                      <td>{option.label}</td>
                      <td>{option.cantidad}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <p className="por-guardar__info-empty">Ni este producto ni sus alternos tienen ubicación en esta sucursal.</p>
          )}
        </div>,
        document.body
      )}
    </>
  )
}

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
    document.addEventListener('mousedown', close, true)
    window.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('resize', closeOnScroll)
    return () => {
      document.removeEventListener('mousedown', close, true)
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
  const pill = usePillExit(count > 0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [shipments, setShipments] = useState([])
  const [porUbicar, setPorUbicar] = useState([])
  const [locationsByBranch, setLocationsByBranch] = useState({})
  // key -> { bodega, division, subdivisionId, cantidad }
  const [drafts, setDrafts] = useState({})
  const [query, setQuery] = useState('')
  const [faltanteTarget, setFaltanteTarget] = useState(null)
  // Grupos (importaciones / POR UBICAR) desplegables, como en Sucursales:
  // al abrir solo el primero esta desplegado.
  const [abiertos, setAbiertos] = useState(null)
  // Filas recien marcadas: el check se ve puesto mientras se guardan.
  const [checkingKeys, setCheckingKeys] = useState(() => new Set())
  // Filas que no se pudieron marcar: muestran por que (como en traslados).
  const [rowErrors, setRowErrors] = useState({})
  // Lo guardado de POR UBICAR en esta sesion: sale de la lista del servidor,
  // pero se sigue viendo con su check para que la barra vaya sumando.
  const [savedPorUbicar, setSavedPorUbicar] = useState({})
  // Lo escogido sin marcar el check se guarda en la base de datos (en cada
  // cambio) para no perderlo y para el Excel de ubicaciones.
  const metaRef = useRef({})
  const draftsRef = useRef({})
  const autosaveTimers = useRef({})

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
      const meta = {}
      nextShipments.forEach((shipment) => {
        shipment.items.forEach((item) => {
          meta[itemKey(shipment, item)] = { envio_id: shipment.id, sucursal_id: shipment.sucursal_id, producto_id: item.producto_id }
        })
      })
      nextPorUbicar.forEach((row) => {
        meta[porUbicarKey(row)] = { envio_id: null, sucursal_id: row.sucursal_id, producto_id: row.producto_id }
      })
      metaRef.current = meta
      setDrafts((prev) => {
        const next = {}
        // Lo que ya se escogio (en pantalla o guardado como borrador) se
        // respeta; si no, la ubicacion sugerida con todo lo que queda.
        const seed = (key, max, row) => {
          const previous = prev[key]
          if (previous?.lines?.length) {
            next[key] = previous.lines.length === 1
              ? { lines: [{ ...previous.lines[0], cantidad: lineQty(previous.lines[0]) <= max ? previous.lines[0].cantidad : String(max) }] }
              : previous
            return
          }
          const borrador = Array.isArray(row?.borrador) ? row.borrador : []
          if (borrador.length) {
            next[key] = {
              lines: borrador.map((entry) => ({
                ...emptyLine(),
                subdivisionId: entry?.subdivision_id ? String(entry.subdivision_id) : '',
                cantidad: entry?.cantidad != null ? String(entry.cantidad) : '',
              })),
            }
            return
          }
          next[key] = {
            lines: [{ ...emptyLine(), subdivisionId: row?.sugerida_subdivision_id ? String(row.sugerida_subdivision_id) : '', cantidad: String(max) }],
          }
        }
        nextShipments.forEach((shipment) => {
          shipment.items.forEach((item) => seed(itemKey(shipment, item), item.pendiente, item))
        })
        nextPorUbicar.forEach((row) => seed(porUbicarKey(row), row.cantidad, row))
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
    setAbiertos(null)
    setSavedPorUbicar({})
    setRowErrors({})
    void loadData()
    return undefined
  }, [open, loadData])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => { if (event.key === 'Escape' && !saving && !faltanteTarget) setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, saving, faltanteTarget])

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
  // Si contaron menos de lo que queda, se confirma: lo que falta sale del
  // inventario y queda como faltante en Inconvenientes al marcar el check.
  const checkShipmentItems = (shipment, items) => {
    const item = items[0]
    const key = itemKey(shipment, item)
    const total = linesTotal(linesOf(drafts[key]))
    if (items.length === 1 && total < item.pendiente) {
      const problem = problemFor(key, item.pendiente, { allowZero: true })
      if (rejectProblems([{ key, problem }])) return Promise.resolve()
      setFaltanteTarget({ shipment, item, total })
      return Promise.resolve()
    }
    return checkRows(items.map((it) => itemKey(shipment, it)), () => saveShipmentItems(shipment, items))
  }
  const checkPorUbicar = (rows) => checkRows(rows.map(porUbicarKey), () => savePorUbicar(rows))

  useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])

  // Guarda en la base de datos lo escogido para el producto (medio segundo
  // despues del ultimo cambio).
  const persistDraft = useCallback((key) => {
    window.clearTimeout(autosaveTimers.current[key])
    autosaveTimers.current[key] = window.setTimeout(async () => {
      delete autosaveTimers.current[key]
      const meta = metaRef.current[key]
      if (!meta) return
      const lines = linesOf(draftsRef.current[key])
      try {
        await authFetch(
          `${API_URL}/inventario/inventario/por-guardar/borrador/`,
          {
            method: 'POST',
            body: JSON.stringify({
              ...meta,
              ubicaciones: lines.map((line) => ({
                subdivision_id: line.subdivisionId ? Number(line.subdivisionId) : null,
                cantidad: String(line.cantidad || '').trim() === '' ? null : lineQty(line),
              })),
            }),
          },
          token
        )
      } catch {
        // Se vuelve a intentar con el siguiente cambio.
      }
    }, 500)
  }, [token])
  const cancelPersist = (keys) => {
    keys.forEach((key) => {
      window.clearTimeout(autosaveTimers.current[key])
      delete autosaveTimers.current[key]
    })
  }

  const setLines = (key, updater) => {
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], lines: updater(linesOf(prev[key])) } }))
    setRowErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    persistDraft(key)
  }
  const updateLine = (key, index, patch) =>
    setLines(key, (lines) => lines.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  const addLine = (key, max) =>
    setLines(key, (lines) => {
      const rest = max - linesTotal(lines)
      return [...lines, { ...emptyLine(), cantidad: rest > 0 ? String(rest) : '' }]
    })
  const removeLine = (key, index) =>
    setLines(key, (lines) => (lines.length > 1 ? lines.filter((_, i) => i !== index) : lines))
  // Tocar una opcion (propia o de un alterno): llena la primera linea sin
  // ubicacion; con una sola linea la reemplaza; si no, agrega otra.
  const applyLocation = (key, subdivisionId, max) =>
    setLines(key, (lines) => {
      const located = { bodega: '', division: '', subdivisionId: String(subdivisionId) }
      const empty = lines.findIndex((line) => !line.subdivisionId)
      if (empty >= 0) return lines.map((line, i) => (i === empty ? { ...line, ...located } : line))
      if (lines.length === 1) return [{ ...lines[0], ...located }]
      const rest = max - linesTotal(lines)
      return [...lines, { ...emptyLine(), ...located, cantidad: rest > 0 ? String(rest) : '' }]
    })

  const problemFor = (key, max, { allowZero = false } = {}) => {
    const lines = linesOf(drafts[key])
    if (allowZero && lines.length === 1 && lineQty(lines[0]) === 0) return ''
    for (const line of lines) {
      if (lineQty(line) <= 0) return lines.length > 1 ? 'Indica cuantas van en cada ubicacion.' : 'Indica cuantas contaste.'
      if (!line.subdivisionId) return 'Elige la bodega, division y subdivision donde lo guardas.'
    }
    const total = linesTotal(lines)
    if (total > max) return lines.length > 1 ? `Maximo ${max} entre todas las ubicaciones (van ${total}).` : `Maximo ${max}.`
    return ''
  }
  const linesToItems = (key, extra) =>
    linesOf(drafts[key]).map((line) => ({ ...extra, cantidad: lineQty(line), subdivision_id: Number(line.subdivisionId) }))

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

  const saveShipmentItems = async (shipment, items, { faltante = false } = {}) => {
    const entries = items.map((item) => {
      const key = itemKey(shipment, item)
      return { key, problem: problemFor(key, item.pendiente, { allowZero: faltante }) }
    })
    if (rejectProblems(entries)) return
    cancelPersist(entries.map((entry) => entry.key))
    setSaving(true)
    setError('')
    try {
      // Mueve lo contado desde POR UBICAR a su ubicacion (ya estaba en el
      // stock: no se suma de nuevo).
      const toStore = items
        .flatMap((item) => linesToItems(itemKey(shipment, item), { producto_id: item.producto_id }))
        .filter((entry) => entry.cantidad > 0)
      if (toStore.length) {
        const response = await authFetch(
          `${shipmentBase(shipment)}/guardar-ubicaciones/`,
          { method: 'POST', body: JSON.stringify({ items: toStore }) },
          token
        )
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar.')
      }
      let faltantes = 0
      if (faltante) {
        for (const item of items) {
          const response = await authFetch(
            `${shipmentBase(shipment)}/faltante-producto/`,
            { method: 'POST', body: JSON.stringify({ producto_id: item.producto_id }) },
            token
          )
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo registrar el faltante.')
          faltantes += Number(payload?.faltante) || 0
        }
      }
      const fresh = await loadData()
      const updated = fresh?.shipments?.find((row) => shipmentKey(row) === shipmentKey(shipment))
      if (updated && updated.items.every((item) => item.pendiente === 0)) {
        // Ya no queda nada por contar: el envio se cierra solo.
        await finishShipment(updated)
        await loadData()
        onSaved?.(`${shipment.codigo}: todo contado, envío completo.`)
      } else if (faltantes) {
        onSaved?.(`Guardado. Faltan ${faltantes}: quedaron en Inconvenientes.`)
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
    cancelPersist(entries.map((entry) => entry.key))
    setSaving(true)
    setError('')
    try {
      const totals = rows.map((row) => linesTotal(linesOf(drafts[porUbicarKey(row)])))
      const items = rows.flatMap((row) =>
        linesToItems(porUbicarKey(row), { producto_id: row.producto_id, sucursal_id: row.sucursal_id })
      )
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
          next[key] = { row, guardado: (prev[key]?.guardado || 0) + totals[index] }
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

  const renderLine = (key, branchId, line, index, total) => {
    const options = locationsByBranch[String(branchId)] || []
    const selected = options.find((option) => String(option.id) === String(line.subdivisionId)) || null
    const bodega = selected?.bodega || line.bodega || ''
    const division = selected?.division || (bodega ? line.division : '') || ''
    const bodegas = uniqueNames(options.map((option) => option.bodega))
    const divisions = bodega ? uniqueNames(options.filter((option) => option.bodega === bodega).map((option) => option.division)) : []
    const subdivisions = division
      ? options.filter((option) => option.bodega === bodega && option.division === division)
      : []
    const multi = total > 1
    return (
      <div
        key={index}
        className={`quick-actions__receive-location-row quick-actions__receive-location-row--review por-guardar__linea${multi ? ' is-multi' : ''}${index > 0 ? ' por-guardar__linea--extra' : ''}`}
      >
        <ReceiveDropdown
          label="Bodega"
          value={bodega}
          placeholder="Selecciona"
          options={bodegas.map((name) => ({ value: name, label: name }))}
          onSelect={(name) => {
            const onlyDivisions = uniqueNames(options.filter((option) => option.bodega === name).map((option) => option.division))
            updateLine(key, index, { bodega: name, division: onlyDivisions.length === 1 ? onlyDivisions[0] : '', subdivisionId: '' })
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
          onSelect={(name) => updateLine(key, index, { bodega, division: name, subdivisionId: '' })}
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
          onSelect={(id) => updateLine(key, index, { bodega, division, subdivisionId: id })}
          disabled={saving || !subdivisions.length}
          darkMode={darkMode}
          emptyMessage="Esta división no tiene subdivisiones."
          searchPlaceholder="Buscar subdivision"
        />
        {multi && (
          <label className="por-guardar__linea-cant">
            <small>Cant.</small>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="0"
              value={line.cantidad}
              onChange={(event) => updateLine(key, index, { cantidad: event.target.value.replace(/[^\d]/g, '') })}
              disabled={saving}
              aria-label="Cantidad en esta ubicación"
            />
          </label>
        )}
        {multi && (
          <button
            type="button"
            className="por-guardar__linea-quitar"
            onClick={() => removeLine(key, index)}
            disabled={saving}
            aria-label="Quitar esta ubicación"
            data-title="Quitar esta ubicación"
          >
            <X size={14} />
          </button>
        )}
      </div>
    )
  }

  // Opciones del "i": sus ubicaciones y las de sus alternos (o posibles
  // alternos, mismo codigo base) en esa sucursal.
  const locationOptions = (row) => [...(row.ubicaciones_propias || []), ...(row.ubicaciones_alternos || [])]

  const renderLocation = (key, branchId, row, max) => {
    const options = locationsByBranch[String(branchId)] || []
    const sinUbicaciones = Array.isArray(locationsByBranch[String(branchId)]) && !options.length
    const lines = linesOf(drafts[key])
    return (
      <div className="por-guardar__ubicaciones">
        {sinUbicaciones && (
          <BlockerNotice
            compact
            title="No hay dónde guardarlo"
            reason="Esta sucursal no tiene bodegas con divisiones y subdivisiones. Créalas en Bodegas y aparecerán aquí."
            goTo="Bodegas"
          />
        )}
        {lines.map((line, index) => renderLine(key, branchId, line, index, lines.length))}
        <div className="por-guardar__ubic-tools">
          <button
            type="button"
            className="por-guardar__add-line"
            onClick={() => addLine(key, max)}
            disabled={saving}
          >
            + Otra ubicación
          </button>
          <span className="por-guardar__info-label">Ubicaciones de alternos</span>
          <UbicacionesInfo
            options={locationOptions(row)}
            usadas={new Set(lines.map((line) => String(line.subdivisionId)))}
            onPick={(subdivisionId) => applyLocation(key, subdivisionId, max)}
            darkMode={darkMode}
            disabled={saving}
          />
        </div>
        {row.sugerida_alterno_codigo && lines.length === 1 && String(lines[0].subdivisionId) === String(row.sugerida_subdivision_id) && (
          <small className="por-guardar__ubic-nota">{`No tiene ubicación propia: sugerida la de ${row.sugerida_alterno_codigo}.`}</small>
        )}
      </div>
    )
  }

  // Excel con las ubicaciones de un grupo (importacion, compra o POR UBICAR):
  // lo escogido en pantalla (con el reparto) o la sugerida, y las de alternos.
  const exportUbicaciones = async (title, entries) => {
    const labelOf = (branchId, id) =>
      (locationsByBranch[String(branchId)] || []).find((option) => String(option.id) === String(id))?.label || ''
    const data = []
    entries.forEach(({ key, row, pending, branchId, sucursal }) => {
      if (pending <= 0) return
      const lines = linesOf(drafts[key])
      const propias = (row.ubicaciones_propias || []).map((loc) => `${loc.label} (${loc.cantidad})`).join(' | ')
      const alternos = (row.ubicaciones_alternos || [])
        .map((loc) => `${loc.producto_codigo}${loc.posible ? ' (posible)' : ''}: ${loc.label} (${loc.cantidad})`)
        .join(' | ')
      lines.forEach((line, index) => {
        const esSugerida = !(row.borrador || []).length && lines.length === 1 && String(line.subdivisionId) === String(row.sugerida_subdivision_id || '')
        data.push({
          codigo: row.producto_codigo,
          descripcion: row.producto_nombre,
          sucursal,
          por_guardar: index === 0 ? pending : '',
          ubicacion: line.subdivisionId ? labelOf(branchId, line.subdivisionId) : 'Sin ubicación',
          cantidad: line.cantidad || '',
          origen: !line.subdivisionId
            ? ''
            : esSugerida
              ? (row.sugerida_alterno_codigo ? `Sugerida (de ${row.sugerida_alterno_codigo})` : 'Sugerida (su ubicación)')
              : 'Escogida',
          propias: index === 0 ? propias : '',
          alternos: index === 0 ? alternos : '',
        })
      })
    })
    await exportToExcel({
      rows: data,
      columns: [
        { key: 'codigo', header: 'Código' },
        { key: 'descripcion', header: 'Descripción' },
        { key: 'sucursal', header: 'Sucursal' },
        { key: 'por_guardar', header: 'Por guardar' },
        { key: 'ubicacion', header: 'Ubicación' },
        { key: 'cantidad', header: 'Cantidad' },
        { key: 'origen', header: 'Origen' },
        { key: 'propias', header: 'Sus ubicaciones' },
        { key: 'alternos', header: 'Ubicaciones de alternos' },
      ],
      valueGetter: (item, columnKey) => item[columnKey],
      fileName: `Ubicaciones ${title}`.replace(/[\\/:*?"<>|#]/g, '').trim(),
    })
  }
  const excelButton = (onClick) => (
    <button
      type="button"
      className="users-circle users-circle--excel por-guardar__excel"
      onClick={onClick}
      disabled={saving}
      aria-label="Descargar Excel con las ubicaciones"
      data-title="Excel con las ubicaciones (lo escogido aquí y las sugeridas)"
    >
      <i className="pi pi-file-excel" />
    </button>
  )

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
    const lines = linesOf(drafts[key])
    const multi = lines.length > 1
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
              value={done ? String(row.guardado ?? '') : multi ? String(linesTotal(lines)) : lines[0]?.cantidad ?? ''}
              onChange={(event) => updateLine(key, 0, { cantidad: event.target.value.replace(/[^\d]/g, '') })}
              disabled={saving || done || multi}
              data-title={multi ? 'Es la suma de las ubicaciones' : undefined}
              aria-label={`Cuantas contaste de ${row.producto_codigo}`}
            />
          </label>
        </div>

        {!done && renderLocation(key, branchId, row, pending)}

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
  const groupKeys = [...shipments.map(shipmentKey), ...(porUbicarRows.length ? ['por-ubicar'] : [])]
  const abiertosActuales = abiertos ?? new Set(groupKeys.slice(0, 1))
  // Al buscar se ven todos los grupos abiertos (para no esconder coincidencias).
  const isCerrado = (key) => !term && !abiertosActuales.has(key)
  const toggleGrupo = (key) => {
    const next = new Set(abiertosActuales)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setAbiertos(next)
  }
  const renderGroupHead = ({ groupKey, title, subtitle, extra }) => {
    const cerrado = isCerrado(groupKey)
    return (
      <div className={`por-guardar__group-head${cerrado ? ' is-cerrado' : ''}`}>
        <button
          type="button"
          className={`por-guardar__group-toggle${cerrado ? ' is-cerrado' : ''}`}
          onClick={() => toggleGrupo(groupKey)}
          aria-expanded={!cerrado}
          aria-label={cerrado ? `Desplegar ${title}` : `Minimizar ${title}`}
        >
          <span className="por-guardar__group-circle" aria-hidden="true">
            <ChevronDown size={18} className="por-guardar__group-chevron" />
          </span>
          <span className="por-guardar__group-copy">
            <strong>{title}</strong>
            {subtitle && <span>{subtitle}</span>}
          </span>
        </button>
        {extra && <div className="por-guardar__group-actions">{extra}</div>}
      </div>
    )
  }
  // Cuerpo del grupo: siempre montado para que abra y cierre con animacion
  // (altura real con grid 0fr -> 1fr); cerrado queda `inert` (sin tab ni clic).
  const renderGroupBody = (groupKey, children) => {
    const cerrado = isCerrado(groupKey)
    return (
      <div className={`por-guardar__group-body${cerrado ? ' is-cerrado' : ''}`} inert={cerrado} aria-hidden={cerrado}>
        <div className="por-guardar__group-body-inner">{children}</div>
      </div>
    )
  }

  return (
    <>
      {/* Como "Envios en camino" y "Envios pendientes": solo aparece si hay
          algo por ubicar (el dialogo abierto se mantiene aunque llegue a 0). */}
      {pill.present && (
        <div className={`quick-actions__pending-shipments por-guardar__dock${pill.leaving ? ' is-leaving' : ''}`}>
          <button
            type="button"
            className="quick-actions__pending-shipments-trigger por-guardar__trigger has-items"
            onClick={() => setOpen(true)}
            aria-label={`Por ubicar: ${count} producto(s)`}
            data-title="Por ubicar"
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
                  {searchBar}
                  {visibleShipments.map((shipment) => {
                    const pendientes = shipment.items.filter((item) => item.pendiente > 0)
                    const doneCount = shipment.items.length - pendientes.length
                    return (
                      <section key={shipmentKey(shipment)} className="por-guardar__group">
                        {renderGroupHead({
                          groupKey: shipmentKey(shipment),
                          title: `${shipment.origen === 'Compra local' ? 'Compra local' : 'Importación'} #${shipment.codigo}`,
                          subtitle: [
                            `Para ${shipment.sucursal_nombre}`,
                            shipment.llegada_confirmada_en && `llegó ${formatDateTime(shipment.llegada_confirmada_en)}`,
                            `${pendientes.length} de ${shipment.items.length} productos por guardar`,
                            `${pendientes.reduce((sum, item) => sum + item.pendiente, 0)} unidades`,
                          ].filter(Boolean).join(' · '),
                          extra: (
                            <>
                              {excelButton(() => exportUbicaciones(shipment.codigo, shipment.items.map((item) => ({
                                key: itemKey(shipment, item),
                                row: item,
                                pending: item.pendiente,
                                branchId: shipment.sucursal_id,
                                sucursal: shipment.sucursal_nombre,
                              }))))}
                            </>
                          ),
                        })}
                        {renderGroupBody(shipmentKey(shipment), <>
                        {renderProgress({
                          done: doneCount,
                          total: shipment.items.length,
                          unitsDone: shipment.items.reduce((sum, item) => sum + item.guardado + (item.vendido || 0), 0),
                          unitsTotal: shipment.items.reduce((sum, item) => sum + item.enviado, 0),
                          toStore: pendientes.length,
                        })}
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
                        </>)}
                      </section>
                    )
                  })}

                  {visiblePorUbicar.length > 0 && (() => {
                    const pendientes = porUbicarRows.filter((row) => !row.done)
                    const doneCount = porUbicarRows.length - pendientes.length
                    return (
                      <section className="por-guardar__group">
                        {renderGroupHead({
                          groupKey: 'por-ubicar',
                          title: 'En POR UBICAR',
                          subtitle: `${pendientes.length} ${pendientes.length === 1 ? 'producto' : 'productos'} por guardar · ${pendientes.reduce((sum, row) => sum + row.cantidad, 0)} unidades`,
                          extra: excelButton(() => exportUbicaciones('POR UBICAR', porUbicarRows.filter((row) => !row.done).map((row) => ({
                            key: row.key,
                            row,
                            pending: row.cantidad,
                            branchId: row.sucursal_id,
                            sucursal: row.sucursal_nombre,
                          })))),
                        })}
                        {renderGroupBody('por-ubicar', <>
                        {renderProgress({
                          done: doneCount,
                          total: porUbicarRows.length,
                          unitsDone: porUbicarRows.reduce((sum, row) => sum + row.guardado, 0),
                          unitsTotal: porUbicarRows.reduce((sum, row) => sum + row.guardado + row.cantidad, 0),
                          toStore: pendientes.length,
                        })}
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
                        </>)}
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
        open={Boolean(faltanteTarget)}
        title="Contaste menos de lo que queda"
        message={faltanteTarget
          ? `${faltanteTarget.item.producto_codigo}: contaste ${faltanteTarget.total} de ${faltanteTarget.item.pendiente}. `
            + `Las ${faltanteTarget.item.pendiente - faltanteTarget.total} que faltan salen del inventario y quedan como faltante en Inconvenientes.`
          : ''}
        confirmLabel="Sí, guardar con faltante"
        cancelLabel="Volver a contar"
        busy={saving}
        onCancel={() => setFaltanteTarget(null)}
        onConfirm={async () => {
          const target = faltanteTarget
          setFaltanteTarget(null)
          await checkRows([itemKey(target.shipment, target.item)], () => saveShipmentItems(target.shipment, [target.item], { faltante: true }))
        }}
      />
    </>
  )
}

export default PorGuardar
