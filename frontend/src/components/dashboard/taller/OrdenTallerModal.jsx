import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, PackagePlus, Plus, Trash2, Truck, X } from 'lucide-react'
import '../admin/CreateUsuario/CreateUsuario.css'
import './Taller.css'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDate, formatDateTime } from '../../../utils/dateFormat'
import useModalAnimation from '../common/useModalAnimation'
import useResizableModal from '../common/useResizableModal'
import MoneyInput from '../common/MoneyInput'
import BlockerNotice from '../common/BlockerNotice'
import ConfirmDialog from '../common/unsavedChanges/ConfirmDialog'
import ProductoBuscador from './ProductoBuscador'
import PruebasPanel from './PruebasPanel'
import DespachoDialog from './DespachoDialog'
import DevolucionDialog from './DevolucionDialog'
import CrearProductoDialog from './CrearProductoDialog'
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
function LineaRow({ linea, index, editable, enOrden, esGarantia, isAdmin, busy, onUpdate, onDelete, onReviewPrice, onCrearProducto }) {
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
  const precioEditable = editable && !linea.es_garantia

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
  const esRepuesto = linea.tipo === 'repuesto'

  return (
    <tr className={`taller-lineas__row${precioPendiente ? ' is-pending' : ''}${linea.tipo === 'sin_codigo' && enOrden ? ' is-missing' : ''}`}>
      <td className="taller-lineas__index">{index + 1}</td>
      <td>
        <span className={`taller-tipo taller-tipo--${linea.tipo}`}>{LINEA_TIPOS[linea.tipo]?.short || linea.tipo}</span>
        {linea.es_garantia && <span className="taller-chip taller-chip--garantia">Garantía</span>}
        {linea.agregada_en_orden && (
          <span className="taller-lineas__added" title={`Agregado con la orden en curso${linea.creado_por_nombre ? ` por ${linea.creado_por_nombre}` : ''}`}>
            Agregado
          </span>
        )}
        {linea.era_sin_codigo && <span className="taller-lineas__added" title="Llegó sin código y se creó en el inventario">Nuevo</span>}
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
        {linea.tipo === 'sin_codigo' && enOrden && (
          isAdmin ? (
            <button type="button" className="taller-mini-btn taller-mini-btn--warn" onClick={() => onCrearProducto(linea)} disabled={busy}>
              <PackagePlus size={13} /> Crear producto
            </button>
          ) : (
            <small className="taller-lineas__error">No existe: el administrador debe crearlo</small>
          )
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
      <td className="taller-lineas__desp">
        {esRepuesto && linea.producto ? (
          <span
            className={`taller-desp${linea.cantidad_despachada >= linea.cantidad ? ' is-done' : linea.cantidad_despachada > 0 ? ' is-partial' : ''}`}
            title={linea.cantidad_despachada >= linea.cantidad ? 'Todo entregado al taller' : `Faltan entregar ${linea.pendiente_despacho}`}
          >
            {`${linea.cantidad_despachada}/${linea.cantidad}`}
          </span>
        ) : (
          <span className="taller-muted">-</span>
        )}
      </td>
      <td className="taller-lineas__money taller-lineas__pvp">
        {esRepuesto ? (linea.precio_lista != null ? formatMoney(linea.precio_lista) : <span className="taller-muted">Sin PVP</span>) : <span className="taller-muted">-</span>}
      </td>
      <td className="taller-lineas__money">
        {precioEditable ? (
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
        {esGarantia && esRepuesto && editable && (
          <label className="taller-garantia-toggle">
            <input
              type="checkbox"
              checked={Boolean(linea.es_garantia)}
              onChange={(event) => onUpdate(linea.id, { es_garantia: event.target.checked }).catch(() => {})}
              disabled={busy}
            />
            Garantía (sin costo)
          </label>
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
          <button
            type="button"
            className="taller-icon-btn taller-icon-btn--no"
            onClick={() => onDelete(linea)}
            disabled={busy}
            title={linea.cantidad_despachada ? 'Quitar (lo entregado queda por devolver a bodega)' : 'Quitar'}
          >
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

function AgregarLinea({ token, busy, onAdd, manoObraCatalogo, inputRef, sucursalId, esGarantia }) {
  const [tab, setTab] = useState('repuesto')
  const [cantidad, setCantidad] = useState('1')
  const [garantia, setGarantia] = useState(Boolean(esGarantia))
  const [form, setForm] = useState(EMPTY_FREE_FORM)
  const [formError, setFormError] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)

  const parsedCantidad = (raw) => {
    const value = parseInt(raw, 10)
    return Number.isFinite(value) && value >= 1 ? value : null
  }

  const addProducto = async (producto) => {
    const qty = parsedCantidad(cantidad)
    if (!qty) {
      setFormError('La cantidad debe ser al menos 1.')
      return false
    }
    try {
      await onAdd({ tipo: 'repuesto', producto: producto.id, cantidad: qty, es_garantia: esGarantia && garantia })
      setCantidad('1')
      setFormError('')
      return true
    } catch {
      return false
    }
  }

  const switchTab = (key, preset = {}) => {
    setTab(key)
    setForm({ ...EMPTY_FREE_FORM, ...preset })
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
            className={`taller-add__tab${tab === item.key ? ' is-active' : ''}`}
            onClick={() => switchTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'repuesto' ? (
        <div className="taller-add__row">
          <ProductoBuscador
            token={token}
            sucursalId={sucursalId}
            onPick={addProducto}
            disabled={busy}
            inputRef={inputRef}
            emptyAction={{ label: 'Agregar sin código', run: (texto) => switchTab('sin_codigo', { referencia: texto }) }}
          />
          <label className="taller-add__field taller-add__field--qty">
            <span>Cant.</span>
            <input className="taller-input taller-input--qty" type="number" min={1} step={1} value={cantidad} onChange={(event) => setCantidad(event.target.value)} disabled={busy} />
          </label>
          {esGarantia && (
            <label className="taller-garantia-toggle taller-garantia-toggle--add">
              <input type="checkbox" checked={garantia} onChange={(event) => setGarantia(event.target.checked)} />
              Garantía (sin costo)
            </label>
          )}
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
// Historial: entregas con firma, devoluciones y eventos.
// ---------------------------------------------------------------------------
function HistorialTab({ orden }) {
  const entregas = orden.entregas || []
  const devoluciones = orden.devoluciones || []
  const eventos = orden.eventos || []
  return (
    <>
      <section className="create-user__section">
        <div className="create-user__section-header">
          <div>
            <p className="create-user__eyebrow">Despachos</p>
            <h4>{`Entregas al taller (${entregas.length})`}</h4>
          </div>
        </div>
        {!entregas.length ? (
          <p className="taller-muted">Todavía no se entregó nada al taller.</p>
        ) : (
          <div className="taller-entregas">
            {entregas.map((entrega) => (
              <div key={entrega.id} className="taller-entrega">
                <div className="taller-entrega__info">
                  <div className="taller-entrega__head">
                    <strong>{formatDateTime(entrega.creado_en)}</strong>
                    <span className={`taller-chip taller-chip--${entrega.tipo === 'prueba' ? 'prueba' : 'orden'}`}>{entrega.tipo_label}</span>
                  </div>
                  <div className="taller-muted">
                    {`Despachó ${entrega.entregado_por_nombre || '-'} · Recibió ${entrega.recibido_por}${entrega.recibido_rol ? ` (${entrega.recibido_rol})` : ''}`}
                  </div>
                  <ul className="taller-entrega__items">
                    {entrega.items.map((item) => (
                      <li key={item.id}>
                        <strong>{item.producto_codigo}</strong>
                        {` x${item.cantidad}`}
                        {item.a_prueba && ' (a prueba)'}
                        {Array.isArray(item.ubicaciones) && item.ubicaciones.length > 0 && (
                          <span className="taller-muted">{` · de ${item.ubicaciones.map((u) => `${u.ubicacion} (${u.cantidad})`).join(', ')}`}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {entrega.nota && <p className="taller-muted">{entrega.nota}</p>}
                </div>
                <img className="taller-entrega__firma" src={entrega.firma} alt={`Firma de ${entrega.recibido_por}`} />
              </div>
            ))}
          </div>
        )}
      </section>

      {devoluciones.length > 0 && (
        <section className="create-user__section">
          <div className="create-user__section-header">
            <div>
              <p className="create-user__eyebrow">Retornos</p>
              <h4>{`Devoluciones a bodega (${devoluciones.length})`}</h4>
            </div>
          </div>
          <ol className="taller-history">
            {devoluciones.map((dev) => (
              <li key={dev.id}>
                <span className="taller-history__when">{formatDateTime(dev.creado_en)}</span>
                <span className="taller-history__who">{dev.recibido_por_nombre || '-'}</span>
                <span className="taller-history__what">
                  {`${dev.producto_codigo} x${dev.cantidad} guardado en ${dev.ubicacion}${dev.devuelto_por ? ` (lo trajo ${dev.devuelto_por})` : ''}`}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="create-user__section">
        <div className="create-user__section-header">
          <div>
            <p className="create-user__eyebrow">Todo</p>
            <h4>Historial de la orden</h4>
          </div>
        </div>
        {!eventos.length ? (
          <p className="taller-muted">Sin movimientos todavía.</p>
        ) : (
          <ol className="taller-history">
            {eventos.map((evento) => (
              <li key={evento.id}>
                <span className="taller-history__when">{formatDateTime(evento.creado_en)}</span>
                <span className="taller-history__who">{evento.usuario_nombre || 'Sistema'}</span>
                <span className="taller-history__what">{evento.descripcion}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  )
}

// Por que todavia no se puede cerrar (lo mismo que valida el servidor).
const motivosNoCierre = (orden) => {
  const motivos = []
  const lineas = orden?.lineas || []
  const pruebas = orden?.pruebas || []
  const sinCodigo = lineas.filter((l) => l.tipo === 'sin_codigo')
  if (sinCodigo.length) motivos.push(`${sinCodigo.length} repuesto(s) sin código por crear en el inventario`)
  const precios = lineas.filter((l) => l.precio_estado === 'pendiente')
  if (precios.length) motivos.push(`${precios.length} precio(s) por aprobar`)
  const porDespachar = lineas.filter((l) => l.pendiente_despacho > 0)
  if (porDespachar.length) motivos.push(`faltan despachar: ${porDespachar.map((l) => `${l.producto_codigo} (${l.pendiente_despacho})`).join(', ')}`)
  const porEntregar = pruebas.filter((p) => p.pendiente_entrega > 0)
  if (porEntregar.length) motivos.push(`pruebas pedidas sin entregar: ${porEntregar.map((p) => p.producto_codigo).join(', ')} (entrégalas o cancélalas)`)
  const porDevolver = pruebas.filter((p) => p.en_taller > 0)
  if (porDevolver.length) motivos.push(`faltan devolver a bodega: ${porDevolver.map((p) => `${p.producto_codigo} (${p.en_taller})`).join(', ')}`)
  return motivos
}

// ---------------------------------------------------------------------------
// Ventana de la orden
// ---------------------------------------------------------------------------
function OrdenTallerModal({ open, ordenId, token, user, isAdmin = false, canEdit = true, onClose, onChanged, notify }) {
  const { shouldRender, isClosing } = useModalAnimation(open)
  const modal = useResizableModal(open, { initialSize: { width: 1360, height: 880 }, minSize: { width: 640, height: 420 } })
  const [orden, setOrden] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [header, setHeader] = useState(EMPTY_HEADER)
  const [headerStatus, setHeaderStatus] = useState('idle')
  const [busy, setBusy] = useState(false)
  const [activeTab, setActiveTab] = useState('detalle')
  const [confirm, setConfirm] = useState(null)
  const [motivo, setMotivo] = useState('')
  const [factura, setFactura] = useState('')
  const [manoObraCatalogo, setManoObraCatalogo] = useState([])
  const [sucursales, setSucursales] = useState([])
  const [showDespacho, setShowDespacho] = useState(false)
  const [devolucion, setDevolucion] = useState(null)
  const [crearProducto, setCrearProducto] = useState(null)
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

  const loadOrden = useCallback(async (id, { silent = false } = {}) => {
    if (!silent) setLoading(true)
    try {
      const response = await authFetch(`${API_URL}/taller/ordenes/${id}/`, {}, token)
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo cargar la orden.'))
      const data = await response.json()
      setOrden(data)
      setHeader({ ...headerFromOrden(data), ...pendingHeaderRef.current })
      setLoadError('')
    } catch (error) {
      setLoadError(error.message || 'No se pudo cargar la orden.')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (!open || !ordenId) return
    pendingHeaderRef.current = {}
    setOrden(null)
    setLoadError('')
    setActiveTab('detalle')
    setHeaderStatus('idle')
    setShowDespacho(false)
    setDevolucion(null)
    setCrearProducto(null)
    loadOrden(ordenId)
  }, [open, ordenId, loadOrden])

  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const [manoResp, sucResp] = await Promise.all([
          authFetch(`${API_URL}/taller/mano-obra/?activos=1`, {}, token),
          authFetch(`${API_URL}/taller/ordenes/sucursales/`, {}, token),
        ])
        if (manoResp.ok) {
          const data = await manoResp.json()
          if (!cancelled) setManoObraCatalogo(Array.isArray(data) ? data : data?.results || [])
        }
        if (sucResp.ok) {
          const data = await sucResp.json()
          if (!cancelled) setSucursales(Array.isArray(data) ? data : [])
        }
      } catch {
        // sin catalogos igual se puede trabajar
      }
    })()
    return () => { cancelled = true }
  }, [open, token])

  const editable = Boolean(orden && canEdit && (orden.estado === 'cotizacion' || orden.estado === 'orden'))
  const enOrden = orden?.estado === 'orden'
  const esGarantia = orden?.tipo === 'garantia'

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

  const patchOrden = (body, fallback) => callOrden('', { method: 'PATCH', body: JSON.stringify(body) }, fallback)
  const addLinea = (body) => callOrden('lineas/', { method: 'POST', body: JSON.stringify(body) }, 'No se pudo agregar.')
  const updateLinea = (id, body) => callOrden(`lineas/${id}/`, { method: 'PATCH', body: JSON.stringify(body) }, 'No se pudo guardar el cambio.')
  const reviewPrice = (id, aprobar) =>
    callOrden(`lineas/${id}/revisar-precio/`, { method: 'POST', body: JSON.stringify({ aprobar }) }, 'No se pudo revisar el precio.').catch(() => {})
  const addPrueba = (body) => callOrden('pruebas/', { method: 'POST', body: JSON.stringify(body) }, 'No se pudo pedir a prueba.')

  const cancelPrueba = (prueba) => {
    const run = prueba.cantidad_entregada
      ? () => callOrden(`pruebas/${prueba.id}/`, { method: 'PATCH', body: JSON.stringify({ cantidad_solicitada: prueba.cantidad_entregada }) }, 'No se pudo cancelar.')
      : () => callOrden(`pruebas/${prueba.id}/`, { method: 'DELETE' }, 'No se pudo cancelar.')
    run().catch(() => {})
  }

  const pasarPrueba = (prueba) => {
    setConfirm({
      title: `¿${prueba.producto_codigo} entra a la orden?`,
      message: `Funcionó: pasan ${prueba.en_taller} unidad(es) a la orden con su PVP. Ya están en el taller, no se vuelven a despachar.`,
      confirmLabel: 'Pasar a la orden',
      run: () => callOrden(`pruebas/${prueba.id}/pasar-a-orden/`, { method: 'POST', body: JSON.stringify({ cantidad: prueba.en_taller }) }, 'No se pudo pasar a la orden.'),
    })
  }

  const requestDelete = (linea) => {
    if (!enOrden) {
      callOrden(`lineas/${linea.id}/`, { method: 'DELETE' }, 'No se pudo quitar.').catch(() => {})
      return
    }
    setConfirm({
      title: '¿Quitar de la orden de trabajo?',
      message: `"${linea.descripcion || lineaCodigo(linea)}" ya se le confirmó al cliente.${linea.cantidad_despachada ? ` Las ${linea.cantidad_despachada} unidad(es) ya entregadas quedan por devolver a bodega.` : ''} Queda registrado en el historial.`,
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
        message: 'La orden queda anulada y ya no se puede modificar. Si hay repuestos en el taller, primero deben volver a bodega.',
        confirmLabel: 'Anular',
        withMotivo: true,
        run: (texto) => callOrden('anular/', { method: 'POST', body: JSON.stringify({ motivo: texto }) }, 'No se pudo anular.'),
      },
      cerrar: {
        title: '¿Cerrar la orden?',
        message: 'Se registra la salida tipo Taller con los repuestos de la orden: salen definitivamente (ya no están ni en el taller ni en el inventario).',
        confirmLabel: 'Cerrar orden',
        withFactura: true,
        run: (_texto, numeroFactura) => callOrden('cerrar/', { method: 'POST', body: JSON.stringify({ numero_factura: numeroFactura }) }, 'No se pudo cerrar la orden.'),
      },
    }
    setMotivo('')
    setFactura(ordenRef.current?.numero_factura || '')
    setConfirm({ kind, ...configs[kind] })
  }

  const confirmRun = async () => {
    if (!confirm) return
    try {
      await confirm.run(motivo.trim(), factura.trim())
      setConfirm(null)
    } catch {
      // el error ya se mostro; el dialogo se queda abierto
    }
  }

  const isEmptyDraft = (current) =>
    current &&
    current.estado === 'cotizacion' &&
    current.tipo !== 'garantia' &&
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

  const afterDialog = (data) => {
    if (data) applyOrden(data)
  }

  const lineas = useMemo(() => orden?.lineas || [], [orden])
  const ivaRate = toNumber(orden?.iva_rate || 0.15)
  const totales = useMemo(() => {
    const byTipo = { repuesto: 0, sin_codigo: 0, insumo: 0, mano_obra: 0 }
    lineas.forEach((linea) => {
      byTipo[linea.tipo] = (byTipo[linea.tipo] || 0) + toNumber(linea.precio) * toNumber(linea.cantidad)
    })
    const subtotal = Object.values(byTipo).reduce((acc, value) => acc + value, 0)
    const iva = Math.round(subtotal * ivaRate * 100) / 100
    return { byTipo, subtotal, iva, total: subtotal + iva }
  }, [lineas, ivaRate])
  const preciosPendientes = lineas.filter((linea) => linea.precio_estado === 'pendiente').length
  const sinCodigo = lineas.filter((linea) => linea.tipo === 'sin_codigo').length
  const porDespachar = lineas.reduce((acc, l) => acc + (l.pendiente_despacho || 0), 0)
    + (orden?.pruebas || []).reduce((acc, p) => acc + (p.pendiente_entrega || 0), 0)
  const motivosCierre = enOrden ? motivosNoCierre(orden) : []

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
  const sucursalBloqueada = Boolean((orden?.entregas || []).length)

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

  const anterior = orden?.garantia_de_resumen
  const lineasGarantiaIds = new Set(lineas.filter((l) => l.es_garantia).map((l) => l.producto))

  return (
    <div className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`} role="dialog" aria-modal="true">
      <div className={`create-user__modal taller-modal${isClosing ? ' create-user__modal--closing' : ''}`} style={modal.style}>
        <header className={`create-user__header taller-modal__header taller-modal__header--${estado.chip}`} {...modal.headerProps}>
          <div className="create-user__header-text taller-modal__title">
            <h3>{titulo}</h3>
            {orden && <span className={`taller-chip taller-chip--${estado.chip}`}>{estado.label}</span>}
            {esGarantia && <span className="taller-chip taller-chip--garantia">Garantía</span>}
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
              <BlockerNotice title="No se pudo abrir la orden" reason={loadError} actionLabel="Reintentar" onAction={() => loadOrden(ordenId)} />
            </div>
          )}

          {orden && (
            <>
              <div className="taller-steps" aria-label="Pasos de la orden">
                {ORDEN_PASOS.map((paso, index) => {
                  const done = !fueraDeFlujo && index < pasoActual
                  const current = index === pasoActual
                  const fecha = index === 0 ? orden.creado_en : index === 1 ? orden.aceptada_en : orden.cerrada_en
                  return (
                    <div key={paso.key} className={`taller-steps__step${done ? ' is-done' : ''}${current ? ' is-current' : ''}`}>
                      <span className="taller-steps__dot">{done || (current && orden.estado === 'cerrada') ? <Check size={13} /> : index + 1}</span>
                      <span className="taller-steps__label">{paso.label}</span>
                      {current && fueraDeFlujo && <span className={`taller-chip taller-chip--${estado.chip}`}>{estado.label}</span>}
                      {fecha && <span className="taller-steps__date">{formatDateTime(fecha)}</span>}
                    </div>
                  )
                })}
              </div>

              <div className="create-user__tabs" role="tablist">
                <button type="button" className={`create-user__tab${activeTab === 'detalle' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('detalle')}>
                  Orden
                </button>
                <button type="button" className={`create-user__tab${activeTab === 'historial' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('historial')}>
                  {`Despachos e historial (${(orden.entregas || []).length})`}
                </button>
              </div>

              <div className="create-user__body taller-modal__body">
                {activeTab === 'detalle' && (
                  <>
                    {esGarantia && anterior && (
                      <section className="create-user__section taller-garantia-panel">
                        <div className="create-user__section-header">
                          <div>
                            <p className="create-user__eyebrow">Garantía</p>
                            <h4>{`Orden original ${formatOrdenNumero(anterior.numero)}`}</h4>
                          </div>
                          <span className="taller-muted">
                            {[anterior.placa, anterior.cliente_nombre, anterior.numero_factura && `Factura ${anterior.numero_factura}`, anterior.cerrada_en && `Cerrada ${formatDate(anterior.cerrada_en)}`]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </div>
                        <div className="taller-garantia-parts">
                          {anterior.repuestos.length ? anterior.repuestos.map((r) => (
                            <div key={r.linea} className="taller-garantia-part">
                              <span><strong>{r.producto_codigo}</strong>{` ${r.descripcion} · x${r.cantidad}`}</span>
                              {editable && (
                                <button
                                  type="button"
                                  className="taller-mini-btn taller-mini-btn--ok"
                                  onClick={() => addLinea({ tipo: 'repuesto', producto: r.producto, cantidad: 1, es_garantia: true }).catch(() => {})}
                                  disabled={busy}
                                >
                                  {lineasGarantiaIds.has(r.producto) ? '+1 por garantía' : 'Agregar por garantía'}
                                </button>
                              )}
                            </div>
                          )) : <span className="taller-muted">La orden original no tenía repuestos.</span>}
                        </div>
                      </section>
                    )}

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
                        <label className="create-user__field">
                          <span>Sucursal (de dónde salen los repuestos)</span>
                          <select
                            value={orden.sucursal ?? ''}
                            disabled={!editable || busy || sucursalBloqueada}
                            title={sucursalBloqueada ? 'Ya se despacharon repuestos: no se puede cambiar' : undefined}
                            onChange={(event) => patchOrden({ sucursal: event.target.value ? Number(event.target.value) : null }, 'No se pudo cambiar la sucursal.').catch(() => {})}
                          >
                            <option value="">Elige la sucursal...</option>
                            {sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                          </select>
                        </label>
                        {field('placa', 'Placa', { upper: true })}
                        {field('modelo', 'Modelo / cilindraje', { placeholder: '3008 1.6 Turbo EP6 Gasolina' })}
                        {field('vin', 'VIN', { upper: true })}
                        {field('kilometraje', 'Kilometraje', { numeric: true })}
                        {field('cliente_nombre', 'Cliente')}
                        {field('cliente_identificacion', 'Cédula / RUC')}
                        {field('cliente_telefono', 'Teléfono')}
                        {orden.estado === 'cerrada' && (
                          <label className="create-user__field">
                            <span>N° de factura</span>
                            <input
                              type="text"
                              defaultValue={orden.numero_factura}
                              disabled={!canEdit || busy}
                              onBlur={(event) => {
                                const value = event.target.value.trim()
                                if (value !== (orden.numero_factura || '')) patchOrden({ numero_factura: value }, 'No se pudo guardar la factura.').catch(() => {})
                              }}
                            />
                          </label>
                        )}
                        {field('observaciones', 'Observaciones', { textarea: true })}
                      </div>
                    </section>

                    <div className="taller-split">
                      <section className="create-user__section taller-split__main">
                        <div className="create-user__section-header">
                          <div>
                            <p className="create-user__eyebrow">Detalle</p>
                            <h4>Repuestos, insumos y mano de obra</h4>
                          </div>
                          {enOrden && isAdmin && (
                            <button
                              type="button"
                              className="create-user__action create-user__action--primary taller-despachar-btn"
                              onClick={() => setShowDespacho(true)}
                              disabled={busy || !porDespachar}
                              title={porDespachar ? undefined : 'No hay nada pendiente de entregar'}
                            >
                              <Truck size={15} /> {porDespachar ? `Despachar (${porDespachar})` : 'Todo despachado'}
                            </button>
                          )}
                        </div>
                        {enOrden && !isAdmin && editable && (
                          <p className="taller-muted taller-hint">
                            {porDespachar
                              ? `Hay ${porDespachar} unidad(es) por retirar: pídeselas al administrador; él las despacha y quien recibe firma.`
                              : 'Solo se puede agregar o aumentar cantidades.'}
                          </p>
                        )}

                        {preciosPendientes > 0 && (
                          <BlockerNotice
                            title={`${preciosPendientes} ${preciosPendientes === 1 ? 'precio por aprobar' : 'precios por aprobar'}`}
                            reason={
                              isAdmin
                                ? 'Tienen un precio distinto al del inventario. Apruébalos o recházalos con ✓ / ✕ en la columna Precio: hasta entonces no se pueden despachar.'
                                : 'Tienen un precio distinto al del inventario: un administrador debe verificarlos antes de que se puedan despachar.'
                            }
                          />
                        )}
                        {sinCodigo > 0 && enOrden && (
                          <BlockerNotice
                            title={`${sinCodigo} ${sinCodigo === 1 ? 'repuesto no existe' : 'repuestos no existen'} en el inventario`}
                            reason={
                              isAdmin
                                ? 'Cómpralos y créalos con el botón "Crear producto" de cada línea (con el código sugerido); así quedan en el catálogo para la próxima vez.'
                                : 'Se agregaron sin código: el administrador debe comprarlos y crear el producto antes de despacharlos.'
                            }
                          />
                        )}

                        {editable && (
                          <AgregarLinea
                            token={token}
                            busy={busy}
                            onAdd={addLinea}
                            manoObraCatalogo={manoObraCatalogo}
                            inputRef={addInputRef}
                            sucursalId={orden.sucursal}
                            esGarantia={esGarantia}
                          />
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
                                <th title="Entregado al taller / pedido">Desp.</th>
                                <th>PVP</th>
                                <th>Precio</th>
                                <th>Total</th>
                                <th aria-label="Acciones" />
                              </tr>
                            </thead>
                            <tbody>
                              {lineas.length === 0 && (
                                <tr>
                                  <td colSpan={10} className="taller-lineas__empty">
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
                                  esGarantia={esGarantia}
                                  isAdmin={isAdmin}
                                  busy={busy}
                                  onUpdate={updateLinea}
                                  onDelete={requestDelete}
                                  onReviewPrice={reviewPrice}
                                  onCrearProducto={setCrearProducto}
                                />
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <div className="taller-totals">
                          <div><span>Repuestos</span><strong>{formatMoney(totales.byTipo.repuesto + totales.byTipo.sin_codigo)}</strong></div>
                          <div><span>Insumos</span><strong>{formatMoney(totales.byTipo.insumo)}</strong></div>
                          <div><span>Mano de obra</span><strong>{formatMoney(totales.byTipo.mano_obra)}</strong></div>
                          <div><span>Subtotal</span><strong>{formatMoney(totales.subtotal)}</strong></div>
                          <div><span>{`IVA ${Math.round(ivaRate * 100)}%`}</span><strong>{formatMoney(totales.iva)}</strong></div>
                          <div className="taller-totals__grand"><span>Total</span><strong>{formatMoney(totales.total)}</strong></div>
                        </div>
                      </section>

                      {(enOrden || (orden.pruebas || []).length > 0) && (
                        <PruebasPanel
                          orden={orden}
                          token={token}
                          isAdmin={isAdmin}
                          canEdit={canEdit}
                          busy={busy}
                          onAdd={addPrueba}
                          onCancel={cancelPrueba}
                          onPasar={pasarPrueba}
                          onDevolver={setDevolucion}
                        />
                      )}
                    </div>
                  </>
                )}

                {activeTab === 'historial' && <HistorialTab orden={orden} />}
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
                  {orden.estado === 'cerrada' && (
                    <span className="taller-muted">
                      {`Cerrada por ${orden.cerrada_por_nombre || '-'}${orden.salida_documento ? ` · Salida ${orden.salida_documento}` : ''}`}
                    </span>
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
                  {enOrden && canEdit && (
                    <>
                      {motivosCierre.length > 0 && (
                        <BlockerNotice compact title="Aún no se puede cerrar" reason={`${motivosCierre.join('; ')}.`} />
                      )}
                      <button
                        type="button"
                        className="create-user__action create-user__action--primary"
                        onClick={() => runStep('cerrar')}
                        disabled={busy || motivosCierre.length > 0}
                      >
                        Orden finalizada: cerrar
                      </button>
                    </>
                  )}
                  <button type="button" className="create-user__action create-user__action--cancel" onClick={handleClose} disabled={busy}>
                    Cerrar ventana
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
          ) : confirm?.withFactura ? (
            <label className="create-user__field taller-confirm-field">
              <span>N° de factura (opcional, del sistema de facturación)</span>
              <input type="text" value={factura} onChange={(event) => setFactura(event.target.value)} />
            </label>
          ) : null
        }
      />

      <DespachoDialog
        open={showDespacho}
        orden={orden}
        token={token}
        notify={notify}
        onClose={() => setShowDespacho(false)}
        onDone={(data) => { setShowDespacho(false); afterDialog(data) }}
      />
      <DevolucionDialog
        open={Boolean(devolucion)}
        orden={orden}
        prueba={devolucion}
        token={token}
        notify={notify}
        onClose={() => setDevolucion(null)}
        onDone={(data) => { setDevolucion(null); afterDialog(data) }}
      />
      <CrearProductoDialog
        open={Boolean(crearProducto)}
        orden={orden}
        linea={crearProducto}
        token={token}
        user={user}
        notify={notify}
        onClose={() => setCrearProducto(null)}
        onDone={(data) => { setCrearProducto(null); afterDialog(data) }}
      />
    </div>
  )
}

export default OrdenTallerModal
