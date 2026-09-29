import { useCallback, useEffect, useRef, useState } from 'react'
import { Toast } from 'primereact/toast'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../Configuracion/Configuracion.css'
import './SolicitudesWeb.css'
import { API_URL, authFetch } from '../../../../utils/api'
import {
  readRemindersFromStorage,
  writeRemindersToStorage,
  emitRemindersSync,
  reminderCompletedByIds,
  isSolicitudWebReminder,
  buildUserIdSet,
  normalizeId,
} from '../../common/reminders/remindersStorage'

const POLL_MS = 20000
const PAGE_SIZE = 15

function formatFecha(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  const fecha = d.toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const hora = d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })
  return `${fecha} ${hora}`
}

function SolicitudesWeb({ token, user, pendingOpenSolicitudWebId, onPendingOpenSolicitudWebHandled }) {
  const [solicitudes, setSolicitudes] = useState([])
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [seleccionada, setSeleccionada] = useState(null)
  const [savingContacto, setSavingContacto] = useState(false)
  const toast = useRef(null)

  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE))

  const notify = useCallback((severity, summary, detail) => {
    toast.current?.show({ severity, summary, detail, life: 3000 })
  }, [])

  const fetchSolicitudes = useCallback(async (targetPage = page) => {
    if (!token) return
    setLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/contacto-web/solicitudes/?page=${targetPage}&page_size=${PAGE_SIZE}`,
        {},
        token,
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.detail || 'No se pudieron cargar las solicitudes.')
      setSolicitudes(Array.isArray(data.results) ? data.results : [])
      setCount(Number(data.count) || 0)
    } catch (err) {
      notify('warn', 'Aviso', err.message || 'No se pudieron cargar las solicitudes.')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, notify])

  useEffect(() => {
    fetchSolicitudes(page)
    const id = window.setInterval(() => fetchSolicitudes(page), POLL_MS)
    return () => window.clearInterval(id)
  }, [fetchSolicitudes, page])

  const patchSolicitud = async (id, payload) => {
    try {
      const response = await authFetch(
        `${API_URL}/contacto-web/solicitudes/${id}/`,
        { method: 'PATCH', body: JSON.stringify(payload) },
        token,
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.detail || 'No se pudo actualizar la solicitud.')
      setSolicitudes((prev) => prev.map((s) => (s.id === id ? { ...s, ...data } : s)))
      setSeleccionada((prev) => (prev && prev.id === id ? { ...prev, ...data } : prev))
    } catch (err) {
      notify('warn', 'Aviso', err.message || 'No se pudo actualizar la solicitud.')
    }
  }

  // El recordatorio de "Pagina web" en Recordatorios/QuickActions vive en un
  // arreglo aparte (localStorage + snapshot en el backend), no en esta tabla
  // -- por eso abrir la solicitud aqui (o desde el propio recordatorio) tiene
  // que marcarlo visto explicitamente ademas de guardar `leido` en la
  // solicitud, para que desaparezca de pendientes al instante sin importar
  // desde donde se abrio.
  const markSolicitudWebReminderSeen = useCallback(
    (solicitudId) => {
      const normalizedId = normalizeId(solicitudId)
      const userIdSet = buildUserIdSet(user)
      if (!normalizedId || !userIdSet.size) return

      let changed = false
      const next = readRemindersFromStorage().map((reminder) => {
        if (!isSolicitudWebReminder(reminder)) return reminder
        if (normalizeId(reminder?.context?.id) !== normalizedId) return reminder

        const completedBySet = new Set(reminderCompletedByIds(reminder))
        let reminderChanged = false
        userIdSet.forEach((id) => {
          if (!completedBySet.has(id)) {
            completedBySet.add(id)
            reminderChanged = true
          }
        })
        if (!reminderChanged) return reminder
        changed = true
        return { ...reminder, completedBy: Array.from(completedBySet) }
      })

      if (changed) {
        writeRemindersToStorage(next)
        emitRemindersSync()
      }
    },
    [user]
  )

  const abrirSolicitud = (solicitud) => {
    setSeleccionada(solicitud)
    markSolicitudWebReminderSeen(solicitud.id)
    if (!solicitud.leido) patchSolicitud(solicitud.id, { leido: true })
  }

  // El check de "contactado" es de una sola via a proposito: una vez marcado
  // no se puede desmarcar desde aqui (evita que alguien lo revierta sin
  // querer), por eso es un boton de accion en vez de un checkbox editable.
  const handleMarkContacted = async () => {
    if (!seleccionada || seleccionada.contactado || savingContacto) return
    setSavingContacto(true)
    try {
      await patchSolicitud(seleccionada.id, { contactado: true })
    } finally {
      setSavingContacto(false)
    }
  }

  useEffect(() => {
    if (!pendingOpenSolicitudWebId || !token) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const response = await authFetch(
          `${API_URL}/contacto-web/solicitudes/${pendingOpenSolicitudWebId}/`,
          {},
          token,
        )
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.detail || 'No se pudo abrir la solicitud.')
        if (!cancelled) abrirSolicitud(data)
      } catch (err) {
        if (!cancelled) notify('warn', 'Aviso', err.message || 'No se pudo abrir la solicitud.')
      } finally {
        if (!cancelled) onPendingOpenSolicitudWebHandled?.()
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpenSolicitudWebId, token])

  const unreadCount = solicitudes.filter((s) => !s.leido).length

  return (
    <section className="create-user__section configuracion__section solicitudes-web">
      <Toast ref={toast} />
      <div className="create-user__section-header">
        <div>
          <h4>
            Solicitudes del sitio web
            {unreadCount > 0 && <span className="solicitudes-web__badge">{unreadCount}</span>}
          </h4>
          <p className="create-user__hint">
            Formulario de contacto de peugeotjpaez.com. Haz clic en una fila para ver el detalle completo.
          </p>
        </div>
        <button
          type="button"
          className="rounded-icon-btn"
          onClick={() => fetchSolicitudes(page)}
          disabled={loading}
          title="Recargar"
        >
          <i className={`pi ${loading ? 'pi-spin pi-spinner' : 'pi-refresh'}`} />
        </button>
      </div>

      <div className="solicitudes-web__table-wrap">
        <table className="solicitudes-web__table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Nombre</th>
              <th>Celular</th>
              <th>Marca / Modelo</th>
              <th>Detalle</th>
              <th>Contactado</th>
            </tr>
          </thead>
          <tbody>
            {solicitudes.length === 0 && (
              <tr>
                <td colSpan={6} className="solicitudes-web__empty">
                  {loading ? 'Cargando…' : 'Todavía no hay solicitudes.'}
                </td>
              </tr>
            )}
            {solicitudes.map((s) => (
              <tr
                key={s.id}
                className={[
                  'solicitudes-web__row',
                  !s.leido && 'solicitudes-web__row--unread',
                  !s.contactado && 'solicitudes-web__row--not-contacted',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => abrirSolicitud(s)}
              >
                <td>{formatFecha(s.creado_en)}</td>
                <td>{s.nombre}</td>
                <td>{s.celular}</td>
                <td>
                  {s.marca || '-'} {s.modelo}
                  {s.anio ? ` (${s.anio})` : ''}
                </td>
                <td className="solicitudes-web__detalle" title={s.detalle}>
                  {s.detalle}
                </td>
                <td>
                  <i
                    className={`pi ${s.contactado ? 'pi-check-circle' : 'pi-times-circle'}`}
                    style={{ color: s.contactado ? '#22c55e' : '#9ca3af' }}
                    title={s.contactado ? 'Contactado' : 'No contactado'}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {count > 0 && (
        <div className="solicitudes-web__pager">
          <span>
            Página {page} de {totalPages} · {count} solicitud{count === 1 ? '' : 'es'}
          </span>
          <div className="solicitudes-web__pager-actions">
            <button
              type="button"
              className="solicitudes-web__mark-read"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
            >
              ← Anterior
            </button>
            <button
              type="button"
              className="solicitudes-web__mark-read"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
            >
              Siguiente →
            </button>
          </div>
        </div>
      )}

      {seleccionada && (
        <div className="solicitudes-web__modal-overlay" onClick={() => setSeleccionada(null)}>
          <div className="solicitudes-web__modal" onClick={(e) => e.stopPropagation()}>
            <div className="solicitudes-web__modal-header">
              <div className="solicitudes-web__modal-heading">
                <span className="solicitudes-web__modal-eyebrow">Solicitud del sitio web</span>
                <h4>{seleccionada.nombre}</h4>
                <span className="solicitudes-web__modal-date">
                  <i className="pi pi-calendar" /> {formatFecha(seleccionada.creado_en)}
                </span>
              </div>
              <button
                type="button"
                className="solicitudes-web__modal-close"
                onClick={() => setSeleccionada(null)}
                aria-label="Cerrar"
              >
                <i className="pi pi-times" />
              </button>
            </div>

            <div className="solicitudes-web__modal-scroll">
              <div className="solicitudes-web__modal-grid">
                <div className="solicitudes-web__modal-field">
                  <span className="solicitudes-web__modal-label">
                    <i className="pi pi-phone" /> Celular
                  </span>
                  <span className="solicitudes-web__modal-value">{seleccionada.celular || '-'}</span>
                </div>
                <div className="solicitudes-web__modal-field">
                  <span className="solicitudes-web__modal-label">
                    <i className="pi pi-car" /> Marca / Modelo
                  </span>
                  <span className="solicitudes-web__modal-value">
                    {seleccionada.marca || '-'} {seleccionada.modelo}
                  </span>
                </div>
                <div className="solicitudes-web__modal-field">
                  <span className="solicitudes-web__modal-label">Año</span>
                  <span className="solicitudes-web__modal-value">{seleccionada.anio || '-'}</span>
                </div>
                <div className="solicitudes-web__modal-field">
                  <span className="solicitudes-web__modal-label">N° de chasis</span>
                  <span className="solicitudes-web__modal-value">{seleccionada.chasis || '-'}</span>
                </div>
              </div>

              <div className="solicitudes-web__modal-detalle-box">
                <span className="solicitudes-web__modal-label">Solicitud</span>
                <p>{seleccionada.detalle}</p>
              </div>
            </div>

            <div className="solicitudes-web__modal-footer">
              {seleccionada.contactado ? (
                <div className="solicitudes-web__contact-status solicitudes-web__contact-status--done">
                  <i className="pi pi-check-circle" />
                  Contactado
                </div>
              ) : (
                <button
                  type="button"
                  className="solicitudes-web__contact-button"
                  onClick={handleMarkContacted}
                  disabled={savingContacto}
                >
                  {savingContacto ? (
                    <>
                      <i className="pi pi-spinner pi-spin" /> Guardando…
                    </>
                  ) : (
                    <>
                      <i className="pi pi-check" /> Marcar como contactado
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

export default SolicitudesWeb
