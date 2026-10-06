import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import '../common/unsavedChanges/unsavedChanges.css'
import './ReceiveCompleteDialog.css'

const CONFETTI_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6']

// Confeti en un canvas (sin librerias): una rafaga desde arriba de ~3 s.
function ConfettiCanvas() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    if (reduceMotion) return undefined
    const context = canvas.getContext('2d')
    if (!context) return undefined

    const ratio = window.devicePixelRatio || 1
    const resize = () => {
      canvas.width = window.innerWidth * ratio
      canvas.height = window.innerHeight * ratio
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const width = window.innerWidth
    const pieces = Array.from({ length: 170 }, () => ({
      x: width / 2 + (Math.random() - 0.5) * width * 0.5,
      y: -20 - Math.random() * 120,
      vx: (Math.random() - 0.5) * 9,
      vy: 1 + Math.random() * 3,
      size: 6 + Math.random() * 6,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.3,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    }))

    const start = performance.now()
    let last = start
    let frame = 0
    const draw = (now) => {
      const elapsed = now - start
      // Movimiento por tiempo (no por cuadro): igual en pantallas de 60 o 144 Hz.
      const step = Math.min(3, Math.max(0, (now - last) / (1000 / 60)))
      last = now
      context.clearRect(0, 0, canvas.width, canvas.height)
      const fade = elapsed > 2600 ? Math.max(0, 1 - (elapsed - 2600) / 900) : 1
      pieces.forEach((piece) => {
        piece.vy += 0.06 * step
        piece.vx *= 0.99 ** step
        piece.x += piece.vx * step
        piece.y += piece.vy * step
        piece.rotation += piece.spin * step
        context.save()
        context.globalAlpha = fade
        context.translate(piece.x, piece.y)
        context.rotate(piece.rotation)
        context.fillStyle = piece.color
        context.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2)
        context.restore()
      })
      if (elapsed < 3500) frame = window.requestAnimationFrame(draw)
      else context.clearRect(0, 0, canvas.width, canvas.height)
    }
    frame = window.requestAnimationFrame(draw)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} className="receive-complete__confetti" aria-hidden="true" />
}

// "Este traslado esta completo": al recibir todos los productos. "Listo"
// confirma la recepcion y cierra todo.
export default function ReceiveCompleteDialog({
  open,
  title = '¡Este traslado está completo!',
  productCount = 0,
  unitCount = 0,
  missingUnits = 0,
  missingProducts = 0,
  busy = false,
  error = '',
  onDone,
  onBack,
}) {
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div className="unsaved-dialog receive-complete" role="dialog" aria-modal="true" aria-label={title}>
      <ConfettiCanvas />
      <div className="unsaved-dialog__card receive-complete__card">
        <div className="receive-complete__icon" aria-hidden="true">✓</div>
        <h4>{title}</h4>
        <p>{`Recibiste los ${productCount} producto(s) (${unitCount} unidades). Todo ya está en el inventario.`}</p>
        {missingUnits > 0 && (
          <p className="receive-complete__missing">
            {`Faltaron ${missingUnits} unidad(es) en ${missingProducts} producto(s); quedan registradas como faltante.`}
          </p>
        )}
        {error && <p className="unsaved-dialog__error">{error}</p>}
        <div className="unsaved-dialog__actions receive-complete__actions">
          {error && onBack && (
            <button type="button" className="unsaved-dialog__btn" onClick={onBack} disabled={busy}>
              Volver
            </button>
          )}
          <button
            type="button"
            className="unsaved-dialog__btn unsaved-dialog__btn--save receive-complete__done"
            onClick={onDone}
            disabled={busy}
            autoFocus
          >
            {busy ? 'Guardando...' : 'Listo'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
