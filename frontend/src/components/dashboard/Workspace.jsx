import WorkspaceTabs from './tabs/WorkspaceTabs'
import QuickActions from './QuickActions'
import './Workspace.css'

function Workspace({
  activeItem,
  openTabs,
  onSelectTab,
  onCloseTab,
  user,
  logo,
  darkMode,
  onToggleTheme,
}) {
  const username = [user?.nombre || user?.first_name, user?.apellido || user?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim() || 'usuario'

  const showWelcome = !activeItem

  return (
    <main className="workspace">
      <div className="workspace__toolbar">
        <QuickActions darkMode={darkMode} onToggleTheme={onToggleTheme} />
      </div>

      <WorkspaceTabs
        openTabs={openTabs}
        activeItem={activeItem}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
      />

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
