import { useMemo, useState } from 'react'
import './Sidebar.css'
import { Settings, PanelLeftClose, Layers } from 'lucide-react'
import { MENU_STRUCTURE, filterMenuByPermissions } from '../menuConfig'

function Sidebar({
  activeItem,
  onSelect,
  openTabs = [],
  user,
  onLogout,
  brandLogo,
  partnerLogo,
  isOpen,
  onToggleSidebar,
  permissionIndex,
}) {
  const [openGroups, setOpenGroups] = useState({})
  const [profileOpen, setProfileOpen] = useState(false)

  const menuItems = useMemo(
    () => filterMenuByPermissions(MENU_STRUCTURE, permissionIndex),
    [permissionIndex]
  )
  const openTabSet = useMemo(() => new Set(openTabs), [openTabs])

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
            const Icon = item.icon || Layers
            const isGroup = Boolean(item.children)
            const childActive =
              isGroup &&
              item.label !== 'Sucursales' &&
              item.children?.some((child) => child.label === activeItem)
            const isOpenGroup = isGroup && openGroups[item.label]
            const isActive = activeItem === item.label
            const hasOpenTab = openTabSet.has(item.label)
            const hasOpenChild =
              isGroup && item.children?.some((child) => openTabSet.has(child.label))

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
                  {(isActive || childActive || hasOpenTab || hasOpenChild) && (
                    <span className="sidebar__bullet" aria-hidden />
                  )}
                </button>

                {isGroup && (
                  <ul className={`sidebar__submenu ${isOpenGroup ? 'open' : ''}`}>
                    {item.children.map((child) => {
                      const ChildIcon = child.icon || Icon
                      const childActive = activeItem === child.label
                      const childHasOpenTab = openTabSet.has(child.label)
                      return (
                        <li key={child.label}>
                          <button
                            type="button"
                            className={`sidebar__sublink ${childActive ? 'active' : ''}`}
                            onClick={() => onSelect(child.label)}
                            disabled={!isOpenGroup}
                            tabIndex={isOpenGroup ? 0 : -1}
                          >
                            <ChildIcon />
                            <span>{child.label}</span>
                            {(childActive || childHasOpenTab) && (
                              <span className="sidebar__bullet sidebar__bullet--small" aria-hidden />
                            )}
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
              <button
                type="button"
                className="sidebar__profile-action sidebar__profile-action--logout"
                onClick={onLogout}
              >
                <span>Cerrar sesión</span>
              </button>
            </div>
          )}
        </div>
      </footer>
    </aside>
  )
}

export default Sidebar
