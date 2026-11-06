import { useCallback, useEffect, useRef, useState } from 'react'

// Firma en pantalla (dedo, lapiz o mouse). Devuelve la imagen PNG como data
// URL con onChange, o null si se borra. Fondo blanco siempre: es "papel".
function SignaturePad({ onChange, height = 170, disabled = false }) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const drawingRef = useRef(false)
  const lastRef = useRef(null)
  const [empty, setEmpty] = useState(true)

  const prepare = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ratio = Math.max(1, window.devicePixelRatio || 1)
    const width = wrap.clientWidth
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const ctx = canvas.getContext('2d')
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#0f172a'
    ctx.lineWidth = 2.2
  }, [height])

  useEffect(() => {
    prepare()
  }, [prepare])

  const point = (event) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const handleDown = (event) => {
    if (disabled) return
    event.preventDefault()
    canvasRef.current.setPointerCapture?.(event.pointerId)
    drawingRef.current = true
    lastRef.current = point(event)
    const ctx = canvasRef.current.getContext('2d')
    ctx.beginPath()
    ctx.arc(lastRef.current.x, lastRef.current.y, 1, 0, Math.PI * 2)
    ctx.fillStyle = '#0f172a'
    ctx.fill()
  }

  const handleMove = (event) => {
    if (!drawingRef.current) return
    event.preventDefault()
    const next = point(event)
    const ctx = canvasRef.current.getContext('2d')
    ctx.beginPath()
    ctx.moveTo(lastRef.current.x, lastRef.current.y)
    ctx.lineTo(next.x, next.y)
    ctx.stroke()
    lastRef.current = next
  }

  const handleUp = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    setEmpty(false)
    onChange?.(canvasRef.current.toDataURL('image/png'))
  }

  const clear = () => {
    prepare()
    setEmpty(true)
    onChange?.(null)
  }

  return (
    <div className="taller-signature">
      <div className="taller-signature__pad" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onPointerLeave={handleUp}
          onPointerCancel={handleUp}
          aria-label="Área de firma"
        />
        {empty && <span className="taller-signature__hint">Firme aquí</span>}
      </div>
      <button type="button" className="taller-link" onClick={clear} disabled={disabled || empty}>
        Borrar firma
      </button>
    </div>
  )
}

export default SignaturePad
