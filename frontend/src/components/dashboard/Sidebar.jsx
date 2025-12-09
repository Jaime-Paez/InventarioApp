const iconProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

const BoxesIcon = () => (
  <svg {...iconProps}>
    <path d="m7.5 4.21 9 4.29 4.5-2.14-9-4.29-4.5 2.14Z" />
    <path d="m3 8.06 9 4.29 9-4.29" />
    <path d="M12 21V12" />
    <path d="m3 8.06 0 7.1 9 4.28 9-4.28 0-7.1" />
  </svg>
)

const TransferIcon = () => (
  <svg {...iconProps}>
    <path d="M17 7h-9" />
    <path d="m13 3 4 4-4 4" />
    <path d="M7 17h9" />
    <path d="m11 21-4-4 4-4" />
  </svg>
)

const PackageIcon = () => (
  <svg {...iconProps}>
    <path d="M21 16.5V8.5L12 4 3 8.5v8l9 4 9-4Z" />
    <path d="m3 8.5 9 4 9-4" />
    <path d="M12 12.5v8" />
  </svg>
)

const BuildingIcon = () => (
  <svg {...iconProps}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M9 3v4" />
    <path d="M15 3v4" />
    <path d="M9 13h6" />
    <path d="M9 17h6" />
  </svg>
)

const HandshakeIcon = () => (
  <svg {...iconProps}>
    <path d="m3 13 3 3a2 2 0 0 0 2.8 0l1.2-1.2" />
    <path d="M11 15.8 9.2 14a2 2 0 0 1 0-2.8l3.6-3.6a2 2 0 0 1 2.8 0l1 1a2 2 0 0 0 2.8 0L21 7" />
    <path d="m16 9-3 3" />
    <path d="M8 9 6 7" />
  </svg>
)

const InboxIcon = () => (
  <svg {...iconProps}>
    <path d="M4 4h16l-2 12H6L4 4Z" />
    <path d="M9 4v3a3 3 0 0 0 6 0V4" />
    <path d="M4 13h4l2 3h4l2-3h4" />
  </svg>
)

const UsersIcon = () => (
  <svg {...iconProps}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
)

const SlidersIcon = () => (
  <svg {...iconProps}>
    <line x1="4" x2="20" y1="4" y2="4" />
    <line x1="4" x2="20" y1="12" y2="12" />
    <line x1="4" x2="20" y1="20" y2="20" />
    <circle cx="10" cy="4" r="2.2" />
    <circle cx="14" cy="12" r="2.2" />
    <circle cx="8" cy="20" r="2.2" />
  </svg>
)

const LogOutIcon = () => (
  <svg {...iconProps}>
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
    <polyline points="10 17 15 12 10 7" />
    <line x1="15" y1="12" x2="3" y2="12" />
  </svg>
)

const GearIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.78 1.78 0 0 0 .35 1.95l.06.06a2.25 2.25 0 1 1-3.18 3.18l-.06-.06A1.78 1.78 0 0 0 15 19.4a1.78 1.78 0 0 0-1 .31 1.78 1.78 0 0 0-.73 1.44V21a2.25 2.25 0 1 1-4.5 0v-.11A1.78 1.78 0 0 0 8 19.4a1.78 1.78 0 0 0-1.95-.35l-.06.06a2.25 2.25 0 1 1-3.18-3.18l.06-.06A1.78 1.78 0 0 0 4.6 15a1.78 1.78 0 0 0-.31-1 1.78 1.78 0 0 0-1.44-.73H3a2.25 2.25 0 0 1 0-4.5h.11A1.78 1.78 0 0 0 4.6 8a1.78 1.78 0 0 0-.35-1L4.19 6.9a2.25 2.25 0 1 1 3.18-3.18l.06.06A1.78 1.78 0 0 0 9 4.6a1.78 1.78 0 0 0 1-.31A1.78 1.78 0 0 0 10.73 2.85V2.75a2.25 2.25 0 1 1 4.5 0v.11A1.78 1.78 0 0 0 16 4.6a1.78 1.78 0 0 0 1.95.35l.06-.06a2.25 2.25 0 0 1 3.18 3.18l-.06.06A1.78 1.78 0 0 0 19.4 9c0 .36.12.71.31 1a1.78 1.78 0 0 0 1.44.73h.11a2.25 2.25 0 1 1 0 4.5h-.11A1.78 1.78 0 0 0 19.71 14a1.78 1.78 0 0 0-.31 1Z" />
  </svg>
)

const MENU_ICONS = {
  Inventario: BoxesIcon,
  Movimientos: TransferIcon,
  Productos: PackageIcon,
  Sucursales: BuildingIcon,
  Proveedores: HandshakeIcon,
  Solicitudes: InboxIcon,
  Clientes: UsersIcon,
  Administrar: SlidersIcon,
}

function Sidebar({ items, activeItem, onSelect, user, onLogout, brandLogo, partnerLogo }) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <img src={brandLogo} alt="Logo Kava" className="sidebar__brand-logo" />
        <span className="brand-divider" aria-hidden />
        <img src={partnerLogo} alt="Logo JPaez" className="sidebar__partner-logo" />
      </div>

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
                {(() => {
                  const Icon = MENU_ICONS[item] || BoxesIcon
                  return <Icon />
                })()}
                <span>{item}</span>
                {activeItem === item && <span className="sidebar__bullet" aria-hidden />}
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
            <LogOutIcon />
            Cerrar panel
          </button>
          <button type="button" className="sidebar__action ghost">
            <GearIcon />
            Configuración
          </button>
        </div>
      </footer>
    </aside>
  )
}

export default Sidebar
