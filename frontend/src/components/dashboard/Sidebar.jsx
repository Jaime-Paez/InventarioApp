import { useMemo, useState } from 'react'

const iconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

const LayersIcon = () => (
  <svg {...iconProps}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 12 12 17 22 12" />
    <polyline points="2 17 12 22 22 17" />
  </svg>
)

const ArrowRightLeftIcon = () => (
  <svg {...iconProps}>
    <path d="m16 3 4 4-4 4" />
    <path d="M20 7H4" />
    <path d="m8 21-4-4 4-4" />
    <path d="M4 17h16" />
  </svg>
)

const CircleArrowDownIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12.5 3.5 3.5 3.5-3.5" />
    <path d="M12 7.5v8.5" />
  </svg>
)

const CircleArrowUpIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M15.5 11.5 12 8 8.5 11.5" />
    <path d="M12 16.5V8" />
  </svg>
)

const TagIcon = () => (
  <svg {...iconProps}>
    <path d="M2 12V7.67a1 1 0 0 1 .29-.7l4.68-4.68a1 1 0 0 1 .7-.29H12a1 1 0 0 1 .7.29l8.31 8.31a1 1 0 0 1 0 1.41l-6.59 6.59a1 1 0 0 1-1.41 0l-9-9A1 1 0 0 1 2 12Z" />
    <path d="M7.5 5.5h.01" />
  </svg>
)

const MapIcon = () => (
  <svg {...iconProps}>
    <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21 3 6" />
    <line x1="9" x2="9" y1="3" y2="18" />
    <line x1="15" x2="15" y1="6" y2="21" />
  </svg>
)

const CompassIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <polygon points="15.5 8.5 13.8 13.8 8.5 15.5 10.2 10.2 15.5 8.5" />
  </svg>
)

const BoxIcon = () => (
  <svg {...iconProps}>
    <path d="M21 16.5V8.5L12 4 3 8.5v8l9 4 9-4Z" />
    <path d="m3 8.5 9 4 9-4" />
    <path d="M12 12.5v8" />
  </svg>
)

const TruckIcon = () => (
  <svg {...iconProps}>
    <path d="M16 3H3v13h13V3Z" />
    <path d="m16 8 3 1.5V16h-3" />
    <circle cx="7" cy="17" r="1.8" />
    <circle cx="17" cy="17" r="1.8" />
  </svg>
)

const RegisteredIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 17V7h4a3 3 0 0 1 0 6H9" />
    <path d="m13 13 2.2 4" />
  </svg>
)

const BuildingIcon = () => (
  <svg {...iconProps}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M9 7h6" />
    <path d="M9 11h6" />
    <path d="M9 15h6" />
  </svg>
)

const HandIcon = () => (
  <svg {...iconProps}>
    <path d="M18 11v7a2.5 2.5 0 0 1-2.5 2.5H9a4.5 4.5 0 0 1-4.5-4.5V12" />
    <path d="M22 11h-3.5" />
    <path d="M13.5 11H12" />
    <path d="M10 11H7.5" />
    <path d="M7.5 15.5v-5A3.5 3.5 0 0 1 11 7h0a2.5 2.5 0 0 1 2.5 2.5V11" />
    <path d="M12 7V4" />
  </svg>
)

const UsersRoundIcon = () => (
  <svg {...iconProps}>
    <path d="M19 21a8 8 0 0 0-14 0" />
    <circle cx="12" cy="8" r="4.5" />
    <path d="M21 22a6 6 0 0 0-4-5.66" />
    <path d="M17 3.34a4 4 0 0 1 0 7.32" />
  </svg>
)

const IdCardIcon = () => (
  <svg {...iconProps}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 8h7" />
    <path d="M7 12h4" />
    <circle cx="17" cy="12" r="1.5" />
    <path d="M15.5 16.5c1-.9 2.5-.9 3.5 0" />
  </svg>
)

const SettingsIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="3" />
    <path d="m19.4 15 .5 2.5a2 2 0 0 1-2 2.5h-.7a2 2 0 0 0-1.9 1.3l-.2.6a2 2 0 0 1-3.8 0l-.2-.6A2 2 0 0 0 9.3 20H8.6a2 2 0 0 1-2-2.5l.5-2.5a2 2 0 0 0-.5-1.8l-1.8-1.8a2 2 0 0 1 1.4-3.4h1.7a2 2 0 0 0 1.8-1.2l.5-1.3a2 2 0 0 1 3.7 0l.5 1.3a2 2 0 0 0 1.8 1.2h1.7a2 2 0 0 1 1.4 3.4L19 13.2a2 2 0 0 0-.5 1.8Z" />
  </svg>
)

const PanelLeftCloseIcon = () => (
  <svg {...iconProps}>
    <path d="M3 5v14a2 2 0 0 0 2 2h14" />
    <path d="M13 3h6v18h-6" />
    <path d="m9 15-3-3 3-3" />
  </svg>
)

const PanelRightOpenIcon = ({ className }) => (
  <svg {...iconProps} className={className}>
    <path d="M21 5v14a2 2 0 0 1-2 2H5" />
    <path d="M11 3H5v18h6" />
    <path d="m15 9 3 3-3 3" />
  </svg>
)

const ChevronDownIcon = ({ className }) => (
  <svg {...iconProps} width={18} height={18} className={className}>
    <path d="m6 9 6 6 6-6" />
  </svg>
)

const MENU_STRUCTURE = [
  { label: 'Inventario', icon: LayersIcon },
  {
    label: 'Movimientos',
    icon: ArrowRightLeftIcon,
    children: [
      { label: 'Entradas', icon: CircleArrowDownIcon },
      { label: 'Salidas', icon: CircleArrowUpIcon },
    ],
  },
  { label: 'Productos', icon: TagIcon },
  {
    label: 'Sucursales',
    icon: MapIcon,
    children: [
      { label: 'Sucursales', icon: CompassIcon },
      { label: 'Bodegas', icon: BoxIcon },
    ],
  },
  {
    label: 'Proovedores',
    icon: TruckIcon,
    children: [
      { label: 'Marcas', icon: RegisteredIcon },
      { label: 'Casas comerciales', icon: BuildingIcon },
    ],
  },
  { label: 'Proveedores', icon: TruckIcon },
  { label: 'Solicitudes', icon: HandIcon },
  { label: 'Clientes', icon: UsersRoundIcon },
  { label: 'Administrar', icon: IdCardIcon },
]

function Sidebar({
  activeItem,
  onSelect,
  user,
  onLogout,
  brandLogo,
  partnerLogo,
  isOpen,
  onToggleSidebar,
}) {
  const [openGroups, setOpenGroups] = useState({})
  const [profileOpen, setProfileOpen] = useState(false)

  const menuItems = useMemo(() => MENU_STRUCTURE, [])

  const toggleGroup = (label) => {
    setOpenGroups((prev) => {
      const shouldOpen = !prev[label]

      if (shouldOpen) {
        return { [label]: true }
      }

      return {}
    })
  }

  const handlePrimarySelect = (item) => {
    if (item.children) {
      toggleGroup(item.label)
      return
    }
    onSelect(item.label)
  }

  const userInitial = (user?.nombre || 'U')[0]?.toUpperCase()
  const userName = user?.nombre || 'Usuario'

  return (
    <aside className={`sidebar ${isOpen ? '' : 'sidebar--hidden'}`}>
      <div className="sidebar__brand">
        <img src={brandLogo} alt="Logo Kava" className="sidebar__brand-logo" />
        <span className="brand-divider" aria-hidden />
        <img src={partnerLogo} alt="Logo JPaez" className="sidebar__partner-logo" />
      </div>

      <nav className="sidebar__nav">
        <ul>
          {menuItems.map((item) => {
            const Icon = item.icon || LayersIcon
            const isGroup = Boolean(item.children)
            const isOpenGroup = isGroup && openGroups[item.label]
            const isActive =
              activeItem === item.label ||
              item.children?.some((child) => child.label === activeItem)

            return (
              <li key={item.label}>
                <button
                  type="button"
                  className={`sidebar__link ${isActive ? 'active' : ''}`}
                  onClick={() => handlePrimarySelect(item)}
                >
                  <Icon />
                  <span>{item.label}</span>
                  {isActive && <span className="sidebar__bullet" aria-hidden />}
                </button>

                {isGroup && isOpenGroup && (
                  <ul className="sidebar__submenu">
                    {item.children.map((child) => {
                      const ChildIcon = child.icon || Icon
                      const childActive = activeItem === child.label
                      return (
                        <li key={child.label}>
                          <button
                            type="button"
                            className={`sidebar__sublink ${childActive ? 'active' : ''}`}
                            onClick={() => onSelect(child.label)}
                          >
                            <ChildIcon />
                            <span>{child.label}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      </nav>

      <footer className="sidebar__footer">
        <div className="sidebar__actions">
          <button type="button" className="sidebar__action ghost">
            <SettingsIcon />
            Configuración
          </button>
          <button type="button" className="sidebar__action" onClick={onToggleSidebar}>
            <PanelLeftCloseIcon />
            Cerrar panel
          </button>
        </div>

        <div className="sidebar__profile">
          <button
            type="button"
            className={`sidebar__user ${profileOpen ? 'open' : ''}`}
            onClick={() => setProfileOpen((value) => !value)}
          >
            <div className="sidebar__avatar minimal">{userInitial}</div>
            <span className="sidebar__user-name">{userName}</span>
            <ChevronDownIcon className="sidebar__chevron" />
          </button>

          {profileOpen && (
            <div className="sidebar__profile-menu">
              <button type="button" className="sidebar__profile-action" onClick={onLogout}>
                Cerrar sesión
              </button>
            </div>
          )}
        </div>
      </footer>
    </aside>
  )
}

export { MENU_STRUCTURE, PanelRightOpenIcon }
export default Sidebar
