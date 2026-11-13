import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import './WorkspaceTabs.css'

// Pestañas estilo navegador: la activa va siempre AL INICIO, con su nombre
// completo y unida al contenido de abajo; las demas se encogen para caber, asi
// que nunca hay flechas ni pestañas escondidas. El nombre cortado se ve
// completo al pasar el mouse (data-title, sin tooltip nativo). Las que no
// estan seleccionadas se pueden arrastrar para ordenarlas.
const DRAG_THRESHOLD_PX = 5

function WorkspaceTabs({ openTabs = [], activeItem, onSelectTab, onCloseTab, onReorderTabs }) {
  const listRef = useRef(null)
  // Orden provisional mientras se arrastra (solo las no seleccionadas).
  const [dragOrder, setDragOrder] = useState(null)
  const [draggingTab, setDraggingTab] = useState(null)
  const dragRef = useRef(null)
  const justDraggedRef = useRef(false)

  const inactiveTabs = openTabs.filter((tab) => tab !== activeItem)

  // La pestaña arrastrada sigue al mouse: su posicion de layout cambia al
  // reordenarse, asi que el desplazamiento se recalcula tras cada render.
  const placeDragged = () => {
    const drag = dragRef.current
    const list = listRef.current
    if (!drag?.started || !list) return
    const el = list.querySelector(`[data-tab-key="${CSS.escape(drag.tab)}"]`)
    if (!el) return
    const layoutLeft = list.getBoundingClientRect().left + el.offsetLeft - list.scrollLeft
    el.style.transform = `translateX(${drag.lastX - drag.grabOffset - layoutLeft}px)`
  }
  useLayoutEffect(placeDragged, [dragOrder])

  const handlePointerDown = (event, tab) => {
    if (event.button !== 0 || tab === activeItem || !onReorderTabs) return
    if (event.target.closest('.workspace__tab-close')) return
    const rect = event.currentTarget.getBoundingClientRect()
    dragRef.current = { tab, startX: event.clientX, lastX: event.clientX, grabOffset: event.clientX - rect.left, started: false, order: inactiveTabs }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handlePointerMove = (event) => {
    const drag = dragRef.current
    const list = listRef.current
    if (!drag || !list) return
    drag.lastX = event.clientX
    if (!drag.started) {
      if (Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) return
      drag.started = true
      setDraggingTab(drag.tab)
      setDragOrder(drag.order)
    }
    // Nuevo lugar: cuantas de las otras pestañas quedan con su centro a la
    // izquierda del mouse.
    const others = drag.order.filter((tab) => tab !== drag.tab)
    let index = 0
    others.forEach((tab) => {
      const el = list.querySelector(`[data-tab-key="${CSS.escape(tab)}"]`)
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (event.clientX > rect.left + rect.width / 2) index += 1
    })
    const next = [...others.slice(0, index), drag.tab, ...others.slice(index)]
    if (next.join('|') !== drag.order.join('|')) {
      drag.order = next
      setDragOrder(next)
    } else {
      placeDragged()
    }
  }

  const endDrag = (commit) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag?.started) return
    const el = listRef.current?.querySelector(`[data-tab-key="${CSS.escape(drag.tab)}"]`)
    if (el) el.style.transform = ''
    justDraggedRef.current = true
    window.setTimeout(() => { justDraggedRef.current = false }, 0)
    setDraggingTab(null)
    setDragOrder(null)
    if (commit) onReorderTabs?.(drag.order)
  }

  // Al cambiar de pestaña, la fila vuelve al inicio (ahi esta la activa).
  useEffect(() => {
    if (listRef.current) listRef.current.scrollLeft = 0
  }, [activeItem])

  // Seguro: los contenedores de la pagina no se desplazan de lado nunca (tienen
  // overflow oculto, pero el navegador igual puede moverlos al enfocar algo).
  useEffect(() => {
    const PAGE_CONTAINERS = '#root, .app-shell, .dashboard-shell, .workspace'
    const handleScroll = (event) => {
      const target = event.target
      if (target instanceof Element && target.scrollLeft && target.matches(PAGE_CONTAINERS)) {
        target.scrollLeft = 0
      }
    }
    document.addEventListener('scroll', handleScroll, true)
    return () => document.removeEventListener('scroll', handleScroll, true)
  }, [])

  if (!openTabs.length) return null

  const rest = dragOrder || inactiveTabs
  const ordered = openTabs.includes(activeItem) ? [activeItem, ...rest] : rest

  return (
    <section className="workspace__tabs">
      <div className="workspace__tablist-wrapper">
        <div className="workspace__tablist" ref={listRef} role="tablist" aria-label="Pestañas del panel">
          {ordered.map((tab) => {
            const isActive = tab === activeItem
            return (
              <button
                key={tab}
                type="button"
                data-tab-key={tab}
                className={`workspace__tab${isActive ? ' active' : ''}${draggingTab === tab ? ' is-dragging' : ''}`}
                role="tab"
                aria-selected={isActive}
                data-title={isActive ? undefined : tab}
                onClick={() => {
                  if (justDraggedRef.current) return
                  onSelectTab(tab)
                }}
                onPointerDown={(event) => handlePointerDown(event, tab)}
                onPointerMove={handlePointerMove}
                onPointerUp={() => endDrag(true)}
                onPointerCancel={() => endDrag(false)}
                onAuxClick={(event) => {
                  // Clic con la rueda cierra, como en el navegador.
                  if (event.button === 1) {
                    event.preventDefault()
                    onCloseTab(tab)
                  }
                }}
              >
                <span className="workspace__tab-dot" aria-hidden="true" />
                <span className="workspace__tab-label">{tab}</span>
                <span
                  role="button"
                  aria-label={`Cerrar ${tab}`}
                  className="workspace__tab-close"
                  onClick={(event) => {
                    event.stopPropagation()
                    onCloseTab(tab)
                  }}
                >
                  ×
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

export default WorkspaceTabs
