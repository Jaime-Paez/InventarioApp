import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DataTable } from 'primereact/datatable'
import { Settings, Tags } from 'lucide-react'
import { Column } from 'primereact/column'
import Toast from '../common/AppToast'
import BlockerNotice from '../common/BlockerNotice'
import { TallerDialogsOcultos } from '../taller/tallerDialogContext'
import CascadeDropdown from '../common/CascadeDropdown'
import ConfirmDialog from '../common/unsavedChanges/ConfirmDialog'
import '../admin/UsersTable/UsersTable.css'
import '../admin/CreateUsuario/CreateUsuario.css'
import '../movimientos/TrasladosInconvenientesTable.css'
import '../taller/Taller.css'
import './CajaChica.css'
import { API_URL, authFetch } from '../../../utils/api'
import { formatDate, formatDateTime } from '../../../utils/dateFormat'
import { buildFileName, exportToExcel } from '../../../utils/exportUtils'
import {
  ArqueoDialog,
  CajaConfigDialog,
  CategoriasDialog,
  ImagenDialog,
  LiquidarDialog,
  MovimientoDialog,
} from './CajaChicaDialogs'
import { ESTADO_CHIP, TIPO_LABELS, currentMonth, formatMoney, monthLabel, monthRange, parseApiError, shiftMonth } from './cajaChicaUtils'

// Nombre a mostrar de una caja: su sucursal o su taller (sin repetir
// "Taller" si el nombre del taller ya lo trae).
const nombreCaja = (c) => {
  if (!c) return ''
  if (c.taller) {
    const t = String(c.taller_nombre || '').trim()
    return /^taller(\s|$)/i.test(t) ? t : `Taller ${t}`
  }
  return c.sucursal_nombre || c.nombre
}

function CajaChicaPage({ token, user, moduleActions, isTabActive, onTitleSwitcherChange }) {
  const toast = useRef(null)
  const isAdmin = Boolean(
    user?.is_superuser || user?.is_staff || user?.es_administrador || String(user?.rol || '').trim().toLowerCase() === 'administrador'
  )
  const canCreate = moduleActions?.puede_crear ?? true

  const [cajas, setCajas] = useState([])
  const [cajaId, setCajaId] = useState('')
  const [categorias, setCategorias] = useState([])
  const [movimientos, setMovimientos] = useState([])
  const [loadingCajas, setLoadingCajas] = useState(true)
  const [loadingMovs, setLoadingMovs] = useState(false)
  const [error, setError] = useState('')
  // Los movimientos se ven por mes; las flechas pasan al mes anterior / siguiente.
  const [mesFiltro, setMesFiltro] = useState(currentMonth)
  const [filtros, setFiltros] = useState(() => ({ ...monthRange(currentMonth()), tipo: '', estado: '', search: '' }))
  const esMesActual = mesFiltro.anio === currentMonth().anio && mesFiltro.mes === currentMonth().mes
  const cambiarMes = (delta) => {
    const nuevo = shiftMonth(mesFiltro, delta)
    setMesFiltro(nuevo)
    setFiltros((prev) => ({ ...prev, ...monthRange(nuevo) }))
  }
  const [dialog, setDialog] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [motivo, setMotivo] = useState('')
  const [busy, setBusy] = useState(false)
  // Menu "Registrar" (gasto, anticipo, ingreso, arqueo, reposicion).
  const [showRegistrar, setShowRegistrar] = useState(false)
  const registrarRef = useRef(null)
  useEffect(() => {
    if (!showRegistrar) return undefined
    const onDown = (event) => { if (!registrarRef.current?.contains(event.target)) setShowRegistrar(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showRegistrar])

  const notify = useCallback((detail, severity = 'success') => {
    toast.current?.show({ severity, summary: 'Caja chica', detail, life: severity === 'error' ? 5000 : 2500 })
  }, [])

  const loadCajas = useCallback(async () => {
    setLoadingCajas(true)
    try {
      const [cajasResp, catResp] = await Promise.all([
        authFetch(`${API_URL}/caja-chica/cajas/`, {}, token),
        authFetch(`${API_URL}/caja-chica/categorias/`, {}, token),
      ])
      if (!cajasResp.ok) throw new Error(await parseApiError(cajasResp, 'No se pudieron cargar las cajas.'))
      const data = await cajasResp.json()
      // La caja de un taller va junto a la de su sucursal (son casi lo mismo):
      // por sucursal, primero la de la sucursal y despues la de sus talleres.
      const list = (Array.isArray(data) ? data : data?.results || []).slice().sort((a, b) => (
        String(a.sucursal_nombre || '').localeCompare(String(b.sucursal_nombre || ''), 'es', { sensitivity: 'base' })
        || (a.taller ? 1 : 0) - (b.taller ? 1 : 0)
        || String(a.taller_nombre || '').localeCompare(String(b.taller_nombre || ''), 'es', { sensitivity: 'base' })
      ))
      setCajas(list)
      if (catResp.ok) {
        const cats = await catResp.json()
        setCategorias(Array.isArray(cats) ? cats : cats?.results || [])
      }
      setCajaId((prev) => {
        if (list.some((c) => String(c.id) === String(prev))) return String(prev)
        // Primero una caja ya configurada (las demas se eligen en el desplegable).
        const first = list.find((c) => c.activa && c.configurada) || list.find((c) => c.activa) || list[0]
        return first ? String(first.id) : ''
      })
      setError('')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingCajas(false)
    }
  }, [token])

  const caja = cajas.find((c) => String(c.id) === String(cajaId)) || null

  const loadMovimientos = useCallback(async () => {
    if (!cajaId) {
      setMovimientos([])
      return
    }
    setLoadingMovs(true)
    try {
      const params = new URLSearchParams({ caja: cajaId, page_size: '500' })
      if (filtros.desde) params.set('desde', filtros.desde)
      if (filtros.hasta) params.set('hasta', filtros.hasta)
      if (filtros.tipo) params.set('tipo', filtros.tipo)
      if (filtros.estado) params.set('estado', filtros.estado)
      if (filtros.search.trim()) params.set('search', filtros.search.trim())
      const response = await authFetch(`${API_URL}/caja-chica/movimientos/?${params}`, {}, token)
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudieron cargar los movimientos.'))
      const data = await response.json()
      setMovimientos(Array.isArray(data) ? data : data?.results || [])
    } catch (err) {
      notify(err.message, 'error')
    } finally {
      setLoadingMovs(false)
    }
  }, [cajaId, filtros, notify, token])

  useEffect(() => { loadCajas() }, [loadCajas])
  useEffect(() => { if (isTabActive) loadCajas() }, [isTabActive, loadCajas])
  useEffect(() => {
    const timer = setTimeout(loadMovimientos, 250)
    return () => clearTimeout(timer)
  }, [loadMovimientos])

  const refreshAll = () => {
    loadCajas()
    loadMovimientos()
  }

  const closeDialog = (message) => {
    setDialog(null)
    if (message) notify(message)
    refreshAll()
  }

  const revisar = async (mov, aprobar, motivoTexto = '') => {
    setBusy(true)
    try {
      const response = await authFetch(
        `${API_URL}/caja-chica/movimientos/${mov.id}/${aprobar ? 'aprobar' : 'rechazar'}/`,
        { method: 'POST', body: JSON.stringify({ motivo: motivoTexto }) },
        token
      )
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo revisar.'))
      notify(aprobar ? 'Aprobado.' : 'Rechazado.')
      refreshAll()
      return true
    } catch (err) {
      notify(err.message, 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  const eliminar = async (mov) => {
    setBusy(true)
    try {
      const response = await authFetch(`${API_URL}/caja-chica/movimientos/${mov.id}/`, { method: 'DELETE' }, token)
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo eliminar.'))
      notify('Eliminado.')
      refreshAll()
      return true
    } catch (err) {
      notify(err.message, 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  const pedirReposicion = async () => {
    setBusy(true)
    try {
      const response = await authFetch(`${API_URL}/caja-chica/cajas/${cajaId}/reposicion/`, { method: 'POST', body: '{}' }, token)
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo pedir la reposición.'))
      const data = await response.json()
      notify(data.estado === 'aprobado' ? `Reposición de ${formatMoney(data.monto)} registrada.` : `Reposición de ${formatMoney(data.monto)} enviada al administrador.`)
      refreshAll()
      return true
    } catch (err) {
      notify(err.message, 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  const exportar = () => {
    const columns = [
      { key: 'fecha', header: 'Fecha' },
      { key: 'tipo', header: 'Tipo' },
      { key: 'estado', header: 'Estado' },
      { key: 'categoria', header: 'Categoría' },
      { key: 'descripcion', header: 'Descripción' },
      { key: 'beneficiario', header: 'Beneficiario' },
      { key: 'comprobante', header: 'Comprobante' },
      { key: 'entrada', header: 'Entrada' },
      { key: 'salida', header: 'Salida' },
      { key: 'registrado', header: 'Registrado por' },
    ]
    exportToExcel({
      rows: movimientos,
      columns,
      fileName: buildFileName(`caja-chica-${(caja?.nombre || 'caja').replace(/\s+/g, '-')}`),
      valueGetter: (row, key) => ({
        fecha: formatDate(row.fecha),
        tipo: row.tipo_label,
        estado: row.estado_label,
        categoria: row.categoria_nombre,
        descripcion: row.descripcion,
        beneficiario: row.beneficiario,
        comprobante: [row.comprobante_label, row.comprobante_numero].filter(Boolean).join(' '),
        entrada: row.es_entrada ? Number(row.monto) : '',
        salida: row.es_entrada ? '' : Number(row.monto),
        registrado: row.registrado_por_nombre,
      })[key],
    })
  }

  const totalesPeriodo = useMemo(() => {
    let entradas = 0
    let salidas = 0
    movimientos.forEach((m) => {
      if (!m.afecta_saldo) return
      if (m.es_entrada) entradas += Number(m.monto)
      else salidas += Number(m.monto)
    })
    return { entradas, salidas }
  }, [movimientos])

  // La caja se elige en el titulo de la pagina ("Caja chica Tumbaco v"),
  // como la sucursal en Entradas / Salidas.
  useEffect(() => {
    if (!onTitleSwitcherChange) return undefined
    const elegida = cajas.find((c) => String(c.id) === String(cajaId))
    onTitleSwitcherChange(cajas.length ? {
      label: elegida ? nombreCaja(elegida) : 'Elige la caja',
      selectedId: String(cajaId || ''),
      options: cajas.map((c) => ({
        id: String(c.id),
        nombre: `${nombreCaja(c)}${c.pendientes > 0 && isAdmin ? ` (${c.pendientes} por aprobar)` : ''}`,
      })),
      onSelect: (id) => setCajaId(String(id)),
    } : null)
    return undefined
  }, [cajas, cajaId, isAdmin, onTitleSwitcherChange])

  // ---------------------------------------------------------------- render

  // Primera carga: se dibuja la pagina (barra y tabla) y el loader va dentro
  // de la tabla, como en el resto de la app.
  const cargandoInicial = loadingCajas && !cajas.length
  const tablaSpinner = (
    <div className="spinner-container spinner-container--table">
      <div className="spinner" />
    </div>
  )

  const saldo = Number(caja?.saldo || 0)
  const fondo = Number(caja?.monto_fondo || 0)
  const porcentaje = fondo > 0 ? Math.max(0, Math.min(100, (saldo / fondo) * 100)) : 0
  const bajo = caja && porcentaje < Number(caja.alerta_reposicion || 0)
  const esCustodio = caja && String(caja.custodio) === String(user?.id)
  const configurada = Boolean(caja?.configurada)
  const puedeRegistrar = Boolean(caja?.activa && configurada && canCreate && (isAdmin || esCustodio))

  // Primera fila del encabezado de la tabla (como en Revision de inventario >
  // Diferencias): vistas y recargar a la izquierda; registrar y configurar a
  // la derecha.
  const barraTabla = (
    <div className="caja-barra">
      <div className="caja-barra__izq">
        <button className="rounded-icon-btn" type="button" onClick={loadMovimientos} disabled={loadingMovs} title="Recargar">
          <i className="pi pi-refresh" />
        </button>
      </div>
      <div className="caja-barra__der">
        {puedeRegistrar && (
          <div className="caja-registrar" ref={registrarRef}>
            <button type="button" className="p-button users-topbtn users-topbtn--create" onClick={() => setShowRegistrar((v) => !v)}>
              <i className="pi pi-plus" /> Registrar <i className="pi pi-angle-down" />
            </button>
            {showRegistrar && (
              <div className="caja-registrar__menu" role="menu">
                {[
                  ['Gasto', 'pi-minus-circle', () => setDialog({ kind: 'mov', tipo: 'gasto' })],
                  ['Anticipo / vale', 'pi-send', () => setDialog({ kind: 'mov', tipo: 'anticipo' })],
                  ['Ingreso', 'pi-plus-circle', () => setDialog({ kind: 'mov', tipo: 'ingreso' })],
                  ['Arqueo', 'pi-calculator', () => setDialog({ kind: 'arqueo' })],
                  ['Pedir reposición', 'pi-refresh', () => setConfirm({ kind: 'reposicion' }), busy || saldo >= fondo],
                ].map(([label, icon, accion, deshabilitado]) => (
                  <button key={label} type="button" role="menuitem" disabled={Boolean(deshabilitado)} onClick={() => { setShowRegistrar(false); accion() }}>
                    <i className={`pi ${icon}`} /> {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {isAdmin && caja && (
          <button type="button" className="caja-config-btn" onClick={() => setDialog({ kind: 'caja', caja })}>
            <Settings size={14} />
            Configurar
          </button>
        )}
        {isAdmin && (
          <button type="button" className="caja-config-btn" onClick={() => setDialog({ kind: 'categorias' })}>
            <Tags size={14} />
            Categorías
          </button>
        )}
      </div>
    </div>
  )

  return (
    <TallerDialogsOcultos.Provider value={isTabActive === false}>
    <div className="users-page caja-page">
      <Toast ref={toast} />

      {error && <BlockerNotice title="No se pudo cargar la caja chica" reason={error} actionLabel="Reintentar" onAction={loadCajas} />}

      {cargandoInicial && (
        <>
          <div className="users-table users-table--card users-table--compact caja-datatable">
            {tablaSpinner}
            <DataTable
              value={[]}
              header={(
                <div className="users-header">
                  <div className="users-header__left">
                    <div className="search-input-container">
                      <input className="search-input" placeholder="Buscar en tabla" disabled />
                      <i className="pi pi-search search-input-icon" />
                    </div>
                  </div>
                  <div className="users-header__right">
                    <span className="users-header__count">Reg. 0</span>
                  </div>
                </div>
              )}
              className="users-datatable users-datatable--compact"
              tableStyle={{ width: '100%' }}
              emptyMessage=" "
              showGridlines
              size="small"
            >
              {['Fecha', 'Tipo', 'Detalle', 'Comprobante', 'Entrada', 'Salida', 'Estado', 'Acciones'].map((titulo) => (
                <Column key={titulo} header={titulo} />
              ))}
            </DataTable>
          </div>
        </>
      )}

      {!cajas.length && !error && !isAdmin && !cargandoInicial && (
        <BlockerNotice
          title="No tienes una caja chica asignada"
          reason="Cada sucursal tiene su caja: pide al administrador que te ponga como custodio de la caja de tu sucursal."
        />
      )}

      {cajas.length > 0 && (
        <>
          {/* Sin configurar no hay tabla: el desplegable va suelto para poder
              cambiar a otra caja (configurada o no) y configurarla. */}
          {caja && !configurada && (
            <div className="caja-barra-suelta">{barraTabla}</div>
          )}
          {caja && !configurada && (
            isAdmin ? (
              <BlockerNotice
                title={`Configura la caja chica de ${nombreCaja(caja)}`}
                reason="Todavía no tiene fondo ni custodio. Indica el monto del fondo, quién la maneja y el tope de gasto sin aprobación: con eso queda abierta."
                actionLabel="Configurar caja"
                onAction={() => setDialog({ kind: 'caja', caja })}
              />
            ) : (
              <BlockerNotice
                title="Esta caja todavía no está configurada"
                reason="El administrador debe ponerle el fondo y el custodio antes de registrar gastos."
              />
            )
          )}

          {caja && configurada && (
            <>
              <div className="caja-stats">
                <div className="caja-stat caja-stat--saldo">
                  <span>En caja</span>
                  <strong>{formatMoney(saldo)}</strong>
                  <div className="caja-meter" aria-label={`${Math.round(porcentaje)}% del fondo`}>
                    <div className={`caja-meter__fill${bajo ? ' is-low' : ''}`} style={{ width: `${porcentaje}%` }} />
                  </div>
                  <small>{`${Math.round(porcentaje)}% de ${formatMoney(fondo)}`}</small>
                </div>
                <div className="caja-stat">
                  <span>Gastado en el período</span>
                  <strong>{formatMoney(totalesPeriodo.salidas)}</strong>
                  <small>{`Entró ${formatMoney(totalesPeriodo.entradas)}`}</small>
                </div>
                <div className="caja-stat">
                  <span>Por aprobar</span>
                  <strong>{caja.pendientes}</strong>
                  <small>{`Tope ${formatMoney(caja.tope_gasto)}`}</small>
                </div>
                <div className="caja-stat">
                  <span>Anticipos sin liquidar</span>
                  <strong>{caja.anticipos_abiertos}</strong>
                </div>
                <div className="caja-stat">
                  <span>Último arqueo</span>
                  <strong className={caja.ultimo_arqueo && Number(caja.ultimo_arqueo.diferencia) !== 0 ? 'is-warn' : ''}>
                    {caja.ultimo_arqueo ? (Number(caja.ultimo_arqueo.diferencia) === 0 ? 'Cuadró' : formatMoney(caja.ultimo_arqueo.diferencia)) : 'Nunca'}
                  </strong>
                  {caja.ultimo_arqueo && <small>{formatDateTime(caja.ultimo_arqueo.fecha)}</small>}
                </div>
                <div className="caja-stat">
                  <span>Custodio</span>
                  <strong className="caja-stat__texto">{caja.custodio_nombre || 'Sin custodio'}</strong>
                </div>
              </div>

              {bajo && (
                <BlockerNotice
                  title={`Queda poco en la caja (${Math.round(porcentaje)}%)`}
                  reason={`Pide la reposición de ${formatMoney(fondo - saldo)} para que el fondo vuelva a ${formatMoney(fondo)}.`}
                  actionLabel={puedeRegistrar ? 'Pedir reposición' : undefined}
                  onAction={puedeRegistrar ? () => setConfirm({ kind: 'reposicion' }) : undefined}
                />
              )}
              {!caja.activa && <BlockerNotice title="Caja desactivada" reason="Solo se puede consultar. Actívala en Configurar para seguir registrando." />}
              {!puedeRegistrar && caja.activa && !isAdmin && (
                <BlockerNotice title="Solo lectura" reason="Solo el custodio de esta caja o un administrador registran movimientos." />
              )}

              {(
                <div className="users-table users-table--card users-table--compact caja-datatable">
                  {loadingMovs && tablaSpinner}
                  <DataTable
                    value={movimientos}
                    dataKey="id"
                    scrollable
                    scrollHeight="flex"
                    header={(
                      <>
                      {barraTabla}
                      <div className="users-header">
                        <div className="users-header__left caja-header__filtros">
                          <div className="search-input-container">
                            <input className="search-input" placeholder="Buscar en tabla" value={filtros.search} onChange={(event) => setFiltros((prev) => ({ ...prev, search: event.target.value }))} />
                            <i className={`pi ${loadingMovs ? 'pi-spinner pi-spin' : 'pi-search'} search-input-icon`} />
                          </div>
                          <div className="caja-mes" role="group" aria-label="Mes">
                            <button type="button" className="caja-mes__btn" onClick={() => cambiarMes(-1)} aria-label="Mes anterior" title="Mes anterior">
                              <i className="pi pi-chevron-left" />
                            </button>
                            <span className="caja-mes__label" aria-live="polite">{monthLabel(mesFiltro)}</span>
                            <button type="button" className="caja-mes__btn" onClick={() => cambiarMes(1)} disabled={esMesActual} aria-label="Mes siguiente" title="Mes siguiente">
                              <i className="pi pi-chevron-right" />
                            </button>
                          </div>
                          <div className="caja-filtro-dropdown">
                            <CascadeDropdown
                              placeholder="Todos los tipos"
                              searchPlaceholder="Buscar"
                              options={[
                                { id: '', nombre: 'Todos los tipos' },
                                { id: 'gasto', nombre: 'Gastos' },
                                { id: 'anticipo', nombre: 'Anticipos' },
                                { id: 'ingreso,reposicion,apertura,vuelto', nombre: 'Ingresos y reposiciones' },
                              ]}
                              valueId={filtros.tipo}
                              getOptionLabel={(o) => o.nombre}
                              onSelect={(o) => setFiltros((prev) => ({ ...prev, tipo: o.id }))}
                            />
                          </div>
                          <div className="caja-filtro-dropdown">
                            <CascadeDropdown
                              placeholder="Todos los estados"
                              searchPlaceholder="Buscar"
                              options={[
                                { id: '', nombre: 'Todos los estados' },
                                { id: 'pendiente', nombre: 'Por aprobar' },
                                { id: 'aprobado', nombre: 'Aprobados' },
                                { id: 'rechazado', nombre: 'Rechazados' },
                              ]}
                              valueId={filtros.estado}
                              getOptionLabel={(o) => o.nombre}
                              onSelect={(o) => setFiltros((prev) => ({ ...prev, estado: o.id }))}
                            />
                          </div>
                        </div>
                        <div className="users-header__right">
                          <span className="users-header__count">Reg. {movimientos.length}</span>
                          <button className="users-circle users-circle--excel" type="button" title={movimientos.length ? 'Exportar Excel' : 'No hay movimientos para exportar'} disabled={!movimientos.length} onClick={exportar}>
                            <i className="pi pi-file-excel" />
                          </button>
                        </div>
                      </div>
                      </>
                    )}
                    className="users-datatable users-datatable--compact"
                    tableStyle={{ width: '100%' }}
                    emptyMessage={loadingMovs ? ' ' : 'No hay movimientos en este período.'}
                    showGridlines
                    size="small"
                    paginator
                    rows={25}
                    rowsPerPageOptions={[10, 25, 50]}
                    removableSort
                    rowClassName={(m) => (m.estado === 'pendiente' ? 'caja-row--pendiente' : m.estado === 'rechazado' ? 'caja-row--rechazado' : '')}
                  >
                    <Column field="fecha" header="Fecha" sortable style={{ minWidth: '100px' }} body={(m) => formatDate(m.fecha)} />
                    <Column
                      field="tipo"
                      header="Tipo"
                      sortable
                      style={{ minWidth: '110px' }}
                      body={(m) => (
                        <>
                          {TIPO_LABELS[m.tipo] || m.tipo_label}
                          {m.de_anticipo && <small className="taller-muted"> (liquidación)</small>}
                        </>
                      )}
                    />
                    <Column
                      field="descripcion"
                      header="Detalle"
                      style={{ minWidth: '240px' }}
                      body={(m) => (
                        <div className="caja-table__detalle">
                          <div>{m.descripcion}</div>
                          <small className="taller-muted">
                            {[m.categoria_nombre, m.beneficiario, `Registró ${m.registrado_por_nombre || '-'}`].filter(Boolean).join(' · ')}
                          </small>
                          {m.estado === 'rechazado' && m.motivo_rechazo && <small className="taller-lineas__error">{`Rechazado: ${m.motivo_rechazo}`}</small>}
                          {m.liquidacion && <small className="taller-muted">{`Liquidado: gastó ${formatMoney(m.liquidacion.gastado)}`}</small>}
                        </div>
                      )}
                    />
                    <Column
                      field="comprobante_numero"
                      header="Comprobante"
                      style={{ minWidth: '140px' }}
                      body={(m) => (
                        <>
                          {m.comprobante_label || '-'} {m.comprobante_numero}
                          {m.tiene_imagen && (
                            <button type="button" className="taller-link" onClick={() => setDialog({ kind: 'imagen', mov: m })}>Ver foto</button>
                          )}
                          {m.tipo === 'gasto' && m.comprobante_tipo && m.comprobante_tipo !== 'sin' && !m.tiene_imagen && (
                            <small className="taller-lineas__error">Sin foto</small>
                          )}
                        </>
                      )}
                    />
                    <Column header="Entrada" style={{ minWidth: '90px' }} body={(m) => <span className="caja-in">{m.es_entrada ? formatMoney(m.monto) : ''}</span>} />
                    <Column header="Salida" style={{ minWidth: '90px' }} body={(m) => <span className="caja-out">{m.es_entrada ? '' : formatMoney(m.monto)}</span>} />
                    <Column field="estado" header="Estado" sortable alignHeader="center" headerClassName="caja-col--centro" bodyClassName="caja-col--centro" style={{ minWidth: '110px' }} body={(m) => <span className={`taller-chip taller-chip--${ESTADO_CHIP[m.estado] || 'cerrada'}`}>{m.estado_label}</span>} />
                    <Column
                      header="Acciones"
                      alignHeader="center"
                      headerClassName="caja-col--centro"
                      bodyClassName="caja-col--centro"
                      style={{ width: '1%', whiteSpace: 'nowrap' }}
                      body={(m) => {
                        const propio = String(m.registrado_por) === String(user?.id)
                        const editable = m.estado !== 'aprobado' && (isAdmin || propio) && !['apertura', 'vuelto'].includes(m.tipo) && !m.de_anticipo
                        const anticipoAbierto = m.tipo === 'anticipo' && m.estado === 'aprobado' && !m.liquidado_en
                        return (
                          <div className="caja-table__actions">
                            {isAdmin && m.estado === 'pendiente' && (
                              <>
                                <button type="button" className="create-user__ghost create-user__ghost--primary" onClick={() => revisar(m, true)} disabled={busy}>Aprobar</button>
                                <button type="button" className="create-user__ghost caja-btn--rechazar" onClick={() => { setMotivo(''); setConfirm({ kind: 'rechazar', mov: m }) }} disabled={busy}>Rechazar</button>
                              </>
                            )}
                            {anticipoAbierto && puedeRegistrar && (
                              <button type="button" className="create-user__ghost caja-btn--liquidar" onClick={() => setDialog({ kind: 'liquidar', mov: m })}>Liquidar</button>
                            )}
                            {editable && (
                              <button type="button" className="create-user__ghost" onClick={() => setDialog({ kind: 'mov', mov: m })}>Corregir</button>
                            )}
                            {isAdmin && !['apertura', 'vuelto'].includes(m.tipo) && !m.de_anticipo && !m.liquidado_en && (
                              <button type="button" className="create-user__locations-remove" aria-label="Eliminar" data-title="Eliminar movimiento" onClick={() => setConfirm({ kind: 'eliminar', mov: m })} disabled={busy}>
                                x
                              </button>
                            )}
                          </div>
                        )
                      }}
                    />
                  </DataTable>
                </div>
              )}

            </>
          )}
        </>
      )}

      <MovimientoDialog
        open={dialog?.kind === 'mov'}
        tipo={dialog?.tipo}
        movimiento={dialog?.mov}
        caja={caja}
        categorias={categorias}
        token={token}
        isAdmin={isAdmin}
        onClose={() => setDialog(null)}
        onDone={(data) => closeDialog(data?.estado === 'pendiente' ? 'Enviado al administrador para aprobación.' : 'Guardado.')}
      />
      <LiquidarDialog
        open={dialog?.kind === 'liquidar'}
        anticipo={dialog?.mov}
        categorias={categorias}
        token={token}
        onClose={() => setDialog(null)}
        onDone={() => closeDialog('Anticipo liquidado.')}
      />
      <ArqueoDialog open={dialog?.kind === 'arqueo'} caja={caja} token={token} onClose={() => setDialog(null)} onDone={() => closeDialog('Arqueo guardado.')} />
      <CajaConfigDialog
        open={dialog?.kind === 'caja'}
        caja={dialog?.caja}
        token={token}
        onClose={() => setDialog(null)}
        onDone={(data) => { if (data?.id) setCajaId(String(data.id)); closeDialog('Caja guardada.') }}
      />
      <CategoriasDialog
        open={dialog?.kind === 'categorias'}
        categorias={categorias}
        token={token}
        onClose={() => setDialog(null)}
        onChanged={loadCajas}
      />
      <ImagenDialog open={dialog?.kind === 'imagen'} movimiento={dialog?.mov} token={token} onClose={() => setDialog(null)} />

      <ConfirmDialog
        open={Boolean(confirm) && isTabActive !== false}
        busy={busy}
        title={
          confirm?.kind === 'reposicion' ? '¿Pedir reposición?'
            : confirm?.kind === 'rechazar' ? '¿Rechazar este movimiento?'
              : '¿Eliminar este movimiento?'
        }
        message={
          confirm?.kind === 'reposicion'
            ? `Se pide ${formatMoney(fondo - saldo)} para que el fondo vuelva a ${formatMoney(fondo)}.${isAdmin ? '' : ' Lo aprueba el administrador.'}`
            : confirm?.kind === 'rechazar'
              ? 'No afecta la caja. Quien lo registró puede corregirlo y volver a enviarlo.'
              : confirm?.mov ? `${confirm.mov.tipo_label} de ${formatMoney(confirm.mov.monto)}: ${confirm.mov.descripcion}` : ''
        }
        confirmLabel={confirm?.kind === 'reposicion' ? 'Pedir' : confirm?.kind === 'rechazar' ? 'Rechazar' : 'Eliminar'}
        details={confirm?.kind === 'rechazar' ? (
          <label className="create-user__field taller-confirm-field">
            <span>Motivo</span>
            <textarea rows={2} value={motivo} onChange={(event) => setMotivo(event.target.value)} />
          </label>
        ) : null}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          let ok = false
          if (confirm?.kind === 'reposicion') ok = await pedirReposicion()
          else if (confirm?.kind === 'rechazar') ok = await revisar(confirm.mov, false, motivo.trim())
          else if (confirm?.kind === 'eliminar') ok = await eliminar(confirm.mov)
          if (ok) setConfirm(null)
        }}
      />
    </div>
    </TallerDialogsOcultos.Provider>
  )
}

export default CajaChicaPage
