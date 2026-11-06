import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Toast from '../common/AppToast'
import BlockerNotice from '../common/BlockerNotice'
import CascadeDropdown from '../common/CascadeDropdown'
import ConfirmDialog from '../common/unsavedChanges/ConfirmDialog'
import '../admin/UsersTable/UsersTable.css'
import '../admin/CreateUsuario/CreateUsuario.css'
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
import { ESTADO_CHIP, TIPO_LABELS, formatMoney, monthStartIso, parseApiError, todayIso } from './cajaChicaUtils'

function CajaChicaPage({ token, user, moduleActions, isTabActive }) {
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
  const [tab, setTab] = useState('movimientos')
  const [filtros, setFiltros] = useState({ desde: monthStartIso(), hasta: todayIso(), tipo: '', estado: '', search: '' })
  const [arqueos, setArqueos] = useState([])
  const [resumen, setResumen] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [motivo, setMotivo] = useState('')
  const [busy, setBusy] = useState(false)

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
      const list = Array.isArray(data) ? data : data?.results || []
      setCajas(list)
      if (catResp.ok) {
        const cats = await catResp.json()
        setCategorias(Array.isArray(cats) ? cats : cats?.results || [])
      }
      setCajaId((prev) => {
        if (list.some((c) => String(c.id) === String(prev))) return String(prev)
        const first = list.find((c) => c.activa) || list[0]
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

  const loadExtras = useCallback(async () => {
    if (!cajaId) return
    try {
      if (tab === 'arqueos') {
        const response = await authFetch(`${API_URL}/caja-chica/cajas/${cajaId}/arqueos/`, {}, token)
        if (response.ok) setArqueos(await response.json())
      }
      if (tab === 'resumen') {
        const params = new URLSearchParams({ desde: filtros.desde || monthStartIso(), hasta: filtros.hasta || todayIso() })
        const response = await authFetch(`${API_URL}/caja-chica/cajas/${cajaId}/resumen/?${params}`, {}, token)
        if (response.ok) setResumen(await response.json())
      }
    } catch {
      // se reintenta al cambiar de pestana
    }
  }, [cajaId, filtros.desde, filtros.hasta, tab, token])

  useEffect(() => { loadCajas() }, [loadCajas])
  useEffect(() => { if (isTabActive) loadCajas() }, [isTabActive, loadCajas])
  useEffect(() => {
    const timer = setTimeout(loadMovimientos, 250)
    return () => clearTimeout(timer)
  }, [loadMovimientos])
  useEffect(() => { loadExtras() }, [loadExtras])

  const refreshAll = () => {
    loadCajas()
    loadMovimientos()
    loadExtras()
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

  // ---------------------------------------------------------------- render

  if (loadingCajas && !cajas.length) {
    return <div className="caja-page"><span className="taller-muted"><i className="pi pi-spin pi-spinner" /> Cargando caja chica...</span></div>
  }

  const saldo = Number(caja?.saldo || 0)
  const fondo = Number(caja?.monto_fondo || 0)
  const porcentaje = fondo > 0 ? Math.max(0, Math.min(100, (saldo / fondo) * 100)) : 0
  const bajo = caja && porcentaje < Number(caja.alerta_reposicion || 0)
  const esCustodio = caja && String(caja.custodio) === String(user?.id)
  const configurada = Boolean(caja?.configurada)
  const puedeRegistrar = Boolean(caja?.activa && configurada && canCreate && (isAdmin || esCustodio))

  return (
    <div className="caja-page">
      <Toast ref={toast} />

      {error && <BlockerNotice title="No se pudo cargar la caja chica" reason={error} actionLabel="Reintentar" onAction={loadCajas} />}

      {!cajas.length && !error && !isAdmin && (
        <BlockerNotice
          title="No tienes una caja chica asignada"
          reason="Cada sucursal tiene su caja: pide al administrador que te ponga como custodio de la caja de tu sucursal."
        />
      )}

      {cajas.length > 0 && (
        <>
          <div className="caja-top">
            <div className="caja-selector" role="tablist" aria-label="Cajas">
              {cajas.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`caja-selector__btn${String(c.id) === String(cajaId) ? ' is-active' : ''}${c.activa ? '' : ' is-inactive'}`}
                  onClick={() => setCajaId(String(c.id))}
                >
                  {c.taller ? `Taller ${c.taller_nombre}` : c.sucursal_nombre || c.nombre}
                  {c.pendientes > 0 && isAdmin && <span className="taller-toggle__count">{c.pendientes}</span>}
                </button>
              ))}
            </div>
            {isAdmin && (
              <div className="caja-top__admin">
                {caja && <button type="button" className="taller-mini-btn" onClick={() => setDialog({ kind: 'caja', caja })}><i className="pi pi-cog" /> Configurar</button>}
                <button type="button" className="taller-mini-btn" onClick={() => setDialog({ kind: 'categorias' })}><i className="pi pi-tags" /> Categorías</button>
              </div>
            )}
          </div>

          {caja && !configurada && (
            isAdmin ? (
              <BlockerNotice
                title={`Configura la caja chica de ${caja.taller ? `Taller ${caja.taller_nombre}` : caja.sucursal_nombre}`}
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
              <div className="caja-cards">
                <div className="caja-card caja-card--saldo">
                  <span>En caja (según el sistema)</span>
                  <strong>{formatMoney(saldo)}</strong>
                  <div className="caja-meter" aria-label={`${Math.round(porcentaje)}% del fondo`}>
                    <div className={`caja-meter__fill${bajo ? ' is-low' : ''}`} style={{ width: `${porcentaje}%` }} />
                  </div>
                  <small>{`${Math.round(porcentaje)}% de un fondo de ${formatMoney(fondo)}`}</small>
                </div>
                <div className="caja-card">
                  <span>Gastado en el período</span>
                  <strong>{formatMoney(totalesPeriodo.salidas)}</strong>
                  <small>{`Entró ${formatMoney(totalesPeriodo.entradas)}`}</small>
                </div>
                <div className="caja-card">
                  <span>Por aprobar</span>
                  <strong>{caja.pendientes}</strong>
                  <small>{`Tope sin aprobación: ${formatMoney(caja.tope_gasto)}`}</small>
                </div>
                <div className="caja-card">
                  <span>Anticipos sin liquidar</span>
                  <strong>{caja.anticipos_abiertos}</strong>
                  <small>{caja.custodio_nombre ? `Custodio: ${caja.custodio_nombre}` : 'Sin custodio'}</small>
                </div>
                <div className="caja-card">
                  <span>Último arqueo</span>
                  <strong className={caja.ultimo_arqueo && Number(caja.ultimo_arqueo.diferencia) !== 0 ? 'is-warn' : ''}>
                    {caja.ultimo_arqueo ? (Number(caja.ultimo_arqueo.diferencia) === 0 ? 'Cuadró' : formatMoney(caja.ultimo_arqueo.diferencia)) : '-'}
                  </strong>
                  <small>{caja.ultimo_arqueo ? formatDateTime(caja.ultimo_arqueo.fecha) : 'Nunca'}</small>
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

              {puedeRegistrar && (
                <div className="caja-actions">
                  <button type="button" className="create-user__action create-user__action--primary" onClick={() => setDialog({ kind: 'mov', tipo: 'gasto' })}>
                    <i className="pi pi-minus-circle" /> Registrar gasto
                  </button>
                  <button type="button" className="create-user__action create-user__action--secondary" onClick={() => setDialog({ kind: 'mov', tipo: 'anticipo' })}>
                    <i className="pi pi-send" /> Anticipo / vale
                  </button>
                  <button type="button" className="create-user__action create-user__action--secondary" onClick={() => setDialog({ kind: 'mov', tipo: 'ingreso' })}>
                    <i className="pi pi-plus-circle" /> Ingreso
                  </button>
                  <button type="button" className="create-user__action create-user__action--secondary" onClick={() => setDialog({ kind: 'arqueo' })}>
                    <i className="pi pi-calculator" /> Arqueo
                  </button>
                  <button type="button" className="create-user__action create-user__action--secondary" onClick={() => setConfirm({ kind: 'reposicion' })} disabled={busy || saldo >= fondo}>
                    <i className="pi pi-refresh" /> Pedir reposición
                  </button>
                </div>
              )}

              <div className="create-user__tabs" role="tablist">
                {[
                  ['movimientos', 'Movimientos'],
                  ['resumen', 'Resumen por categoría'],
                  ['arqueos', 'Arqueos'],
                ].map(([key, label]) => (
                  <button key={key} type="button" className={`create-user__tab${tab === key ? ' create-user__tab--active' : ''}`} onClick={() => setTab(key)}>
                    {label}
                  </button>
                ))}
              </div>

              {tab !== 'arqueos' && (
                <div className="caja-filtros">
                  <label>Desde <input className="taller-input" type="date" value={filtros.desde} onChange={(event) => setFiltros((prev) => ({ ...prev, desde: event.target.value }))} /></label>
                  <label>Hasta <input className="taller-input" type="date" value={filtros.hasta} onChange={(event) => setFiltros((prev) => ({ ...prev, hasta: event.target.value }))} /></label>
                  {tab === 'movimientos' && (
                    <>
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
                      <div className="search-input-container">
                        <input className="search-input" placeholder="Buscar descripción, beneficiario, comprobante" value={filtros.search} onChange={(event) => setFiltros((prev) => ({ ...prev, search: event.target.value }))} />
                        <i className={`pi ${loadingMovs ? 'pi-spinner pi-spin' : 'pi-search'} search-input-icon`} />
                      </div>
                      <button className="users-circle users-circle--excel" type="button" title="Exportar a Excel" disabled={!movimientos.length} onClick={exportar}>
                        <i className="pi pi-file-excel" />
                      </button>
                    </>
                  )}
                </div>
              )}

              {tab === 'movimientos' && (
                <div className="taller-lineas__wrap caja-table">
                  <table className="taller-lineas">
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Tipo</th>
                        <th>Detalle</th>
                        <th>Comprobante</th>
                        <th>Entrada</th>
                        <th>Salida</th>
                        <th>Estado</th>
                        <th aria-label="Acciones" />
                      </tr>
                    </thead>
                    <tbody>
                      {!movimientos.length && (
                        <tr><td colSpan={8} className="taller-lineas__empty">{loadingMovs ? 'Cargando...' : 'No hay movimientos en este período.'}</td></tr>
                      )}
                      {movimientos.map((m) => {
                        const propio = String(m.registrado_por) === String(user?.id)
                        const editable = m.estado !== 'aprobado' && (isAdmin || propio) && !['apertura', 'vuelto'].includes(m.tipo) && !m.de_anticipo
                        const anticipoAbierto = m.tipo === 'anticipo' && m.estado === 'aprobado' && !m.liquidado_en
                        return (
                          <tr key={m.id} className={m.estado === 'pendiente' ? 'is-pending' : m.estado === 'rechazado' ? 'is-inactive' : ''}>
                            <td>{formatDate(m.fecha)}</td>
                            <td>
                              {TIPO_LABELS[m.tipo] || m.tipo_label}
                              {m.de_anticipo && <small className="taller-muted"> (liquidación)</small>}
                            </td>
                            <td className="caja-table__detalle">
                              <div>{m.descripcion}</div>
                              <small className="taller-muted">
                                {[m.categoria_nombre, m.beneficiario, `Registró ${m.registrado_por_nombre || '-'}`].filter(Boolean).join(' · ')}
                              </small>
                              {m.estado === 'rechazado' && m.motivo_rechazo && <small className="taller-lineas__error">{`Rechazado: ${m.motivo_rechazo}`}</small>}
                              {m.liquidacion && (
                                <small className="taller-muted">{`Liquidado: gastó ${formatMoney(m.liquidacion.gastado)}`}</small>
                              )}
                            </td>
                            <td>
                              {m.comprobante_label || '-'} {m.comprobante_numero}
                              {m.tiene_imagen && (
                                <button type="button" className="taller-link" onClick={() => setDialog({ kind: 'imagen', mov: m })}>Ver foto</button>
                              )}
                              {m.tipo === 'gasto' && m.comprobante_tipo && m.comprobante_tipo !== 'sin' && !m.tiene_imagen && (
                                <small className="taller-lineas__error">Sin foto</small>
                              )}
                            </td>
                            <td className="taller-lineas__money caja-in">{m.es_entrada ? formatMoney(m.monto) : ''}</td>
                            <td className="taller-lineas__money caja-out">{m.es_entrada ? '' : formatMoney(m.monto)}</td>
                            <td><span className={`taller-chip taller-chip--${ESTADO_CHIP[m.estado] || 'cerrada'}`}>{m.estado_label}</span></td>
                            <td className="caja-table__actions">
                              {isAdmin && m.estado === 'pendiente' && (
                                <>
                                  <button type="button" className="taller-mini-btn taller-mini-btn--ok" onClick={() => revisar(m, true)} disabled={busy}>Aprobar</button>
                                  <button type="button" className="taller-mini-btn taller-mini-btn--no" onClick={() => { setMotivo(''); setConfirm({ kind: 'rechazar', mov: m }) }} disabled={busy}>Rechazar</button>
                                </>
                              )}
                              {anticipoAbierto && puedeRegistrar && (
                                <button type="button" className="taller-mini-btn taller-mini-btn--warn" onClick={() => setDialog({ kind: 'liquidar', mov: m })}>Liquidar</button>
                              )}
                              {editable && (
                                <button type="button" className="taller-mini-btn" onClick={() => setDialog({ kind: 'mov', mov: m })}>Corregir</button>
                              )}
                              {(editable || (isAdmin && !['apertura', 'vuelto'].includes(m.tipo) && !m.de_anticipo && !m.liquidado_en)) && (
                                <button type="button" className="taller-icon-btn taller-icon-btn--no" title="Eliminar" onClick={() => setConfirm({ kind: 'eliminar', mov: m })} disabled={busy}>
                                  <i className="pi pi-trash" />
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {tab === 'resumen' && (
                <div className="caja-resumen">
                  {!resumen ? (
                    <span className="taller-muted"><i className="pi pi-spin pi-spinner" /> Cargando...</span>
                  ) : (
                    <>
                      <div className="caja-cards">
                        <div className="caja-card"><span>Gastos aprobados</span><strong>{formatMoney(resumen.total_gastos)}</strong></div>
                        <div className="caja-card"><span>Ingresos</span><strong>{formatMoney(resumen.ingresos)}</strong></div>
                        <div className="caja-card"><span>Sin comprobante</span><strong className={resumen.sin_comprobante ? 'is-warn' : ''}>{resumen.sin_comprobante}</strong></div>
                        <div className="caja-card"><span>Con comprobante sin foto</span><strong className={resumen.sin_foto ? 'is-warn' : ''}>{resumen.sin_foto}</strong></div>
                      </div>
                      {!resumen.por_categoria.length ? (
                        <p className="taller-muted">No hay gastos aprobados en este período.</p>
                      ) : (
                        <div className="caja-bars">
                          {resumen.por_categoria.map((row) => {
                            const pct = Number(resumen.total_gastos) > 0 ? (Number(row.total) / Number(resumen.total_gastos)) * 100 : 0
                            return (
                              <div key={row.categoria} className="caja-bar">
                                <span className="caja-bar__label">{row.categoria}</span>
                                <div className="caja-bar__track"><div className="caja-bar__fill" style={{ width: `${pct}%` }} /></div>
                                <span className="caja-bar__value">{`${formatMoney(row.total)} · ${row.cantidad}`}</span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {tab === 'arqueos' && (
                <div className="taller-lineas__wrap caja-table">
                  <table className="taller-lineas">
                    <thead>
                      <tr><th>Fecha</th><th>Contado</th><th>Sistema</th><th>Diferencia</th><th>Observación</th><th>Realizado por</th></tr>
                    </thead>
                    <tbody>
                      {!arqueos.length && <tr><td colSpan={6} className="taller-lineas__empty">Todavía no hay arqueos.</td></tr>}
                      {arqueos.map((a) => (
                        <tr key={a.id}>
                          <td>{formatDateTime(a.creado_en)}</td>
                          <td className="taller-lineas__money">{formatMoney(a.total_contado)}</td>
                          <td className="taller-lineas__money">{formatMoney(a.saldo_sistema)}</td>
                          <td className={`taller-lineas__money ${Number(a.diferencia) === 0 ? 'caja-in' : 'caja-out'}`}>
                            {Number(a.diferencia) === 0 ? 'Cuadra' : formatMoney(a.diferencia)}
                          </td>
                          <td>{a.observacion || '-'}</td>
                          <td>{a.realizado_por_nombre}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
        open={Boolean(confirm)}
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
  )
}

export default CajaChicaPage
