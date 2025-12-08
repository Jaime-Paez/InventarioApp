const SearchIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)

const BellIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
)

const ThemeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 3c.132 0 .264.003.394.01A7.5 7.5 0 1 0 20.99 11.606 9 9 0 0 1 12 3Z" />
  </svg>
)

function TopBar({ user, search, onSearchChange, darkMode, onToggleTheme }) {
  return (
    <header className="topbar">
      <div className="topbar__breadcrumbs">
        <span className="crumb">Inicio</span>
        <span className="crumb">Panel</span>
        <span className="crumb active">Bienvenida</span>
      </div>

      <div className="topbar__actions">
        <div className="topbar__search">
          <SearchIcon />
          <input
            type="search"
            placeholder="Búsqueda rápida"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>

        <button type="button" className="icon-button" aria-label="Notificaciones">
          <BellIcon />
        </button>

        <button
          type="button"
          className={`icon-button ${darkMode ? 'active' : ''}`}
          aria-label="Cambiar tema"
          onClick={onToggleTheme}
        >
          <ThemeIcon />
        </button>

        <div className="topbar__avatar" title={user?.nombre || 'Usuario'}>
          {user?.nombre?.[0]?.toUpperCase() || 'U'}
        </div>
      </div>
    </header>
  )
}

export default TopBar
