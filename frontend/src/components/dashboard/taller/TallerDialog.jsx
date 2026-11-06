import { createPortal } from 'react-dom'

// Ventana secundaria del taller (despacho, devolucion, garantia...). Va por
// encima de la ventana de la orden.
function TallerDialog({ open, title, subtitle, children, footer, onClose, busy = false, wide = false }) {
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div
      className="taller-dialog"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose?.() }}
    >
      <div className={`taller-dialog__card${wide ? ' taller-dialog__card--wide' : ''}`}>
        <header className="taller-dialog__header">
          <div>
            <h4>{title}</h4>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="create-user__icon-button" onClick={onClose} disabled={busy} aria-label="Cerrar">
            <i className="pi pi-times" aria-hidden="true" />
          </button>
        </header>
        <div className="taller-dialog__body">{children}</div>
        {footer && <footer className="taller-dialog__footer">{footer}</footer>}
      </div>
    </div>,
    document.body
  )
}

export default TallerDialog
