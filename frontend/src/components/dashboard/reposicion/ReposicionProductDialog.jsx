import { createPortal } from 'react-dom'
import { getAppPortalRoot } from '../../../utils/portalRoot'
import '../admin/CreateUsuario/CreateUsuario.css'
import ReposicionProductPanel from './ReposicionProductPanel'

// Ventana de detalle (mismo estilo que los demas detalles del sistema).
export default function ReposicionProductDialog({ open, token, row, onClose }) {
  if (!open || !row || typeof document === 'undefined') return null
  return createPortal(
    <div className="create-user__overlay reposicion-dialog__overlay" role="dialog" aria-modal="true">
      <div className="create-user__modal reposicion-dialog">
        <header className="create-user__header">
          <div className="create-user__header-text">
            <h3>{`${row.codigo}: ${row.nombre}`}</h3>
          </div>
          <div className="create-user__header-actions">
            <button type="button" className="create-user__icon-button" onClick={onClose} aria-label="Cerrar">
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="create-user__content">
          <div className="create-user__body reposicion-dialog__body">
            <ReposicionProductPanel token={token} productoId={row.producto_id} initialSucursalId={row.sucursal_id} />
          </div>
        </div>
      </div>
    </div>,
    getAppPortalRoot()
  )
}
