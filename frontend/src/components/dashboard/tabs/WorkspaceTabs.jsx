import { useCallback, useEffect, useRef, useState } from 'react'
import './workspaceTabs.css'

function WorkspaceTabs({ openTabs = [], activeItem, onSelectTab, onCloseTab }) {
  const listRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [hasOverflow, setHasOverflow] = useState(false)

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

    window.addEventListener('resize', handleResize)
    element.addEventListener('scroll', handleScroll)

    return () => {
      window.removeEventListener('resize', handleResize)
      element.removeEventListener('scroll', handleScroll)
    }
  }, [updateScrollControls])

  useEffect(() => {
    const activeTab = listRef.current?.querySelector('.workspace__tab.active')
    activeTab?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [activeItem])

  if (!openTabs.length) return null

  const scrollTabs = (direction) => {
    const element = listRef.current
    if (!element) return

    const scrollAmount = Math.max(element.clientWidth * 0.6, 120)
    const nextPosition =
      direction === 'left' ? element.scrollLeft - scrollAmount : element.scrollLeft + scrollAmount

    element.scrollTo({ left: nextPosition, behavior: 'smooth' })
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
        <div className="workspace__tablist" ref={listRef} role="tablist" aria-label="Pestañas del panel">
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
