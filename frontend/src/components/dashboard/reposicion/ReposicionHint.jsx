import React from 'react'
import { createPortal } from 'react-dom'

// Burbuja de ayuda flotante (en un portal, para que la tabla con scroll no la
// recorte). `hint` = { rect, title, body, reason } o null.
const WIDTH = 300

function ReposicionHint({ hint }) {
  if (!hint) return null
  const { rect } = hint
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - WIDTH / 2),
    window.innerWidth - WIDTH - 8
  )
  const below = rect.bottom + 180 < window.innerHeight
  const style = below
    ? { left, top: rect.bottom + 8, width: WIDTH }
    : { left, bottom: window.innerHeight - rect.top + 8, width: WIDTH }
  return createPortal(
    <div className="reposicion__hint" role="tooltip" style={style}>
      {hint.title && <strong>{hint.title}</strong>}
      {hint.body && <p>{hint.body}</p>}
      {hint.reason && (
        <p className="reposicion__hint-reason">
          <span>¿Por qué?</span>
          {hint.reason}
        </p>
      )}
    </div>,
    document.body
  )
}

export default ReposicionHint
