import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Acciones de un movimiento de caja chica: como maximo un boton por fila.
// - Una sola accion: se muestra ese boton (la "x" de eliminar, o su nombre).
// - Varias (p. ej. Aprobar, Rechazar, Corregir, Eliminar): un boton "!" que
//   al pasar el mouse (o tocarlo) abre el menu con todas.
// El menu va en un portal para que la tabla (con scroll) no lo recorte.
// `acciones` = [{ key, label, onClick, tone: 'primary'|'danger'|'warn'|'' }]
const CLOSE_DELAY_MS = 180

function CajaAccionesMenu({ acciones, disabled = false }) {
  const [rect, setRect] = useState(null)
  const [pos, setPos] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const closeTimerRef = useRef(null)

  const cancelClose = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => setRect(null), CLOSE_DELAY_MS)
  }
  const open = useCallback(() => {
    cancelClose()
    const node = triggerRef.current
    if (node) setRect(node.getBoundingClientRect())
  }, [])

  useEffect(() => () => cancelClose(), [])

  // Se acomoda debajo del boton, alineado a su derecha; si no cabe abajo, arriba.
  useLayoutEffect(() => {
    if (!rect || !menuRef.current) {
      setPos(null)
      return
    }
    const menu = menuRef.current.getBoundingClientRect()
    const margin = 8
    let top = rect.bottom + 4
    if (top + menu.height > window.innerHeight - margin) top = Math.max(margin, rect.top - menu.height - 4)
    let left = rect.right - menu.width
    left = Math.min(Math.max(margin, left), window.innerWidth - menu.width - margin)
    setPos({ top, left })
  }, [rect])

  useEffect(() => {
    if (!rect) return undefined
    const onDown = (event) => {
      if (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return
      setRect(null)
    }
    const onScroll = (event) => {
      if (menuRef.current?.contains(event.target)) return
      setRect(null)
    }
    const onKey = (event) => { if (event.key === 'Escape') setRect(null) }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('keydown', onKey)
    }
  }, [rect])

  const list = (acciones || []).filter(Boolean)
  if (!list.length) return null

  if (list.length === 1) {
    const [accion] = list
    if (accion.key === 'eliminar') {
      return (
        <button
          type="button"
          className="create-user__locations-remove"
          aria-label="Eliminar"
          data-title="Eliminar movimiento"
          onClick={accion.onClick}
          disabled={disabled}
        >
          x
        </button>
      )
    }
    return (
      <button
        type="button"
        className={`create-user__ghost caja-accion-unica${accion.tone ? ` caja-accion-unica--${accion.tone}` : ''}`}
        onClick={accion.onClick}
        disabled={disabled}
      >
        {accion.label}
      </button>
    )
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`caja-acciones-trigger${rect ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(rect)}
        aria-label={`Acciones: ${list.map((accion) => accion.label).join(', ')}`}
        onPointerEnter={(event) => { if (event.pointerType === 'mouse') open() }}
        onPointerLeave={(event) => { if (event.pointerType === 'mouse') scheduleClose() }}
        onClick={() => (rect ? setRect(null) : open())}
        disabled={disabled}
      >
        !
      </button>
      {rect && createPortal(
        <div
          ref={menuRef}
          className="caja-acciones-menu"
          role="menu"
          style={{
            top: pos?.top ?? rect.bottom + 4,
            left: pos?.left ?? rect.left,
            visibility: pos ? 'visible' : 'hidden',
          }}
          onPointerEnter={cancelClose}
          onPointerLeave={(event) => { if (event.pointerType === 'mouse') scheduleClose() }}
        >
          {list.map((accion) => (
            <button
              key={accion.key}
              type="button"
              role="menuitem"
              className={`caja-acciones-menu__item${accion.tone ? ` caja-acciones-menu__item--${accion.tone}` : ''}`}
              onClick={() => {
                setRect(null)
                accion.onClick()
              }}
              disabled={disabled}
            >
              {accion.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}

export default CajaAccionesMenu
