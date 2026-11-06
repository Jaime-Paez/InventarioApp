import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, PackagePlus, X } from 'lucide-react'
import { formatDateTime } from '../../../utils/dateFormat'
import CascadeDropdown from '../common/CascadeDropdown'
import MoneyInput from '../common/MoneyInput'
import useTableCellHover from '../common/useTableCellHover.jsx'
import TallerProductDropdown from './TallerProductDropdown'
import { LINEA_TIPOS, formatMoney, lineaCodigo } from './tallerConstants'

const toNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const TIPO_OPCIONES = [
  { id: 'repuesto', nombre: 'Repuesto' },
  { id: 'mano_obra', nombre: 'Mano de obra' },
  { id: 'insumo', nombre: 'Insumo' },
  { id: 'sin_codigo', nombre: 'Sin código' },
]

const EMPTY_DRAFT = { tipo: 'repuesto', producto: null, mano_obra: null, referencia: '', descripcion: '', cantidad: '1', precio: null, garantia: false }


const onEnterBlur = (event) => {
  if (event.key === 'Enter') event.currentTarget.blur()
}

// ---------------------------------------------------------------------------
// Fila para agregar (igual que en Salidas): tipo, codigo/selector, descripcion,
// cantidad, precio y "Agregar".
// ---------------------------------------------------------------------------
function FormRow({ token, sucursalId, busy, onAdd, manoObraCatalogo, esGarantia, addedIds }) {
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [error, setError] = useState('')
  const set = (patch) => { setDraft((prev) => ({ ...prev, ...patch })); setError('') }

  const pvp = draft.tipo === 'repuesto' && draft.producto?.precio != null ? toNumber(draft.producto.precio) : null
  const precio = draft.precio != null ? draft.precio : pvp
  const cantidad = parseInt(draft.cantidad, 10)
  const total = Number.isFinite(cantidad) && precio != null ? precio * cantidad : null

  const submit = async () => {
    if (!Number.isFinite(cantidad) || cantidad < 1) return setError('La cantidad debe ser al menos 1.')
    const body = { tipo: draft.tipo, cantidad }
    if (draft.tipo === 'repuesto') {
      if (!draft.producto) return setError('Elige el repuesto.')
      body.producto = draft.producto.id
      if (esGarantia && draft.garantia) body.es_garantia = true
      else if (draft.precio != null) body.precio = Number(draft.precio).toFixed(2)
    } else {
      const descripcion = draft.descripcion.trim()
      const referencia = draft.referencia.trim()
      if (draft.tipo === 'sin_codigo' ? !(descripcion || referencia) : !descripcion) {
        return setError(draft.tipo === 'sin_codigo' ? 'Escribe el OEM/referencia o la descripción.' : 'Escribe la descripción.')
      }
      body.descripcion = descripcion
      body.precio = Number(draft.precio || 0).toFixed(2)
      if (draft.tipo === 'sin_codigo') body.referencia = referencia
      if (draft.tipo === 'mano_obra' && draft.mano_obra) body.mano_obra = draft.mano_obra
    }
    try {
      await onAdd(body)
      setDraft({ ...EMPTY_DRAFT, tipo: draft.tipo, garantia: draft.garantia })
    } catch {
      // el error ya se mostro
    }
  }

  return (
    <>
      <div className="create-user__locations-row create-user__locations-row--form">
        <span>
          <CascadeDropdown
            placeholder="Tipo"
            searchPlaceholder="Buscar tipo"
            options={TIPO_OPCIONES}
            valueId={draft.tipo}
            getOptionLabel={(o) => o.nombre}
            onSelect={(o) => setDraft({ ...EMPTY_DRAFT, tipo: o.id, garantia: draft.garantia })}
            disabled={busy}
          />
        </span>
        <span className="taller-lines__picker">
          {draft.tipo === 'repuesto' && (
            <TallerProductDropdown
              token={token}
              sucursalId={sucursalId}
              value={draft.producto}
              onSelect={(producto) => set({ producto, precio: null })}
              disabled={busy}
              addedIds={addedIds}
            />
          )}
          {draft.tipo === 'mano_obra' && (
            <CascadeDropdown
              placeholder="Del catálogo (opcional)"
              searchPlaceholder="Buscar trabajo"
              options={manoObraCatalogo.filter((m) => m.activo)}
              valueId={draft.mano_obra}
              getOptionLabel={(o) => `${o.nombre} · ${formatMoney(o.precio)}`}
              emptyMessage="El catálogo está vacío: escribe el trabajo en Descripción."
              onSelect={(o) => set({ mano_obra: o.id, descripcion: o.nombre, precio: toNumber(o.precio) })}
              disabled={busy}
            />
          )}
          {draft.tipo === 'sin_codigo' && (
            <input placeholder="OEM / referencia" value={draft.referencia} onChange={(event) => set({ referencia: event.target.value })} disabled={busy} />
          )}
          {draft.tipo === 'insumo' && <span className="taller-muted">Sin código</span>}
        </span>
        <span>
          {draft.tipo === 'repuesto' ? (
            <span className="create-salida__table-static-value create-salida__table-static-value--name taller-lines__draft-name">
              <span className="create-salida__product-name-text">{draft.producto?.nombre || '-'}</span>
            </span>
          ) : (
            <input
              placeholder={draft.tipo === 'insumo' ? 'Goma, cinta adhesiva, ...' : draft.tipo === 'mano_obra' ? 'Trabajo' : 'Descripción'}
              value={draft.descripcion}
              onChange={(event) => set({ descripcion: event.target.value, ...(draft.tipo === 'mano_obra' ? { mano_obra: null } : {}) })}
              disabled={busy}
            />
          )}
        </span>
        <span>
          <input type="number" min={1} step={1} value={draft.cantidad} onChange={(event) => set({ cantidad: event.target.value })} disabled={busy} />
        </span>
        <span className="create-salida__table-static-value">-</span>
        <span className="create-salida__table-static-value">{pvp != null ? formatMoney(pvp) : '-'}</span>
        <span>
          {draft.tipo === 'repuesto' && esGarantia && draft.garantia ? (
            <span className="create-salida__table-static-value">$0.00</span>
          ) : (
            <MoneyInput
              value={precio}
              onValueChange={(value) => set({ precio: value })}
              disabled={busy || (draft.tipo === 'repuesto' && !draft.producto)}
            />
          )}
        </span>
        <span className="create-salida__table-static-value">{total != null ? formatMoney(draft.garantia && esGarantia && draft.tipo === 'repuesto' ? 0 : total) : '-'}</span>
        <span className="create-user__locations-cell create-user__locations-cell--action">
          <button type="button" className="create-user__ghost create-salida__ghost--add" onClick={submit} disabled={busy}>
            Agregar
          </button>
        </span>
      </div>
      {(error || (esGarantia && draft.tipo === 'repuesto') || (draft.tipo === 'repuesto' && pvp != null && draft.precio != null && Math.abs(draft.precio - pvp) > 0.0001)) && (
        <div className="create-user__locations-row create-user__locations-row--empty taller-lines__note">
          <span>
            {esGarantia && draft.tipo === 'repuesto' && (
              <label className="taller-garantia-toggle taller-garantia-toggle--inline">
                <input type="checkbox" checked={draft.garantia} onChange={(event) => set({ garantia: event.target.checked })} />
                Garantía (sin costo)
              </label>
            )}
            {draft.tipo === 'repuesto' && pvp != null && draft.precio != null && Math.abs(draft.precio - pvp) > 0.0001 && !draft.garantia && (
              <span className="taller-lines__warn">Precio distinto al PVP: queda por aprobar del administrador.</span>
            )}
            {error && <span className="taller-lines__error">{error}</span>}
          </span>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Fila guardada: cantidad, precio y descripcion se guardan al salir del campo.
// ---------------------------------------------------------------------------
function LineaRow({ linea, editable, enOrden, esGarantia, isAdmin, busy, onUpdate, onDelete, onReviewPrice, onCrearProducto, showHover, hideHover }) {
  const [cantidad, setCantidad] = useState(String(linea.cantidad))
  const [precio, setPrecio] = useState(toNumber(linea.precio))
  const [descripcion, setDescripcion] = useState(linea.descripcion || '')
  const [referencia, setReferencia] = useState(linea.referencia || '')
  const [aviso, setAviso] = useState('')
  const precioRef = useRef(precio)

  useEffect(() => { setCantidad(String(linea.cantidad)) }, [linea.cantidad])
  useEffect(() => { setPrecio(toNumber(linea.precio)); precioRef.current = toNumber(linea.precio) }, [linea.precio])
  useEffect(() => { setDescripcion(linea.descripcion || '') }, [linea.descripcion])
  useEffect(() => { setReferencia(linea.referencia || '') }, [linea.referencia])

  const minCantidad = enOrden && !isAdmin ? linea.cantidad : 1
  const canDelete = editable && (!enOrden || isAdmin)
  const esRepuesto = linea.tipo === 'repuesto'
  const precioPendiente = linea.precio_estado === 'pendiente'

  const commitCantidad = () => {
    const parsed = parseInt(cantidad, 10)
    if (!Number.isFinite(parsed) || parsed < 1) return setCantidad(String(linea.cantidad))
    if (parsed < minCantidad) {
      setAviso(`Mínimo ${minCantidad}: en la orden de trabajo solo se puede aumentar.`)
      return setCantidad(String(linea.cantidad))
    }
    setAviso('')
    if (parsed !== linea.cantidad) onUpdate(linea.id, { cantidad: parsed }).catch(() => setCantidad(String(linea.cantidad)))
  }

  const commitPrecio = () => {
    const value = precioRef.current
    if (value == null) {
      if (linea.precio_lista != null) onUpdate(linea.id, { precio: linea.precio_lista }).catch(() => setPrecio(toNumber(linea.precio)))
      else setPrecio(toNumber(linea.precio))
      return
    }
    if (Math.abs(value - toNumber(linea.precio)) > 0.0001) {
      onUpdate(linea.id, { precio: value.toFixed(2) }).catch(() => setPrecio(toNumber(linea.precio)))
    }
  }

  const commitText = (field, value, original, reset) => {
    const trimmed = String(value || '').trim()
    if (trimmed === String(original || '').trim()) return
    onUpdate(linea.id, { [field]: trimmed }).catch(() => reset(original || ''))
  }

  const despachoClase = linea.cantidad_despachada >= linea.cantidad ? ' is-done' : linea.cantidad_despachada > 0 ? ' is-partial' : ''

  return (
    <>
      <div className={`create-user__locations-row taller-lines__row${precioPendiente ? ' is-pending' : ''}${linea.tipo === 'sin_codigo' && enOrden ? ' is-missing' : ''}`}>
        <span className="taller-lines__wrap">
          <span className={`taller-tipo taller-tipo--${linea.tipo}`}>{LINEA_TIPOS[linea.tipo]?.short || linea.tipo}</span>
          {linea.es_garantia && <span className="taller-chip taller-chip--garantia">Garantía</span>}
          {linea.agregada_en_orden && <span className="taller-lineas__added" title={`Agregado con la orden en curso${linea.creado_por_nombre ? ` por ${linea.creado_por_nombre}` : ''}`}>Agregado</span>}
        </span>
        <span className="taller-lines__wrap">
          {linea.tipo === 'sin_codigo' && editable ? (
            <input value={referencia} placeholder="OEM / referencia" onChange={(event) => setReferencia(event.target.value)} onBlur={() => commitText('referencia', referencia, linea.referencia, setReferencia)} onKeyDown={onEnterBlur} disabled={busy} />
          ) : (
            <strong
              className="create-salida__product-name-text"
              onMouseEnter={(e) => showHover(e, [lineaCodigo(linea)].filter((t) => t && t !== '-'), 'Código')}
              onMouseLeave={hideHover}
            >
              {lineaCodigo(linea)}
            </strong>
          )}
          {linea.tipo === 'sin_codigo' && enOrden && isAdmin && (
            <button type="button" className="taller-mini-btn taller-mini-btn--warn" onClick={() => onCrearProducto(linea)} disabled={busy}>
              <PackagePlus size={13} /> Crear producto
            </button>
          )}
        </span>
        <span className="taller-lines__left">
          {editable && !esRepuesto ? (
            <input value={descripcion} onChange={(event) => setDescripcion(event.target.value)} onBlur={() => commitText('descripcion', descripcion, linea.descripcion, setDescripcion)} onKeyDown={onEnterBlur} disabled={busy} />
          ) : (
            <span
              className="create-salida__product-name-text"
              onMouseEnter={(e) => showHover(e, [linea.descripcion].filter(Boolean), 'Descripción')}
              onMouseLeave={hideHover}
            >
              {linea.descripcion || '-'}
            </span>
          )}
        </span>
        <span>
          {editable ? (
            <input
              type="number"
              min={minCantidad}
              step={1}
              value={cantidad}
              onChange={(event) => { setCantidad(event.target.value); setAviso('') }}
              onBlur={commitCantidad}
              onKeyDown={onEnterBlur}
              disabled={busy}
              title={enOrden && !isAdmin ? `Solo se puede aumentar (mínimo ${minCantidad})` : undefined}
            />
          ) : (
            linea.cantidad
          )}
        </span>
        <span>
          {esRepuesto && linea.producto ? (
            <span className={`taller-desp${despachoClase}`} title={linea.pendiente_despacho ? `Faltan entregar ${linea.pendiente_despacho}` : 'Todo entregado al taller'}>
              {`${linea.cantidad_despachada}/${linea.cantidad}`}
            </span>
          ) : '-'}
        </span>
        <span className="create-salida__numeric">{esRepuesto ? (linea.precio_lista != null ? formatMoney(linea.precio_lista) : 'Sin PVP') : '-'}</span>
        <span>
          {editable && !linea.es_garantia ? (
            <MoneyInput
              className={precioPendiente ? 'taller-money--pending' : undefined}
              value={precio}
              onValueChange={(value) => { precioRef.current = value; setPrecio(value) }}
              onBlur={commitPrecio}
              onKeyDown={onEnterBlur}
              disabled={busy}
            />
          ) : (
            formatMoney(linea.precio)
          )}
        </span>
        <span className="create-salida__numeric taller-lines__total">{formatMoney(toNumber(linea.precio) * toNumber(linea.cantidad))}</span>
        <span className="create-user__locations-cell create-user__locations-cell--action">
          {canDelete && (
            <button
              type="button"
              className="create-user__locations-remove"
              onClick={() => onDelete(linea)}
              disabled={busy}
              title={linea.cantidad_despachada ? 'Quitar (lo entregado queda por devolver a bodega)' : 'Quitar'}
            >
              x
            </button>
          )}
        </span>
      </div>
      {(precioPendiente || linea.precio_estado === 'aprobado' || aviso || (esGarantia && esRepuesto && editable) || (linea.tipo === 'sin_codigo' && enOrden && !isAdmin)) && (
        <div className="create-user__locations-row create-user__locations-row--empty taller-lines__note">
          <span>
            {precioPendiente && (
              <span className="taller-lines__review">
                <span className="taller-chip taller-chip--pendiente">{`Precio por aprobar (PVP ${linea.precio_lista != null ? formatMoney(linea.precio_lista) : 'sin PVP'})`}</span>
                {isAdmin && editable && (
                  <>
                    <button type="button" className="taller-mini-btn taller-mini-btn--ok" onClick={() => onReviewPrice(linea.id, true)} disabled={busy}>
                      <Check size={13} /> Aprobar
                    </button>
                    <button
                      type="button"
                      className="taller-mini-btn taller-mini-btn--no"
                      onClick={() => onReviewPrice(linea.id, false)}
                      disabled={busy || linea.precio_lista == null}
                      title={linea.precio_lista == null ? 'Sin PVP en inventario: corrige el precio en el campo' : 'Vuelve al PVP del inventario'}
                    >
                      <X size={13} /> Rechazar
                    </button>
                  </>
                )}
              </span>
            )}
            {linea.precio_estado === 'aprobado' && (
              <span className="taller-chip taller-chip--aprobado">
                {`Precio aprobado${linea.precio_revisado_por_nombre ? ` por ${linea.precio_revisado_por_nombre}` : ''}${linea.precio_revisado_en ? ` · ${formatDateTime(linea.precio_revisado_en)}` : ''}`}
              </span>
            )}
            {esGarantia && esRepuesto && editable && (
              <label className="taller-garantia-toggle taller-garantia-toggle--inline">
                <input type="checkbox" checked={Boolean(linea.es_garantia)} onChange={(event) => onUpdate(linea.id, { es_garantia: event.target.checked }).catch(() => {})} disabled={busy} />
                Garantía (sin costo)
              </label>
            )}
            {linea.tipo === 'sin_codigo' && enOrden && !isAdmin && <span className="taller-lines__warn">No existe en el inventario: el administrador debe crearlo.</span>}
            {aviso && <span className="taller-lines__error">{aviso}</span>}
          </span>
        </div>
      )}
    </>
  )
}

function LineasTabla({ orden, lineas, token, editable, enOrden, esGarantia, isAdmin, busy, manoObraCatalogo, onAdd, onUpdate, onDelete, onReviewPrice, onCrearProducto }) {
  const addedIds = useMemo(() => new Set(lineas.filter((l) => l.producto).map((l) => String(l.producto))), [lineas])
  const { showHover, hideHover, portal: cellHoverPortal } = useTableCellHover()
  return (
    <div className="create-user__locations-table create-salida__products-table taller-lines">
      <div className="create-user__locations-row create-user__locations-row--head">
        <span>Tipo</span>
        <span>Código / OEM</span>
        <span>Descripción</span>
        <span>Cantidad</span>
        <span title="Entregado al taller / pedido">Desp.</span>
        <span>PVP</span>
        <span>Precio</span>
        <span>Total</span>
        <span>Acciones</span>
      </div>
      {editable && (
        <FormRow
          token={token}
          sucursalId={orden?.sucursal}
          busy={busy}
          onAdd={onAdd}
          manoObraCatalogo={manoObraCatalogo}
          esGarantia={esGarantia}
          addedIds={addedIds}
        />
      )}
      {!lineas.length && (
        <div className="create-user__locations-row create-user__locations-row--empty">
          <span>Sin repuestos, insumos ni mano de obra.</span>
        </div>
      )}
      {lineas.map((linea) => (
        <LineaRow
          key={linea.id}
          linea={linea}
          editable={editable}
          enOrden={enOrden}
          esGarantia={esGarantia}
          isAdmin={isAdmin}
          busy={busy}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onReviewPrice={onReviewPrice}
          onCrearProducto={onCrearProducto}
          showHover={showHover}
          hideHover={hideHover}
        />
      ))}
      {cellHoverPortal}
    </div>
  )
}

export default LineasTabla
