import { useCallback, useEffect, useRef, useState } from 'react'
import './WorkspaceTabs.css'

function WorkspaceTabs({ openTabs = [], activeItem, onSelectTab, onCloseTab }) {
  const listRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragState = useRef({ active: false, startX: 0, scrollLeft: 0, dragged: false })
  const DRAG_THRESHOLD = 6

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
  }, [openTabs, updateScrollControls])

  useEffect(() => {
    const element = listRef.current
    if (!element) return undefined

    const handleResize = () => updateScrollControls()
    const handleScroll = () => updateScrollControls()
    const handleMouseMove = (event) => {
      if (!dragState.current.active) return
      const dx = event.clientX - dragState.current.startX
      if (!dragState.current.dragged && Math.abs(dx) < DRAG_THRESHOLD) return
      if (!dragState.current.dragged) {
        dragState.current.dragged = true
        setIsDragging(true)
      }
      element.scrollLeft = dragState.current.scrollLeft - dx
      event.preventDefault()
    }
    const handleMouseUp = () => {
      if (!dragState.current.active) return
      dragState.current.active = false
      dragState.current.dragged = false
      setIsDragging(false)
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
  }, [updateScrollControls])

  useEffect(() => {
    const element = listRef.current

    if (!element || typeof ResizeObserver === 'undefined') return undefined

    const resizeObserver = new ResizeObserver(() => updateScrollControls())
    resizeObserver.observe(element)

    return () => resizeObserver.disconnect()
  }, [updateScrollControls])

  useEffect(() => {
    const activeTab = listRef.current?.querySelector('.workspace__tab.active')
    activeTab?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [activeItem])

  if (!openTabs.length) return null

  const scrollTabs = (direction) => {
    const element = listRef.current
    if (!element) return

    const tabs = Array.from(element.querySelectorAll('.workspace__tab'))
    if (!tabs.length) return

    const containerRect = element.getBoundingClientRect()
    const THRESHOLD = 4
    let newScrollLeft

    if (direction === 'right') {
      // First tab at least partially outside the right edge
      const target = tabs.find(
        (tab) => tab.getBoundingClientRect().right > containerRect.right - THRESHOLD
      )
      if (!target) return
      newScrollLeft = element.scrollLeft + (target.getBoundingClientRect().left - containerRect.left)
    } else {
      // Last tab at least partially outside the left edge
      const leftHidden = tabs.filter(
        (tab) => tab.getBoundingClientRect().left < containerRect.left + THRESHOLD
      )
      if (!leftHidden.length) return
      const target = leftHidden[leftHidden.length - 1]
      newScrollLeft = element.scrollLeft + (target.getBoundingClientRect().left - containerRect.left)
    }

    element.scrollTo({ left: Math.max(0, newScrollLeft), behavior: 'smooth' })
  }

  const handleWheel = (event) => {
    const element = listRef.current
    if (!element) return
    if (Math.abs(event.deltaX) < Math.abs(event.deltaY)) {
      element.scrollLeft += event.deltaY
      event.preventDefault()
    }
  }

  const handleMouseDown = (event) => {
    if (event.button !== 0) return
    const element = listRef.current
    if (!element) return
    dragState.current = {
      active: true,
      startX: event.clientX,
      scrollLeft: element.scrollLeft,
      dragged: false,
    }
    setIsDragging(false)
  }

  return (
    <section className="workspace__tabs">
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

      <div className="workspace__tablist-wrapper">
        <div
          className={`workspace__tablist${isDragging ? ' is-dragging' : ''}`}
          ref={listRef}
          role="tablist"
          aria-label="Pestañas del panel"
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
        >
          {openTabs.map((tab) => {
            const isActive = tab === activeItem
            return (
              <button
                key={tab}
                type="button"
                className={`workspace__tab ${isActive ? 'active' : ''}`}
                role="tab"
                aria-selected={isActive}
                onClick={() => onSelectTab(tab)}
              >
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
    </section>
  )
}

export default WorkspaceTabs
