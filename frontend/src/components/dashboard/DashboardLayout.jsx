import { useMemo, useState } from 'react'
import kavaDark from '../../assets/login/kava(dark).png'
import kavaLight from '../../assets/login/kava(light).png'
import jpaezDark from '../../assets/login/jpaez(dark).png'
import jpaezLight from '../../assets/login/jpaez(light).png'
import './dashboard.css'
import Sidebar, { MENU_STRUCTURE, PanelRightOpenIcon } from './Sidebar'
import Workspace from './Workspace'

function DashboardLayout({ user, darkMode, onLogout, isEntering }) {
  const [activeItem, setActiveItem] = useState(MENU_STRUCTURE[0].label)
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)

  const heroLogo = useMemo(() => (darkMode ? kavaDark : kavaLight), [darkMode])
  const brandLogo = useMemo(() => (darkMode ? kavaDark : kavaLight), [darkMode])
  const partnerLogo = useMemo(() => (darkMode ? jpaezDark : jpaezLight), [darkMode])

  return (
    <div
      className={`dashboard-shell ${darkMode ? 'dark' : 'light'} ${isEntering ? 'entering' : ''} ${isSidebarOpen ? '' : 'collapsed'}`}
    >
      <Sidebar
        activeItem={activeItem}
        onSelect={setActiveItem}
        user={user}
        onLogout={onLogout}
        brandLogo={brandLogo}
        partnerLogo={partnerLogo}
        isOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen((value) => !value)}
      />

      <Workspace activeItem={activeItem} user={user} logo={heroLogo} />

      {!isSidebarOpen && (
        <button
          type="button"
          className="sidebar__reopen"
          onClick={() => setIsSidebarOpen(true)}
        >
          <PanelRightOpenIcon />
          Abrir panel
        </button>
      )}
    </div>
  )
}

export default DashboardLayout
