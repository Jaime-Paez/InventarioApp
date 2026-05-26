import { useState } from 'react'
import { createPortal } from 'react-dom'
import useModalAnimation from '../../common/useModalAnimation'
import { API_URL, authFetch } from '../../../../utils/api'

const VIEWPORT_PADDING = 12

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
      style={{
        padding: `${VIEWPORT_PADDING}px`,
        background: 'rgba(15, 23, 42, 0.28)',
        backdropFilter: 'blur(1px)',
        zIndex: 10030,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: 'var(--modal-color, #fff)',
          border: '1px solid var(--color-border)',
          borderRadius: 10,
          boxShadow: 'var(--shadow-panel)',
          width: 440,
          maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          pointerEvents: 'auto',
          color: 'var(--color-text-primary)',
          animation: isClosing
            ? 'create-user-modal-out 180ms ease both'
            : 'create-user-modal-in 180ms ease both',
        }}
      >
        <header className="create-user__header" style={{ cursor: 'default', borderBottom: '1px solid var(--color-border)' }}>
          <div className="create-user__header-text" style={{ cursor: 'default' }}>
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

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p className="create-user__eyebrow" style={{ margin: 0 }}>Solicitudes</p>
          <p style={{ margin: 0, fontWeight: 600, fontSize: '0.95rem' }}>
            {productoNombre || 'Producto seleccionado'}
          </p>
          <p style={{ margin: '0', color: 'var(--color-text-secondary)', fontSize: '0.9rem' }}>
            ¿Deseas archivar este producto? Quedará guardado como no deseado.
          </p>
          {error && (
            <p style={{ margin: 0, color: 'var(--color-error, #e53e3e)', fontSize: '0.875rem' }}>
              {error}
            </p>
          )}
        </div>

        <div className="create-user__footer">
          <div className="user-details__footer-left">
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={onClose}
              disabled={loading}
            >
              Cancelar
            </button>
          </div>
          <div className="user-details__footer-right">
            <button
              type="button"
              className="create-user__action create-user__action--primary"
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
