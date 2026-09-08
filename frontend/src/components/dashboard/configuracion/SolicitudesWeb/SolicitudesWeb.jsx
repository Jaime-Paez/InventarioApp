import { useCallback, useEffect, useRef, useState } from 'react'
import { Toast } from 'primereact/toast'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../Configuracion/Configuracion.css'
import './SolicitudesWeb.css'
import { API_URL, authFetch } from '../../../../utils/api'

const POLL_MS = 20000
const PAGE_SIZE = 15

function formatFecha(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  const fecha = d.toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const hora = d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })
  return `${fecha} ${hora}`
}

function SolicitudesWeb({ token }) {
  const [solicitudes, setSolicitudes] = useState([])
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [seleccionada, setSeleccionada] = useState(null)
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

  const abrirSolicitud = (solicitud) => {
    setSeleccionada(solicitud)
    if (!solicitud.leido) patchSolicitud(solicitud.id, { leido: true })
  }

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
            Formulario de contacto de peugeotjpaez.com. Se guardan aquí aunque el correo de aviso falle. Haz clic en
            una fila para ver el detalle completo.
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
              <th>Correo</th>
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
                className={s.leido ? 'solicitudes-web__row' : 'solicitudes-web__row solicitudes-web__row--unread'}
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
                    className={`pi ${s.correo_enviado ? 'pi-check-circle' : 'pi-times-circle'}`}
                    style={{ color: s.correo_enviado ? '#22c55e' : '#9ca3af' }}
                    title={s.correo_enviado ? 'Correo enviado' : 'Correo no enviado'}
                  />
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
              <h4>{seleccionada.nombre}</h4>
              <button
                type="button"
                className="solicitudes-web__modal-close"
                onClick={() => setSeleccionada(null)}
                aria-label="Cerrar"
              >
                <i className="pi pi-times" />
              </button>
            </div>

            <dl className="solicitudes-web__modal-body">
              <dt>Fecha</dt>
              <dd>{formatFecha(seleccionada.creado_en)}</dd>

              <dt>Celular</dt>
              <dd>{seleccionada.celular}</dd>

              <dt>Marca</dt>
              <dd>{seleccionada.marca || '-'}</dd>

              <dt>Modelo</dt>
              <dd>{seleccionada.modelo}</dd>

              <dt>Año</dt>
              <dd>{seleccionada.anio || '-'}</dd>

              <dt>N° de chasis</dt>
              <dd>{seleccionada.chasis || '-'}</dd>

              <dt>Solicitud</dt>
              <dd className="solicitudes-web__modal-detalle">{seleccionada.detalle}</dd>

              <dt>Correo de aviso</dt>
              <dd>{seleccionada.correo_enviado ? 'Enviado' : 'No se pudo enviar'}</dd>
            </dl>

            <label className="solicitudes-web__modal-checkbox">
              <input
                type="checkbox"
                checked={Boolean(seleccionada.contactado)}
                onChange={(e) => patchSolicitud(seleccionada.id, { contactado: e.target.checked })}
              />
              <span>¿Contactaste al interesado?</span>
            </label>
          </div>
        </div>
      )}
    </section>
  )
}

export default SolicitudesWeb
