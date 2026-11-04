import { useCallback, useEffect, useRef, useState } from 'react'

const PADDING = 12

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

// Ventana que se mueve arrastrando el encabezado, cambia de tamano desde la
// esquina (create-user__resize-handle) y se maximiza, como las demas del app.
// `open`: al abrirse se centra con `initialSize` (limitado a la pantalla).
export default function useResizableModal(open, { initialSize = { width: 1000, height: 780 }, minSize = { width: 520, height: 360 } } = {}) {
  const [size, setSize] = useState(initialSize)
  const [position, setPosition] = useState({ x: PADDING, y: PADDING })
  const [maximized, setMaximized] = useState(false)
  const restoreRef = useRef(null)
  const dragRef = useRef(null)

  const available = () => ({
    width: Math.max(320, window.innerWidth - PADDING * 2),
    height: Math.max(280, window.innerHeight - PADDING * 2),
  })

  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    const max = available()
    const width = Math.min(initialSize.width, max.width)
    const height = Math.min(initialSize.height, max.height)
    setSize({ width, height })
    setPosition({ x: Math.max(PADDING, (window.innerWidth - width) / 2), y: Math.max(PADDING, (window.innerHeight - height) / 2) })
    setMaximized(false)
    // Solo al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Si la pantalla cambia, la ventana se acomoda dentro.
  useEffect(() => {
    if (!open) return undefined
    const onResize = () => {
      const max = available()
      if (maximized) {
        setSize(max)
        setPosition({ x: PADDING, y: PADDING })
        return
      }
      setSize((prev) => ({ width: Math.min(prev.width, max.width), height: Math.min(prev.height, max.height) }))
      setPosition((prev) => ({
        x: clamp(prev.x, PADDING, Math.max(PADDING, window.innerWidth - PADDING - 320)),
        y: clamp(prev.y, PADDING, Math.max(PADDING, window.innerHeight - PADDING - 200)),
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, maximized])

  const startPointer = useCallback((event, mode) => {
    if (event.button !== 0) return
    if (mode === 'move' && (maximized || event.target?.closest?.('button, input, a, .create-user__resize-handle'))) return
    if (mode === 'resize' && maximized) return
    event.preventDefault()
    dragRef.current = { mode, startX: event.clientX, startY: event.clientY, size, position }
    const onMove = (moveEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = moveEvent.clientX - drag.startX
      const dy = moveEvent.clientY - drag.startY
      if (drag.mode === 'move') {
        setPosition({
          x: clamp(drag.position.x + dx, PADDING, Math.max(PADDING, window.innerWidth - drag.size.width - PADDING)),
          y: clamp(drag.position.y + dy, PADDING, Math.max(PADDING, window.innerHeight - drag.size.height - PADDING)),
        })
      } else {
        setSize({
          width: clamp(drag.size.width + dx, minSize.width, Math.max(minSize.width, window.innerWidth - drag.position.x - PADDING)),
          height: clamp(drag.size.height + dy, minSize.height, Math.max(minSize.height, window.innerHeight - drag.position.y - PADDING)),
        })
      }
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [maximized, minSize.height, minSize.width, position, size])

  const toggleMaximize = useCallback(() => {
    if (maximized) {
      const restore = restoreRef.current
      if (restore) {
        setSize(restore.size)
        setPosition(restore.position)
      }
      setMaximized(false)
      return
    }
    restoreRef.current = { size, position }
    setSize(available())
    setPosition({ x: PADDING, y: PADDING })
    setMaximized(true)
  }, [maximized, position, size])

  return {
    style: { width: size.width, height: size.height, left: position.x, top: position.y },
    maximized,
    toggleMaximize,
    headerProps: { onMouseDown: (event) => startPointer(event, 'move'), onDoubleClick: toggleMaximize },
    resizeHandleProps: { onMouseDown: (event) => startPointer(event, 'resize') },
  }
}
