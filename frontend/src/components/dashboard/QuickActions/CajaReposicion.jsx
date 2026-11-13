import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Wallet } from 'lucide-react'
import { API_URL, authFetch } from '../../../utils/api'
import './CajaReposicion.css'

// Aviso de caja chica en las acciones rapidas (como "Envios en camino"):
// solo al administrador: cuando una caja bajo del % de alerta (y no se pidio
// la reposicion) o cuando hay una reposicion pedida esperando su aprobacion.
// Al tocar una caja se abre Caja chica con esa caja elegida.
const POLL_MS = 30000

const money = (value) => {
  const number = Number(value)
  return Number.isFinite(number)
    ? number.toLocaleString('es-EC', { style: 'currency', currency: 'USD' })
    : '$0.00'
}

const nombreCaja = (caja) => {
  if (caja?.taller) {
    const taller = String(caja.taller_nombre || '').trim()
    return /^taller(\s|$)/i.test(taller) ? taller : `Taller ${taller}`
  }
  return caja?.sucursal_nombre || caja?.nombre || 'Caja'
}

const buildAlerts = (cajas, isAdmin) => {
  return (Array.isArray(cajas) ? cajas : [])
    .filter((caja) => caja?.activa && caja?.configurada)
    .map((caja) => {
      const saldo = Number(caja?.saldo || 0)
      const fondo = Number(caja?.monto_fondo || 0)
      const porcentaje = fondo > 0 ? Math.max(0, Math.min(100, (saldo / fondo) * 100)) : 100
      const umbral = Number(caja?.alerta_reposicion || 0)
      if (caja?.reposicion_pendiente != null) {
        if (!isAdmin) return null
        return {
          caja,
          tipo: 'aprobar',
          titulo: nombreCaja(caja),
          detalle: `Reposición pedida de ${money(caja.reposicion_pendiente)}: apruébala para entregar el dinero.`,
        }
      }
      // Solo el administrador (es quien repone la caja).
      if (porcentaje < umbral && isAdmin) {
        return {
          caja,
          tipo: 'pedir',
          titulo: nombreCaja(caja),
          detalle: `Quedan ${money(saldo)} de ${money(fondo)} (${Math.round(porcentaje)}%): pide la reposición de ${money(fondo - saldo)}.`,
        }
      }
      return null
    })
    .filter(Boolean)
}

function CajaReposicion({ token, isAdmin, darkMode, onOpenCaja }) {
  const [alerts, setAlerts] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const inFlightRef = useRef(false)

  const load = useCallback(async ({ silent = true } = {}) => {
    if (!token || inFlightRef.current) return
    inFlightRef.current = true
    if (!silent) setLoading(true)
    try {
      const response = await authFetch(`${API_URL}/caja-chica/cajas/`, {}, token)
      // Sin acceso a caja chica (403) no hay aviso.
      if (!response.ok) {
        setAlerts([])
        return
      }
      const data = await response.json().catch(() => [])
      setAlerts(buildAlerts(Array.isArray(data) ? data : data?.results || [], isAdmin))
    } catch {
      // Sin conexion: se reintenta en el siguiente ciclo.
    } finally {
      inFlightRef.current = false
      if (!silent) setLoading(false)
    }
  }, [isAdmin, token])

  useEffect(() => {
    if (!token || !isAdmin) {
      setAlerts([])
      return undefined
    }
    void load()
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load()
    }, POLL_MS)
    const onFocus = () => { void load() }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', onFocus)
    }
  }, [isAdmin, load, token])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!alerts.length) return null

  const porAprobar = alerts.some((alert) => alert.tipo === 'aprobar')

  return (
    <div
      ref={rootRef}
      className={`quick-actions__pending-shipments caja-reposicion${open ? ' is-open' : ''}${darkMode ? ' is-dark' : ''}`}
    >
      <button
        type="button"
        className="quick-actions__pending-shipments-trigger caja-reposicion__trigger"
        onClick={() => {
          setOpen((prev) => !prev)
          if (!open) void load({ silent: false })
        }}
        aria-label={porAprobar ? 'Reposiciones de caja chica por aprobar' : 'Caja chica por reponer'}
        data-title={porAprobar ? 'Reposición por aprobar' : 'Reponer caja chica'}
      >
        <Wallet className="quick-actions__pending-shipments-icon" aria-hidden="true" />
        <span className="quick-actions__pending-shipments-label">
          {porAprobar ? 'Reposición por aprobar' : 'Reponer caja chica'}
        </span>
        <span className="quick-actions__pending-shipments-count">{alerts.length}</span>
      </button>

      {open && (
        <div className="quick-actions__pending-shipments-panel caja-reposicion__panel" role="dialog" aria-label="Caja chica por reponer">
          <div className="quick-actions__pending-shipments-head">
            <strong>Caja chica por reponer</strong>
            <button
              type="button"
              className="quick-actions__pending-shipments-refresh"
              onClick={() => void load({ silent: false })}
              disabled={loading}
              aria-label="Actualizar cajas"
            >
              <i className="pi pi-refresh" aria-hidden="true" />
            </button>
          </div>
          <div className="quick-actions__pending-shipments-list">
            {loading ? (
              <p className="quick-actions__pending-shipments-empty quick-actions__pending-shipments-loading" role="status">
                <Loader2 size={14} />
                <span>Cargando cajas...</span>
              </p>
            ) : alerts.map((alert) => (
              <button
                key={`caja-reposicion-${alert.caja.id}`}
                type="button"
                className={`quick-actions__pending-shipments-item caja-reposicion__item caja-reposicion__item--${alert.tipo}`}
                onClick={() => {
                  setOpen(false)
                  onOpenCaja?.(alert.caja.id)
                }}
              >
                <span className="quick-actions__pending-shipments-item-title">{alert.titulo}</span>
                <span className="quick-actions__pending-shipments-item-meta">{alert.detalle}</span>
                <span className="caja-reposicion__accion">
                  {alert.tipo === 'aprobar' ? 'Abrir para aprobar' : 'Abrir para pedir reposición'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default CajaReposicion
