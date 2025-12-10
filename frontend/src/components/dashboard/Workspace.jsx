function Workspace({ activeItem, openTabs, onSelectTab, onCloseTab, user, logo }) {
  const username = [user?.nombre || user?.first_name, user?.apellido || user?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim() || 'usuario'

  const hasTabs = openTabs?.length > 0
  const showWelcome = !activeItem

  return (
    <main className="workspace">
      <section className="workspace__tabs">
        {hasTabs && (
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
        )}
      </section>

      {showWelcome && (
        <section className="workspace__hero">
          <div className="workspace__logo">
            <img src={logo} alt="Logotipo Kava" />
          </div>
          <div className="workspace__copy">
            <h2>¡Qué gusto tenerte de vuelta, {username}!</h2>
            <p className="workspace__subtitle">
              Para comenzar, selecciona una opción del menú
            </p>
          </div>
        </section>
      )}

      {!showWelcome && (
        <section className="workspace__panel">
          <h1 className="workspace__view-title">{activeItem}</h1>
        </section>
      )}
    </main>
  )
}

export default Workspace
