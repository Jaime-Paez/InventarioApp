import { useCallback, useEffect, useRef, useState } from 'react'
import { Toast } from 'primereact/toast'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../Configuracion/Configuracion.css'
import './SolicitudesWeb.css'
import { API_URL, authFetch } from '../../../../utils/api'

const POLL_MS = 20000

function formatFecha(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  const fecha = d.toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const hora = d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })
  return `${fecha} ${hora}`
}

function SolicitudesWeb({ token, onUnreadChange }) {
  const [solicitudes, setSolicitudes] = useState([])
  const [loading, setLoading] = useState(false)
  const toast = useRef(null)

  const notify = useCallback((severity, summary, detail) => {
    toast.current?.show({ severity, summary, detail, life: 3000 })
  }, [])

  const fetchSolicitudes = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const response = await authFetch(`${API_URL}/contacto-web/solicitudes/?page_size=100`, {}, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.detail || 'No se pudieron cargar las solicitudes.')
      const results = Array.isArray(data.results) ? data.results : []
      setSolicitudes(results)
      onUnreadChange?.(results.filter((s) => !s.leido).length)
    } catch (err) {
      notify('warn', 'Aviso', err.message || 'No se pudieron cargar las solicitudes.')
    } finally {
      setLoading(false)
    }
  }, [token, notify, onUnreadChange])

  useEffect(() => {
    fetchSolicitudes()
    const id = window.setInterval(fetchSolicitudes, POLL_MS)
    return () => window.clearInterval(id)
  }, [fetchSolicitudes])

  const marcarLeida = async (id) => {
    setSolicitudes((prev) => prev.map((s) => (s.id === id ? { ...s, leido: true } : s)))
    try {
      const response = await authFetch(
        `${API_URL}/contacto-web/solicitudes/${id}/`,
        { method: 'PATCH', body: JSON.stringify({ leido: true }) },
        token,
      )
      if (!response.ok) throw new Error('No se pudo marcar como leída.')
      onUnreadChange?.((prevCount) => Math.max(0, (prevCount ?? 1) - 1))
    } catch (err) {
      notify('warn', 'Aviso', err.message || 'No se pudo marcar como leída.')
      fetchSolicitudes()
    }
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
            Formulario de contacto de peugeotjpaez.com. Se guardan aquí aunque el correo de aviso falle.
          </p>
        </div>
        <button
          type="button"
          className="rounded-icon-btn"
          onClick={fetchSolicitudes}
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
              <th></th>
            </tr>
          </thead>
          <tbody>
            {solicitudes.length === 0 && (
              <tr>
                <td colSpan={7} className="solicitudes-web__empty">
                  {loading ? 'Cargando…' : 'Todavía no hay solicitudes.'}
                </td>
              </tr>
            )}
            {solicitudes.map((s) => (
              <tr key={s.id} className={s.leido ? undefined : 'solicitudes-web__row--unread'}>
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
                  {!s.leido && (
                    <button type="button" className="solicitudes-web__mark-read" onClick={() => marcarLeida(s.id)}>
                      Marcar leída
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default SolicitudesWeb
