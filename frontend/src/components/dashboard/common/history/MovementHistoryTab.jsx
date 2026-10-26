import { useEffect, useState } from 'react'
import { API_URL, authFetch } from '../../../../utils/api'
import { formatDate, formatDateTime } from '../../../../utils/dateFormat'
import '../../QuickActions/RecordatoriosPopup.css'
import '../reminders/EntityRemindersTab.css'

// Color del punto/etiqueta de cada evento (clases del timeline de traslados).
const eventClassName = (event) => {
  const title = String(event?.titulo || '').toLowerCase()
  if (event?.tipo === 'inconveniente') return 'rejected'
  if (/rechaz|cancel|elimin|faltante/.test(title)) return 'rejected'
  if (/recibid|lleg/.test(title)) return 'arrived'
  if (event?.tipo === 'envio' || /enviad/.test(title)) return 'sent'
  if (event?.tipo === 'estado' || /aceptad|realizad/.test(title)) return 'accepted'
  return 'pending'
}

// Historial de un movimiento (entrada/salida): creacion, ediciones, estados,
// etapas del traslado, envios de una compra local e inconvenientes.
function MovementHistoryTab({ token, movimientoId, isOpen, entityLabel = '', onError }) {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen || !movimientoId || !token) return undefined
    let cancelled = false
    setLoading(true)
    setError('')
    authFetch(`${API_URL}/movimientos/movimiento_inventario/${movimientoId}/historial/`, {}, token)
      .then(async (response) => {
        if (!response.ok) throw new Error('No se pudo cargar el historial.')
        const data = await response.json()
        if (!cancelled) setEvents(Array.isArray(data?.eventos) ? data.eventos : [])
      })
      .catch((fetchError) => {
        if (cancelled) return
        const message = fetchError?.message || 'No se pudo cargar el historial.'
        setError(message)
        onError?.(message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, movimientoId, token, onError])

  return (
    <section className="create-user__section entity-reminders">
      <div className="entity-reminders__head">
        <div>
          <p className="create-user__eyebrow">Historial</p>
          <h4>{entityLabel ? `Historial de ${entityLabel}` : 'Historial'}</h4>
        </div>
      </div>

      <div className="entity-reminders__pane entity-reminders__pane--list entity-reminders__table-wrap">
        {loading && <p className="entity-reminders__empty">Cargando historial...</p>}
        {!loading && error && <p className="entity-reminders__empty">{error}</p>}
        {!loading && !error && !events.length && (
          <p className="entity-reminders__empty">Este registro todavia no tiene historial.</p>
        )}
        {!loading && !error && events.length > 0 && (
          <div className="recordatorios-popup__detail-history">
            <ol className="recordatorios-popup__detail-history-list">
              {events.map((event, index) => {
                const className = eventClassName(event)
                return (
                  <li
                    key={`${event.at}-${index}`}
                    className={`recordatorios-popup__detail-history-item recordatorios-popup__detail-history-item--${className}`}
                  >
                    <span className="recordatorios-popup__detail-history-point" aria-hidden="true" />
                    <div className="recordatorios-popup__detail-history-card">
                      <div className="recordatorios-popup__detail-history-top">
                        <span className={`recordatorios-popup__status recordatorios-popup__status--${className}`}>
                          {event.titulo}
                        </span>
                        <span className="recordatorios-popup__detail-history-time">
                          {event.solo_fecha ? formatDate(event.at) : formatDateTime(event.at)}
                        </span>
                      </div>
                      {!!event.actor && <small>Por {event.actor}</small>}
                      {!!event.detalle && (
                        <p className="recordatorios-popup__detail-history-reason">{event.detalle}</p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          </div>
        )}
      </div>
    </section>
  )
}

export default MovementHistoryTab
