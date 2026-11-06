import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Truck } from 'lucide-react'
import '../admin/CreateUsuario/CreateUsuario.css'
import '../movimientos/CreateSalida.css'
import './Taller.css'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDate } from '../../../utils/dateFormat'
import useModalAnimation from '../common/useModalAnimation'
import useResizableModal from '../common/useResizableModal'
import BlockerNotice from '../common/BlockerNotice'
import CascadeDropdown from '../common/CascadeDropdown'
import ConfirmDialog from '../common/unsavedChanges/ConfirmDialog'
import LineasTabla from './LineasTabla'
import OrdenHistorial from './OrdenHistorial'
import PruebasPanel from './PruebasPanel'
import DespachoDialog from './DespachoDialog'
import DevolucionDialog from './DevolucionDialog'
import CrearProductoDialog from './CrearProductoDialog'
import { estadoInfo, formatMoney, formatOrdenNumero, lineaCodigo, motivosNoCierre, parseApiError } from './tallerConstants'

const HEADER_FIELDS = [
  'numero_pedido',
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
  const [tecnicos, setTecnicos] = useState([])
  const [talleres, setTalleres] = useState([])
  const [insumosCatalogo, setInsumosCatalogo] = useState([])
  const [showDespacho, setShowDespacho] = useState(false)
  const [devolucion, setDevolucion] = useState(null)
  const [crearProducto, setCrearProducto] = useState(null)
  const pendingHeaderRef = useRef({})
  const headerTimerRef = useRef(null)
  const ordenRef = useRef(null)
  ordenRef.current = orden

  const report = useCallback((detail, severity = 'error', summary = 'Taller') => {
    notify?.({ severity, summary, detail })
  }, [notify])

  const applyOrden = useCallback((data) => {
    setOrden(data)
    // Lo que se esta escribiendo y aun no se guarda no se pisa.
    setHeader({ ...headerFromOrden(data), ...pendingHeaderRef.current })
    onChanged?.(data)
  }, [onChanged])

  const loadOrden = useCallback(async (id) => {
    setLoading(true)
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
      setLoading(false)
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
    const getList = async (url) => {
      try {
        const response = await authFetch(`${API_URL}${url}`, {}, token)
        if (!response.ok) return []
        const data = await response.json()
        return Array.isArray(data) ? data : data?.results || []
      } catch {
        return []
      }
    }
    ;(async () => {
      const [mano, tecs, tals, ins] = await Promise.all([
        getList('/taller/mano-obra/?activos=1'),
        getList('/taller/tecnicos/?activos=1'),
        getList('/taller/talleres/?activos=1'),
        getList('/taller/insumos/?activos=1'),
      ])
      if (cancelled) return
      setManoObraCatalogo(mano)
      setTecnicos(tecs)
      setTalleres(tals)
      setInsumosCatalogo(ins)
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
    !current.tecnico_asignado &&
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

  // El tecnico asignado aunque ya este inactivo (para que se vea en la orden).
  const tecnicoOpciones = useMemo(() => {
    if (orden?.tecnico_asignado && !tecnicos.some((t) => t.id === orden.tecnico_asignado)) {
      return [...tecnicos, { id: orden.tecnico_asignado, nombre: orden.tecnico || 'Técnico' }]
    }
    return tecnicos
  }, [orden?.tecnico, orden?.tecnico_asignado, tecnicos])

  if (!shouldRender) return null

  const estado = estadoInfo(orden?.estado)
  const conHistorial = Boolean(orden && orden.estado !== 'cotizacion')
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
    <label className={`create-user__field${props.full ? ' taller-field--full' : ''}`}>
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
            {orden && orden.estado !== 'cotizacion' && <span className={`taller-chip taller-chip--${estado.chip}`}>{estado.label}</span>}
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
              {conHistorial && (
                <div className="create-user__tabs" role="tablist">
                  <button type="button" className={`create-user__tab${activeTab === 'detalle' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('detalle')}>
                    Orden
                  </button>
                  <button type="button" className={`create-user__tab${activeTab === 'historial' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('historial')}>
                    {`Despachos e historial (${(orden.entregas || []).length})`}
                  </button>
                </div>
              )}

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
                          <p className="create-user__eyebrow">Orden</p>
                          <h4>Datos de la orden</h4>
                        </div>
                        {saveLabel && <span className={`taller-save taller-save--${headerStatus}`}>{saveLabel}</span>}
                      </div>
                      <div className="create-user__grid taller-header-grid">
                        <div className="create-user__field">
                          <span>N° de orden</span>
                          <div className="create-salida__static-value taller-static">{formatOrdenNumero(orden.numero)}</div>
                        </div>
                        {field('numero_pedido', 'N° de pedido')}
                        <div className="create-user__field">
                          <span>Taller</span>
                          <CascadeDropdown
                            placeholder="Elige el taller"
                            searchPlaceholder="Buscar taller"
                            options={talleres.some((t) => t.id === orden.taller) || !orden.taller ? talleres : [...talleres, { id: orden.taller, nombre: orden.taller_nombre }]}
                            valueId={orden.taller}
                            selectedLabel={orden.taller_nombre}
                            getOptionLabel={(t) => t.nombre}
                            emptyMessage="No hay talleres: créalos en Taller → Talleres."
                            onSelect={(t) => patchOrden({ taller: t.id }, 'No se pudo cambiar el taller.').catch(() => {})}
                            disabled={!editable || busy || Boolean((orden.entregas || []).length)}
                          />
                        </div>
                        <div className="create-user__field">
                          <span>Técnico</span>
                          <CascadeDropdown
                            placeholder={tecnicos.length ? 'Elige el técnico' : 'No hay técnicos'}
                            searchPlaceholder="Buscar técnico"
                            options={tecnicoOpciones}
                            valueId={orden.tecnico_asignado}
                            selectedLabel={orden.tecnico}
                            getOptionLabel={(t) => t.nombre}
                            emptyMessage="No hay técnicos activos: créalos en Taller → Técnicos."
                            onSelect={(t) => patchOrden({ tecnico_asignado: t.id }, 'No se pudo asignar el técnico.').catch(() => {})}
                            disabled={!editable || busy}
                          />
                        </div>
                        <div className="create-user__field">
                          <span>Asesor</span>
                          <div className="create-salida__static-value taller-static">{orden.asesor_nombre || '-'}</div>
                        </div>
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
                      </div>
                      {editable && !talleres.length && (
                        <BlockerNotice
                          compact
                          title="No hay talleres para elegir"
                          reason="Crea el taller (con su sucursal principal) en Taller → Talleres y aparecerá aquí."
                          goTo="Talleres"
                        />
                      )}
                      {editable && !tecnicos.length && (
                        <BlockerNotice
                          compact
                          title="No hay técnicos para elegir"
                          reason="Créalos una vez en Taller → Técnicos y aparecerán aquí."
                          goTo="Técnicos"
                        />
                      )}
                    </section>

                    <div className="taller-datos">
                      <section className="create-user__section taller-datos__card">
                        <div className="create-user__section-header">
                          <div>
                            <p className="create-user__eyebrow">Cliente</p>
                            <h4>Datos del cliente</h4>
                          </div>
                        </div>
                        <div className="create-user__grid create-user__grid--two">
                          {field('cliente_nombre', 'Nombre', { full: true })}
                          {field('cliente_identificacion', 'Cédula / RUC')}
                          {field('cliente_telefono', 'Teléfono')}
                        </div>
                      </section>
                      <section className="create-user__section taller-datos__card">
                        <div className="create-user__section-header">
                          <div>
                            <p className="create-user__eyebrow">Vehículo</p>
                            <h4>Datos del vehículo</h4>
                          </div>
                        </div>
                        <div className="create-user__grid create-user__grid--two">
                          {field('placa', 'Placa', { upper: true })}
                          {field('kilometraje', 'Kilometraje', { numeric: true })}
                          {field('modelo', 'Modelo / cilindraje', { placeholder: '3008 1.6 Turbo EP6 Gasolina', full: true })}
                          {field('vin', 'VIN', { upper: true, full: true })}
                        </div>
                      </section>
                    </div>

                    <div className={`taller-split${enOrden || (orden.pruebas || []).length > 0 ? ' taller-split--con-pruebas' : ''}`}>
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
                                ? 'Tienen un precio distinto al del inventario. Apruébalos o recházalos debajo de cada línea: hasta entonces no se pueden despachar.'
                                : 'Tienen un precio distinto al del inventario: un administrador debe verificarlos antes de que se puedan despachar.'
                            }
                          />
                        )}
                        {sinCodigo > 0 && enOrden && (
                          <BlockerNotice
                            title={`${sinCodigo} ${sinCodigo === 1 ? 'repuesto no existe' : 'repuestos no existen'} en el inventario`}
                            reason={
                              isAdmin
                                ? 'Cómpralos y créalos con "Crear producto" en cada línea (con el código sugerido); así quedan en el catálogo para la próxima vez.'
                                : 'Se agregaron sin código: el administrador debe comprarlos y crear el producto antes de despacharlos.'
                            }
                          />
                        )}

                        <LineasTabla
                          orden={orden}
                          lineas={lineas}
                          token={token}
                          editable={editable}
                          enOrden={enOrden}
                          esGarantia={esGarantia}
                          isAdmin={isAdmin}
                          busy={busy}
                          manoObraCatalogo={manoObraCatalogo}
                          insumosCatalogo={insumosCatalogo}
                          onAdd={addLinea}
                          onUpdate={updateLinea}
                          onDelete={requestDelete}
                          onReviewPrice={reviewPrice}
                          onCrearProducto={setCrearProducto}
                        />

                        <div className="taller-totals">
                          <div><span>Repuestos</span><strong>{formatMoney(totales.byTipo.repuesto + totales.byTipo.sin_codigo)}</strong></div>
                          <div><span>Insumos</span><strong>{formatMoney(totales.byTipo.insumo)}</strong></div>
                          <div><span>Mano de obra</span><strong>{formatMoney(totales.byTipo.mano_obra)}</strong></div>
                          <div><span>Subtotal</span><strong>{formatMoney(totales.subtotal)}</strong></div>
                          <div><span>{`IVA ${Math.round(ivaRate * 100)}%`}</span><strong>{formatMoney(totales.iva)}</strong></div>
                          <div className="taller-totals__grand"><span>Total</span><strong>{formatMoney(totales.total)}</strong></div>
                        </div>

                        <section className="create-user__section taller-observaciones">
                          {field('observaciones', 'Observaciones', { textarea: true })}
                        </section>
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

                {activeTab === 'historial' && <OrdenHistorial orden={orden} />}
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
                        <BlockerNotice compact title="Aún no se puede crear la orden de trabajo" reason="Agrega al menos un repuesto, insumo o mano de obra." />
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
