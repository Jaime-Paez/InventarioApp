import { useEffect, useRef } from 'react'
import './WorkspaceTabs.css'

// Pestañas estilo navegador: la activa va siempre AL INICIO, con su nombre
// completo y unida al contenido de abajo; las demas se encogen para caber, asi
// que nunca hay flechas ni pestañas escondidas. El nombre cortado se ve
// completo al pasar el mouse (data-title, sin tooltip nativo).
function WorkspaceTabs({ openTabs = [], activeItem, onSelectTab, onCloseTab }) {
  const listRef = useRef(null)

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

  const ordered = openTabs.includes(activeItem)
    ? [activeItem, ...openTabs.filter((tab) => tab !== activeItem)]
    : openTabs

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
                className={`workspace__tab${isActive ? ' active' : ''}`}
                role="tab"
                aria-selected={isActive}
                data-title={isActive ? undefined : tab}
                onClick={() => onSelectTab(tab)}
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
