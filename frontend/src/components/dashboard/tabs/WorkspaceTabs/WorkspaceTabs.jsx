import { useCallback, useEffect, useRef, useState } from 'react'
import './WorkspaceTabs.css'

function WorkspaceTabs({ openTabs = [], activeItem, onSelectTab, onCloseTab }) {
  const listRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [isScrollDragging, setIsScrollDragging] = useState(false)
  const scrollDragState = useRef({ active: false, startX: 0, scrollLeft: 0, dragged: false })
  const SCROLL_DRAG_THRESHOLD = 6

  // Local tab order — synced with openTabs when tabs are added/removed
  const [tabOrder, setTabOrder] = useState(openTabs)
  useEffect(() => {
    setTabOrder((prev) => {
      const prevSet = new Set(prev)
      const nextSet = new Set(openTabs)
      const filtered = prev.filter((t) => nextSet.has(t))
      const added = openTabs.filter((t) => !prevSet.has(t))
      return [...filtered, ...added]
    })
  }, [openTabs])

  // Tab reorder drag
  const [draggingTabIndex, setDraggingTabIndex] = useState(-1)
  const [dropIndex, setDropIndex] = useState(-1)
  const dropIndexRef = useRef(-1)
  const tabDragState = useRef({ active: false, dragging: false, tabIndex: -1, startX: 0, startY: 0 })
  const tabDragHoldTimerRef = useRef(null)
  const tabWasDraggedRef = useRef(false)
  const tabSlotWidthRef = useRef(110) // measured on drag start
  const TAB_DRAG_HOLD_MS = 180

  // Ghost element — position updated via direct DOM to avoid per-pixel re-renders
  const [ghostInfo, setGhostInfo] = useState(null) // { top, initLeft, width, height, label }
  const ghostRef = useRef(null)
  const ghostOffsetX = useRef(0)

  const updateScrollControls = useCallback(() => {
    const element = listRef.current
    if (!element) return
    const { scrollLeft, clientWidth, scrollWidth } = element
    const overflow = scrollWidth > clientWidth + 1
    setHasOverflow(overflow)
    setCanScrollLeft(overflow && scrollLeft > 0)
    setCanScrollRight(overflow && scrollLeft + clientWidth < scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateScrollControls()
  }, [tabOrder, updateScrollControls])

  useEffect(() => () => {
    if (tabDragHoldTimerRef.current) {
      clearTimeout(tabDragHoldTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const element = listRef.current
    if (!element) return undefined

    const handleResize = () => updateScrollControls()
    const handleScroll = () => updateScrollControls()

    const handleMouseMove = (event) => {
      // Tab reorder drag takes priority over scroll drag
      if (tabDragState.current.active) {
        const dx = event.clientX - tabDragState.current.startX
        const dy = event.clientY - tabDragState.current.startY

        if (!tabDragState.current.dragging && Math.hypot(dx, dy) < 5) return

        if (!tabDragState.current.dragging) {
          // Drag threshold exceeded — start the drag
          tabDragState.current.dragging = true
          const tabs = Array.from(element.querySelectorAll('.workspace__tab'))
          const sourceTab = tabs[tabDragState.current.tabIndex]
          if (sourceTab) {
            const rect = sourceTab.getBoundingClientRect()
            // Measure real slot width (tab width + gap)
            const nextTab = tabs[tabDragState.current.tabIndex + 1]
            tabSlotWidthRef.current = nextTab
              ? nextTab.getBoundingClientRect().left - rect.left
              : rect.width + 10
            ghostOffsetX.current = tabDragState.current.startX - rect.left
            setGhostInfo({
              initLeft: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              label: tabDragState.current.label,
            })
          }
          setDraggingTabIndex(tabDragState.current.tabIndex)
          dropIndexRef.current = tabDragState.current.tabIndex
          setDropIndex(tabDragState.current.tabIndex)
        }

        // Move ghost via direct DOM for performance
        if (ghostRef.current) {
          ghostRef.current.style.left = `${event.clientX - ghostOffsetX.current}px`
        }

        // Determine drop index by ghost center relative to tab midpoints
        const ghostCenter = event.clientX - ghostOffsetX.current + tabSlotWidthRef.current / 2
        const tabs = Array.from(element.querySelectorAll('.workspace__tab'))
        let over = tabs.length - 1
        for (let i = 0; i < tabs.length; i++) {
          const rect = tabs[i].getBoundingClientRect()
          if (ghostCenter < rect.left + rect.width / 2) {
            over = i
            break
          }
        }
        if (over !== dropIndexRef.current) {
          dropIndexRef.current = over
          setDropIndex(over)
        }
        return
      }

      // Scroll drag (background)
      if (!scrollDragState.current.active) return
      const dx = event.clientX - scrollDragState.current.startX
      if (!scrollDragState.current.dragged && Math.abs(dx) < SCROLL_DRAG_THRESHOLD) return
      if (!scrollDragState.current.dragged) {
        scrollDragState.current.dragged = true
        setIsScrollDragging(true)
      }
      element.scrollLeft = scrollDragState.current.scrollLeft - dx
      event.preventDefault()
    }

    const handleMouseUp = () => {
      if (tabDragHoldTimerRef.current) {
        clearTimeout(tabDragHoldTimerRef.current)
        tabDragHoldTimerRef.current = null
      }

      if (tabDragState.current.active) {
        const wasDragging = tabDragState.current.dragging
        if (wasDragging) {
          const from = tabDragState.current.tabIndex
          const to = dropIndexRef.current >= 0 ? dropIndexRef.current : from
          if (from !== to) {
            setTabOrder((prev) => {
              const next = [...prev]
              const [moved] = next.splice(from, 1)
              next.splice(to, 0, moved)
              return next
            })
          }
          tabWasDraggedRef.current = true
          setTimeout(() => { tabWasDraggedRef.current = false }, 0)
        }
        tabDragState.current = { active: false, dragging: false, tabIndex: -1, startX: 0, startY: 0 }
        dropIndexRef.current = -1
        setDraggingTabIndex(-1)
        setDropIndex(-1)
        setGhostInfo(null)
        return
      }

      if (!scrollDragState.current.active) return
      scrollDragState.current.active = false
      scrollDragState.current.dragged = false
      setIsScrollDragging(false)
    }

    window.addEventListener('resize', handleResize)
    element.addEventListener('scroll', handleScroll)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('resize', handleResize)
      element.removeEventListener('scroll', handleScroll)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [updateScrollControls, openTabs.length])

  useEffect(() => {
    const element = listRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const resizeObserver = new ResizeObserver(() => updateScrollControls())
    resizeObserver.observe(element)
    return () => resizeObserver.disconnect()
  }, [updateScrollControls, openTabs.length])

  useEffect(() => {
    const activeTab = listRef.current?.querySelector('.workspace__tab.active')
    activeTab?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [activeItem])

  if (!openTabs.length) return null

  const scrollTabs = (direction) => {
    const element = listRef.current
    if (!element) return
    // Antes cada clic solo alineaba la siguiente pestaña parcialmente oculta
    // al borde, es decir "revelaba una pestaña mas" por clic -- con varias
    // pestañas ocultas hacian falta 2 o mas clics para llegar al final, y el
    // primer clic dejaba la ultima pestaña todavia sin verse completa (daba
    // la sensacion de que la flecha "no llegaba al final"). Ahora cada clic
    // avanza casi una pantalla completa (con un poco de superposicion para
    // dar contexto), y como scrollTo recorta el valor al rango valido del
    // elemento, un clic que se pasa del limite simplemente llega justo al
    // final/inicio real en vez de quedarse corto.
    const OVERLAP = 32
    const maxScrollLeft = element.scrollWidth - element.clientWidth
    const delta = Math.max(element.clientWidth - OVERLAP, element.clientWidth / 2)
    const rawTarget = direction === 'right'
      ? element.scrollLeft + delta
      : element.scrollLeft - delta
    const newScrollLeft = Math.min(Math.max(0, rawTarget), Math.max(0, maxScrollLeft))
    element.scrollTo({ left: newScrollLeft, behavior: 'smooth' })
  }

  const handleWheel = (event) => {
    const element = listRef.current
    if (!element) return
    if (Math.abs(event.deltaX) < Math.abs(event.deltaY)) {
      element.scrollLeft += event.deltaY
      event.preventDefault()
    }
  }

  const handleListMouseDown = (event) => {
    if (event.button !== 0) return
    if (event.target.closest('.workspace__tab')) return
    const element = listRef.current
    if (!element) return
    scrollDragState.current = { active: true, startX: event.clientX, scrollLeft: element.scrollLeft, dragged: false }
    setIsScrollDragging(false)
  }

  const handleTabMouseDown = (event, index, label) => {
    if (event.button !== 0) return
    event.stopPropagation()
    const startX = event.clientX
    const startY = event.clientY

    if (tabDragHoldTimerRef.current) {
      clearTimeout(tabDragHoldTimerRef.current)
    }

    tabDragState.current = { active: false, dragging: false, tabIndex: index, startX, startY, label }
    tabDragHoldTimerRef.current = setTimeout(() => {
      tabDragState.current = {
        ...tabDragState.current,
        active: true,
        startX,
        startY,
      }
      tabDragHoldTimerRef.current = null
    }, TAB_DRAG_HOLD_MS)
  }

  const isDraggingAny = draggingTabIndex >= 0
  const slotWidth = tabSlotWidthRef.current

  // Calculate translateX for each tab to create the sliding-gap effect
  const getTabTranslate = (index) => {
    if (!isDraggingAny || index === draggingTabIndex) return 0
    const from = draggingTabIndex
    const to = dropIndex
    if (from < to && index > from && index <= to) return -slotWidth
    if (from > to && index >= to && index < from) return slotWidth
    return 0
  }

  return (
    <section className={`workspace__tabs${isDraggingAny ? ' is-tab-dragging' : ''}`}>
      {hasOverflow && (
        <button
          type="button"
          className="workspace__tab-control"
          aria-label="Ver pestañas anteriores"
          onClick={() => scrollTabs('left')}
          disabled={!canScrollLeft}
        >
          ‹
        </button>
      )}

      <div
        className={`workspace__tablist-wrapper${canScrollLeft ? ' fade-left' : ''}${canScrollRight ? ' fade-right' : ''}`}
      >
        <div
          className={`workspace__tablist${isScrollDragging ? ' is-dragging' : ''}`}
          ref={listRef}
          role="tablist"
          aria-label="Pestañas del panel"
          onWheel={handleWheel}
          onMouseDown={handleListMouseDown}
        >
          {tabOrder.map((tab, index) => {
            const isActive = tab === activeItem
            const isSource = index === draggingTabIndex
            const translate = getTabTranslate(index)

            return (
              <button
                key={tab}
                type="button"
                draggable={false}
                className={[
                  'workspace__tab',
                  isActive ? 'active' : '',
                  isSource ? 'is-tab-source' : '',
                ].filter(Boolean).join(' ')}
                style={
                  isDraggingAny
                    ? { transform: `translateX(${translate}px)`, transition: isSource ? 'none' : 'transform 0.15s ease' }
                    : undefined
                }
                role="tab"
                aria-selected={isActive}
                onMouseDown={(e) => handleTabMouseDown(e, index, tab)}
                onClick={() => {
                  if (tabWasDraggedRef.current) return
                  onSelectTab(tab)
                }}
              >
                <span className="workspace__tab-label">{tab}</span>
                <span
                  role="button"
                  aria-label={`Cerrar ${tab}`}
                  className="workspace__tab-close"
                  onMouseDown={(event) => {
                    event.stopPropagation()
                  }}
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

      {hasOverflow && (
        <button
          type="button"
          className="workspace__tab-control"
          aria-label="Ver más pestañas"
          onClick={() => scrollTabs('right')}
          disabled={!canScrollRight}
        >
          ›
        </button>
      )}

      {/* Ghost tab — follows the cursor exactly like a browser tab */}
      {ghostInfo && (
        <div
          ref={ghostRef}
          className={`workspace__tab workspace__tab-ghost${activeItem === ghostInfo.label ? ' active' : ''}`}
          style={{
            position: 'fixed',
            left: `${ghostInfo.initLeft}px`,
            top: `${ghostInfo.top}px`,
            width: `${ghostInfo.width}px`,
            height: `${ghostInfo.height}px`,
            pointerEvents: 'none',
            zIndex: 9999,
          }}
          aria-hidden="true"
        >
          <span className="workspace__tab-label">{ghostInfo.label}</span>
          <span className="workspace__tab-close">×</span>
        </div>
      )}
    </section>
  )
}

export default WorkspaceTabs
