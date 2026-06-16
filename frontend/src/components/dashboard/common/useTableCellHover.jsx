import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function useTableCellHover() {
  const [hover, setHover] = useState(null)
  const timerRef = useRef(null)

  const showHover = useCallback((event, items, label) => {
    if (!items.length) return
    if (timerRef.current) clearTimeout(timerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setHover({ top: rect.bottom + 4, left: rect.left, items, label })
    }, 500)
  }, [])

  const hideHover = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    setHover(null)
  }, [])

  const portal = hover ? createPortal(
    <div
      className="table-cell-hover-card"
      style={{ top: hover.top, left: hover.left }}
    >
      <div className="table-cell-hover-card__title">{hover.label}</div>
      {hover.items.map((item, i) => (
        <div key={i} className="table-cell-hover-card__row">{item}</div>
      ))}
    </div>,
    document.body
  ) : null

  return { showHover, hideHover, portal }
}
