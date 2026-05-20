import { useState } from 'react'
import { createPortal } from 'react-dom'
import useModalAnimation from '../../common/useModalAnimation'
import { API_URL, authFetch } from '../../../../utils/api'

function ArchivarProductoModal({ open, solicitudId, productoNombre, token, onArchivado, onClose }) {
  const { shouldRender, isClosing } = useModalAnimation(open)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleArchivar = async () => {
    if (!solicitudId || !token) return
    setLoading(true)
    setError('')
    try {
      const res = await authFetch(
        `${API_URL}/solicitudes/solicitudes/${solicitudId}/archivar/`,
        { method: 'POST' },
        token
      )
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(payload?.detail || 'No se pudo archivar el producto.')
      }
      const data = await res.json().catch(() => ({}))
      onArchivado?.(data)
    } catch (err) {
      setError(err?.message || 'Ocurrió un error al archivar.')
    } finally {
      setLoading(false)
    }
  }

  if (!shouldRender) return null

  const modal = (
    <div
      className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`}
      role="dialog"
      aria-modal="true"
      style={{ padding: 12 }}
    >
      <div
        className={`create-user__modal${isClosing ? ' create-user__modal--closing' : ''}`}
        style={{ width: 440, height: 'auto', minHeight: 0, maxWidth: 'calc(100vw - 24px)', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
      >
        <header className="create-user__header">
          <div className="create-user__header-text">
            <h3>Archivar producto</h3>
          </div>
          <div className="create-user__header-actions">
            <button
              type="button"
              className="create-user__icon-button"
              onClick={onClose}
              disabled={loading}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ margin: 0 }}>
            ¿Deseas archivar el producto <strong>{productoNombre || 'seleccionado'}</strong>? Quedará guardado como no deseado.
          </p>

          {error && (
            <p style={{ margin: 0, color: 'var(--color-error, #e53e3e)', fontSize: '0.875rem' }}>
              {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={onClose}
              disabled={loading}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="create-user__action"
              onClick={handleArchivar}
              disabled={loading}
            >
              {loading ? 'Archivando...' : 'Archivar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal
}

export default ArchivarProductoModal
