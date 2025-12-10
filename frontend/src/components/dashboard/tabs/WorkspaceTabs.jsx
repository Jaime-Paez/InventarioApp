import './workspaceTabs.css'

function WorkspaceTabs({ openTabs = [], activeItem, onSelectTab, onCloseTab }) {
  if (!openTabs.length) return null

  return (
    <section className="workspace__tabs">
      <div className="workspace__tablist" role="tablist" aria-label="Pestañas del panel">
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
    </section>
  )
}

export default WorkspaceTabs
