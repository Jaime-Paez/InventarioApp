import { createPortal } from 'react-dom'
import './unsavedChanges.css'

// Confirmacion simple con el mismo estilo que "¿Guardar cambios?".
export default function ConfirmDialog({
  open,
  title = '¿Seguro?',
  message,
  details = null,
  confirmLabel = 'Seguir',
  cancelLabel = 'Cancelar',
  busy = false,
  onConfirm,
  onCancel,
}) {
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div
      className="unsaved-dialog"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel?.() }}
    >
      <div className="unsaved-dialog__card">
        <h4>{title}</h4>
        {message && <p>{message}</p>}
        {details}
        <div className="unsaved-dialog__actions">
          <button type="button" className="unsaved-dialog__btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className="unsaved-dialog__btn unsaved-dialog__btn--save" onClick={onConfirm} disabled={busy}>
            {busy ? 'Enviando...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
