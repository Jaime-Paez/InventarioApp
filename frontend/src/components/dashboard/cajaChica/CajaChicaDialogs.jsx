import { useEffect, useMemo, useState } from 'react'
import { API_URL, authFetch } from '../../../utils/api'
import BlockerNotice from '../common/BlockerNotice'
import CascadeDropdown from '../common/CascadeDropdown'
import MoneyInput from '../common/MoneyInput'
import TallerDialog from '../taller/TallerDialog'
import {
  COMPROBANTES,
  DENOMINACIONES,
  fileToReducedDataUrl,
  formatMoney,
  parseApiError,
  todayIso,
} from './cajaChicaUtils'

const post = async (token, url, body, method = 'POST', fallback = 'No se pudo guardar.') => {
  const response = await authFetch(`${API_URL}${url}`, { method, body: JSON.stringify(body) }, token)
  if (!response.ok) throw new Error(await parseApiError(response, fallback))
  return response.status === 204 ? null : response.json()
}

const DialogFooter = ({ motivo, busy, onClose, onSubmit, label }) => (
  <>
    {motivo && <span className="taller-muted taller-dialog__why">{motivo}</span>}
    <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose} disabled={busy}>
      Cancelar
    </button>
    <button type="button" className="create-user__action create-user__action--primary" onClick={onSubmit} disabled={busy || Boolean(motivo)}>
      {busy ? 'Guardando...' : label}
    </button>
  </>
)

function ComprobanteFields({ form, setForm, disabled }) {
  const [error, setError] = useState('')
  const onFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const dataUrl = await fileToReducedDataUrl(file)
      setForm((prev) => ({ ...prev, comprobante_imagen: dataUrl }))
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }
  return (
    <>
      <div className="taller-dialog__grid">
        <div className="create-user__field">
          <span>Comprobante</span>
          <CascadeDropdown
            placeholder="Elige..."
            searchPlaceholder="Buscar"
            options={COMPROBANTES.map((c) => ({ id: c.key, nombre: c.label }))}
            valueId={form.comprobante_tipo}
            getOptionLabel={(o) => o.nombre}
            onSelect={(o) => setForm((prev) => ({ ...prev, comprobante_tipo: o.id, ...(o.id === 'sin' ? { comprobante_numero: '', comprobante_imagen: '' } : {}) }))}
            disabled={disabled}
          />
        </div>
        <label className="create-user__field">
          <span>N° de comprobante</span>
          <input
            className="taller-input"
            value={form.comprobante_numero}
            disabled={disabled || form.comprobante_tipo === 'sin'}
            onChange={(event) => setForm((prev) => ({ ...prev, comprobante_numero: event.target.value }))}
          />
        </label>
      </div>
      {form.comprobante_tipo !== 'sin' && (
        <div className="create-user__field">
          <span>Foto del comprobante</span>
          <div className="caja-foto">
            {form.comprobante_imagen ? (
              <>
                <img src={form.comprobante_imagen} alt="Comprobante" />
                <button type="button" className="taller-link" onClick={() => setForm((prev) => ({ ...prev, comprobante_imagen: '' }))} disabled={disabled}>
                  Quitar foto
                </button>
              </>
            ) : (
              <label className="create-user__ghost caja-foto-btn">
                <i className="pi pi-camera" /> Tomar o subir foto
                <input type="file" accept="image/*" capture="environment" hidden onChange={onFile} disabled={disabled} />
              </label>
            )}
          </div>
          {error && <small className="taller-lineas__error">{error}</small>}
        </div>
      )}
    </>
  )
}

const EMPTY_MOV = {
  fecha: '',
  monto: null,
  categoria: '',
  descripcion: '',
  beneficiario: '',
  comprobante_tipo: '',
  comprobante_numero: '',
  comprobante_imagen: '',
}

// Registrar (o corregir) un gasto, anticipo o ingreso.
export function MovimientoDialog({ open, tipo, caja, categorias, movimiento, token, isAdmin, onClose, onDone }) {
  const [form, setForm] = useState(EMPTY_MOV)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    if (movimiento) {
      setForm({
        fecha: movimiento.fecha,
        monto: Number(movimiento.monto),
        categoria: movimiento.categoria ? String(movimiento.categoria) : '',
        descripcion: movimiento.descripcion || '',
        beneficiario: movimiento.beneficiario || '',
        comprobante_tipo: movimiento.comprobante_tipo || '',
        comprobante_numero: movimiento.comprobante_numero || '',
        comprobante_imagen: '',
      })
      if (movimiento.tiene_imagen) {
        authFetch(`${API_URL}/caja-chica/movimientos/${movimiento.id}/imagen/`, {}, token)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => data?.imagen && setForm((prev) => ({ ...prev, comprobante_imagen: data.imagen })))
          .catch(() => {})
      }
    } else {
      setForm({ ...EMPTY_MOV, fecha: todayIso() })
    }
  }, [open, movimiento, token])

  const realTipo = movimiento?.tipo || tipo
  const monto = Number(form.monto || 0)
  const saldo = Number(caja?.saldo || 0)
  const tope = Number(caja?.tope_gasto || 0)
  const esSalida = realTipo === 'gasto' || realTipo === 'anticipo'
  const requiereAprobacion = !isAdmin && ((esSalida && tope > 0 && monto > tope) || realTipo === 'ingreso')

  const motivo = !(monto > 0)
    ? 'Escribe el monto.'
    : realTipo === 'gasto' && !form.categoria
      ? 'Elige la categoría.'
      : realTipo === 'gasto' && !form.comprobante_tipo
        ? 'Indica el comprobante.'
        : !form.descripcion.trim()
          ? 'Describe el movimiento.'
          : realTipo === 'anticipo' && !form.beneficiario.trim()
            ? 'Indica a quién se entrega.'
            : esSalida && !requiereAprobacion && monto > saldo + (movimiento ? Number(movimiento.monto) : 0)
              ? `No alcanza: en caja hay ${formatMoney(saldo)}. Pide una reposición.`
              : ''

  const submit = async () => {
    if (motivo) return
    setBusy(true)
    setError('')
    try {
      const body = {
        ...form,
        monto: monto.toFixed(2),
        categoria: form.categoria ? Number(form.categoria) : null,
      }
      const data = movimiento
        ? await post(token, `/caja-chica/movimientos/${movimiento.id}/`, body, 'PATCH')
        : await post(token, '/caja-chica/movimientos/', { ...body, caja: caja.id, tipo: realTipo })
      onDone?.(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const titulos = { gasto: 'Registrar gasto', anticipo: 'Entregar anticipo / vale', ingreso: 'Registrar ingreso' }
  return (
    <TallerDialog
      open={open}
      busy={busy}
      title={movimiento ? `Corregir ${String(movimiento.tipo_label || '').toLowerCase()}` : titulos[realTipo]}
      subtitle={caja ? `${caja.nombre} · en caja ${formatMoney(caja.saldo)}` : ''}
      onClose={onClose}
      footer={<DialogFooter motivo={motivo} busy={busy} onClose={onClose} onSubmit={submit} label={requiereAprobacion ? 'Enviar a aprobación' : 'Guardar'} />}
    >
      {movimiento?.estado === 'rechazado' && movimiento.motivo_rechazo && (
        <BlockerNotice title="El administrador lo rechazó" reason={movimiento.motivo_rechazo} />
      )}
      <div className="taller-dialog__grid">
        <label className="create-user__field">
          <span>Fecha</span>
          <input className="taller-input" type="date" max={todayIso()} value={form.fecha} onChange={(event) => setForm((prev) => ({ ...prev, fecha: event.target.value }))} disabled={busy} />
        </label>
        <label className="create-user__field">
          <span>Monto</span>
          <MoneyInput className="taller-input" value={form.monto} onValueChange={(value) => setForm((prev) => ({ ...prev, monto: value }))} disabled={busy} />
        </label>
      </div>
      {realTipo === 'gasto' && !categorias.some((c) => c.activa) && (
        <BlockerNotice
          compact
          title="No hay categorías de gasto para elegir"
          reason={isAdmin ? 'Créalas con el botón "Categorías" de esta pantalla y aparecerán aquí.' : 'Pide al administrador que cree las categorías de gasto (botón "Categorías" en Caja chica).'}
        />
      )}
      {realTipo === 'gasto' && (
        <div className="create-user__field">
          <span>Categoría</span>
          <CascadeDropdown
            placeholder="Elige la categoría..."
            searchPlaceholder="Buscar categoría"
            options={categorias.filter((c) => c.activa || String(c.id) === form.categoria)}
            valueId={form.categoria}
            getOptionLabel={(o) => o.nombre}
            emptyMessage="No hay categorías: el administrador las crea en Categorías."
            onSelect={(o) => setForm((prev) => ({ ...prev, categoria: String(o.id) }))}
            disabled={busy}
          />
        </div>
      )}
      <label className="create-user__field">
        <span>{realTipo === 'anticipo' ? 'Para qué es' : 'Descripción'}</span>
        <textarea rows={2} value={form.descripcion} onChange={(event) => setForm((prev) => ({ ...prev, descripcion: event.target.value }))} disabled={busy} />
      </label>
      <label className="create-user__field">
        <span>{realTipo === 'anticipo' ? 'Se entrega a' : realTipo === 'ingreso' ? 'Quién entrega' : 'Pagado a'}</span>
        <input className="taller-input" value={form.beneficiario} onChange={(event) => setForm((prev) => ({ ...prev, beneficiario: event.target.value }))} disabled={busy} />
      </label>
      {realTipo === 'gasto' && <ComprobanteFields form={form} setForm={setForm} disabled={busy} />}
      {requiereAprobacion && (
        <BlockerNotice
          compact
          title="Necesita aprobación"
          reason={realTipo === 'ingreso' ? 'Los ingresos los verifica el administrador.' : `Supera el tope de ${formatMoney(tope)} por gasto: lo aprueba el administrador antes de afectar la caja.`}
        />
      )}
      {error && <BlockerNotice title="No se guardó" reason={error} />}
    </TallerDialog>
  )
}

// Liquidar un anticipo: lo que realmente se gasto, con su comprobante.
export function LiquidarDialog({ open, anticipo, categorias, token, onClose, onDone }) {
  const [form, setForm] = useState(EMPTY_MOV)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !anticipo) return
    setForm({ ...EMPTY_MOV, fecha: todayIso(), monto: Number(anticipo.monto), descripcion: anticipo.descripcion || '', beneficiario: anticipo.beneficiario || '' })
    setError('')
  }, [open, anticipo])

  const gastado = Number(form.monto || 0)
  const entregado = Number(anticipo?.monto || 0)
  const diferencia = entregado - gastado
  const motivo = !(gastado > 0) ? 'Escribe cuánto se gastó.' : !form.categoria ? 'Elige la categoría.' : !form.comprobante_tipo ? 'Indica el comprobante.' : ''

  const submit = async () => {
    if (motivo) return
    setBusy(true)
    setError('')
    try {
      const data = await post(token, `/caja-chica/movimientos/${anticipo.id}/liquidar/`, {
        ...form,
        monto_gastado: gastado.toFixed(2),
        categoria: Number(form.categoria),
      })
      onDone?.(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <TallerDialog
      open={open}
      busy={busy}
      title="Liquidar anticipo"
      subtitle={anticipo ? `${anticipo.beneficiario} recibió ${formatMoney(anticipo.monto)} · ${anticipo.descripcion}` : ''}
      onClose={onClose}
      footer={<DialogFooter motivo={motivo} busy={busy} onClose={onClose} onSubmit={submit} label="Liquidar" />}
    >
      <div className="taller-dialog__grid">
        <label className="create-user__field">
          <span>Fecha</span>
          <input className="taller-input" type="date" max={todayIso()} value={form.fecha} onChange={(event) => setForm((prev) => ({ ...prev, fecha: event.target.value }))} />
        </label>
        <label className="create-user__field">
          <span>Lo que se gastó</span>
          <MoneyInput className="taller-input" value={form.monto} onValueChange={(value) => setForm((prev) => ({ ...prev, monto: value }))} />
        </label>
      </div>
      {gastado > 0 && diferencia !== 0 && (
        <p className={`caja-diferencia ${diferencia > 0 ? 'is-ok' : 'is-warn'}`}>
          {diferencia > 0 ? `Vuelve a la caja (vuelto): ${formatMoney(diferencia)}` : `Se gastó ${formatMoney(-diferencia)} más: sale de la caja como gasto adicional.`}
        </p>
      )}
      <div className="create-user__field">
        <span>Categoría</span>
        <CascadeDropdown
          placeholder="Elige la categoría..."
          searchPlaceholder="Buscar categoría"
          options={categorias.filter((c) => c.activa)}
          valueId={form.categoria}
          getOptionLabel={(o) => o.nombre}
          onSelect={(o) => setForm((prev) => ({ ...prev, categoria: String(o.id) }))}
        />
      </div>
      <label className="create-user__field">
        <span>Descripción</span>
        <textarea rows={2} value={form.descripcion} onChange={(event) => setForm((prev) => ({ ...prev, descripcion: event.target.value }))} />
      </label>
      <ComprobanteFields form={form} setForm={setForm} disabled={busy} />
      {error && <BlockerNotice title="No se liquidó" reason={error} />}
    </TallerDialog>
  )
}

// Arqueo: contar el efectivo por denominacion y compararlo con el sistema.
export function ArqueoDialog({ open, caja, token, onClose, onDone }) {
  const [conteo, setConteo] = useState({})
  const [observacion, setObservacion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setConteo({})
    setObservacion('')
    setError('')
  }, [open])

  const total = useMemo(
    () => DENOMINACIONES.reduce((acc, d) => acc + Number(d.key) * (parseInt(conteo[d.key], 10) || 0), 0),
    [conteo]
  )
  const saldo = Number(caja?.saldo || 0)
  const diferencia = Math.round((total - saldo) * 100) / 100
  const motivo = diferencia !== 0 && !observacion.trim()
    ? `Hay ${diferencia > 0 ? 'un sobrante' : 'un faltante'} de ${formatMoney(Math.abs(diferencia))}: explica el motivo.`
    : ''

  const submit = async () => {
    if (motivo) return
    setBusy(true)
    setError('')
    try {
      const denominaciones = Object.fromEntries(
        Object.entries(conteo).map(([key, value]) => [key, parseInt(value, 10) || 0]).filter(([, value]) => value > 0)
      )
      const data = await post(token, `/caja-chica/cajas/${caja.id}/arqueos/`, { denominaciones, observacion: observacion.trim() })
      onDone?.(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <TallerDialog
      open={open}
      wide
      busy={busy}
      title="Arqueo de caja"
      subtitle={caja ? `${caja.nombre}: cuenta el efectivo que hay ahora` : ''}
      onClose={onClose}
      footer={<DialogFooter motivo={motivo} busy={busy} onClose={onClose} onSubmit={submit} label="Guardar arqueo" />}
    >
      <div className="caja-arqueo">
        {['Billetes', 'Monedas'].map((grupo) => (
          <div key={grupo} className="caja-arqueo__group">
            <p className="create-user__eyebrow">{grupo}</p>
            {DENOMINACIONES.filter((d) => d.tipo === grupo).map((d) => {
              const cantidad = parseInt(conteo[d.key], 10) || 0
              return (
                <div key={d.key} className="caja-arqueo__row">
                  <span className="caja-arqueo__den">{d.label}</span>
                  <span className="taller-muted">×</span>
                  <input
                    className="taller-input taller-input--qty"
                    type="number"
                    min={0}
                    value={conteo[d.key] ?? ''}
                    placeholder="0"
                    onChange={(event) => setConteo((prev) => ({ ...prev, [d.key]: event.target.value }))}
                  />
                  <span className="caja-arqueo__sub">{formatMoney(Number(d.key) * cantidad)}</span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div className="caja-arqueo__totals">
        <div><span>Contado</span><strong>{formatMoney(total)}</strong></div>
        <div><span>Según el sistema</span><strong>{formatMoney(saldo)}</strong></div>
        <div className={diferencia === 0 ? 'is-ok' : 'is-warn'}>
          <span>{diferencia === 0 ? 'Cuadra' : diferencia > 0 ? 'Sobrante' : 'Faltante'}</span>
          <strong>{formatMoney(diferencia)}</strong>
        </div>
      </div>
      <label className="create-user__field">
        <span>{diferencia === 0 ? 'Observación (opcional)' : 'Motivo de la diferencia'}</span>
        <textarea rows={2} value={observacion} onChange={(event) => setObservacion(event.target.value)} />
      </label>
      {error && <BlockerNotice title="No se guardó el arqueo" reason={error} />}
    </TallerDialog>
  )
}

// Crear o configurar una caja (solo admin).
export function CajaConfigDialog({ open, caja, token, onClose, onDone }) {
  const [form, setForm] = useState({ nombre: '', sucursal: '', custodio: '', monto_fondo: null, tope_gasto: 50, alerta_reposicion: 20, activa: true })
  const [opciones, setOpciones] = useState({ sucursales: [], usuarios: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    setForm(caja
      ? {
        nombre: caja.nombre,
        sucursal: caja.sucursal ? String(caja.sucursal) : '',
        custodio: caja.custodio ? String(caja.custodio) : '',
        monto_fondo: Number(caja.monto_fondo),
        tope_gasto: Number(caja.tope_gasto),
        alerta_reposicion: caja.alerta_reposicion,
        activa: caja.activa,
      }
      : { nombre: '', sucursal: '', custodio: '', monto_fondo: null, tope_gasto: 50, alerta_reposicion: 20, activa: true })
    authFetch(`${API_URL}/caja-chica/cajas/opciones/`, {}, token)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setOpciones(data))
      .catch(() => {})
  }, [open, caja, token])

  const esTaller = Boolean(caja?.taller)
  const tallerNombre = String(caja?.taller_nombre || '').trim()
  // Sin repetir "Taller" si el nombre del taller ya lo trae.
  const sucursalNombre = esTaller
    ? (/^taller(\s|$)/i.test(tallerNombre) ? tallerNombre : `Taller ${tallerNombre}`.trim())
    : caja?.sucursal_nombre || ''
  const motivo = !(Number(form.monto_fondo) > 0) ? 'Indica el monto del fondo.' : !form.custodio ? 'Elige el custodio (responsable).' : ''

  const submit = async () => {
    if (motivo) return
    setBusy(true)
    setError('')
    try {
      // Una caja por sucursal/taller: el nombre es automatico y queda activa
      // desde que se crea (no se editan aqui).
      const body = {
        custodio: form.custodio ? Number(form.custodio) : null,
        monto_fondo: Number(form.monto_fondo).toFixed(2),
        tope_gasto: Number(form.tope_gasto || 0).toFixed(2),
        alerta_reposicion: Number(form.alerta_reposicion || 0),
      }
      const data = await post(token, `/caja-chica/cajas/${caja.id}/`, body, 'PATCH')
      onDone?.(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <TallerDialog
      open={open}
      busy={busy}
      title="Configurar caja chica"
      tab={null}
      subtitle={null}
      onClose={onClose}
      footer={<DialogFooter motivo={motivo} busy={busy} onClose={onClose} onSubmit={submit} label={caja?.configurada ? 'Guardar' : 'Abrir caja'} />}
    >
      <div className="taller-dialog__grid">
        <div className="create-user__field">
          <span>{esTaller ? 'Taller' : 'Sucursal'}</span>
          <div className="create-salida__static-value taller-static">
            {esTaller ? `${caja?.taller_nombre || '-'}${caja?.sucursal_nombre ? ` (${caja.sucursal_nombre})` : ''}` : sucursalNombre || '-'}
          </div>
        </div>
        <div className="create-user__field">
          <span>Custodio (responsable)</span>
          <CascadeDropdown
            placeholder="Elige..."
            searchPlaceholder="Buscar usuario"
            options={opciones.usuarios}
            valueId={form.custodio}
            getOptionLabel={(o) => o.nombre}
            onSelect={(o) => setForm((prev) => ({ ...prev, custodio: String(o.id) }))}
          />
        </div>
        <label className="create-user__field">
          <span>{caja ? 'Monto del fondo (referencia para reponer)' : 'Monto del fondo'}</span>
          <MoneyInput className="taller-input" value={form.monto_fondo} onValueChange={(value) => setForm((prev) => ({ ...prev, monto_fondo: value }))} />
        </label>
        <label className="create-user__field">
          <span>Tope por gasto sin aprobación</span>
          <MoneyInput className="taller-input" value={form.tope_gasto} onValueChange={(value) => setForm((prev) => ({ ...prev, tope_gasto: value }))} />
        </label>
        <label className="create-user__field">
          <span>Avisar reposición bajo (% del fondo)</span>
          <input className="taller-input" type="number" min={0} max={100} value={form.alerta_reposicion} onChange={(event) => setForm((prev) => ({ ...prev, alerta_reposicion: event.target.value }))} />
        </label>
      </div>
      {caja && <small className="taller-muted">Si aumentas el fondo, registra el dinero extra como ingreso para que el saldo cuadre.</small>}
      {error && <BlockerNotice title="No se guardó" reason={error} />}
    </TallerDialog>
  )
}

// Categorias de gasto (solo admin).
export function CategoriasDialog({ open, categorias, token, onClose, onChanged }) {
  const [nombre, setNombre] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { if (open) { setNombre(''); setError('') } }, [open])

  const run = async (fn) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <TallerDialog open={open} busy={busy} title="Categorías de gasto" onClose={onClose}>
      <form
        className="taller-add__row"
        onSubmit={(event) => {
          event.preventDefault()
          if (!nombre.trim()) return
          run(async () => { await post(token, '/caja-chica/categorias/', { nombre: nombre.trim(), activa: true }); setNombre('') })
        }}
      >
        <label className="taller-add__field taller-add__field--grow">
          <span>Nueva categoría</span>
          <input className="taller-input" value={nombre} onChange={(event) => setNombre(event.target.value)} disabled={busy} />
        </label>
        <button type="submit" className="create-user__action create-user__action--primary" disabled={busy || !nombre.trim()}>Agregar</button>
      </form>
      <div className="taller-ubicaciones">
        {categorias.map((c) => (
          <div key={c.id} className={`taller-ubicacion${c.activa ? '' : ' is-inactive'}`}>
            <span className="taller-ubicacion__name">{c.nombre}</span>
            <label className="taller-switch">
              <input
                type="checkbox"
                checked={c.activa}
                disabled={busy}
                onChange={(event) => run(() => post(token, `/caja-chica/categorias/${c.id}/`, { activa: event.target.checked }, 'PATCH'))}
              />
              <span>{c.activa ? 'Activa' : 'Inactiva'}</span>
            </label>
          </div>
        ))}
      </div>
      {error && <BlockerNotice title="No se guardó" reason={error} />}
    </TallerDialog>
  )
}

export function ImagenDialog({ open, movimiento, token, onClose }) {
  const [imagen, setImagen] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open || !movimiento) return undefined
    let cancelled = false
    setImagen('')
    setError('')
    authFetch(`${API_URL}/caja-chica/movimientos/${movimiento.id}/imagen/`, {}, token)
      .then(async (r) => {
        if (!r.ok) throw new Error(await parseApiError(r, 'No se pudo cargar la foto.'))
        return r.json()
      })
      .then((data) => { if (!cancelled) setImagen(data?.imagen || '') })
      .catch((err) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [open, movimiento, token])
  return (
    <TallerDialog open={open} wide title="Comprobante" subtitle={movimiento ? `${movimiento.comprobante_label || ''} ${movimiento.comprobante_numero || ''} · ${formatMoney(movimiento.monto)}` : ''} onClose={onClose}>
      {imagen ? <img className="caja-foto__full" src={imagen} alt="Comprobante" /> : !error && <span className="taller-muted"><i className="pi pi-spin pi-spinner" /> Cargando...</span>}
      {error && <BlockerNotice title="No se pudo ver la foto" reason={error} />}
    </TallerDialog>
  )
}
