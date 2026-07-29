import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import './Sidebar.css'
import { Settings, PanelLeftClose, Layers, LogOut } from 'lucide-react'
import { MENU_STRUCTURE, filterMenuByPermissions } from '../menuConfig'
import { API_URL, authFetch } from '../../../utils/api'
import { getAppPortalRoot } from '../../../utils/portalRoot'
import kavaDark from '../../../assets/login/kava(dark).png'
import jpaezDark from '../../../assets/login/jpaez(dark).png'

const INCONVENIENTES_POLL_MS = 30000

function Sidebar({
  activeItem,
  onSelect,
  openTabs = [],
  user,
  token,
  onLogout,
  brandLogo,
  partnerLogo,
  isOpen,
  onToggleSidebar,
  permissionIndex,
  moduleScopeAccessIndex = null,
}) {
  const [openGroups, setOpenGroups] = useState({})
  const [profileOpen, setProfileOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState(null)
  const profileRef = useRef(null)
  const menuRef = useRef(null)

  const handleProfileClick = () => {
    if (profileOpen) { setProfileOpen(false); return }
    const rect = profileRef.current?.getBoundingClientRect()
    if (rect) {
      setMenuStyle({
        position: 'fixed',
        top: rect.top,
        left: rect.right + 8,
      })
    }
    setProfileOpen(true)
  }

  useEffect(() => {
    if (!profileOpen) return
    const handler = (e) => {
      if (
        profileRef.current && !profileRef.current.contains(e.target) &&
        menuRef.current && !menuRef.current.contains(e.target)
      ) setProfileOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [profileOpen])
  const canAccessConfiguration = Boolean(
    user?.is_superuser ||
      user?.is_staff ||
      user?.es_administrador ||
      String(user?.rol || '').trim().toLowerCase() === 'administrador'
  )

  const menuItems = useMemo(
    () => filterMenuByPermissions(
      MENU_STRUCTURE,
      permissionIndex,
      moduleScopeAccessIndex,
      canAccessConfiguration
    ),
    [canAccessConfiguration, moduleScopeAccessIndex, permissionIndex]
  )
  const openTabSet = useMemo(() => new Set(openTabs), [openTabs])

  const canSeeInconvenientes = useMemo(
    () => menuItems.some((item) => item.label === 'Inconvenientes'),
    [menuItems]
  )
  const [hasPendingInconvenientes, setHasPendingInconvenientes] = useState(false)

  const checkPendingInconvenientes = useCallback(async () => {
    if (!token) return
    try {
      const [trasladosRes, importacionesRes] = await Promise.all([
        authFetch(
          `${API_URL}/movimientos/movimiento_inventario/traslados-inconvenientes/?estado=pendiente`,
          {},
          token
        ),
        authFetch(`${API_URL}/importaciones/importaciones/inconvenientes/?estado=pendiente`, {}, token),
      ])
      const [traslados, importaciones] = await Promise.all([
        trasladosRes.ok ? trasladosRes.json().catch(() => []) : [],
        importacionesRes.ok ? importacionesRes.json().catch(() => []) : [],
      ])
      const trasladosCount = Array.isArray(traslados) ? traslados.length : 0
      const importacionesCount = Array.isArray(importaciones) ? importaciones.length : 0
      setHasPendingInconvenientes(trasladosCount + importacionesCount > 0)
    } catch {
      // Silencioso: si falla la verificación, simplemente no se resalta el ítem.
    }
  }, [token])

  useEffect(() => {
    if (!canSeeInconvenientes || !token) {
      setHasPendingInconvenientes(false)
      return undefined
    }
    void checkPendingInconvenientes()
    const intervalId = window.setInterval(checkPendingInconvenientes, INCONVENIENTES_POLL_MS)
    return () => window.clearInterval(intervalId)
  }, [canSeeInconvenientes, token, checkPendingInconvenientes])

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

  const firstName = (user?.nombre || user?.first_name || '').trim()
  const lastName = (user?.apellido || user?.last_name || '').trim()

  const userInitial = (firstName[0] || lastName[0] || 'U').toUpperCase()
  const lastNameInitial = lastName ? `${lastName[0].toUpperCase()}.` : ''
  const userName = `${firstName || 'Usuario'}${lastNameInitial ? ` ${lastNameInitial}` : ''}`.trim()

  return (
    <aside className={`sidebar ${isOpen ? '' : 'sidebar--hidden'}${canAccessConfiguration ? ' sidebar--admin' : ''}`}>
      <div className="sidebar__brand">
        <img src={canAccessConfiguration ? kavaDark : brandLogo} alt="Logo Kava" className="sidebar__brand-logo" />
        <span className="brand-divider" aria-hidden />
        <img src={canAccessConfiguration ? jpaezDark : partnerLogo} alt="Logo JPaez" className="sidebar__partner-logo" />
      </div>

      <nav className="sidebar__nav">
        <ul>
          {menuItems.map((item) => {
            const Icon = item.icon || Layers
            const isGroup = Boolean(item.children)
            const childActive =
              isGroup &&
              item.children?.some((child) => child.label === activeItem)
            const isOpenGroup = isGroup && openGroups[item.label]
            const isActive = !isGroup && activeItem === item.label
            const hasOpenTab = openTabSet.has(item.label)
            const hasOpenChild =
              isGroup && item.children?.some((child) => openTabSet.has(child.label))
            const hasPendingAlert = item.label === 'Inconvenientes' && hasPendingInconvenientes

            return (
              <li
                key={item.label}
                className={`sidebar__item ${isOpenGroup ? 'open' : ''}`}
              >
                <button
                  type="button"
                  className={`sidebar__link ${isActive ? 'active' : ''} ${isOpenGroup ? 'open' : ''} ${hasPendingAlert ? 'sidebar__link--alert' : ''}`}
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
          {canAccessConfiguration ? (
            <button
              type="button"
              className="sidebar__action ghost"
              onClick={() => onSelect('Configuraciones')}
            >
              <Settings />
              Configuración
            </button>
          ) : null}
        </div>

        <div className="sidebar__profile" ref={profileRef}>
          <button
            type="button"
            className="sidebar__user"
            onClick={handleProfileClick}
          >
            <div className="sidebar__avatar minimal">{userInitial}</div>
            <span className="sidebar__user-name">{userName}</span>
          </button>
        </div>

        {profileOpen && menuStyle && createPortal(
          <div ref={menuRef} className="sidebar__profile-menu" style={menuStyle}>
            <button
              type="button"
              className="sidebar__profile-menu-item sidebar__profile-menu-item--logout"
              onClick={() => { setProfileOpen(false); onLogout() }}
            >
              <LogOut size={15} />
              <span>Cerrar sesión</span>
            </button>
          </div>,
          getAppPortalRoot()
        )}
      </footer>
    </aside>
  )
}

export default Sidebar
