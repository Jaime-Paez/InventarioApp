const ShieldIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
  </svg>
)

const ExitIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
    <polyline points="10 17 15 12 10 7" />
    <line x1="15" y1="12" x2="3" y2="12" />
  </svg>
)

const MenuIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 6h16" />
    <path d="M4 12h16" />
    <path d="M4 18h16" />
  </svg>
)

function Sidebar({ items, activeItem, onSelect, user, onLogout }) {
  return (
    <aside className="sidebar">
      <header className="sidebar__header">
        <div className="sidebar__brand">
          <div className="sidebar__logo">k</div>
          <div className="sidebar__text">
            <span className="sidebar__title">kava</span>
            <span className="sidebar__subtitle">panel</span>
          </div>
        </div>
        <button className="sidebar__collapse" type="button" aria-label="Ocultar menú">
          <MenuIcon />
        </button>
      </header>

      <nav className="sidebar__nav">
        <p className="sidebar__section">Menú</p>
        <ul>
          {items.map((item) => (
            <li key={item}>
              <button
                type="button"
                className={`sidebar__link ${activeItem === item ? 'active' : ''}`}
                onClick={() => onSelect(item)}
              >
                <ShieldIcon />
                <span>{item}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <footer className="sidebar__footer">
        <div className="sidebar__user">
          <div className="sidebar__avatar">{user?.nombre?.[0]?.toUpperCase() || 'U'}</div>
          <div className="sidebar__user-text">
            <span className="sidebar__user-name">{user?.nombre || 'Usuario'}</span>
            <span className="sidebar__user-role">{user?.correo || 'correo@empresa.com'}</span>
          </div>
        </div>

        <div className="sidebar__actions">
          <button type="button" className="sidebar__action" onClick={onLogout}>
            <ExitIcon />
            Cerrar panel
          </button>
          <button type="button" className="sidebar__action ghost">
            <ShieldIcon />
            Configuración
          </button>
        </div>
      </footer>
    </aside>
  )
}

export default Sidebar
