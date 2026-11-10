import { useContext, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import '../admin/CreateUsuario/CreateUsuario.css'
import { getAppPortalRoot } from '../../../utils/portalRoot'
import useModalAnimation from '../common/useModalAnimation'
import useResizableModal from '../common/useResizableModal'
import { TallerDialogsOcultos } from './tallerDialogContext'

// Ventana del taller y de caja chica con el mismo formato que el resto de la
// app (crear cliente, crear usuario...): barra con titulo, maximizar y cerrar,
// se arrastra y cambia de tamano, pestana, seccion y pie con los botones.
// Va por encima de la ventana de la orden cuando se abre desde ella.
function TallerDialog({
  open,
  title,
  subtitle,
  eyebrow = 'General',
  tab = 'General',
  children,
  footer,
  onClose,
  busy = false,
  wide = false,
}) {
  const oculto = useContext(TallerDialogsOcultos)
  const { shouldRender, isClosing } = useModalAnimation(open)
  const modal = useResizableModal(open, {
    initialSize: wide ? { width: 1000, height: 640 } : { width: 680, height: 420 },
    minSize: { width: 420, height: 320 },
  })
  // El alto se ajusta al contenido (como las demas ventanas cortas del
  // sistema) hasta que el usuario la agranda o la maximiza.
  const [resized, setResized] = useState(false)
  useEffect(() => { if (open) setResized(false) }, [open])
  if (!shouldRender || typeof document === 'undefined') return null
  const style = resized || modal.maximized
    ? modal.style
    : { ...modal.style, height: 'auto', maxHeight: 'calc(100dvh - 24px)' }
  const resizeHandleProps = {
    onMouseDown: (event) => {
      setResized(true)
      modal.resizeHandleProps.onMouseDown(event)
    },
  }

  const close = () => {
    if (!busy) onClose?.()
  }

  return createPortal(
    <div
      className={`create-user__overlay taller-dialog-overlay${isClosing ? ' create-user__overlay--closing' : ''}`}
      role="dialog"
      aria-modal="true"
      style={oculto ? { display: 'none' } : undefined}
      aria-hidden={oculto || undefined}
    >
      <div className={`create-user__modal taller-dialog-modal${isClosing ? ' create-user__modal--closing' : ''}`} style={style}>
        <header className="create-user__header" {...modal.headerProps}>
          <div className="create-user__header-text">
            <h3>{title}</h3>
          </div>
          <div className="create-user__header-actions">
            <button
              type="button"
              className="create-user__icon-button create-user__icon-button--maximize"
              onClick={modal.toggleMaximize}
              aria-label={modal.maximized ? 'Restaurar' : 'Maximizar'}
            >
              <i className={modal.maximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
            </button>
            <button type="button" className="create-user__icon-button" onClick={close} disabled={busy} aria-label="Cerrar">
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="create-user__form">
          {/* tab={null}: sin la pestana; subtitle={null}: sin el titulo de la seccion. */}
          {tab !== null && (
            <div className="create-user__tabs" role="tablist">
              <button type="button" className="create-user__tab create-user__tab--active" disabled>
                {tab}
              </button>
            </div>
          )}

          <div className="create-user__body">
            <section className="create-user__section taller-dialog-section">
              {subtitle !== null && (
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">{eyebrow}</p>
                    <h4>{subtitle || title}</h4>
                  </div>
                </div>
              )}
              {children}
            </section>
          </div>

          {footer && <div className="create-user__footer taller-dialog-footer">{footer}</div>}
        </div>

        <div className="create-user__resize-handle" {...resizeHandleProps} aria-hidden="true" />
      </div>
    </div>,
    getAppPortalRoot()
  )
}

export default TallerDialog
