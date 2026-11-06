import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Plus, Trash2, X } from 'lucide-react'
import '../admin/CreateUsuario/CreateUsuario.css'
import './Taller.css'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDateTime } from '../../../utils/dateFormat'
import useModalAnimation from '../common/useModalAnimation'
import useResizableModal from '../common/useResizableModal'
import MoneyInput from '../common/MoneyInput'
import BlockerNotice from '../common/BlockerNotice'
import ConfirmDialog from '../common/unsavedChanges/ConfirmDialog'
import {
  LINEA_TIPOS,
  ORDEN_PASOS,
  estadoInfo,
  formatMoney,
  formatOrdenNumero,
  parseApiError,
} from './tallerConstants'

const HEADER_FIELDS = [
  'numero_pedido',
  'tecnico',
  'cliente_nombre',
  'cliente_identificacion',
  'cliente_telefono',
  'placa',
  'modelo',
  'vin',
  'kilometraje',
  'observaciones',
]
const EMPTY_HEADER = Object.fromEntries(HEADER_FIELDS.map((key) => [key, '']))
const HEADER_SAVE_DELAY_MS = 700

const headerFromOrden = (orden) =>
  Object.fromEntries(HEADER_FIELDS.map((key) => [key, orden?.[key] == null ? '' : String(orden[key])]))

const toNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const lineaCodigo = (linea) => {
  if (linea.tipo === 'repuesto') return linea.producto_codigo || '-'
  if (linea.tipo === 'sin_codigo') return linea.referencia || '-'
  return ''
}

// ---------------------------------------------------------------------------
// Fila del detalle: cantidad, precio y descripcion se guardan al salir del
// campo (o con Enter). Si el servidor rechaza el cambio, vuelve al valor real.
// ---------------------------------------------------------------------------
function LineaRow({ linea, index, editable, enOrden, isAdmin, busy, onUpdate, onDelete, onReviewPrice }) {
  const [cantidad, setCantidad] = useState(String(linea.cantidad))
  const [precio, setPrecio] = useState(toNumber(linea.precio))
  const [descripcion, setDescripcion] = useState(linea.descripcion || '')
  const [referencia, setReferencia] = useState(linea.referencia || '')
  const [cantidadError, setCantidadError] = useState('')
  const precioRef = useRef(precio)

  useEffect(() => { setCantidad(String(linea.cantidad)) }, [linea.cantidad])
  useEffect(() => { setPrecio(toNumber(linea.precio)); precioRef.current = toNumber(linea.precio) }, [linea.precio])
  useEffect(() => { setDescripcion(linea.descripcion || '') }, [linea.descripcion])
  useEffect(() => { setReferencia(linea.referencia || '') }, [linea.referencia])

  // En una orden de trabajo el asistente solo puede subir cantidades.
  const minCantidad = enOrden && !isAdmin ? linea.cantidad : 1
  const canDelete = editable && (!enOrden || isAdmin)
  const descripcionEditable = editable && linea.tipo !== 'repuesto'

  const commitCantidad = () => {
    const parsed = parseInt(cantidad, 10)
    if (!Number.isFinite(parsed) || parsed < 1) {
      setCantidad(String(linea.cantidad))
      return
    }
    if (parsed < minCantidad) {
      setCantidadError(`Mínimo ${minCantidad}: en la orden de trabajo solo se puede aumentar.`)
      setCantidad(String(linea.cantidad))
      return
    }
    setCantidadError('')
    if (parsed !== linea.cantidad) {
      onUpdate(linea.id, { cantidad: parsed }).catch(() => setCantidad(String(linea.cantidad)))
    }
  }

  const commitPrecio = () => {
    const value = precioRef.current
    if (value == null) {
      // Campo vacio: vuelve al PVP del inventario (o al precio que tenia).
      if (linea.precio_lista != null) {
        onUpdate(linea.id, { precio: linea.precio_lista }).catch(() => setPrecio(toNumber(linea.precio)))
      } else {
        setPrecio(toNumber(linea.precio))
      }
      return
    }
    if (Math.abs(value - toNumber(linea.precio)) > 0.0001) {
      onUpdate(linea.id, { precio: value.toFixed(2) }).catch(() => setPrecio(toNumber(linea.precio)))
    }
  }

  const commitText = (field, value, original) => {
    const trimmed = String(value || '').trim()
    if (trimmed === String(original || '').trim()) return
    onUpdate(linea.id, { [field]: trimmed }).catch(() => {
      if (field === 'descripcion') setDescripcion(original || '')
      else setReferencia(original || '')
    })
  }

  const onEnterBlur = (event) => {
    if (event.key === 'Enter') event.currentTarget.blur()
  }

  const total = toNumber(linea.precio) * toNumber(linea.cantidad)
  const precioPendiente = linea.precio_estado === 'pendiente'
  const precioAprobado = linea.precio_estado === 'aprobado'

  return (
    <tr className={`taller-lineas__row${precioPendiente ? ' is-pending' : ''}`}>
      <td className="taller-lineas__index">{index + 1}</td>
      <td>
        <span className={`taller-tipo taller-tipo--${linea.tipo}`}>{LINEA_TIPOS[linea.tipo]?.short || linea.tipo}</span>
        {linea.agregada_en_orden && (
          <span className="taller-lineas__added" title={`Agregado con la orden en curso${linea.creado_por_nombre ? ` por ${linea.creado_por_nombre}` : ''}`}>
            Agregado
          </span>
        )}
      </td>
      <td className="taller-lineas__code">
        {linea.tipo === 'sin_codigo' && editable ? (
          <input
            className="taller-input"
            value={referencia}
            placeholder="OEM / referencia"
            onChange={(event) => setReferencia(event.target.value)}
            onBlur={() => commitText('referencia', referencia, linea.referencia)}
            onKeyDown={onEnterBlur}
            disabled={busy}
          />
        ) : (
          lineaCodigo(linea)
        )}
      </td>
      <td className="taller-lineas__desc">
        {descripcionEditable ? (
          <input
            className="taller-input"
            value={descripcion}
            onChange={(event) => setDescripcion(event.target.value)}
            onBlur={() => commitText('descripcion', descripcion, linea.descripcion)}
            onKeyDown={onEnterBlur}
            disabled={busy}
          />
        ) : (
          linea.descripcion || '-'
        )}
      </td>
      <td className="taller-lineas__qty">
        {editable ? (
          <input
            className={`taller-input taller-input--qty${cantidadError ? ' has-error' : ''}`}
            type="number"
            min={minCantidad}
            step={1}
            value={cantidad}
            onChange={(event) => { setCantidad(event.target.value); setCantidadError('') }}
            onBlur={commitCantidad}
            onKeyDown={onEnterBlur}
            disabled={busy}
            title={enOrden && !isAdmin ? `Solo se puede aumentar (mínimo ${minCantidad})` : undefined}
          />
        ) : (
          linea.cantidad
        )}
        {cantidadError && <small className="taller-lineas__error">{cantidadError}</small>}
      </td>
      <td className="taller-lineas__money taller-lineas__pvp">
        {linea.tipo === 'repuesto' ? (linea.precio_lista != null ? formatMoney(linea.precio_lista) : <span className="taller-muted">Sin PVP</span>) : <span className="taller-muted">-</span>}
      </td>
      <td className="taller-lineas__money">
        {editable ? (
          <MoneyInput
            className={`taller-input taller-input--money${precioPendiente ? ' is-pending' : ''}`}
            value={precio}
            onValueChange={(value) => { precioRef.current = value; setPrecio(value) }}
            onBlur={commitPrecio}
            onKeyDown={onEnterBlur}
            disabled={busy}
          />
        ) : (
          formatMoney(linea.precio)
        )}
        {precioPendiente && (
          <div className="taller-price-review">
            <span className="taller-chip taller-chip--pendiente" title="Precio distinto al del inventario: lo verifica un administrador">
              Por aprobar
            </span>
            {isAdmin && editable && (
              <>
                <button type="button" className="taller-icon-btn taller-icon-btn--ok" onClick={() => onReviewPrice(linea.id, true)} disabled={busy} title="Aprobar este precio">
                  <Check size={14} />
                </button>
                <button
                  type="button"
                  className="taller-icon-btn taller-icon-btn--no"
                  onClick={() => onReviewPrice(linea.id, false)}
                  disabled={busy || linea.precio_lista == null}
                  title={linea.precio_lista == null ? 'Sin PVP en inventario: corrige el precio en el campo' : 'Rechazar: vuelve al PVP del inventario'}
                >
                  <X size={14} />
                </button>
              </>
            )}
          </div>
        )}
        {precioAprobado && (
          <span
            className="taller-chip taller-chip--aprobado"
            title={`Aprobado${linea.precio_revisado_por_nombre ? ` por ${linea.precio_revisado_por_nombre}` : ''}${linea.precio_revisado_en ? ` el ${formatDateTime(linea.precio_revisado_en)}` : ''}`}
          >
            Precio aprobado
          </span>
        )}
      </td>
      <td className="taller-lineas__money taller-lineas__total">{formatMoney(total)}</td>
      <td className="taller-lineas__actions">
        {canDelete && (
          <button type="button" className="taller-icon-btn taller-icon-btn--no" onClick={() => onDelete(linea)} disabled={busy} title="Quitar">
            <Trash2 size={14} />
          </button>
        )}
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Barra para agregar lineas: repuesto (buscador), mano de obra (catalogo o
// texto libre), insumo y repuesto sin codigo.
// ---------------------------------------------------------------------------
const ADD_TABS = [
  { key: 'repuesto', label: 'Repuesto' },
  { key: 'mano_obra', label: 'Mano de obra' },
  { key: 'insumo', label: 'Insumo' },
  { key: 'sin_codigo', label: 'Sin código' },
]
const EMPTY_FREE_FORM = { descripcion: '', referencia: '', cantidad: '1', precio: null, mano_obra: null }

function AgregarLinea({ token, busy, onAdd, manoObraCatalogo, inputRef }) {
  const [tab, setTab] = useState('repuesto')
  const [query, setQuery] = useState('')
  const [cantidad, setCantidad] = useState('1')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [form, setForm] = useState(EMPTY_FREE_FORM)
  const [formError, setFormError] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const searchSeq = useRef(0)

  useEffect(() => {
    if (tab !== 'repuesto') return undefined
    const term = query.trim()
    if (!term) {
      setResults([])
      setSearching(false)
      setSearchError('')
      return undefined
    }
    const seq = ++searchSeq.current
    setSearching(true)
    const timer = setTimeout(async () => {
      try {
        const response = await authFetch(`${API_URL}/taller/ordenes/buscar-productos/?q=${encodeURIComponent(term)}`, {}, token)
        if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo buscar.'))
        const data = await response.json()
        if (seq !== searchSeq.current) return
        setResults(Array.isArray(data) ? data : [])
        setSearchError('')
      } catch (error) {
        if (seq !== searchSeq.current) return
        setResults([])
        setSearchError(error.message || 'No se pudo buscar.')
      } finally {
        if (seq === searchSeq.current) setSearching(false)
      }
    }, 280)
    return () => clearTimeout(timer)
  }, [query, tab, token])

  const parsedCantidad = (raw) => {
    const value = parseInt(raw, 10)
    return Number.isFinite(value) && value >= 1 ? value : null
  }

  const addProducto = async (producto) => {
    const qty = parsedCantidad(cantidad)
    if (!qty) {
      setSearchError('La cantidad debe ser al menos 1.')
      return
    }
    try {
      await onAdd({ tipo: 'repuesto', producto: producto.id, cantidad: qty })
      setQuery('')
      setCantidad('1')
      setResults([])
      inputRef?.current?.focus()
    } catch {
      // el error ya se mostro
    }
  }

  const switchTab = (key) => {
    setTab(key)
    setForm(EMPTY_FREE_FORM)
    setFormError('')
    setShowSuggestions(false)
  }

  const suggestions = useMemo(() => {
    if (tab !== 'mano_obra') return []
    const term = form.descripcion.trim().toLowerCase()
    const list = manoObraCatalogo.filter((item) => item.activo)
    if (!term) return list.slice(0, 12)
    return list.filter((item) => item.nombre.toLowerCase().includes(term)).slice(0, 12)
  }, [form.descripcion, manoObraCatalogo, tab])

  const pickTrabajo = (item) => {
    setForm((prev) => ({ ...prev, descripcion: item.nombre, precio: toNumber(item.precio), mano_obra: item.id }))
    setShowSuggestions(false)
    setFormError('')
  }

  const submitFree = async (event) => {
    event?.preventDefault?.()
    const qty = parsedCantidad(form.cantidad)
    const descripcion = form.descripcion.trim()
    const referencia = form.referencia.trim()
    if (!qty) {
      setFormError('La cantidad debe ser al menos 1.')
      return
    }
    if (tab === 'sin_codigo' ? !(descripcion || referencia) : !descripcion) {
      setFormError(tab === 'sin_codigo' ? 'Escribe el OEM/referencia o la descripción.' : 'Escribe la descripción.')
      return
    }
    const body = {
      tipo: tab,
      descripcion,
      cantidad: qty,
      precio: form.precio == null ? '0' : Number(form.precio).toFixed(2),
    }
    if (tab === 'sin_codigo') body.referencia = referencia
    if (tab === 'mano_obra' && form.mano_obra) body.mano_obra = form.mano_obra
    try {
      await onAdd(body)
      setForm(EMPTY_FREE_FORM)
      setFormError('')
    } catch {
      // el error ya se mostro
    }
  }

  const setField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }))

  return (
    <div className="taller-add">
      <div className="taller-add__tabs" role="tablist" aria-label="Qué agregar">
        <span className="taller-add__label"><Plus size={14} /> Agregar</span>
        {ADD_TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`taller-add__tab taller-add__tab--${item.key}${tab === item.key ? ' is-active' : ''}`}
            onClick={() => switchTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'repuesto' ? (
        <div className="taller-add__row">
          <div className="taller-add__search">
            <input
              ref={inputRef}
              className="taller-input"
              placeholder="Buscar repuesto por código, nombre, referencia u OEM"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && results.length) {
                  event.preventDefault()
                  addProducto(results[0])
                }
              }}
              disabled={busy}
            />
            {query.trim() && (
              <div className="taller-add__results" role="listbox">
                {searching && <div className="taller-add__result taller-add__result--info"><i className="pi pi-spin pi-spinner" /> Buscando...</div>}
                {!searching && searchError && <div className="taller-add__result taller-add__result--error">{searchError}</div>}
                {!searching && !searchError && !results.length && (
                  <div className="taller-add__result taller-add__result--info">
                    {`No hay repuestos con "${query.trim()}". Si no lo tenemos, agrégalo en la pestaña "Sin código".`}
                    <button type="button" className="taller-link" onClick={() => { switchTab('sin_codigo'); setForm({ ...EMPTY_FREE_FORM, referencia: query.trim() }) }}>
                      Agregar sin código
                    </button>
                  </div>
                )}
                {!searching && results.map((producto) => (
                  <button key={producto.id} type="button" className="taller-add__result" onClick={() => addProducto(producto)} disabled={busy}>
                    <strong>{producto.codigo}</strong>
                    <span className="taller-add__result-name">{producto.nombre}</span>
                    <span className={`taller-add__stock${producto.stock > 0 ? '' : ' is-empty'}`}>{`Stock ${producto.stock}`}</span>
                    <span className="taller-add__pvp">{producto.precio != null ? formatMoney(producto.precio) : 'Sin PVP'}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <label className="taller-add__field taller-add__field--qty">
            <span>Cant.</span>
            <input className="taller-input taller-input--qty" type="number" min={1} step={1} value={cantidad} onChange={(event) => setCantidad(event.target.value)} disabled={busy} />
          </label>
        </div>
      ) : (
        <form className="taller-add__row" onSubmit={submitFree}>
          {tab === 'sin_codigo' && (
            <label className="taller-add__field">
              <span>OEM / referencia</span>
              <input className="taller-input" value={form.referencia} onChange={(event) => setField('referencia', event.target.value)} disabled={busy} />
            </label>
          )}
          <label className="taller-add__field taller-add__field--grow">
            <span>{tab === 'mano_obra' ? 'Trabajo' : 'Descripción'}</span>
            <div className="taller-add__search">
              <input
                className="taller-input"
                value={form.descripcion}
                placeholder={tab === 'mano_obra' ? 'Elige del catálogo o escribe cualquier trabajo' : tab === 'insumo' ? 'Goma, cinta adhesiva, ...' : ''}
                onChange={(event) => {
                  const value = event.target.value
                  setForm((prev) => ({ ...prev, descripcion: value, mano_obra: null }))
                  if (tab === 'mano_obra') setShowSuggestions(true)
                }}
                onFocus={() => tab === 'mano_obra' && setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                disabled={busy}
              />
              {tab === 'mano_obra' && showSuggestions && suggestions.length > 0 && (
                <div className="taller-add__results" role="listbox">
                  {suggestions.map((item) => (
                    <button key={item.id} type="button" className="taller-add__result" onMouseDown={(event) => event.preventDefault()} onClick={() => pickTrabajo(item)}>
                      <span className="taller-add__result-name">{item.nombre}</span>
                      <span className="taller-add__pvp">{formatMoney(item.precio)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </label>
          <label className="taller-add__field taller-add__field--qty">
            <span>Cant.</span>
            <input className="taller-input taller-input--qty" type="number" min={1} step={1} value={form.cantidad} onChange={(event) => setField('cantidad', event.target.value)} disabled={busy} />
          </label>
          <label className="taller-add__field taller-add__field--money">
            <span>Precio</span>
            <MoneyInput className="taller-input taller-input--money" value={form.precio} onValueChange={(value) => setField('precio', value)} disabled={busy} />
          </label>
          <button type="submit" className="create-user__action create-user__action--primary taller-add__submit" disabled={busy}>
            Agregar
          </button>
        </form>
      )}
      {formError && <p className="taller-add__error">{formError}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ventana de la orden
// ---------------------------------------------------------------------------
function OrdenTallerModal({ open, ordenId, token, isAdmin = false, canEdit = true, onClose, onChanged, notify }) {
  const { shouldRender, isClosing } = useModalAnimation(open)
  const modal = useResizableModal(open, { initialSize: { width: 1240, height: 860 }, minSize: { width: 640, height: 420 } })
  const [orden, setOrden] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [header, setHeader] = useState(EMPTY_HEADER)
  const [headerStatus, setHeaderStatus] = useState('idle')
  const [busy, setBusy] = useState(false)
  const [activeTab, setActiveTab] = useState('detalle')
  const [confirm, setConfirm] = useState(null)
  const [motivo, setMotivo] = useState('')
  const [manoObraCatalogo, setManoObraCatalogo] = useState([])
  const pendingHeaderRef = useRef({})
  const headerTimerRef = useRef(null)
  const addInputRef = useRef(null)
  const ordenRef = useRef(null)
  ordenRef.current = orden

  const report = useCallback((detail, severity = 'error', summary = 'Taller') => {
    notify?.({ severity, summary, detail })
  }, [notify])

  const applyOrden = useCallback((data) => {
    setOrden(data)
    // Lo que se esta escribiendo y aun no se guarda no se pisa.
    const pending = pendingHeaderRef.current
    setHeader({ ...headerFromOrden(data), ...pending })
    onChanged?.(data)
  }, [onChanged])

  useEffect(() => {
    if (!open || !ordenId) return undefined
    let cancelled = false
    pendingHeaderRef.current = {}
    setOrden(null)
    setLoadError('')
    setActiveTab('detalle')
    setHeaderStatus('idle')
    setLoading(true)
    ;(async () => {
      try {
        const response = await authFetch(`${API_URL}/taller/ordenes/${ordenId}/`, {}, token)
        if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo cargar la orden.'))
        const data = await response.json()
        if (!cancelled) {
          setOrden(data)
          setHeader(headerFromOrden(data))
        }
      } catch (error) {
        if (!cancelled) setLoadError(error.message || 'No se pudo cargar la orden.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, ordenId, token])

  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const response = await authFetch(`${API_URL}/taller/mano-obra/?activos=1`, {}, token)
        if (!response.ok) return
        const data = await response.json()
        if (!cancelled) setManoObraCatalogo(Array.isArray(data) ? data : data?.results || [])
      } catch {
        // sin catalogo igual se puede escribir el trabajo
      }
    })()
    return () => { cancelled = true }
  }, [open, token])

  const editable = Boolean(orden && canEdit && (orden.estado === 'cotizacion' || orden.estado === 'orden'))
  const enOrden = orden?.estado === 'orden'

  // ---- Cabecera: se guarda sola mientras se escribe ----
  const flushHeader = useCallback(async () => {
    if (headerTimerRef.current) {
      clearTimeout(headerTimerRef.current)
      headerTimerRef.current = null
    }
    const pending = { ...pendingHeaderRef.current }
    const current = ordenRef.current
    if (!current || !Object.keys(pending).length) return true
    const body = { ...pending }
    if ('kilometraje' in body) {
      const digits = String(body.kilometraje || '').replace(/\D/g, '')
      body.kilometraje = digits ? Number(digits) : null
    }
    setHeaderStatus('saving')
    try {
      const response = await authFetch(`${API_URL}/taller/ordenes/${current.id}/`, { method: 'PATCH', body: JSON.stringify(body) }, token)
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudieron guardar los datos.'))
      const data = await response.json()
      // Solo se limpia lo que no volvio a cambiar mientras se guardaba.
      Object.keys(pending).forEach((key) => {
        if (pendingHeaderRef.current[key] === pending[key]) delete pendingHeaderRef.current[key]
      })
      applyOrden(data)
      setHeaderStatus('saved')
      return true
    } catch (error) {
      setHeaderStatus('error')
      report(error.message)
      return false
    }
  }, [applyOrden, report, token])

  const handleHeaderChange = (field, value) => {
    setHeader((prev) => ({ ...prev, [field]: value }))
    pendingHeaderRef.current = { ...pendingHeaderRef.current, [field]: value }
    setHeaderStatus('pending')
    if (headerTimerRef.current) clearTimeout(headerTimerRef.current)
    headerTimerRef.current = setTimeout(() => { flushHeader() }, HEADER_SAVE_DELAY_MS)
  }

  useEffect(() => () => { if (headerTimerRef.current) clearTimeout(headerTimerRef.current) }, [])

  // ---- Llamadas que devuelven la orden actualizada ----
  const callOrden = useCallback(async (path, options, fallback) => {
    const current = ordenRef.current
    if (!current) throw new Error('Sin orden')
    setBusy(true)
    try {
      const response = await authFetch(`${API_URL}/taller/ordenes/${current.id}/${path}`, options, token)
      if (!response.ok) throw new Error(await parseApiError(response, fallback))
      const data = await response.json()
      applyOrden(data)
      return data
    } catch (error) {
      report(error.message || fallback)
      throw error
    } finally {
      setBusy(false)
    }
  }, [applyOrden, report, token])

  const addLinea = (body) => callOrden('lineas/', { method: 'POST', body: JSON.stringify(body) }, 'No se pudo agregar.')
  const updateLinea = (id, body) => callOrden(`lineas/${id}/`, { method: 'PATCH', body: JSON.stringify(body) }, 'No se pudo guardar el cambio.')
  const reviewPrice = (id, aprobar) =>
    callOrden(`lineas/${id}/revisar-precio/`, { method: 'POST', body: JSON.stringify({ aprobar }) }, 'No se pudo revisar el precio.').catch(() => {})

  const requestDelete = (linea) => {
    if (!enOrden) {
      callOrden(`lineas/${linea.id}/`, { method: 'DELETE' }, 'No se pudo quitar.').catch(() => {})
      return
    }
    setConfirm({
      kind: 'quitar',
      title: '¿Quitar de la orden de trabajo?',
      message: `"${linea.descripcion || lineaCodigo(linea)}" ya se le confirmó al cliente. Quedará registrado en el historial que lo quitaste.`,
      confirmLabel: 'Quitar',
      run: () => callOrden(`lineas/${linea.id}/`, { method: 'DELETE' }, 'No se pudo quitar.'),
    })
  }

  const runStep = (kind) => {
    const configs = {
      aceptar: {
        title: '¿El cliente aceptó la cotización?',
        message: 'Pasa a orden de trabajo con los mismos repuestos, insumos, mano de obra y valores. Desde ahí solo se podrá agregar o aumentar.',
        confirmLabel: 'Crear orden de trabajo',
        run: () => callOrden('aceptar/', { method: 'POST' }, 'No se pudo crear la orden de trabajo.'),
      },
      rechazar: {
        title: '¿El cliente rechazó la cotización?',
        message: 'Queda guardada como rechazada. Se puede reabrir después.',
        confirmLabel: 'Marcar rechazada',
        withMotivo: true,
        run: (texto) => callOrden('rechazar/', { method: 'POST', body: JSON.stringify({ motivo: texto }) }, 'No se pudo rechazar.'),
      },
      reabrir: {
        title: '¿Reabrir la cotización?',
        message: 'Vuelve a cotización para corregirla o volver a presentarla al cliente.',
        confirmLabel: 'Reabrir',
        run: () => callOrden('reabrir/', { method: 'POST' }, 'No se pudo reabrir.'),
      },
      anular: {
        title: '¿Anular esta orden?',
        message: 'La orden queda anulada y ya no se puede modificar.',
        confirmLabel: 'Anular',
        withMotivo: true,
        run: (texto) => callOrden('anular/', { method: 'POST', body: JSON.stringify({ motivo: texto }) }, 'No se pudo anular.'),
      },
    }
    setMotivo('')
    setConfirm({ kind, ...configs[kind] })
  }

  const confirmRun = async () => {
    if (!confirm) return
    try {
      await confirm.run(motivo.trim())
      setConfirm(null)
    } catch {
      // el error ya se mostro; el dialogo se queda abierto
    }
  }

  const isEmptyDraft = (current) =>
    current &&
    current.estado === 'cotizacion' &&
    !(current.lineas || []).length &&
    HEADER_FIELDS.every((key) => !String(current[key] ?? '').trim())

  const handleClose = async () => {
    const saved = await flushHeader()
    if (!saved) return
    const current = ordenRef.current
    if (isEmptyDraft(current)) {
      // Cotizacion que se abrio y no se lleno: no se deja basura.
      try {
        await authFetch(`${API_URL}/taller/ordenes/${current.id}/`, { method: 'DELETE' }, token)
        onChanged?.(null, current.id)
      } catch {
        // si falla, queda como cotizacion vacia; se puede descartar luego
      }
    }
    onClose?.()
  }

  const lineas = useMemo(() => orden?.lineas || [], [orden])
  const totales = useMemo(() => {
    const byTipo = { repuesto: 0, sin_codigo: 0, insumo: 0, mano_obra: 0 }
    lineas.forEach((linea) => {
      byTipo[linea.tipo] = (byTipo[linea.tipo] || 0) + toNumber(linea.precio) * toNumber(linea.cantidad)
    })
    return { byTipo, total: Object.values(byTipo).reduce((acc, value) => acc + value, 0) }
  }, [lineas])
  const preciosPendientes = lineas.filter((linea) => linea.precio_estado === 'pendiente').length
  const sinCodigo = lineas.filter((linea) => linea.tipo === 'sin_codigo').length

  if (!shouldRender) return null

  const estado = estadoInfo(orden?.estado)
  const pasoActual = orden?.estado === 'cerrada' ? 2 : orden?.estado === 'orden' ? 1 : 0
  const fueraDeFlujo = orden?.estado === 'rechazada' || orden?.estado === 'anulada'
  const titulo = orden
    ? `${orden.estado === 'cotizacion' || orden.estado === 'rechazada' ? 'Cotización' : 'Orden de trabajo'} ${formatOrdenNumero(orden.numero)}`
    : 'Orden de taller'
  const headerDisabled = !editable || busy
  const saveLabel = {
    pending: 'Cambios sin guardar...',
    saving: 'Guardando...',
    saved: 'Guardado',
    error: 'No se guardó: revisa la conexión',
  }[headerStatus]

  const field = (key, label, props = {}) => (
    <label className={`create-user__field${props.full ? ' create-user__field--full' : ''}`}>
      <span>{label}</span>
      {props.textarea ? (
        <textarea rows={2} value={header[key]} onChange={(event) => handleHeaderChange(key, event.target.value)} onBlur={flushHeader} disabled={headerDisabled} />
      ) : (
        <input
          type="text"
          inputMode={props.numeric ? 'numeric' : undefined}
          value={header[key]}
          placeholder={props.placeholder}
          onChange={(event) => handleHeaderChange(key, props.numeric ? event.target.value.replace(/\D/g, '') : event.target.value)}
          onBlur={flushHeader}
          disabled={headerDisabled}
          className={props.upper ? 'taller-upper' : undefined}
        />
      )}
    </label>
  )

  return (
    <div className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`} role="dialog" aria-modal="true">
      <div className={`create-user__modal taller-modal${isClosing ? ' create-user__modal--closing' : ''}`} style={modal.style}>
        <header className={`create-user__header taller-modal__header taller-modal__header--${estado.chip}`} {...modal.headerProps}>
          <div className="create-user__header-text taller-modal__title">
            <h3>{titulo}</h3>
            {orden && <span className={`taller-chip taller-chip--${estado.chip}`}>{estado.label}</span>}
          </div>
          <div className="create-user__header-actions">
            <button type="button" className="create-user__icon-button create-user__icon-button--maximize" onClick={modal.toggleMaximize} aria-label={modal.maximized ? 'Restaurar' : 'Maximizar'}>
              <i className={modal.maximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
            </button>
            <button type="button" className="create-user__icon-button" onClick={handleClose} aria-label="Cerrar">
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="create-user__content taller-modal__content">
          {loading && (
            <div className="create-user__loading-overlay" role="status" aria-live="polite">
              <i className="pi pi-spin pi-spinner" aria-hidden="true" />
              <span>Cargando orden...</span>
            </div>
          )}
          {loadError && !loading && (
            <div className="taller-modal__load-error">
              <BlockerNotice title="No se pudo abrir la orden" reason={loadError} />
            </div>
          )}

          {orden && (
            <>
              <div className="taller-steps" aria-label="Pasos de la orden">
                {ORDEN_PASOS.map((paso, index) => {
                  const done = !fueraDeFlujo && index < pasoActual
                  const current = index === pasoActual
                  return (
                    <div key={paso.key} className={`taller-steps__step${done ? ' is-done' : ''}${current ? ' is-current' : ''}`}>
                      <span className="taller-steps__dot">{done ? <Check size={13} /> : index + 1}</span>
                      <span className="taller-steps__label">{paso.label}</span>
                      {current && fueraDeFlujo && <span className={`taller-chip taller-chip--${estado.chip}`}>{estado.label}</span>}
                      {index === 1 && orden.aceptada_en && (
                        <span className="taller-steps__date">{formatDateTime(orden.aceptada_en)}</span>
                      )}
                      {index === 0 && <span className="taller-steps__date">{formatDateTime(orden.creado_en)}</span>}
                    </div>
                  )
                })}
              </div>

              <div className="create-user__tabs" role="tablist">
                <button type="button" className={`create-user__tab${activeTab === 'detalle' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('detalle')}>
                  Orden
                </button>
                <button type="button" className={`create-user__tab${activeTab === 'historial' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('historial')}>
                  {`Historial (${(orden.eventos || []).length})`}
                </button>
              </div>

              <div className="create-user__body taller-modal__body">
                {activeTab === 'detalle' && (
                  <>
                    <section className="create-user__section">
                      <div className="create-user__section-header">
                        <div>
                          <p className="create-user__eyebrow">Datos</p>
                          <h4>Vehículo y cliente</h4>
                        </div>
                        {saveLabel && <span className={`taller-save taller-save--${headerStatus}`}>{saveLabel}</span>}
                      </div>
                      <div className="create-user__grid taller-header-grid">
                        <div className="create-user__field">
                          <span>N° de orden</span>
                          <div className="create-salida__static-value taller-static">{formatOrdenNumero(orden.numero)}</div>
                        </div>
                        {field('numero_pedido', 'N° de pedido')}
                        {field('tecnico', 'Técnico')}
                        <div className="create-user__field">
                          <span>Asesor</span>
                          <div className="create-salida__static-value taller-static">{orden.asesor_nombre || '-'}</div>
                        </div>
                        {field('placa', 'Placa', { upper: true })}
                        {field('modelo', 'Modelo / cilindraje', { placeholder: '3008 1.6 Turbo EP6 Gasolina' })}
                        {field('vin', 'VIN', { upper: true })}
                        {field('kilometraje', 'Kilometraje', { numeric: true })}
                        {field('cliente_nombre', 'Cliente')}
                        {field('cliente_identificacion', 'Cédula / RUC')}
                        {field('cliente_telefono', 'Teléfono')}
                        {field('observaciones', 'Observaciones', { textarea: true })}
                      </div>
                    </section>

                    <section className="create-user__section">
                      <div className="create-user__section-header">
                        <div>
                          <p className="create-user__eyebrow">Detalle</p>
                          <h4>Repuestos, insumos y mano de obra</h4>
                        </div>
                        {enOrden && !isAdmin && editable && (
                          <span className="taller-muted">En la orden de trabajo solo se puede agregar o aumentar cantidades.</span>
                        )}
                      </div>

                      {preciosPendientes > 0 && (
                        <BlockerNotice
                          title={`${preciosPendientes} ${preciosPendientes === 1 ? 'precio por aprobar' : 'precios por aprobar'}`}
                          reason={
                            isAdmin
                              ? 'Tienen un precio distinto al del inventario. Apruébalos o recházalos con ✓ / ✕ en la columna Precio: hasta entonces esos repuestos no se pueden despachar.'
                              : 'Tienen un precio distinto al del inventario: un administrador debe verificarlos antes de que se puedan despachar.'
                          }
                        />
                      )}
                      {sinCodigo > 0 && enOrden && (
                        <BlockerNotice
                          title={`${sinCodigo} ${sinCodigo === 1 ? 'repuesto no existe' : 'repuestos no existen'} en el inventario`}
                          reason="Se agregaron sin código: el administrador debe comprarlos y crear el producto antes de despacharlos."
                        />
                      )}

                      {editable && (
                        <AgregarLinea token={token} busy={busy} onAdd={addLinea} manoObraCatalogo={manoObraCatalogo} inputRef={addInputRef} />
                      )}

                      <div className="taller-lineas__wrap">
                        <table className="taller-lineas">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Tipo</th>
                              <th>Código / OEM</th>
                              <th>Descripción</th>
                              <th>Cant.</th>
                              <th>PVP</th>
                              <th>Precio</th>
                              <th>Total</th>
                              <th aria-label="Acciones" />
                            </tr>
                          </thead>
                          <tbody>
                            {lineas.length === 0 && (
                              <tr>
                                <td colSpan={9} className="taller-lineas__empty">
                                  {editable ? 'Todavía no hay nada. Agrega repuestos, mano de obra o insumos con la barra de arriba.' : 'Sin detalle.'}
                                </td>
                              </tr>
                            )}
                            {lineas.map((linea, index) => (
                              <LineaRow
                                key={linea.id}
                                linea={linea}
                                index={index}
                                editable={editable}
                                enOrden={enOrden}
                                isAdmin={isAdmin}
                                busy={busy}
                                onUpdate={updateLinea}
                                onDelete={requestDelete}
                                onReviewPrice={reviewPrice}
                              />
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="taller-totals">
                        <div><span>Repuestos</span><strong>{formatMoney(totales.byTipo.repuesto + totales.byTipo.sin_codigo)}</strong></div>
                        <div><span>Insumos</span><strong>{formatMoney(totales.byTipo.insumo)}</strong></div>
                        <div><span>Mano de obra</span><strong>{formatMoney(totales.byTipo.mano_obra)}</strong></div>
                        <div className="taller-totals__grand"><span>Total</span><strong>{formatMoney(totales.total)}</strong></div>
                      </div>
                    </section>
                  </>
                )}

                {activeTab === 'historial' && (
                  <section className="create-user__section">
                    {(orden.eventos || []).length === 0 ? (
                      <p className="taller-muted">Sin movimientos todavía.</p>
                    ) : (
                      <ol className="taller-history">
                        {orden.eventos.map((evento) => (
                          <li key={evento.id}>
                            <span className="taller-history__when">{formatDateTime(evento.creado_en)}</span>
                            <span className="taller-history__who">{evento.usuario_nombre || 'Sistema'}</span>
                            <span className="taller-history__what">{evento.descripcion}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                )}
              </div>

              <footer className="create-user__footer taller-modal__footer">
                <div className="create-user__footer-group">
                  {isAdmin && canEdit && ['cotizacion', 'orden', 'rechazada'].includes(orden.estado) && (
                    <button type="button" className="create-user__action create-user__action--cancel" onClick={() => runStep('anular')} disabled={busy}>
                      Anular
                    </button>
                  )}
                  {orden.estado === 'rechazada' && orden.motivo_rechazo && (
                    <span className="taller-muted">{`Motivo del rechazo: ${orden.motivo_rechazo}`}</span>
                  )}
                </div>
                <div className="create-user__footer-group">
                  {orden.estado === 'cotizacion' && canEdit && (
                    <>
                      {!lineas.length && (
                        <BlockerNotice
                          compact
                          title="Aún no se puede crear la orden de trabajo"
                          reason="La cotización está vacía."
                          actionLabel="Agregar repuesto"
                          onAction={() => addInputRef.current?.focus()}
                        />
                      )}
                      <button type="button" className="create-user__action create-user__action--secondary" onClick={() => runStep('rechazar')} disabled={busy}>
                        Cliente rechazó
                      </button>
                      <button type="button" className="create-user__action create-user__action--primary" onClick={() => runStep('aceptar')} disabled={busy || !lineas.length}>
                        Cliente aceptó: crear orden de trabajo
                      </button>
                    </>
                  )}
                  {orden.estado === 'rechazada' && canEdit && (
                    <button type="button" className="create-user__action create-user__action--primary" onClick={() => runStep('reabrir')} disabled={busy}>
                      Reabrir cotización
                    </button>
                  )}
                  <button type="button" className="create-user__action create-user__action--cancel" onClick={handleClose} disabled={busy}>
                    Cerrar
                  </button>
                </div>
              </footer>
            </>
          )}
        </div>
        <div className="create-user__resize-handle" {...modal.resizeHandleProps} aria-hidden="true" />
      </div>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel={confirm?.confirmLabel}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={confirmRun}
        details={
          confirm?.withMotivo ? (
            <label className="create-user__field taller-confirm-field">
              <span>Motivo (opcional)</span>
              <textarea rows={2} value={motivo} onChange={(event) => setMotivo(event.target.value)} />
            </label>
          ) : null
        }
      />
    </div>
  )
}

export default OrdenTallerModal
