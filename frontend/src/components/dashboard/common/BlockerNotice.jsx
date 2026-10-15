import React, { useState } from 'react'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { goToSection } from '../../../utils/navigation'
import './BlockerNotice.css'

// Aviso de "no se puede hacer esto": que pasa, por que y como resolverlo.
// Se usa en todo el sistema cuando una accion se bloquea por falta de datos
// (sin revisores, sin ubicaciones, sin destinatarios, sin productos...).
// `compact` = version de una linea para dentro de desplegables.
// `goTo` = seccion del menu donde se arregla (p. ej. 'Administrar'): agrega
// un boton "Ir a …" que abre esa pestana.
function BlockerNotice({ title, reason, actionLabel, onAction, goTo, goToLabel, compact = false, className = '' }) {
  const [noAccess, setNoAccess] = useState(false)
  return (
    <div className={`blocker-notice${compact ? ' blocker-notice--compact' : ''}${className ? ` ${className}` : ''}`} role="alert">
      <AlertTriangle size={compact ? 14 : 18} aria-hidden="true" />
      <div>
        {title && <strong>{title}</strong>}
        {reason && <p>{reason}</p>}
        {((actionLabel && onAction) || goTo) && (
          <div className="blocker-notice__actions">
            {actionLabel && onAction && (
              <button type="button" className="blocker-notice__action" onClick={onAction}>
                {actionLabel}
                <ArrowRight size={13} aria-hidden="true" />
              </button>
            )}
            {goTo && (
              <button type="button" className="blocker-notice__action" onClick={() => setNoAccess(!goToSection(goTo))}>
                {goToLabel || `Ir a ${goTo}`}
                <ArrowRight size={13} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {noAccess && (
          <p className="blocker-notice__no-access">
            {`No tienes acceso a ${goTo}: pídele a un administrador que lo resuelva.`}
          </p>
        )}
      </div>
    </div>
  )
}

export default BlockerNotice
