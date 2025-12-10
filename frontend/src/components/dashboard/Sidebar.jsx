import { useMemo, useState } from 'react'
import { Layers, ArrowRightLeft, CircleArrowDown, CircleArrowUp, Tag, Map, Compass, Box, Truck, Hexagon, Building, Hand, UsersRound, IdCard, Settings, PanelLeftClose, PanelLeftOpen } from "lucide-react";

const MENU_STRUCTURE = [
  { label: 'Inventario', icon: Layers },
  {
    label: 'Movimientos',
    icon: ArrowRightLeft,
    children: [
      { label: 'Entradas', icon: CircleArrowDown },
      { label: 'Salidas', icon: CircleArrowUp },
    ],
  },
  { label: 'Productos', icon: Tag },
  {
    label: 'Sucursales',
    icon: Map,
    children: [
      { label: 'Sucursales', icon: Compass },
      { label: 'Bodegas', icon: Box },
    ],
  },
  {
    label: 'Proovedores',
    icon: Truck,
    children: [
      { label: 'Marcas', icon: Hexagon },
      { label: 'Casas comerciales', icon: Building },
    ],
  },
  { label: 'Solicitudes', icon: Hand },
  { label: 'Clientes', icon: UsersRound },
  { label: 'Administrar', icon: IdCard },
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

  const userInitial = (user?.nombre || user?.first_name || 'U')[0]?.toUpperCase()
  const userName = [user?.nombre || user?.first_name, user?.apellido || user?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim() || 'Usuario'

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
            const isOpenGroup =
              isGroup && (openGroups[item.label] || item.children?.some((child) => child.label === activeItem))
            const isActive = activeItem === item.label

            return (
              <li
                key={item.label}
                className={`sidebar__item ${isOpenGroup ? 'open' : ''}`}
              >
                <button
                  type="button"
                  className={`sidebar__link ${isActive ? 'active' : ''} ${isOpenGroup ? 'open' : ''}`}
                  onClick={() => handlePrimarySelect(item)}
                >
                  <Icon />
                  <span>{item.label}</span>
                  {isActive && <span className="sidebar__bullet" aria-hidden />}
                </button>

                {isGroup && isOpenGroup && (
                  <ul className="sidebar__submenu open">
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
          <button type="button" className="sidebar__action" onClick={onToggleSidebar}>
            <PanelLeftClose />
            Cerrar panel
          </button>
          <button type="button" className="sidebar__action ghost">
            <Settings />
            Configuración
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

export { MENU_STRUCTURE, PanelLeftOpen }
export default Sidebar
